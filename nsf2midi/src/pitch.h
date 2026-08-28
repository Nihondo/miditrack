// pitch.h
// NotSoFatso の STATE_PERIOD レジスタ値を実周波数、ノート番号、
// ピッチベンド量へ変換する。
//
// 各音源チップの周期→周波数変換式は NESdev Wiki に記載された標準式を用いる。
// (Square/Triangle の分周比のみ third_party/NotSoFatso/Wave_Square.h の
//  ClockMajor() 実装 (nFreqTimer.W + 1 を周期として使う) で裏付けを取った。)

#pragma once

#include <cstdint>

namespace nsf2midi {

enum class ChannelKind {
    Square,      // APU pulse 1/2, MMC5 pulse
    Triangle,    // APU triangle
    Noise,       // APU noise (インデックス周期、リズム扱い)
    Dpcm,        // APU DPCM (リズム扱い)
    Vrc6Pulse,
    Vrc6Saw,
    Fds,
    S5B,         // FME-7 / Sunsoft 5B
    N163,        // Namco 106
};

struct PitchResult {
    bool valid = false;      // period == 0 など、周波数が定義できない場合 false
    int note = 60;           // MIDI ノート番号 (丸め済み, 0-127 にクランプ)
    double cents_offset = 0; // 丸め誤差 (-50 〜 +50 セント程度)
};

// period: STATE_PERIOD の生値。
// n163_active_channels: N163 のときのみ有効な、同時使用チャンネル数 (1-8)。
// note_number_adjust: .mdf の NoteNumberAdjust。
// is_pal: NSF が PAL タイミングかどうか (CPU クロックの選択に使う)。
PitchResult PeriodToNote(ChannelKind kind, int period, int n163_active_channels,
                          int note_number_adjust, bool is_pal);

// cents_offset (-100 〜 +100 目安) を 14bit ピッチベンド値 (0-16383, center 8192)
// に変換する。bend_range_semitones は RPN0 で送出するベンドレンジ。
int CentsToPitchBend14(double cents_offset, double bend_range_semitones);

}  // namespace nsf2midi
