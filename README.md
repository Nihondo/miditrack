# miditrack

Turn chiptune music — NES (`.nsf`), SNES (`.spc`/`.rsn`), or VGM (`.vgm`/`.vgz`) — into a MIDI file you can re-instrument, remix, and export, entirely from your browser. No terminal required for everyday use.

`miditrack` is a local web app that converts a chiptune source file to MIDI, lets you reassign a General MIDI instrument and volume to every track, and plays back the result immediately — including an option to keep the original chip/game sound instead of a generic synth. Under the hood it's backed by three bundled command-line converters (`nsf2midi`, `spc2midi`, `vgm2midi`) and two shared scripts (`midi2wav.sh`, `pitch_shift.sh`), which are also usable on their own from the terminal if you prefer scripting to a browser.

## Quick Start

1. **Install the requirements** (macOS only):
   ```bash
   brew install fluid-synth
   ```
   You'll also need a General MIDI SoundFont (`.sf2`/`.sf3`) somewhere `miditrack` can find it — see [Requirements](#requirements) below.
2. **Set up `miditrack`** (one-time):
   ```bash
   cd miditrack
   python3 -m venv .venv
   .venv/bin/python -m pip install --upgrade pip
   .venv/bin/python -m pip install -e .
   ```
3. **Launch it**:
   ```bash
   ./miditrack.sh
   ```
   This opens a browser tab automatically. Optionally, symlink it onto your `PATH` once (`ln -s "$PWD/miditrack.sh" /opt/homebrew/bin/miditrack`) so you can just type `miditrack` from anywhere afterward.
4. **Drop a file** onto the upload area — a `.nsf`, `.spc`, `.rsn`, `.vgm`/`.vgz`, or an already-converted `.mid`.
5. **Convert, listen, and download** — pick a song (if the file has more than one), click "MIDIに変換" (Convert to MIDI) if you started from a source file, then choose fast or quality auditioning. The audition audio prepares automatically; download the `.mid` or final-quality `.wav` when you're happy.

## What You Can Do

- **Convert chiptune files straight to MIDI** — drop a `.nsf`/`.spc`/`.rsn`/`.vgm` (or its variants) onto the same upload zone as a `.mid`. Multi-song files (NSF, SPC) let you pick which song to convert.
- **Upload a whole rip pack at once** — a `.zip` containing several source files, or several files selected together, works without unzipping first. A `.m3u` playlist bundled alongside is read automatically and used to show real song titles instead of bare track numbers.
- **Reassign each track's instrument** — every track gets a General MIDI instrument dropdown, grouped into the 16 standard families (Piano, Guitar, Strings, Brass, and so on) for easy browsing. Any instrument the converter already picked is pre-selected.
- **Adjust volume per track** — a 0–200% slider per track, independent of every other track even when several share a MIDI channel. If the source MIDI already carries a volume setting (CC7) for that track alone, the slider starts there automatically.
- **Hear the original chip/game sound instead of a generic SoundFont** — for tracks where it's available, switch a "SoundFont" row to "原曲の音源" (Original game sound) to hear the actual NES/SNES/chip hardware output instead of a synthesized approximation.
- **Change the whole song's speed and pitch** — use the compact −/＋ controls on the right side of the audition toolbar to adjust the global speed multiplier and semitone transpose. The change is applied directly to the MIDI (no audio time-stretch artifacts) and reflected in every play, WAV download, and MIDI download until you change it back.
- **Export a batch of speed/pitch variations** — expand the normally collapsed "バリエーションをまとめて生成" (Generate variations in bulk) disclosure to generate every combination of a few speed factors and semitone shifts as a single downloadable ZIP of WAV files, named `{name}_p{+/-semitones}_x{speed}.wav` (for example, `song_p+0_x1.0.wav`), handy for game-development or remix use.
- **Choose fast or final-quality auditioning** — Fast mode renders the full song at 22.05kHz for quick checks; Quality mode renders at 44.1kHz with the same processing used by the final WAV download. Completed renders are cached for the current session, so revisiting the same settings and mode is immediate.
- **Play it back and download the result** — compact controls provide play/pause, one-second seeking, return-to-start, volume, and mute. A digital timer beside them shows elapsed/total time to one-tenth of a second. MIDI preparation starts an audition render immediately; edits refresh it after 500ms of inactivity. Playback waits for the latest audio rather than using an older setting, while an in-progress playback change keeps its relative position with a crossfade. Selection controls clicked with a pointer release focus afterward, so Space immediately returns to play/pause; keyboard-focused controls keep their normal native behavior. The zoomable piano roll follows playback after the playhead reaches the middle of its viewport; scrolling it yourself stops that follow mode. Download buttons save both the edited `.mid` and rendered `.wav`, and your original upload is never modified.
- **Pick your own SoundFont** — choose which `.sf2`/`.sf3` bank to render with, right from the browser.

Everything runs locally on your machine; no file is ever uploaded anywhere else.

## The Toolkit at a Glance

| Tool | What it does | How you use it |
|---|---|---|
| **miditrack** | The web app described above — the recommended way to use this toolkit | Browser, via `miditrack.sh`/`miditrack` |
| **nsf2midi** | Converts NES/Famicom `.nsf`/`.nsfe` files to MIDI | Bundled inside miditrack, or the terminal directly |
| **spc2midi** | Converts SNES `.spc`/`.spc2`/`.rsn` files to MIDI (plus a matching SoundFont) | Bundled inside miditrack, or the terminal directly |
| **vgm2midi** | Converts VGM/VGZ command-log files (Genesis, arcade, PC-88, and more) to MIDI | Bundled inside miditrack, or the terminal directly |
| **midi2wav.sh** | Renders any `.mid` file to a listenable `.wav` using fluidsynth | Called automatically by all four tools above, or run directly |
| **pitch_shift.sh** | Generates speed/pitch variations of an audio file as WAVs | Called by miditrack to keep a `chipNoise` stem in sync with a MIDI-layer speed/pitch transform, or run directly |

Most people only ever need `miditrack` — the three converters and two scripts exist as its building blocks, but each also works standalone if you'd rather script a conversion pipeline than click through a browser.

## Requirements

- macOS
- Python 3.10+ (for `miditrack` itself)
- [fluidsynth](https://www.fluidsynth.org/) — `brew install fluid-synth`
- A General MIDI SoundFont (`.sf2`/`.sf3`). Set the `MIDI2WAV_SOUNDFONT` environment variable to its path, or place one in any of these locations and it will be found automatically:
  - `<this repo>/soundfonts`
  - `~/Library/Audio/Sounds/Banks`
  - `/opt/homebrew/share/soundfonts`
  - `/Library/Audio/Sounds/Banks`
  - `/opt/homebrew/share/fluid-synth/sf2`
- The three converters (`nsf2midi`, `spc2midi`, `vgm2midi`) ship prebuilt inside this repository — no separate build step needed for ordinary use.
- To hear a VGM track's original game sound: build the bundled native helper once with `cd vgm2midi && ./scripts/build-native.sh`. NSF's original game sound needs no separate build step.
- For real chip-noise mixing, exporting speed/pitch variation ZIPs, or syncing a chip-noise stem to a non-default speed/pitch: [ffmpeg](https://ffmpeg.org/) and [rubberband-cli](https://breakfastquay.com/rubberband/) — `brew install ffmpeg rubberband`.

## Using miditrack

### Starting from a MIDI file

1. Select or drag a `.mid`/`.midi` file onto the upload area.
2. The track list appears. Each editable track shows an instrument dropdown (pre-selected to whatever the file already specifies) and, for tracks with notes, a 0–200% volume slider. Long track names and non-editable reasons are shortened with an ellipsis to keep every row the same height; focus or point at a ⚠ button to read an instrument-change warning.
3. Optionally pick a different **SoundFont**, then choose **高速** (Fast, 22.05kHz) or **品質** (Quality, 44.1kHz) in the audition card. Quality mode matches the final WAV download.
4. Optionally adjust the speed multiplier and/or semitone transpose with the compact −/＋ controls on the right side of the audition toolbar. You can also type a value directly into either control.
5. The selected mode starts rendering as soon as MIDI preparation finishes, and edits refresh it after 500ms of inactivity. Use the segmented playback controls or keyboard shortcuts to play, pause, and seek; if the newest audio is still preparing, playback waits for it instead of using an older setting. Pointer-used selection controls release focus after the operation, so Space can immediately control playback; controls reached by keyboard keep their native key behavior. The adjacent digital timer shows elapsed/total time to one-tenth of a second, followed by volume and mute controls. At zoom levels wider than the viewport, playback from the beginning starts auto-scrolling after the playhead reaches the midpoint. A manual horizontal scroll stops following.
6. Click "MIDIをダウンロード" (Download MIDI) or "WAVをダウンロード" (Download WAV) to save your work. WAV download always uses the 44.1kHz quality render and reuses it when Quality mode has already prepared the same state.
7. Optionally expand "バリエーションをまとめて生成" (Generate variations in bulk), enter comma-separated speed factors and semitone values, and click "バリエーションをZIPでダウンロード" (Download variations as ZIP) to get every combination as one ZIP. ZIP entries use `{name}_p{+/-semitones}_x{speed}` (for example, `song_p+0_x1.0.wav`).

### Starting from a source file (`.nsf`/`.spc`/`.rsn`/`.vgm`, a `.zip`, or several files at once)

1. Drop the file(s) onto the upload area — one source file, a source file plus its `.m3u` playlist, or a `.zip` archive containing one or more source files. miditrack detects the format automatically and, for multi-song formats (NSF, SPC), lists every song so you can pick one.
2. If more than one convertible file was found, pick which one from the **ファイル** (File) dropdown.
3. Pick a song (if the format supports multiple) and adjust the format's own options — duration/PAL timing for NSF, loop count for SPC, tempo/loop/duration for VGM. NSF and VGM also offer a "chip noise" option to preserve the real hardware percussion sound instead of a generic drum kit.
4. Click "MIDIに変換" (Convert to MIDI). The track list then appears exactly as if you'd uploaded a `.mid` directly — continue with the steps above.
5. Converting again (a different song, a different file, or different options) discards the current track edits and any rendered audio, just like uploading a new `.mid` would.

### Original game sound vs. SoundFont

Whenever a track can be played with the real chip/game hardware sound, its Source dropdown offers two choices:

- **原曲の音源 (Original game sound)** — the track plays through the actual chip emulation (NSF, VGM) or a SoundFont built from the game's own samples (SPC), instead of a generic synth. Rows marked **（推奨）** ("recommended") were auto-suggested as safe to switch.
- **SoundFont** — the track plays through your selected General MIDI SoundFont, with the instrument dropdown you can freely change.

Switching to Original game sound disables the instrument dropdown for VGM/NSF tracks (that audio never passes through the SoundFont at all); for SPC it only disables the instrument control, since volume adjustments still apply.

### Command-line options

```
miditrack [MIDI_FILE] [--soundfont FILE] [--no-browser]
```

| Option | Description |
|---|---|
| `MIDI_FILE` | A `.mid`/`.midi` file to preload when the browser opens (optional). Source files must be uploaded from the browser. |
| `-s, --soundfont FILE` | Default SoundFont at startup. Can be changed anytime from the browser. |
| `--no-browser` | Don't open a browser tab automatically. |
| `--version` | Show the version and exit. |

## Using the converters directly

If you'd rather script a conversion than use the browser, each converter also works as a standalone command. See each tool's own README for the full option reference and examples — the summaries below cover the everyday case.

### nsf2midi (NES)

```bash
nsf2midi song.nsf song.mid          # convert
nsf2midi -l song.nsf                # list songs/tracks in the file
nsf2midi --wav song.nsf song.mid    # also render a .wav
```

See [nsf2midi/README.md](nsf2midi/README.md) for instrument customization (`.mdf` files), PAL timing, and real chip-audio rendering.

### spc2midi (SNES)

```bash
spc2midi song.rsn song.mid              # convert (auto-detects .spc/.spc2/.rsn)
spc2midi -l song.rsn                    # list sequences in the file
spc2midi -s 12 --sf2 song.rsn song.mid  # convert one song, with a matching SoundFont
```

See [spc2midi/README.md](spc2midi/README.md) for multi-song `.rsn` archives, SoundFont/DLS export, and loop unrolling.

### vgm2midi (Genesis, arcade, PC-88, and more)

```bash
vgm2midi song.vgz                       # convert (creates song.mid)
vgm2midi song.vgz -v                    # verbose: show detected chips
vgm2midi song.vgz --loops 3             # play the loop section 3 times total
```

See [vgm2midi/README.md](vgm2midi/README.md) for the full list of supported sound chips and advanced options.

### midi2wav.sh (render any MIDI to WAV)

```bash
./midi2wav.sh song.mid                  # render with the default SoundFont
./midi2wav.sh -S song.mid               # pick a SoundFont interactively
./midi2wav.sh -s MySound.sf2 -f song.mid  # use a specific SoundFont, overwrite existing output
```

### pitch_shift.sh (batch speed/pitch variations)

```bash
./pitch_shift.sh song.m4a                          # 10 files: 2 speeds x 5 pitches (defaults)
./pitch_shift.sh -s 1.5 -p -3 -p -5 song.m4a        # x1.5 speed, 2 pitch shifts = 2 files
```

Accepts a local audio file or a URL (including YouTube, via `yt-dlp`).

## Troubleshooting

- **"SoundFont not found"** — pass `--soundfont` explicitly, set the `MIDI2WAV_SOUNDFONT` environment variable, or place a `.sf2` in one of the directories listed under [Requirements](#requirements).
- **"midi2wav not found"** — confirm `fluidsynth` is installed (`brew install fluid-synth`).
- **"nsf2midi/spc2midi/vgm2midi not found"** — these ship prebuilt inside this repository, so this shouldn't normally happen. If you moved or rebuilt one, restore it at its usual path or set the corresponding `NSF2MIDI_BIN`/`SPC2MIDI_BIN`/`VGM2MIDI_BIN` environment variable.
- **"対応するSNESサウンドドライバが見つかりませんでした" (no supported SNES driver found)** — the `.spc` file's music driver isn't one of the ~20 families `spc2midi` recognizes; this file can't be converted.
- **"対応する音源ファイルが見つかりません" (no convertible source file found)** — none of the uploaded files matched a supported extension.
- **"有効なZIPファイルではありません" (not a valid ZIP file)** — the uploaded `.zip` is corrupted or not actually a ZIP.
- **"miditrack requires Flask"** — recreate the `.venv` following the [Quick Start](#quick-start) steps above.
- **"pitch_shift.sh が見つかりません" (pitch_shift.sh not found)** — confirm `ffmpeg` and `rubberband-cli` are installed (`brew install ffmpeg rubberband`).
- **"速度×ピッチの組み合わせ数が多すぎます" (too many speed×pitch combinations)** — reduce how many speeds/pitches you specify in the ZIP-export feature (the cap is 40 combinations).

## Acknowledgments

This toolkit stands on several excellent open-source projects:

- **[NotSoFatso](https://github.com/BleuBleu/FamiStudio)** by Disch — the NES/Famicom playback core `nsf2midi` vendors to emulate the APU and expansion audio chips, sourced from the FamiStudio project's modernized build.
- **The original `nsf2midi.exe` 0.14** — a Windows GUI tool with no available source or command-line interface. This repository's `nsf2midi` is a from-scratch macOS/arm64 reimplementation that reads the same `.mdf` instrument-definition format.
- **[VGMTrans](https://github.com/vgmtrans/vgmtrans)** — `spc2midi` is built directly on top of VGMTrans's per-driver SNES sequence parsers, rather than reimplementing note detection from scratch.
- **[jkarenko/vgm2midi](https://github.com/jkarenko/vgm2midi)** — `vgm2midi` began as a fork of this project, extended here with several additional sound chips and fixes.
- **[FluidSynth](https://www.fluidsynth.org/)** — the SoundFont synthesizer `midi2wav.sh` renders every WAV preview and download through.
- **[Rubber Band Library](https://breakfastquay.com/rubberband/)** (via `rubberband-cli`) — the time-stretching/pitch-shifting engine `pitch_shift.sh` uses to generate speed/pitch variations.
- **[DSEG](https://github.com/keshikan/DSEG)** by keshikan — the locally bundled DSEG7 Classic web font used by the playback timer, distributed under the SIL Open Font License 1.1.

See each subproject's own `README.md`/`NOTICE.md` for full attribution and license details.

## License

Each tool carries its own license:

| Tool | License |
|---|---|
| miditrack | MIT |
| nsf2midi | GPL-2.0-or-later (links the vendored NotSoFatso NSF core) |
| spc2midi | zlib (statically links VGMTrans, also zlib, with one LGPL-3.0 component) |
| vgm2midi | MIT (fork of jkarenko/vgm2midi) |

See each subproject's own `README.md`/`LICENSE`/`NOTICE.md` for full details.
