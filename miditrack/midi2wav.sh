#!/usr/bin/env bash
set -euo pipefail

# MIDI → WAV レンダリングツール
# fluidsynth + SoundFont を使って .mid ファイルを試聴用 WAV に変換する。

# === デフォルト設定 ===
SAMPLE_RATE=44100
GAIN=""
FORCE=false
VERBOSE=false
DYNAMIC_SAMPLE_LOADING=true
SELECT_MODE=false
SOUNDFONT=""
OUTPUT=""
SOUNDFONT_DIRS=()
CUSTOM_SOUNDFONT_DIRS=()

# シンボリックリンクを再帰的にたどり、実体の絶対パスを返す（realpath 代替）。
resolve_real_path() {
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

# === デフォルトの SoundFont 探索先（先に見つかったものを優先） ===
DEFAULT_SOUNDFONT_DIRS=(
    "$HOME/Library/Audio/Sounds/Banks"
    "/Library/Audio/Sounds/Banks"
    "/opt/homebrew/share/soundfonts"
    "/opt/homebrew/share/fluid-synth/sf2"
)

# === カラー出力 ===
if [[ -t 1 ]]; then
    C_RESET='\033[0m'  C_BOLD='\033[1m'
    C_GREEN='\033[32m' C_RED='\033[31m'
    C_CYAN='\033[36m'  C_YELLOW='\033[33m'
else
    C_RESET='' C_BOLD='' C_GREEN='' C_RED='' C_CYAN='' C_YELLOW=''
fi
info_line()  { echo -e "${C_CYAN}▶${C_RESET} $*"; }
done_line()  { echo -e "${C_GREEN}✓${C_RESET} $*"; }
err_line()   { echo -e "${C_RED}✗ $*${C_RESET}" >&2; }
step_line()  { echo -e "${C_YELLOW}▶${C_RESET} $*"; }

usage() {
    cat <<'USAGE'
Usage: midi2wav.sh [options] <input.mid> [<input2.mid> ...]

fluidsynth + SoundFont を使って .mid ファイルを WAV に変換する。
出力ファイル名は入力の拡張子を .wav に差し替えたもの（song.mid → song.wav）。

Options:
  -s, --soundfont FILE       使用する SoundFont (.sf2/.sf3) を指定
  -S, --select                探索ディレクトリ内の SoundFont を対話選択（TTY必須）
  -d, --soundfont-dir DIR     SoundFont 探索ディレクトリを追加指定（複数指定可、指定時は既定リストを置換）
  -o, --output FILE           出力先ファイルを指定（入力が1つのときのみ）
  -r, --rate HZ                サンプルレート（デフォルト: 44100）
  -g, --gain VALUE             fluidsynth の -g（未指定時は fluidsynth の既定値）
  -f, --force                  既存の出力 WAV を上書き
  -v, --verbose                 fluidsynth の詳細出力を表示（デフォルトは抑制）
      --no-dynamic-sample-loading
                               SoundFontサンプルの動的読込を無効化
  -h, --help                    このヘルプを表示

SoundFont の解決順:
  1. -s/--soundfont
  2. -S/--select（対話選択）
  3. MIDI2WAV_SOUNDFONT 環境変数
  4. 探索ディレクトリ（既定は下記、-d 指定時は置換）を順に見て最初に見つかった *.sf2/*.sf3

既定の探索ディレクトリ:
  ~/Library/Audio/Sounds/Banks
  /Library/Audio/Sounds/Banks
  /opt/homebrew/share/soundfonts
  /opt/homebrew/share/fluid-synth/sf2

例:
  midi2wav.sh song.mid                     # デフォルト SoundFont で song.wav
  midi2wav.sh -S song.mid                   # SoundFont を対話選択
  midi2wav.sh -s MySound.sf2 -f song.mid    # SoundFont 指定 + 上書き
  midi2wav.sh a.mid b.mid c.mid             # 複数ファイルをまとめて変換

依存: fluidsynth
USAGE
    exit 1
}

# ファイル名から最後の拡張子を除いたパスを返す。
get_path_stem() {
    local filename="$1"
    local stem="${filename%.*}"

    [[ -n "$stem" ]] || stem="$filename"
    printf '%s' "$stem"
}

# ディレクトリ内の SoundFont（*.sf2, *.sf3）をファイル名ソートで列挙する。
list_soundfonts_in_dir() {
    local dir="$1"
    local f

    [[ -d "$dir" ]] || return 0
    for f in "$dir"/*.sf2 "$dir"/*.sf3; do
        [[ -f "$f" ]] && printf '%s\n' "$f"
    done
}

# 探索ディレクトリ群から見つかる SoundFont を全て列挙する（ディレクトリ順、ディレクトリ内はファイル名順）。
# シンボリックリンクはたどるが、実体（realpath）が同じものは最初に見つかった1件のみを残し重複を除く。
collect_available_soundfonts() {
    local dir path real_path seen is_duplicate
    local -a seen_real_paths=()

    for dir in "${SOUNDFONT_DIRS[@]}"; do
        while IFS= read -r path; do
            real_path="$(resolve_real_path "$path")"

            is_duplicate=false
            if [[ ${#seen_real_paths[@]} -gt 0 ]]; then
                for seen in "${seen_real_paths[@]}"; do
                    if [[ "$seen" == "$real_path" ]]; then
                        is_duplicate=true
                        break
                    fi
                done
            fi
            [[ "$is_duplicate" == true ]] && continue

            seen_real_paths+=("$real_path")
            printf '%s\n' "$path"
        done < <(list_soundfonts_in_dir "$dir")
    done
}

# 最初に見つかった SoundFont のパスを返す。
find_first_soundfont() {
    # head -n 1 が1行読んで先に終了すると、上流の collect_available_soundfonts
    # （ループの途中）は SIGPIPE (128+13=141) で終わる。pipefail 有効下ではこれが
    # パイプ全体の終了コードになり、この関数の呼び出し元である
    # `SOUNDFONT="$(find_first_soundfont)"` を set -e が失敗と誤認して
    # スクリプト全体を止めてしまう。head 側で意図的に打ち切っただけなので
    # `|| true` で無視する。
    local first=""
    first="$(collect_available_soundfonts | head -n 1)" || true
    printf '%s' "$first"
}

human_readable_size() {
    local bytes="$1"
    if command -v numfmt &>/dev/null; then
        numfmt --to=iec --suffix=B --format='%.1f' "$bytes" 2>/dev/null || printf '%sB' "$bytes"
    else
        printf '%sB' "$bytes"
    fi
}

# 探索ディレクトリ内の SoundFont を番号付きメニューで対話選択する。
prompt_select_soundfont() {
    local -a candidates=()
    local path size_bytes size_human idx choice

    while IFS= read -r path; do
        candidates+=("$path")
    done < <(collect_available_soundfonts)

    if [[ ${#candidates[@]} -eq 0 ]]; then
        return 1
    fi

    printf '利用可能な SoundFont:\n' >&2
    for idx in "${!candidates[@]}"; do
        path="${candidates[$idx]}"
        size_bytes="$(stat -f '%z' "$path" 2>/dev/null || stat -c '%s' "$path" 2>/dev/null || echo 0)"
        size_human="$(human_readable_size "$size_bytes")"
        printf '  %d) %-30s (%s)  %s\n' "$((idx + 1))" "$(basename "$path")" "$size_human" "$(dirname "$path")" >&2
    done

    while true; do
        printf '番号を選択 [1]: ' >&2
        IFS= read -r choice
        [[ -n "$choice" ]] || choice=1
        if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#candidates[@]} )); then
            printf '%s' "${candidates[$((choice - 1))]}"
            return 0
        fi
        err_line "1〜${#candidates[@]} の番号を入力してください"
    done
}

# --- 引数パース ---
INPUTS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        -s|--soundfont)
            [[ $# -ge 2 ]] || { err_line "--soundfont には SoundFont ファイルが必要です"; exit 1; }
            SOUNDFONT="$2"
            shift 2
            ;;
        -S|--select)     SELECT_MODE=true; shift ;;
        -d|--soundfont-dir)
            [[ $# -ge 2 ]] || { err_line "--soundfont-dir にはディレクトリが必要です"; exit 1; }
            CUSTOM_SOUNDFONT_DIRS+=("$2")
            shift 2
            ;;
        -o|--output)
            [[ $# -ge 2 ]] || { err_line "--output には出力ファイルが必要です"; exit 1; }
            OUTPUT="$2"
            shift 2
            ;;
        -r|--rate)
            [[ $# -ge 2 ]] || { err_line "--rate にはサンプルレートが必要です"; exit 1; }
            SAMPLE_RATE="$2"
            shift 2
            ;;
        -g|--gain)
            [[ $# -ge 2 ]] || { err_line "--gain には値が必要です"; exit 1; }
            GAIN="$2"
            shift 2
            ;;
        -f|--force)      FORCE=true; shift ;;
        -v|--verbose)    VERBOSE=true; shift ;;
        --no-dynamic-sample-loading)
            DYNAMIC_SAMPLE_LOADING=false
            shift
            ;;
        -h|--help)       usage ;;
        -*)              err_line "不明なオプション: $1"; usage ;;
        *)               INPUTS+=("$1"); shift ;;
    esac
done

[[ ${#INPUTS[@]} -eq 0 ]] && { err_line "入力ファイルが指定されていません"; usage; }
if [[ -n "$OUTPUT" && ${#INPUTS[@]} -gt 1 ]]; then
    err_line "--output は入力ファイルが1つのときのみ指定できます"
    exit 1
fi
if [[ ! "$SAMPLE_RATE" =~ ^[1-9][0-9]*$ ]]; then
    err_line "サンプルレートには正の整数を指定してください: $SAMPLE_RATE"
    exit 1
fi

# --- 依存チェック ---
for cmd in fluidsynth; do
    if ! command -v "$cmd" &>/dev/null; then
        err_line "$cmd がインストールされていません"
        exit 1
    fi
done

# --- 探索ディレクトリの確定 ---
if [[ ${#CUSTOM_SOUNDFONT_DIRS[@]} -gt 0 ]]; then
    SOUNDFONT_DIRS=("${CUSTOM_SOUNDFONT_DIRS[@]}")
else
    SOUNDFONT_DIRS=("${DEFAULT_SOUNDFONT_DIRS[@]}")
fi

# --- SoundFont の解決 ---
if [[ -z "$SOUNDFONT" && "$SELECT_MODE" == true ]]; then
    # prompt_select_soundfont() はコマンド置換（サブシェル）内で呼ぶため、
    # その中で exit しても本スクリプトは終了しない。TTY チェックはここで行う。
    if [[ ! -t 0 ]]; then
        err_line "-S/--select は対話端末（TTY）でのみ使用できます"
        exit 1
    fi
    if ! SOUNDFONT="$(prompt_select_soundfont)"; then
        err_line "探索ディレクトリ内に SoundFont (*.sf2/*.sf3) が見つかりません"
        exit 1
    fi
fi

if [[ -z "$SOUNDFONT" && -n "${MIDI2WAV_SOUNDFONT:-}" ]]; then
    SOUNDFONT="$MIDI2WAV_SOUNDFONT"
fi

if [[ -z "$SOUNDFONT" ]]; then
    SOUNDFONT="$(find_first_soundfont)"
fi

if [[ -z "$SOUNDFONT" ]]; then
    err_line "SoundFont が見つかりません"
    printf '  -s/--soundfont で明示指定するか、MIDI2WAV_SOUNDFONT 環境変数を設定するか、\n' >&2
    printf '  次のいずれかに *.sf2 ファイルを配置してください:\n' >&2
    local_dir=""
    for local_dir in "${SOUNDFONT_DIRS[@]}"; do
        printf '    %s\n' "$local_dir" >&2
    done
    exit 1
fi

if [[ ! -f "$SOUNDFONT" ]]; then
    err_line "SoundFont ファイルが見つかりません: $SOUNDFONT"
    exit 1
fi

# --- 変換 ---
FLUIDSYNTH_OPTS=(-ni)
[[ "$VERBOSE" == true ]] || FLUIDSYNTH_OPTS+=(-q)
[[ "$DYNAMIC_SAMPLE_LOADING" == true ]] && FLUIDSYNTH_OPTS+=(-o synth.dynamic-sample-loading=1)
[[ -n "$GAIN" ]] && FLUIDSYNTH_OPTS+=(-g "$GAIN")

info_line "SoundFont: ${C_BOLD}$SOUNDFONT${C_RESET}"

for input in "${INPUTS[@]}"; do
    if [[ ! -f "$input" ]]; then
        err_line "入力ファイルが見つかりません: $input"
        exit 1
    fi

    if [[ -n "$OUTPUT" ]]; then
        output="$OUTPUT"
    else
        output="$(get_path_stem "$input").wav"
    fi

    if [[ -e "$output" && "$FORCE" != true ]]; then
        err_line "出力ファイルが既に存在します（上書きするには -f/--force）: $output"
        exit 1
    fi

    step_line "変換中: ${C_BOLD}$input${C_RESET} → ${C_BOLD}$output${C_RESET}"
    # fluidsynth は "fluidsynth [options] [soundfonts] [midifiles]" の順を要求する。
    # -F/-T/-r 等のオプションは SoundFont/MIDI ファイルより後ろに置けない。
    fluidsynth "${FLUIDSYNTH_OPTS[@]}" -F "$output" -T wav -r "$SAMPLE_RATE" "$SOUNDFONT" "$input"

    if [[ ! -s "$output" ]]; then
        err_line "WAV の書き出しに失敗しました: $output"
        exit 1
    fi

    output_size="$(stat -f '%z' "$output" 2>/dev/null || stat -c '%s' "$output" 2>/dev/null || echo 0)"
    if (( output_size <= 44 )); then
        err_line "生成された WAV が空です（音符が検出されなかった可能性があります）: $output"
        exit 1
    fi

    done_line "生成: ${C_BOLD}$output${C_RESET} ($(human_readable_size "$output_size"))"
done

done_line "完了"
