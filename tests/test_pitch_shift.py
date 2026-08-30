"""pitch_shift.shの有界並列処理を検証する統合テスト。"""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parents[1]
PITCH_SHIFT_PATH = PROJECT_DIR / "pitch_shift.sh"


def create_executable(path: Path, content: str) -> Path:
    """テスト用コマンドを書き出して実行可能にする。"""
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)
    return path


def run_pitch_shift(
    working_dir: Path, arguments: list[str], bin_dir: Path
) -> subprocess.CompletedProcess[str]:
    """外部コマンドをスタブ化したPATHでpitch_shift.shを実行する。"""
    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    return subprocess.run(
        [str(PITCH_SHIFT_PATH), *arguments],
        cwd=working_dir,
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
    )


class PitchShiftIntegrationTests(unittest.TestCase):
    """速度とピッチの組み合わせを有界並列で生成できることを検証する。"""

    def test_generates_all_combinations_with_configured_jobs(self) -> None:
        """指定ジョブ数でも速度×ピッチの全出力を生成する。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            folder = Path(temp_dir)
            bin_dir = folder / "bin"
            bin_dir.mkdir()
            create_executable(
                bin_dir / "ffmpeg",
                """#!/bin/bash
output=""
for argument in "$@"; do output="$argument"; done
: > "$output"
""",
            )
            create_executable(
                bin_dir / "rubberband",
                """#!/bin/bash
output=""
for argument in "$@"; do output="$argument"; done
: > "$output"
""",
            )
            (folder / "song.m4a").touch()

            result = run_pitch_shift(
                folder,
                ["--jobs", "3", "-s", "1.2", "-s", "0.8", "-p", "-1", "-p", "1", "song.m4a"],
                bin_dir,
            )

            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertIn("同時変換数: 3", result.stdout)
            expected = {
                "song_p-1_x1.2.wav",
                "song_p+1_x1.2.wav",
                "song_p-1_x0.8.wav",
                "song_p+1_x0.8.wav",
            }
            self.assertEqual({path.name for path in folder.glob("song_p*.wav")}, expected)

    def test_rejects_non_positive_job_count(self) -> None:
        """同時変換数0は処理開始前に拒否する。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            folder = Path(temp_dir)
            bin_dir = folder / "bin"
            bin_dir.mkdir()

            result = run_pitch_shift(folder, ["--jobs", "0", "song.m4a"], bin_dir)

        self.assertEqual(result.returncode, 1)
        self.assertIn("1以上の整数", result.stderr)


if __name__ == "__main__":
    unittest.main()
