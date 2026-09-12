"""EXIF tag reading and writing via exiftool.

Ports Set-Exif (four GPS position input formats), Find-MissingTag (zero
altitude counts as missing), Write-MediaInfo.
"""

import re
from dataclasses import dataclass, field
from pathlib import Path

from .. import exiftool, log, mediatime
from ..progress import run_parallel

# Set-Exif 的四种 GPS 位置输入格式
_DEFAULT_PATTERN = re.compile(
    r"^\d{1,2}°\s*\d{1,2}'\s*\d{1,2}(?:\.\d+)?\"\s*[NS], \s*\d{1,3}°\s*\d{1,2}'\s*\d{1,2}(?:\.\d+)?\"\s*[EW]$")
_2BULU_PATTERN = re.compile(r"^(-?\d+\.?\d*)\s+(-?\d+\.?\d*)$")
_GE_PATTERN = re.compile(
    r"^\d{1,2}°\d{1,2}'\d{1,2}(?:\.\d+)?\"\s+[北南]\s+\d{1,3}°\d{1,2}'\d{1,2}(?:\.\d+)?\"\s+[东西]$")
_EXIF_PATTERN = re.compile(
    r"^\d{1,2}\s*deg\s*\d{1,2}'\s*\d{1,2}(?:\.\d+)?\"\s*[NS], "
    r"\s*\d{1,3}\s*deg\s*\d{1,2}'\s*\d{1,2}(?:\.\d+)?\"\s*[EW]$")


class SetExifError(Exception):
    pass


# exiftool 对海拔 0 的渲染：0 米既是“缺失”也是有效数据，两个字面量都视为缺失
ZERO_ALTITUDE_VALUES = ("0 m Above Sea Level", "0 m Below Sea Level")


def is_missing_altitude(value: str) -> bool:
    """Zero altitude (either direction) counts as missing, like an empty value."""
    return not value or value in ZERO_ALTITUDE_VALUES


@dataclass
class SetExifOptions:
    position: str | None = None
    altitude: float | None = None
    make: str | None = None
    model: str | None = None
    tags: dict[str, str] = field(default_factory=dict)
    overwrite: bool = False


def build_position_params(position: str) -> list[str]:
    """Translate a -Position argument into exiftool params (4 accepted formats)."""
    m = _2BULU_PATTERN.match(position)
    if m:
        latitude, longitude = float(m[1]), float(m[2])
        if abs(latitude) > 90 or abs(longitude) > 180:
            raise SetExifError(f"Invalid GPS coordinates: {position}")
        lat_ref = "N" if latitude >= 0 else "S"
        lon_ref = "E" if longitude >= 0 else "W"
        params = [
            f"-GPSLatitude={abs(latitude)}",
            f"-GPSLatitudeRef={lat_ref}",
            f"-GPSLongitude={abs(longitude)}",
            f"-GPSLongitudeRef={lon_ref}",
        ]
        return params
    if _GE_PATTERN.match(position):
        converted = (position.replace("北", "N,").replace("南", "S,")
                     .replace("东", "E").replace("西", "W"))
        return [f"-GPSPosition={converted}"]
    if _EXIF_PATTERN.match(position) or _DEFAULT_PATTERN.match(position):
        return [f"-GPSPosition={position}"]
    raise SetExifError(f"Invalid GPS pattern: {position}")


def build_params(options: SetExifOptions) -> list[str]:
    params: list[str] = []
    if options.position:
        params += build_position_params(options.position)
    if options.altitude is not None:
        if options.altitude < 0:
            params.append("-GPSAltitudeRef=Below Sea Level")
        else:
            params.append("-GPSAltitudeRef=Above Sea Level")
        params.append(f"-GPSAltitude={abs(options.altitude)}")
    if options.make:
        params.append(f"-Make={options.make}")
    if options.model:
        params.append(f"-Model={options.model}")
    if options.overwrite:
        params.append("-overwrite_original")
    for tag, value in options.tags.items():
        params.append(f"-{tag}={value}")
    return params


def list_files(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    return sorted(p for p in path.iterdir() if p.is_file())


def set_exif(path: Path, options: SetExifOptions, parallel: bool = False) -> None:
    """Apply EXIF tags to one file or every file in a directory."""
    params = build_params(options)
    files = list_files(path)

    def process(file: Path) -> None:
        process_params = [str(file)] + params + exiftool.large_file_args(file)
        exiftool.invoke(*process_params)

    run_parallel(files, process, activity="Setting Exif data", parallel=parallel)


@dataclass
class MissingTagResult:
    file: Path
    missing_tags: list[str]


def find_missing_tag(path: Path, tags: list[str], parallel: bool = False) -> list[MissingTagResult]:
    """Files missing the given tags; zero altitude counts as missing."""
    files = list_files(path)

    def process(file: Path) -> MissingTagResult | None:
        missing: list[str] = []
        for tag in tags:
            value = exiftool.get_media_tag(file, tag)
            if not value:
                missing.append(tag)
            elif tag == "GPSAltitude" and is_missing_altitude(value):
                missing.append(tag)
            else:
                log.debug(f"Found tag {tag}: [{value}]", target=str(file))
        return MissingTagResult(file=file, missing_tags=missing) if missing else None

    results = run_parallel(files, process, activity="Finding missing tags", parallel=parallel)
    return [r for r in results if r is not None]


def print_media_info(path: Path) -> None:
    """Print GPS position, altitude and timestamp of a file."""
    gps_position = exiftool.get_media_tag(path, "GPSPosition").replace(" deg", "°")
    gps_altitude = exiftool.get_media_tag(path, "GPSAltitude")
    media_time = mediatime.get_media_time(path)
    print(media_time.isoformat() if media_time else "")
    print(gps_position)
    print(gps_altitude)
