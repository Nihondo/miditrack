# CLAUDE.md

Current engineering contracts for `vgm2midi`. Keep this file limited to
durable architecture, safety, support, and verification rules. Put historical
investigations, implementation narratives, and one-off measurements in
`handoff.md` rather than growing this guide.

## Scope and ownership

This vendored Node.js/TypeScript fork converts VGM/VGZ command logs to
Standard MIDI files by interpreting sound-chip register activity. It is a
heuristic converter, not a full chip emulator. It is independent of the
publishing pipeline and is used by `miditrack` as a converter boundary.

- `README.md` and `README_ja.md` are aligned user manuals.
- `NOTICE.md` records upstream origin and licensing.
- `dist/` is a committed build artifact. Rebuild it with TypeScript whenever
  `src/` changes, and include its matching output in source changes.
- Keep this document in English and current; record change history in
  `handoff.md`.

## Architecture

```text
src/vgm-parser.ts          Binary parsing, gzip handling, command boundaries, diagnostics.
src/vgm-playback.ts        Loop/duration expansion and playback preparation.
src/midi-converter.ts      Command dispatch, lifecycle, MIDI/sidecar export.
src/chips/                 Chip-specific register interpretation.
src/midi-math.ts           Shared pitch and MIDI math.
src/event-output.ts        Track/event construction and MIDI-channel policy.
src/pcm-analysis.ts        PCM-bank/range analysis and sample identity metadata.
src/vgm-chip-metadata.ts   VGM physical-channel sidecar generation.
src/stems.ts               Bundled native-helper resolution and invocation.
src/*-renderer.ts          Optional YM2612 DAC/noise WAV stem generation.
native/                    Committed arm64 libvgm helper and its build inputs.
```

`MidiConverter` owns dispatch, lifecycle, output, and genuinely cross-chip
services. A chip module owns only its register-map dispatch and chip-exclusive
state transitions. Keep cross-chip logic in shared modules rather than copying
it between handlers; do not create circular imports or turn chip modules into
alternate converter entry points.

## Parser and conversion invariants

- Preserve VGM command boundaries exactly, including unknown commands. Never
  consume an incorrect number of bytes to make an unsupported command appear
  supported.
- Record unsupported commands/chips in diagnostics. The CLI must warn about
  omitted content and must reject an output with no MIDI tracks/notes rather
  than silently emitting a header-only SMF.
- Preserve chip instance, port, clock flags, data blocks, stream commands,
  sample time, and physical-channel identity through parsing and playback.
- Loop expansion and duration targeting operate on prepared playback. Do not
  duplicate the intro, exceed an explicit duration, or invent a loop when the
  source has none.
- MIDI note boundaries follow chip key/trigger semantics. Frequency, volume,
  and timbre changes on an active note should become pitch bend/expression or
  sidecar events when appropriate, not false retriggers.
- General MIDI percussion uses channel 10. Keep channel assignment and program
  changes centralized in event-output helpers.

## Supported interpretation and deliberate limits

The chip modules currently cover SN76489, YM2612, YM2413, YM2151, YM2203,
YM2608, YM3526, YM3812, Y8950, AY8910/SSG, HuC6280, Game Boy DMG, SegaPCM,
and C140. Support means register-level MIDI inference, not bit-perfect sound
emulation.

- OPN/OPM/OPL/YM2413 timbre snapshots and events are sidecar metadata. They do
  not claim to reproduce FM envelopes, operators, effects, or patch changes in
  MIDI automation.
- PCM-oriented paths (YM2612 DAC, YM2608 ADPCM-B, MSM6258, SegaPCM, C140)
  preserve trigger timing and source/sample identity where available. They do
  not semantically classify drums or decode every PCM/ADPCM stream to MIDI.
- Noise-oriented paths use portable GM percussion approximations. HuC6280 DDA,
  stereo balance, and LFO/vibrato remain outside this MIDI-inference model.
- A VGM with multiple concurrently active chip families can exhaust 16 MIDI
  channels. Existing channel wrapping is intentional; do not promise lossless
  multi-chip channel separation without a dedicated output redesign.
- Add a chip only with parser boundaries, diagnostics, sidecar mapping where
  relevant, synthetic regression coverage, and a real-corpus case when one is
  available.

## Sidecars and native stems

`--track-metadata` writes the physical-channel mapping consumed by
`miditrack`. It must remain versioned, JSON-safe for UTF-8 labels, and
consistent with the generated MIDI track indices. Never expose an unmapped
track as a selectable hardware source.

The optional libvgm helper renders selected hardware stems. `scripts/build-native.sh`
pins its libvgm source and keeps mutable checkout/cache/build state outside the
repository; only the finished arm64 helper under `native/bin/` is committed.
`VGM2MIDI_STEMS_HELPER` may override that helper at runtime. Keep the helper
independent of the TypeScript converter and preserve offline-cache behavior.

`--dac-wav` and noise stem output are raw-audio companions, not replacement
MIDI semantics. Avoid double-triggered mixdowns: honor the corresponding
keep/remove MIDI options and let downstream `miditrack` choose sources.

## Build and test

```bash
cd vgm2midi
npm install
npm run build
npm test
```

Run the matching boundary check after native-helper changes:

```bash
npm run verify:native-stems
```

`audit:corpus` is read-only. It may inspect direct VGM/VGZ files and ZIP
entries in a mounted source corpus, but must not extract into it, modify it, or
hide parse failures. ZIP is the only archive type inspected by this command.

## Hash-pinned real-corpus regression

`tests/real_corpus_cases.json` pins a small user-owned set of VGM/VGZ, NSF,
and SPC sources by archive member and SHA-256. Extracted files belong only in
the git-ignored `testdata/real-corpus/` directory. Populate and verify it from
the repository root:

```bash
python3 scripts/sync_real_corpus.py --source /path/to/source-collection
python3 scripts/verify_real_corpus.py
```

For VGM-only verification, run `npm run test:real-corpus`; use
`REAL_CORPUS_ROOT` for a different local destination. This acceptance suite
checks hashes, expected chip diagnostics, and nonempty MIDI output. It is not
CI input and never licenses committing music. The current corpus covers
YM2203, YM2608, YM2151, C140, HuC6280, GBDMG, SN76489, YM2612, YM2413, and
SegaPCM. MSM6258 is intentionally an unsupported-content diagnostic case;
AY8910, YM3526, YM3812, and Y8950 need real cases when source material exists.

Run `git diff --check` before handoff. Update this file only for a changed
current contract; document investigation history in `handoff.md`.
