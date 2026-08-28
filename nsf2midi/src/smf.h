// smf.h
// Standard MIDI File (SMF format 1) の書き出し。
//
// 用途に必要な最小限のイベント (ノート、CC、PC、ピッチベンド、メタイベント)
// のみをサポートする汎用ライタ。

#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace nsf2midi {

// 1 トラック分のイベント列。tick は先頭からの絶対 tick で指定し、
// Save() 時にデルタタイムへ変換する。
class MidiTrack {
public:
    void NoteOn(uint32_t tick, int channel, int note, int velocity);
    void NoteOff(uint32_t tick, int channel, int note, int velocity = 64);
    void ProgramChange(uint32_t tick, int channel, int program);
    void ControlChange(uint32_t tick, int channel, int controller, int value);
    void PitchBend(uint32_t tick, int channel, int value14);  // 0-16383, center 8192
    void TrackName(uint32_t tick, const std::string& name);
    void CopyrightNotice(uint32_t tick, const std::string& text);
    void SetTempo(uint32_t tick, int microseconds_per_quarter);
    void TimeSignature(uint32_t tick, int numerator, int denominator_pow2);
    void EndOfTrack(uint32_t tick);

private:
    struct Event {
        uint32_t tick;
        int priority;  // 同一 tick 内での順序 (小さいほど先)
        std::vector<uint8_t> bytes;
    };
    std::vector<Event> events_;

    void AddRaw(uint32_t tick, int priority, std::vector<uint8_t> bytes);

    friend class SmfWriter;
};

class SmfWriter {
public:
    explicit SmfWriter(int ticks_per_quarter_note) : ticks_per_quarter_(ticks_per_quarter_note) {}

    // トラックを追加し、書き込み用の参照を返す (SmfWriter が所有権を持つ)。
    MidiTrack& AddTrack();

    // SMF format 1 として path に保存する。成功時 true。
    bool Save(const std::string& path) const;

private:
    int ticks_per_quarter_;
    std::vector<std::unique_ptr<MidiTrack>> tracks_;
};

}  // namespace nsf2midi
