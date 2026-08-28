// spc2midi_root.cpp
#include "spc2midi_root.h"

#include <cstdio>

#include "LogItem.h"

namespace spc2midi {

Spc2MidiRoot g_root;

void Spc2MidiRoot::UI_setRootPtr(VGMRoot** the_root) { *the_root = &g_root; }

// VGMTrans の内部ログは LogManager -> UISink 経由で常にここに届く (spdlog 側のレベルは
// trace に固定されているため、ここでのフィルタが唯一のレベル制御点になる)。
// error/warning は常時 stderr に出し、info/debug は -v が指定されたときだけ出す。
//
// 例外: MAMELoader.cpp の "Failed to open MAME ROM definition JSON" は、spc2midi が対象と
// しないアーケード基板 (MAME) 向けの補助ローダが、あらゆる入力に対して無条件に mame_roms.json
// を探しに行って失敗するだけの内部ノイズ。VGMTrans 公式の vgmtrans-cli でも全く同じメッセージ
// が (対象ファイルの種類に関わらず) 毎回 LOG_LEVEL_ERR で出ることを確認済み。SPC/SPC2/RSN の
// 変換結果には一切影響しないため、非 -v 時は抑制し、-v 指定時のみ他の info/debug と同様に出す。
void Spc2MidiRoot::UI_log(LogItem* item) {
  if (item == nullptr) return;
  if (item->source() == "MAMELoader.cpp") {
    if (verbose_) {
      std::fprintf(stderr, "[%s] %s\n", item->source().c_str(), item->text().c_str());
    }
    return;
  }
  switch (item->logLevel()) {
    case LOG_LEVEL_ERR:
      std::fprintf(stderr, "error: %s\n", item->text().c_str());
      break;
    case LOG_LEVEL_WARN:
      std::fprintf(stderr, "warning: %s\n", item->text().c_str());
      break;
    case LOG_LEVEL_INFO:
    case LOG_LEVEL_DEBUG:
      if (verbose_) {
        std::fprintf(stderr, "[%s] %s\n", item->source().c_str(), item->text().c_str());
      }
      break;
  }
}

// spc2midi は常に main.cpp から明示的な出力パスを渡すため、この経路は本来呼ばれない。
// 呼ばれた場合は想定外の内部経路が実行されたということなので、警告して空パスを返す
// (nsf2midi 同様、黙って動いてしまう実装は避ける)。
std::filesystem::path Spc2MidiRoot::UI_getSaveFilePath(const std::string& suggested_filename,
                                                        const std::string&) {
  std::fprintf(stderr,
      "warning: unexpected UI_getSaveFilePath(\"%s\") call (spc2midi always uses an explicit "
      "output path)\n",
      suggested_filename.c_str());
  return {};
}

std::filesystem::path Spc2MidiRoot::UI_getSaveDirPath(const std::filesystem::path&) {
  std::fprintf(stderr, "warning: unexpected UI_getSaveDirPath() call\n");
  return {};
}

}  // namespace spc2midi
