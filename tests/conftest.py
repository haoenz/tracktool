"""Shared test constants, fixtures and doubles."""

from collections.abc import Mapping, Sequence
from datetime import timedelta
from pathlib import Path

TRACK_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
<name>2024-05-01 test</name>
<Folder>
<Placemark>
<name>track</name>
<gx:Track>
<when>2024-05-01T00:00:00Z</when>
<when>2024-05-01T00:01:00Z</when>
<when>2024-05-01T00:02:00Z</when>
<when>2024-05-01T00:03:00Z</when>
<gx:coord>116.0 39.0 100</gx:coord>
<gx:coord>116.1 39.1 110</gx:coord>
<gx:coord>116.2 39.2 120</gx:coord>
<gx:coord>116.3 39.3 130</gx:coord>
</gx:Track>
</Placemark>
</Folder>
</Document>
</kml>"""


class InMemoryBackend:
    """MetadataBackend over a dict, recording every call it receives.

    Installed as `ctx.backend` it replaces the exiftool process for a whole
    test, so a rule can be driven by the tags a test hands over instead of by
    a file on disk.
    """

    def __init__(self, tags: dict[Path, dict[str, str]] | None = None) -> None:
        self.tags: dict[Path, dict[str, str]] = {Path(p): dict(t) for p, t in (tags or {}).items()}
        self.reads: list[tuple[Path, tuple[str, ...]]] = []
        self.writes: list[tuple[Path, dict[str, str], bool]] = []
        self.shifts: list[tuple[Path, tuple[str, ...], timedelta, bool]] = []

    def read_tags(self, path: Path, tags: Sequence[str]) -> dict[str, str]:
        self.reads.append((path, tuple(tags)))
        available = self.tags.get(Path(path), {})
        return {tag: available[tag] for tag in tags if tag in available}

    def write_tags(self, path: Path, tags: Mapping[str, str], *, overwrite: bool = False) -> None:
        self.writes.append((Path(path), dict(tags), overwrite))
        self.tags.setdefault(Path(path), {}).update(tags)

    def shift_tags(self, path: Path, tags: Sequence[str], delta: timedelta,
                   *, overwrite: bool = False) -> None:
        self.shifts.append((Path(path), tuple(tags), delta, overwrite))
