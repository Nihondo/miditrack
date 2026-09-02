# CLAUDE.md

Guidance for AI agents and developers working on this repository.

## What this project is

A Node.js/TypeScript CLI that converts VGM/VGZ (Video Game Music command
log) files to Standard MIDI Files, by replaying the logged sound-chip
register writes and heuristically inferring note on/off, pitch, and
velocity from them (not a full chip emulator — it interprets each chip's
register semantics directly). This directory is a vendored fork of
[jkarenko/vgm2midi](https://github.com/jkarenko/vgm2midi); see `NOTICE.md`
for the origin and license, and the section below for what was changed and
why. Unrelated to the YouTube publishing pipeline itself — like
`nsf2midi`/`spc2midi`, this exists for pulling chiptune material into a
DAW for arrangement.

## Why this was forked: missing chip conversion and silent empty output

Upstream only recognizes SN76489, YM2612, YM2413, YM2151, and AY-3-8910
chip-write commands (`src/vgm-parser.ts`'s `parseCommands()`). A VGM ripped
from a PC Engine / TurboGrafx-16 game (e.g. *OutRun (TG-16)*, which VGM
command `0xB9` covers) fell into the parser's unknown-command branch —
the 2 bytes after `0xB9` were correctly skipped so parsing didn't break,
but the write was discarded rather than recorded as a `chip_write` event.
With zero note events reaching `MidiConverter`, `exportToFile()` still
produced a syntactically valid but empty Standard MIDI File: a 14-byte
`MThd`-only output with no `MTrk` chunks worth of notes. This is a
silent failure — no error, no warning, just a technically "successful"
conversion with no music in it.

### What HuC6280's PSG looks like on the wire

Confirmed against [MAME's `c6280.cpp`](https://github.com/mamedev/mame/blob/master/src/devices/sound/c6280.cpp)
(the authoritative open-source register-level emulation) and the
[VGM specification](https://vgmrips.net/wiki/VGM_Specification) (HuC6280
clock at header offset `0xA4`, VGM ≥ 1.61; command `0xB9 aa dd` = write
`dd` to register `aa`). Register semantics (`aa`, hex):

| Reg | Meaning |
|---|---|
| `$00` | Channel select (0–5). Every later register write targets whichever channel was last selected here — there is no per-write channel field, unlike SN76489's latch-byte scheme. |
| `$01` | Global L/R balance (not modeled — see below) |
| `$02` | Frequency, low 8 bits of a 12-bit period |
| `$03` | Frequency, high 4 bits |
| `$04` | Channel control: bit7 = enable, bit6 = Direct D/A mode, bits0-4 = volume (**0 = silent, 31 = loudest**) |
| `$05` | Per-channel L/R balance (not modeled) |
| `$06` | Waveform table data / DDA sample data (not modeled — a channel in DDA mode plays raw PCM, not a tone) |
| `$07` | Noise control, channels 4–5 only: bit7 = noise enable |
| `$08`/`$09` | LFO frequency/control (not modeled) |

Frequency-to-Hz: the chip decrements the 12-bit period register at the
input clock rate to step through a 32-entry waveform table, so
`Hz = clock / (32 * period)`, with `period == 0` behaving like `0x1000`
on real hardware (`huc6280RegisterToFrequency()` in `midi-converter.ts`).
This is the same shape as SN76489's `clock / (32 * register)` — the two
chips' tone generators are structurally identical.

### Design choices in the port

- **DDA mode is excluded; noise mode becomes GM percussion.** `$04` bit6
  (DDA) plays raw sample data through register `$06`, so there is no meaningful
  note to convert. Hardware noise (`$07` bit7, channels 4–5) carries important
  rhythm, so `syncHuC6280NoiseState()` writes it to a separate
  `HuC6280 Noise N` track on General MIDI channel 10 as note 42 (Closed
  Hi-Hat). The exact 5-bit noise frequency/timbre is intentionally reduced to
  this one portable percussion voice. Tonal and noise active states remain
  separate so switching modes ends one representation before starting the other.
- **HuC6280 volume is 0=silent/31=loudest (5-bit).** MAME computes
  attenuation from `0x1f - (control & 0x1f)`, so both `noteOn()`'s velocity
  mapping and `handleHuC6280Write()`'s expression-CC mapping increase with
  the register value. An earlier inverted interpretation created phantom
  maximum-volume notes from silent `$04=$80` channel-reset writes.
- **Channel mode is persistent state.** `isEnabled`, `isDDA`, `isNoise`, and
  `isNoiseActive`
  are tracked independently from `active`, which means "a tonal MIDI note is
  currently sounding". Register `$04` may re-enable a channel while its prior
  `$07` noise bit remains set; that must start/continue the percussion track,
  not create a pitched waveform note.
- **MIDI channel assignment wraps rather than extending the scheme.**
  Upstream hands out MIDI channels 1–4 (SN76489), 5–10 (YM2612), 11–13
  (AY8910) — 13 of the 16 available MIDI channels already claimed. HuC6280
  needs 6 more, which doesn't fit in the 3 remaining slots (14–16).
  `huc6280MidiChannel()` assigns 14–16 to HuC6280 channels 0–2, then wraps
  channels 3–5 back onto MIDI channels 1–3 (`((14 + channel - 1) % 16) + 1`).
  This is safe in practice because a real VGM only ever drives one chip
  family — the OutRun (TG-16) file that motivated this fix has every
  other chip's clock field zeroed in the header, so SN76489 channels 1–3
  are never active to begin with. A hypothetical VGM that logs both
  SN76489 *and* HuC6280 activity simultaneously would see those tracks
  collide on the same MIDI channel; doing a full channel-budget redesign
  to avoid that (spanning multiple output files, or dropping GM channel-10
  percussion-avoidance some day) was judged out of scope for a single-chip
  console fix.
- **`$01`/`$05`/`$08`/`$09` (balance, LFO) are intentionally unmodeled**,
  consistent with upstream's own scope — none of the other chip handlers
  in this file model stereo panning or LFO/vibrato either, they only ever
  infer note on/off/pitch/volume from the tone-generator registers.
- **`$02`/`$03` split frequency writes are guarded against retriggering on
  their own intermediate state**, the same way `handlePSGWrite()` already
  guards SN76489's split tone-frequency writes. `handleHuC6280Write()`
  peeks ahead (`isHuC6280MultiByteFreqUpdate()`) through at most one 50 Hz frame
  for the other half of the pair before calling `updateNotePitch()` — a
  write to `$02` alone briefly leaves `state.frequency` combining the new
  LSB with a stale MSB (or vice versa for `$03`), which without this guard
  can read as a large, spurious pitch jump. Real HuC6280 drivers can distribute
  the pair across adjacent frame updates; a 16-sample limit created thousands
  of false MIDI attacks in the OutRun regression files. The bounded 882-sample
  window preserves that driver behavior without merging an unrelated write
  arbitrarily far later in the command stream.

### Added: real YM2151 conversion and strict command-boundary parsing

The upstream parser recorded VGM command `0x54 aa dd` as a `YM2151`
`chip_write`, and the CLI advertised YM2151 as supported, but
`MidiConverter.convert()` had no YM2151 branch. Every YM2151 write was therefore
discarded and `midi-writer-js` emitted only its 14-byte `MThd` header while the
CLI printed success.

`handleYM2151Write()` now models the eight OPM channels using the register map
documented by Yamaha and MAME:

- `$0F`: bit 7 enables hardware noise on channel 7; bits 0-4 select noise frequency
- `$08`: channel in bits 0-2, operator key-on mask in bits 3-6
- `$28-$2F`: channel key code (`OCT` plus the YM2151's gapped `NOTE` code)
- `$30-$37`: channel key fraction in bits 2-7 (1/64 semitone)

The key-code lookup converts the gapped NOTE values to chromatic semitones,
uses Yamaha's `OCT=4, NOTE=A, KF=0` = A440 reference at 3.579545 MHz, and
applies a clock-rate pitch correction for boards that clock the YM2151 at a
different rate (notably 4 MHz). While register `$08` remains keyed on, both
key-code and key-fraction changes stay within that one MIDI note as wide-range
pitch bends; only `$08` key transitions create note boundaries. `$08` normalizes
the M1/C1/M2/C2 mask to logical operators, while `$60/$68/$70/$78` physical
register slots are mapped in MAME ymfm order. The selected algorithm's audible
carrier TL values determine note-on velocity; a carrier TL change during a note
emits relative CC11 rather than a false retrigger. Each new Note On resets CC11
to 127 so the preceding note's envelope cannot attenuate the new velocity again.

### Added: YM2203 OPN FM and integrated SSG conversion

VGM 1.51+ stores the YM2203 clock at header `$44`. Command `$55 aa dd`
writes the primary chip, while `$A5 aa dd` writes the optional second chip
when clock flag bit 30 is set. `VGMCommand.instance` preserves that identity;
the converter initializes independent `ym2203_0_*` and `ym2203_1_*` state and
emits named `YM2203 FM N` / `YM2203 #2 FM N`, `SSG N`, and `SSG Noise N` tracks.

The three FM channels share the OPN register layout with YM2612 port 0:
`$28` controls operator key-on state, `$A0-$A2`/`$A4-$A6` hold normal channel
F-Number/block, `$30-$3F` hold DT/MULTI, `$40-$4F` hold total level, and
`$B0-$B2` hold algorithm/feedback. The YM2612-only state was therefore renamed
to generic OPN state, and `handleOPNTimbreWrite()` / `opnPitchScale()` serve
both chips. At the default `/6` prescale, FM frequency is equivalent to
`fnum * clock / (144 * 2^(20-block))`; the implementation generalizes this as
`fnum * clock / ((24 * prescaler) * 2^(20-block))`.

Registers below `$10` address the integrated AY-compatible SSG. AY-3-8910 and
YM2203 now share the same tone/mixer/volume/envelope state helpers, but keep
different clock formulas. YM2203 SSG tone frequency is
`clock * (6/prescaler) / (64 * period)`; using the standalone AY divisor 16
would put every SSG note two octaves too high. Mixer-selected SSG noise is sent
to GM channel 10/note 42. A write to envelope-shape register `$0D` retriggers
active tone/noise tracks whose volume register selects the hardware envelope,
so envelope-driven rhythm onsets are not lost.

YM2203 address registers `$2D/$2E/$2F` select prescalers 6/3/2 respectively;
`$2E` changes 6 to 3 only when the current value is 6, matching hardware.
Changing the prescaler retunes active FM and SSG notes. The CLI masks the dual
flag before displaying the clock and reports `dual chip` when appropriate.
Primary-chip FM/SSG use MIDI channels 1-6; second-chip FM uses 7-9 and SSG uses
11-13, leaving channel 10 for percussion.

Channel 3 Special mode follows the shared OPN implementation described below.
Register `$27` selects the mode, `$A8-$AA`/`$AC-$AE` supply operator-specific
frequencies for operators 1-3, `$A2/$A6` remains operator 4's frequency, and
`$28` supplies the operator key mask. Both YM2203 instances keep independent
mode, pitch, and optional collapsed-percussion state. Prescaler changes also
retune active Special-mode operator notes.

### Added: YM2608 OPNA FM, SSG, rhythm, and ADPCM-B conversion

VGM 1.51+ stores the YM2608 clock at header `$48` and its integrated SSG flags
at `$7B`. Commands `$56/$57` write ports 0/1 of the primary chip, while
`$A6/$A7` address the optional second chip. The parser preserves both the port
and chip instance, and the verbose CLI masks clock flag bits before reporting
`YM2608 FM/SSG/Rhythm/ADPCM-B`.

The six FM channels reuse the generic OPN state and frequency formula: channels
0-2 use port 0 and channels 3-5 use port 1, while register `$28` on port 0 owns
all key-on masks. Normal `$A0-$A2`/`$A4-$A6` frequency pairs are coalesced so
their intermediate half-written values cannot create phantom pitches. The
integrated SSG uses the same mixer, envelope-retrigger, tone, noise, and
prescaler path as YM2203. Both FM and SSG respond to `$2D/$2E/$2F` prescaler
writes. Primary-chip FM uses MIDI channels 1-6 and SSG uses 7-9; the second
chip's FM uses 11-16 and SSG wraps to 1-3, with channel 10 reserved for all
percussion tracks.

Port-0 rhythm registers `$10-$1D` become six semantic GM percussion tracks.
`$10` bit 7 selects dump/key-off and bits 0-5 select voices; an ordinary write
restarts a selected voice even if it is already active. The fixed mappings are
Bass Drum→36, Snare Drum→38, Top Cymbal→49, Hi-Hat→42, Tom-Tom→45, and Rim
Shot→37. Register `$11` supplies the 6-bit total level and `$18-$1D` the 5-bit
per-instrument levels. OPNA's level fields increase loudness rather than
attenuation, so `ym2608RhythmVelocity()` combines them using the hardware-style
threshold and sends later changes as MIDI expression.

Port-1 ADPCM-B registers `$00-$10` are interpreted as sample triggers rather
than decoded audio. An execute write (`$00` bit 7) uses `$02/$03` start address
as stable sample identity; repeating execute retriggers it, and reset/execute
clear, a subsequent start, or conversion end closes the MIDI note. Register
`$0B` drives velocity/expression. Delta-N (`$09/$0A`), end address, repeat mode,
and real sample duration are retained only as raw register state or ignored,
because faithfully reconstructing them requires the external ADPCM data and a
decoder rather than register-level note inference.

Like YM2203, channel 3 Special mode uses the shared OPN implementation described
below. Only port 0 owns `$27`, `$28`, and the Special frequency registers;
operators 1-3 use `$A8-$AA`/`$AC-$AE`, while operator 4 continues to use
`$A2/$A6`. Both YM2608 instances keep independent state, and prescaler changes
retune active Special-mode operator notes.

### Hardware-noise conversion

SN76489, YM2151, YM2203/YM2608 SSG, AY-3-8910, and HuC6280 hardware noise is represented on
separate named tracks using General MIDI channel 10 and note 42 (Closed
Hi-Hat). `isPercussionKey()` is the shared authority for channel assignment
and for suppressing Program Change events, while `noteOnPercussion()` and
`addExpression()` keep event timing and velocity handling consistent.

- SN76489 channel 3 noise-control writes retrigger percussion while the channel
  is audible. Its inverted 4-bit attenuation register gates the note and maps
  volume changes to expression.
- YM2151 register `$0F` switches channel 7 operator 4 (key-on bit `$40`) from a
  pitched approximation to percussion. Other keyed operators remain on the FM
  track, allowing mixed tonal/noise channel states to survive heuristically.
- AY-3-8910 register 7 independently gates tone and noise for channels A-C.
  Each channel can therefore keep simultaneous tonal and percussion tracks;
  registers 8-10 gate both representations and control their expression.
- YM2203 registers `$00-$0D` use the same SSG state machine with a separate
  chip-instance prefix and YM2203-specific master-clock/prescaler formula.
- YM2608 port-0 registers `$00-$0D` use that same state machine and OPNA
  clock/prescaler formula. Its separate built-in rhythm block is mapped to six
  semantic GM notes rather than collapsed to the SSG noise note.
- HuC6280 channels 4-5 retain the mode-state behavior described above. While
  noise remains active, `updateHuC6280NoiseEnvelope()` treats a volume rise of
  at least `HUC6280_NOISE_RETRIGGER_MIN_VOLUME_RISE` (4 register steps) as a
  new attack and emits Note Off followed by Note On. Smaller rises and all
  falls remain expression changes. This distinction matters because GM Closed
  Hi-Hat is a one-shot voice: expression alone cannot restart it when a game
  resets its software volume envelope without disabling hardware noise.

The source chips' noise-frequency, LFSR mode, and timbre controls are not mapped
to different drum notes. They are deliberately collapsed to one portable GM
voice so rhythmic onsets and rests survive DAW import.

`--noise-wav <file>` provides the higher-fidelity alternative for SN76489 and
HuC6280 only. `src/noise-renderer.ts` walks the already loop-expanded
`playback.data` timeline and writes a 16-bit/44.1kHz/stereo WAV. It is explicitly
an LFSR-only renderer, not a complete emulator: tone/FM, HuC6280 DDA/PCM, and
balance registers remain outside its scope. If no supported noise voice becomes
audible it removes/does not create the requested file, which lets `miditrack`
fall back to its ordinary fluidsynth render without mixing a stale stem.

SN76489 uses the Sega-style 16-bit seed `0x8000`, white-noise taps `0x0009`,
and resets the generator on every channel-3 noise-control write. The shift rate
shares `psgRegisterToFrequency()`'s header-flag rules: the common 3,579,545 Hz
clock with NF=0/1/2 produces 6991/3496/1748 shifts per second. HuC6280 follows
MAME `c6280.cpp` directly: `step = (reg & 0x1f) ^ 0x1f`, counter reload
`max(1, step << 6)`, an 18-bit seed of 1, and XOR feedback from bits
0/1/11/12/17 into bit 17. Both HuC6280 chip instances and channels 4-5 are kept
independent.

Supplying `--noise-wav` sets `suppressHardwareNoise` by default, so only the
five SN76489/HuC6280 MIDI percussion emission sites are gated; register state
updates and HuC6280 tone-mode decisions continue normally. `--keep-noise-midi`
is the explicit A/B escape hatch. `ConversionOptions.noiseWavPath` exposes the
same behavior through `convertVGMToMidi()`; explicitly setting
`suppressHardwareNoise: false` keeps the MIDI percussion there as well.

### YM2612 DAC sample triggers and atomic F-Number updates

Mega Drive music commonly uses YM2612 channel 6 in DAC mode for sampled drums.
Legacy VGM DAC streams place PCM bytes in data block type `$00`, set the read
position with command `$E0`, and use `$80-$8F` to output one byte plus a 0-15
sample wait. The parser now preserves `$E0` as `pcm_seek` and `$80-$8F` as
`pcm_write`; `vgm-playback.ts` counts and clips the wait embedded in
`pcm_write`, so duration targeting and loop expansion retain the original
sample timeline.

`MidiConverter` gates DAC triggers with YM2612 register `$2B` bit 7. A seek is
held pending until the next PCM write, then its byte offset becomes a stable
sample identity on a separate `YM2612 DAC Sample 0x...` GM percussion track.
Repeated seeks to the same offset retrigger that track; a new sample, DAC
disable, or end of conversion closes the previous note. The PCM bytes are not
decoded, so velocity is neutral and GM note numbers 35-81 identify samples
rather than classify their timbre. The *Green Hill Zone* regression source has
222 seeks resolving to six distinct sample-offset tracks.
This is deliberately a trigger heuristic: a source that uses `$E0` merely to
continue silence or resume the middle of a sample can produce an extra hit.

YM2612 tone frequency is split across `$A4-$A6` (block/F-Number MSB) and
`$A0-$A2` (LSB). YM2203 and both YM2608 ports use the same normal-channel
register pairs. Updating MIDI pitch after the first half combines it with stale
bits and can create phantom notes. `isOPNMultiByteFreqUpdate()` looks ahead
for the matching register on the same port/channel, tolerating up to 16 samples
of intervening wait or DAC output, and defers pitch conversion to the second
half. `hasPendingFrequencyUpdate` also remembers that first half so a pair that
changes only BLOCK (leaving F-Number unchanged) still updates the MIDI octave
when its second write arrives. This removes intermediate octave jumps while
preserving genuinely separated frequency writes.

### Added: `--dac-wav` — real YM2612 DAC/PCM audio instead of a placeholder GM note

Diagnosed against a real Mega Drive source (*OutRun*, "01 - Magical Sound
Shower.vgz"): the drum-heavy DAC channel resolves to a large number of
distinct `YM2612 DAC Sample 0x...` tracks — one per first-seen `$E0` seek
address (see the trigger heuristic above) — each carrying a fixed, arbitrary
GM percussion note. For a source with many real distinct samples (or with
mid-sample reseeks that the trigger heuristic can't distinguish from a new
sample), this is a lot of MIDI-editor clutter for something that was never
meant to convey pitch information in the first place: the note number only
ever identified *which* sample played, not what it actually sounded like.

`--dac-wav <file>` (plus `--keep-dac-midi` for the same A/B escape hatch
`--noise-wav`/`--keep-noise-midi` already provide) renders the *actual* DAC
audio to a separate 16-bit/44.1kHz/stereo WAV instead, and suppresses the
`YM2612 DAC Sample`/`YM2612 DAC Direct` MIDI tracks by default (gated by
`ConversionOptions.suppressYM2612Dac`, the same shape as
`suppressHardwareNoise`, checked in `handleYM2612DACWrite()` and
`handleYM2612DirectDACWrite()`).

Unlike SN76489/HuC6280 noise — an LFSR the renderer can resynthesize from
register state alone — the YM2612 DAC channel's stream mode (`$E0` seek +
`$80-8F` write) plays back real PCM sample *bytes* stored in the VGM's own
data blocks, which the parser previously discarded after skipping past them
(`this.skipBytes(size)`, keeping only the block's type tag). `VGMParser`
now captures every data block of type `0x00` (the YM2612 PCM bank; VGM data
blocks of the same type are one contiguous virtual address space,
concatenated in file order per the VGM spec) into `VGMData.ym2612PcmData`,
skipping every other block type unread exactly as before. `src/dac-renderer.ts`'s
`renderDacWav()` then replays `pcm_seek`/`pcm_write` against that captured
bank as a sample-and-hold DAC: each `pcm_write` reads the bank byte at the
current pointer (advancing it by one, matching real hardware's own
auto-incrementing read), and the direct one-byte-at-a-time path (register
`$2A`) uses the byte value the command itself already carries — no bank
lookup needed, since `$2A` writes the DAC latch directly. Both paths convert
each 8-bit unsigned PCM byte (`0x80` center) to a signed 16-bit sample via
`(byte - 128) * 256`; this is a plain linear expansion, not a resampling or
interpolation step — it reproduces the raw sample-and-hold waveform exactly
as the hardware would output it at the VGM's own sample rate.

One hardware nuance worth calling out because it is easy to get backwards:
`$2B` bit 7 does **not** gate whether the DAC latch itself updates — a `$2A`/
stream write always latches a new value regardless of that bit. It only
selects whether channel 6's *output* comes from the DAC latch or from FM
synthesis. `renderDacWav()` therefore keeps updating `pcmPointer`/
`currentLevel` unconditionally, and only gates the audible mix (and the
`voicesFound` bookkeeping that decides whether a stem file gets written at
all) behind the enabled flag. This matters for a driver that disables the
DAC briefly (e.g. to let a different channel use the shared bus) and
re-enables it without a fresh `$2A` write: real hardware resumes playing
whatever was last latched, and so does this renderer — verified by a
regression test that disables/re-enables mid-note with no intervening write
and confirms the same level resumes rather than falling silent.

`--dac-wav` deliberately never touches SegaPCM/C140 (arcade PCM chips,
covered by the sample-trigger conversion above) or YM2608 ADPCM-B (a
different, still-undecoded encoding) — this option is YM2612-DAC-specific,
matching `--noise-wav`'s own scope of exactly two chip families rather than
every percussion-capable chip this file converts.

**Verification**: real, non-mocked run against the OutRun source above with
both `-v` and `--dac-wav`: the resulting `.mid` contains zero `YM2612 DAC`
track-name occurrences (confirmed by grepping the raw MIDI bytes), while the
stem WAV is a valid 295.88-second file matching the song's own duration
exactly, with ~77% of its samples nonzero and full-scale peaks — audibly
real drum-hit audio, not silence or noise-floor artifacts.

### OPN channel 3 Special mode (per-operator frequency)

Diagnosed against a real Mega Drive source (*Super Hang-On*, "02 - Outride a
Crisis.vgz"): a listener reported the converted MIDI sounded wrong, and
analyzing the VGM command stream directly found register `$27` (Ch3
mode/timer control) written once with value `0x40`, followed by 2,294 writes
each to `$A8`/`$A9`/`$AA`/`$AC`/`$AD`/`$AE` — about 24% of the file's 57,700
total YM2612 writes. None of those six registers had a branch anywhere in
`handleYM2612Write()`; they fell through unhandled and were silently
discarded, so channel 3's pitch was derived only from the normal `$A2`/`$A6`
registers (meaningful only for operator 4 in this mode) for a source that
was actually driving four independently-pitched operators.

Register `$27` bits 7-6 select the channel 3 mode: `00`=Normal, `01`=Special,
`10`=Special+CSM, `11`=Special (any nonzero value enables per-operator
frequency; only bit 6 was confirmed as the operative bit, matching
`chip->mode_ch3 = (data & 0xc0) >> 6` plus `if (chip->mode_ch3)` gating
per-operator phase generation in
[Nuked-OPN2's `ym3438.c`](https://github.com/nukeykt/Nuked-OPN2/blob/master/ym3438.c),
a cycle-accurate YM3438/YM2612 emulator — the most authoritative available
reference short of the Yamaha datasheet itself). CSM (mode `10`, automatic
Timer-A-driven key-on for speech-formant synthesis) is scheduled from Timer A
in the VGM sample timeline. Each overflow is emitted through the same Ch3
Special path as a one-MIDI-tick pulse. Repeated overflows that quantize to one
MIDI tick are coalesced, because a MIDI file cannot represent the hardware's
instantaneous key-on/key-off pair faithfully.

In special mode, operators 1-3 read their own frequency/block from
`$A8-$AA` (LSB) and `$AC-$AE` (MSB/block) — the same bit layout as the
normal per-channel registers — while operator 4 continues using the normal
channel 3 `$A2`/`$A6` registers unchanged. The register-offset-to-operator
mapping is **not** sequential (offset 0,1,2 ≠ Op1,Op2,Op3): it's `$A8/$AC`→
Op3, `$A9/$AD`→Op1, `$AA/$AE`→Op2, cross-checked against both
[plutiedev.com's YM2612 register reference](https://www.plutiedev.com/ym2612-registers)
and Nuked-OPN2's `OPN2_PhaseGenerate()` slot switch (`fnum_3ch[1]`→Op1 at
slot 1, `fnum_3ch[0]`→Op3 at slot 7, `fnum_3ch[2]`→Op2 at slot 13). Getting
this backwards would still produce four differently-pitched voices — just
with two of them (Op2/Op3) pitched wrong — so the cross-check against a
second, independent, cycle-accurate-emulator-derived source mattered.
`OPN_CH3_SPECIAL_OPERATOR_BY_OFFSET` encodes this mapping for YM2203, YM2608,
and YM2612; all three chips use the same OPN slot ordering.

`opnCh3SpecialModes` and `opnCh3PercussionActiveKeys` are keyed per chip
instance. This preserves the existing single YM2612 state while isolating both
YM2203 and both YM2608 instances. A mode change closes the active MIDI
representation before flipping the flag — either the four default operator
views or the optional composite percussion voice — so notes cannot hang after
the register meaning changes.

One important correction to the first implementation: Special mode changes
the operators' **base frequencies only**. It does not bypass the selected FM
algorithm. Nuked-OPN2 still runs the same `OPN2_FMPrepare()` routing and
`OPN2_ChGenerate()` output accumulation after selecting per-operator phase
increments, and Furnace documents the same behavior (algorithm 7 gives four
carriers, algorithm 4 gives two 2-op stacks, and algorithms 0-3 retain one
carrier). Therefore four simple GM oscillators cannot reproduce the hardware
voice when modulators and carriers form one composite drum patch.

The default remains an editable operator-frequency view for backward
compatibility. `handleOPNCh3SpecialOperators()` exposes all four `$28` slot
bits as separate notes. Operators 1-3 use chip/instance-specific `_ch3sp_`
state, while operator 4 reuses the existing normal channel 3 state. Raw base
pitch is preserved with scale 1 and each operator TL supplies a velocity proxy.
This is useful when a source employs multiple carriers melodically, but it is
explicitly not a faithful rendering of the FM algorithm.

`--ch3-special-percussion` selects the composite alternative through
`ConversionOptions.opnCh3SpecialPercussion`; the old
`ym2612Ch3SpecialPercussion` property remains as a deprecated API alias.
`handleOPNCh3SpecialPercussion()` emits one channel-10 attack when any
previously-off slot is keyed, closes it when all slots turn off, and ignores
in-note F-Number movement rather than manufacturing new drum attacks. It uses
`OPN_OPERATOR_PATHS` plus the key mask/TL values to find audible carriers, then
classifies their median **base** MIDI note into Bass Drum (≤48), Snare (49-64),
six Tom bands (65-87), Crash Cymbal (88-107), or Closed Hi-Hat (≥108).
`opnCarrierVelocity()` supplies the composite velocity. These thresholds are a
portable GM heuristic, not FM timbre resynthesis; unusual melodic patches can
be misclassified, which is why the mode is opt-in.

YM2612's three default sub-voice tracks claim MIDI channels 11-13
(`midiChannelForKey()`), while YM2203/YM2608 Special Op1-3 use 14-16. Dual
YM2203/YM2608 instances necessarily reuse 14-16 because the ordinary tracks
already consume the 16-channel MIDI budget; track identity remains separate,
and percussion-collapse mode avoids that collision for drum-driven sources.
Cross-family VGMs can still collide in the same way as the existing HuC6280
channel wrap. Normal YM2612 channels 1-5 use MIDI 5-9; channel 6 uses MIDI 14
instead of the upstream channel 10 assignment, so melodic FM does not collide
with General MIDI percussion.

**Verification**: the default conversion of *Outride a Crisis* still exposes
four 815-note operator views. With `--ch3-special-percussion`, they collapse to
786 actual composite hardware attacks: GM Bass Drum 269, Snare 211, Closed
Hi-Hat 170, Crash Cymbal 71, and 65 tuned-Tom attacks. The 29-note difference
is deliberate: they were large in-note pitch changes that the editable view
had to retrigger, not new `$28` hardware attacks. The final file contains no
`YM2612 Ch3 Special Op1`/`Op2`/`Op3` tracks, and melodic `YM2612 FM 5` is on
MIDI channel 14 rather than percussion channel 10.

Synthetic command-stream regressions cover YM2203 and YM2608 default four-note
output, optional percussion collapse, mode-switch cleanup, active-note retuning
after a YM2203 prescaler change, and isolation between dual YM2608 instances.
No real YM2203/YM2608 Ch3 Special VGM was available in the local corpus during
this implementation, so those paths are verified at the register-command level.

### Added: YM2413 (OPLL) FM and rhythm conversion

Upstream's parser recorded VGM command `0x51 aa dd` as a `YM2413` `chip_write`
(`vgm-parser.ts`), and `cli.ts` detected and printed the chip's clock when
present, but `MidiConverter.convert()` had no `else if (cmd.chip ===
'YM2413')` branch — every YM2413 write was silently discarded and the output
had zero notes from that chip. This is the same class of "advertised but
actually unconverted" defect the fork's other additions fixed (YM2151,
YM2203, YM2608), just not caught until this pass, since no regression test
exercised a YM2413-only source.

The YM2413 (OPLL) register map was confirmed against Mitsutaka Okazaki's
[emu2413](https://github.com/digital-sound-antiques/emu2413) — a widely-used,
well-regarded OPLL emulator — because smspower.org's own YM2413 documentation
pages returned HTTP 403 during this research. `OPLL_writeReg()`'s register
switch and `update_key_status()`'s `$0E` key-bit handling are the two
functions this port's design was checked against.

- `$10-$18`: F-Number LSB (8 bits) for channels 0-8.
- `$20-$28`: bit0 = F-Number MSB (9th bit), bits1-3 = block, bit4 = key-on,
  bit5 = sustain (not modeled — no chip in this file currently distinguishes
  EG sustain/release shape). `handleYM2413KeyAndFrequencyWrite()` mirrors
  the OPN handlers' pattern of combining LSB/MSB into one `state.frequency`
  and gating pitch updates through `isOPNMultiByteFreqUpdate()` so a
  `$10`/`$20` pair doesn't briefly read a stale half — but only for pitch
  *changes on an already-keyed channel*. A driver that writes `$20` (which
  also carries key-on) before `$10` has already reached the note-on branch,
  which is unguarded, since OPLL drivers conventionally write `$10` (pitch)
  before `$20` (pitch + key-on) — the reverse order is not currently
  protected against a one-write-early key-on reading a stale/zero LSB.
- `$30-$38`: upper nibble is normally the instrument number (not modeled —
  every YM2413 melodic track uses the same shared square-lead GM Program as
  every other chip in this file, per the existing "Stable GM Program
  fallback" design choice below), lower nibble is a 4-bit volume (0=loudest,
  15=quietest). `ym2413Velocity()` maps it linearly to a 1-100 MIDI
  velocity — no authoritative dB/step figure was available for this
  register (unlike YM2612's well-documented 0.75dB/step Total Level), so
  this deliberately uses the same plain linear mapping as SN76489's 4-bit
  attenuation register rather than asserting a precision this chip's level
  curve doesn't have.
- Frequency: `freq = fnum * clock / (72 * 2^(19-block))`, derived from
  emu2413's `calc_phase()` with vibrato disabled and Multiple=1 (the
  carrier's implicit reference rate) — `phase_step = (fnum*2*ml_table[ML]) <<
  block >> 2` reduces to `fnum << block` when `ml_table[1] == 2`, over a
  19-bit phase accumulator at an output rate of `clock/72`. Per-operator
  Multiple (which the chip's fixed/custom instrument patches use to scale
  pitch per voice, the same idea as OPN's algorithm-aware octave correction
  above) is not modeled — only the raw frequency registers are converted.

**Rhythm mode** (register `$0E` bit 5) repurposes channels 6-8's six FM
operators as five independent percussion voices instead of three melodic
channels: channel 6's modulator+carrier together form Bass Drum, channel 7's
modulator is Hi-Hat and carrier is Snare Drum, channel 8's modulator is
Tom-Tom and carrier is Top Cymbal (`$0E` bit4=BD, bit3=SD, bit2=TOM, bit1=CYM,
bit0=HH — confirmed against emu2413's `update_key_status()`). Each voice maps
to a fixed GM percussion note (`YM2413_RHYTHM_NOTES`); the source pitch
registers for channels 6-8 are read but not used for rhythm voices, the same
simplification YM2608's own built-in rhythm section already makes for this
file. Volume for the five voices comes from `$36`'s low nibble (BD) and
`$37`/`$38`'s high/low nibbles (HH/SD and TOM/CYM respectively) — `$37`/`$38`'s
high nibble is normally the instrument number, and is repurposed as HH/TOM
volume only while rhythm mode is active (confirmed against emu2413's
`OPLL_writeReg()` `$30-$38` case, which branches on `reg[0x0e] & 32`).

`ym2413RhythmMode` tracks the current mode; `handleYM2413RhythmModeWrite()`
closes any of channels 6-8's melodic voice or the five rhythm voices that are
active before flipping the flag, mirroring the same principle already used
for YM2612 channel 3 special mode and HuC6280's tone/noise switch above —
otherwise a note whose register meaning just changed out from under it could
go silent without a Note Off, or keep sounding at a stale pitch. While rhythm
mode is active, channels 6-8's own `$20+ch` key-on bit is deliberately
ignored (only the `$0E` rhythm bits trigger those voices) — real hardware
actually ORs both key-on sources together (confirmed in emu2413's
`update_key_status()`: the per-channel loop that sets `new_slot_key_status`
from `$20+ch` bit4 runs unconditionally, before the rhythm-mode-only bits are
ORed in on top), but no driver in practice writes both simultaneously for the
same channel, and modeling the OR would mean two independent key sources
racing to control the same MIDI note — the same kind of channel-budget
tradeoff already accepted for HuC6280's MIDI-channel wrapping.

MIDI channels 5-9 then 11-14 (skipping percussion channel 10) are used for
the 9 melodic channels (`midiChannelForKey()`), chosen to avoid colliding
with SN76489's channels 1-4 — YM2413 commonly pairs with SN76489 as the Sega
Master System's FM Sound Unit, unlike this file's other FM chips, which are
never realistically paired with a second FM/PSG chip active on the same
source. Channel 10 is used for all five rhythm voices regardless, the same
as every other percussion track in this file.

### Added: Game Boy DMG (LR35902 APU) conversion

Added at the user's request as a follow-up to the YM2413 fix, to broaden VGM
chip coverage beyond the Sega/PC-88/arcade-focused set this fork already
handled. Unlike YM2413, this chip had no existing upstream scaffolding at
all — no parser command, no header clock field, no converter branch — so
this is a from-scratch addition rather than a "silently discarded" bug fix.

VGM command `$B3 aa dd` writes register `aa` (numbered from GameBoy address
`$FF10`, i.e. register 0 = NR10) with value `dd`; header offset `$80` (32
bits, VGM 1.61+) holds the input clock, typically 4194304 Hz. Both confirmed
against the VGM specification (`vgmspec171.txt`). The register map and
frequency formulas were confirmed against
[Pan Docs](https://gbdev.io/pandocs/Audio_Registers.html) — the primary Game
Boy hardware reference — fetched via a mirror (`bgb.bircd.org/pandocs.htm`)
since gbdev.io itself returned HTTP 403 during this research.

The four channels (two pulse, one wave, one noise) use a **trigger** model
unlike every other chip in this file: writing bit7=1 to a channel's NRx4
register restarts it from its current frequency/envelope/DAC state, and
there is no direct "note off" register. Real hardware only stops a voice via
its length counter expiring (if length is enabled) or software explicitly
clearing the channel's DAC. `handleGBDMGTriggerWrite()` treats a trigger
while the DAC is enabled as a retrigger (closing any note already sounding
first, the same "hardware always restarts on write" pattern already used for
e.g. YM2608 rhythm and SegaPCM/C140 in this file) and a trigger while the
DAC is disabled as producing no sound. A voice is otherwise treated as still
sounding until an explicit DAC-off write, a new trigger, or the whole APU
powering off (`NR52` bit7=0, `handleGBDMGMasterControlWrite()`) — the same
"ends at the next explicit event" heuristic this file already uses for
YM2612 DAC sample triggers, rather than attempting to track the actual
256Hz-frame-sequencer length-counter timing.

Deliberately not modeled, consistent with this file's existing precedent of
omitting other chips' LFO/vibrato/envelope-shape/sweep controls:

- **Channel 1's frequency sweep (`NR10`)**: hardware recomputes the
  frequency register internally without writing the new value back to a
  VGM-visible register, so there is nothing in the log to read a swept pitch
  from. Only the pre-sweep trigger frequency is converted.
- **Length counters** (the length fields in `NR11`/`NR21`/`NR31`/`NR41`, and
  the length-enable bit in every `NRx4`): would auto-silence a voice partway
  through if enabled, but tracking them requires modeling the frame
  sequencer against the VGM sample timeline. Most music drivers rely on an
  explicit DAC-off or retrigger rather than length expiry for musical
  note-offs, so — like YM2413's own length fields — this is judged a
  reasonable simplification rather than a silent-failure-class bug.
- **Envelope volume sweep** (the pace field in `NRx2`): only the initial
  volume is read, at trigger time (`gbDmgEnvelopeVelocity()`, mirroring the
  OPN chips' opnActiveVelocity latch-at-key-on pattern); the hardware's own
  automatic ramp afterward is not replayed.
- **Wave RAM contents** (`$FF30-$FF3F` / VGM register `$20-$2F`): timbre
  data, not pitch/volume: ignored per this file's "every melodic track uses
  the shared square-lead GM Program" convention (see "Stable GM Program
  fallback" above).
- **`NR51`/`NR50`** (per-channel stereo routing / master volume): panning
  and mixing, the same category of control already left unmodeled for every
  other chip in this file (see HuC6280's `$01`/`$05` above).

Frequency: the pulse channels' 11-bit period register `x` gives
`freq = clock/(32*(2048-x))` (Pan Docs: "131072/(2048-x)" at the fixed
4194304Hz reference clock; 131072 = 4194304/32 — generalized here to an
explicit clock parameter). The wave channel shares the same period/trigger
register shape but divides by 64 instead of 32 (it steps through all 32
4-bit wave-RAM samples per period instead of one square edge, doubling the
reference rate: Pan Docs' "65536/(2048-x)", 65536 = 4194304/64) — so the
wave channel sounds one octave lower than the pulse channels at the same raw
period value. The noise channel's `NR43` packs a 4-bit shift `s` and 3-bit
divisor code `r` (r=0 means divisor 0.5): `freq = clock/(8*divisor*2^(s+1))`
(Pan Docs: "524288/r/2^(s+1)", 524288 = 4194304/8).

The DAC-enabled gate differs by channel type: channels 1/2/4 (pulse/noise)
read it from their envelope register's upper 5 bits (`gbDmgEnvelopeDacEnabled()`
— all-zero means DAC off, confirmed against Pan Docs), while the wave
channel (3) has its own dedicated `NR30` bit7 (`isEnabled`, since it has no
envelope of its own — `NR32` instead selects a fixed 0/100/50/25% output
level, read by `gbDmgWaveVelocity()`).

The noise channel maps `NR43` to a GM drum band through the same shared
`noiseDrumNote()` helper every other chip's hardware noise uses, but departs
from HuC6280/YM2151's normalization: those chips' raw noise-rate registers
already map roughly linearly to perceived rate, so they normalize the raw
register value directly, while `NR43`'s shift/divisor combination does not
— `gbDmgNoiseNoteForPeriod()` instead computes the actual Hz value (the same
approach SN76489's noise handling uses) and log-scale-normalizes it against
an approximate audible clamp range before calling `noiseDrumNote()`. An
already-sounding noise voice is re-evaluated on every `NR43` write and only
retriggers if the mapped drum note actually changed, matching the
rate-re-evaluation pattern already used for SN76489/AY-SSG/HuC6280/YM2151.
Width mode (`NR43` bit3, 15-bit vs. 7-bit LFSR — a timbre distinction, not a
rate one) is intentionally not mapped to a different drum note, consistent
with how every other chip's noise-mode/LFSR-width control is collapsed to
one portable GM voice in this file (see "Hardware-noise conversion" above).

MIDI channels 1-3 (`gbdmg_0`/`gbdmg_1`/`gbdmg_2` → `midiChannelForKey()`)
are used for the three melodic voices; the noise channel's key
(`gbdmg_noise_0`, deliberately using the `_noise_` infix so
`isPercussionKey()` routes it automatically) uses GM percussion channel 10
like every other chip's noise track in this file. A real Game Boy VGM never
pairs with a second sound chip, so there is no cross-chip MIDI-channel
collision concern here (unlike YM2413's channel assignment above, which
specifically avoids SN76489's 1-4 because that pairing is common).

**Verification**: hand-built VGM command sequences (not a real Game Boy VGM
source, unlike this file's other fixes — no such source was available during
this pass) confirmed a pulse-channel trigger converts to the expected MIDI
note (period 1750 at 4194304Hz → ~442Hz → MIDI note 69/A4), that DAC-off
immediately closes an active note, that a trigger while the DAC is disabled
produces no note, that the wave channel sounds one octave lower than the
pulse channels at the same period value, that the noise channel retriggers
across a drum-band change, and that `NR52` power-off silences every channel.

### Added: OPL family (YM3526/YM3812/Y8950) FM and rhythm conversion

VGM commands `$5A/$5B/$5C` and `$AA/$AB/$AC` now share one OPL converter for
the primary and second YM3812, YM3526, and Y8950 instances. The named header
clocks at `$50/$54/$58` feed diagnostics, verbose chip detection, and the OPL
frequency formula instead of using the diagnostic-only `chipClocks` map.
The register behavior was checked against the pinned libvgm/MAME `fmopl.c`
core: `slot_array` at lines 283-290, the multiplier table at 463-467, the
key-transition guard at 1302-1312, frequency setup around 1241/1258/1646,
and rhythm key routing at 1566-1611.

- `$20-$35`: the low MULTIPLE nibble is retained for octave-only pitch
  correction; AM, vibrato, EGT, and KSR are timbre/envelope controls and are
  not represented in MIDI.
- `$40-$55`: the six-bit Total Level controls note-on velocity and active-note
  CC11. KSL is not modeled.
- `$A0-$A8` plus `$B0-$B8`: ten-bit F-Number, three-bit block, and bit-5
  key state produce melodic notes. `Hz = fnum * clock / (72 * 2^(20-block))`.
- `$C0-$C8` bit 0 selects serial FM or additive carrier routing. Feedback is
  timbre-only. Waveform selection, envelope rates, and global AM/vibrato
  depth are also omitted.
- `$BD` bit 5 enables rhythm and bits 4..0 gate BD, SD, TOM, TC, and HH.
  The five key bits are identical to OPLL/YM2413, so both implementations use
  the same GM notes and transition-only percussion behavior.

OPL `$Bx` combines pitch and key state, so a write with bit 5 already high is
not a new attack. `oplKeyOn` follows the hardware key latch independently of
MIDI active-note state, and only a 0-to-1 transition calls `commitOPLKeyOn()`.
Repeated in-key F-Number/block changes use the shared ±96-semitone pitch-bend
path. `isOPNMultiByteFreqUpdate()` coalesces both ordinary `$Ax`-then-`$Bx`
and reverse `$Bx`-then-`$Ax` ordering; `oplPendingKeyOn` delays only the latter
until its low byte arrives.

The OPN carrier traversal is parameterized as `fmPitchScale()`,
`fmCarrierVelocity()`, and `fmCarrierExpression()`. Existing OPN callers pass
the unchanged four-operator path table, silent TL `$7F`, and doubled
MULTIPLE values. OPL callers pass its two CNT paths, silent TL `$3F`, and the
hardware table where register 10/11 = 10, 12/13 = 12, and 14/15 = 15. This
keeps the OPN behavior byte-for-byte while allowing OPL's six-bit TL and
different multiplier table. Pitch correction remains limited to an explicitly
written common power-of-two factor.

Rhythm mode maps BD/HH/SD/TOM/TC to GM notes 36/42/38/45/49 on MIDI channel
10. BD uses channel 6's carrier TL; the remaining voices use channel 7/8's
individual modulator/carrier slots. Entering or leaving the mode closes all
channel 6-8 melodic and rhythm notes before changing interpretation. While
active, `$B6-$B8` key bits are latched but do not trigger melody; real hardware
ORs the melodic and rhythm key sources, but modeling two owners for one MIDI
note would make note-off ordering ambiguous, matching the existing YM2413
tradeoff.

Primary OPL FM channels use MIDI 1-9. Instance two starts at 11-16 and wraps
to 1-3 (`((10 + channel) % 16) + 1`), following HuC6280's established channel
budget tradeoff; rhythm always uses channel 10. Cross-family collisions remain
visible through descriptor overlap warnings and `--split-chips` sidecars.

YMF262/OPL3 remains outside this implementation because its second bank,
18-channel layout, four-operator modes, and stereo routing require a separate
model. Y8950 Delta-T ADPCM registers `$07`, `$09-$12`, and `$15-$17` stay as
`unsupported_write`; shared `$08` and GPIO/keyboard registers remain ordinary
OPL writes. The exclusion lives in the parser, not the converter, so an
ADPCM-bearing file continues to report partial content and fail `--strict`
instead of being mislabeled as fully converted.

### YM2151/YM2203/YM2608/OPL key-on-bounded FM pitch

YM2151, YM2203, YM2608, and OPL games commonly rewrite pitch every frame for software
pitch envelopes and arpeggios while leaving the channel keyed on. Treating every
change larger than the shared 0.8-semitone threshold as a new MIDI note expands
one hardware attack into many short notes. Their FM tracks therefore use only
the chip's key-register transitions (`$08` for YM2151, `$28` for OPN/OPNA) as
note boundaries. `updateKeyBoundFMPitch()` sends active YM2151 key-code/key-fraction
changes and OPN/OPNA F-Number or prescaler changes through pitch bend instead of
the shared retrigger heuristic.

Each YM2151/YM2203/YM2608/OPL FM track selects RPN 0,0 and sets pitch-bend sensitivity
to ±96 semitones before its first note. This range covers the observed 68-semitone
within-key excursion in the real *To Make The End of Battle* OPN regression source
and the rapid wide KC/KF sweeps in the real *Submerged City (Stage 1)* YM2151
regression source. `addPitchBend()` clamps only values beyond the declared range.
Keep this path limited to those key-bounded FM families: YM2612, SSG, PSG, and HuC6280
continue to use their existing note/pitch policies. `midi-writer-js` controller
events take 1-based channels, while its pitch-bend event still takes a 0-based channel.

Every melodic `noteOn()` rounds to a legal MIDI note number, then emits an
initial bend equal to `frequencyToExactMidi(freq) - midiNote` using the same
per-track bend range as later pitch updates. Do not reset new notes to bend
center: doing so reintroduces up to ±50 cents of static pitch error.

### OPN algorithm-aware octave correction

Raw channel F-Number is not always the pitch heard from a YM2203/YM2608/YM2612 voice. Games
can program every operator in an audible algorithm path with a shared multiplier
such as 2 or 4, making the complete waveform one or two octaves higher than the
raw channel frequency. `MidiConverter` tracks algorithm registers `$B0-$B2`,
DT/MULTI registers `$30-$3F`, total-level registers `$40-$4F`, and the operator
mask in key-on register `$28`. Register slots are reordered to logical O1-O4
before the eight OPN algorithm paths are evaluated.

`opnPitchScale()` collects only keyed, non-max-TL operators that reach an
audible carrier. It applies a correction only when every selected multiplier
was explicitly written and their common multiplier is an unambiguous power of
two. This includes 0.5x when the common doubled-multiplier GCD is 1; previously
that case retained the raw F-Number and made affected tracks one octave too
high. Unknown/unwritten multipliers and ratios without a shared power-of-two
factor retain the raw F-Number, avoiding a precise perceived-fundamental claim
for ambiguous FM spectra.

The selected scale is latched in `opnActivePitchScale` at key-on and remains
fixed until key-off. Mega Drive drivers often program the next patch just before
turning off the previous note; reacting immediately to those writes creates a
sub-millisecond octave transient and an extra MIDI note. F-Number changes during
the note continue to use the latched scale. YM2203/YM2608/YM2612 header clock flags are
masked before frequency calculation, matching the existing YM2151 handling.

### Pitch-clock and chip-variant correctness

Clock fields may contain chip-type or dual-chip flags in bits 30-31. All
frequency paths mask those bits; verbose output displays the masked rate and a
dual-chip suffix. VGM 1.00/1.01 reused the YM2413 clock field for YM2612 or
YM2151, so `VGMParser` copies that legacy value into both candidate clock fields
and the command stream determines which chip is actually active.

VGM 1.51's SN76489 flags are retained in `VGMHeader`: bit 0 maps tone period 0
to `0x400`, while bit 3 disables the usual `/8` input divider and changes the
tone divisor from 32 to 4. AY-compatible flag bit 4 applies the YM2149 pin-26
additional `/2` clock divider to standalone AY8910 and integrated YM2203/YM2608
SSG frequency calculations. AY/SSG period 0 remains non-note-producing because
its real period-1 equivalent is ultrasonic at normal clocks; clamping it to MIDI
note 127 would create a false audible high note.

For VGM commands `$A0` (AY8910) and `$B9` (HuC6280), register-byte bit 7 selects
the second chip. The parser moves it into `VGMCommand.instance` and clears it
from the register number. Converter state, selected HuC6280 channel, track name,
and MIDI-channel assignment are independent per instance.

### SegaPCM and C140 sample-trigger conversion

Many arcade VGMs pair YM2151 with a separate PCM chip for drums. Treat these as
independent chip families rather than trying to infer percussion from YM2151
FM notes:

- VGM header `$38` / command `$C0` describe SegaPCM. Every enabled write to a
  voice control register (`$86 + voice*8`, bit 0 clear) is a retrigger, even if
  the previous control value was already enabled. *Passing Breeze* depends on
  this repeated-write behavior for 3,955 of its 3,961 PCM attacks.
- VGM header `$A8` / command `$D4` describe C140. Each voice has 16 registers;
  mode register offset 5 uses bit 7 for key-on. Bit 6 retriggers only while the
  voice is already active, matching MAME's C140 behavior.
- SegaPCM sample identity combines control-bank bits with the current-address
  registers. C140 identity combines bank and sample-start registers. Each
  first-seen identity receives the next GM percussion note from 35 through 81
  and gets its own named track on MIDI channel 10. After 47 identities the note
  range wraps, so the sample ID in the track name remains the authoritative
  distinction.
- PCM ROM data blocks are intentionally skipped after preserving their command
  boundaries. The converter does not decode audio, determine sample duration,
  or classify kick/snare/hat timbre; MIDI note numbers are stable identity
  labels within the file, not semantic GM instrument claims.

`segaPCMActiveVoices` and `c140ActiveVoices` associate each hardware voice with
its currently sounding sample track and note, so overlapping voices that use
the same sample still receive balanced Note On/Off pairs. Retriggers stop the
prior voice note first, permitting a voice to switch sample identities cleanly.

Two real files exposed a second independent defect: unsupported VGM commands
were not skipped according to their specified operand lengths. In particular,
`0x30-0x3F` was advanced by two operands instead of one and `0xC0-0xFF` was not
advanced at all. Operand bytes then became fake commands, an incidental `0x66`
could terminate parsing early, and later YM2151 writes were lost. Keep
`getUnsupportedCommandOperandCount()` aligned with the VGM specification's
command families. It covers dual-chip/reserved writes, PCM RAM writes, DAC
stream control, 3-byte-address writes, and 4-byte-address writes. Truly unknown
commands now fail with their byte offset instead of silently desynchronizing.

Header reads also honor the VGM rule that fields overlapping a data stream that
begins before offset `0x100` are zero. Without this, a v1.51 file beginning at
`0x40` could report arbitrary command bytes at `0x74` as a phantom AY8910 clock.
Finally, `exportToFile()` throws before writing if conversion produced no
tracks, preventing any future unsupported-chip path from reporting a 14-byte
file as a successful conversion.

### Critical fix: `PitchBendEvent`'s `channel` field is 0-based, not 1-based

This was found and fixed *after* the HuC6280 support above, while
debugging a report that GarageBand only showed 3 of the 6 expected tracks
for a converted OutRun (TG-16) file — and is unrelated to any HuC6280-
specific logic; it affects every chip this tool converts.

`midi-writer-js`'s `NoteOnEvent`, `NoteOffEvent`, and `ControllerChangeEvent`
all accept a 1-based `channel` (1–16) and subtract 1 internally before
building the status byte. `PitchBendEvent` does not — it ORs the raw
`channel` field directly into `0xE0` with no such conversion, so it
expects a 0-based channel (0–15). `noteOn()` and `updateNotePitch()` were
passing the same 1-based `midiCh` used for the other event types straight
into `PitchBendEvent`, which was off by one for every chip's pitch bends —
but for `midiCh === 16` (HuC6280 channels 2/5 as `huc6280MidiChannel()`
assigns them) it did more than shift the target channel: `0xE0 | 16`
overflows the status byte's low nibble into its high nibble, producing
`0xF0` — the *System Exclusive* start byte, not a Pitch Bend event. A
reader that doesn't special-case that malformed SysEx block (GarageBand
doesn't) loses sync with the rest of the track from that point on, which
is why only tracks *before* the first `channel === 16` pitch bend
survived import — `HuC6280 PSG 0`/`1`/`2` displayed, `3`/`4`/`5` silently
vanished, matching the exact report that led to this fix. Both call sites
now pass `channel: midiCh - 1` to `PitchBendEvent`, with a comment at each
explaining why it differs from the neighboring `NoteOnEvent`/
`ControllerChangeEvent`/`NoteOffEvent` calls that keep `midiCh` unchanged.

**Verification**: after the fix, all 6 tracks of the same file parse
cleanly with no `0xF0`/`0xF7` bytes appearing outside intentional SysEx
use (there is none), and every track uses a distinct MIDI channel with no
byte-stream desync. The previously-corrupted `HuC6280 PSG 2` track (channel
16) recovered its note count from 29 (truncated read) to a count in line
with the other melodic channels.

### Added: GM Program Change so every track gets an explicit instrument

Found while looking at the fixed file in GarageBand: with no Program Change
events anywhere in the output, GarageBand (and presumably other DAWs) fell
back to assigning each imported track a random default instrument rather
than a consistent one. None of the chips this tool converts map cleanly
onto a General MIDI instrument, but their tone generators are all
pulse/square-wave-like, so `getTrack()` now sends one `ProgramChangeEvent`
per track — GM program 81 "Lead 1 (square)" (`GM_PROGRAM_LEAD_1_SQUARE`,
byte value 80) — right after the track name, before any notes. Like
`PitchBendEvent`, `midi-writer-js`'s `ProgramChangeEvent` takes a 0-based
channel with no internal `-1`, so this call also needed the `- 1`
adjustment.

This also prompted extracting `midiChannelForKey()` as the single source
of truth for the chip-channel-key -> 1-based MIDI channel mapping that had
previously been duplicated inline in `noteOn()`, `noteOff()`,
`updateNotePitch()`, `handlePSGWrite()`'s expression-CC branch, and
`handleHuC6280Write()`'s expression-CC branch — `getTrack()` needs that
same mapping to pick a Program Change channel before any of those
functions have run, and keeping five copies of the same `if/else if`
chain in sync was already how the `PitchBendEvent` bug above went
unnoticed for as long as it did.

### Added: physical VGM loop expansion and duration targeting

VGM header offset `$1C` is a relative pointer whose absolute command-stream
position is `value + $1C`. `VGMParser` exposes that normalized position as
`loopDataOffset` and records `loopCommandIndex` only when the pointer lands on
an actual VGM command boundary. Unsupported commands remain absent from the
semantic command array, but a loop beginning on one still maps to the next
semantic command index because the boundary is observed before its operands
are skipped.

`prepareVGMPlayback()` runs between parsing and conversion. It removes the
source end command, keeps commands before `loopCommandIndex` as a one-time
intro, repeats the remaining loop body, and appends one final end command.
`--loops N` means N total loop-body passes, including the one already present
in the logged source, so the default and `--loops 1` are backward-compatible.
`--duration SEC` converts seconds to the 44.1 kHz VGM sample timeline, repeats
the loop body as needed, and shortens the last wait command to end on the exact
target sample. Chip state is intentionally not reset between passes; the MIDI
converter receives one continuous expanded command stream.

Append expanded commands iteratively. Do not use `array.push(...commands)`:
real files can contain hundreds of thousands of parsed commands (the test
*Submerged City* file has about 360,000), exceeding JavaScript's function
argument limit before conversion begins.

The two options are mutually exclusive. A loopless VGM may be shortened by
duration, but extending it or requesting more than one loop pass fails rather
than restarting the whole song or padding silence. A declared loop pointer
that does not align with a parsed command boundary also fails when repetition
is required.

### Incidental fix: VGM version display

While tracing this bug, `cli.ts`'s verbose-mode `VGM Version:` line was
found to divide the raw BCD version field by `0x100` (e.g. `0x00000161`
→ `353/256` → printed as `"1.38"`), rather than reading it as BCD
(`"1.61"`). This is cosmetic only — the parser's own version comparisons
(`version >= 0x0151`, etc.) already worked correctly because BCD digits
happen to sort the same way as the hex literals compared against them —
but it was actively misleading while debugging (a real `v1.61` file
reporting itself as `v1.38`), so it was fixed alongside the HuC6280 work.

## Relationship to the global `npm install -g vgm2midi`

If `vgm2midi` was installed globally via `npm install -g vgm2midi`, that
install is the *unpatched* upstream package and can reproduce the
14-byte-output bug on HuC6280 and YM2151 sources and predates YM2203 support. To make the global `vgm2midi`
command resolve to this patched fork instead, run `npm link` from this
directory (registers a symlink from the global `node_modules/vgm2midi` to
this checkout) — but do this deliberately, not as a side effect of
unrelated work, since it rewrites global npm state outside this
repository. Alternatively, invoke this fork directly without touching the
global install: `node vgm2midi/dist/cli.js <input> [options]` from the
project root.

## Build

```
cd vgm2midi
npm install
npm run build   # tsc -> dist/*.js
```

`dist/` is committed (prebuilt, matching `nsf2midi`/`spc2midi`'s
convention of a committed build artifact), so most users don't need to
rebuild — only do so after editing `src/`.

## Testing

Run the build and Node test suite together:

```
npm test
```

## Native stems and read-only corpus audits

Build and verify the pinned libvgm stem helper with:

```
npm run verify:native-stems
```

`scripts/build-native.sh` pins libvgm to `57585ea`. Its mutable source, cache,
and build directories default to `/tmp/vgm2midi-libvgm`, its `source` child,
and `/tmp/vgm2midi-native-build`; they must stay outside this checkout (a
macOS reboot clears `/tmp`, which is why the finished binary — not the
mutable state — gets copied out, see below). Set `VGM2MIDI_NATIVE_CACHE`,
`VGM2MIDI_LIBVGM_SOURCE`, or `VGM2MIDI_NATIVE_BUILD` to choose other external
locations. A locally cached pin is checked out without fetching.
`VGM2MIDI_NATIVE_OFFLINE=1` is useful in CI: it fails before any git action
when the source cache is absent, and fails without fetching when a cached
checkout lacks the pin. Native manifest strings must JSON-escape quotes,
backslashes, and controls while passing UTF-8 bytes through unchanged;
`verify:native-stems` checks this with quote/backslash paths.

After a successful build, the script copies only the finished
`vgm2midi_stems` binary into `native/bin/` inside this checkout. The arm64
binary is committed so Apple Silicon users can render stems from a fresh clone
without fetching or building libvgm. `renderLibvgmStems()` (`src/stems.ts`) resolves the helper from
the `VGM2MIDI_STEMS_HELPER` env var, or else `native/bin/vgm2midi_stems`
next to the installed package. This means a `/tmp`-clearing reboot no longer
requires re-running `build-native.sh` before the next `--stems` run, as long
as `native/bin/` was already populated.

Audit a mounted, immutable corpus with:

```
VGM2MIDI_CORPUS_ROOT=/path VGM2MIDI_EXPECTED_SONGS=133 npm run audit:corpus
```

The audit calls `VGMParser.fromBuffer()` for direct VGM/VGZ files and ZIP
entries, then runs `prepareVGMPlayback()` and MIDI conversion only in memory.
It must not extract entries, write into the corpus, or hide parse errors.
`unzip` is the only archive dependency and supports ZIP; 7z/RAR containers are
reported as uninspected archives rather than modified or silently treated as
songs.

The regression tests cover unsupported-command boundary preservation, early
header overlap, YM2151 note generation, YM2203 header/primary/dual-command parsing,
YM2203 FM key-on-bounded pitch bends, SSG pitch, prescaler, noise and repeated-key behavior,
YM2608 header/port/dual-command parsing, six-channel FM key-on-bounded pitch,
integrated SSG tone/noise, semantic rhythm retriggers, and ADPCM-B trigger identity/reset,
YM2612 algorithm-aware octave correction,
YM2612 channel 3 special mode (independent per-operator notes, mid-note mode-switch
cleanup, and normal-mode behavior left unchanged when special mode is off),
YM2413 melodic FM conversion, split F-Number write protection, rhythm mode
(independent five-voice key-on/off, volume-as-expression, and mid-note
mode-switch cleanup mirroring YM2612 channel 3 special mode's own coverage),
Game Boy DMG pulse/wave/noise trigger conversion (envelope/DAC-derived
velocity and note-off, wave-channel output level, noise rate re-evaluation,
split frequency write protection, and NR52 power-off silencing all channels),
refusal to write an empty MIDI,
HuC6280 silent-volume filtering, noise-to-percussion conversion for YM2151,
SN76489, YM2203/YM2608 SSG, AY-3-8910, and HuC6280, plus YM2612 DAC, YM2608
rhythm/ADPCM-B, and SegaPCM/C140 command and
sample-trigger conversion. Loop regressions cover relative-offset resolution, keeping
the intro once, repeating only the loop body, exact final-wait clipping, and
rejection of impossible loopless extension. The HuC6280 regression also verifies
that a three-step active-noise volume rise stays expression-only while a later
twenty-step envelope reset retriggers the percussion note. Also covered: the
SSG split-period-write guard, `--duration` truncation preserving a zero-wait
`pcm_write`, and SN76489 header clock flag masking (all three below). Further
covered (see "Added: reproduction-fidelity pass" below): OPN carrier-TL
velocity and the YM2612 velocity-40 regression it fixes, YM2612 `$2A` direct
DAC grouping and its EOF/`$2B`-disable close-time regressions, noise-frequency
GM drum mapping and cross-channel re-evaluation for SN76489/AY-SSG/HuC6280/
YM2151, stable square-lead Program Change across melodic chips, and SegaPCM/C140 shared-channel
pan resend on retrigger. Also covered (see "Added: `--dac-wav`" above): the
parser's data-block-type-0x00 PCM bank capture and multi-block concatenation,
`renderDacWav()`'s stream-mode bank reads, direct-mode (`$2A`) byte-carried
writes, DAC-disabled muting, the resume-last-latched-level behavior across a
disable/re-enable with no intervening write, silent handling of an
out-of-range seek, and `suppressYM2612Dac` removing only YM2612 DAC
percussion notes.
For manual verification with a real source:

```
node dist/cli.js "path/to/song.vgz" -v -o /tmp/out.mid
```

Confirm the verbose output lists the expected chip, the command stream reaches
its real end, and the output is well over 14 bytes with at least one `MTrk`
containing Note On/Off events.

### Fixed: SSG split-period write phantom notes, `--duration` DAC-trigger loss, and unmasked SN76489 clock

A post-implementation review of the AY-3-8910/YM2203/YM2608 SSG, PC Engine, and
Mega Drive conversion paths found three correctness bugs not covered by the
existing tests, verified against pre-fix `dist/` output before being fixed:

- **`updateSSGTonePeriod()` had no split-write guard.** Every other
  multi-byte frequency pair in this file (SN76489's `handlePSGWrite()`,
  HuC6280's `$02`/`$03`, and OPN/OPNA FM's `$A0-$A6` pairs) peeks ahead past
  `wait` commands for the other half before updating pitch, so a
  LSB-then-MSB (or MSB-then-LSB) split write never reads pitch off the
  transient combined-with-stale-half state. The AY-3-8910/YM2203/YM2608 SSG
  tone-period write (`reg` 0–5, shared by all three via `updateSSGTonePeriod()`)
  was missing this guard entirely. Reproduced concretely: writing a new SSG
  period MSB first (leaving the LSB briefly stale) read as a spurious note a
  fifth away, retriggering an extra Note On/Off pair before the real
  post-pair note — `generatedNoteCount` went from 2 to 3 for what should be
  one retrigger. `handleSSGWrite()`/`updateSSGTonePeriod()` now take the
  same `cmdIndex`/`chip`/`instance` triple `isOPNMultiByteFreqUpdate()`
  already accepts for OPN FM, and reuse that same look-ahead (port is always
  0 for SSG registers on every chip that has them).
- **`--duration` truncation silently dropped zero-wait `pcm_write` commands.**
  `appendUntilSample()` in `vgm-playback.ts` only copied a `wait`/`pcm_write`
  command into the truncated output when `appliedSamples > 0`. A `wait` with
  a zero sample count is genuinely a no-op and fine to drop, but a
  `pcm_write` always performs one DAC sample-byte output regardless of its
  embedded wait — VGM's DAC streaming commonly issues these back-to-back
  with `samples: 0`. Reproduced concretely: two `pcm_write(samples: 0)`
  commands truncated by `--duration` both vanished from the output,
  producing plain `wait` commands with no DAC triggers at all. `pcm_write`
  is now always emitted when the truncation point hasn't been reached yet,
  regardless of its clipped `appliedSamples`.
- **`psgRegisterToFrequency()` read the raw, unmasked SN76489 clock.**
  Every other clock-bearing chip in this file (YM2612, YM2203, YM2203/YM2608
  SSG, YM2151) masks header clock flag bits with `& 0x3FFFFFFF` before using
  the value in a frequency formula. SN76489's header field defines bit 30 as
  a dual-chip flag and bit 31 as a T6W28 (Neo Geo Pocket) flag; a VGM with
  either bit set fed an inflated clock straight into
  `frequency = clock / (32 * register)`, pushing every SN76489 note toward
  the 127 ceiling. Reproduced concretely: the same register value produced
  MIDI note 76 at a plain clock and note 127 (clamped) with the dual-chip
  flag bit set. `psgRegisterToFrequency()` now masks the same way the other
  chip handlers do. (AY-3-8910's clock field has no such flag bits defined,
  so `ay8910RegisterToFrequency()` was left unmasked.)

### Added: reproduction-fidelity pass — velocity, direct DAC, noise-drum mapping, and PCM pan

A follow-up pass focused on how closely the converted MIDI reproduces the
source, beyond correctness. All five changes below were verified against
the existing test suite (`npm test`, no regressions beyond the two intentional
HuC6280 noise-note updates called out below) plus new regression tests.

- **OPN carrier-Total-Level velocity, and the YM2612 velocity=40 bug it
  fixed.** `opnCarrierVelocity()` (next to `opnPitchScale()`, reusing the
  same `OPN_OPERATOR_PATHS[algorithm]` carrier-reachability loop) derives a
  1-100 velocity from the lowest (loudest) Total Level among the algorithm's
  audible carrier operators: `velocity = clamp(round(100 * 10^(-(0.75*minTL)/120)),
  1, 100)`. TL is 0.75dB/step attenuation (0=loudest, 0x7F=silent), but carrier
  TL is also part of FM patch/timbre design rather than a standalone mixer
  fader. A physical amplitude mapping made ordinary Mega Drive patches nearly
  inaudible in a GM synth; this deliberately shallow curve keeps TL=16 near
  the former neutral velocity 80 while preserving relative dynamics. No reachable carrier (e.g. every candidate
  gated off) falls back to a neutral 80, matching the previous fixed value.
  The result is latched into `state.opnActiveVelocity` at the same key-on
  sites that already latch `opnActivePitchScale` (YM2612/YM2203/YM2608's
  `handle*KeyWrite()`). A TL write mid-note becomes CC11 relative to that
  latched key-on level. `TrackState.expression` tracks the persistent MIDI
  controller value, and `noteOn()` resets it to 127 before the next pitch bend
  and Note On, preventing velocity and stale expression from applying the same
  TL attenuation twice.
  `noteOn()`'s velocity branch was also restructured while doing this:
  YM2612 had never matched the `ym2151_`-and-YM2203/2608-FM branch (the
  condition checked `key.startsWith('ym2151_')`, not `'ym2612_'`), so it fell
  through to the generic `else` (`40 + volume*5`) — and `state.volume` is
  never assigned for `ym2612_*` channels, so this was a silent, permanent
  velocity of 40 for every YM2612 FM note, lower than every other FM chip's
  neutral 80 and never noticed until this review. YM2612 now shares the
  carrier-TL branch with YM2203/YM2608 FM. YM2151 uses the same curve after
  normalizing its raw key mask and physical TL slots to logical operators.
- **YM2612 `$2A` direct one-byte DAC writes.** `handleYM2612Write()` had no
  branch for `$2A` (as opposed to the `$E0`-seek + `$80-$8F`-stream path
  `handleYM2612DACWrite()` already covers) — some non-optimized VGM rips
  drive the DAC this way, and those writes previously fell through unhandled
  with no notes produced at all. `$2A` carries no address, so there is no
  sample identity to key retriggering off; consecutive writes are instead
  grouped into one note by elapsed-time gap
  (`YM2612_DAC_DIRECT_GAP_SAMPLES` = 882 samples = 20ms — non-optimized rips
  drive `$2A` every few samples while a sample plays, so 20ms reliably
  separates one drum hit from the next). All writes share one track/sample
  identity (`ym2612dac_direct_stream`) since there is nothing to distinguish
  samples by; a richer fingerprint-based identity was considered and
  deferred (byte-value fingerprinting risks identity explosion as sample
  volume varies). `stopYM2612DirectDACVoice()` — called from both `$2B`
  disable and end-of-file (`stopAllPCMVoices()`) — closes at the *last
  actual `$2A` write time*, not at the moment the gap/disable/EOF is
  detected; naively closing at `currentTime` there would stretch the final
  hit's duration across any trailing silence or `$2B`-disable delay.
  DAC stream control (`$90-$95`) was evaluated and deliberately not wired up
  in the same pass — the `$E0`-seek+stream and now `$2A`-direct paths already
  cover the common cases, and the added parsing complexity was judged not
  worth it without a source file that actually needs it.
- **Noise-frequency-to-GM-drum mapping**, for SN76489, AY-3-8910/YM2203/
  YM2608 SSG, HuC6280, and YM2151 — previously all hardware noise used a
  fixed GM note 42 regardless of the source's actual noise rate. Shared
  helper `noiseDrumNote(normalizedRate, isPeriodic)` (top of the file, next
  to `YM2608_RHYTHM_NOTES`) maps a per-chip-normalized `[0..1]` rate to
  42/38/45 (white noise, high/mid/low) or 37/35 (SN76489's periodic/tonal
  noise mode, high/low) — normalized rather than absolute Hz because the
  chips' noise-rate ranges differ by orders of magnitude and don't share a
  meaningful absolute threshold. Each chip normalizes its own rate register
  before calling it:
  - SN76489: `psg_3.frequency` already held the noise-control nibble
    unused for anything but on/off (`handleSN76489NoiseControl()`); FB
    (periodic/white) and NF (0/1/2 fixed divisor, or 3 = follow channel 2's
    own tone frequency) are now read from it directly, no new parsing
    needed. Because NF=3 makes the noise depend on channel 2's tone, a
    write to channel 2's frequency now also re-evaluates the noise note if
    NF=3 and noise is currently sounding
    (`reevaluateSN76489NoiseForChannel2Frequency()`), even though nothing on
    channel 3 itself was touched.
  - AY-3-8910/YM2203/YM2608 SSG: register 6 (5-bit noise period) was
    previously parsed nowhere (`handleSSGWrite()` had no `reg === 6`
    branch). It is one shared generator per chip instance covering up to 3
    channels at once, unlike tone/volume which are per-channel, so
    `updateSSGNoisePeriod()` re-evaluates every currently-sounding noise
    channel on that `keyPrefix` — not just the one whose own register
    happens to be touched next — and only retriggers a channel whose GM
    drum note actually changed (a sweep that stays inside one band does
    nothing, avoiding machine-gunning notes).
  - HuC6280: `$07` bits0-4 were read only as the noise-enable bit (bit7);
    the 5-bit rate field is now stored (`state.noisePeriod`) and, confirmed
    against MAME's `c6280.cpp` (`step = (value & 0x1F) ^ 0x1F; noise_counter
    = step << 6`), a **larger** raw register value means a **higher**
    pitch (smaller step/counter → more frequent LFSR updates).
  - YM2151: `$0F` bits0-4 (NFRQ) were likewise read only as the noise-enable
    bit; confirmed against `ymfm_opm.cpp` (`m_noise_counter++ >= freq`), a
    **larger** NFRQ means a **lower** pitch — the opposite direction from
    HuC6280, SN76489, and AY/SSG. Getting this backwards was the single
    easiest mistake to make while implementing this; the regression test
    explicitly checks NFRQ=0 → note 42 and NFRQ=0x1F → note 45 to catch a
    sign flip.
  - Both HuC6280 and YM2151 only re-evaluate a rate change when the channel
    was already sounding noise *before and after* the write — the existing
    on/off sync functions (`syncHuC6280NoiseState()`/`syncYM2151NoiseState()`)
    already handle a fresh on/off transition, so this only covers "still
    active, rate moved to a different drum band" without double-triggering a
    note that was just started.
  - Two existing HuC6280 regression tests' expected note changed from 42 to
    45, because their `$07 = 0x80` fixture leaves the rate field at 0
    (slowest on real hardware), which now correctly maps to the low band
    instead of the old fixed 42.
- **Stable GM Program fallback.** An initial implementation selected
  Ocarina for HuC6280 and sawtooth/brass/organ voices for OPN/OPM tracks.
  Those GM presets can add their own audible vibrato or tremolo, creating
  modulation that does not exist in the VGM register stream. Every melodic
  track therefore continues to use the neutral `GM_PROGRAM_LEAD_1_SQUARE`
  fallback documented above. Chip algorithm and waveform state still drive
  pitch and velocity analysis where supported; they do not select a DAW
  instrument preset.
- **SegaPCM/C140 stereo volume registers now drive CC10 (Pan)**, previously
  collapsed to `Math.max(left, right)` for velocity only. C140's register
  order was confirmed against MAME's `c140.cpp`: offset+0 = right volume,
  offset+1 = left volume — the *opposite* order from SegaPCM's offset+2 =
  left / offset+3 = right, easy to get backwards without checking. Because
  every SegaPCM/C140 sample track shares GM percussion channel 10
  (`isPercussionKey()`/`midiChannelForKey()`), there is exactly one current
  pan value for the whole channel, not one per track — `addPCMPan()`
  therefore caches and compares against one shared `pcmChannel10Pan` field,
  not a per-track value, and resends before every Note On when it differs.
  A per-track cache was tried first and found to be a real bug, not just a
  theoretical one: with voice A panned left, voice B panned right, and A
  retriggering without touching its own volume registers, a per-track cache
  sees "A's own pan hasn't changed" and skips resending — leaving channel
  10 still pointed right (from B) while A is actually sounding on the left.
  The regression test for this reproduces exactly that sequence. The one
  limitation this does not solve is inherent to sharing one MIDI channel:
  simultaneously-sounding PCM voices on different pans still cannot be
  panned independently of each other.

## Added: Extra Header chip volume becomes a leading CC7

A VGM 1.70+ file's Extra Header can carry a per-chip-instance mix volume —
this is how a rip records "this chip was mixed quieter than the others in
the original hardware/emulator setup," independent of any per-channel
register. `parseExtraHeader()` (`vgm-parser.ts`) already parsed this
structure, but nothing downstream ever read the result: every converted
`.mid` was silent about a genuine mix decision the source file recorded,
which meant a multi-chip VGM's chips always played back at equal weight in
`miditrack`'s per-track volume slider regardless of what the original mix
actually was (see `miditrack/CLAUDE.md`'s "Why the volume slider's initial
value can be something other than 100%" for the consumer side of this).

**Fixed two real parsing bugs discovered while wiring this up**, both
regression-tested directly against the VGM spec's byte layout rather than
against the previous (undertested) behavior:

- **Chip Clock entries always got `instance: 1`, never `instance: 0`.**
  The VGM spec encodes "this is the second chip instance" as bit 7 of the
  entry's own Chip ID byte — identical for both the Chip Clock list and the
  Chip Volume list — but the old code hardcoded `instance = 1` for every
  clock-list entry and derived a Chip Volume entry's instance from its
  *Flags* byte instead (`(flags & 1)`, which is actually the
  absolute/relative-volume bit, not an instance selector). This meant a
  clock entry and a volume entry for the very same primary-instance chip
  would land under two different map keys (`"YM2612:1"` vs `"YM2612:0"`)
  and never merge into one entry with both fields populated.
- **A chip appearing only in the Chip Clock list silently reported
  `volume: 0`.** The old code seeded every new map entry with a `volume: 0`
  placeholder before either list had actually been read, so a chip with no
  Chip Volume entry at all was indistinguishable from one explicitly muted.
  `parseExtraHeader()`'s return type now makes `volume` (and
  `isAbsoluteVolume`) optional and only assigns them when a Chip Volume
  entry for that exact chip+instance actually exists.

Both fixes share one root cause: clock and volume entries were being
merged by a chip-identity derivation that differed between the two lists.
`chipIdentity(rawId)` is now the single shared helper both `readList`
passes (inlined per-list after this fix, since their entry byte widths
differ — 5 bytes for clock, 4 for volume) call to turn a raw Chip ID byte
into `{ chip, instance }`, so a clock entry and a volume entry for the same
physical chip instance are guaranteed to land in the same map slot
regardless of which list they came from.

`MidiConverter.extraHeaderVolumePercent(chip, instance)`
(`midi-converter.ts`) turns a matched entry into a 0-127 CC7 value:
`round((volume / 0x100) * 100)`, since `0x0100` (256) is the VGM spec's
"100%, unmodified" sentinel for this field. Two safety restrictions, both
deliberately conservative because this data is genuinely ambiguous
otherwise:

- **Only `isAbsoluteVolume === true` entries are used.** The Flags byte's
  bit 0 selects whether `volume` is an absolute override or a *relative*
  offset from some default this parser has no way to know (the VGM spec
  does not name what that default actually is). Adopting a relative value
  as if it were absolute would produce an arbitrary, meaningless CC7 for
  exactly the files that use this less-common flag; skipping it entirely is
  the correct default.
- **A CC7 that would come out to exactly 100 is not emitted at all** — a
  redundant Controller Change event on every track for the (very common)
  case of an unmodified-volume chip.

Lookup is by `${chip}:${instance}`, reusing the existing `TrackDescriptor`
fields `getTrack()` already computes for every track — with one alias:
`descriptor.chip` spells this chip `"MSM6258"` (matching this file's own
internal naming for the OKI MSM6258, see the DAC-stream sections above),
while the Extra Header chip-name table (inherited from the VGM spec's own
chip list) spells it `"OKIM6258"`. `descriptor.chip === 'misc'` (a
descriptor that couldn't be matched to any known chip family) is skipped
outright rather than risking a coincidental name collision.

**Why the VGM header's Volume Modifier (`$7C`, a `2^(v/0x20)`-scaled global
gain applied equally to every chip) was deliberately not adopted here**: it
scales the *entire mix* uniformly and therefore carries no information
about the *relative* balance between chips — the only thing a MIDI-level
CC7 per track can usefully represent. Folding it in would have added parser
surface for a value that, by construction, can never change which track
sounds relatively louder or quieter than another.

**Verification**: `MidiConverter emits Extra Header absolute chip volume as
a leading CC7`, its two negative counterparts (`omits CC7 when ... exactly
100%` and `ignores a relative (non-absolute) ... volume`), and `matches
Extra Header entries by chip AND instance, not by chip alone` (a second
chip instance's quiet volume must never leak onto the primary instance's
track) all construct a `MidiConverter` directly with a synthetic
`extraHeader` array and inspect the resulting `ControllerChangeEvent`s —
the same "construct `VGMData` in-process, skip the byte-level VGM
encoding" style already used throughout this file's OPN/OPL/YM2413 tests.
`vgm-parser.test.js`'s four `VGM 1.70 extra header ...` tests instead build
the real byte layout by hand (chip ID bit 7 in both lists, Flags byte bit
0, the presence-vs-zero distinction for a clock-only chip, and a relative
volume passed through as-is) to pin down the parser fix independently of
the converter.

## Out of scope (for now)

- Stereo panning (`$01`/`$05`) and LFO/vibrato (`$08`/`$09`) for HuC6280 —
  see "Design choices" above.
- DDA-mode sample playback — HuC6280 channels using register `$06` as raw
  PCM data have no tonal representation in this tool's note-inference
  model, for any chip.
- A MIDI-channel-budget redesign that would avoid the 14–16-wraps-to-1–3
  collision when multiple chip families are active in the same VGM.
- YM2151 operator envelopes and total-level-derived velocity — YM2612/YM2203/
  YM2608 now derive velocity from carrier operator Total Level (see "Added:
  reproduction-fidelity pass" below), but YM2151's own TL registers
  (`$60-$7F`) are not read yet, so its FM tracks still use a fixed neutral
  velocity.
- Timer-A-driven CSM automatic key-on has register-command-level tests for
  YM2203/YM2608/YM2612 and YM2151. The OPN implementation shares the Ch3
  Special output path, while the OPM implementation attacks all configured
  channels. It deliberately emits one-tick MIDI pulses and coalesces repeated
  overflows inside one MIDI tick.
- PCM metadata now preserves the source-specific sample ID independently from
  the 47-note GM percussion allocation. `pcm.events` records start/stop sample
  times, and an MSM6258 start carries its loop flag. This keeps repeated and
  post-wrap sample identities editable without changing `miditrack`'s version-1
  channel-mapping reader.
- YM2413 per-operator Multiple (instrument-dependent pitch scaling) and a
  `$20`-before-`$10` key-on write order — see "Added: YM2413 (OPLL) FM and
  rhythm conversion" above; note conversion itself is now implemented.
- Game Boy DMG's channel 1 frequency sweep, length counters, envelope volume
  sweep, wave RAM contents, and `NR50`/`NR51` panning/mixing — see "Added:
  Game Boy DMG (LR35902 APU) conversion" above for why each is out of scope;
  the four channels' trigger/pitch/velocity conversion itself is implemented.
- Semantic drum classification for YM2612 DAC, YM2608 ADPCM-B, SegaPCM, and
  C140. Their MIDI notes preserve sample identity and trigger timing only,
  never a claim about what the sample actually sounds like. `--dac-wav` (see
  "Added: `--dac-wav`" above) is the one exception to *raw audio* being out
  of scope — it plays back the real captured YM2612 PCM bytes verbatim as a
  separate WAV stem, but still performs no classification: it doesn't know
  or care whether a given sample is a kick, a snare, or something else.
  YM2608 ADPCM-B, SegaPCM, and C140 have no equivalent stem-rendering option
  yet — their MIDI notes remain sample-identity/trigger-timing only, and
  YM2608 ADPCM-B's Delta-N, repeat, and sample-end timing are likewise not
  reconstructed.
