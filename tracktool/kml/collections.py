"""The track collections a KML archive is filed into.

The desktop collection nests one Folder per year and one Document per month;
the mobile collection is a flat MultiGeometry of LineStrings keyed by track
name. Both live next to the ZIP archive, named after the track type, and both
skip a track that is already in — adding twice is a warning, not a duplicate.
Both can also be asked whether they hold a track, which is how a restore
checks the archive before it touches anything.

Filing is done through a collection held open for a whole batch: N tracks are
one read and one write of the document, and the batch is why that is worth a
class rather than a function taking a path. Asking and removing are one-file
questions and read the document themselves.
"""

import re
from pathlib import Path
from typing import Self

from .. import log
from ..errors import UserInputError
from ..paths import display_path
from . import xmlutil
from .kmlfile import KmlContent, TrackKind

# Collection style per track type: (name, LineStyle color)
COLLECTION_STYLES = {
    TrackKind.DEFAULT: ("普通行程", "ff2257ff"),
    TrackKind.TRAIN: ("火车行程", "ff413830"),
    TrackKind.FLIGHT: ("飞机行程", "1ab5ad00"),
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


def new_empty_kml(type_: TrackKind | None = None) -> xmlutil.etree._ElementTree:
    """An empty collection document, styled for the track type when given."""
    if type_ is not None:
        name, color = COLLECTION_STYLES[type_]
        return xmlutil.parse_string(
            _EMPTY_STYLED_TEMPLATE.format(
                kml_ns=xmlutil.KML_NS, gx_ns=xmlutil.GX_NS, name=name, color=color, type_=type_
            )
        )
    return xmlutil.parse_string(_EMPTY_PLAIN_TEMPLATE.format(kml_ns=xmlutil.KML_NS, gx_ns=xmlutil.GX_NS))


def new_empty_mobile_kml() -> xmlutil.etree._ElementTree:
    """An empty mobile collection document — what a rebuild starts every kind from."""
    return xmlutil.parse_string(_EMPTY_MOBILE_TEMPLATE.format(kml_ns=xmlutil.KML_NS, gx_ns=xmlutil.GX_NS))


def collection_paths(type_: TrackKind, archive_dir: Path) -> tuple[Path, Path]:
    """(desktop, mobile) — both named after the track type, both beside the ZIP."""
    return archive_dir / f"{type_}.kml", archive_dir / f"{type_}.Mobile.kml"


def desktop_date(track: Path) -> tuple[str, str]:
    """(year, yyyymm) from the track's file name — what the collection files it under."""
    match = _DATE_NAME_PATTERN.search(track.stem)
    if match is None:
        raise UserInputError(f"Filename does not match expected date format (yyyy-MM-dd): {track.stem}")
    return match[1], match[1] + match[2]


class TrackCollection:
    """A collection document, held open for the tracks of one batch.

    Loading and saving belong to the collection rather than to each track: N
    tracks cost one read and one write of the whole document, where filing
    each on its own would read and write it N times. The tracks are appended
    to the loaded document and only written by `save()`, which is what makes
    the batch one write — the runs of `add()` in between are bookkeeping.
    """

    def __init__(self, path: Path, tree: xmlutil.etree._ElementTree) -> None:
        self.path = path
        self.tree = tree

    def save(self) -> None:
        """Write the document — or, under PLAN mode, report the write it would make."""
        xmlutil.save(self.tree, self.path)


class DesktopCollection(TrackCollection):
    """Folder[year] > Document[yyyymm] > Placemark, one Placemark per track."""

    @classmethod
    def open(cls, path: Path, type_: TrackKind) -> Self:
        """Load the desktop collection, creating it empty when the archive is new."""
        if path.is_file():
            return cls(path, xmlutil.parse_file(path))
        tree = new_empty_kml(type_)
        if xmlutil.save(tree, path):
            log.info("Created new collection KML file", target=str(path))
        return cls(path, tree)

    def add(self, track: Path, content: KmlContent) -> None:
        """Append the track as Placemark under Folder[year] > Document[yyyymm]."""
        year, month = desktop_date(track)
        log.debug(f"Parsed date from filename: {year}/{month}", target=str(track))

        ns = xmlutil.doc_ns(self.tree)
        top_folder = xmlutil.find(self.tree, "/kml:kml/kml:Folder")
        if top_folder is None:
            raise UserInputError(f"Collection KML has no top-level Folder: {display_path(self.path)}")

        year_folder = xmlutil.find(self.tree, f"/kml:kml/kml:Folder/kml:Folder[kml:name='{year}']")
        if year_folder is None:
            year_folder = xmlutil.sub(top_folder, "Folder")
            xmlutil.sub(year_folder, "name", year)
            log.verbose(f"Created year folder: {year}", target=str(self.path))

        month_doc = xmlutil.find(self.tree, f"//kml:Folder[kml:name='{year}']/kml:Document[kml:name='{month}']")
        if month_doc is None:
            month_doc = xmlutil.sub(year_folder, "Document")
            xmlutil.sub(month_doc, "name", month)
            log.verbose(f"Created month document: {month}", target=str(self.path))

        existing_names = [xmlutil.element_text(n) for n in month_doc.findall(f"{{{ns}}}Placemark/{{{ns}}}name")]
        if track.stem in existing_names:
            log.warning(f"Track already exists in collection: {track.stem}", target=str(self.path))
            return

        placemark = xmlutil.sub(month_doc, "Placemark")
        xmlutil.sub(placemark, "name", track.stem)
        xmlutil.sub(placemark, "description", content.description)
        xmlutil.sub(placemark, "styleUrl", f"#{self.path.stem}")
        ls = xmlutil.sub(placemark, "LineString")
        xmlutil.sub(ls, "coordinates", content.line_string)
        log.verbose(f"Added track to collection: {track.stem}", target=str(self.path))


def _find_desktop_placemark(tree: xmlutil.etree._ElementTree, track_name: str) -> xmlutil.etree._Element | None:
    """The unique desktop Placemark with this exact name."""
    nodes = tree.xpath("//kml:Placemark[kml:name=$name]", namespaces=xmlutil.nsmap_for(tree), name=track_name)
    if len(nodes) > 1:
        raise UserInputError(f"Ambiguous track in desktop collection: {track_name}")
    return nodes[0] if nodes else None


def has_desktop_track(track_name: str, collection_path: Path) -> bool:
    """Whether the desktop collection holds this track."""
    return _find_desktop_placemark(xmlutil.parse_file(collection_path), track_name) is not None


def remove_track_from_desktop_collection(track_name: str, collection_path: Path) -> None:
    """Drop the unique desktop Placemark whose name equals the track name."""
    tree = xmlutil.parse_file(collection_path)
    track = _find_desktop_placemark(tree, track_name)
    if track is None:
        log.warning(f"Track not found in collection: {track_name}", target=str(collection_path))
        return
    track.getparent().remove(track)
    if xmlutil.save(tree, collection_path):
        log.info(f"Removed track from collection: {track_name}", target=str(collection_path))


class MobileCollection(TrackCollection):
    """A flat MultiGeometry of LineStrings, one per track, keyed by track name."""

    @classmethod
    def open(cls, path: Path) -> Self:
        """Load the mobile collection, creating it empty when the archive is new."""
        if path.is_file():
            return cls(path, xmlutil.parse_file(path))
        tree = new_empty_mobile_kml()
        if xmlutil.save(tree, path):
            log.info("Created new mobile collection KML file", target=str(path))
        return cls(path, tree)

    def add(self, track: Path, content: KmlContent) -> None:
        """Append the track as LineString[@id] under the MultiGeometry."""
        multi_geom = xmlutil.find(self.tree, "//kml:MultiGeometry")
        if multi_geom is None:
            raise UserInputError(f"Mobile collection KML has no MultiGeometry: {display_path(self.path)}")

        existing = xmlutil.find(self.tree, f"//kml:LineString[@id='{track.stem}']")
        if existing is not None:
            log.warning(f"Track already exists in mobile collection: {track.stem}", target=str(self.path))
            return

        ls = xmlutil.sub(multi_geom, "LineString")
        ls.set("id", track.stem)
        xmlutil.sub(ls, "coordinates", content.line_string)
        log.verbose(f"Added track to mobile collection: {track.stem}", target=str(self.path))


def _find_mobile_linestring(tree: xmlutil.etree._ElementTree, track_name: str) -> xmlutil.etree._Element | None:
    """The mobile LineString whose id is the track name."""
    nodes = tree.xpath("//kml:LineString[@id=$name]", namespaces=xmlutil.nsmap_for(tree), name=track_name)
    if len(nodes) > 1:
        raise UserInputError(f"Ambiguous track in mobile collection: {track_name}")
    return nodes[0] if nodes else None


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
    if xmlutil.save(tree, collection_path):
        log.info(f"Removed track from mobile collection: {track_name}", target=str(collection_path))
