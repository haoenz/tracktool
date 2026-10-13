"""Snapshot access to SQLite archive content and persistent derived geometry."""

import sqlite3
import zlib
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from ..errors import UserInputError
from . import index, storage, trackdata
from .archive import ZipEntry
from .kmlfile import TrackKind


class TrackArchive:
    def __init__(self, path: Path, db: sqlite3.Connection) -> None:
        self.path = path
        self.db = db
        self.closed = False

    def _require_open(self) -> None:
        if self.closed:
            raise UserInputError(f"Archive is closed: {self.path}")

    def list_entries(self) -> list[ZipEntry]:
        self._require_open()
        return [
            ZipEntry(r["path"], TrackKind(r["category"]) if r["category"] else None)
            for r in self.db.execute("SELECT path,category FROM archive_entries ORDER BY path")
        ]

    def fingerprint(self, entry: str) -> str:
        self._require_open()
        row = self.db.execute("SELECT sha256 FROM archive_entries WHERE path=?", (entry,)).fetchone()
        if row is None:
            raise UserInputError(f"KML entry not found: {entry}; use a complete archive member path")
        return row[0]

    def read_bytes(self, entry: str) -> bytes:
        return storage.read_object(self.db, self.fingerprint(entry))

    def read_track_data(self, entry_path: str) -> trackdata.KmlTrackData:
        return self.read_track_data_with_fingerprint(entry_path)[0]

    def read_track_data_with_fingerprint(
        self, entry_path: str, *, max_bytes: int | None = None
    ) -> tuple[trackdata.KmlTrackData, str]:
        digest = self.fingerprint(entry_path)
        size = self.db.execute("SELECT raw_size FROM kml_objects WHERE sha256=?", (digest,)).fetchone()[0]
        if max_bytes is not None and size > max_bytes:
            raise UserInputError(f"{entry_path}: KML entry exceeds the {max_bytes} byte read limit")
        # Fetch index through this snapshot, preserving reads across concurrent pop.
        row = self.db.execute(
            "SELECT status,geometry,error FROM kml_index WHERE sha256=? AND parser_version=?",
            (digest, index.PARSER_VERSION),
        ).fetchone()
        source = f"{self.path}!/{entry_path}"
        if row:
            if row["status"] == "error":
                raise UserInputError(f"{source}: {row['error']}")
            try:
                return index.deserialize(row["geometry"], source), digest
            except ValueError, KeyError, TypeError, zlib.error, AssertionError:
                pass
        return index.read_index(self.path, digest, storage.read_object(self.db, digest), source), digest


@contextmanager
def open_archive(path: str | Path) -> Iterator[TrackArchive]:
    """Directory, SQLite path, or legacy ZIP locator (never read the ZIP).

    A ZIP locator resolves only to its sibling SQLite file. Missing databases
    require explicit migration, so an old backup can never silently become truth.
    """
    resolved = storage.database_path(path)
    with storage.connect(resolved) as db:
        archive = TrackArchive(resolved, db)
        try:
            yield archive
        finally:
            archive.closed = True
