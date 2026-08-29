"""miditrackのローカルWebアプリ。

tools/pixelart_web.py と同型の単一セッション・ローカルFlaskツール:
127.0.0.1限定バインド、起動スコープのトークン認証、CDN不使用の自前JS/CSS、
一時ディレクトリでのセッション状態管理。詳細な設計判断は miditrack/CLAUDE.md
を参照。
"""

from __future__ import annotations

import itertools
import re
import secrets
import shutil
import sys
import tempfile
import threading
import webbrowser
import zipfile
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

from . import convert, libvgm, midi, mix, nsf_chip, pitch_shift, preferences, render
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
ALLOWED_MIDI_EXTENSIONS = (".mid", ".midi")

# トラック音源が実機チップレンダリング（原曲の音源をSoundFontではなく実機/
# エミュレーションで鳴らす方式）を持つフォーマット。SPCの"game"はBRRサンプル
# 由来SoundFontのバンク切り替えであり、これらとは別の仕組みなので含めない。
CHIP_HARDWARE_SOURCE_FORMATS = ("vgm", "nsf")

RendererFunc = Callable[[Path, Path, "Path | None"], None]
ListSongsFunc = Callable[[SourceFormat, Path], "tuple[dict[str, Any], list[dict[str, Any]]]"]
ConvertFunc = Callable[[SourceFormat, Path, Path, "dict[str, Any]"], "tuple[Path | None, Path | None]"]
PitchShiftFunc = Callable[[Path, Path, "list[float]", "list[float]"], "list[Path]"]
MixerFunc = Callable[["list[tuple[Path, float]]", Path], None]
LibvgmRendererFunc = Callable[
    [Path, Path, int, "list[libvgm.LibvgmTarget]"], None
]
NsfChipRendererFunc = Callable[
    [Path, Path, int, "list[nsf_chip.NsfChipTarget]", int], None
]


@dataclass
class WebSession:
    """1ブラウザセッション分のMIDI・割り当て・レンダリング結果を保持する。"""

    root: Path | None = None
    original_path: Path | None = None
    original_name: str = ""
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
    # ブラウザの音声キャッシュを確実に更新する世代番号。MIDI再変換やセッションの
    # clear()をまたいでもサーバープロセス中は単調増加させ、同じ/api/audio?v=Nを
    # 別内容へ再利用しない。プロセス再起動時は認証tokenも変わるため0開始で安全。
    render_id: int = 0
    # 「速度・ピッチのバリエーション」で生成したZIP（WAV+MIDI）。ensure_render()と
    # 同じ入力（assignments/volumes/track_sources/soundfont等）から作られる派生物
    # なので、audio_pathと同じタイミング（reset_midi_state/invalidate_render）で
    # 無効化する。ただし生成自体はensure_render()を経由しない
    # （_apply_to()/_render_applied_midi()を直接、組み合わせの数だけ呼ぶ）。
    variations_zip_path: Path | None = None
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
    # ZIP展開・複数ファイル同時アップロードで見つかった変換候補一覧
    # （{"path": rootからの相対パス, "name": basename} のリスト）。
    # 単一ファイルのアップロード時も要素数1で入る。
    source_files: list[dict[str, str]] = field(default_factory=list)
    # アップロード内で見つかったm3uプレイリストの生テキスト（複数あれば全部保持）。
    # ファイル切り替え（select-file）のたびに曲名解決へ再利用する。
    source_m3u_texts: list[str] = field(default_factory=list)

    def reset_midi_state(self) -> None:
        """MIDI（原本・トラック解析・割り当て・レンダリング結果）だけを初期状態に戻す。

        root・soundfont_override・source_*系フィールドは触らない。clear()と
        load_midi()の両方から呼ばれる共通処理。
        """
        if self.audio_path is not None:
            self.audio_path.unlink(missing_ok=True)
        if self.variations_zip_path is not None:
            self.variations_zip_path.unlink(missing_ok=True)
        self.original_path = None
        self.original_name = ""
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
        # unlink しない理由は上のフィールド定義コメントを参照。
        self.chip_stem_path = None
        self.dac_stem_path = None
        self.game_soundfont_path = None

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

        variations_zip_pathはensure_render()と同じ入力（assignments/volumes/
        track_sources/soundfont等）から作られる派生物なので同時に無効化する。
        ポインタをNoneにするだけで実ファイルの削除は次回生成時に行う
        （audio_path自身の扱いと同じ）。
        """
        self.applied_path = None
        self.apply_summary = None
        self.audio_path = None
        self.variations_zip_path = None

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


def _default_track_source(track: TrackInfo, has_game_soundfont: bool) -> str:
    """明示指定が無いトラックの音源を、変換済み資産から決める。"""
    if has_game_soundfont and track.note_count > 0:
        return "game"
    return "soundfont"


def _selected_track_source(session: WebSession, track: TrackInfo) -> str:
    """セッション上の明示指定を加味したトラックの実効音源を返す。"""
    default = _default_track_source(track, session.game_soundfont_path is not None)
    return session.track_sources.get(track.index, default)


def _set_track_source(session: WebSession, track: TrackInfo, source: str) -> None:
    """既定音源との差分だけをWebSessionへ保存する。"""
    default = _default_track_source(track, session.game_soundfont_path is not None)
    if source == default:
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
    target = metadata.targets.get(track.index) if metadata else None
    has_game_source = has_game_soundfont and track.note_count > 0
    default_source = _default_track_source(track, has_game_soundfont)
    available_sources = (
        ["soundfont", "game"] if target
        else ["game", "soundfont"] if has_game_source
        else ["soundfont"]
    )
    return {
        "index": track.index,
        "name": track.name,
        "channels": list(track.channels),
        "noteCount": track.note_count,
        "currentProgram": track.current_program,
        "programChangeCount": track.program_change_count,
        "assignedProgram": assignments.get(track.index),
        "volumePercent": volumes.get(track.index, midi.DEFAULT_TRACK_VOLUME_PERCENT),
        "volumeEditable": track.note_count > 0,
        "editable": track.editable,
        "reason": track.reason,
        "source": sources.get(track.index, default_source),
        "availableSources": available_sources,
        "sourceSuggested": target.suggested if target else False,
        "sourceGroupSize": len(metadata.group_indices(target.group_id)) if metadata and target else 1,
    }


def soundfont_payload(session: WebSession, default_soundfont: Path | None) -> dict[str, Any]:
    selected = session.soundfont_override or default_soundfont
    return {
        "items": render.list_soundfonts(),
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
    }


def session_payload(session: WebSession) -> dict[str, Any]:
    return {
        "filename": session.original_name or None,
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
        "hasRender": session.audio_path is not None,
        "renderId": session.render_id,
        "hasDownload": session.original_path is not None,
        "hasChipStem": session.chip_stem_path is not None,
        "hasDacStem": session.dac_stem_path is not None,
        "hasGameSoundfont": session.game_soundfont_path is not None,
        "source": source_payload(session),
    }


def _variation_label(speed: float, transpose: int) -> str:
    """バリエーション1件分のファイル名ラベルを作る（例: "x1.2_p-2", "x1_p0"）。

    pitch_shift.py._format_number()は再利用しない — あちらはpitch_shift.sh
    CLIの-s/-pへ渡す文字列を作る別の契約であり、ここは「ファイルシステム安全で
    人間可読なラベルを作る」という別の目的のため、向きを揃えると将来の
    ドリフトリスクになる。整数値は"1.0"ではなく"1"と素直な表記にする。
    """
    speed_text = str(int(speed)) if float(speed).is_integer() else str(speed)
    return f"x{speed_text}_p{transpose}"


def create_app(
    token: str | None = None,
    session: WebSession | None = None,
    soundfont: Path | None = None,
    renderer: RendererFunc | None = None,
    list_songs: ListSongsFunc | None = None,
    converter: ConvertFunc | None = None,
    pitch_shifter: PitchShiftFunc | None = None,
    mixer: MixerFunc | None = None,
    libvgm_renderer: LibvgmRendererFunc | None = None,
    nsf_chip_renderer: NsfChipRendererFunc | None = None,
) -> Flask:
    """テスト可能なmiditrackローカルWebアプリを生成する。"""
    launch_token = token or secrets.token_urlsafe(32)
    web_session = session or WebSession()
    render_wav: RendererFunc = renderer or render.render_wav
    list_source_songs: ListSongsFunc = list_songs or convert.list_songs
    convert_to_midi: ConvertFunc = converter or convert.convert_to_midi
    run_pitch_shift: PitchShiftFunc = pitch_shifter or pitch_shift.run_pitch_shift
    mix_wav: MixerFunc = mixer or mix.mix_wav
    render_libvgm: LibvgmRendererFunc = libvgm_renderer or libvgm.render_selection
    render_nsf_chip: NsfChipRendererFunc = nsf_chip_renderer or nsf_chip.render_selection

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
        """楽器選択の「よく使う」設定（ピン留め・使用回数）を部分更新する。

        ブラウザセッションではなくプロセス全体で共有する設定なので、
        WebSessionではなくユーザーホーム配下のファイルへ直接読み書きする
        （preferences.py参照。起動のたびにポートが変わりlocalStorageの
        オリジンが変わってしまう問題を回避するため）。
        """
        body = request.get_json(silent=True) or {}
        if "pinnedPrograms" not in body and "usageCounts" not in body:
            raise WebValidationError("pinnedProgramsまたはusageCountsを指定してください")
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

        for track_index, value in parsed_assignments.items():
            if value is None:
                web_session.assignments.pop(track_index, None)
        for track_index, value in parsed_volumes.items():
            if value is None or value == midi.DEFAULT_TRACK_VOLUME_PERCENT:
                web_session.volumes.pop(track_index, None)
        web_session.assignments.update(validated_assignments)
        web_session.volumes.update(validated_volumes)
        tracks_by_index = {track.index: track for track in tracks}
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
        return midi.apply_assignments(
            web_session.original_path,
            active_assignments,
            output_path,
            web_session.volumes,
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
        if web_session.applied_path is None:
            applied_path = web_session.root / "miditrack_edited.mid"
            web_session.apply_summary = _apply_to(
                applied_path, web_session.speed_ratio, web_session.transpose_semitones
            )
            web_session.applied_path = applied_path
        return web_session.applied_path

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

    def _render_chip_hardware(work_dir: Path, prefix: str) -> list[tuple[Path, float]]:
        """VGM/NSFの実機チャンネルレンダリング選択に従い、選択チャンネルの
        合成音声を生成する。音量が既定(100%)のチャンネルはまとめて1回、
        音量を変更したチャンネルだけチャンネル単位で個別にレンダリングする —
        個別レンダリングはVGM/NSFの全曲再エミュレーションをチャンネルの数だけ
        繰り返すコストがあるため、実際に音量調整されたチャンネルだけに限定する
        （miditrack/CLAUDE.md「Why per-track volume on 'game' tracks only
        re-renders the channels whose volume actually changed」参照）。
        speed/transposeに依存しないため、バリエーション一括生成
        （POST /api/variations）は全組み合わせでこの結果を1回だけ生成して使い回す。
        戻り値は(WAVパス, ゲイン)の列。選択が無ければ空リスト。
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
            return []
        if web_session.source_path is None:
            raise RenderError("原曲の音源の元ファイルがありません")

        default_indices = sorted(
            index for index in selected_chip_indices
            if web_session.volumes.get(index, midi.DEFAULT_TRACK_VOLUME_PERCENT)
            == midi.DEFAULT_TRACK_VOLUME_PERCENT
        )
        custom_indices = sorted(set(selected_chip_indices) - set(default_indices))

        results: list[tuple[Path, float]] = []
        if default_indices:
            stem_path = work_dir / f"{prefix}.wav"
            _render_chip_targets(default_indices, stem_path)
            results.append((stem_path, mix.STEM_GAIN))
        for index in custom_indices:
            stem_path = work_dir / f"{prefix}.track{index}.wav"
            _render_chip_targets([index], stem_path)
            volume_percent = web_session.volumes.get(index, midi.DEFAULT_TRACK_VOLUME_PERCENT)
            results.append((stem_path, mix.STEM_GAIN * volume_percent / 100))
        return results

    def _render_applied_midi(
        applied_path: Path,
        wav_path: Path,
        *,
        render_id: int,
        speed: float,
        transpose: int,
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

        chip_render_stemsを渡さなければ、この関数自身が_render_chip_hardware()を
        呼んで一時ファイルとして扱う（終了時に削除）。渡された場合は呼び出し元が
        所有するものとして削除しない — バリエーション一括生成
        （POST /api/variations）が、speed/transposeに依存しないこの結果を
        全組み合わせで1回だけ生成して使い回すため。
        """
        owns_chip_render_stems = chip_render_stems is None
        if owns_chip_render_stems:
            chip_render_stems = _render_chip_hardware(
                web_session.root, f"render-{render_id:04d}.chiprender"
            )

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
        if owns_chip_render_stems:
            temp_paths.extend(path for path, _gain in chip_render_stems)
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
                render_wav(jobs[0][0], wav_path, jobs[0][1])
            else:
                # 実機チップステム（ノイズ・DAC、どちらか片方または両方）と合成する
                # 場合だけヘッドルームを取る（mix.DRY_GAIN）。ゲームSF2側とGM側の
                # 2分割だけの場合は「1つの編曲を互いに素なトラック集合へ分割した
                # もの」を単純加算で復元するだけなのでヘッドルームは取らない
                # （mix.SPLIT_GAIN = 1.0）。
                fluid_gain = mix.DRY_GAIN if has_stem else mix.SPLIT_GAIN
                inputs: list[tuple[Path, float]] = []
                for index, (job_mid, job_soundfont) in enumerate(jobs):
                    part_path = web_session.root / f"render-{render_id:04d}.part{index}.wav"
                    temp_paths.append(part_path)
                    render_wav(job_mid, part_path, job_soundfont)
                    inputs.append((part_path, fluid_gain))
                if stem is not None:
                    inputs.append((stem, mix.STEM_GAIN))
                if dac_stem is not None:
                    inputs.append((dac_stem, mix.STEM_GAIN))
                inputs.extend(chip_render_stems)
                if len(inputs) == 1:
                    shutil.copyfile(inputs[0][0], wav_path)
                else:
                    mix_wav(inputs, wav_path)
        finally:
            for temp_path in temp_paths:
                temp_path.unlink(missing_ok=True)
            if stem_sync_dir is not None:
                shutil.rmtree(stem_sync_dir, ignore_errors=True)

    def ensure_render() -> Path:
        """試聴用WAVのパスを返す。未レンダリングならその場でレンダリングする。

        実処理は_render_applied_midi()に委ね、ここではロック取得・世代管理
        （render_id採番・古いWAVの破棄）だけを担う。
        """
        with web_session.render_lock:
            applied_path = ensure_applied()
            if web_session.audio_path is not None and web_session.audio_path.exists():
                return web_session.audio_path

            web_session.render_id += 1
            render_id = web_session.render_id
            wav_path = web_session.root / f"render-{render_id:04d}.wav"
            previous_audio = web_session.audio_path

            _render_applied_midi(
                applied_path,
                wav_path,
                render_id=render_id,
                speed=web_session.speed_ratio,
                transpose=web_session.transpose_semitones,
            )

            if previous_audio is not None and previous_audio != wav_path:
                previous_audio.unlink(missing_ok=True)
            web_session.audio_path = wav_path
        return wav_path

    @app.post("/api/render")
    def render_endpoint() -> Response:
        web_session.require_tracks()
        if web_session.root is None or web_session.original_path is None:
            raise WebValidationError("先にMIDIファイルをアップロードしてください")

        # レンダリングは常に現在のassignmentsを反映すべきなので、既にapply済みでも
        # 明示的に再適用してsummary（updated/inserted件数）を取り直す。
        web_session.invalidate_render()
        wav_path = ensure_render()

        return jsonify(
            audioUrl=f"/api/audio?v={web_session.render_id}",
            renderId=web_session.render_id,
            filename=wav_path.name,
            **(web_session.apply_summary or {}),
        )

    @app.get("/api/audio")
    def get_audio() -> Response:
        if web_session.audio_path is None or not web_session.audio_path.exists():
            raise WebValidationError("先に「適用して試聴」を実行してください")
        return send_file(
            web_session.audio_path, mimetype="audio/wav", conditional=True, max_age=0
        )

    @app.get("/api/download")
    def get_download() -> Response:
        if web_session.original_path is None or web_session.root is None:
            raise WebValidationError("MIDIファイルがアップロードされていません")
        applied_path = ensure_applied()
        download_name = f"{web_session.original_name}_miditrack.mid"
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
        wav_path = ensure_render()
        download_name = f"{web_session.original_name}_miditrack.wav"
        return send_file(
            wav_path,
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
                for speed, transpose in itertools.product(speeds, transposes):
                    label = _variation_label(speed, transpose)
                    mid_out = work_dir / f"{web_session.original_name}_{label}.mid"
                    wav_out = work_dir / f"{web_session.original_name}_{label}.wav"
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
        download_name = f"{web_session.original_name}_variations.zip"
        return send_file(
            web_session.variations_zip_path,
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
                        if convert.is_m3u_filename(member.name):
                            m3u_texts.append(member.read_text(encoding="utf-8", errors="replace"))
                        elif convert.try_detect_format(member.name) is not None:
                            candidates.append(member)
                        # それ以外（readme・カバー画像等）はZIP同梱の付随ファイルとして無視する。
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
        web_session.game_soundfont_path = convert.produced_game_soundfont(output_path, options)
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
