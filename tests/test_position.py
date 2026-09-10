"""Tests for media time parsing and KML timestamp/point matching logic."""

from datetime import UTC, datetime

import pytest

from tracktool import mediatime
from tracktool.exif.position import get_position_from_kml
from tracktool.kml import xmlutil

TRACK_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
<name>2024-05-01 test track</name>
<Folder>
<Placemark>
<gx:Track>
<when>2024-05-01T00:00:00Z</when>
<when>2024-05-01T00:01:00Z</when>
<when>2024-05-01T00:02:00Z</when>
<when>2024-05-01T00:03:00Z</when>
<gx:coord>116.0 39.0 100</gx:coord>
<gx:coord>116.1 39.1 110</gx:coord>
<gx:coord>116.2 39.2 120</gx:coord>
<gx:coord>116.3 39.3 130</gx:coord>
</gx:Track>
</Placemark>
</Folder>
</Document>
</kml>"""


class TestMediatimeParsing:
    def test_offset_helper(self):
        assert mediatime.parse_offset("+08:00") == 8 * 3600
        assert mediatime.parse_offset("-05:30") == -(5 * 3600 + 30 * 60)
        with pytest.raises(ValueError):
            mediatime.parse_offset("bad")


class TestGetPositionFromKml:
    def setup_method(self):
        self.tree = xmlutil.parse_string(TRACK_KML)
        self.track_start = datetime(2024, 5, 1, 0, 0, 0, tzinfo=UTC)

    def test_exact_match(self):
        pos = get_position_from_kml(self.tree, self.track_start)
        assert pos is not None
        assert pos.latitude == "39.0"
        assert pos.longitude == "116.0"
        assert pos.altitude == "100"
        assert pos.time_diff == 0

    def test_inside_nearest_neighbor(self):
        # 00:01:20 在 [00:01, 00:02] 之间，离 00:01 更近
        t = self.track_start.timestamp() + 80
        pos = get_position_from_kml(self.tree, datetime.fromtimestamp(t, tz=UTC))
        assert pos is not None
        assert pos.latitude == "39.1"
        assert pos.time_diff == 20

    def test_before_track_negative_diff(self):
        before = datetime(2024, 4, 30, 23, 59, 30, tzinfo=UTC)
        pos = get_position_from_kml(self.tree, before)
        assert pos is not None
        assert pos.time_diff == -30

    def test_after_track_negative_diff(self):
        t = datetime(2024, 5, 1, 0, 3, 30, tzinfo=UTC)
        pos = get_position_from_kml(self.tree, t)
        assert pos is not None
        assert pos.latitude == "39.3"
        assert pos.time_diff == -30

    def test_rounding_to_nearest(self):
        # 00:01:40 离 00:02 更近
        t = self.track_start.timestamp() + 100
        pos = get_position_from_kml(self.tree, datetime.fromtimestamp(t, tz=UTC))
        assert pos is not None
        assert pos.latitude == "39.2"
        assert pos.time_diff == 20


class TestKmlType:
    def test_get_kml_type(self, tmp_path):
        kml = tmp_path / "2024-05-01 test.kml"
        kml.write_text(TRACK_KML, encoding="utf-8")
        # 无 TrackTags ExtendedData -> Unknown
        from tracktool.kml.kmlfile import get_kml_type

        assert get_kml_type(kml) == "Unknown"

    def test_get_kml_type_with_tags(self, tmp_path):
        kml_content = TRACK_KML.replace(
            "<name>2024-05-01 test track</name>",
            "<name>2024-05-01 test track</name>"
            "<ExtendedData><Data name='TrackTags'><value>徒步</value></Data></ExtendedData>",
        )
        kml = tmp_path / "2024-05-01 test.kml"
        kml.write_text(kml_content, encoding="utf-8")
        from tracktool.kml.kmlfile import get_kml_type

        assert get_kml_type(kml) == "Default"
