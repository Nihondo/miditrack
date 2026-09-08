#!/usr/bin/env bash

# macOSアプリ内の入れ子になったMach-Oを内側から署名する共通処理。
# このファイルは単体実行せず、build_app_bundle.sh/release_app.shからsourceする。

sign_nested_macho() {
  local bundle_contents="$1"
  local node_path="$2"
  local identity="$3"
  local node_entitlements="$4"
  local should_timestamp="$5"

  while IFS= read -r -d '' candidate; do
    if ! file -b "$candidate" | grep -q 'Mach-O'; then
      continue
    fi

    local codesign_args=(--force)
    if [[ "$should_timestamp" == "true" ]]; then
      codesign_args+=(--options runtime --timestamp)
    elif [[ "$candidate" == "$node_path" ]]; then
      codesign_args+=(--options runtime)
    fi
    if [[ "$candidate" == "$node_path" ]]; then
      codesign_args+=(--entitlements "$node_entitlements")
    fi
    codesign "${codesign_args[@]}" --sign "$identity" "$candidate"
  done < <(find "$bundle_contents" -type f -print0)
}
