#!/bin/bash
# build.sh
# spc2midi をビルドし、リポジトリ直下の spc2midi バイナリを更新する。
#
# VGMTrans のソース取得先とビルドツリーは ~/.cache/spc2midi/ (Dropbox の外側) に置く。
# CMakePresets.json の binaryDir / FETCHCONTENT_BASE_DIR がそこを指しているため、
# ここでは cmake --preset / --build --preset を呼ぶだけでよい。Dropbox に触れるのは
# 最後にビルド済みバイナリをこのディレクトリへコピーする一手だけ。
#
# コミットするバイナリは既定でユニバーサル(arm64+x86_64)。Apple Siliconの開発機だけで
# 両アーキテクチャをクロスコンパイルできるため、Intel実機やRosettaは不要。開発中の
# 高速な単一アーキテクチャビルドが必要な場合だけ、第1引数に "arm64"/"x86_64" を渡す。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" == "--clean" ]]; then
  echo "Removing $HOME/.cache/spc2midi/build (VGMTrans のソースキャッシュ ~/.cache/spc2midi/_deps は保持)"
  rm -rf "$HOME/.cache/spc2midi/build"
  exit 0
fi

case "${1:-universal}" in
  universal) PRESET="macos-universal" ;;
  arm64) PRESET="macos-arm64" ;;
  x86_64) PRESET="macos-x86_64" ;;
  *) echo "error: unknown arch '$1' (expected universal, arm64, or x86_64)" >&2; exit 1 ;;
esac
BUILD_DIR="$HOME/.cache/spc2midi/build/$PRESET"

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

# ld only ever auto-signs the arm64 slice (required for it to execute at all
# on Apple Silicon); the x86_64 slice comes out of the linker completely
# unsigned on this host. Sign both slices explicitly and fail the build if
# either one doesn't come out valid, so an unsigned x86_64 slice can never
# reach the committed binary silently.
codesign --force --sign - "$SCRIPT_DIR/spc2midi"
codesign --verify --strict --arch arm64 "$SCRIPT_DIR/spc2midi"
if [[ "$PRESET" == "macos-universal" || "$PRESET" == "macos-x86_64" ]]; then
  codesign --verify --strict --arch x86_64 "$SCRIPT_DIR/spc2midi"
fi

echo "-> $SCRIPT_DIR/spc2midi"
