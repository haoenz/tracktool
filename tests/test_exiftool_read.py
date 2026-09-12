"""Tests for the structured tag read path.

`read_tags` sends one `-j -G1 -n` call per file and maps exiftool's family-1
JSON keys back to the requested tag names, so a file is read once however many
tags are asked for, and a tag the file lacks is an absent key rather than a
neighbouring line of output. `-n` is what makes derived GPS tags arrive as
signed decimals instead of display text.
"""

import json
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest
from conftest import TRACK_KML

from tracktool import exiftool
from tracktool.config import Config
from tracktool.exif.position import SetPositionOptions, set_position_from_kml
from tracktool.exif.write import find_missing_tag

requires_exiftool = pytest.mark.skipif(shutil.which("exiftool") is None, reason="requires exiftool")


def _serve(monkeypatch, record: dict) -> list[tuple[str, ...]]:
    """Answer every persistent call with `record` and count the calls made."""
    calls: list[tuple[str, ...]] = []

    def fake(*params: str) -> list[str]:
        calls.append(params)
        return json.dumps([record]).splitlines()

    monkeypatch.setattr(exiftool, "invoke_persistent", fake)
    return calls


def _make_jpeg(path: Path) -> None:
    ret = subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", str(path)],
        capture_output=True)
    assert ret.returncode == 0, ret.stderr.decode(errors="replace")


class TestReadTags:
    def test_one_call_returns_every_requested_tag(self, monkeypatch, tmp_path):
        calls = _serve(monkeypatch, {
            "SourceFile": "p.jpg",
            "ExifIFD:DateTimeOriginal": "2024:05:01 08:00:00",
            "GPS:GPSAltitude": 100,
            "Composite:GPSAltitude": 100,
            "IFD0:Make": "SONY",
        })

        tags = exiftool.read_tags(tmp_path / "p.jpg",
                                  ["ExifIFD:DateTimeOriginal", "GPSAltitude", "Make", "Make"])

        assert len(calls) == 1
        assert "-n" in calls[0]
        assert tags == {
            "ExifIFD:DateTimeOriginal": "2024:05:01 08:00:00",
            "GPSAltitude": "100",
            "Make": "SONY",
        }

    def test_absent_tag_is_absent(self, monkeypatch, tmp_path):
        _serve(monkeypatch, {"SourceFile": "p.jpg", "IFD0:Make": "SONY"})

        assert exiftool.read_tags(tmp_path / "p.jpg", ["GPSAltitude", "Make"]) == {"Make": "SONY"}

    def test_derived_tags_take_the_composite_group(self, monkeypatch, tmp_path):
        # exiftool 对 GPS 派生标签同时给出 GPS: 与 Composite: 两份；-n 之下 GPS: 是无符号
        # 量值，只有 Composite 带 GPSAltitudeRef 符号，所以必须落 Composite
        _serve(monkeypatch, {
            "SourceFile": "p.jpg",
            "GPS:GPSAltitude": 50,
            "Composite:GPSAltitude": -50,
            "Composite:GPSLatitude": -12.3456789012222,
            "Composite:GPSLongitude": 116.987654321097,
        })

        tags = exiftool.read_tags(tmp_path / "p.jpg", ["GPSLatitude", "GPSLongitude", "GPSAltitude"])

        assert tags["GPSAltitude"] == "-50"
        assert tags["GPSLatitude"] == "-12.3456789012222"

    def test_family_zero_group_resolves_to_family_one(self, monkeypatch, tmp_path):
        # "-Exif:DateTimeOriginal" 用的族 0 名在 -G1 输出里落在 ExifIFD
        _serve(monkeypatch, {
            "SourceFile": "p.jpg",
            "ExifIFD:DateTimeOriginal": "2024:05:01 08:00:00",
            "XMP-exif:DateTimeOriginal": "2024:05:01 08:00:00+08:00",
        })

        assert exiftool.read_tags(tmp_path / "p.jpg", ["Exif:DateTimeOriginal"]) == {
            "Exif:DateTimeOriginal": "2024:05:01 08:00:00"}

    def test_ambiguous_name_is_reported_not_guessed(self, monkeypatch, tmp_path, caplog):
        _serve(monkeypatch, {
            "SourceFile": "p.jpg",
            "ExifIFD:DateTimeOriginal": "2024:05:01 08:00:00",
            "XMP-exif:DateTimeOriginal": "2024:05:01 08:00:00+08:00",
        })

        assert exiftool.read_tags(tmp_path / "p.jpg", ["DateTimeOriginal"]) == {}
        assert "Ambiguous tag" in caplog.text

    def test_malformed_output_is_a_tool_failure(self, monkeypatch, tmp_path):
        monkeypatch.setattr(exiftool, "invoke_persistent",
                            lambda *params: ["perl: warning: Setting locale failed."])

        with pytest.raises(exiftool.ExiftoolError, match="Unreadable exiftool JSON output"):
            exiftool.read_tags(tmp_path / "p.jpg", ["Make"])

    def test_error_key_in_json_is_a_tool_failure(self, monkeypatch, tmp_path):
        _serve(monkeypatch, {"SourceFile": "bad.jpg", "Error": "File format error"})

        with pytest.raises(exiftool.ExiftoolError, match="File format error"):
            exiftool.read_tags(tmp_path / "bad.jpg", ["Make"])


class TestBatchedCallers:
    def test_find_missing_reads_all_requested_tags_at_once(self, monkeypatch, tmp_path):
        photo = tmp_path / "p.jpg"
        photo.touch()  # list_files 只看路径形态，内容由桩读取提供
        calls = _serve(monkeypatch, {
            "SourceFile": "p.jpg",
            "Composite:GPSPosition": "39.1 116.2",
        })

        batch = find_missing_tag(photo, ["GPSPosition", "GPSAltitude"])

        assert len(calls) == 1
        assert [(r.file.name, r.missing_tags) for r in batch.succeeded] == [("p.jpg", ["GPSAltitude"])]
        assert batch.ok


@requires_exiftool
class TestReadTagsAgainstExiftool:
    def test_tags_read_cleanly_while_stderr_has_noise(self, tmp_path):
        """The first persistent call is where perl writes its locale warning;
        that warning used to be returned as the tag value."""
        photo = tmp_path / "p.jpg"
        _make_jpeg(photo)

        tags = exiftool.read_tags(photo, ["GPSPosition", "GPSAltitude", "Make"])

        assert "GPSPosition" not in tags
        assert "GPSAltitude" not in tags
        assert not any("perl" in value for value in tags.values())

    def test_later_reads_are_not_polluted_by_the_startup_warning(self, tmp_path):
        photo = tmp_path / "p.jpg"
        _make_jpeg(photo)
        exiftool.invoke(str(photo), "-GPSAltitude=7", "-GPSAltitudeRef=Above Sea Level",
                        "-overwrite_original")

        assert exiftool.read_tags(photo, ["GPSAltitude"]) == {"GPSAltitude": "7"}
        assert exiftool.read_tags(photo, ["GPSAltitude"]) == {"GPSAltitude": "7"}

    def test_below_sea_level_reads_as_a_negative_number(self, tmp_path):
        photo = tmp_path / "p.jpg"
        _make_jpeg(photo)
        exiftool.invoke(str(photo), "-GPSAltitude=50", "-GPSAltitudeRef=Below Sea Level",
                        "-overwrite_original")

        assert exiftool.read_tags(photo, ["GPSAltitude"]) == {"GPSAltitude": "-50"}

    def test_unreadable_file_raises_instead_of_reading_as_empty(self, tmp_path):
        bad = tmp_path / "bad.jpg"
        bad.write_bytes(b"\x00")

        with pytest.raises(exiftool.ExiftoolError, match="File format error"):
            exiftool.read_tags(bad, ["GPSPosition"])


@requires_exiftool
class TestPositionReadsEachFileOnce:
    def test_set_position_from_kml_uses_one_round_trip_per_file(self, tmp_path, monkeypatch):
        media_dir = tmp_path / "media"
        media_dir.mkdir()
        photo = media_dir / "2024-05-01 a.jpg"
        _make_jpeg(photo)
        # 拍摄时间在轨迹 [00:00, 00:03] UTC 内
        exiftool.invoke(str(photo),
                        "-ExifIFD:DateTimeOriginal=2024:05:01 08:01:30",
                        "-ExifIFD:OffsetTimeOriginal=+08:00",
                        "-overwrite_original")
        zip_path = tmp_path / "Archive.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("2024-05-01 test.kml", TRACK_KML)
        cfg = Config(path=tmp_path / "config.json").load()
        cfg["kml_zip_path"] = str(zip_path)

        reads: list[tuple[str, ...]] = []
        original = exiftool.invoke_persistent

        def counting(*params: str) -> list[str]:
            reads.append(params)
            return original(*params)

        # 计数范围只覆盖批量本身：标签写入走一次性进程，不经过持久进程
        monkeypatch.setattr(exiftool, "invoke_persistent", counting)
        set_position_from_kml(media_dir, options=SetPositionOptions(
            overwrite=True, failed_folder_name="Failed"), cfg=cfg)

        assert len(reads) == 1, reads
        assert "39" in exiftool.get_media_tag(photo, "GPSPosition")
