cmake_minimum_required(VERSION 3.21)
project(vgm2midi_libvgm_stems LANGUAGES CXX)

# Keep downloaded sources/build products out of the Dropbox worktree. The
# pinned revision is deliberately explicit so stem renders are reproducible.
set(VGM2MIDI_LIBVGM_CACHE "$ENV{VGM2MIDI_NATIVE_CACHE}" CACHE PATH "External libvgm cache")
if(NOT VGM2MIDI_LIBVGM_CACHE)
  set(VGM2MIDI_LIBVGM_CACHE "/tmp/vgm2midi-libvgm")
endif()
# libvgm has no top-level LICENSE file; each emu/cores/*.c file carries its
# own (see vgm2midi/NOTICE.md for the full per-file audit). SNDEMU__ALL's
# default (ON) would otherwise also pull in four device families this
# project never uses and whose license could not be confirmed either
# upstream or in the vendored source (NES APU/NSFPlay, QSound, SAA1099,
# WonderSwan), and would pick libvgm's own default core for SN76489/HuC6280
# (Maxim's core, Ootake's core) over the equally-capable, clearly
# BSD-3-Clause MAME core libvgm also ships for both. These must be set
# before FetchContent_MakeAvailable() populates the cache, since libvgm's
# own CMakeLists.txt only fills in cache variables that do not already
# exist; SNDEMU__ALL is turned off so its cascade cannot silently re-enable
# the four excluded device families, and every other device family it would
# have enabled is re-listed explicitly so this is otherwise a no-op change.
set(SNDEMU__ALL OFF CACHE BOOL "" FORCE)
set(SNDEMU_SN76496_MAME ON CACHE BOOL "" FORCE)   # BSD-3-Clause; skip Maxim's sn76489.c (unconfirmed license)
set(SNDEMU_SN76496_MAXIM OFF CACHE BOOL "" FORCE)
set(SNDEMU_C6280_MAME ON CACHE BOOL "" FORCE)     # BSD-3-Clause; skip Ootake_PSG.c (unconfirmed license)
set(SNDEMU_C6280_OOTAKE OFF CACHE BOOL "" FORCE)
set(SNDEMU_NESAPU_ALL OFF CACHE BOOL "" FORCE)    # unused by vgm2midi.ts; MAME core is GPL-2.0+, NSFPlay port is unconfirmed
set(SNDEMU_QSOUND_ALL OFF CACHE BOOL "" FORCE)    # unused by vgm2midi.ts; superctr's core is unconfirmed
set(SNDEMU_SAA1099_ALL OFF CACHE BOOL "" FORCE)   # unused by vgm2midi.ts; Valley Bell's core is unconfirmed
set(SNDEMU_WSWAN_ALL OFF CACHE BOOL "" FORCE)     # unused by vgm2midi.ts; ws_audio.c is unconfirmed
set(SNDEMU_YM2413_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_YM2612_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_YM2151_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_SEGAPCM_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_RF5C68_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_YM2203_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_YM2608_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_YM2610_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_YM3812_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_YM3526_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_Y8950_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_YMF262_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_YMF278B_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_YMZ280B_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_YMF271_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_AY8910_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_32X_PWM_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_GAMEBOY_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_YMW258_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_UPD7759_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_MSM6258_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_MSM6295_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_K051649_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_K054539_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_C140_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_C219_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_K053260_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_POKEY_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_SCSP_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_VBOY_VSU_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_ES5503_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_ES5506_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_X1_010_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_C352_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_GA20_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_MIKEY_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_K007232_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_K005289_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_MSM5205_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_MSM5232_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_BSMT2000_ALL ON CACHE BOOL "" FORCE)
set(SNDEMU_ICS2115_ALL ON CACHE BOOL "" FORCE)

include(FetchContent)
set(FETCHCONTENT_BASE_DIR "${VGM2MIDI_LIBVGM_CACHE}")
FetchContent_Declare(libvgm
  GIT_REPOSITORY https://github.com/ValleyBell/libvgm.git
  GIT_TAG 57585ea
  GIT_SHALLOW FALSE)
FetchContent_MakeAvailable(libvgm)

add_executable(vgm2midi_stems render_stems.cpp)
target_compile_features(vgm2midi_stems PRIVATE cxx_std_17)
target_include_directories(vgm2midi_stems PRIVATE "${libvgm_SOURCE_DIR}")
target_link_libraries(vgm2midi_stems PRIVATE vgm-player vgm-emu vgm-utils)
