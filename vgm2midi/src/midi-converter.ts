import MidiWriter from 'midi-writer-js';
import { VGMData, VGMCommand, ConversionOptions } from './types';
import { CLOCK_MASK } from './vgm-chip-metadata';
import {
  MIDI_PPQ,
  greatestCommonDivisor,
  frequencyToExactMidi,
  samplesToTicks,
} from './midi-math';
import {
  PCMTrackEvent,
  PCMDataBlockMetadata,
  PCMAnalysisMetadata,
  PCMTimbreMetadata,
  pcmTimbreForAnalysis,
  segaPCMAnalysisForTrack,
} from './pcm-analysis';
import {
  addPan,
  addPitchBend,
  noteOnPCMPercussion,
  noteOffPCMPercussion,
  pcmNoteForSample,
  noteOn,
  noteOff,
  getNoteFrequency,
} from './event-output';
import { handleGameGearStereo, handlePSGWrite } from './chips/sn76489';
import { handleHuC6280Write } from './chips/huc6280';
import { advanceGBDMGFrameSequencers, handleGBDMGWrite } from './chips/gbdmg';
import { handleYM2413Write } from './chips/ym2413';
import { handleOPLWrite } from './chips/opl';
import { handleSegaPCMWrite } from './chips/segapcm';
import { handleC140Write } from './chips/c140';
import { handleYM2151Write, syncYM2151ToneState, syncYM2151NoiseState } from './chips/ym2151';
import { handleAY8910Write } from './chips/ay8910';
import { handleOPNCh3SpecialKeyWrite } from './chips/opn-shared';
import { handleYM2612Write, handleYM2612DACSeek, handleYM2612DACWrite, stopYM2612DACVoice, stopYM2612DirectDACVoice } from './chips/ym2612';
import { handleYM2203Write } from './chips/ym2203';
import { handleYM2608Write, stopYM2608ADPCMBVoice } from './chips/ym2608';

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
] as const;
const GM_PERCUSSION_CHANNEL = 10;
export const YM2151_FM_PITCH_BEND_RANGE = 96;
export const YM2203_FM_PITCH_BEND_RANGE = 96;
export const YM2608_FM_PITCH_BEND_RANGE = 96;
export const OPL_FM_PITCH_BEND_RANGE = 96;
export const CHIP_PITCH_BEND_RANGE = 96;
// CSM のハードウェアkey-on/key-offは同一のTimer Aオーバーフローで発生する。
// MIDIで可聴なアタックとして扱える最小単位は1 tickなので、同じtickの複数回
// オーバーフローは1回へ集約し、出力ノートは1 tickだけ保持する。
const CSM_MIDI_PULSE_TICKS = 1;
const YM2608_RHYTHM_NAMES = [
  'Bass Drum',
  'Snare Drum',
  'Top Cymbal',
  'Hi-Hat',
  'Tom-Tom',
  'Rim Shot',
] as const;

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
// matching keyOnMask's own bit0=Op1..bit3=Op4 convention. (The offset->operator table
// itself, OPN_CH3_SPECIAL_OPERATOR_BY_OFFSET, moved to chips/opn-shared.ts alongside
// handleOPNCh3SpecialFrequencyWrite(), its only user.)

// A chip instance needs at least this many qualifying (2+ audible operator) attacks
// before its unison ratio is judged meaningful — a handful of coincidental attacks
// early in a file should not trigger a warning.
const OPN_CH3_UNISON_WARNING_MIN_ATTACKS = 8;
// Fraction of qualifying attacks that must land within the unison threshold before this
// chip instance is flagged as "likely one melodic voice in unison," not a composite
// drum patch or independently-pitched voices.
const OPN_CH3_UNISON_WARNING_RATIO = 0.7;
const OPN_CH3_PERCUSSION_NAMES = new Map<number, string>([
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
const YM2413_RHYTHM_NAMES = ['Bass Drum', 'Hi-Hat', 'Snare Drum', 'Tom-Tom', 'Top Cymbal'] as const;

export type OPLChip = 'YM3812' | 'YM3526' | 'Y8950';
export const OPL_CHIPS = ['YM3812', 'YM3526', 'Y8950'] as const;
const OPL_DISPLAY_NAMES: Readonly<Record<OPLChip, string>> = {
  YM3812: 'YM3812',
  YM3526: 'YM3526',
  Y8950: 'Y8950',
};
const OPL_RHYTHM_NAMES = ['Bass Drum', 'Hi-Hat', 'Snare Drum', 'Tom-Tom', 'Top Cymbal'] as const;
// OPLL built-in patches 1-15's carrier register ($01).  These are the second byte of each
// `default_inst` record in pinned libvgm's emu2413.c.  Patch 0 is the writable user patch
// and is read from $00-$07 below.  Keeping the source bytes public makes this hardware
// table independently verifiable instead of hiding a hand-transcribed Multiple nibble.
/** libvgm/emu2413.c由来のYM2413内蔵patch carrier register ($01) byte。 */
export const YM2413_BUILTIN_CARRIER_REGISTER_BYTES = [
  0x00, 0x61, 0x41, 0x01, 0x61, 0x21, 0x22, 0x61,
  0x21, 0x61, 0x61, 0x01, 0xC1, 0x50, 0x01, 0x41,
] as const;
/** 内蔵patch carrier registerのMultiple下位nibble（patch番号を添字にする）。 */
export const YM2413_BUILTIN_CARRIER_MULTIPLES = [
  0, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 0, 1, 1,
] as const;
const YM2413_OPERATOR_MULTIPLES = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15] as const;

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
export const GBDMG_SQUARE_KEYS = ['gbdmg_0', 'gbdmg_1'] as const;
export const GBDMG_FRAME_SAMPLES = 44100 / 512;

// noiseDrumNote()（SN76489, AY-3-8910/YM2203/YM2608 SSG, HuC6280, YM2151のハードウェア
// ノイズ共通のGMドラムノート判定）は、他のチップ非依存なMIDI数学と合わせて
// midi-math.tsへ移設した（上のimportを参照）。

interface OPNOperatorPath {
  carrier: number;
  operators: readonly number[];
}

// Logical operator order is O1, O2, O3, O4. Each entry describes the operators
// whose frequencies can reach one audible carrier for the corresponding algorithm.
export const OPN_OPERATOR_PATHS: readonly (readonly OPNOperatorPath[])[] = [
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

const OPL_OPERATOR_PATHS: readonly (readonly OPNOperatorPath[])[] = [
  [{ carrier: 1, operators: [0, 1] }],
  [{ carrier: 0, operators: [0] }, { carrier: 1, operators: [1] }],
];
const OPN_DOUBLED_MULTIPLES = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30] as const;
/** fmopl.c mul_tabの実MULTIPLEを2倍した整数表。 */
const OPL_DOUBLED_MULTIPLES = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30] as const;

export interface ChannelState {
  frequency: number; // For PSG: 10-bit; AY8910: 12-bit period; YM2612: 11-bit F-Num
  volume: number;    // Chip-specific volume
  active: boolean;
  midiNote: number;
  baseMidiNote: number; // The note we initially triggered (for pitch bend reference)
  // OPN-family FM state (YM2203/YM2612)
  block?: number;    // Octave (3 bits)
  opnAlgorithm?: number;
  opnOperatorMultipliers?: number[];
  opnOperatorMultiplierWritten?: boolean[];
  opnOperatorTotalLevels?: number[];
  opnActivePitchScale?: number;
  opnActiveVelocity?: number;
  // AY-compatible SSG/OPN partial frequency tracking
  freqLSB?: number;
  freqMSB?: number;
  hasPendingFrequencyUpdate?: boolean;
  // YM2151 pitch is expressed directly as a key code plus a 1/64-semitone fraction.
  keyCode?: number;
  keyFraction?: number;
  keyOnMask?: number;
  // Tone/noise channel-mode state
  isToneEnabled?: boolean;
  isEnvelope?: boolean;
  isEnabled?: boolean;
  isDDA?: boolean;
  isNoise?: boolean;
  isNoiseActive?: boolean;
  // Raw 5-bit noise-rate register value, used to derive a GM drum note. HuC6280's $07
  // bits0-4 and YM2151's $0F bits0-4 (NFRQ) share this field but normalize in opposite
  // directions — see huc6280NoiseNote()/ym2151NoiseNote().
  noisePeriod?: number;
  pan?: number;
  balance?: number;
  // Game Boy DMG frame-sequencer state.  The counters are clocked from the absolute VGM
  // sample timeline at 512Hz, never from MIDI tick rounding.
  gbDmgLengthCounter?: number;
  gbDmgLengthEnabled?: boolean;
  gbDmgEnvelopeVolume?: number;
  gbDmgEnvelopeTimer?: number;
  gbDmgEnvelopePeriod?: number;
  gbDmgEnvelopeIncrease?: boolean;
  gbDmgSweepShadow?: number;
  gbDmgSweepTimer?: number;
  gbDmgSweepPeriod?: number;
  gbDmgSweepShift?: number;
  gbDmgSweepNegate?: boolean;
  gbDmgSweepEnabled?: boolean;
  ym2413Instrument?: number;
  ym2413PendingKeyOn?: boolean;
  oplKeyOn?: boolean;
  oplPendingKeyOn?: boolean;
}

/** MIDI出力を一意に識別するチップ／instance／発音部の記述子。 */
export interface TrackDescriptor {
  chip: string;
  instance: number;
  section: string;
  channel: number;
  sourceKey: string;
  midiChannel: number;
  id: string;
}

/** libvgmのdevice/channel muteへ変換できる1トラック分の選択先。 */
interface LibvgmTrackTarget {
  deviceType: number;
  instance: number;
  mainMask: number;
  linkedMask: number;
  groupId: string;
  suggestedForHardwareMix: boolean;
}

/** 最初の発音時点におけるFMトラックの音色解釈。MIDIには表せない値をsidecarへ残す。 */
interface FMTimbreMetadata {
  model: 'opn' | 'opm' | 'opl' | 'opll';
  suggestedProgram: number;
  algorithm?: number;
  carrierOperators?: number[];
  operatorMultipliers?: number[];
  operatorMultiplierWritten?: boolean[];
  operatorTotalLevels?: number[];
  keyOnMask?: number;
  ym2413Instrument?: number;
  ym2413CarrierMultiple?: number;
  ym2413Volume?: number;
  specialOperator?: number;
  /** OPN Ch3 Specialの出力モード。CSM時はTimer Aによる自動キーオンを伴う。 */
  opnCh3Mode?: 'special' | 'special-csm';
}

interface FMTimbreEvent {
  sampleTime: number;
  source:
    | 'ym2413-patch'
    | 'ym2413-custom-patch'
    | 'opn-timbre'
    | 'opm-timbre'
    | 'opl-timbre';
  timbre: FMTimbreMetadata;
}

interface ActiveNoteInfo {
  note: number;
  startTime: number;
  startVolume: number;
}

interface PCMVoiceNote {
  descriptorId: string;
  note: number;
}

interface TrackState {
  descriptor: TrackDescriptor;
  track: any;
  cursor: number;
  expression: number;
  fmTimbre?: FMTimbreMetadata;
  fmEvents?: FMTimbreEvent[];
  pcmEvents?: PCMTrackEvent[];
  pcmDataBlock?: PCMDataBlockMetadata;
  pcmAnalysis?: PCMAnalysisMetadata;
}

// PCMTrackEvent/PCMDataBlockMetadata/PCMAnalysisMetadata/PCMTimbreMetadataは、
// ROM範囲解析（analyzeSigned8BitPCM()等）と合わせてpcm-analysis.tsへ移設した
// （上のimportを参照）。

interface PCMTrackMetadata {
  source: 'ym2612-dac' | 'ym2612-dac-direct' | 'ym2608-adpcm-b' | 'segapcm' | 'c140' | 'msm6258';
  sampleId: string;
  gmNote?: number;
  events: PCMTrackEvent[];
  dataBlock?: PCMDataBlockMetadata;
  analysis?: PCMAnalysisMetadata;
  timbre?: PCMTimbreMetadata;
}

/** PCMトリガーに付随するチップ固有の再生範囲。 */
export interface PCMPlaybackRangeMetadata {
  endAddressExclusive: number;
  loopAddress?: number;
}

/** source keyを現在のdescriptor IDへ正規化し、既存handlerのMap APIを保つ。 */
class DescriptorActiveNotes extends Map<string, ActiveNoteInfo> {
  constructor(private readonly resolveId: (key: string) => string) { super(); }

  private normalizeKey(key: string): string { return this.resolveId(key); }
  override has(key: string): boolean { return super.has(this.normalizeKey(key)); }
  override get(key: string): ActiveNoteInfo | undefined { return super.get(this.normalizeKey(key)); }
  override set(key: string, value: ActiveNoteInfo): this { return super.set(this.normalizeKey(key), value); }
  override delete(key: string): boolean { return super.delete(this.normalizeKey(key)); }
}

interface StreamState {
  chipType: number;
  bankId: number;
  frequency: number;
  stepSize: number;
  stepBase: number;
  dataPosition: number;
  targetChip?: string;
  targetInstance?: number;
  targetPort?: number;
  targetRegister?: number;
  voice?: PCMVoiceNote;
  /** 現在のStartで解決済みのDAC command数。DCTRL_LMODE_IGNOREが再利用する。 */
  resolvedCommandCount?: number;
  /** 現在のStartで解決済みのraw byte長。identityとIGNOREの両方に使う。 */
  resolvedLength?: number;
  /** millisecond modeを含む、直近Startの絶対sample長。 */
  resolvedDurationSamples?: number;
  /** 非loop streamの予定終了sample。$94/再Startでこの未来Note Offを置換する。 */
  scheduledEndSamples?: number;
}

interface StreamRange {
  start: number;
  length: number;
  commandCount: number;
  durationSamples?: number;
  blockId?: number;
  isLoop: boolean;
  isReverse: boolean;
}
interface ChipInstanceState { channels: Map<string, ChannelState>; scalars: Record<string, unknown>; }

export type OPNCh3Chip = 'YM2203' | 'YM2608' | 'YM2612';

export interface OPNCh3Context {
  chip: OPNCh3Chip;
  instance: number;
  stateKey: string;
  parentKey: string;
  operatorKeys: readonly [string, string, string, string];
  percussionPrefix: string;
}

export interface CSMTimerState {
  timerHigh: number;
  timerLow: number;
  isRunning: boolean;
  isCSMEnabled: boolean;
  nextOverflow?: number;
  nextRelease?: number;
  lastEmittedTick?: number;
  manualKeyOnMask?: number;
  manualKeyOnMasks?: number[];
}

/** VGMのチップ書き込みを解析し、音程・音量・ノイズの発音状態をMIDIイベントへ変換する。 */
export class MidiConverter {
  vgmData: VGMData;
  options: ConversionOptions;
  sampleRate = 44100;
  channels: Map<string, ChannelState> = new Map();
  private tracks: Map<string, TrackState> = new Map();
  private descriptors: Map<string, TrackDescriptor> = new Map();
  /** 実際に重なった異descriptorのMIDI channelだけを記録する（開発者向け、--verboseで表示）。 */
  public warnings: string[] = [];
  /** ヒューリスティック変換が誤りやすい入力を検出したときの、エンドユーザー向け注意事項。
   * warnings（技術的な内部診断）とは別に扱い、--track-metadataサイドカーへ書き出して
   * miditrackのWeb UIがそのまま表示できるようにする。 */
  public userWarnings: string[] = [];
  activeMidiDescriptors: Map<string, { midiChannel: number; startTime: number }> = new Map();
  activePCMNotes: Map<string, number> = new Map();
  generatedNoteCount = 0;
  lastLatchedChannel = 0;
  gameGearStereo = 0xFF;
  huc6280SelectedChannels = [0, 0];
  segaPCMRegisters = new Uint8Array(0x100);
  c140Registers = new Uint8Array(0x200);
  segaPCMActiveVoices: Array<PCMVoiceNote | undefined> = new Array(16);
  c140ActiveVoices: Array<PCMVoiceNote | undefined> = new Array(24);
  pcmSampleNotes: Map<string, number> = new Map();
  isYM2612DACEnabled = false;
  ym2612DACPendingAddress?: number;
  ym2612DACActiveVoice?: PCMVoiceNote;
  ym2612DirectDACActiveVoice?: PCMVoiceNote;
  ym2612DirectDACLastWriteTime?: number;
  // Ch3 mode and active collapsed-percussion track are isolated per OPN chip instance.
  opnCh3SpecialModes: Map<string, boolean> = new Map();
  opnCh3PercussionActiveKeys: Map<string, string> = new Map();
  // Counts how often a Ch3 Special attack keys on 2+ audible operators within
  // OPN_CH3_UNISON_SEMITONE_THRESHOLD of each other, per OPN chip instance — a source
  // driving every operator at (near-)identical pitch is playing one melodic voice in
  // unison, not four independently-pitched voices or a composite drum patch. See
  // appendOPNCh3UnisonWarnings() for how this becomes a user-facing warning.
  opnCh3UnisonStats: Map<string, { totalAttacks: number; unisonAttacks: number }> = new Map();
  private opnCsmTimers: Map<string, CSMTimerState> = new Map();
  private opmCsmTimers: Map<number, CSMTimerState> = new Map();
  oplRhythmModes: Map<string, boolean> = new Map();
  oplRhythmControlBytes: Map<string, number> = new Map();
  ym2203Prescalers = [6, 6];
  ym2608Prescalers = [6, 6];
  ym2608RhythmTotalLevels = [0, 0];
  ym2608RhythmInstrumentLevels = [new Array(6).fill(0), new Array(6).fill(0)];
  ym2608ADPCMRegisters = [new Uint8Array(0x11), new Uint8Array(0x11)];
  ym2608ADPCMActiveVoices: Array<PCMVoiceNote | undefined> = new Array(2);
  // True while YM2413 register $0E bit 5 selects rhythm mode. See the YM2413_RHYTHM_*
  // constants above for the register/percussion mapping.
  ym2413RhythmMode = false;
  // Last-written $0E value, masked to bits 0-4, used to detect which individual rhythm
  // key-on bits changed on the next $0E write (XOR against the new value).
  ym2413RhythmControlByte = 0;
  // 4-bit volume registers (0=loudest, 15=quietest) for the five rhythm voices, in
  // YM2413_RHYTHM_NOTES order (BD, HH, SD, TOM, CYM). BD comes from $36's low nibble; HH
  // and TOM come from $37/$38's normally-instrument-number high nibble (repurposed in
  // rhythm mode); SD and CYM come from $37/$38's low nibble.
  ym2413RhythmVolumes = [0, 0, 0, 0, 0];
  ym2413CustomPatch = new Uint8Array(8);
  hasYM2413CustomCarrierMultiple = false;
  // AY-3-8910/YM2203/YM2608 SSG noise-period (reg 6) is one shared generator per chip
  // instance, unlike tone/volume which are per-channel — keyed by the SSG's keyPrefix
  // (e.g. "ay8910", "ym2203_0_ssg", "ym2608_1_ssg").
  ssgNoisePeriods: Map<string, number> = new Map();
  // All SegaPCM/C140 sample tracks share GM percussion channel 10 (see
  // isPercussionKey()/midiChannelForKey()), so there is exactly one current pan value for
  // the whole channel, not one per track — see addPCMPan()'s comment for why a per-track
  // cache would be wrong here.
  pcmChannel10Pan?: number;
  private initialChannels: Map<string, ChannelState> = new Map();
  private streams: Map<number, StreamState> = new Map();
  huc6280GlobalBalance = [0xFF, 0xFF];
  private secondaryChipStates: Map<string, ChipInstanceState> = new Map();
  private activeChipInstance?: { chip: string; instance: number };
  gbDmgMasterVolume = 0x77;
  gbDmgStereoRouting = 0xFF;
  gbDmgFrameSteps = [0, 0];
  gbDmgNextFrameSamples = [GBDMG_FRAME_SAMPLES, GBDMG_FRAME_SAMPLES];

  constructor(vgmData: VGMData, options: ConversionOptions = {}) {
    this.vgmData = vgmData;
    this.options = {
      tempo: options.tempo || 120,
      trackPerChannel: options.trackPerChannel || false,
      verbose: options.verbose || false,
      suppressHardwareNoise: options.suppressHardwareNoise || false,
      suppressYM2612Dac: options.suppressYM2612Dac || false,
      splitChips: options.splitChips || false,
      opnCh3SpecialPercussion:
        options.opnCh3SpecialPercussion ?? options.ym2612Ch3SpecialPercussion ?? false,
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
  withChipInstance(chip: string, instance: number, action: () => void): void {
    const previousContext = this.activeChipInstance;
    this.activeChipInstance = instance === 1 ? { chip, instance } : undefined;
    if (instance !== 1 || !this.secondaryChipStates.has(chip)) {
      try { action(); } finally { this.activeChipInstance = previousContext; }
      return;
    }
    const saved = this.secondaryChipStates.get(chip)!;
    const predicate = (key: string): boolean => this.belongsToChip(key, chip);
    const primaryChannels = new Map([...this.channels.entries()].filter(([key]) => predicate(key)));
    for (const [key, state] of saved.channels) if (predicate(key)) this.channels.set(key, this.cloneChannels(new Map([[key, state]])).get(key)!);
    const primaryScalars = this.captureChipScalars(chip);
    this.restoreChipScalars(chip, saved.scalars);
    try {
      action();
    } finally {
      saved.channels = new Map([...this.channels.entries()].filter(([key]) => predicate(key)));
      saved.scalars = this.captureChipScalars(chip);
      for (const [key, state] of primaryChannels) this.channels.set(key, state);
      this.restoreChipScalars(chip, primaryScalars);
      this.activeChipInstance = previousContext;
    }
  }

  private belongsToChip(key: string, chip: string): boolean {
    return (chip === 'SN76489' && key.startsWith('psg_'))
      || (chip === 'YM2413' && key.startsWith('ym2413_')) || (chip === 'YM2612' && key.startsWith('ym2612_'))
      || (chip === 'YM2151' && key.startsWith('ym2151_')) || (chip === 'GBDMG' && key.startsWith('gbdmg_'))
      || (chip === 'SegaPCM' && key.startsWith('segapcm_')) || (chip === 'C140' && key.startsWith('c140_'));
  }

  private captureChipScalars(chip: string): Record<string, unknown> {
    if (chip === 'SN76489') return { lastLatchedChannel: this.lastLatchedChannel, gameGearStereo: this.gameGearStereo };
    if (chip === 'YM2612') return {
      dacEnabled: this.isYM2612DACEnabled, pending: this.ym2612DACPendingAddress,
      active: this.ym2612DACActiveVoice, direct: this.ym2612DirectDACActiveVoice,
      last: this.ym2612DirectDACLastWriteTime,
      ch3Modes: new Map(this.opnCh3SpecialModes),
      ch3Percussion: new Map(this.opnCh3PercussionActiveKeys),
    };
    if (chip === 'YM2413') return { rhythm: this.ym2413RhythmMode, control: this.ym2413RhythmControlByte, volumes: this.ym2413RhythmVolumes.slice(), customPatch: this.ym2413CustomPatch.slice(), hasCustomCarrier: this.hasYM2413CustomCarrierMultiple };
    if (chip === 'GBDMG') return {
      masterVolume: this.gbDmgMasterVolume,
      stereoRouting: this.gbDmgStereoRouting,
    };
    if (chip === 'SegaPCM') return {
      registers: this.segaPCMRegisters.slice(), voices: this.segaPCMActiveVoices.slice(),
      sampleNotes: new Map(this.pcmSampleNotes), pcmChannel10Pan: this.pcmChannel10Pan,
    };
    if (chip === 'C140') return {
      registers: this.c140Registers.slice(), voices: this.c140ActiveVoices.slice(),
      sampleNotes: new Map(this.pcmSampleNotes), pcmChannel10Pan: this.pcmChannel10Pan,
    };
    return {};
  }

  private restoreChipScalars(chip: string, value: Record<string, unknown>): void {
    if (chip === 'SN76489') { this.lastLatchedChannel = (value.lastLatchedChannel as number) ?? 0; this.gameGearStereo = (value.gameGearStereo as number) ?? 0xFF; }
    else if (chip === 'YM2612') {
      this.isYM2612DACEnabled = (value.dacEnabled as boolean) ?? false; this.ym2612DACPendingAddress = value.pending as number | undefined;
      this.ym2612DACActiveVoice = value.active as PCMVoiceNote | undefined; this.ym2612DirectDACActiveVoice = value.direct as PCMVoiceNote | undefined;
      this.ym2612DirectDACLastWriteTime = value.last as number | undefined;
      this.opnCh3SpecialModes = new Map((value.ch3Modes as Map<string, boolean> | undefined) ?? []);
      this.opnCh3PercussionActiveKeys = new Map((value.ch3Percussion as Map<string, string> | undefined) ?? []);
    }
    else if (chip === 'YM2413') { this.ym2413RhythmMode = (value.rhythm as boolean) ?? false; this.ym2413RhythmControlByte = (value.control as number) ?? 0; this.ym2413RhythmVolumes = ((value.volumes as number[] | undefined) ?? [0, 0, 0, 0, 0]).slice(); this.ym2413CustomPatch = ((value.customPatch as Uint8Array | undefined) ?? new Uint8Array(8)).slice(); this.hasYM2413CustomCarrierMultiple = (value.hasCustomCarrier as boolean) ?? false; }
    else if (chip === 'GBDMG') {
      this.gbDmgMasterVolume = (value.masterVolume as number) ?? 0x77;
      this.gbDmgStereoRouting = (value.stereoRouting as number) ?? 0xFF;
    }
    else if (chip === 'SegaPCM') {
      if (value.registers) this.segaPCMRegisters = (value.registers as Uint8Array).slice();
      if (value.voices) this.segaPCMActiveVoices = (value.voices as Array<PCMVoiceNote | undefined>).slice();
      this.pcmSampleNotes = new Map((value.sampleNotes as Map<string, number> | undefined) ?? []);
      this.pcmChannel10Pan = value.pcmChannel10Pan as number | undefined;
    }
    else if (chip === 'C140') {
      if (value.registers) this.c140Registers = (value.registers as Uint8Array).slice();
      if (value.voices) this.c140ActiveVoices = (value.voices as Array<PCMVoiceNote | undefined>).slice();
      this.pcmSampleNotes = new Map((value.sampleNotes as Map<string, number> | undefined) ?? []);
      this.pcmChannel10Pan = value.pcmChannel10Pan as number | undefined;
    }
  }

  /** 変換間で可変レジスタを共有しないための深い状態複製。 */
  private cloneChannels(source: Map<string, ChannelState>): Map<string, ChannelState> {
    return new Map([...source.entries()].map(([key, state]) => [key, {
      ...state,
      opnOperatorMultipliers: state.opnOperatorMultipliers?.slice(),
      opnOperatorMultiplierWritten: state.opnOperatorMultiplierWritten?.slice(),
      opnOperatorTotalLevels: state.opnOperatorTotalLevels?.slice(),
    }]));
  }

  /** OPN Ch3 Special関連state（opnCh3SpecialModes等）のMapキーを、YM2612は
   * インスタンス非依存、YM2203/YM2608はチップ+インスタンスで構築する。 */
  private opnCh3StateKey(chip: OPNCh3Chip, instance: number): string {
    const lowerChip = chip.toLowerCase();
    return chip === 'YM2612' ? lowerChip : `${lowerChip}_${instance}`;
  }

  opnCh3Context(chip: OPNCh3Chip, instance = 0): OPNCh3Context {
    const stateKey = this.opnCh3StateKey(chip, instance);
    const parentKey = chip === 'YM2612' ? 'ym2612_2' : `${stateKey}_fm_2`;
    const operatorKeys: [string, string, string, string] = [
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

  private initializeOPNCh3SpecialChannels(context: OPNCh3Context): void {
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
  midiChannelForKey(key: string): number {
    if (this.isPercussionKey(key)) return GM_PERCUSSION_CHANNEL;
    if (key.startsWith('psg_')) return parseInt(key.split('_')[1]) + 1;
    // Channel 3 special-mode Op1-3 sub-voices get their own MIDI channels (11-13),
    // reusing otherwise-unclaimed channel space the same way huc6280MidiChannel() wraps
    // onto 14-16/1-3 — safe for a plain SN76489+YM2612 Mega Drive VGM (this feature's
    // only known source), though it could collide with AY8910/YM2203/YM2608 channels in a
    // hypothetical VGM that also drives one of those chips simultaneously.
    if (key.startsWith('ym2612_ch3sp_')) return 10 + parseInt(key.split('_')[2]);
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
    if (key.startsWith('ym2203_')) return this.ym2203MidiChannel(key);
    if (key.startsWith('ym2608_')) return this.ym2608MidiChannel(key);
    if (this.isOPLKey(key)) return this.oplMidiChannel(key);
    if (key.startsWith('ym2151_')) return parseInt(key.split('_')[1]) + 1;
    if (key.startsWith('ay8910_')) return this.ay8910MidiChannel(key);
    if (key.startsWith('huc6280_')) return this.huc6280MidiChannel(key);
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
    if (key.startsWith('gbdmg_')) return parseInt(key.split('_')[1]) + 1;
    return 1;
  }

  /** VGM Extra Headerのチップ別volumeを、CC7に出力する0-127の値へ変換する。
   *
   * volume=0x0100（256）が100%（GM既定のCC7=100相当）。エントリが無い、
   * volume未指定、または相対値指定（isAbsoluteVolume!==true）の場合は
   * undefinedを返す — 相対値は「既定値からの差分」であり既定値そのものを
   * このパーサーは知らないため、絶対値指定のときだけ安全に採用できる。
   */
  private extraHeaderVolumePercent(chip: string, instance: number): number | undefined {
    const extraHeader = this.vgmData.extraHeader;
    if (!extraHeader || chip === 'misc') return undefined;
    // Extra Header側のチップ名テーブルはOKIM6258、descriptor.chipはMSM6258
    // （このファイル内の他の命名と合わせた別名）を使う。
    const lookupChip = chip === 'MSM6258' ? 'OKIM6258' : chip;
    const entry = extraHeader.find((e) => e.chip === lookupChip && e.instance === instance);
    if (!entry || entry.volume === undefined || entry.isAbsoluteVolume !== true) return undefined;
    return Math.max(0, Math.min(127, Math.round((entry.volume / 0x100) * 100)));
  }

  /** source keyを、現在のchip instanceを含む不変のtrack descriptorへ変換する。 */
  private descriptorForKey(key: string): TrackDescriptor {
    const existing = this.descriptors.get(key);
    if (existing) return existing;
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
  resolveDescriptor(key: string): TrackDescriptor {
    return this.descriptors.get(key) ?? this.descriptorForKey(key);
  }

  /** FMトラックの初回発音時に使うGM音色候補を返す。 */
  private suggestedProgramForFMTimbre(
    model: FMTimbreMetadata['model'], algorithm: number | undefined
  ): number {
    if (algorithm === undefined || model === 'opll') return GM_PROGRAM_LEAD_1_SQUARE;
    if (model === 'opl') return algorithm === 0
      ? GM_PROGRAM_LEAD_2_SAWTOOTH : GM_PROGRAM_DRAWBAR_ORGAN;
    if (algorithm <= 3) return GM_PROGRAM_LEAD_2_SAWTOOTH;
    if (algorithm <= 6) return GM_PROGRAM_SYNTH_BRASS_1;
    return GM_PROGRAM_DRAWBAR_ORGAN;
  }

  /** YM2413内蔵patch番号に対応するGM試聴音色候補を返す。 */
  private suggestedProgramForYM2413Patch(instrument: number): number {
    return YM2413_GM_PROGRAM_BY_PATCH[instrument & 0x0F] ?? GM_PROGRAM_LEAD_1_SQUARE;
  }

  /** YM2413の選択patchからcarrier Multipleを取得する。 */
  private ym2413CarrierMultiple(state: ChannelState): number {
    const instrument = state.ym2413Instrument ?? 0;
    const nibble = instrument === 0
      ? (this.hasYM2413CustomCarrierMultiple ? this.ym2413CustomPatch[1] & 0x0F : 1)
      : YM2413_BUILTIN_CARRIER_MULTIPLES[instrument] ?? 1;
    return YM2413_OPERATOR_MULTIPLES[nibble] ?? 1;
  }

  /** OPN Ch3 Specialのオペレータトラックから親FMチャンネルを解決する。 */
  private opnCh3ParentStateForSourceKey(sourceKey: string): ChannelState | undefined {
    if (sourceKey.startsWith('ym2612_ch3sp_')) return this.channels.get('ym2612_2');
    const match = /^(ym2203|ym2608)_(\d+)_ch3sp_\d+$/.exec(sourceKey);
    return match ? this.channels.get(`${match[1]}_${match[2]}_fm_2`) : undefined;
  }

  /** OPN Ch3の親／オペレータ別トラックなら、現在のSpecial/CSM状態を返す。 */
  private opnCh3ModeForDescriptor(descriptor: TrackDescriptor): FMTimbreMetadata['opnCh3Mode'] | undefined {
    const { chip, instance, sourceKey } = descriptor;
    if (!['YM2203', 'YM2608', 'YM2612'].includes(chip)) return undefined;
    const context = this.opnCh3Context(chip as OPNCh3Chip, instance);
    if (sourceKey !== context.parentKey && !context.operatorKeys.includes(sourceKey)) return undefined;
    if (!this.isOPNCh3SpecialMode(context)) return undefined;
    return this.opnCsmTimer(context.chip, context.instance).isCSMEnabled
      ? 'special-csm'
      : 'special';
  }

  /** MIDIの初回Program Changeと同じ時点のFM状態をsidecar用に複製する。 */
  private fmTimbreForDescriptor(descriptor: TrackDescriptor): FMTimbreMetadata | undefined {
    const chip = descriptor.chip;
    const model = chip === 'YM2151' ? 'opm'
      : chip === 'YM2413' ? 'opll'
      : OPL_CHIPS.includes(chip as OPLChip) ? 'opl'
      : ['YM2203', 'YM2608', 'YM2612'].includes(chip) ? 'opn' : undefined;
    if (!model) return undefined;
    const isPrimaryFM = descriptor.section === 'fm'
      || (descriptor.section === 'tone' && ['YM2151', 'YM2413', 'YM2612'].includes(chip));
    if (!isPrimaryFM && descriptor.section !== 'ch3-special') return undefined;

    const state = descriptor.section === 'ch3-special'
      ? this.opnCh3ParentStateForSourceKey(descriptor.sourceKey)
      : this.channels.get(descriptor.sourceKey);
    if (!state) return undefined;

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
  recordFMTimbreEvent(
    key: string,
    currentTime: number,
    source: FMTimbreEvent['source']
  ): void {
    const state = this.channels.get(key);
    if (!state?.active) return;
    const descriptor = this.resolveDescriptor(key);
    const trackState = this.tracks.get(descriptor.id);
    if (!trackState) return;
    const timbre = this.fmTimbreForDescriptor(descriptor);
    if (!timbre) return;
    const events = trackState.fmEvents;
    const prior = events && events.length > 0
      ? events[events.length - 1].timbre
      : trackState.fmTimbre;
    if (JSON.stringify(prior) === JSON.stringify(timbre)) return;
    trackState.fmEvents ??= [];
    trackState.fmEvents.push({ sampleTime: currentTime, source, timbre });
  }

  /** 発音後のYM2413音色状態をsidecarの時系列イベントへ追記する。 */
  recordYM2413TimbreEvent(
    channel: number,
    currentTime: number,
    source: FMTimbreEvent['source']
  ): void {
    const key = `ym2413_${channel}`;
    this.recordFMTimbreEvent(key, currentTime, source);
  }

  /** OPN Ch3 Special時は親と発音中のオペレータ別トラックをまとめて更新する。 */
  /** PCMトラックの循環しない元サンプルIDとMIDIノートの対応をsidecar向けに返す。 */
  private pcmMetadataForTrack(state: TrackState): PCMTrackMetadata | undefined {
    if (state.pcmEvents === undefined) return undefined;
    const sourceKey = state.descriptor.sourceKey;
    const gmNote = this.pcmSampleNotes.get(sourceKey);
    const events = state.pcmEvents.map(event => ({ ...event }));
    const pcmDataBlock = state.pcmDataBlock;
    const dataBlock = pcmDataBlock === undefined ? {} : { dataBlock: pcmDataBlock };
    if (sourceKey.startsWith('ym2612dac_sample_')) {
      return {
        source: 'ym2612-dac', sampleId: sourceKey.slice('ym2612dac_sample_'.length), gmNote, events, ...dataBlock,
      };
    }
    if (sourceKey === 'ym2612dac_direct_stream') {
      return { source: 'ym2612-dac-direct', sampleId: 'direct-stream', gmNote, events, ...dataBlock };
    }
    const adpcmMatch = /^ym2608_\d+_adpcmb_sample_(.+)$/.exec(sourceKey);
    if (adpcmMatch) {
      return {
        source: 'ym2608-adpcm-b', sampleId: adpcmMatch[1], gmNote, events, ...dataBlock,
        ...(state.pcmAnalysis === undefined
          ? {}
          : { analysis: state.pcmAnalysis, timbre: pcmTimbreForAnalysis(state.pcmAnalysis) }),
      };
    }
    if (sourceKey.startsWith('segapcm_sample_')) {
      const analysis = segaPCMAnalysisForTrack(this.vgmData, pcmDataBlock, events);
      return {
        source: 'segapcm', sampleId: sourceKey.slice('segapcm_sample_'.length), gmNote, events, ...dataBlock,
        ...(analysis === undefined ? {} : { analysis, timbre: pcmTimbreForAnalysis(analysis) }),
      };
    }
    if (sourceKey.startsWith('c140_sample_')) {
      return {
        source: 'c140', sampleId: sourceKey.slice('c140_sample_'.length), gmNote, events, ...dataBlock,
        ...(state.pcmAnalysis === undefined
          ? {}
          : { analysis: state.pcmAnalysis, timbre: pcmTimbreForAnalysis(state.pcmAnalysis) }),
      };
    }
    if (sourceKey.startsWith('msm6258_sample_')) {
      return { source: 'msm6258', sampleId: sourceKey.slice('msm6258_sample_'.length), gmNote, events, ...dataBlock };
    }
    return undefined;
  }

  getTrack(key: string): TrackState {
    const descriptor = this.resolveDescriptor(key);
    const storageKey = descriptor.id;
    if (!this.tracks.has(storageKey)) {
      const track = new MidiWriter.Track();
      track.setTempo(this.options.tempo!);
      const sourceKey = descriptor.sourceKey;
      key = sourceKey;
      const fmTimbre = this.fmTimbreForDescriptor(descriptor);

      // Add track name/instrument based on key
      if (key.startsWith('huc6280_')) track.addTrackName(this.huc6280TrackName(key));
      else if (key.startsWith('psg_noise_')) track.addTrackName('SN76489 Noise ' + key.split('_')[2]);
      else if (key.startsWith('ym2151_noise_')) track.addTrackName('YM2151 Noise ' + key.split('_')[2]);
      else if (key.startsWith('ay8910_')) track.addTrackName(this.ay8910TrackName(key));
      else if (key.includes('_ch3perc_')) track.addTrackName(this.opnCh3PercussionTrackName(key));
      else if (key.includes('_ch3sp_')) track.addTrackName(this.opnCh3SpecialTrackName(key));
      else if (key.startsWith('ym2203_')) track.addTrackName(this.ym2203TrackName(key));
      else if (key.startsWith('ym2608_')) track.addTrackName(this.ym2608TrackName(key));
      else if (this.isOPLKey(key)) track.addTrackName(this.oplTrackName(key));
      else if (key.startsWith('ym2612dac_sample_')) track.addTrackName(this.formatPCMTrackName(key, 'YM2612 DAC'));
      else if (key === 'ym2612dac_direct_stream') track.addTrackName('YM2612 DAC Direct');
      else if (key.startsWith('segapcm_sample_')) track.addTrackName(this.formatPCMTrackName(key, 'SegaPCM'));
      else if (key.startsWith('c140_sample_')) track.addTrackName(this.formatPCMTrackName(key, 'C140'));
      else if (key.startsWith('msm6258_sample_')) track.addTrackName(this.formatPCMTrackName(key, 'MSM6258 Trigger'));
      else if (key.includes('psg')) track.addTrackName('SN76489 PSG ' + key.split('_')[1]);
      else if (key.includes('ym2612')) track.addTrackName('YM2612 FM ' + key.split('_')[1]);
      else if (key.includes('ym2151')) track.addTrackName('YM2151 FM ' + key.split('_')[1]);
      else if (key.startsWith('ym2413_rhythm_')) track.addTrackName('YM2413 Rhythm ' + YM2413_RHYTHM_NAMES[parseInt(key.split('_')[2])]);
      else if (key.startsWith('ym2413_')) track.addTrackName('YM2413 FM ' + key.split('_')[1]);
      else if (key.startsWith('gbdmg_noise_')) track.addTrackName('GameBoy DMG Noise');
      else if (key === 'gbdmg_2') track.addTrackName('GameBoy DMG Wave');
      else if (key.startsWith('gbdmg_')) track.addTrackName('GameBoy DMG Square ' + key.split('_')[1]);

      // ProgramChangeEvent's channel is 0-based, same as PitchBendEvent (see the
      // noteOn()/updateNotePitch() comments on that).
      if (!this.isPercussionKey(key)) {
        track.addEvent(new MidiWriter.ProgramChangeEvent({
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
        track.addEvent(new MidiWriter.ControllerChangeEvent({
          controllerNumber: 7,
          controllerValue: chipVolumePercent,
          channel: descriptor.midiChannel,
          delta: 0,
        }));
      }

      this.tracks.set(storageKey, { descriptor, track, cursor: 0, expression: 127, fmTimbre });
    }
    return this.tracks.get(storageKey)!;
  }

  private isPercussionKey(key: string): boolean {
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

  private isWidePitchBendFMKey(key: string): boolean {
    return this.isYM2151FMKey(key)
      || this.isOPLFMKey(key)
      || ((key.startsWith('ym2203_') || key.startsWith('ym2608_')) && key.includes('_fm_'))
      || key.startsWith('psg_') || key.startsWith('ay8910_') || key.startsWith('huc6280_')
      || key.startsWith('gbdmg_') || key.includes('_ssg_');
  }

  isYM2151FMKey(key: string): boolean {
    return key.startsWith('ym2151_') && !key.startsWith('ym2151_noise_');
  }

  isOPLKey(key: string): boolean {
    return key.startsWith('ym3812_') || key.startsWith('ym3526_') || key.startsWith('y8950_');
  }

  isOPLFMKey(key: string): boolean {
    return this.isOPLKey(key) && key.includes('_fm_') && !key.includes('_rhythm_');
  }

  pitchBendRangeForKey(key: string): number {
    if (this.isYM2151FMKey(key)) return YM2151_FM_PITCH_BEND_RANGE;
    if (this.isOPLFMKey(key)) return OPL_FM_PITCH_BEND_RANGE;
    if (key.startsWith('ym2608_') && key.includes('_fm_')) return YM2608_FM_PITCH_BEND_RANGE;
    if (key.startsWith('ym2203_') && key.includes('_fm_')) return YM2203_FM_PITCH_BEND_RANGE;
    if (key.startsWith('psg_') || key.startsWith('ay8910_') || key.startsWith('huc6280_') || key.startsWith('gbdmg_') || key.includes('_ssg_')) return CHIP_PITCH_BEND_RANGE;
    return 2;
  }

  private addPitchBendRange(track: any, midiChannel: number, semitones: number): void {
    for (const [controllerNumber, controllerValue] of [
      [101, 0],
      [100, 0],
      [6, semitones],
      [38, 0],
      [101, 127],
      [100, 127],
    ]) {
      track.addEvent(new MidiWriter.ControllerChangeEvent({
        controllerNumber,
        controllerValue,
        channel: midiChannel,
        delta: 0,
      }));
    }
  }

  private formatPCMTrackName(key: string, chipName: string): string {
    const sampleId = key.startsWith('msm6258_sample_')
      ? key.slice('msm6258_sample_'.length).toUpperCase()
      : key.split('_')[2].toUpperCase();
    const note = this.pcmSampleNotes.get(key);
    return `${chipName} Sample 0x${sampleId} (GM ${note ?? '?'})`;
  }

  private ym2203MidiChannel(key: string): number {
    const [, instanceText, section, channelText] = key.split('_');
    const instance = parseInt(instanceText);
    const channel = parseInt(channelText);
    if (instance === 0) return section === 'fm' ? channel + 1 : channel + 4;
    return section === 'fm' ? channel + 7 : channel + 11;
  }

  private oplMidiChannel(key: string): number {
    const [, instanceText, , channelText] = key.split('_');
    const instance = parseInt(instanceText);
    const channel = parseInt(channelText);
    return instance === 0 ? channel + 1 : ((10 + channel) % 16) + 1;
  }

  private oplTrackName(key: string): string {
    const [prefix, instanceText, section, channelText] = key.split('_');
    const chip = OPL_DISPLAY_NAMES[prefix.toUpperCase() as OPLChip];
    const suffix = instanceText === '0' ? '' : ' #2';
    if (section === 'rhythm') {
      return `${chip}${suffix} Rhythm ${OPL_RHYTHM_NAMES[parseInt(channelText)]}`;
    }
    return `${chip}${suffix} FM ${channelText}`;
  }

  private ay8910MidiChannel(key: string): number {
    const parts = key.split('_');
    const instance = parseInt(parts[1]);
    const channel = parseInt(parts[parts.length - 1]);
    return instance === 0 ? channel + 11 : channel + 14;
  }

  private ay8910TrackName(key: string): string {
    const parts = key.split('_');
    const suffix = parts[1] === '0' ? '' : ' #2';
    const channel = parts[parts.length - 1];
    return key.includes('_noise_')
      ? `AY-3-8910${suffix} Noise ${channel}`
      : `AY-3-8910${suffix} ${channel}`;
  }

  private huc6280MidiChannel(key: string): number {
    const parts = key.split('_');
    const instance = parseInt(parts[1]);
    const channel = parseInt(parts[parts.length - 1]);
    return instance === 0 ? ((14 + channel - 1) % 16) + 1 : channel + 4;
  }

  private huc6280TrackName(key: string): string {
    const parts = key.split('_');
    const suffix = parts[1] === '0' ? '' : ' #2';
    const channel = parts[parts.length - 1];
    return key.includes('_noise_')
      ? `HuC6280${suffix} Noise ${channel}`
      : `HuC6280${suffix} PSG ${channel}`;
  }

  private ym2203TrackName(key: string): string {
    const parts = key.split('_');
    const [, instanceText, section] = parts;
    const channelText = parts[parts.length - 1];
    const chipSuffix = instanceText === '0' ? '' : ' #2';
    const sectionName = section === 'fm' ? 'FM' : 'SSG';
    if (key.includes('_noise_')) return `YM2203${chipSuffix} SSG Noise ${channelText}`;
    return `YM2203${chipSuffix} ${sectionName} ${channelText}`;
  }

  private opnCh3DisplayNameForKey(key: string): string {
    const parts = key.split('_');
    const chip = parts[0].toUpperCase();
    if (chip === 'YM2612') return chip;
    return `${chip}${parts[1] === '0' ? '' : ' #2'}`;
  }

  private opnCh3SpecialTrackName(key: string): string {
    const parts = key.split('_');
    return `${this.opnCh3DisplayNameForKey(key)} Ch3 Special Op${parts[parts.length - 1]}`;
  }

  private opnCh3PercussionTrackName(key: string): string {
    const note = parseInt(key.split('_ch3perc_')[1]);
    const name = OPN_CH3_PERCUSSION_NAMES.get(note) ?? 'Percussion';
    return `${this.opnCh3DisplayNameForKey(key)} Ch3 Special ${name} (GM ${note})`;
  }

  private ym2608MidiChannel(key: string): number {
    const [, instanceText, section, channelText] = key.split('_');
    const instance = parseInt(instanceText);
    const channel = parseInt(channelText);
    if (instance === 0) return section === 'fm' ? channel + 1 : channel + 7;
    return section === 'fm' ? channel + 11 : channel + 1;
  }

  private ym2608TrackName(key: string): string {
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
    if (key.includes('_noise_')) return `YM2608${suffix} SSG Noise ${channel}`;
    return `YM2608${suffix} ${sectionName} ${channel}`;
  }

  // frequencyToMidiNote()/frequencyToExactMidi()/psgRegisterToFrequency()/
  // ym2612FrequencyToHz()/ym2203FrequencyToHz()/oplFrequencyToHz()/
  // ay8910RegisterToFrequency()/ym2203SSGRegisterToFrequency()/
  // huc6280RegisterToFrequency()/ym2413RegisterToFrequency()は`this`に依存しない
  // 純粋関数として、他のチップ非依存なMIDI数学と合わせてmidi-math.tsへ移設した
  // （上のimportを参照）。

  /** 選択patchのcarrier Multipleを、明確な2の累乗だけoctave補正に変換する。 */
  ym2413PitchScale(state: ChannelState): number {
    const instrument = state.ym2413Instrument ?? 0;
    const multipleNibble = instrument === 0
      ? (this.hasYM2413CustomCarrierMultiple ? this.ym2413CustomPatch[1] & 0x0F : 1)
      : YM2413_BUILTIN_CARRIER_MULTIPLES[instrument] ?? 1;
    const multiple = YM2413_OPERATOR_MULTIPLES[multipleNibble] ?? 1;
    return Number.isInteger(Math.log2(multiple)) ? multiple : 1;
  }

  // gbDmgSquareFrequencyToHz()/gbDmgWaveFrequencyToHz()/gbDmgNoiseFrequencyToHz()/
  // gbDmgNoiseNoteForPeriod()/samplesToTicks()も`this`に依存しない純粋関数として
  // midi-math.tsへ移設した（上のimportを参照）。

  convert(): any[] {
    let currentTime = 0;
    const activeNotes = new DescriptorActiveNotes(key => this.resolveDescriptor(key).id);
    this.tracks.clear(); // Reset tracks
    this.descriptors.clear();
    this.warnings = [];
    this.userWarnings = [];
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
    this.opnCh3UnisonStats.clear();
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
        advanceGBDMGFrameSequencers(this, currentTime, activeNotes);
      }
      else if (cmd.type === 'pcm_seek' && cmd.chip === 'YM2612') {
        handleYM2612DACSeek(this, cmd);
      }
      else if (cmd.type === 'pcm_write' && cmd.chip === 'YM2612') {
        handleYM2612DACWrite(this, currentTime);
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
          handlePSGWrite(this, cmd.data!, currentTime, activeNotes, i);
        });
      }
      else if (cmd.type === 'psg_stereo' && cmd.data !== undefined) {
        this.withChipInstance('SN76489', cmd.instance ?? 0, () => handleGameGearStereo(this, cmd.data!, currentTime));
      }
      else if (cmd.type === 'ay_stereo' && cmd.data !== undefined && cmd.chip !== undefined) {
        this.handleAYSSGStereo(cmd.chip, cmd.instance ?? 0, cmd.data, currentTime);
      }
      else if (cmd.type === 'chip_write') {
        this.withChipInstance(cmd.chip ?? 'unknown', cmd.instance ?? 0, () => {
          // Handle other chips.  Every handler sees only the selected instance's state.
          if (cmd.chip === 'YM2612') handleYM2612Write(this, cmd, currentTime, activeNotes, i);
          else if (cmd.chip === 'YM2203') handleYM2203Write(this, cmd, currentTime, activeNotes, i);
          else if (cmd.chip === 'YM2608') handleYM2608Write(this, cmd, currentTime, activeNotes, i);
          else if (OPL_CHIPS.includes(cmd.chip as OPLChip)) handleOPLWrite(this, cmd, currentTime, activeNotes, i);
          else if (cmd.chip === 'YM2151') handleYM2151Write(this, cmd, currentTime, activeNotes);
          else if (cmd.chip === 'AY8910') handleAY8910Write(this, cmd, currentTime, activeNotes, i);
          else if (cmd.chip === 'HuC6280') handleHuC6280Write(this, cmd, currentTime, activeNotes, i);
          else if (cmd.chip === 'SegaPCM') handleSegaPCMWrite(this, cmd, currentTime);
          else if (cmd.chip === 'C140') handleC140Write(this, cmd, currentTime);
          else if (cmd.chip === 'YM2413') handleYM2413Write(this, cmd, currentTime, activeNotes, i);
          else if (cmd.chip === 'GBDMG') handleGBDMGWrite(this, cmd, currentTime, activeNotes, i);
        });
      }
    }

    this.stopAllPCMVoices(currentTime);

    // Turn off any remaining notes
    for (const descriptorId of [...activeNotes.keys()]) {
      noteOff(this, descriptorId, 0, currentTime, activeNotes);
    }

    this.appendOPNCh3UnisonWarnings();

    return Array.from(this.tracks.values()).map(t => t.track);
  }

  // --- Chip Handling Logic ---

  // handleGameGearStereo()/handlePSGWrite()/handleSN76489NoiseControl()/
  // syncSN76489NoiseVolume()/sn76489Velocity()/sn76489Expression()/sn76489NoiseNote()/
  // reevaluateSN76489NoiseForChannel2Frequency()は、SN76489のレジスタ処理として
  // chips/sn76489.tsへ移設した（上のimportを参照）。

  /** VGM $31 のAY/OPN SSG LR maskを各SSG voiceのCC10へ変換する。 */
  private handleAYSSGStereo(chip: string, instance: number, data: number, currentTime: number): void {
    const keyPrefix = chip === 'AY8910'
      ? `ay8910_${instance}`
      : chip === 'YM2203'
        ? `ym2203_${instance}_ssg`
        : chip === 'YM2608'
          ? `ym2608_${instance}_ssg`
          : undefined;
    if (!keyPrefix) return;
    for (let channel = 0; channel < 3; channel++) {
      const hasRight = (data & (1 << (channel * 2))) !== 0;
      const hasLeft = (data & (1 << (channel * 2 + 1))) !== 0;
      addPan(this, `${keyPrefix}_${channel}`, hasLeft, hasRight, currentTime);
    }
  }


  isOPNCh3SpecialMode(context: OPNCh3Context): boolean {
    return this.opnCh3SpecialModes.get(context.stateKey) ?? false;
  }

  /** OPN Timer Aの値をCSM schedulerへ反映する。 */
  /** OPN $27のCSM有効状態とTimer Aの開始状態を更新する。 */
  // updateOPMCsmTimerRegister()/updateOPMCsmTimer()は、YM2151のCSM Timer A設定処理
  // としてchips/ym2151.tsへ移設した（上のimportを参照）。

  /** すべての動作中CSM Timer Aをwait区間内で進める。 */
  private advanceCSMTimers(
    startTime: number,
    targetTime: number,
    activeNotes: Map<string, { note: number; startTime: number; startVolume: number }>
  ): void {
    if (targetTime <= startTime) return;
    for (const [key, timer] of this.opnCsmTimers) {
      if (!timer.isRunning || !timer.isCSMEnabled) continue;
      const [chip, instanceText] = key.split(':');
      const chipInstance = Number(instanceText);
      this.withChipInstance(chip, chipInstance, () => {
        this.advanceCSMTimer(
          timer,
          targetTime,
          this.opnCsmPeriodSamples(chip as OPNCh3Chip, timer),
          time => this.emitOPNCsmPulse(chip as OPNCh3Chip, chipInstance, true, time, activeNotes),
          time => this.emitOPNCsmPulse(chip as OPNCh3Chip, chipInstance, false, time, activeNotes)
        );
      });
    }
    for (const [instance, timer] of this.opmCsmTimers) {
      if (!timer.isRunning || !timer.isCSMEnabled) continue;
      this.withChipInstance('YM2151', instance, () => {
        this.advanceCSMTimer(
          timer,
          targetTime,
          this.opmCsmPeriodSamples(timer),
          time => this.emitOPMCsmPulse(instance, true, time, activeNotes),
          time => this.emitOPMCsmPulse(instance, false, time, activeNotes)
        );
      });
    }
  }

  /** Timer AのoverflowとMIDI pulse終了を時刻順に処理する。 */
  private advanceCSMTimer(
    timer: CSMTimerState,
    targetTime: number,
    periodSamples: number,
    emitAttack: (time: number) => void,
    emitRelease: (time: number) => void
  ): void {
    while (true) {
      const nextOverflow = timer.nextOverflow ?? Infinity;
      const nextRelease = timer.nextRelease ?? Infinity;
      const nextEvent = Math.min(nextOverflow, nextRelease);
      if (nextEvent > targetTime) return;

      if (nextRelease <= nextOverflow) {
        emitRelease(nextRelease);
        timer.nextRelease = undefined;
        continue;
      }

      timer.nextOverflow = nextOverflow + periodSamples;
      const currentTick = samplesToTicks(nextOverflow, this.options.tempo!, this.sampleRate);
      if (timer.lastEmittedTick === currentTick) continue;
      if (timer.nextRelease !== undefined) emitRelease(nextOverflow);
      emitAttack(nextOverflow);
      timer.lastEmittedTick = currentTick;
      timer.nextRelease = nextOverflow + this.csmPulseSamples();
    }
  }

  /** OPN CSMを既存のCh3 Special出力形式へ変換する。 */
  emitOPNCsmPulse(
    chip: OPNCh3Chip,
    instance: number,
    isKeyOn: boolean,
    currentTime: number,
    activeNotes: Map<string, { note: number; startTime: number; startVolume: number }>
  ): void {
    const context = this.opnCh3Context(chip, instance);
    handleOPNCh3SpecialKeyWrite(
      this,
      context,
      isKeyOn ? 0xF2 : 0x02,
      currentTime,
      activeNotes,
      true
    );
  }

  /** OPM CSMを各チャンネルの短いMIDIアタックとして出力する。 */
  emitOPMCsmPulse(
    instance: number,
    isKeyOn: boolean,
    currentTime: number,
    activeNotes: Map<string, { note: number; startTime: number; startVolume: number }>
  ): void {
    const timer = this.opmCsmTimer(instance);
    timer.manualKeyOnMasks ??= new Array(8).fill(0);
    for (let channel = 0; channel < 8; channel++) {
      const key = `ym2151_${channel}`;
      const state = this.channels.get(key)!;
      state.keyOnMask = timer.manualKeyOnMasks[channel] | (isKeyOn ? 0x0F : 0);
      syncYM2151ToneState(this, channel, false, currentTime, activeNotes);
      if (channel === 7) syncYM2151NoiseState(this, false, currentTime, activeNotes);
    }
  }

  /** OPN/OPMが共通で使う1 MIDI tick分のCSM pulse長をsampleへ換算する。 */
  private csmPulseSamples(): number {
    return Math.max(1, (CSM_MIDI_PULSE_TICKS * 60 * this.sampleRate) / (this.options.tempo! * MIDI_PPQ));
  }

  /** OPN Timer Aの1周期をVGM sampleへ換算する。 */
  opnCsmPeriodSamples(chip: OPNCh3Chip, timer: CSMTimerState): number {
    const clock = this.opnClockRate(chip);
    const count = (timer.timerHigh << 2) | timer.timerLow;
    return Math.max(1, (72 * (1024 - count) * this.sampleRate) / clock);
  }

  /** OPM Timer Aの1周期をVGM sampleへ換算する。 */
  opmCsmPeriodSamples(timer: CSMTimerState): number {
    const clock = (this.vgmData.header.ym2151Clock & CLOCK_MASK) || 3579545;
    const count = (timer.timerHigh << 2) | timer.timerLow;
    return Math.max(1, (64 * (1024 - count) * this.sampleRate) / clock);
  }

  /** OPN各機種のヘッダーclockを取得する。 */
  opnClockRate(chip: OPNCh3Chip): number {
    const clock = chip === 'YM2612'
      ? this.vgmData.header.ym2612Clock
      : chip === 'YM2203'
        ? this.vgmData.header.ym2203Clock
        : this.vgmData.header.ym2608Clock;
    return (clock & CLOCK_MASK) || 7670453;
  }

  /** OPNチップインスタンスのCSM状態を初期化して返す。 */
  opnCsmTimer(chip: OPNCh3Chip, instance: number): CSMTimerState {
    const key = `${chip}:${instance}`;
    const current = this.opnCsmTimers.get(key);
    if (current) return current;
    const timer: CSMTimerState = { timerHigh: 0, timerLow: 0, isRunning: false, isCSMEnabled: false };
    this.opnCsmTimers.set(key, timer);
    return timer;
  }

  /** OPMチップインスタンスのCSM状態を初期化して返す。 */
  opmCsmTimer(instance: number): CSMTimerState {
    const current = this.opmCsmTimers.get(instance);
    if (current) return current;
    const timer: CSMTimerState = { timerHigh: 0, timerLow: 0, isRunning: false, isCSMEnabled: false };
    this.opmCsmTimers.set(instance, timer);
    return timer;
  }

  /** Ch3 Specialの新規キーオンで、発音中オペレータ同士がユニゾン(ほぼ同一音程)かを集計する。
   *
   * handleOPNCh3SpecialOperators()/handleOPNCh3SpecialPercussion()が parentState.keyOnMask を
   * 書き換える前に呼ぶ必要がある — 「新規にキーオンされたオペレータ」の判定に前回のマスクを使うため。
   */
  /** ユニゾン比率が高いOPN Ch3 Specialチップインスタンスをthis.warningsへ追記する。
   *
   * 全オペレータがほぼ同一音程で動いているチャンネルは、実際には複数オペレータで補強された
   * 1つのメロディ楽器であり、デフォルト変換の「独立4トラック」表示にもGMドラム変換にも
   * 適さない — 見た目上の見た目はどちらも「複数の異なる発音」だが、本来は1音。
   */
  private appendOPNCh3UnisonWarnings(): void {
    for (const [stateKey, stats] of this.opnCh3UnisonStats) {
      if (stats.totalAttacks < OPN_CH3_UNISON_WARNING_MIN_ATTACKS) continue;
      if (stats.unisonAttacks / stats.totalAttacks < OPN_CH3_UNISON_WARNING_RATIO) continue;
      const percent = Math.round((stats.unisonAttacks / stats.totalAttacks) * 100);
      this.userWarnings.push(
        `${this.opnCh3DisplayNameForKey(stateKey)} Ch3 Special: ${percent}% of attacks keyed ` +
        `multiple operators at nearly the same pitch (likely one melodic voice reinforced ` +
        `across operators, not four independent voices or a drum patch). The default ` +
        `operator-view conversion will duplicate this melody across several tracks, and ` +
        `--ch3-special-percussion is likely to misclassify it as drum hits.`
      );
    }
  }

  /** OPN/OPNA の $B4-$B6 LR 出力マスクを CC10 に変換する。 */
  opnPitchScale(state: ChannelState): number {
    return this.fmPitchScale(state, OPN_OPERATOR_PATHS, 0x7F, OPN_DOUBLED_MULTIPLES);
  }

  oplPitchScale(state: ChannelState): number {
    return this.fmPitchScale(state, OPL_OPERATOR_PATHS, 0x3F, OPL_DOUBLED_MULTIPLES);
  }

  fmPitchScale(
    state: ChannelState,
    paths: readonly (readonly OPNOperatorPath[])[],
    silentTotalLevel: number,
    doubledMultiples: readonly number[]
  ): number {
    const algorithm = state.opnAlgorithm ?? 0;
    const keyOnMask = state.keyOnMask ?? 0;
    const totalLevels = state.opnOperatorTotalLevels ?? [];
    const operatorIndexes = new Set<number>();

    for (const path of paths[algorithm] ?? paths[0]) {
      const isCarrierActive = (keyOnMask & (1 << path.carrier)) !== 0;
      if (!isCarrierActive || (totalLevels[path.carrier] ?? 0) >= silentTotalLevel) continue;
      for (const operator of path.operators) {
        const isOperatorActive = (keyOnMask & (1 << operator)) !== 0;
        if (isOperatorActive && (totalLevels[operator] ?? 0) < silentTotalLevel) operatorIndexes.add(operator);
      }
    }

    if (operatorIndexes.size === 0) return 1;
    const multipliers = state.opnOperatorMultipliers ?? [];
    const multiplierWritten = state.opnOperatorMultiplierWritten ?? [];
    if ([...operatorIndexes].some(operator => !multiplierWritten[operator])) return 1;
    const activeMultiples = [...operatorIndexes].map(operator => doubledMultiples[multipliers[operator] ?? 0]);
    const commonMultiplier = activeMultiples.reduce(greatestCommonDivisor) / 2;
    if (commonMultiplier === 0.5) return 0.5;
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
  opnCarrierVelocity(state: ChannelState): number {
    return this.fmCarrierVelocity(state, OPN_OPERATOR_PATHS, 0x7F);
  }

  oplCarrierVelocity(state: ChannelState): number {
    return this.fmCarrierVelocity(state, OPL_OPERATOR_PATHS, 0x3F);
  }

  private fmCarrierVelocity(
    state: ChannelState,
    paths: readonly (readonly OPNOperatorPath[])[],
    silentTotalLevel: number
  ): number {
    const algorithm = state.opnAlgorithm ?? 0;
    const keyOnMask = state.keyOnMask ?? 0;
    const totalLevels = state.opnOperatorTotalLevels ?? [];
    let minCarrierTL: number | undefined;

    for (const path of paths[algorithm] ?? paths[0]) {
      const isCarrierActive = (keyOnMask & (1 << path.carrier)) !== 0;
      const tl = totalLevels[path.carrier] ?? 0;
      if (!isCarrierActive || tl >= silentTotalLevel) continue;
      if (minCarrierTL === undefined || tl < minCarrierTL) minCarrierTL = tl;
    }

    if (minCarrierTL === undefined) return 80;
    return this.operatorTotalLevelVelocity(minCarrierTL);
  }

  // Shared TL(0=loudest,0x7F=silent)-to-MIDI-velocity(1-100) curve, factored out of
  // opnCarrierVelocity() so YM2612 channel-3 special mode can derive a velocity directly
  // from one operator's own Total Level — special mode has no algorithm/carrier routing to
  // walk (each operator is an independent oscillator), so opnCarrierVelocity()'s
  // OPN_OPERATOR_PATHS traversal doesn't apply there.
  operatorTotalLevelVelocity(totalLevel: number): number {
    const velocity = Math.round(100 * Math.pow(10, -(0.75 * totalLevel) / 120));
    return Math.max(1, Math.min(100, velocity));
  }

  /** Key On時のvelocityを基準に、発音中TL変化だけを相対CC11へ変換する。 */
  opnCarrierExpression(state: ChannelState): number {
    return this.fmCarrierExpression(state, this.opnCarrierVelocity(state));
  }

  oplCarrierExpression(state: ChannelState): number {
    return this.fmCarrierExpression(state, this.oplCarrierVelocity(state));
  }

  private fmCarrierExpression(state: ChannelState, currentVelocity: number): number {
    const keyOnVelocity = Math.max(1, state.opnActiveVelocity ?? currentVelocity);
    return Math.max(1, Math.min(127, Math.round((currentVelocity / keyOnVelocity) * 127)));
  }

  // Groups consecutive $2A writes into one note by elapsed-time gap (see
  // YM2612_DAC_DIRECT_GAP_SAMPLES). All writes share one track/sample identity, since $2A
  // carries no address to distinguish samples by.
  // Closes the direct-DAC voice at the last actual $2A write time, not `currentTime` —
  // called from both $2B-disable and EOF (stopAllPCMVoices()), neither of which should
  // stretch the final hit's duration out to whenever this happens to be called.
  updateKeyBoundFMPitch(
    key: string,
    currentTime: number,
    activeNotes: Map<string, { note: number; startTime: number; startVolume: number }>,
    pitchBendRange: number
  ): void {
    const state = this.channels.get(key)!;
    if (!activeNotes.has(key)) {
      if (state.active) noteOn(this, key, 0, currentTime, activeNotes);
      return;
    }

    const frequency = getNoteFrequency(this, key, state);
    if (frequency <= 20) return;
    const semitoneOffset = frequencyToExactMidi(frequency) - state.baseMidiNote;
    addPitchBend(this, key, semitoneOffset, pitchBendRange, currentTime);
  }

  /** YM2608 ADPCM-Bの非repeat範囲を、VGMの44.1 kHz時間単位へ概算変換する。 */
  // handleAY8910Write()はchips/ay8910.tsへ、handleSSGWrite()から始まる
  // AY-3-8910互換SSG（AY8910/YM2203/YM2608内蔵SSGコアで共有）の状態機械は
  // chips/ssg.tsへ移設した（上のimportを参照）。


  // handleYM2151Write()から始まるYM2151のレジスタ処理群は、chips/ym2151.tsへ
  // 移設した（上のimportを参照）。


  // handleHuC6280Write()/updateHuC6280Pan()は、HuC6280のレジスタ処理として
  // chips/huc6280.tsへ移設した（上のimportを参照）。


  // handleSegaPCMWrite()/triggerSegaPCMVoice()は、chips/segapcm.tsへ移設した
  // （上のimportを参照）。

  // handleC140Write()/triggerC140Voice()は、chips/c140.tsへ移設した
  // （上のimportを参照）。

  // handleOPLWrite()から始まるOPLファミリー（YM3812/YM3526/Y8950）のレジスタ処理群は、
  // chips/opl.tsへ移設した（上のimportを参照）。

  // handleYM2413Write()から始まるYM2413のレジスタ処理群は、chips/ym2413.tsへ
  // 移設した（上のimportを参照）。

  // advanceGBDMGFrameSequencers()から始まるGame Boy DMGのフレームシーケンサと
  // handle*Write()レジスタ処理群は、chips/gbdmg.tsへ移設した（上のimportを参照）。

  stopPCMVoice(
    activeVoices: Array<PCMVoiceNote | undefined>,
    channel: number,
    currentTime: number
  ): void {
    const voice = activeVoices[channel];
    if (!voice) return;
    noteOffPCMPercussion(this, voice.descriptorId, voice.note, currentTime);
    activeVoices[channel] = undefined;
  }

  private stopAllPCMVoices(currentTime: number): void {
    stopYM2612DACVoice(this, currentTime);
    stopYM2612DirectDACVoice(this, currentTime);
    for (let instance = 0; instance < this.ym2608ADPCMActiveVoices.length; instance++) {
      stopYM2608ADPCMBVoice(this, instance, currentTime);
    }
    for (let channel = 0; channel < this.segaPCMActiveVoices.length; channel++) {
      this.stopPCMVoice(this.segaPCMActiveVoices, channel, currentTime);
    }
    for (let channel = 0; channel < this.c140ActiveVoices.length; channel++) {
      this.stopPCMVoice(this.c140ActiveVoices, channel, currentTime);
    }
    for (const stream of this.streams.values()) this.stopStreamVoice(stream, currentTime, true);
    // Secondary chip scalars are swapped out of the primary fields above. Descriptor-owned
    // PCM notes remain globally visible, so close every remaining one at EOF as well.
    for (const [descriptorId, note] of [...this.activePCMNotes]) {
      noteOffPCMPercussion(this, descriptorId, note, currentTime);
    }
  }

  /** DAC stream 0x90–0x95 を処理し、MSM6258は編集用GMトリガーとして残す。 */
  private handleStreamCommand(cmd: VGMCommand, currentTime: number): void {
    const streamId = cmd.streamId; if (streamId === undefined) return;
    if (cmd.type === 'stream_stop' && streamId === 0xFF) {
      for (const stream of this.streams.values()) this.stopStreamVoice(stream, currentTime);
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
    else if (cmd.type === 'stream_frequency') { stream.frequency = cmd.frequency ?? 0; }
    else if (cmd.type === 'stream_stop') {
      this.stopStreamVoice(stream, currentTime);
    } else if (cmd.type === 'stream_start' || cmd.type === 'stream_start_fast') {
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
        const key = `msm6258_sample_${identity}`; const note = pcmNoteForSample(this, key);
        const commandSize = this.streamCommandSize(stream);
        const dataLengthBytes = range.commandCount > 0
          ? range.commandCount * commandSize * Math.max(1, stream.stepSize)
          : undefined;
        const dataBlock = this.pcmDataBlockForRange(
          stream.bankId,
          stream.targetInstance ?? 0,
          range.start,
          dataLengthBytes
        );
        const descriptorId = noteOnPCMPercussion(this, 
          key,
          note,
          80,
          currentTime,
          range.isLoop,
          dataBlock,
          range.isLoop ? undefined : range.durationSamples
        );
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
  private stopStreamVoice(stream: StreamState, currentTime: number, isFinalizing = false): void {
    if (stream.voice) {
      const scheduled = stream.scheduledEndSamples;
      const closeTime = isFinalizing && scheduled !== undefined ? scheduled : Math.min(currentTime, scheduled ?? currentTime);
      noteOffPCMPercussion(this, stream.voice.descriptorId, stream.voice.note, closeTime);
    }
    stream.voice = undefined;
    stream.scheduledEndSamples = undefined;
  }

  /** 0x91で選択したbank内の連結offsetとblock番号を求める。 */
  private resolveStreamBankOffset(bankId: number, blockId: number, instance: number): { start: number; length: number } | undefined {
    const blocks = (this.vgmData.dataBlocks ?? []).filter(block => block.type === bankId && (block.instance ?? 0) === instance);
    const block = blocks.find(candidate => candidate.blockId === blockId);
    if (!block) return undefined;
    const start = blocks.filter(candidate => candidate.blockId < blockId)
      .reduce((total, candidate) => total + candidate.size, 0);
    return { start, length: block.size };
  }

  /** data bank内の連結offsetを、sidecar用のblock/offset情報へ変換する。 */
  pcmDataBlockForRange(
    bankType: number,
    bankInstance: number,
    bankOffset: number,
    lengthBytes?: number
  ): PCMDataBlockMetadata | undefined {
    if (bankOffset < 0) return undefined;
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
  pcmROMDataBlockForAddress(
    bankType: number,
    bankInstance: number,
    romAddress: number,
    lengthBytes?: number
  ): PCMDataBlockMetadata | undefined {
    if (romAddress < 0) return undefined;
    const blocks = (this.vgmData.dataBlocks ?? [])
      .filter(block => block.type === bankType && (block.instance ?? 0) === bankInstance)
      .sort((left, right) => left.blockId - right.blockId);
    for (const block of blocks) {
      // VGM ROM blocks begin with the full ROM size and the block's load address.
      if (block.payload.length < 8) continue;
      const romSizeBytes = block.payload.readUInt32LE(0);
      const romStartAddress = block.payload.readUInt32LE(4);
      const romDataLengthBytes = block.payload.length - 8;
      if (romAddress < romStartAddress || romAddress >= romStartAddress + romDataLengthBytes) continue;
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

  // segaPCMAnalysisForTrack()/c140PCMAnalysisForVoice()/analyzeSigned8BitPCM()等の
  // ROM範囲PCM/ADPCM波形解析は、pcm-analysis.tsへ移設した（上のimportを参照）。

  /** bankの連結sizeを返し、0x93「終端まで」のcommand数計算に使用する。 */
  private streamBankSize(bankId: number, instance: number): number {
    return (this.vgmData.dataBlocks ?? [])
      .filter(block => block.type === bankId && (block.instance ?? 0) === instance)
      .reduce((total, block) => total + block.size, 0);
  }

  /** setup先のVGM command/data幅から、stream一回のwriteに必要なbyte数を得る。 */
  private streamCommandSize(stream: StreamState): number {
    // MSM6258 is written by VGM $B7 as register+data (two command-data bytes).
    // Keep the port/register check explicit because real stream setups identify $B7
    // there; the chip fallback covers logs that encode only the stream device type.
    if (stream.targetPort === 0xB7 || stream.targetRegister === 0xB7) return 2;
    if (stream.targetChip === 'MSM6258' || (stream.chipType & 0x7F) === 0x17) return 2;
    if (stream.targetPort === 0xB2 || stream.targetRegister === 0xB2) return 2;
    return 1;
  }

  /** 0x93/0x95のlength modeをcommand数と絶対sample durationへ正規化する。 */
  private resolveStreamRange(stream: StreamState, cmd: VGMCommand): StreamRange | undefined {
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
    let blockId: number | undefined;
    let commandCount = 0;
    let durationSamples: number | undefined;

    if (isFast) {
      blockId = cmd.blockId ?? cmd.address ?? 0;
      const block = this.resolveStreamBankOffset(stream.bankId, blockId, stream.targetInstance ?? 0);
      if (!block) return undefined;
      rawStart = block.start;
      start = rawStart + stream.stepBase * commandSize;
      length = block.length;
      commandCount = Math.floor(length / stride);
    } else {
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
      if (mode === 1) commandCount = length;
      else if (mode === 2) durationSamples = Math.round((length * this.sampleRate) / 1000);
      else if (mode === 3) commandCount = Math.floor(Math.max(0, this.streamBankSize(stream.bankId, stream.targetInstance ?? 0) - rawStart) / stride);
      else if (mode === 0x0F) commandCount = Math.floor(length / stride);
      else if (mode !== 0) return undefined;
    }

    if (durationSamples === undefined && stream.frequency > 0) {
      durationSamples = Math.round((commandCount * this.sampleRate) / stream.frequency);
    }
    if (durationSamples === undefined && mode === 2) durationSamples = Math.round((length * this.sampleRate) / 1000);
    stream.dataPosition = rawStart + commandCount * stride;
    stream.resolvedCommandCount = commandCount;
    stream.resolvedLength = length;
    stream.resolvedDurationSamples = durationSamples;
    return { start, length, commandCount, durationSamples, blockId, isLoop, isReverse };
  }

  /** bank/block/start/length/step/flagを含む安定したMSM6258編集トリガーidentityを作る。 */
  private streamIdentity(stream: StreamState, range: StreamRange): string {
    const block = range.blockId === undefined ? 'range' : range.blockId.toString(16);
    return `bank${stream.bankId.toString(16)}_block${block}_start${range.start.toString(16)}_length${range.length.toString(16)}_step${stream.stepSize}_${range.isReverse ? 'reverse' : 'forward'}`;
  }

  // syncHuC6280ToneState()/syncHuC6280NoiseState()/updateHuC6280NoiseEnvelope()/
  // noteOnHuC6280Noise()/huc6280NoiseNoteForPeriod()/addHuC6280Expression()/
  // isHuC6280MultiByteFreqUpdate()も、chips/huc6280.tsへ移設した
  // （上のimportを参照）。


  isOPNMultiByteFreqUpdate(
    cmdIndex: number,
    chip: string,
    port: number,
    otherReg: number,
    instance = 0
  ): boolean {
    let skippedSamples = 0;
    for (let index = cmdIndex + 1; index < this.vgmData.commands.length; index++) {
      const next = this.vgmData.commands[index];
      if (next.type === 'wait' || next.type === 'pcm_write') {
        skippedSamples += next.samples ?? 0;
        if (skippedSamples > 16) return false;
        continue;
      }
      // A dual-chip log can interleave primary and secondary writes at the same sample.
      // They do not alter this instance's register latch, so keep looking for the paired
      // byte instead of combining it with an opposite-instance write or committing a
      // stale half-frequency.
      if (
        next.type === 'chip_write'
        && next.chip === chip
        && (next.instance ?? 0) !== instance
      ) continue;
      return next.type === 'chip_write'
        && next.chip === chip
        && (next.instance ?? 0) === instance
        && (next.port ?? 0) === port
        && next.register === otherReg;
    }
    return false;
  }

  // registerDescriptorStart()/registerDescriptorStop()/addExpression()/addPCMPan()/
  // addPan()/noteOnPercussion()/noteOnPCMPercussion()/noteOffPCMPercussion()/
  // pcmNoteForSample()は、イベント出力の定型処理としてevent-output.tsへ移設した
  // （上のimportを参照）。

  // getNoteFrequency()/ym2151KeyToFrequency()/noteOn()/noteOff()/updateNotePitch()/
  // addPitchBend()は、event-output.tsへ移設した（上のimportを参照）。

  /** MIDIトラック記述子をlibvgmのdevice/channel mute選択へ変換する。
   *
   * Ch3 Specialの4オペレータ別トラック（Op1-3の専用トラックとOp4=通常のchannel3トラック）
   * および複合ドラム化トラック（--ch3-special-percussion時）は、全部が同じ物理channel3の
   * レジスタ操作を見ているだけの別視点に過ぎない。安全な一対一のミュート対象は無いため
   * 個別のlibvgm選択は提供できないが、4トラック全部をchannel3のmainMaskへ束ねることで、
   * まとめて「原曲」へ切り替えたときだけ物理channel3全体（Special/Normal両モードの composite
   * 音を含む）を実機音源としてレンダリングできる。一部だけ「原曲」に切り替えると、
   * レンダリング後もSoundFontを選んだ残りのトラックはミュートされる（一切鳴らない）ため、
   * 二重発音は起きない——同じgroupIdの範囲は必ず一括で切り替わる
   * （validate_sources()のgroup_indices()展開を参照）。 */
  private libvgmTargetForDescriptor(descriptor: TrackDescriptor): LibvgmTrackTarget | undefined {
    const { chip, instance, section, channel, sourceKey } = descriptor;
    let deviceType: number | undefined;
    let mainChannel: number | undefined;
    let linkedChannel: number | undefined;
    let mainMask: number | undefined;
    let isSuggested = false;

    if (chip === 'SN76489') { deviceType = 0x00; mainChannel = channel; isSuggested = section === 'noise'; }
    else if (chip === 'YM2413') { deviceType = 0x01; mainChannel = section === 'rhythm' ? 9 + channel : channel; isSuggested = section === 'rhythm'; }
    else if (chip === 'YM2612') {
      deviceType = 0x02;
      if (section === 'pcm') { mainChannel = 6; isSuggested = true; }
      else if (sourceKey.includes('_ch3sp_') || sourceKey.includes('_ch3perc_')) mainChannel = 2;
      else mainChannel = channel;
    } else if (chip === 'YM2151') { deviceType = 0x03; mainChannel = channel; }
    else if (chip === 'SegaPCM') { deviceType = 0x04; mainMask = 0xFFFF; isSuggested = true; }
    else if (chip === 'YM2203') {
      deviceType = 0x06;
      if (section === 'fm') mainChannel = channel;
      else if (section === 'ch3-special' || section === 'ch3-percussion') mainChannel = 2;
      else if (section === 'ssg' || section === 'noise') linkedChannel = channel;
    } else if (chip === 'YM2608') {
      deviceType = 0x07;
      if (section === 'fm') mainChannel = channel;
      else if (section === 'ch3-special' || section === 'ch3-percussion') mainChannel = 2;
      else if (section === 'ssg' || section === 'noise') linkedChannel = channel;
      else if (section === 'rhythm') { mainChannel = 6 + channel; isSuggested = true; }
      else if (section === 'pcm') { mainChannel = 12; isSuggested = true; }
    } else if (['YM3812', 'YM3526', 'Y8950'].includes(chip)) {
      deviceType = chip === 'YM3812' ? 0x09 : chip === 'YM3526' ? 0x0A : 0x0B;
      mainChannel = section === 'rhythm' ? 9 + channel : channel;
      isSuggested = section === 'rhythm';
    } else if (chip === 'AY8910') { deviceType = 0x12; mainChannel = channel; }
    else if (chip === 'GBDMG') { deviceType = 0x13; mainChannel = section === 'noise' ? 3 : channel; isSuggested = section === 'noise'; }
    else if (chip === 'MSM6258') { deviceType = 0x17; mainMask = 1; isSuggested = true; }
    else if (chip === 'HuC6280') { deviceType = 0x1B; mainChannel = channel; }
    else if (chip === 'C140') { deviceType = 0x1C; mainMask = 0xFFFFFF; isSuggested = true; }

    if (deviceType === undefined) return undefined;
    const resolvedMainMask = mainMask ?? (mainChannel === undefined ? 0 : (1 << mainChannel) >>> 0);
    const linkedMask = linkedChannel === undefined ? 0 : (1 << linkedChannel) >>> 0;
    if (resolvedMainMask === 0 && linkedMask === 0) return undefined;
    const groupId = `${deviceType}:${instance}:${resolvedMainMask}:${linkedMask}`;
    return { deviceType, instance, mainMask: resolvedMainMask, linkedMask, groupId, suggestedForHardwareMix: isSuggested };
  }

  /** MIDIファイルを書き出し、音符が生成されなかった場合は空ファイルを作らず失敗させる。 */
  exportToFile(outputPath: string): void {
    const tracks = this.convert();
    if (this.generatedNoteCount === 0) {
      throw new Error('No MIDI notes were generated. The VGM may contain only unsupported or non-tonal sound data.');
    }
    require('fs').writeFileSync(outputPath, this.buildMidiFile(tracks));
    for (const warning of this.warnings) console.error(`Warning: ${warning}`);
    for (const warning of this.userWarnings) console.error(`Warning: ${warning}`);
    if (this.options.splitChips) this.exportSplitChipFiles(outputPath);
  }

  /** 出力MIDIのトラック順とlibvgmのmute対象を結ぶJSON sidecarを書き出す。
   *
   * warningsフィールドはuserWarnings（ヒューリスティック変換が誤りやすい入力を検出した
   * ときのエンドユーザー向け注意事項）を書き出す。this.warnings（MIDIチャンネル重複などの
   * 技術的な内部診断、--verboseでのみ表示）とは意図的に別で、miditrackのWeb UIが
   * そのままユーザーへ表示できる内容に限定する。 */
  exportTrackMetadata(outputPath: string, totalSamples: number): void {
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
      warnings: this.userWarnings,
    }, null, 2) + '\n');
  }

  /** MIDI writer の固定divisionを 960 PPQ へ置換する。 */
  private buildMidiFile(tracks: any[]): Buffer {
    const file = Buffer.from(new MidiWriter.Writer(tracks).buildFile());
    file.writeUInt16BE(MIDI_PPQ, 12);
    return file;
  }

  /** チップ別DAW編集用sidecarを、通常の混在出力と併せて書き出す。 */
  private exportSplitChipFiles(outputPath: string): void {
    const fs = require('fs'); const path = require('path');
    const groups = new Map<string, any[]>();
    for (const state of this.tracks.values()) {
      const chip = this.chipNameForDescriptor(state.descriptor);
      const tracks = groups.get(chip) ?? []; tracks.push(state.track); groups.set(chip, tracks);
    }
    const parsed = path.parse(outputPath);
    for (const [chip, tracks] of groups) fs.writeFileSync(path.join(parsed.dir, `${parsed.name}.${chip}.mid`), this.buildMidiFile(tracks));
  }

  /** sidecar名はsource keyではなくdescriptorのchip/instanceから生成する。 */
  private chipNameForDescriptor(descriptor: TrackDescriptor): string {
    return `${descriptor.chip}${descriptor.instance === 0 ? '' : `-${descriptor.instance + 1}`}`;
  }
}
