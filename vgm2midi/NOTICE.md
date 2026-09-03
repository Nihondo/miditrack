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

## Native helper (`vgm2midi_stems`) — libvgm

`native/render_stems.cpp` links against [libvgm](https://github.com/ValleyBell/libvgm)
(pinned commit `57585ea`, `native/CMakeLists.txt`), fetched at build time and
never vendored into this repository. `vgm2midi_stems` is a **separate
executable**, invoked as a subprocess the same way `nsf2midi`/`spc2midi` are
— it is not linked into `vgm2midi`'s own Node.js process, so its license does
not extend to `vgm2midi` itself or to anything that merely invokes it.

libvgm has **no top-level LICENSE file**. Each sound-chip emulation core
under `emu/cores/` carries its own per-file license (mostly `// license:`
header comments, the same convention MAME uses, since most cores are ported
from MAME). `native/CMakeLists.txt` does not restrict which cores libvgm
builds, and libvgm's own default (`SNDEMU__ALL=ON`) compiles **every** core
into the `vgm-emu` target — so `vgm2midi_stems` statically links all of them,
including several GPL-2.0 cores. As a combined work, **`vgm2midi_stems` must
therefore be treated as GPL-2.0(-or-later) licensed as a whole**, the same
posture this repository already takes for `nsf2midi` (which links the
GPL-2.0+ NotSoFatso core — see `nsf2midi/CLAUDE.md`). Its complete source is
public at the pinned commit above, satisfying GPL's source-availability
requirement.

The table below was produced by inspecting the license header of every `.c`
file libvgm builds for this project's chip set, at the pinned commit.

| Chip / component | File(s) | License |
|---|---|---|
| YM3812/Y8950/OPL2 (MAME core) | `fmopl.c` | GPL-2.0+ |
| YM2203/2608/2610/2612 OPN family (MAME core) | `fmopn.c` | GPL-2.0+ |
| YM Delta-T ADPCM (used by fmopl/fmopn) | `ymdeltat.c` | GPL-2.0+ (untagged; same authorship as `fmopl.c`/`fmopn.c`) |
| MSM5232 | `msm5232.c` | GPL-2.0+ |
| NES APU (MAME core) | `nes_apu.c` | GPL-2.0+ |
| YM2413/VRC7 (Nuked OPLL) | `nukedopll.c` | GPL-2.0+ |
| YM2151/OPM (MAME core) | `ym2151.c` | GPL-2.0+ |
| YM2413/OPLL (MAME core) | `ym2413.c` | GPL-2.0+ |
| YMF262/OPL3 (MAME core) | `ymf262.c` | GPL-2.0+ |
| YMF278B/OPL4 | `ymf278b.c` | GPL-2.0+ |
| Mega Drive PWM (Gens-derived) | `pwm.c` | GPL-2.0-or-later |
| Virtual Boy VSU (Mednafen-derived) | `vsu.c` | GPL-2.0-or-later |
| YM2612 (Gens core) | `ym2612.c` | GPL-2.0 (Gens project; no per-file header, project-level license) |
| Sega CD RF5C164 PCM (Gens core) | `scd_pcm.c` | GPL-2.0 (Gens project; no per-file header, project-level license) |
| YMF262/OPL3 (Nuked OPL3, alternative core) | `nukedopl3.c` | LGPL-2.1+ |
| YM2151/OPM (Nuked OPM, alternative core) | `nukedopm.c` | LGPL-2.1+ |
| YM2612 (Nuked OPN2, alternative core) | `ym3438.c` | LGPL-2.1+ |
| YM3812/YMF262 (AdLibEmu) | `adlibemu_opl2.c`, `adlibemu_opl3.c`, `adlibemu_opl_inc.c` | LGPL-2.1+ (The DOSBox Team) |
| AY-3-8910/YM2149, BSMT2000, C140, C219, C352, HuC6280 (MAME core), ES5503, Game Boy DMG, ICS2115, Irem GA20, K005289, K051649, K053260, K054539, K007232, MSM5205, MultiPCM, OKI ADPCM/M6258/M6295, POKEY, QSound (MAME core), RF5C68 (MAME core), SAA1099 (MAME core), SCSP, SegaPCM, SN76496 (MAME core), UPD7759, X1-010, YMF271, YMZ280B | `ay8910.c`, `bsmt2000.c`, `c140.c`, `c219.c`, `c352.c`, `c6280_mame.c`, `es5503.c`, `gb.c`, `ics2115.c`, `iremga20.c`, `k005289.c`, `k051649.c`, `k053260.c`, `k054539.c`, `k007232.c`, `msm5205.c`, `multipcm.c`, `okiadpcm.c`, `okim6258.c`, `okim6295.c`, `pokey.c`, `qsound_mame.c`, `rf5c68.c`, `saa1099_mame.c`, `scsp.c`, `scspdsp.c`, `scsplfo.c`, `segapcm.c`, `sn76496.c`, `upd7759.c`, `x1_010.c`, `ymf271.c`, `ymz280b.c` | BSD-3-Clause |
| Atari Lynx Mikey | `mikey.c` | MIT |
| AY-3-8910/YM2149 (EMU2149, alternative core, [digital-sound-antiques/emu2149](https://github.com/digital-sound-antiques/emu2149)) | `emu2149.c` | MIT (no per-file header; confirmed against upstream `LICENSE`) |
| YM2413/OPLL (EMU2413, alternative core, [digital-sound-antiques/emu2413](https://github.com/digital-sound-antiques/emu2413)) | `emu2413.c` | MIT (no per-file header; confirmed against upstream `LICENSE`) |
| Device-interface glue (no independent copyrightable content; follows whichever core it wraps at build time) | `2151intf.c`, `2413intf.c`, `2612intf.c`, `262intf.c`, `ayintf.c`, `c6280intf.c`, `nesintf.c`, `oplintf.c`, `opnintf.c`, `qsoundintf.c`, `rf5cintf.c`, `saaintf.c`, `sn764intf.c` | n/a |
| ES5506 | `es5506.c` | n/a (unimplemented stub in this libvgm revision — every function returns null/no-op) |

### Not yet confirmed

The following files carry no license header in the vendored source, and no
upstream `LICENSE` file could be located for their origin project either.
They are listed here rather than silently folded into the table above, and
should be treated as unresolved until confirmed directly with their authors
or upstream projects — do not rely on this table alone to clear
`vgm2midi_stems` for any distribution beyond this project's own
source-available use:

| Chip / component | File(s) | Known origin |
|---|---|---|
| NES APU / DMC / FDS (NSFPlay port) | `np_nes_apu.c`, `np_nes_dmc.c`, `np_nes_fds.c` | Ported from [NSFPlay](https://github.com/bbbradsmith/nsfplay) by Valley Bell; upstream repository has no `LICENSE` file. |
| PC Engine PSG (Ootake-derived) | `Ootake_PSG.c` | Ported from the Ootake PC Engine emulator; no confirmed open-source license located. |
| SN76489 (Maxim's core, SMS Plus modifications) | `sn76489.c` | By Maxim, modified for SMS Plus by Charles MacDonald; no license header in this file (distinct from `sn76496.c` above, which is BSD-3-Clause). |
| QSound (superctr's core) | `qsound_ctr.c` | Original work by superctr (Ian Karlsson) for libvgm; no license header. |
| SAA1099 (Valley Bell's core) | `saa1099_vb.c` | Original work by libvgm's own maintainer; no per-file license, same undocumented status as the project overall. |
| WonderSwan audio | `ws_audio.c` | No author/origin stated in the vendored file. |

Since `SNDEMU__ALL` builds every core unconditionally, these files are
compiled into `vgm2midi_stems` today regardless of this gap. Narrowing the
build to specific `SNDEMU_<CHIP>_<CORE>` selections (libvgm exposes
alternative, more clearly-licensed cores for several of the GPL/unconfirmed
chips above, e.g. Nuked OPM/OPN2/OPL3 or EMU2149/EMU2413) was not attempted
here — this pass only documents what is currently built, it does not change
`native/CMakeLists.txt`.
