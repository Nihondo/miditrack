# NOTICE

spc2midi itself: zlib license (see `LICENSE`).

## Statically linked components

VGMTrans is fetched at the commit in `vgmtrans.pin`; `build.sh` stores its
source in `~/.cache/spc2midi/` rather than this repository.

| Component | License |
|---|---|
| VGMTrans core (`vgmtranscore`) | zlib |
| spdlog (+ bundled fmt) | MIT |
| zlib / minizip | zlib |
| mio (header-only) | MIT |
| libchdr | BSD-3-Clause |

`patches/vgmtrans-no-rsn.patch` permanently excludes `RSNLoader.cpp` and
`unarr`. The resulting binary has no RAR/RSN decompression component and no
LGPL-3.0 `unarr` dependency.

## Runtime dependency

The arm64 binary links only macOS system libraries (`libc++` and `libSystem`)
at runtime. Confirm the exact linkage with `otool -L spc2midi` after a rebuild.
