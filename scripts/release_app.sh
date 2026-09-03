#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -P "$(dirname "$0")" >/dev/null 2>&1 && pwd)"
repo_dir="$(cd -P "$script_dir/.." >/dev/null 2>&1 && pwd)"
identity="${MIDITRACK_SIGNING_IDENTITY:?set MIDITRACK_SIGNING_IDENTITY to a Developer ID Application identity}"
profile="${MIDITRACK_NOTARY_PROFILE:?set MIDITRACK_NOTARY_PROFILE to a notarytool keychain profile}"
version="$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' "$repo_dir/miditrack/src/miditrack/__init__.py")"
dist_dir="$repo_dir/dist"
app_path="$dist_dir/miditrack.app"
zip_path="$dist_dir/miditrack-${version}-macos-arm64.zip"

mkdir -p "$dist_dir"
[[ ! -e "$app_path" ]] || { echo "remove or archive existing $app_path first" >&2; exit 1; }
"$script_dir/build_app_bundle.sh" --output "$app_path"

# Sign nested Mach-O code before sealing the outer bundle. Scripts and data in
# Resources are sealed by the app signature and do not receive xattr signatures.
while IFS= read -r -d '' candidate; do
  if file -b "$candidate" | grep -q 'Mach-O'; then
    codesign --force --options runtime --timestamp --sign "$identity" "$candidate"
  fi
done < <(find "$app_path/Contents" -type f -print0)
codesign --force --options runtime --timestamp --sign "$identity" "$app_path"
codesign --verify --deep --strict --verbose=4 "$app_path"

ditto -c -k --keepParent "$app_path" "$zip_path"
xcrun notarytool submit "$zip_path" --keychain-profile "$profile" --wait
xcrun stapler staple "$app_path"
xcrun stapler validate "$app_path"
spctl --assess --type execute --verbose=4 "$app_path"
rm -f "$zip_path"
ditto -c -k --keepParent "$app_path" "$zip_path"
git -C "$repo_dir" archive --format=zip --output "$dist_dir/miditrack-${version}-source.zip" HEAD
