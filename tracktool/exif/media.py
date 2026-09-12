"""Media file operations: time shifting, altitude shifting, MP4 conversion,
extension-based grouping.

Ports Move-ExifTime / Move-Altitude / ConvertTo-Mp4 / Group-MediaFiles.
"""

import re
import shutil
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .. import log, mediatime
from ..context import ctx
from ..fileutil import BatchResult, FileFailure, run_per_file
from .write import SetExifOptions, is_missing_altitude, list_files, write_exif_tags

# EXIF Make 字段注册值（exiftool 原样返回，精确匹配，不做大小写归一化）
MAKE_SONY = "SONY"
MAKE_FUJIFILM = "FUJIFILM"
# Insta360 在 EXIF Make 字段的注册值
MAKE_INSTA360 = "Arashi Vision"

# 各厂商时间标签集合（Move-ExifTime 原样移植）
_SONY_PHOTO_TAGS = ["ExifIFD:DateTimeOriginal", "Sony:SonyDateTime", "IFD0:ModifyDate", "ExifIFD:CreateDate"]
_SONY_MP4_TAGS = [
    "XMP-exif:DateTimeOriginal", "QuickTime:CreateDate", "QuickTime:ModifyDate",
    "Track1:TrackCreateDate", "Track1:TrackModifyDate", "Track2:MediaCreateDate", "Track2:MediaModifyDate",
]
_FUJIFILM_MP4_TAGS = ["XMP-exif:DateTimeOriginal", "XMP-xmp:CreateDate", "XMP-xmp:ModifyDate"]
_INSTA360_MP4_TAGS = [
    "XMP-exif:DateTimeOriginal", "QuickTime:CreateDate", "QuickTime:ModifyDate",
    "Track1:TrackCreateDate", "Track1:TrackModifyDate", "Track2:MediaCreateDate", "Track2:MediaModifyDate",
]

_RELATIVE_TIME_PATTERN = re.compile(r"(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?")
_INSTA360_FILENAME_PATTERN = re.compile(r"_(\d{8}_\d{6})_")

_EXTENSION_MAP = {
    ".mp4": "VID", ".mov": "VID", ".avi": "VID",
    ".arw": "RAW", ".raf": "RAW", ".dng": "RAW",
    ".jpg": "IMG", ".jpeg": "IMG",
}

# (make, ext) -> 要平移的时间标签集合；组合缺失即报错跳过该文件
_TAG_SETS: dict[tuple[str, str], list[str]] = {
    (MAKE_SONY, ".arw"): _SONY_PHOTO_TAGS,
    (MAKE_SONY, ".jpg"): _SONY_PHOTO_TAGS,
    (MAKE_SONY, ".jpeg"): _SONY_PHOTO_TAGS,
    (MAKE_SONY, ".mp4"): _SONY_MP4_TAGS,
    (MAKE_FUJIFILM, ".mp4"): _FUJIFILM_MP4_TAGS,
    (MAKE_INSTA360, ".mp4"): _INSTA360_MP4_TAGS,
}


def _parse_time_diff(time_diff: str) -> int:
    """'+1h30m' / '-2d' -> signed seconds."""
    is_negative = time_diff.startswith("-")
    clean = time_diff.lstrip("+-")
    m = _RELATIVE_TIME_PATTERN.search(clean)
    if not m:
        raise ValueError(f"Invalid TimeDiff: {time_diff}")
    days, hours, minutes, seconds = (int(g) if g else 0 for g in m.groups())
    total = days * 86400 + hours * 3600 + minutes * 60 + seconds
    return -total if is_negative else total


def _parse_tz_offset(offset: str) -> int | None:
    try:
        return mediatime.parse_offset(offset)
    except ValueError:
        return None


def _compute_time_shift(file: Path, time_diff: str, offset_time: str, make: str,
                        current_offset: str) -> tuple[int, dict[str, str]] | None:
    """Resolve the requested time_diff + timezone offset into a signed second
    total plus the EXIF offset-time params to write.

    `make` and `current_offset` come from the caller's single tag read, so this
    stays a decision over metadata it is handed. Returns None after logging
    when the file cannot be processed (OffsetTime is SONY-only, or a timezone
    value fails to parse).
    """
    total_seconds_offset = 0
    tz_tags: dict[str, str] = {}

    if time_diff.strip():
        total_seconds_offset += _parse_time_diff(time_diff)

    if offset_time.strip():
        if make != MAKE_SONY:
            log.error(f"OffsetTime is currently only supported for SONY. Current make: {make}",
                      target=str(file))
            return None

        if not current_offset:
            log.warning(f"Current ExifIFD:OffsetTime is missing, assuming {mediatime.DEFAULT_TZ_OFFSET}",
                        target=str(file))
            current_offset = mediatime.DEFAULT_TZ_OFFSET

        target_sec = _parse_tz_offset(offset_time)
        current_sec = _parse_tz_offset(current_offset)
        if target_sec is None or current_sec is None:
            log.error("Failed to parse timezones for OffsetTime difference calculation", target=str(file))
            return None

        diff_sec = target_sec - current_sec
        total_seconds_offset += diff_sec
        log.verbose(f"Setting timezone tags: ExifIFD:OffsetTime from {current_offset} to {offset_time} "
                    f"(diff: {diff_sec:+d} seconds)", target=str(file))
        tz_tags = {
            "ExifIFD:OffsetTime": offset_time,
            "ExifIFD:OffsetTimeOriginal": offset_time,
            "ExifIFD:OffsetTimeDigitized": offset_time,
        }

    return total_seconds_offset, tz_tags


def _rename_insta360(file: Path, shift: timedelta, is_negative: bool) -> None:
    """Sync the timestamp inside an Insta360 filename with the shifted EXIF time."""
    m = _INSTA360_FILENAME_PATTERN.search(file.stem)
    if not m:
        log.error("Filename does not match Insta360 naming pattern", target=str(file))
        return
    original_time = datetime.strptime(m[1], "%Y%m%d_%H%M%S")
    new_time = original_time - shift if is_negative else original_time + shift
    new_time_str = new_time.strftime("%Y%m%d_%H%M%S")
    new_file_path = file.parent / _INSTA360_FILENAME_PATTERN.sub(f"_{new_time_str}_", file.name)
    file.rename(new_file_path)
    log.verbose("Renamed to match new timestamp", target=str(new_file_path))


def move_exif_time(path: Path | list[Path], time_diff: str = "", offset_time: str = "",
                   overwrite: bool = False, parallel: bool = False) -> BatchResult[None]:
    """Shift EXIF timestamps; OffsetTime only supported for SONY. Insta360 files renamed."""
    if not time_diff and not offset_time:
        raise ValueError("At least one of time_diff or offset_time must be provided.")

    files = list_files(path)

    def process(file: Path) -> None:
        ext = file.suffix.lower()
        # Make 与 OffsetTime 一次读齐，每个文件只往返 exiftool 一次
        tags = ctx.backend.read_tags(file, ["Make", "ExifIFD:OffsetTime"])
        make = tags.get("Make", "")

        resolved = _compute_time_shift(file, time_diff, offset_time, make,
                                       tags.get("ExifIFD:OffsetTime", ""))
        if resolved is None:
            raise FileFailure("time shift not applicable to this file")
        total_seconds_offset, tz_tags = resolved

        if total_seconds_offset == 0:
            if tz_tags:
                ctx.backend.write_tags(file, tz_tags, overwrite=overwrite)
                log.verbose("Applied timezone offset tags but no time-shift needed", target=str(file))
            else:
                log.verbose("No timezone or time-shift changes required", target=str(file))
            return

        shift = timedelta(seconds=total_seconds_offset)
        log.verbose(f"Shifting time by {shift}", target=str(file))

        tag_set = _TAG_SETS.get((make, ext))
        if tag_set is None:
            log.error(f"Unsupported camera/extension: {make} {ext}; file skipped", target=str(file))
            raise FileFailure(f"unsupported camera/extension: {make} {ext}")

        ctx.backend.shift_tags(file, tag_set, shift, overwrite=overwrite)
        if tz_tags:
            ctx.backend.write_tags(file, tz_tags, overwrite=overwrite)

        if make == MAKE_INSTA360 and ext == ".mp4":
            _rename_insta360(file, shift, total_seconds_offset < 0)

    return run_per_file(files, process, activity="Shifting Exif time", parallel=parallel)


def move_altitude(path: Path | list[Path], offset: float, overwrite: bool = False,
                  parallel: bool = False) -> BatchResult[None]:
    """Shift GPSAltitude by a fixed offset (drone/ground-level correction)."""
    files = list_files(path)

    def process(file: Path) -> None:
        # -n 模式读到的已是按 GPSAltitudeRef 定了符号的十进制（Below Sea Level 为负）
        altitude = ctx.backend.read_tags(file, ["GPSAltitude"]).get("GPSAltitude", "")
        if is_missing_altitude(altitude):
            log.warning("No GPSAltitude found, skipping", target=str(file))
            raise FileFailure("no GPSAltitude to shift")

        new_alt = float(altitude) + offset
        log.verbose(f"Shifting altitude: {altitude} m -> {new_alt} m", target=str(file))
        write_exif_tags(file, SetExifOptions(altitude=new_alt, overwrite=overwrite))

    return run_per_file(files, process, activity=f"Shifting altitude by {offset} m", parallel=parallel)


def convert_to_mp4(path: Path | list[Path], make: str | None = None, model: str | None = None,
                   output_directory: Path | None = None,
                   offset_time: str = mediatime.DEFAULT_TZ_OFFSET,
                   parallel: bool = False) -> BatchResult[None]:
    """Remux videos to MP4 with creation_time metadata + XMP tags (ffmpeg)."""
    # 入口处一次性校验 offset_time 格式，坏参数直接报错，而不是逐文件失败
    mediatime.parse_offset(offset_time)
    files = list_files(path)
    output_dir = output_directory if output_directory is not None else (files[0].parent if files else Path())

    def process(file: Path) -> None:
        output_path = output_dir / f"{file.stem}.mp4"
        # 时间标签一次读齐；QuickTime:CreateDate 已在 TIME_TAGS 内，MP4 分支直接取用
        tags = ctx.backend.read_tags(file, mediatime.TIME_TAGS)
        media_time = mediatime.parse_media_time(tags, offset_time, target=str(file))

        if media_time is None:
            log.warning("No valid timestamp found; skipping", target=str(file))
            raise FileFailure("no valid timestamp")

        create_time_utc = media_time.astimezone(UTC)

        create_time_str = create_time_utc.strftime("%Y:%m:%d %H:%M:%S") + offset_time
        create_time_utc_str = create_time_utc.strftime("%Y-%m-%dT%H:%M:%S")

        if file.suffix.lower() != ".mp4":
            if output_path.exists():
                log.warning("Output file already exists", target=str(output_path))
                return
            ret = subprocess.run(
                ["ffmpeg", "-y", "-i", str(file), "-c", "copy",
                 "-metadata", f"creation_time={create_time_utc_str}", str(output_path)],
                capture_output=True)
            if ret.returncode != 0:
                log.error("Failed to convert to MP4", target=str(file))
                raise FileFailure("ffmpeg failed to convert to MP4")
            log.verbose("Converted to MP4", target=str(file))
        else:
            log.debug("File is already MP4", target=str(file))
            quicktime_create_date = tags.get("QuickTime:CreateDate", "")
            original_path = file.with_name(file.name + "_original")
            shutil.move(str(file), str(original_path))
            if not quicktime_create_date:
                log.debug("Setting QuickTime:CreateDate", target=str(output_path))
                ret = subprocess.run(
                    ["ffmpeg", "-y", "-i", str(original_path),
                     "-metadata", f"creation_time={create_time_utc_str}",
                     "-c", "copy", "-map", "0", str(output_path)],
                    capture_output=True)
                if ret.returncode != 0:
                    log.error("Failed to convert to MP4", target=str(file))
                    raise FileFailure("ffmpeg failed to convert to MP4")
            else:
                shutil.copy2(original_path, output_path)

        tags = {"XMP-exif:DateTimeOriginal": create_time_str}
        if make:
            tags["Make"] = make
        if model:
            tags["Model"] = model
        write_exif_tags(output_path, SetExifOptions(tags=tags, overwrite=True))
        log.verbose(f"Set tags: {', '.join(tags)}", target=str(output_path))

    return run_per_file(files, process, activity="Converting to MP4", parallel=parallel)


def group_media_files(path: Path) -> None:
    """Sort files into VID/RAW/IMG subdirectories by extension."""
    files = list_files(path)
    extensions = {f.suffix.lower() for f in files}
    if len(extensions) <= 1:
        log.debug("Skipping (all files have the same extension)", target=str(path))
        return

    for file in files:
        sub_dir = _EXTENSION_MAP.get(file.suffix.lower())
        if sub_dir is None:
            continue
        target_dir = path / sub_dir
        if not target_dir.is_dir():
            target_dir.mkdir()
            log.info(f"Created subdirectory: {sub_dir}", target=str(path))
        target_path = target_dir / file.name
        if target_path.exists():
            log.warning("File already exists in target directory", target=str(target_path))
        else:
            shutil.move(str(file), str(target_path))
            log.verbose(f"Moved to {sub_dir}", target=str(target_path))
