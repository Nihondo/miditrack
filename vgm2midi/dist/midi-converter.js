"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MidiConverter = exports.YM2413_BUILTIN_CARRIER_MULTIPLES = exports.YM2413_BUILTIN_CARRIER_REGISTER_BYTES = void 0;
const midi_writer_js_1 = __importDefault(require("midi-writer-js"));
const vgm_chip_metadata_1 = require("./vgm-chip-metadata");
// General MIDI program 81 "Lead 1 (square)" (byte value 80, 0-based). None of the chips
// this tool converts map cleanly onto a GM instrument, but their tone generators are all
// pulse/square-ish, so every track is given this one consistent voice explicitly rather
// than leaving each track's instrument to whatever a DAW's MIDI import happens to assign.
const GM_PROGRAM_LEAD_1_SQUARE = 80;
const GM_PROGRAM_LEAD_2_SAWTOOTH = 81;
const GM_PROGRAM_DRAWBAR_ORGAN = 16;
const GM_PROGRAM_SYNTH_BRASS_1 = 62;
// YM2413の内蔵patch 1-15を、近いGM試聴音色へ対応付ける。patch 0はユーザー
// patchなので固定候補を与えず、従来と同じLead 1へフォールバックする。
const YM2413_GM_PROGRAM_BY_PATCH = [
    GM_PROGRAM_LEAD_1_SQUARE, 40, 24, 0, 73, 71, 68, 56,
    GM_PROGRAM_DRAWBAR_ORGAN, 60, GM_PROGRAM_LEAD_1_SQUARE, 6, 11, 38, 32, 27,
];
const GM_PERCUSSION_CHANNEL = 10;
const GM_CLOSED_HI_HAT_NOTE = 42;
const GM_PCM_PERCUSSION_FIRST_NOTE = 35;
const GM_PCM_PERCUSSION_LAST_NOTE = 81;
const HUC6280_NOISE_RETRIGGER_MIN_VOLUME_RISE = 4;
// Some HuC6280 drivers split the two frequency bytes across adjacent 50/60Hz updates.
// Coalescing up to one 50Hz VGM frame avoids thousands of false MIDI note attacks, while
// still preventing an unrelated write seconds later from being mistaken for the pair.
const HUC6280_SPLIT_FREQUENCY_MAX_GAP_SAMPLES = 882;
// Register $2A drives the DAC one byte at a time with no seek/address information (unlike
// the $E0-seek + $80-8F stream path), so there is no sample identity to key retriggering
// off. Consecutive $2A writes are instead grouped into one note by elapsed-time gap: a
// non-optimized VGM rip drives $2A every few samples while a sample plays, so 882 samples
// (20ms at the VGM 44.1kHz timeline) reliably separates one drum hit from the next without
// splitting a single sample's steady stream of writes.
const YM2612_DAC_DIRECT_GAP_SAMPLES = 882;
const YM2151_FM_PITCH_BEND_RANGE = 96;
const YM2203_FM_PITCH_BEND_RANGE = 96;
const YM2608_FM_PITCH_BEND_RANGE = 96;
const OPL_FM_PITCH_BEND_RANGE = 96;
const CHIP_PITCH_BEND_RANGE = 96;
const MIDI_PPQ = 960;
// CSM のハードウェアkey-on/key-offは同一のTimer Aオーバーフローで発生する。
// MIDIで可聴なアタックとして扱える最小単位は1 tickなので、同じtickの複数回
// オーバーフローは1回へ集約し、出力ノートは1 tickだけ保持する。
const CSM_MIDI_PULSE_TICKS = 1;
const YM2608_RHYTHM_NOTES = [36, 38, 49, 42, 45, 37];
const YM2608_RHYTHM_NAMES = [
    'Bass Drum',
    'Snare Drum',
    'Top Cymbal',
    'Hi-Hat',
    'Tom-Tom',
    'Rim Shot',
];
// OPN channel 3 (the third FM channel, port 0 channel index 2) special mode, shared by
// YM2203, YM2608, and YM2612:
// register $27 bits 7-6 select 00=Normal, 01=Special, 10=Special+CSM, 11=Special (any
// nonzero value enables per-operator frequency, confirmed against Nuked-OPN2's
// `chip->mode_ch3 = (data & 0xc0) >> 6` plus `if (chip->mode_ch3)` gating per-operator
// phase generation — https://github.com/nukeykt/Nuked-OPN2/blob/master/ym3438.c). CSM
// (mode 2) keys all Ch3 operators from each Timer A overflow. The converter emits that
// envelope attack as a one-MIDI-tick pulse, while preserving the usual per-operator or
// optional GM-percussion Ch3 Special representation.
// In special mode, operators 1-3 read their own frequency/block from $A8-$AA (LSB) and
// $AC-$AE (MSB/block); operator 4 continues to use the normal channel $A2/$A6 registers.
// The register-offset-to-operator mapping is NOT sequential (0,1,2 -> Op1,Op2,Op3) — it's
// the same reference confirmed against Nuked-OPN2's OPN2_PhaseGenerate() slot switch
// (fnum_3ch[1]=Op1, fnum_3ch[0]=Op3, fnum_3ch[2]=Op2) and plutiedev.com's YM2612 register
// reference. Offset = reg - 0xA8 (or reg - 0xAC); value = 0-based logical operator index
// matching keyOnMask's own bit0=Op1..bit3=Op4 convention.
const OPN_CH3_SPECIAL_OPERATOR_BY_OFFSET = [2, 0, 1]; // offset 0,1,2 -> Op3,Op1,Op2
const OPN_CH3_PERCUSSION_NAMES = new Map([
    [36, 'Bass Drum'],
    [38, 'Snare Drum'],
    [41, 'Low Floor Tom'],
    [43, 'High Floor Tom'],
    [45, 'Low Tom'],
    [47, 'Low-Mid Tom'],
    [48, 'High-Mid Tom'],
    [50, 'High Tom'],
    [42, 'Closed Hi-Hat'],
    [49, 'Crash Cymbal'],
]);
// YM2413 (OPLL) rhythm mode. Register $0E bit 5 enables it; while active, channels 6-8
// stop being melodic FM channels and their two operators each become an independent
// percussion voice: ch6's modulator+carrier together form Bass Drum, ch7's modulator is
// Hi-Hat and carrier is Snare Drum, ch8's modulator is Tom-Tom and carrier is Top Cymbal —
// confirmed against Mitsutaka Okazaki's emu2413 (a widely-used, well-regarded OPLL
// emulator; https://github.com/digital-sound-antiques/emu2413, see update_key_status() for
// the $0E key-bit-to-slot mapping and OPLL_writeReg()'s $30-$38 case for the $37/$38
// upper-nibble HH/TOM volume reuse). $0E bit4=BD, bit3=SD, bit2=TOM, bit1=CYM, bit0=HH.
const YM2413_RHYTHM_NOTES = [36, 42, 38, 45, 49]; // BD, HH, SD, TOM, CYM (GM Bass Drum 1, Closed Hi-Hat, Acoustic Snare, Low Tom, Crash Cymbal 1)
const YM2413_RHYTHM_NAMES = ['Bass Drum', 'Hi-Hat', 'Snare Drum', 'Tom-Tom', 'Top Cymbal'];
const YM2413_RHYTHM_KEY_BITS = [0x10, 0x01, 0x08, 0x04, 0x02]; // BD, HH, SD, TOM, CYM -> $0E bit masks
const OPL_CHIPS = ['YM3812', 'YM3526', 'Y8950'];
const OPL_DISPLAY_NAMES = {
    YM3812: 'YM3812',
    YM3526: 'YM3526',
    Y8950: 'Y8950',
};
const OPL_RHYTHM_NOTES = [36, 42, 38, 45, 49];
const OPL_RHYTHM_NAMES = ['Bass Drum', 'Hi-Hat', 'Snare Drum', 'Tom-Tom', 'Top Cymbal'];
const OPL_RHYTHM_KEY_BITS = [0x10, 0x01, 0x08, 0x04, 0x02];
const OPL_RHYTHM_SLOTS = [[6, 1], [7, 0], [7, 1], [8, 0], [8, 1]];
// fmopl.c slot_array[32]: only these 18 offsets address the two operators of channels 0-8.
const OPL_SLOT_BY_REGISTER_OFFSET = [
    [0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], undefined, undefined,
    [3, 0], [4, 0], [5, 0], [3, 1], [4, 1], [5, 1], undefined, undefined,
    [6, 0], [7, 0], [8, 0], [6, 1], [7, 1], [8, 1], undefined, undefined,
];
// OPLL built-in patches 1-15's carrier register ($01).  These are the second byte of each
// `default_inst` record in pinned libvgm's emu2413.c.  Patch 0 is the writable user patch
// and is read from $00-$07 below.  Keeping the source bytes public makes this hardware
// table independently verifiable instead of hiding a hand-transcribed Multiple nibble.
/** libvgm/emu2413.c由来のYM2413内蔵patch carrier register ($01) byte。 */
exports.YM2413_BUILTIN_CARRIER_REGISTER_BYTES = [
    0x00, 0x61, 0x41, 0x01, 0x61, 0x21, 0x22, 0x61,
    0x21, 0x61, 0x61, 0x01, 0xC1, 0x50, 0x01, 0x41,
];
/** 内蔵patch carrier registerのMultiple下位nibble（patch番号を添字にする）。 */
exports.YM2413_BUILTIN_CARRIER_MULTIPLES = [
    0, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 0, 1, 1,
];
const YM2413_OPERATOR_MULTIPLES = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
// YM2151's raw $08 bits 3-6 are ordered M1/C1/M2/C2, which is the logical
// algorithm order used by OPN_OPERATOR_PATHS.  Its per-operator register groups however
// are ordered M1/M2/C1/C2 ($60/$68/$70/$78).  MAME ymfm's OPM operator map
// (operator_list(0,16,8,24)) performs the same physical-slot permutation.
const YM2151_LOGICAL_OPERATOR_BY_REGISTER_SLOT = [0, 2, 1, 3];
const YM2151_C2_OPERATOR_MASK = 1 << 3;
// Game Boy DMG (LR35902) APU. VGM command $B3 writes register 0 = GameBoy address $FF10
// (NR10), so these register offsets follow the NRxx numbering directly. Confirmed against
// Pan Docs (gbdev.io/pandocs — the primary Game Boy hardware reference; fetched via a
// mirror since gbdev.io itself returned HTTP 403 during this research) and the VGM
// specification (vgmspec171.txt, command $B3 and header offset $80).
//
// Channels 1-2 (pulse) and channel 3 (wave) each use a "trigger" model rather than an
// explicit enable/disable bit: writing bit7=1 to NRx4 restarts the voice from its current
// frequency/envelope/DAC state. There is no direct "note off" register — real hardware
// stops a voice only via its length counter expiring (if length is enabled) or software
// clearing the channel's DAC (envelope upper 5 bits all zero, or NR30 bit7=0 for the wave
// channel). Length counters are NOT modeled here (see below); a voice is instead treated
// as still sounding until an explicit DAC-off write, a new trigger (which retriggers), or
// the whole APU is powered off via NR52 bit7=0 — the same "ends at the next explicit event"
// heuristic already used for e.g. YM2612 DAC sample triggers in this file.
//
// - Wave RAM contents ($FF30-$FF3F / VGM register $20-$2F): timbre data, not pitch/volume,
//   ignored per this file's "every melodic track uses the shared square-lead GM Program"
//   convention.
const GBDMG_SQUARE_KEYS = ['gbdmg_0', 'gbdmg_1'];
const GBDMG_FRAME_SAMPLES = 44100 / 512;
// Shared noise-frequency-to-GM-drum bands, used by SN76489, AY-3-8910/YM2203/YM2608 SSG,
// HuC6280, and YM2151 hardware noise. Each chip normalizes its own noise-rate register to
// a common [0..1] scale (0 = lowest/slowest, 1 = highest/fastest) before calling
// noiseDrumNote() below — absolute Hz thresholds would not transfer between chips whose
// noise-rate ranges differ by orders of magnitude (NES-style ~440Hz-447kHz vs. AY's
// clock/16/period range), but a normalized position within each chip's own range does.
const NOISE_DRUM_HIGH_NOTE = 42; // Closed Hi-Hat
const NOISE_DRUM_MID_NOTE = 38; // Acoustic Snare
const NOISE_DRUM_LOW_NOTE = 45; // Low Tom
const NOISE_DRUM_PERIODIC_HIGH_NOTE = 37; // Side Stick (SN76489 tonal/periodic noise)
const NOISE_DRUM_PERIODIC_LOW_NOTE = 35; // Bass Drum (SN76489 tonal/periodic noise)
// isPeriodic marks SN76489's tonal/periodic noise mode (FB=0), which sounds pitched rather
// than like white noise, so it uses a different, more "tonal" pair of drum voices than the
// three-band white-noise mapping shared by every other chip.
function noiseDrumNote(normalizedRate, isPeriodic) {
    if (isPeriodic) {
        return normalizedRate >= 0.5 ? NOISE_DRUM_PERIODIC_HIGH_NOTE : NOISE_DRUM_PERIODIC_LOW_NOTE;
    }
    if (normalizedRate >= 0.7)
        return NOISE_DRUM_HIGH_NOTE;
    if (normalizedRate >= 0.35)
        return NOISE_DRUM_MID_NOTE;
    return NOISE_DRUM_LOW_NOTE;
}
// Logical operator order is O1, O2, O3, O4. Each entry describes the operators
// whose frequencies can reach one audible carrier for the corresponding algorithm.
const OPN_OPERATOR_PATHS = [
    [{ carrier: 3, operators: [0, 1, 2, 3] }],
    [{ carrier: 3, operators: [0, 1, 2, 3] }],
    [{ carrier: 3, operators: [0, 1, 2, 3] }],
    [{ carrier: 3, operators: [0, 1, 2, 3] }],
    [
        { carrier: 1, operators: [0, 1] },
        { carrier: 3, operators: [2, 3] },
    ],
    [
        { carrier: 1, operators: [0, 1] },
        { carrier: 2, operators: [0, 2] },
        { carrier: 3, operators: [0, 3] },
    ],
    [
        { carrier: 1, operators: [0, 1] },
        { carrier: 2, operators: [2] },
        { carrier: 3, operators: [3] },
    ],
    [
        { carrier: 0, operators: [0] },
        { carrier: 1, operators: [1] },
        { carrier: 2, operators: [2] },
        { carrier: 3, operators: [3] },
    ],
];
const OPL_OPERATOR_PATHS = [
    [{ carrier: 1, operators: [0, 1] }],
    [{ carrier: 0, operators: [0] }, { carrier: 1, operators: [1] }],
];
const OPN_DOUBLED_MULTIPLES = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30];
/** fmopl.c mul_tabの実MULTIPLEを2倍した整数表。 */
const OPL_DOUBLED_MULTIPLES = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30];
function greatestCommonDivisor(left, right) {
    let dividend = Math.abs(left);
    let divisor = Math.abs(right);
    while (divisor !== 0) {
        [dividend, divisor] = [divisor, dividend % divisor];
    }
    return dividend;
}
/** source keyを現在のdescriptor IDへ正規化し、既存handlerのMap APIを保つ。 */
class DescriptorActiveNotes extends Map {
    constructor(resolveId) {
        super();
        this.resolveId = resolveId;
    }
    normalizeKey(key) { return this.resolveId(key); }
    has(key) { return super.has(this.normalizeKey(key)); }
    get(key) { return super.get(this.normalizeKey(key)); }
    set(key, value) { return super.set(this.normalizeKey(key), value); }
    delete(key) { return super.delete(this.normalizeKey(key)); }
}
/** VGMのチップ書き込みを解析し、音程・音量・ノイズの発音状態をMIDIイベントへ変換する。 */
class MidiConverter {
    constructor(vgmData, options = {}) {
        this.sampleRate = 44100;
        this.channels = new Map();
        this.tracks = new Map();
        this.descriptors = new Map();
        /** 実際に重なった異descriptorのMIDI channelだけを記録する。 */
        this.warnings = [];
        this.activeMidiDescriptors = new Map();
        this.activePCMNotes = new Map();
        this.generatedNoteCount = 0;
        this.lastLatchedChannel = 0;
        this.gameGearStereo = 0xFF;
        this.huc6280SelectedChannels = [0, 0];
        this.segaPCMRegisters = new Uint8Array(0x100);
        this.c140Registers = new Uint8Array(0x200);
        this.segaPCMActiveVoices = new Array(16);
        this.c140ActiveVoices = new Array(24);
        this.pcmSampleNotes = new Map();
        this.isYM2612DACEnabled = false;
        // Ch3 mode and active collapsed-percussion track are isolated per OPN chip instance.
        this.opnCh3SpecialModes = new Map();
        this.opnCh3PercussionActiveKeys = new Map();
        this.opnCsmTimers = new Map();
        this.opmCsmTimers = new Map();
        this.oplRhythmModes = new Map();
        this.oplRhythmControlBytes = new Map();
        this.ym2203Prescalers = [6, 6];
        this.ym2608Prescalers = [6, 6];
        this.ym2608RhythmTotalLevels = [0, 0];
        this.ym2608RhythmInstrumentLevels = [new Array(6).fill(0), new Array(6).fill(0)];
        this.ym2608ADPCMRegisters = [new Uint8Array(0x11), new Uint8Array(0x11)];
        this.ym2608ADPCMActiveVoices = new Array(2);
        // True while YM2413 register $0E bit 5 selects rhythm mode. See the YM2413_RHYTHM_*
        // constants above for the register/percussion mapping.
        this.ym2413RhythmMode = false;
        // Last-written $0E value, masked to bits 0-4, used to detect which individual rhythm
        // key-on bits changed on the next $0E write (XOR against the new value).
        this.ym2413RhythmControlByte = 0;
        // 4-bit volume registers (0=loudest, 15=quietest) for the five rhythm voices, in
        // YM2413_RHYTHM_NOTES order (BD, HH, SD, TOM, CYM). BD comes from $36's low nibble; HH
        // and TOM come from $37/$38's normally-instrument-number high nibble (repurposed in
        // rhythm mode); SD and CYM come from $37/$38's low nibble.
        this.ym2413RhythmVolumes = [0, 0, 0, 0, 0];
        this.ym2413CustomPatch = new Uint8Array(8);
        this.hasYM2413CustomCarrierMultiple = false;
        // AY-3-8910/YM2203/YM2608 SSG noise-period (reg 6) is one shared generator per chip
        // instance, unlike tone/volume which are per-channel — keyed by the SSG's keyPrefix
        // (e.g. "ay8910", "ym2203_0_ssg", "ym2608_1_ssg").
        this.ssgNoisePeriods = new Map();
        this.initialChannels = new Map();
        this.streams = new Map();
        this.huc6280GlobalBalance = [0xFF, 0xFF];
        this.secondaryChipStates = new Map();
        this.gbDmgMasterVolume = 0x77;
        this.gbDmgStereoRouting = 0xFF;
        this.gbDmgFrameSteps = [0, 0];
        this.gbDmgNextFrameSamples = [GBDMG_FRAME_SAMPLES, GBDMG_FRAME_SAMPLES];
        this.vgmData = vgmData;
        this.options = {
            tempo: options.tempo || 120,
            trackPerChannel: options.trackPerChannel || false,
            verbose: options.verbose || false,
            suppressHardwareNoise: options.suppressHardwareNoise || false,
            suppressYM2612Dac: options.suppressYM2612Dac || false,
            splitChips: options.splitChips || false,
            opnCh3SpecialPercussion: options.opnCh3SpecialPercussion ?? options.ym2612Ch3SpecialPercussion ?? false,
        };
        // Initialize PSG channels (0-2: Tone, 3: Noise)
        for (let i = 0; i < 4; i++) {
            this.channels.set(`psg_${i}`, {
                frequency: 0,
                volume: 15,
                active: false,
                midiNote: 0,
                baseMidiNote: 0,
                isNoiseActive: false,
            });
        }
        // Initialize YM2612 channels (0-2: Port 0, 3-5: Port 1)
        for (let i = 0; i < 6; i++) {
            this.channels.set(`ym2612_${i}`, {
                frequency: 0,
                volume: 0,
                active: false,
                midiNote: 0,
                baseMidiNote: 0,
                block: 0,
                freqLSB: 0,
                freqMSB: 0,
                keyOnMask: 0,
                opnAlgorithm: 0,
                opnOperatorMultipliers: [0, 0, 0, 0],
                opnOperatorMultiplierWritten: [false, false, false, false],
                opnOperatorTotalLevels: [0, 0, 0, 0],
                opnActivePitchScale: 1,
            });
        }
        this.initializeOPNCh3SpecialChannels(this.opnCh3Context('YM2612'));
        // Initialize up to two YM2203 chips: 3 FM + 3 integrated SSG channels each.
        for (let instance = 0; instance < 2; instance++) {
            for (let channel = 0; channel < 3; channel++) {
                this.channels.set(`ym2203_${instance}_fm_${channel}`, {
                    frequency: 0,
                    volume: 0,
                    active: false,
                    midiNote: 0,
                    baseMidiNote: 0,
                    block: 0,
                    freqLSB: 0,
                    freqMSB: 0,
                    keyOnMask: 0,
                    opnAlgorithm: 0,
                    opnOperatorMultipliers: [0, 0, 0, 0],
                    opnOperatorMultiplierWritten: [false, false, false, false],
                    opnOperatorTotalLevels: [0, 0, 0, 0],
                    opnActivePitchScale: 1,
                });
                this.channels.set(`ym2203_${instance}_ssg_${channel}`, {
                    frequency: 0,
                    volume: 0,
                    active: false,
                    midiNote: 0,
                    baseMidiNote: 0,
                    freqLSB: 0,
                    freqMSB: 0,
                    isToneEnabled: true,
                    isNoise: false,
                    isNoiseActive: false,
                });
            }
            this.initializeOPNCh3SpecialChannels(this.opnCh3Context('YM2203', instance));
        }
        // Initialize up to two YM2608 chips: 6 FM + 3 integrated SSG channels each.
        for (let instance = 0; instance < 2; instance++) {
            for (let channel = 0; channel < 6; channel++) {
                this.channels.set(`ym2608_${instance}_fm_${channel}`, {
                    frequency: 0,
                    volume: 0,
                    active: false,
                    midiNote: 0,
                    baseMidiNote: 0,
                    block: 0,
                    freqLSB: 0,
                    freqMSB: 0,
                    keyOnMask: 0,
                    opnAlgorithm: 0,
                    opnOperatorMultipliers: [0, 0, 0, 0],
                    opnOperatorMultiplierWritten: [false, false, false, false],
                    opnOperatorTotalLevels: [0, 0, 0, 0],
                    opnActivePitchScale: 1,
                });
            }
            for (let channel = 0; channel < 3; channel++) {
                this.channels.set(`ym2608_${instance}_ssg_${channel}`, {
                    frequency: 0,
                    volume: 0,
                    active: false,
                    midiNote: 0,
                    baseMidiNote: 0,
                    freqLSB: 0,
                    freqMSB: 0,
                    isToneEnabled: true,
                    isNoise: false,
                    isNoiseActive: false,
                });
            }
            this.initializeOPNCh3SpecialChannels(this.opnCh3Context('YM2608', instance));
        }
        // YM3526/YM3812/Y8950 share the OPL 9-channel, two-operator FM register map.
        // Instance is embedded in the key so both chips retain independent register latches.
        for (const chip of OPL_CHIPS) {
            const prefix = chip.toLowerCase();
            for (let instance = 0; instance < 2; instance++) {
                for (let channel = 0; channel < 9; channel++) {
                    this.channels.set(`${prefix}_${instance}_fm_${channel}`, {
                        frequency: 0,
                        volume: 0,
                        active: false,
                        midiNote: 0,
                        baseMidiNote: 0,
                        block: 0,
                        freqLSB: 0,
                        freqMSB: 0,
                        keyOnMask: 0x03,
                        opnAlgorithm: 0,
                        opnOperatorMultipliers: [0, 0],
                        opnOperatorMultiplierWritten: [false, false],
                        opnOperatorTotalLevels: [0, 0],
                        opnActivePitchScale: 1,
                        oplKeyOn: false,
                        oplPendingKeyOn: false,
                    });
                }
            }
        }
        // Initialize YM2151 (OPM) channels (0-7)
        for (let i = 0; i < 8; i++) {
            this.channels.set(`ym2151_${i}`, {
                frequency: 0,
                volume: 0,
                active: false,
                midiNote: 0,
                baseMidiNote: 0,
                keyCode: 0,
                keyFraction: 0,
                keyOnMask: 0,
                isNoise: false,
                isNoiseActive: false,
            });
        }
        // Initialize YM2413 (OPLL) channels 0-8. Channels 6-8 double as rhythm-mode operator
        // pairs (see YM2413_RHYTHM_* constants); their `active` here always reflects the
        // normal-mode melodic voice, forced false and closed whenever rhythm mode is on.
        for (let channel = 0; channel < 9; channel++) {
            this.channels.set(`ym2413_${channel}`, {
                frequency: 0,
                volume: 0,
                active: false,
                midiNote: 0,
                baseMidiNote: 0,
                block: 0,
                freqLSB: 0,
                freqMSB: 0,
                ym2413Instrument: 0,
                ym2413PendingKeyOn: false,
            });
        }
        // Initialize Game Boy DMG channels: two pulse (gbdmg_0/1), one wave (gbdmg_2), and one
        // noise (gbdmg_noise_0, named with the `_noise_` infix so isPercussionKey() routes it
        // to GM percussion channel 10 like every other chip's noise track). `volume` holds the
        // raw NRx2 envelope byte (or, for the wave channel, the 2-bit output-level code from
        // NR32) rather than a pre-derived velocity, since DAC-enabled state is read from it too
        // (see gbDmgDacEnabled()). `isEnabled` is the wave channel's own NR30 DAC-enable bit.
        this.channels.set('gbdmg_0', {
            frequency: 0, volume: 0, active: false, midiNote: 0, baseMidiNote: 0, freqLSB: 0, freqMSB: 0,
            gbDmgLengthCounter: 0, gbDmgLengthEnabled: false, gbDmgEnvelopeVolume: 0, gbDmgEnvelopeTimer: 0,
            gbDmgEnvelopePeriod: 0, gbDmgEnvelopeIncrease: false, gbDmgSweepShadow: 0, gbDmgSweepTimer: 0,
            gbDmgSweepPeriod: 0, gbDmgSweepShift: 0, gbDmgSweepNegate: false, gbDmgSweepEnabled: false,
        });
        this.channels.set('gbdmg_1', {
            frequency: 0, volume: 0, active: false, midiNote: 0, baseMidiNote: 0, freqLSB: 0, freqMSB: 0,
            gbDmgLengthCounter: 0, gbDmgLengthEnabled: false, gbDmgEnvelopeVolume: 0, gbDmgEnvelopeTimer: 0,
            gbDmgEnvelopePeriod: 0, gbDmgEnvelopeIncrease: false,
        });
        this.channels.set('gbdmg_2', {
            frequency: 0, volume: 0, active: false, midiNote: 0, baseMidiNote: 0, freqLSB: 0, freqMSB: 0, isEnabled: false,
            gbDmgLengthCounter: 0, gbDmgLengthEnabled: false,
        });
        this.channels.set('gbdmg_noise_0', {
            frequency: 0, volume: 0, active: false, midiNote: 0, baseMidiNote: 0, noisePeriod: 0,
            gbDmgLengthCounter: 0, gbDmgLengthEnabled: false, gbDmgEnvelopeVolume: 0, gbDmgEnvelopeTimer: 0,
            gbDmgEnvelopePeriod: 0, gbDmgEnvelopeIncrease: false,
        });
        // Initialize up to two AY8910 chips (3 tone/noise channels each).
        for (let instance = 0; instance < 2; instance++) {
            for (let channel = 0; channel < 3; channel++) {
                this.channels.set(`ay8910_${instance}_${channel}`, {
                    frequency: 0,
                    volume: 0,
                    active: false,
                    midiNote: 0,
                    baseMidiNote: 0,
                    freqLSB: 0,
                    freqMSB: 0,
                    isToneEnabled: true,
                    isNoise: false,
                    isNoiseActive: false,
                });
            }
        }
        // Initialize up to two HuC6280 chips (6 channels each; 4-5 also support noise mode).
        for (let instance = 0; instance < 2; instance++) {
            for (let channel = 0; channel < 6; channel++) {
                this.channels.set(`huc6280_${instance}_${channel}`, {
                    frequency: 0,
                    volume: 0, // 0 = silent, 31 = loudest (5-bit)
                    active: false,
                    midiNote: 0,
                    baseMidiNote: 0,
                    freqLSB: 0,
                    freqMSB: 0,
                    isEnabled: false,
                    isDDA: false,
                    isNoise: false,
                    isNoiseActive: false,
                });
            }
        }
        this.segaPCMRegisters.fill(0xFF);
        this.initialChannels = this.cloneChannels(this.channels);
        for (const chip of ['SN76489', 'YM2413', 'YM2612', 'YM2151', 'GBDMG', 'SegaPCM', 'C140']) {
            // A second device must start from power-on state, never from the registers/voices
            // the primary device happened to have when its first command arrives.
            this.secondaryChipStates.set(chip, {
                channels: this.cloneChannels(this.channels),
                scalars: this.captureChipScalars(chip),
            });
        }
    }
    /** 第二チップの可変状態を一時的に主チップのhandlerへ差し替えて隔離する。 */
    withChipInstance(chip, instance, action) {
        const previousContext = this.activeChipInstance;
        this.activeChipInstance = instance === 1 ? { chip, instance } : undefined;
        if (instance !== 1 || !this.secondaryChipStates.has(chip)) {
            try {
                action();
            }
            finally {
                this.activeChipInstance = previousContext;
            }
            return;
        }
        const saved = this.secondaryChipStates.get(chip);
        const predicate = (key) => this.belongsToChip(key, chip);
        const primaryChannels = new Map([...this.channels.entries()].filter(([key]) => predicate(key)));
        for (const [key, state] of saved.channels)
            if (predicate(key))
                this.channels.set(key, this.cloneChannels(new Map([[key, state]])).get(key));
        const primaryScalars = this.captureChipScalars(chip);
        this.restoreChipScalars(chip, saved.scalars);
        try {
            action();
        }
        finally {
            saved.channels = new Map([...this.channels.entries()].filter(([key]) => predicate(key)));
            saved.scalars = this.captureChipScalars(chip);
            for (const [key, state] of primaryChannels)
                this.channels.set(key, state);
            this.restoreChipScalars(chip, primaryScalars);
            this.activeChipInstance = previousContext;
        }
    }
    belongsToChip(key, chip) {
        return (chip === 'SN76489' && key.startsWith('psg_'))
            || (chip === 'YM2413' && key.startsWith('ym2413_')) || (chip === 'YM2612' && key.startsWith('ym2612_'))
            || (chip === 'YM2151' && key.startsWith('ym2151_')) || (chip === 'GBDMG' && key.startsWith('gbdmg_'))
            || (chip === 'SegaPCM' && key.startsWith('segapcm_')) || (chip === 'C140' && key.startsWith('c140_'));
    }
    captureChipScalars(chip) {
        if (chip === 'SN76489')
            return { lastLatchedChannel: this.lastLatchedChannel, gameGearStereo: this.gameGearStereo };
        if (chip === 'YM2612')
            return {
                dacEnabled: this.isYM2612DACEnabled, pending: this.ym2612DACPendingAddress,
                active: this.ym2612DACActiveVoice, direct: this.ym2612DirectDACActiveVoice,
                last: this.ym2612DirectDACLastWriteTime,
                ch3Modes: new Map(this.opnCh3SpecialModes),
                ch3Percussion: new Map(this.opnCh3PercussionActiveKeys),
            };
        if (chip === 'YM2413')
            return { rhythm: this.ym2413RhythmMode, control: this.ym2413RhythmControlByte, volumes: this.ym2413RhythmVolumes.slice(), customPatch: this.ym2413CustomPatch.slice(), hasCustomCarrier: this.hasYM2413CustomCarrierMultiple };
        if (chip === 'GBDMG')
            return {
                masterVolume: this.gbDmgMasterVolume,
                stereoRouting: this.gbDmgStereoRouting,
            };
        if (chip === 'SegaPCM')
            return {
                registers: this.segaPCMRegisters.slice(), voices: this.segaPCMActiveVoices.slice(),
                sampleNotes: new Map(this.pcmSampleNotes), pcmChannel10Pan: this.pcmChannel10Pan,
            };
        if (chip === 'C140')
            return {
                registers: this.c140Registers.slice(), voices: this.c140ActiveVoices.slice(),
                sampleNotes: new Map(this.pcmSampleNotes), pcmChannel10Pan: this.pcmChannel10Pan,
            };
        return {};
    }
    restoreChipScalars(chip, value) {
        if (chip === 'SN76489') {
            this.lastLatchedChannel = value.lastLatchedChannel ?? 0;
            this.gameGearStereo = value.gameGearStereo ?? 0xFF;
        }
        else if (chip === 'YM2612') {
            this.isYM2612DACEnabled = value.dacEnabled ?? false;
            this.ym2612DACPendingAddress = value.pending;
            this.ym2612DACActiveVoice = value.active;
            this.ym2612DirectDACActiveVoice = value.direct;
            this.ym2612DirectDACLastWriteTime = value.last;
            this.opnCh3SpecialModes = new Map(value.ch3Modes ?? []);
            this.opnCh3PercussionActiveKeys = new Map(value.ch3Percussion ?? []);
        }
        else if (chip === 'YM2413') {
            this.ym2413RhythmMode = value.rhythm ?? false;
            this.ym2413RhythmControlByte = value.control ?? 0;
            this.ym2413RhythmVolumes = (value.volumes ?? [0, 0, 0, 0, 0]).slice();
            this.ym2413CustomPatch = (value.customPatch ?? new Uint8Array(8)).slice();
            this.hasYM2413CustomCarrierMultiple = value.hasCustomCarrier ?? false;
        }
        else if (chip === 'GBDMG') {
            this.gbDmgMasterVolume = value.masterVolume ?? 0x77;
            this.gbDmgStereoRouting = value.stereoRouting ?? 0xFF;
        }
        else if (chip === 'SegaPCM') {
            if (value.registers)
                this.segaPCMRegisters = value.registers.slice();
            if (value.voices)
                this.segaPCMActiveVoices = value.voices.slice();
            this.pcmSampleNotes = new Map(value.sampleNotes ?? []);
            this.pcmChannel10Pan = value.pcmChannel10Pan;
        }
        else if (chip === 'C140') {
            if (value.registers)
                this.c140Registers = value.registers.slice();
            if (value.voices)
                this.c140ActiveVoices = value.voices.slice();
            this.pcmSampleNotes = new Map(value.sampleNotes ?? []);
            this.pcmChannel10Pan = value.pcmChannel10Pan;
        }
    }
    /** 変換間で可変レジスタを共有しないための深い状態複製。 */
    cloneChannels(source) {
        return new Map([...source.entries()].map(([key, state]) => [key, {
                ...state,
                opnOperatorMultipliers: state.opnOperatorMultipliers?.slice(),
                opnOperatorMultiplierWritten: state.opnOperatorMultiplierWritten?.slice(),
                opnOperatorTotalLevels: state.opnOperatorTotalLevels?.slice(),
            }]));
    }
    opnCh3Context(chip, instance = 0) {
        const lowerChip = chip.toLowerCase();
        const stateKey = chip === 'YM2612' ? lowerChip : `${lowerChip}_${instance}`;
        const parentKey = chip === 'YM2612' ? 'ym2612_2' : `${stateKey}_fm_2`;
        const operatorKeys = [
            `${stateKey}_ch3sp_1`,
            `${stateKey}_ch3sp_2`,
            `${stateKey}_ch3sp_3`,
            parentKey,
        ];
        return {
            chip,
            instance,
            stateKey,
            parentKey,
            operatorKeys,
            percussionPrefix: `${stateKey}_ch3perc_`,
        };
    }
    initializeOPNCh3SpecialChannels(context) {
        for (const key of context.operatorKeys.slice(0, 3)) {
            this.channels.set(key, {
                frequency: 0,
                volume: 0,
                active: false,
                midiNote: 0,
                baseMidiNote: 0,
                block: 0,
                freqLSB: 0,
                freqMSB: 0,
                opnActivePitchScale: 1,
            });
        }
    }
    // Single source of truth for chip-channel-key -> 1-based MIDI channel, used by
    // getTrack()'s Program Change and by every note/pitch-bend/CC event below.
    midiChannelForKey(key) {
        if (this.isPercussionKey(key))
            return GM_PERCUSSION_CHANNEL;
        if (key.startsWith('psg_'))
            return parseInt(key.split('_')[1]) + 1;
        // Channel 3 special-mode Op1-3 sub-voices get their own MIDI channels (11-13),
        // reusing otherwise-unclaimed channel space the same way huc6280MidiChannel() wraps
        // onto 14-16/1-3 — safe for a plain SN76489+YM2612 Mega Drive VGM (this feature's
        // only known source), though it could collide with AY8910/YM2203/YM2608 channels in a
        // hypothetical VGM that also drives one of those chips simultaneously.
        if (key.startsWith('ym2612_ch3sp_'))
            return 10 + parseInt(key.split('_')[2]);
        // YM2203/YM2608 primary Ch3 Special Op1-3 use the otherwise-free channels 14-16.
        // A dual-chip VGM necessarily reuses those channels because all 16 MIDI channels are
        // already occupied; track identity remains separate, and percussion-collapse mode
        // avoids the collision entirely for drum-driven sources.
        if (key.includes('_ch3sp_')) {
            const parts = key.split('_');
            return 13 + parseInt(parts[parts.length - 1]);
        }
        if (key.startsWith('ym2612_')) {
            const channel = parseInt(key.split('_')[1]);
            // YM2612 channels 1-5 use MIDI 5-9. Channel 6 moves to MIDI 14 so melodic
            // FM never lands on General MIDI's reserved percussion channel 10; channels
            // 11-13 are already used by the optional Ch3 Special operator tracks.
            return channel < 5 ? channel + 5 : 14;
        }
        if (key.startsWith('ym2203_'))
            return this.ym2203MidiChannel(key);
        if (key.startsWith('ym2608_'))
            return this.ym2608MidiChannel(key);
        if (this.isOPLKey(key))
            return this.oplMidiChannel(key);
        if (key.startsWith('ym2151_'))
            return parseInt(key.split('_')[1]) + 1;
        if (key.startsWith('ay8910_'))
            return this.ay8910MidiChannel(key);
        if (key.startsWith('huc6280_'))
            return this.huc6280MidiChannel(key);
        // Rhythm keys (`ym2413_rhythm_N`) are already routed to GM_PERCUSSION_CHANNEL by the
        // isPercussionKey() check above, so this only ever sees the 9 melodic channel keys.
        // 5-9 then 11-14 skips MIDI channel 10 (percussion) and channel-1-4 (SN76489, which
        // commonly accompanies YM2413 as the Sega Master System's FM Sound Unit pairing).
        if (key.startsWith('ym2413_')) {
            const channel = parseInt(key.split('_')[1]);
            return channel < 5 ? channel + 5 : channel + 6;
        }
        // gbdmg_noise_0 is already routed to GM_PERCUSSION_CHANNEL above (its `_noise_`
        // infix matches isPercussionKey()), so this only ever sees gbdmg_0/1/2.
        if (key.startsWith('gbdmg_'))
            return parseInt(key.split('_')[1]) + 1;
        return 1;
    }
    /** VGM Extra Headerのチップ別volumeを、CC7に出力する0-127の値へ変換する。
     *
     * volume=0x0100（256）が100%（GM既定のCC7=100相当）。エントリが無い、
     * volume未指定、または相対値指定（isAbsoluteVolume!==true）の場合は
     * undefinedを返す — 相対値は「既定値からの差分」であり既定値そのものを
     * このパーサーは知らないため、絶対値指定のときだけ安全に採用できる。
     */
    extraHeaderVolumePercent(chip, instance) {
        const extraHeader = this.vgmData.extraHeader;
        if (!extraHeader || chip === 'misc')
            return undefined;
        // Extra Header側のチップ名テーブルはOKIM6258、descriptor.chipはMSM6258
        // （このファイル内の他の命名と合わせた別名）を使う。
        const lookupChip = chip === 'MSM6258' ? 'OKIM6258' : chip;
        const entry = extraHeader.find((e) => e.chip === lookupChip && e.instance === instance);
        if (!entry || entry.volume === undefined || entry.isAbsoluteVolume !== true)
            return undefined;
        return Math.max(0, Math.min(127, Math.round((entry.volume / 0x100) * 100)));
    }
    /** source keyを、現在のchip instanceを含む不変のtrack descriptorへ変換する。 */
    descriptorForKey(key) {
        const existing = this.descriptors.get(key);
        if (existing)
            return existing;
        const sourceKey = key;
        const chip = sourceKey.startsWith('psg_') ? 'SN76489'
            : sourceKey.startsWith('ym2612') ? 'YM2612'
                : sourceKey.startsWith('ym2151') ? 'YM2151'
                    : sourceKey.startsWith('ym2413') ? 'YM2413'
                        : sourceKey.startsWith('ym2203') ? 'YM2203'
                            : sourceKey.startsWith('ym2608') ? 'YM2608'
                                : sourceKey.startsWith('ym3812') ? 'YM3812'
                                    : sourceKey.startsWith('ym3526') ? 'YM3526'
                                        : sourceKey.startsWith('y8950') ? 'Y8950'
                                            : sourceKey.startsWith('ay8910') ? 'AY8910'
                                                : sourceKey.startsWith('huc6280') ? 'HuC6280'
                                                    : sourceKey.startsWith('gbdmg') ? 'GBDMG'
                                                        : sourceKey.startsWith('segapcm') ? 'SegaPCM'
                                                            : sourceKey.startsWith('c140') ? 'C140'
                                                                : sourceKey.startsWith('msm6258') ? 'MSM6258' : 'misc';
        const parts = sourceKey.split('_');
        const embeddedInstance = ['YM2203', 'YM2608', 'YM3812', 'YM3526', 'Y8950', 'AY8910', 'HuC6280'].includes(chip)
            ? Number(parts[1]) || 0 : undefined;
        const instance = this.activeChipInstance?.chip === chip
            ? this.activeChipInstance.instance : embeddedInstance ?? 0;
        const section = sourceKey.includes('_noise_') ? 'noise'
            : sourceKey.includes('_sample_') || sourceKey.includes('_dac_') || sourceKey.includes('_adpcmb_') || sourceKey === 'ym2612dac_direct_stream' ? 'pcm'
                : sourceKey.includes('_rhythm_') ? 'rhythm'
                    : sourceKey.includes('_ch3sp_') ? 'ch3-special'
                        : sourceKey.includes('_ch3perc_') ? 'ch3-percussion'
                            : sourceKey.includes('_ssg_') ? 'ssg'
                                : sourceKey.includes('_fm_') ? 'fm' : 'tone';
        const finalPart = parts[parts.length - 1];
        const channel = /^\d+$/.test(finalPart) ? Number(finalPart) : 0;
        const midiChannel = this.midiChannelForKey(sourceKey);
        const id = `${chip}:${instance}:${section}:${channel}:${sourceKey}`;
        const descriptor = { chip, instance, section, channel, sourceKey, midiChannel, id };
        this.descriptors.set(id, descriptor);
        return descriptor;
    }
    /** descriptor IDまたは従来source keyからdescriptorを得る。 */
    resolveDescriptor(key) {
        return this.descriptors.get(key) ?? this.descriptorForKey(key);
    }
    /** FMトラックの初回発音時に使うGM音色候補を返す。 */
    suggestedProgramForFMTimbre(model, algorithm) {
        if (algorithm === undefined || model === 'opll')
            return GM_PROGRAM_LEAD_1_SQUARE;
        if (model === 'opl')
            return algorithm === 0
                ? GM_PROGRAM_LEAD_2_SAWTOOTH : GM_PROGRAM_DRAWBAR_ORGAN;
        if (algorithm <= 3)
            return GM_PROGRAM_LEAD_2_SAWTOOTH;
        if (algorithm <= 6)
            return GM_PROGRAM_SYNTH_BRASS_1;
        return GM_PROGRAM_DRAWBAR_ORGAN;
    }
    /** YM2413内蔵patch番号に対応するGM試聴音色候補を返す。 */
    suggestedProgramForYM2413Patch(instrument) {
        return YM2413_GM_PROGRAM_BY_PATCH[instrument & 0x0F] ?? GM_PROGRAM_LEAD_1_SQUARE;
    }
    /** YM2413の選択patchからcarrier Multipleを取得する。 */
    ym2413CarrierMultiple(state) {
        const instrument = state.ym2413Instrument ?? 0;
        const nibble = instrument === 0
            ? (this.hasYM2413CustomCarrierMultiple ? this.ym2413CustomPatch[1] & 0x0F : 1)
            : exports.YM2413_BUILTIN_CARRIER_MULTIPLES[instrument] ?? 1;
        return YM2413_OPERATOR_MULTIPLES[nibble] ?? 1;
    }
    /** OPN Ch3 Specialのオペレータトラックから親FMチャンネルを解決する。 */
    opnCh3ParentStateForSourceKey(sourceKey) {
        if (sourceKey.startsWith('ym2612_ch3sp_'))
            return this.channels.get('ym2612_2');
        const match = /^(ym2203|ym2608)_(\d+)_ch3sp_\d+$/.exec(sourceKey);
        return match ? this.channels.get(`${match[1]}_${match[2]}_fm_2`) : undefined;
    }
    /** OPN Ch3の親／オペレータ別トラックなら、現在のSpecial/CSM状態を返す。 */
    opnCh3ModeForDescriptor(descriptor) {
        const { chip, instance, sourceKey } = descriptor;
        if (!['YM2203', 'YM2608', 'YM2612'].includes(chip))
            return undefined;
        const context = this.opnCh3Context(chip, instance);
        if (sourceKey !== context.parentKey && !context.operatorKeys.includes(sourceKey))
            return undefined;
        if (!this.isOPNCh3SpecialMode(context))
            return undefined;
        return this.opnCsmTimer(context.chip, context.instance).isCSMEnabled
            ? 'special-csm'
            : 'special';
    }
    /** MIDIの初回Program Changeと同じ時点のFM状態をsidecar用に複製する。 */
    fmTimbreForDescriptor(descriptor) {
        const chip = descriptor.chip;
        const model = chip === 'YM2151' ? 'opm'
            : chip === 'YM2413' ? 'opll'
                : OPL_CHIPS.includes(chip) ? 'opl'
                    : ['YM2203', 'YM2608', 'YM2612'].includes(chip) ? 'opn' : undefined;
        if (!model)
            return undefined;
        const isPrimaryFM = descriptor.section === 'fm'
            || (descriptor.section === 'tone' && ['YM2151', 'YM2413', 'YM2612'].includes(chip));
        if (!isPrimaryFM && descriptor.section !== 'ch3-special')
            return undefined;
        const state = descriptor.section === 'ch3-special'
            ? this.opnCh3ParentStateForSourceKey(descriptor.sourceKey)
            : this.channels.get(descriptor.sourceKey);
        if (!state)
            return undefined;
        const algorithm = model === 'opll' ? undefined : state.opnAlgorithm ?? 0;
        const paths = model === 'opl' ? OPL_OPERATOR_PATHS : OPN_OPERATOR_PATHS;
        const carrierOperators = algorithm === undefined ? undefined
            : (paths[algorithm] ?? paths[0]).map(path => path.carrier);
        const specialMatch = /_ch3sp_(\d+)$/.exec(descriptor.sourceKey);
        const opnCh3Mode = this.opnCh3ModeForDescriptor(descriptor);
        const ym2413Instrument = state.ym2413Instrument;
        const suggestedProgram = model === 'opll'
            ? this.suggestedProgramForYM2413Patch(ym2413Instrument ?? 0)
            : this.suggestedProgramForFMTimbre(model, algorithm);
        return {
            model,
            suggestedProgram,
            ...(algorithm === undefined ? {} : { algorithm }),
            ...(carrierOperators === undefined ? {} : { carrierOperators }),
            ...(state.opnOperatorMultipliers ? { operatorMultipliers: state.opnOperatorMultipliers.slice() } : {}),
            ...(state.opnOperatorMultiplierWritten ? { operatorMultiplierWritten: state.opnOperatorMultiplierWritten.slice() } : {}),
            ...(state.opnOperatorTotalLevels ? { operatorTotalLevels: state.opnOperatorTotalLevels.slice() } : {}),
            ...(state.keyOnMask === undefined ? {} : { keyOnMask: state.keyOnMask }),
            ...(ym2413Instrument === undefined ? {} : {
                ym2413Instrument,
                ym2413CarrierMultiple: this.ym2413CarrierMultiple(state),
                ym2413Volume: state.volume,
            }),
            ...(specialMatch ? { specialOperator: Number(specialMatch[1]) } : {}),
            ...(opnCh3Mode === undefined ? {} : { opnCh3Mode }),
        };
    }
    /** 発音中のFMトラックへ、レジスタ変更後の音色スナップショットを追記する。 */
    recordFMTimbreEvent(key, currentTime, source) {
        const state = this.channels.get(key);
        if (!state?.active)
            return;
        const descriptor = this.resolveDescriptor(key);
        const trackState = this.tracks.get(descriptor.id);
        if (!trackState)
            return;
        const timbre = this.fmTimbreForDescriptor(descriptor);
        if (!timbre)
            return;
        const events = trackState.fmEvents;
        const prior = events && events.length > 0
            ? events[events.length - 1].timbre
            : trackState.fmTimbre;
        if (JSON.stringify(prior) === JSON.stringify(timbre))
            return;
        trackState.fmEvents ?? (trackState.fmEvents = []);
        trackState.fmEvents.push({ sampleTime: currentTime, source, timbre });
    }
    /** 発音後のYM2413音色状態をsidecarの時系列イベントへ追記する。 */
    recordYM2413TimbreEvent(channel, currentTime, source) {
        const key = `ym2413_${channel}`;
        this.recordFMTimbreEvent(key, currentTime, source);
    }
    /** OPN Ch3 Special時は親と発音中のオペレータ別トラックをまとめて更新する。 */
    recordOPNTimbreEvents(keyPrefix, channel, currentTime) {
        const parentKey = keyPrefix === 'ym2612'
            ? `${keyPrefix}_${channel}`
            : `${keyPrefix}_fm_${channel}`;
        this.recordFMTimbreEvent(parentKey, currentTime, 'opn-timbre');
        if (channel !== 2)
            return;
        const match = /^(ym2203|ym2608)_(\d+)$/.exec(keyPrefix);
        const context = keyPrefix === 'ym2612'
            ? this.opnCh3Context('YM2612')
            : match
                ? this.opnCh3Context(match[1], Number(match[2]))
                : undefined;
        if (!context || !this.isOPNCh3SpecialMode(context))
            return;
        for (const key of context.operatorKeys) {
            if (key !== parentKey)
                this.recordFMTimbreEvent(key, currentTime, 'opn-timbre');
        }
    }
    /** PCMトラックの循環しない元サンプルIDとMIDIノートの対応をsidecar向けに返す。 */
    pcmMetadataForTrack(state) {
        if (state.pcmEvents === undefined)
            return undefined;
        const sourceKey = state.descriptor.sourceKey;
        const gmNote = this.pcmSampleNotes.get(sourceKey);
        const events = state.pcmEvents.map(event => ({ ...event }));
        const dataBlock = state.pcmDataBlock === undefined ? {} : { dataBlock: state.pcmDataBlock };
        if (sourceKey.startsWith('ym2612dac_sample_')) {
            return {
                source: 'ym2612-dac', sampleId: sourceKey.slice('ym2612dac_sample_'.length), gmNote, events, ...dataBlock,
            };
        }
        if (sourceKey === 'ym2612dac_direct_stream') {
            return { source: 'ym2612-dac-direct', sampleId: 'direct-stream', gmNote, events, ...dataBlock };
        }
        const adpcmMatch = /^ym2608_\d+_adpcmb_sample_(.+)$/.exec(sourceKey);
        if (adpcmMatch)
            return { source: 'ym2608-adpcm-b', sampleId: adpcmMatch[1], gmNote, events, ...dataBlock };
        if (sourceKey.startsWith('segapcm_sample_')) {
            return { source: 'segapcm', sampleId: sourceKey.slice('segapcm_sample_'.length), gmNote, events, ...dataBlock };
        }
        if (sourceKey.startsWith('c140_sample_')) {
            return { source: 'c140', sampleId: sourceKey.slice('c140_sample_'.length), gmNote, events, ...dataBlock };
        }
        if (sourceKey.startsWith('msm6258_sample_')) {
            return { source: 'msm6258', sampleId: sourceKey.slice('msm6258_sample_'.length), gmNote, events, ...dataBlock };
        }
        return undefined;
    }
    getTrack(key) {
        const descriptor = this.resolveDescriptor(key);
        const storageKey = descriptor.id;
        if (!this.tracks.has(storageKey)) {
            const track = new midi_writer_js_1.default.Track();
            track.setTempo(this.options.tempo);
            const sourceKey = descriptor.sourceKey;
            key = sourceKey;
            const fmTimbre = this.fmTimbreForDescriptor(descriptor);
            // Add track name/instrument based on key
            if (key.startsWith('huc6280_'))
                track.addTrackName(this.huc6280TrackName(key));
            else if (key.startsWith('psg_noise_'))
                track.addTrackName('SN76489 Noise ' + key.split('_')[2]);
            else if (key.startsWith('ym2151_noise_'))
                track.addTrackName('YM2151 Noise ' + key.split('_')[2]);
            else if (key.startsWith('ay8910_'))
                track.addTrackName(this.ay8910TrackName(key));
            else if (key.includes('_ch3perc_'))
                track.addTrackName(this.opnCh3PercussionTrackName(key));
            else if (key.includes('_ch3sp_'))
                track.addTrackName(this.opnCh3SpecialTrackName(key));
            else if (key.startsWith('ym2203_'))
                track.addTrackName(this.ym2203TrackName(key));
            else if (key.startsWith('ym2608_'))
                track.addTrackName(this.ym2608TrackName(key));
            else if (this.isOPLKey(key))
                track.addTrackName(this.oplTrackName(key));
            else if (key.startsWith('ym2612dac_sample_'))
                track.addTrackName(this.formatPCMTrackName(key, 'YM2612 DAC'));
            else if (key === 'ym2612dac_direct_stream')
                track.addTrackName('YM2612 DAC Direct');
            else if (key.startsWith('segapcm_sample_'))
                track.addTrackName(this.formatPCMTrackName(key, 'SegaPCM'));
            else if (key.startsWith('c140_sample_'))
                track.addTrackName(this.formatPCMTrackName(key, 'C140'));
            else if (key.startsWith('msm6258_sample_'))
                track.addTrackName(this.formatPCMTrackName(key, 'MSM6258 Trigger'));
            else if (key.includes('psg'))
                track.addTrackName('SN76489 PSG ' + key.split('_')[1]);
            else if (key.includes('ym2612'))
                track.addTrackName('YM2612 FM ' + key.split('_')[1]);
            else if (key.includes('ym2151'))
                track.addTrackName('YM2151 FM ' + key.split('_')[1]);
            else if (key.startsWith('ym2413_rhythm_'))
                track.addTrackName('YM2413 Rhythm ' + YM2413_RHYTHM_NAMES[parseInt(key.split('_')[2])]);
            else if (key.startsWith('ym2413_'))
                track.addTrackName('YM2413 FM ' + key.split('_')[1]);
            else if (key.startsWith('gbdmg_noise_'))
                track.addTrackName('GameBoy DMG Noise');
            else if (key === 'gbdmg_2')
                track.addTrackName('GameBoy DMG Wave');
            else if (key.startsWith('gbdmg_'))
                track.addTrackName('GameBoy DMG Square ' + key.split('_')[1]);
            // ProgramChangeEvent's channel is 0-based, same as PitchBendEvent (see the
            // noteOn()/updateNotePitch() comments on that).
            if (!this.isPercussionKey(key)) {
                track.addEvent(new midi_writer_js_1.default.ProgramChangeEvent({
                    instrument: fmTimbre?.suggestedProgram ?? GM_PROGRAM_LEAD_1_SQUARE,
                    channel: descriptor.midiChannel - 1,
                }));
            }
            if (this.isWidePitchBendFMKey(key)) {
                const range = this.pitchBendRangeForKey(key);
                this.addPitchBendRange(track, descriptor.midiChannel, range);
            }
            // VGM Extra Headerが報告するチップ別ミックスバランス（マルチチップVGMの
            // 音量差）をトラック先頭のCC7として出力する。miditrack側のトラック音量
            // スライダーが初期値としてこれを採用する（miditrack/CLAUDE.md参照）。
            // ControllerChangeEventのchannelは1-based（ProgramChangeEvent/
            // PitchBendEventとは異なる。addPitchBendRange()と同じ扱い）。
            const chipVolumePercent = this.extraHeaderVolumePercent(descriptor.chip, descriptor.instance);
            if (chipVolumePercent !== undefined && chipVolumePercent !== 100) {
                track.addEvent(new midi_writer_js_1.default.ControllerChangeEvent({
                    controllerNumber: 7,
                    controllerValue: chipVolumePercent,
                    channel: descriptor.midiChannel,
                    delta: 0,
                }));
            }
            this.tracks.set(storageKey, { descriptor, track, cursor: 0, expression: 127, fmTimbre });
        }
        return this.tracks.get(storageKey);
    }
    isPercussionKey(key) {
        return key.includes('_noise_')
            || key.startsWith('ym2612dac_sample_')
            || key === 'ym2612dac_direct_stream'
            || key.includes('_ch3perc_')
            || key.includes('_rhythm_')
            || key.includes('_adpcmb_')
            || key.startsWith('segapcm_sample_')
            || key.startsWith('c140_sample_')
            || key.startsWith('msm6258_sample_');
    }
    isWidePitchBendFMKey(key) {
        return this.isYM2151FMKey(key)
            || this.isOPLFMKey(key)
            || ((key.startsWith('ym2203_') || key.startsWith('ym2608_')) && key.includes('_fm_'))
            || key.startsWith('psg_') || key.startsWith('ay8910_') || key.startsWith('huc6280_')
            || key.startsWith('gbdmg_') || key.includes('_ssg_');
    }
    isYM2151FMKey(key) {
        return key.startsWith('ym2151_') && !key.startsWith('ym2151_noise_');
    }
    isOPLKey(key) {
        return key.startsWith('ym3812_') || key.startsWith('ym3526_') || key.startsWith('y8950_');
    }
    isOPLFMKey(key) {
        return this.isOPLKey(key) && key.includes('_fm_') && !key.includes('_rhythm_');
    }
    pitchBendRangeForKey(key) {
        if (this.isYM2151FMKey(key))
            return YM2151_FM_PITCH_BEND_RANGE;
        if (this.isOPLFMKey(key))
            return OPL_FM_PITCH_BEND_RANGE;
        if (key.startsWith('ym2608_') && key.includes('_fm_'))
            return YM2608_FM_PITCH_BEND_RANGE;
        if (key.startsWith('ym2203_') && key.includes('_fm_'))
            return YM2203_FM_PITCH_BEND_RANGE;
        if (key.startsWith('psg_') || key.startsWith('ay8910_') || key.startsWith('huc6280_') || key.startsWith('gbdmg_') || key.includes('_ssg_'))
            return CHIP_PITCH_BEND_RANGE;
        return 2;
    }
    addPitchBendRange(track, midiChannel, semitones) {
        for (const [controllerNumber, controllerValue] of [
            [101, 0],
            [100, 0],
            [6, semitones],
            [38, 0],
            [101, 127],
            [100, 127],
        ]) {
            track.addEvent(new midi_writer_js_1.default.ControllerChangeEvent({
                controllerNumber,
                controllerValue,
                channel: midiChannel,
                delta: 0,
            }));
        }
    }
    formatPCMTrackName(key, chipName) {
        const sampleId = key.startsWith('msm6258_sample_')
            ? key.slice('msm6258_sample_'.length).toUpperCase()
            : key.split('_')[2].toUpperCase();
        const note = this.pcmSampleNotes.get(key);
        return `${chipName} Sample 0x${sampleId} (GM ${note ?? '?'})`;
    }
    ym2203MidiChannel(key) {
        const [, instanceText, section, channelText] = key.split('_');
        const instance = parseInt(instanceText);
        const channel = parseInt(channelText);
        if (instance === 0)
            return section === 'fm' ? channel + 1 : channel + 4;
        return section === 'fm' ? channel + 7 : channel + 11;
    }
    oplMidiChannel(key) {
        const [, instanceText, , channelText] = key.split('_');
        const instance = parseInt(instanceText);
        const channel = parseInt(channelText);
        return instance === 0 ? channel + 1 : ((10 + channel) % 16) + 1;
    }
    oplTrackName(key) {
        const [prefix, instanceText, section, channelText] = key.split('_');
        const chip = OPL_DISPLAY_NAMES[prefix.toUpperCase()];
        const suffix = instanceText === '0' ? '' : ' #2';
        if (section === 'rhythm') {
            return `${chip}${suffix} Rhythm ${OPL_RHYTHM_NAMES[parseInt(channelText)]}`;
        }
        return `${chip}${suffix} FM ${channelText}`;
    }
    ay8910MidiChannel(key) {
        const parts = key.split('_');
        const instance = parseInt(parts[1]);
        const channel = parseInt(parts[parts.length - 1]);
        return instance === 0 ? channel + 11 : channel + 14;
    }
    ay8910TrackName(key) {
        const parts = key.split('_');
        const suffix = parts[1] === '0' ? '' : ' #2';
        const channel = parts[parts.length - 1];
        return key.includes('_noise_')
            ? `AY-3-8910${suffix} Noise ${channel}`
            : `AY-3-8910${suffix} ${channel}`;
    }
    huc6280MidiChannel(key) {
        const parts = key.split('_');
        const instance = parseInt(parts[1]);
        const channel = parseInt(parts[parts.length - 1]);
        return instance === 0 ? ((14 + channel - 1) % 16) + 1 : channel + 4;
    }
    huc6280TrackName(key) {
        const parts = key.split('_');
        const suffix = parts[1] === '0' ? '' : ' #2';
        const channel = parts[parts.length - 1];
        return key.includes('_noise_')
            ? `HuC6280${suffix} Noise ${channel}`
            : `HuC6280${suffix} PSG ${channel}`;
    }
    ym2203TrackName(key) {
        const parts = key.split('_');
        const [, instanceText, section] = parts;
        const channelText = parts[parts.length - 1];
        const chipSuffix = instanceText === '0' ? '' : ' #2';
        const sectionName = section === 'fm' ? 'FM' : 'SSG';
        if (key.includes('_noise_'))
            return `YM2203${chipSuffix} SSG Noise ${channelText}`;
        return `YM2203${chipSuffix} ${sectionName} ${channelText}`;
    }
    opnCh3DisplayNameForKey(key) {
        const parts = key.split('_');
        const chip = parts[0].toUpperCase();
        if (chip === 'YM2612')
            return chip;
        return `${chip}${parts[1] === '0' ? '' : ' #2'}`;
    }
    opnCh3SpecialTrackName(key) {
        const parts = key.split('_');
        return `${this.opnCh3DisplayNameForKey(key)} Ch3 Special Op${parts[parts.length - 1]}`;
    }
    opnCh3PercussionTrackName(key) {
        const note = parseInt(key.split('_ch3perc_')[1]);
        const name = OPN_CH3_PERCUSSION_NAMES.get(note) ?? 'Percussion';
        return `${this.opnCh3DisplayNameForKey(key)} Ch3 Special ${name} (GM ${note})`;
    }
    ym2608MidiChannel(key) {
        const [, instanceText, section, channelText] = key.split('_');
        const instance = parseInt(instanceText);
        const channel = parseInt(channelText);
        if (instance === 0)
            return section === 'fm' ? channel + 1 : channel + 7;
        return section === 'fm' ? channel + 11 : channel + 1;
    }
    ym2608TrackName(key) {
        const parts = key.split('_');
        const instance = parseInt(parts[1]);
        const suffix = instance === 0 ? '' : ' #2';
        if (key.includes('_rhythm_')) {
            const channel = parseInt(parts[parts.length - 1]);
            return `YM2608${suffix} Rhythm ${YM2608_RHYTHM_NAMES[channel]}`;
        }
        if (key.includes('_adpcmb_')) {
            const sampleId = parts[parts.length - 1].toUpperCase();
            return `YM2608${suffix} ADPCM-B Sample 0x${sampleId}`;
        }
        const sectionName = parts[2] === 'fm' ? 'FM' : 'SSG';
        const channel = parts[parts.length - 1];
        if (key.includes('_noise_'))
            return `YM2608${suffix} SSG Noise ${channel}`;
        return `YM2608${suffix} ${sectionName} ${channel}`;
    }
    frequencyToMidiNote(frequency) {
        if (frequency <= 20)
            return 0; // Filter out very low frequencies
        // MIDI note = 69 + 12 * log2(freq / 440)
        const note = Math.round(69 + 12 * Math.log2(frequency / 440));
        return Math.max(0, Math.min(127, note));
    }
    frequencyToExactMidi(frequency) {
        if (frequency <= 20)
            return 0;
        return 69 + 12 * Math.log2(frequency / 440);
    }
    psgRegisterToFrequency(register, clockRate, flags) {
        const effectiveRegister = register === 0 && (flags & 0x01) !== 0 ? 0x400 : register;
        if (effectiveRegister === 0)
            return 0;
        // VGM header bit 30 (dual-chip) and bit 31 (T6W28) are flags, not part of the clock
        // value itself — mask them out the same way the OPN/OPNA/YM2151 clock reads already do.
        const effectiveClockRate = clockRate & 0x3FFFFFFF;
        // The usual SN76489 /8 input divider is enabled when flag bit 3 is clear.
        const divisor = (flags & 0x08) === 0 ? 32 : 4;
        return effectiveClockRate / (divisor * effectiveRegister);
    }
    ym2612FrequencyToHz(fnum, block, clockRate) {
        if (fnum === 0)
            return 0;
        // YM2612 frequency = (fnum * clock) / (144 * 2^(20 - block))
        // Note: clock is usually ~7.6MHz. Formula assumes FM clock.
        // If block is undefined, treat as 0
        const blk = block || 0;
        const effectiveClockRate = clockRate & 0x3FFFFFFF;
        return (fnum * effectiveClockRate) / (144 * Math.pow(2, 20 - blk));
    }
    ym2203FrequencyToHz(fnum, block, clockRate, prescaler) {
        if (fnum === 0)
            return 0;
        const effectiveClockRate = clockRate & 0x3FFFFFFF;
        // YM2203 OPN F-Number uses a 144 divisor at the default /6 prescale.
        return (fnum * effectiveClockRate) / ((24 * prescaler) * Math.pow(2, 20 - block));
    }
    oplFrequencyToHz(fnum, block, clockRate) {
        if (fnum === 0)
            return 0;
        const effectiveClockRate = clockRate & vgm_chip_metadata_1.CLOCK_MASK;
        return (fnum * effectiveClockRate) / (72 * Math.pow(2, 20 - block));
    }
    ay8910RegisterToFrequency(register, clockRate, flags) {
        // Period 0 behaves like 1 in hardware, but that tone is ultrasonic at normal clocks
        // and cannot be represented faithfully in MIDI; do not clamp it to audible note 127.
        if (register === 0)
            return 0;
        const baseClockRate = clockRate & 0x3FFFFFFF;
        const effectiveClockRate = (flags & 0x10) !== 0 ? baseClockRate / 2 : baseClockRate;
        // AY-3-8910 frequency = clock / (16 * register)
        return effectiveClockRate / (16 * register);
    }
    ym2203SSGRegisterToFrequency(register, clockRate, prescaler, flags) {
        // See ay8910RegisterToFrequency(): the real period-1 equivalent is ultrasonic.
        if (register === 0)
            return 0;
        const baseClockRate = clockRate & 0x3FFFFFFF;
        const effectiveClockRate = (flags & 0x10) !== 0 ? baseClockRate / 2 : baseClockRate;
        // The integrated SSG uses master clock / (64 * period) at the default /6 prescale.
        return (effectiveClockRate * (6 / prescaler)) / (64 * register);
    }
    huc6280RegisterToFrequency(register, clockRate) {
        // HuC6280 PSG: a 12-bit period register drives a 32-step waveform table.
        // A period of 0 behaves like the maximum period (0x1000) on real hardware.
        const period = register || 0x1000;
        const effectiveClockRate = clockRate & 0x3FFFFFFF;
        return effectiveClockRate / (32 * period);
    }
    // YM2413 (OPLL): a 9-bit F-Number combined with a 3-bit block, phase-accumulated at
    // clock/72 (confirmed against emu2413's calc_phase(): with PM/vibrato disabled and a
    // Multiple of 1 (the carrier's implicit reference rate), the per-sample phase step
    // reduces to fnum << block over a 19-bit accumulator, at an output rate of clock/72 —
    // giving freq = fnum * clock / (72 * 2^(19-block)). The caller applies carrier Multiple
    // only when it is an exact power of two, avoiding fabricated correction for 3, 5, 10,
    // 12, or 15.
    ym2413RegisterToFrequency(fnum, block, clockRate) {
        const effectiveClockRate = clockRate & vgm_chip_metadata_1.CLOCK_MASK;
        if (effectiveClockRate <= 0)
            return 0;
        return (fnum * effectiveClockRate) / (72 * Math.pow(2, 19 - block));
    }
    /** 選択patchのcarrier Multipleを、明確な2の累乗だけoctave補正に変換する。 */
    ym2413PitchScale(state) {
        const instrument = state.ym2413Instrument ?? 0;
        const multipleNibble = instrument === 0
            ? (this.hasYM2413CustomCarrierMultiple ? this.ym2413CustomPatch[1] & 0x0F : 1)
            : exports.YM2413_BUILTIN_CARRIER_MULTIPLES[instrument] ?? 1;
        const multiple = YM2413_OPERATOR_MULTIPLES[multipleNibble] ?? 1;
        return Number.isInteger(Math.log2(multiple)) ? multiple : 1;
    }
    // Game Boy DMG pulse channels (1-2): an 11-bit period register x drives a phase
    // accumulator that wraps every (2048-x) input-clock cycles, divided by 32 to reach the
    // final tone frequency — confirmed against Pan Docs' "Frequency = 131072/(2048-x)" at the
    // chip's fixed 4194304Hz clock (131072 = 4194304/32); this generalizes that to an
    // explicit clock parameter rather than hardcoding the reference value.
    gbDmgSquareFrequencyToHz(period, clockRate) {
        const effectiveClockRate = clockRate & vgm_chip_metadata_1.CLOCK_MASK;
        if (effectiveClockRate <= 0 || period >= 2048)
            return 0;
        return effectiveClockRate / (32 * (2048 - period));
    }
    // Game Boy DMG wave channel (3): same 11-bit period/phase-accumulator shape as the pulse
    // channels, but divided by 64 instead of 32 — the wave channel steps through all 32
    // 4-bit wave-RAM samples per period instead of one square edge, doubling the reference
    // rate (Pan Docs: "Frequency = 65536/(2048-x)"; 65536 = 4194304/64).
    gbDmgWaveFrequencyToHz(period, clockRate) {
        const effectiveClockRate = clockRate & vgm_chip_metadata_1.CLOCK_MASK;
        if (effectiveClockRate <= 0 || period >= 2048)
            return 0;
        return effectiveClockRate / (64 * (2048 - period));
    }
    // Game Boy DMG noise channel (4): NR43 packs a 4-bit shift `s` and a 3-bit divisor code
    // `r` (r=0 means divisor 0.5, matching the "For r=0 assume r=0.5" rule in Pan Docs'
    // "Frequency = 524288/r/2^(s+1)" at the chip's fixed clock; 524288 = 4194304/8).
    gbDmgNoiseFrequencyToHz(nr43, clockRate) {
        const effectiveClockRate = clockRate & vgm_chip_metadata_1.CLOCK_MASK;
        if (effectiveClockRate <= 0)
            return 0;
        const shift = (nr43 >> 4) & 0x0F;
        const divisorCode = nr43 & 0x07;
        const divisor = divisorCode === 0 ? 0.5 : divisorCode;
        return effectiveClockRate / (8 * divisor * Math.pow(2, shift + 1));
    }
    // Maps NR43's raw byte to a GM drum band via the shared noiseDrumNote() helper. The
    // chip's actual audible range is far wider than the other chips' noise generators (a few
    // Hz up to several hundred kHz), so this clamps to an approximate audible band before
    // taking the same log-scale normalization SN76489's noise handling uses, rather than
    // normalizing against the raw register range the way HuC6280/YM2151 do (their registers
    // already map roughly linearly to perceived rate; NR43's shift/divisor combination does
    // not). Width mode (NR43 bit3, 15-bit vs. 7-bit LFSR — a timbre distinction, "metallic"
    // vs. "white") is intentionally not mapped to a different drum note, consistent with how
    // every other chip's noise mode/LFSR-width control is collapsed to one portable GM voice
    // in this file (see "Hardware-noise conversion" in CLAUDE.md).
    gbDmgNoiseNoteForPeriod(nr43, clockRate) {
        const freq = this.gbDmgNoiseFrequencyToHz(nr43, clockRate);
        const clamped = Math.max(30, Math.min(15000, freq || 30));
        const normalizedRate = Math.log2(clamped / 30) / Math.log2(15000 / 30);
        return noiseDrumNote(normalizedRate, false);
    }
    samplesToTicks(samples, tempo) {
        // Convert VGM samples to MIDI ticks
        // VGM is at 44100 Hz
        // Absolute sample time prevents rounding error accumulating across events.
        const ppq = MIDI_PPQ;
        const seconds = samples / this.sampleRate;
        const quarterNotes = (seconds * tempo) / 60;
        return Math.round(quarterNotes * ppq);
    }
    convert() {
        let currentTime = 0;
        const activeNotes = new DescriptorActiveNotes(key => this.resolveDescriptor(key).id);
        this.tracks.clear(); // Reset tracks
        this.descriptors.clear();
        this.warnings = [];
        this.activeMidiDescriptors.clear();
        this.activePCMNotes.clear();
        this.channels = this.cloneChannels(this.initialChannels);
        this.generatedNoteCount = 0;
        this.lastLatchedChannel = 0;
        this.gameGearStereo = 0xFF;
        this.segaPCMRegisters.fill(0xFF);
        this.c140Registers.fill(0);
        this.segaPCMActiveVoices.fill(undefined);
        this.c140ActiveVoices.fill(undefined);
        this.pcmSampleNotes.clear();
        this.isYM2612DACEnabled = false;
        this.ym2612DACPendingAddress = undefined;
        this.ym2612DACActiveVoice = undefined;
        this.ym2612DirectDACActiveVoice = undefined;
        this.ym2612DirectDACLastWriteTime = undefined;
        this.opnCh3SpecialModes.clear();
        this.opnCh3PercussionActiveKeys.clear();
        this.opnCsmTimers.clear();
        this.opmCsmTimers.clear();
        this.oplRhythmModes.clear();
        this.oplRhythmControlBytes.clear();
        this.ym2413RhythmMode = false;
        this.ym2413RhythmControlByte = 0;
        this.ym2413RhythmVolumes = [0, 0, 0, 0, 0];
        this.ym2413CustomPatch.fill(0);
        this.hasYM2413CustomCarrierMultiple = false;
        this.ssgNoisePeriods.clear();
        this.pcmChannel10Pan = undefined;
        this.ym2203Prescalers = [6, 6];
        this.ym2608Prescalers = [6, 6];
        this.ym2608RhythmTotalLevels = [0, 0];
        this.ym2608RhythmInstrumentLevels = [new Array(6).fill(0), new Array(6).fill(0)];
        this.ym2608ADPCMActiveVoices.fill(undefined);
        this.huc6280SelectedChannels = [0, 0];
        this.huc6280GlobalBalance = [0xFF, 0xFF];
        this.gbDmgMasterVolume = 0x77;
        this.gbDmgStereoRouting = 0xFF;
        this.gbDmgFrameSteps = [0, 0];
        this.gbDmgNextFrameSamples = [GBDMG_FRAME_SAMPLES, GBDMG_FRAME_SAMPLES];
        this.streams.clear();
        this.activeChipInstance = undefined;
        for (const chip of this.secondaryChipStates.keys()) {
            this.secondaryChipStates.set(chip, {
                channels: this.cloneChannels(this.initialChannels),
                scalars: this.captureChipScalars(chip),
            });
        }
        for (const registers of this.ym2608ADPCMRegisters) {
            registers.fill(0);
        }
        // Process commands
        // Pass index to handlers for look-ahead
        for (let i = 0; i < this.vgmData.commands.length; i++) {
            const cmd = this.vgmData.commands[i];
            if (cmd.type === 'wait' && cmd.samples) {
                this.advanceCSMTimers(currentTime, currentTime + cmd.samples, activeNotes);
                currentTime += cmd.samples;
                this.advanceGBDMGFrameSequencers(currentTime, activeNotes);
            }
            else if (cmd.type === 'pcm_seek' && cmd.chip === 'YM2612') {
                this.handleYM2612DACSeek(cmd);
            }
            else if (cmd.type === 'pcm_write' && cmd.chip === 'YM2612') {
                this.handleYM2612DACWrite(currentTime);
                const samples = cmd.samples ?? 0;
                this.advanceCSMTimers(currentTime, currentTime + samples, activeNotes);
                currentTime += samples;
            }
            else if (cmd.type.startsWith('stream_')) {
                this.handleStreamCommand(cmd, currentTime);
            }
            else if (cmd.type === 'end') {
                break;
            }
            else if (cmd.type === 'psg_write' && cmd.data !== undefined) {
                // SN76489 PSG
                this.withChipInstance('SN76489', cmd.instance ?? 0, () => {
                    this.handlePSGWrite(cmd.data, currentTime, activeNotes, i);
                });
            }
            else if (cmd.type === 'psg_stereo' && cmd.data !== undefined) {
                this.withChipInstance('SN76489', cmd.instance ?? 0, () => this.handleGameGearStereo(cmd.data, currentTime));
            }
            else if (cmd.type === 'ay_stereo' && cmd.data !== undefined && cmd.chip !== undefined) {
                this.handleAYSSGStereo(cmd.chip, cmd.instance ?? 0, cmd.data, currentTime);
            }
            else if (cmd.type === 'chip_write') {
                this.withChipInstance(cmd.chip ?? 'unknown', cmd.instance ?? 0, () => {
                    // Handle other chips.  Every handler sees only the selected instance's state.
                    if (cmd.chip === 'YM2612')
                        this.handleYM2612Write(cmd, currentTime, activeNotes, i);
                    else if (cmd.chip === 'YM2203')
                        this.handleYM2203Write(cmd, currentTime, activeNotes, i);
                    else if (cmd.chip === 'YM2608')
                        this.handleYM2608Write(cmd, currentTime, activeNotes, i);
                    else if (OPL_CHIPS.includes(cmd.chip))
                        this.handleOPLWrite(cmd, currentTime, activeNotes, i);
                    else if (cmd.chip === 'YM2151')
                        this.handleYM2151Write(cmd, currentTime, activeNotes);
                    else if (cmd.chip === 'AY8910')
                        this.handleAY8910Write(cmd, currentTime, activeNotes, i);
                    else if (cmd.chip === 'HuC6280')
                        this.handleHuC6280Write(cmd, currentTime, activeNotes, i);
                    else if (cmd.chip === 'SegaPCM')
                        this.handleSegaPCMWrite(cmd, currentTime);
                    else if (cmd.chip === 'C140')
                        this.handleC140Write(cmd, currentTime);
                    else if (cmd.chip === 'YM2413')
                        this.handleYM2413Write(cmd, currentTime, activeNotes, i);
                    else if (cmd.chip === 'GBDMG')
                        this.handleGBDMGWrite(cmd, currentTime, activeNotes, i);
                });
            }
        }
        this.stopAllPCMVoices(currentTime);
        // Turn off any remaining notes
        for (const descriptorId of [...activeNotes.keys()]) {
            this.noteOff(descriptorId, 0, currentTime, activeNotes);
        }
        return Array.from(this.tracks.values()).map(t => t.track);
    }
    // --- Chip Handling Logic ---
    /** Game Gear $4F のLRルーティングをSN76489各voiceのCC10へ反映する。 */
    handleGameGearStereo(data, currentTime) {
        this.gameGearStereo = data;
        for (let channel = 0; channel < 4; channel++) {
            this.addPan(`psg_${channel}`, (data & (1 << channel)) !== 0, (data & (1 << (channel + 4))) !== 0, currentTime);
        }
    }
    /** VGM $31 のAY/OPN SSG LR maskを各SSG voiceのCC10へ変換する。 */
    handleAYSSGStereo(chip, instance, data, currentTime) {
        const keyPrefix = chip === 'AY8910'
            ? `ay8910_${instance}`
            : chip === 'YM2203'
                ? `ym2203_${instance}_ssg`
                : chip === 'YM2608'
                    ? `ym2608_${instance}_ssg`
                    : undefined;
        if (!keyPrefix)
            return;
        for (let channel = 0; channel < 3; channel++) {
            const hasRight = (data & (1 << (channel * 2))) !== 0;
            const hasLeft = (data & (1 << (channel * 2 + 1))) !== 0;
            this.addPan(`${keyPrefix}_${channel}`, hasLeft, hasRight, currentTime);
        }
    }
    handlePSGWrite(data, currentTime, activeNotes, cmdIndex) {
        if ((data & 0x80) === 0x80) {
            // Latch/Data byte
            const channel = (data >> 5) & 0x03;
            const type = (data >> 4) & 0x01;
            const nibble = data & 0x0F;
            this.lastLatchedChannel = channel;
            if (type === 0) {
                // Tone register - lower 4 bits
                if (channel < 3) {
                    const key = `psg_${channel}`;
                    const state = this.channels.get(key);
                    const oldFreq = state.frequency;
                    // Peek ahead check for split-byte updates
                    let isMultiByteUpdate = false;
                    for (let k = cmdIndex + 1; k < this.vgmData.commands.length; k++) {
                        const next = this.vgmData.commands[k];
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
                            this.updateNotePitch(key, channel, currentTime, activeNotes);
                        }
                        // NF=3 makes the noise generator track this channel's own tone frequency, so
                        // a change here can move the noise's effective pitch even if this channel's
                        // own tone isn't currently active.
                        if (channel === 2) {
                            this.reevaluateSN76489NoiseForChannel2Frequency(currentTime, activeNotes);
                        }
                    }
                }
                else {
                    this.handleSN76489NoiseControl(nibble, currentTime, activeNotes);
                }
            }
            else {
                // Volume register
                const key = `psg_${channel}`;
                const state = this.channels.get(key);
                const oldVolume = state.volume;
                state.volume = nibble;
                if (channel < 3) {
                    const wasOff = oldVolume === 0x0F;
                    const isOff = nibble === 0x0F;
                    if (wasOff && !isOff) {
                        // Note ON
                        state.active = true;
                        this.noteOn(key, channel, currentTime, activeNotes);
                    }
                    else if (!wasOff && isOff) {
                        // Note OFF
                        state.active = false;
                        this.noteOff(key, channel, currentTime, activeNotes);
                    }
                    else if (!isOff && state.active && oldVolume !== nibble) {
                        // Volume change while active -> Send Expression (CC 11)
                        const expression = Math.max(0, Math.min(127, 127 - (state.volume * 8)));
                        const trackState = this.getTrack(key);
                        const currentTick = this.samplesToTicks(currentTime, this.options.tempo);
                        const gap = Math.max(0, currentTick - trackState.cursor);
                        const midiCh = this.midiChannelForKey(key);
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
                    this.syncSN76489NoiseVolume(oldVolume, currentTime, activeNotes);
                }
            }
        }
        else {
            // Data byte - upper 6 bits of tone frequency
            const dataBits = data & 0x3F;
            const channel = this.lastLatchedChannel;
            if (channel < 3) {
                const key = `psg_${channel}`;
                const state = this.channels.get(key);
                const oldFreq = state.frequency;
                // Set upper 6 bits, keep lower 4 bits
                state.frequency = (dataBits << 4) | (state.frequency & 0x0F);
                if (state.frequency !== oldFreq) {
                    if (state.active) {
                        this.updateNotePitch(key, channel, currentTime, activeNotes);
                    }
                    if (channel === 2) {
                        this.reevaluateSN76489NoiseForChannel2Frequency(currentTime, activeNotes);
                    }
                }
            }
        }
    }
    handleSN76489NoiseControl(data, currentTime, activeNotes) {
        const state = this.channels.get('psg_3');
        state.frequency = data & 0x07;
        if (state.volume === 0x0F)
            return;
        if (this.options.suppressHardwareNoise)
            return;
        const noiseKey = 'psg_noise_3';
        if (state.isNoiseActive)
            this.noteOff(noiseKey, 3, currentTime, activeNotes);
        state.isNoiseActive = true;
        this.noteOnPercussion(noiseKey, this.sn76489Velocity(state.volume), currentTime, activeNotes, this.sn76489NoiseNote());
    }
    syncSN76489NoiseVolume(oldVolume, currentTime, activeNotes) {
        const state = this.channels.get('psg_3');
        if (this.options.suppressHardwareNoise)
            return;
        const noiseKey = 'psg_noise_3';
        const shouldSound = state.volume !== 0x0F;
        if (shouldSound && !state.isNoiseActive) {
            state.isNoiseActive = true;
            this.noteOnPercussion(noiseKey, this.sn76489Velocity(state.volume), currentTime, activeNotes, this.sn76489NoiseNote());
        }
        else if (!shouldSound && state.isNoiseActive) {
            state.isNoiseActive = false;
            this.noteOff(noiseKey, 3, currentTime, activeNotes);
        }
        else if (shouldSound && oldVolume !== state.volume) {
            this.addExpression(noiseKey, this.sn76489Expression(state.volume), currentTime);
        }
    }
    sn76489Velocity(volume) {
        return Math.max(1, Math.round(((15 - volume) / 15) * 100));
    }
    sn76489Expression(volume) {
        return Math.max(0, Math.round(((15 - volume) / 15) * 127));
    }
    // psg_3's `frequency` field holds the noise control nibble (data & 0x07) rather than an
    // actual tone period — see handleSN76489NoiseControl(). Bit2 = FB (0 = periodic/tonal
    // noise, 1 = white noise), bits0-1 = NF (fixed clock/512, /1024, /2048 divisor select;
    // NF=3 instead follows channel 2's own tone frequency).
    sn76489NoiseNote() {
        const control = this.channels.get('psg_3').frequency;
        const isPeriodic = (control & 0x04) === 0;
        const nf = control & 0x03;
        let normalizedRate;
        if (nf === 3) {
            const toneFreq = this.psgRegisterToFrequency(this.channels.get('psg_2').frequency, this.vgmData.header.sn76489Clock, this.vgmData.header.sn76489Flags);
            const clamped = Math.max(100, Math.min(8000, toneFreq || 100));
            normalizedRate = Math.log2(clamped / 100) / Math.log2(8000 / 100);
        }
        else {
            normalizedRate = [1.0, 0.55, 0.25][nf];
        }
        return noiseDrumNote(normalizedRate, isPeriodic);
    }
    // NF=3 makes the noise generator follow channel 2's own tone frequency, so a change to
    // that channel's period can move the noise's effective pitch even though nothing on
    // channel 3 itself was written. Called from channel 2's tone-frequency write paths.
    reevaluateSN76489NoiseForChannel2Frequency(currentTime, activeNotes) {
        if (this.options.suppressHardwareNoise)
            return;
        const noiseState = this.channels.get('psg_3');
        if (!noiseState.isNoiseActive || (noiseState.frequency & 0x03) !== 3)
            return;
        const noiseKey = 'psg_noise_3';
        const newNote = this.sn76489NoiseNote();
        const active = activeNotes.get(noiseKey);
        if (active === undefined || active.note === newNote)
            return;
        this.noteOff(noiseKey, 3, currentTime, activeNotes);
        this.noteOnPercussion(noiseKey, this.sn76489Velocity(noiseState.volume), currentTime, activeNotes, newNote);
    }
    handleYM2612Write(cmd, currentTime, activeNotes, cmdIndex) {
        if (cmd.register === undefined || cmd.data === undefined || cmd.port === undefined)
            return;
        const port = cmd.port;
        const reg = cmd.register;
        const data = cmd.data;
        const ch3Context = this.opnCh3Context('YM2612');
        if (this.handleOPNPanWrite('ym2612', port, reg, data, currentTime))
            return;
        if (this.handleYM2612TimbreWrite(port, reg, data, currentTime)) {
            return;
        }
        if (port === 0 && reg === 0x27) {
            this.handleOPNCh3ModeWrite(ch3Context, data, currentTime, activeNotes);
            this.updateOPNCsmTimer('YM2612', cmd.instance ?? 0, data, currentTime, activeNotes);
            return;
        }
        if (port === 0 && (reg === 0x24 || reg === 0x25)) {
            this.updateOPNCsmTimerRegister('YM2612', cmd.instance ?? 0, reg, data);
            return;
        }
        if (port === 0 && reg === 0x2B) {
            this.isYM2612DACEnabled = (data & 0x80) !== 0;
            if (!this.isYM2612DACEnabled) {
                this.ym2612DACPendingAddress = undefined;
                this.stopYM2612DACVoice(currentTime);
                this.stopYM2612DirectDACVoice(currentTime);
            }
            return;
        }
        // $2A: direct one-byte-at-a-time DAC output (as opposed to the $E0-seek + $80-8F
        // stream path handled by handleYM2612DACWrite()). Some non-optimized VGM rips drive
        // the DAC this way for drum samples instead of using the stream commands; without
        // this branch those writes silently fell through unhandled and produced no notes at
        // all. See handleYM2612DirectDACWrite() for the grouping heuristic.
        if (port === 0 && reg === 0x2A) {
            this.handleYM2612DirectDACWrite(currentTime);
            return;
        }
        // Key On/Off (0x28) - Port 0 only? The spec says 0x28 is usually on Port 0 but controls all channels
        if (port === 0 && reg === 0x28) {
            const ch = data & 0x07; // 0-2 or 4-6? No, bits 0-2 determine channel within port? 
            // Spec: D0-D2 = Channel (0-2 for Ch1-3, 4-6 for Ch4-6). D4-D7 = Slots.
            // Wait, standard mapping:
            // Ch 0-2: 000, 001, 010
            // Ch 3-5: 100, 101, 110 (Bits 2 is set for Ch 4-6)
            let channelIndex = -1;
            if ((data & 0x03) < 3) { // Valid channel bits 0-1
                if ((data & 0x04) === 0) {
                    channelIndex = data & 0x03; // Ch 1-3 (0-2)
                }
                else {
                    channelIndex = (data & 0x03) + 3; // Ch 4-6 (3-5)
                }
            }
            if (channelIndex === 2 && this.isOPNCh3SpecialMode(ch3Context)) {
                this.handleOPNCh3SpecialKeyWrite(ch3Context, data, currentTime, activeNotes);
                return;
            }
            if (channelIndex !== -1) {
                const key = `ym2612_${channelIndex}`;
                const state = this.channels.get(key);
                state.keyOnMask = (data >> 4) & 0x0F;
                const keyOn = state.keyOnMask !== 0; // Any slot ON
                if (keyOn && !state.active) {
                    state.opnActivePitchScale = this.opnPitchScale(state);
                    state.opnActiveVelocity = this.opnCarrierVelocity(state);
                    state.active = true;
                    this.noteOn(key, channelIndex + 4, currentTime, activeNotes); // offset channel for MIDI
                }
                else if (!keyOn && state.active) {
                    state.active = false;
                    this.noteOff(key, channelIndex + 4, currentTime, activeNotes);
                    state.opnActivePitchScale = 1;
                }
            }
            return;
        }
        // Frequency Registers
        // A0-A2: F-Num LSB
        // A4-A6: Block & F-Num MSB
        let channelOffset = -1;
        if (reg >= 0xA0 && reg <= 0xA2) {
            channelOffset = reg - 0xA0; // 0, 1, 2
        }
        else if (reg >= 0xA4 && reg <= 0xA6) {
            channelOffset = reg - 0xA4; // 0, 1, 2
        }
        if (channelOffset !== -1) {
            const channelIndex = channelOffset + (port * 3); // Port 0 -> 0-2, Port 1 -> 3-5
            const key = `ym2612_${channelIndex}`;
            const state = this.channels.get(key);
            if (reg >= 0xA0 && reg <= 0xA2) {
                // F-Num LSB
                state.freqLSB = data;
            }
            else {
                // Block & F-Num MSB
                state.freqMSB = data & 0x07; // Lower 3 bits
                state.block = (data >> 3) & 0x07; // Bits 3-5
            }
            // Update full frequency/fnum
            const oldFreq = state.frequency;
            state.frequency = ((state.freqMSB || 0) << 8) | (state.freqLSB || 0);
            // If note is active, check for pitch change
            const otherReg = reg <= 0xA2 ? reg + 4 : reg - 4;
            const isSplitUpdate = this.isOPNMultiByteFreqUpdate(cmdIndex, 'YM2612', port, otherReg, cmd.instance ?? 0);
            const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
            state.hasPendingFrequencyUpdate = isSplitUpdate;
            if (state.active && !isSplitUpdate && (state.frequency !== oldFreq || hadPendingUpdate)) {
                this.updateNotePitch(key, channelIndex + 4, currentTime, activeNotes);
            }
            return;
        }
        if (port === 0) {
            this.handleOPNCh3SpecialFrequencyWrite(ch3Context, reg, data, currentTime, activeNotes, cmdIndex);
        }
    }
    isOPNCh3SpecialMode(context) {
        return this.opnCh3SpecialModes.get(context.stateKey) ?? false;
    }
    handleOPNCh3ModeWrite(context, data, currentTime, activeNotes) {
        const isSpecial = (data & 0xC0) !== 0;
        if (isSpecial === this.isOPNCh3SpecialMode(context))
            return;
        const percussionKey = this.opnCh3PercussionActiveKeys.get(context.stateKey);
        if (percussionKey !== undefined)
            this.noteOff(percussionKey, 0, currentTime, activeNotes);
        this.opnCh3PercussionActiveKeys.delete(context.stateKey);
        for (const key of context.operatorKeys) {
            const state = this.channels.get(key);
            if (!state.active)
                continue;
            state.active = false;
            this.noteOff(key, 0, currentTime, activeNotes);
        }
        this.channels.get(context.parentKey).keyOnMask = 0;
        this.opnCsmTimer(context.chip, context.instance).manualKeyOnMask = 0;
        this.opnCh3SpecialModes.set(context.stateKey, isSpecial);
    }
    /** OPN Timer Aの値をCSM schedulerへ反映する。 */
    updateOPNCsmTimerRegister(chip, instance, register, data) {
        const timer = this.opnCsmTimer(chip, instance);
        if (register === 0x24)
            timer.timerHigh = data;
        else
            timer.timerLow = data & 0x03;
    }
    /** OPN $27のCSM有効状態とTimer Aの開始状態を更新する。 */
    updateOPNCsmTimer(chip, instance, data, currentTime, activeNotes) {
        const timer = this.opnCsmTimer(chip, instance);
        const wasActive = timer.isRunning && timer.isCSMEnabled;
        timer.isRunning = (data & 0x01) !== 0;
        timer.isCSMEnabled = (data & 0xC0) === 0x80;
        const isActive = timer.isRunning && timer.isCSMEnabled;
        if (!isActive) {
            if (timer.nextRelease !== undefined)
                this.emitOPNCsmPulse(chip, instance, false, currentTime, activeNotes);
            timer.nextOverflow = undefined;
            timer.nextRelease = undefined;
            return;
        }
        if (!wasActive) {
            timer.nextOverflow = currentTime + this.opnCsmPeriodSamples(chip, timer);
            timer.nextRelease = undefined;
            timer.lastEmittedTick = undefined;
        }
    }
    /** OPM Timer Aの値をCSM schedulerへ反映する。 */
    updateOPMCsmTimerRegister(instance, register, data) {
        const timer = this.opmCsmTimer(instance);
        if (register === 0x10)
            timer.timerHigh = data;
        else
            timer.timerLow = data & 0x03;
    }
    /** OPM $14のCSM有効状態とTimer Aの開始状態を更新する。 */
    updateOPMCsmTimer(instance, data, currentTime, activeNotes) {
        const timer = this.opmCsmTimer(instance);
        const wasActive = timer.isRunning && timer.isCSMEnabled;
        timer.isRunning = (data & 0x01) !== 0;
        timer.isCSMEnabled = (data & 0x80) !== 0;
        const isActive = timer.isRunning && timer.isCSMEnabled;
        if (!isActive) {
            if (timer.nextRelease !== undefined)
                this.emitOPMCsmPulse(instance, false, currentTime, activeNotes);
            timer.nextOverflow = undefined;
            timer.nextRelease = undefined;
            return;
        }
        if (!wasActive) {
            timer.nextOverflow = currentTime + this.opmCsmPeriodSamples(timer);
            timer.nextRelease = undefined;
            timer.lastEmittedTick = undefined;
        }
    }
    /** すべての動作中CSM Timer Aをwait区間内で進める。 */
    advanceCSMTimers(startTime, targetTime, activeNotes) {
        if (targetTime <= startTime)
            return;
        for (const [key, timer] of this.opnCsmTimers) {
            if (!timer.isRunning || !timer.isCSMEnabled)
                continue;
            const [chip, instanceText] = key.split(':');
            const chipInstance = Number(instanceText);
            this.withChipInstance(chip, chipInstance, () => {
                this.advanceCSMTimer(timer, targetTime, this.opnCsmPeriodSamples(chip, timer), time => this.emitOPNCsmPulse(chip, chipInstance, true, time, activeNotes), time => this.emitOPNCsmPulse(chip, chipInstance, false, time, activeNotes));
            });
        }
        for (const [instance, timer] of this.opmCsmTimers) {
            if (!timer.isRunning || !timer.isCSMEnabled)
                continue;
            this.withChipInstance('YM2151', instance, () => {
                this.advanceCSMTimer(timer, targetTime, this.opmCsmPeriodSamples(timer), time => this.emitOPMCsmPulse(instance, true, time, activeNotes), time => this.emitOPMCsmPulse(instance, false, time, activeNotes));
            });
        }
    }
    /** Timer AのoverflowとMIDI pulse終了を時刻順に処理する。 */
    advanceCSMTimer(timer, targetTime, periodSamples, emitAttack, emitRelease) {
        while (true) {
            const nextOverflow = timer.nextOverflow ?? Infinity;
            const nextRelease = timer.nextRelease ?? Infinity;
            const nextEvent = Math.min(nextOverflow, nextRelease);
            if (nextEvent > targetTime)
                return;
            if (nextRelease <= nextOverflow) {
                emitRelease(nextRelease);
                timer.nextRelease = undefined;
                continue;
            }
            timer.nextOverflow = nextOverflow + periodSamples;
            const currentTick = this.samplesToTicks(nextOverflow, this.options.tempo);
            if (timer.lastEmittedTick === currentTick)
                continue;
            if (timer.nextRelease !== undefined)
                emitRelease(nextOverflow);
            emitAttack(nextOverflow);
            timer.lastEmittedTick = currentTick;
            timer.nextRelease = nextOverflow + this.csmPulseSamples();
        }
    }
    /** OPN CSMを既存のCh3 Special出力形式へ変換する。 */
    emitOPNCsmPulse(chip, instance, isKeyOn, currentTime, activeNotes) {
        const context = this.opnCh3Context(chip, instance);
        this.handleOPNCh3SpecialKeyWrite(context, isKeyOn ? 0xF2 : 0x02, currentTime, activeNotes, true);
    }
    /** OPM CSMを各チャンネルの短いMIDIアタックとして出力する。 */
    emitOPMCsmPulse(instance, isKeyOn, currentTime, activeNotes) {
        const timer = this.opmCsmTimer(instance);
        timer.manualKeyOnMasks ?? (timer.manualKeyOnMasks = new Array(8).fill(0));
        for (let channel = 0; channel < 8; channel++) {
            const key = `ym2151_${channel}`;
            const state = this.channels.get(key);
            state.keyOnMask = timer.manualKeyOnMasks[channel] | (isKeyOn ? 0x0F : 0);
            this.syncYM2151ToneState(channel, false, currentTime, activeNotes);
            if (channel === 7)
                this.syncYM2151NoiseState(false, currentTime, activeNotes);
        }
    }
    /** OPN/OPMが共通で使う1 MIDI tick分のCSM pulse長をsampleへ換算する。 */
    csmPulseSamples() {
        return Math.max(1, (CSM_MIDI_PULSE_TICKS * 60 * this.sampleRate) / (this.options.tempo * MIDI_PPQ));
    }
    /** OPN Timer Aの1周期をVGM sampleへ換算する。 */
    opnCsmPeriodSamples(chip, timer) {
        const clock = this.opnClockRate(chip);
        const count = (timer.timerHigh << 2) | timer.timerLow;
        return Math.max(1, (72 * (1024 - count) * this.sampleRate) / clock);
    }
    /** OPM Timer Aの1周期をVGM sampleへ換算する。 */
    opmCsmPeriodSamples(timer) {
        const clock = (this.vgmData.header.ym2151Clock & vgm_chip_metadata_1.CLOCK_MASK) || 3579545;
        const count = (timer.timerHigh << 2) | timer.timerLow;
        return Math.max(1, (64 * (1024 - count) * this.sampleRate) / clock);
    }
    /** OPN各機種のヘッダーclockを取得する。 */
    opnClockRate(chip) {
        const clock = chip === 'YM2612'
            ? this.vgmData.header.ym2612Clock
            : chip === 'YM2203'
                ? this.vgmData.header.ym2203Clock
                : this.vgmData.header.ym2608Clock;
        return (clock & vgm_chip_metadata_1.CLOCK_MASK) || 7670453;
    }
    /** OPNチップインスタンスのCSM状態を初期化して返す。 */
    opnCsmTimer(chip, instance) {
        const key = `${chip}:${instance}`;
        const current = this.opnCsmTimers.get(key);
        if (current)
            return current;
        const timer = { timerHigh: 0, timerLow: 0, isRunning: false, isCSMEnabled: false };
        this.opnCsmTimers.set(key, timer);
        return timer;
    }
    /** OPMチップインスタンスのCSM状態を初期化して返す。 */
    opmCsmTimer(instance) {
        const current = this.opmCsmTimers.get(instance);
        if (current)
            return current;
        const timer = { timerHigh: 0, timerLow: 0, isRunning: false, isCSMEnabled: false };
        this.opmCsmTimers.set(instance, timer);
        return timer;
    }
    handleOPNCh3SpecialKeyWrite(context, data, currentTime, activeNotes, isCSMEvent = false) {
        const timer = this.opnCsmTimer(context.chip, context.instance);
        const rawMask = (data >> 4) & 0x0F;
        if (!isCSMEvent)
            timer.manualKeyOnMask = rawMask;
        const manualMask = timer.manualKeyOnMask ?? 0;
        const csmMask = isCSMEvent ? rawMask : timer.nextRelease === undefined ? 0 : 0x0F;
        const effectiveData = (data & 0x0F) | ((manualMask | csmMask) << 4);
        if (this.options.opnCh3SpecialPercussion) {
            this.handleOPNCh3SpecialPercussion(context, effectiveData, currentTime, activeNotes);
            return;
        }
        this.handleOPNCh3SpecialOperators(context, effectiveData, currentTime, activeNotes);
    }
    handleOPNCh3SpecialOperators(context, data, currentTime, activeNotes) {
        const parentState = this.channels.get(context.parentKey);
        const slotMask = (data >> 4) & 0x0F;
        parentState.keyOnMask = slotMask;
        const totalLevels = parentState.opnOperatorTotalLevels ?? [0, 0, 0, 0];
        for (let operator = 0; operator < 4; operator++) {
            const key = context.operatorKeys[operator];
            const state = this.channels.get(key);
            const isKeyOn = (slotMask & (1 << operator)) !== 0;
            if (isKeyOn && !state.active) {
                state.opnActivePitchScale = 1;
                const totalLevel = totalLevels[operator];
                state.opnActiveVelocity = totalLevel >= 0x7F
                    ? undefined
                    : this.operatorTotalLevelVelocity(totalLevel);
                state.active = true;
                this.noteOn(key, 0, currentTime, activeNotes);
            }
            else if (!isKeyOn && state.active) {
                state.active = false;
                this.noteOff(key, 0, currentTime, activeNotes);
                state.opnActivePitchScale = 1;
            }
        }
    }
    handleOPNCh3SpecialPercussion(context, data, currentTime, activeNotes) {
        const parentState = this.channels.get(context.parentKey);
        const previousMask = parentState.keyOnMask ?? 0;
        const slotMask = (data >> 4) & 0x0F;
        const newlyKeyedMask = slotMask & ~previousMask;
        parentState.keyOnMask = slotMask;
        const activeKey = this.opnCh3PercussionActiveKeys.get(context.stateKey);
        if (newlyKeyedMask !== 0) {
            if (activeKey !== undefined)
                this.noteOff(activeKey, 0, currentTime, activeNotes);
            const note = this.opnCh3SpecialPercussionNote(context, slotMask);
            const key = `${context.percussionPrefix}${note}`;
            this.noteOnPercussion(key, this.opnCarrierVelocity(parentState), currentTime, activeNotes, note);
            this.opnCh3PercussionActiveKeys.set(context.stateKey, key);
        }
        else if (slotMask === 0 && activeKey !== undefined) {
            this.noteOff(activeKey, 0, currentTime, activeNotes);
            this.opnCh3PercussionActiveKeys.delete(context.stateKey);
        }
    }
    opnCh3SpecialPercussionNote(context, slotMask) {
        const parentState = this.channels.get(context.parentKey);
        const algorithm = parentState.opnAlgorithm ?? 0;
        const totalLevels = parentState.opnOperatorTotalLevels ?? [0, 0, 0, 0];
        const carrierNotes = [];
        for (const path of OPN_OPERATOR_PATHS[algorithm]) {
            const operator = path.carrier;
            if ((slotMask & (1 << operator)) === 0 || totalLevels[operator] >= 0x7F)
                continue;
            const state = this.channels.get(context.operatorKeys[operator]);
            const note = this.frequencyToMidiNote(this.opnCh3OperatorFrequency(context, state));
            if (note > 0)
                carrierNotes.push(note);
        }
        return this.opnCh3PercussionNoteForCarrierNotes(carrierNotes);
    }
    opnCh3OperatorFrequency(context, state) {
        if (context.chip === 'YM2612') {
            return this.ym2612FrequencyToHz(state.frequency, state.block ?? 0, this.vgmData.header.ym2612Clock);
        }
        const clock = context.chip === 'YM2203'
            ? this.vgmData.header.ym2203Clock
            : this.vgmData.header.ym2608Clock;
        const prescaler = context.chip === 'YM2203'
            ? this.ym2203Prescalers[context.instance]
            : this.ym2608Prescalers[context.instance];
        return this.ym2203FrequencyToHz(state.frequency, state.block ?? 0, clock, prescaler);
    }
    opnCh3PercussionNoteForCarrierNotes(carrierNotes) {
        if (carrierNotes.length === 0)
            return 38;
        carrierNotes.sort((left, right) => left - right);
        const note = carrierNotes[Math.floor(carrierNotes.length / 2)];
        if (note <= 48)
            return 36;
        if (note <= 64)
            return 38;
        if (note >= 108)
            return 42;
        if (note >= 88)
            return 49;
        if (note <= 68)
            return 41;
        if (note <= 72)
            return 43;
        if (note <= 75)
            return 45;
        if (note <= 78)
            return 47;
        if (note <= 81)
            return 48;
        return 50;
    }
    handleOPNCh3SpecialFrequencyWrite(context, reg, data, currentTime, activeNotes, cmdIndex) {
        const isLowByte = reg >= 0xA8 && reg <= 0xAA;
        const isHighByte = reg >= 0xAC && reg <= 0xAE;
        if (!isLowByte && !isHighByte)
            return false;
        const offset = isLowByte ? reg - 0xA8 : reg - 0xAC;
        const operator = OPN_CH3_SPECIAL_OPERATOR_BY_OFFSET[offset];
        const key = context.operatorKeys[operator];
        const state = this.channels.get(key);
        if (isLowByte)
            state.freqLSB = data;
        else {
            state.freqMSB = data & 0x07;
            state.block = (data >> 3) & 0x07;
        }
        const oldFrequency = state.frequency;
        state.frequency = ((state.freqMSB ?? 0) << 8) | (state.freqLSB ?? 0);
        const otherReg = isLowByte ? reg + 4 : reg - 4;
        const isSplitUpdate = this.isOPNMultiByteFreqUpdate(cmdIndex, context.chip, 0, otherReg, context.instance);
        const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
        state.hasPendingFrequencyUpdate = isSplitUpdate;
        if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
            this.updateNotePitch(key, 0, currentTime, activeNotes);
        }
        return true;
    }
    handleYM2612TimbreWrite(port, reg, data, currentTime) {
        return this.handleOPNTimbreWrite('ym2612', port, reg, data, currentTime);
    }
    handleOPNTimbreWrite(keyPrefix, port, reg, data, currentTime) {
        const isMultiplier = reg >= 0x30 && reg <= 0x3F;
        const isTotalLevel = reg >= 0x40 && reg <= 0x4F;
        const isAlgorithm = reg >= 0xB0 && reg <= 0xB2;
        if (!isMultiplier && !isTotalLevel && !isAlgorithm)
            return false;
        const channelOffset = reg & 0x03;
        if (channelOffset >= 3)
            return true;
        const channelIndex = channelOffset + (port * 3);
        const key = keyPrefix === 'ym2612'
            ? `${keyPrefix}_${channelIndex}`
            : `${keyPrefix}_fm_${channelIndex}`;
        const state = this.channels.get(key);
        if (isAlgorithm) {
            state.opnAlgorithm = data & 0x07;
        }
        else {
            const registerSlot = (reg >> 2) & 0x03;
            const logicalOperator = [0, 2, 1, 3][registerSlot];
            if (isMultiplier) {
                state.opnOperatorMultipliers[logicalOperator] = data & 0x0F;
                state.opnOperatorMultiplierWritten[logicalOperator] = true;
            }
            else {
                state.opnOperatorTotalLevels[logicalOperator] = data & 0x7F;
                if (state.active && currentTime !== undefined) {
                    this.addExpression(key, this.opnCarrierExpression(state), currentTime);
                }
            }
        }
        if (currentTime !== undefined)
            this.recordOPNTimbreEvents(keyPrefix, channelIndex, currentTime);
        return true;
    }
    /** OPN/OPNA の $B4-$B6 LR 出力マスクを CC10 に変換する。 */
    handleOPNPanWrite(keyPrefix, port, reg, data, currentTime) {
        if (reg < 0xB4 || reg > 0xB6)
            return false;
        const offset = reg & 0x03;
        if (offset >= 3)
            return true;
        const channel = offset + port * 3;
        const key = keyPrefix === 'ym2612' ? `${keyPrefix}_${channel}` : `${keyPrefix}_fm_${channel}`;
        this.addPan(key, (data & 0x80) !== 0, (data & 0x40) !== 0, currentTime);
        return true;
    }
    opnPitchScale(state) {
        return this.fmPitchScale(state, OPN_OPERATOR_PATHS, 0x7F, OPN_DOUBLED_MULTIPLES);
    }
    oplPitchScale(state) {
        return this.fmPitchScale(state, OPL_OPERATOR_PATHS, 0x3F, OPL_DOUBLED_MULTIPLES);
    }
    fmPitchScale(state, paths, silentTotalLevel, doubledMultiples) {
        const algorithm = state.opnAlgorithm ?? 0;
        const keyOnMask = state.keyOnMask ?? 0;
        const totalLevels = state.opnOperatorTotalLevels ?? [];
        const operatorIndexes = new Set();
        for (const path of paths[algorithm] ?? paths[0]) {
            const isCarrierActive = (keyOnMask & (1 << path.carrier)) !== 0;
            if (!isCarrierActive || (totalLevels[path.carrier] ?? 0) >= silentTotalLevel)
                continue;
            for (const operator of path.operators) {
                const isOperatorActive = (keyOnMask & (1 << operator)) !== 0;
                if (isOperatorActive && (totalLevels[operator] ?? 0) < silentTotalLevel)
                    operatorIndexes.add(operator);
            }
        }
        if (operatorIndexes.size === 0)
            return 1;
        const multipliers = state.opnOperatorMultipliers ?? [];
        const multiplierWritten = state.opnOperatorMultiplierWritten ?? [];
        if ([...operatorIndexes].some(operator => !multiplierWritten[operator]))
            return 1;
        const activeMultiples = [...operatorIndexes].map(operator => doubledMultiples[multipliers[operator] ?? 0]);
        const commonMultiplier = activeMultiples.reduce(greatestCommonDivisor) / 2;
        if (commonMultiplier === 0.5)
            return 0.5;
        const isPowerOfTwo = Number.isInteger(commonMultiplier)
            && commonMultiplier > 1
            && (commonMultiplier & (commonMultiplier - 1)) === 0;
        return isPowerOfTwo ? commonMultiplier : 1;
    }
    // Derives a note-on velocity from the lowest (loudest) Total Level among the audible
    // carrier operators for the channel's current algorithm — reusing opnPitchScale()'s own
    // carrier-reachability logic so a carrier gated by key-on or silenced by max TL is
    // excluded the same way. TL is 0.75dB/step attenuation (0=loudest, 0x7F=silent); the
    // conversion to a 1-100 MIDI velocity intentionally uses a shallow perceptual curve.
    // FM patches use carrier TL as part of timbre design, not as a standalone mixer fader;
    // applying its physical attenuation directly to a GM synth made normal TL values almost
    // inaudible. The 120 dB divisor keeps TL=16 near the former neutral velocity 80 while
    // retaining useful differences between patches and attacks.
    // No carrier reachable (e.g. every candidate gated off) falls back to a neutral 80,
    // matching the previous fixed-velocity behavior.
    opnCarrierVelocity(state) {
        return this.fmCarrierVelocity(state, OPN_OPERATOR_PATHS, 0x7F);
    }
    oplCarrierVelocity(state) {
        return this.fmCarrierVelocity(state, OPL_OPERATOR_PATHS, 0x3F);
    }
    fmCarrierVelocity(state, paths, silentTotalLevel) {
        const algorithm = state.opnAlgorithm ?? 0;
        const keyOnMask = state.keyOnMask ?? 0;
        const totalLevels = state.opnOperatorTotalLevels ?? [];
        let minCarrierTL;
        for (const path of paths[algorithm] ?? paths[0]) {
            const isCarrierActive = (keyOnMask & (1 << path.carrier)) !== 0;
            const tl = totalLevels[path.carrier] ?? 0;
            if (!isCarrierActive || tl >= silentTotalLevel)
                continue;
            if (minCarrierTL === undefined || tl < minCarrierTL)
                minCarrierTL = tl;
        }
        if (minCarrierTL === undefined)
            return 80;
        return this.operatorTotalLevelVelocity(minCarrierTL);
    }
    // Shared TL(0=loudest,0x7F=silent)-to-MIDI-velocity(1-100) curve, factored out of
    // opnCarrierVelocity() so YM2612 channel-3 special mode can derive a velocity directly
    // from one operator's own Total Level — special mode has no algorithm/carrier routing to
    // walk (each operator is an independent oscillator), so opnCarrierVelocity()'s
    // OPN_OPERATOR_PATHS traversal doesn't apply there.
    operatorTotalLevelVelocity(totalLevel) {
        const velocity = Math.round(100 * Math.pow(10, -(0.75 * totalLevel) / 120));
        return Math.max(1, Math.min(100, velocity));
    }
    /** Key On時のvelocityを基準に、発音中TL変化だけを相対CC11へ変換する。 */
    opnCarrierExpression(state) {
        return this.fmCarrierExpression(state, this.opnCarrierVelocity(state));
    }
    oplCarrierExpression(state) {
        return this.fmCarrierExpression(state, this.oplCarrierVelocity(state));
    }
    fmCarrierExpression(state, currentVelocity) {
        const keyOnVelocity = Math.max(1, state.opnActiveVelocity ?? currentVelocity);
        return Math.max(1, Math.min(127, Math.round((currentVelocity / keyOnVelocity) * 127)));
    }
    handleYM2612DACSeek(cmd) {
        if (cmd.address === undefined)
            return;
        this.ym2612DACPendingAddress = cmd.address;
    }
    handleYM2612DACWrite(currentTime) {
        const address = this.ym2612DACPendingAddress;
        if (address === undefined)
            return;
        this.ym2612DACPendingAddress = undefined;
        if (!this.isYM2612DACEnabled)
            return;
        if (this.options.suppressYM2612Dac)
            return;
        this.stopYM2612DACVoice(currentTime);
        const sampleId = address.toString(16).padStart(6, '0');
        const trackKey = `ym2612dac_sample_${sampleId}`;
        const note = this.pcmNoteForSample(trackKey);
        const dataBlock = this.pcmDataBlockForRange(0x00, 0, address);
        const descriptorId = this.noteOnPCMPercussion(trackKey, note, 100, currentTime, false, dataBlock);
        this.ym2612DACActiveVoice = { descriptorId, note };
    }
    stopYM2612DACVoice(currentTime) {
        const voice = this.ym2612DACActiveVoice;
        if (!voice)
            return;
        this.noteOffPCMPercussion(voice.descriptorId, voice.note, currentTime);
        this.ym2612DACActiveVoice = undefined;
    }
    // Groups consecutive $2A writes into one note by elapsed-time gap (see
    // YM2612_DAC_DIRECT_GAP_SAMPLES). All writes share one track/sample identity, since $2A
    // carries no address to distinguish samples by.
    handleYM2612DirectDACWrite(currentTime) {
        if (!this.isYM2612DACEnabled)
            return;
        if (this.options.suppressYM2612Dac)
            return;
        const lastWriteTime = this.ym2612DirectDACLastWriteTime;
        this.ym2612DirectDACLastWriteTime = currentTime;
        if (this.ym2612DirectDACActiveVoice
            && lastWriteTime !== undefined
            && currentTime - lastWriteTime > YM2612_DAC_DIRECT_GAP_SAMPLES) {
            // Close the previous hit at its own last-write time, not `currentTime` — otherwise a
            // long gap before the next hit stretches the previous note across the gap.
            this.noteOffPCMPercussion(this.ym2612DirectDACActiveVoice.descriptorId, this.ym2612DirectDACActiveVoice.note, lastWriteTime);
            this.ym2612DirectDACActiveVoice = undefined;
        }
        if (!this.ym2612DirectDACActiveVoice) {
            const trackKey = 'ym2612dac_direct_stream';
            const note = this.pcmNoteForSample(trackKey);
            const descriptorId = this.noteOnPCMPercussion(trackKey, note, 100, currentTime);
            this.ym2612DirectDACActiveVoice = { descriptorId, note };
        }
    }
    // Closes the direct-DAC voice at the last actual $2A write time, not `currentTime` —
    // called from both $2B-disable and EOF (stopAllPCMVoices()), neither of which should
    // stretch the final hit's duration out to whenever this happens to be called.
    stopYM2612DirectDACVoice(currentTime) {
        const voice = this.ym2612DirectDACActiveVoice;
        if (!voice)
            return;
        const closeTime = this.ym2612DirectDACLastWriteTime ?? currentTime;
        this.noteOffPCMPercussion(voice.descriptorId, voice.note, closeTime);
        this.ym2612DirectDACActiveVoice = undefined;
        this.ym2612DirectDACLastWriteTime = undefined;
    }
    handleYM2203Write(cmd, currentTime, activeNotes, cmdIndex) {
        if (cmd.register === undefined || cmd.data === undefined)
            return;
        const instance = cmd.instance === 1 ? 1 : 0;
        const reg = cmd.register;
        const data = cmd.data;
        const keyPrefix = `ym2203_${instance}`;
        const ch3Context = this.opnCh3Context('YM2203', instance);
        if (this.handleOPNPanWrite(keyPrefix, 0, reg, data, currentTime))
            return;
        if (reg < 0x10) {
            this.handleSSGWrite(`${keyPrefix}_ssg`, reg, data, currentTime, activeNotes, cmdIndex, 'YM2203', instance);
            return;
        }
        if (reg >= 0x2D && reg <= 0x2F) {
            this.updateYM2203Prescaler(instance, reg, currentTime, activeNotes);
            return;
        }
        if (reg === 0x27) {
            this.handleOPNCh3ModeWrite(ch3Context, data, currentTime, activeNotes);
            this.updateOPNCsmTimer('YM2203', instance, data, currentTime, activeNotes);
            return;
        }
        if (reg === 0x24 || reg === 0x25) {
            this.updateOPNCsmTimerRegister('YM2203', instance, reg, data);
            return;
        }
        if (this.handleOPNTimbreWrite(keyPrefix, 0, reg, data, currentTime))
            return;
        if (this.handleYM2203KeyWrite(ch3Context, data, reg, currentTime, activeNotes))
            return;
        if (this.handleOPNCh3SpecialFrequencyWrite(ch3Context, reg, data, currentTime, activeNotes, cmdIndex))
            return;
        this.updateYM2203Frequency(instance, reg, data, currentTime, activeNotes, cmdIndex);
    }
    handleYM2203KeyWrite(context, data, register, currentTime, activeNotes) {
        if (register !== 0x28)
            return false;
        const channel = data & 0x03;
        if (channel >= 3 || (data & 0x04) !== 0)
            return true;
        if (channel === 2 && this.isOPNCh3SpecialMode(context)) {
            this.handleOPNCh3SpecialKeyWrite(context, data, currentTime, activeNotes);
            return true;
        }
        const key = `${context.stateKey}_fm_${channel}`;
        const state = this.channels.get(key);
        state.keyOnMask = (data >> 4) & 0x0F;
        const shouldSound = state.keyOnMask !== 0;
        if (shouldSound && !state.active) {
            state.opnActivePitchScale = this.opnPitchScale(state);
            state.opnActiveVelocity = this.opnCarrierVelocity(state);
            state.active = true;
            this.noteOn(key, 0, currentTime, activeNotes);
        }
        else if (!shouldSound && state.active) {
            state.active = false;
            this.noteOff(key, 0, currentTime, activeNotes);
            state.opnActivePitchScale = 1;
        }
        return true;
    }
    updateYM2203Frequency(instance, reg, data, currentTime, activeNotes, cmdIndex) {
        const isLowByte = reg >= 0xA0 && reg <= 0xA2;
        const isHighByte = reg >= 0xA4 && reg <= 0xA6;
        if (!isLowByte && !isHighByte)
            return;
        const channel = reg & 0x03;
        const key = `ym2203_${instance}_fm_${channel}`;
        const state = this.channels.get(key);
        if (isLowByte)
            state.freqLSB = data;
        else {
            state.freqMSB = data & 0x07;
            state.block = (data >> 3) & 0x07;
        }
        const oldFrequency = state.frequency;
        state.frequency = ((state.freqMSB ?? 0) << 8) | (state.freqLSB ?? 0);
        const otherReg = isLowByte ? reg + 4 : reg - 4;
        const isSplitUpdate = this.isOPNMultiByteFreqUpdate(cmdIndex, 'YM2203', 0, otherReg, instance);
        const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
        state.hasPendingFrequencyUpdate = isSplitUpdate;
        if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
            this.updateKeyBoundFMPitch(key, currentTime, activeNotes, YM2203_FM_PITCH_BEND_RANGE);
        }
    }
    updateYM2203Prescaler(instance, register, currentTime, activeNotes) {
        const oldPrescaler = this.ym2203Prescalers[instance];
        let newPrescaler = oldPrescaler;
        if (register === 0x2D)
            newPrescaler = 6;
        else if (register === 0x2E && oldPrescaler === 6)
            newPrescaler = 3;
        else if (register === 0x2F)
            newPrescaler = 2;
        if (newPrescaler === oldPrescaler)
            return;
        this.ym2203Prescalers[instance] = newPrescaler;
        for (const section of ['fm', 'ssg']) {
            for (let channel = 0; channel < 3; channel++) {
                const key = `ym2203_${instance}_${section}_${channel}`;
                if (this.channels.get(key).active) {
                    if (section === 'fm') {
                        this.updateKeyBoundFMPitch(key, currentTime, activeNotes, YM2203_FM_PITCH_BEND_RANGE);
                    }
                    else
                        this.updateNotePitch(key, 0, currentTime, activeNotes);
                }
            }
        }
        this.updateActiveOPNCh3SpecialPitches(this.opnCh3Context('YM2203', instance), currentTime, activeNotes);
    }
    updateKeyBoundFMPitch(key, currentTime, activeNotes, pitchBendRange) {
        const state = this.channels.get(key);
        if (!activeNotes.has(key)) {
            if (state.active)
                this.noteOn(key, 0, currentTime, activeNotes);
            return;
        }
        const frequency = this.getNoteFrequency(key, state);
        if (frequency <= 20)
            return;
        const semitoneOffset = this.frequencyToExactMidi(frequency) - state.baseMidiNote;
        this.addPitchBend(key, semitoneOffset, pitchBendRange, currentTime);
    }
    handleYM2608Write(cmd, currentTime, activeNotes, cmdIndex) {
        if (cmd.register === undefined || cmd.data === undefined)
            return;
        const instance = cmd.instance === 1 ? 1 : 0;
        const port = cmd.port === 1 ? 1 : 0;
        const reg = cmd.register;
        const data = cmd.data;
        const keyPrefix = `ym2608_${instance}`;
        const ch3Context = this.opnCh3Context('YM2608', instance);
        if (this.handleOPNPanWrite(keyPrefix, port, reg, data, currentTime))
            return;
        if (port === 0 && reg < 0x10) {
            this.handleSSGWrite(`${keyPrefix}_ssg`, reg, data, currentTime, activeNotes, cmdIndex, 'YM2608', instance);
            return;
        }
        if (port === 0 && reg >= 0x10 && reg <= 0x1D) {
            this.handleYM2608RhythmWrite(instance, reg, data, currentTime, activeNotes);
            return;
        }
        if (port === 1 && reg <= 0x10) {
            this.handleYM2608ADPCMBWrite(instance, reg, data, currentTime);
            return;
        }
        if (port === 0 && reg >= 0x2D && reg <= 0x2F) {
            this.updateYM2608Prescaler(instance, reg, currentTime, activeNotes);
            return;
        }
        if (port === 0 && reg === 0x27) {
            this.handleOPNCh3ModeWrite(ch3Context, data, currentTime, activeNotes);
            this.updateOPNCsmTimer('YM2608', instance, data, currentTime, activeNotes);
            return;
        }
        if (port === 0 && (reg === 0x24 || reg === 0x25)) {
            this.updateOPNCsmTimerRegister('YM2608', instance, reg, data);
            return;
        }
        if (this.handleOPNTimbreWrite(keyPrefix, port, reg, data, currentTime))
            return;
        if (port === 0 && this.handleYM2608KeyWrite(ch3Context, data, reg, currentTime, activeNotes))
            return;
        if (port === 0 && this.handleOPNCh3SpecialFrequencyWrite(ch3Context, reg, data, currentTime, activeNotes, cmdIndex))
            return;
        this.updateYM2608Frequency(instance, port, reg, data, currentTime, activeNotes, cmdIndex);
    }
    handleYM2608KeyWrite(context, data, register, currentTime, activeNotes) {
        if (register !== 0x28)
            return false;
        const channelOffset = data & 0x03;
        if (channelOffset >= 3)
            return true;
        const channel = channelOffset + ((data & 0x04) === 0 ? 0 : 3);
        if (channel === 2 && this.isOPNCh3SpecialMode(context)) {
            this.handleOPNCh3SpecialKeyWrite(context, data, currentTime, activeNotes);
            return true;
        }
        const key = `${context.stateKey}_fm_${channel}`;
        const state = this.channels.get(key);
        state.keyOnMask = (data >> 4) & 0x0F;
        const shouldSound = state.keyOnMask !== 0;
        if (shouldSound && !state.active) {
            state.opnActivePitchScale = this.opnPitchScale(state);
            state.opnActiveVelocity = this.opnCarrierVelocity(state);
            state.active = true;
            this.noteOn(key, 0, currentTime, activeNotes);
        }
        else if (!shouldSound && state.active) {
            state.active = false;
            this.noteOff(key, 0, currentTime, activeNotes);
            state.opnActivePitchScale = 1;
        }
        return true;
    }
    updateYM2608Frequency(instance, port, reg, data, currentTime, activeNotes, cmdIndex) {
        const isLowByte = reg >= 0xA0 && reg <= 0xA2;
        const isHighByte = reg >= 0xA4 && reg <= 0xA6;
        if (!isLowByte && !isHighByte)
            return;
        const channel = (reg & 0x03) + (port * 3);
        const key = `ym2608_${instance}_fm_${channel}`;
        const state = this.channels.get(key);
        if (isLowByte)
            state.freqLSB = data;
        else {
            state.freqMSB = data & 0x07;
            state.block = (data >> 3) & 0x07;
        }
        const oldFrequency = state.frequency;
        state.frequency = ((state.freqMSB ?? 0) << 8) | (state.freqLSB ?? 0);
        const otherReg = isLowByte ? reg + 4 : reg - 4;
        const isSplitUpdate = this.isOPNMultiByteFreqUpdate(cmdIndex, 'YM2608', port, otherReg, instance);
        const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
        state.hasPendingFrequencyUpdate = isSplitUpdate;
        if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
            this.updateKeyBoundFMPitch(key, currentTime, activeNotes, YM2608_FM_PITCH_BEND_RANGE);
        }
    }
    updateYM2608Prescaler(instance, register, currentTime, activeNotes) {
        const oldPrescaler = this.ym2608Prescalers[instance];
        let newPrescaler = oldPrescaler;
        if (register === 0x2D)
            newPrescaler = 6;
        else if (register === 0x2E && oldPrescaler === 6)
            newPrescaler = 3;
        else if (register === 0x2F)
            newPrescaler = 2;
        if (newPrescaler === oldPrescaler)
            return;
        this.ym2608Prescalers[instance] = newPrescaler;
        for (let channel = 0; channel < 6; channel++) {
            const key = `ym2608_${instance}_fm_${channel}`;
            if (this.channels.get(key).active) {
                this.updateKeyBoundFMPitch(key, currentTime, activeNotes, YM2608_FM_PITCH_BEND_RANGE);
            }
        }
        for (let channel = 0; channel < 3; channel++) {
            const key = `ym2608_${instance}_ssg_${channel}`;
            if (this.channels.get(key).active)
                this.updateNotePitch(key, 0, currentTime, activeNotes);
        }
        this.updateActiveOPNCh3SpecialPitches(this.opnCh3Context('YM2608', instance), currentTime, activeNotes);
    }
    updateActiveOPNCh3SpecialPitches(context, currentTime, activeNotes) {
        for (const key of context.operatorKeys.slice(0, 3)) {
            if (this.channels.get(key).active)
                this.updateNotePitch(key, 0, currentTime, activeNotes);
        }
    }
    handleYM2608RhythmWrite(instance, register, data, currentTime, activeNotes) {
        if (register === 0x10) {
            this.updateYM2608RhythmKeys(instance, data, currentTime, activeNotes);
            return;
        }
        if (register === 0x11) {
            this.ym2608RhythmTotalLevels[instance] = data & 0x3F;
            this.updateYM2608RhythmExpression(instance, currentTime, activeNotes);
            return;
        }
        if (register >= 0x18 && register <= 0x1D) {
            const channel = register - 0x18;
            this.ym2608RhythmInstrumentLevels[instance][channel] = data & 0x1F;
            this.updateYM2608RhythmExpression(instance, currentTime, activeNotes, channel);
        }
    }
    updateYM2608RhythmKeys(instance, data, currentTime, activeNotes) {
        const isDump = (data & 0x80) !== 0;
        const mask = data & 0x3F;
        for (let channel = 0; channel < 6; channel++) {
            if ((mask & (1 << channel)) === 0)
                continue;
            const key = `ym2608_${instance}_rhythm_${channel}`;
            if (activeNotes.has(key))
                this.noteOff(key, 0, currentTime, activeNotes);
            if (!isDump) {
                const velocity = this.ym2608RhythmVelocity(instance, channel);
                this.noteOnPercussion(key, velocity, currentTime, activeNotes, YM2608_RHYTHM_NOTES[channel]);
            }
        }
    }
    updateYM2608RhythmExpression(instance, currentTime, activeNotes, selectedChannel) {
        for (let channel = 0; channel < 6; channel++) {
            if (selectedChannel !== undefined && channel !== selectedChannel)
                continue;
            const key = `ym2608_${instance}_rhythm_${channel}`;
            if (!activeNotes.has(key))
                continue;
            const expression = Math.round((this.ym2608RhythmVelocity(instance, channel) / 100) * 127);
            this.addExpression(key, expression, currentTime);
        }
    }
    ym2608RhythmVelocity(instance, channel) {
        const combinedLevel = this.ym2608RhythmTotalLevels[instance]
            + this.ym2608RhythmInstrumentLevels[instance][channel];
        const audibleLevel = Math.max(0, combinedLevel - 31);
        return Math.max(1, Math.round((audibleLevel / 63) * 100));
    }
    handleYM2608ADPCMBWrite(instance, register, data, currentTime) {
        const registers = this.ym2608ADPCMRegisters[instance];
        registers[register] = data;
        if (register === 0x0B) {
            const voice = this.ym2608ADPCMActiveVoices[instance];
            if (voice)
                this.addExpression(voice.descriptorId, Math.round((data / 255) * 127), currentTime);
            return;
        }
        if (register !== 0x00)
            return;
        if ((data & 0x01) !== 0 || (data & 0x80) === 0) {
            this.stopYM2608ADPCMBVoice(instance, currentTime);
            return;
        }
        this.stopYM2608ADPCMBVoice(instance, currentTime);
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
            ? this.pcmROMDataBlockForAddress(0x81, instance, address << 5, dataLengthBytes)
            : undefined;
        const sampleId = address.toString(16).padStart(4, '0');
        const trackKey = `ym2608_${instance}_adpcmb_sample_${sampleId}`;
        const note = this.pcmNoteForSample(trackKey);
        const velocity = Math.max(1, Math.round((registers[0x0B] / 255) * 100));
        const deltaN = registers[0x09] | (registers[0x0A] << 8);
        const durationSamples = isLoop
            ? undefined
            : this.ym2608ADPCMDurationSamples(address, endAddress, deltaN, addressUnitBytes);
        const descriptorId = this.noteOnPCMPercussion(trackKey, note, velocity, currentTime, isLoop, dataBlock, durationSamples);
        this.ym2608ADPCMActiveVoices[instance] = { descriptorId, note };
    }
    /** YM2608 ADPCM-Bの非repeat範囲を、VGMの44.1 kHz時間単位へ概算変換する。 */
    ym2608ADPCMDurationSamples(startAddress, endAddress, deltaN, addressUnitBytes) {
        if (endAddress < startAddress || deltaN === 0)
            return undefined;
        const clock = this.vgmData.header.ym2608Clock & vgm_chip_metadata_1.CLOCK_MASK;
        if (clock === 0)
            return undefined;
        const byteLength = (endAddress - startAddress + 1) * addressUnitBytes;
        // The ADPCM-B phase accumulator advances once per master-clock/144 tick.
        // Each encoded byte contains two 4-bit ADPCM samples.
        return Math.round((byteLength * 2 * this.sampleRate * 144 * 0x10000) / (deltaN * clock));
    }
    stopYM2608ADPCMBVoice(instance, currentTime) {
        const voice = this.ym2608ADPCMActiveVoices[instance];
        if (!voice)
            return;
        this.noteOffPCMPercussion(voice.descriptorId, voice.note, currentTime);
        this.ym2608ADPCMActiveVoices[instance] = undefined;
    }
    handleAY8910Write(cmd, currentTime, activeNotes, cmdIndex) {
        if (cmd.register === undefined || cmd.data === undefined)
            return;
        const instance = cmd.instance === 1 ? 1 : 0;
        this.handleSSGWrite(`ay8910_${instance}`, cmd.register, cmd.data, currentTime, activeNotes, cmdIndex, 'AY8910', instance);
    }
    handleSSGWrite(keyPrefix, reg, data, currentTime, activeNotes, cmdIndex, chip, instance) {
        if (reg <= 5) {
            this.updateSSGTonePeriod(keyPrefix, reg, data, currentTime, activeNotes, cmdIndex, chip, instance);
        }
        else if (reg === 6)
            this.updateSSGNoisePeriod(keyPrefix, data, currentTime, activeNotes);
        else if (reg === 7)
            this.updateSSGMixer(keyPrefix, data, currentTime, activeNotes);
        else if (reg >= 8 && reg <= 10) {
            this.updateSSGVolume(keyPrefix, reg - 8, data, currentTime, activeNotes);
        }
        else if (reg === 13) {
            this.retriggerSSGEnvelope(keyPrefix, currentTime, activeNotes);
        }
    }
    // reg 6 (5-bit noise period) is one shared generator per chip instance, unlike tone/
    // volume/mixer which are per-channel — a change here can affect up to 3 channels'
    // noise pitch at once, so every currently-sounding noise channel on this keyPrefix is
    // re-evaluated (not just retriggered unconditionally, to avoid machine-gunning notes
    // for a sweep that stays within the same drum band).
    updateSSGNoisePeriod(keyPrefix, data, currentTime, activeNotes) {
        const period = data & 0x1F;
        const previousPeriod = this.ssgNoisePeriods.get(keyPrefix);
        this.ssgNoisePeriods.set(keyPrefix, period);
        if (previousPeriod === undefined)
            return;
        const newNote = this.ssgNoiseNoteForPeriod(period);
        if (newNote === this.ssgNoiseNoteForPeriod(previousPeriod))
            return;
        for (let channel = 0; channel < 3; channel++) {
            const noiseKey = `${keyPrefix}_noise_${channel}`;
            const active = activeNotes.get(noiseKey);
            if (active === undefined || active.note === newNote)
                continue;
            this.noteOff(noiseKey, 0, currentTime, activeNotes);
            const state = this.channels.get(`${keyPrefix}_${channel}`);
            this.noteOnPercussion(noiseKey, Math.round((state.volume / 15) * 100), currentTime, activeNotes, newNote);
        }
    }
    ssgNoiseNoteForPeriod(period) {
        // Period 0 behaves like 1 on real hardware (a 5-bit down-counter that reloads on
        // underflow), matching the register-0 handling used elsewhere in this file.
        const effectivePeriod = period === 0 ? 1 : period;
        const normalizedRate = 1 - (effectivePeriod - 1) / 30;
        return noiseDrumNote(normalizedRate, false);
    }
    ssgNoiseNote(keyPrefix) {
        return this.ssgNoiseNoteForPeriod(this.ssgNoisePeriods.get(keyPrefix) ?? 1);
    }
    // Looks ahead through at most 16 samples for the other half ($reg ± 1) of a split SSG
    // tone-period write on the same chip/instance, reusing isOPNMultiByteFreqUpdate() the
    // same way OPN FM frequency pairs do. Without this, updating pitch after only the LSB
    // or MSB half has landed briefly combines the new half with a stale other half and can
    // retrigger a spurious note roughly an octave away.
    updateSSGTonePeriod(keyPrefix, reg, data, currentTime, activeNotes, cmdIndex, chip, instance) {
        const channel = Math.floor(reg / 2);
        const key = `${keyPrefix}_${channel}`;
        const state = this.channels.get(key);
        if (reg % 2 === 0)
            state.freqLSB = data;
        else
            state.freqMSB = data & 0x0F;
        const oldFreq = state.frequency;
        state.frequency = ((state.freqMSB || 0) << 8) | (state.freqLSB || 0);
        const otherReg = reg % 2 === 0 ? reg + 1 : reg - 1;
        const isSplitUpdate = this.isOPNMultiByteFreqUpdate(cmdIndex, chip, 0, otherReg, instance);
        if (state.active && !isSplitUpdate && state.frequency !== oldFreq) {
            this.updateNotePitch(key, 0, currentTime, activeNotes);
        }
    }
    updateSSGVolume(keyPrefix, channel, data, currentTime, activeNotes) {
        const key = `${keyPrefix}_${channel}`;
        const state = this.channels.get(key);
        state.isEnvelope = (data & 0x10) !== 0;
        const effectiveVolume = state.isEnvelope ? 15 : data & 0x0F;
        const oldVolume = state.volume;
        const wasToneActive = state.active;
        const wasNoiseActive = state.isNoiseActive;
        state.volume = effectiveVolume;
        this.syncSSGToneState(keyPrefix, channel, currentTime, activeNotes);
        this.syncSSGNoiseState(keyPrefix, channel, currentTime, activeNotes);
        const expression = Math.round((effectiveVolume / 15) * 127);
        if (wasToneActive && state.active && oldVolume !== effectiveVolume) {
            this.addExpression(key, expression, currentTime);
        }
        if (wasNoiseActive && state.isNoiseActive && oldVolume !== effectiveVolume) {
            this.addExpression(`${keyPrefix}_noise_${channel}`, expression, currentTime);
        }
    }
    updateSSGMixer(keyPrefix, data, currentTime, activeNotes) {
        for (let channel = 0; channel < 3; channel++) {
            const state = this.channels.get(`${keyPrefix}_${channel}`);
            state.isToneEnabled = (data & (1 << channel)) === 0;
            state.isNoise = (data & (1 << (channel + 3))) === 0;
            this.syncSSGToneState(keyPrefix, channel, currentTime, activeNotes);
            this.syncSSGNoiseState(keyPrefix, channel, currentTime, activeNotes);
        }
    }
    syncSSGToneState(keyPrefix, channel, currentTime, activeNotes) {
        const key = `${keyPrefix}_${channel}`;
        const state = this.channels.get(key);
        const shouldSound = state.isToneEnabled && state.volume > 0;
        if (shouldSound && !state.active) {
            state.active = true;
            this.noteOn(key, 0, currentTime, activeNotes);
        }
        else if (!shouldSound && state.active) {
            state.active = false;
            this.noteOff(key, 0, currentTime, activeNotes);
        }
    }
    syncSSGNoiseState(keyPrefix, channel, currentTime, activeNotes) {
        const state = this.channels.get(`${keyPrefix}_${channel}`);
        const noiseKey = `${keyPrefix}_noise_${channel}`;
        const shouldSound = state.isNoise && state.volume > 0;
        if (shouldSound && !state.isNoiseActive) {
            state.isNoiseActive = true;
            this.noteOnPercussion(noiseKey, Math.round((state.volume / 15) * 100), currentTime, activeNotes, this.ssgNoiseNote(keyPrefix));
        }
        else if (!shouldSound && state.isNoiseActive) {
            state.isNoiseActive = false;
            this.noteOff(noiseKey, 0, currentTime, activeNotes);
        }
    }
    retriggerSSGEnvelope(keyPrefix, currentTime, activeNotes) {
        for (let channel = 0; channel < 3; channel++) {
            const key = `${keyPrefix}_${channel}`;
            const state = this.channels.get(key);
            if (!state.isEnvelope)
                continue;
            if (state.active) {
                this.noteOff(key, 0, currentTime, activeNotes);
                this.noteOn(key, 0, currentTime, activeNotes);
            }
            if (state.isNoiseActive) {
                const noiseKey = `${keyPrefix}_noise_${channel}`;
                this.noteOff(noiseKey, 0, currentTime, activeNotes);
                this.noteOnPercussion(noiseKey, 100, currentTime, activeNotes, this.ssgNoiseNote(keyPrefix));
            }
        }
    }
    handleYM2151Write(cmd, currentTime, activeNotes) {
        if (cmd.register === undefined || cmd.data === undefined)
            return;
        const reg = cmd.register;
        const data = cmd.data;
        if (reg === 0x10 || reg === 0x11) {
            this.updateOPMCsmTimerRegister(cmd.instance ?? 0, reg, data);
            return;
        }
        if (reg === 0x14) {
            this.updateOPMCsmTimer(cmd.instance ?? 0, data, currentTime, activeNotes);
            return;
        }
        // $20-$27: RL pan bits plus algorithm/feedback. OPM stores each channel's
        // pan in the same register, so emit a portable CC10 state change.
        if (reg >= 0x20 && reg <= 0x27) {
            const key = `ym2151_${reg - 0x20}`;
            this.addPan(key, (data & 0x80) !== 0, (data & 0x40) !== 0, currentTime);
            const state = this.channels.get(key);
            state.opnAlgorithm = data & 0x07;
            this.recordFMTimbreEvent(key, currentTime, 'opm-timbre');
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
            const state = this.channels.get(key);
            state.opnOperatorMultipliers ?? (state.opnOperatorMultipliers = [0, 0, 0, 0]);
            state.opnOperatorMultiplierWritten ?? (state.opnOperatorMultiplierWritten = [false, false, false, false]);
            state.opnOperatorMultipliers[logicalOperator] = data & 0x0F;
            state.opnOperatorMultiplierWritten[logicalOperator] = true;
            this.recordFMTimbreEvent(key, currentTime, 'opm-timbre');
            return;
        }
        // $60-$7f is operator TL, arranged as four 8-register channel groups.
        if (reg >= 0x60 && reg <= 0x7F) {
            const registerSlot = Math.floor((reg - 0x60) / 8);
            const logicalOperator = YM2151_LOGICAL_OPERATOR_BY_REGISTER_SLOT[registerSlot];
            const channel = (reg - 0x60) & 0x07;
            const state = this.channels.get(`ym2151_${channel}`);
            state.opnOperatorTotalLevels ?? (state.opnOperatorTotalLevels = [0, 0, 0, 0]);
            state.opnOperatorTotalLevels[logicalOperator] = data & 0x7F;
            if (state.active) {
                this.addExpression(`ym2151_${channel}`, this.opnCarrierExpression(state), currentTime);
            }
            this.recordFMTimbreEvent(`ym2151_${channel}`, currentTime, 'opm-timbre');
            return;
        }
        // Register $0F: bit7 enables noise on channel 7; bits0-4 (NFRQ) select its frequency.
        if (reg === 0x0F) {
            const state = this.channels.get('ym2151_7');
            const oldNoisePeriod = state.noisePeriod;
            const wasNoiseActive = state.isNoiseActive;
            state.isNoise = (data & 0x80) !== 0;
            state.noisePeriod = data & 0x1F;
            this.syncYM2151ToneState(7, false, currentTime, activeNotes);
            this.syncYM2151NoiseState(false, currentTime, activeNotes);
            // Same "still active, rate moved to a different drum band" re-evaluation as
            // HuC6280's $07 handler — syncYM2151NoiseState() above already handles a fresh
            // on/off transition, this only covers NFRQ changing without a mode change.
            if (wasNoiseActive
                && state.isNoiseActive
                && oldNoisePeriod !== undefined
                && this.ym2151NoiseNoteForPeriod(state.noisePeriod) !== this.ym2151NoiseNoteForPeriod(oldNoisePeriod)) {
                const noiseKey = 'ym2151_noise_7';
                this.noteOff(noiseKey, 7, currentTime, activeNotes);
                this.noteOnPercussion(noiseKey, 80, currentTime, activeNotes, this.ym2151NoiseNoteForPeriod(state.noisePeriod));
            }
            return;
        }
        // Register $08: bits 0-2 select the channel and bits 3-6 key its four operators.
        if (reg === 0x08) {
            const channel = data & 0x07;
            const key = `ym2151_${channel}`;
            const state = this.channels.get(key);
            const timer = this.opmCsmTimer(cmd.instance ?? 0);
            timer.manualKeyOnMasks ?? (timer.manualKeyOnMasks = new Array(8).fill(0));
            timer.manualKeyOnMasks[channel] = (data >> 3) & 0x0F;
            const csmMask = timer.nextRelease === undefined ? 0 : 0x0F;
            state.keyOnMask = timer.manualKeyOnMasks[channel] | csmMask;
            // A repeated key-on retriggers the YM2151 envelope, so mirror that onset in MIDI.
            this.syncYM2151ToneState(channel, true, currentTime, activeNotes);
            if (channel === 7)
                this.syncYM2151NoiseState(true, currentTime, activeNotes);
            return;
        }
        // Registers $28-$2F: octave/key code; $30-$37: 1/64-semitone key fraction.
        if (reg >= 0x28 && reg <= 0x2F) {
            const channel = reg - 0x28;
            const key = `ym2151_${channel}`;
            const state = this.channels.get(key);
            const oldKeyCode = state.keyCode;
            state.keyCode = data & 0x7F;
            if (state.active && state.keyCode !== oldKeyCode) {
                this.updateKeyBoundFMPitch(key, currentTime, activeNotes, YM2151_FM_PITCH_BEND_RANGE);
            }
        }
        else if (reg >= 0x30 && reg <= 0x37) {
            const channel = reg - 0x30;
            const key = `ym2151_${channel}`;
            const state = this.channels.get(key);
            const oldKeyFraction = state.keyFraction;
            state.keyFraction = (data >> 2) & 0x3F;
            if (state.active && state.keyFraction !== oldKeyFraction) {
                this.updateKeyBoundFMPitch(key, currentTime, activeNotes, YM2151_FM_PITCH_BEND_RANGE);
            }
        }
    }
    syncYM2151ToneState(channel, shouldRetrigger, currentTime, activeNotes) {
        const key = `ym2151_${channel}`;
        const state = this.channels.get(key);
        const noiseOperatorMask = channel === 7 && state.isNoise ? YM2151_C2_OPERATOR_MASK : 0;
        const shouldSound = ((state.keyOnMask || 0) & ~noiseOperatorMask) !== 0;
        if (shouldSound && (!state.active || shouldRetrigger)) {
            if (state.active)
                this.noteOff(key, channel, currentTime, activeNotes);
            state.active = true;
            state.opnActiveVelocity = this.opnCarrierVelocity(state);
            this.noteOn(key, channel, currentTime, activeNotes);
        }
        else if (!shouldSound && state.active) {
            state.active = false;
            this.noteOff(key, channel, currentTime, activeNotes);
        }
    }
    syncYM2151NoiseState(shouldRetrigger, currentTime, activeNotes) {
        const state = this.channels.get('ym2151_7');
        const noiseKey = 'ym2151_noise_7';
        const shouldSound = state.isNoise && ((state.keyOnMask || 0) & YM2151_C2_OPERATOR_MASK) !== 0;
        if (shouldSound && (!state.isNoiseActive || shouldRetrigger)) {
            if (state.isNoiseActive)
                this.noteOff(noiseKey, 7, currentTime, activeNotes);
            state.isNoiseActive = true;
            this.noteOnPercussion(noiseKey, 80, currentTime, activeNotes, this.ym2151NoiseNoteForPeriod(state.noisePeriod ?? 0));
        }
        else if (!shouldSound && state.isNoiseActive) {
            state.isNoiseActive = false;
            this.noteOff(noiseKey, 7, currentTime, activeNotes);
        }
    }
    // Confirmed against ymfm_opm.cpp: the noise LFSR advances when a counter that
    // increments every sample reaches the NFRQ-derived threshold (`m_noise_counter++ >=
    // freq`). A LARGER NFRQ raises that threshold, so the counter takes longer to reach it
    // and the noise updates LESS often — pitch is LOWER. (Opposite direction from
    // HuC6280's $07 above.)
    ym2151NoiseNoteForPeriod(nfrq) {
        const normalizedRate = (31 - (nfrq & 0x1F)) / 31;
        return noiseDrumNote(normalizedRate, false);
    }
    handleHuC6280Write(cmd, currentTime, activeNotes, cmdIndex) {
        if (cmd.register === undefined || cmd.data === undefined)
            return;
        const instance = cmd.instance === 1 ? 1 : 0;
        const reg = cmd.register;
        const data = cmd.data;
        // Register $00: channel select (0-5). Every subsequent register write until the
        // next $00 targets whichever channel was selected here.
        if (reg === 0x00) {
            this.huc6280SelectedChannels[instance] = data & 0x07;
            return;
        }
        if (reg === 0x01) {
            this.huc6280GlobalBalance[instance] = data;
            for (let index = 0; index < 6; index += 1)
                this.updateHuC6280Pan(instance, index, currentTime);
            return;
        }
        const channel = this.huc6280SelectedChannels[instance];
        if (channel > 5)
            return; // Only 6 channels (0-5) exist on the real chip
        const key = `huc6280_${instance}_${channel}`;
        const state = this.channels.get(key);
        if (reg === 0x02) {
            // Frequency (low 8 bits). $02/$03 are always written as a pair, so peek ahead
            // for the matching $03 write before reacting — otherwise every frequency change
            // briefly passes through a bogus intermediate value (new LSB + stale MSB) and
            // retriggers a spurious note, the same problem handlePSGWrite() already guards
            // against for SN76489's split tone-frequency writes.
            const oldFreq = state.frequency;
            state.freqLSB = data;
            state.frequency = ((state.freqMSB || 0) << 8) | (state.freqLSB || 0);
            if (state.active && state.frequency !== oldFreq && !this.isHuC6280MultiByteFreqUpdate(cmdIndex, 0x03, instance)) {
                this.updateNotePitch(key, channel, currentTime, activeNotes);
            }
        }
        else if (reg === 0x03) {
            // Frequency (high 4 bits) - same split-write guard as $02 above.
            const oldFreq = state.frequency;
            state.freqMSB = data & 0x0F;
            state.frequency = ((state.freqMSB || 0) << 8) | (state.freqLSB || 0);
            if (state.active && state.frequency !== oldFreq && !this.isHuC6280MultiByteFreqUpdate(cmdIndex, 0x02, instance)) {
                this.updateNotePitch(key, channel, currentTime, activeNotes);
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
            this.syncHuC6280ToneState(key, channel, currentTime, activeNotes);
            this.syncHuC6280NoiseState(key, channel, currentTime, activeNotes);
            if (wasActive && state.active && oldVolume !== volume) {
                this.addHuC6280Expression(key, volume, currentTime);
            }
            if (wasNoiseActive && state.isNoiseActive) {
                this.updateHuC6280NoiseEnvelope(key, channel, oldVolume, currentTime, activeNotes);
            }
        }
        else if (reg === 0x07 && channel >= 4) {
            // Noise control (channels 4-5 only). MIDI has no synthesized-noise
            // equivalent, so emit its rhythm on the GM percussion channel instead.
            const oldNoisePeriod = state.noisePeriod;
            const wasNoiseActive = state.isNoiseActive;
            state.isNoise = (data & 0x80) !== 0;
            state.noisePeriod = data & 0x1F;
            this.syncHuC6280ToneState(key, channel, currentTime, activeNotes);
            this.syncHuC6280NoiseState(key, channel, currentTime, activeNotes);
            // Only re-evaluate a rate change on a channel that was already sounding noise
            // before and after this write — syncHuC6280NoiseState() above already handles a
            // fresh on/off transition, so this only covers "still active, rate moved to a
            // different drum band" without double-triggering a note that was just started.
            if (wasNoiseActive
                && state.isNoiseActive
                && oldNoisePeriod !== undefined
                && this.huc6280NoiseNoteForPeriod(state.noisePeriod) !== this.huc6280NoiseNoteForPeriod(oldNoisePeriod)) {
                const noiseKey = `huc6280_${instance}_noise_${channel}`;
                this.noteOff(noiseKey, channel, currentTime, activeNotes);
                this.noteOnHuC6280Noise(noiseKey, state, currentTime, activeNotes);
            }
        }
        else if (reg === 0x05) {
            state.balance = data;
            this.updateHuC6280Pan(instance, channel, currentTime);
        }
    }
    updateHuC6280Pan(instance, channel, currentTime) {
        const key = `huc6280_${instance}_${channel}`;
        const local = this.channels.get(key)?.balance ?? 0xFF;
        const global = this.huc6280GlobalBalance[instance];
        const hasLeft = ((local >> 4) & 0x0F) > 0 && ((global >> 4) & 0x0F) > 0;
        const hasRight = (local & 0x0F) > 0 && (global & 0x0F) > 0;
        this.addPan(key, hasLeft, hasRight, currentTime);
    }
    handleSegaPCMWrite(cmd, currentTime) {
        if (cmd.register === undefined || cmd.data === undefined)
            return;
        const register = cmd.register & 0xFF;
        const data = cmd.data;
        this.segaPCMRegisters[register] = data;
        if ((register & 0x87) !== 0x86)
            return;
        const channel = (register & 0x78) >> 3;
        if ((data & 0x01) !== 0) {
            this.stopPCMVoice(this.segaPCMActiveVoices, channel, currentTime);
        }
        else {
            this.triggerSegaPCMVoice(channel, data, cmd.instance ?? 0, currentTime);
        }
    }
    triggerSegaPCMVoice(channel, control, instance, currentTime) {
        this.stopPCMVoice(this.segaPCMActiveVoices, channel, currentTime);
        const base = channel << 3;
        const address = (this.segaPCMRegisters[base + 0x84] << 8)
            | (this.segaPCMRegisters[base + 0x85] << 16);
        const sampleId = `${(control & 0x70).toString(16).padStart(2, '0')}${address.toString(16).padStart(6, '0')}`;
        const trackKey = `segapcm_sample_${sampleId}`;
        // base+2 = left volume, base+3 = right volume.
        const left = this.segaPCMRegisters[base + 2];
        const right = this.segaPCMRegisters[base + 3];
        const volume = Math.max(left, right);
        const velocity = Math.max(1, Math.round((Math.min(127, volume) / 127) * 100));
        const note = this.pcmNoteForSample(trackKey);
        const total = left + right;
        this.addPCMPan(trackKey, total > 0 ? Math.round((right / total) * 127) : 64, currentTime);
        const dataBlock = this.pcmROMDataBlockForAddress(0x80, instance, address);
        // SegaPCM's current/loop address is 16.8 fixed point.  Its end register
        // names the final 256-byte page, therefore the useful end is exclusive.
        const endAddressExclusive = (this.segaPCMRegisters[base + 0x06] + 1) << 8;
        const isLoop = (control & 0x02) === 0;
        const durationSamples = isLoop
            ? undefined
            : this.segaPCMDurationSamples(address, this.segaPCMRegisters[base + 0x06], this.segaPCMRegisters[base + 0x07]);
        const loopAddress = this.segaPCMRegisters[base + 0x04]
            | (this.segaPCMRegisters[base + 0x05] << 8);
        const descriptorId = this.noteOnPCMPercussion(trackKey, note, velocity, currentTime, isLoop, dataBlock, durationSamples, { endAddressExclusive, ...(isLoop ? { loopAddress } : {}) });
        this.segaPCMActiveVoices[channel] = { descriptorId, note };
    }
    /** SegaPCMの非ループ範囲を、VGMの44.1 kHz時間単位へ概算変換する。 */
    segaPCMDurationSamples(address, endPage, frequency) {
        if (frequency === 0)
            return undefined;
        const clock = this.vgmData.header.segaPCMClock & vgm_chip_metadata_1.CLOCK_MASK;
        if (clock === 0)
            return undefined;
        // The 315-5218's 16 voices advance their 16.8 address at clock / 128.
        const endAddress = ((endPage + 1) & 0xFF) << 16;
        const distance = (endAddress - address + 0x1000000) & 0xFFFFFF;
        if (distance === 0)
            return undefined;
        return Math.round((distance * this.sampleRate * 128) / (frequency * clock));
    }
    handleC140Write(cmd, currentTime) {
        if (cmd.register === undefined || cmd.data === undefined)
            return;
        const register = cmd.register & 0x1FF;
        const data = cmd.data;
        this.c140Registers[register] = data;
        if (register >= 0x180 || (register & 0x0F) !== 0x05)
            return;
        const channel = register >> 4;
        const isActive = this.c140ActiveVoices[channel] !== undefined;
        const shouldTrigger = (data & 0x80) !== 0 || ((data & 0x40) !== 0 && isActive);
        if (shouldTrigger)
            this.triggerC140Voice(channel, cmd.instance ?? 0, currentTime);
        else
            this.stopPCMVoice(this.c140ActiveVoices, channel, currentTime);
    }
    triggerC140Voice(channel, instance, currentTime) {
        this.stopPCMVoice(this.c140ActiveVoices, channel, currentTime);
        const base = channel << 4;
        const bank = this.c140Registers[base + 4];
        const start = (this.c140Registers[base + 6] << 8) | this.c140Registers[base + 7];
        const sampleId = `${bank.toString(16).padStart(2, '0')}${start.toString(16).padStart(4, '0')}`;
        const trackKey = `c140_sample_${sampleId}`;
        // Confirmed against MAME's c140.cpp: base+0 = right volume, base+1 = left volume
        // (opposite order from SegaPCM above).
        const right = this.c140Registers[base];
        const left = this.c140Registers[base + 1];
        const volume = Math.max(left, right);
        const velocity = Math.max(1, Math.round((Math.min(127, volume) / 127) * 100));
        const note = this.pcmNoteForSample(trackKey);
        const total = left + right;
        this.addPCMPan(trackKey, total > 0 ? Math.round((right / total) * 127) : 64, currentTime);
        const end = (this.c140Registers[base + 8] << 8) | this.c140Registers[base + 9];
        const isLoop = (this.c140Registers[base + 5] & 0x10) !== 0;
        const isC219Noise = this.vgmData.header.c140Type === 2 && (this.c140Registers[base + 5] & 0x04) !== 0;
        const loop = (this.c140Registers[base + 10] << 8) | this.c140Registers[base + 11];
        const startAddress = this.c140ROMAddress(channel, bank, start);
        const dataBlock = this.pcmROMDataBlockForAddress(0x8D, instance, startAddress);
        const frequency = (this.c140Registers[base + 2] << 8) | this.c140Registers[base + 3];
        const durationSamples = isLoop || isC219Noise
            ? undefined
            : this.c140DurationSamples(start, end, frequency);
        const descriptorId = this.noteOnPCMPercussion(trackKey, note, velocity, currentTime, isLoop, dataBlock, durationSamples, {
            endAddressExclusive: this.c140ROMAddress(channel, bank, end),
            ...(isLoop ? { loopAddress: this.c140ROMAddress(channel, bank, loop) } : {}),
        });
        this.c140ActiveVoices[channel] = { descriptorId, note };
    }
    /** C140/C219の非ループ範囲を、VGMの44.1 kHz時間単位へ概算変換する。 */
    c140DurationSamples(start, end, frequency) {
        if (end <= start || frequency === 0)
            return undefined;
        const inputClock = this.vgmData.header.c140Clock & vgm_chip_metadata_1.CLOCK_MASK;
        if (inputClock === 0)
            return undefined;
        // VGMPlay's C140 core treats a MHz-class header clock as the input clock and
        // derives its base rate by /384; already-low clocks are an explicit base rate.
        const baseRate = inputClock >= 1000000 ? Math.floor(inputClock / 384) : inputClock;
        if (baseRate === 0)
            return undefined;
        const addressLength = (end - start) * (this.vgmData.header.c140Type === 2 ? 2 : 1);
        return Math.round((addressLength * this.sampleRate * 65536) / (frequency * baseRate * 2));
    }
    /** C140系レジスタのバンク・開始位置を、VGM ROM blockで使う物理ROMアドレスへ変換する。 */
    c140ROMAddress(channel, bank, address) {
        const logicalAddress = (bank << 16) | address;
        if (this.vgmData.header.c140Type === 1) {
            // System 21 はC140の論理アドレスをROM配線に合わせて並べ替える。
            return (logicalAddress & 0x7FFFF) | ((logicalAddress & 0x300000) >> 1);
        }
        if (this.vgmData.header.c140Type === 2) {
            // C219 (NA-1/NA-2): 音声アドレスはword単位、4音声ごとの外部bankは128 KiB単位。
            const externalBankRegisters = [0x1F7, 0x1F1, 0x1F3, 0x1F5];
            const externalBank = this.c140Registers[externalBankRegisters[Math.floor(channel / 4)]] & 0x03;
            return (externalBank << 17) + (bank << 16) + (address << 1);
        }
        return logicalAddress;
    }
    handleOPLWrite(cmd, currentTime, activeNotes, cmdIndex) {
        if (cmd.register === undefined || cmd.data === undefined)
            return;
        if (!OPL_CHIPS.includes(cmd.chip))
            return;
        const chip = cmd.chip;
        const instance = cmd.instance === 1 ? 1 : 0;
        const register = cmd.register;
        const data = cmd.data;
        if (register === 0xBD) {
            this.handleOPLRhythmWrite(chip, instance, data, currentTime, activeNotes);
        }
        else if (register >= 0x20 && register <= 0x35) {
            this.setOPLOperatorMultiple(chip, instance, register, data, currentTime);
        }
        else if (register >= 0x40 && register <= 0x55) {
            this.setOPLOperatorTotalLevel(chip, instance, register, data, currentTime, activeNotes);
        }
        else if (register >= 0xA0 && register <= 0xA8) {
            this.updateOPLFrequencyLow(chip, instance, register - 0xA0, data, currentTime, activeNotes, cmdIndex);
        }
        else if (register >= 0xB0 && register <= 0xB8) {
            this.updateOPLKeyAndBlock(chip, instance, register - 0xB0, data, currentTime, activeNotes, cmdIndex);
        }
        else if (register >= 0xC0 && register <= 0xC8) {
            this.setOPLConnection(chip, instance, register - 0xC0, data, currentTime);
        }
    }
    oplKey(chip, instance, section, channel) {
        return `${chip.toLowerCase()}_${instance}_${section}_${channel}`;
    }
    oplOperatorSlot(register, bankStart) {
        return OPL_SLOT_BY_REGISTER_OFFSET[register - bankStart];
    }
    setOPLOperatorMultiple(chip, instance, register, data, currentTime) {
        const slot = this.oplOperatorSlot(register, 0x20);
        if (!slot)
            return;
        const [channel, operator] = slot;
        const state = this.channels.get(this.oplKey(chip, instance, 'fm', channel));
        state.opnOperatorMultipliers[operator] = data & 0x0F;
        state.opnOperatorMultiplierWritten[operator] = true;
        this.recordFMTimbreEvent(this.oplKey(chip, instance, 'fm', channel), currentTime, 'opl-timbre');
    }
    setOPLOperatorTotalLevel(chip, instance, register, data, currentTime, activeNotes) {
        const slot = this.oplOperatorSlot(register, 0x40);
        if (!slot)
            return;
        const [channel, operator] = slot;
        const key = this.oplKey(chip, instance, 'fm', channel);
        const state = this.channels.get(key);
        state.opnOperatorTotalLevels[operator] = data & 0x3F;
        if (state.active)
            this.addExpression(key, this.oplCarrierExpression(state), currentTime);
        this.recordFMTimbreEvent(key, currentTime, 'opl-timbre');
        if (!this.oplRhythmModes.get(`${chip}_${instance}`))
            return;
        for (let index = 0; index < OPL_RHYTHM_SLOTS.length; index++) {
            const [rhythmChannel, rhythmOperator] = OPL_RHYTHM_SLOTS[index];
            if (rhythmChannel !== channel || rhythmOperator !== operator)
                continue;
            const rhythmKey = this.oplKey(chip, instance, 'rhythm', index);
            if (!activeNotes.has(rhythmKey))
                continue;
            const expression = Math.round((this.oplRhythmVelocity(chip, instance, index) / 100) * 127);
            this.addExpression(rhythmKey, expression, currentTime);
        }
    }
    setOPLConnection(chip, instance, channel, data, currentTime) {
        const key = this.oplKey(chip, instance, 'fm', channel);
        const state = this.channels.get(key);
        state.opnAlgorithm = data & 0x01;
        this.recordFMTimbreEvent(key, currentTime, 'opl-timbre');
    }
    updateOPLFrequencyLow(chip, instance, channel, data, currentTime, activeNotes, cmdIndex) {
        const key = this.oplKey(chip, instance, 'fm', channel);
        const state = this.channels.get(key);
        const oldFrequency = state.frequency;
        state.freqLSB = data;
        state.frequency = ((state.freqMSB ?? 0) << 8) | data;
        if (this.oplRhythmModes.get(`${chip}_${instance}`) && channel >= 6)
            return;
        if (state.oplPendingKeyOn) {
            state.oplPendingKeyOn = false;
            this.commitOPLKeyOn(chip, instance, channel, currentTime, activeNotes);
            return;
        }
        const isSplitUpdate = this.isOPNMultiByteFreqUpdate(cmdIndex, chip, 0, 0xB0 + channel, instance);
        const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
        state.hasPendingFrequencyUpdate = isSplitUpdate;
        if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
            this.updateKeyBoundFMPitch(key, currentTime, activeNotes, OPL_FM_PITCH_BEND_RANGE);
        }
    }
    updateOPLKeyAndBlock(chip, instance, channel, data, currentTime, activeNotes, cmdIndex) {
        const key = this.oplKey(chip, instance, 'fm', channel);
        const state = this.channels.get(key);
        const oldFrequency = state.frequency;
        const wasKeyOn = state.oplKeyOn ?? false;
        const isKeyOn = (data & 0x20) !== 0;
        state.freqMSB = data & 0x03;
        state.block = (data >> 2) & 0x07;
        state.frequency = ((state.freqMSB ?? 0) << 8) | (state.freqLSB ?? 0);
        state.oplKeyOn = isKeyOn;
        const isSplitUpdate = this.isOPNMultiByteFreqUpdate(cmdIndex, chip, 0, 0xA0 + channel, instance);
        const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
        state.hasPendingFrequencyUpdate = isSplitUpdate;
        if (this.oplRhythmModes.get(`${chip}_${instance}`) && channel >= 6)
            return;
        if (isKeyOn && !wasKeyOn) {
            if (isSplitUpdate)
                state.oplPendingKeyOn = true;
            else
                this.commitOPLKeyOn(chip, instance, channel, currentTime, activeNotes);
        }
        else if (!isKeyOn && wasKeyOn) {
            state.oplPendingKeyOn = false;
            if (state.active) {
                state.active = false;
                this.noteOff(key, 0, currentTime, activeNotes);
            }
        }
        else if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
            this.updateKeyBoundFMPitch(key, currentTime, activeNotes, OPL_FM_PITCH_BEND_RANGE);
        }
    }
    commitOPLKeyOn(chip, instance, channel, currentTime, activeNotes) {
        const key = this.oplKey(chip, instance, 'fm', channel);
        const state = this.channels.get(key);
        if (state.active)
            return;
        state.opnActiveVelocity = this.oplCarrierVelocity(state);
        state.opnActivePitchScale = this.oplPitchScale(state);
        state.active = true;
        this.noteOn(key, 0, currentTime, activeNotes);
    }
    handleOPLRhythmWrite(chip, instance, data, currentTime, activeNotes) {
        const stateKey = `${chip}_${instance}`;
        const wasRhythmMode = this.oplRhythmModes.get(stateKey) ?? false;
        const isRhythmMode = (data & 0x20) !== 0;
        if (isRhythmMode !== wasRhythmMode) {
            for (const channel of [6, 7, 8]) {
                const key = this.oplKey(chip, instance, 'fm', channel);
                const state = this.channels.get(key);
                if (!state.active)
                    continue;
                state.active = false;
                this.noteOff(key, 0, currentTime, activeNotes);
            }
            for (let index = 0; index < OPL_RHYTHM_NOTES.length; index++) {
                const key = this.oplKey(chip, instance, 'rhythm', index);
                if (activeNotes.has(key))
                    this.noteOff(key, 0, currentTime, activeNotes);
            }
            this.oplRhythmModes.set(stateKey, isRhythmMode);
            this.oplRhythmControlBytes.set(stateKey, 0);
        }
        if (!isRhythmMode)
            return;
        const newBits = data & 0x1F;
        const oldBits = this.oplRhythmControlBytes.get(stateKey) ?? 0;
        const changedBits = newBits ^ oldBits;
        this.oplRhythmControlBytes.set(stateKey, newBits);
        for (let index = 0; index < OPL_RHYTHM_KEY_BITS.length; index++) {
            const bit = OPL_RHYTHM_KEY_BITS[index];
            if ((changedBits & bit) === 0)
                continue;
            const key = this.oplKey(chip, instance, 'rhythm', index);
            if ((newBits & bit) !== 0) {
                this.noteOnPercussion(key, this.oplRhythmVelocity(chip, instance, index), currentTime, activeNotes, OPL_RHYTHM_NOTES[index]);
            }
            else if (activeNotes.has(key)) {
                this.noteOff(key, 0, currentTime, activeNotes);
            }
        }
    }
    oplRhythmVelocity(chip, instance, index) {
        const [channel, operator] = OPL_RHYTHM_SLOTS[index];
        const state = this.channels.get(this.oplKey(chip, instance, 'fm', channel));
        return this.operatorTotalLevelVelocity(state.opnOperatorTotalLevels?.[operator] ?? 0);
    }
    handleYM2413Write(cmd, currentTime, activeNotes, cmdIndex) {
        if (cmd.register === undefined || cmd.data === undefined)
            return;
        const reg = cmd.register;
        const data = cmd.data;
        const instance = cmd.instance ?? 0;
        if (reg >= 0x00 && reg <= 0x07) {
            this.ym2413CustomPatch[reg] = data;
            if (reg === 0x01)
                this.hasYM2413CustomCarrierMultiple = true;
            for (let channel = 0; channel < 9; channel++) {
                if (this.channels.get(`ym2413_${channel}`).ym2413Instrument === 0) {
                    this.recordYM2413TimbreEvent(channel, currentTime, 'ym2413-custom-patch');
                }
            }
            return;
        }
        if (reg === 0x0E) {
            this.handleYM2413RhythmModeWrite(data, currentTime, activeNotes);
            return;
        }
        if (reg >= 0x10 && reg <= 0x18) {
            this.updateYM2413Frequency(reg - 0x10, currentTime, activeNotes, cmdIndex, data, cmd.instance ?? 0);
            return;
        }
        if (reg >= 0x20 && reg <= 0x28) {
            this.handleYM2413KeyAndFrequencyWrite(reg - 0x20, currentTime, activeNotes, cmdIndex, data, cmd.instance ?? 0);
            return;
        }
        if (reg >= 0x30 && reg <= 0x38) {
            this.handleYM2413VolumeWrite(reg - 0x30, data, currentTime, activeNotes);
        }
    }
    // Register $0E bit 5 toggles rhythm mode; bits 0-4 (while rhythm mode is on) are the
    // five percussion key-on bits. See YM2413_RHYTHM_* above for the bit/note mapping.
    handleYM2413RhythmModeWrite(data, currentTime, activeNotes) {
        const wasRhythmMode = this.ym2413RhythmMode;
        const isRhythmMode = (data & 0x20) !== 0;
        if (isRhythmMode !== wasRhythmMode) {
            // Channels 6-8 are about to change what they represent (one melodic voice each <->
            // two-operator-pair percussion), so close whichever of those five possibly-active
            // keys are currently sounding — the same principle as YM2612 channel 3 special
            // mode's own mode-switch handling and HuC6280's tone/noise switch.
            for (const channel of [6, 7, 8]) {
                const key = `ym2413_${channel}`;
                const state = this.channels.get(key);
                if (state.active) {
                    state.active = false;
                    this.noteOff(key, 0, currentTime, activeNotes);
                }
            }
            for (let i = 0; i < YM2413_RHYTHM_NOTES.length; i++) {
                const key = `ym2413_rhythm_${i}`;
                if (activeNotes.has(key))
                    this.noteOff(key, 0, currentTime, activeNotes);
            }
            this.ym2413RhythmMode = isRhythmMode;
            this.ym2413RhythmControlByte = 0;
        }
        if (!isRhythmMode)
            return;
        const newBits = data & 0x1F;
        const changedBits = newBits ^ (this.ym2413RhythmControlByte & 0x1F);
        this.ym2413RhythmControlByte = data;
        for (let i = 0; i < YM2413_RHYTHM_KEY_BITS.length; i++) {
            const bit = YM2413_RHYTHM_KEY_BITS[i];
            if ((changedBits & bit) === 0)
                continue;
            const key = `ym2413_rhythm_${i}`;
            if ((newBits & bit) !== 0) {
                this.noteOnPercussion(key, this.ym2413RhythmVelocity(i), currentTime, activeNotes, YM2413_RHYTHM_NOTES[i]);
            }
            else if (activeNotes.has(key)) {
                this.noteOff(key, 0, currentTime, activeNotes);
            }
        }
    }
    updateYM2413Frequency(channel, currentTime, activeNotes, cmdIndex, data, instance) {
        const key = `ym2413_${channel}`;
        const state = this.channels.get(key);
        const oldFrequency = state.frequency;
        state.freqLSB = data;
        state.frequency = ((state.freqMSB ?? 0) << 8) | (state.freqLSB ?? 0);
        // Not audible while this channel is rhythm-controlled, but the pitch state is still
        // latched above so it stays consistent if rhythm mode later turns back off.
        if (this.ym2413RhythmMode && channel >= 6)
            return;
        if (state.ym2413PendingKeyOn) {
            state.ym2413PendingKeyOn = false;
            this.commitYM2413KeyOn(channel, currentTime, activeNotes);
            return;
        }
        const otherReg = 0x20 + channel;
        const isSplitUpdate = this.isOPNMultiByteFreqUpdate(cmdIndex, 'YM2413', 0, otherReg, instance);
        const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
        state.hasPendingFrequencyUpdate = isSplitUpdate;
        if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
            this.updateNotePitch(key, 0, currentTime, activeNotes);
        }
    }
    // $20-$28: bit0=F-Number MSB (9th bit), bits1-3=block, bit4=key-on, bit5=sustain (not
    // modeled — no chip in this file currently distinguishes EG sustain/release shape).
    handleYM2413KeyAndFrequencyWrite(channel, currentTime, activeNotes, cmdIndex, data, instance) {
        const key = `ym2413_${channel}`;
        const state = this.channels.get(key);
        state.freqMSB = data & 0x01;
        state.block = (data >> 1) & 0x07;
        const oldFrequency = state.frequency;
        state.frequency = ((state.freqMSB ?? 0) << 8) | (state.freqLSB ?? 0);
        const otherReg = 0x10 + channel;
        const isSplitUpdate = this.isOPNMultiByteFreqUpdate(cmdIndex, 'YM2413', 0, otherReg, instance);
        const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
        state.hasPendingFrequencyUpdate = isSplitUpdate;
        // While rhythm mode has channels 6-8 repurposed, their own key-on bit here is ignored
        // — the $0E rhythm key bits are the sole trigger for those voices (see
        // handleYM2413RhythmModeWrite()). Frequency/block are still latched above.
        if (this.ym2413RhythmMode && channel >= 6)
            return;
        const isKeyOn = (data & 0x10) !== 0;
        if (isKeyOn && !state.active) {
            // Drivers occasionally write $20 (key-on/MSB) before $10 (LSB).  Defer just this
            // adjacent pair so the note starts with the final 9-bit F-Number rather than a stale
            // low byte; commands not followed by its matching $10 retain immediate key-on.
            if (isSplitUpdate)
                state.ym2413PendingKeyOn = true;
            else
                this.commitYM2413KeyOn(channel, currentTime, activeNotes);
        }
        else if (!isKeyOn && state.active) {
            state.active = false;
            this.noteOff(key, 0, currentTime, activeNotes);
        }
        else if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
            this.updateNotePitch(key, 0, currentTime, activeNotes);
        }
    }
    /** YM2413 key-onを、両方のfrequency byteとpatch carrier Multiple確定後にcommitする。 */
    commitYM2413KeyOn(channel, currentTime, activeNotes) {
        const key = `ym2413_${channel}`;
        const state = this.channels.get(key);
        if (state.active)
            return;
        state.opnActiveVelocity = this.ym2413Velocity(state.volume);
        state.opnActivePitchScale = this.ym2413PitchScale(state);
        state.active = true;
        this.noteOn(key, 0, currentTime, activeNotes);
    }
    // $30-$38: upper nibble is normally the instrument number, which selects an initial GM
    // audition candidate and sidecar timbre snapshot; lower nibble is a 4-bit volume
    // (0=loudest, 15=quietest). In rhythm mode, $37/$38's upper
    // nibble is repurposed as HH/TOM volume (confirmed against emu2413's OPLL_writeReg()
    // $30-$38 case); the lower nibble always carries SD/CYM (or, for $30-$36, the normal
    // per-channel) volume.
    handleYM2413VolumeWrite(channel, data, currentTime, activeNotes) {
        const volume = data & 0x0F;
        if (this.ym2413RhythmMode && channel >= 6) {
            if (channel === 6) {
                this.ym2413RhythmVolumes[0] = volume; // BD
            }
            else if (channel === 7) {
                this.ym2413RhythmVolumes[1] = (data >> 4) & 0x0F; // HH
                this.ym2413RhythmVolumes[2] = volume; // SD
            }
            else {
                this.ym2413RhythmVolumes[3] = (data >> 4) & 0x0F; // TOM
                this.ym2413RhythmVolumes[4] = volume; // CYM
            }
            for (let i = 0; i < YM2413_RHYTHM_NOTES.length; i++) {
                const key = `ym2413_rhythm_${i}`;
                if (!activeNotes.has(key))
                    continue;
                const expression = Math.round((this.ym2413RhythmVelocity(i) / 100) * 127);
                this.addExpression(key, expression, currentTime);
            }
            return;
        }
        const key = `ym2413_${channel}`;
        const state = this.channels.get(key);
        state.ym2413Instrument = (data >> 4) & 0x0F;
        state.volume = volume;
        if (state.active) {
            const expression = Math.round((this.ym2413Velocity(volume) / 100) * 127);
            this.addExpression(key, expression, currentTime);
        }
        this.recordYM2413TimbreEvent(channel, currentTime, 'ym2413-patch');
    }
    // No authoritative dB/step figure was available for YM2413's 4-bit volume register
    // (unlike YM2612's well-documented 0.75dB/step Total Level), so this uses the same
    // simple linear mapping as SN76489's 4-bit attenuation register rather than asserting a
    // precision this chip's level curve doesn't have.
    ym2413Velocity(volume) {
        return Math.max(1, Math.min(100, Math.round(100 - volume * 6.6)));
    }
    ym2413RhythmVelocity(index) {
        return this.ym2413Velocity(this.ym2413RhythmVolumes[index]);
    }
    /** VGMの絶対sample時刻まで、両方のDMG APUフレームシーケンサを進める。 */
    advanceGBDMGFrameSequencers(targetSamples, activeNotes) {
        for (let instance = 0; instance < 2; instance++) {
            while (this.gbDmgNextFrameSamples[instance] <= targetSamples) {
                const frameTime = this.gbDmgNextFrameSamples[instance];
                this.withChipInstance('GBDMG', instance, () => {
                    this.clockGBDMGFrameStep(instance, frameTime, activeNotes);
                });
                this.gbDmgNextFrameSamples[instance] += GBDMG_FRAME_SAMPLES;
            }
        }
    }
    /** 512Hzの一段を実行し、長さ・sweep・envelopeの該当段だけをclockする。 */
    clockGBDMGFrameStep(instance, currentTime, activeNotes) {
        const step = this.gbDmgFrameSteps[instance];
        if ((step & 1) === 0)
            this.clockGBDMGLengths(currentTime, activeNotes);
        if (step === 2 || step === 6)
            this.clockGBDMGSweep(currentTime, activeNotes);
        if (step === 7)
            this.clockGBDMGEnvelopes(currentTime, activeNotes);
        this.gbDmgFrameSteps[instance] = (step + 1) & 7;
    }
    /** length-enableされた発音を256Hzで減算し、ゼロになった時点でMIDI Note Offにする。 */
    clockGBDMGLengths(currentTime, activeNotes) {
        for (const key of ['gbdmg_0', 'gbdmg_1', 'gbdmg_2', 'gbdmg_noise_0']) {
            const state = this.channels.get(key);
            if (!state.gbDmgLengthEnabled || !state.gbDmgLengthCounter)
                continue;
            state.gbDmgLengthCounter -= 1;
            if (state.gbDmgLengthCounter !== 0)
                continue;
            if (state.active)
                state.active = false;
            if (activeNotes.has(key))
                this.noteOff(key, 0, currentTime, activeNotes);
        }
    }
    /** Channel 1のNR10 sweepを128Hzで評価し、連続音程はpitch bendで表現する。 */
    clockGBDMGSweep(currentTime, activeNotes) {
        const state = this.channels.get('gbdmg_0');
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
            this.noteOff('gbdmg_0', 0, currentTime, activeNotes);
            return;
        }
        state.gbDmgSweepShadow = nextFrequency;
        state.frequency = nextFrequency;
        state.freqLSB = nextFrequency & 0xFF;
        state.freqMSB = (nextFrequency >> 8) & 0x07;
        if (state.active)
            this.updateNotePitch('gbdmg_0', 0, currentTime, activeNotes);
    }
    /** 64HzのDMG envelopeをCC11へ変換する。 */
    clockGBDMGEnvelopes(currentTime, activeNotes) {
        for (const key of ['gbdmg_0', 'gbdmg_1', 'gbdmg_noise_0']) {
            const state = this.channels.get(key);
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
            this.addExpression(key, Math.round((next / 15) * 127), currentTime);
        }
    }
    /** NRx2の初期音量とenvelope timerを、ハードウェアtrigger時に再初期化する。 */
    startGBDMGEnvelope(state) {
        state.gbDmgEnvelopeVolume = (state.volume >> 4) & 0x0F;
        state.gbDmgEnvelopePeriod = state.volume & 0x07;
        state.gbDmgEnvelopeTimer = state.gbDmgEnvelopePeriod || 8;
        state.gbDmgEnvelopeIncrease = (state.volume & 0x08) !== 0;
    }
    /** Channel 1 trigger時にNR10 shadow/timerを初期化する。 */
    startGBDMGSweep(state) {
        state.gbDmgSweepShadow = state.frequency;
        state.gbDmgSweepTimer = state.gbDmgSweepPeriod || 8;
        state.gbDmgSweepEnabled = (state.gbDmgSweepPeriod ?? 0) !== 0 || (state.gbDmgSweepShift ?? 0) !== 0;
    }
    /** NRx1/NR31/NR41の長さロード値を保存する。 */
    setGBDMGLength(key, data, maximum) {
        const state = this.channels.get(key);
        state.gbDmgLengthCounter = maximum - (data & (maximum - 1));
    }
    /** trigger時に長さ0をハードウェア最大値へ再ロードする。 */
    reloadGBDMGLength(state, maximum) {
        if ((state.gbDmgLengthCounter ?? 0) === 0)
            state.gbDmgLengthCounter = maximum;
    }
    /** NR50/NR51から指定DMGチャンネルの左右出力を求め、CC10を送る。 */
    updateGBDMGPan(key, channel, currentTime) {
        const isRightRouted = (this.gbDmgStereoRouting & (1 << channel)) !== 0 && (this.gbDmgMasterVolume & 0x07) !== 0;
        const isLeftRouted = (this.gbDmgStereoRouting & (1 << (channel + 4))) !== 0 && ((this.gbDmgMasterVolume >> 4) & 0x07) !== 0;
        this.addPan(key, isLeftRouted, isRightRouted, currentTime);
    }
    /** NR50/NR51更新後、現在鳴っているDMG voiceだけを再panする。 */
    refreshGBDMGPans(currentTime) {
        for (const [key, channel] of [['gbdmg_0', 0], ['gbdmg_1', 1], ['gbdmg_2', 2], ['gbdmg_noise_0', 3]]) {
            if (this.channels.get(key).active)
                this.updateGBDMGPan(key, channel, currentTime);
        }
    }
    // VGM register numbers equal GameBoy address minus $FF10 (see GBDMG_SQUARE_KEYS'
    // comment above).  Wave RAM ($20-$2F) is timbre data and intentionally not converted.
    handleGBDMGWrite(cmd, currentTime, activeNotes, cmdIndex) {
        if (cmd.register === undefined || cmd.data === undefined)
            return;
        const reg = cmd.register;
        const data = cmd.data;
        const instance = cmd.instance ?? 0;
        if (reg === 0x00) {
            this.handleGBDMGSweepWrite(data);
            return;
        }
        if (reg === 0x01) {
            this.setGBDMGLength('gbdmg_0', data, 64);
            return;
        }
        if (reg === 0x02) {
            this.handleGBDMGEnvelopeWrite('gbdmg_0', data, currentTime, activeNotes);
            return;
        }
        if (reg === 0x03) {
            this.updateGBDMGFrequencyLSB('gbdmg_0', 0x03, data, currentTime, activeNotes, cmdIndex, instance);
            return;
        }
        if (reg === 0x04) {
            this.handleGBDMGTriggerWrite('gbdmg_0', 0x04, data, currentTime, activeNotes, cmdIndex, instance);
            return;
        }
        if (reg === 0x06) {
            this.setGBDMGLength('gbdmg_1', data, 64);
            return;
        }
        if (reg === 0x07) {
            this.handleGBDMGEnvelopeWrite('gbdmg_1', data, currentTime, activeNotes);
            return;
        }
        if (reg === 0x08) {
            this.updateGBDMGFrequencyLSB('gbdmg_1', 0x08, data, currentTime, activeNotes, cmdIndex, instance);
            return;
        }
        if (reg === 0x09) {
            this.handleGBDMGTriggerWrite('gbdmg_1', 0x09, data, currentTime, activeNotes, cmdIndex, instance);
            return;
        }
        if (reg === 0x0A) {
            this.handleGBDMGWaveDACWrite(data, currentTime, activeNotes);
            return;
        }
        if (reg === 0x0B) {
            this.setGBDMGLength('gbdmg_2', data, 256);
            return;
        }
        if (reg === 0x0C) {
            this.handleGBDMGWaveOutputLevelWrite(data, currentTime, activeNotes);
            return;
        }
        if (reg === 0x0D) {
            this.updateGBDMGFrequencyLSB('gbdmg_2', 0x0D, data, currentTime, activeNotes, cmdIndex, instance);
            return;
        }
        if (reg === 0x0E) {
            this.handleGBDMGTriggerWrite('gbdmg_2', 0x0E, data, currentTime, activeNotes, cmdIndex, instance);
            return;
        }
        if (reg === 0x10) {
            this.setGBDMGLength('gbdmg_noise_0', data, 64);
            return;
        }
        if (reg === 0x11) {
            this.handleGBDMGNoiseEnvelopeWrite(data, currentTime, activeNotes);
            return;
        }
        if (reg === 0x12) {
            this.handleGBDMGNoiseFrequencyWrite(data, currentTime, activeNotes);
            return;
        }
        if (reg === 0x13) {
            this.handleGBDMGNoiseTriggerWrite(data, currentTime, activeNotes);
            return;
        }
        if (reg === 0x14) {
            this.gbDmgMasterVolume = data;
            this.refreshGBDMGPans(currentTime);
            return;
        }
        if (reg === 0x15) {
            this.gbDmgStereoRouting = data;
            this.refreshGBDMGPans(currentTime);
            return;
        }
        if (reg === 0x16)
            this.handleGBDMGMasterControlWrite(data, currentTime, activeNotes);
    }
    /** NR10のsweep設定をChannel 1へ保存し、次のtriggerから適用する。 */
    handleGBDMGSweepWrite(data) {
        const state = this.channels.get('gbdmg_0');
        state.gbDmgSweepPeriod = (data >> 4) & 0x07;
        state.gbDmgSweepNegate = (data & 0x08) !== 0;
        state.gbDmgSweepShift = data & 0x07;
    }
    // The DAC is enabled when the envelope register's upper 5 bits (initial volume + up/down
    // direction) are not all zero — confirmed against Pan Docs. Only channels 1/2/4 (pulse
    // and noise) read this from their envelope register; the wave channel (3) has a separate
    // dedicated DAC-enable bit (NR30 bit7, tracked in `isEnabled` — see
    // handleGBDMGWaveDACWrite()).
    gbDmgEnvelopeDacEnabled(rawEnvelope) {
        return (rawEnvelope & 0xF8) !== 0;
    }
    // 1-100 MIDI velocity from an envelope register's initial-volume nibble (0-15). Only the
    // initial volume is read, at trigger time — the hardware's own automatic envelope ramp
    // afterward is not replayed (see the "Deliberately not modeled" note above).
    gbDmgEnvelopeVelocity(rawEnvelope) {
        const initialVolume = (rawEnvelope >> 4) & 0x0F;
        return Math.max(1, Math.round((initialVolume / 15) * 100));
    }
    // Channels 1/2 (pulse) and 4 (noise) share this envelope-register shape (NR12/NR22/NR42):
    // bits7-4=initial volume, bit3=direction, bits2-0=sweep pace (not modeled). A transition
    // from DAC-enabled to DAC-disabled immediately silences the channel, matching real
    // hardware (confirmed against Pan Docs).
    handleGBDMGEnvelopeWrite(key, data, currentTime, activeNotes) {
        const state = this.channels.get(key);
        const wasEnabled = this.gbDmgEnvelopeDacEnabled(state.volume);
        state.volume = data;
        if (!state.active)
            this.startGBDMGEnvelope(state);
        if (wasEnabled && !this.gbDmgEnvelopeDacEnabled(data) && state.active) {
            state.active = false;
            this.noteOff(key, 0, currentTime, activeNotes);
        }
    }
    updateGBDMGFrequencyLSB(key, reg, data, currentTime, activeNotes, cmdIndex, instance) {
        const state = this.channels.get(key);
        const oldFrequency = state.frequency;
        state.freqLSB = data;
        state.frequency = ((state.freqMSB ?? 0) << 8) | (state.freqLSB ?? 0);
        const otherReg = reg + 1; // the paired NRx4 trigger/MSB register
        const isSplitUpdate = this.isOPNMultiByteFreqUpdate(cmdIndex, 'GBDMG', 0, otherReg, instance);
        const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
        state.hasPendingFrequencyUpdate = isSplitUpdate;
        if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
            this.updateNotePitch(key, 0, currentTime, activeNotes);
        }
    }
    // NRx4 (the paired trigger/frequency-MSB register for channels 1/2/3): bit7=trigger
    // (restart the voice), bit6=length enable (not modeled), bits2-0=frequency MSB. A
    // trigger while the channel's DAC is enabled retriggers (closing any note already
    // sounding first, the same pattern used elsewhere in this file for hardware "always
    // restarts on write" triggers, e.g. YM2608 rhythm and SegaPCM/C140); a trigger while the
    // DAC is disabled produces no sound, matching real hardware.
    handleGBDMGTriggerWrite(key, reg, data, currentTime, activeNotes, cmdIndex, instance) {
        const state = this.channels.get(key);
        const oldFrequency = state.frequency;
        state.freqMSB = data & 0x07;
        state.frequency = ((state.freqMSB ?? 0) << 8) | (state.freqLSB ?? 0);
        const otherReg = reg - 1; // the paired NRx3 frequency-LSB register
        const isSplitUpdate = this.isOPNMultiByteFreqUpdate(cmdIndex, 'GBDMG', 0, otherReg, instance);
        const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
        state.hasPendingFrequencyUpdate = isSplitUpdate;
        const isTrigger = (data & 0x80) !== 0;
        state.gbDmgLengthEnabled = (data & 0x40) !== 0;
        const isDacEnabled = key === 'gbdmg_2' ? (state.isEnabled ?? false) : this.gbDmgEnvelopeDacEnabled(state.volume);
        if (isTrigger) {
            this.reloadGBDMGLength(state, key === 'gbdmg_2' ? 256 : 64);
            if (key !== 'gbdmg_2')
                this.startGBDMGEnvelope(state);
            if (key === 'gbdmg_0')
                this.startGBDMGSweep(state);
            if (state.active) {
                state.active = false;
                this.noteOff(key, 0, currentTime, activeNotes);
            }
            if (isDacEnabled) {
                state.opnActiveVelocity = key === 'gbdmg_2'
                    ? this.gbDmgWaveVelocity(state.volume)
                    : this.gbDmgEnvelopeVelocity(state.volume);
                state.active = true;
                this.updateGBDMGPan(key, key === 'gbdmg_0' ? 0 : key === 'gbdmg_1' ? 1 : 2, currentTime);
                this.noteOn(key, 0, currentTime, activeNotes);
            }
        }
        else if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
            this.updateNotePitch(key, 0, currentTime, activeNotes);
        }
    }
    // NR30 (wave channel DAC enable, bit7). Distinct from the pulse/noise channels' envelope-
    // derived DAC state — the wave channel has no envelope of its own; NR32 controls its
    // fixed output level instead (see handleGBDMGWaveOutputLevelWrite()).
    handleGBDMGWaveDACWrite(data, currentTime, activeNotes) {
        const key = 'gbdmg_2';
        const state = this.channels.get(key);
        const wasEnabled = state.isEnabled ?? false;
        state.isEnabled = (data & 0x80) !== 0;
        if (wasEnabled && !state.isEnabled && state.active) {
            state.active = false;
            this.noteOff(key, 0, currentTime, activeNotes);
        }
    }
    // NR32 bits6-5: 0=mute, 1=100%, 2=50%, 3=25% output level. Stored directly in
    // `state.volume` (a 2-bit code, not a raw envelope byte, unlike the other channels) and
    // read back by gbDmgWaveVelocity(); reflected as expression on an already-sounding note
    // the same way YM2608's rhythm section resends volume changes.
    handleGBDMGWaveOutputLevelWrite(data, currentTime, activeNotes) {
        const key = 'gbdmg_2';
        const state = this.channels.get(key);
        state.volume = (data >> 5) & 0x03;
        if (state.active) {
            const expression = Math.round((this.gbDmgWaveVelocity(state.volume) / 100) * 127);
            this.addExpression(key, expression, currentTime);
        }
    }
    gbDmgWaveVelocity(outputLevelCode) {
        const percent = [0, 100, 50, 25][outputLevelCode] ?? 0;
        return Math.max(1, Math.round(percent));
    }
    handleGBDMGNoiseEnvelopeWrite(data, currentTime, activeNotes) {
        const key = 'gbdmg_noise_0';
        const state = this.channels.get(key);
        const wasEnabled = this.gbDmgEnvelopeDacEnabled(state.volume);
        state.volume = data;
        if (!activeNotes.has(key))
            this.startGBDMGEnvelope(state);
        if (wasEnabled && !this.gbDmgEnvelopeDacEnabled(data) && activeNotes.has(key)) {
            this.noteOff(key, 0, currentTime, activeNotes);
        }
    }
    // NR43: re-evaluates an already-sounding noise voice's GM drum band the same way
    // SN76489/AY-SSG/HuC6280/YM2151 do — retriggering only if the mapped note actually
    // changed, so a rate sweep that stays inside one band doesn't machine-gun notes.
    handleGBDMGNoiseFrequencyWrite(data, currentTime, activeNotes) {
        const key = 'gbdmg_noise_0';
        const state = this.channels.get(key);
        const oldNoisePeriod = state.noisePeriod ?? 0;
        state.noisePeriod = data;
        if (!activeNotes.has(key))
            return;
        const clockRate = this.vgmData.header.gbDmgClock;
        const oldNote = this.gbDmgNoiseNoteForPeriod(oldNoisePeriod, clockRate);
        const newNote = this.gbDmgNoiseNoteForPeriod(data, clockRate);
        if (oldNote === newNote)
            return;
        this.noteOff(key, 0, currentTime, activeNotes);
        this.noteOnPercussion(key, this.gbDmgEnvelopeVelocity(state.volume), currentTime, activeNotes, newNote);
    }
    // NR44: bit7=trigger, bit6=length enable (not modeled). Same retrigger-on-write pattern
    // as the melodic channels' NRx4 registers.
    handleGBDMGNoiseTriggerWrite(data, currentTime, activeNotes) {
        const key = 'gbdmg_noise_0';
        const state = this.channels.get(key);
        state.gbDmgLengthEnabled = (data & 0x40) !== 0;
        if ((data & 0x80) === 0)
            return;
        this.reloadGBDMGLength(state, 64);
        this.startGBDMGEnvelope(state);
        if (activeNotes.has(key))
            this.noteOff(key, 0, currentTime, activeNotes);
        if (this.gbDmgEnvelopeDacEnabled(state.volume)) {
            const note = this.gbDmgNoiseNoteForPeriod(state.noisePeriod ?? 0, this.vgmData.header.gbDmgClock);
            this.updateGBDMGPan(key, 3, currentTime);
            this.noteOnPercussion(key, this.gbDmgEnvelopeVelocity(state.volume), currentTime, activeNotes, note);
        }
    }
    // NR52 bit7=0 powers off the entire APU, immediately silencing every channel — the same
    // "power off" semantics used for e.g. YM2612's $2B DAC-disable elsewhere in this file.
    // Powering back on (bit7=1) does not by itself resume sound; a channel needs a fresh
    // trigger, matching real hardware.
    handleGBDMGMasterControlWrite(data, currentTime, activeNotes) {
        if ((data & 0x80) !== 0)
            return;
        for (const key of ['gbdmg_0', 'gbdmg_1', 'gbdmg_2']) {
            const state = this.channels.get(key);
            if (state.active) {
                state.active = false;
                this.noteOff(key, 0, currentTime, activeNotes);
            }
        }
        const noiseKey = 'gbdmg_noise_0';
        if (activeNotes.has(noiseKey))
            this.noteOff(noiseKey, 0, currentTime, activeNotes);
    }
    stopPCMVoice(activeVoices, channel, currentTime) {
        const voice = activeVoices[channel];
        if (!voice)
            return;
        this.noteOffPCMPercussion(voice.descriptorId, voice.note, currentTime);
        activeVoices[channel] = undefined;
    }
    stopAllPCMVoices(currentTime) {
        this.stopYM2612DACVoice(currentTime);
        this.stopYM2612DirectDACVoice(currentTime);
        for (let instance = 0; instance < this.ym2608ADPCMActiveVoices.length; instance++) {
            this.stopYM2608ADPCMBVoice(instance, currentTime);
        }
        for (let channel = 0; channel < this.segaPCMActiveVoices.length; channel++) {
            this.stopPCMVoice(this.segaPCMActiveVoices, channel, currentTime);
        }
        for (let channel = 0; channel < this.c140ActiveVoices.length; channel++) {
            this.stopPCMVoice(this.c140ActiveVoices, channel, currentTime);
        }
        for (const stream of this.streams.values())
            this.stopStreamVoice(stream, currentTime, true);
        // Secondary chip scalars are swapped out of the primary fields above. Descriptor-owned
        // PCM notes remain globally visible, so close every remaining one at EOF as well.
        for (const [descriptorId, note] of [...this.activePCMNotes]) {
            this.noteOffPCMPercussion(descriptorId, note, currentTime);
        }
    }
    /** DAC stream 0x90–0x95 を処理し、MSM6258は編集用GMトリガーとして残す。 */
    handleStreamCommand(cmd, currentTime) {
        const streamId = cmd.streamId;
        if (streamId === undefined)
            return;
        if (cmd.type === 'stream_stop' && streamId === 0xFF) {
            for (const stream of this.streams.values())
                this.stopStreamVoice(stream, currentTime);
            return;
        }
        const stream = this.streams.get(streamId) ?? {
            chipType: 0, bankId: 0, frequency: 0, stepSize: 1, stepBase: 0, dataPosition: 0,
        };
        if (cmd.type === 'stream_setup') {
            stream.chipType = cmd.data ?? 0;
            stream.targetChip = cmd.targetChip;
            stream.targetInstance = cmd.targetInstance ?? 0;
            stream.targetPort = cmd.port;
            stream.targetRegister = cmd.register;
        }
        else if (cmd.type === 'stream_data') {
            stream.bankId = cmd.bankId ?? 0;
            stream.stepSize = Math.max(1, cmd.stepSize ?? 1);
            stream.stepBase = cmd.stepBase ?? 0;
        }
        else if (cmd.type === 'stream_frequency') {
            stream.frequency = cmd.frequency ?? 0;
        }
        else if (cmd.type === 'stream_stop') {
            this.stopStreamVoice(stream, currentTime);
        }
        else if (cmd.type === 'stream_start' || cmd.type === 'stream_start_fast') {
            this.stopStreamVoice(stream, currentTime);
            // 0x17 is OKIM6258 in the VGM stream device enum. Other streams remain
            // diagnostics-only instead of pretending a timbre classification.
            if ((stream.chipType & 0x7F) === 0x17) {
                const range = this.resolveStreamRange(stream, cmd);
                if (!range || (range.commandCount === 0 && range.durationSamples === undefined)) {
                    this.streams.set(streamId, stream);
                    return;
                }
                const identity = this.streamIdentity(stream, range);
                const key = `msm6258_sample_${identity}`;
                const note = this.pcmNoteForSample(key);
                const commandSize = this.streamCommandSize(stream);
                const dataLengthBytes = range.commandCount > 0
                    ? range.commandCount * commandSize * Math.max(1, stream.stepSize)
                    : undefined;
                const dataBlock = this.pcmDataBlockForRange(stream.bankId, stream.targetInstance ?? 0, range.start, dataLengthBytes);
                const descriptorId = this.noteOnPCMPercussion(key, note, 80, currentTime, range.isLoop, dataBlock, range.isLoop ? undefined : range.durationSamples);
                stream.voice = { descriptorId, note };
                if (!range.isLoop && range.durationSamples !== undefined) {
                    // Do not emit the Note Off yet.  A later $94 or a restart can occur before
                    // the natural duration and must replace this deadline rather than leave an
                    // irreversible, out-of-order MIDI event at the old future tick.
                    stream.scheduledEndSamples = currentTime + range.durationSamples;
                }
            }
        }
        this.streams.set(streamId, stream);
    }
    /** 開始済みDAC streamのGM編集トリガーを停止する。 */
    stopStreamVoice(stream, currentTime, isFinalizing = false) {
        if (stream.voice) {
            const scheduled = stream.scheduledEndSamples;
            const closeTime = isFinalizing && scheduled !== undefined ? scheduled : Math.min(currentTime, scheduled ?? currentTime);
            this.noteOffPCMPercussion(stream.voice.descriptorId, stream.voice.note, closeTime);
        }
        stream.voice = undefined;
        stream.scheduledEndSamples = undefined;
    }
    /** 0x91で選択したbank内の連結offsetとblock番号を求める。 */
    resolveStreamBankOffset(bankId, blockId, instance) {
        const blocks = (this.vgmData.dataBlocks ?? []).filter(block => block.type === bankId && (block.instance ?? 0) === instance);
        const block = blocks.find(candidate => candidate.blockId === blockId);
        if (!block)
            return undefined;
        const start = blocks.filter(candidate => candidate.blockId < blockId)
            .reduce((total, candidate) => total + candidate.size, 0);
        return { start, length: block.size };
    }
    /** data bank内の連結offsetを、sidecar用のblock/offset情報へ変換する。 */
    pcmDataBlockForRange(bankType, bankInstance, bankOffset, lengthBytes) {
        if (bankOffset < 0)
            return undefined;
        const blocks = (this.vgmData.dataBlocks ?? [])
            .filter(block => block.type === bankType && (block.instance ?? 0) === bankInstance)
            .sort((left, right) => left.blockId - right.blockId);
        let offset = 0;
        for (const block of blocks) {
            if (bankOffset < offset + block.size) {
                return {
                    bankType,
                    bankInstance,
                    blockId: block.blockId,
                    bankOffset,
                    blockOffset: bankOffset - offset,
                    ...(lengthBytes === undefined ? {} : { lengthBytes }),
                };
            }
            offset += block.size;
        }
        return undefined;
    }
    /** ROM data blockの実データ範囲から、物理サンプルアドレスをsidecar情報へ解決する。 */
    pcmROMDataBlockForAddress(bankType, bankInstance, romAddress, lengthBytes) {
        if (romAddress < 0)
            return undefined;
        const blocks = (this.vgmData.dataBlocks ?? [])
            .filter(block => block.type === bankType && (block.instance ?? 0) === bankInstance)
            .sort((left, right) => left.blockId - right.blockId);
        for (const block of blocks) {
            // VGM ROM blocks begin with the full ROM size and the block's load address.
            if (block.payload.length < 8)
                continue;
            const romSizeBytes = block.payload.readUInt32LE(0);
            const romStartAddress = block.payload.readUInt32LE(4);
            const romDataLengthBytes = block.payload.length - 8;
            if (romAddress < romStartAddress || romAddress >= romStartAddress + romDataLengthBytes)
                continue;
            return {
                bankType,
                bankInstance,
                blockId: block.blockId,
                bankOffset: romAddress,
                blockOffset: romAddress - romStartAddress,
                ...(lengthBytes === undefined ? {} : { lengthBytes }),
                romSizeBytes,
                romStartAddress,
                romDataLengthBytes,
            };
        }
        return undefined;
    }
    /** bankの連結sizeを返し、0x93「終端まで」のcommand数計算に使用する。 */
    streamBankSize(bankId, instance) {
        return (this.vgmData.dataBlocks ?? [])
            .filter(block => block.type === bankId && (block.instance ?? 0) === instance)
            .reduce((total, block) => total + block.size, 0);
    }
    /** setup先のVGM command/data幅から、stream一回のwriteに必要なbyte数を得る。 */
    streamCommandSize(stream) {
        // MSM6258 is written by VGM $B7 as register+data (two command-data bytes).
        // Keep the port/register check explicit because real stream setups identify $B7
        // there; the chip fallback covers logs that encode only the stream device type.
        if (stream.targetPort === 0xB7 || stream.targetRegister === 0xB7)
            return 2;
        if (stream.targetChip === 'MSM6258' || (stream.chipType & 0x7F) === 0x17)
            return 2;
        if (stream.targetPort === 0xB2 || stream.targetRegister === 0xB2)
            return 2;
        return 1;
    }
    /** 0x93/0x95のlength modeをcommand数と絶対sample durationへ正規化する。 */
    resolveStreamRange(stream, cmd) {
        const commandSize = this.streamCommandSize(stream);
        const stride = commandSize * Math.max(1, stream.stepSize);
        const isFast = cmd.type === 'stream_start_fast';
        const mode = cmd.lengthMode ?? ((cmd.data ?? 0) & 0x0F);
        const flags = cmd.data ?? 0;
        const isLoop = isFast ? (flags & 0x01) !== 0 : (flags & 0x80) !== 0;
        const isReverse = (flags & 0x10) !== 0;
        let start = 0;
        let rawStart = 0;
        let length = cmd.length ?? 0;
        let blockId;
        let commandCount = 0;
        let durationSamples;
        if (isFast) {
            blockId = cmd.blockId ?? cmd.address ?? 0;
            const block = this.resolveStreamBankOffset(stream.bankId, blockId, stream.targetInstance ?? 0);
            if (!block)
                return undefined;
            rawStart = block.start;
            start = rawStart + stream.stepBase * commandSize;
            length = block.length;
            commandCount = Math.floor(length / stride);
        }
        else {
            const address = cmd.address ?? 0;
            rawStart = address === 0xFFFFFFFF ? stream.dataPosition : address;
            start = rawStart + stream.stepBase * commandSize;
            // DCTRL_LMODE_IGNORE (0) updates the data position but keeps the stream's
            // already-resolved command count.  Raw bytes is the distinct VGM value 0x0F.
            if (mode === 0) {
                commandCount = stream.resolvedCommandCount ?? 0;
                length = stream.resolvedLength ?? 0;
                durationSamples = stream.resolvedDurationSamples;
            }
            if (mode === 1)
                commandCount = length;
            else if (mode === 2)
                durationSamples = Math.round((length * this.sampleRate) / 1000);
            else if (mode === 3)
                commandCount = Math.floor(Math.max(0, this.streamBankSize(stream.bankId, stream.targetInstance ?? 0) - rawStart) / stride);
            else if (mode === 0x0F)
                commandCount = Math.floor(length / stride);
            else if (mode !== 0)
                return undefined;
        }
        if (durationSamples === undefined && stream.frequency > 0) {
            durationSamples = Math.round((commandCount * this.sampleRate) / stream.frequency);
        }
        if (durationSamples === undefined && mode === 2)
            durationSamples = Math.round((length * this.sampleRate) / 1000);
        stream.dataPosition = rawStart + commandCount * stride;
        stream.resolvedCommandCount = commandCount;
        stream.resolvedLength = length;
        stream.resolvedDurationSamples = durationSamples;
        return { start, length, commandCount, durationSamples, blockId, isLoop, isReverse };
    }
    /** bank/block/start/length/step/flagを含む安定したMSM6258編集トリガーidentityを作る。 */
    streamIdentity(stream, range) {
        const block = range.blockId === undefined ? 'range' : range.blockId.toString(16);
        return `bank${stream.bankId.toString(16)}_block${block}_start${range.start.toString(16)}_length${range.length.toString(16)}_step${stream.stepSize}_${range.isReverse ? 'reverse' : 'forward'}`;
    }
    syncHuC6280ToneState(key, channel, currentTime, activeNotes) {
        const state = this.channels.get(key);
        const shouldSound = state.isEnabled && !state.isDDA && !state.isNoise && state.volume > 0;
        if (shouldSound && !state.active) {
            state.active = true;
            this.noteOn(key, channel, currentTime, activeNotes);
        }
        else if (!shouldSound && state.active) {
            state.active = false;
            this.noteOff(key, channel, currentTime, activeNotes);
        }
    }
    syncHuC6280NoiseState(key, channel, currentTime, activeNotes) {
        const state = this.channels.get(key);
        if (this.options.suppressHardwareNoise)
            return;
        const instance = parseInt(key.split('_')[1]);
        const noiseKey = `huc6280_${instance}_noise_${channel}`;
        const shouldSound = state.isEnabled && !state.isDDA && state.isNoise && state.volume > 0;
        if (shouldSound && !state.isNoiseActive) {
            state.isNoiseActive = true;
            this.noteOnHuC6280Noise(noiseKey, state, currentTime, activeNotes);
        }
        else if (!shouldSound && state.isNoiseActive) {
            state.isNoiseActive = false;
            this.noteOff(noiseKey, channel, currentTime, activeNotes);
        }
    }
    updateHuC6280NoiseEnvelope(key, channel, oldVolume, currentTime, activeNotes) {
        const state = this.channels.get(key);
        if (state.volume === oldVolume)
            return;
        if (this.options.suppressHardwareNoise)
            return;
        const instance = parseInt(key.split('_')[1]);
        const noiseKey = `huc6280_${instance}_noise_${channel}`;
        const volumeRise = state.volume - oldVolume;
        if (volumeRise >= HUC6280_NOISE_RETRIGGER_MIN_VOLUME_RISE) {
            this.noteOff(noiseKey, channel, currentTime, activeNotes);
            this.noteOnHuC6280Noise(noiseKey, state, currentTime, activeNotes);
        }
        else {
            this.addHuC6280Expression(noiseKey, state.volume, currentTime);
        }
    }
    noteOnHuC6280Noise(key, state, currentTime, activeNotes) {
        const velocity = Math.max(1, Math.round((state.volume / 31) * 100));
        this.noteOnPercussion(key, velocity, currentTime, activeNotes, this.huc6280NoiseNoteForPeriod(state.noisePeriod ?? 0));
    }
    // Confirmed against MAME's c6280.cpp: step = (value & 0x1F) ^ 0x1F, noise_counter =
    // step << 6 — a larger raw register value produces a smaller step/counter, so the LFSR
    // updates more often and the noise pitch is HIGHER. (Opposite direction from YM2151's
    // NFRQ below.)
    huc6280NoiseNoteForPeriod(rawValue) {
        const normalizedRate = (rawValue & 0x1F) / 31;
        return noiseDrumNote(normalizedRate, false);
    }
    addHuC6280Expression(key, volume, currentTime) {
        this.addExpression(key, Math.round((volume / 31) * 127), currentTime);
    }
    // Looks ahead through at most one 50Hz frame for the other half of a split frequency
    // update. Some HuC6280 drivers intentionally distribute the two bytes across frames.
    isHuC6280MultiByteFreqUpdate(cmdIndex, otherReg, instance) {
        let skippedSamples = 0;
        for (let k = cmdIndex + 1; k < this.vgmData.commands.length; k++) {
            const next = this.vgmData.commands[k];
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
    isOPNMultiByteFreqUpdate(cmdIndex, chip, port, otherReg, instance = 0) {
        let skippedSamples = 0;
        for (let index = cmdIndex + 1; index < this.vgmData.commands.length; index++) {
            const next = this.vgmData.commands[index];
            if (next.type === 'wait' || next.type === 'pcm_write') {
                skippedSamples += next.samples ?? 0;
                if (skippedSamples > 16)
                    return false;
                continue;
            }
            // A dual-chip log can interleave primary and secondary writes at the same sample.
            // They do not alter this instance's register latch, so keep looking for the paired
            // byte instead of combining it with an opposite-instance write or committing a
            // stale half-frequency.
            if (next.type === 'chip_write'
                && next.chip === chip
                && (next.instance ?? 0) !== instance)
                continue;
            return next.type === 'chip_write'
                && next.chip === chip
                && (next.instance ?? 0) === instance
                && (next.port ?? 0) === port
                && next.register === otherReg;
        }
        return false;
    }
    // --- Common Note Helpers ---
    noteOnPCMPercussion(key, pitch, velocity, currentTime, isLoop = false, dataBlock, durationSamples, playbackRange) {
        const descriptor = this.resolveDescriptor(key);
        const trackState = this.getTrack(descriptor.id);
        trackState.pcmEvents ?? (trackState.pcmEvents = []);
        trackState.pcmDataBlock ?? (trackState.pcmDataBlock = dataBlock);
        trackState.pcmEvents.push({
            type: 'start',
            sampleTime: currentTime,
            ...(isLoop ? { isLoop: true } : {}),
            ...(playbackRange === undefined ? {} : { endAddressExclusive: playbackRange.endAddressExclusive }),
            ...(playbackRange?.loopAddress === undefined ? {} : { loopAddress: playbackRange.loopAddress }),
            ...(isLoop || durationSamples === undefined ? {} : { durationSamples }),
            ...(dataBlock?.lengthBytes === undefined ? {} : { dataLengthBytes: dataBlock.lengthBytes }),
        });
        const currentTick = this.samplesToTicks(currentTime, this.options.tempo);
        const gap = Math.max(0, currentTick - trackState.cursor);
        trackState.track.addEvent(new midi_writer_js_1.default.NoteOnEvent({
            pitch,
            velocity: Math.max(1, Math.min(100, velocity)),
            channel: descriptor.midiChannel,
            wait: `T${gap}`,
        }));
        trackState.cursor = currentTick;
        this.generatedNoteCount += 1;
        this.registerDescriptorStart(descriptor, currentTime);
        this.activePCMNotes.set(descriptor.id, pitch);
        return descriptor.id;
    }
    noteOffPCMPercussion(key, pitch, currentTime) {
        const descriptor = this.resolveDescriptor(key);
        const trackState = this.getTrack(descriptor.id);
        trackState.pcmEvents ?? (trackState.pcmEvents = []);
        trackState.pcmEvents.push({ type: 'stop', sampleTime: currentTime });
        const currentTick = this.samplesToTicks(currentTime, this.options.tempo);
        const gap = Math.max(0, currentTick - trackState.cursor);
        trackState.track.addEvent(new midi_writer_js_1.default.NoteOffEvent({
            pitch,
            velocity: 64,
            channel: descriptor.midiChannel,
            duration: `T${gap}`,
        }));
        trackState.cursor = currentTick;
        this.registerDescriptorStop(descriptor.id);
        this.activePCMNotes.delete(descriptor.id);
    }
    noteOnPercussion(key, velocity, currentTime, activeNotes, pitch = GM_CLOSED_HI_HAT_NOTE) {
        const descriptor = this.resolveDescriptor(key);
        activeNotes.set(descriptor.id, {
            note: pitch,
            startTime: currentTime,
            startVolume: velocity,
        });
        const trackState = this.getTrack(descriptor.id);
        const currentTick = this.samplesToTicks(currentTime, this.options.tempo);
        const gap = Math.max(0, currentTick - trackState.cursor);
        trackState.track.addEvent(new midi_writer_js_1.default.NoteOnEvent({
            pitch,
            velocity: Math.max(1, Math.min(100, velocity)),
            channel: descriptor.midiChannel,
            wait: `T${gap}`,
        }));
        trackState.cursor = currentTick;
        this.generatedNoteCount += 1;
        this.registerDescriptorStart(descriptor, currentTime);
    }
    pcmNoteForSample(sampleKey) {
        const existingNote = this.pcmSampleNotes.get(sampleKey);
        if (existingNote !== undefined)
            return existingNote;
        const noteCount = GM_PCM_PERCUSSION_LAST_NOTE - GM_PCM_PERCUSSION_FIRST_NOTE + 1;
        const note = GM_PCM_PERCUSSION_FIRST_NOTE + (this.pcmSampleNotes.size % noteCount);
        this.pcmSampleNotes.set(sampleKey, note);
        return note;
    }
    /** 同じMIDI channelで異なるdescriptorが同時発音した場合だけ警告を記録する。 */
    registerDescriptorStart(descriptor, currentTime) {
        for (const [activeId, active] of this.activeMidiDescriptors) {
            if (activeId === descriptor.id || active.midiChannel !== descriptor.midiChannel)
                continue;
            const warning = `MIDI channel ${descriptor.midiChannel} overlap: ${activeId} and ${descriptor.id}`;
            if (!this.warnings.includes(warning))
                this.warnings.push(warning);
        }
        this.activeMidiDescriptors.set(descriptor.id, { midiChannel: descriptor.midiChannel, startTime: currentTime });
    }
    /** descriptor単位で終了し、同一source keyの別instanceを消さない。 */
    registerDescriptorStop(descriptorId) {
        this.activeMidiDescriptors.delete(descriptorId);
    }
    addExpression(key, expression, currentTime) {
        const descriptor = this.resolveDescriptor(key);
        const trackState = this.getTrack(descriptor.id);
        const currentTick = this.samplesToTicks(currentTime, this.options.tempo);
        const gap = Math.max(0, currentTick - trackState.cursor);
        const clampedExpression = Math.max(0, Math.min(127, expression));
        trackState.track.addEvent(new midi_writer_js_1.default.ControllerChangeEvent({
            controllerNumber: 11,
            controllerValue: clampedExpression,
            channel: descriptor.midiChannel,
            delta: gap,
        }));
        trackState.cursor = currentTick;
        trackState.expression = clampedExpression;
    }
    // SegaPCM/C140 sample tracks all share GM percussion channel 10, so CC10 (Pan) sent on
    // one track's own MidiTrack object still affects every other sample track on that
    // channel. A per-track "did I already send this pan" cache would therefore be wrong: if
    // voice A pans left, voice B pans right, and A retriggers, a per-track cache would see
    // "A's pan is unchanged" and skip resending — leaving channel 10 pointed right while A
    // is actually sounding on the left. Caching one shared value for the whole channel and
    // resending right before every Note On (regardless of which track sends it) avoids that.
    // The one remaining limitation is inherent to sharing a channel: simultaneously
    // sounding PCM voices on different pans still cannot be panned independently.
    addPCMPan(key, pan, currentTime) {
        const clampedPan = Math.max(0, Math.min(127, pan));
        if (this.pcmChannel10Pan === clampedPan)
            return;
        this.pcmChannel10Pan = clampedPan;
        const descriptor = this.resolveDescriptor(key);
        const trackState = this.getTrack(descriptor.id);
        const currentTick = this.samplesToTicks(currentTime, this.options.tempo);
        const gap = Math.max(0, currentTick - trackState.cursor);
        trackState.track.addEvent(new midi_writer_js_1.default.ControllerChangeEvent({
            controllerNumber: 10,
            controllerValue: clampedPan,
            channel: descriptor.midiChannel,
            delta: gap,
        }));
        trackState.cursor = currentTick;
    }
    /** 左のみ/両方/右のみを CC10 の 0/64/127 に正規化して送る。 */
    addPan(key, hasLeft, hasRight, currentTime) {
        const pan = hasLeft && hasRight ? 64 : hasLeft ? 0 : hasRight ? 127 : 64;
        const state = this.channels.get(key);
        if (state?.pan === pan)
            return;
        if (state)
            state.pan = pan;
        const descriptor = this.resolveDescriptor(key);
        const trackState = this.getTrack(descriptor.id);
        const currentTick = this.samplesToTicks(currentTime, this.options.tempo);
        const gap = Math.max(0, currentTick - trackState.cursor);
        trackState.track.addEvent(new midi_writer_js_1.default.ControllerChangeEvent({ controllerNumber: 10, controllerValue: pan, channel: descriptor.midiChannel, delta: gap }));
        trackState.cursor = currentTick;
    }
    getNoteFrequency(key, state) {
        if (key.startsWith('psg_')) {
            return this.psgRegisterToFrequency(state.frequency, this.vgmData.header.sn76489Clock, this.vgmData.header.sn76489Flags);
        }
        else if (key.startsWith('ym2612_')) {
            const baseFrequency = this.ym2612FrequencyToHz(state.frequency, state.block || 0, this.vgmData.header.ym2612Clock);
            const pitchScale = state.active
                ? (state.opnActivePitchScale ?? 1)
                : this.opnPitchScale(state);
            return baseFrequency * pitchScale;
        }
        else if (key.startsWith('ym2203_')) {
            const [, instanceText, section] = key.split('_');
            const instance = parseInt(instanceText);
            const prescaler = this.ym2203Prescalers[instance];
            if (section === 'fm' || section === 'ch3sp') {
                const baseFrequency = this.ym2203FrequencyToHz(state.frequency, state.block ?? 0, this.vgmData.header.ym2203Clock, prescaler);
                const pitchScale = state.active
                    ? (state.opnActivePitchScale ?? 1)
                    : this.opnPitchScale(state);
                return baseFrequency * pitchScale;
            }
            return this.ym2203SSGRegisterToFrequency(state.frequency, this.vgmData.header.ym2203Clock, prescaler, this.vgmData.header.ym2203AyFlags);
        }
        else if (key.startsWith('ym2608_')) {
            const [, instanceText, section] = key.split('_');
            const instance = parseInt(instanceText);
            const prescaler = this.ym2608Prescalers[instance];
            if (section === 'fm' || section === 'ch3sp') {
                const baseFrequency = this.ym2203FrequencyToHz(state.frequency, state.block ?? 0, this.vgmData.header.ym2608Clock, prescaler);
                const pitchScale = state.active
                    ? (state.opnActivePitchScale ?? 1)
                    : this.opnPitchScale(state);
                return baseFrequency * pitchScale;
            }
            return this.ym2203SSGRegisterToFrequency(state.frequency, this.vgmData.header.ym2608Clock, prescaler, this.vgmData.header.ym2608AyFlags);
        }
        else if (this.isOPLFMKey(key)) {
            const chip = key.split('_')[0].toUpperCase();
            const clockRate = chip === 'YM3812'
                ? this.vgmData.header.ym3812Clock
                : chip === 'YM3526'
                    ? this.vgmData.header.ym3526Clock
                    : this.vgmData.header.y8950Clock;
            const baseFrequency = this.oplFrequencyToHz(state.frequency, state.block ?? 0, clockRate);
            const pitchScale = state.active
                ? (state.opnActivePitchScale ?? 1)
                : this.oplPitchScale(state);
            return baseFrequency * pitchScale;
        }
        else if (key.startsWith('ym2151_')) {
            return this.ym2151KeyToFrequency(state.keyCode || 0, state.keyFraction || 0);
        }
        else if (key.startsWith('ay8910_')) {
            return this.ay8910RegisterToFrequency(state.frequency, this.vgmData.header.ay8910Clock, this.vgmData.header.ay8910Flags);
        }
        else if (key.startsWith('huc6280_')) {
            return this.huc6280RegisterToFrequency(state.frequency, this.vgmData.header.huc6280Clock);
        }
        else if (key.startsWith('ym2413_')) {
            const rawFrequency = this.ym2413RegisterToFrequency(state.frequency, state.block ?? 0, this.vgmData.header.ym2413Clock);
            return rawFrequency * (state.active ? (state.opnActivePitchScale ?? 1) : this.ym2413PitchScale(state));
        }
        else if (key === 'gbdmg_2') {
            return this.gbDmgWaveFrequencyToHz(state.frequency, this.vgmData.header.gbDmgClock);
        }
        else if (GBDMG_SQUARE_KEYS.includes(key)) {
            return this.gbDmgSquareFrequencyToHz(state.frequency, this.vgmData.header.gbDmgClock);
        }
        return 0;
    }
    ym2151KeyToFrequency(keyCode, keyFraction) {
        // YM2151 NOTE codes contain gaps. Both values on either side of a gap map
        // to the same chromatic note, matching the chip's own phase-generator logic.
        const semitoneByCode = [1, 2, 3, 3, 4, 5, 6, 6, 7, 8, 9, 9, 10, 11, 12, 12];
        const octave = (keyCode >> 4) & 0x07;
        const semitone = semitoneByCode[keyCode & 0x0F];
        const clockRate = this.vgmData.header.ym2151Clock & 0x3FFFFFFF;
        const clockShift = clockRate > 0 ? 12 * Math.log2(clockRate / 3579545) : 0;
        const exactMidiNote = ((octave + 1) * 12) + semitone + (keyFraction / 64) + clockShift;
        return 440 * Math.pow(2, (exactMidiNote - 69) / 12);
    }
    noteOn(key, midiChannelOffset, currentTime, activeNotes) {
        const descriptor = this.resolveDescriptor(key);
        key = descriptor.sourceKey;
        const state = this.channels.get(key);
        const freq = this.getNoteFrequency(key, state);
        const midiNote = this.frequencyToMidiNote(freq);
        if (midiNote > 0 && midiNote < 128) {
            state.midiNote = midiNote;
            state.baseMidiNote = midiNote; // Capture base note
            activeNotes.set(descriptor.id, { note: midiNote, startTime: currentTime, startVolume: state.volume });
            const trackState = this.getTrack(descriptor.id);
            const currentTick = this.samplesToTicks(currentTime, this.options.tempo);
            const gap = Math.max(0, currentTick - trackState.cursor);
            // Simple velocity mapping
            let velocity = 80;
            if (key.startsWith('psg_')) {
                velocity = Math.max(20, Math.min(127, 100 - (state.volume * 6)));
            }
            else if (key.startsWith('ym2612_')
                || ((key.startsWith('ym2203_') || key.startsWith('ym2608_'))
                    && (key.includes('_fm_') || key.includes('_ch3sp_')))) {
                // Derived from the channel's audible carrier operator(s) Total Level at key-on
                // (opnCarrierVelocity(), latched alongside opnActivePitchScale). Falls back to a
                // neutral 80 when no carrier was reachable for the active algorithm/key-on mask.
                velocity = state.opnActiveVelocity ?? 80;
            }
            else if (key.startsWith('ym2151_')) {
                velocity = state.opnActiveVelocity ?? 80;
            }
            else if (this.isOPLFMKey(key)) {
                velocity = state.opnActiveVelocity ?? 80;
            }
            else if (key.startsWith('huc6280_')) {
                // midi-writer-js expects velocity as a percentage (1-100).
                velocity = Math.max(1, Math.round((state.volume / 31) * 100));
            }
            else if (key.startsWith('ym2413_')) {
                // Latched from the channel's 4-bit volume register at key-on by
                // handleYM2413KeyAndFrequencyWrite() via ym2413Velocity().
                velocity = state.opnActiveVelocity ?? 80;
            }
            else if (key.startsWith('gbdmg_')) {
                // Latched from the channel's envelope initial-volume (or, for the wave channel,
                // its 2-bit output-level code) at trigger time by handleGBDMGTriggerWrite().
                velocity = state.opnActiveVelocity ?? 80;
            }
            else {
                velocity = Math.max(20, Math.min(127, 40 + (state.volume * 5)));
            }
            // Assign unique MIDI channel based on chip/channel
            const midiCh = descriptor.midiChannel;
            // Tune the rounded MIDI note back to the source chip's exact frequency. This
            // avoids retaining as much as ±50 cents of onset quantization error.
            // Unlike NoteOnEvent/NoteOffEvent/ControllerChangeEvent (which take a 1-based
            // channel and subtract 1 internally), midi-writer-js's PitchBendEvent ORs the
            // raw `channel` field into the status byte with no such conversion. Passing our
            // 1-based midiCh straight through is off by one for every chip, and for
            // midiCh === 16 (HuC6280's highest channel) it overflows into the status byte's
            // event-type nibble, producing 0xE0 | 16 === 0xF0 (a SysEx-start byte) instead
            // of a Pitch Bend byte — corrupting the rest of the track for any MIDI reader
            // that doesn't happen to resync (GarageBand does not).
            const exactMidiNote = this.frequencyToExactMidi(freq);
            const semitoneOffset = exactMidiNote - midiNote;
            const bendRange = this.pitchBendRangeForKey(key);
            const bend = Math.max(-1, Math.min(1, semitoneOffset / bendRange));
            let eventGap = gap;
            // CC11 is persistent channel state. Reset it at every Note On so the previous
            // note's FM TL envelope does not attenuate the new TL-derived velocity a second time.
            if (trackState.expression !== 127) {
                trackState.track.addEvent(new midi_writer_js_1.default.ControllerChangeEvent({
                    controllerNumber: 11,
                    controllerValue: 127,
                    channel: midiCh,
                    delta: eventGap,
                }));
                trackState.expression = 127;
                eventGap = 0;
            }
            trackState.track.addEvent(new midi_writer_js_1.default.PitchBendEvent({
                bend,
                channel: midiCh - 1,
                delta: eventGap
            }));
            // Note On immediately follows (delta 0 since gap used by PitchBend)
            trackState.track.addEvent(new midi_writer_js_1.default.NoteOnEvent({
                pitch: midiNote,
                velocity: velocity,
                channel: midiCh,
                wait: `T0`
            }));
            this.generatedNoteCount += 1;
            this.registerDescriptorStart(descriptor, currentTime);
            // Advance cursor
            trackState.cursor = currentTick;
        }
    }
    noteOff(key, midiChannelOffset, currentTime, activeNotes) {
        const descriptor = this.resolveDescriptor(key);
        if (activeNotes.has(descriptor.id)) {
            const noteInfo = activeNotes.get(descriptor.id);
            // We don't need duration from start time anymore, just delta from last event (cursor)
            const trackState = this.getTrack(descriptor.id);
            const currentTick = this.samplesToTicks(currentTime, this.options.tempo);
            const gap = Math.max(0, currentTick - trackState.cursor);
            const midiCh = descriptor.midiChannel;
            trackState.track.addEvent(new midi_writer_js_1.default.NoteOffEvent({
                pitch: noteInfo.note,
                velocity: 64,
                channel: midiCh,
                duration: `T${gap}` // 'duration' is the wait/delta for NoteOffEvent
            }));
            trackState.cursor = currentTick;
            activeNotes.delete(descriptor.id);
            this.registerDescriptorStop(descriptor.id);
        }
    }
    updateNotePitch(key, midiChannelOffset, currentTime, activeNotes) {
        const state = this.channels.get(key);
        const freq = this.getNoteFrequency(key, state);
        const newExactNote = this.frequencyToExactMidi(freq);
        if (activeNotes.has(key)) {
            const diff = newExactNote - state.baseMidiNote;
            // Dynamic Threshold Logic:
            // Bass (psg_2) uses the full standard ±2-semitone MIDI bend range to allow
            // "decayed sustain" pitch slides without clipping the bend value.
            // Melody channels need a tight threshold (e.g. 0.8) so that actual notes (semitones) 
            // are retriggered as new notes, not bent.
            const isContinuousPSG = key.startsWith('psg_') || key.startsWith('ay8910_')
                || key.startsWith('huc6280_') || key.startsWith('gbdmg_') || key.includes('_ssg_');
            const threshold = isContinuousPSG ? CHIP_PITCH_BEND_RANGE : (key === 'psg_2' ? 2 : 0.8);
            if (Math.abs(diff) <= threshold) {
                this.addPitchBend(key, diff, this.pitchBendRangeForKey(key), currentTime);
            }
            else {
                // Large pitch change -> Retrigger
                this.noteOff(key, midiChannelOffset, currentTime, activeNotes);
                this.noteOn(key, midiChannelOffset, currentTime, activeNotes);
            }
        }
        else {
            // If state.active is true, we should try to start it.
            if (state.active) {
                this.noteOn(key, midiChannelOffset, currentTime, activeNotes);
            }
        }
    }
    addPitchBend(key, semitoneOffset, semitoneRange, currentTime) {
        const descriptor = this.resolveDescriptor(key);
        const trackState = this.getTrack(descriptor.id);
        const currentTick = this.samplesToTicks(currentTime, this.options.tempo);
        const gap = Math.max(0, currentTick - trackState.cursor);
        const midiChannel = descriptor.midiChannel;
        const bend = Math.max(-1, Math.min(1, semitoneOffset / semitoneRange));
        // PitchBendEvent is the one midi-writer-js channel event that expects 0-based input.
        trackState.track.addEvent(new midi_writer_js_1.default.PitchBendEvent({
            bend,
            channel: midiChannel - 1,
            delta: gap,
        }));
        trackState.cursor = currentTick;
    }
    /** MIDIトラック記述子をlibvgmのdevice/channel mute選択へ変換する。 */
    libvgmTargetForDescriptor(descriptor) {
        const { chip, instance, section, channel, sourceKey } = descriptor;
        let deviceType;
        let mainChannel;
        let linkedChannel;
        let mainMask;
        let isSuggested = false;
        if (chip === 'SN76489') {
            deviceType = 0x00;
            mainChannel = channel;
            isSuggested = section === 'noise';
        }
        else if (chip === 'YM2413') {
            deviceType = 0x01;
            mainChannel = section === 'rhythm' ? 9 + channel : channel;
            isSuggested = section === 'rhythm';
        }
        else if (chip === 'YM2612') {
            deviceType = 0x02;
            if (section === 'pcm') {
                mainChannel = 6;
                isSuggested = true;
            }
            else if (!sourceKey.includes('_ch3sp_') && !sourceKey.includes('_ch3perc_'))
                mainChannel = channel;
        }
        else if (chip === 'YM2151') {
            deviceType = 0x03;
            mainChannel = channel;
        }
        else if (chip === 'SegaPCM') {
            deviceType = 0x04;
            mainMask = 0xFFFF;
            isSuggested = true;
        }
        else if (chip === 'YM2203') {
            deviceType = 0x06;
            if (section === 'fm')
                mainChannel = channel;
            else if (section === 'ssg' || section === 'noise')
                linkedChannel = channel;
        }
        else if (chip === 'YM2608') {
            deviceType = 0x07;
            if (section === 'fm')
                mainChannel = channel;
            else if (section === 'ssg' || section === 'noise')
                linkedChannel = channel;
            else if (section === 'rhythm') {
                mainChannel = 6 + channel;
                isSuggested = true;
            }
            else if (section === 'pcm') {
                mainChannel = 12;
                isSuggested = true;
            }
        }
        else if (['YM3812', 'YM3526', 'Y8950'].includes(chip)) {
            deviceType = chip === 'YM3812' ? 0x09 : chip === 'YM3526' ? 0x0A : 0x0B;
            mainChannel = section === 'rhythm' ? 9 + channel : channel;
            isSuggested = section === 'rhythm';
        }
        else if (chip === 'AY8910') {
            deviceType = 0x12;
            mainChannel = channel;
        }
        else if (chip === 'GBDMG') {
            deviceType = 0x13;
            mainChannel = section === 'noise' ? 3 : channel;
            isSuggested = section === 'noise';
        }
        else if (chip === 'MSM6258') {
            deviceType = 0x17;
            mainMask = 1;
            isSuggested = true;
        }
        else if (chip === 'HuC6280') {
            deviceType = 0x1B;
            mainChannel = channel;
        }
        else if (chip === 'C140') {
            deviceType = 0x1C;
            mainMask = 0xFFFFFF;
            isSuggested = true;
        }
        if (deviceType === undefined)
            return undefined;
        const resolvedMainMask = mainMask ?? (mainChannel === undefined ? 0 : (1 << mainChannel) >>> 0);
        const linkedMask = linkedChannel === undefined ? 0 : (1 << linkedChannel) >>> 0;
        if (resolvedMainMask === 0 && linkedMask === 0)
            return undefined;
        const groupId = `${deviceType}:${instance}:${resolvedMainMask}:${linkedMask}`;
        return { deviceType, instance, mainMask: resolvedMainMask, linkedMask, groupId, suggestedForHardwareMix: isSuggested };
    }
    /** MIDIファイルを書き出し、音符が生成されなかった場合は空ファイルを作らず失敗させる。 */
    exportToFile(outputPath) {
        const tracks = this.convert();
        if (this.generatedNoteCount === 0) {
            throw new Error('No MIDI notes were generated. The VGM may contain only unsupported or non-tonal sound data.');
        }
        require('fs').writeFileSync(outputPath, this.buildMidiFile(tracks));
        for (const warning of this.warnings)
            console.error(`Warning: ${warning}`);
        if (this.options.splitChips)
            this.exportSplitChipFiles(outputPath);
    }
    /** 出力MIDIのトラック順とlibvgmのmute対象を結ぶJSON sidecarを書き出す。 */
    exportTrackMetadata(outputPath, totalSamples) {
        const tracks = Array.from(this.tracks.values()).map((state, trackIndex) => ({
            trackIndex,
            descriptor: state.descriptor,
            libvgm: this.libvgmTargetForDescriptor(state.descriptor),
            fm: state.fmTimbre,
            fmEvents: state.fmEvents,
            pcm: this.pcmMetadataForTrack(state),
        }));
        require('fs').writeFileSync(outputPath, JSON.stringify({
            version: 1,
            sampleRate: this.sampleRate,
            sampleCount: totalSamples,
            tracks,
        }, null, 2) + '\n');
    }
    /** MIDI writer の固定divisionを 960 PPQ へ置換する。 */
    buildMidiFile(tracks) {
        const file = Buffer.from(new midi_writer_js_1.default.Writer(tracks).buildFile());
        file.writeUInt16BE(MIDI_PPQ, 12);
        return file;
    }
    /** チップ別DAW編集用sidecarを、通常の混在出力と併せて書き出す。 */
    exportSplitChipFiles(outputPath) {
        const fs = require('fs');
        const path = require('path');
        const groups = new Map();
        for (const state of this.tracks.values()) {
            const chip = this.chipNameForDescriptor(state.descriptor);
            const tracks = groups.get(chip) ?? [];
            tracks.push(state.track);
            groups.set(chip, tracks);
        }
        const parsed = path.parse(outputPath);
        for (const [chip, tracks] of groups)
            fs.writeFileSync(path.join(parsed.dir, `${parsed.name}.${chip}.mid`), this.buildMidiFile(tracks));
    }
    /** sidecar名はsource keyではなくdescriptorのchip/instanceから生成する。 */
    chipNameForDescriptor(descriptor) {
        return `${descriptor.chip}${descriptor.instance === 0 ? '' : `-${descriptor.instance + 1}`}`;
    }
}
exports.MidiConverter = MidiConverter;
