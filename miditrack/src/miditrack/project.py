"""miditrackプロジェクト（.miditrack）の安全なZIP入出力。"""

from __future__ import annotations

import json
import shutil
import stat
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from .errors import WebValidationError
from .i18n import t

PROJECT_FORMAT = "miditrack-project"
PROJECT_VERSION = 1
MANIFEST_NAME = "manifest.json"
MAX_PROJECT_MEMBERS = 200
MAX_PROJECT_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
MAX_MANIFEST_BYTES = 1024 * 1024


@dataclass(frozen=True)
class ExtractedProject:
    """安全に展開・検証済みのプロジェクト内容。"""

    root: Path
    manifest: dict[str, Any]


def _validate_member_name(name: str) -> PurePosixPath:
    """ZIP内メンバー名を正規化し、展開先外へのパスを拒否する。"""
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or ".." in path.parts:
        raise WebValidationError(t("プロジェクト内の不正なパスを検出しました: {name}", name=name))
    if any(part in {"", "."} for part in path.parts):
        raise WebValidationError(t("プロジェクト内の不正なパスを検出しました: {name}", name=name))
    return path


def _validate_manifest(value: Any) -> dict[str, Any]:
    """形式識別子とバージョンだけを共通層で検証する。"""
    if not isinstance(value, dict):
        raise WebValidationError(t("プロジェクトmanifestはオブジェクトで指定してください"))
    if value.get("format") != PROJECT_FORMAT:
        raise WebValidationError(t("未対応のプロジェクト形式です"))
    if value.get("version") != PROJECT_VERSION:
        raise WebValidationError(t("未対応のプロジェクトバージョンです"))
    return value


def create_archive(
    output_path: Path, manifest: dict[str, Any], files: dict[str, Path]
) -> None:
    """manifestと指定ファイルを`.miditrack`アーカイブへ安全に書き出す。"""
    entries: dict[str, Path] = {}
    for name, source_path in files.items():
        _validate_member_name(name)
        if name == MANIFEST_NAME or name in entries:
            raise WebValidationError(t("プロジェクト内のファイル名が重複しています: {name}", name=name))
        if not source_path.is_file():
            raise WebValidationError(t("プロジェクト保存対象が見つかりません: {source_path}", source_path=source_path))
        entries[name] = source_path

    _validate_manifest(manifest)
    try:
        manifest_bytes = json.dumps(
            manifest, ensure_ascii=False, indent=2, sort_keys=True
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise WebValidationError(t("プロジェクトmanifestを保存できません: {error}", error=error)) from error
    if len(manifest_bytes) > MAX_MANIFEST_BYTES:
        raise WebValidationError(t("プロジェクトmanifestが大きすぎます"))

    total_size = len(manifest_bytes) + sum(path.stat().st_size for path in entries.values())
    if len(entries) + 1 > MAX_PROJECT_MEMBERS:
        raise WebValidationError(
            t("プロジェクト内のファイル数が多すぎます（上限{max_members}）", max_members=MAX_PROJECT_MEMBERS)
        )
    if total_size > MAX_PROJECT_UNCOMPRESSED_BYTES:
        raise WebValidationError(t("プロジェクトの展開後サイズが大きすぎます"))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(MANIFEST_NAME, manifest_bytes)
            for name, source_path in sorted(entries.items()):
                archive.write(source_path, arcname=name)
    except OSError as error:
        raise WebValidationError(t("プロジェクトを保存できません: {error}", error=error)) from error


def extract_archive(archive_path: Path, destination: Path) -> ExtractedProject:
    """`.miditrack`を展開し、ZIP Slip・容量・manifestを検証して返す。"""
    destination.mkdir(parents=True, exist_ok=True)
    resolved_destination = destination.resolve()
    try:
        with zipfile.ZipFile(archive_path) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_PROJECT_MEMBERS:
                raise WebValidationError(
                    t("プロジェクト内のファイル数が多すぎます（上限{max_members}）", max_members=MAX_PROJECT_MEMBERS)
                )
            if any(info.is_dir() for info in infos):
                raise WebValidationError(t("プロジェクトにディレクトリエントリは含められません"))
            if sum(info.file_size for info in infos) > MAX_PROJECT_UNCOMPRESSED_BYTES:
                raise WebValidationError(t("プロジェクトの展開後サイズが大きすぎます"))

            names: set[str] = set()
            manifest_info: zipfile.ZipInfo | None = None
            for info in infos:
                _validate_member_name(info.filename)
                if info.filename in names:
                    raise WebValidationError(
                        t("プロジェクト内のファイル名が重複しています: {name}", name=info.filename)
                    )
                names.add(info.filename)
                mode = info.external_attr >> 16
                if mode and stat.S_IFMT(mode) == stat.S_IFLNK:
                    raise WebValidationError(t("プロジェクトにシンボリックリンクは含められません"))
                if info.filename == MANIFEST_NAME:
                    manifest_info = info

            if manifest_info is None:
                raise WebValidationError(t("プロジェクトmanifestが見つかりません"))
            if manifest_info.file_size > MAX_MANIFEST_BYTES:
                raise WebValidationError(t("プロジェクトmanifestが大きすぎます"))

            for info in infos:
                target = (resolved_destination / Path(*PurePosixPath(info.filename).parts)).resolve()
                if target == resolved_destination or resolved_destination not in target.parents:
                    raise WebValidationError(
                        t("プロジェクト内の不正なパスを検出しました: {name}", name=info.filename)
                    )
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
    except zipfile.BadZipFile as error:
        raise WebValidationError(t("有効な.miditrackファイルではありません")) from error
    except OSError as error:
        raise WebValidationError(t("プロジェクトを読み込めません: {error}", error=error)) from error

    try:
        raw_manifest = (resolved_destination / MANIFEST_NAME).read_text(encoding="utf-8")
        manifest = _validate_manifest(json.loads(raw_manifest))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise WebValidationError(t("プロジェクトmanifestを読み込めません: {error}", error=error)) from error
    return ExtractedProject(root=resolved_destination, manifest=manifest)
