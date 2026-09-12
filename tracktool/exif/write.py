"""EXIF tag reading and writing through the metadata backend.

Set-Exif accepts four GPS position input formats; Find-MissingTag counts a zero
altitude as missing; Write-MediaInfo prints what a file records.
"""

import re
from dataclasses import dataclass, field
from pathlib import Path

from .. import log, mediatime
from ..actions import Action, WriteTags, run
from ..context import ctx
from ..errors import UserInputError
from ..fileutil import BatchResult, run_per_file
from ..metadata import MediaMetadata, is_missing_altitude

# Set-Exif 的四种 GPS 位置输入格式
_DEFAULT_PATTERN = re.compile(
    r"^\d{1,2}°\s*\d{1,2}'\s*\d{1,2}(?:\.\d+)?\"\s*[NS], \s*\d{1,3}°\s*\d{1,2}'\s*\d{1,2}(?:\.\d+)?\"\s*[EW]$")
_2BULU_PATTERN = re.compile(r"^(-?\d+\.?\d*)\s+(-?\d+\.?\d*)$")
_GE_PATTERN = re.compile(
    r"^\d{1,2}°\d{1,2}'\d{1,2}(?:\.\d+)?\"\s+[北南]\s+\d{1,3}°\d{1,2}'\d{1,2}(?:\.\d+)?\"\s+[东西]$")
_EXIF_PATTERN = re.compile(
    r"^\d{1,2}\s*deg\s*\d{1,2}'\s*\d{1,2}(?:\.\d+)?\"\s*[NS], "
    r"\s*\d{1,3}\s*deg\s*\d{1,2}'\s*\d{1,2}(?:\.\d+)?\"\s*[EW]$")


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
    """Translate a -Position argument into tags (4 accepted formats)."""
    m = _2BULU_PATTERN.match(position)
    if m:
        latitude, longitude = float(m[1]), float(m[2])
        if abs(latitude) > 90 or abs(longitude) > 180:
            raise SetExifError(f"Invalid GPS coordinates: {position}")
        return {
            "GPSLatitude": str(abs(latitude)),
            "GPSLatitudeRef": "N" if latitude >= 0 else "S",
            "GPSLongitude": str(abs(longitude)),
            "GPSLongitudeRef": "E" if longitude >= 0 else "W",
        }
    if _GE_PATTERN.match(position):
        converted = (position.replace("北", "N,").replace("南", "S,")
                     .replace("东", "E").replace("西", "W"))
        return {"GPSPosition": converted}
    if _EXIF_PATTERN.match(position) or _DEFAULT_PATTERN.match(position):
        return {"GPSPosition": position}
    raise SetExifError(f"Invalid GPS pattern: {position}")


def build_tags(options: SetExifOptions) -> dict[str, str]:
    """The tags one Set-Exif call assigns; overwrite is a write flag, not a tag."""
    tags: dict[str, str] = {}
    if options.position:
        tags.update(build_position_params(options.position))
    if options.altitude is not None:
        tags["GPSAltitudeRef"] = "Below Sea Level" if options.altitude < 0 else "Above Sea Level"
        tags["GPSAltitude"] = str(abs(options.altitude))
    if options.make:
        tags["Make"] = options.make
    if options.model:
        tags["Model"] = options.model
    tags.update(options.tags)
    return tags


def list_files(path: Path | list[Path]) -> list[Path]:
    """The files a target denotes: the file itself, a directory's immediate
    contents, or an explicit list the orchestration layer already resolved."""
    if isinstance(path, list):
        return list(path)
    if path.is_file():
        return [path]
    if not path.is_dir():
        raise UserInputError(f"Path does not exist: {path}")
    return sorted(p for p in path.iterdir() if p.is_file())


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
            elif tag == "GPSAltitude" and is_missing_altitude(value):
                missing.append(tag)
            else:
                log.debug(f"Found tag {tag}: [{value}]", target=str(file))
        return MissingTagResult(file=file, missing_tags=missing) if missing else None

    batch = run_per_file(files, process, activity="Finding missing tags", parallel=parallel)
    return BatchResult([r for r in batch.succeeded if r is not None], batch.failed)


def print_media_info(path: Path) -> None:
    """Print timestamp, GPS position and altitude of a file."""
    meta = MediaMetadata.of(
        path, ctx.backend.read_tags(
            path, [*mediatime.TIME_TAGS, "GPSLatitude", "GPSLongitude", "GPSAltitude"]))
    media_time = mediatime.parse_media_time(meta.tags, target=str(path))
    print(media_time.isoformat() if media_time else "")
    print(" ".join(v for v in (meta.get("GPSLatitude"), meta.get("GPSLongitude")) if v))
    print(meta.get("GPSAltitude"))
