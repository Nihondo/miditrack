"""miditrack.pianoroll のテスト。"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import mido

from miditrack import midi, pianoroll
from miditrack.errors import MidiTrackError


def save_midi(path: Path, tracks: list[mido.MidiTrack], ticks_per_beat: int = 480) -> None:
    """テスト用MIDIを指定したトラック構成で保存する。"""
    midi_file = mido.MidiFile(ticks_per_beat=ticks_per_beat)
    midi_file.tracks.extend(tracks)
    midi_file.save(path)


def note_track(
    *, note: int = 60, channel: int = 0, start: int = 0, duration: int = 480,
    velocity: int = 100,
) -> mido.MidiTrack:
    """単一ノートを含むテスト用トラックを返す。"""
    track = mido.MidiTrack()
    track.append(mido.Message("note_on", note=note, velocity=velocity, channel=channel, time=start))
    track.append(mido.Message("note_off", note=note, velocity=0, channel=channel, time=duration))
    return track


class TestExtractNotes(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "fixture.mid"

    def test_single_tempo_maps_ticks_to_seconds(self) -> None:
        tempo = mido.MidiTrack([mido.MetaMessage("set_tempo", tempo=500_000, time=0)])
        save_midi(self.path, [tempo, note_track()])
        payload = pianoroll.extract_notes(self.path)
        self.assertEqual(payload["durationSeconds"], 0.5)
        self.assertEqual(payload["tracks"][1]["notes"], [0.0, 0.5, 60, 100])

    def test_tempo_change_is_integrated_across_note(self) -> None:
        tempo = mido.MidiTrack([
            mido.MetaMessage("set_tempo", tempo=500_000, time=0),
            mido.MetaMessage("set_tempo", tempo=250_000, time=480),
        ])
        save_midi(self.path, [tempo, note_track(duration=960)])
        payload = pianoroll.extract_notes(self.path)
        self.assertEqual(payload["tracks"][1]["notes"][1], 0.75)

    def test_tempo_from_another_track_is_global(self) -> None:
        tempo = mido.MidiTrack([mido.MetaMessage("set_tempo", tempo=250_000, time=240)])
        save_midi(self.path, [note_track(), tempo])
        payload = pianoroll.extract_notes(self.path)
        self.assertEqual(payload["tracks"][0]["notes"][1], 0.375)

    def test_implicit_tempo_before_first_meta_is_not_scaled(self) -> None:
        tempo = mido.MidiTrack([mido.MetaMessage("set_tempo", tempo=500_000, time=240)])
        save_midi(self.path, [note_track(), tempo])
        payload = pianoroll.extract_notes(self.path, speed=2.0)
        self.assertEqual(payload["tracks"][0]["notes"][1], 0.375)

    def test_missing_tempo_uses_scaled_default(self) -> None:
        save_midi(self.path, [note_track()])
        payload = pianoroll.extract_notes(self.path, speed=2.0)
        self.assertEqual(payload["durationSeconds"], 0.25)

    def test_note_off_zero_velocity_retrigger_and_unreleased_notes(self) -> None:
        track = mido.MidiTrack([
            mido.Message("note_on", note=60, velocity=90, channel=0, time=0),
            mido.Message("note_on", note=60, velocity=80, channel=0, time=120),
            mido.Message("note_on", note=60, velocity=0, channel=0, time=120),
            mido.Message("note_off", note=61, velocity=0, channel=0, time=0),
            mido.Message("note_on", note=62, velocity=70, channel=1, time=120),
            mido.MetaMessage("end_of_track", time=120),
        ])
        save_midi(self.path, [track])
        payload = pianoroll.extract_notes(self.path)
        self.assertEqual(payload["noteCount"], 3)
        self.assertEqual(payload["unreleasedNoteCount"], 1)
        self.assertEqual(payload["tracks"][0]["notes"][0:8], [0.0, 0.125, 60, 90, 0.125, 0.125, 60, 80])

    def test_pitchwheel_is_exported_as_a_note_pitch_path(self) -> None:
        track = mido.MidiTrack([
            mido.Message("pitchwheel", pitch=4096, channel=0, time=0),
            mido.Message("note_on", note=60, velocity=100, channel=0, time=0),
            mido.Message("pitchwheel", pitch=-2048, channel=0, time=240),
            mido.Message("note_off", note=60, velocity=0, channel=0, time=240),
        ])
        save_midi(self.path, [track])
        payload = pianoroll.extract_notes(self.path)
        self.assertEqual(payload["tracks"][0]["notes"], [0.0, 0.5, 60, 100])
        self.assertEqual(
            payload["tracks"][0]["pitchPaths"],
            [{"noteIndex": 0, "points": [0.0, 1.0, 0.25, -0.5]}],
        )
        self.assertEqual((payload["minNote"], payload["maxNote"]), (59.5, 61.0))

    def test_pitchwheel_uses_the_rpn_pitch_bend_range(self) -> None:
        track = mido.MidiTrack([
            mido.Message("control_change", control=101, value=0, channel=0, time=0),
            mido.Message("control_change", control=100, value=0, channel=0, time=0),
            mido.Message("control_change", control=6, value=12, channel=0, time=0),
            mido.Message("pitchwheel", pitch=4096, channel=0, time=0),
            mido.Message("note_on", note=60, velocity=100, channel=0, time=0),
            mido.Message("note_off", note=60, velocity=0, channel=0, time=480),
        ])
        save_midi(self.path, [track])
        path = pianoroll.extract_notes(self.path)["tracks"][0]["pitchPaths"][0]
        self.assertEqual(path["points"], [0.0, 6.001])

    def test_channels_with_same_note_do_not_pair_together(self) -> None:
        track = mido.MidiTrack([
            mido.Message("note_on", note=60, velocity=90, channel=0, time=0),
            mido.Message("note_off", note=60, velocity=0, channel=1, time=120),
            mido.Message("note_off", note=60, velocity=0, channel=0, time=120),
        ])
        save_midi(self.path, [track])
        notes = pianoroll.extract_notes(self.path)["tracks"][0]["notes"]
        self.assertEqual(notes, [0.0, 0.25, 60, 90])

    def test_transpose_matches_written_midi_and_preserves_percussion(self) -> None:
        tempo = mido.MidiTrack([mido.MetaMessage("set_tempo", tempo=500_000, time=0)])
        save_midi(self.path, [tempo, note_track(note=120), note_track(note=42, channel=9)])
        output = Path(self.tmp.name) / "transposed.mid"
        midi.apply_assignments(self.path, {}, output, transpose=12)
        expected = pianoroll.extract_notes(output)
        actual = pianoroll.extract_notes(self.path, transpose=12)
        self.assertEqual(actual["tracks"], expected["tracks"])
        self.assertEqual(actual["noteCount"], 1)
        self.assertEqual(actual["tracks"][2]["notes"][2], 42)

    def test_speed_matches_written_midi_including_tempo_clamp(self) -> None:
        tempo = mido.MidiTrack([
            mido.MetaMessage("set_tempo", tempo=midi.MAX_TEMPO_MICROSECONDS, time=0)
        ])
        save_midi(self.path, [tempo, note_track()])
        output = Path(self.tmp.name) / "scaled.mid"
        midi.apply_assignments(self.path, {}, output, speed=0.1)
        expected = pianoroll.extract_notes(output)
        actual = pianoroll.extract_notes(self.path, speed=0.1)
        self.assertEqual(actual["tracks"], expected["tracks"])
        self.assertEqual(actual["durationSeconds"], expected["durationSeconds"])

    def test_empty_tracks_remain_and_payload_is_json_serializable(self) -> None:
        empty = mido.MidiTrack([mido.MetaMessage("end_of_track", time=480)])
        save_midi(self.path, [empty])
        payload = pianoroll.extract_notes(self.path)
        self.assertEqual(payload["minNote"], None)
        self.assertEqual(payload["maxNote"], None)
        self.assertEqual(payload["tracks"], [{"index": 0, "noteCount": 0, "notes": []}])
        json.dumps(payload)

    def test_note_limit_keeps_global_earliest_notes(self) -> None:
        early = note_track(note=60, start=0, duration=10)
        late = note_track(note=70, start=100, duration=10)
        save_midi(self.path, [late, early])
        with mock.patch.object(pianoroll, "MAX_PIANOROLL_NOTES", 1):
            payload = pianoroll.extract_notes(self.path)
        self.assertTrue(payload["truncated"])
        self.assertEqual(payload["noteCount"], 1)
        self.assertEqual(payload["totalNoteCount"], 2)
        self.assertEqual(payload["tracks"][1]["notes"][2], 60)
        self.assertEqual(payload["truncatedAtSeconds"], 0.104)

    def test_smpte_division_is_rejected(self) -> None:
        fake_mido = SimpleNamespace(
            MidiFile=lambda _path: SimpleNamespace(ticks_per_beat=-24, tracks=[])
        )
        with mock.patch.object(midi, "import_mido", return_value=fake_mido):
            with self.assertRaises(MidiTrackError):
                pianoroll.extract_notes(self.path)

