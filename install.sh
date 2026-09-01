#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'USAGE'
Usage: ./install.sh

Installs the macOS dependencies, Python virtual environment, and Node.js
runtime dependencies needed by miditrack.

Requires Homebrew. It installs Python, FluidSynth, Node.js, ffmpeg, and
Rubber Band.

The bundled converter and native-helper binaries require an Apple Silicon Mac.
FluidSynth's standard SoundFont is used by default. To use a custom SoundFont,
place its .sf2/.sf3 file in soundfonts/ after setup.
USAGE
}

fail() {
    printf '✗ %s\n' "$*" >&2
    exit 1
}

if [[ -t 1 ]]; then
    C_CYAN='\033[36m'
    C_RESET='\033[0m'
else
    C_CYAN=''
    C_RESET=''
fi

info_line() {
    printf '%b▶ %s%b\n' "$C_CYAN" "$*" "$C_RESET"
}

success_line() {
    printf '%b✓ %s%b\n' "$C_CYAN" "$*" "$C_RESET"
}

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

validate_command_link() {
    if [[ -L "$COMMAND_LINK" && "$(readlink "$COMMAND_LINK")" == "$LAUNCHER_PATH" ]]; then
        return
    fi
    if [[ -e "$COMMAND_LINK" || -L "$COMMAND_LINK" ]]; then
        fail "既存のmiditrackコマンドを上書きしません: $COMMAND_LINK"
    fi
    [[ -d "$(dirname "$COMMAND_LINK")" && -w "$(dirname "$COMMAND_LINK")" ]] \
        || fail "コマンドリンクの作成先へ書き込めません: $(dirname "$COMMAND_LINK")"
}

install_command_link() {
    if [[ -L "$COMMAND_LINK" && "$(readlink "$COMMAND_LINK")" == "$LAUNCHER_PATH" ]]; then
        success_line "miditrackコマンドは設定済みです: $COMMAND_LINK"
        return
    fi
    ln -s "$LAUNCHER_PATH" "$COMMAND_LINK"
    success_line "miditrackコマンドを作成しました: $COMMAND_LINK"
}

install_brew_formula() {
    local formula_name="$1"

    info_line "Homebrew依存をインストールしています: $formula_name"
    if ! brew install "$formula_name"; then
        printf '⚠ %sの導入に失敗しました。既存の別tap版を利用できる場合は続行します。\n' \
            "$formula_name" >&2
    fi
}

case "${1:-}" in
    "") ;;
    -h|--help)
        usage
        exit 0
        ;;
    *)
        usage >&2
        fail "install.shは引数を受け取りません"
        ;;
esac

INSTALL_PATH="$(resolve_script_path "${BASH_SOURCE[0]}")"
REPOSITORY_DIR="$(cd -P "$(dirname "$INSTALL_PATH")" >/dev/null 2>&1 && pwd)"
PACKAGE_DIR="$REPOSITORY_DIR/miditrack"
VGM_DIR="$REPOSITORY_DIR/vgm2midi"
VIRTUAL_ENV_DIR="$PACKAGE_DIR/.venv"
LAUNCHER_PATH="$PACKAGE_DIR/miditrack.sh"
COMMAND_LINK="/opt/homebrew/bin/miditrack"

[[ "$(uname -m)" == "arm64" ]] || fail "同梱バイナリはApple Silicon専用です。このMacでは利用できません"
[[ -f "$PACKAGE_DIR/pyproject.toml" ]] || fail "miditrackパッケージが見つかりません: $PACKAGE_DIR"
[[ -f "$VGM_DIR/package-lock.json" ]] || fail "vgm2midiのpackage-lock.jsonが見つかりません: $VGM_DIR"
[[ -x "$LAUNCHER_PATH" ]] || fail "miditrack起動ラッパーが実行可能ではありません: $LAUNCHER_PATH"
command -v brew >/dev/null 2>&1 || fail "Homebrewが必要です: https://brew.sh/"
validate_command_link

for formula_name in python fluid-synth node ffmpeg rubberband; do
    install_brew_formula "$formula_name"
done

command -v python3 >/dev/null 2>&1 || fail "python3が見つかりません。HomebrewのPythonをPATHへ追加してください"
command -v npm >/dev/null 2>&1 || fail "npmが見つかりません。HomebrewのNode.jsをPATHへ追加してください"
command -v fluidsynth >/dev/null 2>&1 || fail "fluidsynthが見つかりません。FluidSynthをPATHへ追加してください"
command -v ffmpeg >/dev/null 2>&1 || fail "ffmpegが見つかりません。利用可能なffmpegをPATHへ追加してください"
command -v rubberband >/dev/null 2>&1 || fail "rubberbandが見つかりません。Rubber BandをPATHへ追加してください"
python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' \
    || fail "Python 3.10以上が必要です"

info_line "Python仮想環境をセットアップしています"
python3 -m venv "$VIRTUAL_ENV_DIR"
"$VIRTUAL_ENV_DIR/bin/python" -m pip install --upgrade pip
"$VIRTUAL_ENV_DIR/bin/python" -m pip install -e "$PACKAGE_DIR"

info_line "VGM変換用のNode.js依存をセットアップしています"
npm --prefix "$VGM_DIR" ci --omit=dev
install_command_link

printf '\n'
success_line "セットアップが完了しました"
printf '  起動: miditrack\n'
printf '  カスタムSoundFont: %s/soundfonts/ に.sf2または.sf3を配置してください\n' "$REPOSITORY_DIR"
