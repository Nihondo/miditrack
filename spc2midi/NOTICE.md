# NOTICE

spc2midi itself: zlib license (see `LICENSE`).

## Statically linked components

Fetched at build time from `github.com/vgmtrans/vgmtrans`, pinned by commit
SHA in `vgmtrans.pin` (currently the `v1.3` tag). None of this source is
committed to this repository; `build.sh` downloads it into
`~/.cache/spc2midi/` outside of Dropbox sync.

| Component | License |
|---|---|
| VGMTrans core (`vgmtranscore`) | zlib |
| spdlog (+ bundled fmt) | MIT |
| zlib / minizip | zlib |
| mio (header-only) | MIT |
| libchdr | BSD-3-Clause |
| unarr | **LGPL-3.0** (see note below) |

## Note on unarr

`unarr` (`vgmtrans/lib/unarr`, LGPL-3.0) provides RAR decompression for
`.rsn` input and is linked into `vgmtranscore` `PUBLIC`, so it ends up
statically linked into the `spc2midi` binary.

Because it is statically linked, any *redistribution* of the prebuilt
`spc2midi` binary to third parties carries the LGPL-3.0 section 4 relinking
obligation. This repository is not publicly distributed, so the practical
impact is nil; but if the binary is ever published to third parties, either

- (a) ship the object files / a relinkable archive so the LGPL component
  can be swapped, or
- (b) rebuild with unarr disabled and drop `.rsn` support (only `.spc` /
  `.spc2` would remain supported).

## Runtime dependency

The built binary is not fully dependency-free: `otool -L` shows it links
`/usr/lib/liblzma.5.dylib` in addition to `libc++`/`libSystem` (used
transitively by `unarr` for LZMA-compressed RAR entries). `liblzma` ships
with every macOS install via the system SDK, so this does not add an
installation requirement in practice, but it means the binary is not a
*fully* static Mach-O the way `nsf2midi` is.
