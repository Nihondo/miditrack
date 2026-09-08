# CLAUDE.md

Current engineering contracts for `miditrack`. Keep this file concise and
current: record durable architecture, safety, and verification rules here;
record change history, investigations, and one-off measurements in
`handoff.md` instead.

## Scope and documentation

`miditrack` is a local Flask application with a vanilla JavaScript/CSS client.
It accepts MIDI and supported chiptune sources, invokes the bundled
`nsf2midi`, `spc2midi`, or `vgm2midi` converter, lets the user edit General
MIDI assignments and volume, and renders locally. It does not alter converter
semantics or implement the unrelated publishing pipeline.

- Root `README.md` and `README_ja.md` are aligned end-user manuals. Update both
  for user-visible changes.
- `miditrack/README.md` and `README_ja.md` are contributor guides. Keep their
  setup and verification commands accurate.
- This file is an English maintainer contract. Converter option details belong
  in the corresponding converter documentation.

## Repository shape

```text
miditrack.sh                 Stable launcher; supports checkout and app bundle modes.
miditrack_app.swift          Native WKWebView shell.
midi2wav.sh                  FluidSynth wrapper.
src/miditrack/
  cli.py                     CLI and server startup.
  web.py                     Backward-compatible public import facade.
  web_routes.py              Flask composition, routes, render/export workflows.
  web_session.py             Mutable session state and JSON payload serialization.
  web_*_service.py           Source, session, and project workflows.
  runtime_dependencies.py    Production/test boundary for external operations.
  convert.py                 Source detection, safe converter invocation, ZIP/M3U handling.
  midi.py, pianoroll.py      MIDI analysis/editing and read-only piano-roll extraction.
  render_service.py          Render caches, generations, and prewarm coordination.
  render.py, mix.py          SoundFont rendering and ffmpeg mixing.
  rubberband.py              Speed/pitch synchronization for real-audio stems.
  libvgm.py, nsf_chip.py     VGM/NSF sidecar validation and hardware rendering.
  preferences.py             Durable local preferences.
  web_assets/                HTML, CSS, app bootstrap, and dependency-free ES modules.
tests/                       Python and Node tests.
```

`web.py` is a compatibility facade only. Keep application logic in the focused
modules above. `web_routes.py` composes services and handles HTTP concerns;
route functions should validate input, call a service/workflow, and form the
response rather than absorb business logic.

## Ownership and state

- `WebSession` owns one browser session's mutable source, MIDI, edit, and
  generated-artifact state. Its `clear()`/`reset_midi_state()` lifecycle must
  remove stale derivatives before replacing source data.
- `SessionService`, `SourceService`, and `ProjectService` respectively own
  validated edits, source ingestion/conversion, and `.miditrack` archive
  transactions. Preserve that separation.
- `RenderService` is the only owner of full/preview WAV LRUs, active audio
  generations, and retry-on-revision-change coordination. Other services must
  not create or retain render-cache entries.
- `RuntimeDependencies` is the test seam for renderer, converter, lister,
  mixer, and hardware renderers. Preserve dependency injection when changing
  external-process boundaries.
- The process is threaded. Per-request state belongs in request-local values
  (not `WebSession`); durable user preferences are process-wide but not session
  state.

## Source conversion contract

`convert.py` is the only bridge to converter CLIs.

- Detect source formats from the supported extension set; do not infer from
  untrusted file contents alone.
- Resolve tools in this order: explicit `*_BIN` override, known bundled path,
  then only the documented PATH fallback. A configured but unusable override
  is an error, never a silent fallback.
- Invoke all tools with argv arrays and `shell=False`. Preserve timeouts and
  include a bounded stderr tail in user-facing failures.
- NSF and VGM always request their track-metadata sidecar. `libvgm.py` and
  `nsf_chip.py` validate those sidecars before exposing `game` track sources.
  SPC uses its generated SoundFont as its original-instrument path.
- `SourceService` must analyze the generated MIDI before committing it to the
  session. A successful subprocess with missing or empty output is failure.
- ZIP extraction remains size-limited and zip-slip guarded. Ignore hidden
  archive members. M3U parsing stays format-specific and does not give an
  archive arbitrary filesystem access.
- User-visible conversion options come only from `convert.option_schema()` and
  are server-validated by `validate_convert_options()`. The client may render
  that schema but is not authoritative.

## MIDI, piano roll, and track editing

- `midi.py` is the source of truth for track analysis, program changes,
  velocity-derived volume, speed, and transpose. Apply edits from the original
  MIDI, not from an already edited derivative, so repeated application is
  idempotent.
- Keep format-specific track semantics in converter sidecars rather than
  guessing from track names. A hardware source can only be selected for a
  validated mapped target.
- `GET /api/pianoroll` reads `WebSession.original_path` and applies only the
  analytical speed/transpose transform. It must not depend on rendering,
  assignments, volume, selected source, or SoundFont, so it remains available
  before rendering and after render invalidation.
- Tempo is global across MIDI tracks; note pairing remains track-local. Keep
  piano-roll output bounded and use its compact documented response schema.
- Browser modules keep state local to the client. Do not introduce a framework
  or CDN dependency without an explicit product decision.

## Rendering and audio

- Render only after applying the current assignment/volume/transform state to
  a fresh MIDI derivative. Rendering is offline; there is no live softsynth.
- `render.py` resolves `MIDI2WAV_BIN`, then package-local `midi2wav.sh`, then
  PATH. It passes an explicit sample rate on every render.
- VGM/NSF `game` sources are physical-chip render selections; SPC `game` is a
  generated SoundFont selection. Keep these meanings distinct when splitting
  render jobs and mixing outputs.
- `rubberband.py` keeps real-audio stems synchronized with MIDI speed/pitch;
  validation of those transforms stays in `midi.py`.
- `mix.py` alone constructs ffmpeg mix/gain argv. Resample all inputs to the
  selected render rate before mixing.
- Render IDs are monotonic. An old audio URL with a known ID must retain its
  corresponding artifact until cache eviction; an unknown ID must not resolve
  to unrelated audio.
- Preview rendering may use a separate cache and worker budget, but must never
  make an old revision active after the session changed.

## Preferences, projects, and exports

- `preferences.py` writes optional, loss-tolerant state to
  `~/Library/Application Support/miditrack/preferences.json`; tests override
  this with `MIDITRACK_PREFERENCES_PATH`. Missing or malformed data falls back
  safely.
- Preferences are partial updates. Validate every supplied field and preserve
  other valid stored fields.
- `.miditrack` import is staged and validated before it replaces the active
  session. Archive names and members must remain path-safe.
- Download names are sanitized stems, never user-controlled paths. Per-track
  and variation archives must be generated inside the session root.

## Local security boundary

- The server binds locally and uses a launch-scoped token. Keep host/origin,
  CSP, content-type, and token protections on every API route.
- Multipart uploads and `/api/open-local` are local-user inputs, not trusted
  paths. Enforce extension, size, containment, regular-file, and symlink
  checks before delegation.
- `/api/open-local` is enabled only for the native app's staging directory;
  never turn it into a general filesystem-read API.
- Do not expose shell command strings, arbitrary output paths, or unvalidated
  sidecar data through HTTP.

## Localization and native shell

- Japanese is the stable message ID. `i18n.py` uses the English catalog with a
  Japanese fallback; client strings use the same convention. Keep catalog keys
  and placeholders synchronized with code and marked HTML attributes.
- Resolve language per request, not through mutable session or global state.
  Static HTML is localized server-side so first paint matches dynamic UI.
- The Swift shell owns Finder/Dock integration and security-scoped source
  access. It stages files before calling `/api/open-local`; the backend reads
  only that staging directory.
- The native menu is built at launch. A Web UI language change takes effect in
  that menu on the next app launch.

## Installation, bundle, and release invariants

- `scripts/install.sh` is self-contained and idempotent. It creates the
  package-local `.venv`, installs required tools individually, verifies PATH,
  and must not download, link, or bundle a SoundFont.
- The launcher must preserve the caller's working directory and support both a
  checkout and the packaged backend. Do not add a system-Python fallback.
- The installer may update only the command/link and app bundle it created; it
  must refuse unrelated existing targets.
- The app builder compiles `miditrack_app.swift` ahead of time and updates its
  generated bundle files in place. Do not replace it with a source symlink.
- `scripts/sign_macho_bundle.sh` owns the nested-Mach-O signing walk. Only the
  bundled Node runtime receives V8 entitlements; release signing additionally
  enables hardened-runtime timestamps.
- Notarization is opt-in. `release_app.sh` without `--notarize` builds/signs
  only and must not submit anything to Apple.

## Testing

Run the ordinary suite from this directory:

```bash
PYTHONPATH=src .venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m compileall -q src tests
bash -n miditrack.sh midi2wav.sh
xcrun swiftc -typecheck miditrack_app.swift
```

For renderer, wrapper, bundle, or release changes also run the relevant checks:

```bash
miditrack/midi2wav.sh --help
scripts/build_app_bundle.sh --output /tmp/miditrack.app
codesign --verify --deep --strict /tmp/miditrack.app
scripts/release_app.sh
```

Build and test affected converters at their own boundaries:

```bash
make -C nsf2midi test
./build.sh                 # from spc2midi/
npm test                   # from vgm2midi/
```

`tests/test_real_corpus.py` is an opt-in integration acceptance test. When the
git-ignored `testdata/real-corpus/` exists, normal discovery runs it; otherwise
it skips. It verifies SHA-256-pinned VGM/VGZ, NSF, and SPC data through
`POST /api/source` and `POST /api/source/convert`, including MIDI analysis,
VGM/NSF sidecars, SPC SoundFont handoff, and a real VGM in a ZIP container.
Populate the corpus only through:

```bash
python3 scripts/sync_real_corpus.py --source /path/to/source-collection
```

Set `MIDITRACK_REAL_CORPUS_ROOT` to test another local corpus root. Music data
must never be committed or required by CI.

Run `git diff --check` before handoff. Update this file only for a changed
current contract; put rationale and historical narrative in `handoff.md`.
