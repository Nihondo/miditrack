# vgm2midi

A Node.js/TypeScript command-line tool that converts VGM/VGZ (Video Game
Music command log) files to Standard MIDI Files, by replaying the logged
sound-chip register writes and inferring note on/off, pitch, and velocity
from them. Works on macOS, Linux, and Windows.

This is a local fork of [jkarenko/vgm2midi](https://github.com/jkarenko/vgm2midi)
with HuC6280 (PC Engine / TurboGrafx-16 PSG), working YM2151 (arcade FM),
YM2203 (OPN), YM2608 (OPNA), YM2413 (OPLL), YM3526/YM3812/Y8950 (OPL),
and Game Boy DMG (LR35902 APU)
conversion added, plus OPN channel 3 special mode, YM2612 DAC, and
SegaPCM/C140 sample-trigger extraction — see `NOTICE.md` for the origin and
`CLAUDE.md` for what changed and why.

## Features

- Converts VGM and VGZ (gzip-compressed VGM) files to Standard MIDI Files
- Supports these sound chips:
  - SN76489 PSG (Sega Master System, Game Gear, Genesis/Mega Drive)
  - YM2612 FM and DAC samples (Sega Genesis/Mega Drive)
  - YM2203 OPN: 3-channel FM plus 3-channel SSG (PC-88/PC-98, FM-7, arcade systems) — added in this fork
  - YM2608 OPNA: 6-channel FM, 3-channel SSG, 6 built-in rhythm voices, and ADPCM-B (PC-88/PC-98) — added in this fork
  - YM3526/YM3812/Y8950 OPL: 9-channel FM plus 5-voice rhythm mode (arcade, DOS AdLib, MSX-AUDIO) — added in this fork; Y8950 ADPCM is diagnostic-only
  - YM2151 FM (arcade systems) — completed in this fork
  - AY-3-8910 PSG (MSX, Amstrad CPC, ZX Spectrum)
  - HuC6280 PSG (PC Engine / TurboGrafx-16) — added in this fork
  - SegaPCM (Sega arcade PCM) — sample-trigger extraction added in this fork
  - C140 PCM (Namco arcade systems) — sample-trigger extraction added in this fork
  - YM2413 OPLL: 9-channel FM plus 5-voice rhythm mode (Sega Master System FM Sound Unit, MSX-MUSIC) — added in this fork
  - Game Boy DMG (LR35902 APU): 2 pulse, 1 wave, 1 noise channel — added in this fork
- Converts hardware-noise rhythm from SN76489, YM2151, YM2203/YM2608 SSG, AY-3-8910,
  HuC6280, and Game Boy DMG to separate General MIDI percussion tracks on channel 10,
  using note 42 (Closed Hi-Hat)
- Retriggers HuC6280 percussion when an active noise channel's volume rises by
  four or more steps, preserving repeated software-envelope hi-hat attacks
- Maps the six built-in YM2608 rhythm voices to GM Bass Drum, Snare Drum,
  Crash Cymbal, Closed Hi-Hat, Low Tom, and Side Stick while preserving their
  key masks, retriggers, and level changes
- Maps YM2413's five built-in rhythm voices (Bass Drum, Hi-Hat, Snare Drum,
  Tom-Tom, Top Cymbal) to independently-triggered GM percussion notes
- Maps the OPL family's five rhythm voices to the same GM percussion set and
  preserves `$BD` key-bit transitions without retriggering unchanged bits
- Converts YM2203/YM2608/YM2612 channel 3 Special mode to four editable
  per-operator pitch tracks by default; `--ch3-special-percussion` instead
  collapses each composite FM attack to one GM Bass Drum, Snare, Hi-Hat,
  Crash, or tuned Tom hit
- Routes melodic YM2612 channel 6 to MIDI channel 14, keeping General MIDI's
  reserved percussion channel 10 available for drum tracks
- Converts each distinct YM2612 DAC, YM2608 ADPCM-B, SegaPCM, and C140 sample identity to a
  separate GM percussion track; the first 47 identities receive notes 35-81
  in first-seen order
- Corrects YM2203/YM2608/YM2612 notes by whole octaves when the active algorithm paths share
  an explicitly written, unambiguous power-of-two operator multiplier, including
  `MULTI=0`'s effective 0.5x ratio; the correction is latched at key-on so patch
  setup immediately before key-off cannot create transient notes
- Honors SN76489 and AY/YM2149 clock-divider/period flags, masks chip-type and
  dual-chip bits out of clock values, and keeps dual AY8910/HuC6280 instances
  in separate MIDI tracks
- Coalesces split HuC6280 frequency-register writes across at most one 50 Hz
  frame, while keeping unrelated later writes independent
- Keeps each YM2151/YM2203/YM2608/OPL FM note bounded by the chip's hardware key-on/key-off
  writes and converts in-note YM2151 key-code/key-fraction or OPN F-Number changes to
  pitch bend, avoiding frame-rate note retriggers from software pitch envelopes and arpeggios
- Applies an initial pitch bend to every melodic note so the source frequency is
  retained instead of being left rounded by as much as half a semitone
- Every melodic track is sent an explicit General MIDI instrument so DAWs do
  not fall back to a random default. PSG and wavetable tracks use "Lead 1
  (square)". OPN/OPM and OPL FM tracks select a stable initial GM suggestion
  from the algorithm at their first note; this is a preview choice, not a
  reconstruction of the original FM timbre
- Configurable tempo
- Expands a VGM loop section by total playback count (`--loops`) or to an exact
  target duration (`--duration`)
- Verbose mode showing detected chips and conversion statistics
- Refuses to report success or overwrite the output when no MIDI notes can be
  generated, instead of creating an empty 14-byte MIDI header
- `--noise-wav FILE` renders SN76489/HuC6280 noise as a separate 16-bit,
  44.1 kHz stereo LFSR stem and suppresses the corresponding GM percussion
  notes by default; add `--keep-noise-midi` for A/B comparison
- `--dac-wav FILE` renders the real YM2612 DAC/PCM sample audio (Mega Drive
  drum channel) as a separate 16-bit, 44.1 kHz stereo stem and suppresses the
  corresponding GM percussion notes by default; add `--keep-dac-midi` for
  A/B comparison
- `--track-metadata FILE` writes a versioned JSON sidecar that maps each output
  MIDI track index to its libvgm device, instance, and main/linked channel masks.
  FM tracks also include a first-note snapshot of the detected model, algorithm,
  carrier operators, operator levels, multipliers, key-on mask, and suggested
  GM program; `miditrack` remains compatible with the existing channel mapping

## Installation

From this repository:

```bash
cd vgm2midi
npm install
npm run build
```

A prebuilt `dist/` is already committed, so this step is only needed after
editing the source. Run it directly with:

```bash
node vgm2midi/dist/cli.js <input> [options]
```

To make the global `vgm2midi` command (if installed via
`npm install -g vgm2midi`) resolve to this fork instead of the unpatched
upstream package, run `npm link` from this directory.

## Usage

```bash
vgm2midi input.vgm
```

This creates `input.mid` in the same directory. VGZ (gzip-compressed VGM)
files are auto-detected and decompressed.

### Options

```
Usage: vgm2midi [options] <input>

Arguments:
  input                   Input VGM or VGZ file

Options:
  -V, --version          output the version number
  -o, --output <file>    Output MIDI file (default: input filename with .mid extension)
  -t, --tempo <bpm>      MIDI tempo in BPM (default: "120")
  --loops <count>        Total loop-section playback count, including the logged pass
  --duration <seconds>   Target output duration in seconds
  -v, --verbose          Verbose output
  --noise-wav <file>     Render SN76489/HuC6280 hardware noise to a separate WAV stem
  --keep-noise-midi      Keep GM percussion notes when --noise-wav is used
  --dac-wav <file>       Render YM2612 DAC/PCM sample audio to a separate WAV stem
  --keep-dac-midi        Keep GM percussion notes when --dac-wav is used
  --ch3-special-percussion
                         Collapse OPN Ch3 Special composite hits to GM percussion
  --strict               Fail before output when parsed content would be omitted
  --split-chips          Also write collision-free chip/instance MIDI sidecars
  --stems <directory>    Render sample-exact libvgm mix/chip WAV stems and manifest
  --track-metadata <file>
                         Write MIDI-track to libvgm channel mapping JSON
  -h, --help             display help for command
```

`-v` shows the VGM version, duration, which sound chips were detected in
the file's header, and the total parsed command count — useful for confirming a
source was actually recognized before waiting on a long conversion. A successful
conversion always contains at least one MIDI track with notes; unsupported or
non-tonal sources now exit with an error without writing an empty MIDI file.

`--loops` and `--duration` are mutually exclusive. `--loops 1` preserves the
default one-pass output. A value such as `--loops 3` keeps the intro once and
plays the VGM loop section three times in total, including the pass already
logged in the source. `--duration 600` repeats the loop as needed and clips the
last VGM wait at exactly 600 seconds. If the VGM has no loop point, it can be
shortened with `--duration`, but it cannot be extended or used with
`--loops 2` or greater.

`--noise-wav noise.wav` writes only audible SN76489 and HuC6280 noise to a
separate WAV whose timeline matches the MIDI output. The matching channel-10
drum notes are omitted from the MIDI so mixing the two outputs does not double
the percussion. Use `--keep-noise-midi` only when you intentionally want both
representations for comparison. This stem renderer is limited to the chips'
LFSR noise paths; it is not a complete chip emulator and does not render tones,
FM, HuC6280 DDA/PCM, or balance registers.

`--dac-wav dac.wav` writes the real YM2612 DAC/PCM sample audio (Mega Drive
games commonly use this channel for sampled drums) to a separate WAV whose
timeline matches the MIDI output, using the actual sample bytes captured from
the VGM rather than a placeholder GM note. The matching `YM2612 DAC Sample`/
`YM2612 DAC Direct` channel-10 tracks are omitted from the MIDI by default so
mixing the two outputs does not double the percussion. Use `--keep-dac-midi`
only when you intentionally want both representations for comparison.

`--ch3-special-percussion` is intended for sources that use YM2203, YM2608, or
YM2612 channel 3 Special mode as a composite FM drum voice. These OPN-family
chips still combine the operators through the selected FM algorithm; the option
therefore emits one channel-10 GM hit per hardware attack instead of four
unrelated pitched notes. The audible carrier base range selects Bass Drum,
Snare, Closed Hi-Hat, Crash Cymbal, or one of six tuned Toms. This is a
practical GM approximation, not a reconstruction of the original FM timbre.
Omit the option when channel 3 is used melodically and you want editable
per-operator pitch tracks. Dual YM2203/YM2608 instances are tracked separately.

### Fidelity, diagnostics, and stems

MIDI timing uses 960 PPQ derived from absolute VGM sample positions. `--strict`
turns omitted unsupported writes into an error before output; otherwise the CLI
warns and continues. `--split-chips` retains normal MIDI and adds collision-free
sidecars such as `song.YM2151.mid` and `song.YM2203-2.mid`.

Dual instances are parsed for SN76489, YM2413, YM2612, YM2151, YM2203, YM2608,
YM3526, YM3812, Y8950, AY8910, Game Boy DMG, SegaPCM, C140, and HuC6280. PCM stream device 0x17
(MSM6258/OKIM6258) is a stable GM editing trigger keyed by bank/start/length,
not a timbre classification. `--stems DIR` invokes the bundled, pinned arm64
libvgm helper for 44.1 kHz, 16-bit stereo mix/per-chip WAVs and `*.stems.json`.
Rebuild it only after changing its source, using `vgm2midi/scripts/build-native.sh`
(commit `57585ea`). Its source/cache/build defaults are all under `/tmp`; override
them with `VGM2MIDI_NATIVE_CACHE`, `VGM2MIDI_LIBVGM_SOURCE`, and
`VGM2MIDI_NATIVE_BUILD`, all outside the checkout. The helper reuses the pinned
local git object without network access and fetches only when that object is
absent; `VGM2MIDI_NATIVE_OFFLINE=1` rejects a missing source cache before any
clone/fetch attempt and also rejects a cached checkout missing the pin.
Run `npm run verify:native-stems` to rebuild it and verify mix/stem sample counts
and additive RMS. The same helper also accepts the channel-mask selection mode
used by `miditrack`; `--track-metadata FILE` supplies that UI with the stable
track-index/device/instance/channel-mask mapping and conservative hardware-mix
suggestion flag.

Tracks are identified internally by `{chip, instance, section, channel,
sourceKey, midiChannel}`. Register/latch/DAC/PCM/rhythm/key/TL/pan state is
therefore independent for every dual device, including EOF note closure. The
normal MIDI warns only when different descriptors actually overlap on one MIDI
channel; `--split-chips` always emits the descriptor-derived sidecars.

The parser preserves every VGM 1.72 chip write. Unsupported writes become
`unsupported_write` commands and expose per-chip/instance masked clocks,
command/write/stream counts, and MIDI support through
`VGMParser.parse().diagnostics`, for example:

```json
{"chips":[{"chip":"MSM6258","instance":0,"clock":4000000,"commandCount":3,"writeCount":0,"streamCount":1,"midiSupport":"trigger"}],"unsupportedWriteCount":1,"hasOmittedContent":true}
```

The default CLI continues with a named warning such as `YMF262 (writes 1,
streams 0)`; `--strict` fails before writing MIDI. Legacy VGM 1.00/1.01 FM
clock ownership is determined from the first bounded YM2413/YM2612/YM2151
write, not the SN clock.

YM2151, OPN, and OPL carrier TL controls velocity at key-on and CC11 during a note.
OPL `$Bx` key-on is transition-guarded, so repeated pitch writes with bit 5 still set
become ±96-semitone pitch bends rather than new attacks.
YM2413 defers a key-on whose `$20` arrives before its `$10` LSB and applies only
explicit power-of-two carrier-Multiple corrections. PSG/SSG/HuC frequency
changes stay in one note with ±96-semitone pitch bend unless a real gate restart
occurs. The Game Boy's absolute-sample 512 Hz frame sequencer supplies length
note-off, envelope CC11, and channel-1 sweep bend. Pan is CC10 (`left=0`,
`both=64`, `right=127`) for FM, Game Gear `$4F`/second `$3F`, AY/SSG `$31`,
HuC6280, and Game Boy NR50/NR51.

All `0x67` data blocks remain available by bank type, instance, and block ID.
The size field's bit 31 selects the second bank instance; compressed `0x40`–
`0x7E` blocks are expanded through their VGM compression headers (including
`0x7F` tables) before `0x95` lookup. Malformed compressed blocks fail safely
instead of desynchronising the command stream. Stream `0x91` step data and
`0x93` length modes determine MSM6258 trigger duration: mode `0` preserves the
previous resolved length (DCTRL_LMODE_IGNORE), `1` is commands, `2` is
milliseconds, `3` is to end of bank, and `0x0F` is raw bytes. A non-loop
natural end is held until it is finalised, so `$94` or a restart can shorten or
replace it; looped streams remain open until `$94` or conversion end. This MIDI
is an editing marker only—the libvgm MSM6258 stem remains the audible source.

The native manifest is valid UTF-8 JSON even when input basenames or output
directories contain quotes, backslashes, or control characters. In offline
mode, `VGM2MIDI_NATIVE_OFFLINE=1` rejects a missing source cache before any
clone/fetch attempt and also rejects a cached checkout that lacks pin `57585ea`.

The corpus audit is read-only and never extracts or modifies corpus files. It
parses direct VGM/VGZ files and VGM/VGZ entries in ZIP archives in memory, then
reports diagnostics, zero-note conversions, and MSM6258 trigger candidates:
`VGM2MIDI_CORPUS_ROOT=/path npm run audit:corpus`. Set
`VGM2MIDI_EXPECTED_SONGS=133` when auditing the canonical collection. ZIP
inspection requires the system `unzip` command.

### Examples

```bash
vgm2midi song.vgz -o song.mid -v
vgm2midi "01 Magical Sound Shower.vgm" --tempo 140
vgm2midi song.vgz --loops 3
vgm2midi song.vgz --duration 600
vgm2midi song.vgz --noise-wav song.noise.wav
vgm2midi song.vgz --dac-wav song.dac.wav
vgm2midi song.vgz --ch3-special-percussion
```

## How it works

1. Parse the VGM header (chip clock rates, data offset, sample count),
   decompressing first if the input is VGZ
2. Resolve the VGM loop point and expand or trim the command timeline when
   `--loops` or `--duration` is specified
3. Walk the command stream, tracking each chip's per-channel frequency,
   volume, enable state, and supported PCM sample identity as writes are replayed
4. Convert frequency to a MIDI note number (`note = 69 + 12 * log2(freq / 440)`),
   or decode YM2151 key code/key fraction directly, infer note on/off from each
   chip's enable/volume semantics, and route supported hardware noise to GM
   percussion
5. Write a Standard MIDI File, one track per emulated chip channel

### Limitations

- FM synthesis parameters are simplified — MIDI has no native FM voice
  model, so YM2203/YM2608/YM2612/YM2151 channels are approximated as simple notes. For
  YM2203, YM2608, and YM2612, algorithm, key-on mask, total level, and explicitly
  written operator multipliers are used only for unambiguous shared power-of-two
  octave correction (including 0.5x). Ratios without a shared power-of-two
  factor, detune, envelopes, and perceived missing
  fundamentals remain raw F-Number approximations
- YM2413 defers reverse `$20`-then-`$10` key-on ordering and models only an
  explicit power-of-two carrier-Multiple correction. Non-power-of-two ratios,
  envelopes, detune, and the original OPLL timbre remain outside MIDI's model
- YM3526/YM3812/Y8950 OPL conversion models F-Number/block, key transitions,
  CNT carrier routing, Total Level, MULTIPLE-based octave correction, and `$BD`
  rhythm keys. KSL, feedback, waveform selection, envelopes, AM/vibrato, and the
  original FM timbre are not reproduced. YMF262/OPL3 and Y8950 ADPCM are not
  converted; Y8950 ADPCM writes remain visible to diagnostics and `--strict`
- YM2203/YM2608/YM2612 channel 3 Special mode is converted from the
  operator-specific `$A8-$AA`/`$AC-$AE` frequencies plus the normal `$A2`/`$A6`
  frequency used by operator 4. Its default four-track output exposes each
  operator frequency for editing but cannot reproduce the algorithm's FM
  interaction. `--ch3-special-percussion` preserves one composite attack and
  maps its carrier base range heuristically to GM drums; it still does not
  synthesize the original FM timbre and can misclassify unusual patches
- CSM mode is converted for YM2612, YM2151, YM2203, and YM2608. Timer A
  overflows become one-tick MIDI attacks: OPN uses the existing Ch3 Special
  representation and OPM attacks all eight configured channels. Multiple
  overflows in one MIDI tick are coalesced, so this is an editable onset
  approximation rather than a reproduction of the original FM envelope
- YM2151/YM2203/YM2608/OPL FM tracks declare a ±96-semitone pitch-bend range through MIDI RPN 0
  so large in-note key-code/key-fraction or F-Number movement remains continuous. A MIDI player that ignores
  pitch-bend-range RPN messages will reproduce those bends at the wrong interval
- SN76489, YM2151, YM2203/YM2608 SSG, AY-3-8910, HuC6280, and Game Boy DMG hardware
  noise is approximated as a GM drum note (mostly Closed Hi-Hat, with a few chips
  mapped across a high/mid/low band); chip-specific noise timbre is not reproduced
- Game Boy DMG models the 512 Hz frame sequencer for channel-1 sweep, length
  counters, and envelope CC11. Wave RAM contents and therefore the original
  timbre remain outside MIDI's model
- YM2612 DAC, YM2608 ADPCM-B, SegaPCM, and C140 sample audio is not decoded or classified. Assigned GM notes
  distinguish sample identities but do not claim that a sample is semantically
  a kick, snare, hi-hat, or other matching GM instrument; mappings wrap after
  47 identities. A YM2612 seek followed by DAC output is treated as an onset,
  so a source that seeks only to continue silence or a partial sample may create
  an extra percussion hit
- YM2608 ADPCM-B Delta-N pitch, repeat mode, and sample end timing are not
  reconstructed; start-address writes identify sample-trigger tracks, and the
  next start/reset or end of conversion closes the MIDI note
- HuC6280 Direct D/A (raw sample playback) is not converted to notes
- Stereo panning and LFO/vibrato are not modeled for any chip
- With more than 13 simultaneous PSG/FM/PSG channels active across chip
  families, MIDI channel assignment can wrap and collide (only relevant to
  VGMs that drive multiple chip families at once — see `CLAUDE.md`)

## VGM file format

VGM is a sample-accurate logging format for video game console audio,
recording the exact commands sent to sound chips during gameplay. See the
[VGM specification](https://vgmrips.net/wiki/VGM_Specification) for
details.

## License

MIT — see `LICENSE`. See `NOTICE.md` for the upstream project this fork is
based on.
