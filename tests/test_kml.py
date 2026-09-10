"""Tests for KML editing: split, bad-point removal, archive push/pop."""

import zipfile
from pathlib import Path

import pytest

from tracktool.kml import archive, edit, kmlfile, xmlutil

TRACK_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
<name>2024-05-01 test</name>
<Folder>
<Placemark>
<name>track</name>
<gx:Track>
<when>2024-05-01T00:00:00Z</when>
<when>2024-05-01T00:01:00Z</when>
<when>2024-05-01T00:02:00Z</when>
<when>2024-05-01T00:03:00Z</when>
<gx:coord>116.0 39.0 100</gx:coord>
<gx:coord>116.1 39.1 110</gx:coord>
<gx:coord>116.2 39.2 120</gx:coord>
<gx:coord>116.3 39.3 130</gx:coord>
</gx:Track>
</Placemark>
</Folder>
</Document>
</kml>"""


@pytest.fixture
def track_file(tmp_path: Path) -> Path:
    path = tmp_path / "2024-05-01 test.kml"
    path.write_text(TRACK_KML, encoding="utf-8")
    return path


class TestSplitKml:
    def test_split_two(self, track_file: Path):
        edit.split_kml(track_file, ["2024-05-01T00:01:00Z"])
        part1 = track_file.parent / "2024-05-01 test-Splited-1.kml"
        part2 = track_file.parent / "2024-05-01 test-Splited-2.kml"
        assert part1.is_file() and part2.is_file()

        tree1 = xmlutil.parse_file(part1)
        coords1 = xmlutil.findall(tree1, "//gx:coord")
        assert len(coords1) == 2  # points 0-1
        tree2 = xmlutil.parse_file(part2)
        coords2 = xmlutil.findall(tree2, "//gx:coord")
        assert len(coords2) == 2  # points 2-3

    def test_split_by_coordinate(self, track_file: Path):
        edit.split_kml(track_file, ["116.1 39.1 110"])
        assert (track_file.parent / "2024-05-01 test-Splited-1.kml").is_file()


class TestRemoveBadPoints:
    def test_remove_single(self, track_file: Path):
        edit.remove_bad_points(track_file, ["116.1 39.1 110"])
        fixed = track_file.parent / "2024-05-01 test-Fixed.kml"
        assert fixed.is_file()
        tree = xmlutil.parse_file(fixed)
        assert len(xmlutil.findall(tree, "//gx:coord")) == 3
        assert len(xmlutil.findall(tree, "//kml:when")) == 3

    def test_remove_range(self, track_file: Path):
        edit.remove_bad_points(track_file, ["116.0 39.0 100", "116.1 39.1 110"])
        fixed = track_file.parent / "2024-05-01 test-Fixed.kml"
        tree = xmlutil.parse_file(fixed)
        assert len(xmlutil.findall(tree, "//gx:coord")) == 2

    def test_too_many_points_raises(self, track_file: Path):
        with pytest.raises(ValueError):
            edit.remove_bad_points(track_file, ["a", "b", "c"])


class TestMergeKml:
    def test_merge_multigeometry(self, track_file: Path, tmp_path: Path):
        output = tmp_path / "merged.kml"
        edit.merge_kml([track_file, track_file], output, connected=False, no_archive=True)
        tree = xmlutil.parse_file(output)
        assert len(xmlutil.findall(tree, "//kml:LineString")) == 2

    def test_merge_connected(self, track_file: Path, tmp_path: Path):
        output = tmp_path / "merged.kml"
        edit.merge_kml([track_file, track_file], output, connected=True, no_archive=True)
        tree = xmlutil.parse_file(output)
        lss = xmlutil.findall(tree, "//kml:LineString")
        assert len(lss) == 1
        coords_node = xmlutil.find(tree, "//kml:LineString/kml:coordinates")
        tuples = (coords_node.text or "").split()
        assert len(tuples) == 8  # 4 + 4 coords


class TestKmlContent:
    def test_track_to_linestring(self, track_file: Path):
        content = kmlfile.get_kml_content(track_file)
        tuples = content.line_string.split()
        assert len(tuples) == 4
        assert tuples[0] == "116.0,39.0,100"


class TestArchive:
    def _setup_archive(self, tmp_path: Path, monkeypatch) -> Path:
        archive_dir = tmp_path / "archive"
        archive_dir.mkdir()
        zip_path = archive_dir / "Archive.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("placeholder.txt", "x")
        return zip_path

    def test_push_pop_roundtrip(self, track_file: Path, tmp_path: Path):
        zip_path = self._setup_archive(tmp_path, None)

        # push: 需要类型信息（源文件无 TrackTags）
        archive.push_kml_archive(track_file, str(zip_path), type_="Default")

        # ZIP 中存在
        with zipfile.ZipFile(zip_path) as zf:
            assert track_file.name in zf.namelist()

        # 原件移入 Backup
        assert (zip_path.parent / "Backup" / track_file.name).is_file()
        assert not track_file.exists()

        # 汇总文件已创建并包含轨迹
        desktop = zip_path.parent / "Default.kml"
        mobile = zip_path.parent / "Default.Mobile.kml"
        assert desktop.is_file() and mobile.is_file()
        desktop_tree = xmlutil.parse_file(desktop)
        assert len(xmlutil.findall(desktop_tree, "//kml:Placemark")) == 1
        mobile_tree = xmlutil.parse_file(mobile)
        assert len(xmlutil.findall(mobile_tree, "//kml:LineString")) == 1

        # pop: 取回并从汇总移除
        archive.pop_kml_archive(track_file.stem, "Default", str(zip_path))
        with zipfile.ZipFile(zip_path) as zf:
            assert track_file.name not in zf.namelist()
        # Pop extracts to the current working directory (原版默认输出到 '.')
        restored = Path.cwd() / track_file.name
        try:
            assert restored.is_file()
        finally:
            restored.unlink(missing_ok=True)
        desktop_tree = xmlutil.parse_file(desktop)
        assert len(xmlutil.findall(desktop_tree, "//kml:Placemark")) == 0
