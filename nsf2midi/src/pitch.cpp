#include "pitch.h"

#include <algorithm>
#include <cmath>

namespace nsf2midi {

namespace {

constexpr double kClockNtsc = 1789772.727273;
constexpr double kClockPal = 1662607.0;

double ClockHz(bool is_pal) { return is_pal ? kClockPal : kClockNtsc; }

// period から実周波数 (Hz) を求める。0 または無効な場合は 0.0 を返す。
double FrequencyOf(ChannelKind kind, int period, int n163_active_channels, bool is_pal) {
    const double clk = ClockHz(is_pal);
    switch (kind) {
        case ChannelKind::Square:
            if (period <= 0) return 0.0;
            return clk / (16.0 * (period + 1));
        case ChannelKind::Triangle:
            if (period <= 0) return 0.0;
            return clk / (32.0 * (period + 1));
        case ChannelKind::Vrc6Pulse:
            if (period <= 0) return 0.0;
            return clk / (16.0 * (period + 1));
        case ChannelKind::Vrc6Saw:
            if (period <= 0) return 0.0;
            return clk / (14.0 * (period + 1));
        case ChannelKind::Fds:
            if (period <= 0) return 0.0;
            // NESdev: freq = period * clk / 2^20
            return period * clk / 1048576.0;
        case ChannelKind::N163: {
            if (period <= 0) return 0.0;
            const int n = std::clamp(n163_active_channels, 1, 8);
            // NESdev: freq = period * clk / (N * 15 * 65536)
            return period * clk / (static_cast<double>(n) * 15.0 * 65536.0);
        }
        case ChannelKind::S5B:
            if (period <= 0) return 0.0;
            // AY-3-8910 互換: tone freq = (clk/2) / (16 * period)
            return clk / (32.0 * period);
        case ChannelKind::Noise:
        case ChannelKind::Dpcm:
            // インデックス値であり連続周波数を持たない (呼び出し側で扱う)。
            return 0.0;
    }
    return 0.0;
}

}  // namespace

PitchResult PeriodToNote(ChannelKind kind, int period, int n163_active_channels,
                          int note_number_adjust, bool is_pal) {
    PitchResult result;

    const double freq = FrequencyOf(kind, period, n163_active_channels, is_pal);
    if (freq <= 0.0) {
        result.valid = false;
        return result;
    }

    // MIDI note 69 = A4 = 440Hz
    const double note_f = 69.0 + 12.0 * std::log2(freq / 440.0) + note_number_adjust;

    int note = static_cast<int>(std::lround(note_f));
    double cents = (note_f - note) * 100.0;

    note = std::clamp(note, 0, 127);

    result.valid = true;
    result.note = note;
    result.cents_offset = cents;
    return result;
}

int CentsToPitchBend14(double cents_offset, double bend_range_semitones) {
    if (bend_range_semitones <= 0.0) return 8192;
    const double semitone_offset = cents_offset / 100.0;
    double ratio = semitone_offset / bend_range_semitones;  // -1.0 .. 1.0 が正常範囲
    ratio = std::clamp(ratio, -1.0, 1.0);
    int value = 8192 + static_cast<int>(std::lround(ratio * 8191.0));
    return std::clamp(value, 0, 16383);
}

}  // namespace nsf2midi
