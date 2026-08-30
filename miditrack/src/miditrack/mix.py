"""実機チップノイズWAV（nsf2midi --chip-wav / 将来のvgm2midi --noise-wav）と
fluidsynthのレンダリング結果を ffmpeg で合成する。

render.py が midi2wav.sh を呼ぶのと同じ制約・同じ設計: このリポジトリのパス自体が
スペースと '&' を含むため、subprocess.run() に明示的な argv リストを shell=False で
渡し、シェルを一切介さない。

ffmpeg はこのリポジトリ内に相対パスを持たない（convert.py の node 解決と同様）ため、
解決順は「環境変数（設定済みだが実行不可なら致命的） → PATH」の2段のみ。
"""

from __future__ import annotations

import os
import shutil
import subprocess
from collections.abc import Sequence
from pathlib import Path

from .errors import MixError

MIX_TIMEOUT_SECONDS = 300
_STDERR_TAIL_LINES = 20

# NOISE/DPCM は非線形TNDミックステーブル（nsf2midi/third_party/NotSoFatso/Wave_TND.h）
# 上で単独レンダリングされるため、TRI/DMCが同時に鳴っている実機の音より本来の寄与が
# 大きく出る。両入力に固定のヘッドルームを与え、amix(normalize=0) の純加算で
# クリップしないようにする（0.80+0.55=1.35 が理論上の最悪値で、両方が同時に
# フルスケール付近でなければクリップしない）。
DRY_GAIN = 0.80
STEM_GAIN = 0.55
# ゲーム由来SoundFontレンダリングとGM SoundFontレンダリングを合成する場合のゲイン。
# この2つは「1つの編曲を互いに素なトラック集合へ分割したもの」であり、単純加算すれば
# 分割前の1回レンダリングと同じ音量になる。ステムのような「別枠で足す音」ではないので
# DRY_GAINのようなヘッドルームは取らない。
SPLIT_GAIN = 1.0


def build_filter_complex(gains: Sequence[float], sample_rate: int = 44100) -> str:
    """各入力に個別のゲインを掛けてから単純加算(amix)する-filter_complex文字列を作る。

    normalize=0が必須: amixの既定(normalize=1)は入力数で割ってしまうため、
    入力が2つから3つに増えただけで全体の音量が意図せず変わってしまう。
    dropout_transition=0はamixの既定2秒クロスフェードを無効化する
    （全入力を同じ長さで作る設計だが、念のため明示しておく）。
    """
    if len(gains) < 2:
        raise MixError("ミックスには2つ以上の入力が必要です")
    parts = []
    labels = []
    for index, gain in enumerate(gains):
        label = f"g{index}"
        labels.append(label)
        parts.append(
            f"[{index}:a]aformat=sample_fmts=fltp:sample_rates={sample_rate}:channel_layouts=stereo,"
            f"volume={gain}[{label}]"
        )
    joined_labels = "".join(f"[{label}]" for label in labels)
    parts.append(
        f"{joined_labels}amix=inputs={len(gains)}:duration=longest:"
        "dropout_transition=0:normalize=0[out]"
    )
    return ";".join(parts)


def _is_executable_file(path: str) -> bool:
    p = Path(path)
    return p.is_file() and os.access(p, os.X_OK)


def resolve_ffmpeg_bin() -> str:
    """ffmpeg の実行体を解決する。

    解決順:
      1. FFMPEG_BIN 環境変数 -- 設定されているのに実行できなければ致命的エラー
         （フォールバックしない。render.resolve_midi2wav_bin() と同じ方針）
      2. PATH上の "ffmpeg"

    このリポジトリには ffmpeg 自体のバイナリが存在しないため、
    convert.resolve_converter_argv0() の node 解決と同様、リポジトリ相対パスの段は無い。
    """
    env_bin = os.environ.get("FFMPEG_BIN")
    if env_bin:
        if not _is_executable_file(env_bin):
            raise MixError(f"FFMPEG_BIN が実行可能ファイルではありません: {env_bin}")
        return env_bin

    found = shutil.which("ffmpeg")
    if found:
        return found

    raise MixError("ffmpeg が見つかりません。FFMPEG_BIN 環境変数か PATH を確認してください")


def mix_wav(
    inputs: Sequence[tuple[Path, float]],
    out_wav: Path,
    *,
    sample_rate: int = 44100,
) -> None:
    """(WAVパス, ゲイン) の列を単純加算して out_wav に書き出す。失敗時は MixError。

    2入力（fluidsynthのレンダリング結果 + 実機チップノイズステム）だけでなく、
    ゲーム由来SoundFontレンダリング + GM SoundFontレンダリングの2入力、
    将来的な3入力目（例: chipNoiseステムとの併用）にも対応する。
    """
    if len(inputs) < 2:
        raise MixError("ミックスには2つ以上の入力が必要です")

    bin_path = resolve_ffmpeg_bin()
    filter_complex = build_filter_complex(
        [gain for _path, gain in inputs], sample_rate=sample_rate
    )

    argv = [bin_path, "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    for path, _gain in inputs:
        argv += ["-i", str(path)]
    argv += [
        "-filter_complex",
        filter_complex,
        "-map",
        "[out]",
        "-c:a",
        "pcm_s16le",
        "-ar",
        str(sample_rate),
        "-ac",
        "2",
        str(out_wav),
    ]

    try:
        result = subprocess.run(
            argv,
            shell=False,
            capture_output=True,
            text=True,
            timeout=MIX_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as error:
        raise MixError(
            f"ffmpeg が見つかりません（{bin_path}）。FFMPEG_BIN 環境変数か PATH を確認してください"
        ) from error
    except subprocess.TimeoutExpired as error:
        raise MixError(f"ffmpeg のミックスが {MIX_TIMEOUT_SECONDS} 秒でタイムアウトしました") from error

    if result.returncode != 0:
        stderr_lines = result.stderr.strip().splitlines()
        tail = "\n".join(stderr_lines[-_STDERR_TAIL_LINES:])
        raise MixError(f"ffmpeg の実行に失敗しました（exit={result.returncode}）:\n{tail}")

    if not out_wav.exists() or out_wav.stat().st_size <= 44:
        raise MixError("ミックス結果のWAV書き出しに失敗しました（出力が空です）")
