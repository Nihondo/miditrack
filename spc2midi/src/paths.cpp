// paths.cpp
#include "paths.h"

#include <algorithm>
#include <cctype>

#include "common.h"  // makeSafeFileName (vgmtranscore の util/)

namespace spc2midi {

namespace {

// APFS はデフォルトで大文字小文字を区別しないため、重複チェックのキーは正規化
// (ASCII 小文字化) して比較する。実際に書き出すファイル名の大文字小文字はそのまま
// 保持する — 正規化するのは used_stems 側の比較キーのみ。
std::string ToLowerAscii(const std::string& s) {
  std::string out = s;
  std::transform(out.begin(), out.end(), out.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return out;
}

}  // namespace

std::filesystem::path ReplaceExtension(const std::filesystem::path& path, const std::string& ext) {
  std::string p = path.string();
  size_t dot = p.find_last_of('.');
  size_t slash = p.find_last_of('/');
  if (dot == std::string::npos || (slash != std::string::npos && dot < slash)) {
    return std::filesystem::path(p + "." + ext);
  }
  return std::filesystem::path(p.substr(0, dot) + "." + ext);
}

std::filesystem::path BuildCollectionOutputStem(const std::filesystem::path& dir,
                                                 const std::string& input_stem,
                                                 const std::string& coll_name,
                                                 std::set<std::string>& used_stems) {
  std::string safe_coll = makeSafeFileName(coll_name).string();
  std::string base = (safe_coll.empty() || safe_coll == input_stem)
                          ? input_stem
                          : input_stem + " - " + safe_coll;

  std::string candidate = base;
  int suffix = 2;
  while (used_stems.count(ToLowerAscii(candidate)) != 0) {
    candidate = base + "_" + std::to_string(suffix++);
  }
  used_stems.insert(ToLowerAscii(candidate));
  return dir / candidate;
}

}  // namespace spc2midi
