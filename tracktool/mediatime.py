"""Media timestamp extraction.

Tag priority with three timezone strategies:
- Separate: offset lives in its own EXIF tags (ExifIFD:OffsetTime*), defaults to +08:00
- Include:  offset embedded in the datetime string, e.g. "2024:10:30 12:00:00+08:00"
- UTC:      time is UTC; a Z is appended before parsing

All returned datetimes are timezone-aware (their tzinfo is the *recorded*
timezone, not necessarily local time).
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from pathlib import Path

from . import log
from .context import ctx
from .errors import UserInputError
from .tags import (
    CAPTURE_TIME,
    H264_CAPTURE_TIME,
    OFFSET_TIME,
    OFFSET_TIME_DIGITIZED,
    OFFSET_TIME_ORIGINAL,
    QUICKTIME_CREATE_DATE,
    TIME_TAGS,
    TRACK_CREATE_DATE,
    XMP_CAPTURE_TIME,
)

# 假定的相机时区：EXIF 未记录 OffsetTime 时的回退值
DEFAULT_TZ_OFFSET = "+08:00"


class TZStrategy(StrEnum):
    """How a tag's timestamp carries its timezone offset."""

    SEPARATE = "separate"
    INCLUDE = "include"
    UTC = "utc"


@dataclass(frozen=True)
class TagConfig:
    """One candidate timestamp tag: where its time lives, where its offset does."""

    tag: str
    tz: TZStrategy
    offset_tags: list[str] = field(default_factory=list)


# 按优先级排列的候选时间标签：先试到的先用，解析不了才落到下一条。
# 这里只管「先试谁、怎么解」，要读哪些标签归 tags.TIME_TAGS。
_TAG_CONFIGS = [
    TagConfig(CAPTURE_TIME, TZStrategy.SEPARATE,
              [OFFSET_TIME_ORIGINAL, OFFSET_TIME, OFFSET_TIME_DIGITIZED]),
    TagConfig(H264_CAPTURE_TIME, TZStrategy.INCLUDE),
    TagConfig(XMP_CAPTURE_TIME, TZStrategy.INCLUDE),
    TagConfig(QUICKTIME_CREATE_DATE, TZStrategy.UTC),
    TagConfig(TRACK_CREATE_DATE, TZStrategy.UTC),
]

# "yyyy:MM:dd HH:mm:ss" with optional trailing "+HH:MM" or "Z"
_TIME_PATTERN = re.compile(r"^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:([+-]\d{2}:\d{2})|(Z))?$")
_OFFSET_PATTERN = re.compile(r"^([+-])(\d{2}):(\d{2})$")


def _offset_seconds(offset: str) -> int:
    """'+08:00' -> 28800 seconds; raises ValueError on bad format."""
    m = _OFFSET_PATTERN.match(offset)
    if not m:
        raise ValueError(f"Invalid timezone offset: {offset}")
    total = int(m[2]) * 3600 + int(m[3]) * 60
    return -total if m[1] == "-" else total


def _naive(time_str: str) -> datetime:
    m = _TIME_PATTERN.match(time_str)
    if not m:
        raise ValueError(f"Unparseable time: {time_str}")
    return datetime(int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5]), int(m[6]))


def _aware(naive: datetime, offset: str) -> datetime:
    seconds = 0 if offset in ("Z", "+00:00", "-00:00") else _offset_seconds(offset)
    # 时间戳本身记录在 offset 时区：绝对时刻 = naive - offset（UTC），
    # 但保持 tzinfo 为该 offset
    return naive.replace(tzinfo=timezone(timedelta(seconds=seconds)))


def parse_media_time(tags: Mapping[str, str], default_offset: str = DEFAULT_TZ_OFFSET,
                     target: str | None = None) -> datetime | None:
    """Pick the highest-priority parseable timestamp out of already-read tags.

    `tags` is keyed by the TIME_TAGS names (read_tags output), which
    lets a caller that needs other tags from the same file read them all in one
    call. Returns a timezone-aware datetime, or None if no candidate parses.
    """
    for cfg in _TAG_CONFIGS:
        time_str = tags.get(cfg.tag, "")
        if not time_str:
            continue

        try:
            match cfg.tz:
                case TZStrategy.UTC:
                    if time_str.endswith("Z"):
                        media_time = _aware(_naive(time_str[:-1]), "Z")
                    else:
                        media_time = _aware(_naive(time_str), "Z")
                case TZStrategy.SEPARATE:
                    m = _TIME_PATTERN.match(time_str)
                    if m and m[7]:  # already carries an offset
                        media_time = _aware(_naive(time_str), m[7])
                    else:
                        offset = next((tags.get(tag, "") for tag in cfg.offset_tags if tags.get(tag)), "")
                        media_time = _aware(_naive(time_str), offset or default_offset)
                case TZStrategy.INCLUDE:
                    m = _TIME_PATTERN.match(time_str)
                    if not m or not (m[7] or m[8]):
                        raise ValueError(f"No embedded timezone: {time_str}")
                    media_time = _aware(_naive(time_str), m[7] or m[8])
        except ValueError:
            log.debug(f"Failed to parse {cfg.tag}: {time_str}", target=target)
            continue

        log.debug(f"Using {cfg.tag}: {media_time}", target=target)
        return media_time

    log.debug("No valid timestamp found", target=target)
    return None


def get_media_time(path: Path, default_offset: str = DEFAULT_TZ_OFFSET) -> datetime | None:
    """Extract a timezone-aware creation timestamp, or None if no tag parses.

    The returned datetime's tzinfo equals the recorded timezone offset; use
    .astimezone(timezone.utc) to compare across sources.
    """
    return parse_media_time(ctx.backend.read_tags(path, TIME_TAGS), default_offset, target=str(path))


def parse_offset(offset: str) -> int:
    """Public helper: '+08:00'-style offset -> seconds.

    The internal parsers signal a bad value with ValueError so a caller
    can skip an unreadable tag; at this public boundary it becomes an
    AppError the CLI reports without a traceback.
    """
    try:
        return _offset_seconds(offset)
    except ValueError as exc:
        raise UserInputError(str(exc)) from exc
