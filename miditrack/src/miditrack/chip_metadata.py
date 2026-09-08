"""VGM/NSFのグループ化されたチップsidecarに共通する検証。"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol, TypeVar

from .errors import WebValidationError


class GroupedChipTarget(Protocol):
    """同一物理チャンネルに属するトラック選択先。"""

    group_id: str


class GroupedChipMetadata(Protocol):
    """トラック番号と物理チャンネル選択先の対応。"""

    targets: dict[int, GroupedChipTarget]

    def group_indices(self, group_id: str) -> set[int]:
        """同じ物理チャンネルを共有するトラック番号を返す。"""


MetadataType = TypeVar("MetadataType", bound=GroupedChipMetadata)


def read_uint(
    value: Any,
    label: str,
    maximum: int,
    invalid_message: Callable[[str], str],
) -> int:
    """sidecarの符号なし整数を検証し、既存のローカライズ文言で失敗させる。"""
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= maximum:
        raise WebValidationError(invalid_message(label))
    return value


def load_sidecar_payload(
    path: Path,
    *,
    read_error: Callable[[Exception], str],
    unsupported_message: Callable[[], str],
) -> dict[str, Any] | None:
    """version 1のsidecarオブジェクトを読み、未作成時はNoneを返す。"""
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise WebValidationError(read_error(error)) from error
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise WebValidationError(unsupported_message())
    return payload


def validate_grouped_sources(
    metadata: MetadataType | None,
    raw_sources: dict[int, str],
    *,
    unknown_source_message: Callable[[str], str],
    unmapped_game_message: Callable[[int], str],
) -> dict[int, str]:
    """音源選択を検証し、物理チャンネル共有グループへ展開する。"""
    validated_sources: dict[int, str] = {}
    for track_index, source in raw_sources.items():
        if source not in {"soundfont", "game"}:
            raise WebValidationError(unknown_source_message(source))
        target = metadata.targets.get(track_index) if metadata else None
        if target is None:
            if source == "game":
                raise WebValidationError(unmapped_game_message(track_index))
            validated_sources[track_index] = source
            continue
        for related_index in metadata.group_indices(target.group_id):
            validated_sources[related_index] = source
    return validated_sources
