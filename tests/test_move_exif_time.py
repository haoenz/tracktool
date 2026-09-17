"""Unit tests for the move_exif_time rules: offset/time-diff resolution, the
(make, ext) tag-set table, the Insta360 name sync, and the decisions the two
move commands take per file."""

import logging
from datetime import timedelta
from pathlib import Path

from tracktool import actions
from tracktool.actions import Failed, Rename, ShiftTags, Skip, WriteTags
from tracktool.exif.media import (
    _compute_time_shift,
    _insta360_new_name,
    decide_altitude_shift,
    decide_time_shift,
)
from tracktool.metadata import MediaMetadata
from tracktool.tags import MAKE_FUJIFILM, MAKE_INSTA360, MAKE_SONY, TIMESTAMP_TAG_SETS


def _meta(name: str, **tags: str) -> MediaMetadata:
    return MediaMetadata.of(Path(name), tags)


class TestComputeTimeShift:
    """"make" and "current_offset" are handed in: the caller reads both tags in
    one exiftool call, so this helper needs no tag access of its own."""

    def test_time_diff_only(self):
        assert _compute_time_shift(Path("x.jpg"), "+1h30m", "", MAKE_SONY, "") == (5400, {})

    def test_time_diff_negative(self):
        assert _compute_time_shift(Path("x.jpg"), "-2d", "", MAKE_SONY, "") == (-172800, {})

    def test_offset_only_builds_tz_tags(self):
        total, tz_tags = _compute_time_shift(Path("x.arw"), "", "+08:00", MAKE_SONY, "+09:00")
        assert total == -3600
        assert tz_tags == {
            "ExifIFD:OffsetTime": "+08:00",
            "ExifIFD:OffsetTimeOriginal": "+08:00",
            "ExifIFD:OffsetTimeDigitized": "+08:00",
        }

    def test_offset_missing_tag_defaults_to_plus_8(self, caplog):
        total, tz_tags = _compute_time_shift(Path("x.arw"), "", "+09:00", MAKE_SONY, "")
        assert total == 3600
        assert tz_tags
        assert "assuming +08:00" in caplog.text

    def test_offset_rejected_for_non_sony(self, caplog):
        caplog.set_level(logging.ERROR)
        assert _compute_time_shift(Path("x.mp4"), "", "+08:00", MAKE_INSTA360, "+08:00") is None
        assert "only supported for SONY" in caplog.text

    def test_unparseable_timezone_returns_none(self, caplog):
        caplog.set_level(logging.ERROR)
        assert _compute_time_shift(Path("x.arw"), "", "+08:00", MAKE_SONY, "bogus") is None
        assert "Failed to parse timezones" in caplog.text

    def test_offset_not_requested_for_non_sony_is_fine(self):
        # OffsetTime 跳过时非 SONY 不报错：只做 time_diff 平移
        assert _compute_time_shift(Path("x.mp4"), "+10m", "", MAKE_INSTA360, "") == (600, {})


class TestTagSetTable:
    def test_every_make_constant_appears_exactly_as_table_keys(self):
        makes = {make for make, _ in TIMESTAMP_TAG_SETS}
        assert makes == {MAKE_SONY, MAKE_FUJIFILM, MAKE_INSTA360}

    def test_lookup_matches_old_branching(self):
        sony_photo = TIMESTAMP_TAG_SETS[(MAKE_SONY, ".arw")]
        for ext in (".jpg", ".jpeg"):
            assert TIMESTAMP_TAG_SETS[(MAKE_SONY, ext)] is sony_photo
        for ext in (".tif", ".mov", ".raf"):
            assert (MAKE_SONY, ext) not in TIMESTAMP_TAG_SETS
        assert (MAKE_FUJIFILM, ".jpg") not in TIMESTAMP_TAG_SETS
        assert (MAKE_INSTA360, ".mp4") in TIMESTAMP_TAG_SETS


class TestInsta360NewName:
    """The name is computed, not renamed: the rename is an action to be planned."""

    def test_shifts_timestamp_forward(self):
        assert _insta360_new_name(Path("VID_20240501_120000_00.mp4"),
                                  timedelta(hours=1, minutes=30), is_negative=False) \
            == "VID_20240501_133000_00.mp4"

    def test_shifts_timestamp_backward_across_midnight(self):
        assert _insta360_new_name(Path("VID_20240501_001500_00.mp4"),
                                  timedelta(minutes=30), is_negative=True) \
            == "VID_20240430_234500_00.mp4"

    def test_a_name_without_a_timestamp_has_no_successor(self):
        assert _insta360_new_name(Path("not-instabuild.mp4"), timedelta(hours=1), is_negative=False) is None

    def test_the_planned_rename_lands_on_disk(self, tmp_path: Path):
        file = tmp_path / "VID_20240501_120000_00.mp4"
        file.touch()

        actions.apply(Rename(file, "VID_20240501_133000_00.mp4"))

        assert not file.exists()
        assert (tmp_path / "VID_20240501_133000_00.mp4").is_file()


class TestDecideTimeShift:
    def test_a_plain_shift_moves_the_sony_tag_set(self):
        actions_ = decide_time_shift(_meta("a.jpg", Make=MAKE_SONY), "+1h30m", "", False)

        assert actions_ == [ShiftTags(Path("a.jpg"), TIMESTAMP_TAG_SETS[(MAKE_SONY, ".jpg")],
                                      timedelta(seconds=5400), False)]

    def test_nothing_asked_for_is_a_skip(self):
        assert decide_time_shift(_meta("a.jpg", Make=MAKE_SONY), "", "", False) == [
            Skip(Path("a.jpg"), "no timezone or time-shift changes required")]

    def test_a_timezone_already_in_place_only_rewrites_the_tags(self):
        # 目标偏移与当前偏移相同：位移为 0，但三个 OffsetTime 标签仍要落盘
        result = decide_time_shift(_meta("a.arw", Make=MAKE_SONY, **{"ExifIFD:OffsetTime": "+08:00"}),
                                   "", "+08:00", False)

        assert result == [WriteTags(Path("a.arw"), {
            "ExifIFD:OffsetTime": "+08:00",
            "ExifIFD:OffsetTimeOriginal": "+08:00",
            "ExifIFD:OffsetTimeDigitized": "+08:00",
        }, False)]

    def test_a_shift_and_a_timezone_are_two_steps_in_order(self):
        result = decide_time_shift(
            _meta("a.jpg", Make=MAKE_SONY, **{"ExifIFD:OffsetTime": "+09:00"}), "+10m", "+08:00", True)

        assert [type(action) for action in result] == [ShiftTags, WriteTags]
        assert result[0].delta == timedelta(seconds=600 - 3600)
        assert result[1].tags["ExifIFD:OffsetTime"] == "+08:00"
        assert all(action.overwrite for action in result)

    def test_an_unsupported_camera_is_a_failure(self):
        result = decide_time_shift(_meta("a.jpg", Make=MAKE_FUJIFILM), "+1h", "", False)

        assert result == [Failed(Path("a.jpg"), "unsupported camera/extension: FUJIFILM .jpg")]

    def test_a_timezone_on_a_non_sony_camera_is_a_failure(self):
        result = decide_time_shift(_meta("a.mp4", Make=MAKE_INSTA360), "", "+08:00", False)

        assert result == [Failed(Path("a.mp4"), "time shift not applicable to this file")]

    def test_an_insta360_clip_gets_its_name_shifted_too(self):
        result = decide_time_shift(_meta("VID_20240501_120000_00.mp4", Make=MAKE_INSTA360),
                                   "+1h", "", False)

        assert result == [ShiftTags(Path("VID_20240501_120000_00.mp4"),
                                    TIMESTAMP_TAG_SETS[(MAKE_INSTA360, ".mp4")], timedelta(hours=1), False),
                          Rename(Path("VID_20240501_120000_00.mp4"), "VID_20240501_130000_00.mp4")]

    def test_an_insta360_clip_with_a_foreign_name_keeps_it(self, caplog):
        caplog.set_level(logging.ERROR)

        result = decide_time_shift(_meta("holiday.mp4", Make=MAKE_INSTA360), "+1h", "", False)

        assert [type(action) for action in result] == [ShiftTags]
        assert "does not match Insta360 naming pattern" in caplog.text


class TestDecideAltitudeShift:
    def test_no_altitude_is_a_failure(self):
        assert decide_altitude_shift(_meta("a.jpg"), 5.0, False) == [
            Failed(Path("a.jpg"), "no GPSAltitude to shift")]

    def test_a_zero_altitude_counts_as_none(self):
        assert decide_altitude_shift(_meta("a.jpg", GPSAltitude="0"), 5.0, False) == [
            Failed(Path("a.jpg"), "no GPSAltitude to shift")]

    def test_the_shift_keeps_the_sign_of_the_result(self):
        up = decide_altitude_shift(_meta("a.jpg", GPSAltitude="100"), -2.5, False)
        down = decide_altitude_shift(_meta("b.jpg", GPSAltitude="-10"), -5, True)

        assert up == [WriteTags(Path("a.jpg"),
                                {"GPSAltitudeRef": "Above Sea Level", "GPSAltitude": "97.5"}, False)]
        assert down == [WriteTags(Path("b.jpg"),
                                  {"GPSAltitudeRef": "Below Sea Level", "GPSAltitude": "15.0"}, True)]
