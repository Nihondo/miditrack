"""Web UIの単一ブラウザセッション状態。"""

from __future__ import annotations

import shutil
import threading
import re
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import convert, libvgm, midi, nsf_chip, render
from .errors import WebValidationError
from .i18n import t
from .midi import TrackInfo
from .render_service import CachedAudio, PreviewAudio


@dataclass
class WebSession:
    """1ブラウザセッション分の入力、編集状態、生成物を保持する。"""

    root: Path | None = None
    original_path: Path | None = None
    original_name: str = ""
    download_stem: str = ""
    ticks_per_beat: int | None = None
    tracks: list[TrackInfo] = field(default_factory=list)
    assignments: dict[int, int] = field(default_factory=dict)
    volumes: dict[int, int] = field(default_factory=dict)
    track_sources: dict[int, str] = field(default_factory=dict)
    chip_metadata: libvgm.LibvgmMetadata | nsf_chip.NsfChipMetadata | None = None
    conversion_warnings: list[str] = field(default_factory=list)
    speed_ratio: float = midi.DEFAULT_SPEED_RATIO
    transpose_semitones: int = midi.DEFAULT_TRANSPOSE_SEMITONES
    applied_path: Path | None = None
    apply_summary: dict[str, int | float] | None = None
    applied_duration_seconds: float | None = None
    source_midi_cache: Any | None = None
    source_midi_cache_revision: int | None = None
    audio_path: Path | None = None
    current_render_key: str | None = None
    current_render_mode: str | None = None
    current_render_id: int = 0
    midi_revision: int = 0
    state_revision: int = 0
    render_cache: OrderedDict[str, CachedAudio] = field(
        default_factory=OrderedDict, repr=False
    )
    render_cache_bytes: int = 0
    preview_cache: OrderedDict[str, PreviewAudio] = field(
        default_factory=OrderedDict, repr=False
    )
    preview_cache_bytes: int = 0
    render_id: int = 0
    audio_sources: OrderedDict[int, Path] = field(
        default_factory=OrderedDict, repr=False
    )
    variations_zip_path: Path | None = None
    track_export_zip_path: Path | None = None
    render_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    preview_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    state_lock: threading.RLock = field(default_factory=threading.RLock, repr=False)
    chip_stem_path: Path | None = None
    dac_stem_path: Path | None = None
    game_soundfont_path: Path | None = None
    soundfont_override: Path | None = None
    source_path: Path | None = None
    source_name: str = ""
    source_format: str | None = None
    source_metadata: dict[str, Any] = field(default_factory=dict)
    source_songs: list[dict[str, Any]] = field(default_factory=list)
    source_song_index: int | None = None
    converted_options: dict[str, Any] = field(default_factory=dict)
    source_files: list[dict[str, str]] = field(default_factory=list)
    source_m3u_texts: list[str] = field(default_factory=list)

    def clear_render_cache(self) -> None:
        """試聴・最終WAV・実機ステムのセッション内キャッシュを破棄する。"""
        self.clear_preview_cache()
        for entry in self.render_cache.values():
            entry.path.unlink(missing_ok=True)
        self.render_cache.clear()
        self.render_cache_bytes = 0
        self.current_render_key = None
        self.current_render_mode = None
        self.current_render_id = 0
        self.audio_sources.clear()

    def clear_preview_cache(self, *, preserve_active_sources: bool = False) -> None:
        """短区間プレビューの専用キャッシュを破棄する。"""
        protected = set(self.audio_sources.values()) if preserve_active_sources else set()
        for entry in self.preview_cache.values():
            if entry.path not in protected:
                entry.path.unlink(missing_ok=True)
        self.preview_cache.clear()
        self.preview_cache_bytes = 0

    def reset_midi_state(self) -> None:
        """MIDI由来の状態だけを初期状態へ戻す。"""
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
        self.conversion_warnings = []
        self.speed_ratio = midi.DEFAULT_SPEED_RATIO
        self.transpose_semitones = midi.DEFAULT_TRANSPOSE_SEMITONES
        self.applied_path = None
        self.apply_summary = None
        self.applied_duration_seconds = None
        self.source_midi_cache = None
        self.source_midi_cache_revision = None
        self.audio_path = None
        self.variations_zip_path = None
        self.track_export_zip_path = None
        self.chip_stem_path = None
        self.dac_stem_path = None
        self.game_soundfont_path = None
        self.converted_options = {}

    def clear(self) -> None:
        """現在の一時ディレクトリと全入力状態を破棄する。"""
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
        """MIDI由来の状態を差し替え、入力と編集の世代を進める。"""
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
        """既存状態を破棄し、新しいMIDIアップロードへ置き換える。"""
        self.clear()
        self.root = root
        self.load_midi(original_path, original_name, ticks_per_beat, tracks)

    def invalidate_render(self) -> None:
        """編集状態を残し、そこから導出した生成物だけを無効化する。"""
        self.clear_preview_cache(preserve_active_sources=True)
        self.applied_path = None
        self.apply_summary = None
        self.applied_duration_seconds = None
        self.audio_path = None
        self.current_render_key = None
        self.current_render_mode = None
        self.variations_zip_path = None
        self.track_export_zip_path = None
        self.state_revision += 1

    def require_tracks(self) -> list[TrackInfo]:
        """読込済みトラックを返し、未読込なら検証エラーにする。"""
        if not self.tracks:
            raise WebValidationError(t("先にMIDIファイルをアップロードしてください"))
        return self.tracks


def sanitize_stem(filename: str) -> str:
    """ダウンロードファイル名に安全に使えるstemへ正規化する。"""
    basename = filename.replace("\\", "/").rsplit("/", 1)[-1]
    stem = Path(basename).stem.strip().lstrip(".")
    safe = re.sub(r"[^\w .()-]", "_", stem, flags=re.UNICODE).strip(" .")
    return safe or "miditrack"


def track_filename_label(name: str, index: int) -> str:
    """トラック名をファイル名に安全な断片へ正規化する。"""
    safe = re.sub(r"[^\w .()-]", "_", name.strip(), flags=re.UNICODE).strip(" .")
    return safe or f"Track{index}"


def effective_download_stem(session: WebSession) -> str:
    """明示指定または元ファイル名からダウンロード用stemを返す。"""
    return session.download_stem or session.original_name


def safe_upload_basename(filename: str) -> str:
    """アップロード名を拡張子付きの安全なbasenameへ正規化する。"""
    basename = filename.replace("\\", "/").rsplit("/", 1)[-1]
    suffix = Path(basename).suffix.lower()
    if not re.fullmatch(r"\.[A-Za-z0-9]{1,10}", suffix):
        suffix = ""
    return f"{sanitize_stem(basename)}{suffix}"


def unique_upload_path(directory: Path, original_filename: str) -> Path:
    """アップロード元のbasenameを保った重複しない保存先を返す。"""
    basename = safe_upload_basename(original_filename)
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


def selected_track_source(session: WebSession, track: TrackInfo) -> str:
    """セッション上の明示指定を加味した実効トラック音源を返す。"""
    return session.track_sources.get(track.index, "soundfont")


def set_track_source(session: WebSession, track: TrackInfo, source: str) -> None:
    """既定のSoundFontとの差分だけをセッションへ保存する。"""
    if source == "soundfont":
        session.track_sources.pop(track.index, None)
    else:
        session.track_sources[track.index] = source


def validate_track_sources(
    session: WebSession, tracks: list[TrackInfo], raw_sources: dict[int, str]
) -> dict[int, str]:
    """フォーマット別の選択可能音源に従ってトラック音源を検証する。"""
    tracks_by_index = {track.index: track for track in tracks}
    if session.source_format == "spc":
        validated: dict[int, str] = {}
        for track_index, source in raw_sources.items():
            track = tracks_by_index[track_index]
            if source == "game":
                if session.game_soundfont_path is None or track.note_count == 0:
                    raise WebValidationError(
                        t("トラック{track_index}では原曲の音色を選べません", track_index=track_index)
                    )
                validated[track_index] = source
            elif source == "soundfont":
                validated[track_index] = source
            else:
                raise WebValidationError(t("未知のトラック音源です: {source}", source=source))
        return validated
    if session.source_format == "vgm":
        assert session.chip_metadata is None or isinstance(
            session.chip_metadata, libvgm.LibvgmMetadata
        )
        return libvgm.validate_sources(session.chip_metadata, raw_sources)
    if session.source_format == "nsf":
        assert session.chip_metadata is None or isinstance(
            session.chip_metadata, nsf_chip.NsfChipMetadata
        )
        return nsf_chip.validate_sources(session.chip_metadata, raw_sources)
    validated = {}
    for track_index, source in raw_sources.items():
        if source != "soundfont":
            raise WebValidationError(t("未知のトラック音源です: {source}", source=source))
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
    """トラック状態を既存HTTP契約のJSON要素へ直列化する。"""
    target = metadata.targets.get(track.index) if metadata else None
    has_game_source = target is not None or (has_game_soundfont and track.note_count > 0)
    is_suggested = target.suggested if target else has_game_source
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
        "availableSources": ["soundfont", "game"] if has_game_source else ["soundfont"],
        "sourceSuggested": is_suggested,
        "sourceGroupSize": len(metadata.group_indices(target.group_id))
        if metadata and target
        else 1,
    }


def soundfont_payload(
    session: WebSession, default_soundfont: Path | None
) -> dict[str, Any]:
    """利用可能なSoundFontと現在選択をHTTP応答用に直列化する。"""
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
    """音源由来の状態を既存HTTP契約のJSON要素へ直列化する。"""
    if session.source_format is None:
        return None
    source_format = convert.format_by_key(session.source_format)
    active_file = None
    if session.source_path is not None and session.root is not None:
        active_file = session.source_path.relative_to(session.root).as_posix()
    return {
        "name": session.source_name,
        "format": source_format.key,
        "formatLabel": t(source_format.label),
        "metadata": session.source_metadata,
        "songs": session.source_songs,
        "options": convert.option_schema(source_format),
        "files": session.source_files,
        "activeFile": active_file,
        "hasPlaylist": len(session.source_m3u_texts) > 0,
        "convertedOptions": session.converted_options,
    }


def session_payload(session: WebSession) -> dict[str, Any]:
    """セッション全体を既存HTTP契約のJSONへ直列化する。"""
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
        "conversionWarnings": list(session.conversion_warnings),
        "source": source_payload(session),
    }
