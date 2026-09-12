"""Tests for media time parsing and KML timestamp/point matching logic."""

from datetime import UTC, datetime
from pathlib import Path

import pytest
from conftest import TRACK_KML

from tracktool import mediatime
from tracktool.actions import Failed, Skip, WriteTags
from tracktool.exif.position import (
    SetPositionOptions,
    TrackPoint,
    _find_best_track,
    _verify_or_skip,
    decide_position,
    get_position_from_kml,
)
from tracktool.kml import xmlutil
from tracktool.metadata import MediaMetadata


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
        assert pos.latitude == 39.0
        assert pos.longitude == 116.0
        assert pos.altitude == 100.0
        assert pos.seconds_from_nearest == 0
        assert pos.inside_duration is True

    def test_inside_nearest_neighbor(self):
        # 00:01:20 在 [00:01, 00:02] 之间，离 00:01 更近
        t = self.track_start.timestamp() + 80
        pos = get_position_from_kml(self.tree, datetime.fromtimestamp(t, tz=UTC))
        assert pos is not None
        assert pos.latitude == 39.1
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
        assert pos.latitude == 39.3
        assert pos.seconds_from_nearest == 30
        assert pos.inside_duration is False

    def test_rounding_to_nearest(self):
        # 00:01:40 离 00:02 更近
        t = self.track_start.timestamp() + 100
        pos = get_position_from_kml(self.tree, datetime.fromtimestamp(t, tz=UTC))
        assert pos is not None
        assert pos.latitude == 39.2
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
        assert best.latitude == 39.1
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
        assert best.latitude == 39.0

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
    @staticmethod
    def _point(latitude: float, longitude: float) -> TrackPoint:
        return TrackPoint(latitude=latitude, longitude=longitude, altitude=100.0,
                          seconds_from_nearest=0, inside_duration=True)

    def test_matching_position_proceeds(self):
        assert _verify_or_skip(39.0, 116.0, self._point(39.0, 116.0),
                               SetPositionOptions()) is True

    def test_mismatch_beyond_threshold_skips(self):
        far = self._point(40.0, 117.0)
        assert _verify_or_skip(39.0, 116.0, far, SetPositionOptions()) is False
        assert _verify_or_skip(39.0, 116.0, far, SetPositionOptions(force=True)) is True

    def test_equator_position_is_a_real_coordinate(self):
        # 纬度 0 是合法坐标，不能因为 falsy 被当成「没有位置」
        assert _verify_or_skip(0.0, 116.0, self._point(0.0, 116.0),
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


class TestDecidePosition:
    """The rule as a function of one file's metadata — including what it does
    not bother to look up, which is most of the point of pulling it out."""

    TIME = {"ExifIFD:DateTimeOriginal": "2024:05:01 08:01:30", "ExifIFD:OffsetTimeOriginal": "+08:00"}
    FULL_GPS = {"GPSLatitude": "39.1", "GPSLongitude": "116.1", "GPSAltitude": "110"}

    @staticmethod
    def _meta(**tags: str) -> MediaMetadata:
        return MediaMetadata.of(Path("2024-05-01 a.jpg"), tags)

    @staticmethod
    def _finder(point: TrackPoint | None):
        def find(media_time: datetime) -> TrackPoint | None:
            return point

        return find

    @staticmethod
    def _point(latitude: float = 39.1, longitude: float = 116.1, altitude: float = 110.0,
               seconds: float = 0.0, inside: bool = True) -> TrackPoint:
        return TrackPoint(latitude=latitude, longitude=longitude, altitude=altitude,
                          seconds_from_nearest=seconds, inside_duration=inside)

    def test_a_fully_tagged_file_never_searches_the_archive(self):
        def unexpected(media_time: datetime) -> TrackPoint | None:
            raise AssertionError("the archive was searched for a file that needs nothing")

        result = decide_position(self._meta(**self.FULL_GPS), unexpected, SetPositionOptions())

        assert result == [Skip(Path("2024-05-01 a.jpg"), "GPS data already exists")]

    def test_a_track_match_plans_the_write(self):
        result = decide_position(self._meta(**self.TIME), self._finder(self._point()),
                                 SetPositionOptions(overwrite=True))

        assert result == [WriteTags(Path("2024-05-01 a.jpg"), {
            "GPSLatitude": "39.1", "GPSLatitudeRef": "N",
            "GPSLongitude": "116.1", "GPSLongitudeRef": "E",
            "GPSAltitudeRef": "Above Sea Level", "GPSAltitude": "110.0",
        }, True)]

    def test_the_decision_against_a_real_archive(self):
        # 00:01:30 UTC 落在 [00:01, 00:02] 正中间，取到 00:02 那个点
        cache = {"2024-05-01 test.kml": xmlutil.parse_string(TRACK_KML)}

        result = decide_position(
            self._meta(**self.TIME),
            lambda media_time: _find_best_track(cache, media_time, multiday=False),
            SetPositionOptions())

        assert result[0].tags["GPSLatitude"] == "39.2"
        assert result[0].tags["GPSAltitude"] == "120.0"

    def test_no_timestamp_is_a_failure(self):
        result = decide_position(self._meta(), self._finder(self._point()), SetPositionOptions())

        assert result == [Failed(Path("2024-05-01 a.jpg"), "no valid timestamp")]

    def test_no_track_match_is_a_failure(self):
        result = decide_position(self._meta(**self.TIME), self._finder(None), SetPositionOptions())

        assert result == [Failed(Path("2024-05-01 a.jpg"), "no matching GPS data in the KML archive")]

    def test_a_match_beyond_the_time_limit_is_a_failure(self):
        result = decide_position(self._meta(**self.TIME),
                                 self._finder(self._point(seconds=90.0, inside=False)),
                                 SetPositionOptions(max_time_diff_seconds=60))

        assert result == [Failed(Path("2024-05-01 a.jpg"), "best match 90.0s outside the 60s limit")]

    def test_the_existing_altitude_is_kept_when_the_track_has_none(self):
        # KML 点的海拔是 0（未记录），沿用文件里已有的值
        result = decide_position(self._meta(**self.TIME, **self.FULL_GPS),
                                 self._finder(self._point(altitude=0.0)),
                                 SetPositionOptions(force=True))

        assert result[0].tags["GPSAltitude"] == "110.0"

    def test_force_rewrites_even_a_fully_tagged_file(self):
        result = decide_position(self._meta(**self.TIME, **self.FULL_GPS),
                                 self._finder(self._point()), SetPositionOptions(force=True))

        assert [type(action) for action in result] == [WriteTags]

    def test_a_verification_mismatch_fails_without_quarantine(self):
        result = decide_position(self._meta(**self.TIME, **self.FULL_GPS),
                                 self._finder(self._point(latitude=40.0, longitude=117.0)),
                                 SetPositionOptions(verify_existing_gps=True))

        assert result == [Failed(Path("2024-05-01 a.jpg"), "existing GPS disagrees with the KML",
                                 quarantine=False)]

    def test_a_passing_verification_has_nothing_to_write(self):
        result = decide_position(self._meta(**self.TIME, **self.FULL_GPS),
                                 self._finder(self._point()),
                                 SetPositionOptions(verify_existing_gps=True))

        assert result == [Skip(Path("2024-05-01 a.jpg"), "existing GPS agrees with the KML match")]
