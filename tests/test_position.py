"""Tests for media time parsing and KML timestamp/point matching logic."""

import zipfile
from datetime import UTC, datetime
from pathlib import Path

import pytest
from conftest import TRACK_KML

from tracktool import mediatime
from tracktool.actions import Failed, Skip, WriteTags
from tracktool.exif.position import (
    GeotagOptions,
    _candidate_dates,
    _find_best_track,
    _TrackLibrary,
    _verify_or_skip,
    decide_position,
)
from tracktool.kml import xmlutil
from tracktool.kml.track import Track, TrackMatch, TrackPoint
from tracktool.metadata import MediaMetadata


def make_track(kml_text: str = TRACK_KML, name: str = "2024-05-01 test.kml") -> Track:
    return Track.from_kml(xmlutil.parse_string(kml_text), name)


class TestMediatimeParsing:
    def test_offset_helper(self):
        assert mediatime.parse_offset("+08:00") == 8 * 3600
        assert mediatime.parse_offset("-05:30") == -(5 * 3600 + 30 * 60)
        with pytest.raises(ValueError):
            mediatime.parse_offset("bad")


class TestTrackLoading:
    def test_points_carry_time_and_place(self):
        track = make_track()

        assert track.name == "2024-05-01 test.kml"
        assert track.points[0] == TrackPoint(39.0, 116.0, 100.0,
                                             datetime(2024, 5, 1, 0, 0, 0, tzinfo=UTC))
        assert len(track.points) == 4

    def test_mismatched_lists_are_rejected_at_load(self):
        # whens 与 coords 数量不一致的 KML 是坏文件，加载时就报，而不是错位取点
        broken = TRACK_KML.replace("<when>2024-05-01T00:02:00Z</when>", "")
        with pytest.raises(Exception, match="coordinate|timestamp"):
            make_track(broken)


class TestTrackNearest:
    def setup_method(self):
        self.track = make_track()
        self.track_start = datetime(2024, 5, 1, 0, 0, 0, tzinfo=UTC)

    def test_exact_match(self):
        match = self.track.nearest(self.track_start)
        assert match is not None
        assert match.point.latitude == 39.0
        assert match.point.longitude == 116.0
        assert match.point.altitude == 100.0
        assert match.seconds_from_nearest == 0
        assert match.inside_duration is True

    def test_inside_nearest_neighbor(self):
        # 00:01:20 在 [00:01, 00:02] 之间，离 00:01 更近
        t = self.track_start.timestamp() + 80
        match = self.track.nearest(datetime.fromtimestamp(t, tz=UTC))
        assert match is not None
        assert match.point.latitude == 39.1
        assert match.seconds_from_nearest == 20
        assert match.inside_duration is True

    def test_before_track_outside_duration(self):
        before = datetime(2024, 4, 30, 23, 59, 30, tzinfo=UTC)
        match = self.track.nearest(before)
        assert match is not None
        assert match.seconds_from_nearest == 30
        assert match.inside_duration is False

    def test_after_track_outside_duration(self):
        t = datetime(2024, 5, 1, 0, 3, 30, tzinfo=UTC)
        match = self.track.nearest(t)
        assert match is not None
        assert match.point.latitude == 39.3
        assert match.seconds_from_nearest == 30
        assert match.inside_duration is False

    def test_rounding_to_nearest(self):
        # 00:01:40 离 00:02 更近
        t = self.track_start.timestamp() + 100
        match = self.track.nearest(datetime.fromtimestamp(t, tz=UTC))
        assert match is not None
        assert match.point.latitude == 39.2
        assert match.seconds_from_nearest == 20
        assert match.inside_duration is True

    def test_an_empty_track_matches_nothing(self):
        empty = make_track('<kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>')
        assert empty.nearest(datetime(2024, 5, 1, tzinfo=UTC)) is None


class TestFindBestTrack:
    def setup_method(self):
        self.track = make_track()

    def test_inside_match_wins(self):
        # 第一个候选（06:00 轨迹）在持续时间外，第二个（00:00 轨迹）命中持续时间
        far = make_track(TRACK_KML.replace("T00:0", "T06:0"), "2024-05-01 far.kml")
        near = make_track(TRACK_KML, "2024-05-01 near.kml")
        media_time = datetime(2024, 5, 1, 0, 1, 20, tzinfo=UTC)
        best = _find_best_track([far, near], media_time, multiday=False)
        assert best is not None
        assert best.inside_duration is True
        assert best.point.latitude == 39.1
        assert best.seconds_from_nearest == 20

    def test_closest_out_of_duration_kept(self):
        far = make_track(TRACK_KML, "2024-05-01 far.kml")
        near = make_track(TRACK_KML.replace("T00:0", "T06:0"), "2024-05-01 near.kml")
        media_time = datetime(2024, 5, 1, 5, 30, 0, tzinfo=UTC)
        best = _find_best_track([far, near], media_time, multiday=False)
        assert best is not None
        assert best.inside_duration is False
        # far 轨迹最近点 00:03 差 19620s，near 轨迹 06:00 差 1800s
        assert best.seconds_from_nearest == 1800
        assert best.point.latitude == 39.0

    def test_multiday_window(self):
        tracks = [make_track(name="2024-05-01 trip.kml")]
        media_time = datetime(2024, 4, 30, 23, 59, 30, tzinfo=UTC)
        assert _find_best_track(tracks, media_time, multiday=False) is None
        best = _find_best_track(tracks, media_time, multiday=True)
        assert best is not None
        assert best.inside_duration is False
        assert best.seconds_from_nearest == 30

    def test_kml_without_gps_skipped(self):
        tracks = [make_track('<kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>',
                             "2024-05-01 empty.kml")]
        assert _find_best_track(tracks, datetime(2024, 5, 1, 0, 0, 0, tzinfo=UTC),
                                multiday=False) is None


class TestCandidateDates:
    def test_single_day(self):
        assert _candidate_dates(datetime(2024, 5, 1, 12, 0), multiday=False) == ["2024-05-01"]

    def test_multiday_reaches_into_neighbor_months(self):
        dates = _candidate_dates(datetime(2024, 5, 1, 0, 30), multiday=True)
        assert dates == ["2024-05-01", "2024-04-30", "2024-05-02"]


class TestTrackLibrary:
    """The layered ZIP read per month, not whole; flat entries stay findable."""

    @staticmethod
    def _zip(tmp_path: Path, entries: dict[str, str]) -> Path:
        zip_path = tmp_path / "Archive.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            for name, text in entries.items():
                zf.writestr(name, text)
        return zip_path

    def test_layered_entries_load_by_month(self, tmp_path):
        zip_path = self._zip(tmp_path, {
            "Default/2024-05/2024-05-01 a.kml": TRACK_KML,
            "Default/2024-06/2024-06-01 b.kml": TRACK_KML,
        })
        library = _TrackLibrary(zip_path)

        assert [t.name for t in library.tracks_for(["2024-05-01"])] == ["2024-05-01 a.kml"]

    def test_unlayered_entries_are_always_available(self, tmp_path):
        zip_path = self._zip(tmp_path, {"2024-05-01 flat.kml": TRACK_KML})
        library = _TrackLibrary(zip_path)

        assert [t.name for t in library.tracks_for(["2023-01-01"])] == ["2024-05-01 flat.kml"]

    def test_multiday_window_spans_months(self, tmp_path):
        zip_path = self._zip(tmp_path, {
            "Train/2024-04/2024-04-30 t.kml": TRACK_KML,
            "Train/2024-05/2024-05-02 t.kml": TRACK_KML,
        })
        library = _TrackLibrary(zip_path)

        names = {t.name for t in library.tracks_for(
            _candidate_dates(datetime(2024, 5, 1, 0, 0), multiday=True))}
        assert names == {"2024-04-30 t.kml", "2024-05-02 t.kml"}

    def test_a_month_parses_once_and_is_cached(self, tmp_path):
        zip_path = self._zip(tmp_path, {"Default/2024-05/2024-05-01 a.kml": TRACK_KML})
        library = _TrackLibrary(zip_path)

        first = library.tracks_for(["2024-05-01"])
        second = library.tracks_for(["2024-05-20"])

        assert second == first  # 同一月份只解析一次：两次查询拿到同一批 Track 对象

    def test_broken_kml_is_skipped_not_fatal(self, tmp_path):
        broken = TRACK_KML.replace("<when>2024-05-01T00:02:00Z</when>", "")
        zip_path = self._zip(tmp_path, {
            "Default/2024-05/2024-05-01 bad.kml": broken,
            "Default/2024-05/2024-05-01 good.kml": TRACK_KML,
        })
        library = _TrackLibrary(zip_path)

        assert [t.name for t in library.tracks_for(["2024-05-01"])] == ["2024-05-01 good.kml"]

    def test_non_kml_entries_are_ignored(self, tmp_path):
        zip_path = self._zip(tmp_path, {
            "Default/2024-05/2024-05-01 a.kml": TRACK_KML,
            "Default/2024-05/notes.txt": "not a track",
        })
        library = _TrackLibrary(zip_path)

        assert [t.name for t in library.tracks_for(["2024-05-01"])] == ["2024-05-01 a.kml"]


class TestVerifyOrSkip:
    @staticmethod
    def _match(latitude: float, longitude: float) -> TrackMatch:
        point = TrackPoint(latitude, longitude, 100.0, datetime(2024, 5, 1, tzinfo=UTC))
        return TrackMatch(point, 0, True)

    def test_matching_position_proceeds(self):
        assert _verify_or_skip(39.0, 116.0, self._match(39.0, 116.0),
                               GeotagOptions()) is True

    def test_mismatch_beyond_threshold_skips(self):
        far = self._match(40.0, 117.0)
        assert _verify_or_skip(39.0, 116.0, far, GeotagOptions()) is False
        assert _verify_or_skip(39.0, 116.0, far, GeotagOptions(force=True)) is True

    def test_equator_position_is_a_real_coordinate(self):
        # 纬度 0 是合法坐标，不能因为 falsy 被当成「没有位置」
        assert _verify_or_skip(0.0, 116.0, self._match(0.0, 116.0),
                               GeotagOptions()) is True


class TestKmlType:
    def test_get_kml_type(self, tmp_path):
        kml = tmp_path / "2024-05-01 test.kml"
        kml.write_text(TRACK_KML, encoding="utf-8")
        # 无 TrackTags ExtendedData -> 认不出（None），不是一种类型
        from tracktool.kml.kmlfile import get_kml_type

        assert get_kml_type(kml) is None

    def test_get_kml_type_with_tags(self, tmp_path):
        # TrackTags 是 Document 级 ExtendedData，紧跟在 <Document> 之后
        kml_content = TRACK_KML.replace(
            "<Document>",
            "<Document>"
            "<ExtendedData><Data name='TrackTags'><value>徒步</value></Data></ExtendedData>",
        )
        kml = tmp_path / "2024-05-01 test.kml"
        kml.write_text(kml_content, encoding="utf-8")
        from tracktool.kml.kmlfile import TrackKind, get_kml_type

        assert get_kml_type(kml) is TrackKind.DEFAULT


class TestDecidePosition:
    """The rule as a function of one file's metadata — including what it does
    not bother to look up, which is most of the point of pulling it out."""

    TIME = {"ExifIFD:DateTimeOriginal": "2024:05:01 08:01:30", "ExifIFD:OffsetTimeOriginal": "+08:00"}
    FULL_GPS = {"GPSLatitude": "39.1", "GPSLongitude": "116.1", "GPSAltitude": "110"}

    @staticmethod
    def _meta(**tags: str) -> MediaMetadata:
        return MediaMetadata.of(Path("2024-05-01 a.jpg"), tags)

    @staticmethod
    def _finder(match: TrackMatch | None):
        def find(media_time: datetime) -> TrackMatch | None:
            return match

        return find

    @staticmethod
    def _match(latitude: float = 39.1, longitude: float = 116.1, altitude: float = 110.0,
               seconds: float = 0.0, inside: bool = True) -> TrackMatch:
        point = TrackPoint(latitude, longitude, altitude, datetime(2024, 5, 1, tzinfo=UTC))
        return TrackMatch(point, seconds, inside)

    def test_a_fully_tagged_file_never_searches_the_archive(self):
        def unexpected(media_time: datetime) -> TrackMatch | None:
            raise AssertionError("the archive was searched for a file that needs nothing")

        result = decide_position(self._meta(**self.FULL_GPS), unexpected, GeotagOptions())

        assert result == [Skip(Path("2024-05-01 a.jpg"), "GPS data already exists")]

    def test_a_track_match_plans_the_write(self):
        result = decide_position(self._meta(**self.TIME), self._finder(self._match()),
                                 GeotagOptions(overwrite=True))

        assert result == [WriteTags(Path("2024-05-01 a.jpg"), {
            "GPSLatitude": "39.1", "GPSLatitudeRef": "N",
            "GPSLongitude": "116.1", "GPSLongitudeRef": "E",
            "GPSAltitudeRef": "Above Sea Level", "GPSAltitude": "110.0",
        }, True)]

    def test_the_decision_against_a_real_archive(self):
        # 00:01:30 UTC 落在 [00:01, 00:02] 正中间，取到 00:02 那个点
        tracks = [make_track()]

        result = decide_position(
            self._meta(**self.TIME),
            lambda media_time: _find_best_track(tracks, media_time, multiday=False),
            GeotagOptions())

        assert result[0].tags["GPSLatitude"] == "39.2"
        assert result[0].tags["GPSAltitude"] == "120.0"

    def test_no_timestamp_is_a_failure(self):
        result = decide_position(self._meta(), self._finder(self._match()), GeotagOptions())

        assert result == [Failed(Path("2024-05-01 a.jpg"), "no valid timestamp")]

    def test_no_track_match_is_a_failure(self):
        result = decide_position(self._meta(**self.TIME), self._finder(None), GeotagOptions())

        assert result == [Failed(Path("2024-05-01 a.jpg"), "no matching GPS data in the KML archive")]

    def test_a_match_beyond_the_time_limit_is_a_failure(self):
        result = decide_position(self._meta(**self.TIME),
                                 self._finder(self._match(seconds=90.0, inside=False)),
                                 GeotagOptions(max_time_diff_seconds=60))

        assert result == [Failed(Path("2024-05-01 a.jpg"), "best match 90.0s outside the 60s limit")]

    def test_the_existing_altitude_is_kept_when_the_track_has_none(self):
        # KML 点的海拔是 0（未记录），沿用文件里已有的值
        result = decide_position(self._meta(**self.TIME, **self.FULL_GPS),
                                 self._finder(self._match(altitude=0.0)),
                                 GeotagOptions(force=True))

        assert result[0].tags["GPSAltitude"] == "110.0"

    def test_force_rewrites_even_a_fully_tagged_file(self):
        result = decide_position(self._meta(**self.TIME, **self.FULL_GPS),
                                 self._finder(self._match()), GeotagOptions(force=True))

        assert [type(action) for action in result] == [WriteTags]

    def test_a_verification_mismatch_fails_without_quarantine(self):
        result = decide_position(self._meta(**self.TIME, **self.FULL_GPS),
                                 self._finder(self._match(latitude=40.0, longitude=117.0)),
                                 GeotagOptions(verify_existing_gps=True))

        assert result == [Failed(Path("2024-05-01 a.jpg"), "existing GPS disagrees with the KML",
                                 quarantine=False)]

    def test_a_passing_verification_has_nothing_to_write(self):
        result = decide_position(self._meta(**self.TIME, **self.FULL_GPS),
                                 self._finder(self._match()),
                                 GeotagOptions(verify_existing_gps=True))

        assert result == [Skip(Path("2024-05-01 a.jpg"), "existing GPS agrees with the KML match")]
