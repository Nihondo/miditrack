"""miditrack.shのsymlink解決と専用venv選択を検証する（note_ext/tests/test_wrapper.py準拠）。"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
WRAPPER_PATH = PROJECT_DIR / "miditrack.sh"


def create_executable(path: Path, content: str) -> Path:
    """テスト用コマンドを書き出して実行可能にする。"""
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)
    return path


class MiditrackWrapperTests(unittest.TestCase):
    """ラッパーが呼出元を保ったまま専用venvを使うことを検証する。"""

    def test_resolves_symlink_and_preserves_working_directory(self) -> None:
        """相対symlink経由でもラッパーと同居するvenvへ全引数を渡す。"""
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            project_dir = root / "miditrack"
            bin_dir = root / "bin"
            working_dir = root / "song"
            capture_path = root / "capture.json"
            for directory in (project_dir, bin_dir, working_dir):
                directory.mkdir(parents=True)
            shutil.copy2(WRAPPER_PATH, project_dir / "miditrack.sh")
            cli_path = project_dir / ".venv" / "bin" / "miditrack"
            cli_path.parent.mkdir(parents=True)
            create_executable(
                cli_path,
                """#!/bin/bash
python3 -c 'import json, os, sys
from pathlib import Path
Path(os.environ["CAPTURE_PATH"]).write_text(json.dumps({
    "cwd": os.getcwd(),
    "virtual_env": os.environ.get("VIRTUAL_ENV"),
    "path": os.environ.get("PATH"),
    "python_no_user_site": os.environ.get("PYTHONNOUSERSITE"),
    "python_home": os.environ.get("PYTHONHOME"),
    "arguments": sys.argv[1:],
}), encoding="utf-8")' "$@"
""",
            )
            command_path = bin_dir / "miditrack"
            command_path.symlink_to(Path("../miditrack/miditrack.sh"))
            environment = os.environ.copy()
            environment["PATH"] = f"{bin_dir}{os.pathsep}{environment['PATH']}"
            environment["CAPTURE_PATH"] = str(capture_path)
            environment["PYTHONHOME"] = "/tmp/wrong-python-home"

            result = subprocess.run(
                ["miditrack", "song.mid", "--no-browser"],
                cwd=working_dir,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            captured = json.loads(capture_path.read_text(encoding="utf-8"))

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(captured["cwd"], str(working_dir.resolve()))
        self.assertEqual(captured["virtual_env"], str((project_dir / ".venv").resolve()))
        self.assertEqual(captured["python_no_user_site"], "1")
        self.assertIsNone(captured["python_home"])
        self.assertEqual(
            captured["path"].split(os.pathsep)[0],
            str(cli_path.parent.resolve()),
        )
        self.assertEqual(captured["arguments"], ["song.mid", "--no-browser"])

    def test_reports_missing_virtual_environment(self) -> None:
        """専用venvがない場合は日本語READMEのセットアップ先を示す。"""
        with tempfile.TemporaryDirectory() as temp_name:
            project_dir = Path(temp_name) / "miditrack"
            project_dir.mkdir()
            shutil.copy2(WRAPPER_PATH, project_dir / "miditrack.sh")

            result = subprocess.run(
                [str(project_dir / "miditrack.sh"), "--help"],
                capture_output=True,
                text=True,
                check=False,
            )

        self.assertEqual(result.returncode, 1)
        self.assertIn(".venv", result.stderr)
        self.assertIn("README_ja.md", result.stderr)


if __name__ == "__main__":
    unittest.main()
