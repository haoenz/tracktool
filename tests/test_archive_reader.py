"""Public archive reads: exact selection, lazy parsing, ownership, and no writes."""

import zipfile
from array import array
from dataclasses import fields
from math import isnan

import pytest
from conftest import TRACK_KML, import_test_zip, make_archive

from tracktool.errors import UserInputError
from tracktool.kml import trackdata
from tracktool.kml.archive_reader import open_archive


def make_zip(tmp_path, entries):
    path = make_archive(tmp_path / "archive")
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries:
            archive.writestr(name, content)
    import_test_zip(path)
    return path


def assert_data_equal(left, right):
    """Compare independent array-backed results, treating missing altitudes as NaN."""
    for field in fields(left):
        if field.name not in ("source", "tracks"):
            assert getattr(left, field.name) == getattr(right, field.name)
    assert len(left.tracks) == len(right.tracks)
    for a, b in zip(left.tracks, right.tracks, strict=True):
        assert (a.index, a.name, a.placemark_id) == (b.index, b.name, b.placemark_id)
        assert len(a.segments) == len(b.segments)
        for x, y in zip(a.segments, b.segments, strict=True):
            assert (x.kind, x.geometry_id) == (y.kind, y.geometry_id)
            for field in ("longitude", "latitude", "altitude", "time_us"):
                values, expected = getattr(x, field), getattr(y, field)
                if expected is None:
                    assert values is None
                else:
                    assert isinstance(values, array) and values.typecode == expected.typecode
                    assert len(values) == len(expected)
                    assert all(v == e or (isnan(v) and isnan(e)) for v, e in zip(values, expected, strict=True))


@pytest.mark.parametrize(
    "entry", ["Default/2026-05/旅行.kml", "旧轨迹.KML", "Unknown/trip.kml", "_unclassified/trip.kml"]
)
def test_selected_data_matches_local_file_including_nan_and_metadata(tmp_path, entry):
    content = (
        TRACK_KML.replace(
            "<Folder>",
            '<ExtendedData><Data name="TrackTags"><value>自定义活动</value></Data>'
            '<Data name="PosStartName"><value>出发</value></Data>'
            '<Data name="PosEndName"><value>到达</value></Data></ExtendedData><Folder>',
        )
        .replace("116.0 39.0 100", "116.0 39.0")
        .replace("116.1 39.1 110", "116.1 39.1 0")
    )
    content = content.replace(
        "</gx:Track>",
        "</gx:Track><MultiGeometry><LineString>"
        "<coordinates>120,30 121,31,0</coordinates></LineString>"
        "<gx:MultiTrack><gx:Track><gx:coord>1 2</gx:coord></gx:Track>"
        "</gx:MultiTrack></MultiGeometry>",
    )
    local = tmp_path / "local.kml"
    local.write_text(content, encoding="utf-8")
    path = make_zip(tmp_path, [(entry, content)])
    expected = trackdata.read_track_data(local)
    with open_archive(path) as archive:
        actual = archive.read_track_data(archive.list_entries()[0].path)
    assert actual.source == f"{path.parent / 'archive.sqlite3'}!/{entry}"
    assert_data_equal(actual, expected)
    assert actual.track_tags == "自定义活动"
    assert isnan(actual.tracks[0].segments[0].altitude[0])


def test_xml_bytes_keep_declared_encoding(tmp_path):
    content = TRACK_KML.replace("UTF-8", "UTF-16").replace("<name>track</name>", "<name>中文路线</name>")
    raw = content.encode("utf-16")
    path = make_zip(tmp_path, [("legacy.kml", raw)])
    local = tmp_path / "local.kml"
    local.write_bytes(raw)
    with open_archive(path) as archive:
        actual = archive.read_track_data("legacy.kml")
    assert actual.tracks[0].name == "中文路线"
    assert_data_equal(actual, trackdata.read_track_data(local))


@pytest.mark.parametrize(
    "content, expected",
    [
        (b"<broken>", "Cannot parse KML"),
        (b"\xff\xfe invalid", "Cannot parse KML"),
        (TRACK_KML.replace("116.0 39.0 100", "invalid 39 100"), "point 1: Invalid longitude"),
    ],
)
def test_bad_selected_content_reports_source_and_caller_can_continue(tmp_path, content, expected):
    entry = "Default/bad.kml"
    path = make_zip(tmp_path, [(entry, content), ("good.kml", TRACK_KML)])
    with open_archive(path) as archive:
        with pytest.raises(UserInputError, match=expected) as error:
            archive.read_track_data(entry)
        assert f"{path.parent / 'archive.sqlite3'}!/{entry}" in str(error.value)
        assert archive.read_track_data("good.kml").tracks


def snapshot(root):
    return {
        str(path.relative_to(root)): (path.read_bytes(), path.stat().st_mtime_ns) if path.is_file() else None
        for path in root.rglob("*")
    }
