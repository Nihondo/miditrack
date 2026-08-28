// mdf.h
// nsf2midi 音色定義ファイル (.mdf) の読み込み。
//
// .mdf は INI 形式で、原本 nsf2midi 0.14 の default.mdf と同じ 13 セクション
// (SQUARE-CHANNEL1/2, EXTENDED-CHANNEL1..8, TRIANGELE-CHANNEL, NOISE-CHANNEL,
// PCM-CHANNEL) を持つ。セクション名・キー名は原本との互換のためそのまま用いる
// (TRIANGELE は原本のタイプミスだが互換のため踏襲する)。

#pragma once

#include <array>
#include <string>

namespace nsf2midi {

// 1 チャンネル分の音色パラメータ。原本 default.mdf のキーと 1:1 対応する。
struct ChannelConfig {
    int  instrument = 80;   // GM プログラム番号 (0-127)
    int  bank_hi = 0;       // Bank Select MSB (CC0)
    int  bank_lo = 0;       // Bank Select LSB (CC32)
    int  reverb = 0;        // CC91
    int  chorus = 0;        // CC93
    bool attack_enabled = true;
    bool decay_enabled = true;
    bool pitch_bend_enabled = true;
    bool velocity = false;              // true: APU 出力レベルからベロシティを可変
    int  volume = 127;                  // CC7
    int  relative_divided_point = 2;    // レベル変化検出の相対閾値
    int  absolute_divided_point = 0;    // ノートオン検出最低レベル
    bool frequency_change_enabled = true;
    bool level_change_enabled = true;
    bool channel_enabled = true;
    bool mono_enabled = false;
    bool portament_enabled = false;
    int  note_number_adjust = 0;
    // 以下は原本 0.14 の .mdf には存在しない拡張キー。既定はすべて無効 (false) で、
    // default.mdf をそのまま使う限り挙動は変わらない。gm.mdf 等の新規プリセットで
    // 明示的に有効化する。
    bool noise_drum_map_enabled = false;      // Noise: 周期+LFSRモードでGMドラムを出し分け
    bool pcm_sample_map_enabled = false;      // PCM: DPCMサンプル(アドレス+長さ)ごとに別ノート
    bool duty_program_change_enabled = false; // Square/VRC6Pulse: デューティ比でProgram Change
};

// .mdf が定義する 13 チャンネルスロット。
enum class MdfSlot {
    Square1,
    Square2,
    Extended1,
    Extended2,
    Extended3,
    Extended4,
    Extended5,
    Extended6,
    Extended7,
    Extended8,
    Triangle,
    Noise,
    Pcm,
    Count,
};

class MdfFile {
public:
    // Triangle スロットの既定値を「単純な音量チャンネル」から「線形カウンタを
    // 音量として誤読しない」設定へ補正する (下の実装コメント参照)。
    MdfFile();

    // .mdf ファイルを読み込む。存在しない/壊れている場合は false を返し、
    // 全スロットは既定値のまま (コンストラクタが設定した Triangle の補正込み)。
    bool Load(const std::string& path);

    const ChannelConfig& Get(MdfSlot slot) const {
        return slots_[static_cast<size_t>(slot)];
    }

private:
    std::array<ChannelConfig, static_cast<size_t>(MdfSlot::Count)> slots_{};
};

}  // namespace nsf2midi
