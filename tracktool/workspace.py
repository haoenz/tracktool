"""Where the user's workspace files live, resolved once.

The KML archive ZIP is a workspace fact: both the KML commands that file
tracks into it and the media commands that geotag against it need its path,
and neither should own the lookup. The path comes from the CLI argument or
the config key, resolved here for both.
"""

from pathlib import Path

from .context import ctx
from .errors import UserInputError


def resolve_zip_path(zip_path: str | None) -> Path:
    """CLI argument or config key -> resolved ZIP path; UserInputError when absent."""
    path = zip_path or ctx.config["kml_zip_path"]
    if not path or not Path(path).is_file():
        raise UserInputError(f"KML compressed file path does not exist: {path}")
    return Path(path).resolve()
