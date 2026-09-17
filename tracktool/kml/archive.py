"""Filing tracks into, and out of, the KML archive.

Push files a track everywhere it belongs — both collections, the ZIP archive,
then the backup folder; pop reverses it. The ZIP itself keeps every KML
flat-named (entry = file name) and is rewritten wholesale on removal, since
zipfile has no entry-delete API.

Filing creates what is missing (the archive directory, the archive itself, an
empty collection) — the first track of an archive has nowhere to go otherwise.
Restoring is the opposite: it creates nothing and refuses to run on an archive
that disagrees with itself, so half a track cannot be restored. `--force`
turns those refusals into warnings and skips only the step they belong to.
"""

import shutil
import zipfile
from dataclasses import dataclass
from pathlib import Path

from .. import log
from ..context import ctx
from ..errors import UserInputError
from ..fileutil import move_to_folder
from ..paths import display_path
from ..workspace import resolve_zip_path
from . import collections, kmlfile, xmlutil
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
    if ctx.is_plan:
        # 提前返回还有一层理由：ZipFile 的 "a" 模式会把不存在的压缩包建出来
        log.info(f"Would add to ZIP: {kml_path.name}", target=str(zip_path))
        return
    with zipfile.ZipFile(zip_path, "a", zipfile.ZIP_DEFLATED) as zf:
        names = [Path(info.filename).name for info in zf.infolist()]
        if kml_path.name in names:
            log.warning(f"Already exists in ZIP: {kml_path.name}", target=str(zip_path))
            return
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


def push_kml_archive(path: Path, zip_path: str | None = None, type_: TrackType | None = None,
                     no_archive: bool = False) -> None:
    """Archive a KML track: both collections + ZIP + move to backup folder."""
    zip_file = resolve_zip_path(zip_path)
    archive_dir = zip_file.parent

    log.info("Archiving KML track", target=str(path))
    kml_type = type_ if type_ is not None else kmlfile.get_kml_type(path)
    if kml_type is TrackType.UNKNOWN:
        log.error("Cannot archive track with unknown type", target=str(path))
        return

    if ctx.is_plan:
        # 进档的每一步都会创建或追加：预演只说明这条轨迹会落到哪几处
        log.info(f"Would archive as {kml_type}: {kml_type}.kml, {kml_type}.Mobile.kml"
                 + ("" if no_archive else f", {zip_file.name}")
                 + f", {ctx.config.kml_backup_dir_name}/", target=str(path))
        return

    # 聚合文件与 ZIP 同目录，两者都按需创建，目录也一样
    ensure_archive_directory(archive_dir)
    collection_kml_path = archive_dir / f"{kml_type}.kml"
    if not collection_kml_path.is_file():
        if xmlutil.save(collections.new_empty_kml(kml_type), collection_kml_path):
            log.info("Created new collection KML file", target=str(collection_kml_path))
    collections.add_track_to_desktop_collection(path, collection_kml_path)

    mobile_collection_path = archive_dir / f"{kml_type}.Mobile.kml"
    collections.add_track_to_mobile_collection(path, mobile_collection_path)

    if not no_archive:
        ensure_zip_file(zip_file)
        push_compressed_kml(path, zip_file)

    move_to_folder(path, ctx.config.kml_backup_dir_name, archive_dir)


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
    desktop_collection = archive_dir / f"{type_}.kml"
    mobile_collection = archive_dir / f"{type_}.Mobile.kml"

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
