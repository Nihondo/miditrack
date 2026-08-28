# NotSoFatso

Vendored NSF playback core used by this project to emulate the NES APU and
expansion audio chips (VRC6, VRC7, FDS, MMC5, N106/N163, FME-7/S5B, EPSM) and
run the 6502 CPU of a loaded NSF.

- **Original author:** Disch, 2004 ("NotSoFatso" NSF player / Winamp plugin)
- **Vendored from:** [BleuBleu/FamiStudio](https://github.com/BleuBleu/FamiStudio),
  `ThirdParty/NotSoFatso/`, which maintains a modernized, cross-platform build
  of the original code.
- **License:** GNU General Public License v2 or later (see header comments in
  each source file, and `/LICENSE` at the repository root).

## Files kept

Only the files needed to build a standalone playback/state-inspection core
are kept here; `DllWrapper.cpp` (Windows/.NET P/Invoke wrapper), `NSF.cpp`
(Winamp plugin glue) and `NSF_6502_Trace.cpp` (debug tracer) were dropped
since nsf2midi links the core directly and does not need them.

## Why this code

`CNSFCore::RunOneFrame()` executes exactly one NSF "play" call (one video
frame of NES sound-engine emulation), and `CNSFCore::GetState(channel, state,
sub)` exposes each channel's current volume/period/duty-cycle *after* that
frame. This is exactly the data nsf2midi's note-on/off detector (see
`../../src/detector.cpp`) needs to reconstruct notes from raw APU register
state, without having to re-implement 6502 + APU + expansion-audio emulation
from scratch.

See `NSF_Core.h` for the `CHANNEL_*` / `STATE_*` / `EXTSOUND_*` constants
this project's `src/channel_map.cpp` and `src/pitch.cpp` build on.
