"""What a target means and which files count as media.

A command's target is one file, a directory, or a list the caller already
resolved. A directory means "the media in here": files are filtered by the
extension table below, the single source both discovery and grouping read.
A file the user names is processed whatever it is — pointing at it is the
stronger statement than an extension.
"""

from pathlib import Path

from . import log
from .errors import UserInputError
from .paths import display_path

# 扩展名 -> 媒体类别（group_media_files 的子目录名与发现过滤共用这一份）
MEDIA_EXTENSIONS: dict[str, str] = {
    ".mp4": "VID",
    ".mov": "VID",
    ".avi": "VID",
    ".arw": "RAW",
    ".raf": "RAW",
    ".dng": "RAW",
    ".jpg": "IMG",
    ".jpeg": "IMG",
}


def is_media(path: Path) -> bool:
    """Whether the filename's extension is a known media type."""
    return path.suffix.lower() in MEDIA_EXTENSIONS


def list_files(path: Path | list[Path]) -> list[Path]:
    """The files a target denotes: the file itself, a directory's media, or an
    explicit list the orchestration layer already resolved."""
    if isinstance(path, list):
        return list(path)
    if path.is_file():
        return [path]
    if not path.is_dir():
        raise UserInputError(f"Path does not exist: {display_path(path)}")
    files = sorted(p for p in path.iterdir() if p.is_file())
    media = [p for p in files if is_media(p)]
    if skipped := len(files) - len(media):
        log.debug(f"Skipped {skipped} non-media file(s) (unknown extension)", target=str(path))
    return media
