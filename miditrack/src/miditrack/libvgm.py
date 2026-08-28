"""VGM MIDIトラックとlibvgm物理チャンネルの対応・選択レンダリング。"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .errors import RenderError, WebValidationError

DEFAULT_HELPER = Path("/tmp/vgm2midi-native-build/vgm2midi_stems")
RENDER_TIMEOUT_SECONDS = 300


@dataclass(frozen=True)
class LibvgmTarget:
    """1つ以上のMIDIトラックに対応するlibvgmの物理チャンネル選択。"""

    device_type: int
    instance: int
    main_mask: int
    linked_mask: int
    group_id: str
    suggested: bool


@dataclass(frozen=True)
class LibvgmMetadata:
    """VGM全体の長さと、MIDIトラック番号ごとのlibvgm選択先。"""

    sample_count: int
    targets: dict[int, LibvgmTarget]

    def group_indices(self, group_id: str) -> set[int]:
        """同じ物理チャンネルを共有するMIDIトラック番号を返す。"""
        return {index for index, target in self.targets.items() if target.group_id == group_id}


def metadata_path_for(output_path: Path) -> Path:
    """変換先MIDIからlibvgmトラックsidecarの固定パスを導出する。"""
    return output_path.with_name(output_path.stem + ".libvgm.json")


def _read_uint(value: Any, label: str, maximum: int = 0xFFFFFFFF) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= maximum:
        raise WebValidationError(f"libvgmメタデータの{label}が不正です")
    return value


def load_metadata(path: Path, track_count: int) -> LibvgmMetadata | None:
    """sidecarを検証して読む。存在しない場合は後方互換のためNoneを返す。"""
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise WebValidationError(f"libvgmトラック情報を読み込めません: {error}") from error
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise WebValidationError("未対応のlibvgmトラック情報です")
    sample_count = _read_uint(payload.get("sampleCount"), "sampleCount")
    if sample_count == 0 or not isinstance(payload.get("tracks"), list):
        raise WebValidationError("libvgmトラック情報の内容が不正です")

    targets: dict[int, LibvgmTarget] = {}
    for entry in payload["tracks"]:
        if not isinstance(entry, dict) or entry.get("libvgm") is None:
            continue
        raw = entry["libvgm"]
        if not isinstance(raw, dict):
            raise WebValidationError("libvgmトラック選択先が不正です")
        index = _read_uint(entry.get("trackIndex"), "trackIndex", track_count - 1)
        group_id = raw.get("groupId")
        if not isinstance(group_id, str) or not group_id:
            raise WebValidationError("libvgmトラックgroupIdが不正です")
        targets[index] = LibvgmTarget(
            device_type=_read_uint(raw.get("deviceType"), "deviceType", 0xFF),
            instance=_read_uint(raw.get("instance"), "instance", 0xFFFF),
            main_mask=_read_uint(raw.get("mainMask"), "mainMask"),
            linked_mask=_read_uint(raw.get("linkedMask"), "linkedMask"),
            group_id=group_id,
            suggested=raw.get("suggestedForHardwareMix") is True,
        )
    return LibvgmMetadata(sample_count=sample_count, targets=targets)


def validate_sources(
    metadata: LibvgmMetadata | None, raw_sources: dict[int, str]
) -> dict[int, str]:
    """音源選択を検証し、共有物理チャンネル単位へ展開して返す。

    トラック音源の値は"soundfont"/"game"で統一する（SPC・NSFの原曲音源と同じ
    語彙）。libvgmによる実機レンダリングという実装の違いは"game"という値の
    奥に隠れる。
    """
    validated: dict[int, str] = {}
    for track_index, source in raw_sources.items():
        if source not in {"soundfont", "game"}:
            raise WebValidationError(f"未知のトラック音源です: {source}")
        target = metadata.targets.get(track_index) if metadata else None
        if target is None:
            if source == "game":
                raise WebValidationError(f"トラック{track_index}は原曲の音源へ対応付けできません")
            validated[track_index] = source
            continue
        for related_index in metadata.group_indices(target.group_id):
            validated[related_index] = source
    return validated


def resolve_helper() -> Path:
    """環境変数または既定ビルド先からlibvgm helperを解決する。"""
    configured = os.environ.get("VGM2MIDI_STEMS_HELPER")
    helper = Path(configured) if configured else DEFAULT_HELPER
    if not helper.is_file() or not os.access(helper, os.X_OK):
        raise RenderError(
            "libvgm helperが見つかりません。vgm2midi/scripts/build-native.shを実行するか、"
            f"VGM2MIDI_STEMS_HELPERを設定してください: {helper}"
        )
    return helper


def render_selection(
    source_path: Path,
    output_path: Path,
    sample_count: int,
    targets: Iterable[LibvgmTarget],
) -> None:
    """選択された複数のlibvgm物理チャンネルを1本のWAVへ描画する。"""
    combined: dict[tuple[int, int], tuple[int, int]] = {}
    for target in targets:
        key = (target.device_type, target.instance)
        main_mask, linked_mask = combined.get(key, (0, 0))
        combined[key] = (main_mask | target.main_mask, linked_mask | target.linked_mask)
    if not combined:
        raise RenderError("libvgmで描画するトラックが選択されていません")
    selectors = [
        f"{device_type}:{instance}:{main_mask}:{linked_mask}"
        for (device_type, instance), (main_mask, linked_mask) in sorted(combined.items())
    ]
    command = [
        str(resolve_helper()),
        "--selection",
        str(source_path),
        str(output_path),
        str(sample_count),
        *selectors,
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=RENDER_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RenderError(f"libvgmの描画を開始できません: {error}") from error
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RenderError(f"libvgmの描画に失敗しました: {detail}")
    if not output_path.exists() or output_path.stat().st_size <= 44:
        raise RenderError("libvgmが有効なWAVを生成しませんでした")
