"use strict";
// MidiConverterから抽出した、YM2608のレジスタ処理（FM・prescaler・リズム・ADPCM-B）。
// 統合SSGコアはchips/ssg.tsへ、FM Timbre/Pan・Channel 3 Special/CSM Timer Aの
// 共有機構はchips/opn-shared.tsへ委譲する。`host: MidiConverter`のper-conversion
// 可変状態を直接読み書きする——詳細な設計判断はvgm2midi/CLAUDE.mdの
// 「Refactor: event-output.ts」を参照。
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleYM2608Write = handleYM2608Write;
exports.handleYM2608KeyWrite = handleYM2608KeyWrite;
exports.updateYM2608Frequency = updateYM2608Frequency;
exports.updateYM2608Prescaler = updateYM2608Prescaler;
exports.handleYM2608RhythmWrite = handleYM2608RhythmWrite;
exports.updateYM2608RhythmKeys = updateYM2608RhythmKeys;
exports.updateYM2608RhythmExpression = updateYM2608RhythmExpression;
exports.ym2608RhythmVelocity = ym2608RhythmVelocity;
exports.handleYM2608ADPCMBWrite = handleYM2608ADPCMBWrite;
exports.ym2608ADPCMDurationSamples = ym2608ADPCMDurationSamples;
exports.stopYM2608ADPCMBVoice = stopYM2608ADPCMBVoice;
const midi_converter_1 = require("../midi-converter");
const vgm_chip_metadata_1 = require("../vgm-chip-metadata");
const pcm_analysis_1 = require("../pcm-analysis");
const event_output_1 = require("../event-output");
const ssg_1 = require("./ssg");
const opn_shared_1 = require("./opn-shared");
const YM2608_RHYTHM_NOTES = [36, 38, 49, 42, 45, 37];
function handleYM2608Write(host, cmd, currentTime, activeNotes, cmdIndex) {
    if (cmd.register === undefined || cmd.data === undefined)
        return;
    const instance = cmd.instance === 1 ? 1 : 0;
    const port = cmd.port === 1 ? 1 : 0;
    const reg = cmd.register;
    const data = cmd.data;
    const keyPrefix = `ym2608_${instance}`;
    const ch3Context = host.opnCh3Context('YM2608', instance);
    if ((0, opn_shared_1.handleOPNPanWrite)(host, keyPrefix, port, reg, data, currentTime))
        return;
    if (port === 0 && reg < 0x10) {
        (0, ssg_1.handleSSGWrite)(host, `${keyPrefix}_ssg`, reg, data, currentTime, activeNotes, cmdIndex, 'YM2608', instance);
        return;
    }
    if (port === 0 && reg >= 0x10 && reg <= 0x1D) {
        handleYM2608RhythmWrite(host, instance, reg, data, currentTime, activeNotes);
        return;
    }
    if (port === 1 && reg <= 0x10) {
        handleYM2608ADPCMBWrite(host, instance, reg, data, currentTime);
        return;
    }
    if (port === 0 && reg >= 0x2D && reg <= 0x2F) {
        updateYM2608Prescaler(host, instance, reg, currentTime, activeNotes);
        return;
    }
    if (port === 0 && reg === 0x27) {
        (0, opn_shared_1.handleOPNCh3ModeWrite)(host, ch3Context, data, currentTime, activeNotes);
        (0, opn_shared_1.updateOPNCsmTimer)(host, 'YM2608', instance, data, currentTime, activeNotes);
        return;
    }
    if (port === 0 && (reg === 0x24 || reg === 0x25)) {
        (0, opn_shared_1.updateOPNCsmTimerRegister)(host, 'YM2608', instance, reg, data);
        return;
    }
    if ((0, opn_shared_1.handleOPNTimbreWrite)(host, keyPrefix, port, reg, data, currentTime))
        return;
    if (port === 0 && handleYM2608KeyWrite(host, ch3Context, data, reg, currentTime, activeNotes))
        return;
    if (port === 0 && (0, opn_shared_1.handleOPNCh3SpecialFrequencyWrite)(host, ch3Context, reg, data, currentTime, activeNotes, cmdIndex))
        return;
    updateYM2608Frequency(host, instance, port, reg, data, currentTime, activeNotes, cmdIndex);
}
function handleYM2608KeyWrite(host, context, data, register, currentTime, activeNotes) {
    if (register !== 0x28)
        return false;
    const channelOffset = data & 0x03;
    if (channelOffset >= 3)
        return true;
    const channel = channelOffset + ((data & 0x04) === 0 ? 0 : 3);
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
function updateYM2608Frequency(host, instance, port, reg, data, currentTime, activeNotes, cmdIndex) {
    const isLowByte = reg >= 0xA0 && reg <= 0xA2;
    const isHighByte = reg >= 0xA4 && reg <= 0xA6;
    if (!isLowByte && !isHighByte)
        return;
    const channel = (reg & 0x03) + (port * 3);
    const key = `ym2608_${instance}_fm_${channel}`;
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
    const isSplitUpdate = host.isOPNMultiByteFreqUpdate(cmdIndex, 'YM2608', port, otherReg, instance);
    const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
    state.hasPendingFrequencyUpdate = isSplitUpdate;
    if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
        host.updateKeyBoundFMPitch(key, currentTime, activeNotes, midi_converter_1.YM2608_FM_PITCH_BEND_RANGE);
    }
}
function updateYM2608Prescaler(host, instance, register, currentTime, activeNotes) {
    const oldPrescaler = host.ym2608Prescalers[instance];
    let newPrescaler = oldPrescaler;
    if (register === 0x2D)
        newPrescaler = 6;
    else if (register === 0x2E && oldPrescaler === 6)
        newPrescaler = 3;
    else if (register === 0x2F)
        newPrescaler = 2;
    if (newPrescaler === oldPrescaler)
        return;
    host.ym2608Prescalers[instance] = newPrescaler;
    for (let channel = 0; channel < 6; channel++) {
        const key = `ym2608_${instance}_fm_${channel}`;
        if (host.channels.get(key).active) {
            host.updateKeyBoundFMPitch(key, currentTime, activeNotes, midi_converter_1.YM2608_FM_PITCH_BEND_RANGE);
        }
    }
    for (let channel = 0; channel < 3; channel++) {
        const key = `ym2608_${instance}_ssg_${channel}`;
        if (host.channels.get(key).active)
            (0, event_output_1.updateNotePitch)(host, key, 0, currentTime, activeNotes);
    }
    (0, opn_shared_1.updateActiveOPNCh3SpecialPitches)(host, host.opnCh3Context('YM2608', instance), currentTime, activeNotes);
}
function handleYM2608RhythmWrite(host, instance, register, data, currentTime, activeNotes) {
    if (register === 0x10) {
        updateYM2608RhythmKeys(host, instance, data, currentTime, activeNotes);
        return;
    }
    if (register === 0x11) {
        host.ym2608RhythmTotalLevels[instance] = data & 0x3F;
        updateYM2608RhythmExpression(host, instance, currentTime, activeNotes);
        return;
    }
    if (register >= 0x18 && register <= 0x1D) {
        const channel = register - 0x18;
        host.ym2608RhythmInstrumentLevels[instance][channel] = data & 0x1F;
        updateYM2608RhythmExpression(host, instance, currentTime, activeNotes, channel);
    }
}
function updateYM2608RhythmKeys(host, instance, data, currentTime, activeNotes) {
    const isDump = (data & 0x80) !== 0;
    const mask = data & 0x3F;
    for (let channel = 0; channel < 6; channel++) {
        if ((mask & (1 << channel)) === 0)
            continue;
        const key = `ym2608_${instance}_rhythm_${channel}`;
        if (activeNotes.has(key))
            (0, event_output_1.noteOff)(host, key, 0, currentTime, activeNotes);
        if (!isDump) {
            const velocity = ym2608RhythmVelocity(host, instance, channel);
            (0, event_output_1.noteOnPercussion)(host, key, velocity, currentTime, activeNotes, YM2608_RHYTHM_NOTES[channel]);
        }
    }
}
function updateYM2608RhythmExpression(host, instance, currentTime, activeNotes, selectedChannel) {
    for (let channel = 0; channel < 6; channel++) {
        if (selectedChannel !== undefined && channel !== selectedChannel)
            continue;
        const key = `ym2608_${instance}_rhythm_${channel}`;
        if (!activeNotes.has(key))
            continue;
        const expression = Math.round((ym2608RhythmVelocity(host, instance, channel) / 100) * 127);
        (0, event_output_1.addExpression)(host, key, expression, currentTime);
    }
}
function ym2608RhythmVelocity(host, instance, channel) {
    const combinedLevel = host.ym2608RhythmTotalLevels[instance]
        + host.ym2608RhythmInstrumentLevels[instance][channel];
    const audibleLevel = Math.max(0, combinedLevel - 31);
    return Math.max(1, Math.round((audibleLevel / 63) * 100));
}
function handleYM2608ADPCMBWrite(host, instance, register, data, currentTime) {
    const registers = host.ym2608ADPCMRegisters[instance];
    registers[register] = data;
    if (register === 0x0B) {
        const voice = host.ym2608ADPCMActiveVoices[instance];
        if (voice)
            (0, event_output_1.addExpression)(host, voice.descriptorId, Math.round((data / 255) * 127), currentTime);
        return;
    }
    if (register !== 0x00)
        return;
    if ((data & 0x01) !== 0 || (data & 0x80) === 0) {
        stopYM2608ADPCMBVoice(host, instance, currentTime);
        return;
    }
    stopYM2608ADPCMBVoice(host, instance, currentTime);
    const address = registers[0x02] | (registers[0x03] << 8);
    const endAddress = registers[0x04] | (registers[0x05] << 8);
    // ADPCM-B's ROM start/end registers address 32-byte units.  RAM mode has
    // no VGM ROM data-block equivalent, so preserve the trigger without a link.
    const isROMMode = (registers[0x01] & 0x01) !== 0;
    const isEightBitRAMMode = (registers[0x01] & 0x02) !== 0;
    const addressUnitBytes = isROMMode || isEightBitRAMMode ? 32 : 4;
    const isLoop = (data & 0x10) !== 0;
    const dataLengthBytes = endAddress >= address ? (endAddress - address + 1) << 5 : undefined;
    const dataBlock = isROMMode
        ? host.pcmROMDataBlockForAddress(0x81, instance, address << 5, dataLengthBytes)
        : undefined;
    const sampleId = address.toString(16).padStart(4, '0');
    const trackKey = `ym2608_${instance}_adpcmb_sample_${sampleId}`;
    const note = (0, event_output_1.pcmNoteForSample)(host, trackKey);
    const velocity = Math.max(1, Math.round((registers[0x0B] / 255) * 100));
    const deltaN = registers[0x09] | (registers[0x0A] << 8);
    const durationSamples = isLoop
        ? undefined
        : ym2608ADPCMDurationSamples(host, address, endAddress, deltaN, addressUnitBytes);
    const descriptorId = (0, event_output_1.noteOnPCMPercussion)(host, trackKey, note, velocity, currentTime, isLoop, dataBlock, durationSamples, undefined, isROMMode ? (0, pcm_analysis_1.ym2608ADPCMBAnalysis)(host.vgmData, dataBlock, dataLengthBytes) : undefined);
    host.ym2608ADPCMActiveVoices[instance] = { descriptorId, note };
}
/** YM2608 ADPCM-Bの非repeat範囲を、VGMの44.1 kHz時間単位へ概算変換する。 */
function ym2608ADPCMDurationSamples(host, startAddress, endAddress, deltaN, addressUnitBytes) {
    if (endAddress < startAddress || deltaN === 0)
        return undefined;
    const clock = host.vgmData.header.ym2608Clock & vgm_chip_metadata_1.CLOCK_MASK;
    if (clock === 0)
        return undefined;
    const byteLength = (endAddress - startAddress + 1) * addressUnitBytes;
    // The ADPCM-B phase accumulator advances once per master-clock/144 tick.
    // Each encoded byte contains two 4-bit ADPCM samples.
    return Math.round((byteLength * 2 * host.sampleRate * 144 * 0x10000) / (deltaN * clock));
}
function stopYM2608ADPCMBVoice(host, instance, currentTime) {
    const voice = host.ym2608ADPCMActiveVoices[instance];
    if (!voice)
        return;
    (0, event_output_1.noteOffPCMPercussion)(host, voice.descriptorId, voice.note, currentTime);
    host.ym2608ADPCMActiveVoices[instance] = undefined;
}
