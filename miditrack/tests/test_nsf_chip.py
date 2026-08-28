"""NESチャンネルsidecarと選択レンダラ（nsf2midi --chip-render）の単体テスト。

test_libvgm.py と対称のテスト構成: sidecarのロード/検証はTestNsfChipMetadata、
選択レンダリングのargv形状はTestNsfChipRenderで確認する。NSFには物理チャンネル
共有（AY/SSGやHuC6280のtone/noise共有のようなもの）が存在しないため、
group_indices()による展開は常に単独トラックに留まることも合わせて確認する。
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from miditrack import nsf_chip
from miditrack.errors import RenderError, WebValidationError


class TestNsfChipMetadata(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "converted.nsf-chip.json"

    def _write(self) -> None:
        self.path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "sampleRate": 44100,
                    "sampleCount": 44100,
                    "tracks": [
                        {
                            "trackIndex": 0,
                            "channel": "SQ1",
                            "chipRender": {
                                "channel": "SQ1",
                                "groupId": "SQ1",
                                "suggestedForHardwareMix": True,
                            },
                        },
                        {
                            "trackIndex": 1,
                            "channel": "NOISE",
                            "chipRender": {
                                "channel": "NOISE",
                                "groupId": "NOISE",
                                "suggestedForHardwareMix": True,
                            },
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )

    def test_loads_and_validates_source_selection(self) -> None:
        self._write()
        metadata = nsf_chip.load_metadata(self.path, 2)
        self.assertIsNotNone(metadata)
        self.assertEqual(metadata.sample_count, 44100)
        self.assertTrue(metadata.targets[0].suggested)
        self.assertEqual(metadata.targets[0].channel, "SQ1")
        # NESには物理チャンネル共有が無いため、グループ展開は常に単独。
        self.assertEqual(
            nsf_chip.validate_sources(metadata, {0: "game", 1: "soundfont"}),
            {0: "game", 1: "soundfont"},
        )

    def test_rejects_out_of_range_track_index(self) -> None:
        self._write()
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        payload["tracks"][0]["trackIndex"] = 2
        self.path.write_text(json.dumps(payload), encoding="utf-8")
        with self.assertRaises(WebValidationError):
            nsf_chip.load_metadata(self.path, 2)

    def test_missing_sidecar_returns_none(self) -> None:
        # sidecarを書かない旧nsf2midiバイナリと接続した場合の後方互換。
        self.assertIsNone(nsf_chip.load_metadata(self.path, 2))

    def test_game_source_without_target_is_rejected(self) -> None:
        with self.assertRaises(WebValidationError):
            nsf_chip.validate_sources(None, {0: "game"})

    def test_unknown_source_value_is_rejected(self) -> None:
        self._write()
        metadata = nsf_chip.load_metadata(self.path, 2)
        with self.assertRaises(WebValidationError):
            nsf_chip.validate_sources(metadata, {0: "libvgm"})


class TestNsfChipRender(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.helper = Path(self.temp.name) / "nsf2midi"
        self.helper.write_text("#!/bin/sh\n", encoding="utf-8")
        self.helper.chmod(0o755)
        self.addCleanup(os.environ.pop, "NSF2MIDI_BIN", None)
        os.environ["NSF2MIDI_BIN"] = str(self.helper)

    def test_builds_chip_render_argv_with_sorted_unique_channels(self) -> None:
        output = Path(self.temp.name) / "selected.wav"
        targets = [
            nsf_chip.NsfChipTarget("NOISE", "NOISE", True),
            nsf_chip.NsfChipTarget("SQ1", "SQ1", False),
            nsf_chip.NsfChipTarget("NOISE", "NOISE", True),  # 重複は1つにまとめる
        ]

        def fake_run(argv, **_kwargs):
            output.write_bytes(b"R" * 100)
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        with mock.patch("miditrack.nsf_chip.subprocess.run", side_effect=fake_run) as mocked:
            nsf_chip.render_selection(Path("song.nsf"), output, 22050, targets, 3)
        argv = mocked.call_args.args[0]
        self.assertEqual(argv[0], str(self.helper))
        self.assertIn("--chip-render", argv)
        self.assertEqual(argv[argv.index("--chip-render") + 1], "NOISE,SQ1")
        self.assertIn("--track", argv)
        self.assertEqual(argv[argv.index("--track") + 1], "3")
        self.assertIn("--sample-count", argv)
        self.assertEqual(argv[argv.index("--sample-count") + 1], "22050")
        self.assertEqual(argv[-2], "song.nsf")
        self.assertEqual(argv[-1], str(output))

    def test_raises_when_no_targets_selected(self) -> None:
        output = Path(self.temp.name) / "selected.wav"
        with self.assertRaises(RenderError):
            nsf_chip.render_selection(Path("song.nsf"), output, 22050, [], 0)

    def test_raises_when_output_not_produced(self) -> None:
        output = Path(self.temp.name) / "selected.wav"
        targets = [nsf_chip.NsfChipTarget("SQ1", "SQ1", True)]

        def fake_run(argv, **_kwargs):
            # 出力WAVを書かないまま正常終了したふりをする異常系。
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        with mock.patch("miditrack.nsf_chip.subprocess.run", side_effect=fake_run):
            with self.assertRaises(RenderError):
                nsf_chip.render_selection(Path("song.nsf"), output, 22050, targets, 0)

    def test_raises_with_stderr_detail_on_nonzero_exit(self) -> None:
        output = Path(self.temp.name) / "selected.wav"
        targets = [nsf_chip.NsfChipTarget("SQ1", "SQ1", True)]

        def fake_run(argv, **_kwargs):
            return subprocess.CompletedProcess(argv, 1, stdout="", stderr="boom")

        with mock.patch("miditrack.nsf_chip.subprocess.run", side_effect=fake_run):
            with self.assertRaises(RenderError) as ctx:
                nsf_chip.render_selection(Path("song.nsf"), output, 22050, targets, 0)
        self.assertIn("boom", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
