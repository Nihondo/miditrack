// midi2wav.h
// --wav オプション用: 書き出した .mid をプロジェクトルートの midi2wav.sh
// (fluidsynth ラッパー) に渡して WAV をレンダリングする。
#pragma once

#include <string>

namespace nsf2midi {

// mid_path の MIDI ファイルを wav_path に WAV としてレンダリングする。
// soundfont_path が空なら midi2wav.sh 自身のデフォルト SoundFont 解決に任せる。
// 失敗時は stderr にエラーを出力して false を返す。
bool RenderWav(const std::string& mid_path, const std::string& wav_path,
                const std::string& soundfont_path);

}  // namespace nsf2midi
