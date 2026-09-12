"""The metadata seam: metadata operations, named in metadata terms.

Callers name tags and a shift; nothing outside the backend knows that exiftool
is a separate process taking `-Tag=value` arguments, that a time shift is spelt
`-Tag+=0:0:1 2:30:00`, or that a file past 4 GiB needs an extra API flag.
Keeping that syntax behind this line is what lets the decision rules run
against an in-memory double, and stops tool arguments from leaking into
anything a caller reports — a dry run should print tags, not exiftool flags.
"""

from collections.abc import Mapping, Sequence
from datetime import timedelta
from pathlib import Path
from typing import Protocol, runtime_checkable


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
