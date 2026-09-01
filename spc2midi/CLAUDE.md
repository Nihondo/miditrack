# CLAUDE.md

Guidance for AI agents and developers working on this repository.

## What this project is

A macOS (arm64) command-line tool that converts Super Nintendo (SNES) `.spc`
sound files (and `.spc2` / `.rsn` archives of multiple `.spc` files) to
Standard MIDI Files, plus optional SoundFont2 (`.sf2`) / DLS (`.dls`)
instrument banks built from the SPC's own BRR samples. Unlike its sibling
project [`nsf2midi`](../nsf2midi/CLAUDE.md), this is not a reimplementation
of a lost original tool — it is new work built directly on top of
[VGMTrans](https://github.com/vgmtrans/vgmtrans) (zlib license).

## Architecture

```
CMakeLists.txt / CMakePresets.json   FetchContent-pins VGMTrans, builds vgmtranscore
vgmtrans.pin                         commit SHA VGMTrans is pinned to (ASCII, ONE line — see below)
src/
  main.cpp                           CLI parsing + orchestration
  spc2midi_root.{h,cpp}               headless VGMRoot subclass (see naming note below)
  paths.{h,cpp}                      output filename construction
spc2midi                             committed prebuilt arm64 binary
```

`main.cpp` is intentionally thin (~280 lines): it calls
`g_root.openRawFile()`, walks `g_root.vgmColls()`, and for each `VGMColl`
calls `coll->seq()->saveAsMidi(path, coll)` / `conversion::createSF2File()`
/ `conversion::createDLSFile()`. There is no note-detection heuristic to
maintain, because VGMTrans's per-driver `SeqTrack` subclasses already parse
the exact sequence data.

**Why the files are named `spc2midi_root.*`, not `root.*`:** APFS is
case-insensitive by default. A file named `root.h` in this directory would
make `#include "Root.h"` (VGMTrans's own header, referenced from inside
that same file) resolve to *itself* via case-insensitive quoted-include
lookup, silently creating a self-include loop guarded by `#pragma once` —
`VGMRoot` would never actually get declared, and every method in the class
would fail to compile with "unknown type name". This was hit and fixed
during initial development; always pick a name that cannot collide
case-insensitively with a VGMTrans header when adding new files here.

## Why VGMTrans (vs. nsf2midi's approach)

`nsf2midi` emulates the NES APU and infers note on/off from per-frame
volume/period changes, because NES games have no common sequence-data
format — every game's driver is bespoke, so there is nothing generic to
parse. SNES effectively does have a small number of common drivers
(Nintendo's own N-SPC, Square's AKAO, Konami's, Rare's, etc.), and VGMTrans
already ships per-driver `SeqTrack` subclasses (20 SNES formats as of
v1.3) that walk that bytecode directly. Reading the actual sequence data
instead of re-deriving it from emulated register state gives exact tempo,
loop points, program numbers, and note timing — something `nsf2midi`
structurally cannot do. This is the reason spc2midi takes a completely
different implementation strategy from its sibling project rather than
porting the "emulate and observe" approach to SPC700.

## How VGMTrans is vendored

VGMTrans's own top-level `CMakeLists.txt` is pulled in via
`FetchContent_Declare(... GIT_TAG ${VGMTRANS_PIN})`, pinned to a specific
commit SHA read from `vgmtrans.pin`. `ENABLE_UI_QT` is forced off so no Qt6
install is required; `ENABLE_CLI` stays at its default (on), which also
builds VGMTrans's own `vgmtrans-cli` binary as a side effect — harmless,
and useful as a reference binary for diff-testing (see Testing below).

**Why the build tree lives outside the repo:** this repository lives in
Dropbox. A `git submodule` checkout of VGMTrans plus its own submodules
(spdlog, libchdr, zlib) would add roughly 150MB to `.git`, and every
rebuild rewrites hundreds of MB of `.o` files — both would be synced by
Dropbox on every build, which is exactly the failure mode `nsf2midi`
avoided by staying at 6 tiny vendored files. `CMakePresets.json` points
`binaryDir` and `FETCHCONTENT_BASE_DIR` at `~/.cache/spc2midi/`, so nothing
but this repo's own 4 source files, build definitions, and the final
committed binary ever touches the synced tree. `build.sh` is the only
thing that writes into the repo (one `cp` of the finished binary).

Re-pinning to a newer VGMTrans commit is a one-line change to
`vgmtrans.pin`. If VGMTrans itself ever needs to be *patched* (not just
pinned), switch `FetchContent_Declare`'s `GIT_REPOSITORY` argument to a
local `SOURCE_DIR` pointing at a real submodule checkout — that is the
only line that needs to change to move from "pinned" to "vendored".

**`vgmtrans.pin` must stay pure ASCII with no comments.** `file(STRINGS)`
in CMake behaves like the Unix `strings(1)` utility: it splits on any
non-printable/non-ASCII byte, so a Japanese comment in that file gets
silently shredded into multiple bogus list entries and `GIT_TAG` ends up
being handed a garbage fragment (this was hit and fixed during initial
development — the failure mode was `fatal: invalid reference:  SHA`, not
an obviously-wrong git ref, so it can look like a network problem, not an
encoding one). `CMakeLists.txt` reads the file with `file(READ)` +
`string(STRIP)` instead of `file(STRINGS)`, but even so, keep this file to
a single bare commit hash.

**Why the pin is v1.3, specifically:** `/Applications/VGMTrans.app` on this
machine is also v1.3. Pinning to the exact same source means spc2midi and
the GUI app call the literal same `saveAsMidi()` / `createSF2File()` /
`createDLSFile()` code, which makes byte-for-byte diff testing against the
GUI's own export meaningful (see Testing).

## Design notes

- **`conversion::saveAs<Target>()` (template-parameterized, directory-only
  output) is deliberately not used.** `--sf2`/`--dls` need a *runtime*
  on/off decision and explicit output filenames, neither of which that API
  supports. `saveAsMidi()` / `createSF2File()` / `createDLSFile()` are
  called directly instead, once per `VGMColl`.
- **`saveAsMidi()` is always called with the `coll` argument, never
  `nullptr`.** The collection carries the instrument-set association that
  feeds drum/program-number resolution; omitting it (as some example code
  online does) silently produces less accurate MIDI.
- **`--sf2`/`--dls` skip a collection whose `instrSets()` is empty**,
  warning instead of calling into `conversion::createSF2File()` /
  `createDLSFile()` with nothing to convert — this keeps a
  sequence-only capture from producing a meaningless empty bank.
- **When multiple sequences are found and neither `-s` nor `-a` was given,
  spc2midi converts index 0 and prints a warning** rather than either
  silently converting everything (an `.rsn` can hold dozens of songs — a
  bare `spc2midi foo.rsn` would otherwise flood the directory) or refusing
  to run. This mirrors `nsf2midi`'s own `-t 0` default for multi-track
  NSFs.
- **`openRawFile()` cannot distinguish "file unreadable" from "no driver
  recognized it"** — both return `false` with nothing added to
  `vgmColls()`. `main.cpp` checks `std::filesystem::is_regular_file()`,
  *and* that the path can actually be opened (`std::ifstream`), *before*
  calling `openRawFile()` specifically so these can be reported as
  different exit codes (1 vs. 3); do not remove that pre-check, the
  distinction is otherwise unrecoverable from VGMTrans's public API.
  `is_regular_file()` alone only checks the file's type — it does not
  detect a permission-denied file, which used to fall through to the
  driver-not-recognized path (exit 3) with a misleading message instead of
  the true I/O-error path (exit 1); the `ifstream` open probe added
  alongside it catches that case too.
- **`MAMELoader.cpp`'s "Failed to open MAME ROM definition JSON" is
  filtered out of non-`-v` output.** This is upstream VGMTrans noise —
  confirmed to appear identically from the official `vgmtrans-cli` binary
  for every input regardless of format, because `MAMELoader` unconditionally
  looks for `mame_roms.json` relative to the working directory. It is
  irrelevant to SPC/SPC2/RSN conversion (MAME arcade ROM support is out of
  scope here) and was confusing enough during testing that filtering it
  seemed worth the small deviation from "just pass through whatever
  VGMTrans logs." `-v` still shows it, for anyone actually debugging
  loader behavior.
- **`ConversionOptions` loop count is exposed via `--loops <n>`** (default
  `1`); `main.cpp` calls `ConversionOptions::the().setNumSequenceLoops(opt.loops)`
  once, right after `--list` handling and before any conversion. Note that
  `ConversionOptions`'s C++ member-initializer default is `0` (never enters
  a loop section at all) — only the Qt GUI's settings-load path defaults to
  `1`, since a CLI tool never calls `ConversionOptions::load()`. `--loops 1`
  reproduces that GUI default rather than the raw class default. Bank-select
  style and channel-10 skip remain untouched, using VGMTrans's own
  in-process defaults (`BankSelectStyle::GS`, skip enabled).
- **Why a PATH symlink was originally safe here, and why it once wasn't
  for `nsf2midi` either:** `nsf2midi/src/main.cpp`'s
  `DefaultMdfPathNextToExecutable()` derives the default `.mdf`'s path
  (`gm.mdf`, as of nsf2midi's reproduction-fidelity pass — see its own
  `CLAUDE.md`) from `argv[0]`'s directory. This used to *not* resolve
  symlinks first — a `/opt/homebrew/bin/nsf2midi` symlink made it look for
  `/opt/homebrew/bin/gm.mdf`, fail to find it, and silently fall back to
  built-in defaults — but was fixed once making `gm.mdf` the default turned
  this from a cosmetic gap into a real regression for anyone running the
  binary via a PATH symlink (see nsf2midi's own `CLAUDE.md` for the fix:
  `std::filesystem::canonical()` on `argv0` before taking its parent
  directory). Originally `spc2midi` was a single statically-linked binary
  with no sibling data files (its output paths were all derived from the
  *input* path, never from the executable's own location), so there was
  nothing here for a symlink to break.

### Fixed: crash on bad numeric args, silent output-directory failure, and case-collision in `--all`

A post-implementation review (no real `.spc`/`.rsn` source file was
available, so these were verified by exercising `main.cpp`'s CLI parsing and
`paths.cpp` directly rather than a full end-to-end conversion) found three
issues, all fixed:

- **`-s`/`--seq` and `--loops` crashed on a non-numeric or overflowing
  value.** `ParseArgs()` called `std::stoi()` directly on the argument text;
  `std::stoi` throws `std::invalid_argument`/`std::out_of_range` on bad
  input, and nothing caught it, so e.g. `spc2midi -s abc foo.spc` or
  `--loops 99999999999999999999` aborted with an uncaught-exception
  `SIGABRT` instead of the same clean "error: ... / usage" + exit-2 path
  every other malformed argument already gets. `ParseArgs()` now wraps this
  in a `next_int()` helper that catches the exception, also rejects
  trailing garbage after the number (`std::stoi`'s partial-parse behavior
  would otherwise silently accept `"5abc"` as `5`), and reports the same
  kind of error message before `std::exit(2)`.
- **`fs::create_directories()`'s error code was captured but never
  checked** in the `--all` path. A directory that can't be created (e.g.
  the target collides with an existing regular file, or the volume is
  read-only) let execution continue straight into the per-collection
  conversion loop, which then failed with a confusing "error: failed to
  save MIDI" instead of the real cause. `main.cpp` now checks the
  `std::error_code` immediately and exits 1 with the actual OS error
  message when directory creation fails.
- **`BuildCollectionOutputStem()`'s de-duplication (`used_stems`) compared
  names case-sensitively**, but APFS is case-insensitive by default (see
  the `spc2midi_root.*` naming note above, which hit the same class of
  issue from the other direction). Two collections whose names differ only
  in case (e.g. `"Boss Theme"` vs. `"boss theme"`) produced two distinct
  `used_stems` entries but the *same* file on disk — the second one
  silently overwrote the first with no `_2` suffix and no warning.
  `paths.cpp` now stores and compares an ASCII-lowercased key in
  `used_stems` while still returning the candidate with its original
  casing intact, so the second collection correctly gets suffixed.

## Build

```
brew install cmake ninja   # Qt is NOT required — ENABLE_UI_QT is forced off
./build.sh                 # -> ./spc2midi (arm64 Mach-O)
./build.sh --clean         # remove the cached build tree (keeps downloaded VGMTrans source)
```

A prebuilt binary is committed, so most users never need to run this.

The binary is not perfectly dependency-free the way `nsf2midi` is: `otool
-L` shows `/usr/lib/liblzma.5.dylib` in addition to `libc++`/`libSystem`
(pulled in transitively by `unarr` for LZMA-compressed RAR entries inside
`.rsn` files). `liblzma` ships with every macOS install, so this is not an
installation burden, just worth knowing about — see `NOTICE.md`.

## Testing

There is no automated test suite (matching `nsf2midi`'s own approach — see
its `CLAUDE.md` for the rationale). Manual verification:

```
./spc2midi -l some.spc                          # sanity-check detected sequences
./spc2midi -s 0 --sf2 --dls some.spc out.mid -v  # convert + watch scanner trace on stderr
```

**Byte-identical diff testing against the GUI app is the strongest
available check**, and only works because `vgmtrans.pin` is kept in sync
with the installed `/Applications/VGMTrans.app` version (see above):
export the same collection from the GUI app and `cmp` the two `.mid`
files — they should match exactly. `.sf2`/`.dls` will differ only in the
embedded `ICRD` (creation-date) RIFF chunk timestamp; every other byte,
including all instrument/sample data, should be identical. A mismatch
anywhere else means something in `main.cpp`'s call sequence has drifted
from what the reference implementation (`src/ui/cli/CLIVGMRoot.cpp` in the
pinned VGMTrans source) does.

### Confirmed driver coverage (informal, grows over time)

Verified against real `.rsn` archives from snesmusic.org, with `.mid`/`.dls`
byte-identical to `vgmtrans-cli`'s own output for the same title:

| Driver | Title | Sequences found |
|---|---|---|
| NinSnes (N-SPC) | Super Mario World | 65 |
| AkaoSnes | Final Fantasy VI | 82 |
| AkaoSnes | Chrono Trigger | 91 |

The other ~17 SNES formats VGMTrans supports (KonamiSnes, RareSnes,
CapcomSnes, SuzukiSnes, HudsonSnes, and others — see VGMTrans's
`src/main/formats/` for the full list) have not been individually
exercised yet; `--list` on a candidate `.spc`/`.rsn` reports the detected
`driver=` name, so extending this table is just a matter of trying more
titles.

## Out of scope (for now)

- **Emulation-based fallback** for SPC files whose driver VGMTrans doesn't
  recognize (the `nsf2midi` approach — run SPC700+DSP, watch `KON`/`KOF`/
  `PITCH`/`SRCN` registers, infer notes). `main.cpp`'s
  `colls.empty()` branch has a 3-line comment marking where this would
  hook in. Worth doing only if the confirmed-coverage table above turns
  out to have large gaps against songs actually being used.
- **`--export-samples`** (individual BRR sample export via
  `conversion::saveAllAsWav()`) — not wired up; would be a small addition
  if needed.
- **Remaining `ConversionOptions` CLI flags** (`--bank-select`,
  `--no-skip-ch10`) — `--loops` is now wired up (see Design notes above);
  the other two are one-line API calls each but have no CLI surface yet.
- **`.chd` / `.cue` / MAME arcade formats** VGMTrans also supports — out of
  scope; this tool's usage/help text only advertises `.spc`/`.spc2`/`.rsn`.
