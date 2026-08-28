"""MIDIトラックとNESチャンネルの対応・選択レンダリング（libvgm.pyのNSF版）。

libvgm.pyがVGM+libvgm物理チャンネルに対して持つ役割を、NSF+nsf2midi自身の
チップエミュレーションに対して持つ薄いモジュール。NESには複数のMIDIトラックが
1つの物理チャンネルを共有するケース（AY/SSGやHuC6280のtone/noise共有のような
もの）が存在しないため、libvgm.pyのdevice_type/instance/main_mask/linked_maskの
ようなビットマスク表現は不要で、代わりにnsf2midi自身のチャンネルラベル文字列
（"SQ1"/"NOISE"/"VRC6-SQ1"等、MIDIトラック名と同一）をそのまま選択キーに使う。

レンダリングは外部の別バイナリ（libvgmのnative helper）ではなく、nsf2midi
自身が持つ「選択レンダリングのみ」モード（--chip-render）を呼び出すことで行う。
バイナリ解決はconvert.resolve_converter_argv0()をそのまま再利用するため、
新しい環境変数やビルド手順は不要。
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .errors import RenderError, WebValidationError

# convert.pyはmetadata_path_for()をここからimportするため（nsf_chip_metadata_path_for
# という別名で）、モジュールトップレベルで`from . import convert`すると
# どちらが先に読み込まれてもImportErrorになりうる（部分初期化されたモジュールから
# まだ定義されていない名前を取ろうとするため）。organize_playlists.py/
# youtube_upload.pyが同種の循環importを解決しているのと同じ手法で、convertへの
# 依存はresolve_helper()の関数本体の中でだけ解決する（呼び出し時には両モジュール
# とも完全に初期化済み）。

RENDER_TIMEOUT_SECONDS = 300


@dataclass(frozen=True)
class NsfChipTarget:
    """1つのMIDIトラックに対応するNESチャンネル選択。"""

    channel: str  # nsf2midiのChannelInfo.labelと同一（例: "NOISE"）
    group_id: str
    suggested: bool


@dataclass(frozen=True)
class NsfChipMetadata:
    """NSF全体のサンプル数と、MIDIトラック番号ごとのNESチャンネル対応。"""

    sample_count: int
    targets: dict[int, NsfChipTarget]

    def group_indices(self, group_id: str) -> set[int]:
        """同じ物理チャンネルを共有するMIDIトラック番号を返す（NSFでは常に単独）。"""
        return {index for index, target in self.targets.items() if target.group_id == group_id}


def metadata_path_for(output_path: Path) -> Path:
    """変換先MIDIからNESチャンネルsidecarの固定パスを導出する。"""
    return output_path.with_name(output_path.stem + ".nsf-chip.json")


def _read_uint(value: Any, label: str, maximum: int = 0xFFFFFFFF) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= maximum:
        raise WebValidationError(f"NESチャンネルメタデータの{label}が不正です")
    return value


def load_metadata(path: Path, track_count: int) -> NsfChipMetadata | None:
    """sidecarを検証して読む。存在しない場合は後方互換のためNoneを返す。

    （--track-metadataを持たない旧nsf2midiバイナリと接続した場合、このパスは
    決して生成されないため、常にNoneが返って従来の--chip-wavステム経路へ
    フォールバックする。）
    """
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise WebValidationError(f"NESチャンネル情報を読み込めません: {error}") from error
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise WebValidationError("未対応のNESチャンネル情報です")
    sample_count = _read_uint(payload.get("sampleCount"), "sampleCount")
    if sample_count == 0 or not isinstance(payload.get("tracks"), list):
        raise WebValidationError("NESチャンネル情報の内容が不正です")

    targets: dict[int, NsfChipTarget] = {}
    for entry in payload["tracks"]:
        if not isinstance(entry, dict) or entry.get("chipRender") is None:
            continue
        raw = entry["chipRender"]
        if not isinstance(raw, dict):
            raise WebValidationError("NESチャンネル選択先が不正です")
        index = _read_uint(entry.get("trackIndex"), "trackIndex", track_count - 1)
        channel = raw.get("channel")
        group_id = raw.get("groupId")
        if not isinstance(channel, str) or not channel:
            raise WebValidationError("NESチャンネル名が不正です")
        if not isinstance(group_id, str) or not group_id:
            raise WebValidationError("NESチャンネルgroupIdが不正です")
        targets[index] = NsfChipTarget(
            channel=channel,
            group_id=group_id,
            suggested=raw.get("suggestedForHardwareMix") is True,
        )
    return NsfChipMetadata(sample_count=sample_count, targets=targets)


def validate_sources(
    metadata: NsfChipMetadata | None, raw_sources: dict[int, str]
) -> dict[int, str]:
    """音源選択を検証し、共有物理チャンネル単位へ展開して返す（NSFでは常に単独）。"""
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


def resolve_helper() -> list[str]:
    """nsf2midi本体の起動argvを解決する（convert.resolve_converter_argv0()の再利用）。

    libvgmのような外部native helperを別途持たない: nsf2midi自身が
    --chip-renderモードで「選択レンダリングのみ」を行える。
    """
    from . import convert  # 循環import回避のため関数内でimportする（モジュール先頭コメント参照）

    return convert.resolve_converter_argv0(convert.format_by_key("nsf"))


def render_selection(
    source_path: Path,
    output_path: Path,
    sample_count: int,
    targets: Iterable[NsfChipTarget],
    track: int,
) -> None:
    """選択されたNESチャンネルを1本のWAVへ描画する。

    trackは変換時に使ったnsf2midiの-t/--track（曲番号）。選択レンダリングは
    元のNSFファイルを毎回読み直すため、変換時と同じ曲を指定し直す必要がある。
    """
    channels = sorted({target.channel for target in targets})
    if not channels:
        raise RenderError("実機音で描画するトラックが選択されていません")
    command = [
        *resolve_helper(),
        "--chip-render",
        ",".join(channels),
        "--track",
        str(track),
        "--sample-count",
        str(sample_count),
        str(source_path),
        str(output_path),
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
        raise RenderError(f"nsf2midiの実機音レンダリングを開始できません: {error}") from error
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RenderError(f"nsf2midiの実機音レンダリングに失敗しました: {detail}")
    if not output_path.exists() or output_path.stat().st_size <= 44:
        raise RenderError("nsf2midiが有効なWAVを生成しませんでした")
