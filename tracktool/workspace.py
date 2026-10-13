"""Resolve archive location without configuration-dependent migration.

SQLite identity is archive.sqlite3. Legacy manifest/history names remain reserved
so merge cannot overwrite them; old metadata is never used as archive truth.
"""

import json
from pathlib import Path

from .context import ctx
from .errors import UserInputError
from .paths import display_path

MANIFEST_NAME = "archive.json"
HISTORY_NAME = "history.jsonl"
DEFAULT_ZIP_NAME = "Archive.zip"


def manifest_path(archive_dir: Path) -> Path:
    """The archive's identity file: `<archive_dir>/archive.json`."""
    return archive_dir / MANIFEST_NAME


def history_log_path(archive_dir: Path) -> Path:
    """The archive's change log: `<archive_dir>/history.jsonl`.

    A fixed name inside the archive directory, not a key in the manifest: the
    archive's identity is its directory (E1), so moving the directory takes
    its history along, and no command has to know a manifest version to find
    it.
    """
    return archive_dir / HISTORY_NAME


def read_zip_name(archive_dir: Path) -> str:
    """The ZIP file name recorded in the manifest, defaulted when absent."""
    try:
        data = json.loads(manifest_path(archive_dir).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise UserInputError(f"Cannot read archive manifest {display_path(manifest_path(archive_dir))}: {exc}") from exc
    return str(data.get("zip") or DEFAULT_ZIP_NAME)


def resolve_archive(zip_path: str | None) -> tuple[Path, Path]:
    """Legacy --zip locates the directory; configured paths are directories.

    The returned ZIP path is an export target/locator only. All daily content
    operations resolve its sibling archive.sqlite3, even if the ZIP is missing.
    """
    if zip_path:
        zip_file = Path(zip_path).expanduser().resolve()
        archive_dir = zip_file.parent
    else:
        configured = str(ctx.config["archive_path"] or "")
        if not configured:
            raise UserInputError("Archive directory is not configured (set archive_path or pass --zip)")
        archive_dir = Path(configured).expanduser().resolve()
    if not (archive_dir / "archive.sqlite3").is_file():
        raise UserInputError(
            f"{display_path(archive_dir)} is not a tracktool archive with SQLite; "
            "run `archive init` for an empty directory "
            "or `archive import-zip ZIP DIRECTORY` for migration/recovery"
        )
    if not zip_path:
        zip_file = archive_dir / DEFAULT_ZIP_NAME
    return archive_dir, zip_file
