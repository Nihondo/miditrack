"""WebSessionの編集操作を提供するサービス。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import midi, preferences, render
from .errors import WebValidationError
from .gm import DEFAULT_GM_PROGRAM
from .i18n import t
from .web_session import (
    WebSession,
    sanitize_stem,
    session_payload,
    set_track_source,
    soundfont_payload,
    validate_track_sources,
)


class SessionService:
    """HTTP入力を検証し、セッション編集を原子的に反映する。"""

    def __init__(self, session: WebSession, default_soundfont: Path | None) -> None:
        self._session = session
        self._default_soundfont = default_soundfont

    def clear(self) -> dict[str, bool]:
        """セッションを破棄して成功応答を返す。"""
        self._session.clear()
        return {"ok": True}

    def set_soundfont(self, raw_path: Any) -> dict[str, Any]:
        """選択SoundFontを検証・永続化し、派生レンダーを無効化する。"""
        if raw_path is None:
            self._session.soundfont_override = None
        else:
            if not isinstance(raw_path, str) or not raw_path:
                raise WebValidationError(t("SoundFontのパスが不正です"))
            candidate = Path(raw_path)
            if not render.is_soundfont_file(candidate):
                raise WebValidationError(
                    t("SoundFontファイルが見つかりません: {raw_path}", raw_path=raw_path)
                )
            self._session.soundfont_override = candidate
        self._session.invalidate_render()
        selected = self._session.soundfont_override
        preferences.save_preferences(
            {"selectedSoundfont": str(selected) if selected else None}
        )
        return soundfont_payload(self._session, self._default_soundfont)

    def update_tracks(self, body: dict[str, Any]) -> dict[str, Any]:
        """音色・音量・音源の差分を検証して反映する。"""
        tracks = self._session.require_tracks()
        raw_assignments = body.get("assignments", {})
        raw_volumes = body.get("volumes", {})
        raw_sources = body.get("sources", {})
        self._validate_track_maps(raw_assignments, raw_volumes, raw_sources)
        assignments = self._parse_optional_ints(raw_assignments, "GMプログラム番号")
        volumes = self._parse_optional_ints(raw_volumes, "トラック音量")
        sources = self._parse_sources(raw_sources, {track.index for track in tracks})
        validated_assignments = midi.validate_assignments(tracks, assignments)
        validated_volumes = midi.validate_volumes(tracks, volumes)
        validated_sources = validate_track_sources(self._session, tracks, sources)
        self._apply_tracks(
            tracks,
            assignments,
            volumes,
            sources,
            validated_assignments,
            validated_volumes,
            validated_sources,
        )
        self._session.invalidate_render()
        return session_payload(self._session)

    def update_transform(self, body: dict[str, Any]) -> dict[str, Any]:
        """速度倍率と移調を検証して反映する。"""
        self._session.require_tracks()
        if "speed" not in body and "transpose" not in body:
            raise WebValidationError(t("speedまたはtransposeを指定してください"))
        if "speed" in body:
            self._session.speed_ratio = midi.validate_speed_ratio(body["speed"])
        if "transpose" in body:
            self._session.transpose_semitones = midi.validate_transpose_semitones(
                body["transpose"]
            )
        self._session.invalidate_render()
        return session_payload(self._session)

    def update_filename(self, body: dict[str, Any]) -> dict[str, Any]:
        """ダウンロード用ファイル名を検証して反映する。"""
        self._session.require_tracks()
        if "name" not in body:
            raise WebValidationError(t("nameを指定してください"))
        raw_name = body["name"]
        if not isinstance(raw_name, str):
            raise WebValidationError(t("nameは文字列で指定してください"))
        new_stem = sanitize_stem(raw_name) if raw_name.strip() else ""
        if new_stem != self._session.download_stem:
            self._session.download_stem = new_stem
            self._session.variations_zip_path = None
            self._session.track_export_zip_path = None
        return session_payload(self._session)

    @staticmethod
    def _validate_track_maps(
        assignments: Any, volumes: Any, sources: Any
    ) -> None:
        if not isinstance(assignments, dict):
            raise WebValidationError(t("assignmentsはオブジェクトで指定してください"))
        if not isinstance(volumes, dict):
            raise WebValidationError(t("volumesはオブジェクトで指定してください"))
        if not isinstance(sources, dict):
            raise WebValidationError(t("sourcesはオブジェクトで指定してください"))
        if not assignments and not volumes and not sources:
            raise WebValidationError(t("assignments、volumes、sourcesのいずれかを指定してください"))

    @staticmethod
    def _parse_optional_ints(raw_values: dict[Any, Any], label: str) -> dict[int, int | None]:
        parsed: dict[int, int | None] = {}
        for key, value in raw_values.items():
            try:
                track_index = int(key)
            except (TypeError, ValueError):
                raise WebValidationError(t("トラック番号が不正です: {key}", key=key)) from None
            if value is not None and (not isinstance(value, int) or isinstance(value, bool)):
                if label == "GMプログラム番号":
                    message = t("GMプログラム番号は整数で指定してください: {value}", value=value)
                else:
                    message = t("トラック音量は整数で指定してください: {value}", value=value)
                raise WebValidationError(message)
            parsed[track_index] = value
        return parsed

    @staticmethod
    def _parse_sources(raw_sources: dict[Any, Any], valid_indices: set[int]) -> dict[int, str]:
        parsed: dict[int, str] = {}
        for key, value in raw_sources.items():
            try:
                track_index = int(key)
            except (TypeError, ValueError):
                raise WebValidationError(t("トラック番号が不正です: {key}", key=key)) from None
            if not isinstance(value, str):
                raise WebValidationError(t("トラック音源は文字列で指定してください: {value}", value=value))
            if track_index not in valid_indices:
                raise WebValidationError(t("トラック番号が不正です: {track_index}", track_index=track_index))
            parsed[track_index] = value
        return parsed

    def _apply_tracks(
        self,
        tracks: list[Any],
        assignments: dict[int, int | None],
        volumes: dict[int, int | None],
        sources: dict[int, str],
        validated_assignments: dict[int, int],
        validated_volumes: dict[int, int],
        validated_sources: dict[int, str],
    ) -> None:
        tracks_by_index = {track.index: track for track in tracks}
        for track_index, value in assignments.items():
            if value is None:
                self._session.assignments.pop(track_index, None)
        for track_index, value in volumes.items():
            track = tracks_by_index.get(track_index)
            baseline = track.source_volume_percent if track else midi.DEFAULT_TRACK_VOLUME_PERCENT
            if value is None or value == baseline:
                self._session.volumes.pop(track_index, None)
        self._session.assignments.update(validated_assignments)
        self._session.volumes.update(validated_volumes)
        for track_index, source in validated_sources.items():
            set_track_source(self._session, tracks_by_index[track_index], source)
        self._apply_legacy_source_switch(tracks_by_index, assignments, sources)
        for track_index, source in validated_sources.items():
            track = tracks_by_index[track_index]
            if source == "soundfont" and track.editable:
                self._session.assignments.setdefault(track_index, DEFAULT_GM_PROGRAM)

    def _apply_legacy_source_switch(
        self,
        tracks_by_index: dict[int, Any],
        assignments: dict[int, int | None],
        sources: dict[int, str],
    ) -> None:
        for track_index, program in assignments.items():
            if track_index in sources:
                continue
            track = tracks_by_index[track_index]
            if self._session.game_soundfont_path is not None and track.note_count > 0:
                set_track_source(
                    self._session, track, "soundfont" if program is not None else "game"
                )
