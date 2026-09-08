// MidiConverterから抽出した、AY-3-8910のレジスタ処理エントリポイント。
// 実際のトーン・ノイズ・エンベロープ状態機械はYM2203/YM2608の内蔵SSGコアとも
// 共有するため`./ssg`にあり、ここはAY8910固有のkeyPrefix/chip/instanceを
// 組み立てて渡すだけの薄いラッパー。

import type { MidiConverter } from '../midi-converter';
import { handleSSGWrite } from './ssg';
import type { VGMCommand } from '../types';

export function handleAY8910Write(
  host: MidiConverter,
  cmd: VGMCommand,
  currentTime: number,
  activeNotes: Map<string, { note: number; startTime: number; startVolume: number }>,
  cmdIndex: number
): void {
  if (cmd.register === undefined || cmd.data === undefined) return;
  const instance = cmd.instance === 1 ? 1 : 0;
  handleSSGWrite(
    host,
    `ay8910_${instance}`,
    cmd.register,
    cmd.data,
    currentTime,
    activeNotes,
    cmdIndex,
    'AY8910',
    instance
  );
}
