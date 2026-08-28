"""プロジェクトルートの midi2wav.sh を安全に呼び出し、.mid を .wav にレンダリングする。

このリポジトリのパス自体が "Chill & Relax GAME MUSIC" のようにスペースと '&' を
含むため、シェル経由の実行（シェル文字列の組み立て、shell=True）は確実に壊れる。
subprocess.run() に明示的なargvリストを shell=False で渡し、シェルを一切介さない。
これは nsf2midi/spc2midi の src/midi2wav.cpp（posix_spawn）、vgm2midi の
src/midi2wav.ts（spawnSync(..., {shell: false})）と同じ制約・同じ設計。
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from .errors import RenderError

RENDER_TIMEOUT_SECONDS = 300
_STDERR_TAIL_LINES = 20
_SOUNDFONT_EXTENSIONS = (".sf2", ".sf3")


def _repo_root() -> Path:
    # src/miditrack/render.py -> src/miditrack -> src -> miditrack -> <repo root>
    return Path(__file__).resolve().parents[3]


def default_soundfont_dirs() -> list[Path]:
    """midi2wav.sh の DEFAULT_SOUNDFONT_DIRS と同じ探索順を返す（同じディレクトリ・同じ順序）。"""
    return [
        _repo_root() / "soundfonts",
        Path.home() / "Library/Audio/Sounds/Banks",
        Path("/opt/homebrew/share/soundfonts"),
        Path("/Library/Audio/Sounds/Banks"),
        Path("/opt/homebrew/share/fluid-synth/sf2"),
    ]


def list_soundfonts(dirs: list[Path] | None = None) -> list[dict]:
    """探索ディレクトリ群から見つかる SoundFont (*.sf2/*.sf3) を一覧化する。

    midi2wav.sh の -S（対話選択）と同じ「ディレクトリ順、ディレクトリ内はファイル名順」
    で列挙する。存在しないディレクトリ（未マウントの外付けSSD等）は黙ってスキップする。

    シンボリックリンクはたどるが、実体（resolve()した絶対パス）が同じものは
    最初に見つかった1件のみを残し重複を除く。midi2wav.sh の
    collect_available_soundfonts() と同じ挙動。
    """
    search_dirs = dirs if dirs is not None else default_soundfont_dirs()
    results: list[dict] = []
    seen_real_paths: set[Path] = set()
    for directory in search_dirs:
        if not directory.is_dir():
            continue
        matches = [
            p
            for p in sorted(directory.iterdir())
            if p.is_file() and p.suffix.lower() in _SOUNDFONT_EXTENSIONS
        ]
        for path in matches:
            real_path = path.resolve()
            if real_path in seen_real_paths:
                continue
            seen_real_paths.add(real_path)
            results.append(
                {
                    "path": str(path),
                    "name": path.name,
                    "dir": str(directory),
                    "sizeBytes": path.stat().st_size,
                }
            )
    return results


def _is_executable_file(path: str) -> bool:
    p = Path(path)
    return p.is_file() and os.access(p, os.X_OK)


def resolve_midi2wav_bin() -> str:
    """midi2wav.sh の実行体を解決する。

    解決順（nsf2midi/src/midi2wav.cpp の ResolveMidi2WavBin() と同じ）:
      1. MIDI2WAV_BIN 環境変数 -- 設定されているのに実行できなければ致命的エラー
         （フォールバックしない）
      2. このファイルから見たリポジトリルートの midi2wav.sh
         （src/miditrack/render.py から3階層上がリポジトリルート）
      3. PATH上の "midi2wav"（subprocessが自前でPATH解決するので、素のコマンド名を返す）
    """
    env_bin = os.environ.get("MIDI2WAV_BIN")
    if env_bin:
        if not _is_executable_file(env_bin):
            raise RenderError(f"MIDI2WAV_BIN が実行可能ファイルではありません: {env_bin}")
        return env_bin

    # src/miditrack/render.py -> src/miditrack -> src -> miditrack -> <repo root>
    repo_root = Path(__file__).resolve().parents[3]
    sibling = repo_root / "midi2wav.sh"
    if _is_executable_file(str(sibling)):
        return str(sibling)

    return "midi2wav"


def is_soundfont_file(path: Path) -> bool:
    """path が実在する .sf2/.sf3 ファイルかどうかを返す。"""
    return path.is_file() and path.suffix.lower() in _SOUNDFONT_EXTENSIONS


def render_wav(midi_path: Path, wav_path: Path, soundfont: Path | None = None) -> None:
    """midi_path の .mid を wav_path に .wav としてレンダリングする。失敗時は RenderError。"""
    bin_path = resolve_midi2wav_bin()

    argv = [bin_path, "-f"]
    if soundfont:
        argv += ["-s", str(soundfont)]
    argv += ["-o", str(wav_path), str(midi_path)]

    try:
        result = subprocess.run(
            argv,
            shell=False,
            capture_output=True,
            text=True,
            timeout=RENDER_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as error:
        raise RenderError(
            f"midi2wav が見つかりません（{bin_path}）。MIDI2WAV_BIN 環境変数か "
            "PATH 上の midi2wav を確認してください"
        ) from error
    except subprocess.TimeoutExpired as error:
        raise RenderError(
            f"midi2wav のレンダリングが {RENDER_TIMEOUT_SECONDS} 秒でタイムアウトしました"
        ) from error

    if result.returncode != 0:
        stderr_lines = result.stderr.strip().splitlines()
        tail = "\n".join(stderr_lines[-_STDERR_TAIL_LINES:])
        raise RenderError(f"midi2wav の実行に失敗しました（exit={result.returncode}）:\n{tail}")

    if not wav_path.exists() or wav_path.stat().st_size <= 44:
        raise RenderError("WAVの書き出しに失敗しました（出力が空です）")
