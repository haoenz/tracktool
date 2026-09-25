"""Where the user's workspace files live, resolved once.

The KML archive is a workspace fact: both the KML commands that file tracks
into it and the media commands that geotag against it need its location, and
neither should own the lookup. The location comes from the CLI argument or
the config key, resolved here for both.

An archive is *declared*, not implied: its directory holds an `archive.json`
manifest, and resolving refuses a directory without one. That is what keeps a
typo'd path from silently becoming a second archive — creation has exactly
one entry point (`archive init`), and everything else refuses to run against
an undeclared directory.
"""

import json
from pathlib import Path

from .context import ctx
from .errors import UserInputError
from .paths import display_path

MANIFEST_NAME = "archive.json"
DEFAULT_ZIP_NAME = "Archive.zip"


def manifest_path(archive_dir: Path) -> Path:
    """The archive's identity file: `<archive_dir>/archive.json`."""
    return archive_dir / MANIFEST_NAME


def read_zip_name(archive_dir: Path) -> str:
    """The ZIP file name recorded in the manifest, defaulted when absent."""
    try:
        data = json.loads(manifest_path(archive_dir).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise UserInputError(
            f"Cannot read archive manifest {display_path(manifest_path(archive_dir))}: {exc}") from exc
    return str(data.get("zip") or DEFAULT_ZIP_NAME)


def resolve_archive(zip_path: str | None) -> tuple[Path, Path]:
    """CLI override or configured archive -> (archive_dir, zip_file).

    An explicit ZIP path picks its parent as the archive directory; the config
    key `archive_path` is the directory itself and the manifest names the ZIP
    inside it. Either way the directory must be declared — answering "where"
    includes refusing to guess what is not an archive.
    """
    if zip_path:
        zip_file = Path(zip_path).expanduser().resolve()
        archive_dir = zip_file.parent
    else:
        configured = str(ctx.config["archive_path"] or "")
        if not configured:
            raise UserInputError(
                "Archive directory is not configured (set archive_path or pass --zip)")
        archive_dir = Path(configured).expanduser().resolve()
    if not manifest_path(archive_dir).is_file():
        raise UserInputError(
            f"{display_path(archive_dir)} is not a tracktool archive "
            "(run `tracktool archive init` first)")
    if not zip_path:
        zip_file = archive_dir / read_zip_name(archive_dir)
    return archive_dir, zip_file
