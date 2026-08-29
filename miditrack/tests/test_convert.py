"""miditrack.convert のテスト。

nsf2midi/spc2midi/vgm2midi/subprocess.run は実際には起動せず、
render.py 用の既存テスト（test_render.py）と同じ流儀で argv構造と
shell=False の呼び出し規約、-l 出力のパース結果だけを検証する。
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from miditrack import convert
from miditrack.errors import ConvertError, WebValidationError

NSF_SAMPLE_LIST_OUTPUT = """Title:     Super Test Game
Artist:    Test Artist
Copyright: 2024 Test
Tracks:    3
Region:    NTSC
Expansion: none
  [ 0] Title Screen (12.5 sec)
  [ 1] Stage 1 (180.0 sec)
  [ 2] Stage 2
"""

SPC_SAMPLE_LIST_OUTPUT = """File:      castlevania4.rsn
Sequences: 2
  [ 0] "Stage 1"  driver=AkaoSnes  tracks=8  instrsets=3
  [ 1] "Boss"  driver=AkaoSnes  tracks=6  instrsets=2
"""


class TestDetectFormat(unittest.TestCase):
    def test_detects_each_supported_extension(self) -> None:
        self.assertEqual(convert.detect_format("song.nsf").key, "nsf")
        self.assertEqual(convert.detect_format("song.NSFE").key, "nsf")
        self.assertEqual(convert.detect_format("song.spc").key, "spc")
        self.assertEqual(convert.detect_format("song.spc2").key, "spc")
        self.assertEqual(convert.detect_format("collection.RSN").key, "spc")
        self.assertEqual(convert.detect_format("song.vgm").key, "vgm")
        self.assertEqual(convert.detect_format("song.vgz").key, "vgm")

    def test_unsupported_extension_raises(self) -> None:
        with self.assertRaises(WebValidationError):
            convert.detect_format("song.txt")

    def test_no_extension_raises(self) -> None:
        with self.assertRaises(WebValidationError):
            convert.detect_format("song")


class TestFormatByKey(unittest.TestCase):
    def test_round_trips_through_detect_format(self) -> None:
        fmt = convert.detect_format("song.nsf")
        self.assertIs(convert.format_by_key("nsf"), fmt)


class TestResolveConverterArgv0(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for env_var in ("NSF2MIDI_BIN", "SPC2MIDI_BIN", "VGM2MIDI_BIN"):
            self.addCleanup(os.environ.pop, env_var, None)
            os.environ.pop(env_var, None)

    def _make_executable(self, name: str) -> Path:
        script = Path(self.tmp.name) / name
        script.write_text("#!/bin/sh\n")
        script.chmod(0o755)
        return script

    def test_valid_env_var_is_used(self) -> None:
        script = self._make_executable("custom-nsf2midi")
        os.environ["NSF2MIDI_BIN"] = str(script)
        self.assertEqual(convert.resolve_converter_argv0(convert.format_by_key("nsf")), [str(script)])

    def test_invalid_env_var_is_fatal_not_fallback(self) -> None:
        os.environ["SPC2MIDI_BIN"] = str(Path(self.tmp.name) / "does-not-exist")
        with self.assertRaises(ConvertError):
            convert.resolve_converter_argv0(convert.format_by_key("spc"))

    def test_repo_relative_nsf2midi_is_found_by_default(self) -> None:
        argv0 = convert.resolve_converter_argv0(convert.format_by_key("nsf"))
        self.assertEqual(len(argv0), 1)
        self.assertTrue(argv0[0].endswith("nsf2midi/nsf2midi"))
        self.assertTrue(Path(argv0[0]).is_file())

    def test_repo_relative_spc2midi_is_found_by_default(self) -> None:
        argv0 = convert.resolve_converter_argv0(convert.format_by_key("spc"))
        self.assertEqual(len(argv0), 1)
        self.assertTrue(argv0[0].endswith("spc2midi/spc2midi"))
        self.assertTrue(Path(argv0[0]).is_file())

    def test_repo_relative_vgm2midi_prepends_node(self) -> None:
        argv0 = convert.resolve_converter_argv0(convert.format_by_key("vgm"))
        self.assertEqual(len(argv0), 2)
        self.assertTrue(argv0[0].endswith("node") or argv0[0] == "node")
        self.assertTrue(argv0[1].endswith("vgm2midi/dist/cli.js"))


class TestParseNsfList(unittest.TestCase):
    def test_parses_header_and_tracks(self) -> None:
        metadata, songs = convert._parse_nsf_list(NSF_SAMPLE_LIST_OUTPUT)
        self.assertEqual(metadata["Title"], "Super Test Game")
        self.assertEqual(metadata["Tracks"], "3")
        self.assertEqual(metadata["Region"], "NTSC")
        self.assertEqual(len(songs), 3)
        self.assertEqual(songs[0], {"index": 0, "label": "Title Screen", "durationSeconds": 12.5, "detail": None})
        self.assertEqual(songs[1]["durationSeconds"], 180.0)
        self.assertIsNone(songs[2]["durationSeconds"])
        self.assertEqual(songs[2]["label"], "Stage 2")

    def test_empty_label_falls_back_to_track_number(self) -> None:
        text = "Tracks:    1\n  [ 0]  (5.0 sec)\n"
        _metadata, songs = convert._parse_nsf_list(text)
        self.assertEqual(songs[0]["label"], "Track 0")
        self.assertEqual(songs[0]["durationSeconds"], 5.0)


class TestParseSpcList(unittest.TestCase):
    def test_parses_header_and_sequences(self) -> None:
        metadata, songs = convert._parse_spc_list(SPC_SAMPLE_LIST_OUTPUT)
        self.assertEqual(metadata["File"], "castlevania4.rsn")
        self.assertEqual(metadata["Sequences"], "2")
        self.assertEqual(len(songs), 2)
        self.assertEqual(songs[0]["index"], 0)
        self.assertEqual(songs[0]["label"], "Stage 1")
        self.assertIsNone(songs[0]["durationSeconds"])
        self.assertEqual(songs[0]["detail"], "driver=AkaoSnes tracks=8 instrsets=3")
        self.assertEqual(songs[1]["label"], "Boss")


class TestListSongs(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source_path = Path(self.tmp.name) / "a & b.nsf"
        self.source_path.write_bytes(b"fake-nsf")

    def test_nsf_list_success(self) -> None:
        def fake_run(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 0, stdout=NSF_SAMPLE_LIST_OUTPUT, stderr="")

        with mock.patch("miditrack.convert.subprocess.run", side_effect=fake_run) as mocked:
            metadata, songs = convert.list_songs(convert.format_by_key("nsf"), self.source_path)
        self.assertEqual(len(songs), 3)
        self.assertEqual(metadata["Title"], "Super Test Game")
        (argv,), _ = mocked.call_args
        self.assertIn("-l", argv)
        self.assertIn(str(self.source_path), argv)

    def test_spc_no_driver_exit_code_raises_dedicated_message(self) -> None:
        def fake_run(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 3, stdout="", stderr="error: no supported driver\n")

        with mock.patch("miditrack.convert.subprocess.run", side_effect=fake_run):
            with self.assertRaises(ConvertError) as ctx:
                convert.list_songs(convert.format_by_key("spc"), self.source_path)
        self.assertIn("ドライバ", str(ctx.exception))

    def test_generic_failure_includes_stderr_tail(self) -> None:
        def fake_run(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 1, stdout="", stderr="boom\n")

        with mock.patch("miditrack.convert.subprocess.run", side_effect=fake_run):
            with self.assertRaises(ConvertError) as ctx:
                convert.list_songs(convert.format_by_key("nsf"), self.source_path)
        self.assertIn("boom", str(ctx.exception))


class TestOptionSchemaAndValidation(unittest.TestCase):
    def test_nsf_defaults_song_index_zero_when_songs_present(self) -> None:
        songs = [{"index": 0, "label": "A"}, {"index": 1, "label": "B"}]
        options = convert.validate_convert_options(convert.format_by_key("nsf"), songs, {})
        self.assertEqual(options["songIndex"], 0)
        self.assertIsNone(options["durationSeconds"])
        self.assertFalse(options["forcePal"])

    def test_nsf_out_of_range_song_index_raises(self) -> None:
        songs = [{"index": 0, "label": "A"}]
        with self.assertRaises(WebValidationError):
            convert.validate_convert_options(convert.format_by_key("nsf"), songs, {"songIndex": 5})

    def test_nsf_non_int_song_index_raises(self) -> None:
        songs = [{"index": 0, "label": "A"}]
        with self.assertRaises(WebValidationError):
            convert.validate_convert_options(convert.format_by_key("nsf"), songs, {"songIndex": "0"})

    def test_spc_loops_below_minimum_raises(self) -> None:
        songs = [{"index": 0, "label": "A"}]
        with self.assertRaises(WebValidationError):
            convert.validate_convert_options(convert.format_by_key("spc"), songs, {"loops": -1})

    def test_vgm_loops_and_duration_together_raises(self) -> None:
        with self.assertRaises(WebValidationError):
            convert.validate_convert_options(
                convert.format_by_key("vgm"), [], {"loops": 2, "durationSeconds": 30}
            )

    def test_vgm_accepts_loops_alone(self) -> None:
        options = convert.validate_convert_options(convert.format_by_key("vgm"), [], {"loops": 2})
        self.assertEqual(options["loops"], 2)
        self.assertIsNone(options["durationSeconds"])
        self.assertEqual(options["tempo"], 120)

    def test_chip_noise_appears_in_nsf_and_vgm_schemas(self) -> None:
        nsf_names = {field["name"] for field in convert.option_schema(convert.format_by_key("nsf"))}
        spc_names = {field["name"] for field in convert.option_schema(convert.format_by_key("spc"))}
        vgm_names = {field["name"] for field in convert.option_schema(convert.format_by_key("vgm"))}
        self.assertIn("chipNoise", nsf_names)
        self.assertNotIn("chipNoise", spc_names)
        self.assertIn("chipNoise", vgm_names)

    def test_chip_noise_defaults_false(self) -> None:
        songs = [{"index": 0, "label": "A"}]
        options = convert.validate_convert_options(convert.format_by_key("nsf"), songs, {})
        self.assertFalse(options["chipNoise"])
        vgm_options = convert.validate_convert_options(convert.format_by_key("vgm"), [], {})
        self.assertFalse(vgm_options["chipNoise"])

    def test_ch3_special_percussion_is_vgm_only_and_defaults_false(self) -> None:
        nsf_names = {field["name"] for field in convert.option_schema(convert.format_by_key("nsf"))}
        spc_names = {field["name"] for field in convert.option_schema(convert.format_by_key("spc"))}
        vgm_names = {field["name"] for field in convert.option_schema(convert.format_by_key("vgm"))}
        self.assertNotIn("ch3SpecialPercussion", nsf_names)
        self.assertNotIn("ch3SpecialPercussion", spc_names)
        self.assertIn("ch3SpecialPercussion", vgm_names)

        options = convert.validate_convert_options(convert.format_by_key("vgm"), [], {})
        self.assertFalse(options["ch3SpecialPercussion"])
        field = next(
            item
            for item in convert.option_schema(convert.format_by_key("vgm"))
            if item["name"] == "ch3SpecialPercussion"
        )
        self.assertEqual(field["label"], "OPN Ch3 SpecialをGMドラムに変換")
        self.assertIn("YM2203/YM2608/YM2612", field["help"])

    def test_game_soundfont_is_spc_only(self) -> None:
        nsf_names = {field["name"] for field in convert.option_schema(convert.format_by_key("nsf"))}
        spc_names = {field["name"] for field in convert.option_schema(convert.format_by_key("spc"))}
        vgm_names = {field["name"] for field in convert.option_schema(convert.format_by_key("vgm"))}
        self.assertNotIn("gameSoundfont", nsf_names)
        self.assertIn("gameSoundfont", spc_names)
        self.assertNotIn("gameSoundfont", vgm_names)

    def test_game_soundfont_defaults_false(self) -> None:
        songs = [{"index": 0, "label": "A"}]
        options = convert.validate_convert_options(convert.format_by_key("spc"), songs, {})
        self.assertFalse(options["gameSoundfont"])

    def test_game_soundfont_explicit_false_is_respected(self) -> None:
        songs = [{"index": 0, "label": "A"}]
        options = convert.validate_convert_options(
            convert.format_by_key("spc"), songs, {"gameSoundfont": False}
        )
        self.assertFalse(options["gameSoundfont"])

    def test_game_soundfont_explicit_true_is_respected(self) -> None:
        songs = [{"index": 0, "label": "A"}]
        options = convert.validate_convert_options(
            convert.format_by_key("spc"), songs, {"gameSoundfont": True}
        )
        self.assertTrue(options["gameSoundfont"])

    def test_vgm_timing_fields_share_layout_group(self) -> None:
        schema = convert.option_schema(convert.format_by_key("vgm"))
        timing_fields = [
            field["name"] for field in schema if field.get("layoutGroup") == "timing"
        ]
        self.assertEqual(timing_fields, ["tempo", "loops", "durationSeconds"])

        for format_key in ("nsf", "spc"):
            self.assertFalse(
                any(
                    field.get("layoutGroup") == "timing"
                    for field in convert.option_schema(convert.format_by_key(format_key))
                )
            )


class TestBuildArgv(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # このリポジトリ自身のパスがスペースと '&' を含むのと同じ状況を再現する。
        self.source_path = Path(self.tmp.name) / "a & b.nsf"
        self.output_path = Path(self.tmp.name) / "a & b.mid"

    def test_nsf_argv_shape(self) -> None:
        argv = convert._build_argv(
            convert.format_by_key("nsf"),
            self.source_path,
            self.output_path,
            {"songIndex": 2, "durationSeconds": 30, "forcePal": True},
        )
        self.assertIn("-t", argv)
        self.assertEqual(argv[argv.index("-t") + 1], "2")
        self.assertIn("-d", argv)
        self.assertEqual(argv[argv.index("-d") + 1], "30")
        self.assertIn("--pal", argv)
        self.assertIn("--track-metadata", argv)
        expected_metadata = str(convert.nsf_chip_metadata_path_for(self.output_path))
        self.assertEqual(argv[argv.index("--track-metadata") + 1], expected_metadata)
        self.assertEqual(argv[-2], str(self.source_path))
        self.assertEqual(argv[-1], str(self.output_path))

    def test_spc_argv_shape(self) -> None:
        argv = convert._build_argv(
            convert.format_by_key("spc"),
            self.source_path,
            self.output_path,
            {"songIndex": 1, "loops": 3},
        )
        self.assertIn("-s", argv)
        self.assertEqual(argv[argv.index("-s") + 1], "1")
        self.assertIn("--loops", argv)
        self.assertEqual(argv[argv.index("--loops") + 1], "3")
        self.assertEqual(argv[-2], str(self.source_path))
        self.assertEqual(argv[-1], str(self.output_path))

    def test_vgm_argv_shape_uses_output_flag(self) -> None:
        argv = convert._build_argv(
            convert.format_by_key("vgm"),
            self.source_path,
            self.output_path,
            {"tempo": 140, "loops": 2, "durationSeconds": None},
        )
        self.assertIn("-o", argv)
        self.assertEqual(argv[argv.index("-o") + 1], str(self.output_path))
        self.assertIn("--loops", argv)
        self.assertNotIn("--duration", argv)
        self.assertEqual(argv[-1], str(self.source_path))

    def test_vgm_argv_uses_duration_when_loops_absent(self) -> None:
        argv = convert._build_argv(
            convert.format_by_key("vgm"),
            self.source_path,
            self.output_path,
            {"tempo": 120, "loops": None, "durationSeconds": 45},
        )
        self.assertIn("--duration", argv)
        self.assertEqual(argv[argv.index("--duration") + 1], "45")
        self.assertNotIn("--loops", argv)

    def test_nsf_argv_always_requests_track_metadata_regardless_of_chip_noise(self) -> None:
        # chipNoiseはトラックごとの音源選択(web.py側の"game"プリセレクト)を
        # 切り替えるだけのPython側フラグになり、argv自体には影響しない
        # （VGMの--track-metadataと同じ設計）。--chip-wav(旧経路)はもう呼ばない。
        for chip_noise in (True, False):
            argv = convert._build_argv(
                convert.format_by_key("nsf"),
                self.source_path,
                self.output_path,
                {"songIndex": 0, "chipNoise": chip_noise},
            )
            self.assertNotIn("--chip-wav", argv)
            self.assertIn("--track-metadata", argv)
            expected_metadata = str(convert.nsf_chip_metadata_path_for(self.output_path))
            self.assertEqual(argv[argv.index("--track-metadata") + 1], expected_metadata)

    def test_vgm_argv_adds_noise_wav_when_chip_noise_enabled(self) -> None:
        argv = convert._build_argv(
            convert.format_by_key("vgm"),
            self.source_path,
            self.output_path,
            {"tempo": 120, "loops": None, "durationSeconds": None, "chipNoise": True},
        )
        self.assertIn("--noise-wav", argv)
        expected_stem = str(convert.chip_stem_path_for(self.output_path))
        self.assertEqual(argv[argv.index("--noise-wav") + 1], expected_stem)
        self.assertIn("--keep-noise-midi", argv)

    def test_vgm_argv_adds_dac_wav_alongside_noise_wav_when_chip_noise_enabled(self) -> None:
        # chipNoiseは1つのチェックボックスだが、vgm2midi側は--noise-wav（SN76489/
        # HuC6280）と--dac-wav（YM2612 DAC）が独立したCLIオプションなので、両方を
        # 常に一緒に渡す（曲にそのチャンネルが無ければvgm2midi側がステムを作らないだけ）。
        argv = convert._build_argv(
            convert.format_by_key("vgm"),
            self.source_path,
            self.output_path,
            {"tempo": 120, "loops": None, "durationSeconds": None, "chipNoise": True},
        )
        self.assertIn("--dac-wav", argv)
        expected_stem = str(convert.dac_stem_path_for(self.output_path))
        self.assertEqual(argv[argv.index("--dac-wav") + 1], expected_stem)
        self.assertIn("--keep-dac-midi", argv)

    def test_vgm_argv_always_requests_libvgm_track_metadata(self) -> None:
        argv = convert._build_argv(
            convert.format_by_key("vgm"),
            self.source_path,
            self.output_path,
            {"tempo": 120, "loops": None, "durationSeconds": None, "chipNoise": False},
        )
        self.assertIn("--track-metadata", argv)
        self.assertEqual(
            argv[argv.index("--track-metadata") + 1],
            str(self.output_path.with_name(self.output_path.stem + ".libvgm.json")),
        )

    def test_vgm_argv_omits_noise_and_dac_wav_when_chip_noise_disabled(self) -> None:
        argv = convert._build_argv(
            convert.format_by_key("vgm"),
            self.source_path,
            self.output_path,
            {"tempo": 120, "loops": None, "durationSeconds": None, "chipNoise": False},
        )
        self.assertNotIn("--noise-wav", argv)
        self.assertNotIn("--dac-wav", argv)

    def test_vgm_argv_adds_ch3_special_percussion_when_enabled(self) -> None:
        argv = convert._build_argv(
            convert.format_by_key("vgm"),
            self.source_path,
            self.output_path,
            {
                "tempo": 120,
                "loops": None,
                "durationSeconds": None,
                "ch3SpecialPercussion": True,
            },
        )
        self.assertIn("--ch3-special-percussion", argv)
        self.assertEqual(argv[-2], "--ch3-special-percussion")
        self.assertEqual(argv[-1], str(self.source_path))

    def test_vgm_argv_omits_ch3_special_percussion_when_disabled(self) -> None:
        argv = convert._build_argv(
            convert.format_by_key("vgm"),
            self.source_path,
            self.output_path,
            {
                "tempo": 120,
                "loops": None,
                "durationSeconds": None,
                "ch3SpecialPercussion": False,
            },
        )
        self.assertNotIn("--ch3-special-percussion", argv)


    def test_spc_argv_always_adds_sf2_when_game_soundfont_enabled(self) -> None:
        argv = convert._build_argv(
            convert.format_by_key("spc"),
            self.source_path,
            self.output_path,
            {"songIndex": 0, "loops": 1, "gameSoundfont": True},
        )
        self.assertIn("--sf2", argv)
        # --sf2 は位置引数（source/output）より前に入る。
        self.assertLess(argv.index("--sf2"), len(argv) - 2)
        self.assertEqual(argv[-2], str(self.source_path))
        self.assertEqual(argv[-1], str(self.output_path))

    def test_spc_argv_always_adds_sf2_even_when_game_soundfont_disabled(self) -> None:
        # gameSoundfontは「音符のある全トラックを初期選択するか」だけを制御し、
        # SoundFont自体の生成（--sf2）はNSF/VGMの--track-metadataと同じく常に
        # 要求する。これにより変換後いつでもトラックごとに"game"を選べる。
        argv = convert._build_argv(
            convert.format_by_key("spc"),
            self.source_path,
            self.output_path,
            {"songIndex": 0, "loops": 1, "gameSoundfont": False},
        )
        self.assertIn("--sf2", argv)


class TestChipStemPathFor(unittest.TestCase):
    def test_derives_sibling_chip_wav_path(self) -> None:
        output_path = Path("/tmp/some dir/converted.mid")
        stem_path = convert.chip_stem_path_for(output_path)
        self.assertEqual(stem_path, Path("/tmp/some dir/converted.chip.wav"))


class TestGameSoundfontPathFor(unittest.TestCase):
    def test_derives_sibling_sf2_path(self) -> None:
        output_path = Path("/tmp/some dir/converted.mid")
        sf2_path = convert.game_soundfont_path_for(output_path)
        self.assertEqual(sf2_path, Path("/tmp/some dir/converted.sf2"))


class TestProducedGameSoundfont(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.output_path = Path(self.tmp.name) / "converted.mid"
        self.sf2_path = convert.game_soundfont_path_for(self.output_path)

    def test_returns_none_when_sf2_not_produced(self) -> None:
        result = convert.produced_game_soundfont(self.output_path)
        self.assertIsNone(result)

    def test_returns_none_when_sf2_too_small(self) -> None:
        self.sf2_path.write_bytes(b"0" * 10)
        result = convert.produced_game_soundfont(self.output_path)
        self.assertIsNone(result)

    def test_returns_path_when_sf2_produced(self) -> None:
        self.sf2_path.write_bytes(b"0" * 100)
        result = convert.produced_game_soundfont(self.output_path)
        self.assertEqual(result, self.sf2_path)


class TestConvertToMidi(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source_path = Path(self.tmp.name) / "a & b.spc"
        self.source_path.write_bytes(b"fake-spc")
        self.output_path = Path(self.tmp.name) / "a & b.mid"

    def _fake_success_run(self):
        def fake_run(argv, **kwargs):
            self.output_path.write_bytes(b"fake-midi-bytes")
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        return fake_run

    def test_success_writes_output(self) -> None:
        with mock.patch("miditrack.convert.subprocess.run", side_effect=self._fake_success_run()) as mocked:
            convert.convert_to_midi(
                convert.format_by_key("spc"), self.source_path, self.output_path, {"songIndex": 0, "loops": 1}
            )
        self.assertTrue(self.output_path.exists())
        argv, kwargs = mocked.call_args
        self.assertIsInstance(argv[0], list)
        self.assertFalse(kwargs.get("shell", False))

    def test_spc_no_driver_exit_code_raises_dedicated_message(self) -> None:
        def fake_run(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 3, stdout="", stderr="")

        with mock.patch("miditrack.convert.subprocess.run", side_effect=fake_run):
            with self.assertRaises(ConvertError) as ctx:
                convert.convert_to_midi(
                    convert.format_by_key("spc"), self.source_path, self.output_path, {"songIndex": 0, "loops": 1}
                )
        self.assertIn("ドライバ", str(ctx.exception))

    def test_non_zero_exit_includes_stderr(self) -> None:
        def fake_run(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 1, stdout="", stderr="conversion failed\n")

        with mock.patch("miditrack.convert.subprocess.run", side_effect=fake_run):
            with self.assertRaises(ConvertError) as ctx:
                convert.convert_to_midi(
                    convert.format_by_key("spc"), self.source_path, self.output_path, {"songIndex": 0, "loops": 1}
                )
        self.assertIn("conversion failed", str(ctx.exception))

    def test_missing_output_raises(self) -> None:
        def fake_run(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        with mock.patch("miditrack.convert.subprocess.run", side_effect=fake_run):
            with self.assertRaises(ConvertError):
                convert.convert_to_midi(
                    convert.format_by_key("spc"), self.source_path, self.output_path, {"songIndex": 0, "loops": 1}
                )

    def test_file_not_found_raises(self) -> None:
        with mock.patch("miditrack.convert.subprocess.run", side_effect=FileNotFoundError()):
            with self.assertRaises(ConvertError):
                convert.convert_to_midi(
                    convert.format_by_key("spc"), self.source_path, self.output_path, {"songIndex": 0, "loops": 1}
                )

    def test_timeout_raises(self) -> None:
        with mock.patch(
            "miditrack.convert.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="spc2midi", timeout=300),
        ):
            with self.assertRaises(ConvertError):
                convert.convert_to_midi(
                    convert.format_by_key("spc"), self.source_path, self.output_path, {"songIndex": 0, "loops": 1}
                )

    def test_space_and_ampersand_path_survives_unmangled(self) -> None:
        with mock.patch("miditrack.convert.subprocess.run", side_effect=self._fake_success_run()) as mocked:
            convert.convert_to_midi(
                convert.format_by_key("spc"), self.source_path, self.output_path, {"songIndex": 0, "loops": 1}
            )
        (argv,), _ = mocked.call_args
        self.assertIn(str(self.source_path), argv)
        self.assertIn(str(self.output_path), argv)


class TestConvertToMidiChipNoise(unittest.TestCase):
    """chipNoise（実機ノイズ/DPCMステム）オプション周りの挙動。"""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source_path = Path(self.tmp.name) / "a & b.nsf"
        self.source_path.write_bytes(b"fake-nsf")
        self.output_path = Path(self.tmp.name) / "converted.mid"
        self.stem_path = convert.chip_stem_path_for(self.output_path)
        self.dac_stem_path = convert.dac_stem_path_for(self.output_path)

    def _fake_run_writing_stem(self, stem_size: int = 100):
        # NSFの_build_argv()はもう--chip-wavを要求しない（常に--track-metadataの
        # みを渡す）。convert_to_midi()の produced() チェック自体は「固定パスに
        # ステムが実在するか」だけを見る後方互換の安全網なので、ここではargvの
        # 内容を見ず無条件でconverted.midと同じ固定パス(chip_stem_path_for)へ
        # 書き込む — sidecarを書かない旧nsf2midiバイナリが従来どおり
        # converted.chip.wav を残した状況を再現する。
        def fake_run(argv, **kwargs):
            self.output_path.write_bytes(b"fake-midi-bytes")
            self.stem_path.write_bytes(b"0" * stem_size)
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        return fake_run

    def _fake_run_not_writing_stem(self):
        def fake_run(argv, **kwargs):
            self.output_path.write_bytes(b"fake-midi-bytes")
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        return fake_run

    def _fake_run_writing_vgm_stems(self, write_noise: bool = True, write_dac: bool = True):
        # vgm2midiは--noise-wav（SN76489/HuC6280）と--dac-wav（YM2612 DAC）を独立して
        # 生成する（曲にそのチャンネルが無ければ該当ステムだけを作らない）ので、
        # 両方/片方/どちらも無し、を個別に再現できるようにする。
        def fake_run(argv, **kwargs):
            self.output_path.write_bytes(b"fake-midi-bytes")
            if write_noise and "--noise-wav" in argv:
                Path(argv[argv.index("--noise-wav") + 1]).write_bytes(b"0" * 100)
            if write_dac and "--dac-wav" in argv:
                Path(argv[argv.index("--dac-wav") + 1]).write_bytes(b"0" * 100)
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        return fake_run

    def test_returns_legacy_stem_path_when_produced_by_old_binary(self) -> None:
        # sidecar(--track-metadata)を書かない旧nsf2midiバイナリと接続した場合の
        # 後方互換経路: convert_to_midi()は固定パスに実在するステムをそのまま
        # 返す（新経路ではPython側はargvで--chip-wavを一切要求しない）。
        with mock.patch("miditrack.convert.subprocess.run", side_effect=self._fake_run_writing_stem()):
            result = convert.convert_to_midi(
                convert.format_by_key("nsf"),
                self.source_path,
                self.output_path,
                {"songIndex": 0, "chipNoise": True},
            )
        self.assertEqual(result, (self.stem_path, None))

    def test_returns_both_vgm_stems_when_both_produced(self) -> None:
        self.source_path = Path(self.tmp.name) / "a & b.vgm"
        self.source_path.write_bytes(b"fake-vgm")

        with mock.patch(
            "miditrack.convert.subprocess.run", side_effect=self._fake_run_writing_vgm_stems()
        ):
            result = convert.convert_to_midi(
                convert.format_by_key("vgm"),
                self.source_path,
                self.output_path,
                {"tempo": 120, "loops": None, "durationSeconds": None, "chipNoise": True},
            )
        self.assertEqual(result, (self.stem_path, self.dac_stem_path))

    def test_returns_noise_only_when_source_has_no_dac_activity(self) -> None:
        self.source_path = Path(self.tmp.name) / "a & b.vgm"
        self.source_path.write_bytes(b"fake-vgm")

        with mock.patch(
            "miditrack.convert.subprocess.run",
            side_effect=self._fake_run_writing_vgm_stems(write_dac=False),
        ):
            result = convert.convert_to_midi(
                convert.format_by_key("vgm"),
                self.source_path,
                self.output_path,
                {"tempo": 120, "loops": None, "durationSeconds": None, "chipNoise": True},
            )
        self.assertEqual(result, (self.stem_path, None))

    def test_returns_dac_only_when_source_has_no_psg_noise_activity(self) -> None:
        self.source_path = Path(self.tmp.name) / "a & b.vgm"
        self.source_path.write_bytes(b"fake-vgm")

        with mock.patch(
            "miditrack.convert.subprocess.run",
            side_effect=self._fake_run_writing_vgm_stems(write_noise=False),
        ):
            result = convert.convert_to_midi(
                convert.format_by_key("vgm"),
                self.source_path,
                self.output_path,
                {"tempo": 120, "loops": None, "durationSeconds": None, "chipNoise": True},
            )
        self.assertEqual(result, (None, self.dac_stem_path))

    def test_returns_none_when_chip_noise_disabled(self) -> None:
        with mock.patch("miditrack.convert.subprocess.run", side_effect=self._fake_run_writing_stem()):
            result = convert.convert_to_midi(
                convert.format_by_key("nsf"),
                self.source_path,
                self.output_path,
                {"songIndex": 0, "chipNoise": False},
            )
        self.assertEqual(result, (None, None))

    def test_returns_none_when_stem_not_actually_produced(self) -> None:
        with mock.patch("miditrack.convert.subprocess.run", side_effect=self._fake_run_not_writing_stem()):
            result = convert.convert_to_midi(
                convert.format_by_key("nsf"),
                self.source_path,
                self.output_path,
                {"songIndex": 0, "chipNoise": True},
            )
        self.assertEqual(result, (None, None))

    def test_returns_none_when_stem_is_too_small(self) -> None:
        with mock.patch(
            "miditrack.convert.subprocess.run", side_effect=self._fake_run_writing_stem(stem_size=10)
        ):
            result = convert.convert_to_midi(
                convert.format_by_key("nsf"),
                self.source_path,
                self.output_path,
                {"songIndex": 0, "chipNoise": True},
            )
        self.assertEqual(result, (None, None))

    def test_stale_stem_from_previous_conversion_is_removed_before_running(self) -> None:
        # 前回変換のステムが残っている状態を再現する。今回の変換器はステムを
        # 生成しない（古いnsf2midiバイナリ、または chipNoise が有効でも
        # 何らかの理由で生成されなかった状況を想定）。noise/DAC両方のステムで検証する。
        self.stem_path.write_bytes(b"stale-stem-from-previous-song" * 10)
        self.dac_stem_path.write_bytes(b"stale-dac-stem-from-previous-song" * 10)
        self.assertTrue(self.stem_path.exists())
        self.assertTrue(self.dac_stem_path.exists())

        with mock.patch("miditrack.convert.subprocess.run", side_effect=self._fake_run_not_writing_stem()):
            result = convert.convert_to_midi(
                convert.format_by_key("nsf"),
                self.source_path,
                self.output_path,
                {"songIndex": 0, "chipNoise": True},
            )
        # 古いステムは消え、「前の曲のノイズ/DAC」として誤って返されることはない。
        self.assertFalse(self.stem_path.exists())
        self.assertFalse(self.dac_stem_path.exists())
        self.assertEqual(result, (None, None))


class TestConvertToMidiGameSoundfont(unittest.TestCase):
    """gameSoundfont（spc2midi --sf2 によるゲーム由来SoundFont生成）周りの挙動。"""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source_path = Path(self.tmp.name) / "a & b.spc"
        self.source_path.write_bytes(b"fake-spc")
        self.output_path = Path(self.tmp.name) / "converted.mid"
        self.sf2_path = convert.game_soundfont_path_for(self.output_path)

    def test_stale_sf2_from_previous_conversion_is_removed_before_running(self) -> None:
        # 前回変換のSF2が残っている状態を再現する。今回の変換器はSF2を生成しない
        # （instrSets()が空、またはgameSoundfontが有効でも何らかの理由で
        # 生成されなかった状況を想定）。
        self.sf2_path.write_bytes(b"stale-sf2-from-previous-song" * 10)
        self.assertTrue(self.sf2_path.exists())

        def fake_run(argv, **kwargs):
            self.output_path.write_bytes(b"fake-midi-bytes")
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        with mock.patch("miditrack.convert.subprocess.run", side_effect=fake_run):
            convert.convert_to_midi(
                convert.format_by_key("spc"),
                self.source_path,
                self.output_path,
                {"songIndex": 0, "loops": 1, "gameSoundfont": True},
            )
        # 古いSF2は消え、「前の曲の音色」として誤って使われることはない。
        self.assertFalse(self.sf2_path.exists())


class TestTryDetectFormatAndPredicates(unittest.TestCase):
    def test_try_detect_format_returns_none_for_unsupported(self) -> None:
        self.assertIsNone(convert.try_detect_format("readme.txt"))
        self.assertIsNone(convert.try_detect_format("archive.zip"))
        self.assertIsNone(convert.try_detect_format("playlist.m3u"))

    def test_try_detect_format_matches_detect_format(self) -> None:
        self.assertIs(convert.try_detect_format("song.nsf"), convert.detect_format("song.nsf"))

    def test_is_zip_filename(self) -> None:
        self.assertTrue(convert.is_zip_filename("collection.ZIP"))
        self.assertFalse(convert.is_zip_filename("song.nsf"))

    def test_is_m3u_filename(self) -> None:
        self.assertTrue(convert.is_m3u_filename("playlist.m3u"))
        self.assertTrue(convert.is_m3u_filename("playlist.M3U8"))
        self.assertFalse(convert.is_m3u_filename("song.nsf"))


M3U_SAMPLE = """#EXTM3U
# Game: Castlevania
Castlevania.nsf::NSF,1,Vampire Killer
Castlevania.nsf::NSF,2,Stalker,2:30
,3,Bloody Tears
Castlevania.nsf,4,Wicked Child, Pt. 2
Castlevania.nsf::NSF,$a,Heart of Fire
OtherGame.nsf,1,Unrelated Song
"""


class TestParseM3u(unittest.TestCase):
    def test_parses_filename_track_and_name(self) -> None:
        entries = convert.parse_m3u(M3U_SAMPLE)
        self.assertEqual(len(entries), 6)
        self.assertEqual(entries[0].file, "Castlevania.nsf")
        self.assertEqual(entries[0].file_type, "NSF")
        self.assertEqual(entries[0].track, 1)
        self.assertEqual(entries[0].name, "Vampire Killer")

    def test_comma_inside_title_is_preserved(self) -> None:
        entries = convert.parse_m3u(M3U_SAMPLE)
        wicked = next(e for e in entries if e.track == 4)
        self.assertEqual(wicked.name, "Wicked Child, Pt. 2")

    def test_hex_track_number(self) -> None:
        entries = convert.parse_m3u(M3U_SAMPLE)
        heart = next(e for e in entries if e.name == "Heart of Fire")
        self.assertEqual(heart.track, 10)

    def test_blank_filename_inherits_previous_file(self) -> None:
        entries = convert.parse_m3u(M3U_SAMPLE)
        bloody_tears = next(e for e in entries if e.track == 3)
        self.assertEqual(bloody_tears.file, "Castlevania.nsf")

    def test_comment_and_blank_lines_are_ignored(self) -> None:
        entries = convert.parse_m3u("# just a comment\n\n\n")
        self.assertEqual(entries, [])

    def test_plain_m3u_without_type_suffix(self) -> None:
        entries = convert.parse_m3u("song.spc,1,Intro\nsong.spc,2,Battle Theme\n")
        self.assertEqual([e.name for e in entries], ["Intro", "Battle Theme"])
        self.assertEqual(entries[0].file_type, "")


class TestFilterM3uEntries(unittest.TestCase):
    def test_filters_by_basename_case_insensitive(self) -> None:
        entries = convert.parse_m3u(M3U_SAMPLE)
        filtered = convert.filter_m3u_entries(entries, "CASTLEVANIA.NSF")
        self.assertEqual(len(filtered), 5)
        self.assertTrue(all(e.file == "Castlevania.nsf" for e in filtered))

    def test_ignores_unrelated_file(self) -> None:
        entries = convert.parse_m3u(M3U_SAMPLE)
        filtered = convert.filter_m3u_entries(entries, "NoSuchGame.nsf")
        self.assertEqual(filtered, [])


class TestApplyM3uTitles(unittest.TestCase):
    def test_applies_titles_by_track_number(self) -> None:
        songs = [{"index": i, "label": f"Track {i}"} for i in range(5)]
        entries = convert.filter_m3u_entries(convert.parse_m3u(M3U_SAMPLE), "Castlevania.nsf")
        updated = convert.apply_m3u_titles(songs, entries)
        self.assertEqual(updated[0]["label"], "Vampire Killer")
        self.assertEqual(updated[1]["label"], "Stalker")
        self.assertEqual(updated[2]["label"], "Bloody Tears")
        self.assertEqual(updated[3]["label"], "Wicked Child, Pt. 2")
        # track=10 (0-indexed 9) is out of range for a 5-song list; ignored safely.
        self.assertEqual(updated[4]["label"], "Track 4")

    def test_falls_back_to_ordinal_when_track_missing(self) -> None:
        entries = [
            convert.M3uEntry(file="a.nsf", file_type="", track=None, name="First"),
            convert.M3uEntry(file="a.nsf", file_type="", track=None, name="Second"),
        ]
        songs = [{"index": 0, "label": "Track 0"}, {"index": 1, "label": "Track 1"}]
        updated = convert.apply_m3u_titles(songs, entries)
        self.assertEqual(updated[0]["label"], "First")
        self.assertEqual(updated[1]["label"], "Second")

    def test_no_entries_returns_songs_unchanged(self) -> None:
        songs = [{"index": 0, "label": "Track 0"}]
        self.assertEqual(convert.apply_m3u_titles(songs, []), songs)

    def test_does_not_mutate_input_songs(self) -> None:
        songs = [{"index": 0, "label": "Track 0"}]
        entries = [convert.M3uEntry(file="a.nsf", file_type="", track=1, name="Renamed")]
        convert.apply_m3u_titles(songs, entries)
        self.assertEqual(songs[0]["label"], "Track 0")


class TestExtractZipMembers(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def _make_zip(self, path: Path, members: dict[str, bytes]) -> None:
        with zipfile.ZipFile(path, "w") as zf:
            for name, data in members.items():
                zf.writestr(name, data)

    def test_extracts_files_preserving_relative_paths(self) -> None:
        zip_path = self.root / "songs.zip"
        self._make_zip(zip_path, {"a.nsf": b"AAA", "sub/b.spc": b"BBB"})
        dest = self.root / "out"
        extracted = convert.extract_zip_members(zip_path, dest)
        # dest_dir自体はresolve()前後で異なりうる（macOSの/var -> /private/var等の
        # シンボリックリンク）ため、比較側もresolve()してから相対化する。
        names = sorted(p.relative_to(dest.resolve()).as_posix() for p in extracted)
        self.assertEqual(names, ["a.nsf", "sub/b.spc"])
        self.assertEqual((dest / "a.nsf").read_bytes(), b"AAA")
        self.assertEqual((dest / "sub" / "b.spc").read_bytes(), b"BBB")

    def test_directory_entries_are_skipped(self) -> None:
        zip_path = self.root / "songs.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr(zipfile.ZipInfo("sub/"), "")
            zf.writestr("sub/a.nsf", b"AAA")
        extracted = convert.extract_zip_members(zip_path, self.root / "out")
        self.assertEqual(len(extracted), 1)

    def test_zip_slip_absolute_path_is_rejected(self) -> None:
        zip_path = self.root / "evil.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("/etc/evil.nsf", b"AAA")
        with self.assertRaises(WebValidationError):
            convert.extract_zip_members(zip_path, self.root / "out")

    def test_zip_slip_dotdot_path_is_rejected(self) -> None:
        zip_path = self.root / "evil.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("../evil.nsf", b"AAA")
        with self.assertRaises(WebValidationError):
            convert.extract_zip_members(zip_path, self.root / "out")

    def test_too_many_members_is_rejected(self) -> None:
        zip_path = self.root / "many.zip"
        members = {f"f{i}.nsf": b"x" for i in range(convert.MAX_ARCHIVE_MEMBERS + 1)}
        self._make_zip(zip_path, members)
        with self.assertRaises(WebValidationError):
            convert.extract_zip_members(zip_path, self.root / "out")

    def test_oversized_uncompressed_content_is_rejected(self) -> None:
        zip_path = self.root / "bomb.zip"
        with mock.patch.object(convert, "MAX_ARCHIVE_UNCOMPRESSED_BYTES", 10):
            self._make_zip(zip_path, {"a.nsf": b"x" * 100})
            with self.assertRaises(WebValidationError):
                convert.extract_zip_members(zip_path, self.root / "out")

    def test_invalid_zip_raises_validation_error(self) -> None:
        bad_zip = self.root / "bad.zip"
        bad_zip.write_bytes(b"not a real zip")
        with self.assertRaises(WebValidationError):
            convert.extract_zip_members(bad_zip, self.root / "out")


if __name__ == "__main__":
    unittest.main()
