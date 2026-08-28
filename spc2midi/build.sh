#!/bin/bash
# build.sh
# spc2midi をビルドし、リポジトリ直下の spc2midi バイナリを更新する。
#
# VGMTrans のソース取得先とビルドツリーは ~/.cache/spc2midi/ (Dropbox の外側) に置く。
# CMakePresets.json の binaryDir / FETCHCONTENT_BASE_DIR がそこを指しているため、
# ここでは cmake --preset / --build --preset を呼ぶだけでよい。Dropbox に触れるのは
# 最後にビルド済みバイナリをこのディレクトリへコピーする一手だけ。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRESET="macos-arm64"
BUILD_DIR="$HOME/.cache/spc2midi/build/$PRESET"

if [[ "${1:-}" == "--clean" ]]; then
  echo "Removing $BUILD_DIR (VGMTrans のソースキャッシュ ~/.cache/spc2midi/_deps は保持)"
  rm -rf "$BUILD_DIR"
  exit 0
fi

if ! command -v cmake >/dev/null 2>&1 || ! command -v ninja >/dev/null 2>&1; then
  echo "error: cmake と ninja が必要です。" >&2
  echo "       brew install cmake ninja" >&2
  echo "       (Qt は不要です — spc2midi は VGMTrans の Qt UI を使いません)" >&2
  exit 1
fi

cd "$SCRIPT_DIR"
cmake --preset "$PRESET"
cmake --build --preset "$PRESET"

cp "$BUILD_DIR/spc2midi" "$SCRIPT_DIR/spc2midi"
chmod +x "$SCRIPT_DIR/spc2midi"
echo "-> $SCRIPT_DIR/spc2midi"
