// paths.h
// 出力ファイルパスの組み立て。
#pragma once

#include <filesystem>
#include <set>
#include <string>

namespace spc2midi {

// 拡張子を置換したパスを返す (nsf2midi/src/main.cpp の ReplaceExtensionWithMid と同じロジック
// を拡張子引数化したもの)。最後の '.' がパス区切りより後ろにある場合のみ置換する。
std::filesystem::path ReplaceExtension(const std::filesystem::path& path, const std::string& ext);

// --all (全コレクション出力) 用の出力ファイル名 (拡張子なし) を組み立てる。
// 基本形は "<dir>/<input_stem> - <coll_name>"。coll_name が input_stem と一致する場合は
// " - <coll_name>" を省く。コレクション名は VGMTrans 自身の makeSafeFileName() でサニタイズ
// し (util/common.h; '/' と NUL のみ '_' に置換、空なら "unnamed")、used_stems 内で衝突したら
// "_2" 等の連番を付与する。返り値は拡張子なしのパスなので、呼び出し側で
// ReplaceExtension(path, "mid") 等を呼んで使う。used_stems 内の衝突チェックは
// ASCII 小文字化して比較する (APFS がデフォルトで大文字小文字を区別しないため) が、
// 実際に返すファイル名の大文字小文字は変更しない。
std::filesystem::path BuildCollectionOutputStem(const std::filesystem::path& dir,
                                                 const std::string& input_stem,
                                                 const std::string& coll_name,
                                                 std::set<std::string>& used_stems);

}  // namespace spc2midi
