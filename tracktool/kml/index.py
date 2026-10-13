"""Versioned, portable compact-array index; never a substitute for raw KML.

Serialization v1: zlib JSON metadata with base64 little-endian binary64 / int64
arrays. NaN altitude gaps and None whole arrays are distinct. Segment boundaries,
source order and integer UTC microseconds survive exactly; raw time text stays
in kml_objects. No pickle or per-GPS-point SQL rows.
"""

import base64
import json
import sys
import zlib
from array import array
from dataclasses import replace
from pathlib import Path

from ..errors import UserInputError
from . import storage, trackdata, xmlutil
from .trackdata import KmlTrackData, TrackFeature, TrackSegment

PARSER_VERSION = 2
SERIALIZATION_VERSION = 1


def _encode(values: array | None) -> str | None:
    if values is None:
        return None
    values = array(values.typecode, values)
    if sys.byteorder != "little":
        values.byteswap()
    return base64.b64encode(values.tobytes()).decode("ascii")


def _decode(value: str | None, code: str) -> array | None:
    if value is None:
        return None
    values = array(code)
    values.frombytes(base64.b64decode(value, validate=True))
    if sys.byteorder != "little":
        values.byteswap()
    return values


def serialize(data: KmlTrackData) -> bytes:
    result: dict = dict(
        version=SERIALIZATION_VERSION,
        name=data.name,
        track_tags=data.track_tags,
        start_name=data.start_name,
        end_name=data.end_name,
        tracks=[],
    )
    for track in data.tracks:
        result["tracks"].append(
            dict(
                index=track.index,
                placemark_id=track.placemark_id,
                name=track.name,
                segments=[
                    dict(
                        kind=s.kind,
                        geometry_id=s.geometry_id,
                        longitude=_encode(s.longitude),
                        latitude=_encode(s.latitude),
                        altitude=_encode(s.altitude),
                        time_us=_encode(s.time_us),
                    )
                    for s in track.segments
                ],
            )
        )
    return zlib.compress(json.dumps(result, ensure_ascii=False).encode())


def deserialize(payload: bytes, source: str) -> KmlTrackData:
    data = json.loads(zlib.decompress(payload))
    if data["version"] != SERIALIZATION_VERSION:
        raise ValueError("Unknown geometry serialization version")
    tracks = []
    for track in data["tracks"]:
        segments = []
        for s in track["segments"]:
            lon, lat = _decode(s["longitude"], "d"), _decode(s["latitude"], "d")
            assert lon is not None and lat is not None
            segments.append(
                TrackSegment(
                    s["kind"], s["geometry_id"], lon, lat, _decode(s["altitude"], "d"), _decode(s["time_us"], "q")
                )
            )
        tracks.append(TrackFeature(track["index"], track["placemark_id"], track["name"], tuple(segments)))
    return KmlTrackData(source, data["name"], data["track_tags"], data["start_name"], data["end_name"], tuple(tracks))


def read_index(path: Path, digest: str, raw: bytes | None, source: str) -> KmlTrackData:
    """Check index without decompressing original KML on cache hits.

    Caller snapshot may contain an object removed concurrently. In that case
    return the parsed data but do not attempt to resurrect a deleted object.
    """
    with storage.connect(path) as db:
        row = db.execute(
            "SELECT * FROM kml_index WHERE sha256=? AND parser_version=?", (digest, PARSER_VERSION)
        ).fetchone()
        if row:
            if row["status"] == "error":
                raise UserInputError(f"{source}: {row['error']}")
            try:
                return deserialize(row["geometry"], source)
            except ValueError, KeyError, TypeError, zlib.error, AssertionError:
                pass  # disposable corrupt index: rebuild from verified original
        if raw is None:
            raw = storage.read_object(db, digest)
    data = None
    error = None
    metadata: dict = {}
    try:
        tree = xmlutil.parse_string(raw)
        if not xmlutil.doc_ns(tree):
            raise UserInputError("Expected a namespaced KML document")
        metadata = {
            "name": xmlutil.element_text(xmlutil.find(tree, "/kml:kml/kml:Document/kml:name")),
            "track_tags": xmlutil.extended_data_value(tree, "TrackTags"),
        }
        data = trackdata.track_data_from_tree(tree, source="")
        segments = [s for t in data.tracks for s in t.segments]
        starts = [min(s.time_us) for s in segments if s.time_us]
        ends = [max(s.time_us) for s in segments if s.time_us]
        metadata.update(
            tracks=len(data.tracks),
            segments=len(segments),
            points=sum(len(s.longitude) for s in segments),
            time_min_us=min(starts) if starts else None,
            time_max_us=max(ends) if ends else None,
            altitude=any(s.altitude is not None for s in segments),
        )
    except UserInputError as exc:
        error = str(exc)
    with storage.connect(path, write=True) as db:
        if db.execute("SELECT 1 FROM kml_objects WHERE sha256=?", (digest,)).fetchone():
            db.execute("DELETE FROM kml_index WHERE sha256=? AND parser_version!=?", (digest, PARSER_VERSION))
            db.execute(
                "INSERT OR REPLACE INTO kml_index VALUES (?,?,?,?,?,?)",
                (
                    digest,
                    PARSER_VERSION,
                    "error" if error else "ok",
                    json.dumps(metadata),
                    serialize(data) if data else None,
                    error,
                ),
            )
    if error or data is None:
        raise UserInputError(f"{source}: {error}")
    return replace(data, source=source)
