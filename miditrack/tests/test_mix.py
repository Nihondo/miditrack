"""miditrack.mix のテスト。

ffmpegを実際には起動せず、subprocess.run() を差し替えてargv構造と
shell=False の呼び出し規約だけを検証する。render.py/test_render.py と
同じ書き方。
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from miditrack import mix
from miditrack.errors import MixError


class TestResolveFfmpegBin(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._env_backup = os.environ.get("FFMPEG_BIN")
        self.addCleanup(self._restore_env)

    def _restore_env(self) -> None:
        if self._env_backup is None:
            os.environ.pop("FFMPEG_BIN", None)
        else:
            os.environ["FFMPEG_BIN"] = self._env_backup

    def test_valid_ffmpeg_bin_env_is_used(self) -> None:
        script = Path(self.tmp.name) / "ffmpeg"
        script.write_text("#!/bin/sh\n")
        script.chmod(0o755)
        os.environ["FFMPEG_BIN"] = str(script)
        self.assertEqual(mix.resolve_ffmpeg_bin(), str(script))

    def test_invalid_ffmpeg_bin_env_is_fatal_not_fallback(self) -> None:
        # 設定されているのに実行できなければフォールバックせず致命的エラーにする。
        os.environ["FFMPEG_BIN"] = str(Path(self.tmp.name) / "does-not-exist")
        with self.assertRaises(MixError):
            mix.resolve_ffmpeg_bin()

    def test_missing_ffmpeg_raises_mix_error(self) -> None:
        os.environ.pop("FFMPEG_BIN", None)
        with mock.patch("miditrack.mix.shutil.which", return_value=None):
            with self.assertRaises(MixError):
                mix.resolve_ffmpeg_bin()

    def test_path_ffmpeg_is_used_when_env_unset(self) -> None:
        os.environ.pop("FFMPEG_BIN", None)
        with mock.patch("miditrack.mix.shutil.which", return_value="/usr/bin/ffmpeg"):
            self.assertEqual(mix.resolve_ffmpeg_bin(), "/usr/bin/ffmpeg")


class TestMixWav(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # このリポジトリ自身のパスがスペースと '&' を含むのと同じ状況を再現する。
        self.dry_path = Path(self.tmp.name) / "a & b.dry.wav"
        self.dry_path.write_bytes(b"fake-dry-wav")
        self.stem_path = Path(self.tmp.name) / "a & b.chip.wav"
        self.stem_path.write_bytes(b"fake-stem-wav")
        self.out_path = Path(self.tmp.name) / "a & b.wav"

        self._env_backup = os.environ.get("FFMPEG_BIN")
        os.environ["FFMPEG_BIN"] = "/usr/bin/ffmpeg"  # resolve_ffmpeg_binを固定するため
        self.addCleanup(self._restore_env)

    def _restore_env(self) -> None:
        if self._env_backup is None:
            os.environ.pop("FFMPEG_BIN", None)
        else:
            os.environ["FFMPEG_BIN"] = self._env_backup

    def _fake_success_run(self, out_size: int = 100):
        def fake_run(argv, **kwargs):
            out_arg = Path(argv[-1])
            out_arg.write_bytes(b"0" * out_size)
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        return fake_run

    def _patch_executable(self):
        # resolve_ffmpeg_binのenv経路は「実行可能ファイルであること」を要求するため、
        # FFMPEG_BIN=/usr/bin/ffmpeg をそのまま使えるよう _is_executable_file を差し替える。
        return mock.patch("miditrack.mix._is_executable_file", return_value=True)

    def test_argv_is_a_list_with_shell_false(self) -> None:
        with self._patch_executable(), mock.patch(
            "miditrack.mix.subprocess.run", side_effect=self._fake_success_run()
        ) as mocked:
            mix.mix_wav([(self.dry_path, 0.80), (self.stem_path, 0.55)], self.out_path)
        argv, kwargs = mocked.call_args
        self.assertIsInstance(argv[0], list)
        self.assertFalse(kwargs.get("shell", False))

    def test_nostdin_is_present(self) -> None:
        with self._patch_executable(), mock.patch(
            "miditrack.mix.subprocess.run", side_effect=self._fake_success_run()
        ) as mocked:
            mix.mix_wav([(self.dry_path, 0.80), (self.stem_path, 0.55)], self.out_path)
        (argv,), _ = mocked.call_args
        self.assertIn("-nostdin", argv)

    def test_both_inputs_are_passed_in_order_dry_then_stem(self) -> None:
        with self._patch_executable(), mock.patch(
            "miditrack.mix.subprocess.run", side_effect=self._fake_success_run()
        ) as mocked:
            mix.mix_wav([(self.dry_path, 0.80), (self.stem_path, 0.55)], self.out_path)
        (argv,), _ = mocked.call_args
        i_indices = [i for i, a in enumerate(argv) if a == "-i"]
        self.assertEqual(len(i_indices), 2)
        self.assertEqual(argv[i_indices[0] + 1], str(self.dry_path))
        self.assertEqual(argv[i_indices[1] + 1], str(self.stem_path))

    def test_filter_complex_uses_normalize_zero_and_longest(self) -> None:
        with self._patch_executable(), mock.patch(
            "miditrack.mix.subprocess.run", side_effect=self._fake_success_run()
        ) as mocked:
            mix.mix_wav([(self.dry_path, 0.80), (self.stem_path, 0.55)], self.out_path)
        (argv,), _ = mocked.call_args
        filter_str = argv[argv.index("-filter_complex") + 1]
        self.assertIn("normalize=0", filter_str)
        self.assertIn("duration=longest", filter_str)
        self.assertIn("dropout_transition=0", filter_str)

    def test_output_codec_is_pcm_s16le_44100_stereo(self) -> None:
        with self._patch_executable(), mock.patch(
            "miditrack.mix.subprocess.run", side_effect=self._fake_success_run()
        ) as mocked:
            mix.mix_wav([(self.dry_path, 0.80), (self.stem_path, 0.55)], self.out_path)
        (argv,), _ = mocked.call_args
        self.assertEqual(argv[argv.index("-c:a") + 1], "pcm_s16le")
        self.assertEqual(argv[argv.index("-ar") + 1], "44100")
        self.assertEqual(argv[argv.index("-ac") + 1], "2")

    def test_space_and_ampersand_path_survives_unmangled(self) -> None:
        with self._patch_executable(), mock.patch(
            "miditrack.mix.subprocess.run", side_effect=self._fake_success_run()
        ) as mocked:
            mix.mix_wav([(self.dry_path, 0.80), (self.stem_path, 0.55)], self.out_path)
        (argv,), _ = mocked.call_args
        self.assertIn(str(self.dry_path), argv)
        self.assertIn(str(self.stem_path), argv)
        self.assertIn(str(self.out_path), argv)

    def test_non_zero_exit_raises_mix_error_with_stderr(self) -> None:
        def fake_run(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 1, stdout="", stderr="filter error\n")

        with self._patch_executable(), mock.patch(
            "miditrack.mix.subprocess.run", side_effect=fake_run
        ):
            with self.assertRaises(MixError) as ctx:
                mix.mix_wav([(self.dry_path, 0.80), (self.stem_path, 0.55)], self.out_path)
        self.assertIn("filter error", str(ctx.exception))

    def test_file_not_found_raises_mix_error(self) -> None:
        with self._patch_executable(), mock.patch(
            "miditrack.mix.subprocess.run", side_effect=FileNotFoundError()
        ):
            with self.assertRaises(MixError):
                mix.mix_wav([(self.dry_path, 0.80), (self.stem_path, 0.55)], self.out_path)

    def test_timeout_raises_mix_error(self) -> None:
        with self._patch_executable(), mock.patch(
            "miditrack.mix.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="ffmpeg", timeout=300),
        ):
            with self.assertRaises(MixError):
                mix.mix_wav([(self.dry_path, 0.80), (self.stem_path, 0.55)], self.out_path)

    def test_empty_output_raises_mix_error(self) -> None:
        with self._patch_executable(), mock.patch(
            "miditrack.mix.subprocess.run", side_effect=self._fake_success_run(out_size=0)
        ):
            with self.assertRaises(MixError):
                mix.mix_wav([(self.dry_path, 0.80), (self.stem_path, 0.55)], self.out_path)

    def test_single_input_raises_mix_error(self) -> None:
        with self.assertRaises(MixError):
            mix.mix_wav([(self.dry_path, 1.0)], self.out_path)

    def test_three_inputs_produce_amix_inputs_three(self) -> None:
        third_path = Path(self.tmp.name) / "third.wav"
        third_path.write_bytes(b"fake-third-wav")
        with self._patch_executable(), mock.patch(
            "miditrack.mix.subprocess.run", side_effect=self._fake_success_run()
        ) as mocked:
            mix.mix_wav(
                [(self.dry_path, 0.80), (self.stem_path, 0.55), (third_path, 1.0)], self.out_path
            )
        (argv,), _ = mocked.call_args
        filter_str = argv[argv.index("-filter_complex") + 1]
        self.assertIn("amix=inputs=3", filter_str)
        i_indices = [i for i, a in enumerate(argv) if a == "-i"]
        self.assertEqual(len(i_indices), 3)
        self.assertEqual(argv[i_indices[2] + 1], str(third_path))

    def test_each_gain_appears_in_filter_complex(self) -> None:
        with self._patch_executable(), mock.patch(
            "miditrack.mix.subprocess.run", side_effect=self._fake_success_run()
        ) as mocked:
            mix.mix_wav([(self.dry_path, 0.8), (self.stem_path, 0.55)], self.out_path)
        (argv,), _ = mocked.call_args
        filter_str = argv[argv.index("-filter_complex") + 1]
        self.assertIn("volume=0.8", filter_str)
        self.assertIn("volume=0.55", filter_str)


class TestBuildFilterComplex(unittest.TestCase):
    def test_raises_for_fewer_than_two_gains(self) -> None:
        with self.assertRaises(MixError):
            mix.build_filter_complex([1.0])

    def test_labels_are_indexed_by_input_order(self) -> None:
        filter_str = mix.build_filter_complex([0.8, 0.55, 1.0])
        self.assertIn("[0:a]", filter_str)
        self.assertIn("[1:a]", filter_str)
        self.assertIn("[2:a]", filter_str)
        self.assertIn("amix=inputs=3", filter_str)


if __name__ == "__main__":
    unittest.main()
