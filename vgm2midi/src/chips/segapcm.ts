// MidiConverterから抽出した、SegaPCM（315-5218）のサンプルトリガー処理。
// `host: MidiConverter`のper-conversion可変状態（segaPCMRegisters/segaPCMActiveVoices等）を
// 直接読み書きする——詳細な設計判断はvgm2midi/CLAUDE.mdの「Refactor: event-output.ts」
// を参照。`stopPCMVoice()`/`pcmROMDataBlockForAddress()`はYM2612 DAC/YM2608 ADPCM-B/
// C140とも共有するPCM汎用ヘルパーのため、MidiConverter側に残したまま`host.`経由で呼ぶ。

import type { MidiConverter } from '../midi-converter';
import { segaPCMBankBaseAddress, segaPCMDurationSamples } from '../pcm-analysis';
import { addPCMPan, noteOnPCMPercussion, pcmNoteForSample } from '../event-output';
import type { VGMCommand } from '../types';

export function handleSegaPCMWrite(host: MidiConverter, cmd: VGMCommand, currentTime: number): void {
  if (cmd.register === undefined || cmd.data === undefined) return;
  const register = cmd.register & 0xFF;
  const data = cmd.data;
  host.segaPCMRegisters[register] = data;

  if ((register & 0x87) !== 0x86) return;
  const channel = (register & 0x78) >> 3;
  if ((data & 0x01) !== 0) {
    host.stopPCMVoice(host.segaPCMActiveVoices, channel, currentTime);
  } else {
    triggerSegaPCMVoice(host, channel, data, cmd.instance ?? 0, currentTime);
  }
}

export function triggerSegaPCMVoice(
  host: MidiConverter,
  channel: number,
  control: number,
  instance: number,
  currentTime: number
): void {
  host.stopPCMVoice(host.segaPCMActiveVoices, channel, currentTime);
  const base = channel << 3;
  // $84/$85 are the 16-bit byte address.  The chip advances it as a 16.8
  // fixed-point value; the control register selects its physical ROM bank.
  const address = host.segaPCMRegisters[base + 0x84] | (host.segaPCMRegisters[base + 0x85] << 8);
  const bankBaseAddress = segaPCMBankBaseAddress(host.vgmData, control);
  const physicalAddress = bankBaseAddress + address;
  const sampleId = physicalAddress.toString(16).padStart(6, '0');
  const trackKey = `segapcm_sample_${sampleId}`;
  // base+2 = left volume, base+3 = right volume.
  const left = host.segaPCMRegisters[base + 2];
  const right = host.segaPCMRegisters[base + 3];
  const volume = Math.max(left, right);
  const velocity = Math.max(1, Math.round((Math.min(127, volume) / 127) * 100));
  const note = pcmNoteForSample(host, trackKey);
  const total = left + right;
  addPCMPan(host, trackKey, total > 0 ? Math.round((right / total) * 127) : 64, currentTime);
  const dataBlock = host.pcmROMDataBlockForAddress(0x80, instance, physicalAddress);
  // SegaPCM's current/loop address is 16.8 fixed point.  Its end register
  // names the final 256-byte page, therefore the useful end is exclusive.
  const endAddressExclusive = bankBaseAddress + ((host.segaPCMRegisters[base + 0x06] + 1) << 8);
  const isLoop = (control & 0x02) === 0;
  const durationSamples = isLoop
    ? undefined
    : segaPCMDurationSamples(host.vgmData, address << 8, host.segaPCMRegisters[base + 0x06], host.segaPCMRegisters[base + 0x07], host.sampleRate);
  const loopAddress = bankBaseAddress + host.segaPCMRegisters[base + 0x04]
    + (host.segaPCMRegisters[base + 0x05] << 8);
  const descriptorId = noteOnPCMPercussion(host,
    trackKey,
    note,
    velocity,
    currentTime,
    isLoop,
    dataBlock,
    durationSamples,
    { endAddressExclusive, ...(isLoop ? { loopAddress } : {}) }
  );
  host.segaPCMActiveVoices[channel] = { descriptorId, note };
}
