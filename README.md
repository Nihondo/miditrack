# miditrack

Turn chiptune music — NES (`.nsf`/`.nsfe`), SNES (`.spc`/`.spc2`/`.rsn`), or VGM (`.vgm`/`.vgz`) — into editable MIDI and listen to the result in your browser. Everyday use needs no terminal after the one-time setup.

`miditrack` runs only on your Mac. Your source files, MIDI, and rendered audio stay local.

![miditrack](images/miditrack_lead.png)

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

Drop a source file or a `.mid` onto the upload area and work through the four numbered screens. **Save project** downloads a `.miditrack` archive with the editable MIDI, conversion settings, track choices, speed/pitch, loop, and preset. **Open project** restores that state without re-converting the source. Rendered audio and generated ZIPs are not stored in a project.

### Screen 1 · File Selection

![File Selection](images/miditrack_s01.png)

**Upload area** — Drag a file onto the dashed area, or click to open a file picker. Accepted: `.mid`, `.midi`, `.nsf`, `.nsfe`, `.spc`, `.spc2`, `.rsn`, `.vgm`, `.vgz`, `.zip`, `.m3u`. Drop multiple source files, a ZIP rip pack, or a source file together with an `.m3u` playlist at once. ZIP uploads allow up to 200 files and 512 MiB extracted. A playlist loaded alongside a source file supplies song titles.

**File and song picker** — When the upload contains multiple convertible sources a file dropdown appears. If the format provides multiple songs (NSF, SPC rip packs) a song picker appears below it.

**Conversion settings** — Appear after format detection and vary by format:

- **VGM/VGZ** — Loop count or duration (mutually exclusive). **Original game sound by default** pre-selects noise/DAC/rhythm tracks for chip rendering; any track can be changed after conversion. **OPN Ch3 Special to GM drums** maps YM2203/YM2608/YM2612 Ch3 Special operators to kick, snare, hi-hat, cymbal, and tom.
- **NSF/NSFE** — Duration in seconds and optional PAL timing.
- **SPC/SPC2/RSN** — Loop count.

Click **Convert to MIDI** to start. After conversion the remaining screens work identically to starting from an uploaded MIDI.

### Screen 2 · Tracks

![Tracks](images/miditrack_s02.png)

**Track list** — Each row shows a colour swatch, track name, MIDI channel (CH), source toggle, instrument selector, mute, solo, and volume slider. Click **Track ▲** to sort alphabetically; click again to reverse. MIDI channel 10 (percussion) and multi-channel tracks cannot have their instrument changed.

**SF / Original toggle** — **SF** plays the track through the selected General MIDI SoundFont and honours instrument assignments. **Original** uses a game-derived SoundFont for SPC, or hardware/chip rendering for NSF and VGM. Volume is still adjustable in Original mode. VGM rows sharing a physical hardware channel switch together; ambiguous shared channels are not set to Original automatically. **Cmd-click** (Ctrl-click on Windows/Linux) applies the same choice to every other track that offers the same option.

**Instrument selector** — Choose any GM instrument. The star icon saves it as a favourite for quick access. **Cmd-click** (Ctrl-click) applies that selector's current value to every other editable track (a track left on "Keep unchanged" is unaffected).

**Mute / Solo** — Both affect the rendered preview. **Cmd-click** (Ctrl-click) the mute button to bring every other track to the same mute state (muted or unmuted) at once. Unmuting restores each track's own previously remembered volume rather than a single shared value.

**Ensemble presets** — Save the current combination of instruments and source settings as a named preset. While a preset is active the instrument column switches to a role selector. Presets are stored locally in the browser.

**SoundFont** — Select a `.sf2`/`.sf3` from those found in the standard search directories. **Fast** (22.05 kHz) renders quickly for auditioning; **Quality** (44.1 kHz) matches the WAV download.

### Screen 3 · Audition

![Audition](images/miditrack_s03.png)

**Transport** — ◀◀ rewinds 5 s, ▶▶ skips 5 s, ⏮ returns to start, ▶/⏸ plays or pauses. The timer shows the current position over the total duration.

**Speed** — Playback rate from 0.1× to 10×. Applies to all subsequent renders and the WAV download.

**Pitch** — Shifts by −24 to +24 semitones. Percussion is never transposed; notes that fall outside MIDI range 0–127 are omitted.

**Volume** — Master level for the session.

**Piano roll** — Displays all tracks as coloured note bars on a vertical keyboard. Scroll to navigate; pinch or use the scroll wheel to zoom. Click to seek.

**Pitch bend lane** — Shows pitch bend data for each track below the note area.

Rendering starts automatically after edits. For SoundFont-based tracks, miditrack first prepares a short section around the current play position, then replaces it with the exact full-song render when it is ready. Completed audio is cached for the session. Original VGM/NSF chip-audio tracks currently wait for their full render.

### Screen 4 · Output

![Output](images/miditrack_s04.png)

**Download MIDI / WAV** — Download MIDI saves the edited file with current instrument assignments. Download WAV produces a 44.1 kHz stereo WAV using the current track settings, speed, and pitch. Edit the **filename** field before downloading to set the base name.

**Generate variations in bulk** — Enter comma-separated speed multipliers and semitone values, then click **Download variations as ZIP**. Check **Include MIDI in ZIP** to add the corresponding MIDI file for each combination. Accepts up to 6 speeds, 8 transposes, and 15 total combinations. The audition speed and pitch settings are not changed.

**Export per track** — **Download per track as ZIP** produces one WAV per audible track. Check **Combine original-sound tracks** to merge all original-sound channels into one file, avoiding a full re-render per hardware channel. File names include `_midi` or `_orig` to indicate the render source.

Changing a SoundFont, a track setting, or the filename invalidates previously generated variation and per-track ZIPs; regenerate them after the change.

### Full-Screen Mode

![Full-screen mode](images/miditrack_full.png)

Full-screen mode shows the track panel and the piano roll side-by-side on a single screen. Click **Full screen** in the header to enter; click **Exit full screen** to leave.

**Track panel (left)** — The same controls as Screen 2: source toggle, instrument, mute, solo, and volume per track. Ensemble presets and the SoundFont selector are anchored at the bottom of the panel.

**Piano roll (right)** — Identical to Screen 3. The transport bar and speed/pitch controls appear at the top.

**Output bar (bottom)** — MIDI and WAV download buttons and the output options panel replace the separate Screen 4.

### Display Settings

![Display Settings](images/miditrack_ss.png)

Open the display settings panel from any screen. Changes take effect immediately and are preserved across restarts.

**Theme** — **Global display** sets the colour scheme: follow the system setting, light, or dark.

**Piano roll**
- *Round note corners*, *Add note outline*, *Show grid lines*, *Show keyboard* — toggle each element individually.
- *Height* — Sets the piano roll height in the step-by-step layout. In full-screen mode the roll always fills the window height.
- *Background colour* / *Grid line colour* — Pick a custom colour or reset to the theme default.
- *Track colour scheme* — Controls the saturation of the per-track note colours.
- *Vertical grid divisions* — Number of subdivisions per beat.

**Track list** — *Hide tracks with zero notes* removes empty tracks from the list.

### Limits and behaviour

- MIDI channel 10 is not available for instrument remapping, and multi-channel tracks (including format-0 MIDI) are not editable.
- Auditioning renders then plays audio; it is not a live software synthesizer. Completed renders are cached for the current session.
- `.m3u` title matching is best-effort. A stale or mismatched playlist leaves song titles unchanged instead of failing.

### Command-line options

```text
miditrack [MIDI_FILE] [--soundfont FILE] [--port PORT] [--no-token] [--no-browser]
```

| Option | Description |
|---|---|
| `MIDI_FILE` | Optional `.mid`/`.midi` file to preload. Upload source files in the browser. |
| `-s, --soundfont FILE` | Default SoundFont at startup. The browser can replace it at any time. |
| `-p, --port PORT` | Fixed port for the Web UI. Omit it (or pass `0`) to pick a free port automatically on every launch. |
| `--no-token` | Disable launch-token authentication. By default a fresh token is issued on every launch and the browser strips it from the URL, so a bookmarked link stops working the next time you start `miditrack`. Combined with a fixed `--port`, this lets you bookmark the plain URL and reopen it every time — but it also means any other process on this Mac can reach the Web UI over `127.0.0.1`, so only use it in a trusted environment. |
| `--no-browser` | Do not open a browser tab automatically. |
| `--version` | Show the version and exit. |

### Saving miditrack as a browser "app"

miditrack can be saved as a PWA (Chrome's "Install app," Safari's "Add to Dock," and similar). A saved app icon always opens `http://127.0.0.1:<port>/` with no token, so combine these three options for that workflow:

- **`--port`** — pins the port so the app icon opens the same URL every time.
- **`--no-token`** — a saved app icon has no way to carry a token in its URL, so this disables token authentication entirely (only use this in a trusted environment).
- **`--no-browser`** — skips the automatic browser tab, since opening from the app icon makes it redundant.

```bash
miditrack --port 51888 --no-token --no-browser
```

Start the server with this command, then open it from the saved app icon.

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
