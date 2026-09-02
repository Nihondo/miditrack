// timbre.h
// FDS/N163/S5B/VRC6 の波形メモリ・デューティ比・ノイズ混合・エンベロープから
// --track-metadata sidecar 向けの GM 音色候補を選ぶ。
//
// vgm2midi の OPN/OPM/OPL 音色候補 (algorithm/connection -> GM Program、
// docs/chip-support.md の「対応中チップの制限解除」参照) と同じ位置づけ:
// MIDIノート列や実際に送出する Program Change を変更するものではなく、
// GM SoundFont試聴時の初期候補としてsidecarへ記録するだけの近似ヒューリスティック
// である。third_party/NotSoFatso には依存しないため、実チップ状態は
// timbre_capture.{h,cpp} が読み出し、このファイルはその結果を受け取るだけ。

#pragma once

#include <vector>

#include "pitch.h"  // ChannelKind

namespace nsf2midi {

// 1回分の音色スナップショット。kind に応じたフィールドだけが意味を持つ。
// ノートオンが一度も発生しなかったチャンネルには生成されない
// (main.cpp 側で std::optional 相当のガードをかける)。
struct TimbreSnapshot {
    ChannelKind kind = ChannelKind::Fds;  // Fds / N163 / S5B / Vrc6Pulse のいずれか

    // --- Fds ---
    std::vector<int> fds_wave_table;  // nWaveTable 64要素、各0-63 (6bitサンプル)
    int fds_master_volume = 0;        // nMainVolume、0-32 (5bit)

    // --- N163 ---
    std::vector<int> n163_wave;    // nRAM[wavePosStart..+waveSize) の生値、各0-15
    int n163_active_channels = 1;  // 同時使用チャンネル数 (1-8)

    // --- S5B (FME-7 / Sunsoft 5B) ---
    bool s5b_tone_enabled = false;
    bool s5b_noise_enabled = false;
    int s5b_noise_frequency = 0;     // 5bit (bNoiseFrequency)
    bool s5b_envelope_enabled = false;
    int s5b_envelope_frequency = 0;  // 16bit (nEnvFreq.W)
    int s5b_envelope_shape = 0;      // 4bit (nEnvelopeShape)

    // --- Vrc6Pulse ---
    int vrc6_duty = 0;  // STATE_DUTYCYCLE の生値 0-7 ((n+1)/16 のn)
};

// デューティ比から GM Program を選ぶ。detector.cpp の
// MaybeSendDutyProgramChange() が実際に送出する Program Change と同じ判定式
// (単一の実装を共有し、候補と実送出が食い違わないようにする)。
// kind は ChannelKind::Square または ChannelKind::Vrc6Pulse のみ有効。
int ProgramForDuty(ChannelKind kind, int duty);

// TimbreSnapshot から GM Program 番号 (0-127) の候補を1つ選ぶ。
int GmProgramCandidateFor(const TimbreSnapshot& snapshot);

}  // namespace nsf2midi
