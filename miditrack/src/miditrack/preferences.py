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
from pathlib import Path
from typing import Any

from .errors import WebValidationError
from .gm import GM_PROGRAM_NAMES

MIN_PROGRAM = 0
MAX_PROGRAM = len(GM_PROGRAM_NAMES) - 1


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
    return {"pinnedPrograms": [], "usageCounts": {}, "selectedSoundfont": None}


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
    return {
        "pinnedPrograms": pinned if isinstance(pinned, list) else [],
        "usageCounts": usage if isinstance(usage, dict) else {},
        "selectedSoundfont": selected_soundfont if isinstance(selected_soundfont, str) else None,
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

    path = preferences_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    return current
