// track_metadata.h
// --track-metadata sidecar (MIDIトラック番号 <-> NESチャンネルの対応表) の
// JSON書き出し。vgm2midiの--track-metadata (src/midi-converter.ts の
// exportTrackMetadata()) と同じ役割・同じversion:1のトップレベル形状を持つ
// C++版。miditrack/src/miditrack/nsf_chip.py がこのJSONを読む。

#pragma once

#include <string>
#include <vector>

namespace nsf2midi {

// 1 MIDIトラックぶんのメタデータ。channel は channel_map.cpp の
// ChannelInfo.label と同一の文字列 (例: "SQ1", "NOISE", "VRC6-SQ1")。
// NESには複数のMIDIトラックが1つの物理チャンネルを共有するケースが無いため
// (AY/SSGやHuC6280のようなtone/noise共有が存在しない)、groupIdは常に
// channel自身と同じ値になり、suggestedForHardwareMixは常にtrueになる。
struct TrackMetadataEntry {
    int track_index = 0;
    std::string channel;
};

// path へ version:1 のJSON sidecarを書く。
// { "version": 1, "sampleRate": 44100, "sampleCount": <n>,
//   "tracks": [ { "trackIndex": 0, "channel": "SQ1",
//                 "chipRender": { "channel": "SQ1", "groupId": "SQ1",
//                                 "suggestedForHardwareMix": true } }, ... ] }
// 成功時 true。ファイルが開けない場合 false。
bool WriteTrackMetadata(const std::string& path, int sample_rate, long long sample_count,
                         const std::vector<TrackMetadataEntry>& entries);

}  // namespace nsf2midi
