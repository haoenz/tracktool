"""Where the user's workspace files live, resolved once.

The KML archive ZIP is a workspace fact: both the KML commands that file
tracks into it and the media commands that geotag against it need its path,
and neither should own the lookup. The path comes from the CLI argument or
the config key, resolved here for both.

Resolving answers "where", never "is it there yet": an archive that has not
been created is a normal state for a command that is about to create it, so
existence belongs to the command that reads or writes it.
"""

from pathlib import Path

from .context import ctx
from .errors import UserInputError


def resolve_zip_path(zip_path: str | None) -> Path:
    """CLI argument or config key -> resolved ZIP path; UserInputError when unset."""
    path = zip_path or ctx.config["kml_zip_path"]
    if not path:
        raise UserInputError(
            "KML compressed file path is not configured (set kml_zip_path or pass --zip)")
    return Path(path).expanduser().resolve()
