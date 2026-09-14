"""The track collections a KML archive is filed into.

The desktop collection nests one Folder per year and one Document per month;
the mobile collection is a flat MultiGeometry of LineStrings keyed by track
name. Both live next to the ZIP archive, named after the track type, and both
skip a track that is already in — adding twice is a warning, not a duplicate.
Both can also be asked whether they hold a track, which is how a restore
checks the archive before it touches anything.
"""

import re
from pathlib import Path

from .. import log
from ..errors import UserInputError
from . import kmlfile, xmlutil
from .kmlfile import TrackType

# Collection style per track type: (name, LineStyle color)
COLLECTION_STYLES = {
    TrackType.DEFAULT: ("普通行程", "ff2257ff"),
    TrackType.TRAIN: ("火车行程", "ff413830"),
    TrackType.FLIGHT: ("飞机行程", "1ab5ad00"),
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


def new_empty_kml(type_: TrackType | None = None) -> xmlutil.etree._ElementTree:
    """An empty collection document, styled for the track type when given."""
    if type_ is not None:
        name, color = COLLECTION_STYLES[type_]
        return xmlutil.parse_string(_EMPTY_STYLED_TEMPLATE.format(
            kml_ns=xmlutil.KML_NS, gx_ns=xmlutil.GX_NS, name=name, color=color, type_=type_))
    return xmlutil.parse_string(_EMPTY_PLAIN_TEMPLATE.format(kml_ns=xmlutil.KML_NS, gx_ns=xmlutil.GX_NS))


def add_track_to_desktop_collection(path: Path, collection_path: Path) -> None:
    """Append the track to Folder[year] > Document[yyyymm] > Placemark."""
    m = _DATE_NAME_PATTERN.search(path.stem)
    if not m:
        raise UserInputError(f"Filename does not match expected date format (yyyy-MM-dd): {path.stem}")
    year, month = m[1], m[1] + m[2]
    log.debug(f"Parsed date from filename: {year}/{month}", target=str(path))

    tree = xmlutil.parse_file(collection_path)
    ns = xmlutil.doc_ns(tree)
    top_folder = xmlutil.find(tree, "/kml:kml/kml:Folder")
    if top_folder is None:
        raise UserInputError(f"Collection KML has no top-level Folder: {collection_path}")

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


def _find_desktop_placemark(tree: xmlutil.etree._ElementTree,
                            track_name: str) -> xmlutil.etree._Element | None:
    """The first desktop Placemark whose name contains the track name."""
    return xmlutil.find(tree, f"//kml:Placemark[kml:name[contains(., '{track_name}')]]")


def has_desktop_track(track_name: str, collection_path: Path) -> bool:
    """Whether the desktop collection holds this track."""
    return _find_desktop_placemark(xmlutil.parse_file(collection_path), track_name) is not None


def remove_track_from_desktop_collection(track_name: str, collection_path: Path) -> None:
    """Drop every desktop Placemark whose name contains the track name."""
    tree = xmlutil.parse_file(collection_path)
    track = _find_desktop_placemark(tree, track_name)
    if track is None:
        log.warning(f"Track not found in collection: {track_name}", target=str(collection_path))
        return
    track.getparent().remove(track)
    xmlutil.save(tree, collection_path)
    log.info(f"Removed track from collection: {track_name}", target=str(collection_path))


def add_track_to_mobile_collection(path: Path, collection_path: Path) -> None:
    """Append the track as LineString[@id] under the collection's MultiGeometry."""
    if not collection_path.is_file():
        tree = xmlutil.parse_string(
            _EMPTY_MOBILE_TEMPLATE.format(kml_ns=xmlutil.KML_NS, gx_ns=xmlutil.GX_NS))
        xmlutil.save(tree, collection_path)
        log.info("Created new mobile collection KML file", target=str(collection_path))

    tree = xmlutil.parse_file(collection_path)
    multi_geom = xmlutil.find(tree, "//kml:MultiGeometry")
    if multi_geom is None:
        raise UserInputError(f"Mobile collection KML has no MultiGeometry: {collection_path}")
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


def _find_mobile_linestring(tree: xmlutil.etree._ElementTree,
                            track_name: str) -> xmlutil.etree._Element | None:
    """The mobile LineString whose id is the track name."""
    return xmlutil.find(tree, f"//kml:LineString[@id='{track_name}']")


def has_mobile_track(track_name: str, collection_path: Path) -> bool:
    """Whether the mobile collection holds this track."""
    return _find_mobile_linestring(xmlutil.parse_file(collection_path), track_name) is not None


def remove_track_from_mobile_collection(track_name: str, collection_path: Path) -> None:
    """Drop the LineString whose id matches the track name."""
    tree = xmlutil.parse_file(collection_path)
    ls = _find_mobile_linestring(tree, track_name)
    if ls is None:
        log.warning(f"Track not found in mobile collection: {track_name}", target=str(collection_path))
        return
    ls.getparent().remove(ls)
    xmlutil.save(tree, collection_path)
    log.info(f"Removed track from mobile collection: {track_name}", target=str(collection_path))
