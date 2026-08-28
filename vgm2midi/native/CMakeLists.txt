cmake_minimum_required(VERSION 3.21)
project(vgm2midi_libvgm_stems LANGUAGES CXX)

# Keep downloaded sources/build products out of the Dropbox worktree. The
# pinned revision is deliberately explicit so stem renders are reproducible.
set(VGM2MIDI_LIBVGM_CACHE "$ENV{VGM2MIDI_NATIVE_CACHE}" CACHE PATH "External libvgm cache")
if(NOT VGM2MIDI_LIBVGM_CACHE)
  set(VGM2MIDI_LIBVGM_CACHE "/tmp/vgm2midi-libvgm")
endif()
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
