// midi2wav.cpp
// プロジェクトルートの midi2wav.sh を子プロセスとして起動し、.mid を .wav に
// レンダリングさせる。このリポジトリのパスは "Chill & Relax GAME MUSIC" のように
// スペースと '&' を含むため、system()/popen() のようなシェル経由の実行は確実に
// 壊れる。posix_spawn(p)() で argv 配列を直接渡し、シェルの介在を避ける。
//
// spc2midi 自体には (nsf2midi の gm.mdf のような) 実行ファイル隣接データファイルが
// これまで無かったため、この _NSGetExecutablePath() ベースの実行ファイルパス取得は
// このファイルが初めて spc2midi に持ち込むものである。nsf2midi/src/main.cpp の
// ExecutablePath() / CLAUDE.md の "Why a PATH symlink is safe here" の説明と同じ
// 理由・同じ実装。
#include "midi2wav.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include <mach-o/dyld.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

extern char** environ;

namespace spc2midi {
namespace {

namespace fs = std::filesystem;

// argv[0] を信用せず、OS に直接尋ねて実行中のバイナリの絶対パスを取得する。
std::string ExecutablePath() {
    uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    if (size == 0) return "";
    std::vector<char> buffer(size);
    if (_NSGetExecutablePath(buffer.data(), &size) != 0) return "";
    return std::string(buffer.data());
}

bool IsExecutableFile(const std::string& path) {
    if (path.empty()) return false;
    std::error_code ec;
    if (!fs::is_regular_file(path, ec) || ec) return false;
    return access(path.c_str(), X_OK) == 0;
}

// midi2wav 実行体を解決する:
//   1. MIDI2WAV_BIN 環境変数 -- 設定されているのに実行できなければ致命的エラー
//      (フォールバックしない。tools/make_videos_web.py の REC2ASS_BIN と同じ方針)
//   2. このバイナリの隣にあるリポジトリルートの midi2wav.sh
//      (spc2midi バイナリは "<repo>/spc2midi/spc2midi" に置かれる)
//   3. PATH 上の "midi2wav" (posix_spawnp が自前で解決するので、素のコマンド名を返す)
// 戻り値が空文字列なら (1) が失敗したことを意味し、呼び出し側は変換を中止する。
std::string ResolveMidi2WavBin() {
    const char* env_bin = std::getenv("MIDI2WAV_BIN");
    if (env_bin != nullptr && env_bin[0] != '\0') {
        if (!IsExecutableFile(env_bin)) {
            std::fprintf(stderr,
                "error: MIDI2WAV_BIN is set but not executable: %s\n", env_bin);
            return "";
        }
        return env_bin;
    }

    std::string exe_path = ExecutablePath();
    if (!exe_path.empty()) {
        std::error_code ec;
        fs::path resolved = fs::canonical(exe_path, ec);
        if (!ec) {
            fs::path sibling = resolved.parent_path().parent_path() / "midi2wav.sh";
            if (IsExecutableFile(sibling.string())) {
                return sibling.string();
            }
        }
    }

    return "midi2wav";
}

}  // namespace

bool RenderWav(const fs::path& mid_path, const fs::path& wav_path,
               const std::string& soundfont_path) {
    std::string bin = ResolveMidi2WavBin();
    if (bin.empty()) {
        return false;
    }

    std::vector<std::string> arg_storage;
    arg_storage.push_back(bin);
    arg_storage.push_back("-f");
    if (!soundfont_path.empty()) {
        arg_storage.push_back("-s");
        arg_storage.push_back(soundfont_path);
    }
    arg_storage.push_back("-o");
    arg_storage.push_back(wav_path.string());
    arg_storage.push_back(mid_path.string());

    std::vector<char*> argv;
    argv.reserve(arg_storage.size() + 1);
    for (auto& a : arg_storage) argv.push_back(a.data());
    argv.push_back(nullptr);

    pid_t pid = -1;
    int spawn_rc;
    if (bin.find('/') != std::string::npos) {
        spawn_rc = posix_spawn(&pid, bin.c_str(), nullptr, nullptr, argv.data(), environ);
    } else {
        spawn_rc = posix_spawnp(&pid, bin.c_str(), nullptr, nullptr, argv.data(), environ);
    }
    if (spawn_rc != 0) {
        std::fprintf(stderr, "error: failed to launch midi2wav (%s): %s\n",
                     bin.c_str(), std::strerror(spawn_rc));
        return false;
    }

    int status = 0;
    if (waitpid(pid, &status, 0) == -1) {
        std::fprintf(stderr, "error: waitpid on midi2wav failed: %s\n", std::strerror(errno));
        return false;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        std::fprintf(stderr, "error: midi2wav failed to render %s\n", wav_path.string().c_str());
        return false;
    }

    std::printf("%s\n", wav_path.string().c_str());
    return true;
}

}  // namespace spc2midi
