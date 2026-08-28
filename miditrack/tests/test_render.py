"""miditrack.render のテスト。

fluidsynth/midi2wav.sh を実際には起動せず、subprocess.run() を差し替えて
argv構造と shell=False の呼び出し規約だけを検証する。
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from miditrack import render
from miditrack.errors import RenderError


class TestListSoundfonts(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_scans_directories_in_order_and_files_sorted_by_name(self) -> None:
        dir_a = self.root / "a"
        dir_b = self.root / "b"
        dir_a.mkdir()
        dir_b.mkdir()
        (dir_a / "zzz.sf2").write_bytes(b"0")
        (dir_a / "aaa.sf2").write_bytes(b"00")
        (dir_b / "middle.sf3").write_bytes(b"000")
        (dir_a / "ignored.txt").write_bytes(b"nope")

        results = render.list_soundfonts([dir_a, dir_b])
        names = [item["name"] for item in results]
        self.assertEqual(names, ["aaa.sf2", "zzz.sf2", "middle.sf3"])
        self.assertEqual(results[0]["sizeBytes"], 2)
        self.assertEqual(results[0]["dir"], str(dir_a))

    def test_missing_directory_is_skipped_silently(self) -> None:
        missing = self.root / "does-not-exist"
        self.assertEqual(render.list_soundfonts([missing]), [])

    def test_symlinks_to_the_same_real_file_are_deduplicated(self) -> None:
        # ファイル名ソートで real.sf2 が最後になるよう、先頭寄りの名前をリンクに使う。
        dir_a = self.root / "a"
        dir_a.mkdir()
        real = dir_a / "zzz_real.sf2"
        real.write_bytes(b"0000")
        (dir_a / "aaa_alias1.sf2").symlink_to(real)
        (dir_a / "bbb_alias2.sf2").symlink_to(real)

        results = render.list_soundfonts([dir_a])
        names = [item["name"] for item in results]
        self.assertEqual(names, ["aaa_alias1.sf2"])

    def test_symlink_listed_first_wins_when_real_file_sorts_later(self) -> None:
        dir_a = self.root / "a"
        dir_a.mkdir()
        real = dir_a / "zzz_real.sf2"
        real.write_bytes(b"0000")
        (dir_a / "aaa_alias.sf2").symlink_to(real)

        results = render.list_soundfonts([dir_a])
        names = [item["name"] for item in results]
        self.assertEqual(names, ["aaa_alias.sf2"])

    def test_different_real_files_with_same_extension_are_both_kept(self) -> None:
        dir_a = self.root / "a"
        dir_a.mkdir()
        (dir_a / "one.sf2").write_bytes(b"0")
        (dir_a / "two.sf2").write_bytes(b"00")

        results = render.list_soundfonts([dir_a])
        names = [item["name"] for item in results]
        self.assertEqual(names, ["one.sf2", "two.sf2"])

    def test_default_dirs_match_midi2wav_sh(self) -> None:
        # midi2wav.sh の DEFAULT_SOUNDFONT_DIRS と1対1で対応させる。
        dirs = render.default_soundfont_dirs()
        self.assertTrue(str(dirs[0]).endswith("/soundfonts"))
        self.assertEqual(dirs[1], Path.home() / "Library/Audio/Sounds/Banks")
        self.assertEqual(str(dirs[2]), "/opt/homebrew/share/soundfonts")
        self.assertEqual(str(dirs[3]), "/Library/Audio/Sounds/Banks")
        self.assertEqual(str(dirs[4]), "/opt/homebrew/share/fluid-synth/sf2")


class TestIsSoundfontFile(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_accepts_sf2_and_sf3(self) -> None:
        sf2 = Path(self.tmp.name) / "a.sf2"
        sf2.write_bytes(b"0")
        sf3 = Path(self.tmp.name) / "a.SF3"
        sf3.write_bytes(b"0")
        self.assertTrue(render.is_soundfont_file(sf2))
        self.assertTrue(render.is_soundfont_file(sf3))

    def test_rejects_missing_or_wrong_extension(self) -> None:
        missing = Path(self.tmp.name) / "missing.sf2"
        self.assertFalse(render.is_soundfont_file(missing))
        wrong_ext = Path(self.tmp.name) / "a.txt"
        wrong_ext.write_bytes(b"0")
        self.assertFalse(render.is_soundfont_file(wrong_ext))


class TestResolveMidi2WavBin(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._env_backup = os.environ.get("MIDI2WAV_BIN")
        self.addCleanup(self._restore_env)

    def _restore_env(self) -> None:
        if self._env_backup is None:
            os.environ.pop("MIDI2WAV_BIN", None)
        else:
            os.environ["MIDI2WAV_BIN"] = self._env_backup

    def test_valid_midi2wav_bin_env_is_used(self) -> None:
        script = Path(self.tmp.name) / "midi2wav.sh"
        script.write_text("#!/bin/sh\n")
        script.chmod(0o755)
        os.environ["MIDI2WAV_BIN"] = str(script)
        self.assertEqual(render.resolve_midi2wav_bin(), str(script))

    def test_invalid_midi2wav_bin_env_is_fatal_not_fallback(self) -> None:
        # 設定されているのに実行できなければフォールバックせず致命的エラーにする。
        os.environ["MIDI2WAV_BIN"] = str(Path(self.tmp.name) / "does-not-exist.sh")
        with self.assertRaises(RenderError):
            render.resolve_midi2wav_bin()

    def test_repo_root_midi2wav_sh_is_found_by_default(self) -> None:
        # このリポジトリでは実際に repo_root/midi2wav.sh が存在する前提で確認する。
        os.environ.pop("MIDI2WAV_BIN", None)
        resolved = render.resolve_midi2wav_bin()
        self.assertTrue(resolved.endswith("midi2wav.sh"))
        self.assertTrue(Path(resolved).is_file())


class TestRenderWav(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # このリポジトリ自身のパスがスペースと '&' を含むのと同じ状況を再現する。
        self.mid_path = Path(self.tmp.name) / "a & b.mid"
        self.mid_path.write_bytes(b"fake-midi")
        self.wav_path = Path(self.tmp.name) / "a & b.wav"

    def _fake_success_run(self, wav_size: int = 100):
        def fake_run(argv, **kwargs):
            wav_arg = Path(argv[argv.index("-o") + 1])
            wav_arg.write_bytes(b"0" * wav_size)
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        return fake_run

    def test_argv_is_a_list_with_shell_false(self) -> None:
        with mock.patch(
            "miditrack.render.subprocess.run", side_effect=self._fake_success_run()
        ) as mocked:
            render.render_wav(self.mid_path, self.wav_path)
        argv, kwargs = mocked.call_args
        self.assertIsInstance(argv[0], list)
        self.assertFalse(kwargs.get("shell", False))

    def test_argv_shape_options_before_positionals(self) -> None:
        with mock.patch(
            "miditrack.render.subprocess.run", side_effect=self._fake_success_run()
        ) as mocked:
            render.render_wav(self.mid_path, self.wav_path)
        (argv,), _ = mocked.call_args
        self.assertIn("-f", argv)
        self.assertIn("-o", argv)
        self.assertEqual(argv[argv.index("-o") + 1], str(self.wav_path))
        self.assertEqual(argv[-1], str(self.mid_path))

    def test_space_and_ampersand_path_survives_unmangled(self) -> None:
        with mock.patch(
            "miditrack.render.subprocess.run", side_effect=self._fake_success_run()
        ) as mocked:
            render.render_wav(self.mid_path, self.wav_path)
        (argv,), _ = mocked.call_args
        self.assertIn(str(self.mid_path), argv)
        self.assertIn(str(self.wav_path), argv)

    def test_soundfont_option_included_only_when_given(self) -> None:
        soundfont = Path(self.tmp.name) / "font.sf2"
        with mock.patch(
            "miditrack.render.subprocess.run", side_effect=self._fake_success_run()
        ) as mocked:
            render.render_wav(self.mid_path, self.wav_path, soundfont)
        (argv,), _ = mocked.call_args
        self.assertIn("-s", argv)
        self.assertEqual(argv[argv.index("-s") + 1], str(soundfont))

    def test_non_zero_exit_raises_render_error_with_stderr(self) -> None:
        def fake_run(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 1, stdout="", stderr="soundfont not found\n")

        with mock.patch("miditrack.render.subprocess.run", side_effect=fake_run):
            with self.assertRaises(RenderError) as ctx:
                render.render_wav(self.mid_path, self.wav_path)
        self.assertIn("soundfont not found", str(ctx.exception))

    def test_file_not_found_raises_render_error(self) -> None:
        with mock.patch(
            "miditrack.render.subprocess.run", side_effect=FileNotFoundError()
        ):
            with self.assertRaises(RenderError):
                render.render_wav(self.mid_path, self.wav_path)

    def test_timeout_raises_render_error(self) -> None:
        with mock.patch(
            "miditrack.render.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="midi2wav", timeout=300),
        ):
            with self.assertRaises(RenderError):
                render.render_wav(self.mid_path, self.wav_path)

    def test_empty_output_raises_render_error(self) -> None:
        with mock.patch(
            "miditrack.render.subprocess.run", side_effect=self._fake_success_run(wav_size=0)
        ):
            with self.assertRaises(RenderError):
                render.render_wav(self.mid_path, self.wav_path)


if __name__ == "__main__":
    unittest.main()
