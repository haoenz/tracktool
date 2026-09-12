"""The metadata seam: metadata operations, named in metadata terms.

Callers name tags and a shift; nothing outside the backend knows that exiftool
is a separate process taking `-Tag=value` arguments, that a time shift is spelt
`-Tag+=0:0:1 2:30:00`, or that a file past 4 GiB needs an extra API flag.
Keeping that syntax behind this line is what lets the decision rules run
against an in-memory double, and stops tool arguments from leaking into
anything a caller reports — a dry run should print tags, not exiftool flags.

The other half of the seam is the value the tags are read into. `MediaMetadata`
carries one file's tags and answers the questions the rules ask of them
(position? altitude?), so a rule takes metadata and returns a decision instead
of parsing tag strings at every use. Both halves are free of project imports,
which is what makes them testable without a subprocess.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Protocol, runtime_checkable

# 海拔标签在 -n 模式下的读取方式见 is_missing_altitude；两个规则（补海拔、
# 查缺失）共用它，避免各自判断「什么算没有海拔」而再次分叉。
ZERO_ALTITUDE = 0.0


def is_missing_altitude(value: str | float | None) -> bool:
    """Zero altitude (either direction) counts as missing, like an absent value.

    exiftool is read in -n mode, so the value is a signed decimal ("100",
    "-50") and a zero altitude is a plain 0 whichever hemisphere it is in.
    """
    if value is None or value == "":
        return True
    try:
        return float(value) == ZERO_ALTITUDE
    except (TypeError, ValueError):
        # 非数值形态无法判为零，按旧行为视为有值
        return False


@runtime_checkable
class MetadataBackend(Protocol):
    """Where a command reads and writes a file's metadata."""

    def read_tags(self, path: Path, tags: Sequence[str]) -> dict[str, str]:
        """Every requested tag the file carries, keyed by the requested names.

        A tag the file does not carry is absent from the result rather than an
        empty string, so "no value recorded" and "recorded as empty" stay apart.
        """
        ...

    def write_tags(self, path: Path, tags: Mapping[str, str], *, overwrite: bool = False) -> None:
        """Assign the given tags, keeping a backup of the original unless told not to."""
        ...

    def shift_tags(self, path: Path, tags: Sequence[str], delta: timedelta,
                   *, overwrite: bool = False) -> None:
        """Move each named timestamp tag by delta, leaving every other tag alone."""
        ...


@dataclass(frozen=True)
class MediaMetadata:
    """One file's tags, read once, plus the questions the rules ask of them.

    Reading is the backend's job and deciding is this object's; a rule that
    takes one of these needs no tag access of its own, so it can be exercised
    from a dict instead of a file. Values the file does not carry, values that
    are empty, and values that do not parse all read as absent — a rule then has
    one "no value" case to handle instead of three.
    """

    path: Path
    tags: Mapping[str, str]

    @classmethod
    def of(cls, path: Path, tags: Mapping[str, str]) -> MediaMetadata:
        return cls(path=path, tags=dict(tags))

    def get(self, tag: str, default: str = "") -> str:
        """The tag's raw value; absent reads as the default (empty by default)."""
        value = self.tags.get(tag, default)
        return default if value is None else value

    @property
    def position(self) -> tuple[float, float] | None:
        """(latitude, longitude) in decimal degrees, or None unless both are there."""
        latitude, longitude = self.get("GPSLatitude"), self.get("GPSLongitude")
        if not latitude or not longitude:
            return None
        try:
            return float(latitude), float(longitude)
        except ValueError:
            return None

    @property
    def has_position(self) -> bool:
        return self.position is not None

    @property
    def altitude(self) -> float | None:
        """The altitude in meters, or None when there is no usable number.

        Zero counts as no altitude (see is_missing_altitude), and so does a
        value that does not parse: both leave the caller free to fill one in.
        """
        raw = self.get("GPSAltitude")
        if is_missing_altitude(raw):
            return None
        try:
            return float(raw)
        except ValueError:
            return None

    @property
    def has_altitude(self) -> bool:
        """Whether the file records an altitude at all — zero does not count.

        Distinct from `altitude is not None`: a non-numeric value counts as
        recorded (the historical rule) while yielding no number to shift.
        """
        return not is_missing_altitude(self.get("GPSAltitude"))
