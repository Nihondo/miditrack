"""MIDIおよびゲーム音源の取込・選択・変換サービス。"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Any, Callable

from . import convert, libvgm, midi, nsf_chip
from .convert import SourceFormat
from .errors import WebValidationError
from .i18n import t
from .web_session import WebSession, sanitize_stem, session_payload, unique_upload_path

UploadSaver = Callable[[Path], None]
ListSongsFunc = Callable[
    [SourceFormat, Path], tuple[dict[str, Any], list[dict[str, Any]]]
]
ConvertFunc = Callable[
    [SourceFormat, Path, Path, dict[str, Any]], tuple[Path | None, Path | None]
]


class SourceService:
    """入力ファイルと変換結果のWebSessionライフサイクルを管理する。"""

    def __init__(
        self,
        session: WebSession,
        list_songs: ListSongsFunc,
        converter: ConvertFunc,
    ) -> None:
        self._session = session
        self._list_songs = list_songs
        self._converter = converter

    def ingest_midi(self, original_name: str, save: UploadSaver) -> dict[str, Any]:
        """保存方法を問わずMIDIを新しいセッションへ取り込む。"""
        if not original_name.lower().endswith((".mid", ".midi")):
            raise WebValidationError(t("拡張子が .mid または .midi のファイルを選択してください"))
        temp_root = Path(tempfile.mkdtemp(prefix="miditrack-"))
        try:
            original_path = temp_root / "original.mid"
            save(original_path)
            midi_file, tracks = midi.analyze_midi_file(original_path)
            self._session.replace(
                root=temp_root,
                original_path=original_path,
                original_name=sanitize_stem(original_name),
                ticks_per_beat=midi_file.ticks_per_beat,
                tracks=tracks,
            )
        except Exception:
            shutil.rmtree(temp_root, ignore_errors=True)
            raise
        return session_payload(self._session)

    def ingest_sources(
        self, entries: list[tuple[str, UploadSaver]]
    ) -> dict[str, Any]:
        """音源・ZIP・m3uを新しい音源セッションへ取り込む。"""
        if not entries:
            raise WebValidationError(t("音源ファイルを選択してください"))
        temp_root = Path(tempfile.mkdtemp(prefix="miditrack-")).resolve()
        try:
            candidates, playlists = self._save_source_entries(temp_root, entries)
            self._require_candidates(candidates)
            candidates.sort(key=lambda path: path.relative_to(temp_root).as_posix())
            self._session.clear()
            self._session.root = temp_root
            self._session.source_files = [
                {"path": path.relative_to(temp_root).as_posix(), "name": path.name}
                for path in candidates
            ]
            self._session.source_m3u_texts = playlists
            self.activate_source(candidates[0])
        except Exception:
            shutil.rmtree(temp_root, ignore_errors=True)
            raise
        return session_payload(self._session)

    def select_source(self, relative_path: str) -> dict[str, Any]:
        """アップロード済み候補から現在の変換対象を選択する。"""
        session = self._session
        if session.root is None or not session.source_files:
            raise WebValidationError(t("先に音源ファイルをアップロードしてください"))
        match = next(
            (entry for entry in session.source_files if entry["path"] == relative_path),
            None,
        )
        if match is None:
            raise WebValidationError(t("未知のファイルです: {relative}", relative=relative_path))
        self.activate_source(session.root / relative_path)
        return session_payload(session)

    def activate_source(self, path: Path) -> None:
        """指定音源を変換対象にし、曲一覧とメタデータを読み直す。"""
        source_format = convert.detect_format(path.name)
        session = self._session
        session.reset_midi_state()
        session.source_path = path
        session.source_name = sanitize_stem(path.name)
        session.source_format = source_format.key
        metadata, songs = self._read_source_details(source_format, path)
        session.source_metadata = metadata
        session.source_songs = songs

    def convert_source(
        self, raw_options: dict[str, Any], start_prewarm: Callable[[], None]
    ) -> dict[str, Any]:
        """現在の音源をMIDIへ変換し、編集可能なセッション状態へ反映する。"""
        session = self._session
        if session.source_path is None or session.root is None or session.source_format is None:
            raise WebValidationError(t("先に音源ファイルをアップロードしてください"))
        source_format = convert.format_by_key(session.source_format)
        options = convert.validate_convert_options(
            source_format, session.source_songs, raw_options
        )
        output_path = session.root / "converted.mid"
        chip_stem_path, dac_stem_path = self._converter(
            source_format, session.source_path, output_path, options
        )
        midi_file, tracks = midi.analyze_midi_file(output_path)
        metadata = self._load_chip_metadata(source_format, output_path, len(tracks))
        self._load_converted_midi(source_format, output_path, midi_file, tracks, options)
        self._apply_generated_assets(
            source_format, tracks, options, metadata, chip_stem_path, dac_stem_path
        )
        start_prewarm()
        return session_payload(session)

    def _save_source_entries(
        self, temp_root: Path, entries: list[tuple[str, UploadSaver]]
    ) -> tuple[list[Path], list[str]]:
        uploads_dir = temp_root / "uploads"
        uploads_dir.mkdir()
        archive_dir = temp_root / "archive"
        candidates: list[Path] = []
        playlists: list[str] = []
        for index, (original_name, save) in enumerate(entries):
            self._save_source_entry(
                original_name,
                save,
                index,
                uploads_dir,
                archive_dir,
                candidates,
                playlists,
            )
        return candidates, playlists

    @staticmethod
    def _save_source_entry(
        original_name: str,
        save: UploadSaver,
        index: int,
        uploads_dir: Path,
        archive_dir: Path,
        candidates: list[Path],
        playlists: list[str],
    ) -> None:
        if convert.is_zip_filename(original_name):
            zip_path = uploads_dir / f"upload_{index}.zip"
            save(zip_path)
            SourceService._collect_archive_members(zip_path, archive_dir, candidates, playlists)
            return
        if convert.is_hidden_member_name(original_name):
            return
        if convert.is_m3u_filename(original_name):
            saved = unique_upload_path(uploads_dir, original_name)
            save(saved)
            playlists.append(saved.read_text(encoding="utf-8", errors="replace"))
            return
        if convert.try_detect_format(original_name) is not None:
            saved = unique_upload_path(uploads_dir, original_name)
            save(saved)
            candidates.append(saved)

    @staticmethod
    def _collect_archive_members(
        zip_path: Path,
        archive_dir: Path,
        candidates: list[Path],
        playlists: list[str],
    ) -> None:
        for member in convert.extract_zip_members(zip_path, archive_dir):
            if convert.is_hidden_member_name(member.name):
                continue
            if convert.is_m3u_filename(member.name):
                playlists.append(member.read_text(encoding="utf-8", errors="replace"))
            elif convert.try_detect_format(member.name) is not None:
                candidates.append(member)

    @staticmethod
    def _require_candidates(candidates: list[Path]) -> None:
        if candidates:
            return
        supported = ", ".join(
            extension
            for source_format in convert.SOURCE_FORMATS
            for extension in source_format.extensions
        )
        raise WebValidationError(
            t(
                "対応する音源ファイルが見つかりません（対応: {supported}。ZIPやm3uだけでは変換できません）",
                supported=supported,
            )
        )

    def _read_source_details(
        self, source_format: SourceFormat, path: Path
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        if not source_format.supports_song_list:
            return {}, []
        metadata, songs = self._list_songs(source_format, path)
        for m3u_text in self._session.source_m3u_texts:
            entries = convert.filter_m3u_entries(convert.parse_m3u(m3u_text), path.name)
            if entries:
                return metadata, convert.apply_m3u_titles(songs, entries)
        return metadata, songs

    @staticmethod
    def _load_chip_metadata(
        source_format: SourceFormat, output_path: Path, track_count: int
    ) -> libvgm.LibvgmMetadata | nsf_chip.NsfChipMetadata | None:
        if source_format.key == "vgm":
            return libvgm.load_metadata(libvgm.metadata_path_for(output_path), track_count)
        if source_format.key == "nsf":
            return nsf_chip.load_metadata(nsf_chip.metadata_path_for(output_path), track_count)
        return None

    def _load_converted_midi(
        self,
        source_format: SourceFormat,
        output_path: Path,
        midi_file: Any,
        tracks: list[Any],
        options: dict[str, Any],
    ) -> None:
        stem = self._session.source_name
        if source_format.supports_song_list and options.get("songIndex") is not None:
            stem = f"{stem}_{options['songIndex']:02d}"
        self._session.load_midi(
            original_path=output_path,
            original_name=stem,
            ticks_per_beat=midi_file.ticks_per_beat,
            tracks=tracks,
        )
        self._session.source_song_index = options.get("songIndex")
        self._session.converted_options = options

    def _apply_generated_assets(
        self,
        source_format: SourceFormat,
        tracks: list[Any],
        options: dict[str, Any],
        metadata: libvgm.LibvgmMetadata | nsf_chip.NsfChipMetadata | None,
        chip_stem_path: Path | None,
        dac_stem_path: Path | None,
    ) -> None:
        session = self._session
        session.chip_metadata = metadata
        session.conversion_warnings = (
            list(metadata.warnings) if isinstance(metadata, libvgm.LibvgmMetadata) else []
        )
        if metadata is not None:
            session.chip_stem_path = None
            session.dac_stem_path = None
            if options.get("chipNoise"):
                session.track_sources = {
                    index: "game"
                    for index, target in metadata.targets.items()
                    if target.suggested
                }
        else:
            session.chip_stem_path = chip_stem_path
            session.dac_stem_path = dac_stem_path
        session.game_soundfont_path = convert.produced_game_soundfont(session.original_path)
        if (
            source_format.key == "spc"
            and options.get("gameSoundfont")
            and session.game_soundfont_path is not None
        ):
            session.track_sources = {
                track.index: "game" for track in tracks if track.note_count > 0
            }
