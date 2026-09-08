#!/usr/bin/env python3
"""同期済み実コーパスをVGM、NSF、SPCの各変換器で検証する。"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MANIFEST_PATH = REPOSITORY_ROOT / "tests" / "real_corpus_cases.json"
DEFAULT_CORPUS_ROOT = REPOSITORY_ROOT / "testdata" / "real-corpus"


def load_cases(manifest_path: Path) -> list[dict[str, object]]:
    """同期スクリプトと同じマニフェストからケースを読む。"""
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    return payload["cases"]


def run_command(arguments: list[str], environment: dict[str, str] | None = None) -> None:
    """変換コマンドを失敗時に即座に終了する形で実行する。"""
    subprocess.run(arguments, check=True, text=True, env=environment)


def validate_output(output_path: Path, case_id: str) -> None:
    """SMFヘッダーだけの空出力を実データ変換の成功として扱わない。"""
    if not output_path.is_file() or output_path.stat().st_size <= 14:
        raise RuntimeError(f"{case_id}: conversion produced no MIDI notes: {output_path}")


def verify_nsf_case(case: dict[str, object], corpus_root: Path, output_root: Path) -> None:
    """NSF変換と、必要な実チップチャネルを含むmetadata出力を検証する。"""
    case_id = str(case["id"])
    input_path = corpus_root / str(case["destination"])
    output_path = output_root / f"{case_id}.mid"
    metadata_path = output_root / f"{case_id}.json"
    run_command([
        str(REPOSITORY_ROOT / "nsf2midi" / "nsf2midi"), "--track", "0", "--duration", "10",
        "--track-metadata", str(metadata_path), str(input_path), str(output_path),
    ])
    validate_output(output_path, case_id)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    labels = {entry.get("channel") for entry in metadata.get("tracks", [])}
    for required in case.get("requiredMetadataChannels", []):
        if required not in labels:
            raise RuntimeError(f"{case_id}: missing metadata channel {required}")
    print(f"ok {case_id}")


def verify_spc_case(case: dict[str, object], corpus_root: Path, output_root: Path) -> None:
    """SPC変換が実曲からノートを含むMIDIを作ることを検証する。"""
    case_id = str(case["id"])
    input_path = corpus_root / str(case["destination"])
    output_path = output_root / f"{case_id}.mid"
    run_command([str(REPOSITORY_ROOT / "spc2midi" / "spc2midi"), "--seq", "0", str(input_path), str(output_path)])
    validate_output(output_path, case_id)
    print(f"ok {case_id}")


def parse_arguments() -> argparse.Namespace:
    """非追跡コーパスとマニフェストの位置を指定する。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus-root", type=Path, default=DEFAULT_CORPUS_ROOT)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST_PATH)
    return parser.parse_args()


def main() -> int:
    """VGM、NSF、SPCの順に実データ回帰検証を実行する。"""
    arguments = parse_arguments()
    run_command(["python3", str(REPOSITORY_ROOT / "scripts" / "sync_real_corpus.py"), "--check", "--corpus-root", str(arguments.corpus_root), "--manifest", str(arguments.manifest)])
    run_command(
        ["npm", "--prefix", str(REPOSITORY_ROOT / "vgm2midi"), "run", "test:real-corpus"],
        {**os.environ, "REAL_CORPUS_ROOT": str(arguments.corpus_root)},
    )
    with tempfile.TemporaryDirectory(prefix="miditrack-real-corpus-") as temporary_directory:
        output_root = Path(temporary_directory)
        for case in load_cases(arguments.manifest):
            if case["format"] == "nsf":
                verify_nsf_case(case, arguments.corpus_root, output_root)
            elif case["format"] == "spc":
                verify_spc_case(case, arguments.corpus_root, output_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
