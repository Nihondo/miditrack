"use strict";
// MidiConverterから抽出した、YM2203のレジスタ処理（FM・prescaler）。統合SSGコアは
// chips/ssg.tsへ、FM Timbre/Pan・Channel 3 Special/CSM Timer Aの共有機構は
// chips/opn-shared.tsへ委譲する。`host: MidiConverter`のper-conversion可変状態を
// 直接読み書きする——詳細な設計判断はvgm2midi/CLAUDE.mdの「Refactor: event-output.ts」
// を参照。
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleYM2203Write = handleYM2203Write;
exports.handleYM2203KeyWrite = handleYM2203KeyWrite;
exports.updateYM2203Frequency = updateYM2203Frequency;
exports.updateYM2203Prescaler = updateYM2203Prescaler;
const midi_converter_1 = require("../midi-converter");
const event_output_1 = require("../event-output");
const ssg_1 = require("./ssg");
const opn_shared_1 = require("./opn-shared");
function handleYM2203Write(host, cmd, currentTime, activeNotes, cmdIndex) {
    if (cmd.register === undefined || cmd.data === undefined)
        return;
    const instance = cmd.instance === 1 ? 1 : 0;
    const reg = cmd.register;
    const data = cmd.data;
    const keyPrefix = `ym2203_${instance}`;
    const ch3Context = host.opnCh3Context('YM2203', instance);
    if ((0, opn_shared_1.handleOPNPanWrite)(host, keyPrefix, 0, reg, data, currentTime))
        return;
    if (reg < 0x10) {
        (0, ssg_1.handleSSGWrite)(host, `${keyPrefix}_ssg`, reg, data, currentTime, activeNotes, cmdIndex, 'YM2203', instance);
        return;
    }
    if (reg >= 0x2D && reg <= 0x2F) {
        updateYM2203Prescaler(host, instance, reg, currentTime, activeNotes);
        return;
    }
    if (reg === 0x27) {
        (0, opn_shared_1.handleOPNCh3ModeWrite)(host, ch3Context, data, currentTime, activeNotes);
        (0, opn_shared_1.updateOPNCsmTimer)(host, 'YM2203', instance, data, currentTime, activeNotes);
        return;
    }
    if (reg === 0x24 || reg === 0x25) {
        (0, opn_shared_1.updateOPNCsmTimerRegister)(host, 'YM2203', instance, reg, data);
        return;
    }
    if ((0, opn_shared_1.handleOPNTimbreWrite)(host, keyPrefix, 0, reg, data, currentTime))
        return;
    if (handleYM2203KeyWrite(host, ch3Context, data, reg, currentTime, activeNotes))
        return;
    if ((0, opn_shared_1.handleOPNCh3SpecialFrequencyWrite)(host, ch3Context, reg, data, currentTime, activeNotes, cmdIndex))
        return;
    updateYM2203Frequency(host, instance, reg, data, currentTime, activeNotes, cmdIndex);
}
function handleYM2203KeyWrite(host, context, data, register, currentTime, activeNotes) {
    if (register !== 0x28)
        return false;
    const channel = data & 0x03;
    if (channel >= 3 || (data & 0x04) !== 0)
        return true;
    if (channel === 2 && host.isOPNCh3SpecialMode(context)) {
        (0, opn_shared_1.handleOPNCh3SpecialKeyWrite)(host, context, data, currentTime, activeNotes);
        return true;
    }
    const key = `${context.stateKey}_fm_${channel}`;
    const state = host.channels.get(key);
    state.keyOnMask = (data >> 4) & 0x0F;
    const shouldSound = state.keyOnMask !== 0;
    if (shouldSound && !state.active) {
        state.opnActivePitchScale = host.opnPitchScale(state);
        state.opnActiveVelocity = host.opnCarrierVelocity(state);
        state.active = true;
        (0, event_output_1.noteOn)(host, key, 0, currentTime, activeNotes);
    }
    else if (!shouldSound && state.active) {
        state.active = false;
        (0, event_output_1.noteOff)(host, key, 0, currentTime, activeNotes);
        state.opnActivePitchScale = 1;
    }
    return true;
}
function updateYM2203Frequency(host, instance, reg, data, currentTime, activeNotes, cmdIndex) {
    const isLowByte = reg >= 0xA0 && reg <= 0xA2;
    const isHighByte = reg >= 0xA4 && reg <= 0xA6;
    if (!isLowByte && !isHighByte)
        return;
    const channel = reg & 0x03;
    const key = `ym2203_${instance}_fm_${channel}`;
    const state = host.channels.get(key);
    if (isLowByte)
        state.freqLSB = data;
    else {
        state.freqMSB = data & 0x07;
        state.block = (data >> 3) & 0x07;
    }
    const oldFrequency = state.frequency;
    state.frequency = ((state.freqMSB ?? 0) << 8) | (state.freqLSB ?? 0);
    const otherReg = isLowByte ? reg + 4 : reg - 4;
    const isSplitUpdate = host.isOPNMultiByteFreqUpdate(cmdIndex, 'YM2203', 0, otherReg, instance);
    const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
    state.hasPendingFrequencyUpdate = isSplitUpdate;
    if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
        host.updateKeyBoundFMPitch(key, currentTime, activeNotes, midi_converter_1.YM2203_FM_PITCH_BEND_RANGE);
    }
}
function updateYM2203Prescaler(host, instance, register, currentTime, activeNotes) {
    const oldPrescaler = host.ym2203Prescalers[instance];
    let newPrescaler = oldPrescaler;
    if (register === 0x2D)
        newPrescaler = 6;
    else if (register === 0x2E && oldPrescaler === 6)
        newPrescaler = 3;
    else if (register === 0x2F)
        newPrescaler = 2;
    if (newPrescaler === oldPrescaler)
        return;
    host.ym2203Prescalers[instance] = newPrescaler;
    for (const section of ['fm', 'ssg']) {
        for (let channel = 0; channel < 3; channel++) {
            const key = `ym2203_${instance}_${section}_${channel}`;
            if (host.channels.get(key).active) {
                if (section === 'fm') {
                    host.updateKeyBoundFMPitch(key, currentTime, activeNotes, midi_converter_1.YM2203_FM_PITCH_BEND_RANGE);
                }
                else
                    (0, event_output_1.updateNotePitch)(host, key, 0, currentTime, activeNotes);
            }
        }
    }
    (0, opn_shared_1.updateActiveOPNCh3SpecialPitches)(host, host.opnCh3Context('YM2203', instance), currentTime, activeNotes);
}
