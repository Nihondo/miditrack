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
from typing import Any, Callable

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
THEME_MODES = frozenset({"system", "light", "dark"})
PIANOROLL_HEIGHTS = frozenset({"compact", "standard", "tall"})
PIANOROLL_GRID_DIVISIONS = frozenset({4, 8, 16})
TRACK_COLOR_PALETTES = frozenset({"rainbow", "vivid", "muted", "accessible"})
HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


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
        "appTheme": "system",
        "pianorollHeight": "standard",
        "showPianorollGrid": True,
        "pianorollGridDivisions": 8,
        "pianorollBackgroundColor": None,
        "pianorollGridColor": None,
        "trackColorPalette": "rainbow",
        "hideEmptyTracks": True,
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
    フィールドごとの検証は_FIELD_VALIDATORSに委ね、検証を通らない値は
    黙ってその項目だけ既定値に差し戻す（ファイル全体を捨てない）。
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
    result: dict[str, Any] = {}
    for field, default in _empty_preferences().items():
        try:
            result[field] = _FIELD_VALIDATORS[field](data.get(field))
        except WebValidationError:
            result[field] = default
    return result


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


def _validate_bool(value: Any, field: str) -> bool:
    """真偽値専用の汎用バリデータ。表示設定のON/OFFフィールドはすべてこれを使う。"""
    if not isinstance(value, bool):
        raise WebValidationError(f"{field}はtrueまたはfalseで指定してください")
    return value


def _validate_choice(value: Any, allowed: frozenset, field: str) -> Any:
    """許容集合のいずれかに一致するかだけを見る汎用バリデータ。

    bool は int のサブクラスで allowed に数値集合を渡すと意図せず一致して
    しまうため、明示的に弾く。
    """
    if isinstance(value, bool) or value not in allowed:
        raise WebValidationError(f"{field}の値が不正です")
    return value


def _validate_hex_color(value: Any, field: str) -> str | None:
    """"#rrggbb"またはnull（=テーマ既定に追従）のみを許可する。

    任意のCSS色文字列を許すとブラウザ側でCanvasのfillStyleへそのまま渡る
    ことになるため、形式をハッシュ+16進6桁に絞る。保存時は小文字へ正規化する。
    """
    if value is None:
        return None
    if not isinstance(value, str) or not HEX_COLOR_RE.fullmatch(value):
        raise WebValidationError(f"{field}は#rrggbb形式の文字列またはnullで指定してください: {value!r}")
    return value.lower()


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


# フィールド名 → バリデータのテーブル。load_preferences()/save_preferences()の
# 両方がここを参照するので、新しい設定フィールドを追加するときの変更箇所は
# このテーブルへの1行追加（と_empty_preferences()の既定値追加）だけで済む。
_FIELD_VALIDATORS: dict[str, Callable[[Any], Any]] = {
    "pinnedPrograms": _validate_pinned_programs,
    "usageCounts": _validate_usage_counts,
    "selectedSoundfont": _validate_selected_soundfont,
    "displayMode": _validate_display_mode,
    "roundedPianorollNotes": lambda value: _validate_bool(value, "roundedPianorollNotes"),
    "outlinedPianorollNotes": lambda value: _validate_bool(value, "outlinedPianorollNotes"),
    "showPianorollKeyboard": lambda value: _validate_bool(value, "showPianorollKeyboard"),
    "appTheme": lambda value: _validate_choice(value, THEME_MODES, "appTheme"),
    "pianorollHeight": lambda value: _validate_choice(value, PIANOROLL_HEIGHTS, "pianorollHeight"),
    "showPianorollGrid": lambda value: _validate_bool(value, "showPianorollGrid"),
    "pianorollGridDivisions": lambda value: _validate_choice(
        value, PIANOROLL_GRID_DIVISIONS, "pianorollGridDivisions"
    ),
    "pianorollBackgroundColor": lambda value: _validate_hex_color(value, "pianorollBackgroundColor"),
    "pianorollGridColor": lambda value: _validate_hex_color(value, "pianorollGridColor"),
    "trackColorPalette": lambda value: _validate_choice(value, TRACK_COLOR_PALETTES, "trackColorPalette"),
    "hideEmptyTracks": lambda value: _validate_bool(value, "hideEmptyTracks"),
    "ensemblePresets": validate_ensemble_presets,
}

# PATCH /api/preferences で更新を許可するフィールド名の集合。selectedSoundfont
# はPOST /api/soundfont経由でのみ更新する運用のため、PATCHの対象からは意図的
# に除外する（従来のweb.py側allowed_fieldsが持っていた挙動をそのまま踏襲）。
PATCHABLE_PREFERENCE_FIELDS = frozenset(_FIELD_VALIDATORS) - {"selectedSoundfont"}


def save_preferences(updates: dict[str, Any]) -> dict[str, Any]:
    """既存の設定へ updates を部分適用し、検証してファイルへ保存した結果を返す。

    PATCH /api/session/transform と同じ「指定されたフィールドだけ更新する」規約。
    """
    current = load_preferences()
    for field, validator in _FIELD_VALIDATORS.items():
        if field in updates:
            current[field] = validator(updates[field])

    path = preferences_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    return current
