"""`.miditrack`プロジェクトの検証、保存、復元サービス。"""

from __future__ import annotations

import json
import math
import shutil
import tempfile
from pathlib import Path
from typing import Any, Callable

from . import convert, libvgm, midi, nsf_chip, preferences, project, render
from .errors import WebValidationError
from .i18n import t
from .midi import TrackInfo
from .web_session import (
    WebSession,
    effective_download_stem,
    sanitize_stem,
    session_payload,
    set_track_source,
    validate_track_sources,
)

UploadSaver = Callable[[Path], None]
RenderModeValidator = Callable[[Any], str]


def resolve_project_member(root: Path, member: Any, label: str) -> Path:
    """プロジェクト展開先配下の通常ファイルだけを解決する。"""
    if not isinstance(member, str) or not member:
        raise WebValidationError(t("プロジェクトの{label}が不正です", label=label))
    candidate = (root / member).resolve()
    if candidate == root or root not in candidate.parents or not candidate.is_file():
        raise WebValidationError(t("プロジェクトの{label}が見つかりません", label=label))
    return candidate


def serialize_chip_metadata(
    metadata: libvgm.LibvgmMetadata | nsf_chip.NsfChipMetadata | None,
) -> dict[str, Any] | None:
    """実機音源メタデータを既存loader互換JSONへ直列化する。"""
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


class ProjectService:
    """現在のWebSessionと`.miditrack`アーカイブの相互変換を担当する。"""

    def __init__(
        self, session: WebSession, validate_render_mode: RenderModeValidator
    ) -> None:
        self._session = session
        self._validate_render_mode = validate_render_mode

    def validate_ui(self, raw_ui: Any, tracks: list[TrackInfo]) -> dict[str, Any]:
        """プロジェクトへ保存するブラウザUI状態を検証する。"""
        if not isinstance(raw_ui, dict):
            raise WebValidationError(t("プロジェクトの画面設定はオブジェクトで指定してください"))
        validated: dict[str, Any] = {
            "renderMode": self._validate_render_mode(raw_ui.get("renderMode"))
        }
        track_indices = {track.index for track in tracks}
        if raw_ui.get("loop") is not None:
            validated["loop"] = self._validate_loop(raw_ui["loop"])
        self._validate_preset(raw_ui, validated, track_indices)
        return validated

    def export(self, ui_state: dict[str, Any]) -> Path:
        """現在の編集可能なセッションを`.miditrack`へ書き出す。"""
        session = self._session
        if session.root is None or session.original_path is None:
            raise WebValidationError(t("先にMIDIファイルを読み込んでください"))
        files: dict[str, Path] = {"midi/original.mid": session.original_path}
        source_section = self._collect_source_section(files)
        assets = self._collect_assets(files)
        manifest = self._build_manifest(ui_state, source_section, assets)
        archive_path = session.root / f"{effective_download_stem(session)}.miditrack"
        project.create_archive(archive_path, manifest, files)
        return archive_path

    def import_upload(
        self, save: UploadSaver
    ) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
        """アップロードを検証復元し、成功した場合だけ現在状態を置換する。"""
        staging_root = Path(tempfile.mkdtemp(prefix="miditrack-project-upload-"))
        try:
            archive_path = staging_root / "project.miditrack"
            save(archive_path)
            candidate, ui_state, warnings = self.load(archive_path)
        finally:
            shutil.rmtree(staging_root, ignore_errors=True)
        self._session.clear()
        self._session.__dict__.update(candidate.__dict__)
        return session_payload(self._session), ui_state, warnings

    def load(self, archive_path: Path) -> tuple[WebSession, dict[str, Any], list[str]]:
        """アーカイブを独立セッションへ復元して返す。"""
        project_root = Path(tempfile.mkdtemp(prefix="miditrack-project-")).resolve()
        try:
            extracted = project.extract_archive(archive_path, project_root)
            manifest = extracted.manifest
            candidate, tracks, raw_edits = self._restore_midi(extracted.root, manifest)
            self._restore_source(extracted.root, manifest, candidate)
            self._restore_assets(extracted.root, manifest, candidate, tracks)
            self._restore_edits(raw_edits, manifest["midi"], candidate, tracks)
            warnings = self._restore_soundfont(manifest, candidate)
            ui_state = self.validate_ui(manifest.get("ui", {}), tracks)
            return candidate, ui_state, warnings
        except Exception:
            shutil.rmtree(project_root, ignore_errors=True)
            raise

    @staticmethod
    def _validate_loop(raw_loop: Any) -> dict[str, Any]:
        if not isinstance(raw_loop, dict):
            raise WebValidationError(t("区間ループ設定が不正です"))
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
            raise WebValidationError(t("区間ループの開始・終了設定が不正です"))
        return {"start": float(start), "end": float(end), "enabled": enabled}

    @staticmethod
    def _validate_roles(raw_roles: Any, track_indices: set[int]) -> dict[str, str]:
        if not isinstance(raw_roles, dict):
            raise WebValidationError(t("トラック役割設定が不正です"))
        roles: dict[str, str] = {}
        for raw_index, role_id in raw_roles.items():
            try:
                track_index = int(raw_index)
            except (TypeError, ValueError):
                raise WebValidationError(t("トラック役割のトラック番号が不正です")) from None
            if str(track_index) != str(raw_index) or track_index not in track_indices:
                raise WebValidationError(t("トラック役割のトラック番号が不正です"))
            if not isinstance(role_id, str) or role_id not in preferences.TRACK_ROLE_IDS:
                raise WebValidationError(t("トラック役割が不正です"))
            roles[str(track_index)] = role_id
        return roles

    @staticmethod
    def _validate_snapshot(raw_snapshot: Any, track_indices: set[int]) -> dict[str, Any]:
        if not isinstance(raw_snapshot, dict):
            raise WebValidationError(t("編成プリセットの復元設定が不正です"))
        raw_assignments = raw_snapshot.get("assignments")
        raw_sources = raw_snapshot.get("sources")
        expected_keys = {str(track_index) for track_index in track_indices}
        if (
            not isinstance(raw_assignments, dict)
            or not isinstance(raw_sources, dict)
            or set(raw_assignments) != expected_keys
            or set(raw_sources) != expected_keys
        ):
            raise WebValidationError(t("編成プリセットの復元設定が不正です"))
        return ProjectService._validate_snapshot_values(
            raw_assignments, raw_sources, expected_keys
        )

    @staticmethod
    def _validate_snapshot_values(
        raw_assignments: dict[str, Any],
        raw_sources: dict[str, Any],
        expected_keys: set[str],
    ) -> dict[str, Any]:
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
                raise WebValidationError(t("編成プリセットの復元設定が不正です"))
            assignments[key] = assignment
            sources[key] = source
        return {"assignments": assignments, "sources": sources}

    def _validate_preset(
        self,
        raw_ui: dict[str, Any],
        validated: dict[str, Any],
        track_indices: set[int],
    ) -> None:
        preset_id = raw_ui.get("ensemblePreset")
        preset_definition = self._resolve_preset_definition(raw_ui, preset_id)
        if preset_id is not None:
            validated["ensemblePreset"] = preset_id
            if preset_definition is not None:
                validated["ensemblePresetDefinition"] = preset_definition
        if "trackRoles" in raw_ui:
            validated["trackRoles"] = self._validate_roles(raw_ui["trackRoles"], track_indices)
        if "ensemblePresetSnapshot" in raw_ui:
            validated["ensemblePresetSnapshot"] = self._validate_snapshot(
                raw_ui["ensemblePresetSnapshot"], track_indices
            )
        dependent = {"trackRoles", "ensemblePresetDefinition", "ensemblePresetSnapshot"}
        if dependent.intersection(validated) and preset_id is None:
            raise WebValidationError(t("編成プリセットが指定されていません"))

    @staticmethod
    def _resolve_preset_definition(
        raw_ui: dict[str, Any], preset_id: Any
    ) -> dict[str, Any] | None:
        if "ensemblePresetDefinition" in raw_ui and preset_id is None:
            raise WebValidationError(t("編成プリセットが指定されていません"))
        if preset_id is None:
            return None
        if not isinstance(preset_id, str):
            raise WebValidationError(t("編成プリセットが不正です"))
        raw_definition = raw_ui.get("ensemblePresetDefinition")
        definition = None
        if raw_definition is not None:
            definition = preferences.validate_ensemble_presets([raw_definition])[0]
            if definition["id"] != preset_id:
                raise WebValidationError(t("編成プリセットの定義が一致しません"))
        configured_ids = {
            preset["id"] for preset in preferences.load_preferences()["ensemblePresets"]
        }
        if preset_id not in configured_ids and definition is None:
            raise WebValidationError(t("編成プリセットが見つかりません"))
        return definition

    @staticmethod
    def _member_for_source(relative_path: str) -> str:
        if relative_path.split("/", 1)[0] == "source":
            return relative_path
        return f"source/{relative_path}"

    def _collect_source_section(self, files: dict[str, Path]) -> dict[str, Any] | None:
        session = self._session
        if session.source_format is None or session.root is None:
            return None
        source_files: list[dict[str, str]] = []
        source_members: dict[str, str] = {}
        for entry in session.source_files:
            raw_path, name = entry.get("path"), entry.get("name")
            if not isinstance(raw_path, str) or not isinstance(name, str):
                raise WebValidationError(t("セッションの音源ファイル情報が不正です"))
            member = self._member_for_source(raw_path)
            files[member] = resolve_project_member(session.root, raw_path, t("音源ファイル"))
            source_members[raw_path] = member
            source_files.append({"path": member, "name": name})
        active_file = self._collect_active_source(files, source_files, source_members)
        return {
            "name": session.source_name,
            "format": session.source_format,
            "metadata": session.source_metadata,
            "songs": session.source_songs,
            "files": source_files,
            "activeFile": active_file,
            "playlists": session.source_m3u_texts,
            "songIndex": session.source_song_index,
            "convertedOptions": session.converted_options,
        }

    def _collect_active_source(
        self,
        files: dict[str, Path],
        source_files: list[dict[str, str]],
        source_members: dict[str, str],
    ) -> str | None:
        session = self._session
        if session.source_path is None or session.root is None:
            return None
        raw_active = session.source_path.relative_to(session.root).as_posix()
        active_file = source_members.get(raw_active)
        if active_file is not None:
            return active_file
        active_file = self._member_for_source(raw_active)
        files[active_file] = resolve_project_member(
            session.root, raw_active, t("選択中の音源ファイル")
        )
        source_files.append({"path": active_file, "name": session.source_path.name})
        return active_file

    def _collect_assets(self, files: dict[str, Path]) -> dict[str, Any]:
        session = self._session
        assets: dict[str, Any] = {"chipMetadata": serialize_chip_metadata(session.chip_metadata)}
        for key, path, prefix in (
            ("chipStem", session.chip_stem_path, "assets/chip-stem.wav"),
            ("dacStem", session.dac_stem_path, "assets/dac-stem.wav"),
            ("gameSoundfont", session.game_soundfont_path, "assets/game-soundfont"),
        ):
            if path is not None and path.is_file():
                member = prefix if prefix.endswith(".wav") else f"{prefix}{path.suffix.lower()}"
                files[member] = path
                assets[key] = member
            else:
                assets[key] = None
        return assets

    def _build_manifest(
        self,
        ui_state: dict[str, Any],
        source_section: dict[str, Any] | None,
        assets: dict[str, Any],
    ) -> dict[str, Any]:
        session = self._session
        return {
            "format": project.PROJECT_FORMAT,
            "version": project.PROJECT_VERSION,
            "midi": {
                "path": "midi/original.mid",
                "originalName": session.original_name,
                "downloadStem": session.download_stem,
            },
            "edits": {
                "assignments": session.assignments,
                "volumes": session.volumes,
                "sources": session.track_sources,
                "speed": session.speed_ratio,
                "transpose": session.transpose_semitones,
            },
            "source": source_section,
            "assets": assets,
            "soundfontPath": str(session.soundfont_override)
            if session.soundfont_override
            else None,
            "ui": ui_state,
        }

    @staticmethod
    def _restore_midi(
        extracted_root: Path, manifest: dict[str, Any]
    ) -> tuple[WebSession, list[TrackInfo], dict[str, Any]]:
        raw_midi = manifest.get("midi")
        raw_edits = manifest.get("edits")
        if not isinstance(raw_midi, dict) or not isinstance(raw_edits, dict):
            raise WebValidationError(t("プロジェクトのMIDIまたは編集情報が不正です"))
        original_path = resolve_project_member(extracted_root, raw_midi.get("path"), t("基準MIDI"))
        original_name = raw_midi.get("originalName")
        if not isinstance(original_name, str) or not original_name:
            raise WebValidationError(t("プロジェクトの元ファイル名が不正です"))
        midi_file, tracks = midi.analyze_midi_file(original_path)
        candidate = WebSession(root=extracted_root)
        candidate.load_midi(
            original_path, sanitize_stem(original_name), midi_file.ticks_per_beat, tracks
        )
        return candidate, tracks, raw_edits

    @staticmethod
    def _restore_source(
        extracted_root: Path, manifest: dict[str, Any], candidate: WebSession
    ) -> None:
        raw_source = manifest.get("source")
        if raw_source is None:
            return
        if not isinstance(raw_source, dict):
            raise WebValidationError(t("プロジェクトの音源情報が不正です"))
        source_format, source_name = raw_source.get("format"), raw_source.get("name")
        source_files, active_file = raw_source.get("files"), raw_source.get("activeFile")
        if not isinstance(source_format, str) or not isinstance(source_name, str):
            raise WebValidationError(t("プロジェクトの音源情報が不正です"))
        convert.format_by_key(source_format)
        if not isinstance(source_files, list) or not isinstance(active_file, str):
            raise WebValidationError(t("プロジェクトの音源ファイル情報が不正です"))
        candidate.source_format = source_format
        candidate.source_name = sanitize_stem(source_name)
        candidate.source_files = ProjectService._restore_source_files(
            extracted_root, source_files
        )
        ProjectService._restore_active_source(extracted_root, active_file, candidate)
        ProjectService._restore_source_details(raw_source, candidate)

    @staticmethod
    def _restore_source_files(
        extracted_root: Path, source_files: list[Any]
    ) -> list[dict[str, str]]:
        restored: list[dict[str, str]] = []
        for entry in source_files:
            if (
                not isinstance(entry, dict)
                or not isinstance(entry.get("path"), str)
                or not isinstance(entry.get("name"), str)
            ):
                raise WebValidationError(t("プロジェクトの音源ファイル情報が不正です"))
            path = resolve_project_member(extracted_root, entry["path"], t("音源ファイル"))
            restored.append(
                {"path": path.relative_to(extracted_root).as_posix(), "name": entry["name"]}
            )
        return restored

    @staticmethod
    def _restore_active_source(
        extracted_root: Path, active_file: str, candidate: WebSession
    ) -> None:
        active_path = resolve_project_member(
            extracted_root, active_file, t("選択中の音源ファイル")
        )
        known_paths = {entry["path"] for entry in candidate.source_files}
        if active_path.relative_to(extracted_root).as_posix() not in known_paths:
            raise WebValidationError(t("選択中の音源ファイルが一覧に含まれていません"))
        candidate.source_path = active_path

    @staticmethod
    def _restore_source_details(raw_source: dict[str, Any], candidate: WebSession) -> None:
        metadata = raw_source.get("metadata", {})
        songs = raw_source.get("songs", [])
        playlists = raw_source.get("playlists", [])
        if (
            not isinstance(metadata, dict)
            or not isinstance(songs, list)
            or not isinstance(playlists, list)
            or not all(isinstance(item, str) for item in playlists)
        ):
            raise WebValidationError(t("プロジェクトの音源詳細が不正です"))
        song_index = raw_source.get("songIndex")
        if song_index is not None and (
            isinstance(song_index, bool) or not isinstance(song_index, int)
        ):
            raise WebValidationError(t("プロジェクトの曲番号が不正です"))
        options = raw_source.get("convertedOptions", {})
        if not isinstance(options, dict):
            raise WebValidationError(t("プロジェクトの変換オプションが不正です"))
        candidate.source_metadata = metadata
        candidate.source_songs = songs
        candidate.source_m3u_texts = playlists
        candidate.source_song_index = song_index
        candidate.converted_options = convert.validate_convert_options(
            convert.format_by_key(candidate.source_format or ""), songs, options
        )

    @staticmethod
    def _restore_assets(
        extracted_root: Path,
        manifest: dict[str, Any],
        candidate: WebSession,
        tracks: list[TrackInfo],
    ) -> None:
        raw_assets = manifest.get("assets", {})
        if not isinstance(raw_assets, dict):
            raise WebValidationError(t("プロジェクトの追加資産情報が不正です"))
        ProjectService._restore_chip_metadata(extracted_root, raw_assets, candidate, tracks)
        for key, attribute, label in (
            ("chipStem", "chip_stem_path", t("チップステム")),
            ("dacStem", "dac_stem_path", t("DACステム")),
            ("gameSoundfont", "game_soundfont_path", t("ゲームSoundFont")),
        ):
            value = raw_assets.get(key)
            if value is not None:
                setattr(candidate, attribute, resolve_project_member(extracted_root, value, label))

    @staticmethod
    def _restore_chip_metadata(
        extracted_root: Path,
        raw_assets: dict[str, Any],
        candidate: WebSession,
        tracks: list[TrackInfo],
    ) -> None:
        raw_metadata = raw_assets.get("chipMetadata")
        if raw_metadata is None:
            return
        if (
            not isinstance(raw_metadata, dict)
            or not isinstance(raw_metadata.get("type"), str)
            or not isinstance(raw_metadata.get("payload"), dict)
        ):
            raise WebValidationError(t("プロジェクトの実機音源メタデータが不正です"))
        metadata_path = extracted_root / ".miditrack-metadata.json"
        metadata_path.write_text(json.dumps(raw_metadata["payload"]), encoding="utf-8")
        if raw_metadata["type"] == "vgm":
            candidate.chip_metadata = libvgm.load_metadata(metadata_path, len(tracks))
        elif raw_metadata["type"] == "nsf":
            candidate.chip_metadata = nsf_chip.load_metadata(metadata_path, len(tracks))
        else:
            raise WebValidationError(t("未対応の実機音源メタデータです"))

    @staticmethod
    def _parse_index_map(raw: Any, label: str) -> dict[int, Any]:
        if not isinstance(raw, dict):
            raise WebValidationError(t("プロジェクトの{label}が不正です", label=label))
        parsed: dict[int, Any] = {}
        for key, value in raw.items():
            try:
                index = int(key)
            except (TypeError, ValueError):
                raise WebValidationError(
                    t("プロジェクトの{label}のトラック番号が不正です: {key}", label=label, key=key)
                ) from None
            if str(index) != str(key):
                raise WebValidationError(
                    t("プロジェクトの{label}のトラック番号が不正です: {key}", label=label, key=key)
                )
            parsed[index] = value
        return parsed

    @staticmethod
    def _restore_edits(
        raw_edits: dict[str, Any],
        raw_midi: dict[str, Any],
        candidate: WebSession,
        tracks: list[TrackInfo],
    ) -> None:
        assignments = ProjectService._parse_index_map(
            raw_edits.get("assignments", {}), t("音色設定")
        )
        volumes = ProjectService._parse_index_map(
            raw_edits.get("volumes", {}), t("音量設定")
        )
        sources = ProjectService._parse_index_map(
            raw_edits.get("sources", {}), t("音源設定")
        )
        candidate.assignments = midi.validate_assignments(tracks, assignments)
        candidate.volumes = midi.validate_volumes(tracks, volumes)
        validated_sources = validate_track_sources(candidate, tracks, sources)
        tracks_by_index = {track.index: track for track in tracks}
        for track_index, source in validated_sources.items():
            set_track_source(candidate, tracks_by_index[track_index], source)
        candidate.speed_ratio = midi.validate_speed_ratio(raw_edits.get("speed"))
        candidate.transpose_semitones = midi.validate_transpose_semitones(
            raw_edits.get("transpose")
        )
        download_stem = raw_midi.get("downloadStem", "")
        if not isinstance(download_stem, str):
            raise WebValidationError(t("プロジェクトのダウンロード名が不正です"))
        candidate.download_stem = sanitize_stem(download_stem) if download_stem.strip() else ""

    @staticmethod
    def _restore_soundfont(
        manifest: dict[str, Any], candidate: WebSession
    ) -> list[str]:
        warnings: list[str] = []
        saved_soundfont = manifest.get("soundfontPath")
        if saved_soundfont is None:
            return warnings
        if not isinstance(saved_soundfont, str):
            raise WebValidationError(t("プロジェクトのSoundFont参照が不正です"))
        soundfont_path = Path(saved_soundfont)
        if render.is_soundfont_file(soundfont_path):
            candidate.soundfont_override = soundfont_path
        else:
            warnings.append(t("保存されたSoundFontが見つからないため、既定を使用します。"))
        return warnings
