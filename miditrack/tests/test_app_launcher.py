"""miditrack.appが実行するSwiftランチャーを検証する。"""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parents[1]
LAUNCHER_PATH = PROJECT_DIR / "miditrack_app.swift"
SWIFT_TOOLCHAIN_IS_AVAILABLE = (
    subprocess.run(["xcode-select", "-p"], capture_output=True, check=False).returncode == 0
)


@unittest.skipUnless(SWIFT_TOOLCHAIN_IS_AVAILABLE, "Xcode Command Line Toolsが必要です")
class TestSwiftLauncherCompiles(unittest.TestCase):
    """型検査と自己テストを実行する。"""

    def test_typechecks_without_errors(self) -> None:
        environment = os.environ | {"CLANG_MODULE_CACHE_PATH": tempfile.gettempdir() + "/miditrack-clang-cache"}
        result = subprocess.run(
            ["xcrun", "swiftc", "-typecheck", str(LAUNCHER_PATH)],
            capture_output=True,
            text=True,
            env=environment,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_self_test_mode_validates_the_url_parser(self) -> None:
        environment = os.environ | {"CLANG_MODULE_CACHE_PATH": tempfile.gettempdir() + "/miditrack-clang-cache"}
        result = subprocess.run(
            [str(LAUNCHER_PATH), "--self-test"],
            capture_output=True,
            text=True,
            env=environment,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("self-test: OK", result.stdout)


class TestSwiftLauncherContract(unittest.TestCase):
    """アプリ内リソース、起動順、WebKit統合の不変条件を固定する。"""

    def setUp(self) -> None:
        self.source = LAUNCHER_PATH.read_text(encoding="utf-8")

    def test_resolves_all_runtime_assets_from_the_application_bundle(self) -> None:
        self.assertIn("Bundle.main.resourceURL", self.source)
        self.assertIn("runtime/backend/miditrack-backend", self.source)
        self.assertIn("Contents/Helpers/node", self.source)
        self.assertIn("Contents/Helpers/spc2midi", self.source)
        self.assertNotIn("#filePath", self.source)

    def test_passes_the_bundle_paths_to_the_backend(self) -> None:
        for name in (
            "MIDITRACK_RESOURCE_ROOT",
            "MIDITRACK_NODE_BIN",
            "MIDI2WAV_BIN",
            "NSF2MIDI_BIN",
            "SPC2MIDI_BIN",
            "VGM2MIDI_STEMS_HELPER",
        ):
            self.assertIn(name, self.source)

    def test_rebuilds_the_path_with_homebrew(self) -> None:
        self.assertIn("/opt/homebrew/bin", self.source)

    def test_starts_the_backend_without_a_browser_or_weakened_authentication(self) -> None:
        self.assertIn('"--no-browser"', self.source)
        self.assertNotIn("--no-token", self.source)
        self.assertNotIn("--port", self.source)

    def test_shows_the_main_window_with_a_splash_overlay_before_starting_the_backend(self) -> None:
        # スプラッシュは独立ウィンドウではなく、起動直後から表示されている
        # メインウィンドウに重ねるオーバーレイビュー（makeSplashOverlayView）
        # として実装されている。WKWebViewが自分のウィンドウが一度も画面に
        # 出ていない間は描画を後回しにすることがあるため、メインウィンドウ
        # 自体はバックエンド起動より前に表示しておく必要がある。
        main_window_shown_index = self.source.index("mainWindow.makeKeyAndOrderFront")
        backend_start_index = self.source.index("controller.start(")
        self.assertLess(main_window_shown_index, backend_start_index)
        self.assertIn("makeSplashOverlayView", self.source)
        self.assertIn("miditrack_lead.png", self.source)
        self.assertIn('"Starting…"', self.source)

    def test_waits_for_both_the_backend_and_one_second_before_removing_the_splash_overlay(self) -> None:
        self.assertIn("splashStartedAt", self.source)
        self.assertIn("max(0, 1 - elapsed)", self.source)
        self.assertIn("revealMainContent", self.source)
        self.assertIn("overlay.removeFromSuperview()", self.source)

    def test_preserves_the_native_webkit_integration(self) -> None:
        for required_symbol in (
            "miditrack Web UI: ",
            "applicationShouldTerminateAfterLastWindowClosed",
            "process.interrupt()",
            "runOpenPanelWith",
            "runJavaScriptConfirmPanelWithMessage",
            "WKDownloadDelegate",
            "installMainMenu",
            "NSSavePanel",
            "window.__miditrackNative = true",
            "WKUserScript",
        ):
            self.assertIn(required_symbol, self.source)

    def test_keeps_the_file_and_settings_menu(self) -> None:
        for required_symbol in (
            "ファイルを開く…",
            "#open-dialog-button",
            "#download-button",
            "#download-wav-button",
            "#save-project-button",
            "設定…",
            "#settings-open",
        ):
            self.assertIn(required_symbol, self.source)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
