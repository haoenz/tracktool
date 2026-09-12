"""Media file operations: time shifting, altitude shifting, MP4 conversion,
extension-based grouping.

Timestamp sets are per camera maker (a SONY photo and a SONY clip carry the
same moment in different tags); an Insta360 clip's filename encodes the same
time its tags do, so a shifted clip is renamed to match. Each per-file rule
lives in a `decide_*` function that takes one file's metadata and returns the
steps to take, so the rules can be read (and tested) without an exiftool
process or an ffmpeg run in the way.
"""

import re
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .. import log, mediatime
from ..actions import Action, Failed, RemuxVideo, Rename, ShiftTags, Skip, WriteTags, run
from ..context import ctx
from ..discover import MEDIA_EXTENSIONS, list_files
from ..errors import UserInputError
from ..fileutil import BatchResult, run_per_file
from ..metadata import MediaMetadata
from .write import SetExifOptions, build_tags

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

# (make, ext) -> 要平移的时间标签集合；组合缺失即报错跳过该文件
_TAG_SETS: dict[tuple[str, str], list[str]] = {
    (MAKE_SONY, ".arw"): _SONY_PHOTO_TAGS,
    (MAKE_SONY, ".jpg"): _SONY_PHOTO_TAGS,
    (MAKE_SONY, ".jpeg"): _SONY_PHOTO_TAGS,
    (MAKE_SONY, ".mp4"): _SONY_MP4_TAGS,
    (MAKE_FUJIFILM, ".mp4"): _FUJIFILM_MP4_TAGS,
    (MAKE_INSTA360, ".mp4"): _INSTA360_MP4_TAGS,
}

SHIFT_TAGS = ["Make", "ExifIFD:OffsetTime"]


def _parse_time_diff(time_diff: str) -> int:
    """'+1h30m' / '-2d' -> signed seconds."""
    is_negative = time_diff.startswith("-")
    clean = time_diff.lstrip("+-")
    m = _RELATIVE_TIME_PATTERN.search(clean)
    if not m:
        raise UserInputError(f"Invalid TimeDiff: {time_diff}")
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


def _insta360_new_name(file: Path, shift: timedelta, is_negative: bool) -> str | None:
    """The name an Insta360 clip should carry after the shift, or None when the
    name does not encode a timestamp (an Insta360 build's does)."""
    m = _INSTA360_FILENAME_PATTERN.search(file.stem)
    if not m:
        return None
    original_time = datetime.strptime(m[1], "%Y%m%d_%H%M%S")
    new_time = original_time - shift if is_negative else original_time + shift
    return _INSTA360_FILENAME_PATTERN.sub(f"_{new_time.strftime('%Y%m%d_%H%M%S')}_", file.name)


def decide_time_shift(meta: MediaMetadata, time_diff: str, offset_time: str,
                      overwrite: bool) -> list[Action]:
    """The steps that shift one file's timestamps, plus the name sync that
    follows for an Insta360 clip whose name carries the same time."""
    resolved = _compute_time_shift(meta.path, time_diff, offset_time, meta.get("Make"),
                                   meta.get("ExifIFD:OffsetTime"))
    if resolved is None:
        return [Failed(meta.path, "time shift not applicable to this file")]
    total_seconds_offset, tz_tags = resolved

    if total_seconds_offset == 0:
        if not tz_tags:
            return [Skip(meta.path, "no timezone or time-shift changes required")]
        return [WriteTags(meta.path, tz_tags, overwrite)]

    make, ext = meta.get("Make"), meta.path.suffix.lower()
    tag_set = _TAG_SETS.get((make, ext))
    if tag_set is None:
        return [Failed(meta.path, f"unsupported camera/extension: {make} {ext}")]

    shift = timedelta(seconds=total_seconds_offset)
    actions: list[Action] = [ShiftTags(meta.path, tag_set, shift, overwrite)]
    if tz_tags:
        actions.append(WriteTags(meta.path, tz_tags, overwrite))
    if make == MAKE_INSTA360 and ext == ".mp4":
        new_name = _insta360_new_name(meta.path, shift, total_seconds_offset < 0)
        if new_name is None:
            log.error("Filename does not match Insta360 naming pattern", target=str(meta.path))
        else:
            actions.append(Rename(meta.path, new_name))
    return actions


def move_exif_time(path: Path | list[Path], time_diff: str = "", offset_time: str = "",
                   overwrite: bool = False, parallel: bool = False,
                   dry_run: bool = False) -> BatchResult[list[Action]]:
    """Shift EXIF timestamps; OffsetTime only supported for SONY. Insta360 files renamed."""
    if not time_diff and not offset_time:
        raise UserInputError("At least one of time_diff or offset_time must be provided.")

    files = list_files(path)

    def process(file: Path) -> list[Action]:
        # Make 与 OffsetTime 一次读齐，每个文件只往返 exiftool 一次
        meta = MediaMetadata.of(file, ctx.backend.read_tags(file, SHIFT_TAGS))
        return run(decide_time_shift(meta, time_diff, offset_time, overwrite), dry_run=dry_run)

    return run_per_file(files, process, activity="Shifting Exif time", parallel=parallel,
                        dry_run=dry_run)


def decide_altitude_shift(meta: MediaMetadata, offset: float, overwrite: bool) -> list[Action]:
    """Shift the recorded altitude; no altitude means there is nothing to shift."""
    altitude = meta.altitude
    if altitude is None:
        return [Failed(meta.path, "no GPSAltitude to shift")]
    new_alt = altitude + offset
    log.verbose(f"Shifting altitude: {altitude} m -> {new_alt} m", target=str(meta.path))
    return [WriteTags(meta.path, build_tags(SetExifOptions(altitude=new_alt)), overwrite)]


def move_altitude(path: Path | list[Path], offset: float, overwrite: bool = False,
                  parallel: bool = False, dry_run: bool = False) -> BatchResult[list[Action]]:
    """Shift GPSAltitude by a fixed offset (drone/ground-level correction)."""
    files = list_files(path)

    def process(file: Path) -> list[Action]:
        # -n 模式读到的已是按 GPSAltitudeRef 定了符号的十进制（Below Sea Level 为负）
        meta = MediaMetadata.of(file, ctx.backend.read_tags(file, ["GPSAltitude"]))
        return run(decide_altitude_shift(meta, offset, overwrite), dry_run=dry_run)

    return run_per_file(files, process, activity=f"Shifting altitude by {offset} m",
                        parallel=parallel, dry_run=dry_run)


def decide_convert(meta: MediaMetadata, output_dir: Path, offset_time: str,
                   make: str | None, model: str | None) -> list[Action]:
    """Rewrap one video into MP4 at its own creation time, then tag the result."""
    media_time = mediatime.parse_media_time(meta.tags, offset_time, target=str(meta.path))
    if media_time is None:
        return [Failed(meta.path, "no valid timestamp")]

    create_time_utc = media_time.astimezone(UTC)
    output = output_dir / f"{meta.path.stem}.mp4"
    source_is_mp4 = meta.path.suffix.lower() == ".mp4"
    if not source_is_mp4 and output.exists():
        return [Skip(meta.path, f"output already exists: {output.name}")]

    tags = {"XMP-exif:DateTimeOriginal": create_time_utc.strftime("%Y:%m:%d %H:%M:%S") + offset_time}
    if make:
        tags["Make"] = make
    if model:
        tags["Model"] = model
    return [
        RemuxVideo(meta.path, output, create_time_utc.strftime("%Y-%m-%dT%H:%M:%S"),
                   source_is_mp4=source_is_mp4,
                   has_quicktime_create_date=bool(meta.get("QuickTime:CreateDate"))),
        WriteTags(output, tags, overwrite=True),
    ]


def convert_to_mp4(path: Path | list[Path], make: str | None = None, model: str | None = None,
                   output_directory: Path | None = None,
                   offset_time: str = mediatime.DEFAULT_TZ_OFFSET,
                   parallel: bool = False,
                   dry_run: bool = False) -> BatchResult[list[Action]]:
    """Remux videos to MP4 with creation_time metadata + XMP tags (ffmpeg)."""
    # 入口处一次性校验 offset_time 格式，坏参数直接报错，而不是逐文件失败
    mediatime.parse_offset(offset_time)
    files = list_files(path)
    output_dir = output_directory if output_directory is not None else (files[0].parent if files else Path())

    def process(file: Path) -> list[Action]:
        # 时间标签一次读齐；QuickTime:CreateDate 已在 TIME_TAGS 内，MP4 分支直接取用
        meta = MediaMetadata.of(file, ctx.backend.read_tags(file, mediatime.TIME_TAGS))
        return run(decide_convert(meta, output_dir, offset_time, make, model), dry_run=dry_run)

    return run_per_file(files, process, activity="Converting to MP4", parallel=parallel,
                        dry_run=dry_run)


def group_media_files(path: Path) -> None:
    """Sort files into VID/RAW/IMG subdirectories by extension."""
    files = list_files(path)
    extensions = {f.suffix.lower() for f in files}
    if len(extensions) <= 1:
        log.debug("Skipping (all files have the same extension)", target=str(path))
        return

    for file in files:
        sub_dir = MEDIA_EXTENSIONS.get(file.suffix.lower())
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
