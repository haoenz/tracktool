"""The whole path over real tools: sample media in, geotagged media out.

This is the only place the app runs end to end — ffmpeg writes the samples,
exiftool reads and writes them for real, and the track comes out of a ZIP
archive. Every rule underneath is covered by doubles elsewhere; what is checked
here is that the pieces hold together on the media they actually meet.

Marked `integration`: real exiftool and ffmpeg.
"""

import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from conftest import TRACK_KML, requires_media_tools
from fixtures.media import make_test_jpeg

from tracktool import exiftool, mediatime
from tracktool.exif.position import GeotagOptions, geotag_from_kml
from tracktool.exif.write import SetExifOptions, find_missing_tag, set_exif

pytestmark = requires_media_tools


@dataclass(frozen=True)
class Scene:
    """A media directory plus the archive the geotagger reads its track from."""

    media: Path
    archive: Path


@pytest.fixture
def scene(tmp_path: Path) -> Scene:
    media = tmp_path / "photos"
    media.mkdir()
    archive = tmp_path / "Archive.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("2024-05-01 test.kml", TRACK_KML)
    return Scene(media=media, archive=archive)


def _photo(scene: Scene, name: str, minutes: int) -> Path:
    """A real JPEG taken `minutes` into the track, stamped in local (+08:00) time.

    The track runs 00:00–00:03 UTC; the stamp is written in local time because
    that is how a camera records it, and the reader's default offset is +08:00.
    """
    path = scene.media / name
    make_test_jpeg(path)
    local = datetime(2024, 5, 1, 0, minutes, 0, tzinfo=UTC) + timedelta(hours=8)
    exiftool.invoke(str(path), f"-Exif:DateTimeOriginal={local.strftime('%Y:%m:%d %H:%M:%S')}",
                    "-overwrite_original")
    return path


class TestReportingWhatIsMissing:
    def test_every_untagged_photo_is_reported(self, scene):
        for minutes in (0, 1, 30):
            _photo(scene, f"photo{minutes}.jpg", minutes)

        result = find_missing_tag(scene.media, ["GPSPosition", "GPSAltitude"])

        assert [entry.file.name for entry in result.succeeded] == [
            "photo0.jpg", "photo1.jpg", "photo30.jpg"]
        assert all(entry.missing_tags == ["GPSPosition", "GPSAltitude"]
                   for entry in result.succeeded)
        assert result.ok


class TestGeotaggingFromTheArchive:
    def test_the_position_and_altitude_of_the_track_land_on_the_photo(self, scene):
        inside = [_photo(scene, f"photo{minutes}.jpg", minutes) for minutes in (0, 1)]

        batch = geotag_from_kml(scene.media, str(scene.archive),
                                options=GeotagOptions(overwrite=True,
                                                      failed_folder_name="TrackPosFailed"))

        assert [len(plan) for plan in batch.succeeded] == [1, 1]  # 一张照片一条写入
        assert batch.ok
        assert exiftool.get_media_tag(inside[0], "GPSPosition") == "39 116"
        assert exiftool.get_media_tag(inside[0], "GPSAltitude") == "100"
        assert exiftool.get_media_tag(inside[1], "GPSPosition") == "39.1 116.1"

    def test_a_photo_outside_the_track_goes_to_the_failed_folder(self, scene):
        inside = _photo(scene, "photo0.jpg", 0)
        outside = _photo(scene, "photo30.jpg", 30)  # 27 分钟，远超 60 秒阈值

        batch = geotag_from_kml(scene.media, str(scene.archive),
                                options=GeotagOptions(overwrite=True,
                                                      failed_folder_name="TrackPosFailed"))

        assert [path.name for path in batch.failed] == ["photo30.jpg"]
        assert (scene.media / "TrackPosFailed" / "photo30.jpg").is_file()
        assert not outside.exists()
        assert exiftool.get_media_tag(inside, "GPSPosition")  # 一个失败没中止整批


class TestAfterTheRepair:
    def test_nothing_is_missing_once_the_repair_ran(self, scene):
        for minutes in (0, 1):
            _photo(scene, f"photo{minutes}.jpg", minutes)

        geotag_from_kml(scene.media, str(scene.archive), options=GeotagOptions(overwrite=True))

        assert find_missing_tag(scene.media, ["GPSPosition", "GPSAltitude"]).succeeded == []


class TestTheDirectPaths:
    """The two writes that need no track: reading a time, assigning a coordinate."""

    def test_the_recorded_local_time_reads_back_as_utc(self, scene):
        photo = _photo(scene, "photo0.jpg", 0)

        stamp = mediatime.get_media_time(photo)

        assert stamp is not None
        assert stamp.astimezone(UTC) == datetime(2024, 5, 1, 0, 0, 0, tzinfo=UTC)

    def test_a_position_written_by_hand_reads_back(self, scene):
        photo = _photo(scene, "photo0.jpg", 0)

        set_exif(photo, SetExifOptions(position="31.230416 121.473701", altitude=4.0,
                                       overwrite=True))

        assert exiftool.get_media_tag(photo, "GPSPosition") == "31.230416 121.473701"
        assert exiftool.get_media_tag(photo, "GPSAltitude") == "4"
