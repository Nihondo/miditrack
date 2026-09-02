#include "detector.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

#include "timbre.h"

namespace nsf2midi {

namespace {

constexpr int kRhythmMidiChannel = 9;  // MIDI ch.10 (0 始まり)

// 各音源チップの STATE_VOLUME が取り得る最大値。ベロシティ/Expression の
// 正規化に使う。third_party/NotSoFatso の各 Wave_*.h のビット幅に基づく。
int MaxVolumeOf(ChannelKind kind) {
    switch (kind) {
        case ChannelKind::Square: return 15;       // 4bit エンベロープ
        case ChannelKind::Triangle: return 127;     // 線形カウンタ (7bit)
        case ChannelKind::Noise: return 15;
        case ChannelKind::Dpcm: return 127;
        case ChannelKind::Vrc6Pulse: return 15;
        case ChannelKind::Vrc6Saw: return 63;        // 6bit アキュムレータレート
        case ChannelKind::Fds: return 32;            // 5bit マスタボリューム
        case ChannelKind::S5B: return 15;
        case ChannelKind::N163: return 15;
    }
    return 15;
}

int NormalizeToVelocity(int volume, int max_volume) {
    if (max_volume <= 0) return 0;
    double ratio = std::clamp(static_cast<double>(volume) / max_volume, 0.0, 1.0);
    return static_cast<int>(std::lround(1 + ratio * 126));
}

// デューティ比から GM Program を選ぶ実装は timbre.h/timbre.cpp の
// ProgramForDuty() へ移設した (--track-metadata の音色候補生成と実装を共有し、
// 候補と実際に送出する Program Change が食い違わないようにするため)。

// STATE_PERIOD (0-15, ノイズ周期インデックス。小さいほど高速=高域) と短周期LFSR
// モードから GM ドラムノートを選ぶ。vgm2midi の noiseDrumNote() と同じノート語彙
// (42 Closed Hi-Hat / 38 Acoustic Snare / 45 Low Tom / 37 Side Stick) を踏襲し、
// 2 ツール間でリズムの聴感が揃うようにしている。
int NoiseDrumNote(int period_index, bool short_mode) {
    if (short_mode) return 37;         // 93bit (短周期) LFSR: 金属的な質感
    if (period_index <= 3) return 42;  // 高速 (period 0-3)
    if (period_index <= 10) return 38; // 中速 (period 4-10)
    return 45;                         // 低速 (period 11-15)
}

}  // namespace

// ---------------------------------------------------------------------
// PitchedChannelDetector
// ---------------------------------------------------------------------

PitchedChannelDetector::PitchedChannelDetector(const ChannelInfo& info, const ChannelConfig& cfg,
                                                int midi_channel, bool is_pal, bool verbose)
    : info_(info), cfg_(cfg), midi_channel_(midi_channel), is_pal_(is_pal), verbose_(verbose) {}

void PitchedChannelDetector::WriteHeader(uint32_t tick, MidiTrack& track) {
    track.TrackName(tick, info_.label);
    track.ControlChange(tick, midi_channel_, 0, cfg_.bank_hi);
    track.ControlChange(tick, midi_channel_, 32, cfg_.bank_lo);
    track.ProgramChange(tick, midi_channel_, cfg_.instrument);
    last_program_sent_ = cfg_.instrument;
    track.ControlChange(tick, midi_channel_, 7, cfg_.volume);
    track.ControlChange(tick, midi_channel_, 91, cfg_.reverb);
    track.ControlChange(tick, midi_channel_, 93, cfg_.chorus);
    if (cfg_.pitch_bend_enabled) {
        // RPN 0 (Pitch Bend Sensitivity) = kBendRangeSemitones 半音
        track.ControlChange(tick, midi_channel_, 101, 0);
        track.ControlChange(tick, midi_channel_, 100, 0);
        track.ControlChange(tick, midi_channel_, 6, static_cast<int>(kBendRangeSemitones));
        track.ControlChange(tick, midi_channel_, 38, 0);
    }
    if (cfg_.portament_enabled) {
        track.ControlChange(tick, midi_channel_, 5, 20);   // Portamento Time
        track.ControlChange(tick, midi_channel_, 65, 127);  // Portamento On/Off = On
    }
    header_written_ = true;
}

int PitchedChannelDetector::ComputeVelocity(int volume) const {
    if (!cfg_.velocity) return 100;
    return NormalizeToVelocity(volume, MaxVolumeOf(info_.kind));
}

// デューティ比変化に応じて Program Change を再送する。Square/Vrc6Pulse に限定する
// のは、EXTENDED-CHANNEL スロットが FDS/S5B/N163/Vrc6Saw にも再利用されるため —
// これらのチップに duty という概念はなく、FrameState::duty は -1 (未取得) のまま
// なので実害はないが、ChannelKind でも明示的にガードして意図を明確にする。
// ノートオン時にのみ判定し (発音中のデューティ・フリッカーはタイマー効果として
// 無視)、値が変わった場合のみ送出する (PCスパム防止)。
void PitchedChannelDetector::MaybeSendDutyProgramChange(uint32_t tick, int duty,
                                                          MidiTrack& track) {
    if (!cfg_.duty_program_change_enabled) return;
    if (info_.kind != ChannelKind::Square && info_.kind != ChannelKind::Vrc6Pulse) return;
    if (duty < 0) return;
    int program = ProgramForDuty(info_.kind, duty);
    if (program == last_program_sent_) return;
    track.ProgramChange(tick, midi_channel_, program);
    last_program_sent_ = program;
}

void PitchedChannelDetector::StartNote(uint32_t tick, int note, int volume, MidiTrack& track) {
    if (cfg_.pitch_bend_enabled) {
        // 前のノートが保持していたベンドを引き継がないよう、発音前にセンターへ戻す。
        track.PitchBend(tick, midi_channel_, kPitchBendCenter);
    }
    track.NoteOn(tick, midi_channel_, note, ComputeVelocity(volume));
    current_note_ = note;
    note_active_ = true;
    if (verbose_) {
        std::fprintf(stderr, "[%s] tick=%u note_on note=%d vol=%d\n", info_.label.c_str(), tick,
                     note, volume);
    }
}

void PitchedChannelDetector::StopNote(uint32_t tick, MidiTrack& track) {
    if (note_active_) {
        track.NoteOff(tick, midi_channel_, current_note_);
        note_active_ = false;
        current_note_ = -1;
    }
}

void PitchedChannelDetector::ProcessFrame(uint32_t tick, const FrameState& state,
                                           MidiTrack& track) {
    if (!cfg_.channel_enabled) return;
    if (!header_written_) WriteHeader(tick, track);

    // 検出最低レベル: これ以下ならノートオンせず、鳴っていれば消音する。
    if (state.volume <= cfg_.absolute_divided_point) {
        StopNote(tick, track);
        prev_volume_ = state.volume;
        return;
    }

    PitchResult pitch = PeriodToNote(info_.kind, state.period, state.n163_active_channels,
                                      cfg_.note_number_adjust, is_pal_);
    if (!pitch.valid) {
        StopNote(tick, track);
        prev_volume_ = state.volume;
        return;
    }

    bool trigger = false;
    if (!note_active_) {
        trigger = true;
    } else {
        if (cfg_.frequency_change_enabled && pitch.note != current_note_) trigger = true;
        if (cfg_.level_change_enabled && prev_volume_ >= 0 &&
            (state.volume - prev_volume_) >= cfg_.relative_divided_point) {
            trigger = true;
        }
    }

    if (trigger) {
        if (note_active_ && (cfg_.mono_enabled || cfg_.portament_enabled)) {
            // 単音/ポルタメントモード: 常に前の音を切ってから次の音を鳴らす。
            // 音程が変わらない再トリガー (レベル変化時検出による同音の再アタック)
            // でも NoteOff を省略してはいけない。省略すると NoteOn だけが積み
            // 重なり、ノートオフと対応しないぶら下がりノートになる。
            track.NoteOff(tick, midi_channel_, current_note_);
            if (cfg_.pitch_bend_enabled) {
                // レガート再トリガーでも前の音のベンドを引き継がないよう、センターへ戻す。
                track.PitchBend(tick, midi_channel_, kPitchBendCenter);
            }
            MaybeSendDutyProgramChange(tick, state.duty, track);
            track.NoteOn(tick, midi_channel_, pitch.note, ComputeVelocity(state.volume));
            current_note_ = pitch.note;
            note_active_ = true;
            if (verbose_) {
                std::fprintf(stderr, "[%s] tick=%u note_on note=%d vol=%d (legato)\n",
                             info_.label.c_str(), tick, pitch.note, state.volume);
            }
        } else {
            StopNote(tick, track);
            MaybeSendDutyProgramChange(tick, state.duty, track);
            StartNote(tick, pitch.note, state.volume, track);
        }
    } else if (cfg_.pitch_bend_enabled && note_active_) {
        // ノートオンはせず、半音以内のずれをピッチベンドで表現する。
        int bend = CentsToPitchBend14(pitch.cents_offset, kBendRangeSemitones);
        track.PitchBend(tick, midi_channel_, bend);
    }

    if (note_active_ && (cfg_.attack_enabled || cfg_.decay_enabled) && prev_volume_ >= 0 &&
        state.volume != prev_volume_) {
        int expr = NormalizeToVelocity(state.volume, MaxVolumeOf(info_.kind));
        track.ControlChange(tick, midi_channel_, 11, expr);
    }

    prev_volume_ = state.volume;
}

void PitchedChannelDetector::Finish(uint32_t tick, MidiTrack& track) {
    StopNote(tick, track);
    track.EndOfTrack(tick);
}

// ---------------------------------------------------------------------
// RhythmChannelDetector (Noise / PCM)
// ---------------------------------------------------------------------

RhythmChannelDetector::RhythmChannelDetector(const ChannelInfo& info, const ChannelConfig& cfg,
                                              bool is_dpcm, bool verbose)
    : info_(info), cfg_(cfg), is_dpcm_(is_dpcm), verbose_(verbose) {}

int RhythmChannelDetector::ComputeVelocity(int volume) const {
    if (!cfg_.velocity) return 100;
    return NormalizeToVelocity(volume, MaxVolumeOf(info_.kind));
}

// (addr, length) の組を DPCM サンプルの同一性キーとして、初出順に GM パーカッション
// ノート 35-81 (47 音域) をラウンドロビン割り当てる。vgm2midi の pcmNoteForSample()
// と同じ方式。addr だけでは開始アドレスが同じで長さが違うサンプルを区別できない
// ため、長さも含めてキーにする。
int RhythmChannelDetector::DpcmNoteForSample(int addr, int length) {
    constexpr int kFirstNote = 35;
    constexpr int kNoteCount = 47;  // 35-81
    auto key = std::make_pair(addr, length);
    auto it = dpcm_sample_notes_.find(key);
    if (it != dpcm_sample_notes_.end()) return it->second;
    int note = kFirstNote + static_cast<int>(dpcm_sample_notes_.size() % kNoteCount);
    dpcm_sample_notes_.emplace(key, note);
    return note;
}

void RhythmChannelDetector::WriteHeader(uint32_t tick, MidiTrack& track) {
    // MIDI ch.10 は GM で常にドラムキット固定のため Program Change は送らない。
    track.TrackName(tick, info_.label);
    track.ControlChange(tick, kRhythmMidiChannel, 7, cfg_.volume);
    track.ControlChange(tick, kRhythmMidiChannel, 91, cfg_.reverb);
    track.ControlChange(tick, kRhythmMidiChannel, 93, cfg_.chorus);
    header_written_ = true;
}

void RhythmChannelDetector::ProcessFrame(uint32_t tick, const FrameState& state,
                                          MidiTrack& track) {
    if (!cfg_.channel_enabled) return;
    if (!header_written_) WriteHeader(tick, track);

    if (is_dpcm_) {
        // DPCM: STATE_DPCMSAMPLELENGTH はサンプル起動を検出した瞬間だけ非ゼロを返す
        // (読み出すとフラグが消費される) ため、これをそのままトリガーとして扱う。
        if (state.dpcm_sample_length > 0) {
            int note = cfg_.pcm_sample_map_enabled
                ? DpcmNoteForSample(state.dpcm_sample_addr, state.dpcm_sample_length)
                : std::clamp(cfg_.instrument, 0, 127);
            if (note_active_) track.NoteOff(tick, kRhythmMidiChannel, current_note_);
            track.NoteOn(tick, kRhythmMidiChannel, note, ComputeVelocity(127));
            current_note_ = note;
            note_active_ = true;
            note_off_at_ = tick + 1;
            if (verbose_) {
                std::fprintf(stderr,
                             "[%s] tick=%u note_on note=%d (dpcm trigger, addr=0x%05x len=%d)\n",
                             info_.label.c_str(), tick, note, state.dpcm_sample_addr,
                             state.dpcm_sample_length);
            }
        } else if (note_active_ && tick >= note_off_at_) {
            track.NoteOff(tick, kRhythmMidiChannel, current_note_);
            note_active_ = false;
        }
        return;
    }

    // Noise: 検出最低レベル以下なら消音。
    const int note = cfg_.noise_drum_map_enabled
        ? NoiseDrumNote(state.period, state.noise_short_mode != 0)
        : std::clamp(cfg_.instrument, 0, 127);

    if (state.volume <= cfg_.absolute_divided_point) {
        if (note_active_) {
            track.NoteOff(tick, kRhythmMidiChannel, current_note_);
            note_active_ = false;
        }
        prev_volume_ = state.volume;
        prev_noise_period_ = state.period;
        prev_noise_short_mode_ = state.noise_short_mode;
        return;
    }

    bool trigger = !note_active_;
    if (note_active_ && cfg_.level_change_enabled && prev_volume_ >= 0 &&
        (state.volume - prev_volume_) >= cfg_.relative_divided_point) {
        trigger = true;
    }
    // 周波数変化時検出 (readme.txt §6): ノイズ周期またはLFSRモードが変わったら
    // 再アタックとして扱う。従来この設定 (default.mdf の FrequencyChangeEnabled=1)
    // は読まれておらず、同音量でハット/スネアが交互に鳴るパターンが1音に融合して
    // いた — これはその取りこぼしの修正で、default.mdf を使う既定動作も変わる。
    if (note_active_ && cfg_.frequency_change_enabled && prev_noise_period_ >= 0 &&
        (state.period != prev_noise_period_ ||
         state.noise_short_mode != prev_noise_short_mode_)) {
        trigger = true;
    }

    if (trigger) {
        if (note_active_) track.NoteOff(tick, kRhythmMidiChannel, current_note_);
        track.NoteOn(tick, kRhythmMidiChannel, note, ComputeVelocity(state.volume));
        current_note_ = note;
        note_active_ = true;
        if (verbose_) {
            std::fprintf(stderr, "[%s] tick=%u note_on note=%d vol=%d\n", info_.label.c_str(),
                         tick, note, state.volume);
        }
    }

    prev_volume_ = state.volume;
    prev_noise_period_ = state.period;
    prev_noise_short_mode_ = state.noise_short_mode;
}

void RhythmChannelDetector::Finish(uint32_t tick, MidiTrack& track) {
    if (note_active_) {
        track.NoteOff(tick, kRhythmMidiChannel, current_note_);
        note_active_ = false;
    }
    track.EndOfTrack(tick);
}

}  // namespace nsf2midi
