# spc2midi

A macOS command-line tool that converts Super Nintendo (SNES) `.spc` sound
files to Standard MIDI Files (`.mid`), by parsing the actual sequence data
of the SNES sound driver the file was recorded from — not by emulating and
guessing. It can also export the SPC's own instrument samples as a
SoundFont2 (`.sf2`) or DLS (`.dls`) bank alongside the MIDI, so a DAW can
play the converted MIDI back with the original game's actual sound.

It is built on top of [VGMTrans](https://github.com/vgmtrans/vgmtrans)
(zlib license), which ships dedicated sequence parsers for about 20 SNES
sound driver families (Nintendo's own N-SPC, Square's AKAO, Konami's,
Rare's, Capcom's, and others). Files using an unrecognized driver are
reported as such rather than converted.

## Features

- Converts `.spc`, `.spc2`, and `.rsn` (a RAR archive of multiple `.spc`
  files, as commonly distributed by SPC archive sites) to General MIDI
  Standard MIDI Files
- Optionally exports a matching SoundFont2 (`--sf2`) and/or DLS (`--dls`)
  instrument bank built from the SPC's own BRR samples
- `--wav` also renders the output MIDI to a listenable `.wav` via the
  bundled `midi2wav` tool (fluidsynth + a General MIDI SoundFont)
- `--list` shows every sequence VGMTrans found in the file along with its
  detected driver, without converting anything
- `-a`/`--all` converts every sequence found (an `.rsn` commonly holds an
  entire game's soundtrack)
- Single arm64 binary; VGMTrans is fetched and statically linked at build
  time, not required at runtime

## Installation

A prebuilt binary is committed to this repository — just use `./spc2midi`
directly, or symlink it onto your `PATH`:

```
ln -s "/path/to/this/repo/spc2midi/spc2midi" /opt/homebrew/bin/spc2midi
```

To rebuild from source (only needed if you want a newer VGMTrans, or made
local changes):

```
brew install cmake ninja   # Qt is NOT required
./build.sh
```

The first build downloads and compiles VGMTrans into `~/.cache/spc2midi/`
(outside this repository, to avoid syncing hundreds of megabytes of build
output through Dropbox); later runs reuse that cache.

## Usage

```
spc2midi [options] <input.spc> [output.mid]
```

The input format (`.spc`, `.spc2`, or `.rsn`) is auto-detected — the file
extension is not inspected.

If `output.mid` is omitted, it defaults to the input filename with its
extension changed to `.mid`. `--sf2`/`--dls` derive their filenames from
the same base name.

### Options

| Option | Description |
|---|---|
| `-l, --list` | List every detected sequence (with driver name, track count, instrument-set count) and exit |
| `-s, --seq <n>` | Zero-based sequence index to convert (default: `0`) |
| `-a, --all` | Convert every detected sequence; `[output]` is then treated as a directory |
| `--loops <n>` | Number of times to unroll an infinite loop into the MIDI (default: `1`) |
| `--sf2` | Also write a SoundFont2 (`.sf2`) file |
| `--dls` | Also write a DLS (`.dls`) file |
| `--wav` | Also render each output MIDI to a `.wav` via `midi2wav.sh` (see the project root's `midi2wav` tool) |
| `--soundfont <file>` | SoundFont to use with `--wav` (default: `midi2wav.sh`'s own resolution) |
| `-v, --verbose` | Print VGMTrans's own log messages (info/debug level) to stderr |
| `-h, --help` | Show usage |

If a file contains more than one sequence and neither `-s` nor `-a` is
given, `spc2midi` converts sequence `0` and prints a warning listing how
many sequences were found — it will not silently write dozens of files
from a single `.rsn` archive unless you ask for `-a`.

### Examples

List what's inside an `.rsn` archive:

```
spc2midi -l chrono_trigger.rsn
```

Convert one specific song, with a matching SoundFont2:

```
spc2midi -s 12 --sf2 chrono_trigger.rsn theme.mid
```

Convert an entire soundtrack into a directory:

```
mkdir out && spc2midi -a chrono_trigger.rsn out
```

Unroll a looping song's loop section 4 times instead of just 1 pass through it:

```
spc2midi --loops 4 chrono_trigger.rsn theme.mid
```

Convert and immediately render a listenable WAV alongside the MIDI:

```
spc2midi -s 12 --wav chrono_trigger.rsn theme.mid
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | I/O error (input file unreadable, or nothing converted successfully in `-a` mode) |
| `2` | Usage error (bad/conflicting options) |
| `3` | The file was read successfully, but none of its sequences use a driver VGMTrans recognizes |

Exit code `3` is deliberately distinct from `1`, so a batch script processing
a folder of `.spc`/`.rsn` files can tell "this file isn't supported" apart
from "this file is broken."

## Limitations

- Files using a sound driver outside VGMTrans's ~20 supported SNES formats
  cannot be converted (exit code `3`, see above). There is no
  emulation-based fallback (see `CLAUDE.md`'s "Out of scope" section).
- `ConversionOptions` such as MIDI bank-select style are not exposed on the
  command line yet (only loop count, via `--loops`); other conversions use
  VGMTrans's own defaults.
- Individual BRR sample export (`--export-samples`) is not implemented.

## License

zlib license — see `LICENSE`. This project fetches and statically links
[VGMTrans](https://github.com/vgmtrans/vgmtrans) (also zlib) at build
time; see `NOTICE.md` for the full list of VGMTrans's own bundled
dependencies and their licenses, including one LGPL-3.0 component
(`unarr`, used for `.rsn` support).
