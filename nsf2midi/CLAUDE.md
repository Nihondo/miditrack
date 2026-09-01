# CLAUDE.md

Guidance for AI agents and developers working on this repository.

## What this project is

A macOS (arm64) command-line reimplementation of `nsf2midi.exe` 0.14, a
Windows GUI tool that converts NES Sound Format (`.nsf`) files to Standard
MIDI Files. The original binary was a 32-bit Windows GUI executable with no
available source code and no CLI — it cannot be run on Apple Silicon macOS
(no 32-bit Wine support) and is a GUI app regardless, so it was reimplemented
from scratch rather than ported/wrapped. (The original `nsf2midi.exe`,
`gnsf.ini`, and `readme.txt` were kept briefly as a compatibility reference
during that reimplementation; their content is now fully captured in this
file and in `default.mdf` below, so they were removed from the repository.)

`default.mdf` (repo root) **is kept and is not just historical**: it is the
frozen 0.14-compatibility `.mdf` this port parses identically to the
original tool, still loadable at runtime via `-m default.mdf` (see "Added:
reproduction-fidelity pass" below for why it's no longer the *default*
`.mdf`, but it remains fully functional). Do not modify it.

## Architecture

```
third_party/NotSoFatso/   Vendored NSF playback core (GPL-2+, see its README.md)
src/
  mdf.{h,cpp}             .mdf (INI-style) parser -> ChannelConfig per slot
  channel_map.{h,cpp}     .mdf slot <-> NotSoFatso CHANNEL_* constant, based on
                          the NSF's detected expansion chip (nChipExtensions)
  pitch.{h,cpp}           STATE_PERIOD register value -> real frequency -> MIDI
                          note + cents offset, per chip type
  detector.{h,cpp}        Per-channel note-on/off state machine (the core
                          reimplementation of readme.txt §6's algorithm)
  smf.{h,cpp}             Minimal Standard MIDI File (format 1) writer
  main.cpp                CLI argument parsing + orchestration (frame loop)
```

Data flow: `main.cpp` drives `CNSFCore::RunOneFrame()` once per NSF frame,
reads `CNSFCore::GetState(channel, STATE_VOLUME/STATE_PERIOD, sub)` for every
active channel, converts to a SMF tick via a running frame-rate accumulator,
and feeds `{tick, volume, period}` into that channel's
`PitchedChannelDetector` or `RhythmChannelDetector` (`detector.h`), which
decides whether to emit note on/off/pitch-bend/CC events into that channel's
`MidiTrack` (`smf.h`).

## Why NotSoFatso

FamiStudio (github.com/BleuBleu/FamiStudio) vendors "NotSoFatso", a
Disch-authored NSF playback core (6502 CPU + APU + VRC6/VRC7/FDS/MMC5/N163/
FME-7/EPSM emulation) with a frame-stepped API perfectly suited to this
project:

- `CNSFFile::LoadFile()` parses NESM/NSFE headers (title, chip extensions,
  PAL/NTSC, track times).
- `CNSFCore::RunOneFrame()` executes exactly one PLAY-routine call.
- `CNSFCore::GetState(channel, state, sub)` reads a channel's volume/period
  *after* that frame — the exact data readme.txt §6 says the original tool
  uses for note-on detection (frequency-change detection, level-change
  detection, minimum-level threshold).

Only the emulation core files are vendored (see
`third_party/NotSoFatso/README.md` for the exact list and what was dropped).
It is built directly into the `nsf2midi` binary (no dylib/FFI) as C++14
(the vendored code uses the pre-C++17 `register` keyword) alongside our own
C++17 sources (see Makefile's `NSF_CXXSTD` vs `APP_CXXSTD`).

## Design notes / where behavior is inferred rather than known

The original `nsf2midi.exe` binary's internal algorithms are not
recoverable (no source, and reverse-engineering a stripped/UPX-packed 32-bit
GUI binary was judged not worth the effort vs. treating `readme.txt` §6 and
`default.mdf`'s parameter names as the spec). Where the spec is silent, this
port makes a documented, defensible choice rather than guessing silently:

- **Frequency-to-note formulas** (`pitch.cpp`): standard NESdev-documented
  divisors. The APU pulse/triangle divisor (`clk / (16*(P+1))` and
  `clk / (32*(P+1))`) was cross-checked against
  `third_party/NotSoFatso/Wave_Square.h`'s `ClockMajor()` (uses
  `nFreqTimer.W + 1` as the period count). FDS/N163/S5B formulas are the
  well-known NESdev wiki equations; VRC6 pulse/saw are the corresponding
  4-bit/6-bit envelope duty analogues.
- **Playback rate**: this vendored NotSoFatso build always uses the
  standard NTSC (60.098814 Hz) or PAL (50.006982 Hz) NMI rate
  (`SetPlaybackSpeed(0)` -> `fNSFPlaybackSpeed`), not a custom per-NSF
  speed byte — see `NSF_Core.cpp` around `SetPlaybackSpeed()`. This is
  simpler and matches how FamiStudio itself plays these files.
- **Noise/PCM as GM rhythm channels**: readme.txt §6 says "ノイズとPCMは
  リズム音色" (Noise and PCM use rhythm timbres). This port fixes them to
  MIDI channel 10 (GM drum channel) and uses `.mdf`'s `Instrument` value
  directly as the GM drum note number, rather than modulating pitch (GM
  channel 10 has no meaningful pitch bend across a drum kit).
- **DPCM triggering**: `STATE_DPCMSAMPLELENGTH` returns a nonzero value only
  on the frame a sample starts (the flag is consumed on read — see
  `NsfCoreFile::GetState` in the vendored `NSF_Core.cpp`). This port treats
  that edge as the note-on trigger directly, rather than running it through
  the generic amplitude-threshold detector used by pitched channels.
- **Unsupported expansion chips**: the original 0.14 only supports APU +
  VRC6 + FDS + FME-7 + N106 (see `readme.txt` §2). VRC7/MMC5/EPSM are
  detected (`channel_map.cpp: UnsupportedChipName`) and warned about, but
  not converted — matching the original's feature scope rather than
  silently degrading.

If you need to change note-on detection behavior, read `readme.txt` §6
first and keep `detector.cpp`'s comments (which quote the relevant readme
passage) in sync with the code.

## Build

```
make clean && make        # -> ./nsf2midi (arm64 Mach-O, no external deps)
```

Two C++ standards are used in the same link: `NSF_CXXSTD = c++14` for
`third_party/NotSoFatso` (needs `register`), `APP_CXXSTD = c++17` for
`src/` (uses `std::optional`). See `Makefile` comments if this ever needs to
change.

## Testing

`make test` builds and runs `tests/test_detector.cpp` — a small assert-based
unit test binary covering `PitchedChannelDetector`/`RhythmChannelDetector`
directly (no CI wired up yet, but this is no longer purely manual). It drives
each detector with a sequence of `FrameState` values and writes a real `.mid`
via `SmfWriter::Save()` to a temp file, then inspects the raw output bytes
(`MidiTrack`'s event list is private, `friend`ed only to `SmfWriter` — going
through an actual file keeps the test aligned with what a real conversion
produces, rather than needing a new test-only accessor). It links only
`mdf.cpp`/`pitch.cpp`/`detector.cpp`/`smf.cpp`/`wav_writer.cpp` — no
`third_party/NotSoFatso` dependency, since tests build `FrameState` directly
instead of running a real NSF through the emulation core (this is also why
`chip_render.cpp`, which does depend on `NSF_Core.h`, has no unit test of its
own and is instead covered by the manual `--chip-wav` verification below).
See "Added: reproduction-fidelity pass" below for what it covers (noise
frequency retrigger/drum mapping, DPCM sample identity, duty-based Program
Change, Triangle defaults, and default-config backward compatibility). It
additionally covers `WavWriter` directly: header field correctness (PCM
format tag, channel count, sample rate, block align, byte rate, bits per
sample), that `Close()` correctly patches the RIFF and `data` chunk sizes
after streaming writes, that `WriteMono()` duplicates each sample to both
stereo channels, and that a zero-sample stream still produces a valid
44-byte header (the boundary `miditrack`'s own `size <= 44` failure check
relies on).

For anything that needs a real NSF file (or to spot-check detector changes
against actual game music), verify manually:

```
./nsf2midi -l some.nsf                                  # sanity-check track list/metadata
./nsf2midi -m default.mdf -t 0 -d 30 some.nsf out.mid -v # convert + watch triggers on stderr
./nsf2midi --chip-wav out.chip.wav -t 0 -d 30 some.nsf out.mid  # Noise/DPCM as real chip audio
```

Then inspect `out.mid` with `mido` (Python) — e.g. confirm `note_on`/`note_off`
counts match per track (no hanging notes), track length matches `-d`, and
`.mdf` parameter changes (`ChannelEnabled`, `Instrument`, `PitchBendEnabled`,
`AbsoluteDividedPoint`, `LevelChangeEnabled`, `MonoEnabled`) produce the
expected effect on the output. See the plan file's verification section
(`~/.claude/plans/nsf2midi-exe-mac-cli-purring-forest.md`, if still present)
for the exact commands used during initial development — in particular, when
testing threshold parameters against a specific song, verify with an
extreme value first (e.g. `AbsoluteDividedPoint=200`, above any possible
channel volume) to confirm the logic path is reachable at all, since a
mid-range value may coincidentally not cross any note's actual volume in a
short test clip.

A real regression was caught this way during development: `MonoEnabled=1`
originally emitted a `NoteOn` before conditionally skipping the paired
`NoteOff` when the retriggered note had the same pitch as before, producing
stacked `NoteOn` events with no matching `NoteOff` (readme.txt §6's "レベル
変化時検出" is explicitly for redetecting a same-pitch reattack, so retrigger
must always close the old note first). Fixed in `detector.cpp`'s mono/
portamento branch of `PitchedChannelDetector::ProcessFrame`.

A later post-implementation review (no real `.nsf` source file was available
to reproduce end-to-end, so these were reasoned through and confirmed against
the code paths directly) found two further issues, both fixed:

- **Pitch bend was never reset to center on a new note.** `ProcessFrame()`
  only ever sends `PitchBend` from the `pitch_bend_enabled && note_active_`
  branch — neither `StartNote()` nor the mono/portamento legato branch reset
  it first. A note that held a bend when it ended could leave the next
  `NoteOn` (on the same MIDI channel) sounding at the stale bent pitch until
  the next non-triggering frame sent a fresh bend. Both `StartNote()` and the
  legato retrigger branch in `ProcessFrame()` now send `PitchBend(tick,
  midi_channel_, kPitchBendCenter)` immediately before their `NoteOn`, the
  same way `vgm2midi`'s `noteOn()` resets bend before every new note.
- **`PortamentEnabled` sent CC5 (Portamento Time) but never CC65 (Portamento
  On/Off)**, without which most GM synths never apply portamento to begin
  with — `WriteHeader()` now sends `ControlChange(..., 65, 127)` alongside
  CC5 when `cfg_.portament_enabled` is set.

Also hardened `mdf.cpp`'s `ToBool()`: it previously treated anything other
than the literal string `"0"` as true, so an empty or malformed `.mdf` value
(a stray edit, e.g. `PitchBendEnabled=`) would silently enable a boolean
feature instead of failing safe. It now requires the literal `"1"` to return
true and falls back to `false` for everything else, including `"0"` and
unrecognized text. `default.mdf` is unaffected since it only ever writes
explicit `0`/`1`.

## Added: reproduction-fidelity pass — noise/DPCM/duty GM mapping, and `gm.mdf`

A follow-up pass ported vgm2midi's reproduction-fidelity work (see its own
`CLAUDE.md`) to nsf2midi: three new opt-in `.mdf` keys, a new `gm.mdf`
preset that turns them on, and one always-on bug fix. `default.mdf` (the
frozen 0.14-compatibility reference) is never edited — new behavior is
either gated behind the new keys (all default `0`, so an unmodified
`default.mdf` run is unaffected) or, in the one case below where the
existing behavior was judged an outright bug, applied as a new *default
value* rather than a hardcoded override, so an explicit `.mdf` key still
wins.

- **`NoiseDrumMapEnabled` (Noise) — periodic + LFSR-mode GM drum mapping.**
  `NoiseDrumNote(period_index, short_mode)` (`detector.cpp`, next to
  `MaxVolumeOf()`) maps `STATE_PERIOD` (0-15, smaller = faster/higher) and
  the short-LFSR-mode flag (`STATE_DUTYCYCLE` on `CHANNEL_NOISE`) to GM
  notes 42/38/45/37, matching vgm2midi's `noiseDrumNote()` note vocabulary so
  the two tools' rhythm parts sound alike. `RhythmChannelDetector` gained a
  `current_note_` member so `NoteOff` always targets whatever note is
  actually sounding — previously it recomputed a fixed `cfg_.instrument`
  note on every `NoteOff`, which only worked because the note never changed
  before this feature existed.
- **Always-on fix: `FrequencyChangeEnabled` (Noise) was parsed but never
  read.** `default.mdf`'s `NOISE-CHANNEL` section sets it to `1`, but
  `RhythmChannelDetector::ProcessFrame()` only ever checked
  `level_change_enabled` for its noise retrigger condition — a game
  alternating between two different noise periods at constant volume (e.g.
  hi-hat/snare pattern) collapsed into one sustained note instead of
  separate hits. This is a straightforward bug fix, not a new feature, so it
  applies with `default.mdf` too — the one intentional exception to "new
  behavior needs an explicit key" in this pass. `prev_noise_period_`/
  `prev_noise_short_mode_` track the previous frame's rate; a change in
  either now retriggers when `frequency_change_enabled` is set, independent
  of whether `NoiseDrumMapEnabled` changes what note that retrigger uses.
- **`PcmSampleMapEnabled` (PCM) — per-sample GM drum notes.**
  `DpcmNoteForSample(addr, length)` assigns GM notes 35-81 round-robin by
  first-seen `(STATE_DPCMSAMPLEADDR, STATE_DPCMSAMPLELENGTH)` pair, porting
  vgm2midi's `pcmNoteForSample()` scheme. The identity key is the *pair*, not
  just the address — two samples can start at the same DMA address but have
  different lengths (the previous code discarded length entirely, reducing
  `STATE_DPCMSAMPLELENGTH` to a boolean trigger flag), and using only the
  address would wrongly collapse those into one identity.
  `STATE_DPCMSAMPLELENGTH` still must be read exactly once per frame (reading
  it consumes the trigger flag — see `NSF_Core.cpp`'s `GetState()`), so
  `main.cpp`'s frame loop reads it into `FrameState::dpcm_sample_length` and
  derives the boolean trigger (`length > 0`) from that stored value instead
  of re-reading the core.
- **`DutyProgramChangeEnabled` (Square/Vrc6Pulse only) — duty-cycle GM
  Program Change.** `ProgramForDuty(kind, duty)` maps APU `STATE_DUTYCYCLE`
  (0-3 index: 12.5/25/50/75%) or VRC6's raw 0-7 duty register to GM Program
  84/81/80 (thin/bright/full). Deliberately **not** exposed on the
  `EXTENDED-CHANNEL*` slots generically — those slots are reused for
  FDS/S5B/N163/VRC6-Saw depending on the NSF's expansion chip
  (`channel_map.cpp`), none of which have a duty concept, so
  `MaybeSendDutyProgramChange()` gates on `info_.kind` (not just the config
  flag) to guarantee it's a no-op there — including VRC6-Saw, so
  `gm.mdf`'s `EXTENDED-CHANNEL3` (VRC6-Saw's slot) can safely enable the key
  without risking a spurious Program Change overwriting its Saw-specific
  `Instrument=81`. Program Change is resent only at Note On (mid-note duty
  flicker is a timbre effect, not re-sent, to avoid PC spam) and only when
  the target program actually changed since the last send
  (`last_program_sent_`, initialized from `cfg_.instrument` in
  `WriteHeader()` so the very first Note On doesn't redundantly resend the
  header's own Program Change).
- **Triangle's `STATE_VOLUME` is a linear counter, not amplitude — fixed via
  a changed *default*, not a hardcoded override.** `MdfFile`'s constructor
  now sets the Triangle slot's `level_change_enabled`/`attack_enabled`/
  `decay_enabled`/`velocity` to `false` before `Load()` runs. `default.mdf`'s
  `TRIANGELE-CHANNEL` section never wrote these keys, so the struct's
  general-purpose defaults (`true`) applied — meaning every reload of the
  7-bit linear counter (which counts down while the note sounds and jumps
  back up on reload, not the note's actual amplitude) both spuriously
  retriggered the note (crossing `RelativeDividedPoint`) and sent an
  unnatural CC11 (Expression) wobble. Implementing this as a changed
  constructor default rather than a forced override means an `.mdf` that
  explicitly sets e.g. `LevelChangeEnabled=1` on Triangle still gets it —
  `ApplyKey()` always overwrites whatever the constructor set.
- **`gm.mdf`** (new file, project root) turns all three opt-in keys on plus
  `Velocity=1` on the pitched channels (previously `0` in `default.mdf`,
  flattening all dynamics to a constant velocity) and picks GM instruments
  that fit each tone generator better than the uniform square lead:
  Triangle → GM 39 "Synth Bass 1" (`Instrument=38`), VRC6-Saw slot
  (`EXTENDED-CHANNEL3`) → GM 82 "Lead 2 (sawtooth)" (`Instrument=81`).
  `PCM-CHANNEL`'s `Velocity` key is deliberately left unset — DPCM triggers
  always call `ComputeVelocity(127)` with a hardcoded `127`
  (`RhythmChannelDetector::ProcessFrame()`), so setting `Velocity=1` there
  would have no effect; see the comment in `gm.mdf` itself.
- **`gm.mdf` is now the default `.mdf` when `-m`/`--mdf` is omitted**
  (`DefaultMdfPathNextToExecutable()` in `main.cpp`, despite its name no
  longer being fully accurate — it derives *a* default path next to the
  executable, not literally `default.mdf` — kept as-is rather than renamed,
  since it's a small, self-contained helper and the comment above it now
  states the actual behavior). `default.mdf` (the frozen 0.14-compatibility
  reference, still never edited) remains available via an explicit
  `-m default.mdf`. This means a bare `nsf2midi song.nsf` now produces the
  reproduction-fidelity output described above, not literal 0.14-parity
  output — a deliberate default change once this pass was judged to produce
  a strictly better default listening experience than the original tool's
  fixed-square-lead, flat-velocity output.
- **`DefaultMdfPathNextToExecutable()` no longer trusts `argv0` to locate
  the executable — it asks the OS directly via `_NSGetExecutablePath()`
  (macOS-only, `<mach-o/dyld.h>`).** Making `gm.mdf` the default (previous
  bullet) turned a pre-existing, previously-cosmetic gap into an actual
  regression, and the first fix attempted here (canonicalizing `argv0`
  with `std::filesystem::canonical()` to resolve a PATH symlink like
  `/opt/homebrew/bin/nsf2midi -> .../nsf2midi/nsf2midi`) turned out to be
  insufficient and was replaced. The real root cause is more fundamental
  than symlinks: when a program is located via `PATH` (the normal case for
  an installed CLI tool), the shell that `execve()`s it is not required to
  — and zsh/bash in practice do not — pass the resolved path as `argv0`.
  They pass back whatever the user typed (here, plain `nsf2midi`), which
  `canonical()` cannot resolve unless that exact string also happens to be
  a valid path relative to the current directory; confirmed concretely by
  reproducing the failure under `zsh` with the binary on `PATH` (not just
  invoked through a symlink by absolute/relative path, which — misleadingly
  — *does* pass a resolvable `argv0` and made the first fix look correct
  under that narrower test). Canonicalizing `argv0` in that PATH case
  produced `./gm.mdf` (the current-directory fallback), silently fell back
  to `warning: could not read mdf file ...; using built-in defaults`, and
  every run via `PATH` got none of this pass's reproduction-fidelity
  improvements. `ExecutablePath()` now calls `_NSGetExecutablePath()` first
  — this is independent of `argv0` and how the process was launched, and is
  the standard macOS way to solve this — and `DefaultMdfPathNextToExecutable()`
  still symlink-resolves whatever path it ends up with via
  `std::filesystem::canonical()` (falling back through `argv0` unresolved
  only if every other option fails). Reproduced and confirmed fixed against
  a real NSF run via a `PATH`-only invocation under `zsh`, matching how the
  binary is actually installed and used. The general version of this
  failure mode (a `nsf2midi` PATH symlink breaking a same-directory
  sibling-file lookup) was previously known and documented only in
  `spc2midi/CLAUDE.md`'s "why a PATH symlink is safe there but not here"
  comparison; that comment has been updated to note this is now fixed.
  `spc2midi` itself needed no change — it has no sibling data files to look
  up in the first place, so this class of bug never applied to it.

## Added: `--chip-wav` — render Noise/DPCM as real chip audio instead of GM drums

GM drum notes are a rough stand-in for the Noise and DPCM channels — a
SoundFont snare/hi-hat sounds nothing like real NES percussion. `--chip-wav
<file>` renders those two channels through the emulation core itself, at
their real chip sound, to a 16-bit/44100Hz stereo WAV. This exists so a
downstream mixdown step (currently `miditrack`, via its `chipNoise` convert
option — see its own `CLAUDE.md`) can substitute the true chip sound for
the GM-drum approximation.

- **New files**: `src/wav_writer.{h,cpp}` (a NotSoFatso-independent RIFF/WAVE
  writer; `WriteMono()` duplicates each sample to L/R so the output is
  always stereo, matching what a downstream mixer expects regardless of
  format) and `src/chip_render.{h,cpp}` (`RenderChipWav()`, the actual
  rendering logic).
- **A second, dedicated `CNSFCore` instance.** `RenderChipWav()` never calls
  `RunOneFrame()` on this instance — `GetSamples()` leaves the protected
  `pOutput` pointer dangling on return (it nulls only `pVRC7Buffer`, not
  `pOutput` — see `NSF_Core.cpp`'s end of `GetSamples()`), so interleaving
  `GetSamples()` and `RunOneFrame()` on the same core would write past the
  previous call's buffer. Mixer flags (`SetChannelOptions()`) don't affect
  6502/DMA/frame-sequencer execution, so this second core plays back an
  identical register stream to the MIDI-detection core; it is kept separate
  anyway so its `SetAdvancedOptions()` call (below) can't affect the MIDI
  path, and so the whole feature has no ordering dependency on whether MIDI
  conversion ran first.
- **All 29 mixer channels are muted except `CHANNEL_NOISE` (3) and
  `CHANNEL_DPCM` (4)**, rendered together in one pass — never as two
  separate renders added together. Noise and DPCM share one non-linear
  mixing table (`Wave_TND.h`), so summing two independently-rendered stems
  would not reproduce the real combined output; a single pass with both
  channels un-muted is the only correct way to isolate this pair.
- **DC offset / pop mitigation.** `nDMCOutput` is a 7-bit DC level, and by
  default `bHighPassEnabled`/`bDMCPopReducer` are both off
  (`CNSFCore`'s constructor). A DPCM-only stem without filtering carries a
  large DC step plus audible pops on every `$4011` write. The chip-render
  core enables `bHighPassEnabled` (at the same `nHighPassBase = 150` the
  constructor already uses elsewhere) and `bDMCPopReducer`, applied *only*
  to this second core — `bDMCPopReducer` measurably changes emulation
  (`NSF_Core.cpp`'s DMC output path), so this is a deliberate, scoped
  deviation from being bit-identical to the MIDI-detection core.
- **Sample count**: `round(total_frames * 44100 / frame_rate)`, using the
  exact `total_frames`/`frame_rate` `main()` already computed for the MIDI's
  own tick timeline — this vendored core hardcodes the play rate to
  `NTSC_NMIRATE`/`PAL_NMIRATE` regardless of the NSF header's own speed byte
  (see the "Playback rate" note above), so the WAV's real-world duration and
  the MIDI's real-world duration cannot drift apart. `GetSamples()`'s
  6502 emulation can overshoot the requested cycle count by up to one
  instruction (~7 cycles, against `fTicksPerSample ≈ 40.58`), producing one
  extra sample; the render buffer always has slack beyond the requested
  byte count, and the loop is driven off `GetSamples()`'s actual return
  value (padding with silence on a short read) rather than assuming it
  always returns exactly what was asked for.
- **`--chip-wav` also removes Noise/DPCM from the `.mid` by default** — the
  channel-enable check at `main()`'s track-building loop now works on a
  **value copy** of the `.mdf`'s `ChannelConfig` (not the const reference it
  used before), overridden to `channel_enabled = false` for
  `ChannelKind::Noise`/`ChannelKind::Dpcm` when `--chip-wav` is present and
  `--keep-chip-midi` is not. This is the default, not an opt-in, because the
  alternative — always keeping both — makes "the real chip stem plus a GM
  drum hit" the default outcome of turning this feature on, which is an
  obviously-wrong double-trigger for any downstream mixdown. `--keep-chip-midi`
  is the escape hatch for CLI users who want both (e.g. A/B comparison), and
  is a parse-time error without `--chip-wav`.
- Verified end-to-end with a synthetic hand-built NSF (SQ1 tone + Noise,
  generated the same way this project's other synthetic-fixture testing
  does): `--chip-wav` produced a non-silent, correctly-sized stereo WAV
  (`afinfo`-valid), the Noise/DPCM channels were absent from the `.mid`
  without `--keep-chip-midi` and present with it, and the
  `--keep-chip-midi`-requires-`--chip-wav` check raised the expected
  parse-time error.

## Added: `--track-metadata`/`--chip-render` — per-channel hardware selection, matching vgm2midi's sidecar design

`--chip-wav` (above) is fixed to a hardcoded Noise+DPCM stem, with no way to
pick a different channel or channel combination. This addition generalizes
the same underlying capability — `RenderChipWav()` already muted all but a
chosen set of NotSoFatso channels — into two pieces that together let
`miditrack` offer a per-track "原曲の音源" (hardware chip render) selector
for every NES channel, the same way it already does for VGM via
`vgm2midi --track-metadata` + the pinned libvgm native helper (see
`vgm2midi/CLAUDE.md`'s "Added: per-track libvgm routing").

- **`RenderChipWav()` (`src/chip_render.{h,cpp}`) now takes an arbitrary
  channel set and a raw sample count**, not a hardcoded Noise/DPCM pair and
  a `total_frames`/`frame_rate` pair to derive one from. `--chip-wav`'s own
  call site now passes `{CHANNEL_NOISE, CHANNEL_DPCM}` explicitly — the
  legacy behavior is unchanged, just expressed through the general
  mechanism instead of being hardcoded inside the render function itself.
  The DC-offset/pop mitigation (`bHighPassEnabled`/`bDMCPopReducer`) stays
  unconditionally on regardless of which channels are selected — it was
  already scoped to this dedicated render-only `CNSFCore`, and there's no
  reason a Triangle/Square-only render would need it disabled.
- **Why a single combined render pass, not one WAV per channel summed by
  ffmpeg**: `chip_render.cpp`'s existing comment already noted that
  Noise+DPCM share the non-linear TND mix table
  (`third_party/NotSoFatso/Wave_TND.h`), so rendering them separately and
  summing overshoots the real hardware level — Triangle shares that same
  table, and Square1/Square2 share their own non-linear table
  (`Wave_Square.h`). Rendering an arbitrary selected subset always as one
  pass with everything else muted (rather than N independent per-channel
  stems added together) sidesteps having to model any of those curves
  explicitly — this is the exact same reason vgm2midi's native helper
  renders a `--selection` as one combined pass instead of one stem per
  device.
- **`--track-metadata <file>`** writes a `version: 1` JSON sidecar right
  after `smf.Save()` succeeds, one entry per MIDI track in the same order
  `active` channels were added to `smf` (`src/track_metadata.{h,cpp}`,
  a from-scratch C++ writer — this project has no JSON library dependency,
  so it hand-escapes strings the same way
  `vgm2midi/native/render_stems.cpp`'s `escapeJsonString()` does):
  ```json
  { "version": 1, "sampleRate": 44100, "sampleCount": 220137,
    "tracks": [
      { "trackIndex": 1, "channel": "SQ1",
        "chipRender": { "channel": "SQ1", "groupId": "SQ1",
                         "suggestedForHardwareMix": true } },
      ...
    ] }
  ```
  `sampleCount` uses the exact same `round(total_frames * 44100 / frame_rate)`
  formula `chip_render.cpp` already used internally for `--chip-wav`, so a
  later `--chip-render` call given that same number reproduces an
  identical-length WAV. Unlike vgm2midi's sidecar (where an ambiguous
  shared physical channel — AY/SSG tone+noise, HuC6280, YM2151 noise — can
  leave `libvgm` absent for some tracks, or force several MIDI tracks to
  share one `groupId`), **every NES channel maps to exactly one MIDI
  track with no sharing**: NotSoFatso has no channel that mixes two
  logically-independent MIDI tracks into one physical output the way
  OPN/AY hardware does. `chipRender` is therefore present on every entry,
  `groupId` always equals the channel's own label (so `group_indices()` on
  the Python side is always a singleton — the group-expansion machinery
  is inherited from `libvgm.py` unchanged but is a no-op for NSF), and
  `suggestedForHardwareMix` is always `true`.
- **`--chip-render <channels> --track <n> --sample-count <n> <input.nsf>
  <output.wav>`** is a new, independent early-exit mode (parsed the same
  way `-l/--list` is) that skips `.mdf` loading, `BuildChannelList()`'s
  detector setup, and the whole MIDI-writing pipeline entirely — it loads
  the NSF, resolves `<channels>` (a comma-separated list of the same
  channel labels `--track-metadata`/MIDI track names use, e.g.
  `NOISE,PCM,TRI`) against `BuildChannelList()`'s `ChannelInfo.label` to
  get NotSoFatso channel IDs, and calls the now-generalized
  `RenderChipWav()` once. This is deliberately *not* a separate helper
  binary the way `vgm2midi_stems` is: NotSoFatso is already statically
  linked into `nsf2midi` itself (no external emulator dependency to keep
  isolated), so there's no reason to ship a second executable just to
  reach the same in-process rendering code from a lighter entry point.
  `miditrack` calls this mode fresh every time the current per-track
  hardware selection changes (see its own `nsf_chip.py`), always against
  the *original* `.nsf` file and the *same* `-t/--track` (song index) used
  at the initial conversion — unlike a VGM file, an NSF can have multiple
  tracks/songs, so the song index has to be threaded through and reissued
  explicitly (`miditrack`'s `WebSession.source_song_index`), whereas
  vgm2midi's `--selection` mode needs no equivalent because a `.vgm`/`.vgz`
  file is always exactly one song.
- **`--chip-wav`/`--keep-chip-midi` remain unchanged for CLI
  back-compat** — a user driving `nsf2midi` directly from the command line
  still gets the same fixed Noise+DPCM stem with the same flags. `miditrack`
  itself no longer requests `--chip-wav` at all (see its own `CLAUDE.md`);
  it always requests `--track-metadata` and, when a per-track hardware
  selection is active, calls `--chip-render` at render time instead.
- Verified manually end-to-end against a real synthetic multi-track NSF:
  `--track-metadata` produced a JSON sidecar with one correctly-ordered
  entry per channel (`SQ1`/`SQ2`/`TRI`/`NOISE`/`PCM`, `trackIndex` 1-5
  matching the conductor-track-is-0 convention), `--chip-render
  NOISE,PCM,TRI` and `--chip-render SQ1,SQ2` both produced correctly-sized
  WAVs at the sidecar's own `sampleCount`, the legacy `--chip-wav` path
  (now routed through the same generalized `RenderChipWav()`) still
  produced byte-identical-shaped output, and unknown-channel/missing-flag
  argument errors were confirmed at both the CLI level and through a live,
  fully non-mocked `miditrack` `create_app()` round trip (real `nsf2midi`,
  real `fluidsynth`) — including switching one track back to `soundfont`
  mid-session and re-rendering, which correctly re-enabled that track's
  volume slider while the remaining hardware-selected tracks stayed
  disabled.

## Fixed: `--chip-render` selecting FDS (or MMC5/N163/S5B) rendered silence

`RenderChipWav()` mutes all 29 NotSoFatso mixer channels and unmutes only
the selected ones via `CNSFCore::SetChannelOptions(chan, mix, ...)`
(`third_party/NotSoFatso/NSF_Core.cpp`). That function's `mix` branch used
to compute the internal mixer-flag array index as a flat `chan - 5` for
every channel above the 5 "main" ones (`SQUARE1/2`, `TRIANGLE`, `NOISE`,
`DPCM`). This is wrong: `bChannelMix[24]` is packed in the order
`EmulateAPU()`'s own mixing calls actually read it in — VRC6 (3), MMC5 (3),
N106 (8), FME-7/S5B (3), FDS (1) — while the public `CHANNEL_*` constants
(`NSF_Core.h`) are ordered VRC6 (3), VRC7FM (6), FDS (1), MMC5 (3), N163
(8), S5B (3). Only VRC6 happens to have the same starting offset in both
orderings, so `chan - 5` silently wrote to the wrong element (or, for
`CHANNEL_FDS = 14`, to `bChannelMix[9]` — the slot N163's 4th channel
actually reads) for every other expansion chip. Concretely: unmuting FDS
via `SetChannelOptions(CHANNEL_FDS, 1, ...)` never touched
`bChannelMix[23]` (the index `mWave_FDS.DoTicks()` actually checks), so FDS
stayed muted from the initial all-mute loop and rendered pure silence —
this is what a user reported as "FDS sounds missing from the original
hardware audio render" (`miditrack`'s "原曲の音源" track source, which
calls this same `--chip-render` path via `nsf_chip.py`). N163/S5B/MMC5 had
the same class of bug, just landing on different wrong indices.

Fixed by replacing the flat `default: bChannelMix[chan - 5]` with explicit
`case` ranges that map each public `CHANNEL_*`/`N163_WAVE*`/`S5B_SQUARE*`
value to the *actual* index used elsewhere in `EmulateAPU()`
(`SetChannelOptions()`'s switch statement now documents this packing order
inline). `CHANNEL_VRC7FM1-6` (8-13) is left as a no-op: VRC7 output never
goes through `bChannelMix` at all — it's mixed separately via
`VRC7_Mix()` — so this API could never mute it either before or after this
fix (`nsf2midi` doesn't expose VRC7 as a selectable channel anyway; see
`channel_map.cpp`'s `UnsupportedChipName()`). EPSM channels (`chan >= 29`)
were already rejected by this function's own early `if(chan >= 29) return;`
guard and remain so — also consistent with EPSM being unsupported here.

This is the one deliberate exception to treating `third_party/NotSoFatso`
as a frozen vendored drop: it's a straightforward upstream indexing bug in
a mixer-mute helper the original Winamp-plugin/DLL-wrapper callers
(dropped from this vendoring, see `third_party/NotSoFatso/README.md`)
apparently never exercised for anything but VRC6, so it went unnoticed
until this project's `--chip-render`/`--chip-wav` selective-mute usage hit
it. The ordinary MIDI-conversion path (`main.cpp`'s ~line 378) also calls
`SetChannelOptions()`, but only ever to unmute *every* channel
(`mix=1` for `i` in `0..28`), which this bug never affected — the flat-vs-
packed index mismatch only matters when muting/unmuting a *subset*.

Verified with a hand-built minimal NSF (`NESM` header, `nExtraChip =
EXTSOUND_FDS`, an init routine that writes a 64-byte ramp into the FDS
wave table via `$4089`/`$4040-$407F` and sets a fixed volume-envelope gain
and nonzero frequency via `$4080`/`$4082`/`$4083`, silent play routine):
`--chip-render FDS --track 0 --sample-count 44100` against the pre-fix
binary produced a WAV with peak amplitude 0 (silence, reproducing the bug
exactly); the identical command against the post-fix binary produced peak
amplitude 7812 (audible FDS output). `make test` (the existing
`tests/test_detector.cpp` suite) still passes — it never exercises
`SetChannelOptions()`.

## Fixed: FDS notes came out two octaves too high

`pitch.cpp`'s `FrequencyOf(ChannelKind::Fds, ...)` computed
`period * clk / 1048576.0` (2^20), sourced from a NESdev-wiki-style
formula per this file's own "Design notes" section above. That divisor is
wrong for what this vendored core's emulation actually does — derived from
`third_party/NotSoFatso/Wave_FDS.h`'s `DoTicks()` (the ground truth, since
`detector.cpp` reconstructs notes from *this* emulation's register/state
values, not from an independently-correct physical formula): the wave
accumulator advances one of its 64 wavetable steps every
`65536.0f / nFreq.W` CPU cycles (`freq = 65536.0f / (subfreq + nFreq.W)`,
`Wave_FDS.h`'s `DoTicks()`), so one full 64-step waveform cycle takes
`64 * 65536 / period = 4194304 / period` CPU cycles — making the real
output frequency `period * clk / 4194304` (2^22), not `/ 1048576` (2^20).
The old formula was off by a factor of exactly 4 (two octaves, 24
semitones) high for every FDS note. Fixed by changing the divisor to
`4194304.0` and documenting the derivation inline.

Verified with the same hand-built FDS test NSF used for the
`--chip-render` fix above (`$4082/$4083` frequency register set to
`0x0800` = 2048): `nsf2midi -m default.mdf -t 0 -d 2 ... -v` emitted
`note_on note=105` against the pre-fix binary and `note_on note=81`
against the post-fix binary — exactly 24 semitones apart, confirming both
the bug and the fix. `make test` still passes (no existing test exercises
FDS pitch conversion).

Also confirmed against a real game rip (`zelda.nsf`, "Zelda no Densetsu"):
`GetState(CHANNEL_FDS, STATE_PERIOD, 0)` returned `1092` for the FDS lead
in track 0, and `-v` now emits `note=70` for it (was `note=94` before this
fix — the same 24-semitone gap). Directly instrumenting
`Wave_FDS.h`'s `DoTicks()` (temporary `-DFDS_DEBUG_FREQ` build, since
removed) confirmed the emulator's own wavetable-index wraps 3841 CPU
cycles apart for `period=1092`, matching `4194304/1092 ≈ 3841.5` — i.e.
the divisor fix is exactly what the vendored emulation core itself does,
not just a NESdev-wiki formula taken on faith. User-confirmed by ear
against the real game audio: the post-fix build no longer sounds "too
high."

**Build-cache pitfall hit while debugging this**: right after landing the
divisor fix, a plain `make` (no `make clean`) linked a binary that still
computed the *old* (2^20) frequency — confirmed by disassembling
`build/app_pitch.o` and decoding the embedded FP constant
(`objdump -d` + manually decoding the `movk`-constructed immediate as an
IEEE-754 double). `app_pitch.o`'s own mtime matched `src/pitch.cpp`'s to
the second and *looked* like a correct incremental rebuild, but the
constant baked into it was stale. Root cause unconfirmed (most likely
mtime-second-granularity collision from rapid-fire `git stash`/`make`
cycles run less than a second apart while narrowing down the `--chip-render`
fix earlier in the same session), but the practical lesson: **after any
`git stash pop` (or any edit landing within the same second as a prior
build), do `make clean && make` before trusting the result** — this
codebase's `Makefile` has no header-dependency tracking either (only
`.cpp` sources are prerequisites), so a header-only change (e.g. to
`third_party/NotSoFatso/Wave_FDS.h`) silently no-ops on a plain `make`
regardless.

## Out of scope (by user decision)

- CoreMIDI live playback (the original could play through a MIDI device;
  this port only writes `.mid` files).
- m3u/pls playlist batch conversion (readme.txt §4's `nsf::mdf,...`
  extended playlist syntax).
- XG/GS MIDI dialect switching (`gnsf.ini`'s `STANDARD` key). Output is GM
  only.
