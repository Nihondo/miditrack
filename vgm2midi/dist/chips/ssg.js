"use strict";
// MidiConverterから抽出した、AY-3-8910互換SSG（トーン・ノイズ・エンベロープ）の
// レジスタ処理。AY8910単体、およびYM2203/YM2608に内蔵されたSSGコアの3チップから
// `keyPrefix`/`chip`/`instance`引数で共有される、チップ固有ではない状態機械——
// AY8910自身の`handleAY8910Write()`（chips/ay8910.ts）だけでなく、
// midi-converter.ts側に残るYM2203/YM2608のFMハンドラーからも
// `handleSSGWrite()`が直接呼ばれる。`host: MidiConverter`のper-conversion
// 可変状態（channels/ssgNoisePeriods等）を直接読み書きする——詳細な設計判断は
// vgm2midi/CLAUDE.mdの「Refactor: event-output.ts」を参照。
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleSSGWrite = handleSSGWrite;
exports.updateSSGNoisePeriod = updateSSGNoisePeriod;
exports.ssgNoiseNoteForPeriod = ssgNoiseNoteForPeriod;
exports.ssgNoiseNote = ssgNoiseNote;
exports.updateSSGTonePeriod = updateSSGTonePeriod;
exports.updateSSGVolume = updateSSGVolume;
exports.updateSSGMixer = updateSSGMixer;
exports.syncSSGToneState = syncSSGToneState;
exports.syncSSGNoiseState = syncSSGNoiseState;
exports.retriggerSSGEnvelope = retriggerSSGEnvelope;
const midi_math_1 = require("../midi-math");
const event_output_1 = require("../event-output");
function handleSSGWrite(host, keyPrefix, reg, data, currentTime, activeNotes, cmdIndex, chip, instance) {
    if (reg <= 5) {
        updateSSGTonePeriod(host, keyPrefix, reg, data, currentTime, activeNotes, cmdIndex, chip, instance);
    }
    else if (reg === 6)
        updateSSGNoisePeriod(host, keyPrefix, data, currentTime, activeNotes);
    else if (reg === 7)
        updateSSGMixer(host, keyPrefix, data, currentTime, activeNotes);
    else if (reg >= 8 && reg <= 10) {
        updateSSGVolume(host, keyPrefix, reg - 8, data, currentTime, activeNotes);
    }
    else if (reg === 13) {
        retriggerSSGEnvelope(host, keyPrefix, currentTime, activeNotes);
    }
}
// reg 6 (5-bit noise period) is one shared generator per chip instance, unlike tone/
// volume/mixer which are per-channel — a change here can affect up to 3 channels'
// noise pitch at once, so every currently-sounding noise channel on this keyPrefix is
// re-evaluated (not just retriggered unconditionally, to avoid machine-gunning notes
// for a sweep that stays within the same drum band).
function updateSSGNoisePeriod(host, keyPrefix, data, currentTime, activeNotes) {
    const period = data & 0x1F;
    const previousPeriod = host.ssgNoisePeriods.get(keyPrefix);
    host.ssgNoisePeriods.set(keyPrefix, period);
    if (previousPeriod === undefined)
        return;
    const newNote = ssgNoiseNoteForPeriod(period);
    if (newNote === ssgNoiseNoteForPeriod(previousPeriod))
        return;
    for (let channel = 0; channel < 3; channel++) {
        const noiseKey = `${keyPrefix}_noise_${channel}`;
        const active = activeNotes.get(noiseKey);
        if (active === undefined || active.note === newNote)
            continue;
        (0, event_output_1.noteOff)(host, noiseKey, 0, currentTime, activeNotes);
        const state = host.channels.get(`${keyPrefix}_${channel}`);
        (0, event_output_1.noteOnPercussion)(host, noiseKey, Math.round((state.volume / 15) * 100), currentTime, activeNotes, newNote);
    }
}
function ssgNoiseNoteForPeriod(period) {
    // Period 0 behaves like 1 on real hardware (a 5-bit down-counter that reloads on
    // underflow), matching the register-0 handling used elsewhere in this file.
    const effectivePeriod = period === 0 ? 1 : period;
    const normalizedRate = 1 - (effectivePeriod - 1) / 30;
    return (0, midi_math_1.noiseDrumNote)(normalizedRate, false);
}
function ssgNoiseNote(host, keyPrefix) {
    return ssgNoiseNoteForPeriod(host.ssgNoisePeriods.get(keyPrefix) ?? 1);
}
// Looks ahead through at most 16 samples for the other half ($reg ± 1) of a split SSG
// tone-period write on the same chip/instance, reusing isOPNMultiByteFreqUpdate() the
// same way OPN FM frequency pairs do. Without this, updating pitch after only the LSB
// or MSB half has landed briefly combines the new half with a stale other half and can
// retrigger a spurious note roughly an octave away.
function updateSSGTonePeriod(host, keyPrefix, reg, data, currentTime, activeNotes, cmdIndex, chip, instance) {
    const channel = Math.floor(reg / 2);
    const key = `${keyPrefix}_${channel}`;
    const state = host.channels.get(key);
    if (reg % 2 === 0)
        state.freqLSB = data;
    else
        state.freqMSB = data & 0x0F;
    const oldFreq = state.frequency;
    state.frequency = ((state.freqMSB || 0) << 8) | (state.freqLSB || 0);
    const otherReg = reg % 2 === 0 ? reg + 1 : reg - 1;
    const isSplitUpdate = host.isOPNMultiByteFreqUpdate(cmdIndex, chip, 0, otherReg, instance);
    if (state.active && !isSplitUpdate && state.frequency !== oldFreq) {
        (0, event_output_1.updateNotePitch)(host, key, 0, currentTime, activeNotes);
    }
}
function updateSSGVolume(host, keyPrefix, channel, data, currentTime, activeNotes) {
    const key = `${keyPrefix}_${channel}`;
    const state = host.channels.get(key);
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
        (0, event_output_1.addExpression)(host, key, expression, currentTime);
    }
    if (wasNoiseActive && state.isNoiseActive && oldVolume !== effectiveVolume) {
        (0, event_output_1.addExpression)(host, `${keyPrefix}_noise_${channel}`, expression, currentTime);
    }
}
function updateSSGMixer(host, keyPrefix, data, currentTime, activeNotes) {
    for (let channel = 0; channel < 3; channel++) {
        const state = host.channels.get(`${keyPrefix}_${channel}`);
        state.isToneEnabled = (data & (1 << channel)) === 0;
        state.isNoise = (data & (1 << (channel + 3))) === 0;
        syncSSGToneState(host, keyPrefix, channel, currentTime, activeNotes);
        syncSSGNoiseState(host, keyPrefix, channel, currentTime, activeNotes);
    }
}
function syncSSGToneState(host, keyPrefix, channel, currentTime, activeNotes) {
    const key = `${keyPrefix}_${channel}`;
    const state = host.channels.get(key);
    const shouldSound = state.isToneEnabled && state.volume > 0;
    if (shouldSound && !state.active) {
        state.active = true;
        (0, event_output_1.noteOn)(host, key, 0, currentTime, activeNotes);
    }
    else if (!shouldSound && state.active) {
        state.active = false;
        (0, event_output_1.noteOff)(host, key, 0, currentTime, activeNotes);
    }
}
function syncSSGNoiseState(host, keyPrefix, channel, currentTime, activeNotes) {
    const state = host.channels.get(`${keyPrefix}_${channel}`);
    const noiseKey = `${keyPrefix}_noise_${channel}`;
    const shouldSound = state.isNoise && state.volume > 0;
    if (shouldSound && !state.isNoiseActive) {
        state.isNoiseActive = true;
        (0, event_output_1.noteOnPercussion)(host, noiseKey, Math.round((state.volume / 15) * 100), currentTime, activeNotes, ssgNoiseNote(host, keyPrefix));
    }
    else if (!shouldSound && state.isNoiseActive) {
        state.isNoiseActive = false;
        (0, event_output_1.noteOff)(host, noiseKey, 0, currentTime, activeNotes);
    }
}
function retriggerSSGEnvelope(host, keyPrefix, currentTime, activeNotes) {
    for (let channel = 0; channel < 3; channel++) {
        const key = `${keyPrefix}_${channel}`;
        const state = host.channels.get(key);
        if (!state.isEnvelope)
            continue;
        if (state.active) {
            (0, event_output_1.noteOff)(host, key, 0, currentTime, activeNotes);
            (0, event_output_1.noteOn)(host, key, 0, currentTime, activeNotes);
        }
        if (state.isNoiseActive) {
            const noiseKey = `${keyPrefix}_noise_${channel}`;
            (0, event_output_1.noteOff)(host, noiseKey, 0, currentTime, activeNotes);
            (0, event_output_1.noteOnPercussion)(host, noiseKey, 100, currentTime, activeNotes, ssgNoiseNote(host, keyPrefix));
        }
    }
}
