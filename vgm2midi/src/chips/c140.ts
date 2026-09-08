// MidiConverterから抽出した、C140/C219のサンプルトリガー処理。
// `host: MidiConverter`のper-conversion可変状態（c140Registers/c140ActiveVoices等）を
// 直接読み書きする——詳細な設計判断はvgm2midi/CLAUDE.mdの「Refactor: event-output.ts」
// を参照。`stopPCMVoice()`/`pcmROMDataBlockForAddress()`はYM2612 DAC/YM2608 ADPCM-B/
// SegaPCMとも共有するPCM汎用ヘルパーのため、MidiConverter側に残したまま`host.`経由で呼ぶ。

import type { MidiConverter } from '../midi-converter';
import { c140DurationSamples, c140ROMAddress, c140PCMAnalysisForVoice } from '../pcm-analysis';
import { addPCMPan, noteOnPCMPercussion, pcmNoteForSample } from '../event-output';
import type { VGMCommand } from '../types';

export function handleC140Write(host: MidiConverter, cmd: VGMCommand, currentTime: number): void {
  if (cmd.register === undefined || cmd.data === undefined) return;
  const register = cmd.register & 0x1FF;
  const data = cmd.data;
  host.c140Registers[register] = data;
  if (register >= 0x180 || (register & 0x0F) !== 0x05) return;

  const channel = register >> 4;
  const isActive = host.c140ActiveVoices[channel] !== undefined;
  const shouldTrigger = (data & 0x80) !== 0 || ((data & 0x40) !== 0 && isActive);
  if (shouldTrigger) triggerC140Voice(host, channel, cmd.instance ?? 0, currentTime);
  else host.stopPCMVoice(host.c140ActiveVoices, channel, currentTime);
}

export function triggerC140Voice(
  host: MidiConverter,
  channel: number,
  instance: number,
  currentTime: number
): void {
  host.stopPCMVoice(host.c140ActiveVoices, channel, currentTime);
  const base = channel << 4;
  const bank = host.c140Registers[base + 4];
  const start = (host.c140Registers[base + 6] << 8) | host.c140Registers[base + 7];
  const sampleId = `${bank.toString(16).padStart(2, '0')}${start.toString(16).padStart(4, '0')}`;
  const trackKey = `c140_sample_${sampleId}`;
  // Confirmed against MAME's c140.cpp: base+0 = right volume, base+1 = left volume
  // (opposite order from SegaPCM above).
  const right = host.c140Registers[base];
  const left = host.c140Registers[base + 1];
  const volume = Math.max(left, right);
  const velocity = Math.max(1, Math.round((Math.min(127, volume) / 127) * 100));
  const note = pcmNoteForSample(host, trackKey);
  const total = left + right;
  addPCMPan(host, trackKey, total > 0 ? Math.round((right / total) * 127) : 64, currentTime);
  const end = (host.c140Registers[base + 8] << 8) | host.c140Registers[base + 9];
  const isLoop = (host.c140Registers[base + 5] & 0x10) !== 0;
  const isC219Noise = host.vgmData.header.c140Type === 2 && (host.c140Registers[base + 5] & 0x04) !== 0;
  const loop = (host.c140Registers[base + 10] << 8) | host.c140Registers[base + 11];
  const startAddress = c140ROMAddress(host.vgmData, host.c140Registers, channel, bank, start);
  const dataBlock = host.pcmROMDataBlockForAddress(0x8D, instance, startAddress);
  const frequency = (host.c140Registers[base + 2] << 8) | host.c140Registers[base + 3];
  const durationSamples = isLoop || isC219Noise
    ? undefined
    : c140DurationSamples(host.vgmData, start, end, frequency, host.sampleRate);
  const descriptorId = noteOnPCMPercussion(host,
    trackKey,
    note,
    velocity,
    currentTime,
    isLoop,
    dataBlock,
    durationSamples,
    {
      endAddressExclusive: c140ROMAddress(host.vgmData, host.c140Registers, channel, bank, end),
      ...(isLoop ? { loopAddress: c140ROMAddress(host.vgmData, host.c140Registers, channel, bank, loop) } : {}),
    },
    c140PCMAnalysisForVoice(
      host.vgmData,
      dataBlock,
      startAddress,
      c140ROMAddress(host.vgmData, host.c140Registers, channel, bank, end),
      host.c140Registers[base + 5]
    )
  );
  host.c140ActiveVoices[channel] = { descriptorId, note };
}
