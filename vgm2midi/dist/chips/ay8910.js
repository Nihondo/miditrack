"use strict";
// MidiConverterから抽出した、AY-3-8910のレジスタ処理エントリポイント。
// 実際のトーン・ノイズ・エンベロープ状態機械はYM2203/YM2608の内蔵SSGコアとも
// 共有するため`./ssg`にあり、ここはAY8910固有のkeyPrefix/chip/instanceを
// 組み立てて渡すだけの薄いラッパー。
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleAY8910Write = handleAY8910Write;
const ssg_1 = require("./ssg");
function handleAY8910Write(host, cmd, currentTime, activeNotes, cmdIndex) {
    if (cmd.register === undefined || cmd.data === undefined)
        return;
    const instance = cmd.instance === 1 ? 1 : 0;
    (0, ssg_1.handleSSGWrite)(host, `ay8910_${instance}`, cmd.register, cmd.data, currentTime, activeNotes, cmdIndex, 'AY8910', instance);
}
