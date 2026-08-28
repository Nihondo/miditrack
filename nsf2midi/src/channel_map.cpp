#include "channel_map.h"

#include "NSF_Core.h"

namespace nsf2midi {

std::vector<ChannelInfo> BuildChannelList(int chip_extensions) {
    std::vector<ChannelInfo> list;

    list.push_back({MdfSlot::Square1, CHANNEL_SQUARE1, ChannelKind::Square, "SQ1", false});
    list.push_back({MdfSlot::Square2, CHANNEL_SQUARE2, ChannelKind::Square, "SQ2", false});
    list.push_back({MdfSlot::Triangle, CHANNEL_TRIANGLE, ChannelKind::Triangle, "TRI", false});
    list.push_back({MdfSlot::Noise, CHANNEL_NOISE, ChannelKind::Noise, "NOISE", true});
    list.push_back({MdfSlot::Pcm, CHANNEL_DPCM, ChannelKind::Dpcm, "PCM", true});

    if (chip_extensions & EXTSOUND_VRC6) {
        list.push_back({MdfSlot::Extended1, CHANNEL_VRC6SQUARE1, ChannelKind::Vrc6Pulse, "VRC6-SQ1", false});
        list.push_back({MdfSlot::Extended2, CHANNEL_VRC6SQUARE2, ChannelKind::Vrc6Pulse, "VRC6-SQ2", false});
        list.push_back({MdfSlot::Extended3, CHANNEL_VRC6SAW, ChannelKind::Vrc6Saw, "VRC6-SAW", false});
    } else if (chip_extensions & EXTSOUND_FDS) {
        list.push_back({MdfSlot::Extended1, CHANNEL_FDS, ChannelKind::Fds, "FDS", false});
    } else if (chip_extensions & EXTSOUND_FME07) {
        list.push_back({MdfSlot::Extended1, S5B_SQUARE1, ChannelKind::S5B, "S5B-1", false});
        list.push_back({MdfSlot::Extended2, S5B_SQUARE2, ChannelKind::S5B, "S5B-2", false});
        list.push_back({MdfSlot::Extended3, S5B_SQUARE3, ChannelKind::S5B, "S5B-3", false});
    } else if (chip_extensions & EXTSOUND_N106) {
        static const MdfSlot kSlots[8] = {
            MdfSlot::Extended1, MdfSlot::Extended2, MdfSlot::Extended3, MdfSlot::Extended4,
            MdfSlot::Extended5, MdfSlot::Extended6, MdfSlot::Extended7, MdfSlot::Extended8,
        };
        static const int kChannels[8] = {
            N163_WAVE1, N163_WAVE2, N163_WAVE3, N163_WAVE4,
            N163_WAVE5, N163_WAVE6, N163_WAVE7, N163_WAVE8,
        };
        for (int i = 0; i < 8; i++) {
            list.push_back({kSlots[i], kChannels[i], ChannelKind::N163,
                             "N163-" + std::to_string(i + 1), false});
        }
    }

    return list;
}

std::string UnsupportedChipName(int chip_extensions) {
    if (chip_extensions & EXTSOUND_VRC7) return "VRC7";
    if (chip_extensions & EXTSOUND_MMC5) return "MMC5";
    if (chip_extensions & EXTSOUND_EPSM) return "EPSM";
    return "";
}

}  // namespace nsf2midi
