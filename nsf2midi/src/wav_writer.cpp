// wav_writer.cpp
#include "wav_writer.h"

#include <cstring>
#include <vector>

namespace nsf2midi {

namespace {

void WriteU32LE(std::FILE* f, uint32_t v) {
    uint8_t bytes[4] = {
        static_cast<uint8_t>(v & 0xFF),
        static_cast<uint8_t>((v >> 8) & 0xFF),
        static_cast<uint8_t>((v >> 16) & 0xFF),
        static_cast<uint8_t>((v >> 24) & 0xFF),
    };
    std::fwrite(bytes, 1, 4, f);
}

void WriteU16LE(std::FILE* f, uint16_t v) {
    uint8_t bytes[2] = {
        static_cast<uint8_t>(v & 0xFF),
        static_cast<uint8_t>((v >> 8) & 0xFF),
    };
    std::fwrite(bytes, 1, 2, f);
}

}  // namespace

WavWriter::~WavWriter() {
    if (file_) Close();
}

bool WavWriter::Open(const std::string& path, int sample_rate, int channels) {
    if (channels != 1 && channels != 2) return false;
    if (file_) return false;

    file_ = std::fopen(path.c_str(), "wb");
    if (!file_) return false;

    channels_ = channels;
    data_bytes_ = 0;

    const uint16_t bits_per_sample = 16;
    const uint16_t block_align = static_cast<uint16_t>(channels * (bits_per_sample / 8));
    const uint32_t byte_rate = static_cast<uint32_t>(sample_rate) * block_align;

    // RIFF ヘッダ。RIFF サイズと data サイズは仮の 0 を書き、Close() でパッチする。
    std::fwrite("RIFF", 1, 4, file_);
    WriteU32LE(file_, 0);
    std::fwrite("WAVE", 1, 4, file_);

    std::fwrite("fmt ", 1, 4, file_);
    WriteU32LE(file_, 16);              // fmt チャンクサイズ (PCM)
    WriteU16LE(file_, 1);               // PCM
    WriteU16LE(file_, static_cast<uint16_t>(channels));
    WriteU32LE(file_, static_cast<uint32_t>(sample_rate));
    WriteU32LE(file_, byte_rate);
    WriteU16LE(file_, block_align);
    WriteU16LE(file_, bits_per_sample);

    std::fwrite("data", 1, 4, file_);
    WriteU32LE(file_, 0);               // data サイズ (仮)

    return true;
}

bool WavWriter::WriteMono(const int16_t* samples, size_t count) {
    if (!file_) return false;
    if (count == 0) return true;

    if (channels_ == 1) {
        return WriteInterleaved(samples, count);
    }

    // channels_ == 2: L/R に複製する。
    std::vector<int16_t> stereo(count * 2);
    for (size_t i = 0; i < count; i++) {
        stereo[i * 2] = samples[i];
        stereo[i * 2 + 1] = samples[i];
    }
    return WriteInterleaved(stereo.data(), stereo.size());
}

bool WavWriter::WriteInterleaved(const int16_t* frames, size_t sample_count) {
    if (!file_) return false;
    if (sample_count == 0) return true;

    const size_t bytes = sample_count * sizeof(int16_t);
    if (std::fwrite(frames, 1, bytes, file_) != bytes) return false;
    data_bytes_ += static_cast<uint32_t>(bytes);
    return true;
}

bool WavWriter::Close() {
    if (!file_) return false;

    bool ok = true;
    // data チャンクサイズ (オフセット 40) をパッチする。
    if (std::fseek(file_, 40, SEEK_SET) != 0) ok = false;
    if (ok) WriteU32LE(file_, data_bytes_);

    // RIFF チャンクサイズ (オフセット 4) = ファイル全体 - 8。
    if (ok && std::fseek(file_, 4, SEEK_SET) == 0) {
        WriteU32LE(file_, 36 + data_bytes_);
    } else {
        ok = false;
    }

    std::fclose(file_);
    file_ = nullptr;
    return ok;
}

}  // namespace nsf2midi
