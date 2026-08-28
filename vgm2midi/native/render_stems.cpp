#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include "player/playerbase.hpp"
#include "player/vgmplayer.hpp"
#include "player/playera.hpp"
#include "emu/SoundDevs.h"
#include "utils/DataLoader.h"
#include "utils/FileLoader.h"

namespace {
constexpr UINT32 kRate = 44100, kBlock = 2048;
void put16(std::ofstream& f, UINT16 v) { char b[2] = {(char)v, (char)(v >> 8)}; f.write(b, 2); }
void put32(std::ofstream& f, UINT32 v) { char b[4] = {(char)v, (char)(v >> 8), (char)(v >> 16), (char)(v >> 24)}; f.write(b, 4); }

/** UTF-8 byte列を壊さず、JSON文字列として必要なASCII制御文字だけをescapeする。 */
std::string escapeJsonString(const std::string& value) {
  static constexpr char hex[] = "0123456789abcdef";
  std::string escaped;
  escaped.reserve(value.size() + 8);
  for (const unsigned char byte : value) {
    switch (byte) {
      case '"': escaped += "\\\""; break;
      case '\\': escaped += "\\\\"; break;
      case '\b': escaped += "\\b"; break;
      case '\f': escaped += "\\f"; break;
      case '\n': escaped += "\\n"; break;
      case '\r': escaped += "\\r"; break;
      case '\t': escaped += "\\t"; break;
      default:
        if (byte < 0x20) {
          escaped += "\\u00";
          escaped += hex[byte >> 4];
          escaped += hex[byte & 0x0f];
        } else {
          escaped += static_cast<char>(byte);
        }
    }
  }
  return escaped;
}

/** 指定frame数に固定した44.1kHz/S16/stereo PCM WAVヘッダを書く。 */
void writeWavHeader(std::ofstream& f, UINT32 frames) {
  const UINT32 bytes = frames * 4;
  f.write("RIFF", 4); put32(f, 36 + bytes); f.write("WAVEfmt ", 8); put32(f, 16);
  put16(f, 1); put16(f, 2); put32(f, kRate); put32(f, kRate * 4); put16(f, 4); put16(f, 16); f.write("data", 4); put32(f, bytes);
}
std::string chipName(DEV_ID type) {
  switch (type) {
    case DEVID_SN76496: return "SN76489"; case DEVID_YM2413: return "YM2413"; case DEVID_YM2612: return "YM2612";
    case DEVID_YM2151: return "YM2151"; case DEVID_SEGAPCM: return "SegaPCM"; case DEVID_YM2203: return "YM2203";
    case DEVID_YM2608: return "YM2608"; case DEVID_C140: return "C140"; case DEVID_MSM6258: return "MSM6258"; default: return "Device" + std::to_string(type);
  }
}
struct Device { UINT32 id; DEV_ID type; UINT16 instance; UINT32 clock; };
struct Selection { DEV_ID type; UINT16 instance; UINT32 mainMask; UINT32 linkedMask; };

/** `TYPE:INSTANCE:MAIN_MASK:LINKED_MASK`形式の選択子を読む。 */
Selection parseSelection(const std::string& text) {
  std::vector<UINT32> values; std::size_t start = 0;
  while (start <= text.size()) {
    const auto end = text.find(':', start); const auto part = text.substr(start, end - start);
    if (part.empty()) throw std::runtime_error("invalid empty selection field: " + text);
    values.push_back(static_cast<UINT32>(std::stoul(part, nullptr, 0)));
    if (end == std::string::npos) break; start = end + 1;
  }
  if (values.size() != 4 || values[0] > 0xFF || values[1] > 0xFFFF)
    throw std::runtime_error("invalid selection: " + text);
  return {static_cast<DEV_ID>(values[0]), static_cast<UINT16>(values[1]), values[2], values[3]};
}

/** VGMPlayerを新規作成し、選択外デバイスをdisableしてsample-exactにレンダリングする。 */
std::vector<Device> renderStem(const std::string& input, const std::string& output, UINT32 frames, UINT32 selectedId, bool isMix, const std::vector<Selection>* selections = nullptr) {
  PlayerA player; player.RegisterPlayerEngine(new VGMPlayer);
  if (player.SetOutputSettings(kRate, 2, 16, kBlock)) throw std::runtime_error("libvgm output configuration failed");
  auto cfg = player.GetConfiguration(); cfg.masterVol = 0x10000; cfg.loopCount = 255; cfg.fadeSmpls = 0; cfg.endSilenceSmpls = 0; cfg.pbSpeed = 1.0; player.SetConfiguration(cfg);
  DATA_LOADER* loader = FileLoader_Init(input.c_str());
  if (!loader) throw std::runtime_error("cannot open VGM input");
  DataLoader_SetPreloadBytes(loader, 0x100);
  if (DataLoader_Load(loader) || player.LoadFile(loader) || player.Start()) throw std::runtime_error("libvgm could not load or start VGM");
  auto* vgm = dynamic_cast<VGMPlayer*>(player.GetPlayer()); if (!vgm) throw std::runtime_error("input is not VGM");
  std::vector<PLR_DEV_INFO> info; vgm->GetSongDeviceInfo(info); std::vector<Device> devices;
  for (const auto& item : info) if (item.parentIdx == static_cast<UINT32>(-1)) devices.push_back({item.id, item.type, item.instance, item.devCfg ? item.devCfg->clock : 0});
  bool matchedSelection = false;
  if (selections) {
    for (const auto& device : devices) {
      const auto found = std::find_if(selections->begin(), selections->end(), [&](const Selection& item) { return item.type == device.type && item.instance == device.instance; });
      PLR_MUTE_OPTS mute{};
      if (found == selections->end()) mute.disable = 0xFF;
      else { matchedSelection = true; mute.chnMute[0] = ~found->mainMask; mute.chnMute[1] = ~found->linkedMask; }
      vgm->SetDeviceMuting(device.id, mute);
    }
    if (!matchedSelection) throw std::runtime_error("no requested libvgm device was found");
  } else if (!isMix) {
    for (const auto& device : devices) if (device.id != selectedId) { PLR_MUTE_OPTS mute{}; mute.disable = 1; vgm->SetDeviceMuting(device.id, mute); }
  }
  std::ofstream wav(output, std::ios::binary); if (!wav) throw std::runtime_error("cannot create WAV"); writeWavHeader(wav, frames);
  std::vector<UINT8> buffer(kBlock * 4); for (UINT32 remaining = frames; remaining > 0;) { const UINT32 count = remaining > kBlock ? kBlock : remaining; std::memset(buffer.data(), 0, buffer.size()); player.Render(count * 4, buffer.data()); wav.write(reinterpret_cast<const char*>(buffer.data()), count * 4); remaining -= count; }
  player.Stop(); player.UnloadFile(); player.UnregisterAllPlayers(); DataLoader_Deinit(loader); return devices;
}
}

int main(int argc, char** argv) {
  try {
    if (argc >= 6 && std::string(argv[1]) == "--selection") {
      const std::string input = argv[2], output = argv[3];
      const UINT32 frames = static_cast<UINT32>(std::strtoul(argv[4], nullptr, 10));
      if (!frames) throw std::runtime_error("TOTAL_SAMPLES must be positive");
      std::vector<Selection> selections;
      for (int index = 5; index < argc; ++index) selections.push_back(parseSelection(argv[index]));
      renderStem(input, output, frames, 0, false, &selections); return 0;
    }
    if (argc != 5) {
      std::cerr << "usage: vgm2midi_stems INPUT OUTPUT_DIR TOTAL_SAMPLES MANIFEST\n"
                << "       vgm2midi_stems --selection INPUT OUTPUT_WAV TOTAL_SAMPLES TYPE:INSTANCE:MAIN_MASK:LINKED_MASK [...]\n";
      return 64;
    }
    const std::string input = argv[1], dir = argv[2], manifest = argv[4], base = std::filesystem::path(argv[1]).stem().string();
    const UINT32 frames = static_cast<UINT32>(std::strtoul(argv[3], nullptr, 10)); if (!frames) throw std::runtime_error("TOTAL_SAMPLES must be positive"); std::filesystem::create_directories(dir);
    const std::string mix = dir + "/" + base + ".mix.wav"; const auto devices = renderStem(input, mix, frames, 0, true);
    std::ofstream json(manifest); if (!json) throw std::runtime_error("cannot create manifest"); json << "{\n  \"sampleRate\": 44100,\n  \"sampleCount\": " << frames << ",\n  \"stems\": [\n    {\"chip\":\"" << escapeJsonString("mix") << "\",\"instance\":0,\"clock\":0,\"sampleCount\":" << frames << ",\"path\":\"" << escapeJsonString(mix) << "\"}";
    for (const auto& device : devices) { const std::string chip = chipName(device.type), suffix = device.instance ? chip + "-" + std::to_string(device.instance + 1) : chip, stem = dir + "/" + base + "." + suffix + ".wav"; renderStem(input, stem, frames, device.id, false); json << ",\n    {\"chip\":\"" << escapeJsonString(chip) << "\",\"instance\":" << device.instance << ",\"clock\":" << device.clock << ",\"sampleCount\":" << frames << ",\"path\":\"" << escapeJsonString(stem) << "\"}"; }
    json << "\n  ]\n}\n"; return 0;
  } catch (const std::exception& e) { std::cerr << e.what() << "\n"; return 1; }
}
