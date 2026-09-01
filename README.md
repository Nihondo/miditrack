# miditrack

Turn chiptune music — NES (`.nsf`/`.nsfe`), SNES (`.spc`/`.spc2`/`.rsn`), or VGM (`.vgm`/`.vgz`) — into editable MIDI and listen to the result in your browser. Everyday use needs no terminal after the one-time setup.

`miditrack` runs only on your Mac. Your source files, MIDI, and rendered audio stay local.

## Quick Start

1. On an Apple Silicon Mac, clone or download this repository and enter its directory.

   ```bash
   git clone https://github.com/Nihondo/miditrack.git
   cd miditrack
   ```

2. Run the installer. It installs Python, FluidSynth, Node.js, ffmpeg, Rubber Band, the Python virtual environment, and the VGM runtime dependencies.

   ```bash
   ./install.sh
   ```

3. FluidSynth's standard SoundFont is used immediately for auditioning and WAV export. To use a custom General MIDI SoundFont (`.sf2`/`.sf3`), place it in `soundfonts/`.

   ```bash
   mkdir -p soundfonts
   cp /path/to/GeneralMIDI.sf2 soundfonts/
   ```

4. The installer creates `/opt/homebrew/bin/miditrack`. Start the app from any directory:

   ```bash
   miditrack
   ```

5. Drop a supported source file or a `.mid` file onto the upload area, edit it, audition it, then download MIDI or WAV.

## What You Can Do

- Convert NES, SNES, and VGM/VGZ source files to MIDI. NSF/SPC files with multiple songs offer a song picker.
- Upload several source files, a `.zip` rip pack, or a source file with its `.m3u` playlist. A playlist can supply song titles.
- Reassign General MIDI instruments, set per-track volume or mute, sort the track list, and save favourite instruments and ensemble presets locally.
- Choose **SoundFont** or **Original game sound** for supported tracks. Original sound uses the relevant game SoundFont or chip renderer; SoundFont uses the GM bank you selected.
- Inspect notes in a zoomable piano roll, seek and loop playback, choose a colour/theme/layout preference, and switch to the full-screen editing layout.
- Change the complete song's speed and pitch, save and reopen a `.miditrack` project, and download an edited MIDI or final-quality WAV.
- Generate a ZIP of speed/pitch variations, or export a ZIP containing one WAV per track.

## The Toolkit

| Tool | Purpose | Typical use |
|---|---|---|
| **miditrack** | Browser-based conversion, editing, auditioning, and export | Recommended for everyday work |
| **nsf2midi** | NES/Famicom `.nsf`/`.nsfe` to MIDI | Direct CLI or bundled conversion |
| **spc2midi** | SNES `.spc`/`.spc2`/`.rsn` to MIDI and optional game SoundFont | Direct CLI or bundled conversion |
| **vgm2midi** | VGM/VGZ command logs to MIDI | Direct CLI or bundled conversion |
| **miditrack/midi2wav.sh** | MIDI to WAV through FluidSynth | Used by miditrack or directly from a terminal |

## Requirements

- Apple Silicon Mac, [Homebrew](https://brew.sh/), and an internet connection for the initial package download
- Run `./install.sh` to install Python 3.10+, [FluidSynth](https://www.fluidsynth.org/), Node.js, ffmpeg, and Rubber Band, then create the required Python and Node.js environments
- FluidSynth's standard General MIDI SoundFont is used initially. To add a custom `.sf2`/`.sf3`, place it in `<repository>/soundfonts` (create that directory if it does not exist), or use another supported search directory:
  - `<repository>/soundfonts`
  - `~/Library/Audio/Sounds/Banks`
  - `/opt/homebrew/share/soundfonts`
  - `/Library/Audio/Sounds/Banks`
  - `/opt/homebrew/share/fluid-synth/sf2`

The installer processes Homebrew formulae one at a time. If a formula conflicts with an existing same-named formula from another tap, Homebrew's error remains visible and setup continues. It stops only if the required command is unavailable on `PATH` afterward.

The converter binaries and the Apple Silicon native helper for Original VGM sound are bundled, so ordinary source conversion and Original VGM sound need no build step. ffmpeg and Rubber Band are included in the standard installer for real-audio stem mixing, per-track export, and speed/pitch changes. To rebuild the VGM helper after changing its source, install CMake and Ninja, then run `vgm2midi/scripts/build-native.sh`. Intel Macs need an Intel or Universal helper binary.

## Using miditrack

### Start from MIDI

1. Upload or drag a `.mid`/`.midi` file.
2. Select an instrument, volume, mute state, and (when offered) SoundFont or Original game sound for each track.
3. Pick a SoundFont and **Fast** (22.05 kHz) or **Quality** (44.1 kHz) auditioning. Quality matches WAV download.
4. Use the speed and transpose controls when needed. They affect every subsequent render and download.
5. Use the piano roll to inspect, seek, and define a playback loop. Display settings change only the view and are remembered.
6. Download MIDI or WAV. The WAV download always uses the 44.1 kHz quality render.

Use **Save project** to download a `.miditrack` archive containing the editable MIDI, the source and conversion settings when available, and the saved editing state (track choices, speed/pitch, filename, loop, and preset). **Open project** restores that state without reconverting the source. Rendered audio and generated ZIPs are deliberately not stored in a project.

### Start from a source file

1. Upload one source file, several files, a source file plus `.m3u`, or a `.zip` archive. ZIP uploads allow up to 200 files and 512 MiB after extraction.
2. Choose a file when the upload contains several convertible sources, then choose a song when the format provides several.
3. Choose conversion settings:
   - NSF: duration and optional PAL timing
   - SPC: loop count
   - VGM: loop count or duration, plus optional OPN Ch3 Special percussion conversion
4. **Original game sound by default** is only an initial selection. You can still change any supported track after conversion.
5. Select **Convert to MIDI**, then edit and export as for an uploaded MIDI file.

### SoundFont and Original game sound

- **SoundFont** plays the MIDI through your selected General MIDI SoundFont, so instrument changes apply.
- **Original game sound** uses a game-derived SoundFont for SPC or hardware/chip rendering for NSF and VGM. Instrument selection is unavailable for these tracks, but volume remains adjustable.
- VGM routing follows physical chip channels. Rows which share a hardware channel can change together; ambiguous shared channels are not selected as Original automatically.

### Output options

- **Generate variations in bulk** produces every specified speed × transpose combination as a ZIP. It can include the corresponding MIDI files.
- **Export per track** produces one WAV per audible track. Original-game-sound channels can be combined into one file to avoid a full re-render for each hardware channel.
- Variation generation accepts up to 6 speeds, 8 transposes, and 15 total combinations. Speed is limited to 0.1×–10× and transpose to −24–+24 semitones. MIDI notes outside 0–127 are omitted; percussion is never transposed.

### Limits and behaviour

- MIDI channel 10 is not available for instrument remapping, and tracks spanning multiple channels (including format-0 MIDI) are not editable.
- Auditioning renders then plays audio; it is not a live software synthesizer. Completed renders are cached for the current session and edits refresh the preview after a short delay.
- `.m3u` title matching is best-effort. A stale or mismatched playlist leaves song titles unchanged instead of failing.
- Changing a SoundFont, track edit, or output filename invalidates generated variation and per-track ZIPs; generate them again after the change.

### Command-line options

```text
miditrack [MIDI_FILE] [--soundfont FILE] [--no-browser]
```

| Option | Description |
|---|---|
| `MIDI_FILE` | Optional `.mid`/`.midi` file to preload. Upload source files in the browser. |
| `-s, --soundfont FILE` | Default SoundFont at startup. The browser can replace it at any time. |
| `--no-browser` | Do not open a browser tab automatically. |
| `--version` | Show the version and exit. |

## Using the Command-line Tools

Each converter has its own complete reference. These examples cover the usual case.

### nsf2midi

```bash
nsf2midi song.nsf song.mid
nsf2midi -l song.nsf
```

See [nsf2midi/README.md](nsf2midi/README.md) for MDF instrument definitions, PAL timing, and chip-audio rendering.

### spc2midi

```bash
spc2midi song.rsn song.mid
spc2midi -s 12 --sf2 song.rsn song.mid
```

See [spc2midi/README.md](spc2midi/README.md) for SoundFont/DLS export and loop handling.

### vgm2midi

```bash
vgm2midi song.vgz
vgm2midi song.vgz --loops 3
```

See [vgm2midi/README.md](vgm2midi/README.md) for supported chips and advanced options.

### midi2wav.sh

```bash
./miditrack/midi2wav.sh song.mid
./miditrack/midi2wav.sh -S song.mid
./miditrack/midi2wav.sh -s MySound.sf2 -f song.mid
```

## Troubleshooting

- **SoundFont not found**: pass `--soundfont`, set `MIDI2WAV_SOUNDFONT`, or place a `.sf2`/`.sf3` in one of the directories listed above.
- **midi2wav not found**: install FluidSynth with `brew install fluid-synth`.
- **A bundled converter was not found**: restore it to its repository location or set `NSF2MIDI_BIN`, `SPC2MIDI_BIN`, or `VGM2MIDI_BIN`.
- **No supported SNES driver found**: the SPC driver is not one of the supported VGMTrans families, so it cannot be converted.
- **No convertible source file found**: the upload or ZIP contains no supported source file.
- **Invalid ZIP file**: the archive is damaged or is not a ZIP file.
- **miditrack requires Flask**: recreate `.venv` using Quick Start.
- **rubberband not found**: install it with `brew install rubberband` before applying non-default speed/pitch to a real-audio stem.

## Acknowledgments

- [NotSoFatso](https://github.com/BleuBleu/FamiStudio) powers the vendored NES/Famicom playback core.
- The original `nsf2midi.exe` 0.14 inspired this macOS reimplementation and its MDF format compatibility.
- [VGMTrans](https://github.com/vgmtrans/vgmtrans) provides the SNES sequence parsers used by `spc2midi`.
- [jkarenko/vgm2midi](https://github.com/jkarenko/vgm2midi) is the upstream fork for `vgm2midi`.
- [FluidSynth](https://www.fluidsynth.org/) renders SoundFont audio.
- [Rubber Band Library](https://breakfastquay.com/rubberband/) synchronizes real-audio stems after speed/pitch changes.
- [DSEG](https://github.com/keshikan/DSEG) provides the bundled playback-timer web font.

## License

| Tool | License |
|---|---|
| miditrack | MIT |
| nsf2midi | GPL-2.0-or-later |
| spc2midi | zlib, with an LGPL-3.0 component in VGMTrans |
| vgm2midi | MIT |

See each subproject's `README.md`, `LICENSE`, or `NOTICE.md` for full licensing and attribution.
