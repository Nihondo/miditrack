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

## Documentation ownership

The repository-root `README.md` is the English end-user manual and
`README_ja.md` is its Japanese counterpart; keep their user-visible
behaviour, examples, and section structure aligned. This package's
`README.md`/`README_ja.md` are contributor guides for setup, architecture,
runtime contracts, and verification. Keep detailed implementation history
and invariants in this file, and keep converter-specific option references
in each converter's own documentation.

End users run the repository-root `install.sh` from an Apple Silicon checkout.
It installs the Homebrew runtime tools, creates `miditrack/.venv`, installs
the package and VGM Node.js runtime dependencies, and relies on FluidSynth's
standard SoundFont. Keep the script self-contained, idempotent, and free of a
system-Python fallback; it must not download, link, or bundle a SoundFont.
It creates `/opt/homebrew/bin/miditrack` for the package launcher, but must
fail without overwriting an existing non-matching command or link.
Install Homebrew formulae individually so a conflicting same-named formula
from another tap does not prevent later setup steps; verify every required
runtime command on `PATH` before continuing to the Python and Node.js setup.
Use cyan `▶` and `✓` status lines for installer progress only when stdout is a TTY; keep
redirected output free of ANSI escape sequences.

It also generates `~/Applications/miditrack.app`, a WKWebView shell whose
executable is compiled ahead of time (`xcrun swiftc -O`) from the tracked
`miditrack/miditrack_app.swift` (see "Added: `miditrack.app`..." below for
the full design, including why it must be a compiled binary rather than a
symlink to the source). It must not overwrite a bundle it did not create
itself, and stays idempotent by overwriting the three generated items
(`Info.plist`, the compiled `Contents/MacOS/miditrack` binary, the `.icns`)
in place on every re-run rather than removing and recreating the bundle
directory.

## Architecture

```
miditrack.sh              PATH-symlinkable launcher (copy of note_ext.sh's structure)
pyproject.toml             src-layout + console_script (mirrors note_ext/pyproject.toml)
src/miditrack/
  cli.py                   argparse entry point, launches the web server
  errors.py                MidiTrackError / WebValidationError / RenderError / ConvertError /
                            RubberBandError / MixError
  gm.py                    the 128-name GM table + 16 families (single source of truth)
  midi.py                  track analysis, apply/save program changes and velocity-based volume
  pianoroll.py             read-only note/tempo extraction for the browser piano roll
  render.py                midi2wav.sh resolution + safe subprocess invocation, with an explicit
                            per-render sample rate
  convert.py               nsf2midi/spc2midi/vgm2midi resolution, -l parsing, safe invocation,
                            ZIP extraction (zip-slip guarded), gme-format m3u playlist parsing
  rubberband.py            direct rubberband CLI invocation for keeping real-audio stems in
                            sync with a MIDI-layer transform (speed/pitch option validation
                            itself lives in midi.py)
  mix.py                   ffmpeg resolution + safe subprocess invocation, resamples and mixes
                            SoundFont parts and NSF/VGM hardware stems at the selected rate
  libvgm.py                validates VGM track/channel sidecars and invokes the bundled native
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

The browser keeps the full zoomed timeline as a lightweight scroll-width
wrapper but renders only the visible horizontal slice into one sticky canvas.
The canvas backing store follows the visible viewport's device-pixel
`ResizeObserver` size, so 4x/8x zoom does not multiply canvas allocation by the
zoom factor. Scroll events request at most one static repaint per animation
frame, and `drawPianorollTrack()` culls notes outside that visible slice.
In the full-screen DAW layout, `.pianoroll-card` keeps a 260px minimum height
so a full MIDI pitch range retains visible row separation. `drawPianorollTrack()`
also caps each note rectangle at 80% of one pitch row; this defensive cap keeps
adjacent pitches from overlapping if any future layout makes the canvas smaller.
Note bodies are rounded by default through `drawPianorollNote()` using Canvas
2D's `roundRect()` with a radius capped to the shorter edge; if the user turns
off `roundedPianorollNotes` (or a browser lacks `roundRect()`), it must use the
cheaper `fillRect()` path. `outlinedPianorollNotes` independently adds a
one-pixel outline using the same track hue at lower lightness, following either
the rounded or rectangular note shape. Both are persistent display-only
preferences in `preferences.json`: changing either redraws the static canvas
immediately but must not fetch the piano-roll payload, alter the project
archive, or trigger an audio/MIDI render.
`showPianorollKeyboard` is a third persistent display-only preference, enabled
by default. It places a separate fixed-width canvas beside the horizontal
scroll area, so `drawPianorollKeyboard()` can reuse the exact note-row layout
without moving during scrolling or playback. It draws white keys, shorter black
keys, and only C labels (`MIDI 60 = C4`); it is hidden when no notes are
available. Its backing store must follow its own device-pixel `ResizeObserver`,
and toggling it must relayout and redraw only the static canvases.
`GET /api/pianoroll` additionally returns an optional per-track `pitchPaths`
array for notes with MIDI pitchwheel events. Each path pairs elapsed seconds with
the bend offset in semitones, after applying that channel's RPN 0 bend range
(default ±2 semitones). Like a conventional DAW, note rectangles remain horizontal;
`drawPitchAutomation()` renders the discrete bend values as stepped automation in
a dedicated PITCH lane below the piano roll.
Playback never repaints or copies the canvas: `#pianoroll-playhead` is a 2px DOM
overlay whose compositor-friendly `translate3d()` is the only visual property
updated by the playback rAF loop. Pointer coordinates remain in CSS pixels;
seeking adds the native scroller's `scrollLeft` before dividing by the full
timeline width. Seeking is also keyboard-accessible through the focusable
slider-style canvas. Muting only triggers a local static redraw at lower
opacity; it must not fetch `/api/pianoroll` again. Solo audition goes through
the exact same dimming, for the same reason: `enterSolo()`/`exitSolo()` write real
`volumePercent: 0` values into every non-soloed track via the same
`PATCH /api/session/tracks` mute already uses (see "Why per-track volume
scales Note On velocity instead of sending CC7" below), so
`redrawPianorollStatic()`'s `mutedIndices` check already treats them as
muted correctly — both `enterSolo()` and `exitSolo()` just need to call
`redrawPianorollStatic()` themselves (in a `finally`, so a failed PATCH
still leaves the roll matching whatever `state.session` actually holds)
instead of relying on the playback progress update, which only moves the DOM
playhead and deliberately leaves the visible static slice untouched. There is
deliberately no solo-specific highlight (a third opacity
value, an outline, draw-order reordering): a non-soloed track dims to the
identical 0.18 a manually muted track already uses, since solo's other
tracks are, mechanically, just muted tracks — and a track muted before
solo starts stays dimmed after solo ends, because `exitSolo()` restores
the pre-solo snapshot rather than a flat "all unmuted" state.

Horizontal pointer movement of at least `LOOP_DRAG_THRESHOLD_PX` selects a
piano-roll loop instead of performing a click seek. The browser owns this
transport-only state (`loopStartSeconds`, `loopEndSeconds`, and
`isLoopEnabled`): the DOM overlay and numeric controls mirror it, and the
playback rAF seeks back to the start once the player reaches the end. The
range is persisted under the project archive's validated `ui.loop` object; it
does not change the MIDI or render a shorter audio file.

Pressing a track-name button sets only `highlightedTrackIndex` and locally
redraws the current canvas slice. Other notes use the same dim opacity as
muted/soloed notes, but no session PATCH or audio rerender occurs. Pointer
capture plus pointerup/cancel/lostcapture and Enter/Space keyup guarantee that
the highlight is temporary.

Ensemble presets are persisted role-to-GM-program maps in
`preferences.json`, with three editable defaults. The native `<dialog>` editor
uses the normal GM catalogue for melodic roles and a concise General MIDI drum
kit list for percussion. Activating one captures the current per-track
source/program state, suggests roles from percussion identity, pitch range, and
note density, then shows role selects in place of program selects. Preset
changes reuse those roles; clearing restores the captured assignments. Project
`ui.ensemblePreset`, its validated definition, `ui.trackRoles`, and the
pre-preset restoration snapshot are validated before archiving. Including the
definition keeps a project editable when the local preferences no longer have
that custom preset, while persisting the snapshot lets Clear preset restore the
true pre-preset choices after reopening a project.

**Added: mouse-wheel seeking while hovering the piano roll.** `#pianoroll-canvas`
gained a `wheel` listener (`handlePianorollWheel()`, registered
`{ passive: false }` so it can call `preventDefault()`) alongside the
existing `pointerdown`/`pointermove` click-and-drag seek handlers. It only
acts when `|deltaY| >= |deltaX|` — a vertically-dominant wheel gesture,
which is otherwise inert here since `#pianoroll-scroll` is
`overflow-y: hidden` (nothing to scroll vertically) — and calls the existing
`seekPlaybackBy()` (already shared with the back/forward buttons and
Arrow-key shortcuts) with `-(event.deltaY / 100) * PLAYBACK_SEEK_SECONDS`.
A horizontally-dominant gesture (Shift+wheel, or a trackpad's native
horizontal swipe) is left completely alone — the handler returns before
touching `preventDefault()` or reading `deltaY` at all — so panning the
zoomed-in timeline via `#pianoroll-scroll`'s native horizontal scroll
keeps working exactly as before. The sign matches this app's existing
Page Up (`+10`, forward) / Page Down (`-10`, backward) convention in
`handleSeekKeydown()` — `deltaY` is negative for an "upward" wheel/trackpad
gesture by the DOM spec, the same direction Page Up already means "forward"
for — rather than assuming scroll-down-is-forward, which some other apps
use but this codebase doesn't. Scaling by `/100` (rather than a fixed step
per event) makes a typical mouse wheel's one-notch `deltaY` (~100 in most
browsers/OSes) roughly equal to one `PLAYBACK_SEEK_SECONDS` (1s) tap, while
a trackpad's many small continuous pixel-mode `deltaY` events during one
swipe accumulate into a smooth scrub rather than a series of jumpy 1-second
hops. No new auto-follow-disable call was needed: the event still bubbles
from the canvas up to `#pianoroll-scroll` (`preventDefault()` stops the
default scroll action, not propagation), where the pre-existing `wheel`
listener already calls `setPianorollAutoFollow(false)` — confirmed live,
not just by reading the code, since a bubbling assumption is exactly the
kind of thing that's easy to get backwards. Verified against a live,
non-mocked `create_app()` server via dispatched `WheelEvent`s (Chrome
DevTools MCP has no built-in wheel/scroll gesture, so a synthetic
`new WheelEvent(...)` was dispatched directly at the canvas — behaviorally
identical to a real trackpad/mouse event for a listener that only reads
`deltaX`/`deltaY`): `deltaY: -300` moved a paused player from `0s` to `3s`
(and `-500` from `0s` to `10s`, matching duration-clamped math),
`deltaY: +100` from `0s` stayed clamped at `0s` (`seekPlaybackBy()`'s
existing clamp), a `deltaX: 200 / deltaY: 10` event left `currentTime`
unchanged with `defaultPrevented: false`, and `state.isPianorollAutoFollowing`
flipped to `false` after a vertical-wheel dispatch. Confirmed working
identically in both the normal wizard layout and the fullscreen DAW layout
above, since both reuse the same `#pianoroll-canvas`/`setupPianoroll()`.

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
the locally bundled DSEG7 Classic WOFF2 (with its OFL license), displays
milliseconds as `mm:ss.mmm`, and runs its animation-frame refresh only while
media is playing.
Keep a tabular monospace fallback and fixed timer width so font swapping cannot
shift adjacent controls. MIDI/WAV download buttons remain below the piano roll.

The SoundFont setting lives directly below the track list, not in the audition
section. It contains, in order, the `.program-select`, the fast/quality
segmented choice, and a non-interactive render spinner. The segment shows only
the two visible labels `高速`/`品質`; profile-rate explanations belong in the
manual, not this compact toolbar. In full-screen mode, `#tracks-card` is a
column flex container: only `.table-scroll` grows and scrolls, while the
SoundFont field is the final, fixed control at the bottom of the left column.
The spinner is decorative, stays hidden outside rendering, and becomes static
when reduced motion is requested.

The fast/quality segmented choice remains a native radio group with explicit
`label[for]` associations. Its inputs use the dedicated `.render-mode-input`
canonical 1px/`clip-path` hiding rule, not the shared `.visually-hidden` helper:
that helper intentionally becomes visible while focused/active, which puts a
radio back into the two-column grid during a click and breaks both layout and
hit-testing. Keyboard focus is rendered on the adjacent visible label instead.

Tracks with both `soundfont` and `game` sources use a native radio group with
the visible labels `SF`/`原曲`, not a `<select>`. The control directly reuses the
fast/quality segment's `.render-mode-field`, `.render-mode-options`, and
`.render-mode-input` classes so borders, selected state, and keyboard focus stay
identical. Keep a per-track `<legend>` as its accessible name, and keep each
radio group's `name`/`id` values unique to the track index. `state.trackRows`
stores the group's `sourceInputs`; Cmd/Ctrl-click applies the clicked value to
every compatible group while normal change handling still invalidates the
audition and updates instrument availability.

Pointer-operated selection controls (`select`, radio, checkbox, range, and file
inputs) release focus after their completed pointer interaction so global Space
playback is immediately available again. This behavior must remain
pointer-specific: controls reached or operated from the keyboard keep native
focus and key behavior, while text and number inputs are excluded so editing is
not interrupted. Ordinary buttons use the same policy by blurring only clicks
whose `event.detail` identifies a pointer-produced activation.

Invalidating an audition after an instrument, volume, source, SoundFont,
speed/transpose, solo, or render-profile change stores the old playback
position as a normalized song-progress ratio. Loading the next render restores
that ratio after media metadata becomes available, which preserves the musical
position even when speed changes the WAV duration. New MIDI/source uploads,
source conversion, and full session reset deliberately clear the saved ratio.
If the requested render URL is already active, the player source must not be
reloaded and its exact current position remains unchanged.

Track colors have one browser-side source of truth: `getTrackColor(track.index,
trackCount, opacity)`. Both the note rectangles and the color marker preceding
each track name must use it, so sorting rows cannot break the visual mapping.
Piano-roll time-axis zoom changes `#pianoroll-timeline`'s CSS inline size through
fixed zoom steps and relies on the surrounding native horizontal scroll
container. `#pianoroll-viewport` remains sticky at the scroller's visible width,
and the canvas backing store therefore remains constant across zoom levels.
Seek coordinates are `(scrollLeft + clientX - canvas.left) / timelineWidth`;
using only the visible canvas width would seek to the wrong time after panning.
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
`.mid`, renders it to a `.wav` via [midi2wav.sh](midi2wav.sh), and serves
that WAV to an `<audio>` element with
`send_file(..., conditional=True)` — which gives real HTTP Range/seek
support for free, the same technique `tools/make_videos_web.py` already
uses for video/audio scrubbing. This is deliberately "boring": it reuses
existing, tested infrastructure instead of adding a new audio-synthesis
dependency. The A/B crossfade layer described below (see "Why an A/B
`<audio>` pair, not a live softsynth, closes the remaining gap") hides most
of the latency this design implies. Initial MIDI preparation begins an
automatic render; Space waits for that latest render and then starts playback.

Auditioning has two explicit profiles. `fast` is the default and produces a
full-song, 16-bit stereo 22.05kHz WAV while preserving the existing reverb and
chorus path. `quality` produces the same 44.1kHz render used by
`GET /api/download/wav`; a matching quality audition is therefore reused for
download, while a fast preview is never passed off as the final file.
`render.render_wav()` and `mix.mix_wav()` both receive the profile sample rate
explicitly, so split parts and the final ffmpeg mix cannot silently disagree.

Every player-source change receives a process-lifetime-monotonic `render_id`,
which is exposed through `/api/audio?v=N`. A cache hit for the source already
active in the player keeps the existing id; activating a different cached
source increments it so the browser cannot reuse byte ranges from another WAV.
MIDI re-conversion, plain MIDI replacement, source-file switching, and
`WebSession.clear()` must not reset the counter. A process restart may safely
begin at zero because the launch authentication token in the media URL changes
at the same time.

## Historical A/B `<audio>` pair rationale

The details below record the original crossfade rollout. The current automatic
audition behavior is defined in the next section and supersedes its former
Apply & Audition and paused-prewarm descriptions.

## Current automatic audition behavior

`index.html` has no Apply & Audition button. MIDI preparation calls
`scheduleAutoRender(0)` after the track list and piano roll are ready; edits
use the same function with the existing 500ms debounce. Both paths activate
`POST /api/render`, so a paused player silently loads the newest WAV and a
playing player reaches it through the existing A/B crossfade. The legacy
`POST /api/render/prewarm` endpoint remains for API compatibility but has no
standard-UI caller.

`state.renderGeneration` identifies the newest requested state.
`requestRenderGeneration()` shares an in-flight render for that generation,
and `renderGeneration()` rejects any response that is no longer current
before it updates session state, the player, or the piano roll.
`crossfadeToRender()` passes the same check into `runSwap()`, so a candidate
that turns stale while its metadata loads is unloaded instead of becoming the
active source. `ensureLatestRender()` clears only a pending debounce timer
and waits for the current generation; playback therefore never resumes an
older source after an edit. It also flushes pending track and transform PATCH
operations first.

The only normal UI feedback is the decorative `#render-spinner`, which is
visible while a current render runs and stops animating under
`prefers-reduced-motion`. Start, success, and setting-change toasts are
intentionally suppressed; render and playback failures continue to use the
existing error toast.

## Why an A/B `<audio>` pair, not a live softsynth, closes the remaining gap

The section above explains why `miditrack` renders full WAVs instead of
driving a live softsynth. That leaves one real UX cost: every track edit
used to call `resetPlayer()`, which stripped the `<audio>` element's `src`
and stopped playback outright, so a user tweaking a volume slider while a
song played heard it cut to silence, then had to click "Apply & Audition"
again and wait for the render before hearing anything. `index.html` now
carries two `<audio>` elements, `#player-a`/`#player-b`; `app.js`'s
`state.activePlayerId` names whichever one is the current playback source,
and `activePlayer()`/`inactivePlayer()` are the only places the rest of the
code needs to know that. Editing a track, the SoundFont, speed/pitch, or the
fast/quality toggle now calls `markRenderStale()` instead of `resetPlayer()`
— it flags the "適用して試聴" button (`.is-stale`, `app.css`) and leaves
`state.session.hasRender` alone, but never touches either `<audio>` element,
so whatever was already playing keeps playing through the edit.

`scheduleAutoRender()` (the renamed, extended `schedulePrewarm()`) still
debounces 500ms after the last edit, but now branches on whether
`activePlayer()` is actually playing: paused, it behaves exactly as before —
`POST /api/render/prewarm` populates the cache without touching the player;
playing, it calls the activating `POST /api/render` and hands the result to
`crossfadeToRender(renderId)`, which is also what the explicit "Apply &
Audition" click and the solo-audition button call via `renderAndLoadPlayer()`.
`crossfadeToRender()` loads the new WAV into `inactivePlayer()`, seeks it to
the **same song-progress ratio** `active.currentTime` was at (not the same
absolute second — this is what keeps position musically correct across a
speed change, the same ratio-based reasoning "Speed/pitch is a MIDI-layer
edit" below relies on for `POST /api/variations`), starts it muted, and only
then ramps `from`/`to` volume through an equal-power (cos/sin) curve over
`CROSSFADE_MS` (120ms) before pausing and emptying the old element and
flipping `state.activePlayerId`. If nothing was playing, the same function
takes a "no fade" branch: seek, swap, done — this is also what makes a
speed/pitch change preserve position even while paused, without a separate
code path. Calls are serialized through a `swapQueue` promise chain so an
auto-render's crossfade and a manual click landing close together can't
write into the same `inactivePlayer()` at once; `resetPlayer()` (still used
for MIDI/source replacement and the full reset button, where playback
genuinely must stop) bumps `state.swapGeneration` and discards the queue
outright.

This only works if `GET /api/audio?v=N` keeps answering **the WAV that
render_id actually pointed to**, even after a newer render has activated and
moved `WebSession.audio_path` on. Before this feature `get_audio()` ignored
`?v=` entirely and always served `audio_path` — harmless when only one
`<audio>` element ever existed, but wrong the moment a still-playing old
element keeps issuing Range requests against its own `?v=<old id>` while a
new id is already active. `WebSession.audio_sources` (`web.py`) is a small
`OrderedDict[render_id, Path]`, capped at `AUDIO_SOURCE_HISTORY_LIMIT = 4`,
populated in `ensure_render()`'s `activate_player` branch at the same point
`render_id` itself is finalized. `get_audio()` resolves `?v=` against this
dict first and only falls back to `audio_path` when the id is absent or
already evicted — the same fallback an unknown/omitted `v` always got.
`_cache_store()`'s LRU eviction protects every path still listed in
`audio_sources`, not just the current `audio_path`, so a render that is only
still relevant because an old `<audio>` element is fading out can't be
evicted out from under it. The dict deliberately has a different lifecycle
than `audio_path`: `invalidate_render()` leaves it alone (an old render_id
must keep resolving while its element fades), while `reset_midi_state()`
(and therefore `clear()`) empties it, since a fresh MIDI makes every prior
render meaningless. Verified against a live, non-mocked `create_app()`
server (`.venv/bin/miditrack`, real `fluidsynth`, real browser via Chrome
DevTools): changing a track's render mode mid-playback produced a real,
audible-in-the-timeline crossfade — `player-b` (fast-mode, `?v=1`) and
`player-a` (quality-mode, `?v=2`) overlapped for ~160ms with position
continuous across the swap (`b`'s `currentTime≈1.15s` to `a`'s
`currentTime≈1.13s`, matching the ratio-based reseek), and the network log
showed `?v=1` and `?v=2` each still resolving to their own WAV's bytes after
the swap. A paused-state edit was confirmed to only ever call
`POST /api/render/prewarm`, never move `activePlayer()`'s `src`.

**Two follow-up fixes to the piano-roll playhead specifically, both reported
by hand-testing after the above landed:**

First, `runSwap()` originally sampled `active.currentTime` exactly once, at
the very start, to compute the song-progress ratio it seeks `next` to. That
ratio is correct at the moment it's read, but `active` keeps playing in real
time through `waitForLoadOutcome(next)` (network + decode) and `next.play()`'s
own buffering start-up — both real, if usually small, delays — so by the time
the fade actually begins, `next`'s seeked position had already fallen tens of
milliseconds behind `active`'s current one. That gap became momentarily
visible right at the swap instant (the piano-roll playhead briefly snapping
back before continuing), then self-corrected within a frame since
`activePlayer()` is re-read fresh every frame. `runSwap()` now re-samples
`active.currentTime` a second time — via the local `currentRatio()`/
`seekNextTo()` helpers — immediately after `next.play()` resolves, while
`next.volume` is still `0` (so the reseek is silent), erasing the load/
buffering-latency portion of the drift before the audible/visible fade ever
starts. `runSwap()`'s tail also now calls `updatePianorollPlayhead()` directly
right after the element swap, rather than waiting for the playback-time rAF
loop's next frame to notice — cheap, and removes the last frame of lag.

Second, and the more visible of the two: a speed change (unlike a pure
transpose) changes `durationSeconds` itself — `pianoroll.py`'s duration comes
from the tempo map, which `_scaled_tempo()` divides by `speed`; transpose
never touches it. `flushTransform()` used to call `loadPianoroll()`
immediately on every transform edit, replacing `state.pianoroll` (and
therefore the divisor `updatePianorollPlayhead()` uses to turn elapsed seconds
into full-timeline progress) the moment the `PATCH /api/session/transform` response came
back — independent of whether the audition audio itself had caught up yet.
While playing, that response arrives well before the debounced auto-render's
crossfade does, so for the whole gap in between, the bar's denominator
already reflected the *new* speed while its numerator
(`getDisplayPlaybackSeconds()`) was still the *old*-speed audio's real
elapsed time — a mismatch with no relationship to the small per-swap drift
fixed above, lasting the full ~500ms-debounce-plus-render window rather than
one frame. `flushTransform()` now calls the new `schedulePianorollReload()`
instead of `loadPianoroll()` whenever `isActivePlayerPlaying()` is true: it
bumps `state.pianorollLoadId` (the same generation counter `loadPianoroll()`
itself uses, so a newer edit or an unrelated pianoroll load correctly
supersedes an in-flight one) and kicks off the `GET /api/pianoroll` fetch
immediately, but stores the *promise* in `state.pendingPianorollFetch`
rather than applying it. `applyPendingPianorollReload()` — called after
`crossfadeToRender()` resolves in both `scheduleAutoRender()`'s playing
branch and `renderAndLoadPlayer()`, and also in `scheduleAutoRender()`'s
not-playing branch in case the user paused during the debounce — awaits
that stored promise and applies it (via the extracted `applyPianorollPayload()`,
shared with `loadPianoroll()`) only once the audition audio has actually
caught up to the new setting. Because the fetch was started back when the
edit landed rather than when the crossfade finishes, it has almost always
already resolved by the time it's applied, so the apply step adds no
further network wait and the mismatch window collapses to effectively
nothing. `flushTransform()` calls `schedulePianorollReload()`
unconditionally (the fetch itself is cheap and its freshest `durationSeconds`
is wanted either way) and only branches on `isActivePlayerPlaying()` for
*when* to apply it — immediately, via `applyPendingPianorollReload()`, when
not playing (there is no audio to desync from, matching the piano roll's
documented independence from rendering; see "Why the piano roll is
independent from rendering and track sorting" above), or deferred to the
crossfade otherwise.

**A third, unrelated optimization on the same path, prompted by a direct
question ("do the notes actually change when only speed changes?")**: a pure
speed change scales `pianoroll.py`'s tempo map, which scales *every* note's
start time, duration, and the overall `durationSeconds` by the exact same
factor (`_scaled_tempo()` divides every tempo event by `speed`, so any two
absolute times keep the same ratio regardless of how many tempo-change events
the file has — see "Why tempo is scaled, not replaced" below). Since
`drawPianorollTrack()` only ever positions a note at `start / durationSeconds
* width`, that ratio is mathematically invariant under a speed-only change:
redrawing the static note layer after one produces pixel-identical output to
what's already on screen. `flushTransform()` now compares the just-submitted
`transpose` against `state.session.transpose` (the value in effect before
this PATCH) and passes the result as `schedulePianorollReload({
needsNoteRedraw })`. When `false`, `applyPendingPianorollReload()` still
updates `state.pianoroll` (so `durationSeconds` stays authoritative for the
bar and for `seekPianorollAt()`) and moves only the playhead via
`updatePianorollPlayhead()`, but skips `redrawPianorollStatic()`'s per-note canvas
loop and the now-pointless `setPianorollMessage()` truncation-status update
entirely. `state.pendingPianorollNeedsRedraw` is OR-accumulated (never
overwritten to `false`) across multiple pending reloads so a transpose edit
followed by a speed-only edit, both still unapplied when the crossfade
lands, doesn't drop the redraw the transpose edit actually earned. Note that
this is a presentation-layer optimization only — `durationSeconds` itself is
still always re-fetched from the server (`pianoroll.py`'s
`_scaled_tempo()`/rounding) rather than approximated client-side by scaling
the old value, since a client-side approximation could drift from the
authoritative value for a file with many tempo-change events, and
`seekPianorollAt()` needs that value to be exact, not merely close.

## Why preview rendering uses a state cache and two external workers

The full-render key is a SHA-256 digest of the MIDI generation, assignments,
effective volumes, per-track sources, speed, transpose, source format/song and
sample count, SoundFont/game-SoundFont/chip-stem path-size-mtime signatures,
and the render profile/sample rate. `invalidate_render()` clears only the
currently applied/player pointers; it deliberately retains completed entries,
so repeating the same settings or returning to an earlier state is a cache hit.
Changing only the download filename leaves both the applied MIDI and render
cache intact. Uploading/reconverting MIDI clears the entire cache and advances
the MIDI generation.

The LRU lives under the session temporary directory and is bounded to 16
entries and 256MiB total; `WebSession.clear()` removes it with the rest of the
session. The same LRU also stores raw VGM/NSF hardware stems. Hardware channels
left at their source volume are cached as the current selected set, preserving
the emulator's non-linear combined mix. A channel whose volume was edited is
cached individually before gain, so later gain-only edits remount the same raw
WAV and run only the final mix. SoundFont choice and volume are intentionally
absent from these raw-stem keys.

Independent external jobs share one `ThreadPoolExecutor(max_workers=2)` per
render. A game-derived SoundFont part and a GM SoundFont part overlap, and a
VGM/NSF hardware-cache miss overlaps its independent FluidSynth job. FluidSynth
internal `synth.cpu-cores` parallelism stays disabled: local measurements on
the representative song were slower than keeping FluidSynth single-core and
parallelizing independent outer jobs. MIDI application and track splitting
remain serial, and ffmpeg runs once after every input is complete.

The browser schedules `POST /api/render/prewarm` after 500ms without another
relevant edit and sends the fetch with `priority: "low"` (unsupported browsers
simply treat it as a normal fetch). Prewarming populates the selected profile's
cache but never changes `audio_path` or autoplays. An explicit render for the
same key joins via `render_lock` and then receives the cached result instead of
starting a duplicate external render. `state_revision` is sampled before work
and checked before publishing it; if settings changed during the render, the
unpublished WAV is removed and the current state is retried, preventing mixed
old/new state from entering the cache.

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
`GET /api/download` (MIDI): both call a shared `ensure_*()` helper. MIDI apply
is reused until a content edit invalidates it; WAV download always asks
`ensure_render("quality", activate_player=False)` for the final 44.1kHz
profile. `POST /api/render` supplies the user's `fast`/`quality` selection and
sets `activate_player=True`, while `POST /api/render/prewarm` supplies the same
selection with `activate_player=False`. These three paths therefore share one
cache/key/render implementation without letting a download or prewarm replace
the currently playing source.

The WAV download endpoint intentionally does **not** accept a query-string
token the way `GET /api/audio` does: that exception exists only because
`<audio src>` cannot set a custom header, and a WAV download is always
initiated by `fetch()` from `app.js`, which can set
`X-Miditrack-Token` like every other API call. `tests/test_web.py` asserts
this the same way it already did for `/api/download`.

## Why `midi2wav.sh`, and why the subprocess call never goes through a shell

`render.py` shells out to the package-local `midi2wav.sh` rather than
calling `fluidsynth` directly: SoundFont discovery and fluidsynth's
option-ordering quirk (`fluidsynth`'s CLI requires
`[options] [soundfonts] [midifiles]` — `-F`/`-T`/`-r` must precede the
positional SoundFont/MIDI paths) live in exactly one place for `miditrack`.

This repository's own directory path —
`.../Chill & Relax GAME MUSIC/...` — contains a space and an `&`. Any
shell-interpolated command (a manually built string, `shell=True`) breaks
on that path; worse, an unescaped `&` backgrounds the command silently
rather than raising an error. `render.render_wav()` therefore calls
`subprocess.run(argv, shell=False, ...)` with an explicit `list[str]`
argv. `resolve_midi2wav_bin()` resolves the renderer in this order:
`MIDI2WAV_BIN` env var (fatal if set but not executable — no silent
fallback) → the `midi2wav.sh` found relative to this package's own
resolved location (`Path(__file__).resolve().parents[2]`, i.e. two
directories up from `src/miditrack/render.py` to the `miditrack`
directory) → a bare
`"midi2wav"` on `PATH` (letting `subprocess.run()`'s own PATH search
resolve it, still without invoking a shell).

`midi2wav.sh` enables FluidSynth's `synth.dynamic-sample-loading=1` by
default so a render does not eagerly load unused SoundFont samples. The
`--no-dynamic-sample-loading` switch is an explicit comparison and recovery
path; preserve it when changing the wrapper or FluidSynth option ordering.

## Render measurement contract

`POST /api/render` and `POST /api/render/prewarm` return `renderMs` together
with `renderBreakdown` (`applyMs`, `splitMs`, `fluidSynthMs`, `chipMs`, and
`mixMs`). The first is full request wall time. The per-category values measure
their critical path: concurrent FluidSynth and hardware-chip jobs report the
longest job in that category rather than summed CPU time, so they remain
comparable to the perceived wait. A cache hit has zero work-category values.

`midi.apply_assignments()` returns `durationSeconds` from the already loaded,
edited `MidiFile`, using the same all-track tempo interpretation as the piano
roll (including type-2 files). `WebSession.applied_duration_seconds` caches
that value with `applied_path` and must be reset whenever `invalidate_render()`
resets the applied MIDI. Do not add a second `MidiFile(path)` parse merely to
obtain the duration.

## Short preview rendering contract

`POST /api/render/preview` first checks the matching full-render cache. A hit
returns `available:false, reason:"full-cached"` without parsing MIDI or starting
FluidSynth. Otherwise it cuts the original MIDI window before applying the
current assignments, volumes, speed, and transpose; `write_time_window()`
restores channel state and active notes at tick zero. Its window coordinates are
always on the post-speed output timeline.

Preview WAVs live in `WebSession.preview_cache`, not the full-render LRU.
Preview activation adds only an `audio_sources[render_id]` entry: it must never
write `audio_path`, `current_render_key`, or `current_render_mode`. After a
VGM/NSF conversion, `start_chip_prewarm()` renders the default selection first,
registers it immediately, then renders at most four priority selected channels
in a daemon thread and registers each completed WAV in the LRU under
`render_lock`. Warming every channel in a large VGM would exceed the shared
16-entry/256MB LRU and evict the useful first results. Its long
emulation work stays outside that lock and uses a separate `chip-warm-*` path,
so a foreground render can win the same cache key without corrupting its output.
The cancellation generation is `midi_revision`, not `state_revision`: raw chip
WAVs are independent of volumes, programs, and source selections, so an edit
such as solo must not discard useful in-flight channel warmups. VGM/NSF previews
trim the warmed default-group WAV when all selected game tracks use their
baseline volumes. Non-muted volume edits add a warmed individual channel only
as a gain delta; a solo or mute instead uses only the audible individual
channels, never requesting a 0% channel. Noise/DAC stems are trimmed with
`mix.trim_wav()`. A missing needed channel cache returns
`available:false, reason:"chip-warmup"` and lets the browser take the exact
full-render path rather than starting another expensive emulation synchronously.

**Fixed: preview crashed when `chip_metadata` is absent (legacy `--chip-wav`-only
converter binaries).** `_preview_chip_stems()`'s per-track hardware-channel
block (the one that mixes an individually-warmed VGM/NSF channel WAV as a
volume delta) used to gate only on `web_session.source_format in
CHIP_HARDWARE_SOURCE_FORMATS`, unlike `_plan_chip_hardware()`'s equivalent
block, which also requires `web_session.chip_metadata is not None`
(`_plan_chip_hardware()`'s own `if not selected_chip_indices or not
web_session.chip_metadata: return ...` guard). A session converted through
the legacy fallback path — an `nsf2midi`/`vgm2midi` build old enough to
support only `--chip-wav`/`--noise-wav`/`--dac-wav` and not
`--track-metadata`, still explicitly supported (see "Added: real chip-noise
mixing"'s and "Added: NSF per-track hardware selection"'s "Legacy fallback
preserved" notes) — has `chip_stem_path` set but `chip_metadata` left
`None`, since there is no sidecar to load. Calling
`POST /api/render/preview` against such a session unconditionally reached
`_chip_cache_key(selected_indices)`, which asserts `chip_metadata is not
None` and raised, turning every preview request into a `500`. Fixed by
adding the same `and web_session.chip_metadata is not None` guard
`_preview_chip_stems()`'s sibling function already has; without per-track
metadata there is no `"game"`-selected channel to preview individually
regardless, so this is a pure no-op for every session that does have a
sidecar. `TestWebAppChipStem.test_preview_works_without_chip_metadata_sidecar`
is the regression guard (this test class's fixture converter always returns
the legacy `(stem_path, None)` shape, so it previously reproduced the crash
on every run once a preview test was added).

**Verified: short-preview chip stems stay in sync at non-default speed/
transpose.** `_preview_chip_stems()` only ever slices the *raw, native-tempo*
stem via `mix.trim_wav()` (`source_start`/`source_duration` computed by
scaling the requested output-timeline window by `speed_ratio`, to locate the
matching span in the untransformed source audio) — it does not itself call
`rubberband`. That work happens one layer up: whatever
`chip_render_stems`/`stem`/`dac_stem` `_render_applied_midi()` receives —
whether from `_plan_chip_hardware()` (full render) or pre-sliced by
`_preview_chip_stems()` (short preview) — passes through the same
`has_stem and has_transform` → `_synced_stem()` branch before mixing. This
means a preview's trimmed clip gets rubberband-stretched by the *same*
ratio as a full render's whole-song stem, so its short (~14s) duration
lands correctly on the window's own post-speed length instead of staying at
its native-tempo length. `TestWebAppChipStem.test_preview_syncs_trimmed_chip_stem_when_transform_active`
confirms this directly: a non-default `PATCH /api/session/transform`
followed by `POST /api/render/preview` calls the injected `stem_transformer`
exactly once, with the *trimmed* clip's own path as input (not the raw
full-song stem) and the session's speed/transpose values.

A cut window can legitimately contain no note events for a track that is
editable in the complete song. `validate_volumes()` remains the authoritative
validation at the session PATCH boundary, against the full source tracks.
After that validation, `apply_assignments()` must skip a volume change for an
empty window track rather than reject the whole preview. In particular, solo
sets every non-solo editable track to 0%, so treating such a window as an
invalid volume target makes the first solo preview fail despite valid input.

The browser serializes a solo action with `state.soloOperation` and disables
all solo buttons while it is pending. It snapshots volumes from
`state.session.tracks` (not a DOM list that may be rebuilt by a PATCH), and
clears that snapshot only after the exit PATCH succeeds. Thus a failed exit
keeps enough state to retry restoring every track's pre-solo volume.

The browser stores `activeSource` with the source's global start/end seconds.
Clock display, piano-roll playhead, auto-follow, seeking, loops, and A/B swaps
use global seconds; a short WAV's local `currentTime` is converted through
`sourceGlobalSeconds()` and `sourceLocalSeconds()`. The exact full render is
requested with Fetch `priority: "low"` after a preview and crossfades at the
same global position. Keep the request low-priority: it is background work and
unsupported browsers safely ignore the hint. `renderGeneration()` must leave
the spinner visible while `fullRenderTask` remains pending; the preview's early
return may only end the outer task, never the background full-render indicator.

## Why `rubberband.py` exists — direct chip-stem sync, not batch variations

`src/miditrack/rubberband.py` keeps a real-audio chip/DAC stem in sync with
a non-default MIDI speed/transpose. Batch variations remain a MIDI-layer
feature: they apply each transform to MIDI, then render each combination.

`transform_stem()` runs `rubberband` directly with an explicit argv list and
`shell=False`, including an explicit output path. Its tempo ratio is
`1 / speed`, matching MIDI's tempo-meta scaling direction. It writes to a
same-directory `.partial.wav` path, verifies the result is a non-empty WAV,
then atomically replaces the requested output; every failure path removes
the partial file. This avoids both script-path configuration and inferring
output names from a shell script. The repository path contains a space and
an `&`, so do not introduce shell invocation here.

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

**Why `ensure_render()` remains a locked wrapper around the lower-level
`_render_applied_midi()`**: the former owns state-key lookup, LRU insertion,
state-revision validation, optional player activation, and render-id
bookkeeping. The latter owns only job planning, external rendering, stem sync,
and mixing for a caller-provided MIDI/output/profile. The batch endpoint needs
to render N combinations that intentionally do not enter the audition LRU or
change `audio_path`, so it takes the non-reentrant `render_lock` once and calls
`_render_applied_midi(applied_path, wav_path, *, render_id, speed, transpose,
sample_rate=44100, chip_render_stems=...)` directly for every combination.
Calling `ensure_render()` from that loop would deadlock and would also collapse
distinct batch combinations onto the session's single current state key. This
separation keeps the existing audition source alive throughout a batch run.

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
`applied_path`/`apply_summary` completely untouched. ZIP entries use the
same externally documented `{name}_p{+/-semitones}_x{speed-to-one-decimal}`
label for both WAV and MIDI (for example, `song_p+0_x1.0.wav`), so the pitch
field always precedes the speed field and zero is unambiguous. This is what makes
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
lifecycle, but for a different reason than before**: the field is still
cleared at the same two points —
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

**Why real chip-noise/DAC stems get transformed through `rubberband`
right before mixing, only when a transform is active**: `chip_stem_path`/
`dac_stem_path` (see "Added: real chip-noise mixing" below) are rendered
audio, not MIDI — scaling the MIDI's tempo and transposing its notes does
nothing to those WAVs, so leaving them untouched while the MIDI half speeds
up/transposes would put the stem out of sync and out of tune with the rest
of the mix the moment either control moves off its default.
`_render_applied_midi()` detects a non-default speed/transpose (via the
now-argument-taking `_has_transform()`) and, only then, writes each present
stem into a fresh `render-NNNN.stemsync/` directory through the injected
`stem_transformer(input, output, speed, transpose)`. The synced output, not
the original stem path, is passed to `mix.mix_wav()`. At default
speed/transpose, `stem_transformer` is never called; the ordinary
untransformed render remains dependency-free. `render-NNNN.stemsync/` is
removed in the same `finally` block that already cleans up
`.partN.wav`/split-MIDI temp files.

**Why this and `gameSoundfont`'s track-subset split don't interact**: the
MIDI split in `_plan_render_jobs()` happens against whichever applied MIDI
path it's given (the session's `applied_path` for `ensure_render()`, or a
batch combination's own path for `POST /api/variations`), which already has
that combination's speed/transpose baked in by `_apply_to()` — so both the
game-SoundFont half and the GM half are always rendered from
already-transformed MIDI, and only the real-audio stems need the separate
direct `rubberband` pass described above.

## Added: per-track WAV export (「トラックごとに出力」)

`GET /api/download/wav` only ever returns the final mixed WAV — useful for
listening, but a user bringing the result into a DAW as separate stems had
no way to get there short of re-rendering each instrument by hand outside
`miditrack`. `POST /api/tracks/export` / `GET /api/download/tracks` fill
that gap: they split the same rendering machinery `ensure_render()` already
uses (`_plan_render_jobs()`'s fluidsynth split, `_plan_chip_hardware()`'s
VGM/NSF hardware channels, the standalone `chip_stem_path`/`dac_stem_path`
stems) into one WAV per track (or per logical group), instead of summing
them into one file. The UI lives in the same `<details class="output-panel">`
disclosure as the pre-existing "バリエーションをまとめて生成" — renamed from
`.variation-panel` to `.output-panel` and given a second
`<section class="output-section">` — since both features are "generate
several derived audio files from the current session and zip them," not two
unrelated concerns.

**The core invariant this endpoint is built to satisfy**: summing every WAV
in the exported ZIP (`ffmpeg amix=normalize=0`) must reproduce
`GET /api/download/wav`'s output. This is why every gain that `mix.mix_wav()`
would normally bake into one `-filter_complex` call gets baked into each
standalone file individually instead, via the new `mix.apply_gain()` (a
single-input special case of the same `volume=` filter `mix.mix_wav()`
already uses — `mix_wav()` itself keeps its existing "2+ inputs" contract
unchanged). Concretely:

- Each fluidsynth-rendered track gets `mix.DRY_GAIN` (0.80) if the session
  also has any real-audio contribution (a chip-hardware channel or a
  `chip_stem_path`/`dac_stem_path` stem), or no gain at all (`1.0`, skipping
  ffmpeg entirely) otherwise — the identical `has_stem` rule
  `_render_applied_midi()` already uses for its own fluidsynth part(s).
- Each VGM/NSF hardware chip channel gets whatever gain
  `_plan_chip_hardware()` already computes for it (`mix.STEM_GAIN`, or a
  volume-adjusted multiple of it) — see "Why per-track volume on VGM/NSF
  `"game"` tracks re-renders only the channels whose volume actually
  changed" above.
- `chip_stem_path`/`dac_stem_path` (the non-per-track noise/DPCM/DAC stems)
  each get `mix.STEM_GAIN` baked in and become one standalone
  `{stem}_noise_orig.wav` / `{stem}_dac_orig.wav` file — the same gain the
  real mix already gives them.

Because a plain MIDI session (no chip hardware, no real-audio stem) always
resolves every gain to `1.0`, `mix.apply_gain()`/`mix.mix_wav()` are never
invoked for it — this endpoint gains no new `ffmpeg` dependency for the
common case, matching the project's existing "don't add ffmpeg to the
ordinary path" posture already established for `chipNoise`/`gameSoundfont`.

**Why fluidsynth splitting happens per-track, not per-job**: `_plan_render_jobs()`
splits `applied_path` into at most two MIDIs (game-derived-SoundFont side,
GM side) because that's the coarsest split the final mix actually needs.
This endpoint instead calls `midi.write_track_subset(applied_path, {index},
...)` once per surviving track, reusing the exact same
zero-tick-shift-preserving mechanism (see "Why `write_track_subset()` strips
messages rather than deleting tracks" above) — a track not in `{index}` has
its messages stripped, not the track itself deleted, so tempo/time-signature
metadata anywhere in the file survives and every track's rendered duration
still matches what a combined render would produce. `strip_bank_select` is
decided the same way `_plan_render_jobs()` decides it for its GM-bound half:
`True` whenever `game_soundfont_path` exists, so an SPC track's Bank Select
CC0 (meaningful only inside the game-derived SF2's own bank layout) can't
make fluidsynth silently keep the previous program when rendered against a
generic GM SoundFont.

**Why VGM/NSF hardware channels default to one-WAV-per-channel, with a
`groupChipTracks` opt-in to combine them**: `_plan_chip_hardware()` gained a
`per_track: bool = False` parameter. Its existing (`per_track=False`)
behavior — group every default-volume channel into one emulation pass,
render only volume-adjusted channels individually — stays exactly the
optimization it always was, still used by `ensure_render()`/
`POST /api/variations` and reused here when `groupChipTracks: true` (whose
single-or-multi-input result is combined into one `{stem}_chiptracks_orig.wav`
via `mix.mix_wav()`, or `mix.apply_gain()` when the plan already collapsed
to one input). `per_track=True` instead renders every selected channel with
its own singleton `_render_chip_targets([index], ...)` call, regardless of
whether its volume was touched — full per-channel separation costs one
complete VGM/NSF re-emulation pass per channel (the "全曲再エミュレーション"
cost every response's `field-help` text mentions), which is only worth
paying when the user actually wants separated stems, not for the ordinary
audition/download path. Both branches still go through the existing
`_chip_cache_key()`/LRU cache, so re-exporting after only changing
`groupChipTracks` (or after a prior audition render already populated the
cache with the same channel set) reuses cached WAVs instead of re-emulating.

**Why excluded tracks are silent, not zero-length or missing entirely from
the request**: a track with `note_count == 0`, or whose effective volume
(`WebSession.volumes.get(index, track.source_volume_percent)` — the same
expression `_apply_to()` uses) is `0`, is dropped before any rendering
happens, rather than rendered and included as a silent WAV. Both cases
would just be dead weight in the ZIP for a track the user has already
muted or that never made any sound; the JSON response's `items[]` simply
omits them. If *every* track ends up excluded this way (e.g., every track
muted), the endpoint raises `WebValidationError` rather than returning an
empty ZIP.

**Why the ZIP suffix is `_midi` vs `_orig`, not the `soundfont`/`game`
vocabulary used internally**: `_midi` means "this file came from rendering
the (possibly reassigned) MIDI through a SoundFont," `_orig` means "this
file is (or is derived from) the original game's own audio" — chosen to
match how a user thinks about the choice, not the three different internal
mechanisms that can produce a `"game"`-sourced track (SPC's BRR-derived
SoundFont, VGM/NSF hardware re-emulation, and the non-per-track chip/DAC
stems). All three get `_orig`; only a fluidsynth render against a generic
GM SoundFont gets `_midi`. `_track_filename_label(name, index)` (`web.py`)
is the dedicated normalizer for the track-name half of each filename — it
deliberately does **not** reuse `sanitize_stem()`, because that function
routes every input through `Path(...).stem`, which would truncate a track
name like `"St.Trumpet"` at the first `.` (a real track name is not a
filename with an extension to strip). It shares only the same
"replace anything outside `[\w .()-]` with `_`, then strip leading/trailing
space/dot" regex, and falls back to `Track{index}` for an empty or
whitespace-only name. A same-named track pair naturally gets distinguished
because `{stem}_{label}_{kind}.wav` includes the SoundFont/orig suffix and
the exporting loop's own `unique_wav_name()` helper appends `_1`, `_2`, …
on any remaining collision — the same pattern `_unique_upload_path()`
already uses for upload filename collisions.

**Why `track_export_zip_path` shares `variations_zip_path`'s exact
invalidation lifecycle**: both are derivatives of the identical input set
(assignments/volumes/track_sources/soundfont/speed/transpose), so every
place that already invalidates one (`reset_midi_state()`,
`invalidate_render()`, and `update_download_filename()` when the sanitized
name actually changes) invalidates the other in the same call, for the
same reasons documented under "Added: a user-editable download filename"
below.

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
the same "callers converge on one place" shape as `midi2wav.sh` itself:
`miditrack` has one renderer invocation path instead of reimplementing the
fluidsynth command for each endpoint.

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

**`convert._spc_no_driver_message()` also forwards spc2midi's own ID666/
entry-point diagnostics, when present.** `spc2midi`'s `ReportSpcHeaderHints()`
(its own `CLAUDE.md`) prints a `"--- ID666 tag ..."`-marked block to stderr
on exit 3 for a single `.spc`/`.spc2` input — the game title, artist,
comments, dumper name, and SPC700 entry point, useful for judging whether
an unrecognized driver is a variant of one VGMTrans already supports.
Simply keeping the pre-existing fixed-message replacement would have
silently discarded that block along with the rest of `result.stderr`, so
`_spc_no_driver_message()` locates `_SPC_NO_DRIVER_HINTS_MARKER` in the
stderr text and appends everything from that point on to the fixed Japanese
message — never the *entire* stderr, which would duplicate spc2midi's own
English base message right underneath the Japanese one. This is literal-
string coupling to `spc2midi/src/main.cpp`'s own `printf` text, the same
posture already established for `_parse_nsf_list()`/`_parse_spc_list()`'s
`-l`/`--list` output parsing — a marker-text change on the C++ side must be
mirrored here or the hints silently stop appearing (harmlessly: the base
message alone is still correct, just less helpful). A `.rsn` archive or a
corrupted `.spc`-named input produces no marker (spc2midi's own hint
generation catches that and prints nothing extra), so
`_spc_no_driver_message()` naturally falls back to the base message only —
no branch needed here for that case.

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
`spc2midi --dls` produces or what `midi2wav.sh` can pass through
unchecked (its own `-s`/`--soundfont` argument has no extension
allowlist). `.sf2` was never in question as the only usable format here.

**Why `spc2midi` itself was not touched**: `web.py`/`convert.py` only need
to pass `--sf2` and derive the resulting path — `spc2midi::ReplaceExtension`
(same repo, `src/paths.cpp`) already turns `converted.mid` into
`converted.sf2` deterministically, exactly the pattern
`chip_stem_path_for()` already uses for the NSF/VGM noise stem
(`convert.game_soundfont_path_for()` mirrors it line for line). Rendering
remains a `miditrack` responsibility after conversion, using the selected
SoundFont and its package-local `midi2wav.sh` wrapper.

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
- **On a raw-stem cache miss,
  `render_selection(source_path, output_path, sample_count, targets, track)`
  re-invokes `nsf2midi --chip-render` against the *original* `.nsf` file.**
  The Web layer caches that completed WAV by source generation, song, sample
  count, and exact selected-channel set; returning to the same set therefore
  avoids another emulation pass. A new set must still be rendered together,
  because the only way to get a hardware-accurate combined render of an
  arbitrary channel subset is one pass with everything else muted
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

## Added: full-screen DAW layout

`index.html`'s single `min(1000px, 100%)` column made it impossible to see
the track list and the piano roll at the same time — exactly what editing
instruments/volumes while watching the render's result actually needs. The
`#fullscreen-toggle` button in `.header-inner` toggles `body.is-fullscreen`
(`app.js`'s `setupFullscreenLayout()`). The later zoom-performance fix added stable
`#pianoroll-timeline`/`#pianoroll-viewport` wrappers inside the existing scroll
area, without making fullscreen entry/exit perform DOM surgery.

The header groups `#open-dialog-button`, `#fullscreen-toggle`, and
`#settings-open` inside `.header-actions`, aligned to the right edge. All use
`.header-action-button`, whose white text/icon and high-contrast border are
intentional: the normal gray ghost-button treatment is not sufficiently legible
against the blue header gradient. In the settings dialog,
`.settings-checkbox-row` keeps rounded notes, outlined notes, and grid
visibility together; the two `.settings-field-row` grids pair background/grid
colors and track palette/vertical-grid divisions. These rows become one column
at `max-width: 640px`, while every input ID and its JavaScript event binding
remain unchanged.

### 2026-09 refinement: file-open modal and an uninterrupted track pane

`#upload-card` remains the first, expandable card in the normal layout. On
entry to fullscreen, `moveUploadCardToDialog()` reparents that exact element
into `#open-dialog`, a native `<dialog closedby="any">` opened by the
fullscreen-only `#open-dialog-button`; `moveUploadCardToShell()` returns it to
the start of `.app-shell` when leaving fullscreen. Reusing the one element
preserves its controls, IDs, open state, and event handlers without duplicate
markup or mode-specific state. `setupOpenDialog()` uses `showModal()` so the
browser handles focus containment and makes the background inert. The explicit
close button, Escape, and supported-browser backdrop clicks close it; Safari's
absence of `closedby` is covered by the narrowly scoped backdrop-coordinate
fallback. `showUploadCard()`/`hideUploadCard()` retain the original normal-mode
`<details>` behavior. In fullscreen, file/source/project selection preserves
the open modal so its new conversion controls remain visible; conversion
completion alone closes it. The fullscreen dialog owns the single scroll area
and uses `max-height: calc(100dvh - 24px)`, while its nested upload card has no
height cap. Its summary is permanently expanded, has `aria-disabled`, and hides
its step number and disclosure chevron only in fullscreen; normal-mode
disclosure behavior is unchanged.

Fullscreen no longer reserves a top-left grid row for a collapsed upload
summary. `.app-shell` uses five rows: transport, flexible piano roll,
piano-roll footer, download toolbar, and output panel. `#tracks-card` spans
all five rows from the first row, keeps its normal-layout card heading hidden
only in fullscreen, uses an 8px fullscreen-only card padding, and overrides
the base blue top border with the ordinary neutral card border. This gives the track
controls the first visible pixel of the left workspace. The responsive fallback
also starts with `#tracks-card`; the open dialog remains a top-layer modal at
every viewport width. Escape's fullscreen shortcut explicitly returns when any
native dialog is open, so closing the file dialog cannot change display mode.

The header keeps `miditrack` as the `h1`'s primary label and wraps the smaller
`GM Instrument Assigner` descriptor in `.app-title-subtitle`, preserving the
single accessible heading while reducing the descriptor's visual prominence.

`tests/test_web.py` asserts the normal-layout upload card, fullscreen-only
header/dialog ownership, the fullscreen-only hidden track heading, the neutral
fullscreen track-card border, and the new grid span. Browser verification must
confirm that the header **Open** button appears only in fullscreen, file
selection keeps its modal open without a disclosure chevron, and Escape closes
the modal without exiting fullscreen.

**Why `#audition-card` and `#output-card` become `display: contents` instead
of being restyled as boxes**: normal layout deliberately splits the download
buttons, shared filename, and batch-output disclosure into the separate
`#output-card` headed **出力**, directly below the piano roll. Fullscreen must
retain the pre-split compact right-column sequence, so both cards lose only
their outer box and their children become independently placeable grid items
of `.app-shell`. The transport/piano roll remain children of `#audition-card`;
the download toolbar and output `<details>` are children of `#output-card`.
The `body.is-fullscreen .app-shell > ...` grid rules place them in rows 1–6
without any DOM surgery, while the output heading is hidden only in fullscreen.
Because `display: contents` drops each card's own box, `.disabled-section`'s
opacity would otherwise stop painting. `body.is-fullscreen #audition-card:not
(.ready) > *` and the corresponding `#output-card` rule reapply it to every
visible child; `updateSectionsReadiness()` toggles `ready` on both cards.

**Why the piano-roll canvas still follows fullscreen resizing correctly**:
`setupPianoroll()` observes the scroll viewport and the visible canvas. The
first observer updates the sticky `#pianoroll-viewport` to the scroller's
`clientWidth`; the device-pixel-content-box observer then re-derives
`canvas.width`/`canvas.height` and calls `redrawPianorollStatic()` whenever that
visible box changes. Replacing
`.pianoroll-card`'s fixed `height: 380px` with `height: auto; min-height: 0`
inside a `minmax(0, 1fr)` grid row lets the browser's own layout pass
resize the box, and the existing observer callback does the rest. The
horizontal zoom changes the outer timeline's percentage width while the sticky
viewport and physical canvas allocation remain tied to the visible scroller.
Do not restore a full-timeline canvas: at a measured 2560px-wide fullscreen
viewport, 4x previously created two 15056x1977 backing stores and copied one
into the other every frame; the virtualized canvas is 3764x1977 at both 4x and
8x.

**Why the track table gets a role skeleton in the static HTML rather than
JS-added roles alone**: the DAW layout turns `<table class="track-table">`
into `display: block` (and `<tr>` into `display: grid`, for the per-track
"channel strip" — name/channel/source on one line, instrument/volume on
the next) so it can lay out as the compact strip a DAW's track header
column uses. The two rows deliberately don't share one column split: a
`grid-template-areas` block requires every row to agree on the same column
boundaries, but name/channel/source (3 fields) and instrument/volume
(2 fields, where volume alone needs roughly the combined width of
channel+source to fit its mute/solo/slider/percentage cluster) want
different splits. `body.is-fullscreen .track-row` instead defines 12 equal
`fr` tracks and each `<td>` (matched by `nth-child` position) gets its own
explicit `grid-column`/`grid-row` span — name/instrument each take columns
1–7, channel/source share columns 8–12 on row 1, and volume takes columns
8–12 on row 2 alone. `display: block/grid` strips a table's built-in
accessibility semantics, so `index.html` carries a static
`role="table"`/`role="rowgroup"`/`role="row"`/`role="columnheader"`
skeleton on the parts that never change (the `<thead>` and its one row),
and `buildTrackRow()` (`app.js`) sets `role="row"`/`role="cell"` on each
generated `<tr>`/`<td>` right before returning it, since those rows don't
exist in the static markup. These roles are inert in the normal (non-
fullscreen) layout — a real `<table>` already conveys the same semantics
natively — so this costs nothing outside `body.is-fullscreen`.

**Why Escape uses its own narrow keydown guard instead of reusing
`isPlaybackShortcutBlocked()`**: that existing helper also excludes
`BUTTON`/`AUDIO` targets, which is correct for Space (a focused button's
native behavior *is* to activate on Space, so the global playback shortcut
must yield to it) but wrong for Escape — a keyboard-focused button (e.g.
the fullscreen toggle itself, right after being activated via Enter/Space)
has no native Escape behavior to preserve. `setupFullscreenLayout()` makes
Escape a bidirectional normal/fullscreen layout toggle, so the same shortcut
can enter the DAW layout and leave it. Its dedicated guard only defers to
`isContentEditable`/`INPUT`/`TEXTAREA`/`SELECT` — the actual text-entry and
native-dropdown cases where Escape already has a browser-native meaning to
protect.

### Historical implementation notes (superseded by the 2026-09 refinement)

The following rollout notes document the former collapsible `#upload-card`
implementation. They are retained only to explain earlier measurements and
regressions; do not restore its grid rules or treat them as current behavior.

**Why entering fullscreen force-closes `#upload-card`'s `<details>` from
JS instead of a CSS rule**: `<details open>` is native, per-element browser
state that CSS cannot override (there is no `details[open] { open: false }`
declaration) — only setting the DOM `.open` property does. The card is
collapsed once, on entry, so the compact left column starts with just its
`<summary>` (file name + a chevron) visible; it is never force-reopened on
exit, matching the existing pattern elsewhere in this app of only ever
nudging state one direction from a user action.

**Left column width and the collapsed `#upload-card` heading**: the left
column's width (`.app-shell`'s first `grid-template-columns` track) is
`minmax(0, clamp(360px, 36vw, 640px))` — wide enough that the two-row
channel strip (see above) has real room for the instrument `<select>` and
the full volume control, rather than the initial narrower `clamp(300px,
26vw, 460px)` this shipped with, which was proportioned for the original
3-row strip. `#tracks-card .card-heading` and `#upload-card`'s collapsed
`<summary class="card-heading">` share one compaction rule
(`body.is-fullscreen #tracks-card .card-heading, body.is-fullscreen
#upload-card > summary.card-heading { ... }`): both drop `.step-number` and
the description `<p>`, leaving only a small-caps `<h2>` label — collapsing
`#upload-card`'s `<details>` on entry (previous paragraph) is only worth
doing if its visible `<summary>` is actually this compact; leaving the step
number and full description on the summary line would have made the
"collapse" pointless, since that content is exactly as tall as a couple of
rows in the track list.

**Why the left column only carries `#upload-card` and `#tracks-card`, and
the download/variation controls moved to the bottom of the right column**:
the initial layout put `.download-toolbar`/`.variation-panel` (both
`#audition-card` children promoted by `display: contents`, same as every
other row described above) at the bottom of the *left* column so
`#tracks-card` only got the grid's single flexible row (`grid-row: 3`) to
itself. Moving both to the right column (`grid-row: 5`/`6`, after
`#pianoroll-status`) freed every row below `#upload-card` for
`#tracks-card` alone: `body.is-fullscreen .app-shell > #tracks-card {
grid-row: 2 / 7; }` now spans every remaining row, including the flexible
`minmax(0, 1fr)` track — so the panel's own box (not just its `.table-scroll`
content) stretches to the bottom of the screen regardless of how many
tracks are loaded. A short track list therefore shows blank space *inside*
the panel below the last row rather than the panel itself stopping short;
this was confirmed by measuring `#tracks-card`'s `getBoundingClientRect()`
against `.app-shell`'s own bottom edge (both landed within the shell's own
12px padding) rather than trusting a screenshot at a glance, since the
panel's dark background makes unused space visually indistinguishable from
"the box ended here." The right column's row count grew from 4 to 6
(`.soundfont-field`/`.audition-toolbar`/`.pianoroll-card`/
`#pianoroll-status`/`.download-toolbar`/`.variation-panel`, one row each);
`#pianoroll-status` no longer needs the `grid-row: 4 / span 2` hack it had
when it was the last item in its column, since `.download-toolbar`/
`.variation-panel` now occupy the rows after it directly.

**Why the SoundFont field sits between the piano-roll status line and the
download toolbar, not at the top of the right column**: the transport
(`.audition-toolbar`) now occupies `grid-row: 1` and the piano roll
`grid-row: 2` — the flexible `minmax(0, 1fr)` track — so the DAW's
play/pause/speed/pitch controls sit directly above the timeline the way a
real DAW's transport bar does, and the SoundFont picker (a setting changed
far less often than playback controls) moved down next to the other
"apply/export" controls (`#pianoroll-status` at `grid-row: 3`,
`.soundfont-field` at `grid-row: 4`, `.download-toolbar` at `grid-row: 5`,
`.variation-panel` at `grid-row: 6`).

**Why the `max-width: 900px` fallback assigns every item an explicit
`grid-row` instead of resetting to `grid-column/row: auto` (its original
implementation)**: `#audition-card`'s children are promoted into
`.app-shell`'s grid via `display: contents`, so their fallback stacking
order without an explicit `grid-row` follows plain DOM order — which is
fixed in `index.html` as SoundFont → transport → piano roll → status →
download → variations, independent of whatever order the wide-screen rules
place them in. Once the SoundFont field moved to `grid-row: 4` above (no
longer matching its DOM position), letting the fallback fall back to DOM
order would have put it back above the transport and piano roll on a narrow
window — contradicting the very layout just chosen above 900px. The
fallback keeps `.app-shell` as a `display: grid` (single `minmax(0, 1fr)`
column, `grid-auto-rows: auto`) and gives every promoted child its own
explicit `grid-row: 1` through `8` (upload card, track list, transport,
piano roll, status, SoundFont, download, variations, in that order) so the
narrow layout's stacking order always matches the wide layout's reading
order, regardless of DOM position.

**Why `#tracks-card` needs an explicit `height` inside that same media
query, when the wide layout's `grid-row: 2 / 7` spanning a `minmax(0, 1fr)`
track needed none**: giving `#tracks-card` (and every promoted item) a bare
`grid-row: N` inside a `grid-auto-rows: auto` track relies on the grid
auto-sizing that row from the item's own content size, using the default
`align-self: stretch`. `#tracks-card` is itself `display: flex;
flex-direction: column; min-height: 0; overflow: hidden`, and its child
`.table-scroll` is `flex: 1 1 auto; min-height: 0; overflow-y: auto` — a
flex item with `overflow` other than `visible` resolves its automatic
minimum size to `0` rather than its content size (the same rule
`min-height: 0` exists to opt into elsewhere in this stylesheet). Chained
through an `auto`-sized grid track needing a content-based measurement,
this collapsed `#tracks-card` to roughly its own heading's height (~52px),
hiding the sort chips and every track row — caught by measuring
`getBoundingClientRect()` directly rather than trusting a screenshot, since
the card's own dark background made the collapsed box visually
indistinguishable from a correctly-sized-but-empty one at a glance. The
wide layout never hit this because `minmax(0, 1fr)` is a *definite* track
size once the grid resolves available space, so the stretched item receives
a concrete height up front with no content-dependent measurement pass to
collapse. `body.is-fullscreen #tracks-card { height: min(60vh, 520px); }`
inside the same media query sidesteps the auto-sizing pass entirely by
giving the item a height that doesn't depend on its own content, matching
why `.pianoroll-card` already needed the sibling `height: 320px` override
in this same block.

Verified against a live, non-mocked `create_app()` server
(`.venv/bin/miditrack --no-browser`) with a synthetic 6-track/9-second MIDI
fixture, driven through Chrome DevTools: entering fullscreen produced the
left channel-strip column (sticky sort-chip header, `.table-scroll`
scrolling independently of the page) and the right SoundFont/transport/
piano-roll column; the piano-roll `<canvas>`'s device-pixel backing store
grew to match its new, taller box; starting playback, then toggling
fullscreen and pressing Escape, left `#player-b` continuously playing
throughout (confirmed via `currentTime` sampled before/after both
transitions) — the audio elements are never touched by this feature: the
crossfade/A-B player machinery in "Why an A/B `<audio>` pair..." above is
completely orthogonal to it. Resizing to 800px confirmed the `max-width:
900px` fallback returns to a single scrolling column (via `.app-shell`'s
own `overflow-y: auto`, not the outer document) in the explicit
upload/tracks/transport/piano-roll/status/SoundFont/download/variations
order described above — matching the wide layout's reading order rather
than DOM order — and that `#tracks-card` renders its full track list
(sort chips, every row) at its explicit `min(60vh, 520px)` height with its
own internal scroll, rather than the collapsed, content-less box the first
version of this media query produced.

Historical note: the fullscreen-layout rollout below predates the current
`SF`/`原曲` segmented radio control. Its references to `.source-select`, the
Source dropdown, and the longer `原曲の音源（推奨）` option document the old
layout bugs and their fixes; they are not current implementation guidance.

**Two bugs reported after the layout above shipped, both hand-tested rather
than caught by the automated suite (neither has a Python-side regression to
guard, since both are pure `app.css` layout defects):**

First, the channel strip's row-1 `source`/`ch` column split (`10 / 13` and
`8 / 10` in the original 12-column proportions — 25%/17% of the row) was
sized against `"SoundFont"`, the short static label most tracks show. A
track with `availableSources.length > 1` (VGM/NSF hardware selection, SPC's
game-SoundFont choice) instead renders a real `<select class="source-select">`
whose longer option text — `"原曲の音源（推奨）"` — doesn't fit 25% of the
card width, and a `<select>` clips overflowing text raw, with no `…`, unlike
`.track-name-text`'s existing `text-overflow: ellipsis`. This wasn't caught
by the original verification because the synthetic test fixture had no
dual-source tracks, only the single-source `"SoundFont"` static-text branch.
Column proportions moved from name/ch/source = 58%/17%/25% to 42%/8%/50% (ch
only ever needs 1-2 digits, so it gives up the most room), and
`.program-select`/`.source-select` both gained `overflow: hidden;
text-overflow: ellipsis; white-space: nowrap;` in `body.is-fullscreen` as a
defensive fallback for whatever width remains too narrow regardless (Chrome
and Safari both honor `text-overflow: ellipsis` on `<select>`'s displayed
value, not just plain text elements).

Second, expanding `#upload-card`'s `<details>` (reopening it by clicking its
now-compact `<summary>`, since nothing prevents that) pushed the piano roll
and transport controls down the page. `#upload-card` (`grid-row: 1`, left
column) and `.audition-toolbar` (`grid-row: 1`, right column) share one grid
row, and a CSS grid row's height is shared across every column — the
open `<details>`'s drop-zone/convert-options content (several hundred px)
inflated row 1's auto height for the *whole grid*, shoving row 2 (the piano
roll, on its `minmax(0, 1fr)` track) and every row after it down by that
same amount in both columns, even though the right column's content has no
relationship to the left column's upload state.

The first fix attempt gave `#upload-card` a `max-height` + `overflow-y:
auto`, on the theory that capping the box would stop it from inflating row
1. That was wrong, and shipped without being measured precisely enough to
notice: `max-height` only stops the box from growing *past* the cap — it
does nothing to keep an *auto-sized* grid track from growing to fit the
box's height in the first place, for any height up to that cap. A
`getBoundingClientRect()` comparison before/after opening the card (not
just a screenshot, which had made the shift look smaller than it was) showed
the piano roll's `top` moving from `192` to `406.5` merely from the card's
natural (uncapped, well under the old 520px max-height) open height of
~295px — confirming row 1 was still inflating to match it. The actual fix
removes `#upload-card` from the grid's row-sizing calculation entirely:
`position: absolute` on a grid item still lets it use its assigned
`grid-column`/`grid-row` as its containing block (a normal CSS Grid
positioning feature — the box is positioned and sized against that grid
area's bounds), but an absolutely positioned box no longer contributes to
that track's auto-sizing pass at all, by spec. `body.is-fullscreen
.app-shell > #upload-card` is now `position: absolute; top: 0; left: 0;
width: 100%;` inside `grid-column: 1; grid-row: 1`, with `.app-shell`
gaining `position: relative` (required for the grid-area containing block to
apply) and row 1's track changed from bare `auto` to `minmax(80px, auto)` —
80px because that's the card's own measured collapsed height (`padding:
24px` top/bottom around the compacted single-line `<summary>`), so the
right column's `.audition-toolbar` (58px) still has just enough row height
not to look cramped even though it's now the row's only sizing input. Opening
the card now overlays it (`z-index: 5`, a drop shadow to read as "floating")
on top of `#tracks-card` — which starts at row 2 immediately below the fixed
80px row 1 either way — instead of displacing anything: confirmed by
comparing `.pianoroll-card`/`.audition-toolbar`/`#tracks-card`
`getBoundingClientRect()` before and after opening, all three identical
(`top`/`height` unchanged) to the pixel.

Both were verified by directly mutating `state.session.tracks[]` through
`evaluate_script` (setting `availableSources`/`source`/`sourceSuggested` on
the *correct* track — the session's `tracks[0]` is the always-hidden,
note-less "Conductor"/tempo track in this fixture, not the first visible
row, which cost one failed check before finding the actual note-bearing
track by name — reproducing a VGM-style dual-source track without needing a
real `.vgm` fixture, then `await`-ing the page's own `renderTrackList()`,
itself `async` and silently a no-op if awaited incorrectly) and by toggling
`#upload-card.open` via a real click on its `<summary>` (not just setting
`.open` from script, to exercise the same code path a user's click does) —
both confirmed against a live, non-mocked `create_app()` server through
Chrome DevTools: the `原曲の音源（推奨）` label renders in full with the new
column split, and opening `#upload-card` now leaves the transport bar,
piano roll, and track list at their exact original screen position.

**Why the expanded full-screen file panel does not scroll internally**:
the earlier `max-height: min(60vh, 560px)` and `overflow-y: auto` made the
conversion action fall below an inner scrollbar on shorter wide windows. The
overlay now has no height cap or overflow scroller, while its full-screen-only
padding, drop-zone, conversion panel, and field gaps are reduced. This keeps
the format options and `MIDIに変換` action visible together in the normal
desktop full-screen viewport; the narrow (`max-width: 900px`) fallback retains
the app shell's single-column page scrolling for the rest of the interface.

**Channel-strip row split changed from name/ch/source + instrument/volume to
name/ch/volume + source/instrument**, at the user's request, so row 1 groups
a track's identity and level controls (name, channel, mute, solo, the volume
slider) and row 2 groups its sound-source controls (the source dropdown, the
instrument dropdown with its pin/favorite and mid-song-change-warning
buttons). This needed no HTML/JS change — `buildTrackRow()`'s `<td>` order is
unchanged (name, channel, source, instrument, volume); only each `td`'s
`nth-child`-matched `grid-column`/`grid-row` in `body.is-fullscreen
.track-row` moved, reusing the same 42%/8%/50% row-1 column split from the
`source`-select fix above (now applied to name/ch/volume instead of
name/ch/source) and giving row 2's source/instrument an even 50/50 split
(source still needs the room the `原曲の音源（推奨）` fix above established;
instrument carries the GM program name plus the pin and ⚠ buttons inline).

**Two more bugs found by hand-testing the `position: absolute` overlay fix
above and the new row split, both fixed the same day:**

First, the overlay itself was wrong: opening `#upload-card` covered the
*entire* right column — the transport bar, piano roll, and everything below
it — not just the left column as intended.
`getBoundingClientRect()` showed `right: 1440` (the full viewport width) on
a 1440px-wide window, confirming the box's containing block was the whole
grid, not column 1's track. The cause is a specific, easy-to-miss CSS Grid
rule for absolutely positioned grid items (CSS Grid Level 1 §10.1): when
`grid-column`/`grid-row` is written with only a start line (`grid-column:
1`, which resolves to `grid-column-start: 1; grid-column-end: auto`), the
`auto` end is **not** resolved through the normal auto-placement algorithm
for an absolutely positioned item — auto-placement doesn't apply to abspos
items at all — instead an `auto` end value falls back to the grid
container's own far edge. So `grid-column: 1` on an in-flow item means
"occupy exactly track 1," but the *same declaration* on a `position:
absolute` item means "start at track 1's start line and extend to the
container's right edge." `grid-row: 1` had the identical bug in the other
axis (silently didn't matter at 1440px width because the card's own content
height happened to stay within row 1's neighborhood, but would have made
the overlay span the entire page height in the `max-width: 900px`
single-column fallback, which reassigns `#upload-card` its own `grid-row:
1` too). Both instances — the base rule and the fallback's — now write
explicit two-sided spans (`grid-column: 1 / 2; grid-row: 1 / 2;`) so the
grid area resolves to exactly one track in each axis, matching the in-flow
behavior the original (wrong) code assumed applied uniformly.

Second, `.source-select`/the plain-text source label sat left-aligned inside
its row-2 grid cell with a visually dead gap trailing it before the
instrument dropdown started. The cell (`<td>` at `nth-child(3)`, the actual
grid item) was correctly stretched to its assigned 50% column width, but
the `<select>` (or bare text node, for a single-source track) *inside* that
`<td>` is an ordinary shrink-to-fit inline-level child, not itself a grid
item — grid's `justify-self: stretch` only stretches the item placed
directly in the grid, so it had no effect on content one level further in,
and the box just sat at its own short content width. `body.is-fullscreen
.track-row td:nth-child(3)` gained `display: flex; justify-content:
flex-end; align-items: center;`, turning the cell itself into a flex
container so its child (select or text) right-aligns flush against the
instrument column instead of floating at the left with trailing blank
space — visually clustering the two dropdowns together rather than leaving
one adrift. The existing `min-width: 0` on `.source-select` continues to do
its job for the opposite (too-narrow) case, now as a flex-item minimum
instead of a grid-item one — the same "resolves to min-content unless
overridden" rule applies to both contexts.

Both were verified against a live, non-mocked `create_app()` server: opening
`#upload-card` at 1440px width now measures `right: 530` against a
`.audition-toolbar` starting at `left: 542` (no overlap, confirmed by
`getBoundingClientRect()` on both, not just a screenshot), and every
source cell — `<select>` and plain-text alike — sits flush against its
row's instrument column with no intervening gap.

**Two follow-up polish requests on the same channel strip, both handled by
one container-level rule and one fixed width, no per-cell special-casing:**

The ch number (row 1) and the `パーカッション（ch10）のため変更できません`
lock-reason text (row 2, for a non-editable percussion track) both sat
visibly above-center relative to their row's other controls (the mute/solo/
volume cluster in row 1, the source dropdown in row 2). The cause was the
grid's default `align-items: stretch`: every `<td>` (grid item) stretched to
fill its full row height, and whichever cell's own content didn't already
center itself internally (the ch `<td>` has nothing but a bare `10` text
node; the lock-reason `<span>` is a plain block) just flowed to the *top* of
that stretched box — while name/volume/source *did* look centered only
because their own inner content happens to establish its own flex
`align-items: center` one level down. Rather than special-casing each
column, `align-items: center` moved onto `.track-row` itself (the grid
container): every `<td>` now sizes to its own natural content height and
centers within the row, matching for every column at once — confirmed by
comparing every cell's `centerY` in a percussion row (`599`/`599`/`599` for
name/ch/volume, `634`/`634` for source/instrument), all pixel-identical.
`td:nth-child(2)`'s now-redundant `align-self: start` (the original,
wrong-for-this-purpose top-alignment) was removed.

Separately, `.source-select`'s width still came from its own text content
(`"SoundFont"` vs. the much longer `"原曲の音源（推奨）"`), so even
right-aligned (previous fix), two tracks' dropdowns landed at visibly
different sizes — a column of controls that doesn't line up reads as
sloppier than the single-track case the earlier fix targeted.
`body.is-fullscreen .source-select` gained a fixed `width: 12.5rem` (`flex:
0 1 12.5rem`, so `min-width: 0` — already set — still lets it shrink below
that at the left column's narrowest widths rather than overflow), sized
with room for the longest label. Every dropdown now measures the same
`200px` regardless of which label it holds, confirmed across two tracks
with different source text.

**The gap between the transport toolbar and the piano roll was noticeably
wider in fullscreen (measured `50px`) than in normal mode (measured
`16px`), and the fix went through two iterations before both sides of the
toolbar (above *and* below it) were tight.** Normal mode's `16px` comes
entirely from `.pianoroll-card`'s own `margin-top: 16px` — in that layout
`#audition-card` is an ordinary block, so `.app-shell`'s grid `gap` never
applies between `.audition-toolbar` and `.pianoroll-card` at all (they're
not siblings of `.app-shell`; only `#audition-card` itself is). Fullscreen's
`50px` had three components stacking: `.audition-toolbar`'s `align-self:
start` left it sitting flush against the top of its row while the row
itself was `minmax(80px, auto)` — sized for the collapsed `#upload-card`
overlay's height, not the 58px-tall toolbar — leaving 22px of dead space
below the toolbar before the row even ended; then `.app-shell`'s `gap: 12px`
(which *does* apply here, since `display: contents` promotes both elements
to direct grid children); then the same `margin-top: 16px` on
`.pianoroll-card` that normal mode relies on, now stacking on top of both of
those instead of being the only contributor.

The first fix flipped `.audition-toolbar`'s `align-self` from `start` to
`end` (pushing the row's slack space above the toolbar, next to the header,
instead of below it) and zeroed `.pianoroll-card`'s redundant `margin-top`.
That closed the gap *below* the toolbar to a clean `12px`, but — pointed out
immediately afterward — it did nothing for the gap *above* it, which was now
the same `22px` of slack that used to sit below, just relocated. The row
still had to be at least 80px for a real reason (`#upload-card`'s collapsed
height), and the toolbar only ever needed 58px of it — no single-axis
`align-self` choice could give both edges of the toolbar a tight fit
simultaneously against a row forced taller than its own content by an
unrelated column's requirement.

**The real fix decouples the two columns' row-1 sizing entirely**, since a
shared CSS Grid row's height applies to every column whether or not that
column actually needs the extra space. `grid-template-rows` gained a second,
small, fixed row (`auto 12px minmax(0, 1fr) auto auto auto auto` — a bare
`12px` track inserted right after row 1, shifting every subsequent row
number by one) used only as a buffer: `#upload-card` spans `grid-row: 1 / 3`
(rows 1+2 together, ≈ its own 80px collapsed height, though since it's
`position: absolute` this span only matters for its containing-block
semantics, not its actual rendered size) and `#tracks-card` starts at row 3
— clearing the collapsed overlay by construction, the same guarantee the old
`minmax(80px, auto)` row 1 provided. Row 1 itself, now freed of that
constraint, is bare `auto` — sized purely by whatever's actually in it,
which for column 2 is just the 58px toolbar, so `.audition-toolbar` (back to
`align-self: center`, though with row 1 now ≈ its own height the alignment
barely matters) sits with no slack on either side. The trick that keeps
column 2 from *also* paying for the 12px buffer row: `.pianoroll-card`
spans `grid-row: 2 / 4` — rows 2 and 3 as one continuous item — rather than
being confined to row 3 alone. Grid `gap` only appears *between* separate
items across a row boundary; a single item spanning across an otherwise-empty
row absorbs that row into its own box for free, so the piano roll's top edge
sits exactly `12px` (one `gap`) below the toolbar, with the buffer row
contributing zero extra visual space to that column. Every row number for
`#pianoroll-status`/`.soundfont-field`/`.download-toolbar`/`.variation-panel`
shifted by one to match (4/5/6/7). Verified live at 1440px width: `12px`
above the toolbar (matching `.app-shell`'s own padding, i.e. no extra slack
at all) and `12px` below it before the piano roll begins; `#upload-card`'s
collapsed height (`80px`) still ends `14px` before `#tracks-card` begins
(`upload.bottom − tracksCard.top = -14`, confirming no overlap); and
opening `#upload-card` still measured `right: 530` against the toolbar's
`left: 542` (no encroachment into the right column, unaffected by any of
this row renumbering). The `max-width: 900px` fallback needed no change —
it defines its own independent `grid-row: 1` through `8` for every item and
was never affected by the wide-layout row count.

**Compact channel-strip row height, requested once the two-row layout
itself was settled**: with more tracks needing to be visible at once being
the whole point of the fullscreen mode, a 89px-per-track row (measured)
meant only ~10 tracks fit in a typical viewport before `.table-scroll`
had to scroll. Every fullscreen override here is additive/scoped under
`body.is-fullscreen` — none of the touched classes' *base* rules changed,
so the normal (non-fullscreen) wizard layout's row height is untouched
(verified: `.mute-button` still measures `32×32` there). Three things drove
the 89px figure, all reduced together (shrinking only one leaves the row
governed by whichever is still tall): `.track-row`'s own `padding: 10px 4px`
→ `6px 4px` and `gap: 4px 8px` → `3px 8px`; the shared
`.pin-button`/`.mute-button`/`.solo-button`/`.track-warning-button` square
size `32px` → `26px` (with `font-size` trimmed to `13px` to match, since
these are icon/glyph buttons whose size is mostly the box, not text) and
`.program-select`/`.source-select`'s padding `6px 8px` → `4px 6px`; and
`.track-name`'s `min-height: 32px` → `26px` plus `.track-color-bar`'s
`height: 28px` → `22px` (needed because row 1 is governed by whichever of
the name div or the volume/mute/solo cluster is taller — shrinking only the
buttons would have left `.track-name`'s own `min-height: 32px` still
forcing the row back up to 32px). `.track-volume-control`'s
`grid-template-columns` first two `32px` tracks (reserved for the mute/solo
button cells) moved to `26px` to match. Net result: `69px` per row
(measured), a ~22% reduction, without needing to touch font sizes for
actual readable text (track names, GM program labels) — only icon-button
boxes and control padding. Verified against tracks with a dual-source
`<select>` (VGM/NSF `原曲の音源（推奨）`/SoundFont) and a mid-song
Program-Change ⚠ warning button together on one row: both remain fully
legible and clickable at the smaller size, with no clipping or overlap.

## Added: dark mode (`prefers-color-scheme`, no manual toggle)

**Superseded in one respect — see "Added: 表示設定 (Display settings) dialog"
below.** This section's token architecture (the `--neutral-*` re-pointing,
`--toast-bg` separation) is still exactly how theming works; only the
*mechanism that selects light vs. dark* changed, from a bare
`@media (prefers-color-scheme: dark)` block to a `[data-theme]` attribute
JS resolves and writes, so a user can now pin Light or Dark independent of
the OS setting. The reasoning below for why each token is shaped the way it
is remains accurate and is not repeated in the newer section.

`index.html`'s `<meta name="color-scheme">` was `light` only and `app.css`
had a single, light-only palette — every color was a `--neutral-*`/`--brand*`
custom property in `:root`, which made this a CSS-only change with no
`app.js`/`web.py` involvement. `index.html`'s `<meta name="color-scheme"
content="light dark">` plus `color-scheme: light dark;` on `:root` (`app.css`)
is what lets native form controls (`<select>`, `<input>`, `<audio>`) pick up
dark rendering automatically, on top of the `@media (prefers-color-scheme:
dark)` override block.

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

## Added: 表示設定 (Display settings) dialog — theme selection, piano-roll appearance, and per-color customization

Three independent display preferences (`roundedPianorollNotes`,
`outlinedPianorollNotes`, `showPianorollKeyboard`) had each been added as
its own raw checkbox directly in `.pianoroll-footer`, and `#hide-empty-tracks`
lived as a bare checkbox above the track table. That pattern does not scale:
this feature adds a manual light/dark/system theme choice, a piano-roll
height picker, grid visibility/division controls, per-color background/grid
customization, and a track color palette picker — eight more preferences —
and stacking all of them as loose checkboxes in the main flow would crowd
out the actual editing UI. `#settings-dialog`, opened from a new gear-icon
`#settings-open` button in the header, collects every display-only setting
(including the pre-existing three checkboxes and `#hide-empty-tracks`, both
relocated here) in one place. Every control in the dialog is still
immediate-apply/immediate-save with no OK/Cancel draft state, exactly the
behavior the three original checkboxes already had — this dialog is
strictly a UI reorganization, not a new interaction model.

### Theme selection: `[data-theme]` replaces the bare `@media` block

`appTheme` (`"system"`/`"light"`/`"dark"`, default `"system"`) is resolved
client-side by `resolveTheme()` and written to `document.documentElement
.dataset.theme`; `app.css`'s dark-mode override block, previously a bare
`@media (prefers-color-scheme: dark)` selector (see "Added: dark mode"
above), is now `[data-theme="dark"]` with identical contents — an explicit
`light`/`dark` choice simply writes a fixed attribute value, while `"system"`
resolves through `matchMedia("(prefers-color-scheme: dark)").matches` every
time `applyThemeSetting()` runs. The `matchMedia` `"change"` listener that
used to call `redrawPianorollStatic()` directly now calls `applyThemeSetting()`
instead — `resolveTheme()` ignores the OS value whenever `appTheme` is an
explicit `"light"`/`"dark"`, so routing every OS-level change through this
one function correctly no-ops for a pinned theme without a separate branch
for "is the user on system mode."

**Why the initial theme-detection line lives at the top of `app.js`, not in
an inline `<head>` `<script>`**: the natural fix for a light→dark flash on
load is a synchronous inline script that sets `data-theme` before the
render-blocking stylesheet resolves. That was the first implementation here,
and it silently never ran — `web.py`'s `add_security_headers()` sends
`Content-Security-Policy: ... script-src 'self' ...` with no
`'unsafe-inline'`, and the browser blocks inline `<script>` execution outright
(confirmed live: the browser console showed a CSP violation, not a runtime
error, so nothing about the page's visible behavior hinted at the failure).
The fix moves the same one-line assignment to the very top of `app.js`
itself, which is a same-origin external script the CSP already allows. Since
`<script src="/assets/app.js" defer>` still only executes after the document
has finished parsing, and the `<link rel="stylesheet">` in `<head>` is
render-blocking regardless, this loses no meaningful protection against the
flash in practice — the browser cannot paint until the stylesheet resolves,
and the deferred script runs at essentially the same point. Any future
"run something before first paint" idea in this codebase must go through an
external `/assets/*.js` file for the same reason; a `<script>` tag typed
directly into `index.html` will not execute.

### Piano-roll colors: token indirection lets a null mean "follow the theme"

`--pianoroll-background`, `--pianoroll-automation-background` (the PITCH
lane), and `--pianoroll-grid-line` are new `:root`-level custom properties
that default to `var(--neutral-10)`/`var(--neutral-20)`/`var(--neutral-30)`
respectively — `.pianoroll-card`'s `background`, `drawPianorollGrid()`, and
`drawPitchAutomationGrid()` all read through these tokens now instead of the
raw neutrals directly. This indirection exists solely so a user-picked color
can override just these three roles without touching the neutral scale
everything else still depends on. `applyPianorollColors()` sets or removes
an inline `style.setProperty()` on `document.documentElement` for each
token: a non-null `pianorollBackgroundColor`/`pianorollGridColor` overrides,
`null` (the default, meaning "follow the theme") removes the property
entirely and lets the cascade fall back to the `:root` default — which is
why `cssColor()` needed no changes at all; it already reads whatever the
cascade resolves to. Setting a background color also writes the same value
onto `--pianoroll-automation-background`, so the PITCH lane never keeps a
theme-default gray while the note area above it has been recolored; the
lane's separation from the note area is carried entirely by the (possibly
also user-set) grid-line color instead of a background difference.

`<input type="color">` cannot represent "no value," so each color field
pairs with a "テーマ既定に戻す" (Reset to theme default) button that sets the
state field back to `null`. The picker's own displayed value is kept in
sync with the *effective* resolved color (not just the raw override) by
`syncSettingsDialogControls()`, which reads `cssColor()` after applying both
the theme and any override — this is also why `applyThemeSetting()` calls
`syncSettingsDialogControls()` at its end: switching themes changes what an
unset (`null`) color field's effective value actually is, and the picker
swatch would otherwise show a stale color left over from the previous theme
until the dialog happened to be reopened. Each `<input type="color">` fires
`input` continuously while dragging and `change` once on release;
`setupPianorollColorField()` uses `input` only to call `applyPianorollColors()`
(a live preview, no network call) and `change` to actually call
`savePreferenceFields()`, so scrubbing the picker does not flood
`/api/preferences` with one PATCH per intermediate color.

Server-side, `_validate_hex_color()` (`preferences.py`) accepts only `None`
or a string matching `^#[0-9a-fA-F]{6}$`, normalized to lowercase before
writing — deliberately narrower than "any valid CSS color," because the
stored value is later assigned straight to `context.fillStyle` inside
`drawPianorollGrid()`; accepting an arbitrary string here would mean
trusting unvalidated preferences-file content as a Canvas fill value with no
practical reason to allow anything beyond a hex triple for this UI.

### Track color palette: still one source of truth, now with four implementations

`getTrackColor()`/`getTrackOutlineColor()` remain the single place both the
piano-roll note fill and each track row's color marker read from (see
"Track colors have one browser-side source of truth" above) — this feature
does not change that invariant, it changes what's *behind* those two
functions. `TRACK_COLOR_PALETTES` holds four entries: `rainbow` (the
original hue-by-index HSL formula, byte-for-byte the previous behavior),
`vivid` (the same hue formula at 90% saturation, for stronger track
separation),
`muted` (the same hue formula at lower saturation, for long viewing
sessions), and `accessible` (a fixed Okabe-Ito eight-color set, cycled by
`trackIndex % 8` rather than spread across `trackCount`, so track N always
gets the same color regardless of how many tracks are currently visible —
unlike the two hue-based palettes, where a track's color depends on the
total count and therefore can shift when `hideEmptyTracks` changes which
rows are counted). `activeTrackColorPalette()` looks up `state
.trackColorPalette` on every call rather than being cached, so a palette
change takes effect on the very next redraw with no extra invalidation
logic. Selecting a new palette calls both `redrawPianorollStatic()` and
`renderTrackList()` (the latter for the track-row color markers), unlike
every other display-only preference here, which only needs the piano-roll
redraw.

### Piano-roll height and grid controls

`pianorollHeight` (`"compact"`/`"standard"`/`"tall"`, default `"standard"`)
drives a `--pianoroll-card-height` custom property via `.pianoroll-card
[data-height="compact"|"tall"]` attribute selectors (`"standard"` sets no
attribute and falls through to the existing `380px` default via the
property's fallback argument, `var(--pianoroll-card-height, 380px)`), so the
long-standing "380px is exactly double the original 190px" comment and math
in `app.css` needed no change — only a variable indirection layered on top.
The full-screen layout's own `height: auto`/`320px` overrides
(`body.is-fullscreen .pianoroll-card`) are unaffected and still win by
cascade order, exactly as intended: the height picker is a normal-layout-only
setting, matching how the piano roll already behaves differently in each
layout. `showPianorollGrid` gates only `drawPianorollGrid()`'s line-drawing
half; the background fill always runs regardless, so turning grid lines off
never also blanks the roll. `pianorollGridDivisions` (`4`/`8`/`16`, default
`8`) replaces the hardcoded vertical-line loop bound; the horizontal
6-division split is deliberately left untouched by this setting, since it
exists to mark pitch reference lines, not a time grid the user is choosing a
density for.

### `preferences.py`: a validator table instead of one `if` per field

Growing from 3 boolean display preferences to 11 total fields (8 new: theme,
height, grid visibility, grid divisions, two colors, palette, and moving
`hideEmptyTracks` from frontend-only `state` into persisted preferences)
would have meant roughly tripling the size of `load_preferences()`'s
per-field `isinstance` fallback chain and `save_preferences()`'s per-field
`if "x" in updates` chain, both already showing that shape for the original
three booleans. `_FIELD_VALIDATORS: dict[str, Callable[[Any], Any]]` maps
every preferences field name to its validator function; `load_preferences()`
now loops over `_empty_preferences()`'s keys and falls back to that field's
own default on `WebValidationError`, and `save_preferences()` loops over
`_FIELD_VALIDATORS` and applies only the fields present in `updates` — both
functions are now field-count-independent, and adding a field is a
two-line change (one default in `_empty_preferences()`, one table entry).
`_validate_bool(value, field)` and `_validate_choice(value, allowed, field)`
are new generic helpers; the three original per-field boolean validators
(`_validate_rounded_pianoroll_notes` etc.) were removed in favor of lambdas
delegating to `_validate_bool` — the only externally-visible difference is
`showPianorollKeyboard`'s error message wording changing from "は真偽値で"
to "はtrueまたはfalseで" to match the other two, which no test asserted on.
`PATCHABLE_PREFERENCE_FIELDS = frozenset(_FIELD_VALIDATORS) - {"selectedSoundfont"}`
replaces `web.py`'s own hardcoded `allowed_fields` set inside
`update_preferences()` — `selectedSoundfont` stays excluded from PATCH
because it is written only via `POST /api/soundfont` (see "Added:
in-browser SoundFont selection" above), and keeping that exclusion as a set
subtraction from the single validator table means `web.py` no longer needs
its own separate list of field names to keep in sync by hand.

Verified against a live, non-mocked `create_app()` server driven through
Chrome DevTools (real browser, no fakes): the settings dialog opens from the
gear icon and every control reflects the previous screenshot's dark-theme
palette on load; switching **全体の表示** to **ライト** flips both the page
chrome and the dialog itself, and reloading the page confirms the choice
(and every other changed field) persisted via `preferences.json`, not just
in-memory `state`; setting a custom background color updates
`--pianoroll-background` immediately and is reflected back through
`GET /api/preferences`, while clicking "テーマ既定に戻す" clears it back to
`null` and the resolved color reverts to the theme's own token; switching
**高さ** to **大** measured `.pianoroll-card`'s computed `height` at `560px`.
One real bug was caught only by this live check, not by any mocked test:
firing several `#settings-dialog` control `change` events back-to-back with
no delay between them (simulating unrealistically fast scripted input,
not real pointer interaction) lost some of the earlier PATCHes — each
`PATCH /api/preferences` does its own `load_preferences()` → mutate → write
round trip with no locking, so two in-flight requests can each read the
same pre-update file and the later write silently clobbers the earlier
field's change. Spacing the same changes a few hundred milliseconds apart
(matching how a person actually interacts with several distinct dropdowns)
persisted every field correctly. This race already existed for any two
of the original `savePinnedPrograms()`/`saveUsageCounts()`/`saveDisplayMode()`
-style calls landing close together — see their own "保存できなくても...
次回の変更で再送されれば整合する" eventual-consistency comments — and was
judged acceptable to leave as-is here for the same reason: this is a local,
single-user tool where two genuinely simultaneous preference writes require
either scripted automation or sub-hundred-millisecond double-clicks across
different controls, neither realistic for how this dialog is actually used.

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
flexibility (unlike `MIDI2WAV_BIN`, no ordinary user is
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
xcrun swiftc -typecheck miditrack_app.swift
plutil -lint "$HOME/Applications/miditrack.app/Contents/Info.plist"
```

`test_web.py`'s `TestWebAppAudioSourceHistory` covers the `?v=<render_id>`
resolution the A/B crossfade player depends on (see "Why an A/B `<audio>`
pair..." above): its injected `fake_renderer` embeds the call count into
both the WAV's content and its length, so a test can tell "the bytes for
render_id 1" apart from "the bytes for render_id 2" by more than just which
disk path was hit. It asserts an old `render_id` keeps serving its own WAV
(full body and via a `Range` request) after a second, content-different
render has activated and moved `audio_path`; that an unknown/omitted `v`
falls back to the current `audio_path`; and that a fresh MIDI upload (going
through `reset_midi_state()`) makes the old `render_id` 400 again. The
`app.js`-literal-string half of this regression guard, `test_web.py`'s
`test_render_reload_preserves_relative_playback_position`, was rewritten
alongside the crossfade feature: it no longer greps for the old
`resetPlayer({ preservePosition: true })`/`pendingPlaybackRatio` mechanism
(replaced outright — see below) and instead asserts `markRenderStale()`/
`scheduleAutoRender()` exist and that `crossfadeToRender()`'s position
handoff is ratio-based (`const ratio = Number.isFinite(fromDuration) &&
fromDuration > 0`), not absolute-seconds-based.

Beyond the mocked/string-literal tests above, the A/B crossfade itself was
verified against a live, non-mocked `create_app()` server launched via
`./miditrack.sh --no-browser` (real `fluidsynth`) and driven through Chrome
DevTools: starting playback, then changing the fast/quality toggle mid-song,
produced a real ~160ms equal-power crossfade between `#player-a` and
`#player-b` with `currentTime` continuous across the swap (sampled every
80ms via `requestAnimationFrame`-adjacent polling), and the network log
showed both `?v=1` and `?v=2` continuing to resolve to their own WAV's bytes
after the swap — the exact scenario `TestWebAppAudioSourceHistory` guards at
the HTTP layer. A second run confirmed the paused-state path never calls the
activating `POST /api/render`, only `POST /api/render/prewarm`, and never
moves `activePlayer()`'s `src`.

`tests/test_gm.py`, `test_midi.py`, `test_render.py`, `test_convert.py`,
`test_rubberband.py`, and `test_preferences.py` need no real MIDI file,
fluidsynth, converter, or real `rubberband` subprocess, or Flask test
client. `test_preferences.py` sets `MIDITRACK_PREFERENCES_PATH` to a temp
file in `setUp()`/restores it in `tearDown()` so it never reads or writes
the real user's `~/Library/Application Support/miditrack/preferences.json`;
it covers the missing-file/corrupt-JSON/non-dict-JSON fallbacks, the
partial-update contract, every validation rule (program range, `bool`
rejection, non-integer keys, negative counts), and the same round-trip/
clear-to-`None`/rejects-non-string/rejects-empty-string coverage for
`selectedSoundfont`. `test_web.py`'s `TestWebAppPreferences` covers the
same round-trip-plus-reject shape for every 表示設定-dialog field added by
the theme/piano-roll-appearance/track-color-palette feature above —
`appTheme`, `pianorollHeight`, `showPianorollGrid`/`pianorollGridDivisions`,
`pianorollBackgroundColor`/`pianorollGridColor` (including the lowercase-
normalization and clear-to-`None` cases), `trackColorPalette`, and
`hideEmptyTracks` — plus the `test_get_preferences_includes_default_
ensemble_presets` assertion block, which checks all eight defaults at once.
It does the same
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
`test_rubberband.py` mirrors `test_render.py`'s approach: it mocks
`subprocess.run` to assert the direct `rubberband -q -t -p` argv, explicit
output path, and `shell=False`; it covers missing binaries, timeouts,
non-zero exits, empty output, and partial-file cleanup. The speed/pitch
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
stem_transformer=<fake>)` so no real `fluidsynth`, converter, or
`rubberband` process is spawned; it does directly verify
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
`stem_transformer` when no chip stem is present (the headline regression
guard that the batch path is fully MIDI-layer now, not a `rubberband`
post-process), leaves the session's own `speed`/`transpose` and the
existing audition render (`/api/audio`) untouched by a batch run, cleans up
`variations_work/` and every `render-*.partN.wav`/split-MIDI temp file
afterward, and that `GET /api/download/variations` returns a ZIP
containing a `.wav` and a `.mid` per combination by default (with filenames
encoding speed/transpose and the `.mid` verified via `mido` to carry the
correctly scaled tempo and shifted note) — or only `.wav` files, with every
`items[]` entry's `"mid"` field `null`, when `includeMidi: false` is
passed — and is invalidated by a subsequent track change.

`TestWebApp` covers `POST /api/tracks/export`/`GET /api/download/tracks`
(per-track WAV export) the same way it covers `/api/variations`: one WAV
per track named `{stem}_{trackName}_{midi|orig}.wav`, exclusion of a muted
or note-less track (and a `400` when every track ends up excluded),
rejection of a non-`bool` `groupChipTracks`, the same custom-filename/
invalidation-on-rename/invalidation-on-track-change trio `/api/variations`
already has, that `track_export_work/` is cleaned up afterward, that the
export never mutates the session's own `speed`/`transpose`, and that a
track name containing a `.` (e.g. `"St.Trumpet"`) survives intact in the
exported filename — the regression guard that `_track_filename_label()`
does not route through `sanitize_stem()`'s `Path(...).stem` truncation.
`TestTrackFilenameLabel` unit-tests that normalizer directly (dot
preservation, unsafe-character replacement, empty/whitespace-only name
falling back to `Track{index}`). `TestWebAppGameSoundfont` gained coverage
for the SPC branch (both tracks `_orig` via the game-derived SoundFont
before any assignment, split into `_midi`/`_orig` after `_assign_track0()`,
with `mix_calls` confirmed empty since no stem is present to justify an
`ffmpeg` gain call). `TestWebAppLibvgmTrackSource` gained the VGM
hardware-channel coverage: the default (`groupChipTracks: false`) path
renders the selected channel individually (one `libvgm_calls` entry) and
emits `_orig`; `groupChipTracks: true` combines the same channel-selection
plan into one `{stem}_chiptracks_orig.wav`; and muting the hardware channel
excludes it from the ZIP without disabling its underlying
`_plan_chip_hardware()` render (a muted channel's gain is `0`, but the
plan itself is unaffected — only this endpoint's ZIP membership is). Both
that class and `TestWebAppChipStem` (a new
`test_track_export_noise_stem_gets_stem_gain_and_transform_sync`) inject a
`gain_applier=<fake>` fixture (mirroring the pre-existing `mixer=<fake>`
pattern) so `mix.apply_gain()`'s real `ffmpeg` invocation is never
exercised by these tests; the chip-stem test additionally confirms the
noise stem is pitch/speed-synced through the injected `stem_transformer`
before its `mix.STEM_GAIN` is baked in, matching `_render_applied_midi()`'s
own `_synced_stem()` usage. `test_mix.py`'s `TestApplyGain` covers
`mix.apply_gain()` directly (argv shape, the single `-i`/`-filter:a
volume=...` construction, sample-rate pass-through, and the same
`FileNotFoundError`/timeout/non-zero-exit/empty-output failure modes
`TestMixWav` already covers for `mix_wav()`).

Beyond the mocked unit tests, this feature was verified against a live,
non-mocked `create_app()` server (`./miditrack.sh --no-browser`, real
`fluidsynth`/`ffmpeg`) driven through a real browser: uploading a 2-track
fixture and clicking "トラックごとにZIPでダウンロード" produced a real ZIP
with two valid 44.1kHz stereo WAVs (`afinfo`-confirmed); summing them with
a real `ffmpeg amix=normalize=0` reproduced `GET /api/download/wav`'s own
output to within 0.04% RMS (`sqrt(mean squared difference)` against the
signal's own RMS) — the practical confirmation of the "stems sum back to
the final mix" invariant this feature is built around. The
`#track-export-group-chip-field` checkbox's `hidden` toggle also surfaced
an unrelated pre-existing-pattern bug during this verification: `.hidden`
alone does not hide a `.convert-field.is-checkbox` element, because that
class's own `display: flex` (two-class specificity) outranks the browser's
default `[hidden] { display: none }` UA rule (one-attribute specificity) —
the same reason `.convert-panel[hidden]`/`.playlist-note[hidden]`/
`.pianoroll-empty[hidden]` overrides already exist elsewhere in `app.css`.
`.convert-field.is-checkbox[hidden] { display: none; }` was added
alongside them; any future conditionally-hidden element that also carries
a `display`-setting class needs the same explicit `[hidden]` override, not
just an `el.hidden = true` assignment.

A dedicated `TestWebAppChipStem` class (its own `create_app()`
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
only syncing the stem (via the injected `stem_transformer`) for combinations
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
defaults) and confirms `stem_transformer` is **never** called for a session
with no chip/DAC stem
at all, regardless of the transform setting — the stem-sync path only
exists to keep a stem in sync with a transform, so a stem-less session has
nothing for it to do. `TestWebAppChipStem` gained
`test_transform_syncs_stem_before_mixing` (a non-default transform makes
`ensure_render()` call the injected `stem_transformer` with `speed` and
`transpose` exactly once and feed `mix_wav()` the *synced* WAV rather
than the raw `chip_stem_path`) and
`test_default_transform_never_invokes_stem_transformer_even_with_stem` (the
regression guard: even with a real stem present, leaving speed/transpose
at their defaults must never invoke `stem_transformer` at all, so the
ordinary `chipNoise` path gains no new dependency from this feature).

Beyond the mocked unit tests, this feature was verified through a live,
fully non-mocked `create_app()` with the real `fluidsynth`/`ffmpeg`/
`rubberband` all wired in — see the dedicated verification paragraph
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

**Historical**: the original "速度・ピッチのバリエーション" feature used a WAV
post-processing endpoint. That endpoint pair no longer exists — see
"Speed/pitch is a MIDI-layer edit" above for why it was replaced by
`POST /api/variations`.
The batch-variations replacement was verified end-to-end through a live,
non-mocked `create_app()` (real `fluidsynth`; no audio-stem transform was
needed because this fixture carries no chip stem): a small real `.mid` fixture
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

The MIDI-layer speed/pitch feature (`speed`/`transpose` on `WebSession`,
`PATCH /api/session/transform`) keeps its existing end-to-end MIDI and mix
behavior. Real-audio stem synchronization is now owned by
`rubberband.transform_stem()`; its direct CLI contract, failure handling,
and cleanup are covered by `test_rubberband.py`, while the Flask tests inject
`stem_transformer` to verify the render and per-track-export paths use the
synced output only for non-default transforms. Before a release that changes
the shipped Rubber Band version, additionally run this path against a real
WAV and verify duration/pitch alignment with the transformed MIDI render.

## Project session archives

`project.py` owns the versioned `.miditrack` ZIP container. A project stores
the canonical prepared MIDI and edit-centric state only: source files and the
last successful conversion settings (when applicable), track assignment /
volume edits, transform, download filename, selected SoundFont path, and UI
render mode. It deliberately excludes render cache, WAV output, variations,
playback position, and purely presentational controls.

`POST /api/project/export` is enabled only after a MIDI is prepared. The
corresponding import endpoint extracts and validates a project into a
candidate `WebSession`, then replaces the live session only after that work
succeeds. Keep archive extraction strict: reject path traversal, symlinks,
duplicate members, malformed manifests, and archive/member size-limit
violations. Never auto-convert when loading; the stored canonical MIDI is the
authoritative base. A missing external SoundFont path must be a non-fatal
warning and fall back to the ordinary SoundFont resolution path.

## Added: `--port` (fixed port) and `--no-token` (bookmarkable URL)

`run_server()` originally always bound `make_server("127.0.0.1", 0, app, ...)`
— port `0` lets the OS pick a free port on every launch (see "Added: favorite
instrument shortlist..." above for why that already forced favorites/
SoundFont selection to be server-persisted rather than `localStorage`).
`--port PORT` (`cli.py`, threaded through `run_server(port=...)` into
`make_server()`) lets a user pin that port across launches instead — useful
for anyone who wants one stable local URL, e.g. to script against it or embed
it in another tool. `0` remains the default and still means "auto-select."
Binding failures (a port already in use, or a privileged port without
permission) are not caught here: Werkzeug's own `BaseWSGIServer.__init__`
already catches `OSError` from `server_bind()`/`server_activate()`, prints a
friendly message (including the "Port N is in use by another program..."
text for `EADDRINUSE`) to stderr, and calls `sys.exit(1)` itself — adding a
second `except OSError` in `cli.py` would be dead code, confirmed by
triggering a real `EADDRINUSE` against a second instance on the same fixed
port during implementation.

**Why fixing the port alone did not make a bookmark work — the actual
follow-up bug this section exists to document**: `create_app()` protects
every `/api/*` route behind a per-launch `launch_token`
(`secrets.token_urlsafe(32)`, regenerated on every `run_server()` call
regardless of port), checked via `secrets.compare_digest()` against
`X-Miditrack-Token` (or a `?token=` query param, `/api/audio` only, for the
`<audio>` element which cannot set headers). `app.js` reads that token from
the initial `?token=...` query string, stores it in `sessionStorage`, and
then calls `history.replaceState(null, "", window.location.pathname)` to
strip it back out of the visible URL — deliberately, so the token never sits
in browser history, a screenshot, or a shared window title. The practical
consequence: whatever URL a user bookmarks via the browser's own star/★
button is *already* token-less by the time they bookmark it, so reopening
that bookmark always hits `init()`'s "起動トークンがありません" guard —
independent of whether the port is fixed, since the token itself is still
freshly random on every launch either way. A user who instead bookmarks the
literal URL printed to the terminal (before the browser strips it) would
still lose that bookmark on the next launch, because the token changes even
when `--port` doesn't.

**Why the fix is an opt-in `--no-token` flag, not a persisted-per-port
token**: `preferences.py` already has a working "survive across launches"
mechanism (see "Added: favorite instrument shortlist..." above) and could in
principle persist a token per port the same way it persists
`selectedSoundfont` — this was considered and rejected as strictly worse
than the flag actually shipped: a persisted token sitting in
`~/Library/Application Support/miditrack/preferences.json` in plaintext is
functionally a fixed shared secret anyway (anyone who can read that file can
reconstruct a valid bookmark), so it buys no real security over just
disabling the check outright, while adding a second file-based secret to
reason about and keep in sync with the in-memory `launch_token`. The user
explicitly chose the "disable token auth" trade-off (offered alongside "keep
copying the terminal URL each launch" and "persist a token per port") when
this feature was scoped, given `miditrack` never leaves `127.0.0.1` and this
whole class of protection exists as defense-in-depth on top of the network
boundary anyway (see `POST /api/soundfont`'s own design note on this
project's "uploading a file is equivalent to running a local CLI command as
yourself" trust posture) — not for a residential Mac shared with untrusted
local users.

`create_app(..., require_token: bool = True)` is the single new switch:
`validate_local_request()`'s `/api/*` branch is gated by `and require_token`,
so with `--no-token` every route becomes reachable by any local process that
can reach `127.0.0.1:<port>` — the `127.0.0.1`-only host check and the
same-origin `Origin` check in that same function are **not** conditional on
`require_token` and remain fully in effect either way; only the
token-comparison step is skipped. `run_server(require_token=...)` threads
the CLI flag through to `create_app()`, and prints an explicit warning to
the terminal on every `--no-token` launch (`"警告: --no-token指定により..."`)
so the trade-off is visible every time, not just in `--help`.

**Why the frontend needs to learn `require_token` from the server, not just
default to "assume no token needed"**: `app.js`'s existing `init()` guard
(`if (!token) { showStatus(...); return; }`) exists specifically to fail
fast with one clear message instead of letting every subsequent `apiFetch()`
call (`loadPreferences()`, `loadSoundfonts()`, `GET /api/session`) each
independently 403 with their own toast, overwriting each other. Simply
deleting that guard would restore exactly that noisy multi-toast failure
mode for the still-default `require_token=True` case. Since `index.html` is
served as a static asset with no existing templating (`send_file()`,
predating this feature) and the CSP's `script-src 'self'` already rules out
an inline `<script>` deciding this (see "Added: 表示設定 dialog" above, same
constraint that moved the initial dark-mode detection into `app.js` itself),
the server instead does one targeted string replacement:
`index()` now reads `index.html` as text and substitutes the literal
placeholder `__MIDITRACK_TOKEN_REQUIRED__` (sitting in a
`<meta name="miditrack-token-required" content="...">` tag already in the
file) with `"true"`/`"false"` before returning it via `Response(...,
mimetype="text/html")` — a plain `<meta>` tag needs no script/style
privileges, so this costs nothing under the existing CSP. `app.js` reads
that tag once at module load (`isTokenRequired`, alongside the pre-existing
`token`/`queryToken` constants) and the `init()` guard becomes
`if (isTokenRequired && !token)`, leaving the default `require_token=True`
path completely unchanged while letting a `--no-token` launch skip the
early-return entirely — `apiFetch()` itself needed no change, since it
already just sends whatever `token` string it has (possibly `""`) and the
server no longer checks it in that mode.

Verified against a live, non-mocked `create_app()`/`run_server()` (through
`.venv/bin/miditrack`): `--port 58123` alone binds that exact port and
`/`'s response reflects `content="true"`; a plain `GET /api/session` with no
token header against that instance returns `403`, unchanged from before this
feature; `--port ... --no-token` prints the warning line, serves `/` with
`content="false"`, and the same token-less `GET /api/session` returns `200`;
`--port 99999` (out of the 0–65535 range) is rejected by `cli.py` before any
server starts; and starting a second instance on an already-bound
`--port` reproduces Werkzeug's own `EADDRINUSE` message and `exit=1`,
confirming `cli.py` needs no duplicate `except OSError` handling.

**Why this feature is also the answer to "save miditrack as a browser app"**:
`web_assets/manifest.json`'s `start_url` is the static string `"/"` — a PWA
manifest has no mechanism to interpolate a per-launch value into it, so an
installed app icon (Chrome's "Install app," Safari's "Add to Dock") always
reopens the bare `/` with no `?token=` query string, regardless of which URL
was open in the tab at install time. Before `--no-token` existed, that made
a saved app icon permanently unusable — `init()`'s token guard would fire on
every single launch from that icon, with no query string to ever satisfy it.
`--port` and `--no-token` together are the fix: a fixed port makes `/`'s
full origin predictable up front, and `--no-token` is what actually lets
that bare, tokenless `/` succeed. `--no-browser` is a third, independent
convenience for the same workflow — without it, every server launch also
pops open an ordinary browser tab in addition to whatever the user opens
from the app icon, which is redundant once the icon itself is the intended
entry point. `README.md`/`README_ja.md`'s "Saving miditrack as a browser
'app'" section documents the three flags together for this reason; none of
the three is new code beyond what's already described above — this is a
usage pattern this project's own PWA `manifest.json` (predating this
feature) already implied it would eventually need.

## Superseded: the bash launcher + browser-heartbeat design (removed)

An earlier iteration of double-click launch used a bash-script `.app`
(`~/Applications/miditrack Launcher.app`) that polled a running server with
`curl`, detected a saved Chrome/Safari PWA by scanning `Info.plist` for a
matching `start_url` (Safari's app-shim carries it under a `Manifest` key;
Chromium's under `CrAppModeShortcutURL`, confirmed against Chromium's own
`chrome/app_shim/app_mode-Info.plist` source), and relied on a 60-second
browser heartbeat (`POST /api/heartbeat`) with a 180-second grace period
(`--idle-timeout`) to shut the backend down, since a GUI launch has no
terminal to Ctrl-C. It was replaced by the WKWebView design below, whose
`applicationWillTerminate` gives an exact "the app quit" signal instead of
an approximate "no keep-alive arrived" one — the whole heartbeat mechanism,
`--idle-timeout`, and PWA detection became unnecessary. Two pieces of that
design's reasoning are still worth knowing if this ever comes up again:
`pagehide`+`sendBeacon` was considered and rejected for instant
shutdown-on-tab-close, because closing one of several open tabs fires
`pagehide` even while a sibling tab is still in active use, and because
`sendBeacon` cannot carry a custom auth header; and calling
`server.shutdown()` from *inside* a `make_server(..., threaded=True)`
request-handler thread deadlocks, because `shutdown()` waits for
`serve_forever()`'s loop to exit while that loop won't finish the current
request until the handler itself returns.

## Added: `miditrack.app` — a WKWebView shell compiled from a Swift script

`install.sh` generates `~/Applications/miditrack.app`, a normal Dock
application whose executable (`Contents/MacOS/miditrack`) is a compiled
binary — `xcrun swiftc -O` run once by `install.sh` against the tracked
`miditrack/miditrack_app.swift`, no Xcode project involved. The binary opens
a `WKWebView` window and starts the backend. Closing the window (or Cmd+Q)
quits the backend at the same instant, through
`NSApplicationDelegate.applicationWillTerminate` — replacing the entire
heartbeat-polling mechanism above with one line, since an app-quit event is
exact where a keep-alive timeout was only approximate.

**Why the source keeps its `#!/usr/bin/swift` shebang even though it's
never executed that way in production**: `xcrun swiftc -typecheck
miditrack_app.swift` still gives a `bash -n`-equivalent check (measured
0.33s), and `./miditrack_app.swift --self-test` still runs the pure-function
unit checks directly from the shebang during development, both wired into
`test_app_launcher.py`. The shebang costs nothing and keeps the file
runnable standalone for iteration; only `install.sh`'s generated bundle
compiles it ahead of time.

**Why the executable is a compiled binary, not a symlink to the shebang
script or a bash stub that execs it — the actual root cause behind two
rounds of TCC failures, found by reproducing each on a real machine rather
than guessing**: this repository's checkout lives under
`~/Library/CloudStorage/Dropbox/...`, a TCC-protected location. Two earlier
designs both failed at the point where something under that Dropbox path
got `execve()`'d as a new process image:

1. A bash stub in the bundle started `miditrack.sh --no-browser` before
   `exec`ing the Swift script. Double-clicking from Finder failed with
   `Operation not permitted`, and `log show` pinpointed it exactly:
   `(Sandbox) sandboxd rejected approval request from bash for
   kTCCServiceFileProviderDomain (.../miditrack.sh): would require prompt`.
   The working hypothesis at the time was launch-sequence *timing* — the app
   was still in `LSStoppedState`, with no AppKit event loop or foreground UI
   established yet, so TCC couldn't display its permission dialog and denied
   instead. Moving the backend launch to *after*
   `window.makeKeyAndOrderFront(nil)`/`NSApp.activate(...)` was implemented
   on that theory.
2. Separately, `Contents/MacOS/miditrack` was made a direct symlink to
   `miditrack_app.swift` so LaunchServices could exec it via its shebang.
   This failed identically, but *earlier* in the sequence — before
   `applicationDidFinishLaunching` ever ran, before any window existed to
   show: `(Sandbox) sandboxd rejected approval request from swift for
   kTCCServiceFileProviderDomain (.../miditrack_app.swift): would require
   prompt`. This is what falsified the timing hypothesis: there was no later
   point to move the access to, because the *very first* step of the
   process — the `swift` interpreter opening its own source file to compile
   it — was itself the denied access, and that source file was inside
   Dropbox.

Both failures share one shape: whatever the kernel `execve()`s as the new
process image was itself under the Dropbox path. The fix is to make sure
nothing is — `install.sh` compiles `miditrack_app.swift` to a real Mach-O
binary and places *that* under `$HOME/Applications` (not TCC-protected),
so the thing LaunchServices execs is never inside Dropbox at all. Running
the identical unsigned/compiled binary from Terminal had always worked in
every variant, because Terminal itself already holds the Dropbox grant and
inherits it into whatever it execs — which is what made the earlier
theories plausible for as long as they were only tested that way.
Confirmed on a real machine after switching to a compiled binary: the app
launches from Finder, the backend (`miditrack.sh`, itself inside Dropbox,
then the venv Python inside Dropbox) starts and serves requests
successfully, and `WKWebView` loads the token URL and completes API calls —
**the constraint only applies to the top-level process image LaunchServices
execs, not to child processes that already-running binary execs
afterward.** This is the generalizable lesson: verify a permission fix
against the actual denial (`log show`'s `kTCCServiceX ... would require
prompt`/`denied` lines, which name the exact path and requesting process),
not against a plausible-sounding theory that merely stops reproducing once
something else also changed.

**The backend-launch-timing fix (delaying `BackendController.start()` until
after the window is shown) turned out not to be the real fix, but is kept
anyway** as a defensive ordering with no real cost — `test_app_launcher.py`'s
`test_starts_the_backend_only_after_the_window_is_shown` still pins it. The
`--backend-pid`/`--backend-output` hand-off and the `set -m` job-control fix
for the bash `&`'s `SIGINT` problem belonged only to the bash-stub design and
were removed along with it once `BackendController` went back to spawning
the backend itself.

**`BackendController` therefore spawns the backend itself, via `Process()`**,
rather than watching an already-running one: `executableURL` is
`miditrack.sh` (resolved relative to `miditrack_app.swift`'s own location —
see `#filePath` below), `arguments` is `["--no-browser"]`, `standardOutput`
is a `Pipe()` whose `readabilityHandler` feeds `LineAccumulator` to find the
`miditrack Web UI: ` line, and `standardError` is a `FileHandle` opened on
`~/Library/Logs/miditrack/miditrack-app.log`. `PATH` is rebuilt in
`makeChildEnvironment()` for the same reason it always had to be rebuilt
somewhere: a process Finder/Dock launches inherits launchd's default `PATH`
(`/usr/bin:/bin:/usr/sbin:/sbin` — confirmed via `launchctl getenv PATH`
returning empty), which does **not** include `/opt/homebrew/bin`. Every
external tool this project depends on is resolved via `PATH`
(`midi2wav.sh`'s `fluidsynth`, `mix.py`'s `shutil.which("ffmpeg")`,
`rubberband.py`'s bare `"rubberband"` argv[0], `convert.py`'s
`shutil.which("node")`), so without this the server starts fine and every
render/convert/mix then fails silently with no terminal to show the error.
`test_app_launcher.py`'s `test_rebuilds_the_path_with_homebrew` is the
regression guard — this contract now lives on the Swift side, not
`install.sh`, since `install.sh` no longer generates any executable text.

**Why termination sends `SIGINT` (`process.interrupt()`), not `SIGTERM`**:
`run_server()`'s temp-directory cleanup lives in `except KeyboardInterrupt:
... finally: session.clear()`. `SIGINT` is exactly the signal a terminal's
Ctrl-C sends, so it reaches that same path; `SIGTERM`'s default disposition
kills the process before Python's `finally` block ever runs.
`BackendController.terminate()` sends `SIGINT` first, waits
`backendTerminationGraceSeconds`, then escalates to `SIGTERM` and finally
`SIGKILL` only if the process still hasn't exited — this ladder is the
safety net for a backend that's wedged, not the normal path. Because
`Process()` execs the backend directly (no shell, no `&`), the bash
job-control `SIGINT`-gets-ignored problem the earlier design had to work
around with `set -m` doesn't exist here in the first place — one more thing
that got simpler by removing the bash stub, not just by removing the
early-launch code path.

**Why `CFProcessPath` is no longer needed**: the earlier bash-stub and
symlink-shebang designs both ran the app as `/usr/bin/swift`'s process
image, so `Bundle.main` resolved to the Swift toolchain rather than the
`.app` unless `CFProcessPath` was exported first to point CoreFoundation at
the real bundle. A compiled binary living at its own
`Contents/MacOS/miditrack` doesn't have this problem — it *is* the process
image LaunchServices launched, inside the bundle it belongs to, so
`Bundle.main` should resolve correctly without any help (this specific
point wasn't re-verified after switching to a compiled binary, since the
app already builds its menu bar with an explicit `"miditrack"` string and
sets its Dock icon directly from the repository's `images/miditrack_icon.png`
— neither depends on `Bundle.main` either way, so there was nothing
user-visible left to check). The one thing that would still depend on
`Bundle.main` if it were ever wrong is `UserDefaults.standard` (used by
`setFrameAutosaveName` for window-size persistence) landing in a domain
other than `com.nihondo.miditrack` — cosmetic, not functional, if it
happens.

**Why `#filePath` locates the backend script, never
`CommandLine.arguments[0]`, and why `.resolvingSymlinksInPath()` is kept as
a defensive no-op**: `arguments[0]` becomes `"-"` when the script is fed via
stdin (measured directly), so it cannot be trusted to always be a real
path; `#filePath` is resolved at compile time — for the compiled bundle
binary, `install.sh` passes `miditrack_app.swift`'s own absolute path
(inside the repository) to `swiftc`, so `#filePath` bakes in that path
directly, and `packageDirectoryURL`/`backendScriptURL`
(`.appendingPathComponent("miditrack.sh")`)/`applicationIconURL` all resolve
correctly with no symlink involved. `.resolvingSymlinksInPath()` no longer
does real work in the shipped bundle (there is no symlink to walk back
through), but it's left in place — it's a no-op on an already-resolved path
and costs nothing, while still doing its original job if the file is ever
run through a symlink again (e.g. during development from a different
checkout layout). `test_app_launcher.py`'s
`test_resolves_symlinks_defensively` and
`test_resolves_the_backend_script_relative_to_itself` cover this.

**Why `run_server()`'s stdout is parsed for the token URL instead of
passing `--no-token`**: `run_server()` already prints exactly one line,
`miditrack Web UI: http://127.0.0.1:PORT/?token=...`, before entering
`serve_forever()`. `BackendController` connects the backend's `standardOutput`
to a `Pipe()` it owns and hands each line to `extractWebUiUrl(from:)`
(`hasPrefix` + `URL(string:)` +
`scheme == "http" && host == "127.0.0.1"`, deliberately not a regex — the
format is one fixed prefix plus a URL, not a pattern worth a parser for).
The token therefore never leaves the parent-child pipe, which is what lets
this design drop `--no-token` entirely and go back to normal per-launch
token auth — the fixed-port/`--no-token` combination the standalone-browser
workflow still documents (see "Saving miditrack as a browser app" in the
root README) was only ever needed because a bookmarked URL or PWA icon has
no way to carry a fresh token; a self-hosting shell that reads the token
itself has no such constraint. This is also why the port went back to
automatic (`0`) — fixing it at 51888 existed solely so an external browser
bookmark/PWA could target a stable URL, which no longer applies here.

**The four things a bare `WKWebView` silently breaks, and why each needs an
explicit delegate method** (none of these fail loudly — they just stop
working, which is why `MiditrackWebDelegate` implements all four):
downloads (`app.js`'s `anchor.download`/blob pattern needs
`WKNavigationDelegate` to recognize `shouldPerformDownload` and hand off to
`WKDownloadDelegate`, whose `decideDestinationUsing` opens an `NSSavePanel`
so downloads still prompt for a save location the way a browser's "Save
As" would); file selection (`<input type="file">` needs
`WKUIDelegate.runOpenPanelWith` to show an `NSOpenPanel` at all — Safari and
Chrome do this automatically, a bare `WKWebView` does not); `window.confirm()`
(the preset-delete and session-replace flows in `app.js` depend on it —
needs `runJavaScriptConfirmPanelWithMessage`); and every keyboard shortcut
including Cmd+Q (a `WKWebView` window has no menu bar unless the app builds
one itself — `installMainMenu()` constructs Application/Edit/View/Window
menus with the standard `#selector` bindings by hand).

**`CFBundleIdentifier` is now `com.nihondo.miditrack`** (dropped the
`.launcher` suffix along with the rename from "miditrack Launcher" back to
"miditrack" — the name collision with a Safari-saved PWA that motivated the
old split no longer applies now that the Dock app is a full replacement for
a browser tab, not a thing meant to coexist with one). This identifier must
not change again once users have it pinned to their Dock, for the same
LaunchServices-stable-key reason as before. A user who separately saves
miditrack as a PWA via Safari's "Add to Dock" should still give it a name
other than "miditrack", since Safari places saved apps directly under
`~/Applications/` — the same directory `install.sh` uses — and
`validate_app_bundle()`'s marker check will refuse to overwrite a bundle it
didn't create rather than silently clobbering either one.

**Why `install_app_bundle()` signs the bundle ad hoc
(`codesign --force --deep --sign -`), reversing an earlier decision not to
sign at all — and why signing alone turned out not to be the real fix**:
this repository's checkout lives under `~/Library/CloudStorage/Dropbox/...`,
a TCC-protected location (the same category as Desktop/Documents/Downloads/
iCloud Drive). The first hypothesis, when the unsigned bundle failed with
`Operation not permitted` execing `miditrack.sh` from Finder, was that TCC
couldn't stably identify an unsigned app across launches and so denied
without prompting. Ad hoc signing was added on that theory — and the
earlier "no signature" decision was never about TCC in the first place, it
was about Gatekeeper's quarantine check (still correct: a locally-built
bundle never acquires `com.apple.quarantine`, so Gatekeeper's own
verification never runs against it regardless of signing; quarantine and
TCC are different subsystems). Signing the bundle did **not** fix the
failure — a second real-machine test after signing reproduced the identical
`Operation not permitted`, with the actual permission-grant UI (System
Settings → Privacy & Security → Files and Folders) never even listing
`miditrack`. The real cause, found afterward via `log show` across two more
rounds of failures, was that whatever `execve()`'d as the process image was
itself under the Dropbox path — not a timing or identity problem at all —
see "Why the executable is a compiled binary" above for the actual fix. Ad
hoc signing is kept anyway because it's independently good practice for a
bundle whose
identity should stay stable across `install.sh` re-runs (no Apple Developer
ID or network access needed, just a local `CDHash`), but it is not sufficient
on its own for any future TCC-gated resource this app might touch — the
lesson generalizes: verify a fix against the actual failure (`log show`'s
`kTCCServiceX ... would require prompt`/`denied` lines), don't stop at the
first plausible-sounding theory. It must be re-applied on every `install.sh`
run since it re-signs the bundle's contents each time (`codesign` errors are
swallowed with `|| true` rather than failing the whole install, since a
`codesign`-less environment — unlikely given the earlier Xcode Command Line
Tools check, but not impossible — should still produce a working bundle
rather than blocking setup entirely).

## Added: menu integration between `miditrack.app` and the Web UI

The WKWebView shell above gave `miditrack.app` a Dock presence and window
lifecycle, but its menu bar (`installMainMenu()`) still only covered
AppKit-native concerns (About/Hide/Quit, Edit, native fullscreen, Window).
Every actual app feature — opening a file, changing display settings,
downloading MIDI/WAV/a project — still required reaching into the WebView
and clicking a button, with no menu or keyboard-shortcut path at all. This
feature wires the existing Web UI controls up to native menu items instead
of duplicating their logic in Swift.

**Why `window.__miditrackNative` is injected via `WKUserScript` at
`.atDocumentStart`, not `customUserAgent`**: `index.html` is served with a
strict CSP (`script-src 'self'`, see "Added: 表示設定 dialog" above for why
this already ruled out an inline `<head>` script for the dark-mode-flash
fix), which blocks an inline flag-setting `<script>` but has no effect on a
`WKUserScript` the *native host* injects — it runs before any page script,
including the CSP-governed ones, and needs no server-side cooperation.
Rewriting `customUserAgent` to append a marker string was considered and
rejected: `app.js` has no existing UA-sniffing code path to extend, and a UA
string is a much broader surface (affecting any future third-party
JS/analytics that reads it) for what is otherwise a single boolean flag.
`makeWebView()`'s `WKUserScript` sets exactly `window.__miditrackNative =
true` and nothing else, so `app.js`'s `isNativeApp` constant
(`window.__miditrackNative === true`, defined next to the existing
`isTokenRequired` constant near the top of the file) is a plain equality
check with no parsing.

**Why full-screen (DAW layout) is force-applied in two places, not one**:
`setupFullscreenLayout()` registers the `#fullscreen-toggle` click listener
and the Escape-key handler — the only two ways a user can *change* display
mode — so gating both behind `if (isNativeApp) { toggle.hidden = true;
return; }` removes the toggle mechanism entirely for a native launch. But
the actual mode is *applied* at startup from `loadPreferences()`
(`setFullscreenLayout(isNativeApp || state.displayMode === "fullscreen")`),
not from `init()`'s earlier setup calls — `state.displayMode` is whatever
`preferences.json` last saved from a **browser** session, and could easily
be `"normal"`. Without this second change, a native launch would render in
whatever mode a previous browser session left behind, only becoming
unchangeable (correct, but wrong initial state) rather than being fixed to
full-screen from the first paint. Neither call passes `shouldPersist:
true`, so a native launch never overwrites the browser's own saved
`displayMode` preference — this mirrors the existing "startup application
never persists" behavior `loadPreferences()`'s call already had before this
feature (see `setFullscreenLayout()`'s own `shouldPersist` parameter).

**Why `#fullscreen-toggle[hidden] { display: none; }` had to be added to
`app.css`**: `.button`'s `display: inline-flex` and the browser's default
`[hidden] { display: none }` UA rule are the same specificity (one class
selector vs. one attribute selector), so author CSS wins by cascade order
and `toggle.hidden = true` alone would leave the button visually unchanged
— the identical trap already documented for `.convert-field.is-checkbox`
under "Added: per-track WAV export" above. The fix is the same: an explicit
`#fullscreen-toggle[hidden]` override.

**Why the menu actions are `evaluateJavaScript()` one-liners that click an
existing button, not reimplementations of open/save/settings in Swift**:
every one of these actions already has a fully working, validated,
state-aware implementation in `app.js` — `#open-dialog-button` opens the
upload/conversion modal, `#settings-open` opens the display-settings
dialog, `#download-button`/`#download-wav-button`/`#save-project-button`
each already check `state.session.hasDownload`/disabled state before doing
anything. `clickWebViewElement(_ selector:)` is a single private helper
(`webView?.evaluateJavaScript("document.querySelector('\(selector)')?.click();")`)
that every menu action calls with its own CSS selector — reusing this logic
avoids a second, Swift-side implementation of state that would inevitably
drift from the Web UI's own (e.g. if a future edit changes when the
download buttons become enabled).

**Why the save menu items are always enabled, with no
`WKScriptMessageHandler` syncing `hasDownload` back to Swift**: a disabled
HTML button's `.click()` is a no-op — the browser itself refuses to dispatch
the click, so `evaluateJavaScript()` silently does nothing rather than
erroring. This was confirmed to be acceptable scope for this feature (a
user clicking "MIDIを保存…" before loading a file sees nothing happen,
rather than a grayed-out menu item) rather than building a live state sync
between the WebView's DOM and `NSMenuItem.isEnabled`. `installMainMenu()`
now takes a `target: AnyObject` parameter threaded through
`makeApplicationMenu()`/`makeFileMenu()`, and every action's `NSMenuItem`
sets `.target` explicitly to `MiditrackAppDelegate` itself rather than
leaving it `nil` (which would dispatch through the responder chain).
`MiditrackAppDelegate` is `NSObject`-derived but not `NSResponder`, so
AppKit's automatic menu-item validation (`validateMenuItem:`, which would
otherwise disable an item whose target doesn't currently implement/enable
its action) never applies to these items — they read as permanently enabled
by construction, matching the "always enabled" decision without any extra
code.

**Why the save items are flat top-level items in "ファイル", not grouped in
a "保存" submenu**: the first implementation grouped the three save actions
(MIDI/WAV/project) under a "保存" submenu, the way a conventional macOS
app's File > Save/Export submenu would. The user asked for them flattened
instead — one extra level of menu navigation for three items that are each
reached often enough (each round-trips through the toolbar's own visible
download buttons) that a submenu's added click was judged not worth it.
`makeFileMenu()` now adds "ファイルを開く…" and all three save items
directly to the "ファイル" `NSMenu`, separated by one `.separator()`.
Variation-ZIP and per-track-ZIP exports remain deliberately out of scope
(confirmed with the user during planning) — both stay browser-only actions
reached through the existing `<details>` disclosure in the Web UI, since
neither has a single obvious default output the way MIDI/WAV/project do.

**Why every menu item this feature added carries an SF Symbols icon, via
one shared `addTargetedMenuItem()` helper**: the user asked for icons on
"開く"/"設定…" and the three save items specifically (the pre-existing
AppKit-native items — About/Hide/Quit/Edit/View/Window — were left alone,
matching how sparse icon use already looks in this app's own menu bar
before this change). `addTargetedMenuItem(to:title:action:keyEquivalent:
target:symbolName:)` replaces the previous `menu.addItem(...).target =
target` two-step pattern with one call that also sets `.image =
NSImage(systemSymbolName:accessibilityDescription:)` — this keeps the
"target the AppDelegate directly" invariant from the paragraph above in
one place rather than repeating it five times. Symbol choices:
"ファイルを開く…" → `folder`; "設定…" → `gearshape`; "MIDIを保存…" →
`pianokeys` (a literal piano-keyboard glyph, the most on-the-nose choice
available for a MIDI export); "WAVを保存…" → `waveform`; "プロジェクトを
保存…" → `doc.zipper`, matching that the `.miditrack` archive really is a
ZIP container (see "Project session archives" above) rather than a plain
document — none of these five names are guessed; all are checked against
this app's own `LSMinimumSystemVersion` (13.0, `install.sh`), which ships
with an SF Symbols catalog new enough to include all five (`pianokeys` and
`doc.zipper` are the newest of the five and only need SF Symbols
2-and-3-era coverage, well under macOS 13's baseline) — no
`#available`/nil-fallback guard was added because of this.

**Why Cmd+S is bound to "プロジェクトを保存…", not "MIDIを保存…"**: of the
three, only "プロジェクトを保存…" (`#save-project-button`, `POST
/api/project/export`) round-trips the full editing session — assignments,
volumes, transform, download filename, selected SoundFont — through the
`.miditrack` archive format described under "Project session archives"
above. MIDI/WAV are one-way rendered exports. Cmd+S conventionally means
"save my work so I can resume it," which matches the project archive, not
either export.

**Why "WAVを保存…" alone additionally gets Cmd+E**: `E` for "Export" has
precedent in Apple's own apps (classic iMovie's Share/Export shortcut) and
fits this app's own "MIDI/WAV are one-way rendered exports, not round-trip
saves" distinction from the paragraph above better than a bare "save"
mnemonic would. It does not collide with any existing menu binding in this
app (`o`/`q`/`h`/`⌥h`/`z`/`⇧z`/`x`/`c`/`v`/`a`/`r`/`⌃f`/`m`/`w`/`,`/`s`) or
with the app's own functionality — Safari/TextEdit's unrelated "Use
Selection for Find" convention for the same key has no equivalent feature
in this app to conflict with. "MIDIを保存…" was deliberately left without a
shortcut: giving every save-menu item a binding was not requested, and MIDI
export's own natural mnemonic (`M`) is already the parent "ファイル" menu's
underlying access-key territory, not worth reserving without a concrete
need.

`tests/test_app_launcher.py`'s `TestSwiftLauncherContract` gained five
string-literal contract tests matching this file's existing style
(`test_injects_the_native_app_flag`, `test_has_a_file_menu_with_open_and_save`,
`test_has_a_settings_menu_item`, `test_menu_actions_target_the_app_delegate`,
`test_menu_items_have_sf_symbols_icons`) — `clickWebViewElement()` itself is
not covered by `--self-test`'s pure-function checks (it depends on a live
`WKWebView`, unavailable without a GUI), so these string checks are the only
automated guard for the menu wiring; end-to-end behavior (menu clicks
actually opening dialogs/dialogs prompting for a save location, the flat
"ファイル" menu layout, the five icons actually rendering, and the
browser-launched path keeping its toggle and Escape behavior intact) was
verified by hand against the compiled `~/Applications/miditrack.app`.

## Fixed: `images/miditrack_icon.png` had no padding, so macOS added its own border

The Dock icon showed a visible light bezel/frame wrapped around the note
artwork that nothing in this repository's own pipeline drew. `install.sh`'s
icon-generation function (`sips -z <size> <size> ... --out ...` per iconset
slot, then `iconutil --convert icns`) is a pure per-size resize with no
compositing step, and pixel-sampling the original source PNG directly
(`magick images/miditrack_icon.png -format "%[pixel:p{x,y}]" info:` at
several coordinates) confirmed no light-colored pixels existed near its
edges either — so neither the pipeline nor the source artwork's own pixels
were drawing the border. The actual cause was the source image's geometry:
`magick ... -trim -format "%wx%h%O"` showed the opaque content occupied
1222×1254 of the 1254×1254 canvas — 0px of padding top/bottom and ~16px
left/right — while the artwork was already pre-masked into a rounded-rect
alpha shape (confirmed by sampling along the corner diagonal: alpha stayed
`0` out to roughly 100-150px before becoming opaque, i.e. a real corner
radius, not merely a few anti-aliased pixels). macOS's own icon-consistency
enforcement (post-Big Sur; this app's `LSMinimumSystemVersion` is 13.0)
re-masks and adds a synthetic stroke/backplate/highlight to any icon that
doesn't already match Apple's expected squircle-plus-padding template —
which is exactly the frame visible in the Dock, added by the OS at render
time, not by anything checked into this repository.

The fix was a one-time asset edit, not a build-time transform in
`install.sh`: adding padding on every `install.sh` run would make the
padding amount a hidden, hard-to-preview parameter baked into a shell
script, when it is really a visual design choice that benefits from
being inspected once, as a file, before being committed. `images/
miditrack_icon.png` was regenerated with `magick images/miditrack_icon.png
-resize 824x824 -background none -gravity center -extent 1024x1024
<output>` — shrinking the *existing*, unmodified artwork (rounded shape,
colors, and all) to 824×824 and centering it on a new fully-transparent
1024×1024 canvas. 824-of-1024 (~80%, ~100px margin per side) is the
widely-cited Apple Big Sur+ icon-template content ratio; this reuses the
original art byte-for-byte at a smaller scale rather than redrawing or
re-cropping it, so the shape/colors are unchanged, only the amount of
transparent breathing room around them. The result was visually confirmed
(`Read`ing the generated PNG directly, since this environment can render
image files) before being copied over the tracked file. `install.sh`,
`miditrack_app.swift`'s `applicationIconURL`, and every existing
`test_install.py`/`test_app_launcher.py` assertion reference this same
path unchanged — the fix needed no code change anywhere, only a new PNG
committed in place of the old one. Re-run `install.sh` to regenerate
`~/Applications/miditrack.app`'s `.icns` from the updated source.
