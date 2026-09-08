"use strict";
// MidiConverterから抽出した、SN76489（PSG）とGame Gearステレオ拡張のレジスタ処理。
// `host: MidiConverter`のper-conversion可変状態（channels/lastLatchedChannel等）を
// 直接読み書きする——詳細な設計判断はvgm2midi/CLAUDE.mdの「Refactor: event-output.ts」
// を参照。
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleGameGearStereo = handleGameGearStereo;
exports.handlePSGWrite = handlePSGWrite;
exports.handleSN76489NoiseControl = handleSN76489NoiseControl;
exports.syncSN76489NoiseVolume = syncSN76489NoiseVolume;
exports.sn76489Velocity = sn76489Velocity;
exports.sn76489Expression = sn76489Expression;
exports.sn76489NoiseNote = sn76489NoiseNote;
exports.reevaluateSN76489NoiseForChannel2Frequency = reevaluateSN76489NoiseForChannel2Frequency;
const midi_writer_js_1 = __importDefault(require("midi-writer-js"));
const midi_math_1 = require("../midi-math");
const event_output_1 = require("../event-output");
/** Game Gear $4F のLRルーティングをSN76489各voiceのCC10へ反映する。 */
function handleGameGearStereo(host, data, currentTime) {
    host.gameGearStereo = data;
    for (let channel = 0; channel < 4; channel++) {
        (0, event_output_1.addPan)(host, `psg_${channel}`, (data & (1 << channel)) !== 0, (data & (1 << (channel + 4))) !== 0, currentTime);
    }
}
function handlePSGWrite(host, data, currentTime, activeNotes, cmdIndex) {
    if ((data & 0x80) === 0x80) {
        // Latch/Data byte
        const channel = (data >> 5) & 0x03;
        const type = (data >> 4) & 0x01;
        const nibble = data & 0x0F;
        host.lastLatchedChannel = channel;
        if (type === 0) {
            // Tone register - lower 4 bits
            if (channel < 3) {
                const key = `psg_${channel}`;
                const state = host.channels.get(key);
                const oldFreq = state.frequency;
                // Peek ahead check for split-byte updates
                let isMultiByteUpdate = false;
                for (let k = cmdIndex + 1; k < host.vgmData.commands.length; k++) {
                    const next = host.vgmData.commands[k];
                    if (next.type === 'wait')
                        continue;
                    if (next.type === 'psg_write' && next.data !== undefined) {
                        if ((next.data & 0x80) === 0) {
                            isMultiByteUpdate = true;
                        }
                        break;
                    }
                    else {
                        break;
                    }
                }
                // Keep upper 6 bits, set lower 4 bits
                state.frequency = (state.frequency & 0x3F0) | nibble;
                if (state.frequency !== oldFreq && !isMultiByteUpdate) {
                    if (state.active) {
                        (0, event_output_1.updateNotePitch)(host, key, channel, currentTime, activeNotes);
                    }
                    // NF=3 makes the noise generator track this channel's own tone frequency, so
                    // a change here can move the noise's effective pitch even if this channel's
                    // own tone isn't currently active.
                    if (channel === 2) {
                        reevaluateSN76489NoiseForChannel2Frequency(host, currentTime, activeNotes);
                    }
                }
            }
            else {
                handleSN76489NoiseControl(host, nibble, currentTime, activeNotes);
            }
        }
        else {
            // Volume register
            const key = `psg_${channel}`;
            const state = host.channels.get(key);
            const oldVolume = state.volume;
            state.volume = nibble;
            if (channel < 3) {
                const wasOff = oldVolume === 0x0F;
                const isOff = nibble === 0x0F;
                if (wasOff && !isOff) {
                    // Note ON
                    state.active = true;
                    (0, event_output_1.noteOn)(host, key, channel, currentTime, activeNotes);
                }
                else if (!wasOff && isOff) {
                    // Note OFF
                    state.active = false;
                    (0, event_output_1.noteOff)(host, key, channel, currentTime, activeNotes);
                }
                else if (!isOff && state.active && oldVolume !== nibble) {
                    // Volume change while active -> Send Expression (CC 11)
                    const expression = Math.max(0, Math.min(127, 127 - (state.volume * 8)));
                    const trackState = host.getTrack(key);
                    const currentTick = (0, midi_math_1.samplesToTicks)(currentTime, host.options.tempo, host.sampleRate);
                    const gap = Math.max(0, currentTick - trackState.cursor);
                    const midiCh = host.midiChannelForKey(key);
                    trackState.track.addEvent(new midi_writer_js_1.default.ControllerChangeEvent({
                        controllerNumber: 11,
                        controllerValue: expression,
                        channel: midiCh,
                        delta: gap
                    }));
                    trackState.cursor = currentTick;
                }
            }
            else {
                syncSN76489NoiseVolume(host, oldVolume, currentTime, activeNotes);
            }
        }
    }
    else {
        // Data byte - upper 6 bits of tone frequency
        const dataBits = data & 0x3F;
        const channel = host.lastLatchedChannel;
        if (channel < 3) {
            const key = `psg_${channel}`;
            const state = host.channels.get(key);
            const oldFreq = state.frequency;
            // Set upper 6 bits, keep lower 4 bits
            state.frequency = (dataBits << 4) | (state.frequency & 0x0F);
            if (state.frequency !== oldFreq) {
                if (state.active) {
                    (0, event_output_1.updateNotePitch)(host, key, channel, currentTime, activeNotes);
                }
                if (channel === 2) {
                    reevaluateSN76489NoiseForChannel2Frequency(host, currentTime, activeNotes);
                }
            }
        }
    }
}
function handleSN76489NoiseControl(host, data, currentTime, activeNotes) {
    const state = host.channels.get('psg_3');
    state.frequency = data & 0x07;
    if (state.volume === 0x0F)
        return;
    if (host.options.suppressHardwareNoise)
        return;
    const noiseKey = 'psg_noise_3';
    if (state.isNoiseActive)
        (0, event_output_1.noteOff)(host, noiseKey, 3, currentTime, activeNotes);
    state.isNoiseActive = true;
    (0, event_output_1.noteOnPercussion)(host, noiseKey, sn76489Velocity(state.volume), currentTime, activeNotes, sn76489NoiseNote(host));
}
function syncSN76489NoiseVolume(host, oldVolume, currentTime, activeNotes) {
    const state = host.channels.get('psg_3');
    if (host.options.suppressHardwareNoise)
        return;
    const noiseKey = 'psg_noise_3';
    const shouldSound = state.volume !== 0x0F;
    if (shouldSound && !state.isNoiseActive) {
        state.isNoiseActive = true;
        (0, event_output_1.noteOnPercussion)(host, noiseKey, sn76489Velocity(state.volume), currentTime, activeNotes, sn76489NoiseNote(host));
    }
    else if (!shouldSound && state.isNoiseActive) {
        state.isNoiseActive = false;
        (0, event_output_1.noteOff)(host, noiseKey, 3, currentTime, activeNotes);
    }
    else if (shouldSound && oldVolume !== state.volume) {
        (0, event_output_1.addExpression)(host, noiseKey, sn76489Expression(state.volume), currentTime);
    }
}
function sn76489Velocity(volume) {
    return Math.max(1, Math.round(((15 - volume) / 15) * 100));
}
function sn76489Expression(volume) {
    return Math.max(0, Math.round(((15 - volume) / 15) * 127));
}
// psg_3's `frequency` field holds the noise control nibble (data & 0x07) rather than an
// actual tone period — see handleSN76489NoiseControl(). Bit2 = FB (0 = periodic/tonal
// noise, 1 = white noise), bits0-1 = NF (fixed clock/512, /1024, /2048 divisor select;
// NF=3 instead follows channel 2's own tone frequency).
function sn76489NoiseNote(host) {
    const control = host.channels.get('psg_3').frequency;
    const isPeriodic = (control & 0x04) === 0;
    const nf = control & 0x03;
    let normalizedRate;
    if (nf === 3) {
        const toneFreq = (0, midi_math_1.psgRegisterToFrequency)(host.channels.get('psg_2').frequency, host.vgmData.header.sn76489Clock, host.vgmData.header.sn76489Flags);
        const clamped = Math.max(100, Math.min(8000, toneFreq || 100));
        normalizedRate = Math.log2(clamped / 100) / Math.log2(8000 / 100);
    }
    else {
        normalizedRate = [1.0, 0.55, 0.25][nf];
    }
    return (0, midi_math_1.noiseDrumNote)(normalizedRate, isPeriodic);
}
// NF=3 makes the noise generator follow channel 2's own tone frequency, so a change to
// that channel's period can move the noise's effective pitch even though nothing on
// channel 3 itself was written. Called from channel 2's tone-frequency write paths.
function reevaluateSN76489NoiseForChannel2Frequency(host, currentTime, activeNotes) {
    if (host.options.suppressHardwareNoise)
        return;
    const noiseState = host.channels.get('psg_3');
    if (!noiseState.isNoiseActive || (noiseState.frequency & 0x03) !== 3)
        return;
    const noiseKey = 'psg_noise_3';
    const newNote = sn76489NoiseNote(host);
    const active = activeNotes.get(noiseKey);
    if (active === undefined || active.note === newNote)
        return;
    (0, event_output_1.noteOff)(host, noiseKey, 3, currentTime, activeNotes);
    (0, event_output_1.noteOnPercussion)(host, noiseKey, sn76489Velocity(noiseState.volume), currentTime, activeNotes, newNote);
}
