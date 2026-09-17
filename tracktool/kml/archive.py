"""The KML archive's own storage: the ZIP, and what a restore checks first.

The ZIP keeps every KML flat-named (entry = file name) and is rewritten
wholesale on removal, since zipfile has no entry-delete API. Restoring creates
nothing and refuses to run on an archive that disagrees with itself, so half a
track cannot be restored; `--force` turns those refusals into warnings and
skips only the step they belong to.

Filing a track in — which collections, the ZIP, the backup folder, in what
order — is a sequence of domain steps rather than a property of any one of
them, and lives in workflows.push_tracks. What stays here are the pieces that
sequence is built from: making the archive exist, appending to it, and reading
it back.
"""

import shutil
import zipfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from .. import log
from ..context import ctx
from ..errors import UserInputError
from ..paths import display_path
from ..workspace import resolve_zip_path
from . import collections
from .kmlfile import TrackType


def ensure_archive_directory(archive_dir: Path) -> None:
    """Create the archive directory; a location that cannot be made is user input."""
    if ctx.is_plan:
        log.info("Would create archive directory", target=str(archive_dir))
        return
    try:
        archive_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise UserInputError(f"Cannot create archive directory {display_path(archive_dir)}: {exc}") from exc


def ensure_zip_file(zip_file: Path) -> None:
    """Create the archive (and its directory) when they are not there yet.

    An empty archive is written rather than a zero-byte placeholder: the
    latter is not a ZIP at all (zipfile rejects it), so readers would trip
    over an archive that only looks like one.
    """
    if zip_file.is_file():
        return
    if ctx.is_plan:
        log.info("Would create a new ZIP archive", target=str(zip_file))
        return
    ensure_archive_directory(zip_file.parent)
    try:
        with zipfile.ZipFile(zip_file, "w", zipfile.ZIP_DEFLATED):
            pass
    except OSError as exc:
        raise UserInputError(f"Cannot create KML compressed file {display_path(zip_file)}: {exc}") from exc
    log.info("Created new ZIP archive", target=str(zip_file))


def find_zip_entry(kml_name: str, zip_path: Path) -> str | None:
    """The entry whose file name contains kml_name, None when there is none."""
    with zipfile.ZipFile(zip_path) as zf:
        return next((info.filename for info in zf.infolist()
                     if kml_name in Path(info.filename).name), None)


def push_compressed_kml(kml_path: Path, zip_path: Path) -> None:
    """Add a KML to the ZIP archive if not already present."""
    push_compressed_kmls([kml_path], zip_path)


def push_compressed_kmls(kml_paths: Sequence[Path], zip_path: Path) -> None:
    """Add KMLs to the ZIP, opening it once for the whole batch.

    One open means one index read and one write stream for N entries, where
    looping over push_compressed_kml would reopen and re-read the archive each
    time.
    """
    if ctx.is_plan:
        # 提前返回还有一层理由：ZipFile 的 "a" 模式会把不存在的压缩包建出来
        for kml_path in kml_paths:
            log.info(f"Would add to ZIP: {kml_path.name}", target=str(zip_path))
        return
    with zipfile.ZipFile(zip_path, "a", zipfile.ZIP_DEFLATED) as zf:
        names = {Path(info.filename).name for info in zf.infolist()}
        for kml_path in kml_paths:
            if kml_path.name in names:
                log.warning(f"Already exists in ZIP: {kml_path.name}", target=str(zip_path))
                continue
            zf.write(kml_path, kml_path.name)
            log.info(f"Added to ZIP: {kml_path.name}", target=str(zip_path))


def pop_compressed_kml(kml_name: str, zip_path: Path, output_directory: Path = Path(".")) -> None:
    """Extract an entry matching kml_name from the ZIP, then delete the entry.

    Extraction and entry removal go together: an entry that was not written
    out stays in the archive, since deleting it would take the track's only
    copy with it.
    """
    entry_name = find_zip_entry(kml_name, zip_path)
    if entry_name is None:
        log.warning(f"Entry not found in ZIP: {kml_name}", target=str(zip_path))
        return
    log.debug(f"Found entry in ZIP: {entry_name}", target=str(zip_path))

    target_path = output_directory / Path(entry_name).name
    if target_path.exists():
        raise UserInputError(f"File already exists at destination: {display_path(target_path)}")

    if ctx.is_plan:
        log.info(f"Would extract {entry_name} and remove it from the ZIP", target=str(zip_path))
        return

    with zipfile.ZipFile(zip_path) as zf, zf.open(entry_name) as src, open(target_path, "wb") as dst:
        shutil.copyfileobj(src, dst)
    log.info(f"Extracted from ZIP: {entry_name}", target=str(zip_path))

    # zipfile has no entry-delete API: rewrite the archive without the entry
    with zipfile.ZipFile(zip_path) as zf:
        remaining = {info.filename: zf.read(info.filename)
                     for info in zf.infolist() if info.filename != entry_name}
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, blob in remaining.items():
            zf.writestr(name, blob)
    log.debug(f"Removed from ZIP: {entry_name}", target=str(zip_path))


@dataclass(frozen=True)
class _ArchiveState:
    """What the archive holds for one track, plus every disagreement found."""

    zip_entry: str | None
    in_desktop: bool
    in_mobile: bool
    problems: list[str]


def _inspect_archive(kml_name: str, zip_file: Path, desktop_collection: Path,
                     mobile_collection: Path) -> _ArchiveState:
    """Look the track up in the archive's three records, collecting disagreements.

    Listed as a restore consumes them: the ZIP, then the desktop collection
    (the primary record, always expected), then the mobile one, which is
    optional as a file but must hold the track once it exists.
    """
    zip_exists = zip_file.is_file()
    zip_entry = find_zip_entry(kml_name, zip_file) if zip_exists else None
    desktop_exists = desktop_collection.is_file()
    in_desktop = desktop_exists and collections.has_desktop_track(kml_name, desktop_collection)
    mobile_exists = mobile_collection.is_file()
    in_mobile = mobile_exists and collections.has_mobile_track(kml_name, mobile_collection)

    problems: list[str] = []
    if not zip_exists:
        problems.append(f"KML compressed file does not exist: {display_path(zip_file)}")
    elif zip_entry is None:
        problems.append(f"Track not found in ZIP: {kml_name}")
    if not desktop_exists:
        problems.append(f"Collection KML file does not exist: {display_path(desktop_collection)}")
    elif not in_desktop:
        problems.append(f"Track not found in collection: {kml_name}")
    if mobile_exists and not in_mobile:
        problems.append(f"Track not found in mobile collection: {kml_name}")
    return _ArchiveState(zip_entry, in_desktop, in_mobile, problems)


def pop_kml_archive(kml_name: str, type_: TrackType = TrackType.DEFAULT, zip_path: str | None = None,
                    force: bool = False) -> None:
    """Restore a KML track: extract from ZIP and remove from both collections.

    Nothing is touched before the archive agrees with itself on this track, so
    a track cannot be restored out of one record while another keeps it.
    --force warns about each disagreement instead of stopping, and skips only
    the step whose record is missing.
    """
    zip_file = resolve_zip_path(zip_path)
    archive_dir = zip_file.parent
    desktop_collection, mobile_collection = collections.collection_paths(type_, archive_dir)

    state = _inspect_archive(kml_name, zip_file, desktop_collection, mobile_collection)
    if state.problems:
        if not force:
            raise UserInputError(f"Cannot restore {kml_name}: " + "; ".join(state.problems))
        for problem in state.problems:
            log.warning(f"{problem} (forced)", target=str(archive_dir))

    if state.zip_entry is not None:
        pop_compressed_kml(state.zip_entry, zip_file)
    if state.in_desktop:
        collections.remove_track_from_desktop_collection(kml_name, desktop_collection)
    if state.in_mobile:
        collections.remove_track_from_mobile_collection(kml_name, mobile_collection)
