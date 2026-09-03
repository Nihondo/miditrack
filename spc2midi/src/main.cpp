// main.cpp
// spc2midi CLI エントリポイント。
//
// VGMTrans (third-party, zlib license; vgmtrans.pin で SHA 固定) の vgmtranscore に
// リンクし、SNES 系サウンドドライバのバイトコードを直接解析するシーケンスパーサ
// (N-SPC / AkaoSnes / KonamiSnes ほか計20ドライバ) を通して .spc/.spc2 を
// VGMColl のリストへ変換する。nsf2midi のような「エミュレートして観測する」推定は
// 行わず、coll->seq()->saveAsMidi() がテンポ・ループ・音色まで正確な SMF を書き出す。
//
// 呼ぶべき VGMTrans API は非公開の CLIVGMRoot (src/ui/cli/CLIVGMRoot.cpp) の実装を
// そのまま踏襲している: g_root.openRawFile() -> g_root.vgmColls() -> それぞれの
// VGMColl に対して coll->seq()->saveAsMidi(path, coll) / conversion::createSF2File(*coll)
// / conversion::createDLSFile(dls, *coll)。

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <set>
#include <stdexcept>
#include <string>
#include <system_error>
#include <vector>

#include "DLSConversion.h"
#include "DLSFile.h"
#include "Options.h"
#include "RawFile.h"
#include "SF2Conversion.h"
#include "SF2File.h"
#include "SPCFile.h"
#include "VGMColl.h"
#include "VGMSeq.h"
#include "paths.h"
#include "spc2midi_root.h"

namespace {

namespace fs = std::filesystem;

struct Options {
  std::string input_path;
  std::string output_path;  // 単一出力時はファイル、--all 時はディレクトリとして解釈
  bool list_only = false;
  bool seq_specified = false;
  int seq_index = 0;
  bool all = false;
  bool want_sf2 = false;
  bool want_dls = false;
  bool verbose = false;
  // 無限ループ区間を展開する回数。ConversionOptions のメンバ初期化子デフォルトは 0
  // (ループへ一度も入らない) だが、Qt 版 GUI が設定を読み込む際のデフォルトは 1 なので
  // それに合わせる。
  int loops = 1;
};

enum class ParseResult { Ok, Help, Error };

void PrintUsage(const char* prog) {
  std::fprintf(stderr,
      "usage: %s [options] <input.spc> [output.mid]\n"
      "\n"
      "input must be a .spc or .spc2 file;\n"
      "the format is auto-detected, so the extension is not inspected.\n"
      "\n"
      "options:\n"
      "  -l, --list         list detected sequences and exit\n"
      "  -s, --seq <n>      zero-based sequence index to convert (default: 0)\n"
      "  -a, --all          convert every detected sequence ([output] is a directory)\n"
      "      --loops <n>    number of times to unroll an infinite loop (default: 1)\n"
      "      --sf2          also write a SoundFont2 (.sf2) file\n"
      "      --dls          also write a DLS (.dls) file\n"
      "  -v, --verbose      print VGMTrans log messages (info/debug) to stderr\n"
      "  -h, --help         show this help\n",
      prog);
}

ParseResult ParseArgs(int argc, char** argv, Options& opt) {
  std::vector<std::string> positional;
  for (int i = 1; i < argc; i++) {
    std::string arg = argv[i];
    auto next_value = [&](const char* name) -> std::string {
      if (i + 1 >= argc) {
        std::fprintf(stderr, "error: %s requires a value\n", name);
        std::exit(2);
      }
      return argv[++i];
    };
    auto next_int = [&](const char* name) -> int {
      std::string text = next_value(name);
      try {
        size_t consumed = 0;
        int value = std::stoi(text, &consumed);
        if (consumed != text.size()) throw std::invalid_argument("trailing characters");
        return value;
      } catch (const std::exception&) {
        std::fprintf(stderr, "error: %s expects an integer, got '%s'\n", name, text.c_str());
        std::exit(2);
      }
    };

    if (arg == "-l" || arg == "--list") {
      opt.list_only = true;
    } else if (arg == "-s" || arg == "--seq") {
      opt.seq_specified = true;
      opt.seq_index = next_int(arg.c_str());
    } else if (arg == "-a" || arg == "--all") {
      opt.all = true;
    } else if (arg == "--loops") {
      opt.loops = next_int(arg.c_str());
    } else if (arg == "--sf2") {
      opt.want_sf2 = true;
    } else if (arg == "--dls") {
      opt.want_dls = true;
    } else if (arg == "-v" || arg == "--verbose") {
      opt.verbose = true;
    } else if (arg == "-h" || arg == "--help") {
      return ParseResult::Help;
    } else if (!arg.empty() && arg[0] == '-') {
      std::fprintf(stderr, "error: unknown option %s\n", arg.c_str());
      return ParseResult::Error;
    } else {
      positional.push_back(arg);
    }
  }

  if (positional.empty()) {
    std::fprintf(stderr, "error: missing input file\n");
    return ParseResult::Error;
  }
  if (positional.size() > 2) {
    std::fprintf(stderr, "error: too many arguments\n");
    return ParseResult::Error;
  }
  opt.input_path = positional[0];
  if (positional.size() >= 2) opt.output_path = positional[1];

  if (opt.seq_specified && opt.all) {
    std::fprintf(stderr, "error: -s/--seq and -a/--all are mutually exclusive\n");
    return ParseResult::Error;
  }
  if (opt.seq_index < 0) {
    std::fprintf(stderr, "error: -s/--seq must be >= 0\n");
    return ParseResult::Error;
  }
  if (opt.loops < 0) {
    std::fprintf(stderr, "error: --loops must be >= 0\n");
    return ParseResult::Error;
  }
  return ParseResult::Ok;
}

// input_path が単体の .spc/.spc2 (SPC700ヘッダ+ID666タグ+64KB ARAMダンプ) として
// 読める場合だけ、未対応ドライバの調査に使える追加情報をstderrへ出す。
//
// VGMTransの約20スキャナはどれも「既知タイトルから採取した固定バイト列パターン」
// 方式で、惜しい一致のスコアやログを一切保持しない(上流にその情報が無い)ため、
// 「次にどのドライバに近いか」はVGMTrans側からは得られない。代わりに、
// spc2midi自身がSPCヘッダを直接読み、ゲームタイトル/アーティスト/コメント/
// ダンパー名(VGMTransのSPCFileクラスが既に正しくパースできるID666タグ)と、
// SPCFileが読まないSPC700初期レジスタのうちPC(エントリポイント)を出力する。
// ゲームタイトルは「この曲のドライバがVGMTrans対応済みドライバの亜種か」を
// 人間やAIエージェントが調べる手がかりに、エントリポイントは新規スキャナ
// パターンを書く際の解析の出発点になる。
//
// .spc2は単体SPCの別拡張子であり、ここでは
// 展開しない — RawFile/SPCFileの構築失敗(シグネチャ不一致や最小サイズ未満)を
// 例外で検知し、その場合は追加情報を出さずに黙って戻る(ReportNoDriver()の
// 既存の固定メッセージだけが残る)。
void ReportSpcHeaderHints(const std::string& input_path) {
  try {
    DiskFile file(input_path);
    SPCFile spc(file);  // シグネチャ不一致や0x10180バイト未満なら例外を投げる
    // SPC700ヘッダの初期レジスタ (PC/A/X/Y/PSW/SP、いずれもSPCFileは読まない)。
    // オフセットは標準SPCファイルフォーマット仕様: 0x25(PC,2byte)+A(1)+X(1)+Y(1)+
    // PSW(1)+SP(1)+予約(2)=9byte で 0x25+9=0x2E となり、SPCFile.cpp の
    // loadID666Tag() がID666タグの開始位置として使う 0x2E と一致することで
    // 裏付けが取れている。SPCFileが上のサイズチェックを通過済みなので安全に読める。
    uint16_t pc = file.readShort(0x25);
    const ID666Tag& tag = spc.id666Tag();
    std::fprintf(stderr,
        "       --- ID666 tag (candidate identification hints) ---\n"
        "       Song title:  %s\n"
        "       Game title:  %s\n"
        "       Artist:      %s\n"
        "       Dumped by:   %s\n"
        "       Comments:    %s\n"
        "       Entry point: $%04X (SPC700 PC register at load time)\n"
        "       If this game's driver is a variant of one VGMTrans already supports,\n"
        "       the game title above is the search term to check VGMTrans's\n"
        "       formats/ tree or issue tracker with. Otherwise, the entry point is\n"
        "       the starting address for tracing the driver's boot code by hand.\n",
        tag.songTitle.c_str(), tag.gameTitle.c_str(), tag.artist.c_str(),
        tag.nameOfDumper.c_str(), tag.comments.c_str(), pc);
  } catch (const std::exception&) {
    // .spc2以外の非SPC入力。追加情報を
    // 出せないだけで、ReportNoDriver()自体は失敗させない。
  }
}

// ファイルは読めたが VGMTrans の20ドライバいずれにも該当しなかった場合のエラー。
// 「壊れている」ではなく「未対応」だと分かるようにする。exit 3 で他の失敗と区別する。
int ReportNoDriver(const std::string& input_path) {
  std::fprintf(stderr,
      "error: no supported SNES sequence driver was recognized in '%s'.\n"
      "       The file loaded correctly, but its music driver is not one of the 20\n"
      "       formats VGMTrans can parse (N-SPC, AkaoSnes, KonamiSnes, RareSnes,\n"
      "       CapcomSnes, SuzukiSnes, HudsonSnes, ...).\n"
      "       Run with -v to see which scanners were tried.\n",
      input_path.c_str());
  ReportSpcHeaderHints(input_path);
  return 3;
}

void PrintList(const std::string& input_path, const std::vector<VGMColl*>& colls) {
  std::printf("File:      %s\n", input_path.c_str());
  std::printf("Sequences: %zu\n", colls.size());
  for (size_t i = 0; i < colls.size(); i++) {
    VGMColl* coll = colls[i];
    VGMSeq* seq = coll->seq();
    std::string driver = seq != nullptr ? seq->formatName() : "?";
    unsigned tracks = seq != nullptr ? seq->nNumTracks : 0;
    std::printf("  [%2zu] \"%s\"  driver=%s  tracks=%u  instrsets=%zu\n", i,
        coll->name().c_str(), driver.c_str(), tracks, coll->instrSets().size());
  }
}

bool SaveMidi(VGMColl* coll, const fs::path& path) {
  VGMSeq* seq = coll->seq();
  if (seq == nullptr) {
    std::fprintf(stderr, "error: collection \"%s\" has no sequence to convert\n",
        coll->name().c_str());
    return false;
  }
  if (!seq->saveAsMidi(path, coll)) {
    std::fprintf(stderr, "error: failed to save MIDI: %s\n", path.string().c_str());
    return false;
  }
  std::printf("%s\n", path.string().c_str());
  return true;
}

bool SaveSf2(VGMColl* coll, const fs::path& path) {
  if (coll->instrSets().empty()) {
    std::fprintf(stderr, "warning: \"%s\" has no instrument set; skipping SF2 output\n",
        coll->name().c_str());
    return true;  // MIDI 出力は成功させる方針なので致命的エラーにはしない
  }
  SF2File* sf2 = conversion::createSF2File(*coll);
  if (sf2 == nullptr) {
    std::fprintf(stderr, "error: failed to build SF2 for \"%s\"\n", coll->name().c_str());
    return false;
  }
  bool ok = sf2->saveSF2File(path);
  delete sf2;
  if (!ok) {
    std::fprintf(stderr, "error: failed to save SF2: %s\n", path.string().c_str());
    return false;
  }
  std::printf("%s\n", path.string().c_str());
  return true;
}

bool SaveDls(VGMColl* coll, const fs::path& path) {
  if (coll->instrSets().empty()) {
    std::fprintf(stderr, "warning: \"%s\" has no instrument set; skipping DLS output\n",
        coll->name().c_str());
    return true;
  }
  DLSFile dls;
  if (!conversion::createDLSFile(dls, *coll)) {
    std::fprintf(stderr, "error: failed to build DLS for \"%s\"\n", coll->name().c_str());
    return false;
  }
  if (!dls.saveDLSFile(path)) {
    std::fprintf(stderr, "error: failed to save DLS: %s\n", path.string().c_str());
    return false;
  }
  std::printf("%s\n", path.string().c_str());
  return true;
}

// mid_path を基準に (拡張子だけ差し替えて) --sf2/--dls を追加出力する共通処理。
bool ConvertOne(VGMColl* coll, const fs::path& mid_path, const Options& opt) {
  bool ok = SaveMidi(coll, mid_path);
  if (opt.want_sf2) {
    ok = SaveSf2(coll, spc2midi::ReplaceExtension(mid_path, "sf2")) && ok;
  }
  if (opt.want_dls) {
    ok = SaveDls(coll, spc2midi::ReplaceExtension(mid_path, "dls")) && ok;
  }
  return ok;
}

}  // namespace

int main(int argc, char** argv) {
  using spc2midi::BuildCollectionOutputStem;
  using spc2midi::g_root;
  using spc2midi::ReplaceExtension;

  Options opt;
  switch (ParseArgs(argc, argv, opt)) {
    case ParseResult::Help:
      PrintUsage(argv[0]);
      return 0;
    case ParseResult::Error:
      PrintUsage(argv[0]);
      return 2;
    case ParseResult::Ok:
      break;
  }

  // openRawFile() は「ファイルを開けない」場合と「1つもドライバが認識しなかった」場合を
  // 同じ false で返す (VGMRoot::openRawFile の実装上、区別する手段がない) ので、
  // I/O エラー (exit 1) とドライバ未検出 (exit 3) を切り分けるためにここで先に存在確認する。
  // is_regular_file() はファイル種別しか見ないため、権限拒否や壊れたファイルは通過して
  // しまう — 実際に開けるかどうかも確認して初めて「読み取り可能」と言える。
  std::error_code ec;
  if (!fs::is_regular_file(opt.input_path, ec) || ec) {
    std::fprintf(stderr, "error: cannot read input file: %s\n", opt.input_path.c_str());
    return 1;
  }
  if (std::ifstream probe(opt.input_path, std::ios::binary); !probe.is_open()) {
    std::fprintf(stderr, "error: cannot read input file: %s\n", opt.input_path.c_str());
    return 1;
  }

  g_root.SetVerbose(opt.verbose);
  g_root.init();

  if (!g_root.openRawFile(opt.input_path) || g_root.vgmColls().empty()) {
    return ReportNoDriver(opt.input_path);
  }

  const std::vector<VGMColl*>& colls = g_root.vgmColls();

  if (opt.list_only) {
    PrintList(opt.input_path, colls);
    return 0;
  }

  ConversionOptions::the().setNumSequenceLoops(opt.loops);

  fs::path input_path(opt.input_path);
  std::string input_stem = input_path.stem().string();
  fs::path input_dir = input_path.has_parent_path() ? input_path.parent_path() : fs::path(".");

  if (opt.all) {
    fs::path out_dir = opt.output_path.empty() ? input_dir : fs::path(opt.output_path);
    std::error_code mkec;
    fs::create_directories(out_dir, mkec);
    if (mkec) {
      std::fprintf(stderr, "error: cannot create output directory '%s': %s\n",
          out_dir.string().c_str(), mkec.message().c_str());
      return 1;
    }

    std::set<std::string> used_stems;
    int ok_count = 0;
    for (VGMColl* coll : colls) {
      fs::path stem = BuildCollectionOutputStem(out_dir, input_stem, coll->name(), used_stems);
      if (ConvertOne(coll, ReplaceExtension(stem, "mid"), opt)) ok_count++;
    }
    std::fprintf(stderr, "converted %d of %zu sequence(s)\n", ok_count, colls.size());
    return ok_count > 0 ? 0 : 1;
  }

  size_t index = static_cast<size_t>(opt.seq_index);
  if (index >= colls.size()) {
    std::fprintf(stderr, "error: -s/--seq %d out of range (found %zu sequence(s); use --list)\n",
        opt.seq_index, colls.size());
    return 2;
  }
  if (colls.size() > 1 && !opt.seq_specified) {
    std::fprintf(stderr,
        "warning: %zu sequences found; converting [0] \"%s\".\n"
        "         Use --list to see all, -s N to pick one, or -a for all.\n",
        colls.size(), colls[0]->name().c_str());
  }

  fs::path mid_path =
      opt.output_path.empty() ? ReplaceExtension(input_path, "mid") : fs::path(opt.output_path);

  return ConvertOne(colls[index], mid_path, opt) ? 0 : 1;
}
