"""EXIF tag reading and writing through the metadata backend.

Set-Exif accepts any position spelling Coordinate.parse knows (decimal or DMS)
and writes it as the four GPS tags a file actually stores; Find-MissingTag
counts a zero altitude as missing; Write-MediaInfo prints what a file records.
"""

from dataclasses import dataclass, field
from pathlib import Path

from .. import coords, log, mediatime
from ..actions import Action, WriteTags, run
from ..context import ctx
from ..discover import list_files
from ..errors import UserInputError
from ..fileutil import BatchResult, run_per_file
from ..metadata import MediaMetadata, is_missing_altitude
from ..tags import (
    ALTITUDE,
    ALTITUDE_REF,
    LATITUDE,
    LATITUDE_REF,
    LONGITUDE,
    LONGITUDE_REF,
    MAKE,
    MODEL,
    POSITION_TAGS,
)


class SetExifError(UserInputError):
    """The requested GPS position is not one of the accepted formats."""


@dataclass
class SetExifOptions:
    position: str | None = None
    altitude: float | None = None
    make: str | None = None
    model: str | None = None
    tags: dict[str, str] = field(default_factory=dict)
    overwrite: bool = False


def build_position_params(position: str) -> dict[str, str]:
    """Translate a -Position argument into the four GPS tags a file stores.

    GPSLatitudeRef/GPSLongitudeRef carry the hemisphere, so the numeric tags
    are stored unsigned; exiftool's composite GPSPosition is built from these
    four on read, never written.
    """
    coordinate = coords.Coordinate.parse(position)
    if coordinate is None:
        raise SetExifError(f"Invalid GPS position: {position}")
    return {
        LATITUDE: str(abs(coordinate.latitude)),
        LATITUDE_REF: "N" if coordinate.latitude >= 0 else "S",
        LONGITUDE: str(abs(coordinate.longitude)),
        LONGITUDE_REF: "E" if coordinate.longitude >= 0 else "W",
    }


def build_tags(options: SetExifOptions) -> dict[str, str]:
    """The tags one Set-Exif call assigns; overwrite is a write flag, not a tag."""
    tags: dict[str, str] = {}
    if options.position:
        tags.update(build_position_params(options.position))
    if options.altitude is not None:
        tags[ALTITUDE_REF] = "Below Sea Level" if options.altitude < 0 else "Above Sea Level"
        tags[ALTITUDE] = str(abs(options.altitude))
    if options.make:
        tags[MAKE] = options.make
    if options.model:
        tags[MODEL] = options.model
    tags.update(options.tags)
    return tags


def set_exif(path: Path | list[Path], options: SetExifOptions,
             parallel: bool = False, dry_run: bool = False) -> BatchResult[list[Action]]:
    """Apply EXIF tags to one file, every file in a directory, or a file list.

    The same tags go to every file, so the decisions are built once and the
    plan is one assignment per file.
    """
    tags = build_tags(options)
    files = list_files(path)

    def process(file: Path) -> list[Action]:
        return run([WriteTags(file, tags, options.overwrite)], dry_run=dry_run)

    return run_per_file(files, process, activity="Setting Exif data", parallel=parallel,
                        dry_run=dry_run)


@dataclass
class MissingTagResult:
    file: Path
    missing_tags: list[str]


def find_missing_tag(path: Path | list[Path], tags: list[str],
                     parallel: bool = False) -> BatchResult[MissingTagResult]:
    """Files missing the given tags; zero altitude counts as missing.

    A file that cannot be read is counted as failed instead of aborting the
    batch, so the repair orchestration keeps working on the readable files.
    """
    files = list_files(path)

    def process(file: Path) -> MissingTagResult | None:
        # 全部待查标签一次读齐，N 个标签仍是一次往返
        meta = MediaMetadata.of(file, ctx.backend.read_tags(file, tags))
        missing: list[str] = []
        for tag in tags:
            value = meta.get(tag)
            if not value:
                missing.append(tag)
            elif tag == ALTITUDE and is_missing_altitude(value):
                missing.append(tag)
            else:
                log.debug(f"Found tag {tag}: [{value}]", target=str(file))
        return MissingTagResult(file=file, missing_tags=missing) if missing else None

    batch = run_per_file(files, process, activity="Finding missing tags", parallel=parallel)
    return BatchResult([r for r in batch.succeeded if r is not None], batch.failed)


def print_media_info(path: Path) -> None:
    """Print timestamp, GPS position and altitude of a file."""
    meta = MediaMetadata.of(path, ctx.backend.read_tags(path, POSITION_TAGS))
    media_time = mediatime.parse_media_time(meta.tags, target=str(path))
    print(media_time.isoformat() if media_time else "")
    print(" ".join(v for v in (meta.get(LATITUDE), meta.get(LONGITUDE)) if v))
    print(meta.get(ALTITUDE))
