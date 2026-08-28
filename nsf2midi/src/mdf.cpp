#include "mdf.h"

#include <cctype>
#include <fstream>
#include <optional>
#include <unordered_map>

namespace nsf2midi {

namespace {

std::string Trim(const std::string& s) {
    size_t begin = s.find_first_not_of(" \t\r\n");
    if (begin == std::string::npos) return "";
    size_t end = s.find_last_not_of(" \t\r\n");
    return s.substr(begin, end - begin + 1);
}

std::optional<MdfSlot> SectionToSlot(const std::string& name) {
    static const std::unordered_map<std::string, MdfSlot> kMap = {
        {"SQUARE-CHANNEL1", MdfSlot::Square1},
        {"SQUARE-CHANNEL2", MdfSlot::Square2},
        {"EXTENDED-CHANNEL1", MdfSlot::Extended1},
        {"EXTENDED-CHANNEL2", MdfSlot::Extended2},
        {"EXTENDED-CHANNEL3", MdfSlot::Extended3},
        {"EXTENDED-CHANNEL4", MdfSlot::Extended4},
        {"EXTENDED-CHANNEL5", MdfSlot::Extended5},
        {"EXTENDED-CHANNEL6", MdfSlot::Extended6},
        {"EXTENDED-CHANNEL7", MdfSlot::Extended7},
        {"EXTENDED-CHANNEL8", MdfSlot::Extended8},
        // 原本のタイプミス "TRIANGELE" を互換のため受理する。
        {"TRIANGELE-CHANNEL", MdfSlot::Triangle},
        {"TRIANGLE-CHANNEL", MdfSlot::Triangle},
        {"NOISE-CHANNEL", MdfSlot::Noise},
        {"PCM-CHANNEL", MdfSlot::Pcm},
    };
    auto it = kMap.find(name);
    if (it == kMap.end()) return std::nullopt;
    return it->second;
}

bool ToBool(const std::string& v) {
    // "1" のみ true。空値や誤記など "0"/"1" 以外の値は安全側 (false) にフォールバック
    // する — "0" 以外なら true とすると、空値や typo が意図せず機能を有効化してしまう。
    return Trim(v) == "1";
}

int ToInt(const std::string& v) {
    try {
        return std::stoi(Trim(v));
    } catch (...) {
        return 0;
    }
}

void ApplyKey(ChannelConfig& cfg, const std::string& key, const std::string& value) {
    if (key == "Instrument") cfg.instrument = ToInt(value);
    else if (key == "BankHi") cfg.bank_hi = ToInt(value);
    else if (key == "BankLo") cfg.bank_lo = ToInt(value);
    else if (key == "Reverb") cfg.reverb = ToInt(value);
    else if (key == "Chorus") cfg.chorus = ToInt(value);
    else if (key == "AttackEnabled") cfg.attack_enabled = ToBool(value);
    else if (key == "DecayEnabled") cfg.decay_enabled = ToBool(value);
    else if (key == "PitchBendEnabled") cfg.pitch_bend_enabled = ToBool(value);
    else if (key == "Velocity") cfg.velocity = ToBool(value);
    else if (key == "Volume") cfg.volume = ToInt(value);
    else if (key == "RelativeDividedPoint") cfg.relative_divided_point = ToInt(value);
    else if (key == "AbsoluteDividedPoint") cfg.absolute_divided_point = ToInt(value);
    else if (key == "FrequencyChangeEnabled") cfg.frequency_change_enabled = ToBool(value);
    else if (key == "LevelChangeEnabled") cfg.level_change_enabled = ToBool(value);
    else if (key == "ChannelEnabled") cfg.channel_enabled = ToBool(value);
    else if (key == "MonoEnabled") cfg.mono_enabled = ToBool(value);
    else if (key == "PortamentEnabled") cfg.portament_enabled = ToBool(value);
    else if (key == "NoteNumberAdjust") cfg.note_number_adjust = ToInt(value);
    else if (key == "NoiseDrumMapEnabled") cfg.noise_drum_map_enabled = ToBool(value);
    else if (key == "PcmSampleMapEnabled") cfg.pcm_sample_map_enabled = ToBool(value);
    else if (key == "DutyProgramChangeEnabled") cfg.duty_program_change_enabled = ToBool(value);
    // 未知キーは無視 (将来の拡張や原本側の余剰キーに対する耐性)。
}

}  // namespace

MdfFile::MdfFile() {
    // Triangle チャンネルの STATE_VOLUME は音量ではなく線形カウンタ (0-127、鳴って
    // いる間ずっとデクリメントされ、リロードのたびに跳ね上がる) であり、原本
    // default.mdf の TRIANGLE セクションはこれを踏まえた閾値キー
    // (LevelChangeEnabled 等) を書いていない。ChannelConfig の構造体既定値
    // (attack/decay/level_change=true) がそのまま適用されると、カウンタのリロード
    // のたびに偽のノートオンretriggerと不自然な CC11 (Expression) の揺らぎが発生する
    // — これは「原本の意図」ではなく既定値の取りこぼしなので、意図的なバグ修正として
    // Triangle スロットにだけ異なる既定値を設定する。.mdf 側で明示的にキーを書けば
    // ApplyKey() がこれを上書きするので、ユーザー設定は常にこの既定値より優先される。
    ChannelConfig& tri = slots_[static_cast<size_t>(MdfSlot::Triangle)];
    tri.level_change_enabled = false;
    tri.attack_enabled = false;
    tri.decay_enabled = false;
    tri.velocity = false;
}

bool MdfFile::Load(const std::string& path) {
    std::ifstream in(path);
    if (!in.is_open()) return false;

    std::optional<MdfSlot> current;
    std::string line;
    while (std::getline(in, line)) {
        std::string trimmed = Trim(line);
        if (trimmed.empty() || trimmed[0] == ';' || trimmed[0] == '#') continue;

        if (trimmed.front() == '[' && trimmed.back() == ']') {
            std::string section = trimmed.substr(1, trimmed.size() - 2);
            current = SectionToSlot(section);
            continue;
        }

        if (!current.has_value()) continue;

        size_t eq = trimmed.find('=');
        if (eq == std::string::npos) continue;
        std::string key = Trim(trimmed.substr(0, eq));
        std::string value = Trim(trimmed.substr(eq + 1));

        ApplyKey(slots_[static_cast<size_t>(*current)], key, value);
    }

    return true;
}

}  // namespace nsf2midi
