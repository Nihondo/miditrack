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

    def test_creates_the_expected_app_bundle(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        installer = (repository_root / "install.sh").read_text(encoding="utf-8")

        self.assertIn('APP_BUNDLE_DIR="$HOME/Applications/miditrack.app"', installer)
        self.assertIn("validate_app_bundle()", installer)
        self.assertIn("install_app_bundle()", installer)
        self.assertIn("既存のmiditrack.appを上書きしません", installer)
        # 生成物は3ファイルだけなので上書きで冪等にする。$HOME配下のパスを
        # 変数から組み立ててrm -rfする形は変数が空になったときの被害が大きい。
        self.assertNotIn('rm -rf "$APP_BUNDLE_DIR"', installer)

    def test_app_bundle_info_plist_has_required_keys_and_stays_a_dock_app(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        installer = (repository_root / "install.sh").read_text(encoding="utf-8")

        for key in (
            "CFBundlePackageType",
            "CFBundleName",
            "CFBundleIdentifier",
            "CFBundleExecutable",
            "CFBundleIconFile",
            "CFBundleShortVersionString",
            "LSMinimumSystemVersion",
        ):
            self.assertIn(f"<key>{key}</key>", installer)
        self.assertIn("com.nihondo.miditrack", installer)
        # WKWebViewアプリ本体としてDockに常駐する（薄いLauncherではない）。
        self.assertNotIn("<key>LSUIElement</key>", installer)

    def test_app_bundle_executable_is_a_compiled_binary(self) -> None:
        # シバンスクリプトへのシンボリックリンク（試したがexecve()の対象自体が
        # Dropbox配下だと"would require prompt"というTCCログとともに無条件で
        # 拒否されることを実機で確認した）ではなく、miditrack_app.swiftを
        # swiftcでコンパイルしたバイナリを直接$HOME/Applications配下へ置く。
        # コンパイル後にバックエンド（Dropbox配下のminditrack.sh）をexecしても
        # 問題が起きないことも実機で確認済み——問題は「トップレベルの実行可能
        # ファイル自体の所在」であり、その後の子プロセスexecには適用されない。
        repository_root = Path(__file__).resolve().parents[2]
        installer = (repository_root / "install.sh").read_text(encoding="utf-8")

        self.assertIn(
            'xcrun swiftc -O "$APP_LAUNCHER_PATH" -o "$APP_BUNDLE_DIR/Contents/MacOS/miditrack"',
            installer,
        )
        self.assertIn('APP_LAUNCHER_PATH="$PACKAGE_DIR/miditrack_app.swift"', installer)
        self.assertIn('APP_BUNDLE_MARKER_FILE=".installed-by-install-sh"', installer)
        self.assertIn(
            '[[ -f "$APP_BUNDLE_DIR/Contents/$APP_BUNDLE_MARKER_FILE" ]]',
            installer,
        )
        # CFProcessPath/バックエンド先行起動を担っていたbashスタブは廃止した
        # （タイミングではなくexecve対象の所在そのものが原因だったと判明した
        # ため。miditrack/CLAUDE.md参照）。
        self.assertNotIn("export CFProcessPath", installer)
        self.assertNotIn("--backend-pid", installer)
        self.assertNotIn("set -m", installer)
        self.assertNotIn("ln -sf", installer)

    def test_signs_the_bundle_ad_hoc(self) -> None:
        # 未署名バンドルはTCCが安定して識別できず、Dropbox配下（TCC保護対象）
        # への初回アクセスがダイアログ無しでOperation not permittedになることを
        # 実機で確認した。アドホック署名（codesign -s -）で回避する。
        repository_root = Path(__file__).resolve().parents[2]
        installer = (repository_root / "install.sh").read_text(encoding="utf-8")
        self.assertIn("codesign --force --deep --sign -", installer)

    def test_checks_for_xcode_command_line_tools(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        installer = (repository_root / "install.sh").read_text(encoding="utf-8")
        self.assertIn("xcode-select -p", installer)

    def test_app_bundle_icon_generation_covers_all_iconset_sizes(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        installer = (repository_root / "install.sh").read_text(encoding="utf-8")

        self.assertIn("sips -z 1024 1024", installer)
        self.assertIn("iconutil --convert icns", installer)
        for name in (
            "icon_16x16.png",
            "icon_16x16@2x.png",
            "icon_32x32.png",
            "icon_32x32@2x.png",
            "icon_128x128.png",
            "icon_128x128@2x.png",
            "icon_256x256.png",
            "icon_256x256@2x.png",
            "icon_512x512.png",
            "icon_512x512@2x.png",
        ):
            self.assertIn(name, installer)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
