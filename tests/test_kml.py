"""Tests for KML editing: split, bad-point removal, archive push/pop."""

import zipfile
from pathlib import Path

import pytest
from conftest import TRACK_KML
from typer.testing import CliRunner

from tracktool import workflows
from tracktool.cli import app
from tracktool.config import Config
from tracktool.context import ctx
from tracktool.errors import UserInputError
from tracktool.kml import archive, edit, kmlfile, xmlutil
from tracktool.kml.kmlfile import TrackType

runner = CliRunner()


def _drop_zip_entry(zip_path: Path, entry_name: str) -> None:
    """重写压缩包并去掉某条 entry，造出「ZIP 与聚合不一致」的归档。"""
    with zipfile.ZipFile(zip_path) as zf:
        remaining = {info.filename: zf.read(info.filename)
                     for info in zf.infolist() if info.filename != entry_name}
    with zipfile.ZipFile(zip_path, "w") as zf:
        for name, blob in remaining.items():
            zf.writestr(name, blob)


def _push(*tracks: Path, zip_path: Path, type_: TrackType | None = TrackType.DEFAULT,
          no_archive: bool = False) -> list[Path]:
    """File tracks the way `kml push` does; returns the ones it could not file."""
    return workflows.push_tracks(list(tracks), str(zip_path), type_, no_archive).failed


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


LINESTRING_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<Placemark><LineString><coordinates>116.0,39.0 116.1,39.1</coordinates></LineString></Placemark>
<Placemark><LineString><coordinates>117.0,40.0 bad 117.1,40.1</coordinates></LineString></Placemark>
<Placemark><LineString><coordinates> </coordinates></LineString></Placemark>
</Document>
</kml>"""


class TestAltitudeFromGoogle:
    @pytest.fixture
    def linestring_file(self, tmp_path: Path) -> Path:
        path = tmp_path / "tracks.kml"
        path.write_text(LINESTRING_KML, encoding="utf-8")
        return path

    def test_fills_altitudes_per_point(self, linestring_file: Path, monkeypatch):
        queries: list[str] = []

        def fake_get_altitudes(points, api_key=None):
            queries.extend(points)
            return [10.5, None, 12.5, 13.5]

        monkeypatch.setattr(edit.googleapi, "get_altitudes", fake_get_altitudes)
        edit.set_kml_altitude_from_google(linestring_file, "key")

        assert queries == [(39.0, 116.0), (39.1, 116.1), (40.0, 117.0), (40.1, 117.1)]
        tree = xmlutil.parse_file(linestring_file)
        texts = [c.text or "" for c in xmlutil.findall(tree, "//kml:coordinates")]
        assert texts == [
            "116.0,39.0,10.5 116.1,39.1,0",  # None 高程写为 0
            "117.0,40.0,12.5 bad 117.1,40.1,13.5",  # 无效元组跳过且原样保留
            " ",  # 无有效坐标的节点不回写
        ]


class TestArchive:
    """进档按需创建（目录、压缩包、空聚合），出档先核对再动手。"""

    @staticmethod
    def _archive_dir(tmp_path: Path) -> Path:
        directory = tmp_path / "archive"
        directory.mkdir()
        return directory

    def test_push_creates_the_archive_and_both_collections(self, track_file: Path, tmp_path: Path):
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"

        _push(track_file, zip_path=zip_path)

        assert track_file.name in zipfile.ZipFile(zip_path).namelist()
        assert (zip_path.parent / "Default.kml").is_file()
        assert (zip_path.parent / "Default.Mobile.kml").is_file()

    def test_push_creates_the_archive_directory(self, track_file: Path, tmp_path: Path):
        zip_path = tmp_path / "archive" / "nested" / "Archive.zip"

        _push(track_file, zip_path=zip_path)

        assert zip_path.is_file()

    def test_no_archive_creates_no_zip(self, track_file: Path, tmp_path: Path):
        """--no-archive 只跳过 ZIP：聚合照建，也不该留下一个空压缩包。"""
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"

        _push(track_file, zip_path=zip_path, no_archive=True)

        assert not zip_path.exists()
        assert (zip_path.parent / "Default.kml").is_file()

    def test_a_second_push_appends_to_the_existing_archive(self, track_file: Path, tmp_path: Path):
        """已存在的归档不能被重建，否则第一条轨迹就没了。"""
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"
        _push(track_file, zip_path=zip_path)

        second = track_file.parent / "2024-05-02 second.kml"
        second.write_text(TRACK_KML, encoding="utf-8")
        _push(second, zip_path=zip_path)

        assert sorted(zipfile.ZipFile(zip_path).namelist()) == [track_file.name, second.name]

    def test_push_pop_roundtrip(self, track_file: Path, tmp_path: Path, monkeypatch):
        monkeypatch.chdir(track_file.parent)  # pop 落在当前目录，这里就是源文件所在目录
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"

        # push: 需要类型信息（源文件无 TrackTags）
        _push(track_file, zip_path=zip_path)

        # ZIP 中存在
        with zipfile.ZipFile(zip_path) as zf:
            assert track_file.name in zf.namelist()

        # 原件移入 Backup
        assert (zip_path.parent / "Backup" / track_file.name).is_file()
        assert not track_file.exists()

        # 汇总文件已创建并包含轨迹
        desktop = zip_path.parent / "Default.kml"
        mobile = zip_path.parent / "Default.Mobile.kml"
        assert len(xmlutil.findall(xmlutil.parse_file(desktop), "//kml:Placemark")) == 1
        assert len(xmlutil.findall(xmlutil.parse_file(mobile), "//kml:LineString")) == 1

        # pop: 取回并从两个汇总移除
        archive.pop_kml_archive(track_file.stem, TrackType.DEFAULT, str(zip_path))

        with zipfile.ZipFile(zip_path) as zf:
            assert track_file.name not in zf.namelist()
        assert track_file.is_file()
        assert len(xmlutil.findall(xmlutil.parse_file(desktop), "//kml:Placemark")) == 0
        assert len(xmlutil.findall(xmlutil.parse_file(mobile), "//kml:LineString")) == 0

    def test_pop_refuses_when_the_archive_is_missing(self, tmp_path: Path):
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"

        with pytest.raises(UserInputError, match="KML compressed file does not exist"):
            archive.pop_kml_archive("2024-05-01 test", TrackType.DEFAULT, str(zip_path))

        assert not zip_path.exists()  # 出档不创建任何东西

    def test_pop_refuses_when_the_collection_is_missing(self, tmp_path: Path):
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("2024-05-01 test.kml", TRACK_KML)

        with pytest.raises(UserInputError, match="Collection KML file does not exist"):
            archive.pop_kml_archive("2024-05-01 test", TrackType.DEFAULT, str(zip_path))

        # 核对发生在动手之前：归档没被取走
        assert "2024-05-01 test.kml" in zipfile.ZipFile(zip_path).namelist()

    def test_pop_refuses_when_the_track_is_not_in_the_zip(self, track_file: Path, tmp_path: Path):
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"
        _push(track_file, zip_path=zip_path)
        _drop_zip_entry(zip_path, track_file.name)

        with pytest.raises(UserInputError, match="Track not found in ZIP"):
            archive.pop_kml_archive(track_file.stem, TrackType.DEFAULT, str(zip_path))

        desktop_tree = xmlutil.parse_file(zip_path.parent / "Default.kml")
        assert len(xmlutil.findall(desktop_tree, "//kml:Placemark")) == 1  # 聚合未被清

    def test_pop_refuses_when_the_track_is_not_in_the_collection(self, track_file: Path, tmp_path: Path):
        """ZIP 里有而聚合里没有，同样是三处记载不一致。"""
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"
        _push(track_file, zip_path=zip_path)
        desktop = zip_path.parent / "Default.kml"
        tree = xmlutil.parse_file(desktop)
        for placemark in xmlutil.findall(tree, "//kml:Placemark"):
            placemark.getparent().remove(placemark)
        xmlutil.save(tree, desktop)

        with pytest.raises(UserInputError, match="Track not found in collection"):
            archive.pop_kml_archive(track_file.stem, TrackType.DEFAULT, str(zip_path))

        assert track_file.name in zipfile.ZipFile(zip_path).namelist()

    def test_force_turns_the_disagreement_into_a_warning(self, track_file: Path, tmp_path: Path):
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"
        _push(track_file, zip_path=zip_path)
        _drop_zip_entry(zip_path, track_file.name)

        # 轨迹只留在聚合里：跳过 ZIP 那一步，聚合照清
        archive.pop_kml_archive(track_file.stem, TrackType.DEFAULT, str(zip_path), force=True)

        desktop = zip_path.parent / "Default.kml"
        mobile = zip_path.parent / "Default.Mobile.kml"
        assert len(xmlutil.findall(xmlutil.parse_file(desktop), "//kml:Placemark")) == 0
        assert len(xmlutil.findall(xmlutil.parse_file(mobile), "//kml:LineString")) == 0

    def test_pop_refuses_to_overwrite_an_existing_file(self, track_file: Path, tmp_path: Path,
                                                       monkeypatch):
        monkeypatch.chdir(track_file.parent)
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"
        _push(track_file, zip_path=zip_path)
        track_file.write_text("occupied", encoding="utf-8")

        with pytest.raises(UserInputError, match="already exists at destination"):
            archive.pop_kml_archive(track_file.stem, TrackType.DEFAULT, str(zip_path))

        # 没落到磁盘就不删档：轨迹还在压缩包里
        assert track_file.name in zipfile.ZipFile(zip_path).namelist()


class TestKmlPopCommand:
    """--force 必须真的接到归档层，而不是只写在 help 里。"""

    @staticmethod
    def _invoke(zip_path: Path, tmp_path: Path, monkeypatch, args: list[str]):
        cfg = Config(path=tmp_path / "config.json").load()
        cfg["kml_zip_path"] = str(zip_path)
        monkeypatch.setattr(ctx, "config", cfg)
        monkeypatch.chdir(tmp_path)  # pop 落在当前目录
        return runner.invoke(app, ["kml", "pop", *args])

    def test_archive_disagreement_needs_force(self, track_file: Path, tmp_path: Path, monkeypatch):
        archive_dir = tmp_path / "archive"
        archive_dir.mkdir()
        zip_path = archive_dir / "Archive.zip"
        _push(track_file, zip_path=zip_path)
        _drop_zip_entry(zip_path, track_file.name)
        desktop = archive_dir / "Default.kml"

        refused = self._invoke(zip_path, tmp_path, monkeypatch, [track_file.stem])
        assert isinstance(refused.exception, UserInputError)
        assert len(xmlutil.findall(xmlutil.parse_file(desktop), "//kml:Placemark")) == 1

        forced = self._invoke(zip_path, tmp_path, monkeypatch, [track_file.stem, "--force"])
        assert forced.exit_code == 0
        assert len(xmlutil.findall(xmlutil.parse_file(desktop), "//kml:Placemark")) == 0


class TestTrackType:
    """Issue #7: TrackType StrEnum + set→get roundtrip."""

    @staticmethod
    def _kml_with_track_tags(tmp_path: Path, tag: str = "火车") -> Path:
        # set_kml_type 只更新已存在的 TrackTags 节点，
        # 往返测试需要先注入一个（2bulu 导出的 KML 均带此节点）
        kml_content = TRACK_KML.replace(
            "<Document>",
            "<Document>"
            f"<ExtendedData><Data name='TrackTags'><value>{tag}</value></Data></ExtendedData>",
        )
        kml = tmp_path / "2024-05-01 test.kml"
        kml.write_text(kml_content, encoding="utf-8")
        return kml

    def test_set_get_roundtrip(self, tmp_path: Path):
        # --set 写入的是英文名（如 "Train"），get 必须能读回，不再落 Unknown
        kml = self._kml_with_track_tags(tmp_path, "火车")
        kmlfile.set_kml_type(kml, TrackType.TRAIN)
        assert kmlfile.get_kml_type(kml) is TrackType.TRAIN

    def test_written_value_is_plain_string(self, tmp_path: Path):
        kml = self._kml_with_track_tags(tmp_path, "火车")
        kmlfile.set_kml_type(kml, TrackType.FLIGHT)
        tree = xmlutil.parse_file(kml)
        node = xmlutil.find(tree, "/kml:kml/kml:Document/kml:ExtendedData/kml:Data[@name='TrackTags']/kml:value")
        assert (node.text or "") == "Flight"

    def test_cli_set_then_get(self, tmp_path: Path):
        kml = self._kml_with_track_tags(tmp_path, "火车")

        result = runner.invoke(app, ["kml", "type", str(kml), "--set", "Train"])
        assert result.exit_code == 0
        result = runner.invoke(app, ["kml", "type", str(kml)])
        assert result.exit_code == 0
        assert result.output.strip() == "Train"

    def test_cli_rejects_unknown_type(self, tmp_path: Path):
        # 非法类型值在 CLI 入口被 typer 拒绝，不再流向下游
        kml = tmp_path / "2024-05-01 test.kml"
        kml.write_text(TRACK_KML, encoding="utf-8")
        result = runner.invoke(app, ["kml", "type", str(kml), "--set", "Bogus"])
        assert result.exit_code != 0

    def test_cli_invalid_case_rejected(self, tmp_path: Path):
        # 小写 "default" 曾会静默走向 Unknown / KeyError，现在入口即拒
        kml = tmp_path / "2024-05-01 test.kml"
        kml.write_text(TRACK_KML, encoding="utf-8")
        result = runner.invoke(app, ["kml", "push", str(kml), "--type", "default"])
        assert result.exit_code != 0
