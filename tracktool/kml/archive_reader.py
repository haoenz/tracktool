"""Explicit, read-only access to selected KML entries in a declared archive.

No config lookup, extraction to disk, geometry cache, or archive write workflow.
Open via open_archive(zip_path); the context owns the ZIP handle, while returned
ZipEntry metadata and KmlTrackData arrays can outlive it.
"""

import hashlib
import lzma
import zipfile
import zlib
from collections.abc import Iterator
from compression.zstd import ZstdError
from contextlib import contextmanager
from pathlib import Path

from ..errors import UserInputError
from ..workspace import resolve_archive
from . import trackdata, xmlutil
from .archive import ZipEntry, entry_kind_from_path

# zipfile exposes decompressor errors as well as its own CRC/header errors.
_ZIP_READ_ERRORS = (
    OSError,
    zipfile.BadZipFile,
    EOFError,
    RuntimeError,
    UnicodeError,
    zlib.error,
    lzma.LZMAError,
    ZstdError,
)


class TrackArchive:
    """An open archive, owned by the open_archive context manager.

    Methods fail with UserInputError after the context closes. Callers decide
    whether to continue after an entry error; nothing is silently skipped.
    """

    def __init__(self, zip_path: Path, archive: zipfile.ZipFile) -> None:
        self._zip_path = zip_path
        self._archive = archive

    @property
    def closed(self) -> bool:
        return self._archive.fp is None

    def _require_open(self) -> None:
        if self.closed:
            raise UserInputError(f"Archive is closed: {self._zip_path}")

    def list_entries(self) -> list[ZipEntry]:
        """List KMLs sorted by exact ZIP path, without reading their contents.

        Extension matching ignores case. Directories and non-KMLs are omitted.
        Repeated KML paths are ambiguous and raise, rather than being collapsed.
        kind comes only from the directory, never from parsing activity tags.
        """
        self._require_open()
        entries = []
        seen: set[str] = set()
        for info in self._archive.infolist():
            if info.is_dir() or not info.filename.lower().endswith(".kml"):
                continue
            if info.filename in seen:
                raise UserInputError(f"{self._zip_path}!/{info.filename}: Ambiguous KML entry (duplicate ZIP path)")
            seen.add(info.filename)
            entries.append(ZipEntry(info.filename, entry_kind_from_path(info.filename)))
        return sorted(entries, key=lambda entry: entry.path)

    def read_track_data(self, entry_path: str) -> trackdata.KmlTrackData:
        """Read one exact, case-sensitive path as returned by list_entries.

        No basename/stem matching or path normalization. Source labels are
        '<absolute ZIP path>!/<exact entry path>', positions rather than stable
        IDs. Only this entry is decompressed, CRC-checked and parsed, each call.
        """
        return self.read_track_data_with_fingerprint(entry_path)[0]

    def read_track_data_with_fingerprint(
        self, entry_path: str, *, max_bytes: int | None = None
    ) -> tuple[trackdata.KmlTrackData, str]:
        """Read once and return geometry plus SHA-256 of the exact KML bytes.

        The fingerprint describes the same bytes that were parsed, including
        metadata. It is independent of ZIP compression, timestamps and order.
        max_bytes optionally bounds the uncompressed entry before allocation.
        """
        self._require_open()
        source = f"{self._zip_path}!/{entry_path}"
        matches = [
            info
            for info in self._archive.infolist()
            if info.filename == entry_path and not info.is_dir() and info.filename.lower().endswith(".kml")
        ]
        if not matches:
            raise UserInputError(f"{source}: KML entry not found; use a complete ZIP entry path from list_entries()")
        if len(matches) != 1:
            raise UserInputError(f"{source}: Ambiguous KML entry ({len(matches)} entries have the same ZIP path)")
        if max_bytes is not None and matches[0].file_size > max_bytes:
            raise UserInputError(f"{source}: KML entry exceeds the {max_bytes} byte read limit")
        try:
            content = self._archive.read(matches[0])
        except _ZIP_READ_ERRORS as exc:
            raise UserInputError(f"Cannot read KML entry {source}: {exc}") from exc
        try:
            tree = xmlutil.parse_string(content)
        except UserInputError as exc:
            raise UserInputError(f"{source}: {exc}") from exc
        return trackdata.track_data_from_tree(tree, source=source), hashlib.sha256(content).hexdigest()


@contextmanager
def open_archive(zip_path: str | Path) -> Iterator[TrackArchive]:
    """Open an existing ZIP, following resolve_archive's explicit-path rules.

    Pass a ZIP file, not an archive directory. Its parent must contain the
    archive.json identity file; as with the existing explicit --zip path, its
    presence is checked without reading configuration or the manifest's ZIP
    name. Relative paths and '~' resolve using the existing workspace helper.
    The ZIP opens on entering the context and closes on any exit, including an
    exception in the caller's with block. No entry contents are read on open.
    """
    try:
        if not str(zip_path) or Path(zip_path).expanduser().is_dir():
            raise UserInputError(f"Expected an explicit archive ZIP file path, not a directory: {zip_path!s}")
        _, resolved = resolve_archive(str(zip_path))
        archive = zipfile.ZipFile(resolved, mode="r")
    except (*_ZIP_READ_ERRORS, ValueError) as exc:
        raise UserInputError(f"Cannot open archive {zip_path!s}: {exc}") from exc
    try:
        yield TrackArchive(resolved, archive)
    finally:
        archive.close()
