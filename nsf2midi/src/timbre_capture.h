// timbre_capture.h
// FDS/N163/S5B/VRC6 チャンネルの実チップ状態 (波形メモリ、デューティ比、
// ノイズ混合、エンベロープ) を CNSFCore::GetState() から読み出し、
// timbre.h の TimbreSnapshot へ詰める。main.cpp がフレームループ中、対象
// チャンネルの最初のノートオンが起きたフレームでだけ呼ぶ (chip_render.h と
// 同様、CNSFFile/CNSFCore の完全な定義を必要とするため main.cpp からのみ
// 使う想定で、tests/ のビルドには含めない — timbre.h/timbre.cpp 側の純粋な
// ロジックだけを単体テストする)。

#pragma once

#include "channel_map.h"
#include "timbre.h"

class CNSFCore;

namespace nsf2midi {

// info.kind が Fds/N163/S5B/Vrc6Pulse のいずれかであることを前提とする。
// それ以外の kind を渡した場合、対応するフィールドを埋めない空のスナップショットを
// 返す (呼び出し側で kind をガードする設計なので通常到達しない)。
TimbreSnapshot CaptureTimbreSnapshot(CNSFCore& core, const ChannelInfo& info);

}  // namespace nsf2midi
