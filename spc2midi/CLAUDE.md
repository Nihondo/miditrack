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

The checkout is cached outside the repository and can outlive CMake's patch
stamp. `patches/apply_patch_if_needed.cmake` must therefore apply the pinned
patch only when its forward check succeeds; when it is already present, its
reverse check must succeed instead. Do not replace this with an unconditional
`git apply`, or a normal reconfigure will fail against a valid cached source.

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

## Shared hash-pinned real-corpus regression

The repository root's optional acceptance check uses a small, hash-pinned
selection of user-owned SPC files. The manifest is
`tests/real_corpus_cases.json`; copies under `testdata/real-corpus/` are
explicitly git-ignored. Sync and verify them with:

```bash
python3 scripts/sync_real_corpus.py --source /path/to/source-collection
python3 scripts/verify_real_corpus.py
```

The SPC cases cover Final Fantasy IV, Chrono Trigger, and Fire Emblem and
require each conversion to create more than an empty SMF header. This does not
replace `./build.sh` or normal build verification, and test data must never be
committed.

## Release

The root app builder copies this binary to `Contents/Helpers/spc2midi`, then
records its SHA-256 in `Resources/BUILD-MANIFEST.json`. Rebuild and validate it
before assembling a release app, because development, local installation, and
distribution intentionally use the same binary.
