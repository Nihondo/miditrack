"""配布版と同じアプリ成果物を作るインストーラーを検証する。"""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path


class TestInstallScript(unittest.TestCase):
    """install.shの副作用なしで確認できる契約を検証する。"""

    def setUp(self) -> None:
        self.repository_root = Path(__file__).resolve().parents[2]
        self.installer = (self.repository_root / "install.sh").read_text(encoding="utf-8")

    def test_shows_help_without_installing_dependencies(self) -> None:
        result = subprocess.run(
            ["bash", str(self.repository_root / "install.sh"), "--help"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("Homebrew", result.stdout)
        self.assertIn("FluidSynth, ffmpeg,", result.stdout)
        self.assertNotIn("soundfonts/", result.stdout)

    def test_installs_the_external_audio_tools_and_uv_with_homebrew(self) -> None:
        self.assertIn("for formula in fluid-synth ffmpeg rubberband uv; do", self.installer)
        self.assertIn('command -v uv >/dev/null 2>&1 || fail "uvが見つかりません', self.installer)
        self.assertNotIn("brew install python", self.installer)
        self.assertNotIn("brew install node", self.installer)

    def test_builds_the_shared_bundle_at_the_applications_location(self) -> None:
        self.assertIn('app_dir="$HOME/Applications/miditrack.app"', self.installer)
        self.assertIn('"$repository_dir/scripts/build_app_bundle.sh" --output "$app_dir"', self.installer)
        self.assertIn('marker_path="$app_dir/Contents/Resources/.installed-by-install-sh"', self.installer)
        self.assertIn("既存のmiditrack.appを上書きしません", self.installer)

    def test_preserves_an_existing_unrelated_cli_command(self) -> None:
        self.assertIn('command_link="$(brew --prefix)/bin/miditrack"', self.installer)
        self.assertIn('[[ -L "$command_link" && "$(readlink "$command_link")" == "$cli_path" ]]', self.installer)
        self.assertIn('ln -s "$cli_path" "$command_link"', self.installer)
        self.assertNotIn("ln -sf", self.installer)

    def test_documents_the_user_soundfont_location(self) -> None:
        self.assertIn('"$HOME/Library/Audio/Sounds/Banks"', self.installer)
        self.assertIn(".sf2または.sf3", self.installer)

    def test_refreshes_launchservices_after_building_the_app(self) -> None:
        self.assertIn("lsregister=", self.installer)
        self.assertIn('"$lsregister" -f "$app_dir"', self.installer)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
