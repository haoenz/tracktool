"""Unit tests for the move_exif_time helpers extracted in issue #9:
offset/time-diff resolution, shift formatting, the (make, ext) tag-set table,
and Insta360 filename renaming."""

import logging
from datetime import timedelta
from pathlib import Path

from tracktool.exif import media
from tracktool.exif.media import (
    _TAG_SETS,
    MAKE_INSTA360,
    MAKE_SONY,
    _compute_time_shift,
    _format_shift,
    _rename_insta360,
)


class TestComputeTimeShift:
    """"make" and "current_offset" are handed in: the caller reads both tags in
    one exiftool call, so this helper needs no tag access of its own."""

    def test_time_diff_only(self):
        assert _compute_time_shift(Path("x.jpg"), "+1h30m", "", MAKE_SONY, "") == (5400, [])

    def test_time_diff_negative(self):
        assert _compute_time_shift(Path("x.jpg"), "-2d", "", MAKE_SONY, "") == (-172800, [])

    def test_offset_only_builds_tz_params(self):
        total, params = _compute_time_shift(Path("x.arw"), "", "+08:00", MAKE_SONY, "+09:00")
        assert total == -3600
        assert params == [
            "-ExifIFD:OffsetTime=+08:00",
            "-ExifIFD:OffsetTimeOriginal=+08:00",
            "-ExifIFD:OffsetTimeDigitized=+08:00",
        ]

    def test_offset_missing_tag_defaults_to_plus_8(self, caplog):
        total, params = _compute_time_shift(Path("x.arw"), "", "+09:00", MAKE_SONY, "")
        assert total == 3600
        assert params
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
        assert _compute_time_shift(Path("x.mp4"), "+10m", "", MAKE_INSTA360, "") == (600, [])


class TestFormatShift:
    def test_positive(self):
        sign, offset, shift = _format_shift(5400)
        assert (sign, offset, shift) == ("+=", "0:0:0 1:30:0", timedelta(hours=1, minutes=30))

    def test_negative_multi_day(self):
        sign, offset, shift = _format_shift(-3 * 86400 - 61)
        assert sign == "-="
        assert offset == "0:0:3 0:1:1"
        assert shift == timedelta(days=3, minutes=1, seconds=1)

    def test_zero(self):
        sign, offset, shift = _format_shift(0)
        assert sign == "+="
        assert offset == "0:0:0 0:0:0"
        assert shift == timedelta(0)


class TestTagSetTable:
    def test_every_make_constant_appears_exactly_as_table_keys(self):
        makes = {make for make, _ in _TAG_SETS}
        assert makes == {MAKE_SONY, media.MAKE_FUJIFILM, MAKE_INSTA360}

    def test_lookup_matches_old_branching(self):
        sony_photo = _TAG_SETS[(MAKE_SONY, ".arw")]
        for ext in (".jpg", ".jpeg"):
            assert _TAG_SETS[(MAKE_SONY, ext)] is sony_photo
        for ext in (".tif", ".mov", ".raf"):
            assert (MAKE_SONY, ext) not in _TAG_SETS
        assert (media.MAKE_FUJIFILM, ".jpg") not in _TAG_SETS
        assert (MAKE_INSTA360, ".mp4") in _TAG_SETS


class TestRenameInsta360:
    def test_shifts_timestamp_forward(self, tmp_path: Path):
        file = tmp_path / "VID_20240501_120000_00.mp4"
        file.touch()
        _rename_insta360(file, timedelta(hours=1, minutes=30), is_negative=False)
        assert not file.exists()
        assert (tmp_path / "VID_20240501_133000_00.mp4").is_file()

    def test_shifts_timestamp_backward_across_midnight(self, tmp_path: Path):
        file = tmp_path / "VID_20240501_001500_00.mp4"
        file.touch()
        _rename_insta360(file, timedelta(minutes=30), is_negative=True)
        assert (tmp_path / "VID_20240430_234500_00.mp4").is_file()

    def test_non_matching_name_logs_and_keeps_file(self, tmp_path: Path, caplog):
        caplog.set_level(logging.ERROR)
        file = tmp_path / "not-instabuild.mp4"
        file.touch()
        _rename_insta360(file, timedelta(hours=1), is_negative=False)
        assert file.exists()
        assert "does not match Insta360 naming pattern" in caplog.text
