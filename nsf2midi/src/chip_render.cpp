// chip_render.cpp
#include "chip_render.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <vector>

#include "NSF_Core.h"
#include "wav_writer.h"

namespace nsf2midi {

namespace {

constexpr int kSampleRate = 44100;
// GetSamples() 1 回あたりの要求サンプル数 (モノラル)。
constexpr int kChunkSamples = 8192;
// Emulate6502() は runtocycle を 6502 命令 1 個ぶん (~7 サイクル) 超過し得る。
// fTicksPerSample はおよそ 40.58 なのでこれは 1 サンプル分の溢れを生むが、
// バッファには常に要求バイト数より多くの余白を確保しておく
// (third_party/NotSoFatso/NSF_Core.cpp の GetSamples() 実装を参照)。
constexpr int kBufferSlackSamples = 64;

}  // namespace

bool RenderChipWav(const CNSFFile& file, int track, long long target_samples,
                    const std::vector<int>& channels, const std::string& out_path) {
    if (channels.empty()) return false;

    // このレンダリング専用の CNSFCore を確保する。main.cpp の MIDI 化パスが
    // 使うコアとは完全に独立させる。理由は二つ:
    //
    //   1. GetSamples() は終了時に pVRC7Buffer だけを NULL に戻し、pOutput は
    //      書き込んだ末尾を指したまま放置する
    //      (third_party/NotSoFatso/NSF_Core.cpp の GetSamples() 実装終端付近)。
    //      EmulateAPU() は pOutput が非 NULL である限りそこへ書き込み続けるため、
    //      GetSamples() を呼んだ後に同じインスタンスで RunOneFrame() を呼ぶと
    //      直前のバッファの外側へ書き込むヒープ破壊になる。このコアで
    //      RunOneFrame() を呼ぶことは絶対にない。
    //   2. SetAdvancedOptions() (DC オフセット/ポップ対策、下記) を
    //      MIDI 化用コアに影響させないため。
    CNSFCore core;
    if (!core.Initialize()) return false;
    // main.cpp の MIDI 化パスと同じ順序で初期化する (LoadNSF が内部で
    // SetPlaybackOptions を呼び直すため、ここでの呼び出しは実質 LoadNSF 前の
    // 検証用)。
    if (!core.SetPlaybackOptions(kSampleRate, 1)) return false;
    if (!core.LoadNSF(&file)) return false;

    // 全チャンネルを一旦ミュートし、指定されたチャンネルだけ戻す。
    // ミキサフラグは 6502/DMA/フレームシーケンサの実行に一切影響しないため、
    // レジスタ列は MIDI 化用コアと同一になる。
    for (int i = 0; i < 29; i++) core.SetChannelOptions(i, 0, 255, 0, 0);
    for (int channel : channels) {
        if (channel < 0 || channel >= 29) continue;
        core.SetChannelOptions(channel, 1, 255, 0, 0);
    }
    // NOISE と DPCM (と TRIANGLE) は同じ非線形 TND ミックステーブルを通り、
    // SQUARE1/SQUARE2 も同じ非線形 SQUARE ミックステーブルを通る
    // (third_party/NotSoFatso/Wave_TND.h / Wave_Square.h)。これらを個別に
    // レンダリングして加算すると、非線形テーブルの性質上、実機よりも大きな
    // 出力になる。この関数は選択されたチャンネルを常に単一パスでまとめて
    // レンダリングするため、選択にNOISE/DPCM/TRIANGLEやSQUARE1/SQUARE2が
    // 混在していても正しい合成結果になる。

    // DC オフセット/ポップ対策。nDMCOutput は 7bit の DC レベルであり、
    // ハイパスと DMC ポップリデューサを有効にしないと DPCM 単独ステムは
    // 大きな DC 段差と $4011 書き込みのポップを抱える。DPCM が選択に
    // 含まれない場合は無害なので、選択チャンネルによらず常時有効にしておく
    // (bDMCPopReducer=1 はエミュレーション自体を変えるため、MIDI 化用コアとは
    // ビット一致しなくなる — このコアだけの意図的な選択)。
    NSF_ADVANCEDOPTIONS adv{};
    adv.bHighPassEnabled = 1;
    adv.nHighPassBase = 150;  // CNSFCore コンストラクタの既定値と同じ
    adv.bDMCPopReducer = 1;
    core.SetAdvancedOptions(&adv);

    core.SetPlaybackSpeed(0);
    core.SetTrack(static_cast<BYTE>(track));

    WavWriter writer;
    if (!writer.Open(out_path, kSampleRate, 2)) return false;

    std::vector<int16_t> buffer(kChunkSamples + kBufferSlackSamples);
    long long remaining = target_samples;
    while (remaining > 0) {
        const int want = static_cast<int>(remaining < kChunkSamples ? remaining : kChunkSamples);
        const int want_bytes = want * static_cast<int>(sizeof(int16_t));
        const int got_bytes = core.GetSamples(reinterpret_cast<BYTE*>(buffer.data()), want_bytes);
        if (got_bytes <= 0) {
            // これ以上サンプルが得られない (bFade によるフェード終端など)。
            // 残りは無音でパディングして、WAV の実時間を要求どおりに揃える。
            std::vector<int16_t> silence(static_cast<size_t>(remaining), 0);
            writer.WriteMono(silence.data(), silence.size());
            break;
        }
        const int got_samples = got_bytes / static_cast<int>(sizeof(int16_t));
        if (!writer.WriteMono(buffer.data(), static_cast<size_t>(got_samples))) {
            writer.Close();
            return false;
        }
        remaining -= got_samples;
    }

    return writer.Close();
}

}  // namespace nsf2midi
