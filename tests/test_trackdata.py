"""Read-only numeric geometry, independent of geotagging and archive workflows."""

from array import array
from math import copysign, isnan
from pathlib import Path

import pytest
from conftest import TRACK_KML
from lxml import etree

from tracktool.errors import UserInputError
from tracktool.kml import xmlutil
from tracktool.kml.trackdata import read_track_data, track_data_from_tree


def document(body: str, metadata: str = "") -> etree._ElementTree:
    return xmlutil.parse_string(
        f'<kml xmlns="{xmlutil.KML_NS}" xmlns:gx="{xmlutil.GX_NS}">'
        f"<Document><name>旅程</name>{metadata}{body}</Document></kml>"
    )


def track(coords: tuple[str, ...], times: tuple[str, ...] = ()) -> str:
    return (
        "<gx:Track>"
        + "".join(f"<when>{value}</when>" for value in times)
        + "".join(f"<gx:coord>{value}</gx:coord>" for value in coords)
        + "</gx:Track>"
    )


def line(coords: str) -> str:
    return f"<LineString><coordinates>{coords}</coordinates></LineString>"


def extract(geometry: str):
    return track_data_from_tree(document(f"<Placemark><name>路线</name>{geometry}</Placemark>"), source="trip.kml")


@pytest.mark.parametrize("markup", ["<!-- 下一点 -->", "<?note 下一点?>"])
@pytest.mark.parametrize("geometry_kind", ["LineString", "gx:Track"])
def test_interrupted_coordinate_text_preserves_all_values(markup, geometry_kind, tmp_path):
    geometry = (
        line(f"{markup}120,30,50{markup} 12{markup}1,31,55{markup}")
        if geometry_kind == "LineString"
        else track((f"{markup}120 30{markup} 50", f"12{markup}1 31 55{markup}"))
    )
    tree = document(f"<Placemark>{geometry}</Placemark>")
    before = etree.tostring(tree)
    path = tmp_path / "interrupted.kml"
    path.write_bytes(before)
    for data in (track_data_from_tree(tree), read_track_data(path)):
        segment = data.tracks[0].segments[0]
        assert segment.longitude == array("d", [120, 121])
        assert segment.latitude == array("d", [30, 31])
        assert segment.altitude == array("d", [50, 55])
    assert etree.tostring(tree) == before
    assert path.read_bytes() == before


@pytest.mark.parametrize("markup", ["<!-- ignored -->", "<?note ignored?>"])
@pytest.mark.parametrize("when_tag", ["when", "gx:when"])
def test_interrupted_time_text_preserves_timestamp(markup, when_tag):
    geometry = track(("120 30",), (f"{markup}1970-01-01T00:00:00.{markup}123456Z{markup}",))
    geometry = geometry.replace("<when>", f"<{when_tag}>").replace("</when>", f"</{when_tag}>")
    segment = extract(geometry).tracks[0].segments[0]
    assert segment.time_us == array("q", [123456])


@pytest.mark.parametrize("markup", ["<!-- ignored -->", "<?note ignored?>"])
@pytest.mark.parametrize("field", ["coordinates", "coord", "when"])
def test_invalid_text_after_markup_is_not_silently_discarded(markup, field):
    if field == "coordinates":
        geometry = line(f"120,30,50{markup} invalid")
        error = r"point 2: Malformed coordinate"
    elif field == "coord":
        geometry = track((f"120 30 50{markup} invalid",))
        error = r"point 1: Malformed coordinate"
    else:
        geometry = track(("120 30",), (f"1970-01-01T00:00:00Z{markup}invalid",))
        error = r"point 1: Invalid timestamp"
    with pytest.raises(UserInputError, match=error):
        extract(geometry)


@pytest.mark.parametrize("markup", ["<!-- ignored -->", "<?note ignored?>"])
def test_interrupted_metadata_text_is_complete(markup):
    tree = document(
        f"<Placemark><name>路{markup}线</name>{line('120,30')}</Placemark>",
        f'<ExtendedData><Data name="TrackTags"><value>徒{markup}步</value></Data>'
        f'<Data name="PosStartName"><value>起{markup}点</value></Data>'
        f'<Data name="PosEndName"><value>终{markup}点</value></Data></ExtendedData>',
    )
    name = xmlutil.find(tree, "/kml:kml/kml:Document/kml:name")
    name.text = "旅"
    name.append(etree.Comment("ignored"))
    name[-1].tail = "程"
    before = etree.tostring(tree)
    data = track_data_from_tree(tree)
    assert data.name == "旅程"
    assert data.tracks[0].name == "路线"
    assert (data.track_tags, data.start_name, data.end_name) == ("徒步", "起点", "终点")
    assert etree.tostring(tree) == before


def test_single_track_file_is_read_only(tmp_path: Path, monkeypatch):
    path = tmp_path / "旅行.kml"
    raw = TRACK_KML.encode()
    path.write_bytes(raw)
    before = path.stat()

    def no_save(*args, **kwargs):
        pytest.fail("extraction must not save XML")

    monkeypatch.setattr(xmlutil, "save", no_save)
    data = read_track_data(path)
    assert data.source == str(path)
    assert data.name == "2024-05-01 test"
    assert data.track_tags == data.start_name == data.end_name == ""
    assert len(data.tracks) == 1
    feature = data.tracks[0]
    assert (feature.name, feature.index, feature.placemark_id) == ("track", 1, "")
    assert len(feature.segments) == 1
    segment = feature.segments[0]
    assert segment.kind == "gx:Track"
    assert segment.longitude == array("d", [116, 116.1, 116.2, 116.3])
    assert segment.latitude == array("d", [39, 39.1, 39.2, 39.3])
    assert segment.altitude == array("d", [100, 110, 120, 130])
    assert segment.time_us == array("q", [1714521600000000 + i * 60000000 for i in range(4)])
    assert path.read_bytes() == raw
    assert (path.stat().st_mtime_ns, path.stat().st_size) == (before.st_mtime_ns, before.st_size)
    assert list(tmp_path.iterdir()) == [path]


def test_metadata_and_xml_unchanged():
    tree = document(
        '<!-- retained --><Placemark id="pm"><name><![CDATA[路径 & 名称]]></name>'
        + line("120,30 121,31")
        + "</Placemark>",
        '<ExtendedData><Data name="TrackTags"><value> 自定义活动 </value></Data>'
        '<Data name="PosStartName"><value>起点</value></Data>'
        '<Data name="PosEndName"><value>终点</value></Data></ExtendedData>',
    )
    before = etree.tostring(tree)
    data = track_data_from_tree(tree, source="future/entry.kml")
    assert (data.name, data.source) == ("旅程", "future/entry.kml")
    assert (data.track_tags, data.start_name, data.end_name) == ("自定义活动", "起点", "终点")
    assert data.tracks[0].name == "路径 & 名称"
    assert data.tracks[0].placemark_id == "pm"
    assert etree.tostring(tree) == before
    # The returned arrays neither alias XML nor a hidden cache.
    data.tracks[0].segments[0].longitude[0] = 0
    assert etree.tostring(tree) == before
    assert track_data_from_tree(tree).tracks[0].segments[0].longitude[0] == 120


def test_nested_geometry_and_feature_boundaries_preserve_order():
    tree = document(
        "<Folder><Placemark><name>point only</name><Point><coordinates>0,0</coordinates></Point></Placemark>"
        '<Placemark id="a"><name>same</name><MultiGeometry>'
        + line("9,8 7,6 9,8")
        + "<MultiGeometry><gx:MultiTrack><gx:interpolate>1</gx:interpolate>"
        + track(("3 4", "2 1"), ("1970-01-01T00:00:02Z", "1970-01-01T00:00:01Z"))
        + track(("-1 -2",))
        + "</gx:MultiTrack>"
        + line("-5,-6 -7,-8")
        + '</MultiGeometry></MultiGeometry></Placemark></Folder><Placemark id="b"><name>same</name>'
        + track(("80 20", "81 21"), ("1970-01-01T00:00:00Z", "1970-01-01T00:00:00Z"))
        + "</Placemark>"
    )
    data = track_data_from_tree(tree)
    assert [(f.index, f.placemark_id, f.name) for f in data.tracks] == [(2, "a", "same"), (3, "b", "same")]
    assert [list(s.longitude) for f in data.tracks for s in f.segments] == [[9, 7, 9], [3, 2], [-1], [-5, -7], [80, 81]]
    first, second = data.tracks
    assert [s.kind for s in first.segments] == ["LineString", "gx:Track", "gx:Track", "LineString"]
    assert first.segments[1].time_us == array("q", [2000000, 1000000])
    assert first.segments[2].time_us is None
    assert second.segments[0].time_us == array("q", [0, 0])


@pytest.mark.parametrize("geometry", [line("1,2\n 3,4\t1,2"), track(("1 2", "3 4", "1 2"))])
def test_no_optional_arrays_when_entirely_absent(geometry):
    segment = extract(geometry).tracks[0].segments[0]
    assert segment.longitude == array("d", [1, 3, 1])
    assert segment.latitude == array("d", [2, 4, 2])
    assert segment.altitude is None
    assert segment.time_us is None


@pytest.mark.parametrize("geometry", [line("1,2 3,4,0 5,6 7,8,-2.5"), track(("1 2", "3 4 0", "5 6", "7 8 -2.5"))])
def test_partial_altitude_and_explicit_zero(geometry):
    segment = extract(geometry).tracks[0].segments[0]
    assert segment.altitude is not None
    assert len(segment.altitude) == len(segment.longitude) == len(segment.latitude) == 4
    assert isnan(segment.altitude[0]) and isnan(segment.altitude[2])
    assert segment.altitude[1] == 0
    assert segment.altitude[3] == -2.5


def test_all_zero_altitude_and_original_float_values():
    segment = extract(line("-180,-90,-0 180,90,0 1.2345678901234567,-0,0 1e-10,2E1,0")).tracks[0].segments[0]
    assert segment.longitude == array("d", [-180, 180, 1.2345678901234567, 1e-10])
    assert segment.latitude == array("d", [-90, 90, -0.0, 20])
    assert segment.altitude == array("d", [-0.0, 0, 0, 0])
    assert copysign(1, segment.latitude[2]) == -1
    assert copysign(1, segment.altitude[0]) == -1


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("1970-01-01T00:00:00Z", 0),
        ("1970-01-01T08:00:00+08:00", 0),
        ("1969-12-31T16:00:00-08:00", 0),
        ("1970-01-01T00:00:00.123456789Z", 123456),
        ("1969-12-31T23:59:59.999999999Z", -1),
        ("1970-01-01T00:00:00.1-00:00", 100000),
        ("9999-12-31T23:59:59.999999Z", 253402300799999999),
        ("0001-01-01T00:00:00Z", -62135596800000000),
    ],
)
def test_time_conversion(value, expected):
    segment = extract(track(("1 2",), (value,))).tracks[0].segments[0]
    assert segment.time_us == array("q", [expected])


def test_legacy_gx_when_and_geometry_id():
    geometry = track(("1 2",), ("1970-01-01T00:00:00Z",))
    geometry = geometry.replace("<gx:Track>", '<gx:Track id="segment-id">')
    geometry = geometry.replace("<when>", "<gx:when>").replace("</when>", "</gx:when>")
    segment = extract(geometry).tracks[0].segments[0]
    assert segment.geometry_id == "segment-id"
    assert segment.time_us == array("q", [0])


@pytest.mark.parametrize(
    "value",
    [
        "",
        "garbage",
        "2024-02-30T12:00:00Z",
        "2024-01-01",
        "2024-01-01T12:00:00",
        "2024-01-01T12:00:00+08:60",
        "2024-01-01T12:00:60Z",
        "2024-01-01T12:00:00+24:00",
    ],
)
def test_invalid_time_location(value):
    with pytest.raises(UserInputError, match=r"trip.kml: Placemark 1 .*segment 1 .*point 2: Invalid timestamp"):
        extract(track(("1 2", "3 4"), ("1970-01-01T00:00:00Z", value)))


@pytest.mark.parametrize("counts", [(2, 1, 1, 2), (1, 2, 2, 1), (2, 0, 2, 4)])
def test_time_count_checked_per_track_even_when_document_totals_equal(counts):
    coords_a, times_a, coords_b, times_b = counts
    assert coords_a + coords_b == times_a + times_b
    a = track(("1 2",) * coords_a, ("1970-01-01T00:00:00Z",) * times_a)
    b = track(("3 4",) * coords_b, ("1970-01-01T00:00:00Z",) * times_b)
    segments = extract(f"<gx:MultiTrack>{a}{b}</gx:MultiTrack>").tracks[0].segments
    assert [len(s.longitude) for s in segments] == [coords_a, coords_b]
    assert all(s.time_us is None for s in segments)


@pytest.mark.parametrize("times", [(), ("invalid",), ("invalid",) * 3])
def test_mismatched_times_keep_geometry_and_other_segments_times(times):
    a = track(("1 2 0", "3 4"), times)
    b = track(("5 6 7",), ("1970-01-01T00:00:01Z",))
    first, second = extract(f"<MultiGeometry>{a}{b}</MultiGeometry>").tracks[0].segments
    assert first.longitude == array("d", [1, 3])
    assert first.latitude == array("d", [2, 4])
    assert first.altitude[0] == 0 and isnan(first.altitude[1])
    assert first.time_us is None
    assert second.time_us == array("q", [1000000])


@pytest.mark.parametrize(
    "coordinate, message",
    [
        ("x 2", "Invalid longitude"),
        ("1 nope", "Invalid latitude"),
        ("1 2 x", "Invalid altitude"),
        ("nan 2", "Invalid longitude"),
        ("1 inf", "Invalid latitude"),
        ("1 2 NaN", "Invalid altitude"),
        ("1e999 2", "Non-finite longitude"),
        ("1 2 1e999", "Non-finite altitude"),
        ("181 2", "longitude out of range"),
        ("1 -91", "latitude out of range"),
        ("1_0 2", "Invalid longitude"),
        ("", "Malformed coordinate"),
        ("1", "Malformed coordinate"),
        ("1 2 3 4", "Malformed coordinate"),
    ],
)
def test_invalid_coordinate_location(coordinate, message):
    with pytest.raises(UserInputError, match=rf"trip.kml: Placemark 1 .*segment 2 .*point 2: {message}"):
        extract(line("0,0") + track(("1 2", coordinate)))


@pytest.mark.parametrize("coordinate", ["1,2,", "1,,2", ",2", "1,2,3,4", "1, 2", "1,nan", "1,91"])
def test_invalid_linestring(coordinate):
    with pytest.raises(UserInputError, match=r"segment 1 .*point 1"):
        extract(line(coordinate))


@pytest.mark.parametrize(
    "geometry", ["<gx:Track/>", line(" \n "), "<LineString/>", "<LineString><coordinates/><coordinates/></LineString>"]
)
def test_empty_or_malformed_line_fails(geometry):
    with pytest.raises(UserInputError, match=r"trip.kml: Placemark 1 .*segment 1"):
        extract(geometry)


def test_no_lines_and_failed_extraction_leave_tree_unchanged():
    for body in [
        "",
        "<Placemark><Point><coordinates>1,2</coordinates></Point></Placemark>",
        "<Placemark>" + track(("bad 2",)) + "</Placemark>",
    ]:
        tree = document(body)
        before = etree.tostring(tree)
        with pytest.raises(UserInputError):
            track_data_from_tree(tree)
        assert etree.tostring(tree) == before
    with pytest.raises(UserInputError, match="No extractable line tracks"):
        track_data_from_tree(document(""))


def test_missing_and_malformed_files(tmp_path):
    path = tmp_path / "bad.kml"
    with pytest.raises(UserInputError, match="bad.kml"):
        read_track_data(path)
    path.write_text("<kml>")
    with pytest.raises(UserInputError, match="bad.kml"):
        read_track_data(path)
    assert path.read_text() == "<kml>"


@pytest.mark.parametrize("optional", [False, True])
def test_ten_thousand_points_use_compact_aligned_arrays(optional):
    count = 10000
    geometry = (
        track(("120.123456789 30.123456789 0",) * count, ("2024-01-01T00:00:00Z",) * count)
        if optional
        else line("120.123456789,30.123456789 " * count)
    )
    segment = extract(geometry).tracks[0].segments[0]
    arrays = [segment.longitude, segment.latitude]
    if optional:
        arrays.extend([segment.altitude, segment.time_us])
    else:
        assert segment.altitude is segment.time_us is None
    assert all(isinstance(values, array) and len(values) == count and values.itemsize == 8 for values in arrays)
    assert [values.typecode for values in arrays] == (["d", "d", "d", "q"] if optional else ["d", "d"])
    assert sum(values.buffer_info()[1] * values.itemsize for values in arrays) == count * (32 if optional else 16)
    assert segment.longitude[0] == segment.longitude[-1] == 120.123456789
