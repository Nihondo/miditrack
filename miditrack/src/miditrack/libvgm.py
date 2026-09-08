"""VGM MIDIトラックとlibvgm物理チャンネルの対応・選択レンダリング。"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from .chip_metadata import load_sidecar_payload, read_uint, validate_grouped_sources
from .errors import RenderError, WebValidationError
from .i18n import t
from .tooling import has_wave_audio, is_executable_file, resolve_resource_root

RENDER_TIMEOUT_SECONDS = 300


DEFAULT_HELPER = resolve_resource_root(__file__) / "vgm2midi" / "native" / "bin" / "vgm2midi_stems"


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
    # vgm2midiが変換中に検出した注意事項（例: OPN Ch3 Specialのユニゾン検出）。
    # ユーザー向けの警告表示にのみ使う、変換結果には影響しない付随情報。
    warnings: list[str] = field(default_factory=list)

    def group_indices(self, group_id: str) -> set[int]:
        """同じ物理チャンネルを共有するMIDIトラック番号を返す。"""
        return {index for index, target in self.targets.items() if target.group_id == group_id}


def metadata_path_for(output_path: Path) -> Path:
    """変換先MIDIからlibvgmトラックsidecarの固定パスを導出する。"""
    return output_path.with_name(output_path.stem + ".libvgm.json")


def _read_uint(value: Any, label: str, maximum: int = 0xFFFFFFFF) -> int:
    return read_uint(
        value,
        label,
        maximum,
        lambda invalid_label: t("libvgmメタデータの{label}が不正です", label=invalid_label),
    )


def load_metadata(path: Path, track_count: int) -> LibvgmMetadata | None:
    """sidecarを検証して読む。存在しない場合は後方互換のためNoneを返す。"""
    payload = load_sidecar_payload(
        path,
        read_error=lambda error: t("libvgmトラック情報を読み込めません: {error}", error=error),
        unsupported_message=lambda: t("未対応のlibvgmトラック情報です"),
    )
    if payload is None:
        return None
    sample_count = _read_uint(payload.get("sampleCount"), "sampleCount")
    if sample_count == 0 or not isinstance(payload.get("tracks"), list):
        raise WebValidationError(t("libvgmトラック情報の内容が不正です"))

    targets: dict[int, LibvgmTarget] = {}
    for entry in payload["tracks"]:
        if not isinstance(entry, dict) or entry.get("libvgm") is None:
            continue
        raw = entry["libvgm"]
        if not isinstance(raw, dict):
            raise WebValidationError(t("libvgmトラック選択先が不正です"))
        index = _read_uint(entry.get("trackIndex"), "trackIndex", track_count - 1)
        group_id = raw.get("groupId")
        if not isinstance(group_id, str) or not group_id:
            raise WebValidationError(t("libvgmトラックgroupIdが不正です"))
        targets[index] = LibvgmTarget(
            device_type=_read_uint(raw.get("deviceType"), "deviceType", 0xFF),
            instance=_read_uint(raw.get("instance"), "instance", 0xFFFF),
            main_mask=_read_uint(raw.get("mainMask"), "mainMask"),
            linked_mask=_read_uint(raw.get("linkedMask"), "linkedMask"),
            group_id=group_id,
            suggested=raw.get("suggestedForHardwareMix") is True,
        )
    raw_warnings = payload.get("warnings")
    warnings = (
        [warning for warning in raw_warnings if isinstance(warning, str)]
        if isinstance(raw_warnings, list)
        else []
    )
    return LibvgmMetadata(sample_count=sample_count, targets=targets, warnings=warnings)


def validate_sources(
    metadata: LibvgmMetadata | None, raw_sources: dict[int, str]
) -> dict[int, str]:
    """音源選択を検証し、共有物理チャンネル単位へ展開して返す。

    トラック音源の値は"soundfont"/"game"で統一する（SPC・NSFの原曲音源と同じ
    語彙）。libvgmによる実機レンダリングという実装の違いは"game"という値の
    奥に隠れる。
    """
    return validate_grouped_sources(
        metadata,
        raw_sources,
        unknown_source_message=lambda source: t("未知のトラック音源です: {source}", source=source),
        unmapped_game_message=lambda index: t("トラック{track_index}は原曲の音源へ対応付けできません", track_index=index),
    )


def resolve_helper() -> Path:
    """環境変数またはリポジトリ同梱のlibvgm helperを解決する。"""
    configured = os.environ.get("VGM2MIDI_STEMS_HELPER")
    helper = Path(configured) if configured else DEFAULT_HELPER
    if not is_executable_file(helper):
        raise RenderError(
            "libvgm helperが見つかりません。リポジトリ同梱の"
            "vgm2midi/native/bin/vgm2midi_stemsを復元するか、"
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
    if not has_wave_audio(output_path):
        raise RenderError("libvgmが有効なWAVを生成しませんでした")
