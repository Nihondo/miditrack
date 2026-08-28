#include "smf.h"

#include <algorithm>
#include <cstdio>

namespace nsf2midi {

namespace {

void WriteVarLen(std::vector<uint8_t>& out, uint32_t value) {
    uint8_t buffer[5];
    int len = 0;
    buffer[len++] = value & 0x7F;
    value >>= 7;
    while (value > 0) {
        buffer[len++] = 0x80 | (value & 0x7F);
        value >>= 7;
    }
    for (int i = len - 1; i >= 0; i--) out.push_back(buffer[i]);
}

void WriteU32BE(std::vector<uint8_t>& out, uint32_t v) {
    out.push_back(static_cast<uint8_t>((v >> 24) & 0xFF));
    out.push_back(static_cast<uint8_t>((v >> 16) & 0xFF));
    out.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
    out.push_back(static_cast<uint8_t>(v & 0xFF));
}

void WriteU16BE(std::vector<uint8_t>& out, uint16_t v) {
    out.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
    out.push_back(static_cast<uint8_t>(v & 0xFF));
}

std::vector<uint8_t> MakeMeta(uint8_t type, const std::vector<uint8_t>& data) {
    std::vector<uint8_t> bytes;
    bytes.push_back(0xFF);
    bytes.push_back(type);
    WriteVarLen(bytes, static_cast<uint32_t>(data.size()));
    bytes.insert(bytes.end(), data.begin(), data.end());
    return bytes;
}

std::vector<uint8_t> MakeMetaText(uint8_t type, const std::string& text) {
    return MakeMeta(type, std::vector<uint8_t>(text.begin(), text.end()));
}

}  // namespace

void MidiTrack::AddRaw(uint32_t tick, int priority, std::vector<uint8_t> bytes) {
    events_.push_back(Event{tick, priority, std::move(bytes)});
}

// イベント優先度: 同一 tick では note off を note on より先に出す。
enum Priority {
    kPriorityMeta = 0,
    kPriorityControl = 1,
    kPriorityNoteOff = 2,
    kPriorityNoteOn = 3,
};

void MidiTrack::NoteOn(uint32_t tick, int channel, int note, int velocity) {
    note = std::clamp(note, 0, 127);
    velocity = std::clamp(velocity, 0, 127);
    AddRaw(tick, kPriorityNoteOn,
           {static_cast<uint8_t>(0x90 | (channel & 0x0F)), static_cast<uint8_t>(note),
            static_cast<uint8_t>(velocity)});
}

void MidiTrack::NoteOff(uint32_t tick, int channel, int note, int velocity) {
    note = std::clamp(note, 0, 127);
    velocity = std::clamp(velocity, 0, 127);
    AddRaw(tick, kPriorityNoteOff,
           {static_cast<uint8_t>(0x80 | (channel & 0x0F)), static_cast<uint8_t>(note),
            static_cast<uint8_t>(velocity)});
}

void MidiTrack::ProgramChange(uint32_t tick, int channel, int program) {
    program = std::clamp(program, 0, 127);
    AddRaw(tick, kPriorityControl,
           {static_cast<uint8_t>(0xC0 | (channel & 0x0F)), static_cast<uint8_t>(program)});
}

void MidiTrack::ControlChange(uint32_t tick, int channel, int controller, int value) {
    controller = std::clamp(controller, 0, 127);
    value = std::clamp(value, 0, 127);
    AddRaw(tick, kPriorityControl,
           {static_cast<uint8_t>(0xB0 | (channel & 0x0F)), static_cast<uint8_t>(controller),
            static_cast<uint8_t>(value)});
}

void MidiTrack::PitchBend(uint32_t tick, int channel, int value14) {
    value14 = std::clamp(value14, 0, 16383);
    AddRaw(tick, kPriorityControl,
           {static_cast<uint8_t>(0xE0 | (channel & 0x0F)), static_cast<uint8_t>(value14 & 0x7F),
            static_cast<uint8_t>((value14 >> 7) & 0x7F)});
}

void MidiTrack::TrackName(uint32_t tick, const std::string& name) {
    AddRaw(tick, kPriorityMeta, MakeMetaText(0x03, name));
}

void MidiTrack::CopyrightNotice(uint32_t tick, const std::string& text) {
    AddRaw(tick, kPriorityMeta, MakeMetaText(0x02, text));
}

void MidiTrack::SetTempo(uint32_t tick, int microseconds_per_quarter) {
    std::vector<uint8_t> data = {
        static_cast<uint8_t>((microseconds_per_quarter >> 16) & 0xFF),
        static_cast<uint8_t>((microseconds_per_quarter >> 8) & 0xFF),
        static_cast<uint8_t>(microseconds_per_quarter & 0xFF),
    };
    AddRaw(tick, kPriorityMeta, MakeMeta(0x51, data));
}

void MidiTrack::TimeSignature(uint32_t tick, int numerator, int denominator_pow2) {
    std::vector<uint8_t> data = {
        static_cast<uint8_t>(numerator),
        static_cast<uint8_t>(denominator_pow2),
        24,  // MIDI clocks per metronome click
        8,   // 32nd notes per quarter note
    };
    AddRaw(tick, kPriorityMeta, MakeMeta(0x58, data));
}

void MidiTrack::EndOfTrack(uint32_t tick) {
    AddRaw(tick, 99 /* 常に最後 */, MakeMeta(0x2F, {}));
}

MidiTrack& SmfWriter::AddTrack() {
    tracks_.push_back(std::make_unique<MidiTrack>());
    return *tracks_.back();
}

bool SmfWriter::Save(const std::string& path) const {
    FILE* f = fopen(path.c_str(), "wb");
    if (!f) return false;

    // ヘッダチャンク
    {
        std::vector<uint8_t> header;
        header.insert(header.end(), {'M', 'T', 'h', 'd'});
        WriteU32BE(header, 6);
        WriteU16BE(header, 1);  // format 1
        WriteU16BE(header, static_cast<uint16_t>(tracks_.size()));
        WriteU16BE(header, static_cast<uint16_t>(ticks_per_quarter_));
        fwrite(header.data(), 1, header.size(), f);
    }

    for (const auto& track : tracks_) {
        std::vector<MidiTrack::Event> events = track->events_;
        std::stable_sort(events.begin(), events.end(), [](const auto& a, const auto& b) {
            if (a.tick != b.tick) return a.tick < b.tick;
            return a.priority < b.priority;
        });

        std::vector<uint8_t> body;
        uint32_t prev_tick = 0;
        for (const auto& ev : events) {
            uint32_t delta = ev.tick >= prev_tick ? ev.tick - prev_tick : 0;
            WriteVarLen(body, delta);
            body.insert(body.end(), ev.bytes.begin(), ev.bytes.end());
            prev_tick = ev.tick;
        }

        std::vector<uint8_t> chunk;
        chunk.insert(chunk.end(), {'M', 'T', 'r', 'k'});
        WriteU32BE(chunk, static_cast<uint32_t>(body.size()));
        chunk.insert(chunk.end(), body.begin(), body.end());
        fwrite(chunk.data(), 1, chunk.size(), f);
    }

    fclose(f);
    return true;
}

}  // namespace nsf2midi
