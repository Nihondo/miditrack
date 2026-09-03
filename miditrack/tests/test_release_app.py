"""配布版の署名フローを副作用なしで検証する。"""

from __future__ import annotations

import unittest
from pathlib import Path


class TestReleaseAppSigning(unittest.TestCase):
    """V8を使う同梱NodeだけがJITエンタイトルメントを受け取ることを固定する。"""

    def test_signs_bundled_node_with_allow_jit(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        script = (repository_root / "scripts/release_app.sh").read_text(encoding="utf-8")
        self.assertIn('node_entitlements="$script_dir/entitlements-node.plist"', script)
        self.assertIn('"$candidate" == "$app_path/Contents/Helpers/node"', script)
        self.assertIn('--options runtime --entitlements "$node_entitlements" --timestamp', script)
        self.assertIn('--options runtime --timestamp --sign "$identity" "$candidate"', script)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
