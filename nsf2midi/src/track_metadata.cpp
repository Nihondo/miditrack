// track_metadata.cpp
#include "track_metadata.h"

#include <cstdio>

namespace nsf2midi {

namespace {

// vgm2midi/native/render_stems.cpp の escapeJsonString() と同じ方針:
// " \ 制御文字 (<0x20) だけを手作業でエスケープし、UTF-8バイト列自体は
// そのまま通す。channel文字列は常にASCIIだが、汎用的に安全側へ倒す。
std::string EscapeJsonString(const std::string& value) {
    std::string out;
    out.reserve(value.size() + 2);
    for (unsigned char c : value) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out;
}

const char* TimbreKindName(ChannelKind kind) {
    switch (kind) {
        case ChannelKind::Fds: return "fds";
        case ChannelKind::N163: return "n163";
        case ChannelKind::S5B: return "s5b";
        case ChannelKind::Vrc6Pulse: return "vrc6";
        default: return "unknown";
    }
}

void WriteIntArray(std::FILE* file, const std::vector<int>& values) {
    std::fprintf(file, "[");
    for (size_t i = 0; i < values.size(); i++) {
        std::fprintf(file, "%s%d", (i == 0) ? "" : ",", values[i]);
    }
    std::fprintf(file, "]");
}

// TimbreSnapshot を "timbre": { ... } オブジェクトとして書く。kind ごとに
// 意味を持つフィールドだけを出す (timbre.h のコメント参照)。
void WriteTimbre(std::FILE* file, const TrackMetadataEntry& entry) {
    const TimbreSnapshot& t = entry.timbre;
    std::fprintf(file, "      \"timbre\": {\n");
    std::fprintf(file, "        \"kind\": \"%s\",\n", TimbreKindName(t.kind));
    switch (t.kind) {
        case ChannelKind::Fds:
            std::fprintf(file, "        \"waveform\": ");
            WriteIntArray(file, t.fds_wave_table);
            std::fprintf(file, ",\n");
            std::fprintf(file, "        \"masterVolume\": %d,\n", t.fds_master_volume);
            break;
        case ChannelKind::N163:
            std::fprintf(file, "        \"waveform\": ");
            WriteIntArray(file, t.n163_wave);
            std::fprintf(file, ",\n");
            std::fprintf(file, "        \"activeChannels\": %d,\n", t.n163_active_channels);
            break;
        case ChannelKind::S5B:
            std::fprintf(file, "        \"toneEnabled\": %s,\n", t.s5b_tone_enabled ? "true" : "false");
            std::fprintf(file, "        \"noiseEnabled\": %s,\n",
                         t.s5b_noise_enabled ? "true" : "false");
            std::fprintf(file, "        \"noiseFrequency\": %d,\n", t.s5b_noise_frequency);
            std::fprintf(file, "        \"envelope\": { \"enabled\": %s, \"frequency\": %d, "
                                "\"shape\": %d },\n",
                         t.s5b_envelope_enabled ? "true" : "false", t.s5b_envelope_frequency,
                         t.s5b_envelope_shape);
            break;
        case ChannelKind::Vrc6Pulse:
            std::fprintf(file, "        \"duty\": %d,\n", t.vrc6_duty);
            break;
        default:
            break;
    }
    std::fprintf(file, "        \"gmProgramCandidate\": %d\n", GmProgramCandidateFor(t));
    std::fprintf(file, "      }\n");
}

}  // namespace

bool WriteTrackMetadata(const std::string& path, int sample_rate, long long sample_count,
                         const std::vector<TrackMetadataEntry>& entries) {
    std::FILE* file = std::fopen(path.c_str(), "wb");
    if (!file) return false;

    std::fprintf(file, "{\n");
    std::fprintf(file, "  \"version\": 1,\n");
    std::fprintf(file, "  \"sampleRate\": %d,\n", sample_rate);
    std::fprintf(file, "  \"sampleCount\": %lld,\n", sample_count);
    std::fprintf(file, "  \"tracks\": [\n");
    for (size_t i = 0; i < entries.size(); i++) {
        const TrackMetadataEntry& entry = entries[i];
        const std::string channel = EscapeJsonString(entry.channel);
        std::fprintf(file, "    {\n");
        std::fprintf(file, "      \"trackIndex\": %d,\n", entry.track_index);
        std::fprintf(file, "      \"channel\": \"%s\",\n", channel.c_str());
        std::fprintf(file, "      \"chipRender\": {\n");
        std::fprintf(file, "        \"channel\": \"%s\",\n", channel.c_str());
        std::fprintf(file, "        \"groupId\": \"%s\",\n", channel.c_str());
        std::fprintf(file, "        \"suggestedForHardwareMix\": true\n");
        std::fprintf(file, "      }%s\n", entry.has_timbre ? "," : "");
        if (entry.has_timbre) WriteTimbre(file, entry);
        std::fprintf(file, "    }%s\n", (i + 1 < entries.size()) ? "," : "");
    }
    std::fprintf(file, "  ]\n");
    std::fprintf(file, "}\n");

    const bool ok = std::fflush(file) == 0;
    std::fclose(file);
    return ok;
}

}  // namespace nsf2midi
