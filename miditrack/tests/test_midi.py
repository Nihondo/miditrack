"""miditrack.midi のテスト。"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import mido

from miditrack import midi
from miditrack.errors import MidiTrackError, WebValidationError


def build_fixture(path: Path) -> None:
    """複数の編集可否パターンを1ファイルにまとめたフィクスチャを作る。"""
    mf = mido.MidiFile(ticks_per_beat=480)

    # Track 0: 単一チャンネル、既存プログラムチェンジあり（vgm2midi/nsf2midi(gm.mdf)相当）
    t0 = mido.MidiTrack()
    t0.append(mido.MetaMessage("track_name", name="Lead", time=0))
    t0.append(mido.Message("program_change", program=80, channel=0, time=0))
    t0.append(mido.Message("note_on", note=60, velocity=100, channel=0, time=0))
    t0.append(mido.Message("note_off", note=60, velocity=0, channel=0, time=480))
    mf.tracks.append(t0)

    # Track 1: パーカッションチャンネル(ch10=index9)
    t1 = mido.MidiTrack()
    t1.append(mido.MetaMessage("track_name", name="Noise", time=0))
    t1.append(mido.Message("note_on", note=42, velocity=100, channel=9, time=0))
    t1.append(mido.Message("note_off", note=42, velocity=0, channel=9, time=240))
    mf.tracks.append(t1)

    # Track 2: 単一チャンネル、既存プログラムチェンジなし
    t2 = mido.MidiTrack()
    t2.append(mido.MetaMessage("track_name", name="Bass", time=0))
    t2.append(mido.Message("note_on", note=36, velocity=90, channel=1, time=0))
    t2.append(mido.Message("note_off", note=36, velocity=0, channel=1, time=480))
    mf.tracks.append(t2)

    # Track 3: 複数チャンネル混在
    t3 = mido.MidiTrack()
    t3.append(mido.MetaMessage("track_name", name="Weird", time=0))
    t3.append(mido.Message("note_on", note=60, velocity=100, channel=2, time=0))
    t3.append(mido.Message("note_on", note=64, velocity=100, channel=3, time=0))
    mf.tracks.append(t3)

    # Track 4: ノート無し（テンポトラック）
    t4 = mido.MidiTrack()
    t4.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))
    mf.tracks.append(t4)

    mf.save(path)


def absolute_note_events(mf: mido.MidiFile) -> list[list[tuple]]:
    """各トラックのnote_on/note_offを絶対tickで抽出する（タイミング比較用）。"""
    result = []
    for track in mf.tracks:
        tick = 0
        events = []
        for message in track:
            tick += message.time
            if message.type in ("note_on", "note_off"):
                events.append((message.type, message.channel, message.note, tick))
        result.append(events)
    return result


class TestAnalyzeMidiFile(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fixture_path = Path(self.tmp.name) / "fixture.mid"
        build_fixture(self.fixture_path)

    def test_single_channel_track_is_editable(self) -> None:
        _, tracks = midi.analyze_midi_file(self.fixture_path)
        track = tracks[0]
        self.assertEqual(track.name, "Lead")
        self.assertEqual(track.channels, (0,))
        self.assertEqual(track.note_count, 1)
        self.assertTrue(track.editable)
        self.assertIsNone(track.reason)

    def test_percussion_channel_is_not_editable(self) -> None:
        _, tracks = midi.analyze_midi_file(self.fixture_path)
        track = tracks[1]
        self.assertFalse(track.editable)
        self.assertEqual(track.reason, "percussion")

    def test_multi_channel_track_is_not_editable(self) -> None:
        _, tracks = midi.analyze_midi_file(self.fixture_path)
        track = tracks[3]
        self.assertFalse(track.editable)
        self.assertEqual(track.reason, "multi-channel")

    def test_no_notes_track_is_listed_but_not_editable(self) -> None:
        _, tracks = midi.analyze_midi_file(self.fixture_path)
        track = tracks[4]
        self.assertFalse(track.editable)
        self.assertEqual(track.reason, "no-notes")
        self.assertEqual(track.note_count, 0)

    def test_existing_program_change_is_detected(self) -> None:
        # vgm2midiは全トラックにGM81(0-indexedで80)を送信済み、nsf2midiのgm.mdfも
        # チャンネルごとに音色を送信済み——「生成直後は空」という前提を置いてはいけない。
        _, tracks = midi.analyze_midi_file(self.fixture_path)
        track = tracks[0]
        self.assertEqual(track.current_program, 80)
        self.assertEqual(track.program_change_count, 1)

    def test_no_existing_program_change_is_none(self) -> None:
        _, tracks = midi.analyze_midi_file(self.fixture_path)
        track = tracks[2]
        self.assertIsNone(track.current_program)
        self.assertEqual(track.program_change_count, 0)

    def test_missing_file_raises(self) -> None:
        with self.assertRaises(MidiTrackError):
            midi.analyze_midi_file(Path(self.tmp.name) / "nope.mid")

    def test_empty_note_file_raises(self) -> None:
        mf = mido.MidiFile(ticks_per_beat=480)
        track = mido.MidiTrack()
        track.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))
        mf.tracks.append(track)
        empty_path = Path(self.tmp.name) / "empty.mid"
        mf.save(empty_path)
        with self.assertRaises(MidiTrackError):
            midi.analyze_midi_file(empty_path)


def build_cc7_fixture(path: Path) -> None:
    """変換元CC7（音量）検出のためのフィクスチャ。

    Track 0: 単一チャンネル(0)独占、CC7=64（減衰、採用されるはず）。
    Track 1: 単一チャンネル(1)独占、CC7=110（増幅、採用されないはず＝100のまま）。
    Track 2/3: チャンネル2を共有する2トラック。それぞれCC7=50/80を持つが、
               共有チャンネルのため両方とも採用されず100のまま。
    Track 4: パーカッションチャンネル(9)を単独占有、CC7=64（editable=Falseでも
             採用されるはず — 音量とプログラムチェンジ編集可否は独立）。
    Track 5: 単一チャンネル(3)独占、CC7が時間とともに64→32へ変化する
             （apply_assignments()の再スケールテスト用）。
    """
    mf = mido.MidiFile(ticks_per_beat=480)

    t0 = mido.MidiTrack()
    t0.append(mido.MetaMessage("track_name", name="Quiet", time=0))
    t0.append(mido.Message("control_change", control=7, value=64, channel=0, time=0))
    t0.append(mido.Message("note_on", note=60, velocity=100, channel=0, time=0))
    t0.append(mido.Message("note_off", note=60, velocity=0, channel=0, time=480))
    mf.tracks.append(t0)

    t1 = mido.MidiTrack()
    t1.append(mido.MetaMessage("track_name", name="Loud", time=0))
    t1.append(mido.Message("control_change", control=7, value=110, channel=1, time=0))
    t1.append(mido.Message("note_on", note=60, velocity=100, channel=1, time=0))
    t1.append(mido.Message("note_off", note=60, velocity=0, channel=1, time=480))
    mf.tracks.append(t1)

    t2 = mido.MidiTrack()
    t2.append(mido.MetaMessage("track_name", name="Shared A", time=0))
    t2.append(mido.Message("control_change", control=7, value=50, channel=2, time=0))
    t2.append(mido.Message("note_on", note=60, velocity=100, channel=2, time=0))
    t2.append(mido.Message("note_off", note=60, velocity=0, channel=2, time=480))
    mf.tracks.append(t2)

    t3 = mido.MidiTrack()
    t3.append(mido.MetaMessage("track_name", name="Shared B", time=0))
    t3.append(mido.Message("control_change", control=7, value=80, channel=2, time=0))
    t3.append(mido.Message("note_on", note=64, velocity=100, channel=2, time=0))
    t3.append(mido.Message("note_off", note=64, velocity=0, channel=2, time=480))
    mf.tracks.append(t3)

    t4 = mido.MidiTrack()
    t4.append(mido.MetaMessage("track_name", name="Drums", time=0))
    t4.append(mido.Message("control_change", control=7, value=64, channel=9, time=0))
    t4.append(mido.Message("note_on", note=42, velocity=100, channel=9, time=0))
    t4.append(mido.Message("note_off", note=42, velocity=0, channel=9, time=240))
    mf.tracks.append(t4)

    t5 = mido.MidiTrack()
    t5.append(mido.MetaMessage("track_name", name="Fading", time=0))
    t5.append(mido.Message("control_change", control=7, value=64, channel=3, time=0))
    t5.append(mido.Message("note_on", note=60, velocity=100, channel=3, time=0))
    t5.append(mido.Message("control_change", control=7, value=32, channel=3, time=240))
    t5.append(mido.Message("note_off", note=60, velocity=0, channel=3, time=240))
    mf.tracks.append(t5)

    mf.save(path)


class TestSourceVolumePercent(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fixture_path = Path(self.tmp.name) / "cc7.mid"
        build_cc7_fixture(self.fixture_path)
        _, self.tracks = midi.analyze_midi_file(self.fixture_path)

    def test_attenuating_cc7_on_exclusive_channel_is_adopted(self) -> None:
        self.assertEqual(self.tracks[0].source_volume_percent, 64)

    def test_amplifying_cc7_is_not_adopted(self) -> None:
        self.assertEqual(self.tracks[1].source_volume_percent, 100)

    def test_cc7_on_shared_channel_is_not_adopted(self) -> None:
        self.assertEqual(self.tracks[2].source_volume_percent, 100)
        self.assertEqual(self.tracks[3].source_volume_percent, 100)

    def test_percussion_channel_cc7_is_still_adopted(self) -> None:
        # 音量の採用可否はプログラムチェンジの編集可否（editable）とは独立。
        track = self.tracks[4]
        self.assertFalse(track.editable)
        self.assertEqual(track.source_volume_percent, 64)

    def test_no_cc7_defaults_to_100(self) -> None:
        # 既存フィクスチャ（build_fixture）にはCC7が無く、全トラック既定値のまま。
        other_path = Path(self.tmp.name) / "plain.mid"
        build_fixture(other_path)
        _, tracks = midi.analyze_midi_file(other_path)
        for track in tracks:
            self.assertEqual(track.source_volume_percent, 100)


class TestValidateAssignments(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fixture_path = Path(self.tmp.name) / "fixture.mid"
        build_fixture(self.fixture_path)
        _, self.tracks = midi.analyze_midi_file(self.fixture_path)

    def test_valid_assignment(self) -> None:
        result = midi.validate_assignments(self.tracks, {0: 30, 2: None})
        self.assertEqual(result, {0: 30})

    def test_unknown_track_raises(self) -> None:
        with self.assertRaises(WebValidationError):
            midi.validate_assignments(self.tracks, {99: 5})

    def test_non_editable_track_raises(self) -> None:
        with self.assertRaises(WebValidationError):
            midi.validate_assignments(self.tracks, {1: 5})  # percussion
        with self.assertRaises(WebValidationError):
            midi.validate_assignments(self.tracks, {3: 5})  # multi-channel
        with self.assertRaises(WebValidationError):
            midi.validate_assignments(self.tracks, {4: 5})  # no-notes

    def test_out_of_range_program_raises(self) -> None:
        with self.assertRaises(WebValidationError):
            midi.validate_assignments(self.tracks, {0: -1})
        with self.assertRaises(WebValidationError):
            midi.validate_assignments(self.tracks, {0: 128})

    def test_non_int_program_raises(self) -> None:
        with self.assertRaises(WebValidationError):
            midi.validate_assignments(self.tracks, {0: "x"})  # type: ignore[dict-item]


class TestValidateVolumes(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fixture_path = Path(self.tmp.name) / "fixture.mid"
        build_fixture(self.fixture_path)
        _, self.tracks = midi.analyze_midi_file(self.fixture_path)

    def test_accepts_melodic_percussion_and_multi_channel_tracks(self) -> None:
        result = midi.validate_volumes(self.tracks, {0: 50, 1: 0, 3: 200})
        self.assertEqual(result, {0: 50, 1: 0, 3: 200})

    def test_default_and_none_are_removed(self) -> None:
        self.assertEqual(midi.validate_volumes(self.tracks, {0: 100, 1: None}), {})

    def test_no_note_track_is_rejected(self) -> None:
        with self.assertRaises(WebValidationError):
            midi.validate_volumes(self.tracks, {4: 50})

    def test_out_of_range_and_non_integer_values_are_rejected(self) -> None:
        for value in (-1, 201, 50.5, True):
            with self.subTest(value=value), self.assertRaises(WebValidationError):
                midi.validate_volumes(self.tracks, {0: value})  # type: ignore[dict-item]


class TestValidateVolumesWithSourceBaseline(unittest.TestCase):
    """source_volume_percentが100でないトラック（変換元CC7=64採用済み）の除外基準。"""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fixture_path = Path(self.tmp.name) / "cc7.mid"
        build_cc7_fixture(self.fixture_path)
        _, self.tracks = midi.analyze_midi_file(self.fixture_path)

    def test_value_matching_baseline_is_excluded(self) -> None:
        self.assertEqual(self.tracks[0].source_volume_percent, 64)
        self.assertEqual(midi.validate_volumes(self.tracks, {0: 64}), {})

    def test_value_matching_default_but_not_baseline_is_kept(self) -> None:
        # baselineが64のトラックへ100を送るのは「ユーザーが明示的に既定値へ戻した」
        # 指定であり、baseline自体とは異なるので除外されない。
        self.assertEqual(midi.validate_volumes(self.tracks, {0: 100}), {0: 100})

    def test_value_differing_from_baseline_is_kept(self) -> None:
        self.assertEqual(midi.validate_volumes(self.tracks, {0: 80}), {0: 80})


class TestApplyAssignments(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fixture_path = Path(self.tmp.name) / "fixture.mid"
        build_fixture(self.fixture_path)
        self.original_bytes = self.fixture_path.read_bytes()
        self.before = absolute_note_events(mido.MidiFile(self.fixture_path))

    def test_update_existing_program_change_preserves_timing(self) -> None:
        output_path = Path(self.tmp.name) / "out.mid"
        summary = midi.apply_assignments(self.fixture_path, {0: 30}, output_path)
        self.assertEqual(summary, {"updated": 1, "inserted": 0})

        edited = mido.MidiFile(output_path)
        pcs = [m.program for m in edited.tracks[0] if m.type == "program_change"]
        self.assertEqual(pcs, [30])
        self.assertEqual(absolute_note_events(edited), self.before)

    def test_insert_program_change_preserves_timing(self) -> None:
        output_path = Path(self.tmp.name) / "out.mid"
        summary = midi.apply_assignments(self.fixture_path, {2: 33}, output_path)
        self.assertEqual(summary, {"updated": 0, "inserted": 1})

        edited = mido.MidiFile(output_path)
        pcs = [(m.channel, m.program) for m in edited.tracks[2] if m.type == "program_change"]
        self.assertEqual(pcs, [(1, 33)])
        self.assertEqual(absolute_note_events(edited), self.before)

    def test_apply_on_non_editable_track_raises(self) -> None:
        output_path = Path(self.tmp.name) / "out.mid"
        with self.assertRaises(WebValidationError):
            midi.apply_assignments(self.fixture_path, {1: 5}, output_path)

    def test_original_file_is_never_mutated(self) -> None:
        output_path = Path(self.tmp.name) / "out.mid"
        midi.apply_assignments(self.fixture_path, {0: 30, 2: 33}, output_path)
        self.assertEqual(self.fixture_path.read_bytes(), self.original_bytes)

    def test_multiple_apply_cycles_are_deterministic(self) -> None:
        output_path = Path(self.tmp.name) / "out.mid"
        midi.apply_assignments(self.fixture_path, {0: 30}, output_path)
        midi.apply_assignments(self.fixture_path, {0: 99}, output_path)
        edited = mido.MidiFile(output_path)
        pcs = [m.program for m in edited.tracks[0] if m.type == "program_change"]
        self.assertEqual(pcs, [99])  # 常に原本から読み直すので前回の99は残らず1個だけ

    def test_save_midi_atomic_leaves_no_tmp_file(self) -> None:
        output_path = Path(self.tmp.name) / "out.mid"
        midi.apply_assignments(self.fixture_path, {0: 30}, output_path)
        tmp_files = list(Path(self.tmp.name).glob(".*.tmp*"))
        self.assertEqual(tmp_files, [])
        # 保存されたファイルが読み直せることも確認する。
        mido.MidiFile(output_path)

    def test_track_volume_scales_note_on_velocity_without_changing_timing(self) -> None:
        output_path = Path(self.tmp.name) / "out.mid"
        midi.apply_assignments(self.fixture_path, {}, output_path, {0: 50, 1: 0, 2: 200})
        edited = mido.MidiFile(output_path)

        velocities = [
            [message.velocity for message in track if message.type == "note_on"]
            for track in edited.tracks
        ]
        self.assertEqual(velocities[0], [50])
        self.assertEqual(velocities[1], [0])
        self.assertEqual(velocities[2], [127])
        self.assertEqual(absolute_note_events(edited), self.before)

    def test_track_volume_is_always_reapplied_from_original(self) -> None:
        output_path = Path(self.tmp.name) / "out.mid"
        midi.apply_assignments(self.fixture_path, {}, output_path, {0: 50})
        midi.apply_assignments(self.fixture_path, {}, output_path, {0: 200})
        edited = mido.MidiFile(output_path)
        note_on = next(message for message in edited.tracks[0] if message.type == "note_on")
        self.assertEqual(note_on.velocity, 127)


def build_transpose_boundary_fixture(path: Path) -> None:
    """移調で範囲外(0-127)に出るノートを含むフィクスチャ。

    Track 0: note=125（+10で範囲外）とnote=60（+10でも範囲内）が同じチャンネル。
    Track 1: パーカッションチャンネル(ch9)。範囲外に出す値でも移調してはいけない
    ことを確認するため、わざとnote=125を置く。
    """
    mf = mido.MidiFile(ticks_per_beat=480)

    t0 = mido.MidiTrack()
    t0.append(mido.MetaMessage("track_name", name="Lead", time=0))
    t0.append(mido.Message("note_on", note=125, velocity=100, channel=0, time=0))
    t0.append(mido.Message("note_off", note=125, velocity=0, channel=0, time=240))
    t0.append(mido.Message("note_on", note=60, velocity=100, channel=0, time=0))
    t0.append(mido.Message("note_off", note=60, velocity=0, channel=0, time=240))
    mf.tracks.append(t0)

    t1 = mido.MidiTrack()
    t1.append(mido.MetaMessage("track_name", name="Noise", time=0))
    t1.append(mido.Message("note_on", note=125, velocity=100, channel=9, time=0))
    t1.append(mido.Message("note_off", note=125, velocity=0, channel=9, time=240))
    mf.tracks.append(t1)

    mf.save(path)


class TestApplyAssignmentsCc7Normalization(unittest.TestCase):
    """変換元CC7（source_volumes）をbaselineとして正規化するapply_assignments()の挙動。"""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fixture_path = Path(self.tmp.name) / "cc7.mid"
        build_cc7_fixture(self.fixture_path)
        self.before = absolute_note_events(mido.MidiFile(self.fixture_path))

    def test_untouched_track_keeps_baseline_volume_and_normalizes_cc7(self) -> None:
        # web.py相当: 未操作トラックでもeffective volume=baseline(64)を渡す。
        output_path = Path(self.tmp.name) / "out.mid"
        midi.apply_assignments(
            self.fixture_path, {}, output_path, {0: 64}, {0: 64},
        )
        edited = mido.MidiFile(output_path)
        cc7_values = [m.value for m in edited.tracks[0] if m.type == "control_change" and m.control == 7]
        velocities = [m.velocity for m in edited.tracks[0] if m.type == "note_on"]
        self.assertEqual(cc7_values, [100])
        self.assertEqual(velocities, [64])
        self.assertEqual(absolute_note_events(edited), self.before)

    def test_user_adjusted_track_scales_relative_to_baseline(self) -> None:
        # baseline 64 のトラックをユーザーが80%へ設定した場合、CC7は100へ正規化
        # されたまま、velocityはoriginal * 80/100（baselineではなく指定値）。
        output_path = Path(self.tmp.name) / "out.mid"
        midi.apply_assignments(
            self.fixture_path, {}, output_path, {0: 80}, {0: 64},
        )
        edited = mido.MidiFile(output_path)
        cc7_values = [m.value for m in edited.tracks[0] if m.type == "control_change" and m.control == 7]
        velocities = [m.velocity for m in edited.tracks[0] if m.type == "note_on"]
        self.assertEqual(cc7_values, [100])
        self.assertEqual(velocities, [80])

    def test_amplifying_baseline_is_never_normalized(self) -> None:
        # track1のsource_volume_percentは100（analyze_track()が110を採用しない
        # ため）。source_volumesへ110を渡しても>=100はCC7正規化の対象外。
        output_path = Path(self.tmp.name) / "out.mid"
        midi.apply_assignments(
            self.fixture_path, {}, output_path, {1: 50}, {1: 100},
        )
        edited = mido.MidiFile(output_path)
        cc7_values = [m.value for m in edited.tracks[1] if m.type == "control_change" and m.control == 7]
        self.assertEqual(cc7_values, [110])  # 変更されない

    def test_time_varying_cc7_is_rescaled_preserving_shape(self) -> None:
        # track5: CC7が64→32(ノート発音中)。baseline=64でboth値を100/50へ
        # 再スケールする（比率 100/64 を両方へ適用）。
        output_path = Path(self.tmp.name) / "out.mid"
        midi.apply_assignments(
            self.fixture_path, {}, output_path, {5: 64}, {5: 64},
        )
        edited = mido.MidiFile(output_path)
        cc7_values = [m.value for m in edited.tracks[5] if m.type == "control_change" and m.control == 7]
        self.assertEqual(cc7_values, [100, 50])
        self.assertEqual(absolute_note_events(edited), self.before)

    def test_no_baseline_never_touches_cc7(self) -> None:
        # source_volumesを渡さない（webの旧経路互換）場合、CC7には一切触れない。
        output_path = Path(self.tmp.name) / "out.mid"
        midi.apply_assignments(self.fixture_path, {}, output_path, {0: 50})
        edited = mido.MidiFile(output_path)
        cc7_values = [m.value for m in edited.tracks[0] if m.type == "control_change" and m.control == 7]
        self.assertEqual(cc7_values, [64])  # 原本のまま


class TestApplyTransform(unittest.TestCase):
    """apply_assignments()のspeed/transpose引数（miditrack/CLAUDE.md参照）。"""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fixture_path = Path(self.tmp.name) / "fixture.mid"
        build_fixture(self.fixture_path)

    def test_default_values_are_byte_identical_to_no_transform(self) -> None:
        with_defaults = Path(self.tmp.name) / "with_defaults.mid"
        without = Path(self.tmp.name) / "without.mid"
        midi.apply_assignments(self.fixture_path, {}, with_defaults, speed=1.0, transpose=0)
        midi.apply_assignments(self.fixture_path, {}, without)
        self.assertEqual(with_defaults.read_bytes(), without.read_bytes())

    def test_speed_scales_existing_tempo_messages(self) -> None:
        output_path = Path(self.tmp.name) / "out.mid"
        midi.apply_assignments(self.fixture_path, {}, output_path, speed=2.0)
        edited = mido.MidiFile(output_path)
        tempos = [m.tempo for track in edited.tracks for m in track if m.type == "set_tempo"]
        self.assertEqual(tempos, [250000])

    def test_speed_inserts_tempo_when_none_exists(self) -> None:
        mf = mido.MidiFile(ticks_per_beat=480)
        track = mido.MidiTrack()
        track.append(mido.Message("note_on", note=60, velocity=100, channel=0, time=0))
        track.append(mido.Message("note_off", note=60, velocity=0, channel=0, time=480))
        mf.tracks.append(track)
        no_tempo_path = Path(self.tmp.name) / "no_tempo.mid"
        mf.save(no_tempo_path)

        output_path = Path(self.tmp.name) / "out.mid"
        midi.apply_assignments(no_tempo_path, {}, output_path, speed=2.0)
        edited = mido.MidiFile(output_path)
        tempos = [m.tempo for m in edited.tracks[0] if m.type == "set_tempo"]
        self.assertEqual(tempos, [250000])
        # time=0で先頭に挿入するので後続のノートのtickはずれない。
        self.assertEqual(edited.tracks[0][0].type, "set_tempo")
        self.assertEqual(edited.tracks[0][0].time, 0)

    def test_tempo_is_clamped_to_upper_bound(self) -> None:
        mf = mido.MidiFile(ticks_per_beat=480)
        track = mido.MidiTrack()
        # 2,000,000 / 0.1 = 20,000,000 > MAX_TEMPO_MICROSECONDS(0xFFFFFF=16,777,215)
        track.append(mido.MetaMessage("set_tempo", tempo=2_000_000, time=0))
        track.append(mido.Message("note_on", note=60, velocity=100, channel=0, time=0))
        track.append(mido.Message("note_off", note=60, velocity=0, channel=0, time=480))
        mf.tracks.append(track)
        slow_tempo_path = Path(self.tmp.name) / "slow_tempo.mid"
        mf.save(slow_tempo_path)

        output_path = Path(self.tmp.name) / "out.mid"
        midi.apply_assignments(slow_tempo_path, {}, output_path, speed=midi.MIN_SPEED_RATIO)
        edited = mido.MidiFile(output_path)
        tempos = [m.tempo for m in edited.tracks[0] if m.type == "set_tempo"]
        self.assertEqual(tempos, [midi.MAX_TEMPO_MICROSECONDS])

    def test_tempo_is_clamped_to_lower_bound(self) -> None:
        mf = mido.MidiFile(ticks_per_beat=480)
        track = mido.MidiTrack()
        # 1 / 10.0 = 0.1 -> round()で0になるところをMIN_TEMPO_MICROSECONDS(1)へ底上げ。
        track.append(mido.MetaMessage("set_tempo", tempo=1, time=0))
        track.append(mido.Message("note_on", note=60, velocity=100, channel=0, time=0))
        track.append(mido.Message("note_off", note=60, velocity=0, channel=0, time=480))
        mf.tracks.append(track)
        fast_tempo_path = Path(self.tmp.name) / "fast_tempo.mid"
        mf.save(fast_tempo_path)

        output_path = Path(self.tmp.name) / "out.mid"
        midi.apply_assignments(fast_tempo_path, {}, output_path, speed=midi.MAX_SPEED_RATIO)
        edited = mido.MidiFile(output_path)
        tempos = [m.tempo for m in edited.tracks[0] if m.type == "set_tempo"]
        self.assertEqual(tempos, [midi.MIN_TEMPO_MICROSECONDS])

    def test_transpose_shifts_melodic_notes_and_skips_percussion(self) -> None:
        output_path = Path(self.tmp.name) / "out.mid"
        midi.apply_assignments(self.fixture_path, {}, output_path, transpose=12)
        edited = mido.MidiFile(output_path)
        notes_track0 = [m.note for m in edited.tracks[0] if m.type in ("note_on", "note_off")]
        notes_track1 = [m.note for m in edited.tracks[1] if m.type in ("note_on", "note_off")]
        self.assertEqual(notes_track0, [72, 72])  # 60+12
        self.assertEqual(notes_track1, [42, 42])  # percussion(ch9)は変化しない

    def test_out_of_range_notes_are_dropped_in_pairs_and_ticks_preserved(self) -> None:
        boundary_path = Path(self.tmp.name) / "boundary.mid"
        build_transpose_boundary_fixture(boundary_path)
        original = mido.MidiFile(boundary_path)

        output_path = Path(self.tmp.name) / "out.mid"
        midi.apply_assignments(boundary_path, {}, output_path, transpose=10)
        edited = mido.MidiFile(output_path)

        # track0: note=125+10=135は範囲外なのでnote_on/note_offの対が消え、
        # note=60+10=70は残る。
        notes_track0 = [
            (m.type, m.note) for m in edited.tracks[0] if m.type in ("note_on", "note_off")
        ]
        self.assertEqual(notes_track0, [("note_on", 70), ("note_off", 70)])

        # パーカッション(ch9)は移調対象外なので範囲外判定自体が行われず残る。
        notes_track1 = [
            (m.type, m.note) for m in edited.tracks[1] if m.type in ("note_on", "note_off")
        ]
        self.assertEqual(notes_track1, [("note_on", 125), ("note_off", 125)])

        def total_ticks(track) -> int:
            return sum(message.time for message in track)

        for index in range(len(original.tracks)):
            self.assertEqual(
                total_ticks(edited.tracks[index]),
                total_ticks(original.tracks[index]),
                f"track {index} の総tick長が変化した",
            )

    def test_transform_combines_with_program_change_and_volume(self) -> None:
        output_path = Path(self.tmp.name) / "out.mid"
        midi.apply_assignments(
            self.fixture_path, {2: 33}, output_path, {0: 50}, speed=2.0, transpose=1
        )
        edited = mido.MidiFile(output_path)

        pcs = [(m.channel, m.program) for m in edited.tracks[2] if m.type == "program_change"]
        self.assertEqual(pcs, [(1, 33)])

        velocities = [m.velocity for m in edited.tracks[0] if m.type == "note_on"]
        self.assertEqual(velocities, [50])

        notes = [m.note for m in edited.tracks[0] if m.type == "note_on"]
        self.assertEqual(notes, [61])  # 60+1

        tempos = [m.tempo for track in edited.tracks for m in track if m.type == "set_tempo"]
        self.assertEqual(tempos, [250000])

    def test_multiple_apply_cycles_do_not_accumulate_transform(self) -> None:
        output_path = Path(self.tmp.name) / "out.mid"
        midi.apply_assignments(self.fixture_path, {}, output_path, speed=2.0, transpose=12)
        midi.apply_assignments(self.fixture_path, {}, output_path, speed=2.0, transpose=12)
        edited = mido.MidiFile(output_path)
        tempos = [m.tempo for track in edited.tracks for m in track if m.type == "set_tempo"]
        notes = [m.note for m in edited.tracks[0] if m.type == "note_on"]
        self.assertEqual(tempos, [250000])  # 500000/2のまま。二重に割られていない
        self.assertEqual(notes, [72])  # 60+12のまま。二重に加算されていない


class TestValidateSpeedRatio(unittest.TestCase):
    def test_accepts_values_in_range(self) -> None:
        self.assertEqual(midi.validate_speed_ratio(1.0), 1.0)
        self.assertEqual(midi.validate_speed_ratio(2), 2.0)
        self.assertEqual(midi.validate_speed_ratio(midi.MIN_SPEED_RATIO), midi.MIN_SPEED_RATIO)
        self.assertEqual(midi.validate_speed_ratio(midi.MAX_SPEED_RATIO), midi.MAX_SPEED_RATIO)

    def test_rejects_out_of_range_and_non_numeric(self) -> None:
        for value in (0.0, midi.MAX_SPEED_RATIO + 1, "1.2", True, None):
            with self.subTest(value=value), self.assertRaises(WebValidationError):
                midi.validate_speed_ratio(value)


class TestValidateTransposeSemitones(unittest.TestCase):
    def test_accepts_values_in_range(self) -> None:
        self.assertEqual(midi.validate_transpose_semitones(0), 0)
        self.assertEqual(
            midi.validate_transpose_semitones(midi.MIN_TRANSPOSE_SEMITONES),
            midi.MIN_TRANSPOSE_SEMITONES,
        )
        self.assertEqual(
            midi.validate_transpose_semitones(midi.MAX_TRANSPOSE_SEMITONES),
            midi.MAX_TRANSPOSE_SEMITONES,
        )

    def test_rejects_out_of_range_non_integer_and_bool(self) -> None:
        for value in (
            midi.MIN_TRANSPOSE_SEMITONES - 1,
            midi.MAX_TRANSPOSE_SEMITONES + 1,
            1.5,
            True,
            "2",
            None,
        ):
            with self.subTest(value=value), self.assertRaises(WebValidationError):
                midi.validate_transpose_semitones(value)


class TestValidateVariationOptions(unittest.TestCase):
    def test_none_uses_defaults(self) -> None:
        speeds, transposes = midi.validate_variation_options(None, None)
        self.assertEqual(speeds, midi.DEFAULT_VARIATION_SPEEDS)
        self.assertEqual(transposes, midi.DEFAULT_VARIATION_TRANSPOSES)

    def test_custom_values_are_parsed(self) -> None:
        speeds, transposes = midi.validate_variation_options([1.5, 2], [-3, 0, 3])
        self.assertEqual(speeds, [1.5, 2.0])
        self.assertEqual(transposes, [-3, 0, 3])

    def test_empty_list_is_rejected(self) -> None:
        with self.assertRaises(WebValidationError):
            midi.validate_variation_options([], None)
        with self.assertRaises(WebValidationError):
            midi.validate_variation_options(None, [])

    def test_non_list_is_rejected(self) -> None:
        with self.assertRaises(WebValidationError):
            midi.validate_variation_options(1.2, None)

    def test_non_numeric_speed_is_rejected(self) -> None:
        with self.assertRaises(WebValidationError):
            midi.validate_variation_options(["fast"], None)

    def test_bool_speed_is_rejected(self) -> None:
        with self.assertRaises(WebValidationError):
            midi.validate_variation_options([True], None)

    def test_out_of_range_speed_is_rejected(self) -> None:
        with self.assertRaises(WebValidationError):
            midi.validate_variation_options([0.0], None)

    def test_non_integer_transpose_is_rejected(self) -> None:
        # 旧WAV後処理方式のpitchesはfloatを許していたが、MIDIレイヤーは
        # 半音（整数）しか表現できないため、ここでは明示的に拒否する。
        with self.assertRaises(WebValidationError):
            midi.validate_variation_options(None, [1.5])

    def test_out_of_range_transpose_is_rejected(self) -> None:
        with self.assertRaises(WebValidationError):
            midi.validate_variation_options(None, [midi.MAX_TRANSPOSE_SEMITONES + 1])

    def test_too_many_speeds_is_rejected(self) -> None:
        with self.assertRaises(WebValidationError):
            midi.validate_variation_options(list(range(1, midi.MAX_VARIATION_SPEED_COUNT + 2)), None)

    def test_too_many_transposes_is_rejected(self) -> None:
        with self.assertRaises(WebValidationError):
            midi.validate_variation_options(
                None, list(range(0, midi.MAX_VARIATION_TRANSPOSE_COUNT + 2))
            )

    def test_too_many_combinations_is_rejected(self) -> None:
        speeds = [1.0 + i * 0.01 for i in range(midi.MAX_VARIATION_SPEED_COUNT)]
        transposes = list(range(midi.MAX_VARIATION_TRANSPOSE_COUNT))
        with self.assertRaises(WebValidationError):
            midi.validate_variation_options(speeds, transposes)

    def test_duplicate_values_are_removed_preserving_order(self) -> None:
        speeds, transposes = midi.validate_variation_options([1.2, 0.8, 1.2], [0, 1, 0])
        self.assertEqual(speeds, [1.2, 0.8])
        self.assertEqual(transposes, [0, 1])


def build_bank_select_fixture(path: Path) -> None:
    """バンクセレクト(CC0/CC32)とCC7(音量、除去対象外)を持つ1トラックのフィクスチャ。"""
    mf = mido.MidiFile(ticks_per_beat=480)
    t0 = mido.MidiTrack()
    t0.append(mido.MetaMessage("track_name", name="Lead", time=0))
    t0.append(mido.Message("control_change", control=0, value=127, channel=0, time=0))
    t0.append(mido.Message("control_change", control=7, value=100, channel=0, time=0))
    t0.append(mido.Message("program_change", program=38, channel=0, time=0))
    t0.append(mido.Message("note_on", note=60, velocity=100, channel=0, time=0))
    t0.append(mido.Message("note_off", note=60, velocity=0, channel=0, time=480))
    t0.append(mido.Message("control_change", control=32, value=5, channel=0, time=0))
    mf.tracks.append(t0)
    mf.save(path)


def build_shared_channel_fixture(path: Path) -> None:
    """異なる2トラックが同一MIDIチャンネル(ch0)を共有するフィクスチャ。"""
    mf = mido.MidiFile(ticks_per_beat=480)

    t0 = mido.MidiTrack()
    t0.append(mido.MetaMessage("track_name", name="A", time=0))
    t0.append(mido.Message("program_change", program=10, channel=0, time=0))
    t0.append(mido.Message("note_on", note=60, velocity=100, channel=0, time=0))
    t0.append(mido.Message("note_off", note=60, velocity=0, channel=0, time=480))
    mf.tracks.append(t0)

    t1 = mido.MidiTrack()
    t1.append(mido.MetaMessage("track_name", name="B", time=0))
    t1.append(mido.Message("program_change", program=20, channel=0, time=0))
    t1.append(mido.Message("note_on", note=64, velocity=100, channel=0, time=0))
    t1.append(mido.Message("note_off", note=64, velocity=0, channel=0, time=480))
    mf.tracks.append(t1)

    mf.save(path)


class TestWriteTrackSubset(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fixture_path = Path(self.tmp.name) / "fixture.mid"
        build_fixture(self.fixture_path)
        self.before = absolute_note_events(mido.MidiFile(self.fixture_path))

    def test_kept_track_note_ticks_are_unchanged(self) -> None:
        output_path = Path(self.tmp.name) / "subset.mid"
        midi.write_track_subset(self.fixture_path, {0, 4}, output_path)
        result = mido.MidiFile(output_path)
        self.assertEqual(absolute_note_events(result)[0], self.before[0])

    def test_dropped_track_has_no_channel_messages(self) -> None:
        output_path = Path(self.tmp.name) / "subset.mid"
        midi.write_track_subset(self.fixture_path, {0, 4}, output_path)
        result = mido.MidiFile(output_path)
        # track1(パーカッション)/track2/track3はkeep_indices外 -> 非メタが全部消える。
        for index in (1, 2, 3):
            for message in result.tracks[index]:
                self.assertTrue(message.is_meta)

    def test_meta_only_track_survives_regardless_of_keep_indices(self) -> None:
        output_path = Path(self.tmp.name) / "subset.mid"
        # track4(テンポのみ)をkeep_indicesから外しても、非メタが元々無いので消えない。
        midi.write_track_subset(self.fixture_path, {0}, output_path)
        result = mido.MidiFile(output_path)
        tempos = [m.tempo for m in result.tracks[4] if m.type == "set_tempo"]
        self.assertEqual(tempos, [500000])

    def test_total_tick_length_is_preserved_per_track(self) -> None:
        output_path = Path(self.tmp.name) / "subset.mid"
        midi.write_track_subset(self.fixture_path, {0}, output_path)
        original = mido.MidiFile(self.fixture_path)
        result = mido.MidiFile(output_path)

        def total_ticks(track) -> int:
            return sum(message.time for message in track)

        for index in range(len(original.tracks)):
            self.assertEqual(
                total_ticks(result.tracks[index]),
                total_ticks(original.tracks[index]),
                f"track {index} の総tick長が変化した",
            )

    def test_returns_true_when_subset_has_sounding_notes(self) -> None:
        output_path = Path(self.tmp.name) / "subset.mid"
        has_notes = midi.write_track_subset(self.fixture_path, {0}, output_path)
        self.assertTrue(has_notes)

    def test_returns_false_when_subset_has_no_sounding_notes(self) -> None:
        output_path = Path(self.tmp.name) / "subset.mid"
        # track4はテンポのみでnote_onが無い。
        has_notes = midi.write_track_subset(self.fixture_path, {4}, output_path)
        self.assertFalse(has_notes)

    def test_returns_false_for_empty_keep_indices(self) -> None:
        output_path = Path(self.tmp.name) / "subset.mid"
        has_notes = midi.write_track_subset(self.fixture_path, set(), output_path)
        self.assertFalse(has_notes)


class TestWriteTrackSubsetBankSelect(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fixture_path = Path(self.tmp.name) / "bank.mid"
        build_bank_select_fixture(self.fixture_path)

    def test_bank_select_removed_when_requested(self) -> None:
        output_path = Path(self.tmp.name) / "out.mid"
        midi.write_track_subset(self.fixture_path, {0}, output_path, strip_bank_select=True)
        result = mido.MidiFile(output_path)
        ccs = [(m.control, m.value) for m in result.tracks[0] if m.type == "control_change"]
        self.assertEqual(ccs, [(7, 100)])

    def test_bank_select_kept_when_not_requested(self) -> None:
        output_path = Path(self.tmp.name) / "out.mid"
        midi.write_track_subset(self.fixture_path, {0}, output_path, strip_bank_select=False)
        result = mido.MidiFile(output_path)
        ccs = {(m.control, m.value) for m in result.tracks[0] if m.type == "control_change"}
        self.assertEqual(ccs, {(0, 127), (7, 100), (32, 5)})

    def test_note_timing_unaffected_by_bank_select_removal(self) -> None:
        output_path = Path(self.tmp.name) / "out.mid"
        before = absolute_note_events(mido.MidiFile(self.fixture_path))
        midi.write_track_subset(self.fixture_path, {0}, output_path, strip_bank_select=True)
        after = absolute_note_events(mido.MidiFile(output_path))
        self.assertEqual(after, before)


class TestWriteTrackSubsetSharedChannel(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fixture_path = Path(self.tmp.name) / "shared.mid"
        build_shared_channel_fixture(self.fixture_path)

    def test_dropped_tracks_program_change_does_not_leak_into_kept(self) -> None:
        output_path = Path(self.tmp.name) / "out.mid"
        # track0とtrack1は共にch0を使うが、track1だけをkeep_indicesから外す。
        midi.write_track_subset(self.fixture_path, {0}, output_path)
        result = mido.MidiFile(output_path)
        pcs_track0 = [m.program for m in result.tracks[0] if m.type == "program_change"]
        pcs_track1 = [m.program for m in result.tracks[1] if m.type == "program_change"]
        self.assertEqual(pcs_track0, [10])
        self.assertEqual(pcs_track1, [])


if __name__ == "__main__":
    unittest.main()
