"""プロジェクトルートの pitch_shift.sh を安全に呼び出し、レンダリング済みWAVから
速度×ピッチの全組み合わせのWAVを生成する。

render.py と同じ理由（このリポジトリのパス自体がスペースと '&' を含む）で、
シェルを一切介さず subprocess.run() に明示的なargvリストを shell=False で渡す。
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from .errors import PitchShiftError

PITCH_SHIFT_TIMEOUT_SECONDS = 900
_STDERR_TAIL_LINES = 20

# pitch_shift.sh 自身のデフォルト値と一致させる。
DEFAULT_SPEEDS: list[float] = [1.2, 0.8]
DEFAULT_PITCHES: list[float] = [-2, -1, 0, 1, 2]

# 暴走防止のための実用的な上限。デフォルト（2速度 x 5ピッチ = 10ファイル）には
# 余裕を持たせつつ、大量の同時rubberband起動やZIP肥大化を防ぐ。
MAX_SPEED_COUNT = 8
MAX_PITCH_COUNT = 12
MAX_COMBINATION_COUNT = 40
MIN_SPEED = 0.1
MAX_SPEED = 10.0
MIN_PITCH = -48
MAX_PITCH = 48


def _is_executable_file(path: str) -> bool:
    p = Path(path)
    return p.is_file() and os.access(p, os.X_OK)


def resolve_pitch_shift_bin() -> str:
    """pitch_shift.sh の実行体を解決する。

    解決順（render.py の resolve_midi2wav_bin() と同じ規約）:
      1. PITCH_SHIFT_BIN 環境変数 -- 設定されているのに実行できなければ致命的エラー
         （フォールバックしない）
      2. このファイルから見たリポジトリルートの pitch_shift.sh
         （src/miditrack/pitch_shift.py から3階層上がリポジトリルート）
      3. PATH上の "pitch_shift.sh"（subprocessが自前でPATH解決するので、素の
         コマンド名を返す）
    """
    env_bin = os.environ.get("PITCH_SHIFT_BIN")
    if env_bin:
        if not _is_executable_file(env_bin):
            raise PitchShiftError(f"PITCH_SHIFT_BIN が実行可能ファイルではありません: {env_bin}")
        return env_bin

    # src/miditrack/pitch_shift.py -> src/miditrack -> src -> miditrack -> <repo root>
    repo_root = Path(__file__).resolve().parents[3]
    sibling = repo_root / "pitch_shift.sh"
    if _is_executable_file(str(sibling)):
        return str(sibling)

    return "pitch_shift.sh"


def _validate_number_list(
    values: list[float] | None,
    default: list[float],
    *,
    label: str,
    max_count: int,
    minimum: float,
    maximum: float,
) -> list[float]:
    if values is None:
        return list(default)
    if not isinstance(values, list) or len(values) == 0:
        raise PitchShiftError(f"{label}は空でないリストで指定してください")
    if len(values) > max_count:
        raise PitchShiftError(f"{label}は最大{max_count}個までです")
    parsed: list[float] = []
    for value in values:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise PitchShiftError(f"{label}の値は数値で指定してください: {value!r}")
        number = float(value)
        if not (minimum <= number <= maximum):
            raise PitchShiftError(f"{label}の値は{minimum}〜{maximum}の範囲で指定してください: {number}")
        parsed.append(number)
    return parsed


def validate_pitch_shift_options(
    speeds: list[float] | None, pitches: list[float] | None
) -> tuple[list[float], list[float]]:
    """速度・ピッチの指定値を検証し、未指定ならpitch_shift.sh既定値を返す。

    クライアント側の無効化に頼らず、ここで組み合わせ数の上限も含めて再検証する。
    """
    parsed_speeds = _validate_number_list(
        speeds,
        DEFAULT_SPEEDS,
        label="速度倍率",
        max_count=MAX_SPEED_COUNT,
        minimum=MIN_SPEED,
        maximum=MAX_SPEED,
    )
    parsed_pitches = _validate_number_list(
        pitches,
        DEFAULT_PITCHES,
        label="ピッチ",
        max_count=MAX_PITCH_COUNT,
        minimum=MIN_PITCH,
        maximum=MAX_PITCH,
    )
    if len(parsed_speeds) * len(parsed_pitches) > MAX_COMBINATION_COUNT:
        raise PitchShiftError(
            f"速度×ピッチの組み合わせ数が多すぎます（最大{MAX_COMBINATION_COUNT}件）"
        )
    return parsed_speeds, parsed_pitches


def _format_number(value: float) -> str:
    # 整数値は "1" ではなく "1.0"/"-2" のような素直な表記のまま渡す。
    # pitch_shift.sh 側は文字列として -s/-p にそのまま渡すだけなので、
    # 出力ファイル名との対応はここでの見た目に依存しない
    # （run_pitch_shift() は生成された *.wav を実ファイルとして列挙する）。
    if float(value).is_integer():
        return str(int(value))
    return str(value)


def run_pitch_shift(
    wav_path: Path, work_dir: Path, speeds: list[float], pitches: list[float]
) -> list[Path]:
    """wav_path を入力に、speeds×pitches の全組み合わせのWAVを work_dir に生成する。

    pitch_shift.sh は出力をCWD直下に書き出すため、work_dir をcwdに指定して実行する。
    戻り値は生成された各WAVファイルへのパス（入力ファイル自身は含まない）。
    失敗時は PitchShiftError。
    """
    bin_path = resolve_pitch_shift_bin()

    argv = [bin_path]
    for speed in speeds:
        argv += ["-s", _format_number(speed)]
    for pitch in pitches:
        argv += ["-p", _format_number(pitch)]
    argv += [str(wav_path)]

    before = set(work_dir.glob("*.wav"))

    try:
        result = subprocess.run(
            argv,
            shell=False,
            cwd=work_dir,
            capture_output=True,
            text=True,
            timeout=PITCH_SHIFT_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as error:
        raise PitchShiftError(
            f"pitch_shift.sh が見つかりません（{bin_path}）。PITCH_SHIFT_BIN 環境変数か "
            "リポジトリ直下の pitch_shift.sh を確認してください"
        ) from error
    except subprocess.TimeoutExpired as error:
        raise PitchShiftError(
            f"pitch_shift.sh の処理が {PITCH_SHIFT_TIMEOUT_SECONDS} 秒でタイムアウトしました"
        ) from error

    if result.returncode != 0:
        stderr_lines = result.stderr.strip().splitlines()
        tail = "\n".join(stderr_lines[-_STDERR_TAIL_LINES:])
        raise PitchShiftError(f"pitch_shift.sh の実行に失敗しました（exit={result.returncode}）:\n{tail}")

    after = set(work_dir.glob("*.wav"))
    generated = sorted(after - before, key=lambda p: p.name)
    expected_count = len(speeds) * len(pitches)
    if len(generated) != expected_count:
        raise PitchShiftError(
            f"生成されたWAVの数が一致しません（期待: {expected_count}、実際: {len(generated)}）"
        )
    for path in generated:
        if not path.exists() or path.stat().st_size <= 44:
            raise PitchShiftError(f"WAVの書き出しに失敗しました（出力が空です）: {path.name}")
    return generated
