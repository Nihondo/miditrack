"use strict";
// MidiConverterから抽出した、HuC6280（PC Engine/TurboGrafx-16 PSG）のレジスタ処理。
// `host: MidiConverter`のper-conversion可変状態（channels/huc6280SelectedChannels等）を
// 直接読み書きする——詳細な設計判断はvgm2midi/CLAUDE.mdの「Refactor: event-output.ts」
// を参照。
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleHuC6280Write = handleHuC6280Write;
exports.updateHuC6280Pan = updateHuC6280Pan;
exports.syncHuC6280ToneState = syncHuC6280ToneState;
exports.syncHuC6280NoiseState = syncHuC6280NoiseState;
exports.updateHuC6280NoiseEnvelope = updateHuC6280NoiseEnvelope;
exports.noteOnHuC6280Noise = noteOnHuC6280Noise;
exports.huc6280NoiseNoteForPeriod = huc6280NoiseNoteForPeriod;
exports.addHuC6280Expression = addHuC6280Expression;
exports.isHuC6280MultiByteFreqUpdate = isHuC6280MultiByteFreqUpdate;
const midi_math_1 = require("../midi-math");
const event_output_1 = require("../event-output");
const HUC6280_NOISE_RETRIGGER_MIN_VOLUME_RISE = 4;
// Some HuC6280 drivers split the two frequency bytes across adjacent 50/60Hz updates.
// Coalescing up to one 50Hz VGM frame avoids thousands of false MIDI note attacks, while
// still preventing an unrelated write seconds later from being mistaken for the pair.
const HUC6280_SPLIT_FREQUENCY_MAX_GAP_SAMPLES = 882;
function handleHuC6280Write(host, cmd, currentTime, activeNotes, cmdIndex) {
    if (cmd.register === undefined || cmd.data === undefined)
        return;
    const instance = cmd.instance === 1 ? 1 : 0;
    const reg = cmd.register;
    const data = cmd.data;
    // Register $00: channel select (0-5). Every subsequent register write until the
    // next $00 targets whichever channel was selected here.
    if (reg === 0x00) {
        host.huc6280SelectedChannels[instance] = data & 0x07;
        return;
    }
    if (reg === 0x01) {
        host.huc6280GlobalBalance[instance] = data;
        for (let index = 0; index < 6; index += 1)
            updateHuC6280Pan(host, instance, index, currentTime);
        return;
    }
    const channel = host.huc6280SelectedChannels[instance];
    if (channel > 5)
        return; // Only 6 channels (0-5) exist on the real chip
    const key = `huc6280_${instance}_${channel}`;
    const state = host.channels.get(key);
    if (reg === 0x02) {
        // Frequency (low 8 bits). $02/$03 are always written as a pair, so peek ahead
        // for the matching $03 write before reacting — otherwise every frequency change
        // briefly passes through a bogus intermediate value (new LSB + stale MSB) and
        // retriggers a spurious note, the same problem handlePSGWrite() already guards
        // against for SN76489's split tone-frequency writes.
        const oldFreq = state.frequency;
        state.freqLSB = data;
        state.frequency = ((state.freqMSB || 0) << 8) | (state.freqLSB || 0);
        if (state.active && state.frequency !== oldFreq && !isHuC6280MultiByteFreqUpdate(host, cmdIndex, 0x03, instance)) {
            (0, event_output_1.updateNotePitch)(host, key, channel, currentTime, activeNotes);
        }
    }
    else if (reg === 0x03) {
        // Frequency (high 4 bits) - same split-write guard as $02 above.
        const oldFreq = state.frequency;
        state.freqMSB = data & 0x0F;
        state.frequency = ((state.freqMSB || 0) << 8) | (state.freqLSB || 0);
        if (state.active && state.frequency !== oldFreq && !isHuC6280MultiByteFreqUpdate(host, cmdIndex, 0x02, instance)) {
            (0, event_output_1.updateNotePitch)(host, key, channel, currentTime, activeNotes);
        }
    }
    else if (reg === 0x04) {
        // Channel control: bit7 = enable, bit6 = Direct D/A mode,
        // bits0-4 = volume (0=silent, 31=loudest).
        const enable = (data & 0x80) !== 0;
        const isDDA = (data & 0x40) !== 0;
        const volume = data & 0x1F;
        const wasActive = state.active;
        const wasNoiseActive = state.isNoiseActive;
        const oldVolume = state.volume;
        state.volume = volume;
        state.isEnabled = enable;
        state.isDDA = isDDA;
        syncHuC6280ToneState(host, key, channel, currentTime, activeNotes);
        syncHuC6280NoiseState(host, key, channel, currentTime, activeNotes);
        if (wasActive && state.active && oldVolume !== volume) {
            addHuC6280Expression(host, key, volume, currentTime);
        }
        if (wasNoiseActive && state.isNoiseActive) {
            updateHuC6280NoiseEnvelope(host, key, channel, oldVolume, currentTime, activeNotes);
        }
    }
    else if (reg === 0x07 && channel >= 4) {
        // Noise control (channels 4-5 only). MIDI has no synthesized-noise
        // equivalent, so emit its rhythm on the GM percussion channel instead.
        const oldNoisePeriod = state.noisePeriod;
        const wasNoiseActive = state.isNoiseActive;
        state.isNoise = (data & 0x80) !== 0;
        state.noisePeriod = data & 0x1F;
        syncHuC6280ToneState(host, key, channel, currentTime, activeNotes);
        syncHuC6280NoiseState(host, key, channel, currentTime, activeNotes);
        // Only re-evaluate a rate change on a channel that was already sounding noise
        // before and after this write — syncHuC6280NoiseState() above already handles a
        // fresh on/off transition, so this only covers "still active, rate moved to a
        // different drum band" without double-triggering a note that was just started.
        if (wasNoiseActive
            && state.isNoiseActive
            && oldNoisePeriod !== undefined
            && huc6280NoiseNoteForPeriod(state.noisePeriod) !== huc6280NoiseNoteForPeriod(oldNoisePeriod)) {
            const noiseKey = `huc6280_${instance}_noise_${channel}`;
            (0, event_output_1.noteOff)(host, noiseKey, channel, currentTime, activeNotes);
            noteOnHuC6280Noise(host, noiseKey, state, currentTime, activeNotes);
        }
    }
    else if (reg === 0x05) {
        state.balance = data;
        updateHuC6280Pan(host, instance, channel, currentTime);
    }
}
function updateHuC6280Pan(host, instance, channel, currentTime) {
    const key = `huc6280_${instance}_${channel}`;
    const local = host.channels.get(key)?.balance ?? 0xFF;
    const global = host.huc6280GlobalBalance[instance];
    const hasLeft = ((local >> 4) & 0x0F) > 0 && ((global >> 4) & 0x0F) > 0;
    const hasRight = (local & 0x0F) > 0 && (global & 0x0F) > 0;
    (0, event_output_1.addPan)(host, key, hasLeft, hasRight, currentTime);
}
function syncHuC6280ToneState(host, key, channel, currentTime, activeNotes) {
    const state = host.channels.get(key);
    const shouldSound = state.isEnabled && !state.isDDA && !state.isNoise && state.volume > 0;
    if (shouldSound && !state.active) {
        state.active = true;
        (0, event_output_1.noteOn)(host, key, channel, currentTime, activeNotes);
    }
    else if (!shouldSound && state.active) {
        state.active = false;
        (0, event_output_1.noteOff)(host, key, channel, currentTime, activeNotes);
    }
}
function syncHuC6280NoiseState(host, key, channel, currentTime, activeNotes) {
    const state = host.channels.get(key);
    if (host.options.suppressHardwareNoise)
        return;
    const instance = parseInt(key.split('_')[1]);
    const noiseKey = `huc6280_${instance}_noise_${channel}`;
    const shouldSound = state.isEnabled && !state.isDDA && state.isNoise && state.volume > 0;
    if (shouldSound && !state.isNoiseActive) {
        state.isNoiseActive = true;
        noteOnHuC6280Noise(host, noiseKey, state, currentTime, activeNotes);
    }
    else if (!shouldSound && state.isNoiseActive) {
        state.isNoiseActive = false;
        (0, event_output_1.noteOff)(host, noiseKey, channel, currentTime, activeNotes);
    }
}
function updateHuC6280NoiseEnvelope(host, key, channel, oldVolume, currentTime, activeNotes) {
    const state = host.channels.get(key);
    if (state.volume === oldVolume)
        return;
    if (host.options.suppressHardwareNoise)
        return;
    const instance = parseInt(key.split('_')[1]);
    const noiseKey = `huc6280_${instance}_noise_${channel}`;
    const volumeRise = state.volume - oldVolume;
    if (volumeRise >= HUC6280_NOISE_RETRIGGER_MIN_VOLUME_RISE) {
        (0, event_output_1.noteOff)(host, noiseKey, channel, currentTime, activeNotes);
        noteOnHuC6280Noise(host, noiseKey, state, currentTime, activeNotes);
    }
    else {
        addHuC6280Expression(host, noiseKey, state.volume, currentTime);
    }
}
function noteOnHuC6280Noise(host, key, state, currentTime, activeNotes) {
    const velocity = Math.max(1, Math.round((state.volume / 31) * 100));
    (0, event_output_1.noteOnPercussion)(host, key, velocity, currentTime, activeNotes, huc6280NoiseNoteForPeriod(state.noisePeriod ?? 0));
}
// Confirmed against MAME's c6280.cpp: step = (value & 0x1F) ^ 0x1F, noise_counter =
// step << 6 — a larger raw register value produces a smaller step/counter, so the LFSR
// updates more often and the noise pitch is HIGHER. (Opposite direction from YM2151's
// NFRQ below.)
function huc6280NoiseNoteForPeriod(rawValue) {
    const normalizedRate = (rawValue & 0x1F) / 31;
    return (0, midi_math_1.noiseDrumNote)(normalizedRate, false);
}
function addHuC6280Expression(host, key, volume, currentTime) {
    (0, event_output_1.addExpression)(host, key, Math.round((volume / 31) * 127), currentTime);
}
// Looks ahead through at most one 50Hz frame for the other half of a split frequency
// update. Some HuC6280 drivers intentionally distribute the two bytes across frames.
function isHuC6280MultiByteFreqUpdate(host, cmdIndex, otherReg, instance) {
    let skippedSamples = 0;
    for (let k = cmdIndex + 1; k < host.vgmData.commands.length; k++) {
        const next = host.vgmData.commands[k];
        if (next.type === 'wait') {
            skippedSamples += next.samples ?? 0;
            if (skippedSamples > HUC6280_SPLIT_FREQUENCY_MAX_GAP_SAMPLES)
                return false;
            continue;
        }
        return next.type === 'chip_write'
            && next.chip === 'HuC6280'
            && (next.instance ?? 0) === instance
            && next.register === otherReg;
    }
    return false;
}
