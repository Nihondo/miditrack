# nsf2midi

A macOS command-line tool that converts NES Sound Format (`.nsf`) music into
Standard MIDI Files (`.mid`), by emulating the original NES audio hardware
and detecting notes from the emulated register state.

This is a from-scratch macOS/arm64 reimplementation of the Windows GUI tool
`nsf2midi` 0.14, built because the original 32-bit `.exe` cannot run on
Apple Silicon and has no command-line interface. It reads the same `.mdf`
instrument-definition file format as the original.

## Features

- Converts NSF/NSFE files to General MIDI Standard MIDI Files (format 1)
- Emulates APU (2 pulse, triangle, noise, DPCM) plus VRC6, FDS, FME-7
  (Sunsoft 5B) and N106/N163 expansion audio
- Reads `.mdf` instrument-definition files for per-channel instrument,
  volume, pitch-bend, note-on detection sensitivity, mono/portamento mode,
  etc. — fully compatible with the original `default.mdf`
- `--wav` also renders the output MIDI to a listenable `.wav` via the
  bundled `midi2wav` tool (fluidsynth + a General MIDI SoundFont)
- `--chip-wav` renders the Noise and DPCM channels as real chip-emulated
  audio to a separate `.wav` instead of GM drum MIDI notes, for mixing back
  in with a truer percussion sound (see below)
- Single, dependency-free arm64 binary

## Installation

Build from source (requires Xcode Command Line Tools):

```
make
```

This produces a single binary, `nsf2midi`, with no runtime dependencies
beyond the system libraries. Copy it wherever you like, e.g.:

```
cp nsf2midi /usr/local/bin/
```

## Usage

```
nsf2midi [options] <input.nsf> [output.mid]
```

If `output.mid` is omitted, it defaults to the input filename with its
extension changed to `.mid`.

### Options

| Option | Description |
|---|---|
| `-m, --mdf <file>` | Instrument definition file (default: `gm.mdf` next to the `nsf2midi` binary — pass `-m default.mdf` for exact original-tool compatibility) |
| `-t, --track <n>` | Zero-based track index to convert (default: `0`) |
| `-d, --duration <sec>` | Seconds to convert (default: the NSFE track length if present, otherwise 180) |
| `-l, --list` | List the file's title, tracks and detected expansion chip, then exit |
| `--pal` | Force PAL timing (default: auto-detected from the NSF header) |
| `-v, --verbose` | Print each detected note to stderr as it's written |
| `--wav` | Also render the output MIDI to a `.wav` via `midi2wav.sh` (see the project root's `midi2wav` tool) |
| `--soundfont <file>` | SoundFont to use with `--wav` (default: `midi2wav.sh`'s own resolution) |
| `--chip-wav <file>` | Render the Noise and DPCM channels as real chip-emulated audio to `<file>` instead of GM drum MIDI notes. By default this also removes both channels from the `.mid` |
| `--keep-chip-midi` | With `--chip-wav`, also keep the Noise/DPCM GM drum notes in the `.mid` (requires `--chip-wav`) |
| `--track-metadata <file>` | Write a JSON sidecar mapping each MIDI track to its NES channel label, for later arbitrary-channel selection via `--chip-render` (see below) |
| `--chip-render <channels> --track <n> --sample-count <n> <input.nsf> <output.wav>` | Skip MIDI conversion entirely and render only `<channels>` (comma-separated channel labels, e.g. `NOISE,PCM,TRI` — the same labels `--track-metadata`/MIDI track names use) as real chip-emulated audio to `<output.wav>` |
| `-h, --help` | Show usage |

### Examples

List what's inside an NSF:

```
nsf2midi -l castlevania.nsf
```

Convert track 2 (zero-based) for 90 seconds, using a custom instrument set:

```
nsf2midi -m my_instruments.mdf -t 2 -d 90 castlevania.nsf theme.mid
```

By default, conversion already uses the bundled `gm.mdf` preset for richer
General MIDI reproduction (drum-mapped noise/PCM, duty-aware lead tone,
velocity dynamics) — no flag needed:

```
nsf2midi castlevania.nsf theme.mid
```

For output that matches the original Windows tool byte-for-byte (fixed
square-wave lead, flat velocity, `Instrument`-only drum notes), pass
`default.mdf` explicitly:

```
nsf2midi -m default.mdf castlevania.nsf theme.mid
```

Convert and immediately render a listenable WAV alongside the MIDI:

```
nsf2midi --wav castlevania.nsf theme.mid
```

Convert, but render the Noise/DPCM channels as real chip audio instead of
GM drum notes (removed from the MIDI by default):

```
nsf2midi --chip-wav theme.chip.wav castlevania.nsf theme.mid
```

## Real chip audio for Noise/DPCM (`--chip-wav`)

GM drum notes are a rough stand-in for the NES's Noise and DPCM (sample
playback) channels — a SoundFont snare/hi-hat sounds nothing like the
original hardware's percussion. `--chip-wav <file>` renders those two
channels through the same emulation core, at their real chip sound, to a
16-bit/44100Hz stereo WAV whose length exactly matches the output MIDI's
duration (so it can be mixed back in sample-for-sample later, e.g. by
`miditrack`'s "原曲の音源" option). By default the
Noise and DPCM channels are also removed from the `.mid` so they don't
sound twice; pass `--keep-chip-midi` alongside `--chip-wav` to keep the GM
drum notes too (e.g. for A/B comparison). Note that because Noise and DPCM
share one non-linear mixing curve on real hardware, the isolated stem is a
few dB louder than its true contribution when mixed against the Triangle
channel — expected, and something a mixdown step should apply a fixed gain
for rather than trying to correct in `nsf2midi` itself.

## Per-channel hardware selection (`--track-metadata` / `--chip-render`)

`--chip-wav` above is fixed to Noise+DPCM only. `--track-metadata <file>`
writes a JSON sidecar (one entry per MIDI track, naming its NES channel —
`SQ1`/`SQ2`/`TRI`/`NOISE`/`PCM`, plus any detected expansion channels) next
to a normal conversion, and `--chip-render <channels> --track <n>
--sample-count <n> <input.nsf> <output.wav>` renders *any* combination of
those same channel labels as real chip audio in a single pass — skipping
MIDI conversion entirely, so it's cheap to call repeatedly. This is what
`miditrack` uses for its per-track "原曲の音源" selector (see its own
`CLAUDE.md`): every NES channel maps to exactly one MIDI track (unlike some
of the multi-chip formats `vgm2midi` handles, NES has no channel shared
between two tracks), so every channel is always offered and always marked
as a safe default. `--sample-count` should be the sidecar's own
`sampleCount` value, so the rendered WAV's length always matches the
originally converted MIDI's duration.

## The `.mdf` instrument definition file

A `.mdf` file is an INI-style text file with one section per NES sound
channel: `[SQUARE-CHANNEL1]`, `[SQUARE-CHANNEL2]`, `[TRIANGELE-CHANNEL]`
(sic — kept for compatibility with the original), `[NOISE-CHANNEL]`,
`[PCM-CHANNEL]`, and `[EXTENDED-CHANNEL1]` through `[EXTENDED-CHANNEL8]`
(used for whichever expansion chip the NSF declares — VRC6 uses 3,
FDS uses 1, FME-7 uses 3, N106/N163 uses up to 8).

Each section supports these keys:

| Key | Meaning |
|---|---|
| `Instrument` | General MIDI program number (0-127). For Noise/PCM, this is used directly as the GM drum note number. |
| `BankHi` / `BankLo` | MIDI Bank Select MSB/LSB (CC0/CC32) |
| `Reverb` / `Chorus` | CC91 / CC93 |
| `Volume` | Channel volume, CC7 |
| `AttackEnabled` / `DecayEnabled` | Reproduce the NES channel's volume envelope via MIDI Expression (CC11) while a note holds |
| `PitchBendEnabled` | Reproduce sub-semitone frequency changes as pitch bend instead of retriggering the note |
| `Velocity` | If enabled, scale note-on velocity by the NES channel's output level instead of using a fixed velocity |
| `RelativeDividedPoint` | Minimum volume jump (level-change detection) that triggers a new note-on, to catch same-pitch reattacks |
| `AbsoluteDividedPoint` | Minimum volume required to sound a note at all |
| `FrequencyChangeEnabled` | Trigger a new note-on whenever the detected pitch changes |
| `LevelChangeEnabled` | Trigger a new note-on on a large-enough volume jump (see `RelativeDividedPoint`) |
| `ChannelEnabled` | Whether to convert this channel at all |
| `MonoEnabled` | Keep only one note sounding at a time on this channel, tying consecutive notes together |
| `PortamentEnabled` | Like `MonoEnabled`, and also sends a Portamento Time CC |
| `NoteNumberAdjust` | Semitone offset applied to every note on this channel |
| `NoiseDrumMapEnabled` | Noise only. Pick a GM drum note (42/38/45/37) from the actual noise rate and LFSR mode instead of a fixed `Instrument` note |
| `PcmSampleMapEnabled` | PCM only. Assign a distinct GM drum note (35-81, round-robin) per DPCM sample instead of a fixed `Instrument` note |
| `DutyProgramChangeEnabled` | Square/VRC6-pulse channels only. Send a GM Program Change reflecting the channel's duty cycle (thin/bright/full) at each note-on; a no-op on other channel types |

These three keys are extensions not present in the original 0.14 `.mdf`
format; they default to off (`0`). [`gm.mdf`](gm.mdf) turns them all on for
richer GM reproduction (drum-accurate noise/PCM, duty-aware lead tone,
velocity dynamics, a bass-register instrument for Triangle) and **is the
default `.mdf` used when `-m`/`--mdf` is omitted**. `default.mdf` remains the
frozen 0.14-compatibility reference (identical to the original tool's
output) and is never modified — pass it explicitly with `-m default.mdf`
when you want that instead.

## Limitations

Compared to the original Windows tool, this port intentionally does not
implement:

- Live playback through a CoreMIDI device (file output only)
- `.nsf::.mdf` extended m3u/pls playlist batch conversion
- XG/GS MIDI dialect output (General MIDI only)
- VRC7, MMC5, or EPSM expansion audio (the original 0.14 didn't support
  these either; if detected, a warning is printed and that channel is
  skipped)

## License

GNU General Public License v2 or later — see `LICENSE`. This project links
the [NotSoFatso](third_party/NotSoFatso/README.md) NSF playback core
(© 2004 Disch, vendored from the FamiStudio project), which is GPL-2+.
