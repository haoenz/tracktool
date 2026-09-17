"""End-to-end regression for issue #4 with real exiftool: a file whose
GPSAltitude is 0 below sea level must be reported missing by find_missing_tag,
matching what fill_altitude_from_google repairs. Before the shared
is_missing_altitude predicate the two rules diverged: show-missing only knew
the above-sea-level wording, so below-sea-level files looked healthy but were
still "repaired" by fill-altitude."""

import shutil
import subprocess
from pathlib import Path

import pytest

from tracktool import exiftool
from tracktool.exif.write import find_missing_tag

pytestmark = pytest.mark.skipif(shutil.which("exiftool") is None, reason="requires exiftool")


def _make_jpeg(path: Path) -> None:
    ret = subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", str(path)],
        capture_output=True)
    assert ret.returncode == 0, ret.stderr.decode(errors="replace")


class TestFindMissingAltitudeEndToEnd:
    def test_below_sea_level_zero_counts_as_missing(self, tmp_path: Path):
        photo = tmp_path / "photo.jpg"
        _make_jpeg(photo)
        exiftool.invoke(str(photo), "-GPSAltitude=0", "-GPSAltitudeRef=Below Sea Level",
                        "-overwrite_original")

        assert exiftool.get_media_tag(photo, "GPSAltitude") == "0"

        result = find_missing_tag(photo, ["GPSAltitude"])
        assert [(r.file, r.missing_tags) for r in result.succeeded] == [(photo, ["GPSAltitude"])]
        assert result.ok

    def test_real_altitude_not_reported(self, tmp_path: Path):
        photo = tmp_path / "photo.jpg"
        _make_jpeg(photo)
        exiftool.invoke(str(photo), "-GPSAltitude=12.5", "-GPSAltitudeRef=Below Sea Level",
                        "-overwrite_original")

        result = find_missing_tag(photo, ["GPSAltitude"])
        assert result.succeeded == []
        assert result.ok
