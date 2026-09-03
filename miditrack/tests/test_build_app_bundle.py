"""アプリバンドルのInfo.plist宣言を副作用なしで検証する。"""

from __future__ import annotations

import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path

from miditrack import convert
from miditrack.web import ALLOWED_MIDI_EXTENSIONS, PROJECT_EXTENSION


class TestBuildAppBundlePlist(unittest.TestCase):
    """Finder関連付けのLaunchServices宣言を固定する。"""

    def setUp(self) -> None:
        self.repository_root = Path(__file__).resolve().parents[2]
        script = (self.repository_root / "scripts/build_app_bundle.sh").read_text(encoding="utf-8")
        heredoc = script.split("<<PLIST", 1)[1].split("\nPLIST", 1)[0]
        # ヒアドキュメント開始行の改行は実際の出力には含まれないため、抽出時だけ落とす。
        self.plist_text = heredoc.lstrip().replace("$version", "0.0.0-test")
        self.plist = plistlib.loads(self.plist_text.encode("utf-8"))

    def test_generated_plist_is_valid(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".plist") as file:
            file.write(self.plist_text.encode("utf-8"))
            file.flush()
            result = subprocess.run(["plutil", "-lint", file.name], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_project_is_owned_but_other_file_types_are_alternate(self) -> None:
        document_types = self.plist["CFBundleDocumentTypes"]
        project_type = next(item for item in document_types if item["CFBundleTypeName"] == "miditrack Project")
        self.assertEqual(project_type["CFBundleTypeRole"], "Editor")
        self.assertEqual(project_type["LSHandlerRank"], "Owner")
        for document_type in document_types:
            if document_type is not project_type:
                self.assertEqual(document_type["LSHandlerRank"], "Alternate")

    def test_all_supported_extensions_are_declared(self) -> None:
        declared_extensions = {PROJECT_EXTENSION.removeprefix(".")}
        for declaration in self.plist["UTImportedTypeDeclarations"]:
            declared_extensions.update(declaration["UTTypeTagSpecification"]["public.filename-extension"])
        declared_extensions.update({"mid", "midi", "zip"})
        expected_extensions = {
            *(extension.removeprefix(".") for extension in ALLOWED_MIDI_EXTENSIONS),
            PROJECT_EXTENSION.removeprefix("."),
            *(extension.removeprefix(".") for fmt in convert.SOURCE_FORMATS for extension in fmt.extensions),
            "zip",
        }
        self.assertTrue(expected_extensions.issubset(declared_extensions))
        self.assertNotIn("$", self.plist_text)

    def test_signs_only_the_bundled_node_with_the_jit_entitlement(self) -> None:
        entitlements_path = self.repository_root / "scripts/entitlements-node.plist"
        entitlements = plistlib.loads(entitlements_path.read_bytes())
        self.assertEqual(entitlements, {"com.apple.security.cs.allow-jit": True})
        bundle_script = (self.repository_root / "scripts/build_app_bundle.sh").read_text(encoding="utf-8")
        self.assertIn('node_entitlements="$script_dir/entitlements-node.plist"', bundle_script)
        self.assertIn('"$candidate" == "$bundle_contents/Helpers/node"', bundle_script)
        self.assertIn('--entitlements "$node_entitlements"', bundle_script)

    def test_compiles_the_icon_composer_asset_with_actool(self) -> None:
        icon_source = self.repository_root / "images/miditrack.icon"
        splash_source = self.repository_root / "miditrack/src/miditrack/web_assets/miditrack_lead.png"
        documentation_splash = self.repository_root / "images/miditrack_lead.png"
        self.assertTrue(icon_source.is_dir())
        self.assertTrue(splash_source.is_file())
        self.assertEqual(splash_source.read_bytes(), documentation_splash.read_bytes())
        self.assertFalse(
            (self.repository_root / "miditrack/src/miditrack/web_assets/miditrack_icon.png").exists()
        )

        bundle_script = (self.repository_root / "scripts/build_app_bundle.sh").read_text(encoding="utf-8")
        self.assertIn('icon_source="$repo_dir/images/miditrack.icon"', bundle_script)
        self.assertIn("xcrun actool --compile", bundle_script)
        self.assertIn("--app-icon miditrack", bundle_script)
        self.assertIn("--output-partial-info-plist", bundle_script)
        self.assertIn("<key>CFBundleIconName</key><string>miditrack</string>", bundle_script)
        self.assertNotIn("iconutil --convert icns", bundle_script)
        self.assertNotIn("printf 'ic10'", bundle_script)
        self.assertNotIn('rsync -a "$repo_dir/images/"', bundle_script)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
