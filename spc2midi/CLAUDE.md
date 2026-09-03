# spc2midi maintainer guide

## Scope

`spc2midi` is an arm64 macOS CLI that converts `.spc` and `.spc2` files to
MIDI through the pinned VGMTrans source. It can additionally write `.sf2` or
`.dls` instrument banks. User-facing documentation belongs in `README.md` and
`README_ja.md`; keep both aligned.

## Build invariant

`CMakeLists.txt` fetches the commit stored in `vgmtrans.pin` as
`vgmtrans_no_rsn` and applies `patches/vgmtrans-no-rsn.patch`. The patch must
continue to exclude all of the following:

- `src/main/loaders/RSNLoader.cpp`
- `lib/unarr` and its include configuration
- the `unarr` link dependency of `vgmtranscore`

There is no RSN-enabled preset, development build, test build, or release
build. Do not add one. `.rsn` input is rejected by miditrack; its ZIP support
remains independent and accepts ZIP members ending in `.spc` or `.spc2`.

Build with:

```bash
brew install cmake ninja
./build.sh
```

The VGMTrans checkout and build directory are deliberately outside the
repository under `~/.cache/spc2midi/`. The script copies only the rebuilt
`spc2midi` binary back to this directory.

## Verification

```bash
./build.sh
nm -gU spc2midi | rg 'ar_open_rar_archive' && exit 1 || true
otool -L spc2midi
./spc2midi --help
```

The resulting Mach-O may link macOS system libraries only. It must not link
Homebrew paths, `unarr`, or RAR/LZMA runtime libraries.

## Release

The root app builder copies this binary to `Contents/Helpers/spc2midi`, then
records its SHA-256 in `Resources/BUILD-MANIFEST.json`. Rebuild and validate it
before assembling a release app, because development, local installation, and
distribution intentionally use the same binary.
