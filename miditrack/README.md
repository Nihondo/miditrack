# miditrack development guide

This document is for contributors and maintainers of the `miditrack` package. For installation, browser workflows, supported formats, and command-line examples, use the repository's [user manual](../README.md) ([Japanese](../README_ja.md)).

## Scope and documentation ownership

`miditrack` is a local Flask application that converts supported chiptune files through bundled converter CLIs, lets users edit the resulting MIDI, and renders audio locally.

- `../README.md` and `../README_ja.md` are the end-user manuals. Keep their structure and practical behaviour in sync.
- This README records contributor setup, architecture, runtime contracts, and verification commands.
- `CLAUDE.md` records detailed implementation history, invariants, and design rationale. Update it when a developer-facing contract changes.
- Each converter owns its own README and CLAUDE.md. Do not duplicate its option reference here.

## Development setup

```bash
cd miditrack
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -e .
```

Run the application through the wrapper:

```bash
./miditrack.sh --no-browser
```

The wrapper resolves its own location, always uses this package's `.venv`, preserves the caller's working directory, and forwards all arguments. Do not replace it with an implicit system-Python fallback.

### External tools for local development

| Need | Command or dependency |
|---|---|
| SoundFont rendering | `brew install fluid-synth` and an `.sf2`/`.sf3` SoundFont |
| Real-audio stem mixing and per-track export | `brew install ffmpeg` |
| Speed/pitch changes for real-audio stems | `brew install rubberband` |
| Original VGM sound | `cd ../vgm2midi && ./scripts/build-native.sh` |

Set `MIDI2WAV_SOUNDFONT` to override SoundFont discovery. The optional `VGM2MIDI_STEMS_HELPER` override points to a non-default VGM native helper. The user manual documents normal SoundFont locations; preserve that list when changing discovery behaviour.

## Architecture

```text
miditrack/
  miditrack.sh             stable launcher for the package virtual environment
  midi2wav.sh              FluidSynth wrapper used by the renderer
  src/miditrack/
    cli.py                 CLI parsing and server startup
    web.py                 Flask routes, sessions, request validation
    convert.py             bundled converter resolution and source conversion
    render.py              MIDI-to-WAV rendering and SoundFont discovery
    rubberband.py          direct real-audio stem speed/pitch synchronization
    midi.py                MIDI analysis and editing
    pianoroll.py           read-only piano-roll data extraction
    project.py             .miditrack archive serialization
    preferences.py         persisted local preferences
    static/                browser client assets
  tests/                   Python test suite
```

The browser client is intentionally a thin local front end. MIDI edits and render decisions remain server-side, and rendered assets are session-scoped temporary files.

## Runtime contracts

### Converter boundary

`convert.py` invokes the bundled `nsf2midi`, `spc2midi`, and `vgm2midi` executables with explicit argv lists. The converters produce MIDI (and their format-specific sidecars); they must not be asked to render generic SoundFont WAV files. `miditrack` owns the subsequent render through `midi2wav.sh`.

Converter lookup accepts these explicit executable overrides:

- `NSF2MIDI_BIN`
- `SPC2MIDI_BIN`
- `VGM2MIDI_BIN`

An override that is set but unusable must fail clearly rather than silently falling back to another executable.

### Audio rendering boundary

`render.resolve_midi2wav_bin()` resolves the renderer in this order:

1. `MIDI2WAV_BIN`, if executable.
2. Package-local `miditrack/midi2wav.sh`.
3. `midi2wav` on `PATH`.

`render.py`, `convert.py`, and `rubberband.py` must pass argv arrays to subprocesses with no shell. Repository paths may contain spaces or shell metacharacters.

`midi2wav.sh` derives the repository root from its own path so its bundled SoundFont directory remains `<repository>/soundfonts` after the script's move into `miditrack/`.

### Local security model

The server binds locally and uses a launch-scoped token for API requests. Treat uploads as local-user inputs, but keep ZIP extraction limits and path validation intact. Do not expose a route that allows arbitrary filesystem reads or a shell command string.

## Verification

Run the Python suite from the repository root:

```bash
miditrack/.venv/bin/python -m pytest -q miditrack/tests
```

Before submitting a renderer or wrapper change, also check:

```bash
bash -n miditrack/midi2wav.sh
miditrack/midi2wav.sh --help
```

When a change crosses a converter boundary, build and test the affected converter as well:

```bash
make -C nsf2midi test
./build.sh                 # from spc2midi/
npm test                   # from vgm2midi/
```

Run `git diff --check` before handoff. When changing user-visible behaviour, update the root English and Japanese manuals together, then verify their headings, examples, and option tables remain aligned.

## Useful implementation references

- [CLAUDE.md](CLAUDE.md): detailed design history and implementation invariants.
- [../README.md](../README.md): user-facing workflow and troubleshooting.
- [../nsf2midi/README.md](../nsf2midi/README.md), [../spc2midi/README.md](../spc2midi/README.md), and [../vgm2midi/README.md](../vgm2midi/README.md): converter-specific manuals.

## License

MIT
