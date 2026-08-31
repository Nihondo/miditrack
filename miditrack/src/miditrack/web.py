"""miditrackのローカルWebアプリ。

tools/pixelart_web.py と同型の単一セッション・ローカルFlaskツール:
127.0.0.1限定バインド、起動スコープのトークン認証、CDN不使用の自前JS/CSS、
一時ディレクトリでのセッション状態管理。詳細な設計判断は miditrack/CLAUDE.md
を参照。
"""

from __future__ import annotations

import hashlib
import itertools
import json
import math
import re
import secrets
import shutil
import sys
import tempfile
import threading
import time
import webbrowser
import zipfile
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

try:
    from flask import Flask, Response, jsonify, request, send_file
    from werkzeug.exceptions import RequestEntityTooLarge
    from werkzeug.serving import make_server
except ImportError as import_error:  # pragma: no cover - exercised via cli.py's own guard
    raise ImportError("miditrack requires Flask") from import_error

from . import convert, libvgm, midi, mix, nsf_chip, pianoroll, pitch_shift, preferences, project, render
from .convert import SourceFormat
from .errors import (
    ConvertError,
    MidiTrackError,
    MixError,
    PitchShiftError,
    RenderError,
    WebValidationError,
)
from .gm import DEFAULT_GM_PROGRAM, instrument_catalog
from .midi import TrackInfo

ASSET_DIR = Path(__file__).with_name("web_assets")
# .rsn/.vgz等の音源ファイルは.midより桁違いに大きくなりうるため32MBから引き上げてある。
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
MAX_PROJECT_UPLOAD_BYTES = 512 * 1024 * 1024
ALLOWED_MIDI_EXTENSIONS = (".mid", ".midi")
PROJECT_EXTENSION = ".miditrack"
TRACK_ROLE_IDS = set(preferences.TRACK_ROLE_IDS)

# トラック音源が実機チップレンダリング（原曲の音源をSoundFontではなく実機/
# エミュレーションで鳴らす方式）を持つフォーマット。SPCの"game"はBRRサンプル
# 由来SoundFontのバンク切り替えであり、これらとは別の仕組みなので含めない。
CHIP_HARDWARE_SOURCE_FORMATS = ("vgm", "nsf")
FAST_RENDER_MODE = "fast"
QUALITY_RENDER_MODE = "quality"
RENDER_SAMPLE_RATES = {FAST_RENDER_MODE: 22050, QUALITY_RENDER_MODE: 44100}
RENDER_CACHE_MAX_BYTES = 256 * 1024 * 1024
RENDER_CACHE_MAX_ENTRIES = 16
RENDER_CACHE_VERSION = 1
RENDER_WORKERS = 2
# /api/audio?v=Nがrender_idごとに解決できるWAVの保持件数。クロスフェード中は旧render_idの
# 要素が引き続きこの音源へRangeリクエストを送り続けるため、invalidate_render()後も
# ここに載っている間は消さない（LRU（render_cache）からの追い出し対象からも保護する）。
# 上限は「同時に鳴りうる音源はたかだかA/B 2枚+ソロ切替の余裕」程度で十分なので小さく保つ。
AUDIO_SOURCE_HISTORY_LIMIT = 4

RendererFunc = Callable[[Path, Path, "Path | None"], None]
ListSongsFunc = Callable[[SourceFormat, Path], "tuple[dict[str, Any], list[dict[str, Any]]]"]
ConvertFunc = Callable[[SourceFormat, Path, Path, "dict[str, Any]"], "tuple[Path | None, Path | None]"]
PitchShiftFunc = Callable[[Path, Path, "list[float]", "list[float]"], "list[Path]"]
MixerFunc = Callable[["list[tuple[Path, float]]", Path], None]
GainApplierFunc = Callable[[Path, Path, float], None]
LibvgmRendererFunc = Callable[
    [Path, Path, int, "list[libvgm.LibvgmTarget]"], None
]
NsfChipRendererFunc = Callable[
    [Path, Path, int, "list[nsf_chip.NsfChipTarget]", int], None
]


@dataclass(frozen=True)
class CachedAudio:
    """セッション内LRUキャッシュに保持するWAVとサイズ。"""

    path: Path
    size_bytes: int


@dataclass(frozen=True)
class RenderOutcome:
    """1回の試聴／最終レンダー要求の結果と計測値。"""

    path: Path
    mode: str
    cache_key: str
    cache_hit: bool
    render_ms: int


@dataclass(frozen=True)
class ChipCacheMiss:
    """生成が必要な実機音声キャッシュ1件を表す。"""

    cache_key: str
    indices: list[int]
    path: Path


@dataclass(frozen=True)
class ChipHardwarePlan:
    """実機音声のミックス入力と、まだ生成されていないキャッシュ項目。"""

    inputs: list[tuple[Path, float]]
    misses: list[ChipCacheMiss]


@dataclass
class WebSession:
    """1ブラウザセッション分のMIDI・割り当て・レンダリング結果を保持する。"""

    root: Path | None = None
    original_path: Path | None = None
    original_name: str = ""
    # MIDI/WAV単体ダウンロードとバリエーションZIP（ZIP自体・内部の各ファイル名）が
    # 共通して参照するベースファイル名の明示指定。空文字列は「未指定」を意味し、
    # その場合はoriginal_nameを使う。original_nameと同じ「MIDI由来」の設定なので
    # reset_midi_state()で初期化する（soundfont_overrideのようなMIDIをまたいで
    # 残るUI設定ではない）。
    download_stem: str = ""
    ticks_per_beat: int | None = None
    tracks: list[TrackInfo] = field(default_factory=list)
    assignments: dict[int, int] = field(default_factory=dict)
    volumes: dict[int, int] = field(default_factory=dict)
    # "game"（原曲の音源）を選んだトラックだけを保持する。SoundFontは既定値
    # なので辞書へ入れない。
    track_sources: dict[int, str] = field(default_factory=dict)
    # VGM(libvgm)/NSF(nsf2midi --chip-render)の「MIDIトラック<->実機チャンネル」
    # sidecarメタデータ。フォーマットにより実際の型はLibvgmMetadataまたは
    # NsfChipMetadataになるが、どちらも同じ形（targets/group_indices()）を
    # 持つので呼び出し側はsource_formatで実装を出し分けるだけでよい。
    # SPCのgame_soundfont_pathとは完全に別の軸（あちらはSoundFontバンク切替）。
    chip_metadata: libvgm.LibvgmMetadata | nsf_chip.NsfChipMetadata | None = None
    # セッション全体の速度倍率・移調（半音）。assignments/volumesと同じ
    # 「MIDI由来の編集パラメータ」なのでreset_midi_state()で初期化する
    # （soundfont_overrideのようなMIDIをまたいで残るUI設定ではない）。
    speed_ratio: float = midi.DEFAULT_SPEED_RATIO
    transpose_semitones: int = midi.DEFAULT_TRANSPOSE_SEMITONES
    applied_path: Path | None = None
    apply_summary: dict[str, int] | None = None
    audio_path: Path | None = None
    current_render_key: str | None = None
    current_render_mode: str | None = None
    midi_revision: int = 0
    state_revision: int = 0
    render_cache: OrderedDict[str, CachedAudio] = field(
        default_factory=OrderedDict, repr=False
    )
    render_cache_bytes: int = 0
    # ブラウザの音声キャッシュを確実に更新する世代番号。MIDI再変換やセッションの
    # clear()をまたいでもサーバープロセス中は単調増加させ、同じ/api/audio?v=Nを
    # 別内容へ再利用しない。プロセス再起動時は認証tokenも変わるため0開始で安全。
    render_id: int = 0
    # render_id -> そのidをactivateした時点のWAVパス。クロスフェード中、旧
    # <audio>要素は新レンダリングがactivateされた後も自分のrender_id（?v=旧N）
    # へRangeリクエストを送り続ける。get_audio()はこの辞書で解決し、audio_pathが
    # 新音源へ差し替わっていても旧要素には旧音源のバイトを返し続ける。
    # invalidate_render()では消さない（旧render_idを鳴らし続けるのがこの辞書の
    # 存在理由）。reset_midi_state()（延いてはclear()）でだけ消す。
    audio_sources: OrderedDict[int, Path] = field(
        default_factory=OrderedDict, repr=False
    )
    # 「速度・ピッチのバリエーション」で生成したZIP（WAV+MIDI）。ensure_render()と
    # 同じ入力（assignments/volumes/track_sources/soundfont等）から作られる派生物
    # なので、audio_pathと同じタイミング（reset_midi_state/invalidate_render）で
    # 無効化する。ただし生成自体はensure_render()を経由しない
    # （_apply_to()/_render_applied_midi()を直接、組み合わせの数だけ呼ぶ）。
    variations_zip_path: Path | None = None
    # 「トラックごとに出力」で生成したZIP（トラック単位WAV）。variations_zip_pathと
    # 全く同じ入力から作られる派生物なので、無効化のタイミングも完全に同じにする
    # （reset_midi_state/invalidate_render/ファイル名変更）。
    track_export_zip_path: Path | None = None
    render_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    # 音源変換時（convert_source）に chipNoise オプションで生成された実機ノイズ/DPCM
    # ステムWAV。ensure_render() がこれを検出すると、fluidsynthの出力とffmpegで
    # ミックスしてから audio_path に置く。convert_source() がステムを書いた「後」に
    # load_midi() を呼ぶため、reset_midi_state() ではこのフィールドをNoneに戻す
    # だけに留め、ファイル自体をunlinkしてはいけない（今書いたばかりのステムを
    # 消してしまう）。ファイルの実体は root ごと clear() で消える。
    chip_stem_path: Path | None = None
    # 音源変換時（convert_source）にvgm2midi --dac-wavが生成したYM2612 DAC(PCM)サンプル
    # ステムWAV。chip_stem_path（SN76489/HuC6280ノイズ、--noise-wav）とはvgm2midi側で
    # 独立したCLIオプション・独立したレンダラだが、ensure_render()では両方とも同じ
    # 「実機音でミックスする追加ステム」として扱い、存在する分だけ mix_wav() の入力に
    # 追加する。ライフサイクル（unlinkしない理由を含む）はchip_stem_pathと完全に同一。
    dac_stem_path: Path | None = None
    # 音源変換時（convert_source）に gameSoundfont オプションで spc2midi --sf2 が
    # 書き出したゲーム由来SoundFont。ensure_render() が、音色を手動指定していない
    # トラック（＝assignmentsにキーが無いトラック）をこのSF2で鳴らす。ライフサイクルは
    # chip_stem_path と完全に同一: convert_source() は load_midi() の「後」に代入し
    # （load_midi() -> reset_midi_state() がNoneに戻すため）、reset_midi_state() では
    # Noneに戻すだけでunlinkしない（書かれたばかりのSF2を消してしまうため）。実体は
    # root ごと clear() で消える。invalidate_render() では触らない —
    # SF2はMIDI由来の資産であって、レンダリング結果の派生物ではない。
    game_soundfont_path: Path | None = None
    # ユーザーがWeb UIで選択したSoundFont。アップロードしたMIDIとは独立した設定なので
    # clear()/replace()では消さない（別のMIDIを読み込んでも選択は保持される）。
    # game_soundfont_path とは直交する軸: こちらは「音色を手動指定したトラックを
    # 鳴らすGMバンク」の意味を持つ。
    soundfont_override: Path | None = None
    # 音源ファイル（.nsf/.spc/.rsn/.vgm等）由来のセッション情報。.midを直接読んだ
    # ときはNoneのまま。root/soundfont_overrideと違い、clear()で必ず消える。
    source_path: Path | None = None
    source_name: str = ""
    source_format: str | None = None
    source_metadata: dict[str, Any] = field(default_factory=dict)
    source_songs: list[dict[str, Any]] = field(default_factory=list)
    # 変換時に実際に指定した曲/トラック番号（NSF/SPCのsongIndex）。NSFの
    # nsf_chip.render_selection()は元のNSFファイルを毎回読み直すため、変換時と
    # 同じ曲番号(-t/--track)を再指定する必要があり、そのために保持する。
    source_song_index: int | None = None
    # 最後にMIDIへ変換したときの検証済みオプション。変換前に画面で選んだだけの
    # 値は保存しないため、プロジェクトを開いても基準MIDIとの対応が崩れない。
    converted_options: dict[str, Any] = field(default_factory=dict)
    # ZIP展開・複数ファイル同時アップロードで見つかった変換候補一覧
    # （{"path": rootからの相対パス, "name": basename} のリスト）。
    # 単一ファイルのアップロード時も要素数1で入る。
    source_files: list[dict[str, str]] = field(default_factory=list)
    # アップロード内で見つかったm3uプレイリストの生テキスト（複数あれば全部保持）。
    # ファイル切り替え（select-file）のたびに曲名解決へ再利用する。
    source_m3u_texts: list[str] = field(default_factory=list)

    def clear_render_cache(self) -> None:
        """試聴・最終WAV・実機ステムのセッション内キャッシュを破棄する。"""
        for entry in self.render_cache.values():
            entry.path.unlink(missing_ok=True)
        self.render_cache.clear()
        self.render_cache_bytes = 0
        self.current_render_key = None
        self.current_render_mode = None
        # audio_sourcesが指すパスはすべてrender_cache由来なので、上のループで
        # 既にunlink済み。ここでは辞書自体をクリアするだけでよい。
        self.audio_sources.clear()

    def reset_midi_state(self) -> None:
        """MIDI（原本・トラック解析・割り当て・レンダリング結果）だけを初期状態に戻す。

        root・soundfont_override・source_*系フィールドは触らない。clear()と
        load_midi()の両方から呼ばれる共通処理。
        """
        self.clear_render_cache()
        if self.audio_path is not None:
            self.audio_path.unlink(missing_ok=True)
        if self.variations_zip_path is not None:
            self.variations_zip_path.unlink(missing_ok=True)
        if self.track_export_zip_path is not None:
            self.track_export_zip_path.unlink(missing_ok=True)
        self.original_path = None
        self.original_name = ""
        self.download_stem = ""
        self.ticks_per_beat = None
        self.tracks = []
        self.assignments = {}
        self.volumes = {}
        self.track_sources = {}
        self.chip_metadata = None
        self.speed_ratio = midi.DEFAULT_SPEED_RATIO
        self.transpose_semitones = midi.DEFAULT_TRANSPOSE_SEMITONES
        self.applied_path = None
        self.apply_summary = None
        self.audio_path = None
        self.variations_zip_path = None
        self.track_export_zip_path = None
        # unlink しない理由は上のフィールド定義コメントを参照。
        self.chip_stem_path = None
        self.dac_stem_path = None
        self.game_soundfont_path = None
        self.converted_options = {}

    def clear(self) -> None:
        """現在の一時ディレクトリと状態を破棄する。"""
        if self.root is not None:
            shutil.rmtree(self.root, ignore_errors=True)
        self.root = None
        self.reset_midi_state()
        self.source_path = None
        self.source_name = ""
        self.source_format = None
        self.source_metadata = {}
        self.source_songs = []
        self.source_song_index = None
        self.converted_options = {}
        self.source_files = []
        self.source_m3u_texts = []

    def load_midi(
        self,
        original_path: Path,
        original_name: str,
        ticks_per_beat: int,
        tracks: list[TrackInfo],
    ) -> None:
        """MIDI由来の状態だけを差し替える（root・source系フィールドは触らない）。

        音源からの変換後にトラック一覧を更新する用途と、rootを共有したまま
        MIDIだけを差し替えたいケースの両方で使う。既存のレンダリング結果が
        あれば破棄する。
        """
        self.reset_midi_state()
        self.original_path = original_path
        self.original_name = original_name
        self.ticks_per_beat = ticks_per_beat
        self.tracks = tracks
        self.midi_revision += 1
        self.state_revision += 1

    def replace(
        self,
        root: Path,
        original_path: Path,
        original_name: str,
        ticks_per_beat: int,
        tracks: list[TrackInfo],
    ) -> None:
        """既存状態を消去し、新しいアップロードへ置き換える。"""
        self.clear()
        self.root = root
        self.load_midi(original_path, original_name, ticks_per_beat, tracks)

    def invalidate_render(self) -> None:
        """割り当て変更後にレンダリング結果だけを無効化する（原本・トラック解析は残す）。

        variations_zip_path・track_export_zip_pathはensure_render()と同じ入力
        （assignments/volumes/track_sources/soundfont等）から作られる派生物な
        ので同時に無効化する。ポインタをNoneにするだけで実ファイルの削除は次回
        生成時に行う（audio_path自身の扱いと同じ）。
        """
        self.applied_path = None
        self.apply_summary = None
        self.audio_path = None
        self.current_render_key = None
        self.current_render_mode = None
        self.variations_zip_path = None
        self.track_export_zip_path = None
        self.state_revision += 1

    def require_tracks(self) -> list[TrackInfo]:
        if not self.tracks:
            raise WebValidationError("先にMIDIファイルをアップロードしてください")
        return self.tracks


def sanitize_stem(filename: str) -> str:
    """ダウンロードファイル名に安全に使えるstemへ正規化する（パス区切りは無視）。"""
    basename = filename.replace("\\", "/").rsplit("/", 1)[-1]
    stem = Path(basename).stem.strip().lstrip(".")
    safe = re.sub(r"[^\w .()-]", "_", stem, flags=re.UNICODE).strip(" .")
    return safe or "miditrack"


def _track_filename_label(name: str, index: int) -> str:
    """トラック名を「トラックごとに出力」のファイル名断片へ正規化する。

    sanitize_stem()と同じ「ファイルシステムに安全でない文字を`_`へ置換し、前後の
    ` .`を落とす」正規表現を使うが、sanitize_stem()自身が経由するPath(...).stem
    は通さない ―― トラック名は`St.Trumpet`のように`.`を含むことがあり、
    拡張子とみなして切り詰められてしまうと元の名前が失われる（sanitize_stem()
    はダウンロードファイル名"全体"のstemを求める用途なのでこの割り切りが正しいが、
    トラック名はそもそも拡張子を持たない）。空になった場合はTrack{index}へ
    フォールバックする。
    """
    stripped = name.strip()
    safe = re.sub(r"[^\w .()-]", "_", stripped, flags=re.UNICODE).strip(" .")
    return safe or f"Track{index}"


def _effective_download_stem(session: WebSession) -> str:
    """ダウンロードファイル名のベースstemを返す。

    session.download_stem（ユーザーがダウンロードファイル名欄で明示指定した名前）
    があればそれを、無ければアップロード時のファイル名（original_name）を使う。
    MIDI/WAV単体ダウンロードとバリエーションZIP（ZIP自体・内部の各ファイル名）が
    すべてこの1箇所を参照するので、呼び出し側ごとに定義がずれない。
    """
    return session.download_stem or session.original_name


def _safe_upload_basename(filename: str) -> str:
    """アップロードされたファイル名を保存用の安全なbasenameへ正規化する。

    sanitize_stem()と同じ安全性（パス区切り除去、`.`/`..`だけの名前を弾く）を
    保ちつつ、拡張子（フォーマット判定・m3uのファイル名照合に必要）は保持する。
    戻り値が空になることはなく、`directory / 戻り値` がdirectoryの外に出ることもない。
    """
    basename = filename.replace("\\", "/").rsplit("/", 1)[-1]
    suffix = Path(basename).suffix.lower()
    if not re.fullmatch(r"\.[A-Za-z0-9]{1,10}", suffix):
        suffix = ""
    return f"{sanitize_stem(basename)}{suffix}"


def _unique_upload_path(directory: Path, original_filename: str) -> Path:
    """元のファイル名をなるべくそのまま使いつつ、directory内で重複しない保存先を返す。

    m3uプレイリストはファイル名（basename）で音源ファイルと紐付けるため、
    ここで拡張子付きの元ファイル名を保てないと曲名の突き合わせができなくなる。
    """
    basename = _safe_upload_basename(original_filename)
    candidate = directory / basename
    if not candidate.exists():
        return candidate
    stem, suffix = Path(basename).stem, Path(basename).suffix
    counter = 1
    while True:
        candidate = directory / f"{stem}_{counter}{suffix}"
        if not candidate.exists():
            return candidate
        counter += 1


def _selected_track_source(session: WebSession, track: TrackInfo) -> str:
    """セッション上の明示指定を加味したトラックの実効音源を返す。

    明示指定が無いトラックは常に"soundfont"がデフォルト（NSF/VGM/SPCいずれも
    共通）。"game"を初期選択にしたい場合はconvert_source()がtrack_sourcesへ
    明示的に書き込む（VGM/NSFのsuggested、SPCの音符ありトラック全件）。
    """
    return session.track_sources.get(track.index, "soundfont")


def _set_track_source(session: WebSession, track: TrackInfo, source: str) -> None:
    """既定音源（"soundfont"）との差分だけをWebSessionへ保存する。"""
    if source == "soundfont":
        session.track_sources.pop(track.index, None)
    else:
        session.track_sources[track.index] = source


def _validate_track_sources(
    session: WebSession, tracks: list[TrackInfo], raw_sources: dict[int, str]
) -> dict[int, str]:
    """SoundFont・原曲の音源（SPCのSoundFontバンク切替、VGM/NSFの実機レンダリング）の
    音源選択を検証する。

    "game"の実体はフォーマットごとに異なる（SPC=BRRサンプル由来SoundFontの
    バンク切替、VGM/NSF=libvgm/nsf2midiによる実機チャンネルレンダリング）ため、
    session.source_formatで検証ロジックを出し分ける。
    """
    tracks_by_index = {track.index: track for track in tracks}
    if session.source_format == "spc":
        validated: dict[int, str] = {}
        for track_index, source in raw_sources.items():
            track = tracks_by_index[track_index]
            if source == "game":
                if session.game_soundfont_path is None or track.note_count == 0:
                    raise WebValidationError(f"トラック{track_index}では原曲の音色を選べません")
                validated[track_index] = source
            elif source == "soundfont":
                validated[track_index] = source
            else:
                raise WebValidationError(f"未知のトラック音源です: {source}")
        return validated
    if session.source_format == "vgm":
        assert session.chip_metadata is None or isinstance(session.chip_metadata, libvgm.LibvgmMetadata)
        return libvgm.validate_sources(session.chip_metadata, raw_sources)
    if session.source_format == "nsf":
        assert session.chip_metadata is None or isinstance(session.chip_metadata, nsf_chip.NsfChipMetadata)
        return nsf_chip.validate_sources(session.chip_metadata, raw_sources)
    # .midを直接アップロードした場合など、"game"を選べる余地が無い。
    validated = {}
    for track_index, source in raw_sources.items():
        if source != "soundfont":
            raise WebValidationError(f"未知のトラック音源です: {source}")
        validated[track_index] = source
    return validated


def track_payload(
    track: TrackInfo,
    assignments: dict[int, int],
    volumes: dict[int, int],
    sources: dict[int, str],
    metadata: libvgm.LibvgmMetadata | nsf_chip.NsfChipMetadata | None,
    has_game_soundfont: bool,
) -> dict[str, Any]:
    # "game"の実体はフォーマットごとに異なる: VGM/NSFはmetadataのtargetが
    # トラックごとに実機レンダリング対象かどうかを表し、SPCにはそのような
    # 「共有チャンネルで曖昧」という概念が無いためgame_soundfont_path（SoundFont
    # が実際に生成できたか）だけで音符のある全トラックが等しく選べる。
    target = metadata.targets.get(track.index) if metadata else None
    has_game_source = target is not None or (has_game_soundfont and track.note_count > 0)
    is_suggested = target.suggested if target else has_game_source
    available_sources = ["soundfont", "game"] if has_game_source else ["soundfont"]
    return {
        "index": track.index,
        "name": track.name,
        "channels": list(track.channels),
        "noteCount": track.note_count,
        "currentProgram": track.current_program,
        "programChangeCount": track.program_change_count,
        "assignedProgram": assignments.get(track.index),
        "volumePercent": volumes.get(track.index, track.source_volume_percent),
        "sourceVolumePercent": track.source_volume_percent,
        "volumeEditable": track.note_count > 0,
        "editable": track.editable,
        "reason": track.reason,
        "source": sources.get(track.index, "soundfont"),
        "availableSources": available_sources,
        "sourceSuggested": is_suggested,
        "sourceGroupSize": len(metadata.group_indices(target.group_id)) if metadata and target else 1,
    }


def soundfont_payload(session: WebSession, default_soundfont: Path | None) -> dict[str, Any]:
    selected = session.soundfont_override or default_soundfont
    items = render.list_soundfonts()
    if (
        selected is not None
        and render.is_soundfont_file(selected)
        and all(item["path"] != str(selected) for item in items)
    ):
        items.insert(
            0,
            {
                "path": str(selected),
                "name": selected.name,
                "dir": str(selected.parent),
                "sizeBytes": selected.stat().st_size,
            },
        )
    return {
        "items": items,
        "selected": str(selected) if selected else None,
        "isOverride": session.soundfont_override is not None,
    }


def source_payload(session: WebSession) -> dict[str, Any] | None:
    if session.source_format is None:
        return None
    fmt = convert.format_by_key(session.source_format)
    active_file = None
    if session.source_path is not None and session.root is not None:
        active_file = session.source_path.relative_to(session.root).as_posix()
    return {
        "name": session.source_name,
        "format": fmt.key,
        "formatLabel": fmt.label,
        "metadata": session.source_metadata,
        "songs": session.source_songs,
        "options": convert.option_schema(fmt),
        "files": session.source_files,
        "activeFile": active_file,
        "hasPlaylist": len(session.source_m3u_texts) > 0,
        "convertedOptions": session.converted_options,
    }


def session_payload(session: WebSession) -> dict[str, Any]:
    return {
        "filename": session.original_name or None,
        "downloadStem": session.download_stem,
        "ticksPerBeat": session.ticks_per_beat,
        "trackCount": len(session.tracks),
        "tracks": [
            track_payload(
                track,
                session.assignments,
                session.volumes,
                session.track_sources,
                session.chip_metadata,
                session.game_soundfont_path is not None,
            )
            for track in session.tracks
        ],
        "speed": session.speed_ratio,
        "transpose": session.transpose_semitones,
        "hasRender": session.audio_path is not None and session.audio_path.exists(),
        "renderId": session.render_id,
        "renderMode": session.current_render_mode,
        "hasDownload": session.original_path is not None,
        "hasChipStem": session.chip_stem_path is not None,
        "hasDacStem": session.dac_stem_path is not None,
        "hasGameSoundfont": session.game_soundfont_path is not None,
        "source": source_payload(session),
    }


def _project_member_path(root: Path, member: str, label: str) -> Path:
    """プロジェクト展開先配下のファイルだけを解決する。"""
    if not isinstance(member, str) or not member:
        raise WebValidationError(f"プロジェクトの{label}が不正です")
    candidate = (root / member).resolve()
    if candidate == root or root not in candidate.parents or not candidate.is_file():
        raise WebValidationError(f"プロジェクトの{label}が見つかりません")
    return candidate


def _project_metadata_payload(
    metadata: libvgm.LibvgmMetadata | nsf_chip.NsfChipMetadata | None,
) -> dict[str, Any] | None:
    """実機音源メタデータを既存loader互換のJSONへ直列化する。"""
    if metadata is None:
        return None
    if isinstance(metadata, libvgm.LibvgmMetadata):
        return {
            "type": "vgm",
            "payload": {
                "version": 1,
                "sampleCount": metadata.sample_count,
                "tracks": [
                    {
                        "trackIndex": index,
                        "libvgm": {
                            "deviceType": target.device_type,
                            "instance": target.instance,
                            "mainMask": target.main_mask,
                            "linkedMask": target.linked_mask,
                            "groupId": target.group_id,
                            "suggestedForHardwareMix": target.suggested,
                        },
                    }
                    for index, target in sorted(metadata.targets.items())
                ],
            },
        }
    return {
        "type": "nsf",
        "payload": {
            "version": 1,
            "sampleCount": metadata.sample_count,
            "tracks": [
                {
                    "trackIndex": index,
                    "chipRender": {
                        "channel": target.channel,
                        "groupId": target.group_id,
                        "suggestedForHardwareMix": target.suggested,
                    },
                }
                for index, target in sorted(metadata.targets.items())
            ],
        },
    }


def _variation_label(speed: float, transpose: int) -> str:
    """バリエーション1件分のファイル名ラベルを作る（例: "p-2_x1.2", "p+0_x1.0"）。

    pitch_shift.py._format_number()は再利用しない — あちらはpitch_shift.sh
    CLIの-s/-pへ渡す文字列を作る別の契約であり、ここは「ファイルシステム安全で
    人間可読なラベルを作る」という別の目的のため、向きを揃えると将来の
    ドリフトリスクになる。速度は常に小数第1位まで表示し、ピッチは正値と0にも
    符号を付けることで、CLIの出力形式と揃える。
    """
    speed_text = f"{speed:.1f}"
    return f"p{transpose:+d}_x{speed_text}"


def create_app(
    token: str | None = None,
    session: WebSession | None = None,
    soundfont: Path | None = None,
    renderer: RendererFunc | None = None,
    list_songs: ListSongsFunc | None = None,
    converter: ConvertFunc | None = None,
    pitch_shifter: PitchShiftFunc | None = None,
    mixer: MixerFunc | None = None,
    gain_applier: GainApplierFunc | None = None,
    libvgm_renderer: LibvgmRendererFunc | None = None,
    nsf_chip_renderer: NsfChipRendererFunc | None = None,
) -> Flask:
    """テスト可能なmiditrackローカルWebアプリを生成する。"""
    launch_token = token or secrets.token_urlsafe(32)
    web_session = session or WebSession()
    list_source_songs: ListSongsFunc = list_songs or convert.list_songs
    convert_to_midi: ConvertFunc = converter or convert.convert_to_midi
    run_pitch_shift: PitchShiftFunc = pitch_shifter or pitch_shift.run_pitch_shift
    render_libvgm: LibvgmRendererFunc = libvgm_renderer or libvgm.render_selection
    render_nsf_chip: NsfChipRendererFunc = nsf_chip_renderer or nsf_chip.render_selection

    def render_wav(
        midi_path: Path,
        wav_path: Path,
        selected_soundfont: Path | None,
        sample_rate: int,
    ) -> None:
        """本番レンダラへsample_rateを渡し、従来の3引数テスト注入も維持する。"""
        if renderer is not None:
            renderer(midi_path, wav_path, selected_soundfont)
            return
        render.render_wav(
            midi_path, wav_path, selected_soundfont, sample_rate=sample_rate
        )

    def mix_wav(
        inputs: list[tuple[Path, float]], output_path: Path, sample_rate: int
    ) -> None:
        """本番ミキサーへsample_rateを渡し、従来の2引数テスト注入も維持する。"""
        if mixer is not None:
            mixer(inputs, output_path)
            return
        mix.mix_wav(inputs, output_path, sample_rate=sample_rate)

    def apply_gain_wav(
        input_path: Path, output_path: Path, gain: float, sample_rate: int
    ) -> None:
        """本番ゲイン適用（mix.apply_gain）へsample_rateを渡し、テスト注入も可能にする。

        「トラックごとに出力」（POST /api/tracks/export）専用。gainが1.0のとき
        （実機ステム併用のない通常セッション）は呼び出し側がそもそも呼ばない
        ため、ffmpeg依存はchipNoise/gameSoundfontと同じく実際に必要な場合のみ発生する。
        """
        if gain_applier is not None:
            gain_applier(input_path, output_path, gain)
            return
        mix.apply_gain(input_path, output_path, gain, sample_rate=sample_rate)

    app = Flask(__name__, static_folder=str(ASSET_DIR), static_url_path="/assets")
    app.config.update(
        MAX_CONTENT_LENGTH=MAX_UPLOAD_BYTES,
        MIDITRACK_TOKEN=launch_token,
        MIDITRACK_SESSION=web_session,
    )

    @app.before_request
    def validate_local_request() -> Response | None:
        host = request.host.split(":", 1)[0].strip("[]")
        if host not in {"127.0.0.1", "localhost", "::1"}:
            return jsonify(error="ローカルホスト以外からは接続できません"), 403
        if request.origin:
            origin_host = urlparse(request.origin).hostname
            if origin_host not in {"127.0.0.1", "localhost", "::1"}:
                return jsonify(error="外部Originからの操作は拒否されました"), 403
        if request.path.startswith("/api/"):
            # <audio>要素はカスタムヘッダーを送れないため、GETの /api/audio に
            # 限りクエリ文字列トークンも許可する（Rangeシーク対応をfetch+blob
            # 変換なしで維持するため）。/api/download は通常のfetchで届くので
            # 対象に含めない。
            supplied = request.headers.get("X-Miditrack-Token", "")
            if not supplied and request.method == "GET" and request.path == "/api/audio":
                supplied = request.args.get("token", "")
            if not secrets.compare_digest(supplied, launch_token):
                return jsonify(error="起動トークンが一致しません"), 403
        return None

    @app.after_request
    def add_security_headers(response: Response) -> Response:
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self'; style-src 'self'; "
            "script-src 'self'; connect-src 'self'; media-src 'self'; "
            "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.errorhandler(WebValidationError)
    @app.errorhandler(MidiTrackError)
    def handle_validation_error(error: Exception) -> tuple[Response, int]:
        return jsonify(error=str(error)), 400

    @app.errorhandler(RenderError)
    @app.errorhandler(ConvertError)
    @app.errorhandler(PitchShiftError)
    @app.errorhandler(MixError)
    def handle_render_error(error: Exception) -> tuple[Response, int]:
        return jsonify(error=str(error)), 502

    @app.errorhandler(RequestEntityTooLarge)
    def handle_large_upload(_error: RequestEntityTooLarge) -> tuple[Response, int]:
        return jsonify(error="ファイルのサイズが大きすぎます"), 413

    def project_member_for_source(relative_path: str) -> str:
        """通常アップロードと読込済みプロジェクトの両方で安定した保存名を返す。"""
        if relative_path.split("/", 1)[0] == "source":
            return relative_path
        return f"source/{relative_path}"

    def validate_project_loop(raw_loop: Any) -> dict[str, Any]:
        """プロジェクトの区間ループ設定を検証する。"""
        if not isinstance(raw_loop, dict):
            raise WebValidationError("区間ループ設定が不正です")
        start = raw_loop.get("start")
        end = raw_loop.get("end")
        enabled = raw_loop.get("enabled", False)
        is_valid = (
            not isinstance(start, bool)
            and isinstance(start, (int, float))
            and not isinstance(end, bool)
            and isinstance(end, (int, float))
            and math.isfinite(start)
            and math.isfinite(end)
            and start >= 0
            and end > start
            and isinstance(enabled, bool)
        )
        if not is_valid:
            raise WebValidationError("区間ループの開始・終了設定が不正です")
        return {"start": float(start), "end": float(end), "enabled": enabled}

    def validate_project_roles(raw_roles: Any, track_indices: set[int]) -> dict[str, str]:
        """プロジェクトのトラック役割を検証する。"""
        if not isinstance(raw_roles, dict):
            raise WebValidationError("トラック役割設定が不正です")
        roles: dict[str, str] = {}
        for raw_index, role_id in raw_roles.items():
            try:
                track_index = int(raw_index)
            except (TypeError, ValueError):
                raise WebValidationError("トラック役割のトラック番号が不正です") from None
            if str(track_index) != str(raw_index) or track_index not in track_indices:
                raise WebValidationError("トラック役割のトラック番号が不正です")
            if not isinstance(role_id, str) or role_id not in TRACK_ROLE_IDS:
                raise WebValidationError("トラック役割が不正です")
            roles[str(track_index)] = role_id
        return roles

    def validate_preset_snapshot(raw_snapshot: Any, track_indices: set[int]) -> dict[str, Any]:
        """プリセット解除時に戻す音源・楽器設定を検証する。"""
        if not isinstance(raw_snapshot, dict):
            raise WebValidationError("編成プリセットの復元設定が不正です")
        raw_assignments = raw_snapshot.get("assignments")
        raw_sources = raw_snapshot.get("sources")
        expected_keys = {str(track_index) for track_index in track_indices}
        if (
            not isinstance(raw_assignments, dict)
            or not isinstance(raw_sources, dict)
            or set(raw_assignments) != expected_keys
            or set(raw_sources) != expected_keys
        ):
            raise WebValidationError("編成プリセットの復元設定が不正です")
        assignments: dict[str, int | None] = {}
        sources: dict[str, str] = {}
        for key in expected_keys:
            assignment = raw_assignments[key]
            source = raw_sources[key]
            if (
                isinstance(assignment, bool)
                or (assignment is not None and not isinstance(assignment, int))
                or (isinstance(assignment, int) and not 0 <= assignment <= 127)
                or source not in {"soundfont", "game"}
            ):
                raise WebValidationError("編成プリセットの復元設定が不正です")
            assignments[key] = assignment
            sources[key] = source
        return {"assignments": assignments, "sources": sources}

    def validate_project_ui(raw_ui: Any, tracks: list[TrackInfo]) -> dict[str, Any]:
        """プロジェクトへ保存するブラウザUI状態を検証する。"""
        if not isinstance(raw_ui, dict):
            raise WebValidationError("プロジェクトの画面設定はオブジェクトで指定してください")
        validated: dict[str, Any] = {
            "renderMode": _validate_render_mode(raw_ui.get("renderMode"))
        }
        track_indices = {track.index for track in tracks}
        if raw_ui.get("loop") is not None:
            validated["loop"] = validate_project_loop(raw_ui["loop"])
        preset_id = raw_ui.get("ensemblePreset")
        preset_definition = None
        if "ensemblePresetDefinition" in raw_ui and preset_id is None:
            raise WebValidationError("編成プリセットが指定されていません")
        if preset_id is not None:
            if not isinstance(preset_id, str):
                raise WebValidationError("編成プリセットが不正です")
            raw_definition = raw_ui.get("ensemblePresetDefinition")
            if raw_definition is not None:
                definitions = preferences.validate_ensemble_presets([raw_definition])
                preset_definition = definitions[0]
                if preset_definition["id"] != preset_id:
                    raise WebValidationError("編成プリセットの定義が一致しません")
            configured_ids = {
                preset["id"] for preset in preferences.load_preferences()["ensemblePresets"]
            }
            if preset_id not in configured_ids and preset_definition is None:
                raise WebValidationError("編成プリセットが見つかりません")
            validated["ensemblePreset"] = preset_id
            if preset_definition is not None:
                validated["ensemblePresetDefinition"] = preset_definition
        if "trackRoles" in raw_ui:
            validated["trackRoles"] = validate_project_roles(raw_ui["trackRoles"], track_indices)
        if "ensemblePresetSnapshot" in raw_ui:
            validated["ensemblePresetSnapshot"] = validate_preset_snapshot(
                raw_ui["ensemblePresetSnapshot"], track_indices
            )
        dependent_fields = {
            "trackRoles", "ensemblePresetDefinition", "ensemblePresetSnapshot",
        }
        if dependent_fields.intersection(validated) and preset_id is None:
            raise WebValidationError("編成プリセットが指定されていません")
        return validated

    def build_project_archive(ui_state: dict[str, Any]) -> Path:
        """現在の編集可能なセッションを`.miditrack`へ書き出す。"""
        if web_session.root is None or web_session.original_path is None:
            raise WebValidationError("先にMIDIファイルを読み込んでください")
        files: dict[str, Path] = {"midi/original.mid": web_session.original_path}
        source_section: dict[str, Any] | None = None
        if web_session.source_format is not None:
            source_files: list[dict[str, str]] = []
            source_members: dict[str, str] = {}
            for entry in web_session.source_files:
                raw_path = entry.get("path")
                name = entry.get("name")
                if not isinstance(raw_path, str) or not isinstance(name, str):
                    raise WebValidationError("セッションの音源ファイル情報が不正です")
                source_path = _project_member_path(web_session.root, raw_path, "音源ファイル")
                member = project_member_for_source(raw_path)
                files[member] = source_path
                source_members[raw_path] = member
                source_files.append({"path": member, "name": name})
            active_file = None
            if web_session.source_path is not None:
                raw_active = web_session.source_path.relative_to(web_session.root).as_posix()
                active_file = source_members.get(raw_active)
                if active_file is None:
                    active_file = project_member_for_source(raw_active)
                    files[active_file] = _project_member_path(
                        web_session.root, raw_active, "選択中の音源ファイル"
                    )
                    source_files.append({"path": active_file, "name": web_session.source_path.name})
            source_section = {
                "name": web_session.source_name,
                "format": web_session.source_format,
                "metadata": web_session.source_metadata,
                "songs": web_session.source_songs,
                "files": source_files,
                "activeFile": active_file,
                "playlists": web_session.source_m3u_texts,
                "songIndex": web_session.source_song_index,
                "convertedOptions": web_session.converted_options,
            }

        assets: dict[str, Any] = {"chipMetadata": _project_metadata_payload(web_session.chip_metadata)}
        for key, path, prefix in (
            ("chipStem", web_session.chip_stem_path, "assets/chip-stem.wav"),
            ("dacStem", web_session.dac_stem_path, "assets/dac-stem.wav"),
            ("gameSoundfont", web_session.game_soundfont_path, "assets/game-soundfont"),
        ):
            if path is not None and path.is_file():
                member = prefix if prefix.endswith(".wav") else f"{prefix}{path.suffix.lower()}"
                files[member] = path
                assets[key] = member
            else:
                assets[key] = None

        manifest = {
            "format": project.PROJECT_FORMAT,
            "version": project.PROJECT_VERSION,
            "midi": {
                "path": "midi/original.mid",
                "originalName": web_session.original_name,
                "downloadStem": web_session.download_stem,
            },
            "edits": {
                "assignments": web_session.assignments,
                "volumes": web_session.volumes,
                "sources": web_session.track_sources,
                "speed": web_session.speed_ratio,
                "transpose": web_session.transpose_semitones,
            },
            "source": source_section,
            "assets": assets,
            "soundfontPath": str(web_session.soundfont_override) if web_session.soundfont_override else None,
            "ui": ui_state,
        }
        archive_path = web_session.root / f"{_effective_download_stem(web_session)}{PROJECT_EXTENSION}"
        project.create_archive(archive_path, manifest, files)
        return archive_path

    def parse_project_index_map(raw: Any, label: str) -> dict[int, Any]:
        """JSONオブジェクトのトラック番号キーを整数へ戻す。"""
        if not isinstance(raw, dict):
            raise WebValidationError(f"プロジェクトの{label}が不正です")
        parsed: dict[int, Any] = {}
        for key, value in raw.items():
            try:
                index = int(key)
            except (TypeError, ValueError):
                raise WebValidationError(f"プロジェクトの{label}のトラック番号が不正です: {key}") from None
            if str(index) != str(key):
                raise WebValidationError(f"プロジェクトの{label}のトラック番号が不正です: {key}")
            parsed[index] = value
        return parsed

    def load_project_session(archive_path: Path) -> tuple[WebSession, dict[str, Any], list[str]]:
        """アーカイブを別セッションへ復元し、成功時だけ呼び出し側が置換できるようにする。"""
        project_root = Path(tempfile.mkdtemp(prefix="miditrack-project-")).resolve()
        try:
            extracted = project.extract_archive(archive_path, project_root)
            manifest = extracted.manifest
            raw_midi = manifest.get("midi")
            raw_edits = manifest.get("edits")
            if not isinstance(raw_midi, dict) or not isinstance(raw_edits, dict):
                raise WebValidationError("プロジェクトのMIDIまたは編集情報が不正です")
            original_path = _project_member_path(extracted.root, raw_midi.get("path"), "基準MIDI")
            original_name = raw_midi.get("originalName")
            if not isinstance(original_name, str) or not original_name:
                raise WebValidationError("プロジェクトの元ファイル名が不正です")
            midi_file, tracks = midi.analyze_midi_file(original_path)
            candidate = WebSession(root=project_root)
            candidate.load_midi(original_path, sanitize_stem(original_name), midi_file.ticks_per_beat, tracks)

            raw_source = manifest.get("source")
            if raw_source is not None:
                if not isinstance(raw_source, dict):
                    raise WebValidationError("プロジェクトの音源情報が不正です")
                source_format = raw_source.get("format")
                source_name = raw_source.get("name")
                source_files = raw_source.get("files")
                active_file = raw_source.get("activeFile")
                if not isinstance(source_format, str) or not isinstance(source_name, str):
                    raise WebValidationError("プロジェクトの音源情報が不正です")
                convert.format_by_key(source_format)
                if not isinstance(source_files, list) or not isinstance(active_file, str):
                    raise WebValidationError("プロジェクトの音源ファイル情報が不正です")
                candidate.source_format = source_format
                candidate.source_name = sanitize_stem(source_name)
                candidate.source_files = []
                for entry in source_files:
                    if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not isinstance(entry.get("name"), str):
                        raise WebValidationError("プロジェクトの音源ファイル情報が不正です")
                    path = _project_member_path(extracted.root, entry["path"], "音源ファイル")
                    candidate.source_files.append(
                        {"path": path.relative_to(project_root).as_posix(), "name": entry["name"]}
                    )
                active_path = _project_member_path(extracted.root, active_file, "選択中の音源ファイル")
                if active_path.relative_to(project_root).as_posix() not in {entry["path"] for entry in candidate.source_files}:
                    raise WebValidationError("選択中の音源ファイルが一覧に含まれていません")
                candidate.source_path = active_path
                metadata = raw_source.get("metadata", {})
                songs = raw_source.get("songs", [])
                playlists = raw_source.get("playlists", [])
                if not isinstance(metadata, dict) or not isinstance(songs, list) or not isinstance(playlists, list) or not all(isinstance(item, str) for item in playlists):
                    raise WebValidationError("プロジェクトの音源詳細が不正です")
                candidate.source_metadata = metadata
                candidate.source_songs = songs
                candidate.source_m3u_texts = playlists
                song_index = raw_source.get("songIndex")
                if song_index is not None and (isinstance(song_index, bool) or not isinstance(song_index, int)):
                    raise WebValidationError("プロジェクトの曲番号が不正です")
                candidate.source_song_index = song_index
                converted_options = raw_source.get("convertedOptions", {})
                if not isinstance(converted_options, dict):
                    raise WebValidationError("プロジェクトの変換オプションが不正です")
                candidate.converted_options = convert.validate_convert_options(
                    convert.format_by_key(source_format), songs, converted_options
                )

            raw_assets = manifest.get("assets", {})
            if not isinstance(raw_assets, dict):
                raise WebValidationError("プロジェクトの追加資産情報が不正です")
            raw_metadata = raw_assets.get("chipMetadata")
            if raw_metadata is not None:
                if not isinstance(raw_metadata, dict) or not isinstance(raw_metadata.get("type"), str) or not isinstance(raw_metadata.get("payload"), dict):
                    raise WebValidationError("プロジェクトの実機音源メタデータが不正です")
                metadata_path = project_root / ".miditrack-metadata.json"
                metadata_path.write_text(json.dumps(raw_metadata["payload"]), encoding="utf-8")
                if raw_metadata["type"] == "vgm":
                    candidate.chip_metadata = libvgm.load_metadata(metadata_path, len(tracks))
                elif raw_metadata["type"] == "nsf":
                    candidate.chip_metadata = nsf_chip.load_metadata(metadata_path, len(tracks))
                else:
                    raise WebValidationError("未対応の実機音源メタデータです")
            for key, attribute, label in (
                ("chipStem", "chip_stem_path", "チップステム"),
                ("dacStem", "dac_stem_path", "DACステム"),
                ("gameSoundfont", "game_soundfont_path", "ゲームSoundFont"),
            ):
                value = raw_assets.get(key)
                if value is not None:
                    setattr(candidate, attribute, _project_member_path(extracted.root, value, label))

            assignments = parse_project_index_map(raw_edits.get("assignments", {}), "音色設定")
            volumes = parse_project_index_map(raw_edits.get("volumes", {}), "音量設定")
            sources = parse_project_index_map(raw_edits.get("sources", {}), "音源設定")
            candidate.assignments = midi.validate_assignments(tracks, assignments)
            candidate.volumes = midi.validate_volumes(tracks, volumes)
            validated_sources = _validate_track_sources(candidate, tracks, sources)
            tracks_by_index = {track.index: track for track in tracks}
            for track_index, source in validated_sources.items():
                _set_track_source(candidate, tracks_by_index[track_index], source)
            candidate.speed_ratio = midi.validate_speed_ratio(raw_edits.get("speed"))
            candidate.transpose_semitones = midi.validate_transpose_semitones(raw_edits.get("transpose"))
            download_stem = raw_midi.get("downloadStem", "")
            if not isinstance(download_stem, str):
                raise WebValidationError("プロジェクトのダウンロード名が不正です")
            candidate.download_stem = sanitize_stem(download_stem) if download_stem.strip() else ""

            warnings: list[str] = []
            saved_soundfont = manifest.get("soundfontPath")
            if saved_soundfont is not None:
                if not isinstance(saved_soundfont, str):
                    raise WebValidationError("プロジェクトのSoundFont参照が不正です")
                soundfont_path = Path(saved_soundfont)
                if render.is_soundfont_file(soundfont_path):
                    candidate.soundfont_override = soundfont_path
                else:
                    warnings.append("保存されたSoundFontが見つからないため、既定を使用します。")

            raw_ui = manifest.get("ui", {})
            ui_state = validate_project_ui(raw_ui, tracks)
            return candidate, ui_state, warnings
        except Exception:
            shutil.rmtree(project_root, ignore_errors=True)
            raise

    @app.get("/")
    def index() -> Response:
        return send_file(ASSET_DIR / "index.html")

    @app.get("/api/instruments")
    def get_instruments() -> Response:
        return jsonify(families=instrument_catalog())

    @app.get("/api/preferences")
    def get_preferences() -> Response:
        return jsonify(**preferences.load_preferences())

    @app.patch("/api/preferences")
    def update_preferences() -> Response:
        """楽器選択の設定と編成プリセットを部分更新する。

        ブラウザセッションではなくプロセス全体で共有する設定なので、
        WebSessionではなくユーザーホーム配下のファイルへ直接読み書きする
        （preferences.py参照。起動のたびにポートが変わりlocalStorageの
        オリジンが変わってしまう問題を回避するため）。
        """
        body = request.get_json(silent=True) or {}
        allowed_fields = {
            "pinnedPrograms",
            "usageCounts",
            "displayMode",
            "roundedPianorollNotes",
            "outlinedPianorollNotes",
            "ensemblePresets",
        }
        if not any(field in body for field in allowed_fields):
            raise WebValidationError("更新する設定を指定してください")
        return jsonify(**preferences.save_preferences(body))

    @app.get("/api/soundfonts")
    def get_soundfonts() -> Response:
        return jsonify(**soundfont_payload(web_session, soundfont))

    @app.post("/api/soundfont")
    def set_soundfont() -> Response:
        body = request.get_json(silent=True) or {}
        raw_path = body.get("path")
        if raw_path is None:
            web_session.soundfont_override = None
        else:
            if not isinstance(raw_path, str) or not raw_path:
                raise WebValidationError("SoundFontのパスが不正です")
            candidate = Path(raw_path)
            if not render.is_soundfont_file(candidate):
                raise WebValidationError(f"SoundFontファイルが見つかりません: {raw_path}")
            web_session.soundfont_override = candidate
        web_session.invalidate_render()
        # ブラウザでの選択を次回起動でも復元できるよう永続化する
        # （run_server()の--soundfont未指定時の復元ロジックと対）。
        selected = web_session.soundfont_override
        preferences.save_preferences({"selectedSoundfont": str(selected) if selected else None})
        return jsonify(**soundfont_payload(web_session, soundfont))

    @app.post("/api/project/export")
    def export_project() -> Response:
        """現在の編集可能なセッションを`.miditrack`としてダウンロードする。"""
        web_session.require_tracks()
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            raise WebValidationError("プロジェクトの画面設定はオブジェクトで指定してください")
        archive_path = build_project_archive(validate_project_ui(body, web_session.require_tracks()))
        download_name = f"{_effective_download_stem(web_session)}{PROJECT_EXTENSION}"
        return send_file(
            archive_path,
            mimetype="application/vnd.miditrack.project+zip",
            as_attachment=True,
            download_name=download_name,
            max_age=0,
        )

    @app.post("/api/project/import")
    def import_project() -> Response:
        """プロジェクトを別セッションへ検証復元してから、現在状態を置換する。"""
        # Flask 3.1ではmultipart解析前にリクエスト単位の上限を変更できる。
        request.max_content_length = MAX_PROJECT_UPLOAD_BYTES
        upload = request.files.get("project")
        if upload is None or not upload.filename:
            raise WebValidationError(".miditrackファイルを選択してください")
        if not upload.filename.lower().endswith(PROJECT_EXTENSION):
            raise WebValidationError("拡張子が .miditrack のファイルを選択してください")
        staging_root = Path(tempfile.mkdtemp(prefix="miditrack-project-upload-"))
        try:
            archive_path = staging_root / "project.miditrack"
            upload.save(archive_path)
            candidate, ui_state, warnings = load_project_session(archive_path)
        finally:
            shutil.rmtree(staging_root, ignore_errors=True)

        # load_project_session()が成功するまで既存セッションへ一切触れない。
        web_session.clear()
        web_session.__dict__.update(candidate.__dict__)
        return jsonify(session=session_payload(web_session), uiState=ui_state, warnings=warnings)

    @app.get("/api/session")
    def get_session() -> Response:
        return jsonify(**session_payload(web_session))

    @app.post("/api/session")
    def create_session() -> tuple[Response, int]:
        upload = request.files.get("midi")
        if upload is None or not upload.filename:
            raise WebValidationError("MIDIファイルを選択してください")
        original_name = upload.filename
        if not original_name.lower().endswith(ALLOWED_MIDI_EXTENSIONS):
            raise WebValidationError("拡張子が .mid または .midi のファイルを選択してください")

        temp_root = Path(tempfile.mkdtemp(prefix="miditrack-"))
        try:
            original_path = temp_root / "original.mid"
            upload.save(original_path)
            midi_file, tracks = midi.analyze_midi_file(original_path)
            web_session.replace(
                root=temp_root,
                original_path=original_path,
                original_name=sanitize_stem(original_name),
                ticks_per_beat=midi_file.ticks_per_beat,
                tracks=tracks,
            )
        except Exception:
            shutil.rmtree(temp_root, ignore_errors=True)
            raise
        return jsonify(**session_payload(web_session)), 201

    @app.delete("/api/session")
    def delete_session() -> Response:
        web_session.clear()
        return jsonify(ok=True)

    @app.patch("/api/session/tracks")
    def update_tracks() -> Response:
        tracks = web_session.require_tracks()
        body = request.get_json(silent=True) or {}
        raw_assignments = body.get("assignments", {})
        raw_volumes = body.get("volumes", {})
        raw_sources = body.get("sources", {})
        if not isinstance(raw_assignments, dict):
            raise WebValidationError("assignmentsはオブジェクトで指定してください")
        if not isinstance(raw_volumes, dict):
            raise WebValidationError("volumesはオブジェクトで指定してください")
        if not isinstance(raw_sources, dict):
            raise WebValidationError("sourcesはオブジェクトで指定してください")
        if not raw_assignments and not raw_volumes and not raw_sources:
            raise WebValidationError("assignments、volumes、sourcesのいずれかを指定してください")

        parsed_assignments: dict[int, int | None] = {}
        for key, value in raw_assignments.items():
            try:
                track_index = int(key)
            except (TypeError, ValueError):
                raise WebValidationError(f"トラック番号が不正です: {key}") from None
            if value is not None and (not isinstance(value, int) or isinstance(value, bool)):
                raise WebValidationError(f"GMプログラム番号は整数で指定してください: {value}")
            parsed_assignments[track_index] = value

        parsed_volumes: dict[int, int | None] = {}
        for key, value in raw_volumes.items():
            try:
                track_index = int(key)
            except (TypeError, ValueError):
                raise WebValidationError(f"トラック番号が不正です: {key}") from None
            if value is not None and (not isinstance(value, int) or isinstance(value, bool)):
                raise WebValidationError(f"トラック音量は整数で指定してください: {value}")
            parsed_volumes[track_index] = value

        parsed_sources: dict[int, str] = {}
        valid_track_indices = {track.index for track in tracks}
        for key, value in raw_sources.items():
            try:
                track_index = int(key)
            except (TypeError, ValueError):
                raise WebValidationError(f"トラック番号が不正です: {key}") from None
            if not isinstance(value, str):
                raise WebValidationError(f"トラック音源は文字列で指定してください: {value}")
            if track_index not in valid_track_indices:
                raise WebValidationError(f"トラック番号が不正です: {track_index}")
            parsed_sources[track_index] = value

        validated_assignments = midi.validate_assignments(tracks, parsed_assignments)
        validated_volumes = midi.validate_volumes(tracks, parsed_volumes)
        validated_sources = _validate_track_sources(
            web_session, tracks, parsed_sources
        )

        tracks_by_index = {track.index: track for track in tracks}
        for track_index, value in parsed_assignments.items():
            if value is None:
                web_session.assignments.pop(track_index, None)
        for track_index, value in parsed_volumes.items():
            track = tracks_by_index.get(track_index)
            baseline = track.source_volume_percent if track else midi.DEFAULT_TRACK_VOLUME_PERCENT
            if value is None or value == baseline:
                web_session.volumes.pop(track_index, None)
        web_session.assignments.update(validated_assignments)
        web_session.volumes.update(validated_volumes)
        for track_index, source in validated_sources.items():
            _set_track_source(web_session, tracks_by_index[track_index], source)
        # 従来APIとの互換性: SPCで音色だけを指定した場合もGM SoundFontへ切り替え、
        # 指定解除だけなら原曲の音色へ戻す。sourcesが同時指定された場合はそちらを優先。
        for track_index, program in parsed_assignments.items():
            if track_index in parsed_sources:
                continue
            track = tracks_by_index[track_index]
            if web_session.game_soundfont_path is not None and track.note_count > 0:
                _set_track_source(
                    web_session, track, "soundfont" if program is not None else "game"
                )
        # 原曲のプログラム番号はGM音色番号ではないため、音源だけSoundFontへ
        # 切り替えた編集可能トラックにはGM 81を安全な初期値として設定する。
        for track_index, source in validated_sources.items():
            track = tracks_by_index[track_index]
            if source == "soundfont" and track.editable:
                web_session.assignments.setdefault(track_index, DEFAULT_GM_PROGRAM)
        web_session.invalidate_render()
        return jsonify(**session_payload(web_session))

    @app.patch("/api/session/transform")
    def update_transform() -> Response:
        """セッション全体の速度倍率・移調（半音）を更新する。

        音色・音量はトラックごとの割り当てだが、こちらはファイル全体に対して
        1組だけの設定なので、POST /api/soundfontと同様に独立したエンドポイントに
        分ける（PATCH /api/session/tracksへは相乗りさせない）。
        """
        web_session.require_tracks()
        body = request.get_json(silent=True) or {}
        if "speed" not in body and "transpose" not in body:
            raise WebValidationError("speedまたはtransposeを指定してください")

        if "speed" in body:
            web_session.speed_ratio = midi.validate_speed_ratio(body["speed"])
        if "transpose" in body:
            web_session.transpose_semitones = midi.validate_transpose_semitones(body["transpose"])

        web_session.invalidate_render()
        return jsonify(**session_payload(web_session))

    @app.patch("/api/session/filename")
    def update_download_filename() -> Response:
        """MIDI/WAV単体ダウンロードとバリエーション・トラック別ZIPが使うベースファイル名を更新する。

        speed/transpose（PATCH /api/session/transform）と同様、ファイル全体に対して
        1つだけの設定なので独立エンドポイントに分ける。空文字列（または空白のみ）を
        送ると明示指定を解除し、アップロード時のファイル名（original_name）に戻る。
        既に生成済みのバリエーションZIP・トラック別ZIPは内部の各ファイル名が古い
        stemのまま残ってしまうため、ここで無効化して次回ダウンロード時に再生成させる
        （試聴用のapplied_path/audio_pathはファイル名の変更で内容が変わるわけでは
        ないのでinvalidate_render()は使わず、両ZIPだけを個別に無効化する）。
        """
        web_session.require_tracks()
        body = request.get_json(silent=True) or {}
        if "name" not in body:
            raise WebValidationError("nameを指定してください")
        raw_name = body["name"]
        if not isinstance(raw_name, str):
            raise WebValidationError("nameは文字列で指定してください")
        new_stem = sanitize_stem(raw_name) if raw_name.strip() else ""
        if new_stem != web_session.download_stem:
            web_session.download_stem = new_stem
            web_session.variations_zip_path = None
            web_session.track_export_zip_path = None
        return jsonify(**session_payload(web_session))

    @app.get("/api/pianoroll")
    def get_pianoroll() -> Response:
        """現在のMIDIから、レンダリング非依存のピアノロール情報を返す。"""
        web_session.require_tracks()
        if web_session.original_path is None:
            raise WebValidationError("先にMIDIファイルをアップロードしてください")
        original_path = web_session.original_path
        speed = web_session.speed_ratio
        transpose = web_session.transpose_semitones
        return jsonify(
            **pianoroll.extract_notes(original_path, speed=speed, transpose=transpose)
        )

    def _validate_render_mode(raw_mode: Any) -> str:
        """APIから受け取った試聴モードを検証して返す。"""
        mode = raw_mode if raw_mode is not None else FAST_RENDER_MODE
        if mode not in RENDER_SAMPLE_RATES:
            raise WebValidationError("renderModeはfastまたはqualityで指定してください")
        return mode

    def _path_signature(path: Path | None) -> tuple[str, int, int] | None:
        """キャッシュキー用にファイルのパス・サイズ・更新時刻を返す。"""
        if path is None:
            return None
        try:
            stat = path.stat()
        except OSError:
            return (str(path), -1, -1)
        return (str(path.resolve()), stat.st_size, stat.st_mtime_ns)

    def _render_state_key(mode: str) -> str:
        """現在の編集状態とレンダープロファイルから決定論的なキーを作る。"""
        metadata_sample_count = (
            web_session.chip_metadata.sample_count
            if web_session.chip_metadata is not None
            else None
        )
        effective_soundfont = web_session.soundfont_override or soundfont
        payload = {
            "version": RENDER_CACHE_VERSION,
            "midiRevision": web_session.midi_revision,
            "assignments": sorted(web_session.assignments.items()),
            "volumes": sorted(web_session.volumes.items()),
            "sources": sorted(web_session.track_sources.items()),
            "speed": web_session.speed_ratio,
            "transpose": web_session.transpose_semitones,
            "sourceFormat": web_session.source_format,
            "sourceSongIndex": web_session.source_song_index,
            "sampleCount": metadata_sample_count,
            "soundfont": _path_signature(effective_soundfont),
            "gameSoundfont": _path_signature(web_session.game_soundfont_path),
            "chipStem": _path_signature(web_session.chip_stem_path),
            "dacStem": _path_signature(web_session.dac_stem_path),
            "mode": mode,
            "sampleRate": RENDER_SAMPLE_RATES[mode],
        }
        encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    def _cache_lookup(cache_key: str) -> Path | None:
        """LRUキャッシュから有効なWAVを返し、参照順を更新する。"""
        entry = web_session.render_cache.get(cache_key)
        if entry is None:
            return None
        if not entry.path.exists() or entry.path.stat().st_size <= 44:
            web_session.render_cache.pop(cache_key, None)
            web_session.render_cache_bytes -= entry.size_bytes
            return None
        web_session.render_cache.move_to_end(cache_key)
        return entry.path

    def _evict_render_cache(protected_paths: set[Path]) -> None:
        """現在利用中のWAVを残し、件数・容量上限まで古いキャッシュを削除する。"""
        while (
            len(web_session.render_cache) > RENDER_CACHE_MAX_ENTRIES
            or web_session.render_cache_bytes > RENDER_CACHE_MAX_BYTES
        ):
            evicted = False
            for cache_key, entry in list(web_session.render_cache.items()):
                if entry.path in protected_paths:
                    continue
                web_session.render_cache.pop(cache_key)
                web_session.render_cache_bytes -= entry.size_bytes
                entry.path.unlink(missing_ok=True)
                evicted = True
                break
            if not evicted:
                break

    def _cache_store(
        cache_key: str, path: Path, protected_paths: set[Path] | None = None
    ) -> Path:
        """完成済みWAVをLRUへ登録し、上限を超えた古い項目を削除する。"""
        old_entry = web_session.render_cache.pop(cache_key, None)
        if old_entry is not None:
            web_session.render_cache_bytes -= old_entry.size_bytes
            if old_entry.path != path:
                old_entry.path.unlink(missing_ok=True)
        entry = CachedAudio(path=path, size_bytes=path.stat().st_size)
        web_session.render_cache[cache_key] = entry
        web_session.render_cache_bytes += entry.size_bytes
        protected = set(protected_paths or ())
        protected.add(path)
        if web_session.audio_path is not None:
            protected.add(web_session.audio_path)
        # クロスフェード中に旧render_idへ引き続き応答する必要のあるWAVも、
        # LRU追い出しの対象から外す（audio_sources自体の説明を参照）。
        protected.update(web_session.audio_sources.values())
        _evict_render_cache(protected)
        return path

    def _cache_output_path(kind: str, cache_key: str) -> Path:
        """セッションキャッシュ内の衝突しないWAVパスを返す。"""
        assert web_session.root is not None
        cache_dir = web_session.root / "render-cache"
        cache_dir.mkdir(exist_ok=True)
        return cache_dir / f"{kind}-{cache_key[:24]}.wav"

    def _apply_to(output_path: Path, speed: float, transpose: int) -> dict[str, int]:
        """assignments・volumesを適用したMIDIをoutput_pathへ書き、summaryを返す。

        常にoriginal_pathを読み直すので冪等（apply_assignments()自身の契約）。
        speed/transposeを引数で受けるのは、バリエーション一括生成
        （POST /api/variations）がweb_session.speed_ratio/transpose_semitonesを
        一切書き換えずに任意の組み合わせを適用できるようにするため — サーバーは
        threaded=Trueで動くため、一括生成中にセッションの値を一時的に書き換えると
        並行するGET /api/sessionに偽の値を見せてしまう（miditrack/CLAUDE.md参照）。
        """
        active_assignments = {
            index: program
            for index, program in web_session.assignments.items()
            if _selected_track_source(web_session, web_session.tracks[index]) == "soundfont"
        }
        # 実効音量: ユーザーが動かした値（web_session.volumes）を優先し、未操作でも
        # 変換元CC7由来のsource_volume_percentが既定値でないトラックはそれを渡す
        # （validate_volumes()はそれをユーザー入力と一致した時点で除外しているため、
        # ここで補わないとapply_assignments()にそのトラックの音量変更意図が伝わらない）。
        effective_volumes = {
            track.index: web_session.volumes.get(track.index, track.source_volume_percent)
            for track in web_session.tracks
            if track.index in web_session.volumes
            or track.source_volume_percent != midi.DEFAULT_TRACK_VOLUME_PERCENT
        }
        source_volumes = {track.index: track.source_volume_percent for track in web_session.tracks}
        return midi.apply_assignments(
            web_session.original_path,
            active_assignments,
            output_path,
            effective_volumes,
            source_volumes,
            speed=speed,
            transpose=transpose,
        )

    def ensure_applied() -> Path:
        """assignments適用済みのMIDIパスを返す。未適用ならその場で適用する。

        invalidate_render()がapplied_path/apply_summaryを対で無効化するため、
        「未適用」は常に「割り当て変更後まだ一度もapplyしていない」と一致する。
        """
        if web_session.root is None or web_session.original_path is None:
            raise WebValidationError("MIDIファイルがアップロードされていません")
        for _attempt in range(3):
            if web_session.applied_path is not None:
                return web_session.applied_path
            state_revision = web_session.state_revision
            applied_path = web_session.root / "miditrack_edited.mid"
            apply_summary = _apply_to(
                applied_path, web_session.speed_ratio, web_session.transpose_semitones
            )
            if state_revision != web_session.state_revision:
                continue
            web_session.apply_summary = apply_summary
            web_session.applied_path = applied_path
            return applied_path
        raise WebValidationError("設定が連続して変更されたため、MIDIの適用をやり直してください")

    def _plan_render_jobs(
        applied_path: Path, gm_soundfont: Path | None, render_id: int
    ) -> list[tuple[Path, Path | None]]:
        """(MIDIパス, SoundFont) のレンダリングジョブを決める。

        VGM/NSFの実機チャンネルレンダリング選択行をMIDI側から除外した後、SPCの
        原曲音色とGM SoundFontの明示選択に従ってトラックを分割する。片側だけに
        音が残る場合は1ジョブ、両側に残る場合だけ2ジョブとしてensure_render()が
        後で加算する。"game"はSPCではSoundFontバンク切替（このMIDI分割に残る）、
        VGM/NSFでは実機チャンネルレンダリング（このMIDI分割から除外される）と
        意味が異なるため、CHIP_HARDWARE_SOURCE_FORMATSで判定する。
        """
        all_indices = set(range(len(web_session.tracks)))
        chip_render_indices = (
            {
                index for index, source in web_session.track_sources.items()
                if source == "game"
            }
            if web_session.source_format in CHIP_HARDWARE_SOURCE_FORMATS
            else set()
        )
        audible_indices = all_indices - chip_render_indices
        dry_path = applied_path
        if audible_indices != all_indices:
            dry_path = web_session.root / f"render-{render_id:04d}.dry.mid"
            if not midi.write_track_subset(applied_path, audible_indices, dry_path):
                return []

        game_sf = web_session.game_soundfont_path
        if game_sf is None or not game_sf.exists():
            return [(dry_path, gm_soundfont)]

        gm_indices = {
            track.index for track in web_session.tracks
            if track.note_count > 0
            and track.index in audible_indices
            and _selected_track_source(web_session, track) == "soundfont"
        }
        if not gm_indices:
            # 既定状態: 全トラックをゲーム音源で鳴らす。分割もミックスも不要。
            return [(dry_path, game_sf)]

        game_mid = web_session.root / f"render-{render_id:04d}.game.mid"
        gm_mid = web_session.root / f"render-{render_id:04d}.gm.mid"
        gm_indices &= audible_indices
        game_has_notes = midi.write_track_subset(
            applied_path, audible_indices - gm_indices, game_mid
        )
        gm_has_notes = midi.write_track_subset(
            applied_path, gm_indices, gm_mid, strip_bank_select=True
        )

        if game_has_notes and gm_has_notes:
            return [(game_mid, game_sf), (gm_mid, gm_soundfont)]
        if gm_has_notes:
            return [(gm_mid, gm_soundfont)]
        return [(game_mid, game_sf)]

    def _has_transform(speed: float, transpose: int) -> bool:
        return speed != midi.DEFAULT_SPEED_RATIO or transpose != midi.DEFAULT_TRANSPOSE_SEMITONES

    def _synced_stem(
        stem_path: Path, label: str, work_dir: Path, speed: float, transpose: int
    ) -> Path:
        """実機ステムを指定の速度・移調へpitch_shift.shで揃える。

        MIDI側のテンポ・ノート番号は既にapply_assignments()で変換済みだが、
        chip_stem_path/dac_stem_pathは実音声なのでMIDI側だけ変換すると
        再生時間・ピッチがずれる。組み合わせを常に1つ（[speed]×[transpose]）に
        限定して呼ぶため、run_pitch_shift()の戻り値は必ず1件で、
        pitch_shift.sh自身のファイル名生成規則を再実装する必要がない。
        speed/transposeを引数で受ける理由は_apply_to()と同じ
        （バリエーション一括生成がセッションの値を書き換えずに済むようにするため）。
        """
        stem_copy = work_dir / f"{label}.wav"
        shutil.copyfile(stem_path, stem_copy)
        outputs = run_pitch_shift(stem_copy, work_dir, [speed], [float(transpose)])
        return outputs[0]

    def _render_chip_targets(indices: list[int], output_path: Path) -> None:
        """指定したチャンネル(トラック)集合を1本のWAVへ実機/エミュレーションで
        レンダリングする。呼び出し元が選択チャンネルの存在・chip_metadataの
        存在を確認済みであることが前提。
        """
        assert web_session.source_path is not None
        if web_session.source_format == "vgm":
            assert isinstance(web_session.chip_metadata, libvgm.LibvgmMetadata)
            libvgm_targets = [
                web_session.chip_metadata.targets[index] for index in indices
            ]
            render_libvgm(
                web_session.source_path,
                output_path,
                web_session.chip_metadata.sample_count,
                libvgm_targets,
            )
        else:  # nsf
            assert isinstance(web_session.chip_metadata, nsf_chip.NsfChipMetadata)
            if web_session.source_song_index is None:
                raise RenderError("原曲の音源に対応する曲番号がありません")
            nsf_targets = [
                web_session.chip_metadata.targets[index] for index in indices
            ]
            render_nsf_chip(
                web_session.source_path,
                output_path,
                web_session.chip_metadata.sample_count,
                nsf_targets,
                web_session.source_song_index,
            )

    def _chip_cache_key(indices: list[int]) -> str:
        """選択チャンネル集合に対する実機生WAVのキャッシュキーを返す。"""
        assert web_session.chip_metadata is not None
        payload = {
            "version": RENDER_CACHE_VERSION,
            "midiRevision": web_session.midi_revision,
            "source": _path_signature(web_session.source_path),
            "format": web_session.source_format,
            "songIndex": web_session.source_song_index,
            "sampleCount": web_session.chip_metadata.sample_count,
            "indices": sorted(indices),
        }
        encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
        return "chip:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    def _plan_chip_hardware(*, per_track: bool = False) -> ChipHardwarePlan:
        """VGM/NSFの実機音声入力を決め、キャッシュミスを未実行のまま返す。

        既定（per_track=False）では、音量が既定(100%)のチャンネルはまとめて1回、
        音量を変更したチャンネルだけチャンネル単位で個別にレンダリングする —
        個別レンダリングはVGM/NSFの全曲再エミュレーションをチャンネルの数だけ
        繰り返すコストがあるため、実際に音量調整されたチャンネルだけに限定する
        （miditrack/CLAUDE.md「Why per-track volume on 'game' tracks only
        re-renders the channels whose volume actually changed」参照）。
        実行を分離することで、通常レンダーではFluidSynthと同じ最大2枠へ投入できる。

        per_track=Trueは「トラックごとに出力」（POST /api/tracks/export）専用の
        分岐で、音量が既定かどうかに関わらず選択チャンネルを常に1つずつ個別の
        WAVへレンダリングする（コストは承知の上でユーザーが明示的にチェックを
        外した場合のみ）。ゲインの求め方自体は既定分岐の「音量変更チャンネル」
        と同じ式を全チャンネルに適用するだけなので、実装を分岐後半で共有する。
        """
        selected_chip_indices = (
            [
                index for index, source in web_session.track_sources.items()
                if source == "game"
            ]
            if web_session.source_format in CHIP_HARDWARE_SOURCE_FORMATS
            else []
        )
        if not selected_chip_indices or not web_session.chip_metadata:
            return ChipHardwarePlan(inputs=[], misses=[])
        if web_session.source_path is None:
            raise RenderError("原曲の音源の元ファイルがありません")

        # ここでのbaselineはトラックの変換元CC7由来の音量(source_volume_percent)。
        # 実機レンダリング音声には変換元の音量が既にそのまま含まれているため、
        # 「未操作＝そのままbaselineの音量で鳴る」チャンネルはbaselineが100%
        # でなくてもdefault_indices（追加ゲイン無し）扱いにする。ユーザーが実際に
        # 操作したチャンネルだけ、baselineを基準にした相対ゲインで個別レンダリング
        # する。
        tracks_by_index = {track.index: track for track in web_session.tracks}
        baseline_for = (
            lambda index: tracks_by_index[index].source_volume_percent
            if index in tracks_by_index
            else midi.DEFAULT_TRACK_VOLUME_PERCENT
        )

        plans: list[tuple[list[int], float]] = []
        if per_track:
            for index in sorted(selected_chip_indices):
                baseline_percent = baseline_for(index) or midi.DEFAULT_TRACK_VOLUME_PERCENT
                volume_percent = web_session.volumes.get(index, baseline_percent)
                plans.append(
                    ([index], mix.STEM_GAIN * volume_percent / baseline_percent)
                )
        else:
            default_indices = sorted(
                index for index in selected_chip_indices
                if index not in web_session.volumes
                or web_session.volumes[index] == baseline_for(index)
            )
            custom_indices = sorted(set(selected_chip_indices) - set(default_indices))
            if default_indices:
                plans.append((default_indices, mix.STEM_GAIN))
            for index in custom_indices:
                baseline_percent = baseline_for(index) or midi.DEFAULT_TRACK_VOLUME_PERCENT
                volume_percent = web_session.volumes.get(index, baseline_percent)
                plans.append(
                    ([index], mix.STEM_GAIN * volume_percent / baseline_percent)
                )

        results: list[tuple[Path, float]] = []
        misses: list[ChipCacheMiss] = []
        for indices, gain in plans:
            cache_key = _chip_cache_key(indices)
            cached_path = _cache_lookup(cache_key)
            if cached_path is None:
                cached_path = _cache_output_path("chip", cache_key)
                misses.append(ChipCacheMiss(cache_key, indices, cached_path))
            results.append((cached_path, gain))
        return ChipHardwarePlan(inputs=results, misses=misses)

    def _store_chip_hardware(plan: ChipHardwarePlan) -> None:
        """生成済みの実機音声キャッシュミスをLRUへ登録する。"""
        protected = {path for path, _gain in plan.inputs}
        for miss in plan.misses:
            _cache_store(miss.cache_key, miss.path, protected)

    def _render_chip_hardware(
        _work_dir: Path, _prefix: str, *, per_track: bool = False
    ) -> list[tuple[Path, float]]:
        """実機音声を最大2並列で生成し、バリエーション生成向けに返す。

        per_track=Trueは「トラックごとに出力」専用: _plan_chip_hardware()の
        同名引数をそのまま中継し、選択チャンネルを常に個別レンダリングさせる。
        """
        plan = _plan_chip_hardware(per_track=per_track)
        try:
            with ThreadPoolExecutor(max_workers=RENDER_WORKERS) as executor:
                futures = [
                    executor.submit(_render_chip_targets, miss.indices, miss.path)
                    for miss in plan.misses
                ]
                for future in futures:
                    future.result()
            _store_chip_hardware(plan)
        except Exception:
            for miss in plan.misses:
                miss.path.unlink(missing_ok=True)
            raise
        return plan.inputs

    def _render_applied_midi(
        applied_path: Path,
        wav_path: Path,
        *,
        render_id: int,
        speed: float,
        transpose: int,
        sample_rate: int = 44100,
        chip_render_stems: list[tuple[Path, float]] | None = None,
    ) -> None:
        """適用済みMIDI(applied_path)をwav_pathへレンダリングする。

        呼び出し元がweb_session.render_lockを保持していることが前提
        （render_id基点の一時ファイル名が同時実行と衝突しうるため、非再入の
        render_lockを1回だけ取ってから呼ぶ設計になっている）。

        _plan_render_jobs() が決めたジョブが1つだけ、かつ実機ノイズ/DPCM/DAC
        ステム（chip_stem_path・dac_stem_path・chip_render_stems）も無く、
        speed/transposeも既定値なら、従来どおりfluidsynthの出力を直接
        wav_pathへ書く。ジョブが2つ（ゲーム由来SoundFont側と手動指定した
        GM SoundFont側への分割）になった場合やステムがある場合は、各ジョブを
        一時的なrender-NNNN.partN.wavへレンダリングしてからmix_wav()で合成する。
        speed/transposeが既定値でなければ、ミックス前にステムだけを
        pitch_shift.shで同じ量だけ変換して同期を保つ（既定値のままなら通常
        ケースにrubberbandの依存を増やさないため一切呼ばない）。

        chip_render_stemsを渡さなければ、この関数自身が実機音声キャッシュを計画し、
        キャッシュミスをFluidSynthと同じ最大2並列の実行枠へ投入する。渡された場合は
        呼び出し元が所有するものとして再生成しない — バリエーション一括生成
        （POST /api/variations）が、speed/transposeに依存しないこの結果を
        全組み合わせで1回だけ生成して使い回すため。
        """
        chip_plan = ChipHardwarePlan(inputs=[], misses=[])
        if chip_render_stems is None:
            chip_plan = _plan_chip_hardware()
            chip_render_stems = chip_plan.inputs

        effective_soundfont = web_session.soundfont_override or soundfont
        jobs = _plan_render_jobs(applied_path, effective_soundfont, render_id)

        stem = web_session.chip_stem_path
        if stem is not None and not stem.exists():
            stem = None
        dac_stem = web_session.dac_stem_path
        if dac_stem is not None and not dac_stem.exists():
            dac_stem = None
        has_stem = stem is not None or dac_stem is not None or len(chip_render_stems) > 0
        has_transform = _has_transform(speed, transpose)

        # applied_pathは分割MIDIではなく渡された適用済みMIDIなので、レンダリング後に
        # 消してはいけない（/api/downloadや後続の組み合わせが引き続き参照しうる）。
        # 分割で新規に書いたgame.mid/gm.midだけをここに集め、パートWAVは下の
        # ループで追加する。
        temp_paths = [job_path for job_path, _sf in jobs if job_path != applied_path]
        stem_sync_dir: Path | None = None
        try:
            if has_stem and has_transform:
                stem_sync_dir = web_session.root / f"render-{render_id:04d}.stemsync"
                stem_sync_dir.mkdir()
                if stem is not None:
                    stem = _synced_stem(stem, "noise", stem_sync_dir, speed, transpose)
                if dac_stem is not None:
                    dac_stem = _synced_stem(dac_stem, "dac", stem_sync_dir, speed, transpose)
                chip_render_stems = [
                    (
                        _synced_stem(path, f"chiprender{index}", stem_sync_dir, speed, transpose),
                        gain,
                    )
                    for index, (path, gain) in enumerate(chip_render_stems)
                ]

            if len(jobs) == 1 and not has_stem:
                render_wav(jobs[0][0], wav_path, jobs[0][1], sample_rate)
            else:
                # 実機チップステム（ノイズ・DAC、どちらか片方または両方）と合成する
                # 場合だけヘッドルームを取る（mix.DRY_GAIN）。ゲームSF2側とGM側の
                # 2分割だけの場合は「1つの編曲を互いに素なトラック集合へ分割した
                # もの」を単純加算で復元するだけなのでヘッドルームは取らない
                # （mix.SPLIT_GAIN = 1.0）。
                fluid_gain = mix.DRY_GAIN if has_stem else mix.SPLIT_GAIN
                inputs: list[tuple[Path, float]] = []
                render_parts: list[tuple[Path, Path | None, Path]] = []
                for index, (job_mid, job_soundfont) in enumerate(jobs):
                    part_path = web_session.root / f"render-{render_id:04d}.part{index}.wav"
                    temp_paths.append(part_path)
                    render_parts.append((job_mid, job_soundfont, part_path))
                    inputs.append((part_path, fluid_gain))
                with ThreadPoolExecutor(max_workers=RENDER_WORKERS) as executor:
                    chip_futures = [
                        executor.submit(_render_chip_targets, miss.indices, miss.path)
                        for miss in chip_plan.misses
                    ]
                    render_futures = [
                        executor.submit(
                            render_wav,
                            job_mid,
                            part_path,
                            job_soundfont,
                            sample_rate,
                        )
                        for job_mid, job_soundfont, part_path in render_parts
                    ]
                    for future in chip_futures + render_futures:
                        future.result()
                _store_chip_hardware(chip_plan)
                if stem is not None:
                    inputs.append((stem, mix.STEM_GAIN))
                if dac_stem is not None:
                    inputs.append((dac_stem, mix.STEM_GAIN))
                inputs.extend(chip_render_stems)
                if len(inputs) == 1:
                    shutil.copyfile(inputs[0][0], wav_path)
                else:
                    mix_wav(inputs, wav_path, sample_rate)
        finally:
            for miss in chip_plan.misses:
                if miss.cache_key not in web_session.render_cache:
                    miss.path.unlink(missing_ok=True)
            for temp_path in temp_paths:
                temp_path.unlink(missing_ok=True)
            if stem_sync_dir is not None:
                shutil.rmtree(stem_sync_dir, ignore_errors=True)

    def ensure_render(mode: str, *, activate_player: bool) -> RenderOutcome:
        """指定モードのWAVをキャッシュから返すか生成する。

        activate_player=Trueの場合だけ/api/audioの現在音源とrender_idを更新する。
        品質モードをactivateせず生成すれば、試聴状態を変えずに最終WAVとして
        ダウンロードできる。
        """
        with web_session.render_lock:
            started_at = time.perf_counter()
            for _attempt in range(3):
                state_revision = web_session.state_revision
                applied_path = ensure_applied()
                state_key = _render_state_key(mode)
                cache_key = f"render:{state_key}"
                wav_path = _cache_lookup(cache_key)
                cache_hit = wav_path is not None
                generated_path: Path | None = None

                if wav_path is None:
                    web_session.render_id += 1
                    work_id = web_session.render_id
                    wav_path = _cache_output_path(mode, state_key)
                    generated_path = wav_path
                    try:
                        _render_applied_midi(
                            applied_path,
                            wav_path,
                            render_id=work_id,
                            speed=web_session.speed_ratio,
                            transpose=web_session.transpose_semitones,
                            sample_rate=RENDER_SAMPLE_RATES[mode],
                        )
                    except Exception:
                        generated_path.unlink(missing_ok=True)
                        raise

                if state_revision != web_session.state_revision:
                    if generated_path is not None:
                        generated_path.unlink(missing_ok=True)
                    continue

                if generated_path is not None:
                    _cache_store(cache_key, wav_path)
                break
            else:
                raise WebValidationError(
                    "設定が連続して変更されたため、レンダリングをやり直してください"
                )

            if activate_player:
                is_new_player_source = (
                    web_session.current_render_key != cache_key
                    or web_session.audio_path != wav_path
                )
                if is_new_player_source and cache_hit:
                    web_session.render_id += 1
                web_session.audio_path = wav_path
                web_session.current_render_key = cache_key
                web_session.current_render_mode = mode
                # 今回activateされたrender_idがこのWAVを指すよう記録する。旧render_id
                # 宛のリクエスト（クロスフェード中の旧<audio>要素）はget_audio()が
                # この辞書で解決し、audio_pathが差し替わった後も旧音源を返し続ける。
                web_session.audio_sources[web_session.render_id] = wav_path
                web_session.audio_sources.move_to_end(web_session.render_id)
                while len(web_session.audio_sources) > AUDIO_SOURCE_HISTORY_LIMIT:
                    web_session.audio_sources.popitem(last=False)

            render_ms = round((time.perf_counter() - started_at) * 1000)
            return RenderOutcome(
                path=wav_path,
                mode=mode,
                cache_key=cache_key,
                cache_hit=cache_hit,
                render_ms=render_ms,
            )

    @app.post("/api/render")
    def render_endpoint() -> Response:
        web_session.require_tracks()
        if web_session.root is None or web_session.original_path is None:
            raise WebValidationError("先にMIDIファイルをアップロードしてください")

        body = request.get_json(silent=True) or {}
        mode = _validate_render_mode(body.get("renderMode"))
        outcome = ensure_render(mode, activate_player=True)

        return jsonify(
            audioUrl=f"/api/audio?v={web_session.render_id}",
            renderId=web_session.render_id,
            filename=outcome.path.name,
            renderMode=outcome.mode,
            sampleRate=RENDER_SAMPLE_RATES[outcome.mode],
            cacheHit=outcome.cache_hit,
            renderMs=outcome.render_ms,
            **(web_session.apply_summary or {}),
        )

    @app.post("/api/render/prewarm")
    def prewarm_render_endpoint() -> Response:
        """現在状態の試聴WAVを生成するが、プレイヤー音源は切り替えない。"""
        web_session.require_tracks()
        if web_session.root is None or web_session.original_path is None:
            raise WebValidationError("先にMIDIファイルをアップロードしてください")
        body = request.get_json(silent=True) or {}
        mode = _validate_render_mode(body.get("renderMode"))
        outcome = ensure_render(mode, activate_player=False)
        return jsonify(
            status="ready",
            renderMode=outcome.mode,
            sampleRate=RENDER_SAMPLE_RATES[outcome.mode],
            cacheHit=outcome.cache_hit,
            renderMs=outcome.render_ms,
        )

    @app.get("/api/audio")
    def get_audio() -> Response:
        # ?v=<render_id>はaudio_sourcesで解決する。クロスフェード中は旧<audio>要素が
        # activate済みの新render_idより古いidへRangeリクエストを送り続けるため、
        # audio_pathが新音源へ差し替わった後もその要素には旧音源のバイトを返す必要が
        # ある。該当idが無い・既に破棄済み（reset_midi_state以降）の場合は、常に
        # 「現在の音源」を意味するaudio_pathへ従来どおりフォールバックする。
        audio_path = web_session.audio_path
        requested = request.args.get("v")
        if requested is not None:
            try:
                requested_id = int(requested)
            except ValueError:
                requested_id = None
            if requested_id is not None:
                candidate = web_session.audio_sources.get(requested_id)
                if candidate is not None and candidate.exists():
                    audio_path = candidate
        if audio_path is None or not audio_path.exists():
            raise WebValidationError("先に「適用して試聴」を実行してください")
        return send_file(audio_path, mimetype="audio/wav", conditional=True, max_age=0)

    @app.get("/api/download")
    def get_download() -> Response:
        if web_session.original_path is None or web_session.root is None:
            raise WebValidationError("MIDIファイルがアップロードされていません")
        applied_path = ensure_applied()
        download_name = f"{_effective_download_stem(web_session)}_miditrack.mid"
        return send_file(
            applied_path,
            mimetype="audio/midi",
            as_attachment=True,
            download_name=download_name,
        )

    @app.get("/api/download/wav")
    def get_download_wav() -> Response:
        if web_session.root is None or web_session.original_path is None:
            raise WebValidationError("MIDIファイルがアップロードされていません")
        outcome = ensure_render(QUALITY_RENDER_MODE, activate_player=False)
        download_name = f"{_effective_download_stem(web_session)}_miditrack.wav"
        return send_file(
            outcome.path,
            mimetype="audio/wav",
            as_attachment=True,
            download_name=download_name,
        )

    @app.post("/api/variations")
    def variations_endpoint() -> Response:
        """速度×ピッチの全組み合わせをMIDIレイヤーで生成し、WAV（+任意でMIDI）のZIPにまとめる。

        単体変換（PATCH /api/session/transform）と同じ_apply_to()/
        _render_applied_midi()を組み合わせの数だけ呼ぶ — rubberbandによるWAV
        後処理（旧実装）ではなく、組み合わせごとにMIDIのテンポ・ノート番号を
        書き換えて再レンダリングするため、音質劣化が無い。MIDIは各組み合わせの
        レンダリング元として常に生成するが、ZIPへ含めるかどうかは`includeMidi`
        （既定true）で選べる — DAWへ持ち込みたい場合はMIDIも欲しいが、単に
        音を量産して聴き比べたいだけならWAVのみでZIPを軽くしたいという両方の
        使い方があるため。
        ensure_render()を経由しないので事前の試聴レンダリングは不要で、既存の
        試聴WAV（audio_path）・セッションのspeed/transposeにも一切影響しない
        （threaded=Trueのサーバーで一括生成中にセッションを書き換えると並行する
        GET /api/sessionに偽の値を見せてしまうため、意図的にこの形にしている）。
        """
        web_session.require_tracks()
        if web_session.root is None or web_session.original_path is None:
            raise WebValidationError("MIDIファイルがアップロードされていません")

        body = request.get_json(silent=True) or {}
        speeds, transposes = midi.validate_variation_options(
            body.get("speeds"), body.get("transposes")
        )
        include_midi = body.get("includeMidi", True)
        if not isinstance(include_midi, bool):
            raise WebValidationError("includeMidiはtrue/falseで指定してください")

        work_dir = web_session.root / "variations_work"
        shutil.rmtree(work_dir, ignore_errors=True)
        work_dir.mkdir()
        items: list[dict[str, Any]] = []
        pairs: list[tuple[Path, Path]] = []
        try:
            with web_session.render_lock:
                # 実機チップ/DACレンダリングはspeed/transposeに依存しないため、
                # バッチ全体で1回だけ生成し全組み合わせで使い回す
                # （_render_applied_midi()のchip_render_stems引数）。
                shared_chip_stems = _render_chip_hardware(work_dir, "_chiprender")
                download_stem = _effective_download_stem(web_session)
                for speed, transpose in itertools.product(speeds, transposes):
                    label = _variation_label(speed, transpose)
                    mid_out = work_dir / f"{download_stem}_{label}.mid"
                    wav_out = work_dir / f"{download_stem}_{label}.wav"
                    _apply_to(mid_out, speed, transpose)
                    web_session.render_id += 1
                    _render_applied_midi(
                        mid_out,
                        wav_out,
                        render_id=web_session.render_id,
                        speed=speed,
                        transpose=transpose,
                        chip_render_stems=shared_chip_stems,
                    )
                    items.append(
                        {
                            "speed": speed,
                            "transpose": transpose,
                            "wav": wav_out.name,
                            "mid": mid_out.name if include_midi else None,
                        }
                    )
                    pairs.append((mid_out, wav_out))

            zip_path = web_session.root / "variations.zip"
            if web_session.variations_zip_path is not None:
                web_session.variations_zip_path.unlink(missing_ok=True)
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
                for mid_out, wav_out in pairs:
                    if include_midi:
                        archive.write(mid_out, arcname=mid_out.name)
                    archive.write(wav_out, arcname=wav_out.name)
            web_session.variations_zip_path = zip_path
        finally:
            # ZIPへ書き出した後は、個々の一時MIDI/WAVを持ち続ける理由がない。
            shutil.rmtree(work_dir, ignore_errors=True)

        return jsonify(items=items, downloadUrl="/api/download/variations")

    @app.get("/api/download/variations")
    def get_download_variations() -> Response:
        if (
            web_session.variations_zip_path is None
            or not web_session.variations_zip_path.exists()
        ):
            raise WebValidationError("先に「バリエーションをまとめて生成」を実行してください")
        download_name = f"{_effective_download_stem(web_session)}_variations.zip"
        return send_file(
            web_session.variations_zip_path,
            mimetype="application/zip",
            as_attachment=True,
            download_name=download_name,
        )

    @app.post("/api/tracks/export")
    def track_export_endpoint() -> Response:
        """トラックごとの音声を個別WAVへ分けてZIPにまとめる（「トラックごとに出力」）。

        全出力を単純加算すればGET /api/download/wavと同じ音になるよう、
        _render_applied_midi()と同じゲイン設計（実機ステム併用時のみ
        fluidsynth側にmix.DRY_GAIN、実機チップチャンネルは常にmix.STEM_GAIN
        ベース）を1トラックずつ焼き込む。分離不可能な実機ノイズ/DPCM・DAC
        ステムは1本のWAVにまとめ、VGM/NSFの実機チップチャンネルは既定で
        チャンネルごとに分離するが、groupChipTracks指定時は1本にまとめる
        （チャンネルごとの分離はチャンネル数だけ全曲再エミュレーションが
        走るため、ユーザーが明示的に選べるようにしている）。ノート数0・
        実効音量0%のトラックは無音WAVを増やすだけなので除外する。
        ensure_render()を経由しないので試聴レンダリングは不要で、既存の
        試聴WAV・セッションのspeed/transposeにも影響しない
        （POST /api/variationsと同じ設計判断）。
        """
        web_session.require_tracks()
        if web_session.root is None or web_session.original_path is None:
            raise WebValidationError("MIDIファイルがアップロードされていません")

        body = request.get_json(silent=True) or {}
        group_chip_tracks = body.get("groupChipTracks", False)
        if not isinstance(group_chip_tracks, bool):
            raise WebValidationError("groupChipTracksはtrue/falseで指定してください")

        work_dir = web_session.root / "track_export_work"
        shutil.rmtree(work_dir, ignore_errors=True)
        work_dir.mkdir()
        items: list[dict[str, Any]] = []
        export_paths: list[Path] = []
        used_names: set[str] = set()

        def unique_wav_name(base: str) -> str:
            candidate = f"{base}.wav"
            counter = 1
            while candidate in used_names:
                candidate = f"{base}_{counter}.wav"
                counter += 1
            used_names.add(candidate)
            return candidate

        def finalize_chip_input(raw_path: Path, gain: float, label: str, stem_dir: Path) -> Path:
            """1件の実機音声(raw_path, gain)を、必要なら速度/ピッチ同期しゲインを
            焼き込んだ独立WAVへ変換して返す（グループ化時にmix_wav()でまとめる
            前処理、または単独出力の最終処理として共通で使う）。
            """
            synced_path = raw_path
            if has_transform:
                synced_path = _synced_stem(raw_path, label, stem_dir, speed, transpose)
            if gain == 1.0:
                return synced_path
            gained_path = work_dir / f"{label}_gain.wav"
            apply_gain_wav(synced_path, gained_path, gain, 44100)
            return gained_path

        try:
            with web_session.render_lock:
                applied_path = ensure_applied()
                speed = web_session.speed_ratio
                transpose = web_session.transpose_semitones
                has_transform = _has_transform(speed, transpose)
                download_stem = _effective_download_stem(web_session)

                tracks_by_index = {track.index: track for track in web_session.tracks}

                def effective_volume(track: TrackInfo) -> int:
                    return web_session.volumes.get(track.index, track.source_volume_percent)

                audible_tracks = [
                    track for track in web_session.tracks
                    if track.note_count > 0 and effective_volume(track) != 0
                ]

                game_sf = web_session.game_soundfont_path
                if game_sf is not None and not game_sf.exists():
                    game_sf = None

                selected_chip_indices = sorted(
                    index for index, source in web_session.track_sources.items()
                    if source == "game"
                ) if web_session.source_format in CHIP_HARDWARE_SOURCE_FORMATS else []
                included_chip_indices = {
                    index for index in selected_chip_indices
                    if index in tracks_by_index
                    and tracks_by_index[index].note_count > 0
                    and effective_volume(tracks_by_index[index]) != 0
                }

                chip_plan = (
                    _plan_chip_hardware(per_track=not group_chip_tracks)
                    if selected_chip_indices
                    else ChipHardwarePlan(inputs=[], misses=[])
                )

                stem = web_session.chip_stem_path
                if stem is not None and not stem.exists():
                    stem = None
                dac_stem = web_session.dac_stem_path
                if dac_stem is not None and not dac_stem.exists():
                    dac_stem = None
                has_stem = stem is not None or dac_stem is not None or bool(chip_plan.inputs)
                fluidsynth_gain = mix.DRY_GAIN if has_stem else 1.0

                # fluidsynthジョブ: 実機チップ選択（VGM/NSF）以外の可聴トラックを
                # 1トラック1MIDIへ分割する。SPCの"game"はSoundFontバンク切替の
                # ままfluidsynthジョブに含める。
                fluidsynth_specs: list[tuple[TrackInfo, Path, Path, str]] = []
                fluidsynth_mid_paths: dict[int, Path] = {}
                for track in audible_tracks:
                    source = _selected_track_source(web_session, track)
                    if source == "game" and track.index in selected_chip_indices:
                        continue
                    if source == "game" and game_sf is not None:
                        soundfont_path: Path | None = game_sf
                        strip_bank_select = False
                        kind = "orig"
                    else:
                        soundfont_path = web_session.soundfont_override or soundfont
                        strip_bank_select = game_sf is not None
                        kind = "midi"
                    mid_out = work_dir / f"track{track.index}.mid"
                    has_notes = midi.write_track_subset(
                        applied_path, {track.index}, mid_out, strip_bank_select=strip_bank_select
                    )
                    if not has_notes:
                        continue
                    wav_out = work_dir / f"track{track.index}.wav"
                    fluidsynth_specs.append((track, wav_out, soundfont_path, kind))
                    # mid_outはこの後のrender_wav()呼び出しでしか使わないので、
                    # specへは埋め込まずクロージャのローカル辞書経由で参照する。
                    fluidsynth_mid_paths[track.index] = mid_out

                stem_sync_dir: Path | None = None
                if has_stem and has_transform:
                    stem_sync_dir = work_dir / "stemsync"
                    stem_sync_dir.mkdir()
                    if stem is not None:
                        stem = _synced_stem(stem, "noise", stem_sync_dir, speed, transpose)
                    if dac_stem is not None:
                        dac_stem = _synced_stem(dac_stem, "dac", stem_sync_dir, speed, transpose)

                chip_plan_misses = list(chip_plan.misses)
                try:
                    with ThreadPoolExecutor(max_workers=RENDER_WORKERS) as executor:
                        futures = [
                            executor.submit(
                                render_wav,
                                fluidsynth_mid_paths[track.index],
                                wav_out,
                                soundfont_path,
                                44100,
                            )
                            for track, wav_out, soundfont_path, _kind in fluidsynth_specs
                        ]
                        futures += [
                            executor.submit(_render_chip_targets, miss.indices, miss.path)
                            for miss in chip_plan_misses
                        ]
                        for future in futures:
                            future.result()
                    if selected_chip_indices:
                        _store_chip_hardware(chip_plan)
                except Exception:
                    for miss in chip_plan_misses:
                        miss.path.unlink(missing_ok=True)
                    raise

                # --- fluidsynthトラックの最終化 ---
                for track, wav_out, _soundfont_path, kind in fluidsynth_specs:
                    final_wav = wav_out
                    if fluidsynth_gain != 1.0:
                        gained_path = work_dir / f"track{track.index}_gain.wav"
                        apply_gain_wav(wav_out, gained_path, fluidsynth_gain, 44100)
                        final_wav = gained_path
                    label = _track_filename_label(track.name, track.index)
                    filename = unique_wav_name(f"{download_stem}_{label}_{kind}")
                    dest = work_dir / filename
                    shutil.move(str(final_wav), dest)
                    items.append({"track": track.name, "file": filename, "kind": kind})
                    export_paths.append(dest)

                # --- 実機チップチャンネルの最終化 ---
                if chip_plan.inputs:
                    if group_chip_tracks:
                        if len(chip_plan.inputs) == 1:
                            raw_path, gain = chip_plan.inputs[0]
                            combined = finalize_chip_input(raw_path, gain, "chiptracks", work_dir)
                        else:
                            synced_inputs = [
                                (
                                    _synced_stem(raw_path, f"chiptracksmix{i}", work_dir, speed, transpose)
                                    if has_transform
                                    else raw_path,
                                    gain,
                                )
                                for i, (raw_path, gain) in enumerate(chip_plan.inputs)
                            ]
                            combined = work_dir / "chiptracks_combined.wav"
                            mix_wav(synced_inputs, combined, 44100)
                        filename = unique_wav_name(f"{download_stem}_chiptracks_orig")
                        dest = work_dir / filename
                        shutil.move(str(combined), dest)
                        items.append({"track": "原曲の音源（まとめ）", "file": filename, "kind": "orig"})
                        export_paths.append(dest)
                    else:
                        for index, (raw_path, gain) in zip(selected_chip_indices, chip_plan.inputs):
                            if index not in included_chip_indices:
                                continue
                            final_path = finalize_chip_input(
                                raw_path, gain, f"chiprender{index}", work_dir
                            )
                            track = tracks_by_index[index]
                            label = _track_filename_label(track.name, track.index)
                            filename = unique_wav_name(f"{download_stem}_{label}_orig")
                            dest = work_dir / filename
                            shutil.move(str(final_path), dest)
                            items.append({"track": track.name, "file": filename, "kind": "orig"})
                            export_paths.append(dest)

                # --- 分離不可能な実機ステム（ノイズ/DPCM・DAC） ---
                if stem is not None:
                    final_stem = work_dir / "noise_stem_gain.wav"
                    apply_gain_wav(stem, final_stem, mix.STEM_GAIN, 44100)
                    filename = unique_wav_name(f"{download_stem}_noise_orig")
                    dest = work_dir / filename
                    shutil.move(str(final_stem), dest)
                    items.append({"track": "ノイズ/DPCM", "file": filename, "kind": "orig"})
                    export_paths.append(dest)
                if dac_stem is not None:
                    final_dac = work_dir / "dac_stem_gain.wav"
                    apply_gain_wav(dac_stem, final_dac, mix.STEM_GAIN, 44100)
                    filename = unique_wav_name(f"{download_stem}_dac_orig")
                    dest = work_dir / filename
                    shutil.move(str(final_dac), dest)
                    items.append({"track": "DAC", "file": filename, "kind": "orig"})
                    export_paths.append(dest)

                if not items:
                    raise WebValidationError("出力できるトラックがありません")

            zip_path = web_session.root / "track_export.zip"
            if web_session.track_export_zip_path is not None:
                web_session.track_export_zip_path.unlink(missing_ok=True)
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
                for path in export_paths:
                    archive.write(path, arcname=path.name)
            web_session.track_export_zip_path = zip_path
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

        return jsonify(items=items, downloadUrl="/api/download/tracks")

    @app.get("/api/download/tracks")
    def get_download_tracks() -> Response:
        if (
            web_session.track_export_zip_path is None
            or not web_session.track_export_zip_path.exists()
        ):
            raise WebValidationError("先に「トラックごとに出力」を実行してください")
        download_name = f"{_effective_download_stem(web_session)}_tracks.zip"
        return send_file(
            web_session.track_export_zip_path,
            mimetype="application/zip",
            as_attachment=True,
            download_name=download_name,
        )

    def _activate_source_file(path: Path) -> None:
        """指定した音源ファイルを「現在変換対象のファイル」にする（曲一覧を取り直す）。

        MIDI由来の状態はreset_midi_state()で初期化するが、root・source_files・
        source_m3u_texts（アップロード時にまとめて確定したもの）は変更しない —
        同じアップロード内の別ファイルへ何度でも切り替えられるようにするため。
        """
        fmt = convert.detect_format(path.name)
        web_session.reset_midi_state()
        web_session.source_path = path
        web_session.source_name = sanitize_stem(path.name)
        web_session.source_format = fmt.key

        if fmt.supports_song_list:
            metadata, songs = list_source_songs(fmt, path)
            for m3u_text in web_session.source_m3u_texts:
                entries = convert.filter_m3u_entries(convert.parse_m3u(m3u_text), path.name)
                if entries:
                    songs = convert.apply_m3u_titles(songs, entries)
                    break
        else:
            metadata, songs = {}, []

        web_session.source_metadata = metadata
        web_session.source_songs = songs

    @app.post("/api/source")
    def create_source() -> tuple[Response, int]:
        uploads = [f for f in request.files.getlist("source") if f and f.filename]
        if not uploads:
            raise WebValidationError("音源ファイルを選択してください")

        # resolve()しておかないと、extract_zip_members()内部のdest_dir.resolve()
        # （macOSの/var -> /private/var シンボリックリンク解決）と食い違い、
        # 展開後メンバーパスへの後段のrelative_to(temp_root)がValueErrorになる。
        temp_root = Path(tempfile.mkdtemp(prefix="miditrack-")).resolve()
        try:
            uploads_dir = temp_root / "uploads"
            uploads_dir.mkdir()
            archive_dir = temp_root / "archive"

            candidates: list[Path] = []
            m3u_texts: list[str] = []

            for index, upload in enumerate(uploads):
                original_name = upload.filename
                if convert.is_zip_filename(original_name):
                    zip_path = uploads_dir / f"upload_{index}.zip"
                    upload.save(zip_path)
                    for member in convert.extract_zip_members(zip_path, archive_dir):
                        if convert.is_hidden_member_name(member.name):
                            pass  # __MACOSX/._foo.spcや.DS_Store等の隠しファイルは無視する。
                        elif convert.is_m3u_filename(member.name):
                            m3u_texts.append(member.read_text(encoding="utf-8", errors="replace"))
                        elif convert.try_detect_format(member.name) is not None:
                            candidates.append(member)
                        # それ以外（readme・カバー画像等）はZIP同梱の付随ファイルとして無視する。
                elif convert.is_hidden_member_name(original_name):
                    pass  # 隠しファイルは無視する（ZIP同梱時と同じ扱い）。
                elif convert.is_m3u_filename(original_name):
                    saved = _unique_upload_path(uploads_dir, original_name)
                    upload.save(saved)
                    m3u_texts.append(saved.read_text(encoding="utf-8", errors="replace"))
                elif convert.try_detect_format(original_name) is not None:
                    saved = _unique_upload_path(uploads_dir, original_name)
                    upload.save(saved)
                    candidates.append(saved)
                # else: 未対応拡張子の付随ファイルは無視する（ZIP同梱時と同じ扱い）。

            if not candidates:
                supported = ", ".join(ext for f in convert.SOURCE_FORMATS for ext in f.extensions)
                raise WebValidationError(
                    f"対応する音源ファイルが見つかりません（対応: {supported}。"
                    "ZIPやm3uだけでは変換できません）"
                )

            candidates.sort(key=lambda p: p.relative_to(temp_root).as_posix())

            web_session.clear()
            web_session.root = temp_root
            web_session.source_files = [
                {"path": p.relative_to(temp_root).as_posix(), "name": p.name} for p in candidates
            ]
            web_session.source_m3u_texts = m3u_texts
            _activate_source_file(candidates[0])
        except Exception:
            shutil.rmtree(temp_root, ignore_errors=True)
            raise
        return jsonify(**session_payload(web_session)), 201

    @app.post("/api/source/select-file")
    def select_source_file() -> Response:
        if web_session.root is None or not web_session.source_files:
            raise WebValidationError("先に音源ファイルをアップロードしてください")
        body = request.get_json(silent=True) or {}
        relative = body.get("path")
        if not isinstance(relative, str) or not relative:
            raise WebValidationError("pathを指定してください")
        match = next((f for f in web_session.source_files if f["path"] == relative), None)
        if match is None:
            raise WebValidationError(f"未知のファイルです: {relative}")
        _activate_source_file(web_session.root / relative)
        return jsonify(**session_payload(web_session))

    @app.post("/api/source/convert")
    def convert_source() -> Response:
        if web_session.source_path is None or web_session.root is None or web_session.source_format is None:
            raise WebValidationError("先に音源ファイルをアップロードしてください")
        fmt = convert.format_by_key(web_session.source_format)

        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            raise WebValidationError("変換オプションはオブジェクトで指定してください")
        options = convert.validate_convert_options(fmt, web_session.source_songs, body)

        output_path = web_session.root / "converted.mid"
        chip_stem_path, dac_stem_path = convert_to_midi(
            fmt, web_session.source_path, output_path, options
        )

        midi_file, tracks = midi.analyze_midi_file(output_path)
        # "MIDIトラック <-> 実機チャンネル"sidecarはVGM/NSFそれぞれ独立した
        # モジュール（libvgm.py/nsf_chip.py）が読む。どちらも同じ形
        # （targets/group_indices()）を持つが、実体の型はフォーマットで決まる。
        track_metadata: libvgm.LibvgmMetadata | nsf_chip.NsfChipMetadata | None = None
        if fmt.key == "vgm":
            track_metadata = libvgm.load_metadata(
                libvgm.metadata_path_for(output_path), len(tracks)
            )
        elif fmt.key == "nsf":
            track_metadata = nsf_chip.load_metadata(
                nsf_chip.metadata_path_for(output_path), len(tracks)
            )

        stem = web_session.source_name
        if fmt.supports_song_list and options.get("songIndex") is not None:
            stem = f"{stem}_{options['songIndex']:02d}"

        web_session.load_midi(
            original_path=output_path,
            original_name=stem,
            ticks_per_beat=midi_file.ticks_per_beat,
            tracks=tracks,
        )
        # load_midi() -> reset_midi_state() が chip_stem_path/dac_stem_path/
        # game_soundfont_path/chip_metadata/track_sources を初期値に戻すため、
        # 必ずその後に代入する（順序を逆にすると今設定した値が消える）。
        web_session.chip_metadata = track_metadata
        web_session.source_song_index = options.get("songIndex")
        web_session.converted_options = options
        if track_metadata is not None:
            # 新しいnsf2midi/vgm2midiではトラック選択"game"を優先し、旧noise/dac
            # ステムを同時に混ぜない。sidecarが無い旧converter/fakeでは従来の
            # ステム経路を保つ（NSFの場合、その戻り値は現行_build_argv()では
            # 常にNoneだが、後方互換の旧converter/fakeがステムを返す余地は残す）。
            web_session.chip_stem_path = None
            web_session.dac_stem_path = None
            if options.get("chipNoise"):
                web_session.track_sources = {
                    index: "game"
                    for index, target in track_metadata.targets.items()
                    if target.suggested
                }
        else:
            web_session.chip_stem_path = chip_stem_path
            web_session.dac_stem_path = dac_stem_path
        web_session.game_soundfont_path = convert.produced_game_soundfont(output_path)
        if (
            fmt.key == "spc"
            and options.get("gameSoundfont")
            and web_session.game_soundfont_path is not None
        ):
            # VGM/NSFのchipNoiseと同じ「サジェスト対象を初期選択する」役割。
            # SPCには共有チャンネルで曖昧なケースが無く、音符のあるトラックは
            # 等しく原曲の音源へ切り替えられるため、対象は「音符のある全
            # トラック」になる（VGM/NSFのtarget.suggestedサブセットに相当）。
            web_session.track_sources = {
                track.index: "game" for track in tracks if track.note_count > 0
            }
        return jsonify(**session_payload(web_session))

    return app


def resolve_startup_soundfont_override(explicit_soundfont: Path | None) -> Path | None:
    """起動時のsoundfont_override初期値を決める。

    --soundfontが明示指定されなければ、前回ブラウザで選択したSoundFontを
    settings.jsonから復元する（miditrack/CLAUDE.md「Added: favorite
    instrument shortlist」参照）。明示指定があれば常にNoneを返す
    （soundfont_override or soundfontという既存の優先順位を変えないため、
    ランタイム選択が無い状態＝CLI指定がそのまま使われる状態にする）。
    """
    if explicit_soundfont is not None:
        return None
    saved_soundfont = preferences.load_preferences().get("selectedSoundfont")
    if saved_soundfont and render.is_soundfont_file(Path(saved_soundfont)):
        return Path(saved_soundfont)
    return None


def run_server(
    midi_path: Path | None = None,
    soundfont: Path | None = None,
    open_browser: bool = True,
) -> None:
    """127.0.0.1の空きポートでWeb UIを起動し、終了時に一時データを消す。"""
    token = secrets.token_urlsafe(32)
    session = WebSession()
    session.soundfont_override = resolve_startup_soundfont_override(soundfont)
    app = create_app(token=token, session=session, soundfont=soundfont)

    if midi_path is not None:
        temp_root = Path(tempfile.mkdtemp(prefix="miditrack-"))
        try:
            original_path = temp_root / "original.mid"
            shutil.copyfile(midi_path, original_path)
            midi_file, tracks = midi.analyze_midi_file(original_path)
            session.replace(
                root=temp_root,
                original_path=original_path,
                original_name=sanitize_stem(midi_path.name),
                ticks_per_beat=midi_file.ticks_per_beat,
                tracks=tracks,
            )
        except Exception:
            shutil.rmtree(temp_root, ignore_errors=True)
            raise

    server = make_server("127.0.0.1", 0, app, threaded=True)
    port = server.server_port
    url = f"http://127.0.0.1:{port}/?token={token}"
    print(f"miditrack Web UI: {url}")
    print("終了するにはこのターミナルで Ctrl-C を押してください。")
    sys.stdout.flush()
    if open_browser:
        threading.Timer(0.2, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nmiditrack Web UIを終了しました。")
    finally:
        server.shutdown()
        session.clear()


if __name__ == "__main__":  # pragma: no cover
    run_server()
