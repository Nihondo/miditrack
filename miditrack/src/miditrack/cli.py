"""miditrack CLIエントリポイント。

`miditrack [MIDI_FILE] [--soundfont FILE] [--port PORT] [--no-token]
[--no-browser]` でローカルWeb UIを起動する。このツール自体がWeb UIであり、
pixelart.pyの `--web` のような「他のモードと排他的なフラグ」は存在しない。
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from . import __version__


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="miditrack",
        description=(
            "MIDIファイルのトラックごとにGeneral MIDI音色（プログラムチェンジ）を"
            "割り当て、fluidsynthでレンダリングして試聴するローカルWebツール"
        ),
    )
    parser.add_argument(
        "midi_file",
        nargs="?",
        type=Path,
        help="起動時に読み込む .mid ファイル（省略時はブラウザでアップロードする）",
    )
    parser.add_argument(
        "-s",
        "--soundfont",
        type=Path,
        default=None,
        help="レンダリングに使うSoundFont(.sf2/.sf3)。省略時はmidi2wav.sh自身の解決に任せる",
    )
    parser.add_argument(
        "-p",
        "--port",
        type=int,
        default=0,
        help="Web UIを起動する固定ポート番号（省略時は空きポートを自動選択）",
    )
    parser.add_argument(
        "--no-token",
        action="store_true",
        help=(
            "起動トークン認証を無効化する（--portと併用してブックマークから毎回"
            "開けるようにするためのオプション。このMac上の他プロセスからも"
            "127.0.0.1経由でアクセス可能になるため、信頼できる環境でのみ使うこと）"
        ),
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="起動時にブラウザを自動で開かない",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"miditrack {__version__}",
    )
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.midi_file is not None and not args.midi_file.is_file():
        raise SystemExit(f"MIDIファイルが見つかりません: {args.midi_file}")
    if args.soundfont is not None and not args.soundfont.is_file():
        raise SystemExit(f"SoundFontファイルが見つかりません: {args.soundfont}")
    if not 0 <= args.port <= 65535:
        raise SystemExit(f"ポート番号は0〜65535で指定してください: {args.port}")

    try:
        from .web import run_server
    except ImportError as error:
        raise SystemExit(
            "miditrack にはFlaskが必要です。miditrack/README_ja.mdの「インストール」に"
            "従ってvenvを作成してください"
        ) from error

    run_server(
        midi_path=args.midi_file,
        soundfont=args.soundfont,
        open_browser=not args.no_browser,
        port=args.port,
        require_token=not args.no_token,
        local_open_dir=(
            Path(local_open_dir)
            if (local_open_dir := os.environ.get("MIDITRACK_LOCAL_OPEN_DIR"))
            else None
        ),
    )


if __name__ == "__main__":  # pragma: no cover
    main()
