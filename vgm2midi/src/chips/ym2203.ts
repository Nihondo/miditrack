// MidiConverterから抽出した、YM2203のレジスタ処理（FM・prescaler）。統合SSGコアは
// chips/ssg.tsへ、FM Timbre/Pan・Channel 3 Special/CSM Timer Aの共有機構は
// chips/opn-shared.tsへ委譲する。`host: MidiConverter`のper-conversion可変状態を
// 直接読み書きする——詳細な設計判断はvgm2midi/CLAUDE.mdの「Refactor: event-output.ts」
// を参照。

import type { MidiConverter, OPNCh3Context } from '../midi-converter';
import { YM2203_FM_PITCH_BEND_RANGE } from '../midi-converter';
import { noteOn, noteOff, updateNotePitch } from '../event-output';
import { handleSSGWrite } from './ssg';
import {
  handleOPNPanWrite,
  handleOPNTimbreWrite,
  handleOPNCh3ModeWrite,
  updateOPNCsmTimer,
  updateOPNCsmTimerRegister,
  handleOPNCh3SpecialKeyWrite,
  handleOPNCh3SpecialFrequencyWrite,
  updateActiveOPNCh3SpecialPitches,
} from './opn-shared';
import type { VGMCommand } from '../types';

type ActiveNoteMap = Map<string, { note: number; startTime: number; startVolume: number }>;

export function handleYM2203Write(
  host: MidiConverter,
  cmd: VGMCommand,
  currentTime: number,
  activeNotes: ActiveNoteMap,
  cmdIndex: number
): void {
  if (cmd.register === undefined || cmd.data === undefined) return;
  const instance = cmd.instance === 1 ? 1 : 0;
  const reg = cmd.register;
  const data = cmd.data;
  const keyPrefix = `ym2203_${instance}`;
  const ch3Context = host.opnCh3Context('YM2203', instance);

  if (handleOPNPanWrite(host, keyPrefix, 0, reg, data, currentTime)) return;

  if (reg < 0x10) {
    handleSSGWrite(host, `${keyPrefix}_ssg`, reg, data, currentTime, activeNotes, cmdIndex, 'YM2203', instance);
    return;
  }
  if (reg >= 0x2D && reg <= 0x2F) {
    updateYM2203Prescaler(host, instance, reg, currentTime, activeNotes);
    return;
  }
  if (reg === 0x27) {
    handleOPNCh3ModeWrite(host, ch3Context, data, currentTime, activeNotes);
    updateOPNCsmTimer(host, 'YM2203', instance, data, currentTime, activeNotes);
    return;
  }
  if (reg === 0x24 || reg === 0x25) {
    updateOPNCsmTimerRegister(host, 'YM2203', instance, reg, data);
    return;
  }
  if (handleOPNTimbreWrite(host, keyPrefix, 0, reg, data, currentTime)) return;
  if (handleYM2203KeyWrite(host, ch3Context, data, reg, currentTime, activeNotes)) return;
  if (handleOPNCh3SpecialFrequencyWrite(
    host, ch3Context, reg, data, currentTime, activeNotes, cmdIndex
  )) return;
  updateYM2203Frequency(host, instance, reg, data, currentTime, activeNotes, cmdIndex);
}

export function handleYM2203KeyWrite(
  host: MidiConverter,
  context: OPNCh3Context,
  data: number,
  register: number,
  currentTime: number,
  activeNotes: ActiveNoteMap
): boolean {
  if (register !== 0x28) return false;
  const channel = data & 0x03;
  if (channel >= 3 || (data & 0x04) !== 0) return true;
  if (channel === 2 && host.isOPNCh3SpecialMode(context)) {
    handleOPNCh3SpecialKeyWrite(host, context, data, currentTime, activeNotes);
    return true;
  }
  const key = `${context.stateKey}_fm_${channel}`;
  const state = host.channels.get(key)!;
  state.keyOnMask = (data >> 4) & 0x0F;
  const shouldSound = state.keyOnMask !== 0;
  if (shouldSound && !state.active) {
    state.opnActivePitchScale = host.opnPitchScale(state);
    state.opnActiveVelocity = host.opnCarrierVelocity(state);
    state.active = true;
    noteOn(host, key, 0, currentTime, activeNotes);
  } else if (!shouldSound && state.active) {
    state.active = false;
    noteOff(host, key, 0, currentTime, activeNotes);
    state.opnActivePitchScale = 1;
  }
  return true;
}

export function updateYM2203Frequency(
  host: MidiConverter,
  instance: number,
  reg: number,
  data: number,
  currentTime: number,
  activeNotes: ActiveNoteMap,
  cmdIndex: number
): void {
  const isLowByte = reg >= 0xA0 && reg <= 0xA2;
  const isHighByte = reg >= 0xA4 && reg <= 0xA6;
  if (!isLowByte && !isHighByte) return;

  const channel = reg & 0x03;
  const key = `ym2203_${instance}_fm_${channel}`;
  const state = host.channels.get(key)!;
  if (isLowByte) state.freqLSB = data;
  else {
    state.freqMSB = data & 0x07;
    state.block = (data >> 3) & 0x07;
  }
  const oldFrequency = state.frequency;
  state.frequency = ((state.freqMSB ?? 0) << 8) | (state.freqLSB ?? 0);
  const otherReg = isLowByte ? reg + 4 : reg - 4;
  const isSplitUpdate = host.isOPNMultiByteFreqUpdate(
    cmdIndex,
    'YM2203',
    0,
    otherReg,
    instance
  );
  const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
  state.hasPendingFrequencyUpdate = isSplitUpdate;
  if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
    host.updateKeyBoundFMPitch(key, currentTime, activeNotes, YM2203_FM_PITCH_BEND_RANGE);
  }
}

export function updateYM2203Prescaler(
  host: MidiConverter,
  instance: number,
  register: number,
  currentTime: number,
  activeNotes: ActiveNoteMap
): void {
  const oldPrescaler = host.ym2203Prescalers[instance];
  let newPrescaler = oldPrescaler;
  if (register === 0x2D) newPrescaler = 6;
  else if (register === 0x2E && oldPrescaler === 6) newPrescaler = 3;
  else if (register === 0x2F) newPrescaler = 2;
  if (newPrescaler === oldPrescaler) return;

  host.ym2203Prescalers[instance] = newPrescaler;
  for (const section of ['fm', 'ssg']) {
    for (let channel = 0; channel < 3; channel++) {
      const key = `ym2203_${instance}_${section}_${channel}`;
      if (host.channels.get(key)!.active) {
        if (section === 'fm') {
          host.updateKeyBoundFMPitch(
            key,
            currentTime,
            activeNotes,
            YM2203_FM_PITCH_BEND_RANGE
          );
        }
        else updateNotePitch(host, key, 0, currentTime, activeNotes);
      }
    }
  }
  updateActiveOPNCh3SpecialPitches(
    host, host.opnCh3Context('YM2203', instance), currentTime, activeNotes
  );
}
