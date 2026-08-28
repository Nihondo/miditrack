"""miditrack.pitch_shift のテスト。

pitch_shift.sh を実際には起動せず、subprocess.run() を差し替えて
argv構造と shell=False の呼び出し規約、バリデーション規則だけを検証する。
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from miditrack import pitch_shift
from miditrack.errors import PitchShiftError


class TestResolvePitchShiftBin(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._env_backup = os.environ.get("PITCH_SHIFT_BIN")
        self.addCleanup(self._restore_env)

    def _restore_env(self) -> None:
        if self._env_backup is None:
            os.environ.pop("PITCH_SHIFT_BIN", None)
        else:
            os.environ["PITCH_SHIFT_BIN"] = self._env_backup

    def test_valid_pitch_shift_bin_env_is_used(self) -> None:
        script = Path(self.tmp.name) / "pitch_shift.sh"
        script.write_text("#!/bin/sh\n")
        script.chmod(0o755)
        os.environ["PITCH_SHIFT_BIN"] = str(script)
        self.assertEqual(pitch_shift.resolve_pitch_shift_bin(), str(script))

    def test_invalid_pitch_shift_bin_env_is_fatal_not_fallback(self) -> None:
        os.environ["PITCH_SHIFT_BIN"] = str(Path(self.tmp.name) / "does-not-exist.sh")
        with self.assertRaises(PitchShiftError):
            pitch_shift.resolve_pitch_shift_bin()

    def test_repo_root_pitch_shift_sh_is_found_by_default(self) -> None:
        os.environ.pop("PITCH_SHIFT_BIN", None)
        resolved = pitch_shift.resolve_pitch_shift_bin()
        self.assertTrue(resolved.endswith("pitch_shift.sh"))
        self.assertTrue(Path(resolved).is_file())


class TestValidatePitchShiftOptions(unittest.TestCase):
    def test_none_uses_defaults(self) -> None:
        speeds, pitches = pitch_shift.validate_pitch_shift_options(None, None)
        self.assertEqual(speeds, pitch_shift.DEFAULT_SPEEDS)
        self.assertEqual(pitches, pitch_shift.DEFAULT_PITCHES)

    def test_custom_values_are_parsed_as_floats(self) -> None:
        speeds, pitches = pitch_shift.validate_pitch_shift_options([1.5, 2], [-3, 0, 3])
        self.assertEqual(speeds, [1.5, 2.0])
        self.assertEqual(pitches, [-3.0, 0.0, 3.0])

    def test_empty_list_is_rejected(self) -> None:
        with self.assertRaises(PitchShiftError):
            pitch_shift.validate_pitch_shift_options([], None)

    def test_non_numeric_value_is_rejected(self) -> None:
        with self.assertRaises(PitchShiftError):
            pitch_shift.validate_pitch_shift_options(["fast"], None)

    def test_bool_value_is_rejected(self) -> None:
        # bool は int のサブクラスなので明示的に弾く必要がある。
        with self.assertRaises(PitchShiftError):
            pitch_shift.validate_pitch_shift_options([True], None)

    def test_out_of_range_speed_is_rejected(self) -> None:
        with self.assertRaises(PitchShiftError):
            pitch_shift.validate_pitch_shift_options([0], None)
        with self.assertRaises(PitchShiftError):
            pitch_shift.validate_pitch_shift_options([100], None)

    def test_out_of_range_pitch_is_rejected(self) -> None:
        with self.assertRaises(PitchShiftError):
            pitch_shift.validate_pitch_shift_options(None, [-100])

    def test_too_many_speeds_is_rejected(self) -> None:
        with self.assertRaises(PitchShiftError):
            pitch_shift.validate_pitch_shift_options(list(range(1, 20)), None)

    def test_too_many_combinations_is_rejected(self) -> None:
        speeds = [1.0] * pitch_shift.MAX_SPEED_COUNT
        pitches = [0] * pitch_shift.MAX_PITCH_COUNT
        with self.assertRaises(PitchShiftError):
            pitch_shift.validate_pitch_shift_options(speeds, pitches)


class TestRunPitchShift(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # このリポジトリ自身のパスがスペースと '&' を含むのと同じ状況を再現する。
        self.work_dir = Path(self.tmp.name) / "work & dir"
        self.work_dir.mkdir()
        self.wav_path = self.work_dir / "song & title.wav"
        self.wav_path.write_bytes(b"fake-wav")

    def _fake_success_run(self, speeds: list[float], pitches: list[float]):
        def fake_run(argv, **kwargs):
            cwd = Path(kwargs["cwd"])
            for s in speeds:
                for p in pitches:
                    out = cwd / f"song & title_x{s}_p{p}.wav"
                    out.write_bytes(b"0" * 100)
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        return fake_run

    def test_argv_is_a_list_with_shell_false_and_cwd_set(self) -> None:
        speeds, pitches = [1.2, 0.8], [-2, 0, 2]
        with mock.patch(
            "miditrack.pitch_shift.subprocess.run",
            side_effect=self._fake_success_run(speeds, pitches),
        ) as mocked:
            result = pitch_shift.run_pitch_shift(self.wav_path, self.work_dir, speeds, pitches)
        argv, kwargs = mocked.call_args
        self.assertIsInstance(argv[0], list)
        self.assertFalse(kwargs.get("shell", False))
        self.assertEqual(kwargs.get("cwd"), self.work_dir)
        self.assertEqual(len(result), 6)

    def test_argv_shape_includes_all_speeds_and_pitches(self) -> None:
        speeds, pitches = [1.5, 0.5], [-1, 1]
        with mock.patch(
            "miditrack.pitch_shift.subprocess.run",
            side_effect=self._fake_success_run(speeds, pitches),
        ) as mocked:
            pitch_shift.run_pitch_shift(self.wav_path, self.work_dir, speeds, pitches)
        (argv,), _ = mocked.call_args
        self.assertEqual(argv.count("-s"), 2)
        self.assertEqual(argv.count("-p"), 2)
        self.assertEqual(argv[-1], str(self.wav_path))

    def test_space_and_ampersand_path_survives_unmangled(self) -> None:
        speeds, pitches = [1.0], [0]
        with mock.patch(
            "miditrack.pitch_shift.subprocess.run",
            side_effect=self._fake_success_run(speeds, pitches),
        ) as mocked:
            pitch_shift.run_pitch_shift(self.wav_path, self.work_dir, speeds, pitches)
        (argv,), _ = mocked.call_args
        self.assertIn(str(self.wav_path), argv)

    def test_non_zero_exit_raises_pitch_shift_error_with_stderr(self) -> None:
        def fake_run(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 1, stdout="", stderr="rubberband missing\n")

        with mock.patch("miditrack.pitch_shift.subprocess.run", side_effect=fake_run):
            with self.assertRaises(PitchShiftError) as ctx:
                pitch_shift.run_pitch_shift(self.wav_path, self.work_dir, [1.0], [0])
        self.assertIn("rubberband missing", str(ctx.exception))

    def test_file_not_found_raises_pitch_shift_error(self) -> None:
        with mock.patch(
            "miditrack.pitch_shift.subprocess.run", side_effect=FileNotFoundError()
        ):
            with self.assertRaises(PitchShiftError):
                pitch_shift.run_pitch_shift(self.wav_path, self.work_dir, [1.0], [0])

    def test_timeout_raises_pitch_shift_error(self) -> None:
        with mock.patch(
            "miditrack.pitch_shift.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="pitch_shift.sh", timeout=900),
        ):
            with self.assertRaises(PitchShiftError):
                pitch_shift.run_pitch_shift(self.wav_path, self.work_dir, [1.0], [0])

    def test_missing_expected_output_raises_pitch_shift_error(self) -> None:
        # スクリプトはexit 0を返すのに、期待した組み合わせ数のファイルを生成しない場合。
        def fake_run(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        with mock.patch("miditrack.pitch_shift.subprocess.run", side_effect=fake_run):
            with self.assertRaises(PitchShiftError):
                pitch_shift.run_pitch_shift(self.wav_path, self.work_dir, [1.0, 0.5], [0])

    def test_pre_existing_wav_in_work_dir_is_not_mistaken_for_output(self) -> None:
        # 入力コピー自体や以前の残骸を「新規生成された」と誤カウントしない。
        preexisting = self.work_dir / "leftover.wav"
        preexisting.write_bytes(b"0" * 100)
        speeds, pitches = [1.0], [0]
        with mock.patch(
            "miditrack.pitch_shift.subprocess.run",
            side_effect=self._fake_success_run(speeds, pitches),
        ):
            result = pitch_shift.run_pitch_shift(self.wav_path, self.work_dir, speeds, pitches)
        self.assertEqual(len(result), 1)
        self.assertNotIn(preexisting, result)


if __name__ == "__main__":
    unittest.main()
