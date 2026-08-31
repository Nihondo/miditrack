"""MIDIファイルからピアノロール表示用のノート列を抽出する。"""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import midi
from .errors import MidiTrackError
from .gm import PERCUSSION_CHANNEL

MAX_PIANOROLL_NOTES = 20_000
NOTE_STRIDE = 4
NOTE_FIELDS = ["start", "duration", "note", "velocity"]
TIME_DECIMALS = 3
DEFAULT_PITCH_BEND_RANGE_SEMITONES = 2.0


@dataclass(frozen=True)
class _TickNote:
    track_index: int
    start_tick: int
    end_tick: int
    note: int
    velocity: int
    order: int
    pitch_points: tuple[tuple[int, float], ...] = ()


@dataclass
class _ActiveNote:
    """ノートオフまでの発音状態と、ノート内のピッチベンド軌跡を保持する。"""

    start_tick: int
    velocity: int
    pitch_points: list[tuple[int, float]] = field(default_factory=list)


@dataclass(frozen=True)
class _TempoMap:
    ticks: tuple[int, ...]
    seconds: tuple[float, ...]
    tempos: tuple[int, ...]
    ticks_per_beat: int

    def to_seconds(self, tick: int) -> float:
        index = bisect_right(self.ticks, tick) - 1
        elapsed_ticks = tick - self.ticks[index]
        return self.seconds[index] + (
            elapsed_ticks * self.tempos[index] / 1_000_000 / self.ticks_per_beat
        )


def _read_midi(path: Path) -> Any:
    mido = midi.import_mido()
    try:
        midi_file = mido.MidiFile(path)
    except (OSError, EOFError, ValueError) as error:
        raise MidiTrackError(f"MIDIを読み込めません: {path}: {error}") from error
    if midi_file.ticks_per_beat <= 0:
        raise MidiTrackError("SMPTE形式のMIDIタイムコードには対応していません")
    return midi_file


def _scaled_tempo(tempo: int, speed: float) -> int:
    scaled = round(tempo / speed)
    return max(midi.MIN_TEMPO_MICROSECONDS, min(midi.MAX_TEMPO_MICROSECONDS, scaled))


def _collect_tempo_changes(midi_file: Any) -> tuple[list[tuple[int, int]], list[int]]:
    changes: list[tuple[int, int]] = []
    end_ticks: list[int] = []
    for track in midi_file.tracks:
        absolute_tick = 0
        for message in track:
            absolute_tick += message.time
            if message.is_meta and message.type == "set_tempo":
                changes.append((absolute_tick, message.tempo))
        end_ticks.append(absolute_tick)
    changes.sort(key=lambda item: item[0])
    return changes, end_ticks


def _build_tempo_map(midi_file: Any, speed: float) -> tuple[_TempoMap, list[int]]:
    changes, end_ticks = _collect_tempo_changes(midi_file)
    has_explicit_tempo = bool(changes)
    initial_tempo = midi.DEFAULT_TEMPO_MICROSECONDS
    if not has_explicit_tempo:
        initial_tempo = _scaled_tempo(initial_tempo, speed)

    ticks = [0]
    seconds = [0.0]
    tempos = [initial_tempo]
    for tick, tempo in changes:
        previous_seconds = seconds[-1] + (
            (tick - ticks[-1]) * tempos[-1] / 1_000_000 / midi_file.ticks_per_beat
        )
        ticks.append(tick)
        seconds.append(previous_seconds)
        tempos.append(_scaled_tempo(tempo, speed))
    return _TempoMap(tuple(ticks), tuple(seconds), tuple(tempos), midi_file.ticks_per_beat), end_ticks


def _transposed_note(channel: int, note: int, transpose: int) -> int | None:
    if channel == PERCUSSION_CHANNEL:
        return note
    result = note + transpose
    return result if 0 <= result <= 127 else None


def _close_note(
    notes: list[_TickNote], active_note: _ActiveNote, channel: int, note: int,
    end_tick: int, track_index: int, transpose: int, order: int,
) -> int:
    rendered_note = _transposed_note(channel, note, transpose)
    if rendered_note is not None:
        notes.append(
            _TickNote(
                track_index,
                active_note.start_tick,
                end_tick,
                rendered_note,
                active_note.velocity,
                order,
                tuple(active_note.pitch_points),
            )
        )
        return order + 1
    return order


def _pitch_offset_semitones(pitch: int, pitch_range: float) -> float:
    """14bitのMIDIピッチベンド値を、RPN 0に基づく半音差へ変換する。"""
    divisor = 8192 if pitch < 0 else 8191
    return pitch / divisor * pitch_range


def _append_pitch_point(active_note: _ActiveNote, tick: int, offset: float) -> None:
    """同値の連続イベントを除いて、ノート内のピッチ変化点を追加する。"""
    if active_note.pitch_points and active_note.pitch_points[-1][0] == tick:
        active_note.pitch_points[-1] = (tick, offset)
    elif not active_note.pitch_points or active_note.pitch_points[-1][1] != offset:
        active_note.pitch_points.append((tick, offset))


def _append_channel_pitch_point(
    active: dict[tuple[int, int], _ActiveNote], channel: int, tick: int, offset: float,
) -> None:
    """指定チャンネルで発音中の全ノートへピッチ変化点を追加する。"""
    for (active_channel, _note), active_note in active.items():
        if active_channel == channel:
            _append_pitch_point(active_note, tick, offset)


def _extract_track_notes(
    track: Any, track_index: int, transpose: int, start_order: int,
) -> tuple[list[_TickNote], int, int]:
    active: dict[tuple[int, int], _ActiveNote] = {}
    notes: list[_TickNote] = []
    pitch_values: dict[int, int] = {}
    pitch_ranges: dict[int, float] = {}
    rpn_selection: dict[int, list[int | None]] = {}
    rpn_data_entry: dict[int, list[int]] = {}
    absolute_tick = 0
    order = start_order
    for message in track:
        absolute_tick += message.time
        if message.type == "control_change":
            selection = rpn_selection.setdefault(message.channel, [None, None])
            data_entry = rpn_data_entry.setdefault(message.channel, [0, 0])
            if message.control == 101:
                selection[0] = message.value
            elif message.control == 100:
                selection[1] = message.value
            elif message.control in (6, 38) and selection == [0, 0]:
                data_entry[0 if message.control == 6 else 1] = message.value
                pitch_ranges[message.channel] = data_entry[0] + data_entry[1] / 100
                offset = _pitch_offset_semitones(
                    pitch_values.get(message.channel, 0), pitch_ranges[message.channel]
                )
                _append_channel_pitch_point(active, message.channel, absolute_tick, offset)
            continue
        if message.type == "pitchwheel":
            pitch_values[message.channel] = message.pitch
            offset = _pitch_offset_semitones(
                message.pitch, pitch_ranges.get(message.channel, DEFAULT_PITCH_BEND_RANGE_SEMITONES)
            )
            _append_channel_pitch_point(active, message.channel, absolute_tick, offset)
            continue
        if message.type not in ("note_on", "note_off"):
            continue
        key = (message.channel, message.note)
        is_note_on = message.type == "note_on" and message.velocity > 0
        if is_note_on and key in active:
            order = _close_note(
                notes, active.pop(key), *key, absolute_tick, track_index, transpose, order
            )
        if is_note_on:
            offset = _pitch_offset_semitones(
                pitch_values.get(message.channel, 0),
                pitch_ranges.get(message.channel, DEFAULT_PITCH_BEND_RANGE_SEMITONES),
            )
            active[key] = _ActiveNote(
                absolute_tick, message.velocity, [(absolute_tick, offset)]
            )
        elif key in active:
            order = _close_note(
                notes, active.pop(key), *key, absolute_tick, track_index, transpose, order
            )

    unreleased_count = len(active)
    for (channel, note), active_note in active.items():
        order = _close_note(
            notes, active_note, channel, note, absolute_tick, track_index, transpose, order
        )
    return notes, unreleased_count, order


def _flatten_notes(notes: list[_TickNote], tempo_map: _TempoMap) -> list[float | int]:
    flattened: list[float | int] = []
    for note in notes:
        start = tempo_map.to_seconds(note.start_tick)
        end = tempo_map.to_seconds(note.end_tick)
        flattened.extend(
            [round(start, TIME_DECIMALS), round(max(0.0, end - start), TIME_DECIMALS),
             note.note, note.velocity]
        )
    return flattened


def _flatten_pitch_path(note: _TickNote, tempo_map: _TempoMap) -> list[float]:
    """ノート開始からの秒数と半音差を交互にしたピッチ軌跡を返す。"""
    start = tempo_map.to_seconds(note.start_tick)
    flattened: list[float] = []
    for tick, offset in note.pitch_points:
        elapsed = max(0.0, tempo_map.to_seconds(tick) - start)
        flattened.extend([round(elapsed, TIME_DECIMALS), round(offset, TIME_DECIMALS)])
    return flattened


def _has_pitch_motion(note: _TickNote) -> bool:
    return any(abs(offset) > 0.000_001 for _tick, offset in note.pitch_points)


def _group_tracks(
    notes: list[_TickNote], track_count: int, tempo_map: _TempoMap,
) -> list[dict[str, Any]]:
    grouped: list[list[_TickNote]] = [[] for _ in range(track_count)]
    for note in notes:
        grouped[note.track_index].append(note)
    tracks: list[dict[str, Any]] = []
    for index, track_notes in enumerate(grouped):
        track_payload: dict[str, Any] = {
            "index": index,
            "noteCount": len(track_notes),
            "notes": _flatten_notes(track_notes, tempo_map),
        }
        pitch_paths = [
            {"noteIndex": note_index, "points": _flatten_pitch_path(note, tempo_map)}
            for note_index, note in enumerate(track_notes)
            if _has_pitch_motion(note)
        ]
        if pitch_paths:
            track_payload["pitchPaths"] = pitch_paths
        tracks.append(track_payload)
    return tracks


def _build_payload(
    midi_file: Any, tempo_map: _TempoMap, end_ticks: list[int], all_notes: list[_TickNote],
    unreleased_count: int, speed: float, transpose: int,
) -> dict[str, Any]:
    total_note_count = len(all_notes)
    kept_notes = all_notes[:MAX_PIANOROLL_NOTES]
    truncated = total_note_count > len(kept_notes)
    truncated_at = tempo_map.to_seconds(all_notes[MAX_PIANOROLL_NOTES].start_tick) if truncated else None
    note_numbers = [
        round(note.note + offset, TIME_DECIMALS)
        for note in kept_notes
        for _tick, offset in note.pitch_points
    ]
    duration = tempo_map.to_seconds(max(end_ticks, default=0))
    return {
        "ticksPerBeat": midi_file.ticks_per_beat,
        "durationSeconds": round(duration, TIME_DECIMALS),
        "speed": speed,
        "transpose": transpose,
        "minNote": min(note_numbers) if note_numbers else None,
        "maxNote": max(note_numbers) if note_numbers else None,
        "noteCount": len(kept_notes),
        "totalNoteCount": total_note_count,
        "unreleasedNoteCount": unreleased_count,
        "truncated": truncated,
        "truncatedAtSeconds": round(truncated_at, TIME_DECIMALS) if truncated_at is not None else None,
        "stride": NOTE_STRIDE,
        "fields": NOTE_FIELDS,
        "tracks": _group_tracks(kept_notes, len(midi_file.tracks), tempo_map),
    }


def extract_notes(
    path: Path,
    *,
    speed: float = midi.DEFAULT_SPEED_RATIO,
    transpose: int = midi.DEFAULT_TRANSPOSE_SEMITONES,
) -> dict[str, Any]:
    """MIDIを読み直し、速度・移調を反映したピアノロール用ペイロードを返す。"""
    speed = midi.validate_speed_ratio(speed)
    transpose = midi.validate_transpose_semitones(transpose)
    midi_file = _read_midi(path)
    tempo_map, end_ticks = _build_tempo_map(midi_file, speed)
    all_notes: list[_TickNote] = []
    unreleased_count = 0
    order = 0
    for track_index, track in enumerate(midi_file.tracks):
        track_notes, track_unreleased, order = _extract_track_notes(
            track, track_index, transpose, order
        )
        all_notes.extend(track_notes)
        unreleased_count += track_unreleased

    all_notes.sort(key=lambda note: (note.start_tick, note.order))
    return _build_payload(
        midi_file, tempo_map, end_ticks, all_notes, unreleased_count, speed, transpose
    )
