"""リポジトリ直下の初回セットアップスクリプトを検証する。"""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path


class TestInstallScript(unittest.TestCase):
    """install.shの副作用なしで確認できる契約を検証する。"""

    def test_shows_help_without_installing_dependencies(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        result = subprocess.run(
            ["bash", str(repository_root / "install.sh"), "--help"],
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0)
        self.assertIn("Homebrew", result.stdout)
        self.assertIn("soundfonts/", result.stdout)
        self.assertNotIn("--soundfont", result.stdout)

    def test_creates_the_expected_homebrew_command_link(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        installer = (repository_root / "install.sh").read_text(encoding="utf-8")

        self.assertIn('COMMAND_LINK="/opt/homebrew/bin/miditrack"', installer)
        self.assertIn('ln -s "$LAUNCHER_PATH" "$COMMAND_LINK"', installer)

    def test_continues_after_an_individual_brew_formula_fails(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        installer = (repository_root / "install.sh").read_text(encoding="utf-8")

        self.assertIn('if ! brew install "$formula_name"; then', installer)
        self.assertIn('command -v ffmpeg', installer)

    def test_colours_entire_status_lines_only_for_a_terminal(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        installer = (repository_root / "install.sh").read_text(encoding="utf-8")

        self.assertIn('if [[ -t 1 ]]; then', installer)
        self.assertIn("C_CYAN='\\033[36m'", installer)
        self.assertIn("info_line()", installer)
        self.assertIn(
            "printf '%b▶ %s%b\\n' \"$C_CYAN\" \"$*\" \"$C_RESET\"",
            installer,
        )
        self.assertIn("success_line()", installer)
        self.assertIn(
            "printf '%b✓ %s%b\\n' \"$C_CYAN\" \"$*\" \"$C_RESET\"",
            installer,
        )
        self.assertNotIn("printf '%b▶%b %s\\n'", installer)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
