// test_detector.cpp
// PitchedChannelDetector / RhythmChannelDetector の単体テスト。
//
// MidiTrack のイベント列は private (SmfWriter のみ friend) のため、各テストは
// 実際に SmfWriter::Save() で一時 .mid ファイルへ書き出し、生成された生バイト列
// (NoteOn=0x9n/NoteOff=0x8n/ProgramChange=0xCn) を検査する。これは
// CLAUDE.md が記す手動検証 (mido での確認) と同じ検査対象を自動化したもの。
//
// third_party/NotSoFatso には依存しない (FrameState を直接組み立てて渡すため)。
// ビルド/実行: `make test` (Makefile 参照)。

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "../src/detector.h"
#include "../src/mdf.h"
#include "../src/smf.h"
#include "../src/wav_writer.h"

using namespace nsf2midi;

namespace {

int g_failures = 0;

void Check(bool cond, const char* expr, const char* file, int line) {
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s (%s:%d)\n", expr, file, line);
        g_failures++;
    }
}
#define CHECK(cond) Check((cond), #cond, __FILE__, __LINE__)

std::vector<uint8_t> ReadFile(const std::string& path) {
    std::vector<uint8_t> data;
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return data;
    std::fseek(f, 0, SEEK_END);
    long size = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    data.resize(static_cast<size_t>(size));
    if (size > 0) {
        size_t read = std::fread(data.data(), 1, static_cast<size_t>(size), f);
        (void)read;
    }
    std::fclose(f);
    return data;
}

int CountOccurrences(const std::vector<uint8_t>& bytes, const std::vector<uint8_t>& needle) {
    if (needle.empty() || bytes.size() < needle.size()) return 0;
    int count = 0;
    for (size_t i = 0; i + needle.size() <= bytes.size(); i++) {
        if (std::equal(needle.begin(), needle.end(), bytes.begin() + i)) count++;
    }
    return count;
}

std::vector<uint8_t> RunRhythmDetector(const ChannelInfo& info, const ChannelConfig& cfg,
                                        bool is_dpcm, const std::vector<FrameState>& frames,
                                        const char* tmp_name) {
    SmfWriter smf(480);
    MidiTrack& track = smf.AddTrack();
    RhythmChannelDetector detector(info, cfg, is_dpcm);
    uint32_t tick = 0;
    for (const auto& state : frames) {
        detector.ProcessFrame(tick, state, track);
        tick += 10;
    }
    detector.Finish(tick, track);

    std::string path = std::string("/tmp/") + tmp_name;
    smf.Save(path);
    return ReadFile(path);
}

std::vector<uint8_t> RunPitchedDetector(const ChannelInfo& info, const ChannelConfig& cfg,
                                         const std::vector<FrameState>& frames,
                                         const char* tmp_name) {
    SmfWriter smf(480);
    MidiTrack& track = smf.AddTrack();
    PitchedChannelDetector detector(info, cfg, /*midi_channel=*/0, /*is_pal=*/false);
    uint32_t tick = 0;
    for (const auto& state : frames) {
        detector.ProcessFrame(tick, state, track);
        tick += 10;
    }
    detector.Finish(tick, track);

    std::string path = std::string("/tmp/") + tmp_name;
    smf.Save(path);
    return ReadFile(path);
}

ChannelInfo MakeNoiseInfo() {
    return ChannelInfo{MdfSlot::Noise, /*core_channel=*/0, ChannelKind::Noise, "Noise", true};
}

ChannelInfo MakeDpcmInfo() {
    return ChannelInfo{MdfSlot::Pcm, /*core_channel=*/0, ChannelKind::Dpcm, "DPCM", true};
}

ChannelInfo MakeSquareInfo() {
    return ChannelInfo{MdfSlot::Square1, /*core_channel=*/0, ChannelKind::Square, "Square1",
                        false};
}

ChannelInfo MakeVrc6SawInfo() {
    return ChannelInfo{MdfSlot::Extended3, /*core_channel=*/0, ChannelKind::Vrc6Saw, "Vrc6Saw",
                        false};
}

ChannelConfig DefaultRhythmConfig() {
    ChannelConfig cfg;
    cfg.channel_enabled = true;
    cfg.absolute_divided_point = 0;
    return cfg;
}

}  // namespace

// ---------------------------------------------------------------------
// Noise: 周波数変化時検出 (Step 9)
// ---------------------------------------------------------------------

void TestNoiseFrequencyRetrigger() {
    ChannelConfig cfg = DefaultRhythmConfig();
    cfg.level_change_enabled = false;   // 音量変化検出を切って周波数変化検出だけ見る
    cfg.frequency_change_enabled = true;
    cfg.noise_drum_map_enabled = false;  // instrument 固定ノートで確認 (default.mdf 相当)

    FrameState s1;
    s1.volume = 10;
    s1.period = 3;
    s1.noise_short_mode = 0;

    std::vector<FrameState> frames = {s1, s1, s1};  // 変化なし: 最初の1回だけトリガー
    auto midi = RunRhythmDetector(MakeNoiseInfo(), cfg, false, frames, "noise_no_change.mid");
    int note = std::clamp(cfg.instrument, 0, 127);
    std::vector<uint8_t> note_on = {0x99, static_cast<uint8_t>(note)};
    CHECK(CountOccurrences(midi, note_on) == 1);

    FrameState s2 = s1;
    s2.period = 8;  // period 変化 -> リトリガー
    frames = {s1, s1, s2};
    midi = RunRhythmDetector(MakeNoiseInfo(), cfg, false, frames, "noise_period_change.mid");
    CHECK(CountOccurrences(midi, note_on) == 2);
}

// ---------------------------------------------------------------------
// Noise: ドラムマップ on/off でのノート選択 (Step 10)
// ---------------------------------------------------------------------

void TestNoiseDrumMapSelectsNote() {
    ChannelConfig cfg = DefaultRhythmConfig();
    cfg.noise_drum_map_enabled = true;
    cfg.frequency_change_enabled = false;
    cfg.level_change_enabled = false;

    auto noteFor = [&](int period, int short_mode) -> int {
        FrameState s;
        s.volume = 10;
        s.period = period;
        s.noise_short_mode = short_mode;
        auto midi = RunRhythmDetector(MakeNoiseInfo(), cfg, false, {s}, "noise_map.mid");
        // 最初 (かつ唯一) の Note On のノート番号を、0x99 の直後のバイトとして探す。
        for (size_t i = 0; i + 2 < midi.size(); i++) {
            if (midi[i] == 0x99) return midi[i + 1];
        }
        return -1;
    };

    CHECK(noteFor(0, 0) == 42);   // 高速 -> Closed Hi-Hat
    CHECK(noteFor(6, 0) == 38);   // 中速 -> Acoustic Snare
    CHECK(noteFor(14, 0) == 45);  // 低速 -> Low Tom
    CHECK(noteFor(0, 1) == 37);   // 短周期LFSR -> Side Stick (period に関わらず優先)

    // マップ無効時は instrument 固定 (default.mdf の NOISE-CHANNEL は 59)。
    ChannelConfig cfg_off = DefaultRhythmConfig();
    cfg_off.noise_drum_map_enabled = false;
    cfg_off.instrument = 59;
    FrameState s;
    s.volume = 10;
    s.period = 0;
    auto midi = RunRhythmDetector(MakeNoiseInfo(), cfg_off, false, {s}, "noise_map_off.mid");
    CHECK(CountOccurrences(midi, {0x99, 59}) == 1);
    CHECK(CountOccurrences(midi, {0x99, 42}) == 0);
}

// ---------------------------------------------------------------------
// Noise: NoteOn/Off ペア整合 (current_note_)
// ---------------------------------------------------------------------

void TestNoiseNoteOnOffPairIntegrity() {
    ChannelConfig cfg = DefaultRhythmConfig();
    cfg.noise_drum_map_enabled = true;
    cfg.frequency_change_enabled = true;
    cfg.level_change_enabled = false;

    // period 0 (note 42) -> period 14 (note 45) -> 無音 (最後の NoteOff は 45 に対して
    // 出るべきで、最初のノート 42 に対して出てはいけない)。
    FrameState s1;
    s1.volume = 10;
    s1.period = 0;
    FrameState s2 = s1;
    s2.period = 14;
    FrameState s3 = s1;
    s3.period = 14;
    s3.volume = 0;  // absolute_divided_point 以下 -> 消音

    auto midi = RunRhythmDetector(MakeNoiseInfo(), cfg, false, {s1, s2, s3},
                                   "noise_pair_integrity.mid");
    CHECK(CountOccurrences(midi, {0x99, 42}) == 1);
    CHECK(CountOccurrences(midi, {0x89, 42}) == 1);  // 42 -> 45 の切り替えで一度 Off
    CHECK(CountOccurrences(midi, {0x99, 45}) == 1);
    CHECK(CountOccurrences(midi, {0x89, 45}) == 1);  // 消音時、最後のノート(45)に対してOff
}

// ---------------------------------------------------------------------
// DPCM: サンプル別ノート採番 (Step 11)
// ---------------------------------------------------------------------

void TestDpcmSampleIdentity() {
    ChannelConfig cfg = DefaultRhythmConfig();
    cfg.pcm_sample_map_enabled = true;

    FrameState sample_a;
    sample_a.dpcm_sample_length = 16;
    sample_a.dpcm_sample_addr = 0x1000;
    FrameState silence;
    silence.dpcm_sample_length = 0;
    FrameState sample_b;
    sample_b.dpcm_sample_length = 32;
    sample_b.dpcm_sample_addr = 0x2000;
    FrameState sample_a_again = sample_a;  // 同一 (addr, length) -> 同じノート、再トリガー

    auto midi = RunRhythmDetector(MakeDpcmInfo(), cfg, true,
                                   {sample_a, silence, sample_b, silence, sample_a_again},
                                   "dpcm_identity.mid");

    // 初出順に 35, 36 が割り当てられ、sample_a の再登場は 35 を再利用する。
    CHECK(CountOccurrences(midi, {0x99, 35}) == 2);  // sample_a x2 (初回 + 再トリガー)
    CHECK(CountOccurrences(midi, {0x99, 36}) == 1);  // sample_b x1

    // 同じ開始アドレスで長さが異なるサンプルは別ノートになる。
    FrameState sample_c_same_addr;
    sample_c_same_addr.dpcm_sample_length = 64;  // sample_a と addr は同じだが長さが違う
    sample_c_same_addr.dpcm_sample_addr = 0x1000;
    auto midi2 = RunRhythmDetector(MakeDpcmInfo(), cfg, true, {sample_a, silence, sample_c_same_addr},
                                    "dpcm_identity_length.mid");
    CHECK(CountOccurrences(midi2, {0x99, 35}) == 1);
    CHECK(CountOccurrences(midi2, {0x99, 36}) == 1);  // addr は同じでも別サンプル扱い
}

// ---------------------------------------------------------------------
// Square: デューティ比 -> Program Change (Step 12)
// ---------------------------------------------------------------------

void TestDutyProgramChange() {
    ChannelConfig cfg;
    cfg.channel_enabled = true;
    cfg.duty_program_change_enabled = true;
    cfg.instrument = 80;
    cfg.mono_enabled = true;  // 常に NoteOff->NoteOn のレガート経路も通す

    FrameState duty50;
    duty50.volume = 10;
    duty50.period = 100;
    duty50.duty = 2;  // 50%
    FrameState duty125 = duty50;
    duty125.duty = 0;      // 12.5%
    duty125.period = 120;  // Program Change はノートオン時のみ送出されるため、
                            // 周波数変化を伴わせて新規トリガーを発生させる。
    FrameState duty125_again = duty125;  // 変化なし -> PC 再送しない

    auto midi = RunPitchedDetector(MakeSquareInfo(), cfg, {duty50, duty125, duty125_again},
                                    "duty_program_change.mid");
    // WriteHeader() の初期 PC (80) + duty50->duty125 の1回だけ (2回目は変化なしで抑制)。
    CHECK(CountOccurrences(midi, {0xC0, 80}) == 1);
    CHECK(CountOccurrences(midi, {0xC0, 84}) == 1);  // 12.5% -> charang

    // Vrc6Saw では duty という概念がなく (FrameState::duty は既定 -1)、
    // DutyProgramChangeEnabled を立てても Program Change は初期送出の1回だけ。
    ChannelConfig cfg_saw = cfg;
    auto midi_saw = RunPitchedDetector(MakeVrc6SawInfo(), cfg_saw, {duty50, duty125},
                                        "duty_program_change_saw.mid");
    CHECK(CountOccurrences(midi_saw, {0xC0, 80}) == 1);
    CHECK(CountOccurrences(midi_saw, {0xC0, 84}) == 0);
}

// ---------------------------------------------------------------------
// Triangle: 新しい既定値 (Step 13)
// ---------------------------------------------------------------------

void TestTriangleDefaultsSuppressFalseTrigger() {
    MdfFile mdf;  // Load() を呼ばない = default.mdf 相当 (キー無し)
    const ChannelConfig& tri = mdf.Get(MdfSlot::Triangle);
    CHECK(tri.level_change_enabled == false);
    CHECK(tri.attack_enabled == false);
    CHECK(tri.decay_enabled == false);
    CHECK(tri.velocity == false);
    // 音量ゲート (absolute_divided_point) はコンストラクタで変更していない。
    CHECK(tri.absolute_divided_point == 0);
}

void TestTriangleExplicitMdfKeyWins() {
    std::string path = "/tmp/nsf2midi_test_triangle.mdf";
    FILE* f = std::fopen(path.c_str(), "w");
    CHECK(f != nullptr);
    if (f) {
        std::fputs("[TRIANGELE-CHANNEL]\nLevelChangeEnabled=1\n", f);
        std::fclose(f);
    }

    MdfFile mdf;
    CHECK(mdf.Load(path));
    const ChannelConfig& tri = mdf.Get(MdfSlot::Triangle);
    // 明示的にキーを書いたので、コンストラクタの既定値 (false) より優先される。
    CHECK(tri.level_change_enabled == true);
    // 書いていないキーはコンストラクタの既定値のまま。
    CHECK(tri.attack_enabled == false);
}

// ---------------------------------------------------------------------
// 後方互換性: 新機能 OFF (default.mdf 相当) での出力が従来と一致
// ---------------------------------------------------------------------

void TestBackwardCompatibilityWhenNewFeaturesDisabled() {
    // ChannelConfig の既定値そのまま (noise_drum_map/pcm_sample_map/duty_program_change
    // はすべて false) で、Noise が instrument 固定ノートのまま動くことを確認する。
    ChannelConfig cfg;
    cfg.channel_enabled = true;
    cfg.instrument = 59;  // default.mdf の NOISE-CHANNEL と同じ値
    cfg.absolute_divided_point = 7;
    cfg.level_change_enabled = false;
    cfg.frequency_change_enabled = true;  // default.mdf も 1 だが、Step 9 の修正対象

    FrameState s1;
    s1.volume = 10;
    s1.period = 0;
    FrameState s2 = s1;
    s2.period = 15;  // 周期が変わっても noise_drum_map_enabled=false なのでノート番号は不変

    auto midi = RunRhythmDetector(MakeNoiseInfo(), cfg, false, {s1, s2},
                                   "noise_backward_compat.mid");
    // ノートは常に 59 (instrument) のまま。周期変化でリトリガーはする (Step 9 の修正)
    // が、ノート番号自体は変わらない。
    CHECK(CountOccurrences(midi, {0x99, 59}) == 2);
    CHECK(CountOccurrences(midi, {0x99, 42}) == 0);
}

// --- WavWriter ---------------------------------------------------------

uint32_t ReadU32LE(const std::vector<uint8_t>& bytes, size_t offset) {
    return static_cast<uint32_t>(bytes[offset]) |
           (static_cast<uint32_t>(bytes[offset + 1]) << 8) |
           (static_cast<uint32_t>(bytes[offset + 2]) << 16) |
           (static_cast<uint32_t>(bytes[offset + 3]) << 24);
}

uint16_t ReadU16LE(const std::vector<uint8_t>& bytes, size_t offset) {
    return static_cast<uint16_t>(bytes[offset] | (bytes[offset + 1] << 8));
}

void TestWavWriterHeaderFields() {
    const std::string path = "/tmp/nsf2midi_test_wav_header.wav";
    WavWriter w;
    CHECK(w.Open(path, 44100, 2));
    int16_t samples[3] = {1, 2, 3};
    CHECK(w.WriteMono(samples, 3));
    CHECK(w.Close());

    std::vector<uint8_t> bytes = ReadFile(path);
    CHECK(bytes.size() == 44 + 3 * 2 * sizeof(int16_t));
    CHECK(std::string(bytes.begin(), bytes.begin() + 4) == "RIFF");
    CHECK(std::string(bytes.begin() + 8, bytes.begin() + 12) == "WAVE");
    CHECK(std::string(bytes.begin() + 12, bytes.begin() + 16) == "fmt ");
    CHECK(std::string(bytes.begin() + 36, bytes.begin() + 40) == "data");
    CHECK(ReadU16LE(bytes, 20) == 1);       // PCM
    CHECK(ReadU16LE(bytes, 22) == 2);       // channels
    CHECK(ReadU32LE(bytes, 24) == 44100);   // sample rate
    CHECK(ReadU16LE(bytes, 32) == 4);       // block align (2ch * 16bit)
    CHECK(ReadU32LE(bytes, 28) == 44100u * 4);  // byte rate
    CHECK(ReadU16LE(bytes, 34) == 16);      // bits per sample
    std::remove(path.c_str());
}

void TestWavWriterPatchesSizesOnClose() {
    const std::string path = "/tmp/nsf2midi_test_wav_sizes.wav";
    WavWriter w;
    CHECK(w.Open(path, 44100, 2));
    int16_t samples[100] = {};
    CHECK(w.WriteMono(samples, 100));
    CHECK(w.Close());

    std::vector<uint8_t> bytes = ReadFile(path);
    const uint32_t expected_data_bytes = 100 * 2 * sizeof(int16_t);
    CHECK(ReadU32LE(bytes, 40) == expected_data_bytes);
    CHECK(ReadU32LE(bytes, 4) == 36 + expected_data_bytes);
    CHECK(bytes.size() == 44 + expected_data_bytes);
    std::remove(path.c_str());
}

void TestWavWriterMonoDuplicatesToBothChannels() {
    const std::string path = "/tmp/nsf2midi_test_wav_mono_dup.wav";
    WavWriter w;
    CHECK(w.Open(path, 44100, 2));
    int16_t samples[1] = {static_cast<int16_t>(0x1234)};
    CHECK(w.WriteMono(samples, 1));
    CHECK(w.Close());

    std::vector<uint8_t> bytes = ReadFile(path);
    CHECK(bytes.size() == 44 + 4);
    CHECK(ReadU16LE(bytes, 44) == 0x1234);  // L
    CHECK(ReadU16LE(bytes, 46) == 0x1234);  // R
    std::remove(path.c_str());
}

void TestWavWriterEmptyStreamIsStillValid() {
    const std::string path = "/tmp/nsf2midi_test_wav_empty.wav";
    WavWriter w;
    CHECK(w.Open(path, 44100, 2));
    CHECK(w.Close());

    std::vector<uint8_t> bytes = ReadFile(path);
    CHECK(bytes.size() == 44);
    CHECK(ReadU32LE(bytes, 4) == 36);
    CHECK(ReadU32LE(bytes, 40) == 0);
    std::remove(path.c_str());
}

int main() {
    TestNoiseFrequencyRetrigger();
    TestNoiseDrumMapSelectsNote();
    TestNoiseNoteOnOffPairIntegrity();
    TestDpcmSampleIdentity();
    TestDutyProgramChange();
    TestTriangleDefaultsSuppressFalseTrigger();
    TestTriangleExplicitMdfKeyWins();
    TestBackwardCompatibilityWhenNewFeaturesDisabled();
    TestWavWriterHeaderFields();
    TestWavWriterPatchesSizesOnClose();
    TestWavWriterMonoDuplicatesToBothChannels();
    TestWavWriterEmptyStreamIsStillValid();

    if (g_failures == 0) {
        std::printf("All tests passed.\n");
        return 0;
    }
    std::fprintf(stderr, "%d test(s) failed.\n", g_failures);
    return 1;
}
