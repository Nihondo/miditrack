"use strict";
// MidiConverterから抽出した、YM2151（OPM）FM・ノイズ・CSM Timer Aのレジスタ処理。
// `host: MidiConverter`のper-conversion可変状態（channels等）を直接読み書きする——
// 詳細な設計判断はvgm2midi/CLAUDE.mdの「Refactor: event-output.ts」を参照。
// `opmCsmTimer()`/`opmCsmPeriodSamples()`/`emitOPMCsmPulse()`はOPN系とも共有する
// CSM Timer A進行機構（advanceCSMTimers()）から直接呼ばれるため、`opnCarrierVelocity()`/
// `opnCarrierExpression()`/`recordFMTimbreEvent()`/`updateKeyBoundFMPitch()`と合わせて
// MidiConverter側に残したまま`host.`経由で呼ぶ。
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateOPMCsmTimerRegister = updateOPMCsmTimerRegister;
exports.updateOPMCsmTimer = updateOPMCsmTimer;
exports.handleYM2151Write = handleYM2151Write;
exports.syncYM2151ToneState = syncYM2151ToneState;
exports.syncYM2151NoiseState = syncYM2151NoiseState;
exports.ym2151NoiseNoteForPeriod = ym2151NoiseNoteForPeriod;
const midi_converter_1 = require("../midi-converter");
const midi_math_1 = require("../midi-math");
const event_output_1 = require("../event-output");
// YM2151's raw $08 bits 3-6 are ordered M1/C1/M2/C2, which is the logical
// algorithm order used by OPN_OPERATOR_PATHS.  Its per-operator register groups however
// are ordered M1/M2/C1/C2 ($60/$68/$70/$78).  MAME ymfm's OPM operator map
// (operator_list(0,16,8,24)) performs the same physical-slot permutation.
const YM2151_LOGICAL_OPERATOR_BY_REGISTER_SLOT = [0, 2, 1, 3];
const YM2151_C2_OPERATOR_MASK = 1 << 3;
/** OPM Timer Aの値をCSM schedulerへ反映する。 */
function updateOPMCsmTimerRegister(host, instance, register, data) {
    const timer = host.opmCsmTimer(instance);
    if (register === 0x10)
        timer.timerHigh = data;
    else
        timer.timerLow = data & 0x03;
}
/** OPM $14のCSM有効状態とTimer Aの開始状態を更新する。 */
function updateOPMCsmTimer(host, instance, data, currentTime, activeNotes) {
    const timer = host.opmCsmTimer(instance);
    const wasActive = timer.isRunning && timer.isCSMEnabled;
    timer.isRunning = (data & 0x01) !== 0;
    timer.isCSMEnabled = (data & 0x80) !== 0;
    const isActive = timer.isRunning && timer.isCSMEnabled;
    if (!isActive) {
        if (timer.nextRelease !== undefined)
            host.emitOPMCsmPulse(instance, false, currentTime, activeNotes);
        timer.nextOverflow = undefined;
        timer.nextRelease = undefined;
        return;
    }
    if (!wasActive) {
        timer.nextOverflow = currentTime + host.opmCsmPeriodSamples(timer);
        timer.nextRelease = undefined;
        timer.lastEmittedTick = undefined;
    }
}
function handleYM2151Write(host, cmd, currentTime, activeNotes) {
    if (cmd.register === undefined || cmd.data === undefined)
        return;
    const reg = cmd.register;
    const data = cmd.data;
    if (reg === 0x10 || reg === 0x11) {
        updateOPMCsmTimerRegister(host, cmd.instance ?? 0, reg, data);
        return;
    }
    if (reg === 0x14) {
        updateOPMCsmTimer(host, cmd.instance ?? 0, data, currentTime, activeNotes);
        return;
    }
    // $20-$27: RL pan bits plus algorithm/feedback. OPM stores each channel's
    // pan in the same register, so emit a portable CC10 state change.
    if (reg >= 0x20 && reg <= 0x27) {
        const key = `ym2151_${reg - 0x20}`;
        (0, event_output_1.addPan)(host, key, (data & 0x80) !== 0, (data & 0x40) !== 0, currentTime);
        const state = host.channels.get(key);
        state.opnAlgorithm = data & 0x07;
        host.recordFMTimbreEvent(key, currentTime, 'opm-timbre');
        return;
    }
    // $40-$5f stores DT1 and MULTIPLE, arranged as four 8-register channel groups.
    // The sidecar preserves the MULTIPLE nibble for later timbre reconstruction; MIDI
    // itself only uses the existing key-code/fraction pitch representation for OPM.
    if (reg >= 0x40 && reg <= 0x5F) {
        const registerSlot = Math.floor((reg - 0x40) / 8);
        const logicalOperator = YM2151_LOGICAL_OPERATOR_BY_REGISTER_SLOT[registerSlot];
        const channel = (reg - 0x40) & 0x07;
        const key = `ym2151_${channel}`;
        const state = host.channels.get(key);
        state.opnOperatorMultipliers ?? (state.opnOperatorMultipliers = [0, 0, 0, 0]);
        state.opnOperatorMultiplierWritten ?? (state.opnOperatorMultiplierWritten = [false, false, false, false]);
        state.opnOperatorMultipliers[logicalOperator] = data & 0x0F;
        state.opnOperatorMultiplierWritten[logicalOperator] = true;
        host.recordFMTimbreEvent(key, currentTime, 'opm-timbre');
        return;
    }
    // $60-$7f is operator TL, arranged as four 8-register channel groups.
    if (reg >= 0x60 && reg <= 0x7F) {
        const registerSlot = Math.floor((reg - 0x60) / 8);
        const logicalOperator = YM2151_LOGICAL_OPERATOR_BY_REGISTER_SLOT[registerSlot];
        const channel = (reg - 0x60) & 0x07;
        const state = host.channels.get(`ym2151_${channel}`);
        state.opnOperatorTotalLevels ?? (state.opnOperatorTotalLevels = [0, 0, 0, 0]);
        state.opnOperatorTotalLevels[logicalOperator] = data & 0x7F;
        if (state.active) {
            (0, event_output_1.addExpression)(host, `ym2151_${channel}`, host.opnCarrierExpression(state), currentTime);
        }
        host.recordFMTimbreEvent(`ym2151_${channel}`, currentTime, 'opm-timbre');
        return;
    }
    // Register $0F: bit7 enables noise on channel 7; bits0-4 (NFRQ) select its frequency.
    if (reg === 0x0F) {
        const state = host.channels.get('ym2151_7');
        const oldNoisePeriod = state.noisePeriod;
        const wasNoiseActive = state.isNoiseActive;
        state.isNoise = (data & 0x80) !== 0;
        state.noisePeriod = data & 0x1F;
        syncYM2151ToneState(host, 7, false, currentTime, activeNotes);
        syncYM2151NoiseState(host, false, currentTime, activeNotes);
        // Same "still active, rate moved to a different drum band" re-evaluation as
        // HuC6280's $07 handler — syncYM2151NoiseState() above already handles a fresh
        // on/off transition, this only covers NFRQ changing without a mode change.
        if (wasNoiseActive
            && state.isNoiseActive
            && oldNoisePeriod !== undefined
            && ym2151NoiseNoteForPeriod(state.noisePeriod) !== ym2151NoiseNoteForPeriod(oldNoisePeriod)) {
            const noiseKey = 'ym2151_noise_7';
            (0, event_output_1.noteOff)(host, noiseKey, 7, currentTime, activeNotes);
            (0, event_output_1.noteOnPercussion)(host, noiseKey, 80, currentTime, activeNotes, ym2151NoiseNoteForPeriod(state.noisePeriod));
        }
        return;
    }
    // Register $08: bits 0-2 select the channel and bits 3-6 key its four operators.
    if (reg === 0x08) {
        const channel = data & 0x07;
        const key = `ym2151_${channel}`;
        const state = host.channels.get(key);
        const timer = host.opmCsmTimer(cmd.instance ?? 0);
        timer.manualKeyOnMasks ?? (timer.manualKeyOnMasks = new Array(8).fill(0));
        timer.manualKeyOnMasks[channel] = (data >> 3) & 0x0F;
        const csmMask = timer.nextRelease === undefined ? 0 : 0x0F;
        state.keyOnMask = timer.manualKeyOnMasks[channel] | csmMask;
        // A repeated key-on retriggers the YM2151 envelope, so mirror that onset in MIDI.
        syncYM2151ToneState(host, channel, true, currentTime, activeNotes);
        if (channel === 7)
            syncYM2151NoiseState(host, true, currentTime, activeNotes);
        return;
    }
    // Registers $28-$2F: octave/key code; $30-$37: 1/64-semitone key fraction.
    if (reg >= 0x28 && reg <= 0x2F) {
        const channel = reg - 0x28;
        const key = `ym2151_${channel}`;
        const state = host.channels.get(key);
        const oldKeyCode = state.keyCode;
        state.keyCode = data & 0x7F;
        if (state.active && state.keyCode !== oldKeyCode) {
            host.updateKeyBoundFMPitch(key, currentTime, activeNotes, midi_converter_1.YM2151_FM_PITCH_BEND_RANGE);
        }
    }
    else if (reg >= 0x30 && reg <= 0x37) {
        const channel = reg - 0x30;
        const key = `ym2151_${channel}`;
        const state = host.channels.get(key);
        const oldKeyFraction = state.keyFraction;
        state.keyFraction = (data >> 2) & 0x3F;
        if (state.active && state.keyFraction !== oldKeyFraction) {
            host.updateKeyBoundFMPitch(key, currentTime, activeNotes, midi_converter_1.YM2151_FM_PITCH_BEND_RANGE);
        }
    }
}
function syncYM2151ToneState(host, channel, shouldRetrigger, currentTime, activeNotes) {
    const key = `ym2151_${channel}`;
    const state = host.channels.get(key);
    const noiseOperatorMask = channel === 7 && state.isNoise ? YM2151_C2_OPERATOR_MASK : 0;
    const shouldSound = ((state.keyOnMask || 0) & ~noiseOperatorMask) !== 0;
    if (shouldSound && (!state.active || shouldRetrigger)) {
        if (state.active)
            (0, event_output_1.noteOff)(host, key, channel, currentTime, activeNotes);
        state.active = true;
        state.opnActiveVelocity = host.opnCarrierVelocity(state);
        (0, event_output_1.noteOn)(host, key, channel, currentTime, activeNotes);
    }
    else if (!shouldSound && state.active) {
        state.active = false;
        (0, event_output_1.noteOff)(host, key, channel, currentTime, activeNotes);
    }
}
function syncYM2151NoiseState(host, shouldRetrigger, currentTime, activeNotes) {
    const state = host.channels.get('ym2151_7');
    const noiseKey = 'ym2151_noise_7';
    const shouldSound = state.isNoise && ((state.keyOnMask || 0) & YM2151_C2_OPERATOR_MASK) !== 0;
    if (shouldSound && (!state.isNoiseActive || shouldRetrigger)) {
        if (state.isNoiseActive)
            (0, event_output_1.noteOff)(host, noiseKey, 7, currentTime, activeNotes);
        state.isNoiseActive = true;
        (0, event_output_1.noteOnPercussion)(host, noiseKey, 80, currentTime, activeNotes, ym2151NoiseNoteForPeriod(state.noisePeriod ?? 0));
    }
    else if (!shouldSound && state.isNoiseActive) {
        state.isNoiseActive = false;
        (0, event_output_1.noteOff)(host, noiseKey, 7, currentTime, activeNotes);
    }
}
// Confirmed against ymfm_opm.cpp: the noise LFSR advances when a counter that
// increments every sample reaches the NFRQ-derived threshold (`m_noise_counter++ >=
// freq`). A LARGER NFRQ raises that threshold, so the counter takes longer to reach it
// and the noise updates LESS often — pitch is LOWER. (Opposite direction from
// HuC6280's $07.)
function ym2151NoiseNoteForPeriod(nfrq) {
    const normalizedRate = (31 - (nfrq & 0x1F)) / 31;
    return (0, midi_math_1.noiseDrumNote)(normalizedRate, false);
}
