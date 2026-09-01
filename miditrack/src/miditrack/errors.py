"""miditrack共通の例外型。"""

from __future__ import annotations


class MidiTrackError(Exception):
    """MIDI読み込み・解析・書き込みに関する回復不能なエラー。"""


class WebValidationError(ValueError):
    """APIリクエストの入力検証に失敗したときに送出する（Flask側で400に変換）。"""


class RenderError(MidiTrackError):
    """midi2wav.sh を使ったWAVレンダリングに失敗したときに送出する（Flask側で502に変換）。"""


class ConvertError(MidiTrackError):
    """nsf2midi/spc2midi/vgm2midi を使った音源→MIDI変換に失敗したときに送出する（Flask側で502に変換）。"""


class RubberBandError(MidiTrackError):
    """rubberbandによる実音声ステムの同期に失敗したときに送出する（Flask側で502に変換）。"""


class MixError(MidiTrackError):
    """ffmpegを使った実機ノイズステムとのミックスに失敗したときに送出する（Flask側で502に変換）。"""
