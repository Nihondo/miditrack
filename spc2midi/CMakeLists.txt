cmake_minimum_required(VERSION 3.25)
project(spc2midi VERSION 0.4.0 LANGUAGES C CXX)

# VGMTrans の Qt UI は不要。vgmtranscore (+ 同梱の vgmtrans-cli) だけを取り込む。
set(ENABLE_UI_QT OFF CACHE BOOL "" FORCE)

# vgmtrans.pin は SHA 1行のみ (ASCII)。file(STRINGS) は strings(1) 同様に非ASCIIバイト列を
# 区切りとみなして分割してしまうため、コメント入りの多バイト文字混在ファイルには使えない。
# 単純な file(READ) + string(STRIP) で読む。
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/vgmtrans.pin" VGMTRANS_PIN)
string(STRIP "${VGMTRANS_PIN}" VGMTRANS_PIN)

include(FetchContent)
FetchContent_Declare(vgmtrans_no_rsn
  GIT_REPOSITORY https://github.com/vgmtrans/vgmtrans.git
  GIT_TAG        ${VGMTRANS_PIN}
  GIT_SUBMODULES lib/spdlog lib/libchdr lib/zlib
  # The source/build cache lives outside this checkout and can survive a
  # reconfigure. Apply the pinned patch once, then verify its reverse applies
  # cleanly on later builds instead of failing by trying to apply it twice.
  PATCH_COMMAND ${CMAKE_COMMAND}
    "-DSOURCE_DIR=<SOURCE_DIR>"
    "-DPATCH_FILE=${CMAKE_CURRENT_SOURCE_DIR}/patches/vgmtrans-no-rsn.patch"
    -P "${CMAKE_CURRENT_SOURCE_DIR}/patches/apply_patch_if_needed.cmake"
  GIT_PROGRESS   TRUE)
FetchContent_MakeAvailable(vgmtrans_no_rsn)

add_executable(spc2midi
  src/main.cpp
  src/spc2midi_root.cpp
  src/paths.cpp)
target_link_libraries(spc2midi PRIVATE vgmtranscore)
target_compile_features(spc2midi PRIVATE cxx_std_20)
