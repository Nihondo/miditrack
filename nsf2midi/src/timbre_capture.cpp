#include "timbre_capture.h"

#include "NSF_Core.h"

namespace nsf2midi {

namespace {

TimbreSnapshot CaptureFds(CNSFCore& core, int channel) {
    TimbreSnapshot s;
    s.kind = ChannelKind::Fds;
    s.fds_wave_table.reserve(64);
    for (int i = 0; i < 64; i++) {
        s.fds_wave_table.push_back(core.GetState(channel, STATE_FDSWAVETABLE, i));
    }
    s.fds_master_volume = core.GetState(channel, STATE_FDSMASTERVOLUME, 0);
    return s;
}

TimbreSnapshot CaptureN163(CNSFCore& core, int channel) {
    TimbreSnapshot s;
    s.kind = ChannelKind::N163;
    int wave_pos_start = core.GetState(channel, STATE_N163WAVEPOS, 0);
    int wave_size = core.GetState(channel, STATE_N163WAVESIZE, 0);
    s.n163_active_channels = core.GetState(channel, STATE_N163NUMCHANNELS, 0);
    if (s.n163_active_channels <= 0) s.n163_active_channels = 1;
    // nRAM は 0x100 バイトの共有領域 (third_party/NotSoFatso/Wave_N106.h)。
    // wave_size は最大でも 0xFC (252) 程度に収まるが、念のため mod 0x100 で
    // 安全に折り返す。
    if (wave_size < 0) wave_size = 0;
    s.n163_wave.reserve(static_cast<size_t>(wave_size));
    for (int i = 0; i < wave_size; i++) {
        int addr = (wave_pos_start + i) & 0xFF;
        s.n163_wave.push_back(core.GetState(channel, STATE_N163WAVE, addr));
    }
    return s;
}

TimbreSnapshot CaptureS5b(CNSFCore& core, int channel) {
    TimbreSnapshot s;
    s.kind = ChannelKind::S5B;
    // AY-3-8910 系ミキサーレジスタ(R7)由来のbChannelMixerは「無効化」ビット
    // (0=有効,1=無効)。third_party/NotSoFatso/NSF_Core.cpp の $07 書き込み処理
    // (mWave_FME07[ch].bChannelMixer = (v >> ch の該当2bit)) が、チャンネルごとに
    // bit0=トーン無効, bit3=ノイズ無効の位置のまま切り出して保持している。
    int mixer = core.GetState(channel, STATE_S5BMIXER, 0);
    s.s5b_tone_enabled = (mixer & 0x01) == 0;
    s.s5b_noise_enabled = (mixer & 0x08) == 0;
    s.s5b_noise_frequency = core.GetState(channel, STATE_S5BNOISEFREQUENCY, 0);
    s.s5b_envelope_enabled = core.GetState(channel, STATE_S5BENVENABLED, 0) != 0;
    // ハードウェアエンベロープ発生器は3チャンネル共有 (実チップ・エミュレータとも
    // チャンネル0の値を参照する。third_party/NotSoFatso/NSF_Core.cpp 参照)。
    s.s5b_envelope_frequency = core.GetState(channel, STATE_S5BENVFREQUENCY, 0);
    s.s5b_envelope_shape = core.GetState(channel, STATE_S5BENVSHAPE, 0);
    return s;
}

TimbreSnapshot CaptureVrc6Pulse(CNSFCore& core, int channel) {
    TimbreSnapshot s;
    s.kind = ChannelKind::Vrc6Pulse;
    s.vrc6_duty = core.GetState(channel, STATE_DUTYCYCLE, 0);
    return s;
}

}  // namespace

TimbreSnapshot CaptureTimbreSnapshot(CNSFCore& core, const ChannelInfo& info) {
    switch (info.kind) {
        case ChannelKind::Fds: return CaptureFds(core, info.core_channel);
        case ChannelKind::N163: return CaptureN163(core, info.core_channel);
        case ChannelKind::S5B: return CaptureS5b(core, info.core_channel);
        case ChannelKind::Vrc6Pulse: return CaptureVrc6Pulse(core, info.core_channel);
        default: return TimbreSnapshot{};
    }
}

}  // namespace nsf2midi
