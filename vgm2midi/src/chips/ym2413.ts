// MidiConverterから抽出した、YM2413（OPLL）FM・リズムモードのレジスタ処理。
// `host: MidiConverter`のper-conversion可変状態（channels/ym2413RhythmMode等）を
// 直接読み書きする——詳細な設計判断はvgm2midi/CLAUDE.mdの「Refactor: event-output.ts」
// を参照。`recordYM2413TimbreEvent()`はsidecar用の共有FMタイムブレ記録機構
// （recordFMTimbreEvent()）へのYM2413専用ラッパーで、他チップからも直接
// `host.recordFMTimbreEvent()`が呼ばれるため、MidiConverter側に残したまま
// `host.recordYM2413TimbreEvent()`として呼ぶ。

import type { MidiConverter } from '../midi-converter';
import { addExpression, noteOn, noteOff, noteOnPercussion, updateNotePitch } from '../event-output';
import type { VGMCommand } from '../types';

type ActiveNoteMap = Map<string, { note: number; startTime: number; startVolume: number }>;

// BD, HH, SD, TOM, CYM (GM Bass Drum 1, Closed Hi-Hat, Acoustic Snare, Low Tom, Crash Cymbal 1)
const YM2413_RHYTHM_NOTES = [36, 42, 38, 45, 49] as const;
// BD, HH, SD, TOM, CYM -> $0E bit masks
const YM2413_RHYTHM_KEY_BITS = [0x10, 0x01, 0x08, 0x04, 0x02] as const;

export function handleYM2413Write(
  host: MidiConverter,
  cmd: VGMCommand,
  currentTime: number,
  activeNotes: ActiveNoteMap,
  cmdIndex: number
): void {
  if (cmd.register === undefined || cmd.data === undefined) return;
  const reg = cmd.register;
  const data = cmd.data;
  if (reg >= 0x00 && reg <= 0x07) {
    host.ym2413CustomPatch[reg] = data;
    if (reg === 0x01) host.hasYM2413CustomCarrierMultiple = true;
    for (let channel = 0; channel < 9; channel++) {
      if (host.channels.get(`ym2413_${channel}`)!.ym2413Instrument === 0) {
        host.recordYM2413TimbreEvent(channel, currentTime, 'ym2413-custom-patch');
      }
    }
    return;
  }
  if (reg === 0x0E) {
    handleYM2413RhythmModeWrite(host, data, currentTime, activeNotes);
    return;
  }
  if (reg >= 0x10 && reg <= 0x18) {
    updateYM2413Frequency(host, reg - 0x10, currentTime, activeNotes, cmdIndex, data, cmd.instance ?? 0);
    return;
  }
  if (reg >= 0x20 && reg <= 0x28) {
    handleYM2413KeyAndFrequencyWrite(
      host, reg - 0x20, currentTime, activeNotes, cmdIndex, data, cmd.instance ?? 0
    );
    return;
  }
  if (reg >= 0x30 && reg <= 0x38) {
    handleYM2413VolumeWrite(host, reg - 0x30, data, currentTime, activeNotes);
  }
}

// Register $0E bit 5 toggles rhythm mode; bits 0-4 (while rhythm mode is on) are the
// five percussion key-on bits. See YM2413_RHYTHM_* above for the bit/note mapping.
export function handleYM2413RhythmModeWrite(
  host: MidiConverter,
  data: number,
  currentTime: number,
  activeNotes: ActiveNoteMap
): void {
  const wasRhythmMode = host.ym2413RhythmMode;
  const isRhythmMode = (data & 0x20) !== 0;

  if (isRhythmMode !== wasRhythmMode) {
    // Channels 6-8 are about to change what they represent (one melodic voice each <->
    // two-operator-pair percussion), so close whichever of those five possibly-active
    // keys are currently sounding — the same principle as YM2612 channel 3 special
    // mode's own mode-switch handling and HuC6280's tone/noise switch.
    for (const channel of [6, 7, 8]) {
      const key = `ym2413_${channel}`;
      const state = host.channels.get(key)!;
      if (state.active) {
        state.active = false;
        noteOff(host, key, 0, currentTime, activeNotes);
      }
    }
    for (let i = 0; i < YM2413_RHYTHM_NOTES.length; i++) {
      const key = `ym2413_rhythm_${i}`;
      if (activeNotes.has(key)) noteOff(host, key, 0, currentTime, activeNotes);
    }
    host.ym2413RhythmMode = isRhythmMode;
    host.ym2413RhythmControlByte = 0;
  }

  if (!isRhythmMode) return;

  const newBits = data & 0x1F;
  const changedBits = newBits ^ (host.ym2413RhythmControlByte & 0x1F);
  host.ym2413RhythmControlByte = data;

  for (let i = 0; i < YM2413_RHYTHM_KEY_BITS.length; i++) {
    const bit = YM2413_RHYTHM_KEY_BITS[i];
    if ((changedBits & bit) === 0) continue;
    const key = `ym2413_rhythm_${i}`;
    if ((newBits & bit) !== 0) {
      noteOnPercussion(host, key, ym2413RhythmVelocity(host, i), currentTime, activeNotes, YM2413_RHYTHM_NOTES[i]);
    } else if (activeNotes.has(key)) {
      noteOff(host, key, 0, currentTime, activeNotes);
    }
  }
}

export function updateYM2413Frequency(
  host: MidiConverter,
  channel: number,
  currentTime: number,
  activeNotes: ActiveNoteMap,
  cmdIndex: number,
  data: number,
  instance: number
): void {
  const key = `ym2413_${channel}`;
  const state = host.channels.get(key)!;
  const oldFrequency = state.frequency;
  state.freqLSB = data;
  state.frequency = ((state.freqMSB ?? 0) << 8) | (state.freqLSB ?? 0);

  // Not audible while this channel is rhythm-controlled, but the pitch state is still
  // latched above so it stays consistent if rhythm mode later turns back off.
  if (host.ym2413RhythmMode && channel >= 6) return;

  if (state.ym2413PendingKeyOn) {
    state.ym2413PendingKeyOn = false;
    commitYM2413KeyOn(host, channel, currentTime, activeNotes);
    return;
  }

  const otherReg = 0x20 + channel;
  const isSplitUpdate = host.isOPNMultiByteFreqUpdate(
    cmdIndex, 'YM2413', 0, otherReg, instance
  );
  const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
  state.hasPendingFrequencyUpdate = isSplitUpdate;
  if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
    updateNotePitch(host, key, 0, currentTime, activeNotes);
  }
}

// $20-$28: bit0=F-Number MSB (9th bit), bits1-3=block, bit4=key-on, bit5=sustain (not
// modeled — no chip in this file currently distinguishes EG sustain/release shape).
export function handleYM2413KeyAndFrequencyWrite(
  host: MidiConverter,
  channel: number,
  currentTime: number,
  activeNotes: ActiveNoteMap,
  cmdIndex: number,
  data: number,
  instance: number
): void {
  const key = `ym2413_${channel}`;
  const state = host.channels.get(key)!;

  state.freqMSB = data & 0x01;
  state.block = (data >> 1) & 0x07;
  const oldFrequency = state.frequency;
  state.frequency = ((state.freqMSB ?? 0) << 8) | (state.freqLSB ?? 0);

  const otherReg = 0x10 + channel;
  const isSplitUpdate = host.isOPNMultiByteFreqUpdate(
    cmdIndex, 'YM2413', 0, otherReg, instance
  );
  const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
  state.hasPendingFrequencyUpdate = isSplitUpdate;

  // While rhythm mode has channels 6-8 repurposed, their own key-on bit here is ignored
  // — the $0E rhythm key bits are the sole trigger for those voices (see
  // handleYM2413RhythmModeWrite()). Frequency/block are still latched above.
  if (host.ym2413RhythmMode && channel >= 6) return;

  const isKeyOn = (data & 0x10) !== 0;
  if (isKeyOn && !state.active) {
    // Drivers occasionally write $20 (key-on/MSB) before $10 (LSB).  Defer just this
    // adjacent pair so the note starts with the final 9-bit F-Number rather than a stale
    // low byte; commands not followed by its matching $10 retain immediate key-on.
    if (isSplitUpdate) state.ym2413PendingKeyOn = true;
    else commitYM2413KeyOn(host, channel, currentTime, activeNotes);
  } else if (!isKeyOn && state.active) {
    state.active = false;
    noteOff(host, key, 0, currentTime, activeNotes);
  } else if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
    updateNotePitch(host, key, 0, currentTime, activeNotes);
  }
}

/** YM2413 key-onを、両方のfrequency byteとpatch carrier Multiple確定後にcommitする。 */
export function commitYM2413KeyOn(
  host: MidiConverter,
  channel: number,
  currentTime: number,
  activeNotes: ActiveNoteMap
): void {
  const key = `ym2413_${channel}`;
  const state = host.channels.get(key)!;
  if (state.active) return;
  state.opnActiveVelocity = ym2413Velocity(state.volume);
  state.opnActivePitchScale = host.ym2413PitchScale(state);
  state.active = true;
  noteOn(host, key, 0, currentTime, activeNotes);
}

// $30-$38: upper nibble is normally the instrument number, which selects an initial GM
// audition candidate and sidecar timbre snapshot; lower nibble is a 4-bit volume
// (0=loudest, 15=quietest). In rhythm mode, $37/$38's upper
// nibble is repurposed as HH/TOM volume (confirmed against emu2413's OPLL_writeReg()
// $30-$38 case); the lower nibble always carries SD/CYM (or, for $30-$36, the normal
// per-channel) volume.
export function handleYM2413VolumeWrite(
  host: MidiConverter,
  channel: number,
  data: number,
  currentTime: number,
  activeNotes: ActiveNoteMap
): void {
  const volume = data & 0x0F;

  if (host.ym2413RhythmMode && channel >= 6) {
    if (channel === 6) {
      host.ym2413RhythmVolumes[0] = volume; // BD
    } else if (channel === 7) {
      host.ym2413RhythmVolumes[1] = (data >> 4) & 0x0F; // HH
      host.ym2413RhythmVolumes[2] = volume; // SD
    } else {
      host.ym2413RhythmVolumes[3] = (data >> 4) & 0x0F; // TOM
      host.ym2413RhythmVolumes[4] = volume; // CYM
    }
    for (let i = 0; i < YM2413_RHYTHM_NOTES.length; i++) {
      const key = `ym2413_rhythm_${i}`;
      if (!activeNotes.has(key)) continue;
      const expression = Math.round((ym2413RhythmVelocity(host, i) / 100) * 127);
      addExpression(host, key, expression, currentTime);
    }
    return;
  }

  const key = `ym2413_${channel}`;
  const state = host.channels.get(key)!;
  state.ym2413Instrument = (data >> 4) & 0x0F;
  state.volume = volume;
  if (state.active) {
    const expression = Math.round((ym2413Velocity(volume) / 100) * 127);
    addExpression(host, key, expression, currentTime);
  }
  host.recordYM2413TimbreEvent(channel, currentTime, 'ym2413-patch');
}

// No authoritative dB/step figure was available for YM2413's 4-bit volume register
// (unlike YM2612's well-documented 0.75dB/step Total Level), so this uses the same
// simple linear mapping as SN76489's 4-bit attenuation register rather than asserting a
// precision this chip's level curve doesn't have.
export function ym2413Velocity(volume: number): number {
  return Math.max(1, Math.min(100, Math.round(100 - volume * 6.6)));
}

export function ym2413RhythmVelocity(host: MidiConverter, index: number): number {
  return ym2413Velocity(host.ym2413RhythmVolumes[index]);
}
