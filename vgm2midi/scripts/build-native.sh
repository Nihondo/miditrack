#!/usr/bin/env bash
set -euo pipefail

# All mutable native state stays outside the cloud-synchronised checkout.
cache_dir="${VGM2MIDI_NATIVE_CACHE:-/tmp/vgm2midi-libvgm}"
source_dir="${VGM2MIDI_LIBVGM_SOURCE:-$cache_dir/source}"
build_dir="${VGM2MIDI_NATIVE_BUILD:-/tmp/vgm2midi-native-build}"
commit="57585ea"
is_offline="${VGM2MIDI_NATIVE_OFFLINE:-0}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"

for mutable_path in "$cache_dir" "$source_dir" "$build_dir"; do
  case "$mutable_path" in
    "$project_dir"|"$project_dir"/*)
      echo "native cache/source/build must be outside the Dropbox checkout: $mutable_path" >&2
      exit 2
      ;;
  esac
done

if [[ -e "$source_dir" && ! -d "$source_dir/.git" ]]; then
  echo "libvgm source exists but is not a git checkout: $source_dir" >&2
  exit 2
fi
if [[ ! -d "$source_dir/.git" ]]; then
  if [[ "$is_offline" == "1" ]]; then
    echo "libvgm source cache is absent in offline mode: $source_dir" >&2
    exit 2
  fi
  mkdir -p "$(dirname "$source_dir")"
  git clone https://github.com/ValleyBell/libvgm.git "$source_dir"
fi

# Reuse a cached object/HEAD without touching the network. Fetch only when the
# requested pin is genuinely absent from the local object database.
if ! git -C "$source_dir" cat-file -e "${commit}^{commit}" 2>/dev/null; then
  if [[ "$is_offline" == "1" ]]; then
    echo "libvgm source cache exists but pin $commit is absent in offline mode: $source_dir" >&2
    exit 2
  fi
  git -C "$source_dir" fetch --quiet origin "$commit"
fi
git -C "$source_dir" checkout --quiet --detach "$commit"
resolved_commit="$(git -C "$source_dir" rev-parse HEAD)"
if [[ "$resolved_commit" != "$commit"* ]]; then
  echo "libvgm checkout does not match pin $commit: $resolved_commit" >&2
  exit 2
fi
if ! grep -Fq "GIT_TAG $commit" "$project_dir/native/CMakeLists.txt"; then
  echo "native CMake pin does not match $commit" >&2
  exit 2
fi

cmake -S "$project_dir/native" -B "$build_dir" -G Ninja \
  -DFETCHCONTENT_SOURCE_DIR_LIBVGM="$source_dir" \
  -DVGM2MIDI_NATIVE_CACHE="$cache_dir"
cmake --build "$build_dir" --target vgm2midi_stems
echo "$build_dir/vgm2midi_stems"
