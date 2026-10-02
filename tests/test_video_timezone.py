"""Video timezone decisions, unchanged pending files, and real MP4 round trips."""

import logging
import subprocess
from datetime import UTC, datetime

import pytest
from conftest import InMemoryBackend, requires_media_tools
from typer.testing import CliRunner

from tracktool import actions, exiftool, mediatime, workflows
from tracktool.actions import Failed, RemuxVideo, WriteTags
from tracktool.cli import app
from tracktool.config import Config
from tracktool.context import ctx
from tracktool.errors import UserInputError
from tracktool.exif.media import convert_to_mp4, decide_convert
from tracktool.fileutil import BatchResult, FileFailure
from tracktool.mediatime import TimezonePolicy
from tracktool.metadata import MediaMetadata
from tracktool.tags import (
    CAPTURE_TIME,
    H264_CAPTURE_TIME,
    KEYS_CAPTURE_TIME,
    OFFSET_TIME_ORIGINAL,
    QUICKTIME_CREATE_DATE,
    TRACK_CREATE_DATE,
    USERDATA_CAPTURE_TIME,
    VIDEO_TIME_TAGS,
    XMP_CAPTURE_TIME,
    XMP_CREATE_DATE,
)


def plan(tmp_path, tags, policy=TimezonePolicy.AUTO, offset="+08:00", source=None):
    return decide_convert(MediaMetadata.of(tmp_path / "clip.mp4", tags), tmp_path, offset, None, None, policy, source)


@pytest.mark.parametrize("tag", mediatime.VIDEO_TIME_SOURCES)
def test_missing_timezone_preserves_wall_clock_and_normalizes_utc(tmp_path, tag):
    result = plan(tmp_path, {tag: "2024:05:01 01:30:00"}, offset="+09:00")
    assert isinstance(result[0], RemuxVideo)
    assert result[0].create_time_utc == "2024-04-30T16:30:00Z"
    assert isinstance(result[1], WriteTags)
    assert result[1].tags[XMP_CAPTURE_TIME] == "2024:05:01 01:30:00+09:00"
    assert result[1].tags[QUICKTIME_CREATE_DATE] == "2024:04:30 16:30:00"


@pytest.mark.parametrize("zone", ["Z", "+00:00", "-00:00", "+08:00", "-05:30"])
@pytest.mark.parametrize(
    "tag", [XMP_CAPTURE_TIME, XMP_CREATE_DATE, KEYS_CAPTURE_TIME, USERDATA_CAPTURE_TIME, H264_CAPTURE_TIME]
)
def test_any_explicit_timezone_requires_a_decision(tmp_path, tag, zone):
    result = plan(tmp_path, {tag: "2024:05:01 12:00:00" + zone}, offset="+09:00")
    assert len(result) == 1 and isinstance(result[0], Failed)
    assert not result[0].quarantine
    assert "--timezone-policy keep" in result[0].reason
    assert "--timezone-policy force" in result[0].reason


def test_separate_offset_is_also_stored_timezone(tmp_path):
    tags = {CAPTURE_TIME: "2024:05:01 12:00:00", OFFSET_TIME_ORIGINAL: "+00:00"}
    assert isinstance(plan(tmp_path, tags)[0], Failed)
    result = plan(tmp_path, tags, TimezonePolicy.FORCE)
    assert result[1].tags[OFFSET_TIME_ORIGINAL] == "+08:00"


@pytest.mark.parametrize(
    ("zone", "expected_utc"),
    [("Z", "2024:05:01 01:30:00"), ("+09:00", "2024:04:30 16:30:00"), ("-05:30", "2024:05:01 07:00:00")],
)
def test_keep_preserves_the_instant_and_ignores_fallback_offset(tmp_path, zone, expected_utc):
    result = plan(tmp_path, {XMP_CAPTURE_TIME: "2024:05:01 01:30:00" + zone}, TimezonePolicy.KEEP)
    assert result[1].tags[QUICKTIME_CREATE_DATE] == expected_utc
    assert result[1].tags[XMP_CAPTURE_TIME].startswith("2024:05:01 01:30:00")


def test_force_reinterprets_wall_clock_and_is_repeatable(tmp_path):
    tags = {XMP_CAPTURE_TIME: "2024:05:01 01:30:00+00:00", QUICKTIME_CREATE_DATE: "2024:05:01 01:30:00"}
    first = plan(tmp_path, tags, TimezonePolicy.FORCE)[1].tags
    assert first[XMP_CAPTURE_TIME] == "2024:05:01 01:30:00+08:00"
    assert first[QUICKTIME_CREATE_DATE] == "2024:04:30 17:30:00"
    second = plan(tmp_path, {**tags, **first}, TimezonePolicy.FORCE)[1].tags
    assert second == first
    assert plan(tmp_path, {**tags, **first}, TimezonePolicy.KEEP)[1].tags == first
    assert isinstance(plan(tmp_path, {**tags, **first})[0], Failed)


def test_explicit_string_takes_precedence_over_unzoned_header(tmp_path):
    tags = {QUICKTIME_CREATE_DATE: "2024:05:01 04:00:00", KEYS_CAPTURE_TIME: "2024:05:01 12:00:00+08:00"}
    selected = mediatime.resolve_video_time(tags, policy=TimezonePolicy.KEEP)
    assert selected.source.tag == KEYS_CAPTURE_TIME
    assert selected.source.stored_offset == "+08:00"
    assert selected.value.astimezone(UTC) == datetime(2024, 5, 1, 4, tzinfo=UTC)


def test_header_without_zone_does_not_become_explicit_utc():
    selected = mediatime.resolve_video_time({QUICKTIME_CREATE_DATE: "2024:05:01 12:00:00"})
    assert selected.source.stored_offset is None
    assert selected.value.isoformat() == "2024-05-01T12:00:00+08:00"


def test_unset_header_does_not_hide_valid_capture_time(tmp_path):
    tags = {QUICKTIME_CREATE_DATE: "0000:00:00 00:00:00", XMP_CAPTURE_TIME: "2024:05:01 12:00:00+08:00"}
    assert isinstance(plan(tmp_path, tags)[0], Failed)
    assert isinstance(plan(tmp_path, tags, TimezonePolicy.KEEP)[0], RemuxVideo)
    assert isinstance(plan(tmp_path, {QUICKTIME_CREATE_DATE: "0000:00:00 00:00:00"})[0], Failed)


def test_conflicting_times_need_an_explicit_source(tmp_path):
    tags = {XMP_CAPTURE_TIME: "2024:05:01 12:00:00+08:00", KEYS_CAPTURE_TIME: "2024:05:01 16:00:00+08:00"}
    result = plan(tmp_path, tags, TimezonePolicy.KEEP)
    assert isinstance(result[0], Failed) and "--time-source" in result[0].reason
    result = plan(tmp_path, tags, TimezonePolicy.KEEP, source=KEYS_CAPTURE_TIME)
    assert result[1].tags[XMP_CAPTURE_TIME] == "2024:05:01 16:00:00+08:00"
    assert result[1].tags[KEYS_CAPTURE_TIME] == "2024:05:01 16:00:00+08:00"


def test_equivalent_instants_with_different_offsets_are_not_conflicts(tmp_path):
    tags = {XMP_CAPTURE_TIME: "2024:05:01 12:00:00+08:00", KEYS_CAPTURE_TIME: "2024:05:01 04:00:00Z"}
    assert isinstance(plan(tmp_path, tags, TimezonePolicy.KEEP)[0], RemuxVideo)


def test_conflicting_unzoned_clocks_and_missing_source_are_reported(tmp_path):
    tags = {QUICKTIME_CREATE_DATE: "2024:05:01 12:00:00", TRACK_CREATE_DATE: "2024:05:01 13:00:00"}
    assert isinstance(plan(tmp_path, tags)[0], Failed)
    assert isinstance(plan(tmp_path, tags, source=XMP_CAPTURE_TIME)[0], Failed)


def test_subseconds_survive_conversion_and_later_geotag_reads(tmp_path):
    tags = {XMP_CAPTURE_TIME: "2024:05:01 00:00:00.125+08:00", QUICKTIME_CREATE_DATE: "2024:04:30 16:00:00"}
    written = plan(tmp_path, tags, TimezonePolicy.KEEP)[1].tags
    assert written[XMP_CAPTURE_TIME] == "2024:05:01 00:00:00.125000+08:00"
    stamp = mediatime.parse_media_time(written)
    assert stamp.astimezone(UTC) == datetime(2024, 4, 30, 16, 0, 0, 125000, tzinfo=UTC)


def test_corrected_xmp_supersedes_readonly_camera_timestamp_for_geotagging():
    stamp = mediatime.parse_media_time(
        {XMP_CAPTURE_TIME: "2024:05:01 12:00:00+08:00", H264_CAPTURE_TIME: "2024:05:01 12:00:00Z"}
    )
    assert stamp.astimezone(UTC) == datetime(2024, 5, 1, 4, tzinfo=UTC)


@pytest.fixture
def backend(tmp_path, monkeypatch):
    double = InMemoryBackend()
    monkeypatch.setattr(ctx, "backend", double)
    monkeypatch.setattr(ctx, "config", Config(tmp_path / "config.json"))
    monkeypatch.setattr(ctx, "reporter", lambda activity: None)
    return double


@pytest.mark.parametrize("dry_run", [False, True])
def test_cli_pending_file_is_untouched_and_other_files_continue(tmp_path, backend, dry_run, caplog):
    caplog.set_level(logging.WARNING)
    pending, good = tmp_path / "a.mp4", tmp_path / "b.mp4"
    for path in (pending, good):
        path.write_bytes(b"video")
    backend.tags[pending] = {XMP_CAPTURE_TIME: "2024:05:01 12:00:00Z"}
    backend.tags[good] = {QUICKTIME_CREATE_DATE: "2024:05:01 12:00:00"}
    args = ["--dry-run"] if dry_run else []
    result = CliRunner().invoke(app, [*args, "exif", "to-mp4", str(tmp_path)])
    assert result.exit_code == 3, result.output
    assert "Timezone decision required" in caplog.text
    assert pending.read_bytes() == b"video"
    assert not pending.with_name(pending.name + "_original").exists()
    assert all(path == good for path, _, _ in backend.writes)
    assert bool(backend.writes) is not dry_run
    if dry_run:
        assert sorted(p.name for p in tmp_path.iterdir()) == ["a.mp4", "b.mp4"]


@pytest.mark.parametrize("policy", ["keep", "force"])
def test_cli_explicit_policy_is_applied(tmp_path, backend, policy):
    path = tmp_path / "a.mp4"
    path.write_bytes(b"video")
    backend.tags[path] = {XMP_CAPTURE_TIME: "2024:05:01 12:00:00Z", QUICKTIME_CREATE_DATE: "2024:05:01 12:00:00"}
    result = CliRunner().invoke(
        app, ["exif", "to-mp4", str(path), "--timezone-policy", policy, "--offset-time", "+09:00"]
    )
    assert result.exit_code == 0, result.output
    assert backend.tags[path][XMP_CAPTURE_TIME] == "2024:05:01 12:00:00" + ("+09:00" if policy == "force" else "+00:00")


@pytest.mark.parametrize("offset", ["+24:00", "+08:60", "bad"])
def test_invalid_offset_is_rejected_before_reading_or_writing(tmp_path, backend, offset):
    with pytest.raises(UserInputError):
        convert_to_mp4(tmp_path, offset_time=offset)
    assert not backend.reads and not backend.writes


def test_repair_vid_waits_before_renaming_directory(tmp_path, backend):
    directory = tmp_path / "VID"
    directory.mkdir()
    path = directory / "a.mp4"
    path.write_bytes(b"video")
    backend.tags[path] = {KEYS_CAPTURE_TIME: "2024:05:01 12:00:00+08:00"}
    result = workflows.resolve_vid_exif(tmp_path)
    assert result.failed == [path]
    assert path.read_bytes() == b"video"
    assert list(tmp_path.iterdir()) == [directory]
    assert not backend.writes


def test_repair_vid_passes_policy_and_source_to_both_conversion_phases(tmp_path, monkeypatch):
    (tmp_path / "VID").mkdir()
    calls = []
    monkeypatch.setattr(workflows, "convert_to_mp4", lambda *args, **kwargs: calls.append(kwargs) or BatchResult())
    monkeypatch.setattr(workflows, "resolve_missing_gps", lambda *args, **kwargs: BatchResult())
    workflows.resolve_vid_exif(
        tmp_path, timezone_policy=TimezonePolicy.FORCE, offset_time="+09:00", time_source=KEYS_CAPTURE_TIME
    )
    assert len(calls) == 2
    assert calls[0]["check_only"]
    assert all(c["timezone_policy"] == TimezonePolicy.FORCE for c in calls)
    assert all(c["offset_time"] == "+09:00" and c["time_source"] == KEYS_CAPTURE_TIME for c in calls)


def test_failed_remux_keeps_source_and_existing_backup(tmp_path, monkeypatch):
    source = tmp_path / "a.mp4"
    source.write_bytes(b"source")
    backup = tmp_path / "a.mp4_original"
    backup.write_bytes(b"first original")

    def fail(*args):
        raise FileFailure("ffmpeg failure")

    monkeypatch.setattr(actions, "_ffmpeg", fail)
    with pytest.raises(FileFailure):
        actions.apply(RemuxVideo(source, source, "2024-05-01T00:00:00Z", True, False))
    assert source.read_bytes() == b"source" and backup.read_bytes() == b"first original"
    assert sorted(p.name for p in tmp_path.iterdir()) == [source.name, backup.name]


class TestRealVideoTimezone:
    pytestmark = requires_media_tools

    @staticmethod
    def sample(path):
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=64x64",
                "-t",
                "0.1",
                "-metadata",
                "creation_time=2024-05-01T01:30:00Z",
                str(path),
            ],
            check=True,
            capture_output=True,
        )

    @pytest.mark.parametrize("extension", ["mp4", "mov"])
    @pytest.mark.parametrize("process_tz", ["UTC", "America/New_York"])
    def test_real_conversion_roundtrip_is_stable_and_independent_of_system_timezone(
        self, tmp_path, monkeypatch, extension, process_tz
    ):
        monkeypatch.setenv("TZ", process_tz)
        source = tmp_path / f"clip.{extension}"
        self.sample(source)
        output = tmp_path / "clip.mp4"
        original = source.read_bytes()
        try:
            assert convert_to_mp4(source).ok
            tags = exiftool.read_tags(output, VIDEO_TIME_TAGS)
            assert tags[XMP_CAPTURE_TIME] == "2024:05:01 01:30:00+08:00"
            assert tags[QUICKTIME_CREATE_DATE] == tags[TRACK_CREATE_DATE] == "2024:04:30 17:30:00"
            before = output.read_bytes()
            assert convert_to_mp4(output).failed == [output]
            assert output.read_bytes() == before
            assert convert_to_mp4(output, timezone_policy=TimezonePolicy.KEEP).ok
            assert exiftool.read_tags(output, VIDEO_TIME_TAGS) == tags
            for _ in range(2):
                assert convert_to_mp4(output, timezone_policy=TimezonePolicy.FORCE, offset_time="+09:00").ok
                tags = exiftool.read_tags(output, VIDEO_TIME_TAGS)
                assert tags[XMP_CAPTURE_TIME] == "2024:05:01 01:30:00+09:00"
                assert tags[QUICKTIME_CREATE_DATE] == tags[TRACK_CREATE_DATE] == "2024:04:30 16:30:00"
            if extension == "mp4":
                assert source.with_name(source.name + "_original").read_bytes() == original
            else:
                assert source.read_bytes() == original
        finally:
            exiftool.close_thread_process()

    @pytest.mark.parametrize("tag", [XMP_CAPTURE_TIME, XMP_CREATE_DATE, KEYS_CAPTURE_TIME, USERDATA_CAPTURE_TIME])
    def test_explicit_zero_offset_is_detected_and_force_updates_the_stored_field(self, tmp_path, tag):
        source = tmp_path / "clip.mp4"
        self.sample(source)
        exiftool.invoke(str(source), f"-{tag}=2024:05:01 01:30:00+00:00", "-overwrite_original")
        try:
            assert tag in exiftool.read_tags(source, VIDEO_TIME_TAGS)
            original = source.read_bytes()
            assert convert_to_mp4(source).failed == [source]
            assert source.read_bytes() == original
            assert convert_to_mp4(source, timezone_policy=TimezonePolicy.FORCE).ok
            tags = exiftool.read_tags(source, VIDEO_TIME_TAGS)
            assert tags[tag] == "2024:05:01 01:30:00+08:00"
            assert mediatime.parse_media_time(tags).astimezone(UTC) == datetime(2024, 4, 30, 17, 30, tzinfo=UTC)
            assert convert_to_mp4(source, timezone_policy=TimezonePolicy.KEEP).ok
        finally:
            exiftool.close_thread_process()

    def test_capture_time_with_unset_container_dates(self, tmp_path):
        source = tmp_path / "clip.mp4"
        self.sample(source)
        exiftool.invoke(
            str(source),
            "-QuickTime:CreateDate=",
            "-QuickTime:TrackCreateDate=",
            "-QuickTime:MediaCreateDate=",
            "-XMP-exif:DateTimeOriginal=2024:05:01 01:30:00+08:00",
            "-overwrite_original",
        )
        try:
            assert convert_to_mp4(source, timezone_policy=TimezonePolicy.KEEP).ok
            tags = exiftool.read_tags(source, VIDEO_TIME_TAGS)
            assert tags[QUICKTIME_CREATE_DATE] == tags[TRACK_CREATE_DATE] == "2024:04:30 17:30:00"
        finally:
            exiftool.close_thread_process()
