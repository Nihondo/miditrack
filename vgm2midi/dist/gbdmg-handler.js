"use strict";
// MidiConverterから抽出した、Game Boy DMG（LR35902 APU）のレジスタ処理とフレーム
// シーケンサ。`host: MidiConverter`のper-conversion可変状態（channels/gbDmgFrameSteps等）を
// 直接読み書きする——詳細な設計判断はvgm2midi/CLAUDE.mdの「Refactor: event-output.ts」
// を参照。
Object.defineProperty(exports, "__esModule", { value: true });
exports.advanceGBDMGFrameSequencers = advanceGBDMGFrameSequencers;
exports.clockGBDMGFrameStep = clockGBDMGFrameStep;
exports.clockGBDMGLengths = clockGBDMGLengths;
exports.clockGBDMGSweep = clockGBDMGSweep;
exports.clockGBDMGEnvelopes = clockGBDMGEnvelopes;
exports.startGBDMGEnvelope = startGBDMGEnvelope;
exports.startGBDMGSweep = startGBDMGSweep;
exports.setGBDMGLength = setGBDMGLength;
exports.reloadGBDMGLength = reloadGBDMGLength;
exports.updateGBDMGPan = updateGBDMGPan;
exports.refreshGBDMGPans = refreshGBDMGPans;
exports.handleGBDMGWrite = handleGBDMGWrite;
exports.handleGBDMGSweepWrite = handleGBDMGSweepWrite;
exports.gbDmgEnvelopeDacEnabled = gbDmgEnvelopeDacEnabled;
exports.gbDmgEnvelopeVelocity = gbDmgEnvelopeVelocity;
exports.handleGBDMGEnvelopeWrite = handleGBDMGEnvelopeWrite;
exports.updateGBDMGFrequencyLSB = updateGBDMGFrequencyLSB;
exports.handleGBDMGTriggerWrite = handleGBDMGTriggerWrite;
exports.handleGBDMGWaveDACWrite = handleGBDMGWaveDACWrite;
exports.handleGBDMGWaveOutputLevelWrite = handleGBDMGWaveOutputLevelWrite;
exports.gbDmgWaveVelocity = gbDmgWaveVelocity;
exports.handleGBDMGNoiseEnvelopeWrite = handleGBDMGNoiseEnvelopeWrite;
exports.handleGBDMGNoiseFrequencyWrite = handleGBDMGNoiseFrequencyWrite;
exports.handleGBDMGNoiseTriggerWrite = handleGBDMGNoiseTriggerWrite;
exports.handleGBDMGMasterControlWrite = handleGBDMGMasterControlWrite;
const midi_converter_1 = require("./midi-converter");
const midi_math_1 = require("./midi-math");
const event_output_1 = require("./event-output");
/** VGMの絶対sample時刻まで、両方のDMG APUフレームシーケンサを進める。 */
function advanceGBDMGFrameSequencers(host, targetSamples, activeNotes) {
    for (let instance = 0; instance < 2; instance++) {
        while (host.gbDmgNextFrameSamples[instance] <= targetSamples) {
            const frameTime = host.gbDmgNextFrameSamples[instance];
            host.withChipInstance('GBDMG', instance, () => {
                clockGBDMGFrameStep(host, instance, frameTime, activeNotes);
            });
            host.gbDmgNextFrameSamples[instance] += midi_converter_1.GBDMG_FRAME_SAMPLES;
        }
    }
}
/** 512Hzの一段を実行し、長さ・sweep・envelopeの該当段だけをclockする。 */
function clockGBDMGFrameStep(host, instance, currentTime, activeNotes) {
    const step = host.gbDmgFrameSteps[instance];
    if ((step & 1) === 0)
        clockGBDMGLengths(host, currentTime, activeNotes);
    if (step === 2 || step === 6)
        clockGBDMGSweep(host, currentTime, activeNotes);
    if (step === 7)
        clockGBDMGEnvelopes(host, currentTime, activeNotes);
    host.gbDmgFrameSteps[instance] = (step + 1) & 7;
}
/** length-enableされた発音を256Hzで減算し、ゼロになった時点でMIDI Note Offにする。 */
function clockGBDMGLengths(host, currentTime, activeNotes) {
    for (const key of ['gbdmg_0', 'gbdmg_1', 'gbdmg_2', 'gbdmg_noise_0']) {
        const state = host.channels.get(key);
        if (!state.gbDmgLengthEnabled || !state.gbDmgLengthCounter)
            continue;
        state.gbDmgLengthCounter -= 1;
        if (state.gbDmgLengthCounter !== 0)
            continue;
        if (state.active)
            state.active = false;
        if (activeNotes.has(key))
            (0, event_output_1.noteOff)(host, key, 0, currentTime, activeNotes);
    }
}
/** Channel 1のNR10 sweepを128Hzで評価し、連続音程はpitch bendで表現する。 */
function clockGBDMGSweep(host, currentTime, activeNotes) {
    const state = host.channels.get('gbdmg_0');
    if (!state.gbDmgSweepEnabled)
        return;
    state.gbDmgSweepTimer = (state.gbDmgSweepTimer ?? 0) - 1;
    if ((state.gbDmgSweepTimer ?? 0) > 0)
        return;
    state.gbDmgSweepTimer = state.gbDmgSweepPeriod || 8;
    const shift = state.gbDmgSweepShift ?? 0;
    if (shift === 0)
        return;
    const shadow = state.gbDmgSweepShadow ?? state.frequency;
    const delta = shadow >> shift;
    const nextFrequency = state.gbDmgSweepNegate ? shadow - delta : shadow + delta;
    if (nextFrequency < 0 || nextFrequency > 0x7FF) {
        state.gbDmgSweepEnabled = false;
        state.active = false;
        (0, event_output_1.noteOff)(host, 'gbdmg_0', 0, currentTime, activeNotes);
        return;
    }
    state.gbDmgSweepShadow = nextFrequency;
    state.frequency = nextFrequency;
    state.freqLSB = nextFrequency & 0xFF;
    state.freqMSB = (nextFrequency >> 8) & 0x07;
    if (state.active)
        (0, event_output_1.updateNotePitch)(host, 'gbdmg_0', 0, currentTime, activeNotes);
}
/** 64HzのDMG envelopeをCC11へ変換する。 */
function clockGBDMGEnvelopes(host, currentTime, activeNotes) {
    for (const key of ['gbdmg_0', 'gbdmg_1', 'gbdmg_noise_0']) {
        const state = host.channels.get(key);
        const period = state.gbDmgEnvelopePeriod ?? 0;
        if (!state.active && !activeNotes.has(key))
            continue;
        if (period === 0)
            continue;
        state.gbDmgEnvelopeTimer = (state.gbDmgEnvelopeTimer ?? period) - 1;
        if ((state.gbDmgEnvelopeTimer ?? 0) > 0)
            continue;
        state.gbDmgEnvelopeTimer = period;
        const previous = state.gbDmgEnvelopeVolume ?? 0;
        const next = previous + (state.gbDmgEnvelopeIncrease ? 1 : -1);
        if (next < 0 || next > 15)
            continue;
        state.gbDmgEnvelopeVolume = next;
        (0, event_output_1.addExpression)(host, key, Math.round((next / 15) * 127), currentTime);
    }
}
/** NRx2の初期音量とenvelope timerを、ハードウェアtrigger時に再初期化する。 */
function startGBDMGEnvelope(state) {
    state.gbDmgEnvelopeVolume = (state.volume >> 4) & 0x0F;
    state.gbDmgEnvelopePeriod = state.volume & 0x07;
    state.gbDmgEnvelopeTimer = state.gbDmgEnvelopePeriod || 8;
    state.gbDmgEnvelopeIncrease = (state.volume & 0x08) !== 0;
}
/** Channel 1 trigger時にNR10 shadow/timerを初期化する。 */
function startGBDMGSweep(state) {
    state.gbDmgSweepShadow = state.frequency;
    state.gbDmgSweepTimer = state.gbDmgSweepPeriod || 8;
    state.gbDmgSweepEnabled = (state.gbDmgSweepPeriod ?? 0) !== 0 || (state.gbDmgSweepShift ?? 0) !== 0;
}
/** NRx1/NR31/NR41の長さロード値を保存する。 */
function setGBDMGLength(host, key, data, maximum) {
    const state = host.channels.get(key);
    state.gbDmgLengthCounter = maximum - (data & (maximum - 1));
}
/** trigger時に長さ0をハードウェア最大値へ再ロードする。 */
function reloadGBDMGLength(state, maximum) {
    if ((state.gbDmgLengthCounter ?? 0) === 0)
        state.gbDmgLengthCounter = maximum;
}
/** NR50/NR51から指定DMGチャンネルの左右出力を求め、CC10を送る。 */
function updateGBDMGPan(host, key, channel, currentTime) {
    const isRightRouted = (host.gbDmgStereoRouting & (1 << channel)) !== 0 && (host.gbDmgMasterVolume & 0x07) !== 0;
    const isLeftRouted = (host.gbDmgStereoRouting & (1 << (channel + 4))) !== 0 && ((host.gbDmgMasterVolume >> 4) & 0x07) !== 0;
    (0, event_output_1.addPan)(host, key, isLeftRouted, isRightRouted, currentTime);
}
/** NR50/NR51更新後、現在鳴っているDMG voiceだけを再panする。 */
function refreshGBDMGPans(host, currentTime) {
    for (const [key, channel] of [['gbdmg_0', 0], ['gbdmg_1', 1], ['gbdmg_2', 2], ['gbdmg_noise_0', 3]]) {
        if (host.channels.get(key).active)
            updateGBDMGPan(host, key, channel, currentTime);
    }
}
// VGM register numbers equal GameBoy address minus $FF10 (see GBDMG_SQUARE_KEYS'
// comment above).  Wave RAM ($20-$2F) is timbre data and intentionally not converted.
function handleGBDMGWrite(host, cmd, currentTime, activeNotes, cmdIndex) {
    if (cmd.register === undefined || cmd.data === undefined)
        return;
    const reg = cmd.register;
    const data = cmd.data;
    const instance = cmd.instance ?? 0;
    if (reg === 0x00) {
        handleGBDMGSweepWrite(host, data);
        return;
    }
    if (reg === 0x01) {
        setGBDMGLength(host, 'gbdmg_0', data, 64);
        return;
    }
    if (reg === 0x02) {
        handleGBDMGEnvelopeWrite(host, 'gbdmg_0', data, currentTime, activeNotes);
        return;
    }
    if (reg === 0x03) {
        updateGBDMGFrequencyLSB(host, 'gbdmg_0', 0x03, data, currentTime, activeNotes, cmdIndex, instance);
        return;
    }
    if (reg === 0x04) {
        handleGBDMGTriggerWrite(host, 'gbdmg_0', 0x04, data, currentTime, activeNotes, cmdIndex, instance);
        return;
    }
    if (reg === 0x06) {
        setGBDMGLength(host, 'gbdmg_1', data, 64);
        return;
    }
    if (reg === 0x07) {
        handleGBDMGEnvelopeWrite(host, 'gbdmg_1', data, currentTime, activeNotes);
        return;
    }
    if (reg === 0x08) {
        updateGBDMGFrequencyLSB(host, 'gbdmg_1', 0x08, data, currentTime, activeNotes, cmdIndex, instance);
        return;
    }
    if (reg === 0x09) {
        handleGBDMGTriggerWrite(host, 'gbdmg_1', 0x09, data, currentTime, activeNotes, cmdIndex, instance);
        return;
    }
    if (reg === 0x0A) {
        handleGBDMGWaveDACWrite(host, data, currentTime, activeNotes);
        return;
    }
    if (reg === 0x0B) {
        setGBDMGLength(host, 'gbdmg_2', data, 256);
        return;
    }
    if (reg === 0x0C) {
        handleGBDMGWaveOutputLevelWrite(host, data, currentTime);
        return;
    }
    if (reg === 0x0D) {
        updateGBDMGFrequencyLSB(host, 'gbdmg_2', 0x0D, data, currentTime, activeNotes, cmdIndex, instance);
        return;
    }
    if (reg === 0x0E) {
        handleGBDMGTriggerWrite(host, 'gbdmg_2', 0x0E, data, currentTime, activeNotes, cmdIndex, instance);
        return;
    }
    if (reg === 0x10) {
        setGBDMGLength(host, 'gbdmg_noise_0', data, 64);
        return;
    }
    if (reg === 0x11) {
        handleGBDMGNoiseEnvelopeWrite(host, data, currentTime, activeNotes);
        return;
    }
    if (reg === 0x12) {
        handleGBDMGNoiseFrequencyWrite(host, data, currentTime, activeNotes);
        return;
    }
    if (reg === 0x13) {
        handleGBDMGNoiseTriggerWrite(host, data, currentTime, activeNotes);
        return;
    }
    if (reg === 0x14) {
        host.gbDmgMasterVolume = data;
        refreshGBDMGPans(host, currentTime);
        return;
    }
    if (reg === 0x15) {
        host.gbDmgStereoRouting = data;
        refreshGBDMGPans(host, currentTime);
        return;
    }
    if (reg === 0x16)
        handleGBDMGMasterControlWrite(host, data, currentTime, activeNotes);
}
/** NR10のsweep設定をChannel 1へ保存し、次のtriggerから適用する。 */
function handleGBDMGSweepWrite(host, data) {
    const state = host.channels.get('gbdmg_0');
    state.gbDmgSweepPeriod = (data >> 4) & 0x07;
    state.gbDmgSweepNegate = (data & 0x08) !== 0;
    state.gbDmgSweepShift = data & 0x07;
}
// The DAC is enabled when the envelope register's upper 5 bits (initial volume + up/down
// direction) are not all zero — confirmed against Pan Docs. Only channels 1/2/4 (pulse
// and noise) read this from their envelope register; the wave channel (3) has a separate
// dedicated DAC-enable bit (NR30 bit7, tracked in `isEnabled` — see
// handleGBDMGWaveDACWrite()).
function gbDmgEnvelopeDacEnabled(rawEnvelope) {
    return (rawEnvelope & 0xF8) !== 0;
}
// 1-100 MIDI velocity from an envelope register's initial-volume nibble (0-15). Only the
// initial volume is read, at trigger time — the hardware's own automatic envelope ramp
// afterward is not replayed (see the "Deliberately not modeled" note above).
function gbDmgEnvelopeVelocity(rawEnvelope) {
    const initialVolume = (rawEnvelope >> 4) & 0x0F;
    return Math.max(1, Math.round((initialVolume / 15) * 100));
}
// Channels 1/2 (pulse) and 4 (noise) share this envelope-register shape (NR12/NR22/NR42):
// bits7-4=initial volume, bit3=direction, bits2-0=sweep pace (not modeled). A transition
// from DAC-enabled to DAC-disabled immediately silences the channel, matching real
// hardware (confirmed against Pan Docs).
function handleGBDMGEnvelopeWrite(host, key, data, currentTime, activeNotes) {
    const state = host.channels.get(key);
    const wasEnabled = gbDmgEnvelopeDacEnabled(state.volume);
    state.volume = data;
    if (!state.active)
        startGBDMGEnvelope(state);
    if (wasEnabled && !gbDmgEnvelopeDacEnabled(data) && state.active) {
        state.active = false;
        (0, event_output_1.noteOff)(host, key, 0, currentTime, activeNotes);
    }
}
function updateGBDMGFrequencyLSB(host, key, reg, data, currentTime, activeNotes, cmdIndex, instance) {
    const state = host.channels.get(key);
    const oldFrequency = state.frequency;
    state.freqLSB = data;
    state.frequency = ((state.freqMSB ?? 0) << 8) | (state.freqLSB ?? 0);
    const otherReg = reg + 1; // the paired NRx4 trigger/MSB register
    const isSplitUpdate = host.isOPNMultiByteFreqUpdate(cmdIndex, 'GBDMG', 0, otherReg, instance);
    const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
    state.hasPendingFrequencyUpdate = isSplitUpdate;
    if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
        (0, event_output_1.updateNotePitch)(host, key, 0, currentTime, activeNotes);
    }
}
// NRx4 (the paired trigger/frequency-MSB register for channels 1/2/3): bit7=trigger
// (restart the voice), bit6=length enable (not modeled), bits2-0=frequency MSB. A
// trigger while the channel's DAC is enabled retriggers (closing any note already
// sounding first, the same pattern used elsewhere in this file for hardware "always
// restarts on write" triggers, e.g. YM2608 rhythm and SegaPCM/C140); a trigger while the
// DAC is disabled produces no sound, matching real hardware.
function handleGBDMGTriggerWrite(host, key, reg, data, currentTime, activeNotes, cmdIndex, instance) {
    const state = host.channels.get(key);
    const oldFrequency = state.frequency;
    state.freqMSB = data & 0x07;
    state.frequency = ((state.freqMSB ?? 0) << 8) | (state.freqLSB ?? 0);
    const otherReg = reg - 1; // the paired NRx3 frequency-LSB register
    const isSplitUpdate = host.isOPNMultiByteFreqUpdate(cmdIndex, 'GBDMG', 0, otherReg, instance);
    const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
    state.hasPendingFrequencyUpdate = isSplitUpdate;
    const isTrigger = (data & 0x80) !== 0;
    state.gbDmgLengthEnabled = (data & 0x40) !== 0;
    const isDacEnabled = key === 'gbdmg_2' ? (state.isEnabled ?? false) : gbDmgEnvelopeDacEnabled(state.volume);
    if (isTrigger) {
        reloadGBDMGLength(state, key === 'gbdmg_2' ? 256 : 64);
        if (key !== 'gbdmg_2')
            startGBDMGEnvelope(state);
        if (key === 'gbdmg_0')
            startGBDMGSweep(state);
        if (state.active) {
            state.active = false;
            (0, event_output_1.noteOff)(host, key, 0, currentTime, activeNotes);
        }
        if (isDacEnabled) {
            state.opnActiveVelocity = key === 'gbdmg_2'
                ? gbDmgWaveVelocity(state.volume)
                : gbDmgEnvelopeVelocity(state.volume);
            state.active = true;
            updateGBDMGPan(host, key, key === 'gbdmg_0' ? 0 : key === 'gbdmg_1' ? 1 : 2, currentTime);
            (0, event_output_1.noteOn)(host, key, 0, currentTime, activeNotes);
        }
    }
    else if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
        (0, event_output_1.updateNotePitch)(host, key, 0, currentTime, activeNotes);
    }
}
// NR30 (wave channel DAC enable, bit7). Distinct from the pulse/noise channels' envelope-
// derived DAC state — the wave channel has no envelope of its own; NR32 controls its
// fixed output level instead (see handleGBDMGWaveOutputLevelWrite()).
function handleGBDMGWaveDACWrite(host, data, currentTime, activeNotes) {
    const key = 'gbdmg_2';
    const state = host.channels.get(key);
    const wasEnabled = state.isEnabled ?? false;
    state.isEnabled = (data & 0x80) !== 0;
    if (wasEnabled && !state.isEnabled && state.active) {
        state.active = false;
        (0, event_output_1.noteOff)(host, key, 0, currentTime, activeNotes);
    }
}
// NR32 bits6-5: 0=mute, 1=100%, 2=50%, 3=25% output level. Stored directly in
// `state.volume` (a 2-bit code, not a raw envelope byte, unlike the other channels) and
// read back by gbDmgWaveVelocity(); reflected as expression on an already-sounding note
// the same way YM2608's rhythm section resends volume changes.
function handleGBDMGWaveOutputLevelWrite(host, data, currentTime) {
    const key = 'gbdmg_2';
    const state = host.channels.get(key);
    state.volume = (data >> 5) & 0x03;
    if (state.active) {
        const expression = Math.round((gbDmgWaveVelocity(state.volume) / 100) * 127);
        (0, event_output_1.addExpression)(host, key, expression, currentTime);
    }
}
function gbDmgWaveVelocity(outputLevelCode) {
    const percent = [0, 100, 50, 25][outputLevelCode] ?? 0;
    return Math.max(1, Math.round(percent));
}
function handleGBDMGNoiseEnvelopeWrite(host, data, currentTime, activeNotes) {
    const key = 'gbdmg_noise_0';
    const state = host.channels.get(key);
    const wasEnabled = gbDmgEnvelopeDacEnabled(state.volume);
    state.volume = data;
    if (!activeNotes.has(key))
        startGBDMGEnvelope(state);
    if (wasEnabled && !gbDmgEnvelopeDacEnabled(data) && activeNotes.has(key)) {
        (0, event_output_1.noteOff)(host, key, 0, currentTime, activeNotes);
    }
}
// NR43: re-evaluates an already-sounding noise voice's GM drum band the same way
// SN76489/AY-SSG/HuC6280/YM2151 do — retriggering only if the mapped note actually
// changed, so a rate sweep that stays inside one band doesn't machine-gun notes.
function handleGBDMGNoiseFrequencyWrite(host, data, currentTime, activeNotes) {
    const key = 'gbdmg_noise_0';
    const state = host.channels.get(key);
    const oldNoisePeriod = state.noisePeriod ?? 0;
    state.noisePeriod = data;
    if (!activeNotes.has(key))
        return;
    const clockRate = host.vgmData.header.gbDmgClock;
    const oldNote = (0, midi_math_1.gbDmgNoiseNoteForPeriod)(oldNoisePeriod, clockRate);
    const newNote = (0, midi_math_1.gbDmgNoiseNoteForPeriod)(data, clockRate);
    if (oldNote === newNote)
        return;
    (0, event_output_1.noteOff)(host, key, 0, currentTime, activeNotes);
    (0, event_output_1.noteOnPercussion)(host, key, gbDmgEnvelopeVelocity(state.volume), currentTime, activeNotes, newNote);
}
// NR44: bit7=trigger, bit6=length enable (not modeled). Same retrigger-on-write pattern
// as the melodic channels' NRx4 registers.
function handleGBDMGNoiseTriggerWrite(host, data, currentTime, activeNotes) {
    const key = 'gbdmg_noise_0';
    const state = host.channels.get(key);
    state.gbDmgLengthEnabled = (data & 0x40) !== 0;
    if ((data & 0x80) === 0)
        return;
    reloadGBDMGLength(state, 64);
    startGBDMGEnvelope(state);
    if (activeNotes.has(key))
        (0, event_output_1.noteOff)(host, key, 0, currentTime, activeNotes);
    if (gbDmgEnvelopeDacEnabled(state.volume)) {
        const note = (0, midi_math_1.gbDmgNoiseNoteForPeriod)(state.noisePeriod ?? 0, host.vgmData.header.gbDmgClock);
        updateGBDMGPan(host, key, 3, currentTime);
        (0, event_output_1.noteOnPercussion)(host, key, gbDmgEnvelopeVelocity(state.volume), currentTime, activeNotes, note);
    }
}
// NR52 bit7=0 powers off the entire APU, immediately silencing every channel — the same
// "power off" semantics used for e.g. YM2612's $2B DAC-disable elsewhere in this file.
// Powering back on (bit7=1) does not by itself resume sound; a channel needs a fresh
// trigger, matching real hardware.
function handleGBDMGMasterControlWrite(host, data, currentTime, activeNotes) {
    if ((data & 0x80) !== 0)
        return;
    for (const key of ['gbdmg_0', 'gbdmg_1', 'gbdmg_2']) {
        const state = host.channels.get(key);
        if (state.active) {
            state.active = false;
            (0, event_output_1.noteOff)(host, key, 0, currentTime, activeNotes);
        }
    }
    const noiseKey = 'gbdmg_noise_0';
    if (activeNotes.has(noiseKey))
        (0, event_output_1.noteOff)(host, noiseKey, 0, currentTime, activeNotes);
}
