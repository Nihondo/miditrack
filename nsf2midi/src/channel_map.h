// channel_map.h
// .mdf のスロット (SQUARE-CHANNEL1 など) を NotSoFatso のチャンネル番号
// (third_party/NotSoFatso/NSF_Core.h の CHANNEL_* / N163_WAVE* / S5B_* 定数)
// へ対応付ける。
//
// EXTENDED-CHANNEL1..8 の実際の割当は、NSF が使用する拡張音源チップ
// (CNSFFile::nChipExtensions) によって変わる。1 曲が複数の拡張チップを
// 同時に使うことは実質無いため、最初に見つかったチップ 1 つを採用する。

#pragma once

#include <string>
#include <vector>

#include "mdf.h"
#include "pitch.h"

namespace nsf2midi {

struct ChannelInfo {
    MdfSlot slot;
    int core_channel;      // NotSoFatso の CHANNEL_* 定数値
    ChannelKind kind;
    std::string label;     // トラック名に使う短い識別子
    bool is_rhythm = false;  // true なら MIDI ch.10 (index 9) の打楽器として扱う
};

// nChipExtensions は third_party/NotSoFatso/NSF_Core.h の EXTSOUND_* のビット和。
// 戻り値は演奏に使う順序 (SQUARE1,SQUARE2,TRIANGLE,NOISE,PCM,EXTENDED...)。
std::vector<ChannelInfo> BuildChannelList(int chip_extensions);

// chip_extensions のうち、この移植が未対応の拡張チップ (VRC7 / MMC5 / EPSM) が
// 含まれていれば、その名称を返す (警告表示用)。対応チップのみなら空文字列。
std::string UnsupportedChipName(int chip_extensions);

}  // namespace nsf2midi
