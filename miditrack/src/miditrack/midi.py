"""MIDIトラックの解析と、トラックごとのプログラムチェンジ適用・保存。

読み込み・書き込みのパターンは note_ext/src/note_ext/midi.py の
import_mido() / load_note_events() / save_midi_atomic() を踏襲している
（ただし他パッケージからのimportはしない — このリポジトリの独立パッケージ間の
既存方針。nsf2midi/spc2midi がそれぞれ独立に midi2wav.cpp を持つのと同じ扱い）。
"""

from __future__ import annotations

import dataclasses
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import MidiTrackError, WebValidationError
from .gm import PERCUSSION_CHANNEL

MIN_TRACK_VOLUME_PERCENT = 0
MAX_TRACK_VOLUME_PERCENT = 200
DEFAULT_TRACK_VOLUME_PERCENT = 100

# セッション全体の速度倍率・移調（半音）。トラック別の音色・音量とは異なり、
# ファイル全体に対して1組だけ持つ（miditrack/CLAUDE.md「Why speed/pitch also
# exists at the MIDI layer」参照）。
DEFAULT_SPEED_RATIO = 1.0
MIN_SPEED_RATIO = 0.1
MAX_SPEED_RATIO = 10.0
DEFAULT_TRANSPOSE_SEMITONES = 0
MIN_TRANSPOSE_SEMITONES = -24
MAX_TRANSPOSE_SEMITONES = 24

# 速度・ピッチの「バリエーション一括生成」（web.py の POST /api/variations）の
# 既定値・上限。1組み合わせ = MIDI適用+フルレンダリング1回なので、rubberband
# 1プロセスで済んでいた旧WAV後処理方式（上限40）より大幅に低く抑える。
# MAX_VARIATION_COUNTは既定の組み合わせ数（3速度×5移調=15）がちょうど収まる
# 値にしてある。
DEFAULT_VARIATION_SPEEDS: list[float] = [1.2, 1.0, 0.8]
DEFAULT_VARIATION_TRANSPOSES: list[int] = [-2, -1, 0, 1, 2]
MAX_VARIATION_SPEED_COUNT = 6
MAX_VARIATION_TRANSPOSE_COUNT = 8
MAX_VARIATION_COUNT = 15

# SMFの既定テンポ（tempoメタが1つも無いファイルでの4分音符=120BPM相当）。
DEFAULT_TEMPO_MICROSECONDS = 500_000
# set_tempoメタはマイクロ秒/4分音符を3バイトで表現するため、この値を超えられない。
MAX_TEMPO_MICROSECONDS = 0xFFFFFF
MIN_TEMPO_MICROSECONDS = 1


def import_mido() -> Any:
    """MIDI処理時だけmidoを読み込み、不足時は導入方法を示す。"""
    try:
        import mido
    except ImportError as error:
        raise MidiTrackError(
            "MIDI処理にはmidoが必要です。miditrack/README_ja.mdの「インストール」に"
            "従ってvenvを作成してください"
        ) from error
    return mido


@dataclass(frozen=True)
class TrackInfo:
    """1トラック分の解析結果。"""

    index: int
    name: str
    channels: tuple[int, ...]
    note_count: int
    current_program: int | None
    program_change_count: int
    editable: bool
    reason: str | None  # None | "percussion" | "multi-channel" | "no-notes"
    source_volume_percent: int  # 変換元CC7由来の音量(%)。既定はDEFAULT_TRACK_VOLUME_PERCENT


def _track_name(track: Any) -> str | None:
    for message in track:
        if message.is_meta and message.type == "track_name":
            name = message.name.strip()
            if name:
                return name
            return None
    return None


def analyze_track(track: Any, index: int) -> TrackInfo:
    """1トラックを走査し、チャンネル・ノート数・既存プログラムチェンジ・CC7音量を検出する。

    source_volume_percentは、この時点ではチャンネル占有（同じチャンネルを他の
    トラックも使っているか）を考慮しない単一トラック内の値を返す。占有判定は
    全トラックが出揃わないとできないため、analyze_midi_file()側の2パス目で
    必要に応じて既定値へ戻す。
    """
    channels: set[int] = set()
    note_count = 0
    program_changes: list[int] = []  # 出現順のプログラム番号（チャンネル別に後でフィルタ）
    program_change_channels: list[int] = []
    volume_changes: list[int] = []  # 出現順のCC7値（チャンネル別に後でフィルタ）
    volume_change_channels: list[int] = []

    for message in track:
        if message.type in ("note_on", "note_off"):
            channels.add(message.channel)
            if message.type == "note_on" and message.velocity > 0:
                note_count += 1
        elif message.type == "program_change":
            program_changes.append(message.program)
            program_change_channels.append(message.channel)
        elif message.type == "control_change" and message.control == 7:
            volume_changes.append(message.value)
            volume_change_channels.append(message.channel)

    sorted_channels = tuple(sorted(channels))
    name = _track_name(track) or f"Track {index}"

    current_program: int | None = None
    program_change_count = 0
    source_volume_percent = DEFAULT_TRACK_VOLUME_PERCENT
    reason: str | None
    editable: bool

    if len(sorted_channels) == 0:
        editable = False
        reason = "no-notes"
    elif len(sorted_channels) == 1:
        channel = sorted_channels[0]
        if channel == PERCUSSION_CHANNEL:
            editable = False
            reason = "percussion"
        else:
            editable = True
            reason = None
        # このトラックの単一チャンネルに対する既存プログラムチェンジを検出する。
        # vgm2midi は全トラックにGM81を送信済み、nsf2midiのgm.mdfプリセットも
        # チャンネルごとに音色を送信済みなので、「生成直後は空」という前提を
        # 置かずに検出する（miditrack/CLAUDE.md参照）。
        matching = [
            program
            for program, ch in zip(program_changes, program_change_channels)
            if ch == channel
        ]
        program_change_count = len(matching)
        if matching:
            current_program = matching[0]
        # 変換元CC7を音量スライダーの初期値として採用する。0-127を%へそのまま
        # 対応させ（CC7=100が既定値100%と一致）、100%未満（減衰）だけ採用する。
        # 100%以上を採用するとvelocityスケーリングのクランプで潰れるため
        # 意図的に見送る（miditrack/CLAUDE.md「Why per-track volume scales
        # Note On velocity...」参照）。
        matching_volumes = [
            value
            for value, ch in zip(volume_changes, volume_change_channels)
            if ch == channel
        ]
        if matching_volumes and matching_volumes[0] < DEFAULT_TRACK_VOLUME_PERCENT:
            source_volume_percent = matching_volumes[0]
    else:
        editable = False
        reason = "multi-channel"

    return TrackInfo(
        index=index,
        name=name,
        channels=sorted_channels,
        note_count=note_count,
        current_program=current_program,
        program_change_count=program_change_count,
        editable=editable,
        reason=reason,
        source_volume_percent=source_volume_percent,
    )


def analyze_midi_file(path: Path) -> tuple[Any, list[TrackInfo]]:
    """MIDIファイルを読み、(mido.MidiFile, トラック解析結果の一覧) を返す。"""
    mido = import_mido()
    try:
        midi_file = mido.MidiFile(path)
    except (OSError, EOFError, ValueError) as error:
        raise MidiTrackError(f"MIDIを読み込めません: {path}: {error}") from error

    if len(midi_file.tracks) == 0:
        raise MidiTrackError("トラックが1つもありません")

    tracks = [analyze_track(track, index) for index, track in enumerate(midi_file.tracks)]

    # CC7はMIDIチャンネル単位の状態なので、そのチャンネルを使うノートありトラックが
    # 自分1つだけの場合にのみsource_volume_percentを採用する。共有チャンネル
    # （例: nsf2midiのNOISE/PCMは両方ch10）でCC7を採用すると、後段のapply_assignments()
    # がそのチャンネルのCC7を書き換える際に他のトラックへ干渉してしまうため。
    channel_track_counts: dict[int, int] = {}
    for track in tracks:
        if track.note_count > 0:
            for channel in track.channels:
                channel_track_counts[channel] = channel_track_counts.get(channel, 0) + 1

    def _resolve_occupancy(track: TrackInfo) -> TrackInfo:
        if track.source_volume_percent == DEFAULT_TRACK_VOLUME_PERCENT:
            return track
        if len(track.channels) != 1 or channel_track_counts.get(track.channels[0], 0) != 1:
            return dataclasses.replace(track, source_volume_percent=DEFAULT_TRACK_VOLUME_PERCENT)
        return track

    tracks = [_resolve_occupancy(track) for track in tracks]

    if not any(track.note_count > 0 for track in tracks):
        raise MidiTrackError("演奏データのあるトラックがありません")

    return midi_file, tracks


def validate_assignments(
    tracks: list[TrackInfo], raw_assignments: dict[int, int | None]
) -> dict[int, int]:
    """PATCH /api/session/tracks の入力を検証し、有効な割り当てだけを返す。

    値がNone（＝「変更しない」）のキーは結果から除外する。
    """
    tracks_by_index = {track.index: track for track in tracks}
    validated: dict[int, int] = {}
    for track_index, program in raw_assignments.items():
        if program is None:
            continue
        track = tracks_by_index.get(track_index)
        if track is None:
            raise WebValidationError(f"トラック番号が不正です: {track_index}")
        if not track.editable:
            reason_ja = {
                "percussion": "パーカッションチャンネル（ch10）のため変更できません",
                "multi-channel": "複数チャンネルを含むため変更できません",
                "no-notes": "ノートがないため変更できません",
            }.get(track.reason or "", "変更できないトラックです")
            raise WebValidationError(f"トラック{track_index}: {reason_ja}")
        if not isinstance(program, int) or isinstance(program, bool) or not 0 <= program <= 127:
            raise WebValidationError(f"GMプログラム番号は0-127の範囲で指定してください: {program}")
        validated[track_index] = program
    return validated


def validate_volumes(
    tracks: list[TrackInfo], raw_volumes: dict[int, int | None]
) -> dict[int, int]:
    """トラック別音量（0-200%）を検証し、そのトラックの初期値（source_volume_percent、
    通常は100%だが変換元CC7があれば異なる）と一致する値だけを除外して返す。
    """
    tracks_by_index = {track.index: track for track in tracks}
    validated: dict[int, int] = {}
    for track_index, volume in raw_volumes.items():
        if volume is None:
            continue
        track = tracks_by_index.get(track_index)
        if track is None:
            raise WebValidationError(f"トラック番号が不正です: {track_index}")
        if track.note_count == 0:
            raise WebValidationError(f"トラック{track_index}: ノートがないため音量を変更できません")
        if not isinstance(volume, int) or isinstance(volume, bool):
            raise WebValidationError(f"トラック音量は整数で指定してください: {volume}")
        if not MIN_TRACK_VOLUME_PERCENT <= volume <= MAX_TRACK_VOLUME_PERCENT:
            raise WebValidationError(
                f"トラック音量は{MIN_TRACK_VOLUME_PERCENT}-{MAX_TRACK_VOLUME_PERCENT}%の"
                f"範囲で指定してください: {volume}"
            )
        if volume == track.source_volume_percent:
            continue
        validated[track_index] = volume
    return validated


def validate_speed_ratio(value: Any) -> float:
    """速度倍率を検証する。1.0が既定（変更なし）。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise WebValidationError(f"速度倍率は数値で指定してください: {value!r}")
    number = float(value)
    if not (MIN_SPEED_RATIO <= number <= MAX_SPEED_RATIO):
        raise WebValidationError(
            f"速度倍率は{MIN_SPEED_RATIO}〜{MAX_SPEED_RATIO}の範囲で指定してください: {number}"
        )
    return number


def validate_transpose_semitones(value: Any) -> int:
    """移調量（半音）を検証する。小数は明示的に拒否する（ピッチベンドは非対応）。"""
    if isinstance(value, bool) or not isinstance(value, int):
        raise WebValidationError(f"ピッチ（半音）は整数で指定してください: {value!r}")
    if not (MIN_TRANSPOSE_SEMITONES <= value <= MAX_TRANSPOSE_SEMITONES):
        raise WebValidationError(
            f"ピッチ（半音）は{MIN_TRANSPOSE_SEMITONES}〜{MAX_TRANSPOSE_SEMITONES}の"
            f"範囲で指定してください: {value}"
        )
    return value


def _validate_variation_axis(
    values: list[Any] | None,
    default: list[Any],
    *,
    label: str,
    max_count: int,
    validate_one: Any,
) -> list[Any]:
    """バリエーション軸（速度またはピッチ）1本ぶんのリストを検証する。

    要素ごとの検証はvalidate_speed_ratio()/validate_transpose_semitones()に
    委ね、ここでは「リストとしての」形式・件数・重複を扱う。
    """
    if values is None:
        return list(default)
    if not isinstance(values, list) or len(values) == 0:
        raise WebValidationError(f"{label}は空でないリストで指定してください")
    if len(values) > max_count:
        raise WebValidationError(f"{label}は最大{max_count}個までです")
    ordered: list[Any] = []
    for value in values:
        validated = validate_one(value)
        # 同じ値の重複は無駄なレンダリング・ZIP内の重複ファイル名を生むため、
        # 最初の出現順を保ったまま除く。
        if validated not in ordered:
            ordered.append(validated)
    return ordered


def validate_variation_options(
    speeds: list[Any] | None, transposes: list[Any] | None
) -> tuple[list[float], list[int]]:
    """バリエーション一括生成（POST /api/variations）の速度・ピッチ一覧を検証する。

    クライアント側の無効化に頼らず、ここで組み合わせ数の上限も含めて再検証する
    （convert.validate_convert_options()等と同じ姿勢）。要素ごとの範囲・型検査は
    単体変換のvalidate_speed_ratio()/validate_transpose_semitones()をそのまま
    再利用し、検証ルールが2箇所に分岐しないようにする。
    """
    parsed_speeds = _validate_variation_axis(
        speeds,
        DEFAULT_VARIATION_SPEEDS,
        label="速度倍率",
        max_count=MAX_VARIATION_SPEED_COUNT,
        validate_one=validate_speed_ratio,
    )
    parsed_transposes = _validate_variation_axis(
        transposes,
        DEFAULT_VARIATION_TRANSPOSES,
        label="ピッチ",
        max_count=MAX_VARIATION_TRANSPOSE_COUNT,
        validate_one=validate_transpose_semitones,
    )
    if len(parsed_speeds) * len(parsed_transposes) > MAX_VARIATION_COUNT:
        raise WebValidationError(
            f"速度×ピッチの組み合わせ数が多すぎます（最大{MAX_VARIATION_COUNT}件）"
        )
    return parsed_speeds, parsed_transposes
    return value


def _scale_tempo(midi_file: Any, speed: float) -> None:
    """全トラックのset_tempoメタをspeedで割る。1つも無ければ挿入する。

    nsf2midi/vgm2midiはtick 0に1つだけ、spc2midi(VGMTrans)は曲中にも
    テンポ変化を出しうるが、「存在する全set_tempoを一律に割る」でどちらも
    正しく速度倍率が反映される。
    """
    mido = import_mido()
    found = False
    for track in midi_file.tracks:
        for message in track:
            if message.is_meta and message.type == "set_tempo":
                found = True
                scaled = round(message.tempo / speed)
                message.tempo = max(MIN_TEMPO_MICROSECONDS, min(MAX_TEMPO_MICROSECONDS, scaled))
    if found:
        return
    scaled = round(DEFAULT_TEMPO_MICROSECONDS / speed)
    tempo = max(MIN_TEMPO_MICROSECONDS, min(MAX_TEMPO_MICROSECONDS, scaled))
    midi_file.tracks[0].insert(0, mido.MetaMessage("set_tempo", tempo=tempo, time=0))


def calculate_duration_seconds(midi_file: Any) -> float:
    """全トラック共通のテンポマップでMIDI全体の演奏時間を秒単位で返す。

    type-2 MIDIにもアプリ内のピアノロールと同じ「全トラック横断のテンポ」解釈を
    適用する。MidoのMidiFile.lengthはtype-2で例外にするため、適用済みMIDIを
    すでにメモリに持つレンダー経路ではこの関数を使う。
    """
    current_tempo = DEFAULT_TEMPO_MICROSECONDS
    previous_tick = 0
    elapsed_seconds = 0.0
    tempo_changes: list[tuple[int, int]] = []
    end_ticks: list[int] = []
    for track in midi_file.tracks:
        absolute_tick = 0
        for message in track:
            absolute_tick += message.time
            if message.is_meta and message.type == "set_tempo":
                tempo_changes.append((absolute_tick, message.tempo))
        end_ticks.append(absolute_tick)
    for tick, tempo in sorted(tempo_changes):
        elapsed_seconds += (tick - previous_tick) * current_tempo / 1_000_000 / midi_file.ticks_per_beat
        previous_tick = tick
        current_tempo = tempo
    return elapsed_seconds + (
        (max(end_ticks, default=0) - previous_tick)
        * current_tempo
        / 1_000_000
        / midi_file.ticks_per_beat
    )


def _transpose_track(track: Any, semitones: int) -> None:
    """note_on/note_off/polytouchのノート番号を移調する。

    パーカッションチャンネル（ch10）はGMドラムのノート番号が音程ではなく
    打楽器の種類を表すため対象外。0-127を外れたノートはクランプせず削除する
    （note_on/note_offは同じノート番号なので必ず対で落ち、鳴りっぱなしには
    ならない）。削除は_filter_track()を再利用し、トラック総tick長を保つ。
    """

    def keep(message: Any) -> bool:
        if message.is_meta:
            return True
        if message.type not in ("note_on", "note_off", "polytouch"):
            return True
        if getattr(message, "channel", None) == PERCUSSION_CHANNEL:
            return True
        new_note = message.note + semitones
        if not 0 <= new_note <= 127:
            return False
        message.note = new_note
        return True

    _filter_track(track, keep)


def apply_assignments(
    original_path: Path,
    assignments: dict[int, int],
    output_path: Path,
    volumes: dict[int, int] | None = None,
    source_volumes: dict[int, int] | None = None,
    speed: float = DEFAULT_SPEED_RATIO,
    transpose: int = DEFAULT_TRANSPOSE_SEMITONES,
) -> dict[str, int | float]:
    """原本を読み直し、音色・トラック別Note Onベロシティ倍率・全体の速度/移調を適用して保存する。

    既存のプログラムチェンジがあれば値を書き換えるだけ（delta-time連鎖を壊さない
    ＝タイミング完全維持）。無ければ、そのチャンネルの最初のメッセージの直前に
    time=0 で挿入する（後続のtickは一切ずれない）。

    音量は「絶対音量（100%=CC7=100相当）」として扱う。共有MIDIチャンネルへ新規に
    CC7を送ることはせず、対象トラック内のNote On velocityだけを原本値から倍率変換
    するため、同じチャンネルを使う別トラックの音量へ干渉しない。ただし、そのトラック
    が変換元で単独チャンネルを占有しCC7（source_volumes、既定100未満＝減衰のみ採用、
    詳細はanalyze_track()参照）を持っていた場合は、そのCC7を100へ正規化する
    （既存メッセージの値を書き換えるだけで新規挿入はしない）。これにより、slider値を
    そのままvelocity倍率として適用しても二重に減衰しない。fluidsynthのCC7カーブは
    厳密には線形ではないため、この畳み込みは近似であることに留意
    （miditrack/CLAUDE.md「Why per-track volume scales Note On velocity...」参照）。

    speed/transposeが既定値（1.0・0）のときはテンポ・ノート番号を一切書き換えず、
    常に原本を読み直すapply_assignments()自体の不変条件により、この関数を繰り返し
    呼んでも速度・移調が累積することはない。
    """
    mido = import_mido()
    try:
        midi_file = mido.MidiFile(original_path)
    except (OSError, EOFError, ValueError) as error:
        raise MidiTrackError(f"MIDIを読み込めません: {original_path}: {error}") from error

    updated = 0
    inserted = 0

    for track_index, program in assignments.items():
        if track_index >= len(midi_file.tracks):
            raise WebValidationError(f"トラック番号が不正です: {track_index}")
        track = midi_file.tracks[track_index]

        channel = _single_note_channel(track)
        if channel is None or channel == PERCUSSION_CHANNEL:
            raise WebValidationError(f"トラック{track_index}は編集対象外です")

        existing = [m for m in track if m.type == "program_change" and m.channel == channel]
        if existing:
            for message in existing:
                message.program = program
            updated += 1
        else:
            insert_index = _first_channel_message_index(track, channel)
            new_message = mido.Message(
                "program_change", program=program, channel=channel, time=0
            )
            track.insert(insert_index, new_message)
            inserted += 1

    for track_index, volume in (volumes or {}).items():
        if track_index >= len(midi_file.tracks):
            raise WebValidationError(f"トラック番号が不正です: {track_index}")
        track = midi_file.tracks[track_index]
        if not any(message.type == "note_on" and message.velocity > 0 for message in track):
            # 短区間プレビューでは、曲全体では発音するトラックでも切り出し窓の
            # 中にはノートが無いことがある。PATCH時のvalidate_volumes()が元の
            # トラックに対する編集可否を検証済みなので、ここでは空の窓を無音の
            # まま通し、他トラックのソロ／ミュート処理を失敗させない。
            continue
        for message in track:
            if message.type != "note_on" or message.velocity <= 0:
                continue
            if volume == 0:
                message.velocity = 0
            else:
                message.velocity = max(1, min(127, round(message.velocity * volume / 100)))

        # 変換元CC7（減衰のみ採用、baseline<100）を100へ正規化する。velocity側は
        # 上のループで既にvolume（既定はこのbaseline自身）で倍率変換済みなので、
        # ここでCC7を書き換えないと減衰が二重にかかってしまう。baseline<=0は
        # 分母になれないため対象外（そのトラックは既に無音相当）。
        baseline = (source_volumes or {}).get(track_index, DEFAULT_TRACK_VOLUME_PERCENT)
        if 0 < baseline < DEFAULT_TRACK_VOLUME_PERCENT:
            channel = _single_note_channel(track)
            if channel is not None:
                for message in track:
                    if (
                        message.type == "control_change"
                        and message.control == 7
                        and message.channel == channel
                    ):
                        message.value = max(0, min(127, round(message.value * 100 / baseline)))

    if speed != DEFAULT_SPEED_RATIO:
        _scale_tempo(midi_file, speed)
    if transpose != DEFAULT_TRANSPOSE_SEMITONES:
        for track in midi_file.tracks:
            _transpose_track(track, transpose)

    # ここでは既に編集後のMIDI全体をメモリ上に持っている。保存後に再度
    # MidiFile(path)を開くよりも、レンダー開始を1回分のフルパースだけ短縮できる。
    duration_seconds = round(calculate_duration_seconds(midi_file), 3)
    save_midi_atomic(midi_file, output_path)
    return {
        "updated": updated,
        "inserted": inserted,
        "durationSeconds": duration_seconds,
    }


def _single_note_channel(track: Any) -> int | None:
    """トラックのnote_on/note_offが使う単一チャンネルを返す。0または複数ならNone。"""
    channels = {m.channel for m in track if m.type in ("note_on", "note_off")}
    if len(channels) != 1:
        return None
    return next(iter(channels))


def _first_channel_message_index(track: Any, channel: int) -> int:
    """指定チャンネルを持つ最初のメッセージのインデックスを返す。

    MetaMessage（track_name/set_tempo等）にはchannelがないため、
    hasattrで安全にスキップする。
    """
    for i, message in enumerate(track):
        if getattr(message, "channel", None) == channel:
            return i
    # channels集合の算出元と同じmessageが必ず存在するはずだが、念のためのフォールバック。
    return len(track)


def write_track_subset(
    source_path: Path,
    keep_indices: set[int],
    output_path: Path,
    *,
    strip_bank_select: bool = False,
) -> bool:
    """keep_indices のトラックだけが鳴るMIDIを output_path に書く。

    ゲーム由来SoundFontと汎用GM SoundFontのハイブリッドレンダリング用に、
    1本のMIDIを「音色を手動指定していないトラック」と「手動指定したトラック」
    の2本へ分割する際に使う。keep_indices に含まれないトラックは、トラック
    自体は残したまま非メタメッセージ（note_on/note_off/program_change/
    control_change/pitchwheel等）をすべて取り除き、そのデルタタイムを直後の
    メッセージへ繰り越す。トラックを丸ごと削除しないので、テンポ・拍子などの
    メタイベントがどのトラックにあっても両方の出力に残り、end_of_trackの
    絶対tickも保存される（＝2つの出力の演奏長がそろう）。

    strip_bank_select=True のときは、残すトラックからもバンクセレクト
    （CC0/CC32）を取り除く。spc2midiの出力はVGMTransのBankSelectStyle::GSに
    従ってCC0にprogNum>>7を載せるが、そのbankは「ゲーム由来SoundFontの中での
    バンク」であって汎用GM SoundFontには存在しないため、そのまま送ると
    fluidsynthがプリセットを見つけられず直前の音色を保持してしまう。

    戻り値は「書き出したMIDIにvelocity>0のnote_onが1つでも残っているか」。
    Falseならfluidsynthに渡しても無音なので、呼び出し側でレンダリングを
    省ける。
    """
    mido = import_mido()
    try:
        midi_file = mido.MidiFile(source_path)
    except (OSError, EOFError, ValueError) as error:
        raise MidiTrackError(f"MIDIを読み込めません: {source_path}: {error}") from error

    has_notes = False
    for index, track in enumerate(midi_file.tracks):
        if index in keep_indices:
            if any(m.type == "note_on" and m.velocity > 0 for m in track):
                has_notes = True
            if strip_bank_select:
                _filter_track(track, lambda m: not _is_bank_select(m))
        else:
            _filter_track(track, lambda m: m.is_meta)

    save_midi_atomic(midi_file, output_path)
    return has_notes


def _is_bank_select(message: Any) -> bool:
    return (
        not message.is_meta
        and message.type == "control_change"
        and message.control in (0, 32)
    )


def _filter_track(track: Any, keep: Any) -> None:
    """条件に合わないメッセージを取り除き、そのデルタタイムを直後へ繰り越す。

    末尾で落ちた場合は最後に残ったメッセージ（通常end_of_track）へ加算するので、
    トラック全体の総tick長は不変。track（mido.MidiTrackはlistのサブクラス）を
    その場で置換する。
    """
    carried = 0
    kept: list[Any] = []
    for message in track:
        if not keep(message):
            carried += message.time
            continue
        message.time += carried
        carried = 0
        kept.append(message)
    if carried and kept:
        kept[-1].time += carried
    track[:] = kept


@dataclass(frozen=True)
class MidiWindow:
    """出力時間軸で表した、切り出し済みMIDIのタイムライン範囲。"""

    start_seconds: float
    end_seconds: float


def _tempo_events(midi_file: Any) -> list[tuple[int, int]]:
    """全トラックのテンポイベントを絶対tick順で返す。"""
    events: list[tuple[int, int]] = []
    for track in midi_file.tracks:
        absolute_tick = 0
        for message in track:
            absolute_tick += message.time
            if message.is_meta and message.type == "set_tempo":
                events.append((absolute_tick, message.tempo))
    return sorted(events)


def _seconds_to_tick(midi_file: Any, seconds: float) -> int:
    """テンポマップに従って秒を絶対tickへ変換する。"""
    if seconds <= 0:
        return 0
    elapsed_seconds = 0.0
    previous_tick = 0
    current_tempo = DEFAULT_TEMPO_MICROSECONDS
    for event_tick, event_tempo in _tempo_events(midi_file):
        segment_seconds = (
            (event_tick - previous_tick)
            * current_tempo
            / 1_000_000
            / midi_file.ticks_per_beat
        )
        if elapsed_seconds + segment_seconds >= seconds:
            return previous_tick + round(
                (seconds - elapsed_seconds)
                * 1_000_000
                * midi_file.ticks_per_beat
                / current_tempo
            )
        elapsed_seconds += segment_seconds
        previous_tick = event_tick
        current_tempo = event_tempo
    return previous_tick + round(
        (seconds - elapsed_seconds)
        * 1_000_000
        * midi_file.ticks_per_beat
        / current_tempo
    )


def write_time_window(
    source_path: Path,
    output_path: Path,
    start_seconds: float,
    end_seconds: float,
    *,
    speed: float = DEFAULT_SPEED_RATIO,
) -> MidiWindow:
    """指定時間帯を、独立して発音可能なMIDIとして書き出す。

    start/endは速度適用後の出力時間軸で受け、切り出し対象の原本時間軸へ戻して
    tickを求める。窓の開始時点で有効なprogram change・CC・pitch bendと発音中の
    ノートをtick 0へ復元するため、長いノートも短区間プレビューで鳴る。
    """
    if start_seconds < 0 or end_seconds <= start_seconds or speed <= 0:
        raise WebValidationError("MIDI区間の開始・終了秒または速度が不正です")
    mido = import_mido()
    try:
        source = mido.MidiFile(source_path)
    except (OSError, EOFError, ValueError) as error:
        raise MidiTrackError(f"MIDIを読み込めません: {source_path}: {error}") from error

    output_duration_seconds = calculate_duration_seconds(source) / speed
    effective_end_seconds = min(end_seconds, output_duration_seconds)
    if effective_end_seconds <= start_seconds:
        raise WebValidationError("短区間プレビューを作成できる演奏時間がありません")
    start_tick = _seconds_to_tick(source, start_seconds * speed)
    end_tick = _seconds_to_tick(source, effective_end_seconds * speed)
    if end_tick <= start_tick:
        end_tick = start_tick + 1

    result = mido.MidiFile(type=source.type, ticks_per_beat=source.ticks_per_beat)
    initial_tempo = DEFAULT_TEMPO_MICROSECONDS
    for tick, tempo in _tempo_events(source):
        if tick > start_tick:
            break
        initial_tempo = tempo

    for track_index, source_track in enumerate(source.tracks):
        absolute_tick = 0
        latest_state: dict[tuple[int, str, int | None], Any] = {}
        active_notes: dict[tuple[int, int], list[Any]] = {}
        events: list[tuple[int, int, Any]] = []
        for order, message in enumerate(source_track):
            absolute_tick += message.time
            if message.type == "end_of_track":
                continue
            if absolute_tick < start_tick:
                if (
                    not message.is_meta
                    and message.type not in ("note_on", "note_off")
                    and hasattr(message, "channel")
                ):
                    control = message.control if message.type == "control_change" else None
                    latest_state[(message.channel, message.type, control)] = message.copy(time=0)
                if message.type == "note_on" and message.velocity > 0:
                    active_notes.setdefault((message.channel, message.note), []).append(
                        message.copy(time=0)
                    )
                elif message.type == "note_off" or (
                    message.type == "note_on" and message.velocity == 0
                ):
                    notes = active_notes.get((message.channel, message.note), [])
                    if notes:
                        notes.pop(0)
                continue
            if absolute_tick <= end_tick:
                events.append((absolute_tick - start_tick, order, message.copy(time=0)))

        prefix: list[Any] = []
        if track_index == 0:
            prefix.append(mido.MetaMessage("set_tempo", tempo=initial_tempo, time=0))
        prefix.extend(latest_state.values())
        prefix.extend(note for notes in active_notes.values() for note in notes)
        ordered = [(0, index, message) for index, message in enumerate(prefix)]
        ordered.extend((tick, len(prefix) + order, message) for tick, order, message in events)
        ordered.sort(key=lambda item: (item[0], item[1]))
        target = mido.MidiTrack()
        previous_tick = 0
        for event_tick, _order, message in ordered:
            message.time = max(0, event_tick - previous_tick)
            target.append(message)
            previous_tick = event_tick
        target.append(mido.MetaMessage("end_of_track", time=max(0, end_tick - start_tick - previous_tick)))
        result.tracks.append(target)

    save_midi_atomic(result, output_path)
    return MidiWindow(start_seconds=start_seconds, end_seconds=effective_end_seconds)


def save_midi_atomic(midi_file: Any, path: Path) -> None:
    """MIDIを同じディレクトリの一時ファイルから原子的に置換する。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.stem}.tmp{path.suffix}")
    try:
        midi_file.save(temporary_path)
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)
