#!/usr/bin/env bash
set -euo pipefail

# Assemble the exact application payload used by install.sh and release_app.sh.

script_dir="$(cd -P "$(dirname "$0")" >/dev/null 2>&1 && pwd)"
repo_dir="$(cd -P "$script_dir/.." >/dev/null 2>&1 && pwd)"
source "$script_dir/runtime-manifest.env"
node_entitlements="$script_dir/entitlements-node.plist"
output_dir=""

usage() {
  echo "Usage: scripts/build_app_bundle.sh --output /absolute/path/miditrack.app" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) output_dir="$2"; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done

[[ "$output_dir" == /* && "$output_dir" == *.app ]] || { usage; exit 2; }
[[ "$(uname -m)" == arm64 ]] || { echo "Apple Silicon is required" >&2; exit 1; }
command -v uv >/dev/null 2>&1 || { echo "uv is required to assemble the pinned Python runtime" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v xcrun >/dev/null 2>&1 || { echo "Xcode Command Line Tools are required" >&2; exit 1; }
[[ -f "$node_entitlements" ]] || { echo "Node entitlements file is missing: $node_entitlements" >&2; exit 1; }
[[ ! -e "$output_dir" ]] || { echo "output already exists: $output_dir" >&2; exit 1; }

version="$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' "$repo_dir/miditrack/src/miditrack/__init__.py")"
[[ -n "$version" ]] || { echo "cannot determine miditrack version" >&2; exit 1; }
for helper in nsf2midi/nsf2midi spc2midi/spc2midi vgm2midi/native/bin/vgm2midi_stems; do
  [[ -x "$repo_dir/$helper" ]] || { echo "missing executable helper: $helper" >&2; exit 1; }
done
if nm -gU "$repo_dir/spc2midi/spc2midi" 2>/dev/null | grep -q 'ar_open_rar_archive'; then
  echo "spc2midi still contains RSN/unarr symbols; rebuild it before packaging" >&2
  exit 1
fi

work_dir="$(mktemp -d /tmp/miditrack-app-build.XXXXXX)"
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT
export UV_CACHE_DIR="$work_dir/uv-cache"
python_dir="$work_dir/python"
UV_PYTHON_INSTALL_DIR="$python_dir" uv python install "$PYTHON_VERSION"
python_bin="$(find "$python_dir" -type f -path '*/bin/python3*' ! -name '*-config' -perm -111 -print -quit)"
[[ -n "$python_bin" ]] || { echo "pinned Python was not installed" >&2; exit 1; }
build_venv="$work_dir/build-venv"
uv venv "$build_venv" --python "$python_bin"
uv export --project "$repo_dir/miditrack" --locked --no-dev --extra build --no-emit-project \
  --format requirements-txt | uv pip sync --python "$build_venv/bin/python" -

node_archive="$work_dir/node.tar.gz"
curl --fail --location --silent --show-error "$NODE_URL" --output "$node_archive"
echo "$NODE_SHA256  $node_archive" | shasum -a 256 -c -
tar -xzf "$node_archive" -C "$work_dir"
node_root="$work_dir/node-v${NODE_VERSION}-darwin-arm64"
[[ -x "$node_root/bin/node" ]] || { echo "pinned Node runtime is incomplete" >&2; exit 1; }

bundle_contents="$output_dir/Contents"
mkdir -p "$bundle_contents/MacOS" "$bundle_contents/Helpers" "$bundle_contents/Resources"
project_root="$bundle_contents/Resources/project"
mkdir -p "$project_root"
rsync -a --delete --exclude .venv --exclude __pycache__ --exclude tests --exclude build \
  "$repo_dir/miditrack/" "$project_root/miditrack/"
rsync -a --delete --exclude node_modules --exclude build \
  "$repo_dir/vgm2midi/" "$project_root/vgm2midi/"
rsync -a --delete --exclude build "$repo_dir/nsf2midi/" "$project_root/nsf2midi/"
rsync -a --delete --exclude build "$repo_dir/spc2midi/" "$project_root/spc2midi/"
(cd "$project_root/vgm2midi" && "$node_root/bin/npm" ci --omit=dev)

pyinstaller_args=(--noconfirm --clean --onedir --name miditrack-backend
  --paths "$repo_dir/miditrack/src" --collect-data miditrack
  --distpath "$work_dir/pyinstaller-dist" --workpath "$work_dir/pyinstaller-work"
  --specpath "$work_dir" "$repo_dir/miditrack/src/miditrack/frozen_entry.py")
(cd "$work_dir" && "$build_venv/bin/python" -m PyInstaller "${pyinstaller_args[@]}")
mkdir -p "$bundle_contents/Resources/runtime"
mv "$work_dir/pyinstaller-dist/miditrack-backend" "$bundle_contents/Resources/runtime/backend"

cp "$node_root/bin/node" "$bundle_contents/Helpers/node"
cp "$repo_dir/nsf2midi/nsf2midi" "$bundle_contents/Helpers/nsf2midi"
cp "$repo_dir/spc2midi/spc2midi" "$bundle_contents/Helpers/spc2midi"
cp "$repo_dir/vgm2midi/native/bin/vgm2midi_stems" "$bundle_contents/Helpers/vgm2midi_stems"
chmod +x "$bundle_contents/Helpers/"{node,nsf2midi,spc2midi,vgm2midi_stems}

xcrun swiftc -O -whole-module-optimization -target arm64-apple-macos13.0 \
  "$repo_dir/miditrack/miditrack_app.swift" -o "$bundle_contents/MacOS/miditrack"

cat > "$bundle_contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleName</key><string>miditrack</string>
<key>CFBundleDisplayName</key><string>miditrack</string>
<key>CFBundleIdentifier</key><string>com.nihondo.miditrack</string>
<key>CFBundleExecutable</key><string>miditrack</string>
<key>CFBundleIconFile</key><string>miditrack</string>
<key>CFBundleShortVersionString</key><string>$version</string>
<key>CFBundleVersion</key><string>$version</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>CFBundleDocumentTypes</key><array>
<dict><key>CFBundleTypeName</key><string>miditrack Project</string><key>CFBundleTypeRole</key><string>Editor</string><key>LSHandlerRank</key><string>Owner</string><key>LSItemContentTypes</key><array><string>com.nihondo.miditrack.project</string></array></dict>
<dict><key>CFBundleTypeName</key><string>MIDI File</string><key>CFBundleTypeRole</key><string>Viewer</string><key>LSHandlerRank</key><string>Alternate</string><key>LSItemContentTypes</key><array><string>public.midi-audio</string></array></dict>
<dict><key>CFBundleTypeName</key><string>Chiptune Source File</string><key>CFBundleTypeRole</key><string>Viewer</string><key>LSHandlerRank</key><string>Alternate</string><key>LSItemContentTypes</key><array><string>com.nihondo.miditrack.nsf</string><string>com.nihondo.miditrack.nsfe</string><string>com.nihondo.miditrack.spc</string><string>com.nihondo.miditrack.spc2</string><string>com.nihondo.miditrack.vgm</string><string>com.nihondo.miditrack.vgz</string></array></dict>
<dict><key>CFBundleTypeName</key><string>ZIP Archive</string><key>CFBundleTypeRole</key><string>Viewer</string><key>LSHandlerRank</key><string>Alternate</string><key>LSItemContentTypes</key><array><string>public.zip-archive</string></array></dict>
</array>
<key>UTExportedTypeDeclarations</key><array>
<dict><key>UTTypeIdentifier</key><string>com.nihondo.miditrack.project</string><key>UTTypeDescription</key><string>miditrack Project</string><key>UTTypeConformsTo</key><array><string>public.data</string><string>public.archive</string></array><key>UTTypeTagSpecification</key><dict><key>public.filename-extension</key><array><string>miditrack</string></array><key>public.mime-type</key><string>application/vnd.miditrack.project+zip</string></dict></dict>
</array>
<key>UTImportedTypeDeclarations</key><array>
<dict><key>UTTypeIdentifier</key><string>com.nihondo.miditrack.nsf</string><key>UTTypeDescription</key><string>NSF File</string><key>UTTypeConformsTo</key><array><string>public.data</string></array><key>UTTypeTagSpecification</key><dict><key>public.filename-extension</key><array><string>nsf</string></array></dict></dict>
<dict><key>UTTypeIdentifier</key><string>com.nihondo.miditrack.nsfe</string><key>UTTypeDescription</key><string>NSFE File</string><key>UTTypeConformsTo</key><array><string>public.data</string></array><key>UTTypeTagSpecification</key><dict><key>public.filename-extension</key><array><string>nsfe</string></array></dict></dict>
<dict><key>UTTypeIdentifier</key><string>com.nihondo.miditrack.spc</string><key>UTTypeDescription</key><string>SPC File</string><key>UTTypeConformsTo</key><array><string>public.data</string></array><key>UTTypeTagSpecification</key><dict><key>public.filename-extension</key><array><string>spc</string></array></dict></dict>
<dict><key>UTTypeIdentifier</key><string>com.nihondo.miditrack.spc2</string><key>UTTypeDescription</key><string>SPC2 File</string><key>UTTypeConformsTo</key><array><string>public.data</string></array><key>UTTypeTagSpecification</key><dict><key>public.filename-extension</key><array><string>spc2</string></array></dict></dict>
<dict><key>UTTypeIdentifier</key><string>com.nihondo.miditrack.vgm</string><key>UTTypeDescription</key><string>VGM File</string><key>UTTypeConformsTo</key><array><string>public.data</string></array><key>UTTypeTagSpecification</key><dict><key>public.filename-extension</key><array><string>vgm</string></array></dict></dict>
<dict><key>UTTypeIdentifier</key><string>com.nihondo.miditrack.vgz</string><key>UTTypeDescription</key><string>VGZ File</string><key>UTTypeConformsTo</key><array><string>public.data</string></array><key>UTTypeTagSpecification</key><dict><key>public.filename-extension</key><array><string>vgz</string></array></dict></dict>
</array>
</dict></plist>
PLIST

# Embed only the 1024px source (the ICNS `ic10` representation). Finder then
# scales the same artwork for compact list views instead of selecting a
# separately downsampled representation with a visible light frame.
icon_source="$repo_dir/images/miditrack_icon.png"
icon_output="$bundle_contents/Resources/miditrack.icns"
icon_png_bytes="$(stat -f %z "$icon_source")"
icon_total_bytes=$((icon_png_bytes + 16))
{
  printf 'icns'
  printf '%08x' "$icon_total_bytes" | /usr/bin/xxd -r -p
  printf 'ic10'
  printf '%08x' $((icon_png_bytes + 8)) | /usr/bin/xxd -r -p
  cat "$icon_source"
} > "$icon_output"

git_commit="$(git -C "$repo_dir" rev-parse HEAD)"
python_lock_hash="$(shasum -a 256 "$repo_dir/miditrack/uv.lock" | awk '{print $1}')"
node_lock_hash="$(shasum -a 256 "$repo_dir/vgm2midi/package-lock.json" | awk '{print $1}')"
nsf2midi_hash="$(shasum -a 256 "$repo_dir/nsf2midi/nsf2midi" | awk '{print $1}')"
spc2midi_hash="$(shasum -a 256 "$repo_dir/spc2midi/spc2midi" | awk '{print $1}')"
vgm_stems_hash="$(shasum -a 256 "$repo_dir/vgm2midi/native/bin/vgm2midi_stems" | awk '{print $1}')"
cat > "$bundle_contents/Resources/BUILD-MANIFEST.json" <<JSON
{"gitCommit":"$git_commit","miditrackVersion":"$version","pythonVersion":"$PYTHON_VERSION","pyInstallerVersion":"$PYINSTALLER_VERSION","pythonLockSha256":"$python_lock_hash","nodeVersion":"$NODE_VERSION","nodeSha256":"$NODE_SHA256","nodeLockSha256":"$node_lock_hash","helpers":{"nsf2midi":"$nsf2midi_hash","spc2midi":"$spc2midi_hash","vgm2midiStems":"$vgm_stems_hash"}}
JSON
printf '%s\n' 'miditrack app bundle (generated by build_app_bundle.sh)' > "$bundle_contents/Resources/.installed-by-install-sh"
while IFS= read -r -d '' candidate; do
  if file -b "$candidate" | grep -q 'Mach-O'; then
    if [[ "$candidate" == "$bundle_contents/Helpers/node" ]]; then
      codesign --force --options runtime --entitlements "$node_entitlements" --sign - "$candidate"
    else
      codesign --force --sign - "$candidate"
    fi
  fi
done < <(find "$bundle_contents" -type f -print0)
codesign --force --sign - "$output_dir"
