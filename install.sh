#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./install.sh

Builds the same arm64 miditrack.app payload used for release distribution and
installs it into ~/Applications. Homebrew is used only for FluidSynth, ffmpeg,
and Rubber Band.
USAGE
}

fail() { printf '✗ %s\n' "$*" >&2; exit 1; }
info() { printf '▶ %s\n' "$*"; }
ok() { printf '✓ %s\n' "$*"; }

resolve_script_path() {
  local source_path="$1" source_dir link_target
  while [[ -L "$source_path" ]]; do
    source_dir="$(cd -P "$(dirname "$source_path")" >/dev/null 2>&1 && pwd)"
    link_target="$(readlink "$source_path")"
    [[ "$link_target" == /* ]] && source_path="$link_target" || source_path="$source_dir/$link_target"
  done
  source_dir="$(cd -P "$(dirname "$source_path")" >/dev/null 2>&1 && pwd)"
  printf '%s/%s\n' "$source_dir" "$(basename "$source_path")"
}

case "${1:-}" in
  "") ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; fail "install.shは引数を受け取りません" ;;
esac

install_path="$(resolve_script_path "${BASH_SOURCE[0]}")"
repository_dir="$(cd -P "$(dirname "$install_path")" >/dev/null 2>&1 && pwd)"
app_dir="$HOME/Applications/miditrack.app"
command_link="/opt/homebrew/bin/miditrack"
cli_path="$app_dir/Contents/Resources/project/miditrack/miditrack.sh"
marker_path="$app_dir/Contents/Resources/.installed-by-install-sh"

[[ "$(uname -m)" == arm64 ]] || fail "miditrack.appはApple Silicon専用です"
[[ -x "$repository_dir/scripts/build_app_bundle.sh" ]] || fail "アプリ組み立てスクリプトが見つかりません"
command -v brew >/dev/null 2>&1 || fail "Homebrewが必要です: https://brew.sh/"
command -v uv >/dev/null 2>&1 || fail "固定Pythonランタイムの組み立てにuvが必要です: brew install uv"

if [[ -e "$app_dir" || -L "$app_dir" ]]; then
  [[ -f "$marker_path" && ! -L "$app_dir" ]] || fail "既存のmiditrack.appを上書きしません: $app_dir"
  fail "既存のmiditrack.appを安全に置き換えられません。先にアプリを終了してから手動で退避してください: $app_dir"
fi
if [[ -e "$command_link" || -L "$command_link" ]]; then
  [[ -L "$command_link" && "$(readlink "$command_link")" == "$cli_path" ]] || fail "既存のmiditrackコマンドを上書きしません: $command_link"
fi

for formula in fluid-synth ffmpeg rubberband; do
  info "Homebrew依存をインストールしています: $formula"
  brew install "$formula"
done

mkdir -p "$HOME/Applications"
info "配布版と同じmiditrack.appを組み立てています"
"$repository_dir/scripts/build_app_bundle.sh" --output "$app_dir"

if [[ ! -e "$command_link" ]]; then
  [[ -w "$(dirname "$command_link")" ]] || fail "コマンドリンクの作成先へ書き込めません: $(dirname "$command_link")"
  ln -s "$cli_path" "$command_link"
fi

ok "miditrack.appを作成しました: $app_dir"
printf '  起動: "%s"\n' "$app_dir"
printf '  CLI: miditrack\n'
printf '  SoundFont: mkdir -p "$HOME/Library/Audio/Sounds/Banks"\n'
printf '             .sf2または.sf3をそのディレクトリへ配置してください\n'
