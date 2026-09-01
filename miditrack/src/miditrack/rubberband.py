"""rubberband CLIで実音声ステムをMIDI変換後の速度・移調へ同期する。"""

from __future__ import annotations

import subprocess
from pathlib import Path

from .errors import RubberBandError

RUBBERBAND_TIMEOUT_SECONDS = 900
_STDERR_TAIL_LINES = 20


def _build_partial_path(output_path: Path) -> Path:
    """完了前の出力を最終出力と区別する一時パスを返す。"""
    return output_path.with_suffix(".partial.wav")


def _validate_output_file(output_path: Path) -> None:
    """rubberbandが有効なWAV出力を生成したことを確認する。"""
    if not output_path.exists() or output_path.stat().st_size <= 44:
        raise RubberBandError(
            f"rubberbandによるWAVの書き出しに失敗しました: {output_path.name}"
        )


def transform_stem(
    input_path: Path, output_path: Path, speed: float, transpose: int
) -> None:
    """WAVステムを指定した速度・移調へ変換して ``output_path`` に保存する。

    MIDI側の速度倍率に合わせるため、rubberbandのテンポ比には ``1 / speed`` を渡す。
    出力は一時ファイルへ生成してから原子的に置き換え、失敗時に不完全な最終出力を
    残さない。失敗時は ``RubberBandError`` を送出する。
    """
    if not input_path.is_file():
        raise RubberBandError(f"同期するWAVステムが見つかりません: {input_path}")
    if speed <= 0:
        raise RubberBandError(f"速度倍率は0より大きい必要があります: {speed}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    partial_path = _build_partial_path(output_path)
    partial_path.unlink(missing_ok=True)
    argv = [
        "rubberband",
        "-q",
        "-t",
        f"{1 / speed:.6f}",
        "-p",
        str(transpose),
        str(input_path),
        str(partial_path),
    ]

    try:
        try:
            result = subprocess.run(
                argv,
                shell=False,
                capture_output=True,
                text=True,
                timeout=RUBBERBAND_TIMEOUT_SECONDS,
            )
        except FileNotFoundError as error:
            raise RubberBandError(
                "rubberband が見つかりません。rubberband-cliをインストールしてください"
            ) from error
        except subprocess.TimeoutExpired as error:
            raise RubberBandError(
                f"rubberbandの処理が {RUBBERBAND_TIMEOUT_SECONDS} 秒でタイムアウトしました"
            ) from error

        if result.returncode != 0:
            stderr_lines = result.stderr.strip().splitlines()
            tail = "\n".join(stderr_lines[-_STDERR_TAIL_LINES:])
            raise RubberBandError(
                f"rubberbandの実行に失敗しました（exit={result.returncode}）:\n{tail}"
            )

        _validate_output_file(partial_path)
        partial_path.replace(output_path)
    finally:
        partial_path.unlink(missing_ok=True)
