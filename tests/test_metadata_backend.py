"""The metadata seam: the rules have to run without an exiftool process.

Every exif module reaches metadata through `ctx.backend`, so installing an
in-memory double is enough to drive the read/decide/write rules directly. The
double is installed *over* fatal exiftool primitives, so a call that still
escapes the seam fails the test instead of quietly shelling out — which is what
makes "this rule needs no subprocess" an assertion rather than a claim.
"""

from datetime import timedelta
from pathlib import Path

import pytest
from conftest import InMemoryBackend

from tracktool import exiftool, googleapi
from tracktool.context import ctx
from tracktool.exif.google import set_altitude_from_google
from tracktool.exif.media import move_altitude
from tracktool.exif.write import SetExifOptions, find_missing_tag, set_exif
from tracktool.metadata import MediaMetadata, MetadataBackend


def _meta(**tags: str) -> MediaMetadata:
    """Metadata as a value: the decisions need no file behind them."""
    return MediaMetadata.of(Path("a.jpg"), tags)


@pytest.fixture
def backend(monkeypatch) -> InMemoryBackend:
    """Install the double, and make any real exiftool call a hard failure."""
    double = InMemoryBackend()

    def escaped(*params: object) -> list[str]:
        raise AssertionError("a real exiftool call escaped the seam")

    monkeypatch.setattr(exiftool, "invoke", escaped)
    monkeypatch.setattr(exiftool, "invoke_persistent", escaped)
    monkeypatch.setattr(ctx, "backend", double)
    return double


@pytest.fixture
def photo(tmp_path: Path) -> Path:
    """A path that exists on disk so file listing works; never actually read."""
    path = tmp_path / "2024-05-01 a.jpg"
    path.write_bytes(b"not really a jpeg")
    return path


class TestTheSeam:
    def test_the_exiftool_adapter_satisfies_the_protocol(self):
        assert isinstance(exiftool.ExiftoolBackend(), MetadataBackend)


class TestFindMissingTag:
    """The zero-altitude rule used to need a real file plus a monkeypatched
    module attribute; it is now a decision over tags the backend hands over."""

    def test_zero_altitude_counts_as_missing(self, backend, photo):
        backend.tags[photo] = {"GPSAltitude": "0"}

        result = find_missing_tag(photo, ["GPSAltitude"])

        assert [r.missing_tags for r in result.succeeded] == [["GPSAltitude"]]

    def test_a_real_altitude_is_not_missing(self, backend, photo):
        backend.tags[photo] = {"GPSAltitude": "-12.5"}

        assert find_missing_tag(photo, ["GPSAltitude"]).succeeded == []

    def test_an_absent_tag_is_missing(self, backend, photo):
        result = find_missing_tag(photo, ["GPSAltitude", "GPSLatitude"])

        assert [r.missing_tags for r in result.succeeded] == [["GPSAltitude", "GPSLatitude"]]

    def test_every_tag_comes_from_one_read(self, backend, photo):
        find_missing_tag(photo, ["GPSAltitude", "GPSLatitude", "GPSLongitude"])

        assert backend.reads == [(photo, ("GPSAltitude", "GPSLatitude", "GPSLongitude"))]


class TestSetExif:
    def test_the_tags_and_the_overwrite_flag_reach_the_backend(self, backend, photo):
        set_exif(photo, SetExifOptions(position="39.9 116.4", altitude=-50, overwrite=True))

        assert backend.writes == [(
            photo,
            {"GPSLatitude": "39.9", "GPSLatitudeRef": "N",
             "GPSLongitude": "116.4", "GPSLongitudeRef": "E",
             "GPSAltitudeRef": "Below Sea Level", "GPSAltitude": "50"},
            True,
        )]


class TestMoveAltitude:
    def test_a_file_without_altitude_is_left_alone(self, backend, photo):
        result = move_altitude(photo, 5)

        assert not result.ok
        assert backend.writes == []

    def test_the_shifted_altitude_is_written(self, backend, photo):
        backend.tags[photo] = {"GPSAltitude": "100"}

        move_altitude(photo, -2.5)

        assert backend.writes == [
            (photo, {"GPSAltitudeRef": "Above Sea Level", "GPSAltitude": "97.5"}, False)]


class TestGoogleAltitude:
    def test_a_file_that_has_altitude_never_reaches_the_api(self, backend, photo, monkeypatch):
        backend.tags[photo] = {"GPSAltitude": "100", "GPSLatitude": "39", "GPSLongitude": "116"}

        def unexpected(*args: object, **kwargs: object) -> list[float | None]:
            raise AssertionError("the elevation API was called for a file that has an altitude")

        monkeypatch.setattr(googleapi, "get_altitudes", unexpected)

        result = set_altitude_from_google(photo, overwrite=True)

        assert result.ok
        assert backend.writes == []


class TestExiftoolArgv:
    """exiftool's spelling of a shift stays inside the backend."""

    def test_a_shift_renders_as_days_and_a_clock(self):
        assert exiftool._shift_amount(timedelta(hours=1, minutes=30)) == "0:0:0 1:30:0"
        assert exiftool._shift_amount(timedelta(days=3, minutes=1, seconds=1)) == "0:0:3 0:1:1"
        assert exiftool._shift_amount(timedelta(0)) == "0:0:0 0:0:0"

    def test_a_negative_shift_becomes_the_minus_operator(self, monkeypatch, tmp_path):
        calls: list[tuple[str, ...]] = []
        monkeypatch.setattr(exiftool, "invoke", lambda *params: calls.append(params) or [])

        exiftool.ExiftoolBackend().shift_tags(
            tmp_path / "x.jpg", ["DateTimeOriginal"], timedelta(hours=-2), overwrite=True)

        assert calls == [(str(tmp_path / "x.jpg"),
                          "-DateTimeOriginal-=0:0:0 2:0:0",
                          "-overwrite_original")]

    def test_a_write_spells_an_assignment(self, monkeypatch, tmp_path):
        calls: list[tuple[str, ...]] = []
        monkeypatch.setattr(exiftool, "invoke", lambda *params: calls.append(params) or [])

        exiftool.ExiftoolBackend().write_tags(tmp_path / "x.jpg", {"IPTC:City": "Beijing"})

        assert calls == [(str(tmp_path / "x.jpg"), "-IPTC:City=Beijing")]
