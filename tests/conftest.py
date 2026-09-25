"""Shared test constants, fixtures and doubles."""

import shutil
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from tracktool.context import RunMode, ctx

_MEDIA_TOOLS = ("exiftool", "ffmpeg")

# 走真实外部工具的用例贴上它：`-m "not integration"` 于是得到一个不碰外部工具的
# 运行，而工具缺席时这些用例是跳过而不是失败（skipif 管跳过，标记管筛选）。
requires_media_tools = [
    pytest.mark.integration,
    pytest.mark.skipif(not all(shutil.which(tool) for tool in _MEDIA_TOOLS),
                       reason="requires " + " and ".join(_MEDIA_TOOLS)),
]

def make_archive(directory: Path) -> Path:
    """Declare a test archive directory the way `archive init` does; return the ZIP path.

    Since E1 an archive exists only when its directory holds archive.json, so
    any test that files tracks into one starts here instead of hand-writing
    the manifest. Fixture setup, not a run under test: it forces APPLY so a
    plan-mode test still gets its archive.
    """
    from tracktool.kml.archive import init_archive

    mode = ctx.mode
    ctx.mode = RunMode.APPLY
    try:
        init_archive(directory)
    finally:
        ctx.mode = mode
    return directory / "Archive.zip"


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


_STAMP_FORMAT = "%Y:%m:%d %H:%M:%S"


def _shift_stamp(value: str | None, delta: timedelta) -> str | None:
    """The stamp moved by delta, or None when the double cannot move it.

    The double knows exiftool's canonical `YYYY:MM:DD HH:MM:SS` form, which is
    what the app's own writes produce; any other form is left as it was, so a
    test that needs one belongs against the real backend.
    """
    if not value:
        return None
    try:
        stamp = datetime.strptime(value, _STAMP_FORMAT)
    except ValueError:
        return None
    return (stamp + delta).strftime(_STAMP_FORMAT)


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
        """The shift lands on the double's own tags, not just on the record.

        Recording alone would let a rule that reads a time back after shifting
        it pass here and fail on a real file, which is the drift the backend
        contract exists to catch.
        """
        self.shifts.append((Path(path), tuple(tags), delta, overwrite))
        available = self.tags.setdefault(Path(path), {})
        for tag in tags:
            moved = _shift_stamp(available.get(tag), delta)
            if moved is not None:
                available[tag] = moved


@pytest.fixture(autouse=True)
def apply_mode(monkeypatch) -> None:
    """Every test starts in APPLY.

    The run mode is global state on the shared context, so a test that leaves
    it in PLAN — the CLI does exactly that when it sees --dry-run — would
    silently turn every later test into a dry run.
    """
    monkeypatch.setattr(ctx, "mode", RunMode.APPLY)


@pytest.fixture
def plan_mode(apply_mode, monkeypatch) -> None:
    """Put the run in PLAN mode: every write reports instead of happening.

    The mode is a field of the context, not a parameter, so a test flips it
    the same way the CLI does and then calls the ordinary entry point.
    """
    monkeypatch.setattr(ctx, "mode", RunMode.PLAN)
