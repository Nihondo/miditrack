# CLAUDE.md

Current engineering contracts for `nsf2midi`. Keep this file limited to
durable architecture, compatibility, safety, and verification rules. Put
historical investigations and one-off measurements in `handoff.md`.

## Scope and compatibility

`nsf2midi` is an arm64 macOS CLI reimplementation of the behavior exposed by
the Windows `nsf2midi.exe` 0.14 tool. It converts NSF/NSFE playback state into
Standard MIDI files; it is not a live MIDI player or a general audio renderer.

- `README.md` and `README_ja.md` are aligned user manuals.
- `default.mdf` is the frozen original-tool compatibility preset. Do not
  modify it.
- `gm.mdf`, found next to the executable, is the default richer preset.
  `-m default.mdf` remains the explicit compatibility path.
- Keep this file in English and current; do not add design chronology here.

## Architecture

```text
third_party/NotSoFatso/   Vendored NSF CPU/APU and expansion-chip playback core.
src/main.cpp              CLI parsing, source orchestration, frame loop, output modes.
src/mdf.*                 INI-like instrument-definition parsing.
src/channel_map.*         MDF slot to emulated channel mapping and chip detection.
src/pitch.*               Emulated period to MIDI note/cents conversion.
src/detector.*            Per-channel note, note-off, bend, expression detection.
src/smf.*                 Minimal format-1 Standard MIDI writer.
src/timbre*.              First-sounding timbre snapshots and GM candidates.
src/track_metadata.*      MIDI-track to NES-channel JSON sidecar.
src/chip_render.*         Selected-chip audio render through a second playback core.
src/wav_writer.*          Streaming stereo WAV writer.
```

`main.cpp` advances `CNSFCore` one frame at a time, reads each enabled
channel's state, converts frame time to SMF ticks, and feeds it into a
pitched or rhythm detector. Keep playback, detection, MIDI writing, metadata,
and audio rendering separate; do not duplicate a detector decision in CLI
or sidecar code.

## Playback and detector invariants

- NotSoFatso is vendored and built into the executable; do not introduce a
  runtime dylib/FFI dependency. Its C++14 sources and this application's C++17
  sources intentionally compile under separate Makefile standards.
- Run detection from state observed after each PLAY frame. Use `readme.txt`
  and the current source comments as the compatibility reference when changing
  thresholds or note boundaries.
- Pitched channels emit matched note-on/note-off pairs, reset pitch bend for
  each new note, and use expression/bend for active-note changes when enabled.
  Rhythm channels use GM channel 10 and their configured drum note.
- Noise and DPCM triggering are channel-specific; do not route them through a
  pitched detector. Do not silently treat an unsupported expansion as APU.
- Supported conversion families are APU, VRC6, FDS, N163, and S5B/FME-7.
  VRC7, MMC5, and EPSM are detected and warned about rather than converted.
- Frequency conversion must match the vendored core's state representation,
  including PAL/NTSC timing and expansion-chip-specific period formulas.

## MDF, sidecars, and chip audio

`.mdf` parsing remains compatible with the original 0.14 field set. Newer
fields are optional and must retain safe defaults so existing `default.mdf`
files continue to work. An invalid boolean fails closed rather than enabling a
feature unexpectedly.

`--track-metadata` writes the JSON mapping consumed by `miditrack`. Track
indices, NES channel labels, render groups, sample count, and optional timbre
snapshots must agree with the MIDI produced in the same run. Do not report a
hardware-selectable source without a valid channel mapping.

`--chip-render` renders only metadata-labelled channels for a requested track
and sample count. `--chip-wav` is the fixed Noise+DPCM convenience stem.
Both use a separate playback core from MIDI detection, output stereo WAV, and
must not alter normal MIDI behavior. With `--chip-wav`, omit Noise/DPCM GM MIDI
by default to avoid a double-triggered mix; `--keep-chip-midi` is the explicit
override and is invalid without `--chip-wav`.

Timbre snapshots provide GM candidates for selected FDS, N163, S5B, and VRC6
channels. They are advisory metadata, not a claim to reconstruct original
waveforms, envelopes, or effects.

## Build and verification

```bash
cd nsf2midi
make clean && make
make test
./nsf2midi --help
```

Use a clean build after changing headers, vendored sources, or compiler flags;
the Makefile does not replace a complete dependency-aware build system. For a
manual source check, use `-l`, convert a bounded track with `-d`, and inspect
the MIDI/metadata output. Test hardware-render changes with `--chip-render`
or `--chip-wav`, checking that the WAV is nonempty and the selected channels
match the sidecar.

The final executable may link only macOS system libraries. Preserve the
standalone arm64 build and do not add Homebrew runtime dependencies.

## Hash-pinned real-corpus regression

The repository-level `tests/real_corpus_cases.json` pins selected user-owned
NSF ZIP members by SHA-256. Their extracted copies live only in the
git-ignored `testdata/real-corpus/` directory. Populate and verify from the
repository root:

```bash
python3 scripts/sync_real_corpus.py --source /path/to/source-collection
python3 scripts/verify_real_corpus.py
```

The NSF acceptance path converts track 0 for ten seconds, rejects header-only
MIDI, and verifies requested metadata labels. Current cases cover base APU and
FDS. It complements `make test`; music data is never committed or required by
CI.

## Out of scope

- CoreMIDI live playback.
- Extended m3u/pls batch conversion syntax.
- XG/GS output; emitted MIDI is General MIDI.
- Conversion of VRC7, MMC5, or EPSM audio channels until supported explicitly.

Run `git diff --check` before handoff. Update this file only for a changed
current contract; record historical rationale in `handoff.md`.
