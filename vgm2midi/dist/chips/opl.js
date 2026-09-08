"use strict";
// MidiConverterから抽出した、OPLファミリー（YM3812/YM3526/Y8950）FM・リズムモードの
// レジスタ処理。`host: MidiConverter`のper-conversion可変状態（channels/oplRhythmModes等）
// を直接読み書きする——詳細な設計判断はvgm2midi/CLAUDE.mdの「Refactor: event-output.ts」
// を参照。`recordFMTimbreEvent()`/`updateKeyBoundFMPitch()`/`operatorTotalLevelVelocity()`/
// `oplCarrierVelocity()`/`oplCarrierExpression()`はYM2151/OPN系とも共有する（あるいは
// OPN系と対になる）ヘルパーのため、MidiConverter側に残したまま`host.`経由で呼ぶ。
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleOPLWrite = handleOPLWrite;
exports.oplKey = oplKey;
exports.oplOperatorSlot = oplOperatorSlot;
exports.setOPLOperatorMultiple = setOPLOperatorMultiple;
exports.setOPLOperatorTotalLevel = setOPLOperatorTotalLevel;
exports.setOPLConnection = setOPLConnection;
exports.updateOPLFrequencyLow = updateOPLFrequencyLow;
exports.updateOPLKeyAndBlock = updateOPLKeyAndBlock;
exports.commitOPLKeyOn = commitOPLKeyOn;
exports.handleOPLRhythmWrite = handleOPLRhythmWrite;
exports.oplRhythmVelocity = oplRhythmVelocity;
const midi_converter_1 = require("../midi-converter");
const event_output_1 = require("../event-output");
const OPL_RHYTHM_NOTES = [36, 42, 38, 45, 49];
const OPL_RHYTHM_KEY_BITS = [0x10, 0x01, 0x08, 0x04, 0x02];
const OPL_RHYTHM_SLOTS = [[6, 1], [7, 0], [7, 1], [8, 0], [8, 1]];
// fmopl.c slot_array[32]: only these 18 offsets address the two operators of channels 0-8.
const OPL_SLOT_BY_REGISTER_OFFSET = [
    [0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], undefined, undefined,
    [3, 0], [4, 0], [5, 0], [3, 1], [4, 1], [5, 1], undefined, undefined,
    [6, 0], [7, 0], [8, 0], [6, 1], [7, 1], [8, 1], undefined, undefined,
];
function handleOPLWrite(host, cmd, currentTime, activeNotes, cmdIndex) {
    if (cmd.register === undefined || cmd.data === undefined)
        return;
    if (!midi_converter_1.OPL_CHIPS.includes(cmd.chip))
        return;
    const chip = cmd.chip;
    const instance = cmd.instance === 1 ? 1 : 0;
    const register = cmd.register;
    const data = cmd.data;
    if (register === 0xBD) {
        handleOPLRhythmWrite(host, chip, instance, data, currentTime, activeNotes);
    }
    else if (register >= 0x20 && register <= 0x35) {
        setOPLOperatorMultiple(host, chip, instance, register, data, currentTime);
    }
    else if (register >= 0x40 && register <= 0x55) {
        setOPLOperatorTotalLevel(host, chip, instance, register, data, currentTime, activeNotes);
    }
    else if (register >= 0xA0 && register <= 0xA8) {
        updateOPLFrequencyLow(host, chip, instance, register - 0xA0, data, currentTime, activeNotes, cmdIndex);
    }
    else if (register >= 0xB0 && register <= 0xB8) {
        updateOPLKeyAndBlock(host, chip, instance, register - 0xB0, data, currentTime, activeNotes, cmdIndex);
    }
    else if (register >= 0xC0 && register <= 0xC8) {
        setOPLConnection(host, chip, instance, register - 0xC0, data, currentTime);
    }
}
function oplKey(chip, instance, section, channel) {
    return `${chip.toLowerCase()}_${instance}_${section}_${channel}`;
}
function oplOperatorSlot(register, bankStart) {
    return OPL_SLOT_BY_REGISTER_OFFSET[register - bankStart];
}
function setOPLOperatorMultiple(host, chip, instance, register, data, currentTime) {
    const slot = oplOperatorSlot(register, 0x20);
    if (!slot)
        return;
    const [channel, operator] = slot;
    const state = host.channels.get(oplKey(chip, instance, 'fm', channel));
    state.opnOperatorMultipliers[operator] = data & 0x0F;
    state.opnOperatorMultiplierWritten[operator] = true;
    host.recordFMTimbreEvent(oplKey(chip, instance, 'fm', channel), currentTime, 'opl-timbre');
}
function setOPLOperatorTotalLevel(host, chip, instance, register, data, currentTime, activeNotes) {
    const slot = oplOperatorSlot(register, 0x40);
    if (!slot)
        return;
    const [channel, operator] = slot;
    const key = oplKey(chip, instance, 'fm', channel);
    const state = host.channels.get(key);
    state.opnOperatorTotalLevels[operator] = data & 0x3F;
    if (state.active)
        (0, event_output_1.addExpression)(host, key, host.oplCarrierExpression(state), currentTime);
    host.recordFMTimbreEvent(key, currentTime, 'opl-timbre');
    if (!host.oplRhythmModes.get(`${chip}_${instance}`))
        return;
    for (let index = 0; index < OPL_RHYTHM_SLOTS.length; index++) {
        const [rhythmChannel, rhythmOperator] = OPL_RHYTHM_SLOTS[index];
        if (rhythmChannel !== channel || rhythmOperator !== operator)
            continue;
        const rhythmKey = oplKey(chip, instance, 'rhythm', index);
        if (!activeNotes.has(rhythmKey))
            continue;
        const expression = Math.round((oplRhythmVelocity(host, chip, instance, index) / 100) * 127);
        (0, event_output_1.addExpression)(host, rhythmKey, expression, currentTime);
    }
}
function setOPLConnection(host, chip, instance, channel, data, currentTime) {
    const key = oplKey(chip, instance, 'fm', channel);
    const state = host.channels.get(key);
    state.opnAlgorithm = data & 0x01;
    host.recordFMTimbreEvent(key, currentTime, 'opl-timbre');
}
function updateOPLFrequencyLow(host, chip, instance, channel, data, currentTime, activeNotes, cmdIndex) {
    const key = oplKey(chip, instance, 'fm', channel);
    const state = host.channels.get(key);
    const oldFrequency = state.frequency;
    state.freqLSB = data;
    state.frequency = ((state.freqMSB ?? 0) << 8) | data;
    if (host.oplRhythmModes.get(`${chip}_${instance}`) && channel >= 6)
        return;
    if (state.oplPendingKeyOn) {
        state.oplPendingKeyOn = false;
        commitOPLKeyOn(host, chip, instance, channel, currentTime, activeNotes);
        return;
    }
    const isSplitUpdate = host.isOPNMultiByteFreqUpdate(cmdIndex, chip, 0, 0xB0 + channel, instance);
    const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
    state.hasPendingFrequencyUpdate = isSplitUpdate;
    if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
        host.updateKeyBoundFMPitch(key, currentTime, activeNotes, midi_converter_1.OPL_FM_PITCH_BEND_RANGE);
    }
}
function updateOPLKeyAndBlock(host, chip, instance, channel, data, currentTime, activeNotes, cmdIndex) {
    const key = oplKey(chip, instance, 'fm', channel);
    const state = host.channels.get(key);
    const oldFrequency = state.frequency;
    const wasKeyOn = state.oplKeyOn ?? false;
    const isKeyOn = (data & 0x20) !== 0;
    state.freqMSB = data & 0x03;
    state.block = (data >> 2) & 0x07;
    state.frequency = ((state.freqMSB ?? 0) << 8) | (state.freqLSB ?? 0);
    state.oplKeyOn = isKeyOn;
    const isSplitUpdate = host.isOPNMultiByteFreqUpdate(cmdIndex, chip, 0, 0xA0 + channel, instance);
    const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
    state.hasPendingFrequencyUpdate = isSplitUpdate;
    if (host.oplRhythmModes.get(`${chip}_${instance}`) && channel >= 6)
        return;
    if (isKeyOn && !wasKeyOn) {
        if (isSplitUpdate)
            state.oplPendingKeyOn = true;
        else
            commitOPLKeyOn(host, chip, instance, channel, currentTime, activeNotes);
    }
    else if (!isKeyOn && wasKeyOn) {
        state.oplPendingKeyOn = false;
        if (state.active) {
            state.active = false;
            (0, event_output_1.noteOff)(host, key, 0, currentTime, activeNotes);
        }
    }
    else if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
        host.updateKeyBoundFMPitch(key, currentTime, activeNotes, midi_converter_1.OPL_FM_PITCH_BEND_RANGE);
    }
}
function commitOPLKeyOn(host, chip, instance, channel, currentTime, activeNotes) {
    const key = oplKey(chip, instance, 'fm', channel);
    const state = host.channels.get(key);
    if (state.active)
        return;
    state.opnActiveVelocity = host.oplCarrierVelocity(state);
    state.opnActivePitchScale = host.oplPitchScale(state);
    state.active = true;
    (0, event_output_1.noteOn)(host, key, 0, currentTime, activeNotes);
}
function handleOPLRhythmWrite(host, chip, instance, data, currentTime, activeNotes) {
    const stateKey = `${chip}_${instance}`;
    const wasRhythmMode = host.oplRhythmModes.get(stateKey) ?? false;
    const isRhythmMode = (data & 0x20) !== 0;
    if (isRhythmMode !== wasRhythmMode) {
        for (const channel of [6, 7, 8]) {
            const key = oplKey(chip, instance, 'fm', channel);
            const state = host.channels.get(key);
            if (!state.active)
                continue;
            state.active = false;
            (0, event_output_1.noteOff)(host, key, 0, currentTime, activeNotes);
        }
        for (let index = 0; index < OPL_RHYTHM_NOTES.length; index++) {
            const key = oplKey(chip, instance, 'rhythm', index);
            if (activeNotes.has(key))
                (0, event_output_1.noteOff)(host, key, 0, currentTime, activeNotes);
        }
        host.oplRhythmModes.set(stateKey, isRhythmMode);
        host.oplRhythmControlBytes.set(stateKey, 0);
    }
    if (!isRhythmMode)
        return;
    const newBits = data & 0x1F;
    const oldBits = host.oplRhythmControlBytes.get(stateKey) ?? 0;
    const changedBits = newBits ^ oldBits;
    host.oplRhythmControlBytes.set(stateKey, newBits);
    for (let index = 0; index < OPL_RHYTHM_KEY_BITS.length; index++) {
        const bit = OPL_RHYTHM_KEY_BITS[index];
        if ((changedBits & bit) === 0)
            continue;
        const key = oplKey(chip, instance, 'rhythm', index);
        if ((newBits & bit) !== 0) {
            (0, event_output_1.noteOnPercussion)(host, key, oplRhythmVelocity(host, chip, instance, index), currentTime, activeNotes, OPL_RHYTHM_NOTES[index]);
        }
        else if (activeNotes.has(key)) {
            (0, event_output_1.noteOff)(host, key, 0, currentTime, activeNotes);
        }
    }
}
function oplRhythmVelocity(host, chip, instance, index) {
    const [channel, operator] = OPL_RHYTHM_SLOTS[index];
    const state = host.channels.get(oplKey(chip, instance, 'fm', channel));
    return host.operatorTotalLevelVelocity(state.opnOperatorTotalLevels?.[operator] ?? 0);
}
