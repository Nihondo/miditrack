"""miditrack.rubberband のテスト。"""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from miditrack import rubberband
from miditrack.errors import RubberBandError


class TestTransformStem(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # パスに空白と & があっても、shell=Falseのargvで安全に渡せることを確認する。
        self.work_dir = Path(self.tmp.name) / "work & dir"
        self.work_dir.mkdir()
        self.input_path = self.work_dir / "song & title.wav"
        self.input_path.write_bytes(b"fake-wav")
        self.output_path = self.work_dir / "synced stem.wav"

    def _fake_success_run(self):
        def fake_run(argv, **_kwargs):
            Path(argv[-1]).write_bytes(b"0" * 100)
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        return fake_run

    def test_argv_is_direct_rubberband_call_with_shell_false(self) -> None:
        with mock.patch(
            "miditrack.rubberband.subprocess.run", side_effect=self._fake_success_run()
        ) as mocked:
            rubberband.transform_stem(self.input_path, self.output_path, 1.2, -2)

        (argv,), kwargs = mocked.call_args
        self.assertEqual(
            argv,
            [
                "rubberband",
                "-q",
                "-t",
                "0.833333",
                "-p",
                "-2",
                str(self.input_path),
                str(self.output_path.with_suffix(".partial.wav")),
            ],
        )
        self.assertFalse(kwargs.get("shell", False))
        self.assertTrue(self.output_path.is_file())
        self.assertFalse(self.output_path.with_suffix(".partial.wav").exists())

    def test_space_and_ampersand_paths_survive_unmangled(self) -> None:
        with mock.patch(
            "miditrack.rubberband.subprocess.run", side_effect=self._fake_success_run()
        ) as mocked:
            rubberband.transform_stem(self.input_path, self.output_path, 1.0, 0)

        (argv,), _ = mocked.call_args
        self.assertIn(str(self.input_path), argv)
        self.assertIn(str(self.output_path.with_suffix(".partial.wav")), argv)

    def test_non_zero_exit_raises_error_with_stderr(self) -> None:
        def fake_run(argv, **_kwargs):
            return subprocess.CompletedProcess(argv, 1, stdout="", stderr="conversion failed\n")

        with mock.patch("miditrack.rubberband.subprocess.run", side_effect=fake_run):
            with self.assertRaises(RubberBandError) as context:
                rubberband.transform_stem(self.input_path, self.output_path, 1.0, 0)
        self.assertIn("conversion failed", str(context.exception))

    def test_missing_rubberband_raises_actionable_error(self) -> None:
        with mock.patch(
            "miditrack.rubberband.subprocess.run", side_effect=FileNotFoundError()
        ):
            with self.assertRaises(RubberBandError) as context:
                rubberband.transform_stem(self.input_path, self.output_path, 1.0, 0)
        self.assertIn("rubberband が見つかりません", str(context.exception))

    def test_timeout_raises_error(self) -> None:
        with mock.patch(
            "miditrack.rubberband.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="rubberband", timeout=900),
        ):
            with self.assertRaises(RubberBandError):
                rubberband.transform_stem(self.input_path, self.output_path, 1.0, 0)

    def test_missing_or_empty_output_raises_error_without_leaving_partial_file(self) -> None:
        def fake_run(argv, **_kwargs):
            Path(argv[-1]).write_bytes(b"0" * 44)
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        with mock.patch("miditrack.rubberband.subprocess.run", side_effect=fake_run):
            with self.assertRaises(RubberBandError):
                rubberband.transform_stem(self.input_path, self.output_path, 1.0, 0)
        self.assertFalse(self.output_path.exists())
        self.assertFalse(self.output_path.with_suffix(".partial.wav").exists())

    def test_invalid_input_or_speed_raises_before_running_rubberband(self) -> None:
        with self.assertRaises(RubberBandError):
            rubberband.transform_stem(self.work_dir / "missing.wav", self.output_path, 1.0, 0)
        with self.assertRaises(RubberBandError):
            rubberband.transform_stem(self.input_path, self.output_path, 0.0, 0)


if __name__ == "__main__":
    unittest.main()
