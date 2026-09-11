"""KML archive management: push/pop tracks between the source folder, the
desktop collection (Folder[year] > Document[yyyymm] > Placemark), the mobile
collection (flat MultiGeometry of LineString[@id]) and the ZIP archive.

Ports Push-KmlArchive / Pop-KmlArchive / Push-CompressedKml / Pop-CompressedKml
/ Add-*/Remove-KmlTrackTo*Collection and New-EmptyKml.
"""

import re
import shutil
import zipfile
from pathlib import Path

from .. import log
from ..config import Config, config
from ..fileutil import move_to_folder
from . import kmlfile, xmlutil

# Collection style per track type: (name, LineStyle color)
COLLECTION_STYLES = {
    "Default": ("普通行程", "ff2257ff"),
    "Train": ("火车行程", "ff413830"),
    "Flight": ("飞机行程", "1ab5ad00"),
}

_DATE_NAME_PATTERN = re.compile(r"(\d{4})-(\d{2})-\d{2}")

_EMPTY_STYLED_TEMPLATE = """<?xml version='1.0' encoding='UTF-8'?>
<kml xmlns='{kml_ns}' xmlns:gx='{gx_ns}' xmlns:kml='{kml_ns}' xmlns:atom='http://www.w3.org/2005/Atom'>
<Folder>
<name>{name}</name>
<Style id='{type_}'>
<LineStyle>
<color>{color}</color>
<width>3</width>
</LineStyle>
</Style>
</Folder>
</kml>"""

_EMPTY_PLAIN_TEMPLATE = """<?xml version='1.0' encoding='UTF-8'?>
<kml xmlns='{kml_ns}' xmlns:gx='{gx_ns}' xmlns:kml='{kml_ns}' xmlns:atom='http://www.w3.org/2005/Atom'>
<Document>
<Folder>
</Folder>
</Document>
</kml>"""

_EMPTY_MOBILE_TEMPLATE = """<?xml version='1.0' encoding='UTF-8'?>
<kml xmlns='{kml_ns}' xmlns:gx='{gx_ns}' xmlns:kml='{kml_ns}' xmlns:atom='http://www.w3.org/2005/Atom'>
<Folder>
<Placemark>
<MultiGeometry>
</MultiGeometry>
</Placemark>
</Folder>
</kml>"""


def new_empty_kml(type_: str | None = None) -> xmlutil.etree._ElementTree:
    if type_ is not None:
        name, color = COLLECTION_STYLES[type_]
        return xmlutil.parse_string(_EMPTY_STYLED_TEMPLATE.format(
            kml_ns=xmlutil.KML_NS, gx_ns=xmlutil.GX_NS, name=name, color=color, type_=type_))
    return xmlutil.parse_string(_EMPTY_PLAIN_TEMPLATE.format(kml_ns=xmlutil.KML_NS, gx_ns=xmlutil.GX_NS))


def _resolve_zip_path(zip_path: str | None, cfg: Config) -> Path:
    """CLI argument or config key -> resolved ZIP path; FileNotFoundError when absent."""
    path = zip_path or cfg["kmlCompressedFilePath"]
    if not path or not Path(path).is_file():
        raise FileNotFoundError(f"KML compressed file path does not exist: {path}")
    return Path(path).resolve()


# ── ZIP entry management ────────────────────────────────────────────────────


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


# ── Desktop collection ──────────────────────────────────────────────────────


def add_track_to_desktop_collection(path: Path, collection_path: Path) -> None:
    """Append the track to Folder[year] > Document[yyyymm] > Placemark."""
    m = _DATE_NAME_PATTERN.search(path.stem)
    if not m:
        raise ValueError(f"Filename does not match expected date format (yyyy-MM-dd): {path.stem}")
    year, month = m[1], m[1] + m[2]
    log.debug(f"Parsed date from filename: {year}/{month}", target=str(path))

    tree = xmlutil.parse_file(collection_path)
    ns = xmlutil.doc_ns(tree)
    top_folder = xmlutil.find(tree, "/kml:kml/kml:Folder")
    if top_folder is None:
        raise ValueError(f"Collection KML has no top-level Folder: {collection_path}")

    year_folder = xmlutil.find(tree, f"/kml:kml/kml:Folder/kml:Folder[kml:name='{year}']")
    if year_folder is None:
        year_folder = xmlutil.sub(top_folder, "Folder")
        xmlutil.sub(year_folder, "name", year)
        log.info(f"Created year folder: {year}", target=str(collection_path))

    month_doc = xmlutil.find(tree, f"//kml:Folder[kml:name='{year}']/kml:Document[kml:name='{month}']")
    if month_doc is None:
        month_doc = xmlutil.sub(year_folder, "Document")
        xmlutil.sub(month_doc, "name", month)
        log.info(f"Created month document: {month}", target=str(collection_path))

    existing_names = [xmlutil.element_text(n) for n in month_doc.findall(f"{{{ns}}}Placemark/{{{ns}}}name")]
    if path.stem in existing_names:
        log.warning(f"Track already exists in collection: {path.stem}", target=str(collection_path))
        return

    content = kmlfile.get_kml_content(path)
    track = xmlutil.sub(month_doc, "Placemark")
    xmlutil.sub(track, "name", path.stem)
    xmlutil.sub(track, "description", content.description)
    xmlutil.sub(track, "styleUrl", f"#{collection_path.stem}")
    ls = xmlutil.sub(track, "LineString")
    xmlutil.sub(ls, "coordinates", content.line_string)
    xmlutil.save(tree, collection_path)
    log.info(f"Added track to collection: {path.stem}", target=str(collection_path))


def remove_track_from_desktop_collection(track_name: str, collection_path: Path) -> None:
    tree = xmlutil.parse_file(collection_path)
    track = xmlutil.find(tree, f"//kml:Placemark[kml:name[contains(., '{track_name}')]]")
    if track is None:
        log.warning(f"Track not found in collection: {track_name}", target=str(collection_path))
        return
    track.getparent().remove(track)
    xmlutil.save(tree, collection_path)
    log.info(f"Removed track from collection: {track_name}", target=str(collection_path))


# ── Mobile collection ───────────────────────────────────────────────────────


def add_track_to_mobile_collection(path: Path, collection_path: Path) -> None:
    if not collection_path.is_file():
        tree = xmlutil.parse_string(
            _EMPTY_MOBILE_TEMPLATE.format(kml_ns=xmlutil.KML_NS, gx_ns=xmlutil.GX_NS))
        xmlutil.save(tree, collection_path)
        log.info("Created new mobile collection KML file", target=str(collection_path))

    tree = xmlutil.parse_file(collection_path)
    multi_geom = xmlutil.find(tree, "//kml:MultiGeometry")
    if multi_geom is None:
        raise ValueError(f"Mobile collection KML has no MultiGeometry: {collection_path}")
    track_id = path.stem

    existing = xmlutil.find(tree, f"//kml:LineString[@id='{track_id}']")
    if existing is not None:
        log.warning(f"Track already exists in mobile collection: {track_id}", target=str(collection_path))
        return

    line_string = kmlfile.get_kml_content(path).line_string
    ls = xmlutil.sub(multi_geom, "LineString")
    ls.set("id", track_id)
    xmlutil.sub(ls, "coordinates", line_string)
    xmlutil.save(tree, collection_path)
    log.info(f"Added track to mobile collection: {track_id}", target=str(collection_path))


def remove_track_from_mobile_collection(track_name: str, collection_path: Path) -> None:
    tree = xmlutil.parse_file(collection_path)
    ls = xmlutil.find(tree, f"//kml:LineString[@id='{track_name}']")
    if ls is None:
        log.warning(f"Track not found in mobile collection: {track_name}", target=str(collection_path))
        return
    ls.getparent().remove(ls)
    xmlutil.save(tree, collection_path)
    log.info(f"Removed track from mobile collection: {track_name}", target=str(collection_path))


# ── Top-level push/pop ──────────────────────────────────────────────────────


def push_kml_archive(path: Path, zip_path: str | None = None, type_: str | None = None,
                     no_archive: bool = False, cfg: Config = config) -> None:
    """Archive a KML track: both collections + ZIP + move to backup folder."""
    zip_file = _resolve_zip_path(zip_path, cfg)
    archive_dir = zip_file.parent

    log.info("Archiving KML track", target=str(path))
    kml_type = type_ if type_ is not None else kmlfile.get_kml_type(path)
    if kml_type == "Unknown":
        log.error("Cannot archive track with unknown type", target=str(path))
        return

    collection_kml_path = archive_dir / f"{kml_type}.kml"
    if not collection_kml_path.is_file():
        xmlutil.save(new_empty_kml(kml_type), collection_kml_path)
        log.info("Created new collection KML file", target=str(collection_kml_path))
    add_track_to_desktop_collection(path, collection_kml_path)

    mobile_collection_path = archive_dir / f"{kml_type}.Mobile.kml"
    add_track_to_mobile_collection(path, mobile_collection_path)

    if not no_archive:
        if not zip_file.is_file():
            zip_file.touch()
            log.info("Created new ZIP archive", target=str(zip_file))
        push_compressed_kml(path, zip_file)

    move_to_folder(path, str(cfg["kmlBackupDirName"] or "Backup"), archive_dir)


def pop_kml_archive(kml_name: str, type_: str = "Default", zip_path: str | None = None,
                    cfg: Config = config) -> None:
    """Restore a KML track: extract from ZIP and remove from both collections."""
    zip_file = _resolve_zip_path(zip_path, cfg)
    archive_dir = zip_file.parent

    pop_compressed_kml(kml_name, zip_file)

    collection_kml_path = archive_dir / f"{type_}.kml"
    remove_track_from_desktop_collection(kml_name, collection_kml_path)

    mobile_collection_path = archive_dir / f"{type_}.Mobile.kml"
    if mobile_collection_path.is_file():
        remove_track_from_mobile_collection(kml_name, mobile_collection_path)
