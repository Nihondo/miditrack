#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'USAGE'
Usage: ./install.sh

Installs the macOS dependencies, Python virtual environment, and Node.js
runtime dependencies needed by miditrack.

Requires Homebrew and Xcode Command Line Tools. It installs Python, FluidSynth,
Node.js, ffmpeg, and Rubber Band. It also creates ~/Applications/miditrack.app,
a WKWebView shell (driven by a #!/usr/bin/swift script) so miditrack can be
launched from the Dock.

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

validate_app_bundle() {
    if [[ -e "$APP_BUNDLE_DIR" || -L "$APP_BUNDLE_DIR" ]]; then
        # install.shが生成したものだけを上書き対象にする
        # （COMMAND_LINKと同じく、他人が置いた同名のバンドルを壊さない）。
        # 実行ファイルはコンパイル済みバイナリなのでテキストマーカーを
        # 埋め込みづらく、代わりに専用の隠しマーカーファイルの有無で
        # install.sh生成物かどうかを判定する。
        [[ -d "$APP_BUNDLE_DIR" && ! -L "$APP_BUNDLE_DIR" ]] \
            || fail "既存のmiditrack.appを上書きしません: $APP_BUNDLE_DIR"
        [[ -f "$APP_BUNDLE_DIR/Contents/$APP_BUNDLE_MARKER_FILE" ]] \
            || fail "既存のmiditrack.appを上書きしません: $APP_BUNDLE_DIR"
    fi
    [[ -d "$HOME/Applications" ]] || mkdir -p "$HOME/Applications" 2>/dev/null \
        || fail "アプリケーションの設置先を作成できません: $HOME/Applications"
    [[ -w "$HOME/Applications" ]] \
        || fail "アプリケーションの設置先へ書き込めません: $HOME/Applications"
}

install_app_bundle() {
    info_line "Dockから起動するmiditrack.appを作成しています"
    mkdir -p "$APP_BUNDLE_DIR/Contents/MacOS" "$APP_BUNDLE_DIR/Contents/Resources"

    cat >"$APP_BUNDLE_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleName</key><string>miditrack</string>
  <key>CFBundleDisplayName</key><string>miditrack</string>
  <key>CFBundleIdentifier</key><string>com.nihondo.miditrack</string>
  <key>CFBundleExecutable</key><string>miditrack</string>
  <key>CFBundleIconFile</key><string>miditrack</string>
  <key>CFBundleShortVersionString</key><string>$MIDITRACK_VERSION</string>
  <key>CFBundleVersion</key><string>$MIDITRACK_VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST

    # 実行ファイルはシバンスクリプトへのシンボリックリンクではなく、
    # miditrack_app.swiftをコンパイルしたバイナリそのものを$HOME/Applications
    # 配下に直接置く。理由: .appの実行可能ファイル自体がDropbox配下
    # （~/Library/CloudStorage/、TCP保護対象）にあると、execve()でその
    # ファイルをプロセスイメージとしてロードする最初の一歩そのものが、
    # TCCにより「プロンプトを出す前提条件を満たさない」として無条件に
    # 拒否される（"would require prompt"というサンドボックスログを実機で
    # 確認。ターミナルなど既に許可を持つプロセス経由の実行は成功するため、
    # バックエンド起動のタイミングではなく実行可能ファイルの所在そのものが
    # 原因）。コンパイル済みバイナリを$HOME/Applications配下（TCC非対象）に
    # 置くことで、execveされる対象自体をDropboxの外に出す。
    # #filePathはコンパイル時にコンパイラへ渡したソースパス（$APP_LAUNCHER_PATH、
    # リポジトリ内の絶対パス）がバイナリへ埋め込まれるため、実行時にも
    # miditrack.sh/アイコンの位置を正しく解決できる。
    xcrun swiftc -O "$APP_LAUNCHER_PATH" -o "$APP_BUNDLE_DIR/Contents/MacOS/miditrack" \
        || fail "miditrack_app.swiftのコンパイルに失敗しました"
    printf '%s\n' "$APP_BUNDLE_MARKER" > "$APP_BUNDLE_DIR/Contents/$APP_BUNDLE_MARKER_FILE"

    local iconset_dir
    iconset_dir="$(mktemp -d)/miditrack.iconset"
    mkdir -p "$iconset_dir"
    sips -z 16 16     "$APP_ICON_SOURCE" --out "$iconset_dir/icon_16x16.png"      >/dev/null
    sips -z 32 32     "$APP_ICON_SOURCE" --out "$iconset_dir/icon_16x16@2x.png"   >/dev/null
    sips -z 32 32     "$APP_ICON_SOURCE" --out "$iconset_dir/icon_32x32.png"      >/dev/null
    sips -z 64 64     "$APP_ICON_SOURCE" --out "$iconset_dir/icon_32x32@2x.png"   >/dev/null
    sips -z 128 128   "$APP_ICON_SOURCE" --out "$iconset_dir/icon_128x128.png"    >/dev/null
    sips -z 256 256   "$APP_ICON_SOURCE" --out "$iconset_dir/icon_128x128@2x.png" >/dev/null
    sips -z 256 256   "$APP_ICON_SOURCE" --out "$iconset_dir/icon_256x256.png"    >/dev/null
    sips -z 512 512   "$APP_ICON_SOURCE" --out "$iconset_dir/icon_256x256@2x.png" >/dev/null
    sips -z 512 512   "$APP_ICON_SOURCE" --out "$iconset_dir/icon_512x512.png"    >/dev/null
    sips -z 1024 1024 "$APP_ICON_SOURCE" --out "$iconset_dir/icon_512x512@2x.png" >/dev/null
    iconutil --convert icns "$iconset_dir" --output "$APP_BUNDLE_DIR/Contents/Resources/miditrack.icns"
    rm -rf "$(dirname "$iconset_dir")"

    # 素材側に付いたquarantineが伝播した場合の保険。ローカル生成物には
    # 通常付かないため、対象属性が無くてもエラーにしない。
    xattr -dr com.apple.quarantine "$APP_BUNDLE_DIR" 2>/dev/null || true

    # 未署名のバンドルはmacOSのTCC（プライバシー保護）がアプリを安定して
    # 識別できず、Dropbox配下（~/Library/CloudStorage/）のようなTCC保護対象
    # ディレクトリへの初回アクセス時に、許可ダイアログを出さずに一律で
    # Operation not permittedを返すことがある（実機で確認済み）。アドホック
    # 署名（開発者IDなし、ローカルの一意な識別子だけを与える）を施すことで、
    # TCCが同じアプリとして安定して識別し、初回アクセス時に正しく許可ダイアログ
    # を出せるようにする。codesignが無い環境（Xcode Command Line Toolsはインス
    # トール済みのはずだが念のため）ではスキップし、致命的エラーにはしない。
    if command -v codesign >/dev/null 2>&1; then
        codesign --force --deep --sign - "$APP_BUNDLE_DIR" 2>/dev/null || true
    fi

    touch "$APP_BUNDLE_DIR"

    success_line "miditrack.appを作成しました: $APP_BUNDLE_DIR"
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
APP_BUNDLE_DIR="$HOME/Applications/miditrack.app"
APP_LAUNCHER_PATH="$PACKAGE_DIR/miditrack_app.swift"
APP_ICON_SOURCE="$REPOSITORY_DIR/images/miditrack_icon.png"
APP_BUNDLE_MARKER="miditrack app bundle (generated by install.sh)"
APP_BUNDLE_MARKER_FILE=".installed-by-install-sh"

[[ "$(uname -m)" == "arm64" ]] || fail "同梱バイナリはApple Silicon専用です。このMacでは利用できません"
[[ -f "$PACKAGE_DIR/pyproject.toml" ]] || fail "miditrackパッケージが見つかりません: $PACKAGE_DIR"
[[ -f "$VGM_DIR/package-lock.json" ]] || fail "vgm2midiのpackage-lock.jsonが見つかりません: $VGM_DIR"
[[ -x "$LAUNCHER_PATH" ]] || fail "miditrack起動ラッパーが実行可能ではありません: $LAUNCHER_PATH"
[[ -x "$APP_LAUNCHER_PATH" ]] || fail "miditrack.app用のSwiftランチャーが実行可能ではありません: $APP_LAUNCHER_PATH"
[[ -f "$APP_ICON_SOURCE" ]] || fail "アプリアイコンの素材が見つかりません: $APP_ICON_SOURCE"
command -v brew >/dev/null 2>&1 || fail "Homebrewが必要です: https://brew.sh/"
command -v sips >/dev/null 2>&1 || fail "sipsが見つかりません（macOS標準のコマンドです）"
command -v iconutil >/dev/null 2>&1 || fail "iconutilが見つかりません（macOS標準のコマンドです）"
xcode-select -p >/dev/null 2>&1 \
    || fail "Xcode Command Line Toolsが必要です。'xcode-select --install' を実行してください"
/usr/bin/swift --version >/dev/null 2>&1 \
    || fail "swiftを実行できません。'xcode-select --install' でCommand Line Toolsを導入してください"
MIDITRACK_VERSION="$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' "$PACKAGE_DIR/src/miditrack/__init__.py")"
[[ -n "$MIDITRACK_VERSION" ]] || fail "miditrackのバージョンを取得できません: $PACKAGE_DIR/src/miditrack/__init__.py"
validate_command_link
validate_app_bundle

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
install_app_bundle

printf '\n'
success_line "セットアップが完了しました"
printf '  起動: miditrack\n'
printf '  Dockから起動: "%s" をダブルクリック（Dockへドラッグして常駐させられます）\n' "$APP_BUNDLE_DIR"
printf '    ウィンドウを閉じるとバックエンドも同時に終了します\n'
printf '  カスタムSoundFont: %s/soundfonts/ に.sf2または.sf3を配置してください\n' "$REPOSITORY_DIR"
