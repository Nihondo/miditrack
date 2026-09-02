"""libvgmトラックsidecarと選択レンダラの単体テスト。"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from miditrack import libvgm
from miditrack.errors import WebValidationError


class TestLibvgmMetadata(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "converted.libvgm.json"

    def _write(self) -> None:
        self.path.write_text(json.dumps({
            "version": 1,
            "sampleCount": 44100,
            "tracks": [
                {"trackIndex": 0, "libvgm": {
                    "deviceType": 2, "instance": 0, "mainMask": 64,
                    "linkedMask": 0, "groupId": "2:0:64:0",
                    "suggestedForHardwareMix": True,
                }, "fm": {
                    "model": "opn", "algorithm": 5,
                    "carrierOperators": [1, 2, 3], "suggestedProgram": 62,
                }, "pcm": {
                    "source": "ym2612-dac", "sampleId": "001234", "gmNote": 35,
                    "events": [{"type": "start", "sampleTime": 0}],
                }},
                {"trackIndex": 1, "libvgm": {
                    "deviceType": 2, "instance": 0, "mainMask": 64,
                    "linkedMask": 0, "groupId": "2:0:64:0",
                    "suggestedForHardwareMix": True,
                }},
            ],
        }), encoding="utf-8")

    def test_loads_and_expands_shared_physical_channel(self) -> None:
        self._write()
        metadata = libvgm.load_metadata(self.path, 2)
        self.assertIsNotNone(metadata)
        self.assertEqual(metadata.sample_count, 44100)
        self.assertTrue(metadata.targets[0].suggested)
        self.assertEqual(
            libvgm.validate_sources(metadata, {0: "game"}),
            {0: "game", 1: "game"},
        )

    def test_rejects_out_of_range_track_index(self) -> None:
        self._write()
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        payload["tracks"][0]["trackIndex"] = 2
        self.path.write_text(json.dumps(payload), encoding="utf-8")
        with self.assertRaises(WebValidationError):
            libvgm.load_metadata(self.path, 2)


class TestLibvgmRender(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.helper = Path(self.temp.name) / "helper"
        self.helper.write_text("#!/bin/sh\n", encoding="utf-8")
        self.helper.chmod(0o755)
        self.addCleanup(os.environ.pop, "VGM2MIDI_STEMS_HELPER", None)
        os.environ["VGM2MIDI_STEMS_HELPER"] = str(self.helper)

    def test_resolves_bundled_helper_when_override_is_absent(self) -> None:
        with (
            mock.patch.dict(os.environ, {}, clear=True),
            mock.patch.object(libvgm, "DEFAULT_HELPER", self.helper),
        ):
            self.assertEqual(libvgm.resolve_helper(), self.helper)

    def test_combines_masks_for_the_same_device(self) -> None:
        output = Path(self.temp.name) / "selected.wav"
        targets = [
            libvgm.LibvgmTarget(2, 0, 1, 0, "a", False),
            libvgm.LibvgmTarget(2, 0, 4, 2, "b", True),
        ]

        def fake_run(argv, **_kwargs):
            output.write_bytes(b"R" * 100)
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        with mock.patch("miditrack.libvgm.subprocess.run", side_effect=fake_run) as mocked:
            libvgm.render_selection(Path("song.vgm"), output, 22050, targets)
        argv = mocked.call_args.args[0]
        self.assertEqual(argv[-1], "2:0:5:2")
        self.assertEqual(argv[1], "--selection")


if __name__ == "__main__":
    unittest.main()
