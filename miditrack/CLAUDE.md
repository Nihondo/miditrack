# CLAUDE.md

Guidance for AI agents and developers working on this repository.

## What this project is

A local Web tool (Flask backend, vanilla JS/CSS frontend, no CDN) that lets a
user convert a chiptune source file to MIDI, assign a General MIDI
instrument (Program Change) and volume to each track, and audition the result. It
exists downstream of `nsf2midi`/`spc2midi`/`vgm2midi` — all three write MIDI
but offer no way to go back and pick a different instrument afterward, and
none has its own Web UI. `miditrack` is a general-purpose Standard MIDI File
editor plus a thin Web front end for those three CLIs; it does not change
how any of the three converters themselves work, and it does not know
anything about the YouTube publishing pipeline the rest of this repository
serves.

## Architecture

```
miditrack.sh              PATH-symlinkable launcher (copy of note_ext.sh's structure)
pyproject.toml             src-layout + console_script (mirrors note_ext/pyproject.toml)
src/miditrack/
  cli.py                   argparse entry point, launches the web server
  errors.py                MidiTrackError / WebValidationError / RenderError / ConvertError /
                            PitchShiftError / MixError
  gm.py                    the 128-name GM table + 16 families (single source of truth)
  midi.py                  track analysis, apply/save program changes and velocity-based volume
  pianoroll.py             read-only note/tempo extraction for the browser piano roll
  render.py                midi2wav.sh resolution + safe subprocess invocation
  convert.py               nsf2midi/spc2midi/vgm2midi resolution, -l parsing, safe invocation,
                            ZIP extraction (zip-slip guarded), gme-format m3u playlist parsing
  pitch_shift.py           pitch_shift.sh resolution + safe subprocess invocation, used only
                            to keep a chipNoise stem in sync with a MIDI-layer transform
                            (speed/pitch option validation itself lives in midi.py)
  mix.py                   ffmpeg resolution + safe subprocess invocation, mixes an NSF/VGM
                            hardware-noise stem into the fluidsynth render
  libvgm.py                validates VGM track/channel sidecars and invokes the pinned native
                            helper for a selected physical-channel mix
  preferences.py           favorite-instrument shortlist (pinned/usage) and the last-selected
                            SoundFont, persisted to ~/Library/Application Support/miditrack/
                            preferences.json
  web.py                   create_app() / run_server() (tools/pixelart_web.py shape)
  web_assets/               index.html / app.css / app.js
tests/                      unittest suite, no real fluidsynth/mido/converter subprocess calls
```

## Why the piano roll is independent from rendering and track sorting

`GET /api/pianoroll` always re-reads `WebSession.original_path` and applies the
session's speed/transpose analytically. It must not use `applied_path`,
`audio_path`, assignments, volume, selected per-track sources, or the SoundFont:
the roll is intentionally available before the first render and survives every
render invalidation. Tempo events from all MIDI tracks form one global tempo
map; note pairing remains track-local because different tracks may share a MIDI
channel. The response uses a server-described flat note schema (`stride` plus
`fields`) and caps the globally earliest notes at 20,000 to bound response size.

The browser caches the static note/grid layer in an offscreen canvas. Playback
updates copy that layer and draw only the playhead, avoiding a full redraw of up
to 20,000 notes on every `<audio>` `timeupdate`. Canvas resolution follows the
device-pixel `ResizeObserver` size, while pointer coordinates remain in CSS
pixels. Seeking is also keyboard-accessible through the focusable slider-style
canvas. Muting only triggers a local static-layer redraw at lower opacity; it
must not fetch `/api/pianoroll` again.

The dedicated playback buttons above the piano roll must call the same helpers
as the global keyboard shortcuts: one-second back/forward matches Arrow
Left/Right, return-to-start matches Home or Command+Left, and play/pause matches
Space. Playback events (`play`, `pause`, `ended`, and media reset/load events)
must update the toggle icon and disabled states, regardless of whether the
action came from a button, shortcut, or piano-roll seek.
Present those buttons as two segmented pairs — back/forward and
return-to-start/play-pause — using the same height, border, separators,
background, and focus treatment as `.compact-stepper`. The start icon must use
a filled vertical bar so it remains visibly `|◀` with fill-only SVG styling.
The native `<audio>` element remains the playback engine but is hidden. The
custom media group sits immediately after the segmented playback buttons in
the audition toolbar and owns elapsed/total time, a native range-based volume
control, and a mute toggle; its state must follow media events. The timer uses
the locally bundled DSEG7 Classic WOFF2 (with its OFL license), displays tenths
as `mm:ss.t`, and runs its animation-frame refresh only while media is playing.
Keep a tabular monospace fallback and fixed timer width so font swapping cannot
shift adjacent controls. MIDI/WAV download buttons remain below the piano roll.

The SoundFont select and adjacent Apply & Audition button retain their standard
`.program-select` and `.button` heights. Center them vertically; do not stretch
either control to make their outer boxes equal.

Track colors have one browser-side source of truth: `getTrackColor(track.index,
trackCount, opacity)`. Both the note rectangles and the color marker preceding
each track name must use it, so sorting rows cannot break the visual mapping.
Piano-roll time-axis zoom changes the canvas CSS inline size through fixed zoom
steps and relies on the surrounding native horizontal scroll container. The
`ResizeObserver` rebuilds the device-pixel backing store at each size, and seek
coordinates continue to use the canvas's full scrolled `getBoundingClientRect()`;
do not map pointer positions against the visible scroll viewport instead.
Playback that begins at zero enables auto-follow. The viewport remains at the
start until the playhead reaches its midpoint, then scrolls to keep the
playhead centered. Wheel, pointer, touch, scrollbar, or other manual horizontal
scroll intent disables auto-follow; pausing and resuming must not silently
re-enable it, while returning to zero and starting playback does.
The ordinary total-note count is intentionally not shown below the roll; the
status line is reserved for truncation and load errors, so do not restore a
plain `N notes` status when changing the piano-roll payload or rendering code.

Track-column sorting is display-only. `state.session.tracks` remains in original
MIDI order and `sortedTracks()` sorts a copy for rendering. All edits, solo
audition, warning controls, and server payloads continue to identify rows by
`track.index`. A change to sorting must never reorder the session array or the
MIDI/WAV output. Channel-less tracks stay last in both sort directions.

Track rows have a fixed 52px block size. Long track names and lock reasons must
stay on one line and use visual ellipsis rather than increasing the row height;
their complete DOM text remains available to assistive technology. A track with
multiple Program Changes uses an in-row ⚠ button and a `popover="manual"`
tooltip, never a second warning `<tr>`. The button's `aria-describedby` points
to the full warning, and hover, focus, and touch/click focus all expose the same
top-layer Popover so horizontal table scrolling cannot clip it.

## Why render-then-play, not a live softsynth

(This section covers the audition/render step — MIDI in, WAV out. The
separate "convert a source file to MIDI" step, added later, is described
under "Why source-file conversion lives in `miditrack`, not in each CLI"
below; that step doesn't touch fluidsynth at all.)

The obvious "better" UX would be live playback that updates instantly as
you change a dropdown. That needs either a real-time softsynth driven from
the browser (a vendored WebAssembly/JS SoundFont synthesizer — nothing like
that exists anywhere in this repo) or a persistent backend audio process
with seek support (fluidsynth's player API, driven via ctypes/ctypes
bindings, with its own lifecycle to manage). Both are substantial new
engineering surface for a tool whose actual requirement, as stated by the
user, was "pseudo-playback... at least the ability to change playback
position" — not real-time interactivity.

`miditrack` instead applies the chosen Program Changes to a working-copy
`.mid`, renders it to a `.wav` via [midi2wav.sh](../midi2wav.sh) (the same
`fluidsynth` wrapper `nsf2midi`/`spc2midi`/`vgm2midi`'s own `--wav` option
already uses), and serves that WAV to an `<audio>` element with
`send_file(..., conditional=True)` — which gives real HTTP Range/seek
support for free, the same technique `tools/make_videos_web.py` already
uses for video/audio scrubbing. This is deliberately "boring": it reuses
existing, tested infrastructure instead of adding a new audio-synthesis
dependency, at the cost of needing an explicit "Apply & Audition" click
per change rather than instant feedback. For a chiptune-length source
(seconds to a few minutes), `fluidsynth -F` (fast, non-realtime render)
completes in well under a second in practice, so the click-to-hear latency
is small.

Every completed render receives a process-lifetime-monotonic `render_id`,
which appears in both `render-NNNN.wav` and `/api/audio?v=N`. MIDI re-conversion,
plain MIDI replacement, source-file switching, and `WebSession.clear()` must
invalidate the current `audio_path` without resetting that counter. Reusing
`v=1` after a re-conversion lets an `<audio>` element reuse byte ranges cached
for the previous WAV even though the server has replaced the file. A process
restart may safely begin at zero because the launch authentication token in
the media URL changes at the same time.

## Why WAV became a real download, not just an `<audio>` preview

The tool originally only let a user download the edited `.mid` — the
rendered `.wav` existed solely as `web_session.audio_path`, a session-temp
file that `WebSession.clear()`/process exit deletes. That made sense when
the WAV was purely a preview of the MIDI edits, but once source-file
conversion made `miditrack` cover the whole pipeline end-to-end, the
rendered WAV became a real deliverable a user would want to keep (e.g. to
drop into `make_videos.sh`'s working directory as the song's `*.wav`), not
just something to audition and discard.

`GET /api/download/wav` is deliberately symmetric with the existing
`GET /api/download` (MIDI): both call a shared `ensure_*()` helper that
performs the underlying work only if it hasn't already happened (apply
assignments; render), rather than unconditionally redoing it. `ensure_applied()`
and `ensure_render()` were extracted specifically so `POST /api/render`,
`GET /api/download`, and `GET /api/download/wav` share one implementation of
"has this already happened for the current assignments" instead of three
copies that could drift — `WebSession.invalidate_render()` already clears
`applied_path`/`apply_summary`/`audio_path` together on every assignment or
SoundFont change, so "not yet applied" and "assignments changed since the
last apply" are the same condition, and `ensure_applied()`/`ensure_render()`
only need to check for `None`. `POST /api/render` itself still calls
`invalidate_render()` unconditionally before `ensure_render()`, because a
user clicking "適用して試聴" again should always regenerate — even when
nothing changed — the same way it always did before this refactor.

The WAV download endpoint intentionally does **not** accept a query-string
token the way `GET /api/audio` does: that exception exists only because
`<audio src>` cannot set a custom header, and a WAV download is always
initiated by `fetch()` from `app.js`, which can set
`X-Miditrack-Token` like every other API call. `tests/test_web.py` asserts
this the same way it already did for `/api/download`.

## Why `midi2wav.sh`, and why the subprocess call never goes through a shell

`render.py` shells out to the project-root `midi2wav.sh` rather than
calling `fluidsynth` directly, for the same reason `nsf2midi`/`spc2midi`/
`vgm2midi`'s own `--wav` option does: SoundFont discovery and fluidsynth's
option-ordering quirk (`fluidsynth`'s CLI requires
`[options] [soundfonts] [midifiles]` — `-F`/`-T`/`-r` must precede the
positional SoundFont/MIDI paths) live in exactly one place, reused by four
callers now instead of three.

This repository's own directory path —
`.../Chill & Relax GAME MUSIC/...` — contains a space and an `&`. Any
shell-interpolated command (a manually built string, `shell=True`) breaks
on that path; worse, an unescaped `&` backgrounds the command silently
rather than raising an error. `render.render_wav()` therefore calls
`subprocess.run(argv, shell=False, ...)` with an explicit `list[str]`
argv, exactly mirroring `nsf2midi/src/midi2wav.cpp`'s `posix_spawn()` and
`vgm2midi/src/midi2wav.ts`'s `spawnSync(bin, args, { stdio: 'inherit' })`
(Node's default `shell: false`). `resolve_midi2wav_bin()` is the Python
transcription of `nsf2midi/src/midi2wav.cpp`'s `ResolveMidi2WavBin()`:
`MIDI2WAV_BIN` env var (fatal if set but not executable — no silent
fallback) → the `midi2wav.sh` found relative to this package's own
resolved location (`Path(__file__).resolve().parents[3]`, i.e. three
directories up from `src/miditrack/render.py` to the repo root) → a bare
`"midi2wav"` on `PATH` (letting `subprocess.run()`'s own PATH search
resolve it, still without invoking a shell).

## Why `pitch_shift.py` still exists — only for chip-stem sync, not for batch variations

`src/miditrack/pitch_shift.py` originally implemented the entire "batch
variations" feature: generate every combination of speed × pitch as
separate WAVs via `rubberband`, by running `pitch_shift.sh` against the
rendered WAV. That feature has since been replaced by the MIDI-layer batch
described below — the module now survives purely to let
`web._synced_stem()` keep a `chipNoise` stem (real recorded audio, not
MIDI) in sync with a non-default speed/transpose. Do not delete this
module: `_synced_stem()` has no MIDI-layer substitute, since scaling a
tempo meta or shifting a note number does nothing to a `.wav`.

`resolve_pitch_shift_bin()` uses the same resolution order every other
`resolve_*_bin()` in this package follows (`PITCH_SHIFT_BIN` env var, fatal
if set but not executable → the script found relative to this package's
own resolved repo root → a bare `"pitch_shift.sh"` on `PATH`), and
`run_pitch_shift()` calls `subprocess.run(argv, shell=False, cwd=work_dir,
...)` with an explicit `list[str]` argv, for the same reason `render.py`
never shells out: this repository's own path contains a space and an `&`.

**Why `run_pitch_shift()` diffs `work_dir`'s `*.wav` files before/after the
subprocess call, rather than constructing the expected output filenames
itself**: `pitch_shift.sh` builds each output name as
`${STEM}_x${s}_p${p}.wav` using the *literal string* passed to `-s`/`-p`
in its own shell arithmetic (awk formatting only affects the internal tempo
ratio, not the filename). Reconstructing that exact string formatting in
Python to predict filenames would be a second, drift-prone implementation
of `pitch_shift.sh`'s own naming logic. Listing what's actually on disk
after the run is both simpler and correct by construction. This matters
less now than it did for the old batch feature — `_synced_stem()` always
calls with a single-element `[speed]`/`[transpose]` list, so the diff
always yields exactly one file — but the guard against mistaking a
leftover `.wav` for freshly generated output is still worth keeping, since
`work_dir` here is a fresh `render-NNNN.stemsync/` directory rather than a
long-lived one.

## Speed/pitch is a MIDI-layer edit — one control, one batch, sharing one render path

`miditrack` has the actual MIDI, so a speed change is "divide every tempo
meta by the ratio" and a pitch change is "add semitones to note numbers" —
no time-stretch DSP, no artifacts, and the result is reflected in the
downloadable `.mid` too, which is useful for taking the transposed/retimed
arrangement into a DAW. `WebSession` carries one `speed_ratio`/
`transpose_semitones` pair per session (not per track, unlike instrument/
volume) and `PATCH /api/session/transform` sets them, independent of
`PATCH /api/session/tracks` for the same reason `POST /api/soundfont` is
its own endpoint: it is an orthogonal axis, not a per-track edit.

The single-value speed/pitch controls live at the inline end of the playback-
control row above the piano roll. Each is a
compact segmented − / editable number / ＋ stepper sharing the piano-roll zoom
control's visual language. Keep the native number inputs and their existing
`transform-speed`/`transform-transpose` IDs: keyboard entry and the debounced
`PATCH /api/session/transform` path remain the source of truth, while the
flanking buttons only call `stepUp()`/`stepDown()` and dispatch `input`. The
bulk-variation fields stay in a native `<details>` disclosure below the player,
collapsed by default; moving the single-value controls must not couple those two
settings or payloads.

`POST /api/variations` generates every combination of a speed list × a
transpose list the same way — by writing each combination's own MIDI and
rendering it — rather than post-processing the previewed WAV with
`rubberband` (the feature's original implementation, described in the
section above). This eliminates the DSP artifacts and audio-only output of
the old approach, and lets one control (`_apply_to()` + rendering) serve
both the single-value control and the batch, instead of maintaining two
separate mechanisms with two separate UIs.

**Why `ensure_render()` was split into a locked wrapper and an unlocked
body (`_render_applied_midi()`)**: the batch endpoint needs to render N
combinations without going through `ensure_render()` itself, for three
concrete reasons, each of which was a real blocker during design:
`WebSession.render_lock` is not reentrant, so calling `ensure_render()`
from inside a loop that already holds it would deadlock; `ensure_render()`
has an early-return that reuses the existing `audio_path` once rendered
once, which would make every iteration after the first a no-op; and
`ensure_render()` unlinks the *previous* `audio_path` after rendering a new
one, which would delete the previous iteration's own output from under it.
`_render_applied_midi(applied_path, wav_path, *, render_id, speed,
transpose, chip_render_stem=None)` is the actual rendering body (job
planning, stem sync, mixing) with no opinion about locking, the current
session's `audio_path`, or `render_id` bookkeeping — those three concerns
now live solely in the thin `ensure_render()` wrapper, which the batch
endpoint never calls. The batch instead takes `render_lock` itself, once,
for the whole loop, and calls `_render_applied_midi()` directly per
combination with its own dedicated output path — never touching
`audio_path`, so the existing audition render survives a batch run intact.

**Why `_apply_to()`/`_has_transform()`/`_synced_stem()` take speed/transpose
as arguments instead of temporarily writing them onto `WebSession`**: the
server runs `make_server(..., threaded=True)`, so a batch request that
temporarily overwrote `web_session.speed_ratio`/`transpose_semitones`
while iterating would let a concurrent `GET /api/session` observe a value
that was never actually the session's own setting — a real, user-visible
bug, not just a style preference. A `try`/`finally` restore would paper
over the read-observability problem while adding "restore path must never
be skipped by any exception" as a new invariant to maintain. Passing both
values as plain arguments through `_apply_to()` → `_render_applied_midi()`
→ `_has_transform()`/`_synced_stem()` means the batch never mutates session
state at all, so there is nothing to restore and no window where a
concurrent reader could observe a wrong value.

**Why each variation's MIDI is written to its own path, never
`miditrack_edited.mid`**: that fixed name is `ensure_applied()`'s own
output — the one `/api/download` returns — and is keyed to the *session's*
speed/transpose, not any one batch combination's. `_apply_to()` takes an
explicit `output_path`, so the batch writes each combination to
`variations_work/{name}_x{speed}_p{transpose}.mid` and leaves
`applied_path`/`apply_summary` completely untouched. This is what makes
`test_variations_do_not_change_session_speed_and_transpose` pass: `/api/
download` keeps returning the session's own transform after a batch run,
never the last combination's.

**Why the chip-hardware render is generated once per batch, not once per
combination**: `_render_chip_hardware()` (VGM `libvgm`/NSF `nsf2midi
--chip-render`) depends only on which channels are selected for hardware
playback — never on speed/transpose, which only affects `_synced_stem()`'s
post-processing of that same stem afterward. `POST /api/variations` calls
it exactly once before the loop and passes the result into
`_render_applied_midi(..., chip_render_stem=shared)` for every
combination; `_render_applied_midi()` only owns (and cleans up) the stem
it generated itself, so passing one in makes the caller responsible for it
instead. This avoids re-running an emulation pass (a cost comparable to
the fluidsynth render itself) N times for output that would be byte-
identical each time.

**Why the combination cap dropped from 40 to `MAX_VARIATION_COUNT = 15`**:
the old cap modeled "how many `rubberband` subprocesses is reasonable to
launch from one WAV," where the shipped default (originally 2 speeds × 5
transposes = 10) left headroom to spare. One combination is now a full
`apply_assignments()` + fluidsynth render (and possibly an `ffmpeg` mix and
a `rubberband` stem sync), each costing roughly what a single "Apply &
Audition" click costs — and the whole batch holds `render_lock` for its
entire duration, blocking any concurrent render. The cap was chosen to sit
just above the shipped default, not as a measurement of any hard resource
limit; when `DEFAULT_VARIATION_SPEEDS` grew from `[1.2, 0.8]` to
`[1.2, 1.0, 0.8]` (adding the unmodified-speed case so a user doesn't have
to also request a plain `1.0` pass separately) the default combination
count became 3×5=15, so the cap moved from 12 to 15 in lockstep — it must
never sit below whatever the shipped defaults themselves produce.

**Why the ZIP's MIDI files are optional (`includeMidi`, default `true`)**:
every combination's `.mid` is still always generated — `_apply_to()`
writes it because `_render_applied_midi()` needs it as the render source,
not because the ZIP wants it — but bundling it into the ZIP is now
conditional. Some users want the `.mid` files (to drop the
transposed/retimed arrangement straight into a DAW, the same reasoning
"Why speed/pitch is a MIDI-layer edit" gives for the single-value control),
while others just want to audition or distribute a batch of WAVs and would
rather the ZIP not double in file count for files they'll never open.
`variations_endpoint()` validates `includeMidi` as a plain `bool` (rejecting
anything else, same posture as every other boolean-shaped request field in
this codebase) and simply skips the `archive.write(mid_out, ...)` call per
combination when it's `false` — the `.mid` file itself is still written to
`variations_work/` and still deleted by the `finally` block regardless, so
this flag only ever affects what ends up inside the ZIP, never how many
files `_render_applied_midi()` produces. Each `items[]` entry's `"mid"`
field is `null` when `includeMidi` is `false`, rather than still naming a
file that isn't actually in the ZIP — the API response should never claim
something exists that a client fetching `/api/download/variations` won't
actually find there.

**Why `variations_zip_path` shares `audio_path`'s invalidation
lifecycle, but for a different reason than before**: the field (renamed
from `pitch_shift_zip_path`) is still cleared at the same two points —
`invalidate_render()` and `reset_midi_state()` — but no longer because it
is a derivative of `audio_path`; the batch never touches `audio_path` at
all. It shares the lifecycle because it is a derivative of the *same
inputs* `ensure_render()` itself depends on (assignments, volumes,
track_sources, the effective SoundFont) — any edit that would invalidate a
fresh audition render equally invalidates a previously-generated
variations ZIP, since re-running the batch against those same inputs would
produce different files.

**Why tempo is scaled, not replaced**: `apply_assignments()` divides every
existing `set_tempo` meta message's `tempo` (microseconds/quarter note) by
`speed` and clamps to `MIN_TEMPO_MICROSECONDS`/`MAX_TEMPO_MICROSECONDS`
(1 and `0xFFFFFF`, the field's actual 3-byte range) rather than trying to
compute an absolute BPM — this handles all three converters uniformly:
`nsf2midi`/`vgm2midi` each write exactly one tempo meta at tick 0,
`spc2midi` (via VGMTrans) can write tempo changes mid-song, and dividing
every one of them by the same ratio preserves whatever tempo curve was
already there. A file with no tempo meta at all gets one inserted at
`tracks[0]`'s head with `time=0` (same "insert with zero duration so no
downstream tick moves" trick `apply_assignments()` already uses for a
missing Program Change), seeded from `DEFAULT_TEMPO_MICROSECONDS` (500,000
µs = the SMF-implied 120 BPM used when a file carries no tempo meta at
all).

**Why out-of-range notes are dropped, not clamped, after transposition**:
clamping `note + semitones` into 0-127 would silently fold a high melody
line down an octave or more, changing which pitch is heard rather than
just shifting it — a worse outcome than the note simply not sounding.
`_transpose_track()` reuses `midi.py`'s own `_filter_track()` (the same
helper `write_track_subset()` uses to drop a whole track's messages while
carrying delta-time forward) to remove any `note_on`/`note_off`/
`polytouch` whose transposed note falls outside 0-127. Because `note_on`
and its matching `note_off` carry the identical note number, both members
of a pair are dropped together — never a stuck/hung note. `PERCUSSION_CHANNEL`
(ch10) is skipped entirely by the same predicate, before the range check
ever runs, for the same reason `apply_assignments()` never offers a
Program Change dropdown for a percussion track: GM drum note numbers pick
*which drum*, not a pitch, so shifting them would swap kick for snare
rather than transposing anything.

**Why real chip-noise/DAC stems get pitch-shifted through `pitch_shift.sh`
right before mixing, only when a transform is active**: `chip_stem_path`/
`dac_stem_path` (see "Added: real chip-noise mixing" below) are rendered
audio, not MIDI — scaling the MIDI's tempo and transposing its notes does
nothing to those WAVs, so leaving them untouched while the MIDI half speeds
up/transposes would put the stem out of sync and out of tune with the rest
of the mix the moment either control moves off its default.
`_render_applied_midi()` detects a non-default speed/transpose (via the
now-argument-taking `_has_transform()`) and, only then, copies each present
stem into a fresh `render-NNNN.stemsync/` directory and calls the same
injected `run_pitch_shift()` with a single-element `[speed]`/`[transpose]`
list — reusing `pitch_shift.sh` here instead of writing a second
time-stretch implementation. The synced copies, not the original stem
paths, are what get passed to `mix.mix_wav()`. At default speed/transpose,
`run_pitch_shift()` is never called at all — this keeps the ordinary
(untransformed) render path exactly as fast and dependency-free as before
this feature, matching the project's existing "don't add ffmpeg/rubberband
to the common case" posture for `mix.py`/`pitch_shift.py`.
`render-NNNN.stemsync/` is removed in the same `finally` block that already
cleans up `.partN.wav`/split-MIDI temp files. **This is the sole remaining
reason `pitch_shift.py` is still part of this codebase** — see the section
above.

**Why this and `gameSoundfont`'s track-subset split don't interact**: the
MIDI split in `_plan_render_jobs()` happens against whichever applied MIDI
path it's given (the session's `applied_path` for `ensure_render()`, or a
batch combination's own path for `POST /api/variations`), which already has
that combination's speed/transpose baked in by `_apply_to()` — so both the
game-SoundFont half and the GM half are always rendered from
already-transformed MIDI, and only the real-audio stems need the separate
`pitch_shift.sh` pass described above.

## Added: a user-editable download filename (`download_stem`)

Before this feature, `GET /api/download`, `GET /api/download/wav`, and the
batch `POST /api/variations`/`GET /api/download/variations` pair all named
their output solely from `WebSession.original_name` — the sanitized stem of
whatever file was uploaded or converted. A user who wanted a different
deliverable name (e.g. matching a DAW project's own naming convention, or
distinguishing several takes downloaded from the same session) had no way to
set one; only a rename after the fact in Finder. `index.html`'s
`.download-toolbar` gained a plain `#download-filename` text input next to
the two download buttons, pre-filled with the currently loaded file's name
and editable at any time.

**Why this is a `WebSession` field with its own `PATCH /api/session/filename`
endpoint, not a per-request query parameter or JSON body field**: three
separate download-shaped endpoints need the same base name applied
consistently, and one of them (`POST /api/variations`) has to know it at
*generation* time — the per-item `.mid`/`.wav` filenames baked into the ZIP
are decided while the batch loop runs, not when the ZIP is later fetched via
`GET /api/download/variations`. Threading a `name` argument through every
`downloadFrom()` call site in `app.js` would still leave that generation-time
problem unsolved, since the field's value at generation time and at download
time could differ. A session field mirrors exactly how `speed_ratio`/
`transpose_semitones` already solve the identical "one setting, several
downstream readers, some of them at generation time" shape (see "Speed/pitch
is a MIDI-layer edit" above) — `PATCH /api/session/filename` is a third
"one value for the whole session" endpoint alongside `PATCH
/api/session/transform` and `POST /api/soundfont`, for the same reason
those weren't folded into `PATCH /api/session/tracks`: this isn't a
per-track edit.

`WebSession.download_stem: str = ""` stores the raw override; `""` means "no
override, use `original_name`" — never `None`, since the field always holds
a string the frontend can drop straight into the input's `.value`.
`_effective_download_stem(session)` (`session.download_stem or
session.original_name`) is the single place all four download-name call
sites (`get_download`, `get_download_wav`, the `POST /api/variations` loop,
`get_download_variations`) read from, so a fifth future download endpoint
only needs to call the same helper rather than re-deriving the fallback
logic. `PATCH /api/session/filename` sanitizes the submitted value through
the same `sanitize_stem()` every upload path already uses (never trusting a
client-supplied string straight into a filename), and treats a blank or
whitespace-only submission as "clear the override" (`download_stem = ""`)
rather than sanitizing it into the literal fallback `"miditrack"` —
clearing the field should restore the automatic name, not pin it to a
placeholder.

**Why `download_stem` resets in `reset_midi_state()`, not
`soundfont_override`'s "survives across uploads" lifecycle**: unlike the
selected SoundFont (a UI preference independent of which file is loaded),
this field's entire purpose is "the name for *this* file's downloads" — its
own placeholder/initial value in the UI is the newly loaded file's name, so
a fresh upload or source conversion resetting it back to `""` (which the
frontend then displays as the new `filename`) is the expected behavior, not
a bug to guard against. This mirrors `original_name` itself, which the field
overrides and shares a reset lifecycle with.

**Why changing the filename invalidates `variations_zip_path` but not
`audio_path`/`applied_path`**: a filename edit changes nothing about the
actual MIDI or audio content, so re-running `ensure_render()`/
`ensure_applied()` would be pure waste — unlike `invalidate_render()`
(called by every actual content-changing PATCH), `update_download_filename()`
clears only `variations_zip_path` directly, and only when the sanitized
value actually differs from the current one. This is necessary because the
ZIP's *internal* per-item filenames (`{stem}_{label}.mid`/`.wav`, written
once during the `POST /api/variations` loop) are baked in at generation
time — leaving a stale ZIP downloadable under a *new* outer name (from
`_effective_download_stem()` re-evaluated at `GET /api/download/variations`
time) while its internal files still carried the *old* stem would be a
visible inconsistency between the ZIP's own filename and its contents.
Forcing regeneration is the same invalidate-on-any-input-change posture
`variations_zip_path`'s own field comment already documents for every other
generation input (assignments/volumes/track_sources/soundfont).

`app.js`'s `renderDownloadFilenameField(payload)` mirrors
`renderTransformFields(payload)` exactly: called from `refreshFromSession()`
so any session refresh (a track edit, a fresh upload, `handleReset()`) keeps
the field in sync with the server's `downloadStem`/`filename`, but the
debounced `flushDownloadFilename()` — triggered 250ms after the user's own
`input` event, via `state.downloadFilenamePatchTimer` — deliberately does
**not** call it again after a successful `PATCH`, for the same reason
`flushTransform()` doesn't re-call `renderTransformFields()`: re-rendering
the field from the user's own just-submitted response would fight the
browser's cursor position if they kept typing during the round trip.

## Why source-file conversion lives in `miditrack`, not in each CLI

`nsf2midi`/`spc2midi`/`vgm2midi` are three independently-built tools in
different languages (two C++ binaries, one Node/TypeScript CLI), and none of
them has a Web UI. Giving each of them its own Flask server would be three
near-identical implementations of the same local-single-session-token-auth
pattern `miditrack` already has. `miditrack` is also already the downstream
consumer of their output, so folding "convert the source file" into the
first step of the same page — rather than requiring a separate terminal
command before ever opening the browser — was the smaller addition. This is
the same "callers converge on one place" shape as `midi2wav.sh` itself: four
different callers (the three converters' own `--wav` option, plus
`miditrack`) share one script instead of reimplementing fluidsynth
invocation four times.

`src/miditrack/convert.py` mirrors `render.py`'s own design exactly: no
shell (`subprocess.run(argv, shell=False, ...)` with an explicit
`list[str]`, for the same reason — this repository's path contains a space
and `&`), and the same binary-resolution order (`<FORMAT>_BIN` env var,
fatal if set but not executable → a known repo-relative path → PATH, where
applicable). `resolve_converter_argv0()` differs from
`render.resolve_midi2wav_bin()` in one place: `vgm2midi`'s `dist/cli.js` is
started as `[node, cli.js]` rather than invoked directly, because although
it carries a `#!/usr/bin/env node` shebang and executable bit, both live
inside this repository's Dropbox-synced tree, and Dropbox sync is known to
not always preserve the executable bit reliably — the two C++ binaries
(`nsf2midi/nsf2midi`, `spc2midi/spc2midi`) don't have this failure mode
since a plain Mach-O binary doesn't depend on a shebang. `nsf2midi` and
`spc2midi` have no PATH fallback beyond their repo-relative path because
they are not expected to ever be installed system-wide; `vgm2midi` does,
because it is also `npm link`-able per its own CLAUDE.md.

## Why `-l`/`--list` output is parsed as text, not read from a shared format

None of the three converters emits JSON, and adding a `--json` flag to any
of them — three separate parsers, three separate output-format decisions —
was a larger change to well-tested independent tools than parsing their
existing, already-stable `printf`/`std::fprintf` output. Because the parser
targets exactly this repository's own `nsf2midi/src/main.cpp` (the
`list_only` block) and `spc2midi/src/main.cpp` (`PrintList()`), there is no
external-format drift risk — but it does mean an edit to either tool's list
`printf` format must be mirrored in `convert._parse_nsf_list()` /
`convert._parse_spc_list()`, or the corresponding regex silently stops
matching. `vgm2midi` has no `-l` equivalent (`supports_song_list=False` in
`convert.SOURCE_FORMATS`) because a `.vgm`/`.vgz` file is always exactly one
song; there is nothing to list.

## Why nsf2midi/spc2midi's own exit code 3 gets a dedicated message

`spc2midi` returns exit code 3 specifically when the file loaded but no
known SNES sequence driver matched it (see its own `ReportNoDriver()`) —
this is different from "broken file" or "wrong arguments," and the
generic "conversion failed, exit=N" message would bury that distinction
under a raw exit code. `convert.list_songs()` and `convert.convert_to_midi()`
both special-case this exit code with the same Japanese message a user
would actually want to see, before falling through to the generic
stderr-tail message for any other nonzero exit.

## Why the WAV/MIDI conversion options are a server-owned schema

`convert.option_schema()` plays the same role for the "convert" panel that
`gm.py` plays for the instrument dropdowns and `tools/make_videos_web.py`'s
`OPTION_SCHEMA` plays for its own form: the frontend never hardcodes field
names, types, or `min`/`conflicts` rules — it renders whatever
`GET /api/source` (via the `source.options` field of the session payload)
returns. `convert.validate_convert_options()` re-validates the exact same
rules server-side before ever building an argv, the same "never trust
client-side disabling alone" posture `make_videos_web.py` documents for its
own dynamic-required-field checks — a hostile or buggy client sending
`{"loops": 2, "durationSeconds": 30}` for a VGM conversion is rejected with
400, not silently passed through to `vgm2midi`, which would itself reject it
via its own `--loops`/`--duration` mutual-exclusion check (`cli.ts:49-51`) —
but failing fast in `miditrack` gives a clearer error than a raw
nonzero-exit-from-a-child-process message.

The VGM-only `ch3SpecialPercussion` boolean is intentionally part of this
same schema rather than a hardcoded frontend control. The generic bool
renderer therefore produces a native labeled checkbox, while `_build_argv()`
maps a checked value to `vgm2midi --ch3-special-percussion`. Its unchecked
default preserves `vgm2midi`'s four editable OPN Ch3 Special operator tracks
for YM2203, YM2608, and YM2612. The user-facing label names OPN explicitly so
the control is not mistaken for a YM2612-only feature.

All three formats' `loops` and `durationSeconds` schema entries share
`layoutGroup: "timing"` and are always declared in that order, even on a
format that can't actually use one of them — the unusable one instead
carries `unavailable: True` plus a `help` string explaining why. The generic
renderer copies `layoutGroup` to each field and marks the options container,
while CSS lays the group out as two equal columns (`has-timing-group`) and
lets all later options span the full row; at 640px and below the group
returns to one column. `buildConvertField()` renders an `unavailable` field
disabled and skips both its event listeners and its `state.convertFields`
entry (`app.js`), so `gatherConvertOptions()` never has a chance to send a
value for it and the dynamic loops/durationSeconds mutual-exclusion logic
(`updateConvertFieldConflicts()`) never sees it either.
`validate_convert_options()` mirrors this server-side, before any type
checking: an `unavailable` field is forced to its schema `default`
regardless of what the client sent, the same "never trust client-side
disabling alone" posture already established for `conflicts`. Keep this
metadata server-owned: do not add a per-format field-name list to `app.js`
merely to control which of `loops`/`durationSeconds` is enabled or how the
layout groups.

**Why NSF can only set `durationSeconds`, SPC can only set `loops`, and
VGM can set either (mutually exclusive)**: `nsf2midi` observes emulated APU
register state frame-by-frame and has no way to detect a loop point, so a
duration in seconds is the only way to bound playback; `spc2midi` (via
VGMTrans) parses the SNES driver's actual sequence data, which has no
"total seconds" — only an unrolled-loop-count — but does give an exact,
often-changing tempo the file itself will carry, so there's nothing for the
user to set there either; `vgm2midi` reads a register-write log with an
explicit sample-accurate loop offset in its header, so both a loop count and
a target duration are meaningful and mutually exclusive (mirroring
`vgm2midi`'s own `cli.ts:49-51` check).

**Why the "テンポ (BPM)" conversion-time option was removed entirely
(including from VGM, the one format that used to expose it)**: a VGM
register-write log carries no notion of beats or tempo at all — `tempo` only
existed to pick how `vgm2midi`'s `samplesToTicks()` (`quarterNotes = seconds
* tempo / 60`) converts absolute sample timestamps into MIDI ticks. Changing
that value changes nothing about the actual audio or its real-time duration,
only how finely the beat grid is quantized in the resulting `.mid` — the
same "not a real tempo, just a carrier grid" situation `nsf2midi` is
already in with its own hardcoded 500000µs (120 BPM, `nsf2midi/src/main.cpp:34,399`).
Since a user's actual goal ("make it play faster/slower") is already served
by the existing MIDI-layer speed control (see "Why speed/pitch is a
MIDI-layer edit" below, which scales the `set_tempo` meta by a ratio after
conversion), there was no reason to keep a conversion-time BPM picker whose
value is invisible in the rendered audio. `_build_argv()`'s VGM branch now
hardcodes `"-t", "120"` unconditionally; `spc2midi` never had a `-t`
equivalent to begin with, since VGMTrans writes the game's own real tempo
straight from the sequence data (`SeqTrack::addTempoNoItem()`, can vary
mid-song) and there's nothing to override.

## Why converting a source file reuses the same `WebSession.root`

`POST /api/source` still calls `WebSession.clear()` (so any *previous*
session's temp directory and source/MIDI state is discarded, exactly like
uploading a new `.mid` does) but then creates one fresh `mkdtemp()` root
that holds both the uploaded source file and, later, the converted
`.mid` — rather than the converted MIDI creating yet another temp directory.
`WebSession.load_midi()` is the method that lets `POST /api/source/convert`
swap in the converted MIDI's tracks/assignments/render state without
touching `root` or the `source_*` fields, so the original source file stays
available for a **re-convert** (different song, different options) without
re-uploading. `replace()` (used by the plain `.mid` upload path and CLI
preload) is now expressed as `clear()` followed by `load_midi()`, so both
paths funnel through the same "MIDI state reset" logic instead of
duplicating it.

`WebSession.reset_midi_state()` was extracted from `load_midi()`/`clear()`
when ZIP/multi-file support (below) added a third caller that needs the
exact same reset — `_activate_source_file()`, called both right after
upload and every time the user switches which archive member is active via
`POST /api/source/select-file`. It resets exactly the MIDI-derived fields
(original path/name, ticks, tracks, assignments, render state) and nothing
else, so switching the active file mid-session correctly clears stale
tracks/assignments from whatever file was previously converted, without
touching `root`, `source_files`, or `source_m3u_texts` — those describe the
*upload* as a whole and must survive any number of file switches within it.

## Why source files can be uploaded as a ZIP, or as several loose files at once

Real chiptune rip packs are rarely a single bare `.nsf`/`.spc` — they
commonly ship as a `.zip` containing one archive per game (sometimes
several), each paired with a same-named `.m3u` (see below), or as a folder
the user drags in as multiple files at once (the source file plus its
`.m3u`, or several `.spc` files from one soundtrack). Requiring the user to
unzip and upload one file at a time before this feature existed would have
made exactly the case this tool exists to make convenient — going from "a
folder of chiptune files" to a listenable, re-instrumented WAV — the most
tedious part of the workflow.

`POST /api/source` therefore accepts the `source` form field **one or more
times** (`request.files.getlist("source")`, same multi-value-field pattern
Werkzeug already supports) and additionally unpacks any uploaded `.zip`
in-process via `convert.extract_zip_members()`. Both paths (loose files,
ZIP members) feed into the same candidate-collection loop, so a ZIP
containing two `.nsf` files behaves identically to selecting those two
`.nsf` files directly in the file picker. Files that are recognized as
neither a source format nor a `.m3u`/`.m3u8` (readme text, cover art —
extremely common in real rip packs) are silently ignored rather than
rejecting the whole upload, matching how a human skimming the same folder
would behave.

When more than one convertible file is found, the first (sorted by its
path within the upload) is auto-activated so the UI never sits in an empty
state, and `source.files`/`source.activeFile` in the session payload let
the frontend render a "ファイル" selector (mirroring the existing "曲"
selector) that calls `POST /api/source/select-file` to switch — which just
re-runs the same `_activate_source_file()` used at upload time against a
different already-extracted path, no new upload required.

**ZIP extraction and zip-slip**: `convert.extract_zip_members()` resolves
every member's destination path and rejects anything that would land
outside the destination directory (absolute paths, `..` segments) before
writing a single byte — the classic "zip-slip" vulnerability. It also
checks the central directory's total member count and total uncompressed
size *before* extracting anything, rejecting oversized/many-member ZIPs
outright as a simple, proportionate zip-bomb guard. This is deliberately
not hardened against a maliciously crafted central-directory/local-header
mismatch (a more advanced attack): `miditrack` only ever binds to
`127.0.0.1` behind a launch-scoped token, the same "uploading a file is
equivalent to running a local CLI command as yourself" trust boundary
`POST /api/soundfont`'s design note already establishes for this tool — the
goal here is "don't choke on a large or malformed ZIP a real user might
have," not defense against a hostile adversary.

`_safe_upload_basename()`/`_unique_upload_path()` (`web.py`) give loose
(non-ZIP) uploads the same zip-slip-style safety for their `FileStorage`-
supplied filename, which — unlike a ZIP member name — is attacker-controlled
multipart metadata and must never be joined into a filesystem path
unsanitized. They also matter for a reason beyond safety: the original
filename (not a synthetic `upload_N.ext`) has to survive onto disk, because
m3u title matching (below) works by comparing basenames.

## Why song titles can come from a bundled m3u playlist

Multi-track NSF/SPC rip packs are very often distributed with a sibling
`.m3u` that names each subsong — the file `nsf2midi -l`/`spc2midi -l`
already surface only as "Track 3" or the driver's own (frequently blank or
cryptic) internal label. When that `.m3u` is available, showing the real
song titles in the "曲" dropdown is a meaningfully better experience than
the raw `-l` output, so `convert.py` implements a parser for it and
`_activate_source_file()` applies it automatically whenever a bundled `.m3u`
matches the currently active file by name.

**Format**: this is the de facto standard extended M3U variant used by
[Game_Music_Emu](https://github.com/libgme/game-music-emu) (the library
behind most NSF/SPC/GBS players, including foobar2000's `foo_input_gme`) —
`gme/M3u_Playlist.cpp`'s `Gme_File::load_m3u()`. One data line is
`filename[::TYPE],track,name[,length[,loop[,fade[,repeat]]]]`; comments
start with `#`. `convert._parse_m3u_filename_field()` /
`_parse_m3u_track_field()` / `_parse_m3u_name_field()` are a direct
line-for-line Python transcription of that C++ parser's `parse_filename()`
/ `parse_track()` / `parse_name()` (fetched from the actual upstream source
during implementation to get the comma-escaping and `::TYPE`-suffix rules
exactly right — titles legitimately contain commas, e.g. "Wicked Child, Pt.
2", and the grammar's lookahead rule for when a comma ends a field versus
belongs to the text was verified against that source rather than guessed).
Fields past `name` (length/loop/fade/repeat) are intentionally not parsed —
`miditrack` only needs the title. One convention `parse_m3u()` adds beyond
a literal port: a blank filename field (`,3,Bloody Tears`) inherits the
most recently seen non-blank filename, matching a common real-world
authoring shorthand for playlists covering one file's tracks consecutively.

**Matching titles to songs**: `convert.filter_m3u_entries()` selects only
the m3u lines whose filename matches the currently active file by
basename (case-insensitive) — this is why loose-upload filenames must
survive intact on disk (see above). `apply_m3u_titles()` then maps each
matched entry onto a song index: if *every* matched entry carries a parsed
track number, it uses `track - 1` (gme's own convention is 1-based; both
`nsf2midi -t` and `spc2midi -s` are 0-based, confirmed from their own
`--help` text), which is robust even if the m3u lists tracks out of order.
If any entry is missing a track number, it falls back to pure line-order
zipped against the tool's own `-l` song order — the realistic assumption
for a hand-authored playlist meant to be played straight through. An entry
whose resolved index falls outside the tool's own song list (e.g. a stale
m3u referencing more tracks than the file actually has) is silently
skipped rather than erroring, since a partially-useful title match is
strictly better than refusing the whole upload over one bad line.

This is deliberately scoped to `supports_song_list=True` formats (NSF,
SPC) only — `vgm2midi` converts exactly one song per file, so there is
nothing for a per-track title to disambiguate, and applying an m3u-derived
name there would just be renaming the output for no functional benefit.

## Why Program Change is *detected*, never assumed absent

An early design instinct might be "generated files have no Program Change
yet, so just insert one." That's wrong for two of the three converters
this tool is built for:

- `vgm2midi` sends GM program 81 "Lead 1 (square)" (0-indexed 80) to
  **every** melodic track — `vgm2midi/src/midi-converter.ts:8`
  (`GM_PROGRAM_LEAD_1_SQUARE = 80`) and its use at `:385`.
- `nsf2midi`'s `gm.mdf` preset (the default `.mdf` since its
  reproduction-fidelity pass) sends a per-channel instrument from
  `WriteHeader()` and re-sends on duty-cycle changes —
  `nsf2midi/src/detector.cpp:84` and `nsf2midi/gm.mdf`.
- `spc2midi` output carries the real game's own instrument indices
  (verified during implementation: SMW's Title theme has Program Change
  values 0/1/3 on its tracks, not GM-standard numbers — they index
  VGMTrans's own instrument mapping, meaningful alongside the optional
  `--sf2`/`--dls` export, not as GM names).

`midi.analyze_track()` therefore scans every track for its single note
channel's first `program_change` and surfaces it as `current_program`, so
the UI can pre-select it. A track's dropdown starting on "変更しない（現在:
81番）" and a track starting on "変更しない（現在: 未設定）" are both
correct, honest representations of what's actually already in the file —
verified end-to-end against a real `vgm2midi` output (every FM track
pre-selected 81 exactly as `midi-converter.ts` predicts) and a real
`spc2midi` output (tracks pre-selected their actual VGMTrans-assigned
program numbers) during implementation.

## Why `apply_assignments()` re-checks editability itself

`midi.validate_assignments()` is the gate the `PATCH /api/session/tracks`
endpoint calls before ever touching `session.assignments`, and it rejects
any assignment targeting a non-editable track. `apply_assignments()`
(called later, from `POST /api/render`) does **not** trust that its
caller already validated — it independently derives the track's single
note channel via `_single_note_channel()` and rejects both "not exactly
one channel" and "channel is the percussion channel" before writing
anything. This was not just theoretical caution: it was an actual bug
caught by `tests/test_midi.py`'s
`test_apply_on_non_editable_track_raises` during implementation — the
first version of `apply_assignments()` only rejected the "zero or
multiple channels" case and happily inserted a Program Change onto
channel 10 if called directly (bypassing the PATCH-time check). Defense
in depth here costs one extra `if`, and the function is public API within
the package (`web.py`'s `/api/download`-on-demand path also calls it), so
relying on a single call site's validation was fragile.

## Why per-track volume scales Note On velocity instead of sending CC7

MIDI volume controller CC7 is channel-wide, while real input files can contain
multiple tracks that share one MIDI channel. Sending CC7 from one row in the Web
table would therefore change every other track on that channel and violate the
feature's per-track promise. `WebSession.volumes` instead stores 0-200 percent
per track, and `apply_assignments()` re-reads the original MIDI and scales only
that track's positive-velocity Note On messages. Note Off events and Note On
velocity zero remain zero; nonzero results are clamped to 1-127, while exactly
0% intentionally converts Note On to velocity zero (mute).

This path is independent of instrument editability: percussion-channel and
multi-channel tracks cannot receive a Program Change from this UI, but they can
still receive a track-local velocity multiplier. Tracks with no notes expose no
slider. Like instrument changes, PATCH validation is repeated server-side,
invalidates the current render, and every apply starts from `original_path`, so
moving 50% -> 200% never compounds the earlier 50% pass.

**Added: a mute button, and per-track volume for VGM/NSF `"game"` tracks
too.** Each row's volume control gained a ☆-style mute button (`app.js`'s
`.mute-button`, remembering the pre-mute value so a second click restores
it) — purely a frontend convenience over the existing slider, no server
change needed. Separately, the volume slider is no longer disabled for
VGM/NSF `"game"` tracks — see the section below for why that was possible
and what it cost.

## Why the volume slider's initial value can be something other than 100%

The converted MIDI can already carry a real mix decision from the source —
`vgm2midi` now writes a leading CC7 per track when the source VGM's Extra
Header records a chip-specific mix volume (see `vgm2midi/CLAUDE.md`'s
"Added: Extra Header chip volume becomes a leading CC7"), and any hand-authored
or DAW-exported `.mid` a user uploads directly can carry CC7 for the same
reason spc2midi/VGMTrans output can. Before this feature the slider ignored
all of that and always started at a flat 100%, silently discarding a mix
balance the source file actually specified.

`TrackInfo.source_volume_percent` (`midi.py`'s `analyze_track()`) reads the
first CC7 on the track's own single note channel — the exact same
channel-filtering approach `current_program`/`program_change_count` already
use for Program Change, reused here rather than invented fresh. Two
deliberate restrictions keep this addition narrow and safe:

- **Only a CC7 below 100 is adopted (attenuation only), never above.**
  `apply_assignments()`'s existing velocity math clamps at 127
  (`max(1, min(127, ...))`), so treating e.g. `nsf2midi`'s `gm.mdf` preset
  (which always sends `CC7=127` at header write time — see that project's
  own `WriteHeader()`) as a >100% baseline would push velocity scaling into
  that ceiling for every NSF conversion and silently destroy the dynamics
  `gm.mdf`'s own `Velocity=1` cfg already worked to preserve. Restricting
  adoption to genuinely quiet tracks (a real, deliberate "duck this
  instrument" mix decision) avoids ever needing an amplifying multiplier at
  all. One direct consequence: **no NSF conversion's slider defaults change**
  because of this feature — `gm.mdf`'s CC7 values (127, 110) are always
  above the threshold.
- **Only a CC7 on a channel the track exclusively occupies is adopted.**
  CC7 is channel-wide MIDI state, exactly the reason per-track volume itself
  avoids ever *sending* CC7 (see the section above). `analyze_midi_file()`
  runs a second pass after `analyze_track()` and resets
  `source_volume_percent` back to the default for any track whose channel is
  also used by another note-bearing track — this is why `nsf2midi`'s shared
  NOISE/PCM channel (both channel 10) never actually seeds a non-100 slider
  even though `gm.mdf`'s Noise/PCM sections *do* write CC7 values below 100
  (110), the same channel-sharing consideration `apply_assignments()`'s own
  docstring already documents for why volume never becomes a new CC7 send.

`track_payload()` exposes both `volumePercent` (the effective slider value —
a user-set value from `WebSession.volumes` if present, else this baseline)
and `sourceVolumePercent` (the baseline itself, used by `app.js` as the
mute/solo restore target instead of a hardcoded 100 — see `buildTrackRow()`'s
`volumeBeforeMute` and `enterSolo()`). `validate_volumes()` now excludes a
submitted value from `WebSession.volumes` when it matches *that track's own*
baseline rather than the global constant 100 — so leaving the slider
untouched, or explicitly dragging it back to its own starting position, are
both treated as "no override" the same way submitting 100 always was.

**Why the slider is "absolute volume," and what apply_assignments() actually
does with the baseline**: the slider's number always means the same thing —
100% is "as loud as an ordinary GM channel with no CC7 override" — rather
than "percent of whatever this track originally sounded like." This matters
because a user who never touches the slider still expects the audible result
to sound like the source's own mix, not like a hardcoded 100% ignoring a
source CC7=64. `apply_assignments()` therefore takes a new `source_volumes`
argument (the baseline per track, always supplied by `web.py`'s `_apply_to()`
alongside the effective `volumes` dict) and, whenever a track's baseline is
below 100, rewrites *that track's own* existing CC7 messages in place —
never inserting a new one, the same "mutate in place, never insert new
channel-wide state" discipline `_is_bank_select()`/Program Change rewriting
already follow — so the value becomes `round(cc7 * 100 / baseline)`. This
normalizes a static or time-varying CC7 curve back up to a 100% baseline
while preserving its shape (a mid-song CC7 dip proportionally follows the
same math), and it is what makes the velocity multiplier in the same loop
correct: an untouched slider still carries `volume == baseline` (via
`web.py`'s effective-volumes dict, not merely the default), so velocity is
scaled by the same ratio CC7 is renormalized by, leaving the *combined*
audible result approximately unchanged from the source — the slider becoming
visible at 64% instead of 100% is a UI change, not (to first-order,
`fluidsynth`'s CC7 response is not perfectly linear — an already-documented
approximation, see the section above) an audio change. If the user then
drags the slider to some other value, velocity scales by that new value
instead of the baseline, while CC7 stays normalized to 100 either way — the
same "always re-derive from `original_path`" invariant that already keeps
`apply_assignments()` idempotent applies here too, since `source_volumes` is
recomputed from the original file's own analysis on every call, never
accumulated.

`_render_chip_hardware()`'s existing default/custom volume split (see the
next section) also reads this baseline instead of the constant 100 for both
halves: a "game"-selected track whose slider was never touched still joins
the single default-group hardware render (its own emulation output already
carries the source's mix), and a track the user *did* adjust gets an
individual-render gain of `mix.STEM_GAIN * volume_percent / baseline_percent`
rather than `.../ 100` — so a track with e.g. an already-quiet baseline that
the user boosts back up doesn't get double-quietened by treating its own
baseline as if it were already 100.

## Why per-track volume on VGM/NSF `"game"` tracks re-renders only the channels whose volume actually changed

Originally, VGM/NSF `"game"` tracks (`CHIP_HARDWARE_SOURCE_FORMATS`) disabled
the volume slider outright — see "Frontend vocabulary" in the NSF
per-track hardware selection section below for why: the velocity-scaling
path above only ever touches the MIDI, but a `"game"`-selected track is
removed from the MIDI entirely and its audio comes from `libvgm`/
`nsf2midi --chip-render` re-emulating the original source file — a
process that has no concept of "velocity" to scale. `WebSession.volumes`
was still saved and written into the MIDI's Note On velocities for such
tracks, but since that MIDI is never rendered, the value was silently
inert (confirmed by tracing `_plan_render_jobs()`, which drops
`"game"`-selected indices from the dry MIDI before it ever reaches
`render_wav()`).

Per-track volume for these tracks was added by mixing in a linear gain at
the WAV level instead — the same place `mix.mix_wav()` already lets any
number of inputs be summed with independent gains. `_render_chip_hardware()`
(`web.py`) splits the selected `"game"` indices into two groups: those still
at the default 100% volume are rendered together in **one** `libvgm`/
`nsf2midi --chip-render` call (unchanged behavior, `mix.STEM_GAIN` as
before), and each channel whose volume was actually changed is rendered
**individually** (`_render_chip_targets()` called once per channel) with a
gain of `mix.STEM_GAIN * volume_percent / 100`. `_render_chip_hardware()`
now returns `list[tuple[Path, float]]` instead of a single `Path | None`,
and `_render_applied_midi()`'s `chip_render_stems` parameter (renamed from
`chip_render_stem`) threads that list straight into `mix_wav()`'s inputs;
`_synced_stem()` (for non-default speed/transpose) runs once per entry in
that list rather than once total.

**Why split by "changed from default" instead of always rendering every
channel individually**: `libvgm`'s native helper and `nsf2midi
--chip-render` both re-run the *entire* source file's emulation from the
start for every invocation (see "Added: real chip-noise mixing" and "Added:
NSF per-track hardware selection" below) — there's no way to render "just
one channel's contribution" without paying for a full pass. Individually
rendering every selected channel, even ones nobody touched, would multiply
render time by the channel count for no audible benefit on tracks left at
their default volume. Grouping the untouched channels into the single call
they always used to get keeps the common case (nobody touches the volume
slider on a `"game"` track) exactly as fast as before this feature; the
per-channel cost is paid only for channels a user actually adjusted. This
was a deliberate scope decision, confirmed with the user, over the
alternative of always rendering every channel individually for
maximally-accurate mixing.

**Why the default/custom split happens inside `_render_chip_hardware()`
rather than being decided by the caller**: both call sites
(`_render_applied_midi()`'s own auto-generation path, and
`POST /api/variations`'s shared-stem-across-combinations path) need
identical grouping logic, and `WebSession.volumes` is the single source of
truth for "which volume is default" regardless of which caller is asking.

**Batch variations (`POST /api/variations`) interaction**: `_render_chip_hardware()`
still gets called exactly once per batch, before the `itertools.product()`
loop, and its `list[tuple[Path, float]]` result is passed to every
combination's `_render_applied_midi()` call the same way the old single
`Path` was — the per-channel-if-changed rendering happens once, not once
per combination, preserving the existing "the whole batch shares one
chip-hardware render" optimization this project already relies on for
render time.

## Why in-place `msg.program` mutation, or a `time=0` insertion — never delete/rebuild

`apply_assignments()` always re-reads the uploaded original from disk
(`mido.MidiFile(original_path)`), so every apply starts from the same
known-good bytes and "keep original" (an assignment value of `None`,
removed from `session.assignments`) is always exactly reproducible.

For a track whose channel already carries one or more `program_change`
messages, every one of them has its `.program` mutated in place — not
just the first. This matters for `nsf2midi`'s duty-driven re-sends and any
track that changes instrument mid-song (`program_change_count > 1`,
surfaced in the UI as a ⚠ Popover tooltip): picking a new instrument should apply
uniformly, and mutating in place means the delta-time chain is completely
untouched, so every note's absolute tick is provably unaffected (verified
in `tests/test_midi.py` by comparing absolute-tick note event lists before
and after, and independently against a real `spc2midi` output where a
25-occurrence and a 29-occurrence Program Change track were both
confirmed fully rewritten with `mido` after a round-trip through the Web
API).

For a track with no existing Program Change, a new
`mido.Message("program_change", ..., time=0)` is inserted immediately
before the first message in the track whose `.channel` matches (skipping
`MetaMessage`s like `track_name`/`set_tempo`, which have no `.channel`
attribute — `getattr(message, "channel", None)` guards this). A `time=0`
message consumes zero ticks, so the displaced message keeps its own
original delta time and every downstream tick is unchanged — the same
reasoning `note_ext/src/note_ext/midi.py:310-312` uses when it always
writes `time=0` for its own header messages.

## Why the GM table lives only in `gm.py`

No 128-name General MIDI program table existed anywhere in this repository
before this tool (confirmed by search during planning — only scattered
single-program constants like `vgm2midi`'s `GM_PROGRAM_LEAD_1_SQUARE`
existed). `gm.py` is the one place it's written out, and
`GET /api/instruments` serves it as JSON so the frontend never hardcodes
an instrument name — `app.js` builds its 16 `<optgroup>` blocks from that
response and clones the resulting fragment per track row. The module
asserts `len(GM_PROGRAM_NAMES) == 128 == len(GM_FAMILY_NAMES) * 8` at
import time (and again as a unit test), since each family is a
mechanically-derived contiguous 8-program block, not a second hand-written
mapping that could drift from the name list.

## Why `PERCUSSION_CHANNEL` (ch10) is out of scope

Confirmed with the user during planning: implementing GM drum-kit
switching (Bank Select MSB=120 + a handful of Program values for
Standard/Room/Power/Electronic/TR-808/Jazz/Brush/Orchestra kits) is a
meaningfully different and more complex feature than plain per-channel
Program Change, and was explicitly deferred. `gm.py`'s
`PERCUSSION_CHANNEL = 9` (0-indexed) is the single place this exclusion is
encoded; `midi.analyze_track()` checks it once, and `apply_assignments()`
independently re-checks it (see above).

One real interaction worth knowing: `vgm2midi` can wrap its own
MIDI-channel assignment scheme onto channel 10 when a VGM drives more chip
families than fit in its channel budget (`vgm2midi/CLAUDE.md`'s "A
MIDI-channel-budget redesign that would avoid the 14–16-wraps-to-1–3
collision" — and, observed during implementation against a real VGM with
YM2612 + DAC channels active simultaneously, a *melodic* YM2612 FM track
landed on channel 9 this way). `miditrack` judges editability purely by
channel number, with no way to distinguish "this is really GM percussion"
from "this landed on channel 10 because of a channel-budget collision" —
so it inherits that collision as a locked, non-editable row rather than
guessing. This is a `vgm2midi`-side limitation being surfaced, not a
`miditrack` bug.

## Added: in-browser SoundFont selection

The initial implementation only accepted a SoundFont via `--soundfont FILE`
at CLI startup, fixed for the whole session — the only way to try a
different bank was to quit and relaunch. `GET /api/soundfonts` and
`POST /api/soundfont` (both in `web.py`) let the browser list and switch
the active SoundFont at runtime, without touching `midi2wav.sh` itself.

`render.list_soundfonts()` and `render.default_soundfont_dirs()`
(`render.py`) are a direct Python transcription of `midi2wav.sh`'s own
`DEFAULT_SOUNDFONT_DIRS` array — same five directories, same order
(`<repo>/soundfonts` first, then `~/Library/Audio/Sounds/Banks`,
`/opt/homebrew/share/soundfonts`, `/Library/Audio/Sounds/Banks`,
`/opt/homebrew/share/fluid-synth/sf2`), so the browser's list always
matches what `midi2wav.sh -S`'s own interactive picker would show — which
is otherwise unreachable from a Web UI, since there's no TTY behind an
HTTP request (documented as a limitation in `README_ja.md`/`README.md`
before this feature; the in-browser picker now covers the same need).
Missing directories are silently skipped, matching the shell script's own
behavior — this is also how an external SoundFont library is meant to be
wired in: symlink it at `<repo>/soundfonts` rather than hardcoding its
real (often machine-specific) path anywhere in this codebase.

`WebSession.soundfont_override: Path | None` is deliberately **not**
reset by `clear()`/`replace()` — it is a per-browser-session UI
preference, independent of which MIDI file happens to be loaded, so
switching MIDI files (or resetting the upload) does not also forget which
SoundFont the user picked. `POST /api/render` resolves the effective
SoundFont as `web_session.soundfont_override or soundfont` (the
`soundfont` closure variable being whatever `--soundfont` supplied at
startup, i.e. the runtime choice always wins over the CLI default, which
in turn wins over `midi2wav.sh`'s own resolution when both are absent).

`POST /api/soundfont` validates the submitted path with
`render.is_soundfont_file()` (must exist, must have a `.sf2`/`.sf3`
extension) before accepting it — this endpoint is the one place in this
tool that accepts an arbitrary filesystem path from the client rather
than an opaque ID, which would normally be worth extra scrutiny. It's
judged acceptable here because (a) this app only ever binds to
`127.0.0.1` behind a launch-scoped token, the same trust boundary as
running a CLI command locally — `miditrack --soundfont FILE` already
accepts an arbitrary local path from the same person, and (b) the
alternative (restricting the client to selecting only a server-issued ID
from the discovered list) would prevent picking a SoundFont living
outside all six search directories, which is a real, if less common,
use case. Every response still round-trips through `render.list_soundfonts()`
so the dropdown always reflects reality, but the endpoint itself does not
require the submitted path to be a member of that list.

Selecting a SoundFont calls `invalidate_render()` (same as changing a
track's instrument assignment does), because the previous render — if
any — was rendered with the old SoundFont and no longer matches what a
fresh "Apply & Audition" click would produce.

## Added: real chip-noise mixing (`chipNoise`)

As of the per-track libvgm source feature, the VGM branch no longer consumes
the old noise/DAC stems when the bundled converter writes
`converted.libvgm.json`. `vgm2midi` keeps those MIDI notes and writes a stable
track-index → device/instance/main-mask/linked-mask sidecar. `convert_source()`
loads it after MIDI analysis, stores it in `WebSession.libvgm_metadata`, and,
when `chipNoise` is checked, puts only targets marked
`suggestedForHardwareMix` into `track_sources`. The old tuple-returned WAVs are
still accepted when a legacy converter or a test fake writes no sidecar; this
keeps NSF and older VGM integrations backward compatible.

`PATCH /api/session/tracks` accepts `sources` alongside assignments and
volumes. `libvgm.validate_sources()` expands a change across every MIDI row
with the same `groupId`, because sample identities or logical noise/tone rows
can describe one physical chip channel. During rendering,
`_plan_render_jobs()` drops all libvgm-selected rows from the FluidSynth MIDI,
and `libvgm.render_selection()` asks the native helper for one combined WAV of
the selected channel masks. That WAV joins the existing dry/stem mixer and is
pitch-shifted with the same synchronization path when a whole-song transform
is active. Instrument and volume controls remain stored but are disabled in
the UI while libvgm is selected, so switching back to SoundFont restores the
prior settings.

Automatic suggestions are deliberately conservative. Independently muted
SN76489/GB noise, YM2612 DAC, OPL/OPNA rhythm/PCM, and whole-device PCM targets
may be suggested. AY/OPN SSG and HuC6280 tone/noise share physical channels,
and YM2151 noise shares FM channel 7, so those mappings can be offered as a
group but never auto-selected. OPN channel-3 special operator rows have no
safe one-to-one mute target and receive no libvgm option.

GM drum notes are a rough stand-in for the NES's Noise and DPCM channels —
a SoundFont snare/hi-hat sounds nothing like real hardware percussion.
`nsf2midi` gained a `--chip-wav <file>` option (see its own `CLAUDE.md`)
that renders those two channels through the emulation core itself, as real
chip audio, to a WAV whose length exactly matches the output MIDI's
duration — and, by default, removes them from the `.mid` so they don't
also sound as GM drums. `miditrack` is where that stem actually gets used:
`convert.option_schema()` exposes a `chipNoise` boolean field on both `nsf`
and `vgm` (never SPC). `convert.convert_to_midi()` passes `--chip-wav <path>`
for NSF or, for VGM, **both** `--noise-wav <path>` and `--dac-wav <path>`
(vgm2midi's SN76489/HuC6280 LFSR-noise renderer and its YM2612 DAC/PCM
sample renderer, respectively — two independent CLI options and two
independent WAV files, since a Mega Drive VGM can use both the PSG and the
YM2612 DAC channel at once). `convert_to_midi()` returns
`tuple[Path | None, Path | None]` — `(chip_stem_path, dac_stem_path)` — so
NSF conversions always carry `None` in the second slot (there is no YM2612
DAC channel on the NES), while a VGM conversion can come back with either,
both, or neither populated depending on which channels the source actually
used. Neither renderer is a complete chip emulator: the noise path is
LFSR-only (SN76489/HuC6280), and the DAC path plays back the real captured
PCM sample bytes but performs no semantic drum classification — see
`vgm2midi/CLAUDE.md`'s "Hardware-noise conversion" and "Added: `--dac-wav`"
sections for exactly what each does and does not cover.

**Why the stem paths are fixed siblings of the converted `.mid`, and why
`convert_to_midi()` unlinks both before every run**: `web.py` always converts
into the same fixed `converted.mid` inside the session's temp root, so
`convert.chip_stem_path_for()`/`convert.dac_stem_path_for()` derive equally
fixed `converted.chip.wav`/`converted.dac.wav` (different suffixes so the
two never collide when a VGM produces both). Without the
`unlink(missing_ok=True)` at the top of `convert_to_midi()` for *both*
paths, a stem left over from a *previous* conversion in the same session —
a different song, or the same song re-converted with `chipNoise` turned
off — would still be sitting at that path and would silently get treated
as this run's fresh stem: the previous song's noise or DAC audio mixed
under the current one. This is not a hypothetical; it is the exact shape
of bug a fixed output path always risks, and it only manifests on the
*second* conversion in a session, so it's worth stating outright rather
than leaving it implicit in the code.

**Why `chip_stem_path`/`dac_stem_path` live on `WebSession` and are set
*after* `load_midi()`, not before**: `POST /api/source/convert`
(`convert_source()`) calls `web_session.load_midi(...)` to swap in the
newly-converted tracks, and `load_midi()` goes through
`reset_midi_state()` — the same reset every MIDI replacement goes through,
including a plain `.mid` re-upload. `reset_midi_state()` sets both fields
back to `None` (see each field's own doc comment in `web.py`) precisely so
that uploading a plain `.mid` — which never carries a chip stem — can't
inherit a stale one from whatever was loaded before it. That means
`convert_source()` must assign both `web_session.chip_stem_path` and
`web_session.dac_stem_path` *after* `load_midi()` returns, not before, or
the values it just set would be immediately wiped by the reset it
triggers. Unlike `audio_path`, `reset_midi_state()` deliberately does
**not** `unlink()` either stem file here — `convert_to_midi()` writes
whichever stems it produces *before* `convert_source()` calls
`load_midi()`, so an unlink at reset time would delete the files that
conversion just produced. The files themselves are only ever removed by
`WebSession.clear()` tearing down the whole session root.

**Why mixing happens inside `_render_applied_midi()`, not as a separate
step**: `/api/audio` and `/api/download/wav` both go through
`ensure_render()`, which delegates its actual rendering to
`_render_applied_midi()` (see "Speed/pitch is a MIDI-layer edit" above for
why that split exists); `POST /api/variations` calls the same
`_render_applied_midi()` directly, once per combination. Putting the mix
logic in that one shared body — fluidsynth renders to a temporary
`render-NNNN.partN.wav`, `mix.mix_wav()` combines it with whichever of
`chip_stem_path`/`dac_stem_path` actually exist into the real
`render-NNNN.wav` (or a batch combination's own output path), and the
temporary part file is deleted in a `finally` — means every caller picks up
the mixed audio automatically, with no changes needed at any call site.
When neither stem is present, `render_wav()` writes directly to the final path
exactly as before, so `mix.py`/`ffmpeg` are never invoked for an ordinary
MIDI session — this tool does not gain a hard `ffmpeg` dependency for the
common case, only for `chipNoise` conversions. `mix_wav()`'s inputs are a
`Sequence[tuple[Path, float]]` (generalized to N inputs by the
"gameSoundfont" feature below, before the DAC stem existed), so a VGM that
produces both stems mixes three inputs — dry render, noise stem, DAC
stem — with no further change needed to the mixing function itself; only
`ensure_render()`'s job-planning needed to check both `Path | None` fields
independently and append whichever ones resolved to an existing file.

**Why the mix uses fixed gains and `amix`'s `normalize=0`, not a limiter**:
NOISE and DPCM share one non-linear mixing curve on real NES hardware
(`nsf2midi/CLAUDE.md`'s own `--chip-wav` section), so a stem rendered in
isolation is a few dB louder than its true contribution would be alongside
the Triangle channel — a real, bounded, and unfixable-at-the-source
characteristic, not a bug. `mix.mix_wav()` therefore applies a fixed
attenuation to each input (`DRY_GAIN`/`STEM_GAIN` in `mix.py` — made
public, not `_`-prefixed, once the "Added: game-derived SoundFont hybrid
rendering" feature below needed a third gain constant alongside them)
rather than trying to correct the physics, and mixes with ffmpeg's
`amix=inputs=2:duration=longest:dropout_transition=0:normalize=0` —
`normalize=0` is required because `amix`'s default (`normalize=1`) divides
by the input count, which would quietly halve the fluidsynth render's own
volume the moment `chipNoise` is turned on; `dropout_transition=0` pins
away `amix`'s default 2-second crossfade at whichever input ends first
(harmless here since both inputs are the same length by construction, but
worth being explicit about); a limiter was deliberately not used because
its lookahead would make the mixed output non-deterministic relative to a
fixed-gain sum, for a case (two bounded, mostly-non-simultaneous-peak
sources) a limiter isn't actually needed to avoid clipping. The DAC stem
reuses the same `STEM_GAIN` as the noise stem rather than introducing a
fourth gain constant — both are "real hardware audio mixed alongside a
fluidsynth render" in the same sense, and there was no empirical reason
(no observed clipping or measured loudness mismatch) to give YM2612 DAC
sample audio a different headroom than SN76489/HuC6280 noise.

**Why `resolve_ffmpeg_bin()` has only two resolution tiers, not three**:
`render.resolve_midi2wav_bin()`/`convert.resolve_converter_argv0()` both
check a repo-relative path before falling back to `PATH` — but this
repository doesn't vendor `ffmpeg` (unlike `midi2wav.sh` or the three
converter binaries), so there is no repository-relative candidate to check.
The order is `FFMPEG_BIN` env var (fatal if set but not executable — same
"no silent fallback" policy every other `resolve_*_bin()` in this package
follows) → a bare `"ffmpeg"` resolved via `PATH` (`shutil.which()`,
mirroring how `convert.resolve_converter_argv0()` resolves a bare `node`
for `vgm2midi`).

Verified end-to-end with the real (non-mocked) pipeline: a synthetic
hand-built NSF (one tone channel plus Noise, built the same way
`nsf2midi`'s own manual `--chip-wav` verification does) was converted
through a live `create_app()` instance with no fakes injected —
`POST /api/source/convert` with `chipNoise: true` invoked the real
`nsf2midi --chip-wav`, `POST /api/render` rendered through real
`fluidsynth` and mixed through real `ffmpeg`, and `GET /api/download/wav`
returned a real, `afinfo`-valid stereo WAV containing audible content from
both the tone and the noise stem (confirmed non-silent and unclipped by
inspecting the raw PCM samples).

## Added: game-derived SoundFont hybrid rendering (`gameSoundfont`)

`spc2midi` output carries the SNES driver's own raw instrument numbers as
MIDI Program Change values, not GM-mapped ones (see "Why Program Change is
*detected*, never assumed absent" above) — VGMTrans has no semantic
GM-mapping logic for this at all (confirmed by reading its source: the code
path that would translate an instrument index to a GM name is present but
dead/commented out), so a generic GM SoundFont plays back completely
unrelated instruments. `spc2midi --sf2` already solves this the other way:
it builds a real SoundFont from the SPC's own BRR samples, with
Bank/Program numbers that are *structurally guaranteed* to match the `.mid`
it writes alongside it — both come from the same `VGMColl`, and
`SF2Conversion.cpp` writes `wBank`/`wPreset` from the exact same
`vgminstr->bank`/`instrNum` the sequence parser used to write the MIDI's own
Bank Select (CC0) and Program Change. Rendering an spc2midi MIDI through its
own generated SF2 therefore reproduces the original game's actual timbres,
verified against a real rip (Chrono Trigger's "Battle 1") during
implementation: every `(bank, program)` pair present in the `.mid` (e.g.
channel 0's `bank=127, program=0` after a Bank Select) had a matching
`phdr` preset in the `.sf2`, and a real `fluidsynth -v` render produced no
"No preset found" warnings on any channel that actually carried notes (the
one warning it does print — `channel 9 [bank=128 prog=0]` — is fluidsynth's
own default GS percussion-channel initialization, printed unconditionally
for every session regardless of whether channel 10 is used; this SPC output
never puts notes there, consistent with VGMTrans's own
`ConversionOptions::skipChannel10` default of `true`, which spc2midi
inherits because it never calls `ConversionOptions::load()` to override it).

The feature this section covers: convert with `gameSoundfont: true`
(SPC-only, default off) to have `spc2midi --sf2` also produce a SoundFont
alongside the `.mid`; then, with no per-track instrument overrides, the
whole song plays through that game-derived SoundFont instead of the
selected GM one. Every note-bearing track exposes the same `source` contract
used by the VGM selector: `game` means the SPC's original BRR-backed timbre,
and `soundfont` means the selected generic GM SoundFont. `game` is the
computed default, so `WebSession.track_sources` stores only differences from
that default; this keeps payloads explicit without filling session state with
redundant entries. Instrument choice is disabled for `game`, but volume stays
enabled because both render paths keep the MIDI track and its velocity edits.
The first explicit switch to `soundfont` inserts `DEFAULT_GM_PROGRAM` (GM 81,
Lead 1 square) if the editable track has no GM assignment yet. A stored GM
program is retained when switching back to `game`, but `ensure_applied()`
filters assignments by the effective source so game playback preserves the
SPC's original Program Change. Assignment-only PATCH requests retain the old
API behavior: setting a program implies `soundfont`, and clearing it implies
`game`, unless an explicit source is sent in the same request.

**Why this needed splitting the MIDI into two files and rendering/mixing
twice, instead of one fluidsynth call**: a game-derived SoundFont and a
generic GM SoundFont are different bank spaces — program 0 in the game SF2
is "BRR sample slot 0," not GM's Acoustic Grand Piano — so one MIDI cannot
be correctly played by two SoundFonts loaded together in a single
`fluidsynth` call the way `midi2wav.sh` invokes it (it only ever accepts
one `SOUNDFONT` argument in the first place; see root `CLAUDE.md`). Editing
SF2 preset headers at the byte level to remap one SoundFont's Bank/Program
numbers into the other's namespace was considered and rejected as
disproportionate complexity for what `midi.write_track_subset()` +
`mix.mix_wav()` already do cheaply: split the MIDI along the effective
per-track `source` partition, render each half separately, and sum the two
WAVs.

**Why `write_track_subset()` strips messages rather than deleting tracks**:
`mido.MidiTrack` messages form a delta-time chain, so removing a whole
track can lose a tempo map or time signature that happened to live there,
and changes every subsequent absolute tick if reconstructed carelessly.
Instead, both output MIDIs keep *every* original track; a track not in the
kept set has its non-meta messages (`note_on`/`note_off`/`program_change`/
`control_change`/pitch bend) stripped out, with each stripped message's
delta-time carried forward onto the next surviving message (or onto the
final `end_of_track` if nothing follows) so the track's total tick length
—and therefore both outputs' rendered duration — is provably unchanged.
This is the same "never touch delta-time; only mutate/insert with `time=0`"
discipline `apply_assignments()` already documents above, applied to
deletion instead of insertion. A side effect worth knowing: if two
*different* tracks happen to share one MIDI channel (uncommon for spc2midi,
whose driver-per-channel-per-track model normally keeps this 1:1, but not
structurally impossible), stripping one track's messages cannot leak its
Program Change onto the other kept track sharing that channel — because
messages are removed per-track, not per-channel — but it does mean a
channel-wide CC (e.g. pan) sent from the *dropped* track is lost from that
channel entirely, a known, accepted approximation.

**Why the GM-bound half also strips Bank Select (CC0/CC32)**:
`write_track_subset(..., strip_bank_select=True)` removes CC0/CC32 only
from the kept tracks on the GM-soundfont side. spc2midi sends CC0 with
`progNum >> 7` under VGMTrans's GS bank-select style — meaningful only
inside the game-derived SF2's own bank layout. Sent unmodified to a generic
GM SoundFont, fluidsynth would look for a preset in a bank that SoundFont
never defines and silently keep whatever program was previously active on
that channel instead of the one actually requested. The game-soundfont side
keeps Bank Select untouched — it needs it precisely to reach the same
banks its own SF2 defines.

**Why the split happens after `apply_assignments()`, not before**:
`apply_assignments()`'s own invariant is "always re-read
`original_path` from scratch," so running it twice against two
already-split fragments would double the bookkeeping (its `updated`/
`inserted` summary) for no benefit; splitting the *already-applied*
`miditrack_edited.mid` instead means the split step only ever has to reason
about one finished, timing-correct MIDI. It also means `GET /api/download`
keeps returning that one combined file — the split is purely an internal
rendering detail, never a user-visible artifact.

**Why the mixing gain differs from the `chipNoise` stem mix**:
`mix.py` now exposes `DRY_GAIN`/`STEM_GAIN` (renamed from the earlier
`_DRY_GAIN`/`_STEM_GAIN`, see above) plus a new `SPLIT_GAIN = 1.0`. The
`chipNoise` mix combines two *physically distinct* signal sources (a
fluidsynth render and a real hardware noise/DPCM emulation) whose combined
loudness genuinely exceeds either alone, so it needs headroom. The
game/GM split is different: it is one arrangement cut into two disjoint
track subsets, rendered separately, and summed back — mathematically the
same total energy a single combined render would have produced, so no
headroom is taken (`amix`'s `normalize=0` still applies, since `amix`'s own
default would otherwise divide by input count and quietly halve the
volume). Verified against a real split-and-mix render (Chrono Trigger's
"Battle 1" with one track reassigned to a GM organ patch): the resulting
WAV peaked at 17.5% of full scale, no clipping, and played the reassigned
track through the GM SoundFont while every other track kept the game's
original BRR timbres.

**Why `mix.mix_wav()` became N-input instead of staying fixed at two**:
`ensure_render()` can now need up to three simultaneous inputs in principle
(game-soundfont part, GM-soundfont part, and a future NSF/VGM `chipNoise`
stem — SPC has no `chipNoise` option today, but the mixer itself has no
reason to assume it never will), so `mix_wav()` takes a
`Sequence[tuple[Path, float]]` of `(wav_path, gain)` pairs and
`build_filter_complex()` generates the matching `-i`/`aformat`/`volume`/
`amix=inputs=N` chain dynamically instead of a hardcoded two-input string.
The `chipNoise` path is unaffected in output — same two gains, same
`normalize=0`/`duration=longest`/`dropout_transition=0` — only its internal
temp-file name changed (`render-NNNN.dry.wav` → `render-NNNN.part0.wav`,
now that "which numbered part is this" generalizes across both features
sharing the same mixing machinery). This generalization stopped being
theoretical the moment vgm2midi grew `--dac-wav` alongside its existing
`--noise-wav` (see "Added: real chip-noise mixing" above): a VGM that uses
both the PSG and the YM2612 DAC channel already needs 3 inputs (dry render +
noise stem + DAC stem) with no `gameSoundfont` split at all, and a
hypothetical SPC-like game-soundfont split combined with both VGM stems
would need 4 — validating that the N-input design was worth doing up front
rather than hardcoding two.

**Why `.dls` was never considered as an alternative to `.sf2`**: fluidsynth
on this project's Homebrew install (`fluid-synth` 2.6.0) does not link
`libinstpatch` (`otool -L libfluidsynth.3.dylib | grep instpatch` returns
nothing), so it cannot load DLS files at all regardless of what
`spc2midi --dls` produces or what `midi2wav.sh` would pass through
unchecked (its own `-s`/`--soundfont` argument has no extension
allowlist). `.sf2` was never in question as the only usable format here.

**Why `spc2midi` itself was not touched**: `web.py`/`convert.py` only need
to pass `--sf2` and derive the resulting path — `spc2midi::ReplaceExtension`
(same repo, `src/paths.cpp`) already turns `converted.mid` into
`converted.sf2` deterministically, exactly the pattern
`chip_stem_path_for()` already uses for the NSF/VGM noise stem
(`convert.game_soundfont_path_for()` mirrors it line for line). A
CLI-level `spc2midi --wav` option that automatically renders through its
own just-written `.sf2` was considered and explicitly deferred: miditrack
never calls `spc2midi --wav` in the first place (it renders through
`midi2wav.sh` itself, independently), so that option would have zero value
for this feature and was not worth the C++ rebuild + prebuilt-binary
recommit it would require.

**Why an empty/failed SF2 always degrades to the ordinary GM render,
never an error**: `spc2midi --sf2` warns and skips writing the SoundFont
(without a nonzero exit) whenever `instrSets()` is empty for that
sequence — a legitimate, non-error outcome for some games/drivers.
`convert.produced_game_soundfont()` treats "file doesn't exist" and "file
exists but is implausibly small" (`_MIN_GAME_SOUNDFONT_BYTES = 64`, well
below any real RIFF/sfbk SoundFont) identically as "not produced," and
every downstream layer — `WebSession.game_soundfont_path` staying `None`,
`_plan_render_jobs()` short-circuiting to the single ordinary GM job —
treats that exactly like `gameSoundfont` never having been requested at
all, so a song without usable instrument data still converts and plays
normally.

## Added: NSF per-track hardware selection, and unifying the three formats' vocabulary onto `"game"`

Before this feature, "use the original sound source" meant three genuinely
different mechanisms with three different UIs: SPC offered a per-track
`"game"`/`"soundfont"` choice (a BRR-sample-derived SoundFont bank swap,
see "Added: game-derived SoundFont hybrid rendering" above), VGM offered a
per-track `"libvgm"`/`"soundfont"` choice (libvgm physical-channel
rendering, see "Added: real chip-noise mixing" above), and NSF had no
per-track choice at all — `chipNoise` only ever produced one fixed
Noise+DPCM stem mixed unconditionally into the whole render. `nsf2midi`
gained `--track-metadata`/`--chip-render` (its own `CLAUDE.md`) so NSF
could reach the same per-track granularity VGM already had — every NES
channel maps to exactly one MIDI track with no ambiguous sharing, so
(unlike VGM's AY/SSG, HuC6280, and YM2151-noise carve-outs) *every*
channel is safely selectable and always marked `suggestedForHardwareMix`.

**The value itself is now `"game"` everywhere, not `"libvgm"` for VGM.**
`libvgm.validate_sources()`'s accepted value set changed from
`{"soundfont", "libvgm"}` to `{"soundfont", "game"}`, and every VGM
call site (`WebSession.track_sources`, `track_payload()`'s
`availableSources`, the frontend's `<option>` values) follows. This was a
deliberate part of the unification, not an implementation detail: it means
`WebSession.track_sources`/`availableSources` are now spelled identically
across all three formats, and a frontend that only ever sees `"game"`/
`"soundfont"` doesn't need to know which of the three underlying
mechanisms produced a given track's `"game"` option. `CHIP_HARDWARE_SOURCE_FORMATS
= ("vgm", "nsf")` (`web.py`) is the one place that still has to
distinguish "`game` means physical-channel hardware rendering" (VGM/NSF,
stripped from the FluidSynth MIDI and rendered by a separate process) from
"`game` means a SoundFont bank swap" (SPC, stays in the FluidSynth MIDI,
just routed to a different `.sf2`) — every render-planning/volume-slider
decision that needs to tell the two apart checks this tuple against
`WebSession.source_format` rather than the source string itself.

**`src/miditrack/nsf_chip.py`** is the NSF counterpart of `libvgm.py`,
built to the same contract (`NsfChipMetadata`/`NsfChipTarget`,
`metadata_path_for()`, `load_metadata()`, `validate_sources()`,
`render_selection()`) but deliberately not sharing code with it — this
project's existing convention for the three sibling converters (see root
`CLAUDE.md`'s "no shared code between the three sibling converters" for
`midi2wav.{h,cpp}`/`.ts`) extends naturally here since NSF and VGM reach
their hardware audio through genuinely different mechanisms:

- **No device/instance/mask concept.** `NsfChipTarget` is just
  `{channel: str, group_id: str, suggested: bool}` — `channel` is the same
  human-readable NES channel label (`"SQ1"`, `"NOISE"`, …) `nsf2midi`
  already uses for MIDI track names, not a numeric bitmask. `group_id`
  always equals `channel` itself (NES has no shared-physical-channel
  case), so `group_indices()`'s group-expansion machinery — inherited
  unchanged from the same pattern `libvgm.py` established — is always a
  no-op singleton for NSF, but keeping the identical shape means
  `_validate_track_sources()`'s VGM/NSF branches read the same way and a
  future NES-family expansion chip with real channel sharing (none exist
  today) would not need a schema change.
- **`resolve_helper()` reuses `convert.resolve_converter_argv0()`
  directly** instead of a separate native-binary resolution path — unlike
  libvgm (a large external C library, built once via
  `vgm2midi/scripts/build-native.sh` into a separate pinned helper binary,
  see `vgm2midi/CLAUDE.md`), NotSoFatso is already statically linked into
  the `nsf2midi` binary itself, so "the helper" *is* `nsf2midi`, invoked
  with a new `--chip-render` mode instead of a second executable. This
  means `nsf_chip.py` needs no new environment variable, build step, or
  binary-resolution logic of its own — `NSF2MIDI_BIN`/repo-relative
  resolution, already used for ordinary conversion, is reused as-is.
- **Why the import is deferred into `resolve_helper()`'s function body,
  not `from . import convert` at module top level**: `convert.py` imports
  `nsf_chip.metadata_path_for` (aliased `nsf_chip_metadata_path_for`, the
  same pattern it already uses for `libvgm.metadata_path_for`) to derive
  the sidecar path passed to `--track-metadata`. Since `nsf_chip.py` in
  turn needs `convert.resolve_converter_argv0()`/`convert.format_by_key()`
  to invoke `nsf2midi`, a module-top-level `from . import convert` in
  `nsf_chip.py` combined with a module-top-level *specific-name* import in
  `convert.py` (`from .nsf_chip import metadata_path_for as ...`) fails
  under one of the two possible import orders — whichever module starts
  importing first ends up asking the other, still-partially-initialized
  module for a name that hasn't been defined yet at that point in its
  execution. `organize_playlists.py`/`youtube_upload.py` already document
  and rely on the same fix elsewhere in this repository (see root
  `CLAUDE.md`'s `youtube_upload.py` section): defer the import into the
  function body that actually needs it, so it only resolves at call time,
  by which point both modules have finished executing. Verified directly
  by importing `miditrack.convert` first and `miditrack.nsf_chip` first in
  separate fresh interpreter processes — both succeed.
- **`render_selection(source_path, output_path, sample_count, targets,
  track)` always re-invokes `nsf2midi --chip-render` against the
  *original* `.nsf` file**, never a cached WAV, because the set of
  selected channels can change at any point in the session (a track
  flipped back to `"soundfont"` via `PATCH /api/session/tracks`) and the
  only way to get a hardware-accurate combined render of an arbitrary
  channel *subset* is one fresh emulation pass with everything else muted
  (see `nsf2midi/CLAUDE.md`'s explanation of why Noise/DPCM/Triangle and
  Square1/Square2 each share a non-linear mixing table, and therefore
  can't be rendered independently and summed). This is why `track` — the
  `-t`/`--track` song index used at the *original* conversion — has to be
  threaded through and reissued on every re-render, unlike VGM's
  `libvgm.render_selection()`, which needs no song index because a
  `.vgm`/`.vgz` file is always exactly one song: `WebSession.source_song_index`
  is set from `options.get("songIndex")` right alongside `chip_metadata`
  in `convert_source()`, survives everything `PATCH /api/session/tracks`
  does (it's a `source_*`-bucket field, not MIDI-derived state), and is
  reset only by `WebSession.clear()` — the same lifecycle
  `source_metadata`/`source_songs` already have.
- **`ensure_render()`'s libvgm-specific block became a `source_format`
  dispatch** between `render_libvgm()` and the newly-injectable
  `render_nsf_chip()` (`create_app(nsf_chip_renderer=...)`, mirroring
  `libvgm_renderer`), writing to a now-neutrally-named
  `render-NNNN.chiprender.wav` (was `render-NNNN.libvgm.wav`) — the rest
  of the mixing/stem-sync/temp-file-cleanup machinery
  (`_synced_stem()`/`mix.STEM_GAIN`/`stem_sync_dir`) is completely
  unchanged and applies identically regardless of which renderer produced
  the stem.
- **Why `chipNoise`'s preselection is simpler for NSF than VGM**: VGM's
  `chipNoise` only auto-selects targets whose `suggestedForHardwareMix` is
  `true` (a conservative subset — AY/SSG, HuC6280, and YM2151-noise
  targets are deliberately never auto-selected because they can share a
  physical channel with an independently-meaningful tone track). Since
  every NSF target is always `suggested`, checking NSF's `chipNoise`
  simply hardware-selects every note-bearing channel — the exact same
  `if options.get("chipNoise"): track_sources = {index: "game" for index,
  target in track_metadata.targets.items() if target.suggested}` code
  in `convert_source()` (shared verbatim between VGM and NSF, keyed only
  on which metadata loader produced `track_metadata`) happens to select
  "only the safe subset" for VGM and "everything" for NSF, purely as a
  consequence of what each format's sidecar reports as `suggested` — no
  format-specific branch was needed in the preselection logic itself.
- **Legacy `--chip-wav` fallback preserved.** `convert.convert_to_midi()`
  no longer requests `--chip-wav` for NSF at all (`_build_argv()`'s NSF
  branch now always requests `--track-metadata` instead) — but the
  function's final `produced()` check (does `chip_stem_path_for(output_path)`
  exist and look like a real WAV?) is untouched, so a pre-sidecar
  `nsf2midi` binary that still only understands `--chip-wav` and never
  writes a `--track-metadata` sidecar continues to work exactly as before
  through `WebSession.chip_stem_path`'s original whole-stem-mix path (see
  "Added: real chip-noise mixing" above) — `convert_source()`'s
  `if track_metadata is not None: ... else: chip_stem_path = ...` branch,
  already written for VGM's own sidecar-vs-legacy split, needed no NSF-
  specific change to cover this.
- **Frontend vocabulary**: `buildTrackRow()`'s source `<option>` labels
  collapsed from three spellings (`"原曲の音色"` for SPC, `"libvgm（推奨）"`/
  `"libvgm（実機音）"` for VGM) to two, shared by all three formats:
  `"原曲の音源"` (append `（推奨）` when `track.sourceSuggested`) and
  `"SoundFont"`. The row highlight class renamed from `is-libvgm` to the
  format-agnostic `is-hardware`. The volume-slider disable rule at the time —
  SPC's `"game"` kept the slider enabled (it's still a FluidSynth render,
  just through a different bank), VGM/NSF's `"game"` disabled it (the audio
  never touched FluidSynth's velocity handling at all) — was driven by a
  small `CHIP_HARDWARE_SOURCE_FORMATS` constant mirrored in `app.js`
  (`isChipHardwareFormat()`) rather than a hardcoded `=== "libvgm"` check,
  so it stayed correct for both VGM and NSF without duplicating the
  distinction in two places. **This disable rule no longer exists** — see
  "Why per-track volume on VGM/NSF `"game"` tracks re-renders only the
  channels whose volume actually changed" above; `isChipHardwareFormat()`
  itself is unchanged and still used for the `is-hardware` row highlight.
- Verified end-to-end against a real synthetic multi-track NSF through a
  live, fully non-mocked `create_app()` (real `nsf2midi`, real
  `fluidsynth`, a real `.sf2`): converting with `chipNoise: true` correctly
  hardware-selected all five note-bearing channels (`SQ1`/`SQ2`/`TRI`/
  `NOISE`/`PCM`, each `sourceSuggested: true`) while the conductor track
  (no notes) stayed on `"soundfont"` with no `"game"` option offered; the
  resulting WAV was confirmed non-silent with sample values matching a
  direct `nsf2midi --chip-render SQ1,SQ2` CLI run of the same channels;
  switching one channel back to `"soundfont"` via `PATCH
  /api/session/tracks` correctly re-enabled that track's volume slider
  while the remaining hardware-selected tracks' sliders stayed disabled
  (true at the time of this verification, before per-track volume on
  `"game"` tracks existed), and re-rendering produced a new, correctly
  larger WAV (FluidSynth now also contributing that one track's audio)
  with no leftover temp files.

`tests/test_nsf_chip.py` mirrors `tests/test_libvgm.py` exactly (sidecar
load/validation, out-of-range track index, missing-sidecar back-compat,
`validate_sources()`'s value-set/rejection cases, and `render_selection()`'s
argv shape including duplicate-channel de-duplication and both the
zero-target and nonzero-exit `RenderError` paths). `tests/test_web.py`
gained `TestWebAppNsfChipTrackSource`, symmetric with the existing
`TestWebAppLibvgmTrackSource` (same fixture shape, one non-suggested and
one suggested target, so both classes exercise the identical
preselection/PATCH/render-dispatch logic through their respective
formats) — plus a fake `list_songs` injection that `TestWebAppLibvgmTrackSource`
doesn't need, since NSF (`supports_song_list=True`) calls it from
`POST /api/source` where VGM (`supports_song_list=False`) never does.

## Added: dark mode (`prefers-color-scheme`, no manual toggle)

`index.html`'s `<meta name="color-scheme">` was `light` only and `app.css`
had a single, light-only palette — every color was a `--neutral-*`/`--brand*`
custom property in `:root`, which made this a CSS-only change with no
`app.js`/`web.py` involvement. There is no manual light/dark switch: no
sibling web tool in this repository (`tools/pixelart_web_assets`,
`tools/make_videos_web_assets`) has one either, and adding a toggle would
need new session-scoped state (`localStorage`, or a server-side preference)
for a single-user local tool where the OS-level preference is already the
right signal. `index.html`'s `<meta name="color-scheme" content="light dark">`
plus `color-scheme: light dark;` on `:root` (`app.css`) is what lets native
form controls (`<select>`, `<input>`, `<audio>`) pick up dark rendering
automatically, on top of the `@media (prefers-color-scheme: dark)` override
block.

**Why the dark override just re-points the existing `--neutral-*` scale
instead of a parallel dark palette**: every rule in `app.css` already
treats the neutral scale semantically low-to-high (`--neutral-0` = lightest
background, `--neutral-100` = darkest text) consistently across `color`
and `background` — so redefining only those custom properties inside the
`prefers-color-scheme: dark` block, without touching a single selector,
flips every consumer at once. `--brand-light` (the subtle blue-tinted
background/row-highlight tone) and `--brand-dark` (icon strokes, the
gradient's dark stop, the volume-slider `accent-color`) get their own
dark-mode values for the same reason — `--brand-dark`'s light-mode value
(`#5674b9`) reads fine on white but is too close in luminance to the dark
palette's own background tones, so dark mode lightens it to `#6a8ecf`.
`--warning` (`#b45309`, a dark amber) is brightened to `#eab308` for the
same reason — it colors the ⚠ warning control and its Popover border, where
the light-mode value's low luminance would fail contrast against a dark card
background. `--success`/`--danger` needed no change: both are only ever
used as toast *backgrounds* under fixed white text, so their contrast is
theme-independent.

**Why `--toast-bg` exists as a separate token from `--neutral-100`**: before
this change, `.status-toast`'s background was `var(--neutral-100)` directly
— reusing the same "darkest neutral" property that also colors primary body
text. That works only because in light mode "darkest neutral" and "always-
dark chip background" happen to be the same value; inverting the scale for
dark mode makes `--neutral-100` become the *lightest* neutral (correct for
body text, which must turn light-on-dark), which would have turned the toast
into a near-white box behind its own hardcoded white text. `--toast-bg` is
defined once from `--neutral-100` in the light-mode `:root` (so it starts
identical to the pre-existing behavior) but is given its own fixed dark
value (`#10151d`) inside the dark override, decoupled from the neutral
scale's inversion — the general lesson being that a custom property reused
for two different semantic roles (foreground vs. a fixed-dark chrome
element) cannot be inverted as one variable once both roles need to move in
opposite directions.

The one other hardcoded, non-variable color found during this change —
`.button.secondary`'s `background: #fff` — was switched to
`background: var(--neutral-0)` so the secondary button's surface also
flips; every other literal `#fff`/`rgba(255,255,255,…)` in the stylesheet
(`.app-header` and its children, `.button.primary`, `.step-number`,
`.status-toast`'s text color) sits on the brand gradient or the
theme-independent `--toast-bg`, both of which keep a dark surface in either
theme, so white text there is correct regardless of the OS setting and was
deliberately left as-is.

## Added: favorite instrument shortlist and SoundFont selection, persisted server-side

Each track row's instrument `<select>` gained a pin button (☆/★) and a
"よく使う" `<optgroup>` at the top, built from whichever GM programs are
either manually pinned or ranked by selection frequency (`app.js`'s
`buildFavoriteProgramsOptgroup()`, capped at `MAX_FAVORITE_PROGRAMS = 8`,
pinned entries first). This is purely a frontend convenience — the server's
GM catalog (`gm.py`) is untouched; the favorites group is just a
client-side reordering of programs that already exist in the full list.

**Why this is persisted server-side (`GET`/`PATCH /api/preferences`,
`src/miditrack/preferences.py`) instead of the browser's `localStorage`,
which every other piece of frontend-only state in this app already uses**:
`run_server()` starts `make_server("127.0.0.1", 0, app, ...)` — port `0`
means the OS picks a free port fresh on every launch (see "Why WAV became a
real download" section's discussion of `render_id` for the token/URL
implications of this same fact). `localStorage` is scoped per *origin*
(`scheme://host:port`), so a value saved under `http://127.0.0.1:57774`
is invisible to the next launch's `http://127.0.0.1:57861` — the favorite
list would silently reset on every single restart, which defeats the
entire point of a persistent "recently/frequently used" shortlist. This
was caught by the user directly observing that the port changes across
launches and asking whether the favorites would survive it — they don't,
under `localStorage`, which is why this feature is the one piece of UI
state in this app that talks to a server endpoint instead of browser
storage.

`preferences.py` mirrors the shape of every other settings-like piece of
state in this package (`render.py`'s SoundFont resolution, `WebSession`'s
`soundfont_override`): `preferences_path()` resolves to `~/Library/
Application Support/miditrack/preferences.json` by default, with a
`MIDITRACK_PREFERENCES_PATH` env var override — not for runtime
flexibility (unlike `MIDI2WAV_BIN`/`PITCH_SHIFT_BIN`, no ordinary user is
expected to set this), but purely so tests can point it at a temp
directory instead of writing into the real user's home directory (see
`tests/test_preferences.py`, `TestWebAppPreferences` in `test_web.py`).
`load_preferences()` treats a missing file, invalid JSON, or a JSON value
that isn't an object as equally "no preferences yet" rather than an
error — this file is optional, ephemeral-loss-tolerant state, not
something whose absence should ever block the app from starting.
`save_preferences()` follows the same "partial update" contract
`PATCH /api/session/transform` already established: only the keys present
in the request body are validated and replaced, the other field is carried
over from the current file untouched. Validation reuses `gm.py`'s
`GM_PROGRAM_NAMES` length (128) as the valid program range, so this module
never hardcodes "0–127" independently of the single source of truth for
the GM table.

This setting is process-wide, not per-`WebSession` — the favorites list
(and, as of the addition below, the selected SoundFont) is explicitly
meant to survive across MIDI uploads, resets, and even full process
restarts, so it was never a candidate for `WebSession` fields in the
first place.

**SoundFont selection was folded into the same file** once the same
port-changes-every-launch problem was pointed out for it too:
`POST /api/soundfont` (the endpoint the "試聴" card's SoundFont dropdown
calls) now also calls `preferences.save_preferences({"selectedSoundfont":
...})` right after updating `web_session.soundfont_override`, using the
same string-or-`None` shape `pinnedPrograms`/`usageCounts` already
established. `WebSession.soundfont_override` itself is unchanged — it's
still the runtime source of truth `render_endpoint()`/`ensure_render()`
read every time (`web_session.soundfont_override or soundfont`, see
"Added: in-browser SoundFont selection" above) — `preferences.json` is
purely *where that same value gets remembered* for the next launch, not
a second place the app reads from during a running session.

`resolve_startup_soundfont_override(explicit_soundfont)` is the one new
function that bridges the two: called from `run_server()` before
`create_app()`, it returns the saved path only when `explicit_soundfont`
(the CLI's own `--soundfont`) is `None` and that saved path still points
at a real `.sf2`/`.sf3` file (`render.is_soundfont_file()` — a SoundFont
deleted or moved since the last launch is silently treated as "nothing
saved," not an error) — otherwise it returns `None`, keeping the existing
"CLI argument beats everything else when explicitly given" precedence
`soundfont_override or soundfont` already encodes. Deliberately kept out of
`create_app()` itself (unlike `preferences.load_preferences()` for
favorites, which *is* read by an endpoint handler inside `create_app()`):
`create_app()` is called directly by every test in `test_web.py` with a
fresh `WebSession()`, and letting `create_app()` silently reach into the
real user's `preferences.json` on every one of those calls would make
test isolation depend on nobody's real `~/Library/Application Support/
miditrack/preferences.json` ever containing a `selectedSoundfont` — a
fragile assumption `test_web.py`'s `setUpModule()`/`tearDownModule()`
already have to work around for the `POST /api/soundfont` tests, which
now write into a module-wide temp `MIDITRACK_PREFERENCES_PATH` for
exactly this reason. `resolve_startup_soundfont_override()` is instead
called exactly once, by `run_server()`, which is the one caller that
represents an actual `miditrack` launch.

`app.js`'s `state.pinnedPrograms`/`state.usageCounts` start empty and are
populated by `loadPreferences()`, called once from `init()` before
`loadSoundfonts()`/the initial `/api/session` fetch — so the first
`buildTrackRow()` render already has the favorites data available and
never needs a second pass. `savePinnedPrograms()`/`saveUsageCounts()` are
fire-and-forget `PATCH` calls: the visible UI update (the pin button's ★/☆,
the `<optgroup>` contents) always happens synchronously in the same
function that mutates `state`, so a slow or failed save never desyncs what
the user sees from what they just clicked — only the next launch's
favorites list would be missing that one change.

## Why the venv is package-local, not at the project root

Root `CLAUDE.md` explains that `.venv-align`/`.venv-pixelize` live at the
project root specifically because their wrapper scripts live under
`tools/` and resolve `TOOLS_DIR/..`. `miditrack` is not part of that
group — it's an independent bundled package, the same category as
`note_ext/`/`rec2ass/`/`nsf2midi/`/`spc2midi/`/`vgm2midi/` — so its
`.venv` lives inside `miditrack/` itself, following `note_ext/note_ext.sh`'s
exact pattern (`NOTE_EXT_DIR/.venv`, no reference to the project root).
Flask is pinned to the same `3.1.3` version `.venv-pixelize` has installed,
purely so the two unrelated Flask apps in this repository behave
identically and one upgrade decision covers both — they never share an
environment.

## Testing

```
cd miditrack
PYTHONPATH=src python -m unittest discover -s tests -v
python -m compileall -q src tests
bash -n miditrack.sh
```

`tests/test_gm.py`, `test_midi.py`, `test_render.py`, `test_convert.py`,
`test_pitch_shift.py`, and `test_preferences.py` need no real MIDI file,
fluidsynth, or converter/`pitch_shift.sh` subprocess, or Flask test
client. `test_preferences.py` sets `MIDITRACK_PREFERENCES_PATH` to a temp
file in `setUp()`/restores it in `tearDown()` so it never reads or writes
the real user's `~/Library/Application Support/miditrack/preferences.json`;
it covers the missing-file/corrupt-JSON/non-dict-JSON fallbacks, the
partial-update contract, every validation rule (program range, `bool`
rejection, non-integer keys, negative counts), and the same round-trip/
clear-to-`None`/rejects-non-string/rejects-empty-string coverage for
`selectedSoundfont`. `test_web.py`'s `TestWebAppPreferences` does the same
env-var isolation for the `GET`/`PATCH /api/preferences` endpoints (the
whole module's `setUpModule()`/`tearDownModule()` additionally redirect
`MIDITRACK_PREFERENCES_PATH` for every test in the file, since
`POST /api/soundfont` — exercised by several pre-existing `TestWebApp`
tests — now writes to this file too), and includes
`test_preferences_survive_across_separate_apps`/
`test_selected_soundfont_survives_across_separate_apps` — the regression
guard that two independent `create_app()` instances (standing in for two
separate `miditrack` launches on two different ports) see the same
persisted favorites/SoundFont, which is the entire reason this feature
isn't `localStorage`. `TestResolveStartupSoundfontOverride` covers
`resolve_startup_soundfont_override()` directly: an explicit `--soundfont`
always wins (returns `None` regardless of what's saved), a saved SoundFont
is restored when no explicit one is given, no saved SoundFont or a saved
path that no longer exists on disk both return `None`. `test_midi.py` builds
its fixtures with `mido` in-process, `test_render.py` mocks
`subprocess.run` to assert argv shape (`shell=False`, `-f` present, options
before positionals, `MIDI2WAV_BIN` never silently falls through), and
`test_convert.py` does the same for `nsf2midi`/`spc2midi`/`vgm2midi`
(per-format argv shape, `<FORMAT>_BIN` never silently falling through,
`-l`/`--list` stdout parsing against literal sample output shaped like the
real `printf` formats in `nsf2midi/src/main.cpp`/`spc2midi/src/main.cpp`,
m3u parsing against literal sample playlists — including comma-containing
titles and hex track numbers — and ZIP extraction, including zip-slip
absolute-path/`..` rejection and the member-count/uncompressed-size caps,
built with real `zipfile.ZipFile` writes to temp directories, no mocking
needed since `zipfile` itself has no external side effects).
`test_pitch_shift.py` mirrors `test_render.py`'s approach: it mocks
`subprocess.run` to assert argv shape (`-s`/`-p` per speed/pitch, `cwd` set
to the work directory, `shell=False`), covers `resolve_pitch_shift_bin()`'s
same three-tier resolution order, and that `run_pitch_shift()` diffs
`work_dir`'s `*.wav` files before/after the call rather than trusting a
predicted filename (including that a pre-existing leftover `.wav` in
`work_dir` isn't mistaken for freshly generated output). The speed/pitch
defaulting/range/count-cap validation this module used to own moved to
`midi.validate_variation_options()` when the batch-variations feature
became a MIDI-layer edit — see `TestValidateVariationOptions` in
`test_midi.py` below. `test_mix.py`
mirrors `test_render.py` too: it mocks `subprocess.run` to assert
`shell=False`, that the `-filter_complex` string literally contains
`normalize=0`/`duration=longest`/`dropout_transition=0`, that `-nostdin` is
present, that the dry input is passed before the stem input, and the same
env-var/PATH resolution and failure-mode coverage (`FFMPEG_BIN` never
silently falling through, non-zero exit, timeout, empty output) as
`test_render.py`'s own `RenderError` cases. `test_web.py` uses
`create_app(renderer=<fake>, list_songs=<fake>, converter=<fake>,
pitch_shifter=<fake>)` so no real `fluidsynth`, converter, or
`pitch_shift.sh` process is spawned; it does directly verify
`Range: bytes=...` returns `206` with a `Content-Range` header, which is
the actual seek guarantee, that `GET /api/download/wav` renders on
demand but reuses an existing render rather than re-rendering, that a
bundled `.m3u` (uploaded alongside a source file, or found inside a ZIP)
correctly overrides song labels only for the file it actually names, that
`POST /api/source/select-file` correctly switches which ZIP member is
active (re-running song listing) without requiring a fresh upload, and
that `POST /api/variations` produces the expected number of combinations
from the default lists (15 = 3 speeds × 5 transposes), honors custom
`speeds`/`transposes`, rejects an over-large combination count, a
non-integer transpose, and a non-`bool` `includeMidi` with `400` without
ever calling the injected `renderer`, applies the session's current track
assignments to every combination, never touches the injected
`pitch_shifter` when no chip stem is present (the headline regression
guard that the batch path is fully MIDI-layer now, not a `rubberband`
post-process), leaves the session's own `speed`/`transpose` and the
existing audition render (`/api/audio`) untouched by a batch run, cleans up
`variations_work/` and every `render-*.partN.wav`/split-MIDI temp file
afterward, and that `GET /api/download/variations` returns a ZIP
containing a `.wav` and a `.mid` per combination by default (with filenames
encoding speed/transpose and the `.mid` verified via `mido` to carry the
correctly scaled tempo and shifted note) — or only `.wav` files, with every
`items[]` entry's `"mid"` field `null`, when `includeMidi: false` is
passed — and is invalidated by a subsequent track change. A dedicated
`TestWebAppChipStem` class (its own `create_app()`
with an injected `mixer=<fake>`, separate from the rest of `test_web.py`'s
`TestWebApp`, which never injects one) covers the `chipNoise` mixing path:
converting with `chipNoise: true` sets `hasChipStem` in the session
payload, `ensure_render()` routes fluidsynth's output to a `.partN.wav` and
mixes it with the stem rather than rendering straight to the final WAV,
the part file is deleted afterward, re-assigning an instrument re-mixes
against the *same* stem, uploading a plain `.mid` clears `chip_stem_path`
and `hasChipStem`, `GET /api/download/wav` receives the mixed audio, a
`MixError` from the injected mixer surfaces as `502`, converting *without*
`chipNoise` never calls the injected mixer at all (the regression guard
for not adding a hard `ffmpeg` dependency to the ordinary case), and that
a `POST /api/variations` batch mixes every combination independently while
only syncing the stem (via the injected `pitch_shifter`) for combinations
whose own speed/transpose isn't the default — the sharpest guard that this
decision is made per-combination, not per-session or "always sync because
it's a batch." The same class's
`test_ensure_render_mixes_both_noise_and_dac_stems_when_both_present`
covers the YM2612 DAC extension specifically: a fake converter that returns
both a chip (noise) stem and a DAC stem sets both `hasChipStem` and
`hasDacStem` in the session payload, and the single `mix_wav()` call
receives exactly three inputs (dry render, then the noise stem, then the
DAC stem, in that order) rather than two — the regression guard for
`ensure_render()`'s independent `stem`/`dac_stem` existence checks actually
composing correctly instead of one silently overwriting the other.
`test_convert.py`'s `TestConvertToMidiChipNoise` separately covers
`convert_to_midi()`'s `(chip_stem_path, dac_stem_path)` tuple return itself
— both stems produced, only one produced (either direction, modeling a
source with PSG noise but no DAC activity or vice versa), neither produced,
and that a stale stem from a *previous* conversion is unlinked for both
paths before a run that doesn't reproduce it. `test_wrapper.py` is adapted
line-for-line from `note_ext/tests/test_wrapper.py`.

`test_midi.py`'s `TestWriteTrackSubset*` classes cover the `gameSoundfont`
split function directly: kept-track note timing is byte-for-byte unchanged,
a dropped track's non-meta messages are gone while a meta-only track (e.g.
a tempo track) survives regardless of which set it's in, each track's total
tick length (and therefore rendered duration) is preserved, the returned
"has sounding notes" flag is correct including the empty-subset case,
Bank Select (CC0/CC32) is removed only when requested while other CCs
(e.g. CC7 volume) survive, and — the scenario that motivates stripping
messages instead of channels — two different tracks sharing one MIDI
channel don't leak a dropped track's Program Change onto a kept track on
the same channel. `test_mix.py` gained `TestBuildFilterComplex` (labels
scale correctly to any input count) and `mix_wav()` argument-shape coverage
for 3+ inputs, alongside the existing 2-input tests updated to the new
`Sequence[tuple[Path, float]]` signature. A dedicated `TestWebAppGameSoundfont`
class in `test_web.py` (its own `create_app()` with an injected `mixer`, the
same pattern as `TestWebAppChipStem`) covers `ensure_render()`'s job-planning
logic end-to-end: converting with `gameSoundfont: true` sets
`hasGameSoundfont`; with no assignments, exactly one render call uses
`game_soundfont_path` and no split files or mixing occur at all (the
common-case regression guard against adding an unconditional ffmpeg
dependency); assigning one editable track produces exactly two render
calls (one per SoundFont) and one mix call with `SPLIT_GAIN` (1.0) on both
inputs, and the split `.game.mid`/`.gm.mid`/`.partN.wav` files are all
gone afterward while `applied_path` (needed by `GET /api/download`,
verified to still return the combined pre-split MIDI) survives; clearing
that assignment returns to a single game-soundfont render; a fixture with
no percussion/unassignable track at all — so assigning its one editable
track empties the game-side subset entirely — falls back to a single GM
render instead of a pointless one-input "mix"; `soundfont_override` is
confirmed to affect only the GM-side render, never the game-soundfont
side; and a converter that doesn't actually produce a usable `.sf2` (e.g.
`instrSets()` was empty) falls back to the ordinary single GM render with
no mixer call, exactly as if `gameSoundfont` had never been requested.

`test_midi.py`'s `TestApplyTransform` covers the MIDI-layer speed/pitch
feature: default `speed=1.0, transpose=0` produces byte-identical output to
calling `apply_assignments()` without those arguments at all; an existing
`set_tempo` is scaled by the ratio; a file with no tempo meta gets one
inserted with `time=0` (no tick shift); both the upper and lower
`MAX_TEMPO_MICROSECONDS`/`MIN_TEMPO_MICROSECONDS` clamps are exercised with
dedicated fixtures chosen so the unclamped math would actually overflow/
underflow; transposition shifts melodic notes but skips `PERCUSSION_CHANNEL`
entirely; a note pushed out of 0-127 by transposition is dropped as a
matched `note_on`/`note_off` pair (verified against a fixture with one
in-range and one out-of-range note sharing a channel) with every track's
total tick length unchanged; the transform combines correctly with a
simultaneous Program Change and volume change in one `apply_assignments()`
call; and calling `apply_assignments()` twice with the same non-default
speed/transpose does not compound (always re-reading `original_path`, the
same invariant `TestApplyAssignments.test_multiple_apply_cycles_are_deterministic`
already relies on for Program Change). `TestValidateSpeedRatio`/
`TestValidateTransposeSemitones` cover the range/type validation
(`validate_transpose_semitones()` explicitly rejects `bool` and non-integer
floats, since a half-semitone would need pitch bend this feature doesn't
implement). In `test_web.py`, `TestWebApp` covers `PATCH /api/session/transform`
end-to-end (partial updates preserve the untouched field, invalid values
return 400, no-body requests return 400, an upload with no MIDI returns
400, `POST /api/render` on a transformed session produces MIDI with the
scaled tempo/shifted note, a fresh MIDI upload resets both fields to their
defaults) and confirms `run_pitch_shift` (the ZIP feature's own injected
fake, reused here) is **never** called for a session with no chip/DAC stem
at all, regardless of the transform setting — the stem-sync path only
exists to keep a stem in sync with a transform, so a stem-less session has
nothing for it to do. `TestWebAppChipStem` gained
`test_transform_syncs_stem_before_mixing` (a non-default transform makes
`ensure_render()` call the injected `pitch_shifter` with `[speed]`/
`[transpose]` exactly once and feed `mix_wav()` the *synced* WAV rather
than the raw `chip_stem_path`) and
`test_default_transform_never_invokes_pitch_shifter_even_with_stem` (the
regression guard: even with a real stem present, leaving speed/transpose
at their defaults must never invoke `pitch_shifter` at all, so the
ordinary `chipNoise` path gains no new dependency from this feature).

Beyond the mocked unit tests, this feature was verified through a live,
fully non-mocked `create_app()` with the real `fluidsynth`/`ffmpeg`/
`pitch_shift.sh` all wired in — see the dedicated verification paragraph
above ("The MIDI-layer speed/pitch feature ... was verified end-to-end").

`TestWebApp` also covers the download-filename override
(`PATCH /api/session/filename`): unsafe characters are sanitized the same
way an upload's filename is, a blank/whitespace-only submission clears the
override back to `original_name`, requests with no `name` key or a
non-string `name` return 400, the same as an upload-less session, a fresh
MIDI upload resets `downloadStem` to `""`, and `GET /api/download`/
`GET /api/download/wav`/`GET /api/download/variations` all reflect the
override in their `Content-Disposition` filename (the variations case also
checks every member inside the returned ZIP carries the overridden stem).
`test_changing_filename_after_generation_invalidates_variations_zip` and
`test_setting_same_filename_does_not_invalidate_variations_zip` are the pair
of regression guards for the invalidation rule described above: editing the
field to an actually different value after generating a ZIP forces
`GET /api/download/variations` back to 400 (matching the existing
track-change invalidation test), while re-submitting the exact same
(sanitized) value leaves an already-generated ZIP downloadable. This was
additionally checked by hand against a live, non-mocked `miditrack`
process: setting the field to `"my custom name"` via the browser and
inspecting the resulting `PATCH` request, `GET /api/session`'s
`downloadStem`, and the `Content-Disposition` headers on both single-file
downloads and the variations ZIP (plus its member names) all agreed.

All 387 tests pass as of this writing (`TestWebAppLibvgmTrackSource`/
`TestWebAppNsfChipTrackSource` additionally cover the default/custom volume
split in `_render_chip_hardware()`: all-default-volume selections still
render once, a single changed channel triggers exactly one extra
individual render with the correct `mix.STEM_GAIN * volume_percent / 100`
gain alongside the unchanged default group's `mix.STEM_GAIN`, changing
every selected channel's volume drops the default group entirely (pure
per-channel rendering, no group-of-one call), and a batch
`POST /api/variations` run reuses the same individually-rendered stems
across every combination rather than re-rendering per combination.
`test_render.py` additionally covers
`list_soundfonts()`'s directory-order/file-sort behavior and
`is_soundfont_file()`'s validation; `test_web.py` covers
`GET /api/soundfonts`, `POST /api/soundfont`'s accept/reject paths, that
`POST /api/render` prefers the runtime selection over the CLI default,
and that the selection survives a fresh MIDI upload). Beyond the mocked
unit tests, this feature was verified with real, non-mocked round trips
through the actual `vgm2midi` binary and the actual `fluidsynth`: a
minimal hand-built `.vgm` (one YM2151 note, built the same way
`vgm2midi/tests/vgm2midi.test.js`'s own `createVgmBuffer()` helper does)
was POSTed to a live `create_app()` instance with no fakes injected —
`POST /api/source` correctly detected the VGM format, `POST /api/source/convert`
invoked the real `node vgm2midi/dist/cli.js` and produced a track correctly
pre-selected to GM program 80 (matching the "vgm2midi always sends GM 81"
claim above), reassigning it to program 40 and `POST /api/render` produced
a real WAV via real `fluidsynth`, and `GET /api/download`/`GET /api/download/wav`
returned files confirmed with `mido` (Program Change correctly rewritten to
40, note timing unchanged) and `afinfo` (a valid playable WAV) respectively.
The ZIP/multi-file-select path was separately verified end-to-end the same
way: a real `.zip` containing two `.vgm` files was uploaded, the second
member was activated via `POST /api/source/select-file`, and
`POST /api/source/convert` invoked the real `vgm2midi` against that
second member specifically (confirmed via the returned `filename`) before
rendering through real `fluidsynth` — proving the file-selector round trip
actually reaches the file the user picked, not just whichever was
auto-selected at upload time. (Real multi-track NSF/SPC fixtures paired
with an authentic `.m3u`, which would exercise the title-matching path
against a real `nsf2midi -l`/`spc2midi -l` listing rather than an injected
fake, were not available in this environment; that path is covered by
`test_convert.py`'s parser tests against the literal upstream grammar plus
`test_web.py`'s Flask-level integration tests instead.)
Manual verification was additionally
run against real `nsf2midi`-shaped fixtures (via `test_midi.py`'s
`build_fixture()`, modeling the `gm.mdf` Program Change pattern) and real
output files from this session's own `spc2midi` (`smw.rsn`'s Title theme)
and `vgm2midi` (`vgmx-example.vgz`) runs — including a full round trip
through the real (non-mocked) `render.render_wav()` → real `fluidsynth`
render → HTTP Range seek → download → independent `mido` verification of
the rewritten Program Change values and unchanged note timing. The
SoundFont picker was additionally verified end-to-end against this
machine's real search directories (which held multiple real `.sf2` files
during implementation): `GET /api/soundfonts` correctly discovered all of
them, selecting a non-default one and rendering confirmed the real
`fluidsynth` invocation actually received `-s <that path>`.

**Historical**: the original "速度・ピッチのバリエーション" feature (WAV
post-processed through `pitch_shift.sh`, `POST /api/pitch-shift` /
`GET /api/download/pitch-shift`) was verified end-to-end via
`pitch_shift.run_pitch_shift()` called directly against a real WAV and a
full browser round trip that downloaded a real ZIP of 10 `rubberband`-shifted
`.wav` files. That endpoint pair no longer exists — see "Speed/pitch is a
MIDI-layer edit" above for why it was replaced by `POST /api/variations`.
The batch-variations replacement was verified end-to-end through a live,
non-mocked `create_app()` (real `fluidsynth`; no `pitch_shift.sh` call at
all, since this fixture carries no chip stem): a small real `.mid` fixture
was uploaded, `POST /api/variations` with the default lists produced a real
`variations.zip` containing 20 files (10 `.wav` + 10 `.mid`, confirmed via
`unzip -l`, back when the shipped default was still 2 speeds × 5
transposes = 10), one extracted `.mid` was independently opened with
`mido` and confirmed to carry the expected scaled tempo and shifted note
for its filename's speed/transpose, and `GET /api/session` confirmed the
session's own `speed`/`transpose` were unchanged by the batch run.

The `DEFAULT_VARIATION_SPEEDS` change (to `[1.2, 1.0, 0.8]`) and
`includeMidi` were separately re-verified end-to-end against a live,
non-mocked `miditrack` process: `POST /api/variations` with an empty body
returned exactly 15 items (confirming the new 3×5 default); a follow-up
call with `{"speeds": [1.2, 1.0], "transposes": [0], "includeMidi":
false}` returned `items[].mid === null` for both entries, and the
downloaded ZIP (`unzip -l`) contained exactly 2 files, both `.wav`, no
`.mid` — confirming `includeMidi: false` actually changes what lands in
the ZIP, not just the JSON response.

The `gameSoundfont` hybrid-rendering feature was verified end-to-end
against a real, unmodified game rip beyond the mocked unit tests, using a
real `.spc` file (Chrono Trigger's "Battle 1") run through the actual
`spc2midi` binary and the actual `fluidsynth`, no fakes injected. First, the
core assumption the whole feature depends on was checked directly: parsing
`spc2midi -s 0 --sf2`'s own `.mid`/`.sf2` output with `mido` and a small
`phdr`-chunk reader confirmed no notes ever land on channel 10, that CC0
(Bank Select MSB) is the only bank-select controller present (CC32 never
appears, consistent with VGMTrans's GS bank-select style), and that every
`(bank, program)` pair actually used in the `.mid` has a matching preset in
the `.sf2` — including a `bank=127` preset used by several tracks, which
matched exactly. Second, converting through a live `create_app()` with
`gameSoundfont: true` and no per-track overrides produced a real WAV via
real `fluidsynth` (confirmed `afinfo`-valid, 26.5% peak, unclipped) that,
compared by ear against the same song converted with `gameSoundfont: false`,
audibly used the game's own instrument timbres instead of GM's. Third, the
actual split-and-mix path was driven for real: one track was reassigned to
a GM organ patch via `PATCH /api/session/tracks`, `POST /api/render`
produced two real `fluidsynth` renders (one against the generated `.sf2`,
one against a real GM SoundFont) mixed through real `ffmpeg`, no leftover
`.game.mid`/`.gm.mid`/`.partN.wav` files remained afterward, `applied_path`
was still intact for `/api/download`, and the mixed `GET /api/download/wav`
output was confirmed `afinfo`-valid and unclipped (17.5% peak) with the
reassigned track audibly playing the GM organ patch while every other
track kept the original game timbres.

The MIDI-layer speed/pitch feature (`speed`/`transpose` on
`WebSession`, `PATCH /api/session/transform`) was verified end-to-end
through a live, fully non-mocked `create_app()` — the real
`render.render_wav()` (real `fluidsynth`), the real `mix.mix_wav()` (real
`ffmpeg`), and the real `pitch_shift.run_pitch_shift()` (real
`pitch_shift.sh`/`rubberband`) were all injected, with no fakes anywhere in
the stack. A 2-second, 120 BPM one-note fixture was uploaded with a real
WAV attached as `chip_stem_path` (standing in for what a real
`chipNoise` NSF/VGM conversion would have produced), then
`PATCH /api/session/transform` set `speed=1.2, transpose=-2` over HTTP.
`POST /api/render` returned 200; `GET /api/download` returned a `.mid`
confirmed via `mido` to carry `tempo=416667` (500000/1.2) and note 58
(60-2); `GET /api/download/wav` returned a real mixed WAV whose `afinfo`
duration (4.64s) matched a separately-rendered transform-only WAV
(fluidsynth's fixed reverb tail explains why this isn't exactly 2.0/1.2
seconds — the note-only portion scales correctly, confirmed by comparing
against the untransformed baseline's 4.95s render). Independently, calling
`pitch_shift.run_pitch_shift()` directly against that same baseline WAV
with `[1.2]`/`[-2.0]` produced exactly one output file (confirming the
"combination count is always 1, so `outputs[0]` needs no filename
prediction" assumption `_synced_stem()` relies on) whose duration (4.13s)
was 1.2× shorter than the input (4.95s), matching the MIDI side's own
1.2× speed direction. The `gameSoundfont` split path was not independently
re-verified with a real `.spc` under this change, since `_plan_render_jobs()`
splits `applied_path` — which `ensure_applied()` already produces with the
transform baked in — so no new interaction exists beyond what
`TestWebAppGameSoundfont`'s existing mocked tests already cover.
