// MidiConverterから抽出した、チップ非依存のMIDI数学（周波数・MIDIノート・チック変換、
// ノイズのGMドラムノート判定）。すべて`this`に依存しない純粋関数として、
// MidiConverterはdispatch・ライフサイクル・exportに専念する。

import { CLOCK_MASK } from './vgm-chip-metadata';

export const MIDI_PPQ = 960;
export const DEFAULT_SAMPLE_RATE = 44100;

// Shared noise-frequency-to-GM-drum bands, used by SN76489, AY-3-8910/YM2203/YM2608 SSG,
// HuC6280, and YM2151 hardware noise. Each chip normalizes its own noise-rate register to
// a common [0..1] scale (0 = lowest/slowest, 1 = highest/fastest) before calling
// noiseDrumNote() below — absolute Hz thresholds would not transfer between chips whose
// noise-rate ranges differ by orders of magnitude (NES-style ~440Hz-447kHz vs. AY's
// clock/16/period range), but a normalized position within each chip's own range does.
const NOISE_DRUM_HIGH_NOTE = 42;              // Closed Hi-Hat
const NOISE_DRUM_MID_NOTE = 38;               // Acoustic Snare
const NOISE_DRUM_LOW_NOTE = 45;               // Low Tom
const NOISE_DRUM_PERIODIC_HIGH_NOTE = 37;     // Side Stick (SN76489 tonal/periodic noise)
const NOISE_DRUM_PERIODIC_LOW_NOTE = 35;      // Bass Drum (SN76489 tonal/periodic noise)

// isPeriodic marks SN76489's tonal/periodic noise mode (FB=0), which sounds pitched rather
// than like white noise, so it uses a different, more "tonal" pair of drum voices than the
// three-band white-noise mapping shared by every other chip.
export function noiseDrumNote(normalizedRate: number, isPeriodic: boolean): number {
  if (isPeriodic) {
    return normalizedRate >= 0.5 ? NOISE_DRUM_PERIODIC_HIGH_NOTE : NOISE_DRUM_PERIODIC_LOW_NOTE;
  }
  if (normalizedRate >= 0.7) return NOISE_DRUM_HIGH_NOTE;
  if (normalizedRate >= 0.35) return NOISE_DRUM_MID_NOTE;
  return NOISE_DRUM_LOW_NOTE;
}

export function greatestCommonDivisor(left: number, right: number): number {
  let dividend = Math.abs(left);
  let divisor = Math.abs(right);
  while (divisor !== 0) {
    [dividend, divisor] = [divisor, dividend % divisor];
  }
  return dividend;
}

export function frequencyToMidiNote(frequency: number): number {
  if (frequency <= 20) return 0; // Filter out very low frequencies
  // MIDI note = 69 + 12 * log2(freq / 440)
  const note = Math.round(69 + 12 * Math.log2(frequency / 440));
  return Math.max(0, Math.min(127, note));
}

export function frequencyToExactMidi(frequency: number): number {
    if (frequency <= 20) return 0;
    return 69 + 12 * Math.log2(frequency / 440);
}

export function psgRegisterToFrequency(register: number, clockRate: number, flags: number): number {
  const effectiveRegister = register === 0 && (flags & 0x01) !== 0 ? 0x400 : register;
  if (effectiveRegister === 0) return 0;
  // VGM header bit 30 (dual-chip) and bit 31 (T6W28) are flags, not part of the clock
  // value itself — mask them out the same way the OPN/OPNA/YM2151 clock reads already do.
  const effectiveClockRate = clockRate & 0x3FFFFFFF;
  // The usual SN76489 /8 input divider is enabled when flag bit 3 is clear.
  const divisor = (flags & 0x08) === 0 ? 32 : 4;
  return effectiveClockRate / (divisor * effectiveRegister);
}

export function ym2612FrequencyToHz(fnum: number, block: number, clockRate: number): number {
  if (fnum === 0) return 0;
  // YM2612 frequency = (fnum * clock) / (144 * 2^(20 - block))
  // Note: clock is usually ~7.6MHz. Formula assumes FM clock.
  // If block is undefined, treat as 0
  const blk = block || 0;
  const effectiveClockRate = clockRate & 0x3FFFFFFF;
  return (fnum * effectiveClockRate) / (144 * Math.pow(2, 20 - blk));
}

export function ym2203FrequencyToHz(
  fnum: number,
  block: number,
  clockRate: number,
  prescaler: number
): number {
  if (fnum === 0) return 0;
  const effectiveClockRate = clockRate & 0x3FFFFFFF;
  // YM2203 OPN F-Number uses a 144 divisor at the default /6 prescale.
  return (fnum * effectiveClockRate) / ((24 * prescaler) * Math.pow(2, 20 - block));
}

export function oplFrequencyToHz(fnum: number, block: number, clockRate: number): number {
  if (fnum === 0) return 0;
  const effectiveClockRate = clockRate & CLOCK_MASK;
  return (fnum * effectiveClockRate) / (72 * Math.pow(2, 20 - block));
}

export function ay8910RegisterToFrequency(register: number, clockRate: number, flags: number): number {
  // Period 0 behaves like 1 in hardware, but that tone is ultrasonic at normal clocks
  // and cannot be represented faithfully in MIDI; do not clamp it to audible note 127.
  if (register === 0) return 0;
  const baseClockRate = clockRate & 0x3FFFFFFF;
  const effectiveClockRate = (flags & 0x10) !== 0 ? baseClockRate / 2 : baseClockRate;
  // AY-3-8910 frequency = clock / (16 * register)
  return effectiveClockRate / (16 * register);
}

export function ym2203SSGRegisterToFrequency(
  register: number,
  clockRate: number,
  prescaler: number,
  flags: number
): number {
  // See ay8910RegisterToFrequency(): the real period-1 equivalent is ultrasonic.
  if (register === 0) return 0;
  const baseClockRate = clockRate & 0x3FFFFFFF;
  const effectiveClockRate = (flags & 0x10) !== 0 ? baseClockRate / 2 : baseClockRate;
  // The integrated SSG uses master clock / (64 * period) at the default /6 prescale.
  return (effectiveClockRate * (6 / prescaler)) / (64 * register);
}

export function huc6280RegisterToFrequency(register: number, clockRate: number): number {
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
export function ym2413RegisterToFrequency(fnum: number, block: number, clockRate: number): number {
  const effectiveClockRate = clockRate & CLOCK_MASK;
  if (effectiveClockRate <= 0) return 0;
  return (fnum * effectiveClockRate) / (72 * Math.pow(2, 19 - block));
}

// Game Boy DMG pulse channels (1-2): an 11-bit period register x drives a phase
// accumulator that wraps every (2048-x) input-clock cycles, divided by 32 to reach the
// final tone frequency — confirmed against Pan Docs' "Frequency = 131072/(2048-x)" at the
// chip's fixed 4194304Hz clock (131072 = 4194304/32); this generalizes that to an
// explicit clock parameter rather than hardcoding the reference value.
export function gbDmgSquareFrequencyToHz(period: number, clockRate: number): number {
  const effectiveClockRate = clockRate & CLOCK_MASK;
  if (effectiveClockRate <= 0 || period >= 2048) return 0;
  return effectiveClockRate / (32 * (2048 - period));
}

// Game Boy DMG wave channel (3): same 11-bit period/phase-accumulator shape as the pulse
// channels, but divided by 64 instead of 32 — the wave channel steps through all 32
// 4-bit wave-RAM samples per period instead of one square edge, doubling the reference
// rate (Pan Docs: "Frequency = 65536/(2048-x)"; 65536 = 4194304/64).
export function gbDmgWaveFrequencyToHz(period: number, clockRate: number): number {
  const effectiveClockRate = clockRate & CLOCK_MASK;
  if (effectiveClockRate <= 0 || period >= 2048) return 0;
  return effectiveClockRate / (64 * (2048 - period));
}

// Game Boy DMG noise channel (4): NR43 packs a 4-bit shift `s` and a 3-bit divisor code
// `r` (r=0 means divisor 0.5, matching the "For r=0 assume r=0.5" rule in Pan Docs'
// "Frequency = 524288/r/2^(s+1)" at the chip's fixed clock; 524288 = 4194304/8).
export function gbDmgNoiseFrequencyToHz(nr43: number, clockRate: number): number {
  const effectiveClockRate = clockRate & CLOCK_MASK;
  if (effectiveClockRate <= 0) return 0;
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
export function gbDmgNoiseNoteForPeriod(nr43: number, clockRate: number): number {
  const freq = gbDmgNoiseFrequencyToHz(nr43, clockRate);
  const clamped = Math.max(30, Math.min(15000, freq || 30));
  const normalizedRate = Math.log2(clamped / 30) / Math.log2(15000 / 30);
  return noiseDrumNote(normalizedRate, false);
}

// VGM samples (44.1kHz timeline) を MIDI tick へ変換する。絶対サンプル時刻から毎回
// 計算することで、イベントをまたいだ丸め誤差の蓄積を防ぐ。
export function samplesToTicks(
  samples: number,
  tempo: number,
  sampleRate: number = DEFAULT_SAMPLE_RATE,
  ppq: number = MIDI_PPQ,
): number {
  const seconds = samples / sampleRate;
  const quarterNotes = (seconds * tempo) / 60;
  return Math.round(quarterNotes * ppq);
}
