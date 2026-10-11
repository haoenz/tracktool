"""Read KML line geometry into compact arrays, without editing or joining it.

This model is independent of the time-indexed photo-positioning Track model.
Each Placemark owns its segments; each gx:Track/LineString remains a segment.
Array indices align only within that segment. No point objects are retained.
"""

import re
from array import array
from dataclasses import dataclass
from datetime import UTC, datetime
from math import isfinite, nan
from pathlib import Path

from ..errors import UserInputError
from ..tags import POS_END_NAME, POS_START_NAME, TRACK_TAGS
from . import xmlutil

_NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_TIME = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?"
    r"(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])"
)
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


@dataclass(frozen=True)
class TrackSegment:
    """One geometry, in source order. Arrays are owned by the caller and mutable.

    longitude/latitude/altitude are array('d') (64-bit floats). Missing altitude
    is None for an entire segment, NaN for individual points; zero stays zero.
    time_us is None or array('q'): signed 64-bit UTC microseconds since the Unix
    epoch. Input fractions beyond six digits are truncated, never rounded.
    geometry_id is the source geometry's XML id, or '' if absent.
    """

    kind: str
    geometry_id: str
    longitude: array
    latitude: array
    altitude: array | None
    time_us: array | None


@dataclass(frozen=True)
class TrackFeature:
    """A Placemark containing lines; index is 1-based among all Placemarks.

    index remains unambiguous even when XML ids/names are absent or duplicated.
    Segments follow XML order, including nested MultiGeometry/gx:MultiTrack.
    """

    index: int
    placemark_id: str
    name: str
    segments: tuple[TrackSegment, ...]


@dataclass(frozen=True)
class KmlTrackData:
    """File/document metadata and line-bearing Placemarks in source order.

    source is the input path or caller-supplied label (e.g. a future ZIP entry).
    name is Document/name. The other strings use the existing Document-level
    ExtendedData reading rules, including stripping surrounding whitespace;
    track_tags is the original activity, without category mapping. Missing
    metadata is ''. No XML nodes or per-point datetime objects are retained.
    """

    source: str
    name: str
    track_tags: str
    start_name: str
    end_name: str
    tracks: tuple[TrackFeature, ...]


def read_track_data(path: str | Path) -> KmlTrackData:
    """Read a file without writes, configuration access, or implicit caching."""
    path = Path(path)
    return track_data_from_tree(xmlutil.parse_file(path), source=str(path))


def track_data_from_tree(tree: xmlutil.etree._ElementTree, *, source: str = "") -> KmlTrackData:
    """Extract lines from an existing XML tree without modifying it.

    Raise UserInputError for invalid/empty supported geometry, invalid numbers,
    timestamps without an explicit timezone, or partial time data within any
    gx:Track. No lines also raises UserInputError. Time order is unrestricted.
    Points/polygons are ignored. A one-point line is retained as provided.
    """
    ns = xmlutil.doc_ns(tree)
    if not ns:
        raise UserInputError(f"{source or '<XML>'}: Expected a namespaced KML document")
    kml = f"{{{ns}}}"
    gx = f"{{{xmlutil.GX_NS}}}"
    tracks: list[TrackFeature] = []
    for index, placemark in enumerate(tree.getroot().iter(f"{kml}Placemark"), 1):
        name = xmlutil.element_text(placemark.find(f"{kml}name"))
        segments: list[TrackSegment] = []
        for node in placemark.iter(f"{gx}Track", f"{kml}LineString"):
            kind = "gx:Track" if node.tag == f"{gx}Track" else "LineString"
            location = f"{source or '<XML>'}: Placemark {index} ({name!r}), segment {len(segments) + 1} ({kind})"
            segments.append(_read_segment(node, kind, kml, location))
        if segments:
            tracks.append(TrackFeature(index, placemark.get("id", ""), name, tuple(segments)))
    if not tracks:
        raise UserInputError(f"{source or '<XML>'}: No extractable line tracks (gx:Track or LineString)")
    return KmlTrackData(
        source=source,
        name=xmlutil.element_text(xmlutil.find(tree, "/kml:kml/kml:Document/kml:name")),
        track_tags=xmlutil.extended_data_value(tree, TRACK_TAGS),
        start_name=xmlutil.extended_data_value(tree, POS_START_NAME),
        end_name=xmlutil.extended_data_value(tree, POS_END_NAME),
        tracks=tuple(tracks),
    )


def _number(text: str, field: str, location: str) -> float:
    if not _NUMBER.fullmatch(text):
        raise UserInputError(f"{location}: Invalid {field} number {text!r}")
    value = float(text)
    if not isfinite(value):
        raise UserInputError(f"{location}: Non-finite {field} {text!r}")
    limit = 180 if field == "longitude" else 90 if field == "latitude" else None
    if limit is not None and not -limit <= value <= limit:
        raise UserInputError(f"{location}: {field} out of range [-{limit}, {limit}]: {text!r}")
    return value


def _timestamp(text: str, location: str) -> int:
    try:
        if not _TIME.fullmatch(text):
            raise ValueError("expected YYYY-MM-DDTHH:MM:SS[.fraction] with Z or ±HH:MM")
        delta = datetime.fromisoformat(text) - _EPOCH
    except ValueError as exc:
        raise UserInputError(f"{location}: Invalid timestamp {text!r}: {exc}") from exc
    # Integer arithmetic avoids float timestamp rounding, especially far from 1970.
    return (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds


def _read_segment(node: xmlutil.etree._Element, kind: str, kml: str, location: str) -> TrackSegment:
    longitude = array("d")
    latitude = array("d")
    altitude = None
    gx = f"{{{xmlutil.GX_NS}}}"
    if kind == "gx:Track":
        coordinate_texts = (xmlutil.element_text(child) for child in node.iterchildren(f"{gx}coord"))
    else:
        coordinate_nodes = node.iterchildren(f"{kml}coordinates")
        coordinates = next(coordinate_nodes, None)
        if coordinates is None or next(coordinate_nodes, None) is not None:
            raise UserInputError(f"{location}: Expected exactly one coordinates element")
        # Do not split the whole LineString into a second, full point-text list.
        coordinate_texts = (match[0] for match in re.finditer(r"\S+", xmlutil.element_text(coordinates)))
    for index, text in enumerate(coordinate_texts):
        point_location = f"{location}, point {index + 1}"
        parts = text.split() if kind == "gx:Track" else text.split(",")
        if len(parts) not in (2, 3) or any(not part for part in parts):
            raise UserInputError(
                f"{point_location}: Malformed coordinate {text!r}; expected longitude, latitude[, altitude]"
            )
        longitude.append(_number(parts[0], "longitude", point_location))
        latitude.append(_number(parts[1], "latitude", point_location))
        if len(parts) == 3:
            value = _number(parts[2], "altitude", point_location)
            if altitude is None:
                altitude = array("d", [nan]) * index
            altitude.append(value)
        elif altitude is not None:
            altitude.append(nan)

    time_us = None
    if kind == "gx:Track":
        # Both standard kml:when and historical gx:when spellings stay local to
        # this Track. Never zip the document-wide coordinate/time collections.
        when_tags = (f"{kml}when", f"{gx}when")
        time_count = sum(1 for _ in node.iterchildren(*when_tags))
        if time_count:
            if time_count != len(longitude):
                raise UserInputError(
                    f"{location}, point {min(time_count, len(longitude)) + 1}: "
                    f"{len(longitude)} coordinate(s) but {time_count} timestamp(s)"
                )
            time_us = array("q")
            for index, child in enumerate(node.iterchildren(*when_tags), 1):
                time_us.append(_timestamp(xmlutil.element_text(child), f"{location}, point {index}"))
    if not longitude:
        raise UserInputError(f"{location}: Empty line geometry; no coordinates")
    return TrackSegment(kind, node.get("id", ""), longitude, latitude, altitude, time_us)
