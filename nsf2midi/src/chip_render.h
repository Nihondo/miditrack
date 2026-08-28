// chip_render.h
// 指定した任意のチャンネル集合だけを NotSoFatso で実際に鳴らし、16bit/44100Hz/
// stereo の WAV として書き出す。--chip-wav（NOISE+DPCM固定）と --chip-render
// （任意チャンネル選択）の共通実体。
//
// main.cpp が MIDI 化に使う CNSFCore とは別に、この関数専用の CNSFCore を
// 生成する (理由は chip_render.cpp 内のコメントを参照)。

#pragma once

#include <string>
#include <vector>

// third_party/NotSoFatso/NSF_File.h には include guard がなく、main.cpp が
// 直接 "NSF_File.h" を include した後にこのヘッダ経由で再度 include すると
// 二重定義エラーになる (third_party/NotSoFatso/NSF_Core.h も同じ理由で
// CNSFFile を前方宣言のみに留めている)。CNSFFile はここでは参照/ポインタとして
// しか使わないため、前方宣言だけで足りる。
class CNSFFile;

namespace nsf2midi {

// file/track の指定チャンネル (third_party/NotSoFatso/NSF_Core.h の CHANNEL_*
// / N163_WAVE* / S5B_* 定数値の集合) だけを実機音でレンダリングし、
// target_samples ぶんを out_path に書き出す。target_samples は呼び出し側が
// あらかじめ算出した値をそのまま使う（--chip-wav の通常変換パスでは
// round(total_frames * 44100 / frame_rate)、--chip-render の選択レンダリング
// パスでは --track-metadata sidecar に書かれた sampleCount をそのまま渡す —
// どちらも同じ44.1kHzタイムラインに揃うことが目的）。
// 成功時 true。失敗時 (ファイルが開けない、チャンネル集合が空等) false。
bool RenderChipWav(const CNSFFile& file, int track, long long target_samples,
                    const std::vector<int>& channels, const std::string& out_path);

}  // namespace nsf2midi
