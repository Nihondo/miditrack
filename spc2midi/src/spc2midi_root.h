// spc2midi_root.h
// spc2midi 用のヘッドレス VGMRoot 実装。
//
// ファイル名を "root.h" ではなく "spc2midi_root.h" にしているのは意図的: APFS はデフォルトで
// 大文字小文字を区別しないため、"root.h" という名前だと同じディレクトリの #include "Root.h"
// (VGMTrans 自身のヘッダ) が量的引用符探索でこのファイル自身を指してしまい、自己インクルード
// ループになって VGMRoot が未定義のままコンパイルエラーになる。この衝突を避けるため常に
// vgmtrans の Root.h と紛れない名前を使うこと。
//
// VGMTrans 公式の src/ui/cli/CLIVGMRoot (複数入力ファイル → 1ファイル1コレクション前提の
// 設計) はコピーせず、必要な仮想関数だけを独自に最小実装する。理由は主に2点:
//   - spc2midi は「1つの .spc から複数シーケンスが見つかる」ケースを主眼に置いており、
//     出力ファイル名の組み立て (-a / -s / 衝突回避) を main.cpp / paths.cpp 側で完結させたい。
//   - UI_getSaveFilePath / UI_getSaveDirPath は対話的な保存先選択を前提にした経路であり、
//     spc2midi のワンショット CLI では呼ばれてはいけない。呼ばれたら警告を出すだけにして
//     「呼ばれても静かに動く」実装を避ける。
#pragma once

#include <filesystem>

#include "Root.h"

namespace spc2midi {

class Spc2MidiRoot : public VGMRoot {
 public:
  void UI_setRootPtr(VGMRoot** the_root) override;
  void UI_log(LogItem* item) override;
  std::filesystem::path UI_getSaveFilePath(const std::string& suggested_filename,
                                            const std::string& extension = "") override;
  std::filesystem::path UI_getSaveDirPath(const std::filesystem::path& suggested_dir = {}) override;

  void SetVerbose(bool verbose) { verbose_ = verbose; }

 private:
  bool verbose_ = false;
};

// 翻訳単位スコープのグローバルインスタンス。VGMRoot::init() が呼ぶ UI_setRootPtr() が
// グローバル pRoot (Root.h externで宣言) にこのアドレスを書き込むため、main() のローカル
// 変数にしてはいけない (スキャナがぶら下がったポインタを掴む)。
extern Spc2MidiRoot g_root;

}  // namespace spc2midi
