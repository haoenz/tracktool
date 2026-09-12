"""Filing tracks into, and out of, the KML archive.

Push files a track everywhere it belongs — both collections, the ZIP archive,
then the backup folder; pop reverses it. The ZIP itself keeps every KML
flat-named (entry = file name) and is rewritten wholesale on removal, since
zipfile has no entry-delete API.
"""

import shutil
import zipfile
from pathlib import Path

from .. import log
from ..context import ctx
from ..fileutil import move_to_folder
from ..workspace import resolve_zip_path
from . import collections, kmlfile, xmlutil
from .kmlfile import TrackType


def push_compressed_kml(kml_path: Path, zip_path: Path) -> None:
    """Add a KML to the ZIP archive if not already present."""
    with zipfile.ZipFile(zip_path, "a", zipfile.ZIP_DEFLATED) as zf:
        names = [Path(info.filename).name for info in zf.infolist()]
        if kml_path.name in names:
            log.warning(f"Already exists in ZIP: {kml_path.name}", target=str(zip_path))
            return
        zf.write(kml_path, kml_path.name)
        log.info(f"Added to ZIP: {kml_path.name}", target=str(zip_path))


def pop_compressed_kml(kml_name: str, zip_path: Path, output_directory: Path = Path(".")) -> None:
    """Extract an entry matching kml_name from the ZIP, then delete the entry."""
    with zipfile.ZipFile(zip_path, "a", zipfile.ZIP_DEFLATED) as zf:
        entry_name = next(
            (info.filename for info in zf.infolist() if kml_name in Path(info.filename).name), None
        )
        if entry_name is None:
            log.warning(f"Entry not found in ZIP: {kml_name}", target=str(zip_path))
            return
        log.debug(f"Found entry in ZIP: {entry_name}", target=str(zip_path))
        target_path = output_directory / Path(entry_name).name
        if target_path.exists():
            log.warning("File already exists at destination", target=str(target_path))
        else:
            with zf.open(entry_name) as src, open(target_path, "wb") as dst:
                shutil.copyfileobj(src, dst)
            log.info(f"Extracted from ZIP: {entry_name}", target=str(zip_path))
        # zipfile has no entry-delete API: rewrite the archive without the entry
        remaining = [info for info in zf.infolist() if info.filename != entry_name]
        data = {info.filename: zf.read(info.filename) for info in remaining}
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, blob in data.items():
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

    collection_kml_path = archive_dir / f"{kml_type}.kml"
    if not collection_kml_path.is_file():
        xmlutil.save(collections.new_empty_kml(kml_type), collection_kml_path)
        log.info("Created new collection KML file", target=str(collection_kml_path))
    collections.add_track_to_desktop_collection(path, collection_kml_path)

    mobile_collection_path = archive_dir / f"{kml_type}.Mobile.kml"
    collections.add_track_to_mobile_collection(path, mobile_collection_path)

    if not no_archive:
        if not zip_file.is_file():
            zip_file.touch()
            log.info("Created new ZIP archive", target=str(zip_file))
        push_compressed_kml(path, zip_file)

    move_to_folder(path, str(ctx.config["kml_backup_dir_name"] or "Backup"), archive_dir)


def pop_kml_archive(kml_name: str, type_: TrackType = TrackType.DEFAULT, zip_path: str | None = None) -> None:
    """Restore a KML track: extract from ZIP and remove from both collections."""
    zip_file = resolve_zip_path(zip_path)
    archive_dir = zip_file.parent

    pop_compressed_kml(kml_name, zip_file)

    collection_kml_path = archive_dir / f"{type_}.kml"
    collections.remove_track_from_desktop_collection(kml_name, collection_kml_path)

    mobile_collection_path = archive_dir / f"{type_}.Mobile.kml"
    if mobile_collection_path.is_file():
        collections.remove_track_from_mobile_collection(kml_name, mobile_collection_path)
