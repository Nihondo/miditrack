#!/usr/bin/env bash
set -euo pipefail

# ピッチシフト＋速度変更バッチ処理スクリプト
# 入力音声を WAV に変換し、速度×ピッチの全組み合わせの WAV を生成する

# === デフォルト設定 ===
SAMPLE_RATE=48000
CHANNELS=2
SPEEDS=()
PITCHES=()
PARALLEL_JOBS="${PITCH_SHIFT_JOBS:-4}"
VERBOSE=false

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

# ファイル名から最後の拡張子を除いたベース名を返す。
get_filename_stem() {
    local filename="$1"
    local stem="${filename%.*}"

    [[ -n "$stem" ]] || stem="$filename"
    printf '%s' "$stem"
}

# URL ダウンロード時の保存ベース名を対話的に確認する。
prompt_download_basename() {
    local default_name="$1"
    local entered_name=""

    if [[ ! -t 0 ]]; then
        printf '%s' "$default_name"
        return
    fi

    while true; do
        printf '保存ファイルのベース名（拡張子なし） [未入力なら %s]: ' "$default_name" >&2
        IFS= read -r entered_name
        [[ -n "$entered_name" ]] || entered_name="$default_name"

        if [[ "$entered_name" == */* || "$entered_name" == "." || "$entered_name" == ".." ]]; then
            err_line "ベース名には /、.、.. を指定できません"
            continue
        fi
        printf '%s' "$entered_name"
        return
    done
}

# yt-dlp の出力テンプレート内でベース名の % をリテラルとして扱う。
escape_ytdlp_template_text() {
    printf '%s' "${1//%/%%}"
}

usage() {
    cat <<'USAGE'
Usage: pitch_shift.sh [options] <input_file_or_url>

入力音声（mp3, m4a, opus, mp4, wav 等）からピッチシフト済み WAV を生成する。
URL を指定した場合は自動的にダウンロードしてから処理する。
対話実行では保存するベース名を確認し、未入力なら表示された既存名を使用する。

Options:
  -s, --speed FACTOR   速度倍率（複数指定可、デフォルト: 1.2, 0.8）
  -p, --pitch SEMI     ピッチシフト量（半音単位、複数指定可、デフォルト: -2, -1, 0, 1, 2）
  -j, --jobs N         同時変換数（デフォルト: 4、PITCH_SHIFT_JOBSでも指定可）
  -v, --verbose        ffmpeg/rubberbandの詳細出力を表示（デフォルトは抑制）
  -h, --help           このヘルプを表示

速度×ピッチの全組み合わせを生成する。

例:
  pitch_shift.sh song.m4a                          # デフォルト: 10ファイル生成
  pitch_shift.sh -s 1.5 -p -3 -p -5 song.m4a      # x1.5 × p-3/p-5 = 2ファイル
  pitch_shift.sh -s 1.2 -s 0.8 -p 0 song.m4a      # x1.2/x0.8 × p0 = 2ファイル

出力ファイル（入力が song.m4a, デフォルト設定の場合）:
  song_p-2_x1.2.wav   song_p-1_x1.2.wav   song_p+0_x1.2.wav   song_p+1_x1.2.wav   song_p+2_x1.2.wav
  song_p-2_x0.8.wav   song_p-1_x0.8.wav   song_p+0_x0.8.wav   song_p+1_x0.8.wav   song_p+2_x0.8.wav

依存: ffmpeg, rubberband-cli, curl（URL入力時）, yt-dlp（YouTube URL時）
USAGE
    exit 1
}

# --- 引数パース ---
[[ $# -lt 1 ]] && usage
INPUT=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -s|--speed)  SPEEDS+=("$2"); shift 2 ;;
        -p|--pitch)  PITCHES+=("$2"); shift 2 ;;
        -j|--jobs)
            [[ $# -ge 2 ]] || { err_line "--jobs には同時変換数が必要です"; exit 1; }
            PARALLEL_JOBS="$2"
            shift 2
            ;;
        -v|--verbose) VERBOSE=true; shift ;;
        -h|--help)   usage ;;
        -*)          err_line "不明なオプション: $1"; usage ;;
        *)           INPUT="$1"; shift ;;
    esac
done

[[ -z "$INPUT" ]] && { err_line "入力ファイルが指定されていません"; usage; }
if [[ ! "$PARALLEL_JOBS" =~ ^[1-9][0-9]*$ ]]; then
    err_line "同時変換数には1以上の整数を指定してください: $PARALLEL_JOBS"
    exit 1
fi

# 未指定時はデフォルト値を使用
if [[ ${#SPEEDS[@]} -eq 0 ]]; then
    SPEEDS=(1.2 0.8)
fi
if [[ ${#PITCHES[@]} -eq 0 ]]; then
    PITCHES=(-2 -1 0 1 2)
fi

# --- URL の場合はダウンロード ---
if [[ "$INPUT" =~ ^https?:// ]]; then
    if [[ "$INPUT" =~ (youtube\.com|youtu\.be|youtube\.com/shorts) ]]; then
        # YouTube URL → yt-dlp で音声抽出
        if ! command -v yt-dlp &>/dev/null; then
            err_line "yt-dlp がインストールされていません"
            exit 1
        fi
        if ! YOUTUBE_FILENAME="$(yt-dlp -x --print filename "$INPUT")"; then
            err_line "YouTube のファイル名を取得できませんでした"
            exit 1
        fi
        if [[ -z "$YOUTUBE_FILENAME" ]]; then
            err_line "YouTube のファイル名を取得できませんでした"
            exit 1
        fi
        YOUTUBE_BASENAME="$(basename "$YOUTUBE_FILENAME")"
        YOUTUBE_STEM="$(get_filename_stem "$YOUTUBE_BASENAME")"
        DOWNLOAD_STEM="$(prompt_download_basename "$YOUTUBE_STEM")"
        YTDLP_OUTPUT_STEM="$(escape_ytdlp_template_text "$DOWNLOAD_STEM")"
        info_line "YouTube から音声をダウンロード中: ${C_BOLD}$INPUT${C_RESET}"
        INPUT="$(yt-dlp -x -o "${YTDLP_OUTPUT_STEM}.%(ext)s" --print after_move:filepath "$INPUT")"
        if [[ -z "$INPUT" || ! -f "$INPUT" ]]; then
            err_line "yt-dlp のダウンロードに失敗しました"
            exit 1
        fi
        done_line "ダウンロード完了: ${C_BOLD}$INPUT${C_RESET}"
    else
        # 一般 URL → curl
        if ! command -v curl &>/dev/null; then
            err_line "curl がインストールされていません"
            exit 1
        fi
        URL_PATH="${INPUT%%\?*}"
        URL_BASENAME="$(basename "$URL_PATH")"
        URL_BASENAME="$(python3 -c "import urllib.parse,sys; print(urllib.parse.unquote(sys.argv[1]))" "$URL_BASENAME")"
        if [[ -z "$URL_BASENAME" || "$URL_BASENAME" == "/" ]]; then
            URL_BASENAME="download_$$"
        fi
        URL_STEM="$(get_filename_stem "$URL_BASENAME")"
        URL_SUFFIX="${URL_BASENAME#"$URL_STEM"}"
        DOWNLOAD_STEM="$(prompt_download_basename "$URL_STEM")"
        URL_BASENAME="${DOWNLOAD_STEM}${URL_SUFFIX}"
        info_line "ダウンロード中: ${C_BOLD}$INPUT${C_RESET}"
        curl -fSL -o "$URL_BASENAME" "$INPUT"
        INPUT="$URL_BASENAME"
        done_line "ダウンロード完了: ${C_BOLD}$INPUT${C_RESET}"
    fi
fi

BASENAME="$(basename "$INPUT")"
STEM="${BASENAME%.*}"

if [[ ! -f "$INPUT" ]]; then
    err_line "ファイルが見つかりません: $INPUT"
    exit 1
fi

# --- 依存チェック ---
for cmd in ffmpeg rubberband; do
    if ! command -v "$cmd" &>/dev/null; then
        err_line "$cmd がインストールされていません"
        exit 1
    fi
done

# --- WAV 変換 ---
TEMP_WAV="temp_$$_$(date +%s).wav"
ACTIVE_PIDS=()

cleanup_jobs_and_temp() {
    local pid
    if [[ ${#ACTIVE_PIDS[@]} -gt 0 ]]; then
        for pid in "${ACTIVE_PIDS[@]}"; do
            kill -TERM "$pid" 2>/dev/null || true
        done
        for pid in "${ACTIVE_PIDS[@]}"; do
            wait "$pid" 2>/dev/null || true
        done
    fi
    ACTIVE_PIDS=()
    rm -f "$TEMP_WAV"
}

wait_for_jobs() {
    local pid failed=0
    for pid in "${ACTIVE_PIDS[@]}"; do
        wait "$pid" || failed=1
    done
    ACTIVE_PIDS=()
    return "$failed"
}

trap cleanup_jobs_and_temp EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

info_line "WAV に変換中: ${C_BOLD}$INPUT${C_RESET}"
FFMPEG_LOG_OPTS=(-hide_banner -loglevel error)
if [[ "$VERBOSE" == true ]]; then
    FFMPEG_LOG_OPTS=()
fi
# "${arr[@]+"${arr[@]}"}" は、-v/--verbose指定時にFFMPEG_LOG_OPTSが空配列に
# なった場合の回避策。macOS標準の/bin/bash（3.2系、set -u下）は空配列を
# "${arr[@]}"のまま展開すると「unbound variable」で落ちる既知の互換性問題が
# あるため、この`${arr[@]+...}`イディオムで「配列が設定されていれば展開、
# 空でも展開結果は空のまま」という安全な形にする。
ffmpeg "${FFMPEG_LOG_OPTS[@]+"${FFMPEG_LOG_OPTS[@]}"}" \
    -i "$INPUT" \
    -vn \
    -ar "$SAMPLE_RATE" -ac "$CHANNELS" \
    -sample_fmt s16 \
    "$TEMP_WAV"

# --- 速度×ピッチの全組み合わせを有界並列で生成 ---
info_line "同時変換数: ${C_BOLD}${PARALLEL_JOBS}${C_RESET}"
RUBBERBAND_LOG_OPTS=(-q)
if [[ "$VERBOSE" == true ]]; then
    RUBBERBAND_LOG_OPTS=()
fi
for s in "${SPEEDS[@]}"; do
    TEMPO_RATIO=$(awk "BEGIN {printf \"%.6f\", 1 / $s}")
    SPEED_LABEL=$(awk "BEGIN {printf \"%.1f\", $s}")
    for p in "${PITCHES[@]}"; do
        PITCH_LABEL=$(awk "BEGIN {printf \"%+g\", $p}")
        OUTPUT="${STEM}_p${PITCH_LABEL}_x${SPEED_LABEL}.wav"
        step_line "速度 ${C_BOLD}${s}x${C_RESET} / ピッチ ${C_BOLD}${p}${C_RESET} → ${C_BOLD}$OUTPUT${C_RESET}"
        # 上のffmpeg呼び出しと同じ理由でRUBBERBAND_LOG_OPTSも安全展開する。
        rubberband "${RUBBERBAND_LOG_OPTS[@]+"${RUBBERBAND_LOG_OPTS[@]}"}" -t "$TEMPO_RATIO" -p "$p" "$TEMP_WAV" "$OUTPUT" &
        ACTIVE_PIDS+=("$!")
        if [[ ${#ACTIVE_PIDS[@]} -ge $PARALLEL_JOBS ]]; then
            if ! wait_for_jobs; then
                err_line "ピッチシフト処理に失敗しました"
                exit 1
            fi
        fi
    done
done

if [[ ${#ACTIVE_PIDS[@]} -gt 0 ]] && ! wait_for_jobs; then
    err_line "ピッチシフト処理に失敗しました"
    exit 1
fi

done_line "完了"
