"""miditrack.appが実行するSwiftランチャー（miditrack_app.swift）を検証する。

実際のGUI（NSApplication.run()）は起動しない。型検査と--self-testモードで
純粋関数の正しさを確認し、それ以外はソースコード文字列に対する契約テストで
設計上の不変条件（トークン維持・自動ポート・バックエンド起動タイミングなど）
を固定する。
"""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
LAUNCHER_PATH = PROJECT_DIR / "miditrack_app.swift"

SWIFT_TOOLCHAIN_IS_AVAILABLE = (
    subprocess.run(["xcode-select", "-p"], capture_output=True, check=False).returncode == 0
)


@unittest.skipUnless(SWIFT_TOOLCHAIN_IS_AVAILABLE, "Xcode Command Line Toolsが必要です")
class TestSwiftLauncherCompiles(unittest.TestCase):
    """実際にコンパイル・実行して検証する（bash -n相当の軽量チェック＋自己テスト）。"""

    def test_typechecks_without_errors(self) -> None:
        result = subprocess.run(
            ["xcrun", "swiftc", "-typecheck", str(LAUNCHER_PATH)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_self_test_mode_validates_the_url_parser(self) -> None:
        result = subprocess.run(
            [str(LAUNCHER_PATH), "--self-test"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("self-test: OK", result.stdout)


class TestSwiftLauncherContract(unittest.TestCase):
    """ソースコードを文字列として読み、設計上の不変条件を固定する契約テスト。

    bashスタブは廃止された（Contents/MacOS/miditrackはリポジトリ内の
    miditrack_app.swiftへの直接のシンボリックリンク）。バックエンド起動・
    PATH再構築・CLIオプションの選択はすべてこのファイルの責務になった。
    """

    def setUp(self) -> None:
        self.source = LAUNCHER_PATH.read_text(encoding="utf-8")

    def test_resolves_the_backend_script_relative_to_itself(self) -> None:
        self.assertIn('packageDirectoryURL.appendingPathComponent("miditrack.sh")', self.source)

    def test_rebuilds_the_path_with_homebrew(self) -> None:
        # launchd既定PATHには/opt/homebrew/binが含まれない
        # （Finder/Dock起動プロセスの既知の制約）。無いとレンダリングだけ
        # 全部失敗する。
        self.assertIn("/opt/homebrew/bin", self.source)

    def test_starts_the_backend_without_a_browser(self) -> None:
        self.assertIn('"--no-browser"', self.source)

    def test_never_disables_token_authentication(self) -> None:
        self.assertNotIn("--no-token", self.source)

    def test_never_pins_the_port(self) -> None:
        self.assertNotIn("--port", self.source)

    def test_starts_the_backend_only_after_the_window_is_shown(self) -> None:
        # 真因はコンパイル済みバイナリ化（execve対象をDropbox外へ出すこと）で
        # 解消したが、この起動順序は追加の安全策として残している。
        # makeKeyAndOrderFront(ウィンドウ表示)がbackend.start()より先に
        # ソース上で出現することを固定する。
        window_shown_index = self.source.index("window.makeKeyAndOrderFront")
        backend_start_index = self.source.index("controller.start(")
        self.assertLess(window_shown_index, backend_start_index)

    def test_parses_the_run_server_startup_line(self) -> None:
        self.assertIn("miditrack Web UI: ", self.source)

    def test_quits_when_the_last_window_closes(self) -> None:
        self.assertIn("applicationShouldTerminateAfterLastWindowClosed", self.source)

    def test_stops_the_backend_with_sigint(self) -> None:
        self.assertIn("process.interrupt()", self.source)

    def test_implements_the_webkit_gaps(self) -> None:
        # 素のWKWebViewでは無言で動かなくなる4つの機能。
        self.assertIn("runOpenPanelWith", self.source)
        self.assertIn("runJavaScriptConfirmPanelWithMessage", self.source)
        self.assertIn("WKDownloadDelegate", self.source)
        self.assertIn("installMainMenu", self.source)

    def test_downloads_prompt_for_a_save_location(self) -> None:
        self.assertIn("NSSavePanel", self.source)

    def test_uses_filepath_not_command_line_arguments_zero(self) -> None:
        # CommandLine.arguments[0]はstdin実行時に"-"になり得るため信用しない
        # （実機で確認済み）。#filePathを自己位置解決に使う。
        self.assertIn("#filePath", self.source)

    def test_injects_the_native_app_flag(self) -> None:
        # app.js側のisNativeApp判定はWKUserScript（atDocumentStart）で注入
        # されるwindow.__miditrackNativeを読む。CSP（script-src 'self'）の
        # 影響を受けない同期注入であることが前提。
        self.assertIn("window.__miditrackNative = true", self.source)
        self.assertIn("WKUserScript", self.source)

    def test_has_a_file_menu_with_open_and_save(self) -> None:
        # 保存メニューはサブメニュー化せず「ファイル」直下にフラットに並べる
        # （ユーザー要望により、当初のサブメニュー案から変更）。
        self.assertIn("ファイルを開く…", self.source)
        self.assertIn("#open-dialog-button", self.source)
        self.assertIn("#download-button", self.source)
        self.assertIn("#download-wav-button", self.source)
        self.assertIn("#save-project-button", self.source)
        self.assertNotIn('NSMenu(title: "保存")', self.source)

    def test_has_a_settings_menu_item(self) -> None:
        self.assertIn("設定…", self.source)
        self.assertIn("#settings-open", self.source)

    def test_menu_actions_target_the_app_delegate(self) -> None:
        # 保存メニュー項目は常に有効にする設計のため、targetをAppDelegate
        # 自身（NSObject直系・NSResponderではない）へ明示指定し、AppKitの
        # 自動バリデーション対象から外している（addTargetedMenuItem内で
        # 一括設定）。
        self.assertIn("item.target = target", self.source)
        self.assertGreaterEqual(self.source.count("addTargetedMenuItem("), 5)

    def test_menu_items_have_sf_symbols_icons(self) -> None:
        # 追加したメニュー項目（開く・設定・保存3種）にはSF Symbolsアイコンを
        # つける。
        self.assertIn("NSImage(systemSymbolName:", self.source)
        for symbol_name in ("folder", "gearshape", "pianokeys", "waveform", "doc.zipper"):
            self.assertIn(f'symbolName: "{symbol_name}"', self.source)

    def test_resolves_symlinks_defensively(self) -> None:
        # install.shはこのファイルをswiftcでコンパイルしたバイナリを
        # $HOME/Applications配下に直接置く（シンボリックリンクではない —
        # execve対象自体がDropbox配下にあるとTCCに無条件拒否されるため。
        # miditrack/CLAUDE.md参照）。.resolvingSymlinksInPath()はそれでも
        # 安全側の保険として残す：コンパイル時に#filePathへ埋め込まれる
        # ソースパスが万一シンボリックリンクを経由していても、正しく実パス
        # へ解決される。
        self.assertIn(".resolvingSymlinksInPath()", self.source)


if __name__ == "__main__":
    unittest.main()
