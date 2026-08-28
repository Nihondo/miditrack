// wav_writer.h
// 16bit PCM の RIFF/WAVE ファイルを書き出す、third_party/NotSoFatso に依存しない
// 純粋なライタ。chip_render.cpp から使うが、それ自体は NSF/APU の知識を持たない。

#pragma once

#include <cstdint>
#include <cstdio>
#include <string>

namespace nsf2midi {

// ストリーミング書き込み: Open() で 44 バイトのプレースホルダヘッダを書き、
// Write*() で PCM サンプルを追記し、Close() で RIFF/data サイズを後追いパッチする。
// 呼び出し順序を守らずプロセスが落ちた場合、ファイルはヘッダのサイズが 0 のまま
// 残るが、これは呼び出し側 (miditrack 側の「サイズが 44 バイト以下なら失敗」判定)
// が既に想定している失敗モードなので、ここで復旧を試みる必要はない。
class WavWriter {
public:
    WavWriter() = default;
    ~WavWriter();

    WavWriter(const WavWriter&) = delete;
    WavWriter& operator=(const WavWriter&) = delete;

    // channels は 1 (モノ) か 2 (ステレオ) のみサポートする。
    bool Open(const std::string& path, int sample_rate, int channels);

    // モノラルの 16bit サンプル列を書き込む。channels==2 で開いている場合は
    // 各サンプルを L/R に複製する (channels==1 ならそのまま書く)。
    bool WriteMono(const int16_t* samples, size_t count);

    // 既にインターリーブされたフレーム列 (フレーム数 = count / channels_) を書く。
    bool WriteInterleaved(const int16_t* frames, size_t sample_count);

    // RIFF/data チャンクのサイズをファイル先頭に書き戻してクローズする。
    bool Close();

    bool is_open() const { return file_ != nullptr; }

private:
    std::FILE* file_ = nullptr;
    int channels_ = 0;
    uint32_t data_bytes_ = 0;
};

}  // namespace nsf2midi
