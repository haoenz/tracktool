"""Media timestamp extraction (Get-MediaTime).

Tag priority with three timezone strategies:
- Separate: offset lives in its own EXIF tags (Exif:OffsetTime*), defaults to +08:00
- Include:  offset embedded in the datetime string, e.g. "2024:10:30 12:00:00+08:00"
- UTC:      time is UTC; a Z is appended before parsing

All returned datetimes are timezone-aware (their tzinfo is the *recorded*
timezone, not necessarily local time).
"""

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import exiftool, log

_TAG_CONFIGS = [
    {
        "tag": "Exif:DateTimeOriginal",
        "tz": "separate",
        "offset_tags": ["Exif:OffsetTimeOriginal", "Exif:OffsetTime", "Exif:OffsetTimeDigitized"],
    },
    {"tag": "H264:DateTimeOriginal", "tz": "include"},
    {"tag": "XMP-exif:DateTimeOriginal", "tz": "include"},
    {"tag": "QuickTime:CreateDate", "tz": "utc"},
    {"tag": "Track1:TrackCreateDate", "tz": "utc"},
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
    # 但保持 tzinfo 为该 offset（与 PowerShell ParseExact 的 K 行为一致）
    return naive.replace(tzinfo=timezone(timedelta(seconds=seconds)))


def get_media_time(path: Path, default_offset: str = "+08:00") -> datetime | None:
    """Extract a timezone-aware creation timestamp, or None if no tag parses.

    The returned datetime's tzinfo equals the recorded timezone offset; use
    .astimezone(timezone.utc) to compare across sources.
    """
    for cfg in _TAG_CONFIGS:
        time_str = exiftool.get_media_tag(path, cfg["tag"])
        if not time_str:
            continue

        try:
            if cfg["tz"] == "utc":
                if time_str.endswith("Z"):
                    media_time = _aware(_naive(time_str[:-1]), "Z")
                else:
                    media_time = _aware(_naive(time_str), "Z")
            elif cfg["tz"] == "separate":
                m = _TIME_PATTERN.match(time_str)
                if m and m[7]:  # already carries an offset
                    media_time = _aware(_naive(time_str), m[7])
                else:
                    offset = ""
                    for offset_tag in cfg["offset_tags"]:
                        offset = exiftool.get_media_tag(path, offset_tag)
                        if offset:
                            break
                    media_time = _aware(_naive(time_str), offset or default_offset)
            else:  # include
                m = _TIME_PATTERN.match(time_str)
                if not m or not (m[7] or m[8]):
                    raise ValueError(f"No embedded timezone: {time_str}")
                media_time = _aware(_naive(time_str), m[7] or m[8])
        except ValueError:
            log.debug(f"Failed to parse {cfg['tag']}: {time_str}", target=str(path))
            continue

        log.debug(f"Using {cfg['tag']}: {media_time}", target=str(path))
        return media_time

    log.warning("No valid timestamp found", target=str(path))
    return None


def parse_offset(offset: str) -> int:
    """Public helper: '+08:00'-style offset -> seconds."""
    return _offset_seconds(offset)
