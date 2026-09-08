#!/usr/bin/env python3
"""実データコーパスの選定ZIP entryを非追跡のローカル領域へ安全に同期する。"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import zipfile


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MANIFEST_PATH = REPOSITORY_ROOT / "tests" / "real_corpus_cases.json"
DEFAULT_CORPUS_ROOT = REPOSITORY_ROOT / "testdata" / "real-corpus"


def load_manifest(manifest_path: Path) -> list[dict[str, object]]:
    """ケースマニフェストを読み、最低限の構造を検証して返す。"""
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    if payload.get("version") != 1 or not isinstance(payload.get("cases"), list):
        raise ValueError(f"unsupported real corpus manifest: {manifest_path}")
    return payload["cases"]


def validate_relative_path(value: str, label: str) -> PurePosixPath:
    """原本・出力いずれにも使える安全な相対パスを検証する。"""
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or path == PurePosixPath("."):
        raise ValueError(f"{label} must be a non-empty relative path: {value!r}")
    return path


def hash_bytes(content: bytes) -> str:
    """コーパス入力の固定SHA-256を返す。"""
    return hashlib.sha256(content).hexdigest()


def read_source_bytes(source_root: Path, case: dict[str, object]) -> bytes:
    """マニフェストに指定された原本ファイルまたはZIP entryだけを読む。"""
    source = case.get("source")
    if not isinstance(source, dict):
        raise ValueError(f"{case['id']}: source must be an object")
    archive = source.get("archive")
    member = source.get("member")
    if isinstance(archive, str) and isinstance(member, str):
        archive_path = source_root / validate_relative_path(archive, "archive")
        member_path = validate_relative_path(member, "member").as_posix()
        with zipfile.ZipFile(archive_path) as bundle:
            return bundle.read(member_path)
    direct = source.get("file")
    if isinstance(direct, str):
        return (source_root / validate_relative_path(direct, "file")).read_bytes()
    raise ValueError(f"{case['id']}: source needs archive/member or file")


def validate_case_content(case: dict[str, object], content: bytes) -> None:
    """原本とローカルコピーが同じ固定データであることを確認する。"""
    expected = case.get("sha256")
    actual = hash_bytes(content)
    if not isinstance(expected, str) or actual != expected:
        raise ValueError(f"{case['id']}: SHA-256 mismatch: expected {expected}, got {actual}")


def write_case_content(corpus_root: Path, case: dict[str, object], content: bytes, replace: bool) -> str:
    """内容が一致しない既存ファイルを明示許可なしに上書きせず同期する。"""
    destination = case.get("destination")
    if not isinstance(destination, str):
        raise ValueError(f"{case['id']}: destination must be a string")
    destination_path = corpus_root / validate_relative_path(destination, "destination")
    if destination_path.exists() and destination_path.read_bytes() != content:
        if not replace:
            raise ValueError(f"{case['id']}: local file differs; rerun with --replace: {destination_path}")
    if destination_path.exists() and destination_path.read_bytes() == content:
        return "unchanged"
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = destination_path.with_suffix(destination_path.suffix + ".tmp")
    temporary_path.write_bytes(content)
    temporary_path.replace(destination_path)
    return "copied"


def verify_local_corpus(corpus_root: Path, cases: list[dict[str, object]]) -> None:
    """ローカルの全選定ケースの存在と固定ハッシュを検証する。"""
    failures: list[str] = []
    for case in cases:
        destination = case.get("destination")
        if not isinstance(destination, str):
            failures.append(f"{case.get('id')}: invalid destination")
            continue
        local_path = corpus_root / validate_relative_path(destination, "destination")
        if not local_path.is_file():
            failures.append(f"{case['id']}: missing {local_path}")
            continue
        try:
            validate_case_content(case, local_path.read_bytes())
        except ValueError as error:
            failures.append(str(error))
    if failures:
        raise ValueError("\n".join(failures))


def parse_arguments() -> argparse.Namespace:
    """同期またはローカル検証用の引数を読む。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Read-only original corpus directory")
    parser.add_argument("--corpus-root", type=Path, default=DEFAULT_CORPUS_ROOT)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST_PATH)
    parser.add_argument("--check", action="store_true", help="Check local files only; do not copy")
    parser.add_argument("--replace", action="store_true", help="Allow replacing a mismatched local copy")
    return parser.parse_args()


def main() -> int:
    """指定ケースだけを同期するか、既存ローカルコーパスを検証する。"""
    arguments = parse_arguments()
    cases = load_manifest(arguments.manifest)
    try:
        if arguments.check:
            verify_local_corpus(arguments.corpus_root, cases)
            print(f"verified {len(cases)} real corpus cases in {arguments.corpus_root}")
            return 0
        if arguments.source is None or not arguments.source.is_dir():
            raise ValueError("--source must name the read-only original corpus directory")
        copied = unchanged = 0
        for case in cases:
            content = read_source_bytes(arguments.source, case)
            validate_case_content(case, content)
            result = write_case_content(arguments.corpus_root, case, content, arguments.replace)
            copied += result == "copied"
            unchanged += result == "unchanged"
        print(f"synced {len(cases)} real corpus cases: {copied} copied, {unchanged} unchanged")
        return 0
    except (OSError, ValueError, zipfile.BadZipFile, KeyError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
