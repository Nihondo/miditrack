# NOTICE

vgm2midi itself: MIT license (see `LICENSE`).

## Origin

This directory is a vendored fork of
[jkarenko/vgm2midi](https://github.com/jkarenko/vgm2midi) (MIT license,
commit `2648ee6`), brought in as a plain copy rather than a git submodule —
its own commit history stays on GitHub, not in this repo's history, the
same convention used for the bundled `rec2ass` package (see the project
root `CLAUDE.md`).

## Why it was forked here

The upstream tool only recognizes SN76489, YM2612, YM2413, YM2151, and
AY-3-8910 sound-chip commands in a VGM file. A PC Engine / TurboGrafx-16
(HuC6280 PSG) source — e.g. Sega/NEC console rips like *OutRun (TG-16)* —
produced a MIDI file with zero note events (a 14-byte header-only file)
because every `0xB9` (HuC6280 register write) command was silently
discarded. See `CLAUDE.md` for what was added and why.

## Third-party dependencies

`commander`, `midi-writer-js`, and `pako` are pulled from npm as ordinary
`dependencies` in `package.json` (not vendored into this repository); see
`package-lock.json` for pinned versions and their own licenses.
