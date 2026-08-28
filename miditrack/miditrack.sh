#!/bin/bash
set -euo pipefail

resolve_script_path() {
    local source_path="$1"
    local source_dir
    local link_target

    while [[ -L "$source_path" ]]; do
        source_dir="$(cd -P "$(dirname "$source_path")" >/dev/null 2>&1 && pwd)"
        link_target="$(readlink "$source_path")"
        if [[ "$link_target" == /* ]]; then
            source_path="$link_target"
        else
            source_path="$source_dir/$link_target"
        fi
    done

    source_dir="$(cd -P "$(dirname "$source_path")" >/dev/null 2>&1 && pwd)"
    printf '%s/%s\n' "$source_dir" "$(basename "$source_path")"
}

WRAPPER_PATH="$(resolve_script_path "${BASH_SOURCE[0]}")"
MIDITRACK_DIR="$(cd -P "$(dirname "$WRAPPER_PATH")" >/dev/null 2>&1 && pwd)"
VIRTUAL_ENV_DIR="$MIDITRACK_DIR/.venv"
CLI_PATH="$VIRTUAL_ENV_DIR/bin/miditrack"

if [[ ! -x "$CLI_PATH" ]]; then
    printf '✗ miditrack用Python環境がありません: %s\n' "$VIRTUAL_ENV_DIR" >&2
    printf '  miditrack/README_ja.mdの「インストール」に従って作成してください。\n' >&2
    exit 1
fi

export VIRTUAL_ENV="$VIRTUAL_ENV_DIR"
export PATH="$VIRTUAL_ENV_DIR/bin:${PATH:-/usr/bin:/bin}"
export PYTHONNOUSERSITE=1
unset PYTHONHOME || true

exec "$CLI_PATH" "$@"
