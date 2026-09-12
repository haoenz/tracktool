"""Tests for media time parsing and KML timestamp/point matching logic."""

from datetime import UTC, datetime

import pytest
from conftest import TRACK_KML

from tracktool import mediatime
from tracktool.exif.position import (
    SetPositionOptions,
    TrackPoint,
    _find_best_track,
    _verify_or_skip,
    get_position_from_kml,
)
from tracktool.kml import xmlutil


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
        assert pos.seconds_from_nearest == 0
        assert pos.inside_duration is True

    def test_inside_nearest_neighbor(self):
        # 00:01:20 在 [00:01, 00:02] 之间，离 00:01 更近
        t = self.track_start.timestamp() + 80
        pos = get_position_from_kml(self.tree, datetime.fromtimestamp(t, tz=UTC))
        assert pos is not None
        assert pos.latitude == "39.1"
        assert pos.seconds_from_nearest == 20
        assert pos.inside_duration is True

    def test_before_track_outside_duration(self):
        before = datetime(2024, 4, 30, 23, 59, 30, tzinfo=UTC)
        pos = get_position_from_kml(self.tree, before)
        assert pos is not None
        assert pos.seconds_from_nearest == 30
        assert pos.inside_duration is False

    def test_after_track_outside_duration(self):
        t = datetime(2024, 5, 1, 0, 3, 30, tzinfo=UTC)
        pos = get_position_from_kml(self.tree, t)
        assert pos is not None
        assert pos.latitude == "39.3"
        assert pos.seconds_from_nearest == 30
        assert pos.inside_duration is False

    def test_rounding_to_nearest(self):
        # 00:01:40 离 00:02 更近
        t = self.track_start.timestamp() + 100
        pos = get_position_from_kml(self.tree, datetime.fromtimestamp(t, tz=UTC))
        assert pos is not None
        assert pos.latitude == "39.2"
        assert pos.seconds_from_nearest == 20
        assert pos.inside_duration is True


class TestFindBestTrack:
    def setup_method(self):
        self.tree = xmlutil.parse_string(TRACK_KML)

    def test_inside_match_wins(self):
        # 第一个候选（06:00 轨迹）在持续时间外，第二个（00:00 轨迹）命中持续时间
        shifted = xmlutil.parse_string(TRACK_KML.replace("T00:0", "T06:0"))
        cache = {"2024-05-01 far.kml": shifted, "2024-05-01 near.kml": self.tree}
        media_time = datetime(2024, 5, 1, 0, 1, 20, tzinfo=UTC)
        best = _find_best_track(cache, media_time, multiday=False)
        assert best is not None
        assert best.inside_duration is True
        assert best.latitude == "39.1"
        assert best.seconds_from_nearest == 20

    def test_closest_out_of_duration_kept(self):
        shifted = xmlutil.parse_string(TRACK_KML.replace("T00:0", "T06:0"))
        cache = {"2024-05-01 far.kml": self.tree, "2024-05-01 near.kml": shifted}
        media_time = datetime(2024, 5, 1, 5, 30, 0, tzinfo=UTC)
        best = _find_best_track(cache, media_time, multiday=False)
        assert best is not None
        assert best.inside_duration is False
        # far 轨迹最近点 00:03 差 19620s，near 轨迹 06:00 差 1800s
        assert best.seconds_from_nearest == 1800
        assert best.latitude == "39.0"

    def test_multiday_window(self):
        cache = {"2024-05-01 trip.kml": self.tree}
        media_time = datetime(2024, 4, 30, 23, 59, 30, tzinfo=UTC)
        assert _find_best_track(cache, media_time, multiday=False) is None
        best = _find_best_track(cache, media_time, multiday=True)
        assert best is not None
        assert best.inside_duration is False
        assert best.seconds_from_nearest == 30

    def test_kml_without_gps_skipped(self):
        empty = xmlutil.parse_string(
            '<kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>')
        cache = {"2024-05-01 empty.kml": empty}
        assert _find_best_track(cache, datetime(2024, 5, 1, 0, 0, 0, tzinfo=UTC),
                                multiday=False) is None


class TestVerifyOrSkip:
    EXISTING = "39 deg 0' 0\" N, 116 deg 0' 0\" E"

    @staticmethod
    def _point(lat: str, lon: str) -> TrackPoint:
        return TrackPoint(latitude=lat, longitude=lon, altitude="100",
                          seconds_from_nearest=0, inside_duration=True)

    def test_matching_position_proceeds(self):
        assert _verify_or_skip(self.EXISTING, self._point("39.0", "116.0"),
                               SetPositionOptions()) is True

    def test_mismatch_beyond_threshold_skips(self):
        far = self._point("40.0", "117.0")
        assert _verify_or_skip(self.EXISTING, far, SetPositionOptions()) is False
        assert _verify_or_skip(self.EXISTING, far, SetPositionOptions(force=True)) is True

    def test_unparseable_existing_proceeds(self):
        assert _verify_or_skip("garbage", self._point("40.0", "117.0"),
                               SetPositionOptions()) is True


class TestKmlType:
    def test_get_kml_type(self, tmp_path):
        kml = tmp_path / "2024-05-01 test.kml"
        kml.write_text(TRACK_KML, encoding="utf-8")
        # 无 TrackTags ExtendedData -> Unknown
        from tracktool.kml.kmlfile import TrackType, get_kml_type

        assert get_kml_type(kml) is TrackType.UNKNOWN

    def test_get_kml_type_with_tags(self, tmp_path):
        # TrackTags 是 Document 级 ExtendedData，紧跟在 <Document> 之后
        kml_content = TRACK_KML.replace(
            "<Document>",
            "<Document>"
            "<ExtendedData><Data name='TrackTags'><value>徒步</value></Data></ExtendedData>",
        )
        kml = tmp_path / "2024-05-01 test.kml"
        kml.write_text(kml_content, encoding="utf-8")
        from tracktool.kml.kmlfile import TrackType, get_kml_type

        assert get_kml_type(kml) is TrackType.DEFAULT
