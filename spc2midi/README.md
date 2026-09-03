# spc2midi

`spc2midi` converts Super Nintendo `.spc` and `.spc2` files to Standard MIDI
Files (`.mid`). It can also export the source instruments as SoundFont2
(`.sf2`) or DLS (`.dls`). It uses the sequence parsers from
[VGMTrans](https://github.com/vgmtrans/vgmtrans), rather than emulation.

## Supported input

- `.spc` and `.spc2` are supported and auto-detected.
- `.rsn` is deliberately unsupported. `RSNLoader` and `unarr` are excluded
  from every build, including local development, tests, and release builds.
- A ZIP file is not an input to this CLI. miditrack itself accepts ZIP uploads
  and selects contained `.spc`/`.spc2` files with its normal ZIP safety limits.

## Build

The committed arm64 binary is rebuilt with the fixed VGMTrans patch:

```bash
brew install cmake ninja
./build.sh
```

The first build downloads VGMTrans into `~/.cache/spc2midi/`. The patch at
`patches/vgmtrans-no-rsn.patch` excludes `RSNLoader.cpp`, `lib/unarr`, its
include path, and link dependency. Verify a rebuilt binary with:

```bash
nm -gU spc2midi | rg 'ar_open_rar_archive' && exit 1 || true
otool -L spc2midi
```

## Usage

```text
spc2midi [options] <input.spc> [output.mid]
```

The extension is not trusted; VGMTrans auto-detects supported SPC data.

| Option | Description |
|---|---|
| `-l, --list` | List detected sequences and exit |
| `-s, --seq <n>` | Convert a zero-based sequence (default: `0`) |
| `-a, --all` | Convert every detected sequence to an output directory |
| `--loops <n>` | Unroll an infinite loop this many times (default: `1`) |
| `--sf2` / `--dls` | Also write a SoundFont2 or DLS bank |
| `-v, --verbose` | Print VGMTrans log messages |
| `-h, --help` | Show usage |

Examples:

```bash
spc2midi song.spc song.mid
spc2midi --sf2 song.spc song.mid
mkdir out && spc2midi -a game.spc out
```

## License

spc2midi and VGMTrans are zlib-licensed. See `LICENSE` and `NOTICE.md` for
the complete, current static-link dependency list.
