"""ローカル実コーパスをmiditrackのHTTP変換経路で検証する。"""

from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import unittest
import zipfile

from miditrack.web import WebSession, create_app


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS_ROOT = REPOSITORY_ROOT / "testdata" / "real-corpus"
CORPUS_ROOT = Path(os.environ.get("MIDITRACK_REAL_CORPUS_ROOT", DEFAULT_CORPUS_ROOT))
MANIFEST_PATH = REPOSITORY_ROOT / "tests" / "real_corpus_cases.json"
AUTH_HEADERS = {"X-Miditrack-Token": "real-corpus-token"}


def load_cases() -> list[dict[str, object]]:
    """共有マニフェストからmiditrackが扱う実データケースを読む。"""
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))["cases"]


def options_for_case(case: dict[str, object]) -> dict[str, object]:
    """短時間でも変換経路を網羅できる形式ごとの正規オプションを返す。"""
    if case["format"] == "vgm":
        # ループ点を持たない短いVGMへ曲長以上の--durationを渡すと、変換器は
        # 存在しないループを展開しようとして失敗する。既定の実データ長を使う。
        return {}
    if case["format"] == "nsf":
        return {"songIndex": 0, "durationSeconds": 10}
    if case["format"] == "spc":
        return {"songIndex": 0, "loops": 1}
    raise AssertionError(f"unknown real corpus format: {case['format']}")


@unittest.skipUnless(CORPUS_ROOT.is_dir(), "requires git-ignored testdata/real-corpus")
class TestRealCorpusThroughMiditrack(unittest.TestCase):
    """実ファイルをアップロードAPIから変換し、UI向けセッションまで検証する。"""

    def setUp(self) -> None:
        self.app = create_app(token=AUTH_HEADERS["X-Miditrack-Token"], session=WebSession())
        self.app.config["MIDITRACK_ENABLE_BACKGROUND_PREWARM"] = False
        self.client = self.app.test_client()
        self.addCleanup(self.app.config["MIDITRACK_SESSION"].clear)

    def post_source(self, filename: str, content: bytes):
        """実データを通常のmultipart音源アップロードとして送る。"""
        return self.client.post(
            "/api/source",
            headers=AUTH_HEADERS,
            data={"source": (io.BytesIO(content), filename)},
            content_type="multipart/form-data",
        )

    def assert_converted_payload(self, case: dict[str, object], payload: dict[str, object]) -> None:
        """変換済みセッションの形式、実ノート、形式固有sidecar連携を確認する。"""
        self.assertEqual(payload["source"]["format"], case["format"])
        self.assertGreater(payload["trackCount"], 0)
        self.assertGreater(sum(track["noteCount"] for track in payload["tracks"]), 0)
        converted_options = payload["source"]["convertedOptions"]
        for name, value in options_for_case(case).items():
            self.assertEqual(converted_options[name], value)
        if case["format"] in {"vgm", "nsf"}:
            self.assertTrue(any("game" in track["availableSources"] for track in payload["tracks"]))
        if case["format"] == "spc":
            self.assertTrue(payload["hasGameSoundfont"])

    def convert_case(self, case: dict[str, object], filename: str, content: bytes) -> None:
        """アップロード、形式検出、CLI変換、MIDI解析を一続きで検証する。"""
        uploaded = self.post_source(filename, content)
        self.assertEqual(uploaded.status_code, 201, uploaded.get_data(as_text=True))
        self.assertEqual(uploaded.get_json()["source"]["format"], case["format"])
        converted = self.client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps(options_for_case(case)),
        )
        self.assertEqual(converted.status_code, 200, converted.get_data(as_text=True))
        self.assert_converted_payload(case, converted.get_json())

    def test_all_real_cases_convert_through_upload_api(self) -> None:
        """抽出済み全ケースがUIの通常変換経路を通過する。"""
        for case in load_cases():
            with self.subTest(case=case["id"]):
                source_path = CORPUS_ROOT / str(case["destination"])
                content = source_path.read_bytes()
                self.assertEqual(hashlib.sha256(content).hexdigest(), case["sha256"])
                self.convert_case(case, source_path.name, content)

    def test_real_vgm_inside_zip_converts_through_upload_api(self) -> None:
        """実VGMを含むZIPも、通常の展開・選択・変換経路を通過する。"""
        case = next(item for item in load_cases() if item["format"] == "vgm")
        source_path = CORPUS_ROOT / str(case["destination"])
        content = source_path.read_bytes()
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr(source_path.name, content)
        self.convert_case(case, "real-vgm.zip", archive.getvalue())
