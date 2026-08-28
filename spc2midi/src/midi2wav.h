// midi2wav.h
// --wav オプション用: 書き出した .mid をプロジェクトルートの midi2wav.sh
// (fluidsynth ラッパー) に渡して WAV をレンダリングする。
#pragma once

#include <filesystem>
#include <string>

namespace spc2midi {

// mid_path の MIDI ファイルを wav_path に WAV としてレンダリングする。
// soundfont_path が空なら midi2wav.sh 自身のデフォルト SoundFont 解決に任せる。
// 失敗時は stderr にエラーを出力して false を返す。
bool RenderWav(const std::filesystem::path& mid_path, const std::filesystem::path& wav_path,
                const std::string& soundfont_path);

}  // namespace spc2midi
