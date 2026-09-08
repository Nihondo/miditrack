// MidiConverterから抽出した、YM2612のレジスタ処理（FM・DAC）。FM Timbre/Pan・
// Channel 3 Special/CSM Timer Aの共有機構はchips/opn-shared.tsにあり、ここは
// YM2612固有のレジスタマップ（DAC/Key On/Frequency）だけを扱う。`host: MidiConverter`
// のper-conversion可変状態を直接読み書きする——詳細な設計判断はvgm2midi/CLAUDE.mdの
// 「Refactor: event-output.ts」を参照。

import type { MidiConverter } from '../midi-converter';
import { noteOn, noteOff, noteOnPCMPercussion, noteOffPCMPercussion, pcmNoteForSample, updateNotePitch } from '../event-output';
import {
  handleOPNPanWrite,
  handleOPNTimbreWrite,
  handleOPNCh3ModeWrite,
  updateOPNCsmTimer,
  updateOPNCsmTimerRegister,
  handleOPNCh3SpecialKeyWrite,
  handleOPNCh3SpecialFrequencyWrite,
} from './opn-shared';
import type { VGMCommand } from '../types';

type ActiveNoteMap = Map<string, { note: number; startTime: number; startVolume: number }>;

export function handleYM2612Write(
  host: MidiConverter,
  cmd: VGMCommand,
  currentTime: number,
  activeNotes: ActiveNoteMap,
  cmdIndex: number
): void {
  if (cmd.register === undefined || cmd.data === undefined || cmd.port === undefined) return;

  const port = cmd.port;
  const reg = cmd.register;
  const data = cmd.data;
  const ch3Context = host.opnCh3Context('YM2612');

  if (handleOPNPanWrite(host, 'ym2612', port, reg, data, currentTime)) return;

  if (handleYM2612TimbreWrite(host, port, reg, data, currentTime)) {
    return;
  }

  if (port === 0 && reg === 0x27) {
    handleOPNCh3ModeWrite(host, ch3Context, data, currentTime, activeNotes);
    updateOPNCsmTimer(host, 'YM2612', cmd.instance ?? 0, data, currentTime, activeNotes);
    return;
  }

  if (port === 0 && (reg === 0x24 || reg === 0x25)) {
    updateOPNCsmTimerRegister(host, 'YM2612', cmd.instance ?? 0, reg, data);
    return;
  }

  if (port === 0 && reg === 0x2B) {
    host.isYM2612DACEnabled = (data & 0x80) !== 0;
    if (!host.isYM2612DACEnabled) {
      host.ym2612DACPendingAddress = undefined;
      stopYM2612DACVoice(host, currentTime);
      stopYM2612DirectDACVoice(host, currentTime);
    }
    return;
  }

  // $2A: direct one-byte-at-a-time DAC output (as opposed to the $E0-seek + $80-8F
  // stream path handled by handleYM2612DACWrite()). Some non-optimized VGM rips drive
  // the DAC this way for drum samples instead of using the stream commands; without
  // this branch those writes silently fell through unhandled and produced no notes at
  // all. See handleYM2612DirectDACWrite() for the grouping heuristic.
  if (port === 0 && reg === 0x2A) {
    handleYM2612DirectDACWrite(host, currentTime);
    return;
  }

  // Key On/Off (0x28) - Port 0 only? The spec says 0x28 is usually on Port 0 but controls all channels
  if (port === 0 && reg === 0x28) {
      // Spec: D0-D2 = Channel (0-2 for Ch1-3, 4-6 for Ch4-6). D4-D7 = Slots.
      // Wait, standard mapping:
      // Ch 0-2: 000, 001, 010
      // Ch 3-5: 100, 101, 110 (Bits 2 is set for Ch 4-6)

      let channelIndex = -1;
      if ((data & 0x03) < 3) { // Valid channel bits 0-1
           if ((data & 0x04) === 0) {
               channelIndex = data & 0x03; // Ch 1-3 (0-2)
           } else {
               channelIndex = (data & 0x03) + 3; // Ch 4-6 (3-5)
           }
      }

      if (channelIndex === 2 && host.isOPNCh3SpecialMode(ch3Context)) {
          handleOPNCh3SpecialKeyWrite(host, ch3Context, data, currentTime, activeNotes);
          return;
      }

      if (channelIndex !== -1) {
          const key = `ym2612_${channelIndex}`;
          const state = host.channels.get(key)!;
          state.keyOnMask = (data >> 4) & 0x0F;
          const keyOn = state.keyOnMask !== 0; // Any slot ON

          if (keyOn && !state.active) {
              state.opnActivePitchScale = host.opnPitchScale(state);
              state.opnActiveVelocity = host.opnCarrierVelocity(state);
              state.active = true;
              noteOn(host, key, channelIndex + 4, currentTime, activeNotes); // offset channel for MIDI
          } else if (!keyOn && state.active) {
              state.active = false;
              noteOff(host, key, channelIndex + 4, currentTime, activeNotes);
              state.opnActivePitchScale = 1;
          }
      }
      return;
  }

  // Frequency Registers
  // A0-A2: F-Num LSB
  // A4-A6: Block & F-Num MSB
  let channelOffset = -1;
  if (reg >= 0xA0 && reg <= 0xA2) {
      channelOffset = reg - 0xA0; // 0, 1, 2
  } else if (reg >= 0xA4 && reg <= 0xA6) {
      channelOffset = reg - 0xA4; // 0, 1, 2
  }

  if (channelOffset !== -1) {
      const channelIndex = channelOffset + (port * 3); // Port 0 -> 0-2, Port 1 -> 3-5
      const key = `ym2612_${channelIndex}`;
      const state = host.channels.get(key)!;

      if (reg >= 0xA0 && reg <= 0xA2) {
          // F-Num LSB
          state.freqLSB = data;
      } else {
          // Block & F-Num MSB
          state.freqMSB = data & 0x07; // Lower 3 bits
          state.block = (data >> 3) & 0x07; // Bits 3-5
      }

      // Update full frequency/fnum
      const oldFreq = state.frequency;
      state.frequency = ((state.freqMSB || 0) << 8) | (state.freqLSB || 0);

      // If note is active, check for pitch change
      const otherReg = reg <= 0xA2 ? reg + 4 : reg - 4;
      const isSplitUpdate = host.isOPNMultiByteFreqUpdate(
        cmdIndex,
        'YM2612',
        port,
        otherReg,
        cmd.instance ?? 0
      );
      const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
      state.hasPendingFrequencyUpdate = isSplitUpdate;
      if (state.active && !isSplitUpdate && (state.frequency !== oldFreq || hadPendingUpdate)) {
          updateNotePitch(host, key, channelIndex + 4, currentTime, activeNotes);
      }
      return;
  }

  if (port === 0) {
    handleOPNCh3SpecialFrequencyWrite(
      host,
      ch3Context,
      reg,
      data,
      currentTime,
      activeNotes,
      cmdIndex
    );
  }
}

export function handleYM2612TimbreWrite(
  host: MidiConverter,
  port: number,
  reg: number,
  data: number,
  currentTime: number
): boolean {
  return handleOPNTimbreWrite(host, 'ym2612', port, reg, data, currentTime);
}

export function handleYM2612DACSeek(host: MidiConverter, cmd: VGMCommand): void {
  if (cmd.address === undefined) return;
  host.ym2612DACPendingAddress = cmd.address;
}

export function handleYM2612DACWrite(host: MidiConverter, currentTime: number): void {
  const address = host.ym2612DACPendingAddress;
  if (address === undefined) return;
  host.ym2612DACPendingAddress = undefined;
  if (!host.isYM2612DACEnabled) return;
  if (host.options.suppressYM2612Dac) return;

  stopYM2612DACVoice(host, currentTime);
  const sampleId = address.toString(16).padStart(6, '0');
  const trackKey = `ym2612dac_sample_${sampleId}`;
  const note = pcmNoteForSample(host, trackKey);
  const dataBlock = host.pcmDataBlockForRange(0x00, 0, address);
  const descriptorId = noteOnPCMPercussion(host, trackKey, note, 100, currentTime, false, dataBlock);
  host.ym2612DACActiveVoice = { descriptorId, note };
}

export function stopYM2612DACVoice(host: MidiConverter, currentTime: number): void {
  const voice = host.ym2612DACActiveVoice;
  if (!voice) return;
  noteOffPCMPercussion(host, voice.descriptorId, voice.note, currentTime);
  host.ym2612DACActiveVoice = undefined;
}

// Groups consecutive $2A writes into one note by elapsed-time gap (see
// YM2612_DAC_DIRECT_GAP_SAMPLES). All writes share one track/sample identity, since $2A
// carries no address to distinguish samples by.
export function handleYM2612DirectDACWrite(host: MidiConverter, currentTime: number): void {
  if (!host.isYM2612DACEnabled) return;
  if (host.options.suppressYM2612Dac) return;
  const lastWriteTime = host.ym2612DirectDACLastWriteTime;
  host.ym2612DirectDACLastWriteTime = currentTime;

  if (
    host.ym2612DirectDACActiveVoice
    && lastWriteTime !== undefined
    && currentTime - lastWriteTime > YM2612_DAC_DIRECT_GAP_SAMPLES
  ) {
    // Close the previous hit at its own last-write time, not `currentTime` — otherwise a
    // long gap before the next hit stretches the previous note across the gap.
    noteOffPCMPercussion(host,
      host.ym2612DirectDACActiveVoice.descriptorId,
      host.ym2612DirectDACActiveVoice.note,
      lastWriteTime
    );
    host.ym2612DirectDACActiveVoice = undefined;
  }

  if (!host.ym2612DirectDACActiveVoice) {
    const trackKey = 'ym2612dac_direct_stream';
    const note = pcmNoteForSample(host, trackKey);
    const descriptorId = noteOnPCMPercussion(host, trackKey, note, 100, currentTime);
    host.ym2612DirectDACActiveVoice = { descriptorId, note };
  }
}

// Closes the direct-DAC voice at the last actual $2A write time, not `currentTime` —
// called from both $2B-disable and EOF (stopAllPCMVoices()), neither of which should
// stretch the final hit's duration out to whenever this happens to be called.
export function stopYM2612DirectDACVoice(host: MidiConverter, currentTime: number): void {
  const voice = host.ym2612DirectDACActiveVoice;
  if (!voice) return;
  const closeTime = host.ym2612DirectDACLastWriteTime ?? currentTime;
  noteOffPCMPercussion(host, voice.descriptorId, voice.note, closeTime);
  host.ym2612DirectDACActiveVoice = undefined;
  host.ym2612DirectDACLastWriteTime = undefined;
}

// Register $2A drives the DAC one byte at a time with no seek/address information (unlike
// the $E0-seek + $80-8F stream path), so there is no sample identity to key retriggering
// off. Consecutive $2A writes are instead grouped into one note by elapsed-time gap: a
// non-optimized VGM rip drives $2A every few samples while a sample plays, so 882 samples
// (20ms at the VGM 44.1kHz timeline) reliably separates one drum hit from the next without
// splitting a single sample's steady stream of writes.
const YM2612_DAC_DIRECT_GAP_SAMPLES = 882;
