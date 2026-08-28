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
        std::fprintf(file, "      }\n");
        std::fprintf(file, "    }%s\n", (i + 1 < entries.size()) ? "," : "");
    }
    std::fprintf(file, "  ]\n");
    std::fprintf(file, "}\n");

    const bool ok = std::fflush(file) == 0;
    std::fclose(file);
    return ok;
}

}  // namespace nsf2midi
