// detector.h
// 1 チャンネル分のノートオン/オフ検出状態機械。
//
// readme.txt §6 (ノートオン検出パラメータ / エンベロープの再現) の記述を
// そのまま条件式に落としたもの:
//   - 検出最低レベル (AbsoluteDividedPoint): これ以下なら消音
//   - 周波数変化時検出 (FrequencyChangeEnabled): ノート番号が変わったら新規ノートオン
//   - レベル変化時検出 (LevelChangeEnabled) + 相対閾値 (RelativeDividedPoint):
//     音量が閾値以上急変したら新規ノートオン (同音連打の検出)
//   - 単音モード (MonoEnabled) / ポルタメント (PortamentEnabled): 音を切れ目なく繋ぐ
//   - ベロシティ制御 (Velocity) / アタック・減衰の再現 (Attack/DecayEnabled):
//     ノートオン時のベロシティ、または発音中の Expression (CC11) で音量を追従

#pragma once

#include <cstdint>
#include <map>
#include <utility>

#include "channel_map.h"
#include "mdf.h"
#include "smf.h"

namespace nsf2midi {

// 1 フレーム分の生の音源状態 (NotSoFatso::GetState から取得)。
struct FrameState {
    int volume = 0;
    int period = 0;
    int n163_active_channels = 1;  // N163 のときのみ意味を持つ
    int duty = -1;                 // Square/Vrc6Pulse のみ意味を持つ (STATE_DUTYCYCLE)
    int noise_short_mode = 0;      // Noise のみ意味を持つ (STATE_DUTYCYCLE: 1=短周期LFSR)
    int dpcm_sample_addr = -1;     // Dpcm のみ意味を持つ (STATE_DPCMSAMPLEADDR)
    int dpcm_sample_length = 0;    // Dpcm のみ意味を持つ (STATE_DPCMSAMPLELENGTH の生値)
};

// 通常の音程付きチャンネル (Square/Triangle/VRC6/FDS/S5B/N163) 用の検出器。
class PitchedChannelDetector {
public:
    PitchedChannelDetector(const ChannelInfo& info, const ChannelConfig& cfg, int midi_channel,
                            bool is_pal, bool verbose = false);

    void ProcessFrame(uint32_t tick, const FrameState& state, MidiTrack& track);
    void Finish(uint32_t tick, MidiTrack& track);

private:
    ChannelInfo info_;
    ChannelConfig cfg_;
    int midi_channel_;
    bool is_pal_;
    bool verbose_;

    bool header_written_ = false;
    bool note_active_ = false;
    int current_note_ = -1;
    int prev_volume_ = -1;
    int last_program_sent_ = -1;  // DutyProgramChangeEnabled 用 (Square/Vrc6Pulse のみ)
    static constexpr double kBendRangeSemitones = 2.0;
    static constexpr int kPitchBendCenter = 8192;

    void WriteHeader(uint32_t tick, MidiTrack& track);
    int ComputeVelocity(int volume) const;
    void StartNote(uint32_t tick, int note, int volume, MidiTrack& track);
    void StopNote(uint32_t tick, MidiTrack& track);
    void MaybeSendDutyProgramChange(uint32_t tick, int duty, MidiTrack& track);
};

// ノイズ/PCM チャンネル用の検出器。GM リズムパート (MIDI ch.10) に固定する。
// 音程情報は持たず、.mdf の Instrument 値をそのまま打楽器ノート番号として使う。
class RhythmChannelDetector {
public:
    RhythmChannelDetector(const ChannelInfo& info, const ChannelConfig& cfg, bool is_dpcm,
                          bool verbose = false);

    void ProcessFrame(uint32_t tick, const FrameState& state, MidiTrack& track);
    void Finish(uint32_t tick, MidiTrack& track);

private:
    ChannelInfo info_;
    ChannelConfig cfg_;
    bool is_dpcm_;
    bool verbose_;

    bool header_written_ = false;
    bool note_active_ = false;
    int current_note_ = -1;  // 現在発音中のノート番号 (NoteOff を対応させるため保持)
    int prev_volume_ = -1;
    int prev_noise_period_ = -1;       // Noise: 直前フレームの STATE_PERIOD
    int prev_noise_short_mode_ = -1;   // Noise: 直前フレームの短周期LFSRモード
    uint32_t note_off_at_ = 0;  // DPCM: 短いヒットとして自動的に消音する予定 tick
    std::map<std::pair<int, int>, int> dpcm_sample_notes_;  // (addr, length) -> GMノート

    void WriteHeader(uint32_t tick, MidiTrack& track);
    int ComputeVelocity(int volume) const;
    int DpcmNoteForSample(int addr, int length);
};

}  // namespace nsf2midi
