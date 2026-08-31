"""楽器選択の「よく使う」設定（ピン留め・使用回数）をユーザーホーム配下の
JSONファイルに永続化する。

ブラウザの localStorage はオリジン（scheme://host:port）単位で分離されるが、
miditrack の Webサーバーは `make_server("127.0.0.1", 0, ...)` で起動のたびに
ポートを自動割り当てするため、次回起動時には別オリジンになりブラウザ側の
記憶が失われる（miditrack/CLAUDE.md「Why favorite instruments are stored
server-side」参照）。この設定ファイルはプロセスの再起動やポート変更に関係なく
永続化する唯一の置き場所になる。
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from .errors import WebValidationError
from .gm import GM_PROGRAM_NAMES

MIN_PROGRAM = 0
MAX_PROGRAM = len(GM_PROGRAM_NAMES) - 1
MAX_ENSEMBLE_PRESETS = 24
MAX_ENSEMBLE_PRESET_NAME_LENGTH = 48
TRACK_ROLE_IDS = ("melody", "counterMelody", "bass", "accompaniment", "percussion")
PRESET_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
DEFAULT_ENSEMBLE_PRESETS = (
    {
        "id": "game-leads",
        "name": "ゲームリード",
        "programs": {
            "melody": 80,
            "counterMelody": 81,
            "bass": 38,
            "accompaniment": 88,
            "percussion": 24,
        },
    },
    {
        "id": "acoustic",
        "name": "アコースティック",
        "programs": {
            "melody": 24,
            "counterMelody": 40,
            "bass": 32,
            "accompaniment": 0,
            "percussion": 0,
        },
    },
    {
        "id": "jazz-quartet",
        "name": "ジャズカルテット",
        "programs": {
            "melody": 65,
            "counterMelody": 56,
            "bass": 32,
            "accompaniment": 0,
            "percussion": 32,
        },
    },
)
DISPLAY_MODES = frozenset({"normal", "fullscreen"})


def preferences_path() -> Path:
    """設定ファイルの絶対パスを返す（ファイル自体の存在は問わない）。

    MIDITRACK_PREFERENCES_PATH環境変数があればそれを優先する
    （テストが実際のユーザー設定ファイルを汚染しないようにするため）。
    """
    override = os.environ.get("MIDITRACK_PREFERENCES_PATH")
    if override:
        return Path(override)
    return Path.home() / "Library" / "Application Support" / "miditrack" / "preferences.json"


def _empty_preferences() -> dict[str, Any]:
    return {
        "pinnedPrograms": [],
        "usageCounts": {},
        "selectedSoundfont": None,
        "displayMode": "normal",
        "roundedPianorollNotes": True,
        "outlinedPianorollNotes": True,
        "showPianorollKeyboard": True,
        "ensemblePresets": build_default_ensemble_presets(),
    }


def build_default_ensemble_presets() -> list[dict[str, Any]]:
    """編集可能な既定編成プリセットの複製を返す。"""
    return [
        {
            "id": preset["id"],
            "name": preset["name"],
            "programs": dict(preset["programs"]),
        }
        for preset in DEFAULT_ENSEMBLE_PRESETS
    ]


def load_preferences() -> dict[str, Any]:
    """設定ファイルを読み込む。存在しない・壊れている場合は空の設定を返す。

    このファイルは「無くても機能が空の状態で動く」性質の設定なので、
    読み込み失敗をエラーにはせず、常に有効な既定値へフォールバックする。
    """
    path = preferences_path()
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return _empty_preferences()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return _empty_preferences()
    if not isinstance(data, dict):
        return _empty_preferences()
    pinned = data.get("pinnedPrograms")
    usage = data.get("usageCounts")
    selected_soundfont = data.get("selectedSoundfont")
    display_mode = data.get("displayMode")
    rounded_pianoroll_notes = data.get("roundedPianorollNotes")
    outlined_pianoroll_notes = data.get("outlinedPianorollNotes")
    show_pianoroll_keyboard = data.get("showPianorollKeyboard")
    try:
        ensemble_presets = validate_ensemble_presets(data.get("ensemblePresets"))
    except WebValidationError:
        ensemble_presets = build_default_ensemble_presets()
    return {
        "pinnedPrograms": pinned if isinstance(pinned, list) else [],
        "usageCounts": usage if isinstance(usage, dict) else {},
        "selectedSoundfont": selected_soundfont if isinstance(selected_soundfont, str) else None,
        "displayMode": display_mode if display_mode in DISPLAY_MODES else "normal",
        "roundedPianorollNotes": (
            rounded_pianoroll_notes if isinstance(rounded_pianoroll_notes, bool) else True
        ),
        "outlinedPianorollNotes": (
            outlined_pianoroll_notes if isinstance(outlined_pianoroll_notes, bool) else True
        ),
        "showPianorollKeyboard": (
            show_pianoroll_keyboard if isinstance(show_pianoroll_keyboard, bool) else True
        ),
        "ensemblePresets": ensemble_presets,
    }


def _validate_pinned_programs(value: Any) -> list[int]:
    if not isinstance(value, list):
        raise WebValidationError("pinnedProgramsはリストで指定してください")
    validated: list[int] = []
    for program in value:
        if isinstance(program, bool) or not isinstance(program, int):
            raise WebValidationError(f"pinnedProgramsの値は整数で指定してください: {program!r}")
        if not (MIN_PROGRAM <= program <= MAX_PROGRAM):
            raise WebValidationError(
                f"pinnedProgramsの値は{MIN_PROGRAM}〜{MAX_PROGRAM}の範囲で指定してください: {program}"
            )
        if program not in validated:
            validated.append(program)
    return validated


def _validate_usage_counts(value: Any) -> dict[str, int]:
    if not isinstance(value, dict):
        raise WebValidationError("usageCountsはオブジェクトで指定してください")
    validated: dict[str, int] = {}
    for key, count in value.items():
        try:
            program = int(key)
        except (TypeError, ValueError):
            raise WebValidationError(f"usageCountsのキーは整数で指定してください: {key!r}") from None
        if not (MIN_PROGRAM <= program <= MAX_PROGRAM):
            raise WebValidationError(
                f"usageCountsのキーは{MIN_PROGRAM}〜{MAX_PROGRAM}の範囲で指定してください: {program}"
            )
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise WebValidationError(f"usageCountsの値は0以上の整数で指定してください: {count!r}")
        validated[str(program)] = count
    return validated


def _validate_selected_soundfont(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise WebValidationError(f"selectedSoundfontは文字列またはnullで指定してください: {value!r}")
    return value


def _validate_display_mode(value: Any) -> str:
    if value not in DISPLAY_MODES:
        raise WebValidationError("displayModeはnormalまたはfullscreenで指定してください")
    return value


def _validate_rounded_pianoroll_notes(value: Any) -> bool:
    if not isinstance(value, bool):
        raise WebValidationError("roundedPianorollNotesはtrueまたはfalseで指定してください")
    return value


def _validate_outlined_pianoroll_notes(value: Any) -> bool:
    if not isinstance(value, bool):
        raise WebValidationError("outlinedPianorollNotesはtrueまたはfalseで指定してください")
    return value


def _validate_show_pianoroll_keyboard(value: Any) -> bool:
    """ピアノロール鍵盤の表示設定を検証する。"""
    if not isinstance(value, bool):
        raise WebValidationError("showPianorollKeyboardは真偽値で指定してください")
    return value


def validate_ensemble_presets(value: Any) -> list[dict[str, Any]]:
    """編成プリセット一覧を検証し、保存用の正規化済みデータを返す。"""
    if value is None:
        return build_default_ensemble_presets()
    if not isinstance(value, list) or len(value) > MAX_ENSEMBLE_PRESETS:
        raise WebValidationError(f"ensemblePresetsは最大{MAX_ENSEMBLE_PRESETS}件のリストで指定してください")
    validated: list[dict[str, Any]] = []
    preset_ids: set[str] = set()
    preset_names: set[str] = set()
    for preset in value:
        if not isinstance(preset, dict):
            raise WebValidationError("ensemblePresetsの各項目はオブジェクトで指定してください")
        preset_id = preset.get("id")
        name = preset.get("name")
        programs = preset.get("programs")
        if not isinstance(preset_id, str) or not PRESET_ID_RE.fullmatch(preset_id):
            raise WebValidationError("編成プリセットIDが不正です")
        if not isinstance(name, str) or not (name := name.strip()) or len(name) > MAX_ENSEMBLE_PRESET_NAME_LENGTH:
            raise WebValidationError(f"編成プリセット名は1〜{MAX_ENSEMBLE_PRESET_NAME_LENGTH}文字で指定してください")
        if preset_id in preset_ids or name.casefold() in preset_names:
            raise WebValidationError("編成プリセットのIDまたは名前が重複しています")
        if not isinstance(programs, dict) or set(programs) != set(TRACK_ROLE_IDS):
            raise WebValidationError("編成プリセットの役割設定が不正です")
        validated_programs: dict[str, int] = {}
        for role_id in TRACK_ROLE_IDS:
            program = programs[role_id]
            if isinstance(program, bool) or not isinstance(program, int) or not MIN_PROGRAM <= program <= MAX_PROGRAM:
                raise WebValidationError(f"編成プリセットの{role_id}音色が不正です")
            validated_programs[role_id] = program
        preset_ids.add(preset_id)
        preset_names.add(name.casefold())
        validated.append({"id": preset_id, "name": name, "programs": validated_programs})
    return validated


def save_preferences(updates: dict[str, Any]) -> dict[str, Any]:
    """既存の設定へ updates を部分適用し、検証してファイルへ保存した結果を返す。

    PATCH /api/session/transform と同じ「指定されたフィールドだけ更新する」規約。
    """
    current = load_preferences()
    if "pinnedPrograms" in updates:
        current["pinnedPrograms"] = _validate_pinned_programs(updates["pinnedPrograms"])
    if "usageCounts" in updates:
        current["usageCounts"] = _validate_usage_counts(updates["usageCounts"])
    if "selectedSoundfont" in updates:
        current["selectedSoundfont"] = _validate_selected_soundfont(updates["selectedSoundfont"])
    if "displayMode" in updates:
        current["displayMode"] = _validate_display_mode(updates["displayMode"])
    if "roundedPianorollNotes" in updates:
        current["roundedPianorollNotes"] = _validate_rounded_pianoroll_notes(
            updates["roundedPianorollNotes"]
        )
    if "outlinedPianorollNotes" in updates:
        current["outlinedPianorollNotes"] = _validate_outlined_pianoroll_notes(
            updates["outlinedPianorollNotes"]
        )
    if "showPianorollKeyboard" in updates:
        current["showPianorollKeyboard"] = _validate_show_pianoroll_keyboard(
            updates["showPianorollKeyboard"]
        )
    if "ensemblePresets" in updates:
        current["ensemblePresets"] = validate_ensemble_presets(updates["ensemblePresets"])

    path = preferences_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    return current
