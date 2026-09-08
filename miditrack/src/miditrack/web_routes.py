"""miditrackのローカルWebアプリのFlaskルート構成。

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
import os
import re
import secrets
import shutil
import stat
import sys
import tempfile
import threading
import time
import webbrowser
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

try:
    from flask import Flask, Response, jsonify, request, send_file
    from werkzeug.exceptions import RequestEntityTooLarge
    from werkzeug.serving import make_server
except ImportError as import_error:  # pragma: no cover - exercised via cli.py's own guard
    raise ImportError("miditrack requires Flask") from import_error

from . import convert, i18n, libvgm, midi, mix, nsf_chip, pianoroll, preferences, project, render
from .i18n import t
from .convert import SourceFormat
from .errors import (
    ConvertError,
    MidiTrackError,
    MixError,
    RenderError,
    RubberBandError,
    WebValidationError,
)
from .gm import DEFAULT_GM_PROGRAM, instrument_catalog
from .midi import TrackInfo
from .runtime_dependencies import RuntimeDependencies
from .render_service import (
    CachedRenderRequest,
    PreviewRenderRequest,
    RenderService,
)
from .web_project_service import ProjectService
from .web_session_service import SessionService
from .web_source_service import SourceService
from .web_session import (
    WebSession,
    effective_download_stem as _effective_download_stem,
    sanitize_stem,
    selected_track_source as _selected_track_source,
    session_payload,
    set_track_source as _set_track_source,
    soundfont_payload,
    track_filename_label as _track_filename_label,
    unique_upload_path as _unique_upload_path,
    validate_track_sources as _validate_track_sources,
)

def resolve_asset_directory() -> Path:
    """アプリバンドルまたは開発パッケージのWebアセットを解決する。"""
    resource_root = os.environ.get("MIDITRACK_RESOURCE_ROOT")
    if resource_root:
        bundled_assets = Path(resource_root) / "miditrack/src/miditrack/web_assets"
        if bundled_assets.is_dir():
            return bundled_assets
    return Path(__file__).with_name("web_assets")


ASSET_DIR = resolve_asset_directory()
# .vgz等の音源ファイルは.midより桁違いに大きくなりうるため32MBから引き上げてある。
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
# VGMには数十の実機チャンネルを持つ曲がある。全チャンネルの生WAVを温めると
# render_cache（16件／256MB）から先に完成したWAVを追い出してしまうため、既定集合に
# 加えて先頭の少数だけを温める。未温めチャンネルは正確な全尺レンダーへフォールバック
# し、その結果は通常キャッシュに残る。
CHIP_PREWARM_MAX_CHANNELS = 4
# 再生中は毎フレーム異なるtimelineSecondsが送られてくるため、量子化しないと
# window_key（延いてはpreview_cacheのキー）が実質毎回変わってしまい、3〜8件しか
# 持たないキャッシュが原理的に一度もヒットしない（Phase 5, Step 3）。窓開始を
# 1秒グリッドへ切り捨てることで、同じ1秒区間内の再生中の連続編集がヒットできる
# ようにする。
PREVIEW_WINDOW_QUANTIZE_SECONDS = 1.0
PREVIEW_CACHE_MAX_ENTRIES = 8
# 22.05kHzの12秒WAVは1件あたり約1MBなので、件数上限だけで十分小さいが、
# 全尺LRU（render_cache）と同様バイト上限も明示しておく。
PREVIEW_CACHE_MAX_BYTES = 32 * 1024 * 1024
PREVIEW_PREROLL_SECONDS = 2.0
PREVIEW_FORWARD_SECONDS = 12.0
# /api/audio?v=Nがrender_idごとに解決できるWAVの保持件数。クロスフェード中は旧render_idの
# 要素が引き続きこの音源へRangeリクエストを送り続けるため、invalidate_render()後も
# ここに載っている間は消さない（LRU（render_cache）からの追い出し対象からも保護する）。
# 元は「同時に鳴りうる音源はたかだかA/B 2枚+ソロ切替の余裕」で4だったが、再生中の編集を
# 短区間プレビュー経由にした後は1回の編集でプレビュー・全尺の2 render_idを消費する
# （Phase 5, Step 2）ため、連続編集でクロスフェード中の旧音源が押し出されないよう6へ
# 引き上げてある。
AUDIO_SOURCE_HISTORY_LIMIT = 6

RendererFunc = Callable[[Path, Path, "Path | None"], None]
ListSongsFunc = Callable[[SourceFormat, Path], "tuple[dict[str, Any], list[dict[str, Any]]]"]
ConvertFunc = Callable[[SourceFormat, Path, Path, "dict[str, Any]"], "tuple[Path | None, Path | None]"]
StemTransformerFunc = Callable[[Path, Path, float, int], None]
MixerFunc = Callable[["list[tuple[Path, float]]", Path], None]
GainApplierFunc = Callable[[Path, Path, float], None]
LibvgmRendererFunc = Callable[
    [Path, Path, int, "list[libvgm.LibvgmTarget]"], None
]
NsfChipRendererFunc = Callable[
    [Path, Path, int, "list[nsf_chip.NsfChipTarget]", int], None
]
# multipartのFileStorage.save()と、Finderからステージング済みのファイルを
# copyfile()する経路で共有する保存操作。
UploadSaver = Callable[[Path], None]


@dataclass(frozen=True)
class RenderOutcome:
    """1回の試聴／最終レンダー要求の結果と計測値。

    render_idはこの結果が実際に登録されたaudio_sourcesのキー（この呼び出しの
    中で確定した値）を保持する。エンドポイント側は応答のaudioUrl/renderIdを
    ここから読む — 呼び出し完了後にweb_session.render_idを読み直すと、
    ensure_preview()がrender_lockを長時間保持しなくなった（Phase 5, Step 1）
    ことで、その間に別スレッドの並行呼び出しがrender_idをさらに進めている
    可能性があり、無関係なWAVのidを報告してしまう。activate_player=Falseの
    ensure_render()呼び出し（prewarm）はrenderIdを応答に含めないため、
    このフィールドは0のまま使われない。
    """

    path: Path
    mode: str
    cache_key: str
    cache_hit: bool
    render_id: int
    render_ms: int
    breakdown: "RenderBreakdown"


@dataclass
class RenderBreakdown:
    """レンダーのクリティカルパスを構成する処理時間（ミリ秒）。

    FluidSynthと実機チップのジョブは最大2本まで並列実行するため、各カテゴリは
    合計CPU時間ではなく最長ジョブ時間を持つ。これによりrenderMsとの比較で実際の
    待ち時間を判断できる。
    """

    apply_ms: int = 0
    split_ms: int = 0
    fluid_synth_ms: int = 0
    chip_ms: int = 0
    mix_ms: int = 0

    def to_response(self) -> dict[str, int]:
        """API応答用のcamelCase計測値を返す。"""
        return {
            "applyMs": self.apply_ms,
            "splitMs": self.split_ms,
            "fluidSynthMs": self.fluid_synth_ms,
            "chipMs": self.chip_ms,
            "mixMs": self.mix_ms,
        }


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




def _render_workers() -> int:
    """レンダリングジョブの同時実行数を設定ファイルから解決する。

    表示設定ダイアログの「レンダリング」セクション（renderWorkers、既定
    "auto"）を都度読み込む — load_preferences()自体が軽量なJSON読み込み
    で、他のリクエストパス（/api/preferences等）でも毎回呼ばれている
    ものと同じ扱い。ThreadPoolExecutorを使う箇所は毎回この関数を呼ぶ。
    """
    prefs = preferences.load_preferences()
    return preferences.resolve_render_workers(prefs["renderWorkers"])




def _variation_label(speed: float, transpose: int) -> str:
    """バリエーション1件分のファイル名ラベルを作る（例: "p-2_x1.2", "p+0_x1.0"）。

    速度は常に小数第1位まで表示し、ピッチは正値と0にも符号を付けることで、
    ファイルシステム安全かつ人間が比較しやすい名前にする。
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
    stem_transformer: StemTransformerFunc | None = None,
    mixer: MixerFunc | None = None,
    gain_applier: GainApplierFunc | None = None,
    libvgm_renderer: LibvgmRendererFunc | None = None,
    nsf_chip_renderer: NsfChipRendererFunc | None = None,
    require_token: bool = True,
    local_open_dir: Path | None = None,
) -> Flask:
    """テスト可能なmiditrackローカルWebアプリを生成する。

    require_token=Falseは`--no-token`起動用で、/api/以下の起動トークン検証
    そのものを無効化する（127.0.0.1限定バインドとOrigin検証のみに頼る）。
    固定ポート起動時にブックマークからトークン無しで開けるようにするための、
    ユーザーが明示的に選ぶセキュリティ低下トレードオフ。
    local_open_dirはmiditrack.appだけが作成する一時ステージング領域である。
    指定時のみFinder/Dock用の`/api/open-local`を有効にし、ほかのローカル
    ファイルをWeb APIから読めないようにする。
    """
    launch_token = token or secrets.token_urlsafe(32)
    web_session = session or WebSession()
    dependencies = RuntimeDependencies(
        renderer=renderer,
        list_songs=list_songs,
        converter=converter,
        stem_transformer=stem_transformer,
        mixer=mixer,
        gain_applier=gain_applier,
        libvgm_renderer=libvgm_renderer,
        nsf_chip_renderer=nsf_chip_renderer,
    )
    list_source_songs = dependencies.get_list_songs()
    convert_to_midi = dependencies.get_converter()
    transform_stem = dependencies.get_stem_transformer()
    render_libvgm = dependencies.get_libvgm_renderer()
    render_nsf_chip = dependencies.get_nsf_chip_renderer()
    local_open_root = local_open_dir.resolve() if local_open_dir is not None else None
    render_wav = dependencies.render_wav
    mix_wav = dependencies.mix_wav
    apply_gain_wav = dependencies.apply_gain
    render_service = RenderService(
        web_session,
        render_cache_max_entries=RENDER_CACHE_MAX_ENTRIES,
        render_cache_max_bytes=RENDER_CACHE_MAX_BYTES,
        preview_cache_max_entries=PREVIEW_CACHE_MAX_ENTRIES,
        preview_cache_max_bytes=PREVIEW_CACHE_MAX_BYTES,
        audio_source_history_limit=AUDIO_SOURCE_HISTORY_LIMIT,
    )
    project_service = ProjectService(
        web_session, lambda raw_mode: _validate_render_mode(raw_mode)
    )
    source_service = SourceService(web_session, list_source_songs, convert_to_midi)
    session_service = SessionService(web_session, soundfont)
    _cache_lookup = render_service.cache_lookup
    _cache_store = render_service.cache_store
    _next_render_id = render_service.next_render_id
    _register_audio_source = render_service.register_audio_source
    _cache_output_path = render_service.cache_output_path

    app = Flask("miditrack.web", static_folder=str(ASSET_DIR), static_url_path="/assets")
    app.config.update(
        MAX_CONTENT_LENGTH=MAX_UPLOAD_BYTES,
        MIDITRACK_TOKEN=launch_token,
        MIDITRACK_SESSION=web_session,
        MIDITRACK_REQUIRE_TOKEN=require_token,
        MIDITRACK_ENABLE_BACKGROUND_PREWARM=True,
    )

    @app.before_request
    def validate_local_request() -> Response | None:
        # preferences.jsonのappLanguage（"system"ならAccept-Languageヘッダー、
        # 明示指定ならそれを最優先）から、このリクエストで使う言語を最初に
        # 確定する。以降のraise/jsonify(error=...)は全てこのContextVar経由で
        # t()が参照するので、後続処理より前に必ず設定しておく必要がある。
        stored_language = preferences.load_preferences().get("appLanguage")
        i18n.set_language(i18n.resolve_language(stored_language, request.headers.get("Accept-Language")))
        host = request.host.split(":", 1)[0].strip("[]")
        if host not in {"127.0.0.1", "localhost", "::1"}:
            return jsonify(error=t("ローカルホスト以外からは接続できません")), 403
        if request.origin:
            origin_host = urlparse(request.origin).hostname
            if origin_host not in {"127.0.0.1", "localhost", "::1"}:
                return jsonify(error=t("外部Originからの操作は拒否されました")), 403
        if request.path.startswith("/api/") and require_token:
            # <audio>要素はカスタムヘッダーを送れないため、GETの /api/audio に
            # 限りクエリ文字列トークンも許可する（Rangeシーク対応をfetch+blob
            # 変換なしで維持するため）。/api/download は通常のfetchで届くので
            # 対象に含めない。
            supplied = request.headers.get("X-Miditrack-Token", "")
            if not supplied and request.method == "GET" and request.path == "/api/audio":
                supplied = request.args.get("token", "")
            if not secrets.compare_digest(supplied, launch_token):
                return jsonify(error=t("起動トークンが一致しません")), 403
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
    @app.errorhandler(RubberBandError)
    @app.errorhandler(MixError)
    def handle_render_error(error: Exception) -> tuple[Response, int]:
        return jsonify(error=str(error)), 502

    @app.errorhandler(RequestEntityTooLarge)
    def handle_large_upload(_error: RequestEntityTooLarge) -> tuple[Response, int]:
        return jsonify(error=t("ファイルのサイズが大きすぎます")), 413


    @app.get("/")
    def index() -> Response:
        # フロントエンド（app.js）が起動トークン必須かどうかを最初の描画時点
        # で知るための静的置換。--no-token起動時はブックマークからトークン
        # 無しで開けるようにするため、この1箇所だけindex.htmlを動的に返す。
        html = (ASSET_DIR / "index.html").read_text(encoding="utf-8")
        html = html.replace(
            "__MIDITRACK_TOKEN_REQUIRED__", "true" if require_token else "false"
        )
        # 言語もここでサーバー側確定させる。app.jsは<script defer>で初回ペイント
        # より後にしか実行できず（CSPがインラインscriptを禁止しており、
        # ダークモードの白フラッシュと同型の問題になる — i18n.localize_html()
        # のdocstring参照）、静的テキストはHTML文字列の時点で言語を確定させる
        # 必要がある。before_requestで既に確定済みの言語をそのまま使う。
        html = html.replace("__MIDITRACK_LANG__", i18n.get_language())
        html = i18n.localize_html(html, i18n.get_language())
        return Response(html, mimetype="text/html")

    @app.get("/favicon.ico")
    def favicon() -> Response:
        return send_file(ASSET_DIR / "favicon.ico")

    @app.get("/api/instruments")
    def get_instruments() -> Response:
        return jsonify(families=instrument_catalog())

    @app.get("/api/preferences")
    def get_preferences() -> Response:
        return jsonify(**preferences.localize_preferences_payload(preferences.load_preferences()))

    @app.patch("/api/preferences")
    def update_preferences() -> Response:
        """楽器選択の設定と編成プリセットを部分更新する。

        ブラウザセッションではなくプロセス全体で共有する設定なので、
        WebSessionではなくユーザーホーム配下のファイルへ直接読み書きする
        （preferences.py参照。起動のたびにポートが変わりlocalStorageの
        オリジンが変わってしまう問題を回避するため）。
        """
        body = request.get_json(silent=True) or {}
        if not any(field in body for field in preferences.PATCHABLE_PREFERENCE_FIELDS):
            raise WebValidationError(t("更新する設定を指定してください"))
        return jsonify(**preferences.localize_preferences_payload(preferences.save_preferences(body)))

    @app.get("/api/soundfonts")
    def get_soundfonts() -> Response:
        return jsonify(**soundfont_payload(web_session, soundfont))

    @app.post("/api/soundfont")
    def set_soundfont() -> Response:
        body = request.get_json(silent=True) or {}
        return jsonify(**session_service.set_soundfont(body.get("path")))

    @app.post("/api/project/export")
    def export_project() -> Response:
        """現在の編集可能なセッションを`.miditrack`としてダウンロードする。"""
        web_session.require_tracks()
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            raise WebValidationError(t("プロジェクトの画面設定はオブジェクトで指定してください"))
        ui_state = project_service.validate_ui(body, web_session.require_tracks())
        archive_path = project_service.export(ui_state)
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
            raise WebValidationError(t(".miditrackファイルを選択してください"))
        if not upload.filename.lower().endswith(PROJECT_EXTENSION):
            raise WebValidationError(t("拡張子が .miditrack のファイルを選択してください"))
        payload, ui_state, warnings = project_service.import_upload(upload.save)
        return jsonify(session=payload, uiState=ui_state, warnings=warnings)

    @app.get("/api/session")
    def get_session() -> Response:
        return jsonify(**session_payload(web_session))

    @app.post("/api/session")
    def create_session() -> tuple[Response, int]:
        upload = request.files.get("midi")
        if upload is None or not upload.filename:
            raise WebValidationError(t("MIDIファイルを選択してください"))
        return jsonify(**source_service.ingest_midi(upload.filename, upload.save)), 201

    @app.delete("/api/session")
    def delete_session() -> Response:
        return jsonify(**session_service.clear())

    @app.patch("/api/session/tracks")
    def update_tracks() -> Response:
        body = request.get_json(silent=True) or {}
        return jsonify(**session_service.update_tracks(body))

    @app.patch("/api/session/transform")
    def update_transform() -> Response:
        body = request.get_json(silent=True) or {}
        return jsonify(**session_service.update_transform(body))

    @app.patch("/api/session/filename")
    def update_download_filename() -> Response:
        body = request.get_json(silent=True) or {}
        return jsonify(**session_service.update_filename(body))

    @app.get("/api/pianoroll")
    def get_pianoroll() -> Response:
        """現在のMIDIから、レンダリング非依存のピアノロール情報を返す。"""
        web_session.require_tracks()
        if web_session.original_path is None:
            raise WebValidationError(t("先にMIDIファイルをアップロードしてください"))
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
            raise WebValidationError(t("renderModeはfastまたはqualityで指定してください"))
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

    def _apply_source_to(
        source_path: Path, output_path: Path, speed: float, transpose: int
    ) -> dict[str, int | float]:
        """指定MIDIへassignments・volumesを適用してsummaryを返す。

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
            source_path,
            active_assignments,
            output_path,
            effective_volumes,
            source_volumes,
            speed=speed,
            transpose=transpose,
        )

    def _apply_to(
        output_path: Path, speed: float, transpose: int
    ) -> dict[str, int | float]:
        """原本MIDIへ現在の編集を適用してoutput_pathへ書く。"""
        assert web_session.original_path is not None
        return _apply_source_to(web_session.original_path, output_path, speed, transpose)

    def ensure_applied(breakdown: RenderBreakdown | None = None) -> Path:
        """assignments適用済みのMIDIパスを返す。未適用ならその場で適用する。

        invalidate_render()がapplied_path/apply_summaryを対で無効化するため、
        「未適用」は常に「割り当て変更後まだ一度もapplyしていない」と一致する。
        """
        applied_path, _summary, elapsed_ms = render_service.ensure_applied(
            _apply_to,
            lambda: WebValidationError(t("MIDIファイルがアップロードされていません")),
            lambda: WebValidationError(
                t("設定が連続して変更されたため、MIDIの適用をやり直してください")
            ),
        )
        if breakdown is not None:
            breakdown.apply_ms += elapsed_ms
        return applied_path

    def _source_midi_readonly() -> Any:
        """original_pathのread-only解析済みMIDIを、可能ならキャッシュから返す。

        write_time_window()の`source_midi`引数専用（read-only契約）。
        source_midi_cache_revisionが現在のmidi_revisionと一致する間だけ
        キャッシュを使う — original_pathはload_midi()内でmidi_revisionの
        インクリメントと必ずセットで差し替わるため、一致していれば
        source_midi_cacheは確実に今のoriginal_pathの内容と対応している。
        """
        assert web_session.original_path is not None
        if web_session.source_midi_cache_revision == web_session.midi_revision:
            return web_session.source_midi_cache
        parsed = midi.parse_midi_readonly(web_session.original_path)
        web_session.source_midi_cache = parsed
        web_session.source_midi_cache_revision = web_session.midi_revision
        return parsed

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
        """実機ステムを指定の速度・移調へrubberbandで揃える。

        MIDI側のテンポ・ノート番号は既にapply_assignments()で変換済みだが、
        chip_stem_path/dac_stem_pathは実音声なのでMIDI側だけ変換すると
        再生時間・ピッチがずれる。出力先を明示して1ステムずつ変換するため、
        スクリプト側のファイル名規則や出力ファイル探索には依存しない。
        speed/transposeを引数で受ける理由は_apply_to()と同じ
        （バリエーション一括生成がセッションの値を書き換えずに済むようにするため）。
        """
        output_path = work_dir / f"{label}.synced.wav"
        transform_stem(stem_path, output_path, speed, transpose)
        return output_path

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
            with ThreadPoolExecutor(max_workers=_render_workers()) as executor:
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

    def prewarm_chip_hardware(midi_revision: int) -> None:
        """変換直後の実機音源キャッシュをバックグラウンドで温める。

        まず既定選択の全チャンネルWAVを温める。これが全尺レンダーのクリティカル
        パスなので、個別チャンネルの温め完了を待たず即座にLRUへ登録する。その後に
        個別チャンネルWAVを完成順に登録し、短区間プレビューで使えるようにする。

        長いエミュレーションはrender_lockの外で実行する。通常レンダーと同時に
        なった場合は、先に登録されたものを優先して温め側の一時WAVを捨てるため、
        同じキャッシュキーを壊さない。
        """
        def prepare_plan(*, per_track: bool) -> list[ChipCacheMiss] | None:
            with web_session.render_lock:
                if midi_revision != web_session.midi_revision or web_session.root is None:
                    return None
                plan = _plan_chip_hardware(per_track=per_track)
                return [
                    ChipCacheMiss(
                        miss.cache_key,
                        miss.indices,
                        _cache_output_path("chip-warm", miss.cache_key),
                    )
                    for miss in plan.misses
                ]

        def render_and_store(misses: list[ChipCacheMiss]) -> bool:
            """温めたWAVを完了順に登録し、状態更新時は安全に破棄する。"""
            if not misses:
                return True
            stored_paths: set[Path] = set()
            try:
                with ThreadPoolExecutor(max_workers=_render_workers()) as executor:
                    futures = {
                        executor.submit(_render_chip_targets, miss.indices, miss.path): miss
                        for miss in misses
                    }
                    for future in as_completed(futures):
                        miss = futures[future]
                        future.result()
                        with web_session.render_lock:
                            if midi_revision != web_session.midi_revision:
                                miss.path.unlink(missing_ok=True)
                                continue
                            if _cache_lookup(miss.cache_key) is None:
                                _cache_store(miss.cache_key, miss.path)
                                stored_paths.add(miss.path)
                            else:
                                miss.path.unlink(missing_ok=True)
                return midi_revision == web_session.midi_revision
            except Exception:
                for miss in misses:
                    if miss.path not in stored_paths:
                        miss.path.unlink(missing_ok=True)
                return False

        default_misses = prepare_plan(per_track=False)
        if default_misses is None or not render_and_store(default_misses):
            return

        individual_misses = prepare_plan(per_track=True)
        if individual_misses is not None:
            render_and_store(individual_misses[:CHIP_PREWARM_MAX_CHANNELS])

    def start_chip_prewarm() -> None:
        """現状態の実機音源キャッシュ温めを開始する。"""
        if (
            not app.config["MIDITRACK_ENABLE_BACKGROUND_PREWARM"]
            or web_session.source_format not in CHIP_HARDWARE_SOURCE_FORMATS
        ):
            return
        # 生チップWAVのキーは元MIDI／変換元だけで決まり、音量・音色・音源選択は
        # 含まれない。これらの編集でstate_revisionが変わっても温めを中止せず、
        # ソロ直後の短区間プレビューで再利用できるようにする。
        midi_revision = web_session.midi_revision
        threading.Thread(
            target=prewarm_chip_hardware,
            args=(midi_revision,),
            name="miditrack-chip-prewarm",
            daemon=True,
        ).start()

    def _render_applied_midi(
        applied_path: Path,
        wav_path: Path,
        *,
        render_id: int,
        speed: float,
        transpose: int,
        sample_rate: int = 44100,
        chip_render_stems: list[tuple[Path, float]] | None = None,
        include_session_stems: bool = True,
        breakdown: RenderBreakdown | None = None,
    ) -> None:
        """適用済みMIDI(applied_path)をwav_pathへレンダリングする。

        render_idはこの関数が使う一時ファイル名（render-NNNN.partN.wav等）の
        基点であり、呼び出し元がweb_session.render_lockの下で採番済みである
        ことが前提（同時実行との衝突を避けるため）。ただしロック自体を関数の
        実行中ずっと保持している必要はない: `chip_render_stems`を明示的に渡した
        呼び出し（ensure_preview()）はこの関数内部で_plan_chip_hardware()/
        _store_chip_hardware()を一切呼ばない＝共有render_cacheに触れないため、
        render_lockを取らずに呼んでよい。`chip_render_stems=None`（ensure_render()
        からの呼び出し）はこの関数自身が_plan_chip_hardware()経由でLRUを
        参照・更新するため、呼び出し元がrender_lockを保持したまま呼ぶ既存の
        契約が引き続き必要。

        _plan_render_jobs() が決めたジョブが1つだけ、かつ実機ノイズ/DPCM/DAC
        ステム（chip_stem_path・dac_stem_path・chip_render_stems）も無く、
        speed/transposeも既定値なら、従来どおりfluidsynthの出力を直接
        wav_pathへ書く。ジョブが2つ（ゲーム由来SoundFont側と手動指定した
        GM SoundFont側への分割）になった場合やステムがある場合は、各ジョブを
        一時的なrender-NNNN.partN.wavへレンダリングしてからmix_wav()で合成する。
        speed/transposeが既定値でなければ、ミックス前にステムだけを
        rubberbandで同じ量だけ変換して同期を保つ（既定値のままなら通常
        ケースにrubberbandの依存を増やさないため一切呼ばない）。

        chip_render_stemsを渡さなければ、この関数自身が実機音声キャッシュを計画し、
        キャッシュミスをFluidSynthと同じ最大2並列の実行枠へ投入する。渡された場合は
        呼び出し元が所有するものとして再生成しない — バリエーション一括生成
        （POST /api/variations）が、speed/transposeに依存しないこの結果を
        全組み合わせで1回だけ生成して使い回すため。
        """
        split_started_at = time.perf_counter()
        chip_plan = ChipHardwarePlan(inputs=[], misses=[])
        if chip_render_stems is None:
            chip_plan = _plan_chip_hardware()
            chip_render_stems = chip_plan.inputs

        effective_soundfont = web_session.soundfont_override or soundfont
        jobs = _plan_render_jobs(applied_path, effective_soundfont, render_id)
        if breakdown is not None:
            breakdown.split_ms += round((time.perf_counter() - split_started_at) * 1000)

        stem = web_session.chip_stem_path if include_session_stems else None
        if stem is not None and not stem.exists():
            stem = None
        dac_stem = web_session.dac_stem_path if include_session_stems else None
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
                fluid_started_at = time.perf_counter()
                render_wav(jobs[0][0], wav_path, jobs[0][1], sample_rate)
                if breakdown is not None:
                    breakdown.fluid_synth_ms = max(
                        breakdown.fluid_synth_ms,
                        round((time.perf_counter() - fluid_started_at) * 1000),
                    )
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
                def render_chip_job(miss: ChipCacheMiss) -> int:
                    started_at = time.perf_counter()
                    _render_chip_targets(miss.indices, miss.path)
                    return round((time.perf_counter() - started_at) * 1000)

                def render_fluid_job(
                    job_mid: Path, job_soundfont: Path | None, part_path: Path
                ) -> int:
                    started_at = time.perf_counter()
                    render_wav(job_mid, part_path, job_soundfont, sample_rate)
                    return round((time.perf_counter() - started_at) * 1000)

                with ThreadPoolExecutor(max_workers=_render_workers()) as executor:
                    chip_futures = [
                        executor.submit(render_chip_job, miss)
                        for miss in chip_plan.misses
                    ]
                    render_futures = [
                        executor.submit(
                            render_fluid_job,
                            job_mid,
                            job_soundfont,
                            part_path,
                        )
                        for job_mid, job_soundfont, part_path in render_parts
                    ]
                    chip_durations = [future.result() for future in chip_futures]
                    fluid_durations = [future.result() for future in render_futures]
                if breakdown is not None:
                    breakdown.chip_ms = max(breakdown.chip_ms, max(chip_durations, default=0))
                    breakdown.fluid_synth_ms = max(
                        breakdown.fluid_synth_ms, max(fluid_durations, default=0)
                    )
                _store_chip_hardware(chip_plan)
                if stem is not None:
                    inputs.append((stem, mix.STEM_GAIN))
                if dac_stem is not None:
                    inputs.append((dac_stem, mix.STEM_GAIN))
                inputs.extend(chip_render_stems)
                if len(inputs) == 1:
                    shutil.copyfile(inputs[0][0], wav_path)
                else:
                    mix_started_at = time.perf_counter()
                    mix_wav(inputs, wav_path, sample_rate)
                    if breakdown is not None:
                        breakdown.mix_ms += round((time.perf_counter() - mix_started_at) * 1000)
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
            breakdown = RenderBreakdown()

            def build_request() -> CachedRenderRequest:
                nonlocal breakdown
                breakdown = RenderBreakdown()
                applied_path = ensure_applied(breakdown)
                state_key = _render_state_key(mode)
                cache_key = f"render:{state_key}"

                def render_to(wav_path: Path, work_id: int) -> None:
                    _render_applied_midi(
                        applied_path,
                        wav_path,
                        render_id=work_id,
                        speed=web_session.speed_ratio,
                        transpose=web_session.transpose_semitones,
                        sample_rate=RENDER_SAMPLE_RATES[mode],
                        breakdown=breakdown,
                    )

                return CachedRenderRequest(cache_key, mode, state_key, render_to)

            cached_render = render_service.ensure_cached_render(
                build_request,
                lambda: WebValidationError(
                    t("設定が連続して変更されたため、レンダリングをやり直してください")
                ),
            )
            wav_path = cached_render.path
            cache_key = cached_render.cache_key
            cache_hit = cached_render.cache_hit
            work_id = cached_render.work_id

            active_render_id = (
                render_service.activate_full_render(
                    cache_key, wav_path, mode, work_id, cache_hit
                )
                if activate_player
                else 0
            )

            render_ms = round((time.perf_counter() - started_at) * 1000)
            return RenderOutcome(
                path=wav_path,
                mode=mode,
                cache_key=cache_key,
                cache_hit=cache_hit,
                render_id=active_render_id,
                render_ms=render_ms,
                breakdown=breakdown,
            )

    def _preview_chip_stems(
        window: midi.MidiWindow, work_id: int
    ) -> tuple[list[tuple[Path, float]], list[Path]]:
        """短区間プレビュー用に原曲ステムを切り出し、ミックス入力を返す。

        既定音量の選択集合は変換直後に温めた集合WAVをそのまま切り出す。音量を
        変更した少数チャンネルは個別WAVを差分として重ね、ソロ／ミュートでは無音の
        チャンネルを要求しない。必要な生WAVがまだ無ければ、重い全曲エミュレー
        ションを同期で始めず全尺レンダーへフォールバックさせる。
        """
        assert web_session.root is not None
        source_start = window.start_seconds * web_session.speed_ratio
        source_duration = (window.end_seconds - window.start_seconds) * web_session.speed_ratio
        if source_duration <= 0:
            return [], []

        inputs: list[tuple[Path, float]] = []
        temporary_paths: list[Path] = []

        def add_trimmed_stem(source_path: Path, label: str, gain: float) -> None:
            output_path = web_session.root / f"preview-{work_id:04d}.{label}.wav"
            mix.trim_wav(
                source_path,
                output_path,
                source_start,
                source_duration,
                sample_rate=RENDER_SAMPLE_RATES[FAST_RENDER_MODE],
            )
            temporary_paths.append(output_path)
            inputs.append((output_path, gain))

        if web_session.chip_stem_path is not None and web_session.chip_stem_path.exists():
            add_trimmed_stem(web_session.chip_stem_path, "noise", mix.STEM_GAIN)
        if web_session.dac_stem_path is not None and web_session.dac_stem_path.exists():
            add_trimmed_stem(web_session.dac_stem_path, "dac", mix.STEM_GAIN)

        if (
            web_session.source_format in CHIP_HARDWARE_SOURCE_FORMATS
            and web_session.chip_metadata is not None
        ):
            # chip_metadataが無い場合（--track-metadataサイドカーを書かない
            # 旧nsf2midiバイナリ経由の、chip_stem_pathだけを使う後方互換経路。
            # 「Added: NSF per-track hardware選択」参照）はチャンネル単位の
            # track_sources選択自体が発生し得ないため、_chip_cache_key()が
            # 前提とするchip_metadataへ触れずに素通りする。_plan_chip_hardware()
            # の同じガード（`or not web_session.chip_metadata`）と揃えた。
            tracks_by_index = {track.index: track for track in web_session.tracks}
            selected_indices = sorted(
                index for index, source in web_session.track_sources.items() if source == "game"
            )
            baseline_for = lambda index: (
                tracks_by_index[index].source_volume_percent
                or midi.DEFAULT_TRACK_VOLUME_PERCENT
            )
            volume_for = lambda index: web_session.volumes.get(index, baseline_for(index))
            default_group_path = _cache_lookup(_chip_cache_key(selected_indices))
            has_muted_channel = any(volume_for(index) == 0 for index in selected_indices)
            if default_group_path is not None and not has_muted_channel:
                add_trimmed_stem(default_group_path, "chip-default", mix.STEM_GAIN)
                for index in selected_indices:
                    baseline = baseline_for(index)
                    volume = volume_for(index)
                    if volume == baseline:
                        continue
                    raw_path = _cache_lookup(_chip_cache_key([index]))
                    if raw_path is None:
                        for path in temporary_paths:
                            path.unlink(missing_ok=True)
                        raise WebValidationError(t("原曲音源の短区間プレビューを温めています"))
                    # 集合WAVには基準音量のこのチャンネルが既に含まれるため、差分だけ
                    # を加える。ミュートを含む場合は集合WAVを使わず、下の個別経路で
                    # 可聴チャンネルだけを使う。
                    delta_gain = mix.STEM_GAIN * (volume / baseline - 1)
                    add_trimmed_stem(raw_path, f"chip{index}-delta", delta_gain)
                return inputs, temporary_paths

            for index in selected_indices:
                baseline = baseline_for(index)
                volume = volume_for(index)
                if volume == 0:
                    continue
                raw_path = _cache_lookup(_chip_cache_key([index]))
                if raw_path is None:
                    for path in temporary_paths:
                        path.unlink(missing_ok=True)
                    raise WebValidationError(t("原曲音源の短区間プレビューを温めています"))
                add_trimmed_stem(
                    raw_path,
                    f"chip{index}",
                    mix.STEM_GAIN * volume / baseline,
                )
        return inputs, temporary_paths

    def ensure_preview(
        mode: str, timeline_seconds: float
    ) -> tuple[RenderOutcome | None, midi.MidiWindow | None]:
        """再生位置付近の短区間WAVを生成し、audio_sourcesだけへ登録する。

        full renderのaudio_path/current_render_keyは絶対に書き換えない。プレビューを
        選んだ後もダウンロード、全尺キャッシュ判定、後続の全尺クロスフェードが
        従来どおり全尺WAVだけを対象にできるようにするためである。

        重い処理全体はセッション専用のpreview_lockでのみ直列化する。render_id採番・
        LRU参照・audio_sources登録というセッション全体で共有される状態は、
        _next_render_id()/_cache_lookup()等の内部でより細粒度のstate_lockに
        よって保護されており、この関数自身はrender_lockを一切取らない
        （prewarm_chip_hardware()の「重い処理はロック外、登録だけ短くロック」と
        同じ考え方を、専用ロック自体を分けることでさらに徹底したもの）。
        これにより進行中の全尺レンダー（render_lockを丸ごと保持するensure_render()）
        がプレビュー要求を待たせることはない。ensure_preview()は`chip_render_stems`を
        明示的に_render_applied_midi()へ渡すため、その呼び出しは_plan_chip_hardware()を
        経由せず共有render_cacheの高レベルな整合性（どのキーが生成中か等）には
        触れない — render_lockではなくstate_lockだけで安全な理由。
        """
        if web_session.root is None or web_session.original_path is None:
            raise WebValidationError(t("MIDIファイルがアップロードされていません"))
        with web_session.preview_lock:
            started_at = time.perf_counter()
            # 全尺キャッシュ済み判定は要求されたmodeそのもの（fast/quality）で行う
            # — こちらは実在するrender_cacheのキーと一致している必要がある。
            if _cache_lookup(f"render:{_render_state_key(mode)}") is not None:
                return None, None
            # プレビューは常にfast(22050Hz)で焼く（2609行目付近のsample_rate指定
            # 参照）。にもかかわらずキャッシュキーにmodeそのものを使うと、fast/
            # qualityの切替だけでバイト同一のプレビューを焼き直してしまう。
            # プレビュー専用キャッシュのキーはFAST_RENDER_MODE固定のstate_keyで
            # 作る（Phase 5, Step 3）。
            preview_state_key = _render_state_key(FAST_RENDER_MODE)
            # 再生中は毎フレーム異なるtimelineSecondsが送られてくる。量子化しないと
            # 3〜8件しか持たないpreview_cacheが原理的に一度もヒットしない。
            # PREVIEW_PREROLL_SECONDS(2.0) > PREVIEW_WINDOW_QUANTIZE_SECONDS(1.0)
            # なので、量子化後も実際の再生位置は必ず窓の中に収まる。
            quantized_timeline_seconds = (
                math.floor(timeline_seconds / PREVIEW_WINDOW_QUANTIZE_SECONDS)
                * PREVIEW_WINDOW_QUANTIZE_SECONDS
            )
            start_seconds = max(0.0, quantized_timeline_seconds - PREVIEW_PREROLL_SECONDS)
            end_seconds = quantized_timeline_seconds + PREVIEW_FORWARD_SECONDS
            window_key = f"{start_seconds:.3f}:{end_seconds:.3f}"
            cache_key = f"preview:{preview_state_key}:{window_key}"
            breakdown = RenderBreakdown()

            def output_path_for(work_id: int) -> Path:
                assert web_session.root is not None
                return web_session.root / f"preview-{work_id:04d}.wav"

            def render_to(wav_path: Path, work_id: int) -> midi.MidiWindow:
                nonlocal breakdown
                assert web_session.root is not None
                assert web_session.original_path is not None
                breakdown = RenderBreakdown()
                raw_window_path = web_session.root / f"preview-{work_id:04d}.raw.mid"
                applied_window_path = web_session.root / f"preview-{work_id:04d}.mid"
                preview_stem_paths: list[Path] = []
                try:
                    window = midi.write_time_window(
                        web_session.original_path,
                        raw_window_path,
                        start_seconds,
                        end_seconds,
                        speed=web_session.speed_ratio,
                        source_midi=_source_midi_readonly(),
                    )
                    summary = _apply_source_to(
                        raw_window_path,
                        applied_window_path,
                        web_session.speed_ratio,
                        web_session.transpose_semitones,
                    )
                    # 切り出しMIDIの実際の長さを正とする。終端付近では要求した
                    # 12秒先まで存在しないため、固定窓長を返すとクライアントの
                    # シーク・ループの上限が曲末を越えてしまう。
                    window = midi.MidiWindow(
                        window.start_seconds,
                        window.start_seconds + float(summary["durationSeconds"]),
                    )
                    preview_chip_stems, preview_stem_paths = _preview_chip_stems(
                        window, work_id
                    )
                    _render_applied_midi(
                        applied_window_path,
                        wav_path,
                        render_id=work_id,
                        speed=web_session.speed_ratio,
                        transpose=web_session.transpose_semitones,
                        sample_rate=RENDER_SAMPLE_RATES[FAST_RENDER_MODE],
                        chip_render_stems=preview_chip_stems,
                        include_session_stems=False,
                        breakdown=breakdown,
                    )
                    return window
                finally:
                    raw_window_path.unlink(missing_ok=True)
                    applied_window_path.unlink(missing_ok=True)
                    for preview_stem_path in preview_stem_paths:
                        preview_stem_path.unlink(missing_ok=True)

            cached_preview = render_service.ensure_cached_preview(
                PreviewRenderRequest(cache_key, output_path_for, render_to),
                lambda: WebValidationError(
                    t("設定が連続して変更されたため、短区間プレビューをやり直してください")
                ),
            )
            entry = cached_preview.entry
            cache_hit = cached_preview.cache_hit

            preview_render_id = _next_render_id()
            _register_audio_source(preview_render_id, entry.path)
            return (
                RenderOutcome(
                    path=entry.path,
                    mode=mode,
                    cache_key=cache_key,
                    cache_hit=cache_hit,
                    render_id=preview_render_id,
                    render_ms=round((time.perf_counter() - started_at) * 1000),
                    breakdown=breakdown,
                ),
                entry.window,
            )

    @app.post("/api/render")
    def render_endpoint() -> Response:
        web_session.require_tracks()
        if web_session.root is None or web_session.original_path is None:
            raise WebValidationError(t("先にMIDIファイルをアップロードしてください"))

        body = request.get_json(silent=True) or {}
        mode = _validate_render_mode(body.get("renderMode"))
        outcome = ensure_render(mode, activate_player=True)

        return jsonify(
            audioUrl=f"/api/audio?v={outcome.render_id}",
            renderId=outcome.render_id,
            filename=outcome.path.name,
            renderMode=outcome.mode,
            sampleRate=RENDER_SAMPLE_RATES[outcome.mode],
            cacheHit=outcome.cache_hit,
            renderMs=outcome.render_ms,
            renderBreakdown=outcome.breakdown.to_response(),
            **(web_session.apply_summary or {}),
        )

    @app.post("/api/render/prewarm")
    def prewarm_render_endpoint() -> Response:
        """現在状態の試聴WAVを生成するが、プレイヤー音源は切り替えない。"""
        web_session.require_tracks()
        if web_session.root is None or web_session.original_path is None:
            raise WebValidationError(t("先にMIDIファイルをアップロードしてください"))
        body = request.get_json(silent=True) or {}
        mode = _validate_render_mode(body.get("renderMode"))
        outcome = ensure_render(mode, activate_player=False)
        return jsonify(
            status="ready",
            renderMode=outcome.mode,
            sampleRate=RENDER_SAMPLE_RATES[outcome.mode],
            cacheHit=outcome.cache_hit,
            renderMs=outcome.render_ms,
            renderBreakdown=outcome.breakdown.to_response(),
        )

    @app.post("/api/render/preview")
    def render_preview_endpoint() -> Response:
        """現在の曲全体タイムライン位置付近の短区間WAVを返す。"""
        web_session.require_tracks()
        if web_session.root is None or web_session.original_path is None:
            raise WebValidationError(t("先にMIDIファイルをアップロードしてください"))
        body = request.get_json(silent=True) or {}
        requested_revision = body.get("stateRevision")
        if requested_revision is not None and requested_revision != web_session.state_revision:
            return jsonify(error=t("設定が更新されたため短区間プレビューを破棄しました")), 409
        timeline_seconds = body.get("timelineSeconds", 0.0)
        if (
            isinstance(timeline_seconds, bool)
            or not isinstance(timeline_seconds, (int, float))
            or not math.isfinite(timeline_seconds)
            or timeline_seconds < 0
        ):
            raise WebValidationError(t("timelineSecondsは0以上の有限な秒数で指定してください"))
        mode = _validate_render_mode(body.get("renderMode"))
        try:
            outcome, window = ensure_preview(mode, float(timeline_seconds))
        except WebValidationError as error:
            # t()は現在言語で解決するため、raise側（原曲音源の短区間プレビューを
            # 温めています）と同じ呼び出しで比較すれば英語UIでも一致する。
            # 日本語原文をそのまま比較すると英語訳文とは絶対に一致せず、
            # chip-warmup中の200応答が常に例外の再raiseへ化けてしまっていた。
            if t("原曲音源の短区間プレビューを温めています") not in str(error):
                raise
            return jsonify(available=False, reason="chip-warmup"), 200
        if outcome is None or window is None:
            return jsonify(available=False, reason="full-cached"), 200
        return jsonify(
            available=True,
            audioUrl=f"/api/audio?v={outcome.render_id}",
            renderId=outcome.render_id,
            renderKind="segment",
            renderMode=outcome.mode,
            sampleRate=RENDER_SAMPLE_RATES[FAST_RENDER_MODE],
            timelineStartSeconds=window.start_seconds,
            timelineEndSeconds=window.end_seconds,
            cacheHit=outcome.cache_hit,
            renderMs=outcome.render_ms,
            renderBreakdown=outcome.breakdown.to_response(),
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
            # 「適用して試聴」ボタンは自動レンダリングへの置き換えで既に廃止済み
            # （存在しないボタン名を案内していた）。他の未アップロード時ガードと
            # 同じ文言に揃える。
            raise WebValidationError(t("先にMIDIファイルをアップロードしてください"))
        return send_file(audio_path, mimetype="audio/wav", conditional=True, max_age=0)

    @app.get("/api/download")
    def get_download() -> Response:
        if web_session.original_path is None or web_session.root is None:
            raise WebValidationError(t("MIDIファイルがアップロードされていません"))
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
            raise WebValidationError(t("MIDIファイルがアップロードされていません"))
        outcome = ensure_render(QUALITY_RENDER_MODE, activate_player=False)
        download_name = f"{_effective_download_stem(web_session)}_miditrack.wav"
        return send_file(
            outcome.path,
            mimetype="audio/wav",
            as_attachment=True,
            download_name=download_name,
        )

    def generate_variations(
        speeds: list[float], transposes: list[int], include_midi: bool
    ) -> dict[str, Any]:
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
            raise WebValidationError(t("MIDIファイルがアップロードされていません"))

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

                # MIDI書き出し（_apply_to()）はmido操作主体で軽量なため逐次実行する。
                # render_idはrender-NNNN.partN.wav等の一時ファイル名に使われ、
                # 並列レンダリング時の衝突を避けるためここで組み合わせごとに
                # _next_render_id()で事前採番し、タプルへローカルに捕まえておく
                # （後段の並列実行はこのタプルの値を読むだけで、web_session.render_id
                # を直接読み直さない — 並行するensure_preview()呼び出しがさらに
                # 進めていても影響を受けない）。
                combos: list[tuple[float, int, Path, Path, int]] = []
                for speed, transpose in itertools.product(speeds, transposes):
                    label = _variation_label(speed, transpose)
                    mid_out = work_dir / f"{download_stem}_{label}.mid"
                    wav_out = work_dir / f"{download_stem}_{label}.wav"
                    _apply_to(mid_out, speed, transpose)
                    combos.append((speed, transpose, mid_out, wav_out, _next_render_id()))

                # 重いfluidsynth/ffmpeg呼び出し（_render_applied_midi()）だけを
                # 設定された同時処理数（表示設定「レンダリング」＝renderWorkers）
                # で並列実行する。バッチ全体はrender_lockを保持したままなので、
                # 他のリクエストと衝突する余地は無く、内部ジョブの並列度だけが変わる。
                def render_combo(combo: tuple[float, int, Path, Path, int]) -> None:
                    combo_speed, combo_transpose, combo_mid, combo_wav, combo_render_id = combo
                    _render_applied_midi(
                        combo_mid,
                        combo_wav,
                        render_id=combo_render_id,
                        speed=combo_speed,
                        transpose=combo_transpose,
                        chip_render_stems=shared_chip_stems,
                    )

                with ThreadPoolExecutor(max_workers=_render_workers()) as executor:
                    futures = {executor.submit(render_combo, combo): combo for combo in combos}
                    try:
                        for future in as_completed(futures):
                            future.result()
                    except Exception:
                        # 未着手のfutureはキャンセルを試みる（実行中のものは
                        # そのままwith文の終了処理で完了を待つ）。最初に発生した
                        # 例外をそのまま再送出する。
                        for pending in futures:
                            pending.cancel()
                        raise

                # ZIPへの書き込み順は組み合わせの決定順（itertools.productの順）を
                # 維持する — 並列実行の完了順に依存させない。
                for speed, transpose, mid_out, wav_out, _render_id in combos:
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

        return {"items": items, "downloadUrl": "/api/download/variations"}

    @app.post("/api/variations")
    def variations_endpoint() -> Response:
        body = request.get_json(silent=True) or {}
        speeds, transposes = midi.validate_variation_options(
            body.get("speeds"), body.get("transposes")
        )
        include_midi = body.get("includeMidi", True)
        if not isinstance(include_midi, bool):
            raise WebValidationError(t("includeMidiはtrue/falseで指定してください"))
        return jsonify(**generate_variations(speeds, transposes, include_midi))

    @app.get("/api/download/variations")
    def get_download_variations() -> Response:
        if (
            web_session.variations_zip_path is None
            or not web_session.variations_zip_path.exists()
        ):
            raise WebValidationError(t("先に「バリエーションをまとめて生成」を実行してください"))
        download_name = f"{_effective_download_stem(web_session)}_variations.zip"
        return send_file(
            web_session.variations_zip_path,
            mimetype="application/zip",
            as_attachment=True,
            download_name=download_name,
        )

    def generate_track_export(group_chip_tracks: bool) -> dict[str, Any]:
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
            raise WebValidationError(t("MIDIファイルがアップロードされていません"))

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
                    with ThreadPoolExecutor(max_workers=_render_workers()) as executor:
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
                        items.append({"track": t("原曲の音源（まとめ）"), "file": filename, "kind": "orig"})
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
                    items.append({"track": t("ノイズ/DPCM"), "file": filename, "kind": "orig"})
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
                    raise WebValidationError(t("出力できるトラックがありません"))

            zip_path = web_session.root / "track_export.zip"
            if web_session.track_export_zip_path is not None:
                web_session.track_export_zip_path.unlink(missing_ok=True)
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
                for path in export_paths:
                    archive.write(path, arcname=path.name)
            web_session.track_export_zip_path = zip_path
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

        return {"items": items, "downloadUrl": "/api/download/tracks"}

    @app.post("/api/tracks/export")
    def track_export_endpoint() -> Response:
        body = request.get_json(silent=True) or {}
        group_chip_tracks = body.get("groupChipTracks", False)
        if not isinstance(group_chip_tracks, bool):
            raise WebValidationError(t("groupChipTracksはtrue/falseで指定してください"))
        return jsonify(**generate_track_export(group_chip_tracks))

    @app.get("/api/download/tracks")
    def get_download_tracks() -> Response:
        if (
            web_session.track_export_zip_path is None
            or not web_session.track_export_zip_path.exists()
        ):
            raise WebValidationError(t("先に「トラックごとに出力」を実行してください"))
        download_name = f"{_effective_download_stem(web_session)}_tracks.zip"
        return send_file(
            web_session.track_export_zip_path,
            mimetype="application/zip",
            as_attachment=True,
            download_name=download_name,
        )


    @app.post("/api/source")
    def create_source() -> tuple[Response, int]:
        uploads = [f for f in request.files.getlist("source") if f and f.filename]
        entries = [(upload.filename, upload.save) for upload in uploads]
        return jsonify(**source_service.ingest_sources(entries)), 201

    if local_open_root is not None:
        @app.post("/api/open-local")
        def open_local() -> tuple[Response, int] | Response:
            """miditrack.appがステージングしたファイルだけを既存の取込処理へ渡す。"""
            if not require_token:
                return jsonify(error=t("Finderからのファイル読み込みには起動トークンが必要です")), 403
            if not local_open_root.is_dir():
                raise WebValidationError(t("ローカルファイル用の一時領域を確認できません"))
            body = request.get_json(silent=True)
            paths = body.get("paths") if isinstance(body, dict) else None
            if not isinstance(paths, list) or not paths:
                raise WebValidationError(t("読み込むファイルのパスを指定してください"))
            if len(paths) > 64:
                raise WebValidationError(t("一度に読み込めるファイルは64件までです"))

            allowed_extensions = {
                *ALLOWED_MIDI_EXTENSIONS,
                PROJECT_EXTENSION,
                ".zip", ".m3u", ".m3u8",
                *(extension for fmt in convert.SOURCE_FORMATS for extension in fmt.extensions),
            }
            entries: list[tuple[str, UploadSaver]] = []
            for raw_path in paths:
                if not isinstance(raw_path, str) or not raw_path:
                    raise WebValidationError(t("ローカルファイルのパスが不正です"))
                source_path = Path(raw_path)
                try:
                    resolved_path = source_path.resolve(strict=True)
                    resolved_path.relative_to(local_open_root)
                    source_status = source_path.lstat()
                except (OSError, ValueError):
                    raise WebValidationError(t("ローカルファイルはアプリの一時領域内にある必要があります")) from None
                if source_path.is_symlink() or not stat.S_ISREG(source_status.st_mode):
                    raise WebValidationError(t("ローカルファイルは通常ファイルで指定してください"))
                if resolved_path.suffix.lower() not in allowed_extensions:
                    raise WebValidationError(
                        t("対応していない拡張子です: {suffix}", suffix=resolved_path.suffix or t("(なし)"))
                    )
                size_limit = MAX_PROJECT_UPLOAD_BYTES if resolved_path.suffix.lower() == PROJECT_EXTENSION else MAX_UPLOAD_BYTES
                if source_status.st_size > size_limit:
                    raise WebValidationError(t("ローカルファイルのサイズが上限を超えています"))
                entries.append((resolved_path.name, lambda destination, source=resolved_path: shutil.copyfile(source, destination)))

            project_entries = [entry for entry in entries if entry[0].lower().endswith(PROJECT_EXTENSION)]
            if project_entries:
                payload, ui_state, warnings = project_service.import_upload(
                    project_entries[0][1]
                )
                return jsonify(kind="project", session=payload, uiState=ui_state, warnings=warnings)
            if len(entries) == 1 and entries[0][0].lower().endswith(ALLOWED_MIDI_EXTENSIONS):
                return jsonify(
                    kind="midi", session=source_service.ingest_midi(*entries[0])
                ), 201
            return jsonify(
                kind="source", session=source_service.ingest_sources(entries)
            ), 201

    @app.post("/api/source/select-file")
    def select_source_file() -> Response:
        if web_session.root is None or not web_session.source_files:
            raise WebValidationError(t("先に音源ファイルをアップロードしてください"))
        body = request.get_json(silent=True) or {}
        relative = body.get("path")
        if not isinstance(relative, str) or not relative:
            raise WebValidationError(t("pathを指定してください"))
        return jsonify(**source_service.select_source(relative))

    @app.post("/api/source/convert")
    def convert_source() -> Response:
        if (
            web_session.source_path is None
            or web_session.root is None
            or web_session.source_format is None
        ):
            raise WebValidationError(t("先に音源ファイルをアップロードしてください"))
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            raise WebValidationError(t("変換オプションはオブジェクトで指定してください"))
        payload = source_service.convert_source(body, start_chip_prewarm)
        return jsonify(**payload)

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
    port: int = 0,
    require_token: bool = True,
    local_open_dir: Path | None = None,
) -> None:
    """127.0.0.1でWeb UIを起動し、終了時に一時データを消す。

    portが0（既定）の場合はOSが空きポートを自動選択する。0以外を渡すと
    そのポートに固定してバインドする。require_token=Falseは`--no-token`
    起動用で、起動トークン検証そのものを無効化する
    （固定ポートと組み合わせると、URL全体をブックマークして毎回開けるように
    なるトレードオフ。127.0.0.1限定バインドとOrigin検証はrequire_tokenに
    関わらず常に有効）。
    """
    token = secrets.token_urlsafe(32)
    session = WebSession()
    session.soundfont_override = resolve_startup_soundfont_override(soundfont)
    app = create_app(
        token=token,
        session=session,
        soundfont=soundfont,
        require_token=require_token,
        local_open_dir=local_open_dir,
    )

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

    server = make_server("127.0.0.1", port, app, threaded=True)
    port = server.server_port
    if require_token:
        url = f"http://127.0.0.1:{port}/?token={token}"
    else:
        url = f"http://127.0.0.1:{port}/"
        print(
            "Warning: --no-token disables launch-token authentication. "
            "Other users and processes on this Mac can also reach it via "
            "127.0.0.1."
        )
    print(f"miditrack Web UI: {url}")
    print("Press Ctrl-C in this terminal to quit.")
    sys.stdout.flush()
    if open_browser:
        threading.Timer(0.2, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nmiditrack Web UI stopped.")
    finally:
        server.shutdown()
        session.clear()


if __name__ == "__main__":  # pragma: no cover
    run_server()
