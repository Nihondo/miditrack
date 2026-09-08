// MidiConverterから抽出した、AY-3-8910互換SSG（トーン・ノイズ・エンベロープ）の
// レジスタ処理。AY8910単体、およびYM2203/YM2608に内蔵されたSSGコアの3チップから
// `keyPrefix`/`chip`/`instance`引数で共有される、チップ固有ではない状態機械——
// AY8910自身の`handleAY8910Write()`（chips/ay8910.ts）だけでなく、
// midi-converter.ts側に残るYM2203/YM2608のFMハンドラーからも
// `handleSSGWrite()`が直接呼ばれる。`host: MidiConverter`のper-conversion
// 可変状態（channels/ssgNoisePeriods等）を直接読み書きする——詳細な設計判断は
// vgm2midi/CLAUDE.mdの「Refactor: event-output.ts」を参照。

import type { MidiConverter } from '../midi-converter';
import { noiseDrumNote } from '../midi-math';
import { addExpression, noteOn, noteOff, noteOnPercussion, updateNotePitch } from '../event-output';

type ActiveNoteMap = Map<string, { note: number; startTime: number; startVolume: number }>;

export function handleSSGWrite(
  host: MidiConverter,
  keyPrefix: string,
  reg: number,
  data: number,
  currentTime: number,
  activeNotes: ActiveNoteMap,
  cmdIndex: number,
  chip: string,
  instance: number
): void {
  if (reg <= 5) {
    updateSSGTonePeriod(host, keyPrefix, reg, data, currentTime, activeNotes, cmdIndex, chip, instance);
  }
  else if (reg === 6) updateSSGNoisePeriod(host, keyPrefix, data, currentTime, activeNotes);
  else if (reg === 7) updateSSGMixer(host, keyPrefix, data, currentTime, activeNotes);
  else if (reg >= 8 && reg <= 10) {
    updateSSGVolume(host, keyPrefix, reg - 8, data, currentTime, activeNotes);
  } else if (reg === 13) {
    retriggerSSGEnvelope(host, keyPrefix, currentTime, activeNotes);
  }
}

// reg 6 (5-bit noise period) is one shared generator per chip instance, unlike tone/
// volume/mixer which are per-channel — a change here can affect up to 3 channels'
// noise pitch at once, so every currently-sounding noise channel on this keyPrefix is
// re-evaluated (not just retriggered unconditionally, to avoid machine-gunning notes
// for a sweep that stays within the same drum band).
export function updateSSGNoisePeriod(
  host: MidiConverter,
  keyPrefix: string,
  data: number,
  currentTime: number,
  activeNotes: ActiveNoteMap
): void {
  const period = data & 0x1F;
  const previousPeriod = host.ssgNoisePeriods.get(keyPrefix);
  host.ssgNoisePeriods.set(keyPrefix, period);
  if (previousPeriod === undefined) return;

  const newNote = ssgNoiseNoteForPeriod(period);
  if (newNote === ssgNoiseNoteForPeriod(previousPeriod)) return;

  for (let channel = 0; channel < 3; channel++) {
    const noiseKey = `${keyPrefix}_noise_${channel}`;
    const active = activeNotes.get(noiseKey);
    if (active === undefined || active.note === newNote) continue;
    noteOff(host, noiseKey, 0, currentTime, activeNotes);
    const state = host.channels.get(`${keyPrefix}_${channel}`)!;
    noteOnPercussion(host,
      noiseKey,
      Math.round((state.volume / 15) * 100),
      currentTime,
      activeNotes,
      newNote
    );
  }
}

export function ssgNoiseNoteForPeriod(period: number): number {
  // Period 0 behaves like 1 on real hardware (a 5-bit down-counter that reloads on
  // underflow), matching the register-0 handling used elsewhere in this file.
  const effectivePeriod = period === 0 ? 1 : period;
  const normalizedRate = 1 - (effectivePeriod - 1) / 30;
  return noiseDrumNote(normalizedRate, false);
}

export function ssgNoiseNote(host: MidiConverter, keyPrefix: string): number {
  return ssgNoiseNoteForPeriod(host.ssgNoisePeriods.get(keyPrefix) ?? 1);
}

// Looks ahead through at most 16 samples for the other half ($reg ± 1) of a split SSG
// tone-period write on the same chip/instance, reusing isOPNMultiByteFreqUpdate() the
// same way OPN FM frequency pairs do. Without this, updating pitch after only the LSB
// or MSB half has landed briefly combines the new half with a stale other half and can
// retrigger a spurious note roughly an octave away.
export function updateSSGTonePeriod(
  host: MidiConverter,
  keyPrefix: string,
  reg: number,
  data: number,
  currentTime: number,
  activeNotes: ActiveNoteMap,
  cmdIndex: number,
  chip: string,
  instance: number
): void {
  const channel = Math.floor(reg / 2);
  const key = `${keyPrefix}_${channel}`;
  const state = host.channels.get(key)!;

  if (reg % 2 === 0) state.freqLSB = data;
  else state.freqMSB = data & 0x0F;

  const oldFreq = state.frequency;
  state.frequency = ((state.freqMSB || 0) << 8) | (state.freqLSB || 0);
  const otherReg = reg % 2 === 0 ? reg + 1 : reg - 1;
  const isSplitUpdate = host.isOPNMultiByteFreqUpdate(cmdIndex, chip, 0, otherReg, instance);
  if (state.active && !isSplitUpdate && state.frequency !== oldFreq) {
    updateNotePitch(host, key, 0, currentTime, activeNotes);
  }
}

export function updateSSGVolume(
  host: MidiConverter,
  keyPrefix: string,
  channel: number,
  data: number,
  currentTime: number,
  activeNotes: ActiveNoteMap
): void {
  const key = `${keyPrefix}_${channel}`;
  const state = host.channels.get(key)!;
  state.isEnvelope = (data & 0x10) !== 0;
  const effectiveVolume = state.isEnvelope ? 15 : data & 0x0F;
  const oldVolume = state.volume;
  const wasToneActive = state.active;
  const wasNoiseActive = state.isNoiseActive;
  state.volume = effectiveVolume;

  syncSSGToneState(host, keyPrefix, channel, currentTime, activeNotes);
  syncSSGNoiseState(host, keyPrefix, channel, currentTime, activeNotes);

  const expression = Math.round((effectiveVolume / 15) * 127);
  if (wasToneActive && state.active && oldVolume !== effectiveVolume) {
    addExpression(host, key, expression, currentTime);
  }
  if (wasNoiseActive && state.isNoiseActive && oldVolume !== effectiveVolume) {
    addExpression(host, `${keyPrefix}_noise_${channel}`, expression, currentTime);
  }
}

export function updateSSGMixer(
  host: MidiConverter,
  keyPrefix: string,
  data: number,
  currentTime: number,
  activeNotes: ActiveNoteMap
): void {
  for (let channel = 0; channel < 3; channel++) {
    const state = host.channels.get(`${keyPrefix}_${channel}`)!;
    state.isToneEnabled = (data & (1 << channel)) === 0;
    state.isNoise = (data & (1 << (channel + 3))) === 0;
    syncSSGToneState(host, keyPrefix, channel, currentTime, activeNotes);
    syncSSGNoiseState(host, keyPrefix, channel, currentTime, activeNotes);
  }
}

export function syncSSGToneState(
  host: MidiConverter,
  keyPrefix: string,
  channel: number,
  currentTime: number,
  activeNotes: ActiveNoteMap
): void {
  const key = `${keyPrefix}_${channel}`;
  const state = host.channels.get(key)!;
  const shouldSound = state.isToneEnabled && state.volume > 0;

  if (shouldSound && !state.active) {
    state.active = true;
    noteOn(host, key, 0, currentTime, activeNotes);
  } else if (!shouldSound && state.active) {
    state.active = false;
    noteOff(host, key, 0, currentTime, activeNotes);
  }
}

export function syncSSGNoiseState(
  host: MidiConverter,
  keyPrefix: string,
  channel: number,
  currentTime: number,
  activeNotes: ActiveNoteMap
): void {
  const state = host.channels.get(`${keyPrefix}_${channel}`)!;
  const noiseKey = `${keyPrefix}_noise_${channel}`;
  const shouldSound = state.isNoise && state.volume > 0;

  if (shouldSound && !state.isNoiseActive) {
    state.isNoiseActive = true;
    noteOnPercussion(host,
      noiseKey,
      Math.round((state.volume / 15) * 100),
      currentTime,
      activeNotes,
      ssgNoiseNote(host, keyPrefix)
    );
  } else if (!shouldSound && state.isNoiseActive) {
    state.isNoiseActive = false;
    noteOff(host, noiseKey, 0, currentTime, activeNotes);
  }
}

export function retriggerSSGEnvelope(
  host: MidiConverter,
  keyPrefix: string,
  currentTime: number,
  activeNotes: ActiveNoteMap
): void {
  for (let channel = 0; channel < 3; channel++) {
    const key = `${keyPrefix}_${channel}`;
    const state = host.channels.get(key)!;
    if (!state.isEnvelope) continue;
    if (state.active) {
      noteOff(host, key, 0, currentTime, activeNotes);
      noteOn(host, key, 0, currentTime, activeNotes);
    }
    if (state.isNoiseActive) {
      const noiseKey = `${keyPrefix}_noise_${channel}`;
      noteOff(host, noiseKey, 0, currentTime, activeNotes);
      noteOnPercussion(host, noiseKey, 100, currentTime, activeNotes, ssgNoiseNote(host, keyPrefix));
    }
  }
}
