// timbre.cpp
#include "timbre.h"

#include <cmath>
#include <cstdlib>

namespace nsf2midi {

namespace {

constexpr int kProgramLead1Square = 80;     // 50% デューティ / 素のPSGトーン
constexpr int kProgramLead2Sawtooth = 81;   // 25%/75% デューティ / 中程度の波形粗さ / ノイズ混合バズ
constexpr int kProgramLead5Charang = 84;    // 12.5% デューティ (最も細い)
constexpr int kProgramLead8BassLead = 87;   // 波形が急峻/ノイズ的
constexpr int kProgramPad2Warm = 89;        // なだらかな波形
constexpr int kProgramPad3Polysynth = 90;   // N163多チャンネル (デチューン気味)
constexpr int kProgramPad4Choir = 91;       // N163中程度チャンネル数
constexpr int kProgramDrawbarOrgan = 16;    // S5Bハードウェアエンベロープの持続音

// FDS: 64ステップ波形の隣接差分絶対値合計 (ラップアラウンド込み) をステップ数で
// 割った平均変化量を粗さの指標とする。なだらかな正弦波に近いほど小さく、
// 矩形波・ノイズ的な波形ほど大きくなる。この値自体に物理的な単位はなく、
// 3段階に振り分けるための相対的な目安に過ぎない。
int WaveformRoughness(const std::vector<int>& wave) {
    if (wave.size() < 2) return 0;
    long total = 0;
    for (size_t i = 0; i < wave.size(); i++) {
        int next = wave[(i + 1) % wave.size()];
        total += std::abs(next - wave[i]);
    }
    return static_cast<int>(total / static_cast<long>(wave.size()));
}

int GmProgramForFds(const TimbreSnapshot& s) {
    int roughness = WaveformRoughness(s.fds_wave_table);
    if (roughness < 4) return kProgramPad2Warm;
    if (roughness < 12) return kProgramLead2Sawtooth;
    return kProgramLead8BassLead;
}

// N163はチャンネル同時使用数が増えるほど1チャンネルあたりのサンプルレートが
// 下がり (nFrequencyLookupTable が nActiveChannels で変わる、
// third_party/NotSoFatso/Wave_N106.h)、デチューン気味のオルガン/コーラス的な
// 質感になることが知られている (NESdev wiki、FamiTracker解説等で広く言及される
// N163の特性)。この既知の傾向をアクティブチャンネル数だけから引く粗い近似であり、
// 波形の形状そのものは見ない。
int GmProgramForN163(const TimbreSnapshot& s) {
    if (s.n163_active_channels <= 2) return kProgramLead1Square;
    if (s.n163_active_channels <= 5) return kProgramPad4Choir;
    return kProgramPad3Polysynth;
}

int GmProgramForS5b(const TimbreSnapshot& s) {
    if (s.s5b_envelope_enabled) return kProgramDrawbarOrgan;
    if (s.s5b_noise_enabled && s.s5b_tone_enabled) return kProgramLead2Sawtooth;
    return kProgramLead1Square;
}

}  // namespace

int ProgramForDuty(ChannelKind kind, int duty) {
    if (kind == ChannelKind::Vrc6Pulse) {
        if (duty <= 2) return kProgramLead5Charang;
        if (duty <= 5) return kProgramLead2Sawtooth;
        return kProgramLead1Square;
    }
    // ChannelKind::Square (APU): STATE_DUTYCYCLE は0-3のインデックス
    // (DUTY_CYCLE_TABLE={2,4,8,12} の何番目か。0=12.5%,1=25%,2=50%,3=75%)。
    switch (duty) {
        case 0: return kProgramLead5Charang;
        case 2: return kProgramLead1Square;
        default: return kProgramLead2Sawtooth;  // 1 (25%) / 3 (75%)
    }
}

int GmProgramCandidateFor(const TimbreSnapshot& snapshot) {
    switch (snapshot.kind) {
        case ChannelKind::Fds: return GmProgramForFds(snapshot);
        case ChannelKind::N163: return GmProgramForN163(snapshot);
        case ChannelKind::S5B: return GmProgramForS5b(snapshot);
        case ChannelKind::Vrc6Pulse: return ProgramForDuty(ChannelKind::Vrc6Pulse, snapshot.vrc6_duty);
        default: return kProgramLead1Square;
    }
}

}  // namespace nsf2midi
