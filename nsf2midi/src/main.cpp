// main.cpp
// nsf2midi CLI エントリポイント。
//
// third_party/NotSoFatso (CNSFFile/CNSFCore) で NSF を 1 フレームずつ実行し、
// 各フレームのチャンネル状態 (音量・周期) を detector.h の状態機械へ渡して
// ノートオン/オフ・ピッチベンド・CC を判定、smf.h で SMF (format 1) として
// 書き出す。

#include <algorithm>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

#include <mach-o/dyld.h>

#include "NSF_Core.h"
#include "NSF_File.h"
#include "channel_map.h"
#include "chip_render.h"
#include "detector.h"
#include "mdf.h"
#include "smf.h"
#include "track_metadata.h"

namespace {

constexpr int kTicksPerQuarter = 480;
constexpr int kMicrosecondsPerQuarter = 500000;  // 120 BPM 固定
constexpr double kDefaultDurationSec = 180.0;
constexpr int kRhythmMidiChannelReserved = 9;  // MIDI ch.10 (0 始まり); Noise/PCM 用に予約
constexpr int kChipSampleRate = 44100;  // RenderChipWav()/track-metadataが仮定するサンプルレート

struct Options {
    std::string input_path;
    std::string output_path;
    std::string mdf_path;
    int track = 0;
    double duration_sec = -1.0;  // 未指定なら NSFE のトラック長 or 既定値
    bool list_only = false;
    bool force_pal = false;
    bool verbose = false;
    std::string chip_wav_path;   // --chip-wav; 空なら実機ノイズ/DPCMステム出力を行わない
    bool keep_chip_midi = false; // --keep-chip-midi; --chip-wav 指定時も NOISE/PCM を MIDI 化する
    std::string track_metadata_path;  // --track-metadata; 空ならsidecarを書かない
    std::string chip_render_channels; // --chip-render <channels>; 空なら通常のMIDI変換を行う
    long long chip_render_sample_count = -1;  // --sample-count; --chip-renderとセットで使う
};

void PrintUsage(const char* prog) {
    std::fprintf(stderr,
        "usage: %s [options] <input.nsf> [output.mid]\n"
        "\n"
        "options:\n"
        "  -m, --mdf <file>       music definition file (default: gm.mdf next to the executable;\n"
        "                         pass -m default.mdf for exact nsf2midi.exe 0.14 compatibility)\n"
        "  -t, --track <n>        zero-based track index (default: 0)\n"
        "  -d, --duration <sec>   seconds to convert (default: NSFE track length, or 180)\n"
        "  -l, --list             list tracks and exit\n"
        "      --pal              force PAL timing\n"
        "  -v, --verbose          print detected notes to stderr\n"
        "      --chip-wav <file>  render NOISE+DPCM as real chip-emulated audio to <file> instead of\n"
        "                         MIDI GM drum notes (both channels are removed from the .mid unless\n"
        "                         --keep-chip-midi is also given)\n"
        "      --keep-chip-midi   with --chip-wav, also keep NOISE/DPCM as GM drum notes in the .mid\n"
        "      --track-metadata <file>  write a MIDI-track to NES-channel mapping JSON sidecar\n"
        "                         (per-track channel labels, for arbitrary-channel selection\n"
        "                         rendering via --chip-render)\n"
        "      --chip-render <channels> render only <channels> (comma-separated channel labels,\n"
        "                         e.g. NOISE,PCM,TRI -- same labels as --track-metadata/MIDI track\n"
        "                         names) as real chip-emulated audio; skips MIDI conversion\n"
        "                         entirely. Requires --track, --sample-count, <input.nsf>, and a\n"
        "                         <output.wav> path in place of the usual [output.mid]\n"
        "      --sample-count <n> exact sample count to render with --chip-render (44100Hz)\n"
        "  -h, --help             show this help\n",
        prog);
}

// argv[0] cannot be trusted to resolve the executable's real location: when
// a program is found via PATH (the normal case for an installed CLI tool),
// the shell that execve()s it is not required to -- and in practice zsh/bash
// commonly do not -- pass the resolved absolute path as argv[0]. They pass
// back whatever the user typed (e.g. plain "nsf2midi"), which
// std::filesystem::canonical() cannot resolve unless that exact string also
// happens to be a valid path relative to the current directory. This was
// confirmed as the actual cause of a real regression: canonicalizing argv0
// alone produced "./gm.mdf" (i.e. silently fell through to the
// current-directory fallback) for every invocation via a PATH symlink.
// _NSGetExecutablePath() (macOS-only, <mach-o/dyld.h>) asks the OS directly
// for the path of the running executable, independent of argv0 or how the
// process was launched, and is the standard way macOS command-line tools
// solve this. Returns an empty string if unavailable for any reason.
std::string ExecutablePath() {
    uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);  // First call: get required buffer size.
    if (size == 0) return "";
    std::vector<char> buffer(size);
    if (_NSGetExecutablePath(buffer.data(), &size) != 0) return "";
    return std::string(buffer.data());
}

// gm.mdf (reproduction-fidelity preset) is the default when -m/--mdf is not
// given. default.mdf (the frozen 0.14-compatibility reference) remains
// available via an explicit -m default.mdf.
//
// Resolves symlinks before taking the directory: a PATH symlink (e.g.
// /opt/homebrew/bin/nsf2midi -> .../nsf2midi/nsf2midi, the standard way this
// binary is installed) would otherwise make this look for
// /opt/homebrew/bin/gm.mdf, fail silently, and fall back to built-in
// defaults -- meaning gm.mdf's whole reproduction-fidelity pass would never
// actually apply for anyone running the binary via PATH. Prefers
// ExecutablePath() (see above, reliable regardless of how the process was
// launched); only falls back to canonicalizing the passed-in argv0 if that
// API is unavailable, and to argv0 unresolved if canonicalization also
// fails (e.g. neither resolves to a real path at all).
std::string DefaultMdfPathNextToExecutable(const char* argv0) {
    std::string exe_path = ExecutablePath();
    std::error_code ec;
    std::filesystem::path resolved =
        std::filesystem::canonical(exe_path.empty() ? argv0 : exe_path.c_str(), ec);
    std::filesystem::path dir = !ec ? resolved.parent_path()
                                     : std::filesystem::path(argv0).parent_path();
    if (dir.empty()) dir = ".";
    return (dir / "gm.mdf").string();
}

std::string ReplaceExtension(const std::string& path, const std::string& ext) {
    size_t dot = path.find_last_of('.');
    size_t slash = path.find_last_of('/');
    if (dot == std::string::npos || (slash != std::string::npos && dot < slash)) {
        return path + "." + ext;
    }
    return path.substr(0, dot) + "." + ext;
}

std::string ReplaceExtensionWithMid(const std::string& path) {
    return ReplaceExtension(path, "mid");
}

bool ParseArgs(int argc, char** argv, Options& opt) {
    opt.mdf_path = DefaultMdfPathNextToExecutable(argv[0]);

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

        if (arg == "-m" || arg == "--mdf") {
            opt.mdf_path = next_value(arg.c_str());
        } else if (arg == "-t" || arg == "--track") {
            opt.track = std::stoi(next_value(arg.c_str()));
        } else if (arg == "-d" || arg == "--duration") {
            opt.duration_sec = std::stod(next_value(arg.c_str()));
        } else if (arg == "-l" || arg == "--list") {
            opt.list_only = true;
        } else if (arg == "--pal") {
            opt.force_pal = true;
        } else if (arg == "-v" || arg == "--verbose") {
            opt.verbose = true;
        } else if (arg == "--chip-wav") {
            opt.chip_wav_path = next_value(arg.c_str());
        } else if (arg == "--keep-chip-midi") {
            opt.keep_chip_midi = true;
        } else if (arg == "--track-metadata") {
            opt.track_metadata_path = next_value(arg.c_str());
        } else if (arg == "--chip-render") {
            opt.chip_render_channels = next_value(arg.c_str());
        } else if (arg == "--sample-count") {
            opt.chip_render_sample_count = std::stoll(next_value(arg.c_str()));
        } else if (arg == "-h" || arg == "--help") {
            return false;
        } else if (!arg.empty() && arg[0] == '-') {
            std::fprintf(stderr, "error: unknown option %s\n", arg.c_str());
            return false;
        } else {
            positional.push_back(arg);
        }
    }

    if (opt.keep_chip_midi && opt.chip_wav_path.empty()) {
        std::fprintf(stderr, "error: --keep-chip-midi requires --chip-wav\n");
        return false;
    }

    if (!opt.chip_render_channels.empty() && opt.chip_render_sample_count < 0) {
        std::fprintf(stderr, "error: --chip-render requires --sample-count\n");
        return false;
    }
    if (opt.chip_render_sample_count >= 0 && opt.chip_render_channels.empty()) {
        std::fprintf(stderr, "error: --sample-count requires --chip-render\n");
        return false;
    }

    if (positional.empty()) return false;
    opt.input_path = positional[0];
    if (positional.size() >= 2) opt.output_path = positional[1];
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    using namespace nsf2midi;

    Options opt;
    if (!ParseArgs(argc, argv, opt)) {
        PrintUsage(argv[0]);
        return opt.input_path.empty() ? 1 : 0;
    }

    CNSFFile file;
    if (file.LoadFile(opt.input_path.c_str(), 1, false) != 0) {
        std::fprintf(stderr, "error: failed to load NSF: %s\n", opt.input_path.c_str());
        return 1;
    }

    if (opt.list_only) {
        std::printf("Title:     %s\n", file.szGameTitle ? file.szGameTitle : "(unknown)");
        std::printf("Artist:    %s\n", file.szArtist ? file.szArtist : "(unknown)");
        std::printf("Copyright: %s\n", file.szCopyright ? file.szCopyright : "(unknown)");
        std::printf("Tracks:    %d\n", file.nTrackCount);
        std::printf("Region:    %s\n", file.nIsPal ? "PAL" : "NTSC");
        std::string unsupported = UnsupportedChipName(file.nChipExtensions);
        if (!unsupported.empty()) {
            std::printf("Expansion: %s (unsupported by this port)\n", unsupported.c_str());
        } else if (file.nChipExtensions != 0) {
            auto channels = BuildChannelList(file.nChipExtensions);
            std::printf("Expansion: detected (%zu extra channel(s))\n", channels.size() - 5);
        } else {
            std::printf("Expansion: none\n");
        }
        for (int t = 0; t < file.nTrackCount; t++) {
            const char* label = (file.szTrackLabels && file.szTrackLabels[t]) ? file.szTrackLabels[t] : "";
            if (file.pTrackTime && file.pTrackTime[t] >= 0) {
                std::printf("  [%2d] %s (%.1f sec)\n", t, label, file.pTrackTime[t] / 1000.0);
            } else {
                std::printf("  [%2d] %s\n", t, label);
            }
        }
        return 0;
    }

    // --chip-render: 通常のMIDI変換は一切行わず、指定チャンネルだけを実機音で
    // レンダリングして終了する (-l/--list と同じ早期リターンの一種)。
    // miditrackが --track-metadata sidecar 経由でトラックごとの音源選択を反映
    // させるたびに呼び直す、軽量な「選択レンダリングのみ」モード。
    if (!opt.chip_render_channels.empty()) {
        if (opt.track < 0 || opt.track >= file.nTrackCount) {
            std::fprintf(stderr, "error: track %d out of range (0..%d)\n", opt.track,
                          file.nTrackCount - 1);
            return 1;
        }
        if (opt.output_path.empty()) {
            std::fprintf(stderr, "error: --chip-render requires an <output.wav> path\n");
            return 1;
        }

        std::vector<ChannelInfo> channels = BuildChannelList(file.nChipExtensions);
        std::vector<int> selected;
        size_t pos = 0;
        while (pos <= opt.chip_render_channels.size()) {
            size_t comma = opt.chip_render_channels.find(',', pos);
            std::string label = opt.chip_render_channels.substr(
                pos, comma == std::string::npos ? std::string::npos : comma - pos);
            if (label.empty()) {
                std::fprintf(stderr, "error: --chip-render has an empty channel name\n");
                return 1;
            }
            auto it = std::find_if(channels.begin(), channels.end(),
                                    [&](const ChannelInfo& info) { return info.label == label; });
            if (it == channels.end()) {
                std::fprintf(stderr, "error: unknown --chip-render channel '%s'\n", label.c_str());
                return 1;
            }
            selected.push_back(it->core_channel);
            if (comma == std::string::npos) break;
            pos = comma + 1;
        }

        if (!RenderChipWav(file, opt.track, opt.chip_render_sample_count, selected,
                            opt.output_path)) {
            std::fprintf(stderr, "error: failed to render chip WAV: %s\n",
                          opt.output_path.c_str());
            return 1;
        }
        std::fprintf(stderr, "wrote %s (%zu channel(s))\n", opt.output_path.c_str(),
                      selected.size());
        return 0;
    }

    if (opt.track < 0 || opt.track >= file.nTrackCount) {
        std::fprintf(stderr, "error: track %d out of range (0..%d)\n", opt.track,
                      file.nTrackCount - 1);
        return 1;
    }

    if (opt.output_path.empty()) {
        opt.output_path = ReplaceExtensionWithMid(opt.input_path);
    }

    const bool is_pal = opt.force_pal || (file.nIsPal != 0);

    std::string unsupported = UnsupportedChipName(file.nChipExtensions);
    if (!unsupported.empty()) {
        std::fprintf(stderr, "warning: %s expansion audio is not supported by this port; that channel will be skipped\n",
                      unsupported.c_str());
    }

    MdfFile mdf;
    if (!mdf.Load(opt.mdf_path)) {
        std::fprintf(stderr, "warning: could not read mdf file '%s'; using built-in defaults\n",
                      opt.mdf_path.c_str());
    }

    std::vector<ChannelInfo> channels = BuildChannelList(file.nChipExtensions);

    // MIDI チャンネルを割り当てる。ch.10 (index 9) は Noise/PCM 用に予約する。
    std::vector<int> midi_channel_for(channels.size(), -1);
    {
        int next = 0;
        for (size_t i = 0; i < channels.size(); i++) {
            if (channels[i].is_rhythm) continue;
            if (next == kRhythmMidiChannelReserved) next++;  // 9 を飛ばす
            if (next >= 16) {
                std::fprintf(stderr, "warning: too many channels; '%s' truncated to channel 15\n",
                              channels[i].label.c_str());
                midi_channel_for[i] = 15;
                continue;
            }
            midi_channel_for[i] = next++;
        }
    }

    CNSFCore core;
    if (!core.Initialize()) {
        std::fprintf(stderr, "error: failed to initialize NSF core\n");
        return 1;
    }
    if (!core.SetPlaybackOptions(44100, 1)) {
        std::fprintf(stderr, "error: failed to set playback options\n");
        return 1;
    }
    if (!core.LoadNSF(&file)) {
        std::fprintf(stderr, "error: failed to load NSF into core\n");
        return 1;
    }
    for (int i = 0; i < 29; i++) core.SetChannelOptions(i, 1, 255, 0, 0);
    core.SetPlaybackSpeed(0);
    core.SetTrack(static_cast<BYTE>(opt.track));

    double duration_sec = opt.duration_sec;
    if (duration_sec < 0) {
        if (file.pTrackTime && file.pTrackTime[opt.track] >= 0) {
            duration_sec = file.pTrackTime[opt.track] / 1000.0;
        } else {
            duration_sec = kDefaultDurationSec;
        }
    }

    const double frame_rate = is_pal ? 50.006982 : 60.098814;
    const double ticks_per_frame = kTicksPerQuarter * 2.0 / frame_rate;  // 120BPM -> 2 quarter/sec
    const int total_frames = static_cast<int>(duration_sec * frame_rate);

    SmfWriter smf(kTicksPerQuarter);

    MidiTrack& conductor = smf.AddTrack();
    conductor.TrackName(0, file.szGameTitle ? file.szGameTitle : "nsf2midi");
    conductor.SetTempo(0, kMicrosecondsPerQuarter);
    conductor.TimeSignature(0, 4, 2);
    if (file.szCopyright) conductor.CopyrightNotice(0, file.szCopyright);
    conductor.EndOfTrack(static_cast<uint32_t>(total_frames * ticks_per_frame));

    struct ActiveChannel {
        ChannelInfo info;
        MidiTrack* track;
        std::unique_ptr<PitchedChannelDetector> pitched;
        std::unique_ptr<RhythmChannelDetector> rhythm;
    };
    std::vector<ActiveChannel> active;

    for (size_t i = 0; i < channels.size(); i++) {
        const ChannelInfo& info = channels[i];
        // 値コピー: --chip-wav 指定時に NOISE/DPCM だけ channel_enabled を
        // 上書きして MIDI から除外する (実機ノイズ側の二重発音を防ぐ)。
        // .mdf 側の設定そのものは変更しない。
        ChannelConfig cfg = mdf.Get(info.slot);
        if (!opt.chip_wav_path.empty() && !opt.keep_chip_midi &&
            (info.kind == ChannelKind::Noise || info.kind == ChannelKind::Dpcm)) {
            cfg.channel_enabled = false;
        }
        if (!cfg.channel_enabled) continue;

        ActiveChannel ac;
        ac.info = info;
        ac.track = &smf.AddTrack();
        if (info.is_rhythm) {
            ac.rhythm = std::make_unique<RhythmChannelDetector>(
                info, cfg, info.kind == ChannelKind::Dpcm, opt.verbose);
        } else {
            ac.pitched = std::make_unique<PitchedChannelDetector>(
                info, cfg, midi_channel_for[i], is_pal, opt.verbose);
        }
        active.push_back(std::move(ac));
    }

    double tick_accum = 0.0;
    for (int frame = 0; frame < total_frames; frame++) {
        core.RunOneFrame();
        uint32_t tick = static_cast<uint32_t>(tick_accum);

        for (auto& ac : active) {
            FrameState state;
            state.volume = core.GetState(ac.info.core_channel, STATE_VOLUME, 0);
            state.period = core.GetState(ac.info.core_channel, STATE_PERIOD, 0);
            if (ac.info.kind == ChannelKind::N163) {
                state.n163_active_channels =
                    core.GetState(N163_WAVE1, STATE_N163NUMCHANNELS, 0);
                if (state.n163_active_channels <= 0) state.n163_active_channels = 1;
            }
            if (ac.info.kind == ChannelKind::Square || ac.info.kind == ChannelKind::Vrc6Pulse) {
                state.duty = core.GetState(ac.info.core_channel, STATE_DUTYCYCLE, 0);
            }
            if (ac.info.kind == ChannelKind::Noise) {
                state.noise_short_mode = core.GetState(CHANNEL_NOISE, STATE_DUTYCYCLE, 0);
            }
            if (ac.info.kind == ChannelKind::Dpcm) {
                // STATE_DPCMSAMPLELENGTH はサンプル起動を検出した瞬間だけ非ゼロを返す
                // (読み出すとフラグが消費される) ため、1 フレームに 1 回だけ読み、
                // その生値を dpcm_sample_length として保持する。トリガー判定自体は
                // 従来通り「非ゼロなら起動」を volume 代わりに使う (readme の
                // "リズム音色" 扱いに合わせる)。
                state.dpcm_sample_length = core.GetState(CHANNEL_DPCM, STATE_DPCMSAMPLELENGTH, 0);
                state.dpcm_sample_addr = core.GetState(CHANNEL_DPCM, STATE_DPCMSAMPLEADDR, 0);
                state.volume = state.dpcm_sample_length > 0 ? 127 : 0;
            }

            if (ac.pitched) {
                ac.pitched->ProcessFrame(tick, state, *ac.track);
            } else {
                ac.rhythm->ProcessFrame(tick, state, *ac.track);
            }
        }

        tick_accum += ticks_per_frame;
    }

    uint32_t final_tick = static_cast<uint32_t>(tick_accum);
    for (auto& ac : active) {
        if (ac.pitched) {
            ac.pitched->Finish(final_tick, *ac.track);
        } else {
            ac.rhythm->Finish(final_tick, *ac.track);
        }
    }

    if (!smf.Save(opt.output_path)) {
        std::fprintf(stderr, "error: failed to write %s\n", opt.output_path.c_str());
        return 1;
    }

    std::fprintf(stderr, "wrote %s (%d channels, %.1f sec)\n", opt.output_path.c_str(),
                 static_cast<int>(active.size()), duration_sec);

    // MIDIのトラック順・実時間タイムライン(sampleCount)双方の基準となる値。
    // --chip-wav(レガシー) と --track-metadata の両方がここから算出する。
    const long long chip_sample_count =
        std::llround(static_cast<double>(total_frames) * kChipSampleRate / frame_rate);

    if (!opt.track_metadata_path.empty()) {
        // MIDI 書き出し成功後に実行する: sidecar生成が失敗しても .mid は残す。
        std::vector<TrackMetadataEntry> entries;
        entries.reserve(active.size());
        for (const auto& ac : active) {
            TrackMetadataEntry entry;
            // track 0 はコンダクタートラックなので、active[i] は常に MIDI トラック
            // i+1 に対応する (main() 冒頭の smf.AddTrack() 呼び出し順と一致)。
            entry.track_index = static_cast<int>(entries.size() + 1);
            entry.channel = ac.info.label;
            entries.push_back(std::move(entry));
        }
        if (!WriteTrackMetadata(opt.track_metadata_path, kChipSampleRate, chip_sample_count,
                                 entries)) {
            std::fprintf(stderr, "error: failed to write track metadata: %s\n",
                          opt.track_metadata_path.c_str());
            return 1;
        }
        std::fprintf(stderr, "wrote %s (track metadata)\n", opt.track_metadata_path.c_str());
    }

    if (!opt.chip_wav_path.empty()) {
        // MIDI 書き出し成功後に実行する: ステム生成が失敗しても .mid は残す。
        const std::vector<int> legacy_channels = {CHANNEL_NOISE, CHANNEL_DPCM};
        if (!RenderChipWav(file, opt.track, chip_sample_count, legacy_channels,
                            opt.chip_wav_path)) {
            std::fprintf(stderr, "error: failed to render chip WAV: %s\n",
                          opt.chip_wav_path.c_str());
            return 1;
        }
        std::fprintf(stderr, "wrote %s (chip noise/DPCM)\n", opt.chip_wav_path.c_str());
    }

    return 0;
}
