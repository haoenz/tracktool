"""Tests for KML editing: split, bad-point removal, archive push/pop."""

import json
import zipfile
from pathlib import Path

import pytest
from conftest import TRACK_KML, make_archive
from typer.testing import CliRunner

from tracktool import workflows
from tracktool.cli import app
from tracktool.config import Config
from tracktool.context import ctx
from tracktool.errors import UserInputError
from tracktool.kml import archive, edit, kmlfile, xmlutil
from tracktool.kml.kmlfile import TrackKind

runner = CliRunner()


def _drop_zip_entry(zip_path: Path, entry_name: str) -> None:
    """重写压缩包并去掉某条 entry，造出「ZIP 与聚合不一致」的归档。"""
    with zipfile.ZipFile(zip_path) as zf:
        remaining = {info.filename: zf.read(info.filename) for info in zf.infolist() if info.filename != entry_name}
    with zipfile.ZipFile(zip_path, "w") as zf:
        for name, blob in remaining.items():
            zf.writestr(name, blob)


def _push(*tracks: Path, zip_path: Path, type_: TrackKind | None = TrackKind.DEFAULT, move: bool = False) -> list[Path]:
    """File tracks the way `kml push` does; returns the ones it could not file."""
    return workflows.push_tracks(list(tracks), str(zip_path), type_, move).failed


def _zip_entry(track: Path) -> str:
    """分层后轨迹在 ZIP 里的 entry 路径（E2 契约：<Kind>/<YYYY-MM>/<name>）。"""
    return archive.zip_entry_name(track, "Default")


@pytest.fixture
def track_file(tmp_path: Path) -> Path:
    path = tmp_path / "2024-05-01 test.kml"
    path.write_text(TRACK_KML, encoding="utf-8")
    return path


@pytest.fixture
def gapped_track_file(tmp_path: Path) -> Path:
    """四点轨迹：1、2 点之间记录中断 40 分钟且跳远（默认阈值可检出）。"""
    points = [
        ("2024-05-01T00:00:00Z", "116.0 39.0 100"),
        ("2024-05-01T00:01:00Z", "116.001 39.001 100"),
        ("2024-05-01T00:41:00Z", "116.2 39.2 120"),
        ("2024-05-01T00:42:00Z", "116.201 39.201 100"),
    ]
    whens = "".join(f"<when>{w}</when>" for w, _ in points)
    coords = "".join(f"<gx:coord>{c}</gx:coord>" for _, c in points)
    path = tmp_path / "2024-05-01 gapped.kml"
    path.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">\n'
        "<Document>\n<name>2024-05-01 gapped</name>\n<Folder>\n<Placemark>\n<name>track</name>\n"
        f"<gx:Track>\n{whens}\n{coords}\n</gx:Track>\n"
        "</Placemark>\n</Folder>\n</Document>\n</kml>",
        encoding="utf-8",
    )
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

    def test_detect_gap_and_split(self, gapped_track_file: Path):
        points = edit.detect_gap_points(gapped_track_file, gap_seconds=300, gap_meters=500)
        assert points == ["2024-05-01T00:01:00Z"]  # 中断前最后一个点

        edit.split_kml(gapped_track_file, points)
        part1 = gapped_track_file.parent / "2024-05-01 gapped-Splited-1.kml"
        part2 = gapped_track_file.parent / "2024-05-01 gapped-Splited-2.kml"
        tree1 = xmlutil.parse_file(part1)
        tree2 = xmlutil.parse_file(part2)
        assert len(xmlutil.findall(tree1, "//gx:coord")) == 2  # 点 0-1
        assert len(xmlutil.findall(tree2, "//gx:coord")) == 2  # 点 2-3

    def test_detect_gap_pause_in_place_is_no_gap(self, tmp_path: Path):
        """时间跳 40 分钟但原地未动：不算中断，不切。"""
        points = [
            ("2024-05-01T00:00:00Z", "116.0 39.0 100"),
            ("2024-05-01T00:01:00Z", "116.0 39.0 100"),
            ("2024-05-01T00:41:00Z", "116.0 39.0 100"),
            ("2024-05-01T00:42:00Z", "116.0 39.0 100"),
        ]
        whens = "".join(f"<when>{w}</when>" for w, _ in points)
        coords = "".join(f"<gx:coord>{c}</gx:coord>" for _, c in points)
        path = tmp_path / "2024-05-01 paused.kml"
        path.write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">\n'
            "<Document>\n<Folder>\n<Placemark>\n"
            f"<gx:Track>\n{whens}\n{coords}\n</gx:Track>\n"
            "</Placemark>\n</Folder>\n</Document>\n</kml>",
            encoding="utf-8",
        )
        assert edit.detect_gap_points(path, gap_seconds=300, gap_meters=500) == []

    def test_detect_gap_requires_timestamps(self, track_file: Path):
        """2bulu 导出都带 when；无时间戳的轨迹直接报错而非静默漏检。"""
        raw = track_file.read_text(encoding="utf-8")
        stripped = "\n".join(line for line in raw.splitlines() if "<when>" not in line)
        track_file.write_text(stripped, encoding="utf-8")
        with pytest.raises(UserInputError):
            edit.detect_gap_points(track_file, gap_seconds=300, gap_meters=500)

    def test_cli_auto_split(self, gapped_track_file: Path):
        result = runner.invoke(app, ["kml", "split", str(gapped_track_file), "--auto"])
        assert result.exit_code == 0, result.output
        assert (gapped_track_file.parent / "2024-05-01 gapped-Splited-1.kml").is_file()
        assert (gapped_track_file.parent / "2024-05-01 gapped-Splited-2.kml").is_file()

    def test_cli_auto_no_gap_makes_nothing(self, track_file: Path):
        """默认阈值下连续轨迹检不出中断，不产生任何文件。"""
        result = runner.invoke(app, ["kml", "split", str(track_file), "--auto"])
        assert result.exit_code == 0, result.output
        assert not list(track_file.parent.glob("*-Splited-*.kml"))

    def test_cli_auto_conflicts_with_points(self, track_file: Path):
        result = runner.invoke(app, ["kml", "split", str(track_file), "--auto", "2024-05-01T00:01:00Z"])
        assert result.exit_code != 0

    def test_cli_requires_points_or_auto(self, track_file: Path):
        result = runner.invoke(app, ["kml", "split", str(track_file)])
        assert result.exit_code != 0


class TestRemoveBadPoints:
    def test_remove_single(self, track_file: Path):
        edit.prune_points(track_file, ["116.1 39.1 110"])
        fixed = track_file.parent / "2024-05-01 test-Fixed.kml"
        assert fixed.is_file()
        tree = xmlutil.parse_file(fixed)
        assert len(xmlutil.findall(tree, "//gx:coord")) == 3
        assert len(xmlutil.findall(tree, "//kml:when")) == 3

    def test_remove_range(self, track_file: Path):
        edit.prune_points(track_file, ["116.0 39.0 100", "116.1 39.1 110"])
        fixed = track_file.parent / "2024-05-01 test-Fixed.kml"
        tree = xmlutil.parse_file(fixed)
        assert len(xmlutil.findall(tree, "//gx:coord")) == 2

    def test_too_many_points_raises(self, track_file: Path):
        with pytest.raises(ValueError):
            edit.prune_points(track_file, ["a", "b", "c"])


def _write_track(tmp_path: Path, name: str, points: list[tuple[str, str]]) -> Path:
    """1 秒级采样风格的 gx:Track 文件，供漂移探测用例合成轨迹。"""
    whens = "".join(f"<when>{w}</when>" for w, _ in points)
    coords = "".join(f"<gx:coord>{c}</gx:coord>" for _, c in points)
    path = tmp_path / name
    path.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">\n'
        "<Document>\n<Folder>\n<Placemark>\n"
        f"<gx:Track>\n{whens}\n{coords}\n</gx:Track>\n"
        "</Placemark>\n</Folder>\n</Document>\n</kml>",
        encoding="utf-8",
    )
    return path


def _second(t: int) -> str:
    return f"2024-05-01T00:00:{t:02d}Z"


# 纬度 0.001 度 ≈ 111 m，全部用纬度偏移控制距离
BASE = "116.0 39.0 100"


def _stationary(count: int, start: int = 0):
    return [(_second(start + i), BASE) for i in range(count)]


class TestDetectDrift:
    def test_drift_burst_detected_and_pruned(self, tmp_path: Path):
        """原地记录中飞出 ~333 m 又回来：检出区间，prune 只删漂移点。"""
        points = _stationary(5)
        points += [
            (_second(5), "116.0 39.003 100"),
            (_second(6), "116.0 39.0031 100"),
            (_second(7), "116.0 39.0029 100"),
            (_second(8), "116.0 39.003 100"),
        ]
        points += _stationary(3, start=9)
        path = _write_track(tmp_path, "drift.kml", points)

        bursts = edit.detect_drift_points(path)
        assert bursts == [("2024-05-01T00:00:05Z", "2024-05-01T00:00:08Z")]

        assert edit.prune_drift_points(path) == 4
        fixed = tmp_path / "drift-Fixed.kml"
        tree = xmlutil.parse_file(fixed)
        assert len(xmlutil.findall(tree, "//gx:coord")) == 8
        assert len(xmlutil.findall(tree, "//kml:when")) == 8
        # 锚点与返回点都保留
        assert (tmp_path / "drift.kml").read_text(encoding="utf-8").count("<gx:coord>") == 12

    def test_single_point_spike(self, tmp_path: Path):
        """单点尖峰：飞出一点、下一点即回，只删这一个点。"""
        points = _stationary(5)
        points += [(_second(5), "116.0 39.002 100")]
        points += _stationary(2, start=6)
        path = _write_track(tmp_path, "spike.kml", points)

        assert edit.detect_drift_points(path) == [("2024-05-01T00:00:05Z", "2024-05-01T00:00:05Z")]
        assert edit.prune_drift_points(path) == 1
        assert len(xmlutil.findall(xmlutil.parse_file(tmp_path / "spike-Fixed.kml"), "//gx:coord")) == 7

    def test_real_movement_is_not_drift(self, tmp_path: Path):
        """每步 50 m、0.83 m/s 的稀疏真实步行：不触发，不删任何点。"""
        points = [(f"2024-05-01T00:{m:02d}:00Z", f"116.0 {39.0 + 0.00045 * m:.5f} 100") for m in range(6)]
        path = _write_track(tmp_path, "walk.kml", points)
        assert edit.detect_drift_points(path) == []

    def test_departure_without_return_is_kept(self, tmp_path: Path):
        """触发后 200 秒才回锚点（超出时间窗）：不确认，整段保留。"""
        points = _stationary(5)
        points += [(_second(5), "116.0 39.003 100"), (_second(6), "116.0 39.003 100")]
        points += [(f"2024-05-01T00:{m:02d}:00Z", "116.0 39.003 100") for m in range(1, 3)]
        points += [("2024-05-01T00:03:30Z", BASE)]
        path = _write_track(tmp_path, "away.kml", points)
        assert edit.detect_drift_points(path) == []

    def test_no_drift_writes_nothing(self, tmp_path: Path):
        path = _write_track(tmp_path, "clean.kml", _stationary(10))
        assert edit.prune_drift_points(path) == 0
        assert not (tmp_path / "clean-Fixed.kml").exists()

    def test_cli_auto_prune(self, tmp_path: Path):
        points = _stationary(5)
        points += [(_second(5), "116.0 39.003 100"), (_second(6), "116.0 39.0029 100")]
        points += _stationary(3, start=7)
        path = _write_track(tmp_path, "cli-drift.kml", points)

        result = runner.invoke(app, ["kml", "prune", str(path), "--auto"])
        assert result.exit_code == 0, result.output
        fixed = tmp_path / "cli-drift-Fixed.kml"
        assert fixed.is_file()
        assert len(xmlutil.findall(xmlutil.parse_file(fixed), "//gx:coord")) == 8

    def test_cli_auto_no_drift_makes_nothing(self, tmp_path: Path):
        path = _write_track(tmp_path, "cli-clean.kml", _stationary(10))
        result = runner.invoke(app, ["kml", "prune", str(path), "--auto"])
        assert result.exit_code == 0, result.output
        assert not list(tmp_path.glob("*-Fixed.kml"))

    def test_cli_auto_conflicts_with_points(self, tmp_path: Path):
        path = _write_track(tmp_path, "c.kml", _stationary(4))
        result = runner.invoke(app, ["kml", "prune", str(path), "--auto", BASE])
        assert result.exit_code != 0

    def test_cli_requires_points_or_auto(self, tmp_path: Path):
        path = _write_track(tmp_path, "c.kml", _stationary(4))
        result = runner.invoke(app, ["kml", "prune", str(path)])
        assert result.exit_code != 0


class TestMergeKml:
    @staticmethod
    def _archive(tmp_path: Path, monkeypatch) -> Path:
        """merge 总是走共享的 resolve_archive：装一个已声明的归档到 ctx.config。"""
        zip_path = make_archive(tmp_path / "archive")
        cfg = Config(path=tmp_path / "config.json").load()
        cfg["archive_path"] = str(zip_path.parent)
        monkeypatch.setattr(ctx, "config", cfg)
        return zip_path

    def test_merge_multigeometry(self, track_file: Path, tmp_path: Path, monkeypatch):
        self._archive(tmp_path, monkeypatch)
        output = tmp_path / "merged.kml"
        edit.merge_kml([track_file, track_file], output, connected=False)
        tree = xmlutil.parse_file(output)
        assert len(xmlutil.findall(tree, "//kml:LineString")) == 2

    def test_merge_connected(self, track_file: Path, tmp_path: Path, monkeypatch):
        self._archive(tmp_path, monkeypatch)
        output = tmp_path / "merged.kml"
        edit.merge_kml([track_file, track_file], output, connected=True)
        tree = xmlutil.parse_file(output)
        lss = xmlutil.findall(tree, "//kml:LineString")
        assert len(lss) == 1
        coords_node = xmlutil.find(tree, "//kml:LineString/kml:coordinates")
        tuples = (coords_node.text or "").split()
        assert len(tuples) == 8  # 4 + 4 coords

    def test_merge_leaves_the_sources_alone_until_moved(self, track_file: Path, tmp_path: Path, monkeypatch):
        """E5：merge 默认把源文件归档进 ZIP 但不搬；--move 才收进 Backup。
        同一源文件列两次只归档一次、只搬一次。"""
        zip_path = self._archive(tmp_path, monkeypatch)
        output = tmp_path / "merged.kml"

        edit.merge_kml([track_file, track_file], output, connected=False, move=True)

        assert not track_file.is_file()  # move=True：源文件进了 Backup
        assert (zip_path.parent / "Backup" / track_file.name).is_file()
        assert output.is_file()  # 合并结果留在 --output 指的位置


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


PLACEMARK_KML = "<Placemark><LineString><coordinates>{coordinates}</coordinates></LineString></Placemark>"

DOCUMENT_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
{placemarks}
</Document>
</kml>"""


class TestAltitudeFromGoogle:
    """只有整轨都没有高程的轨迹才补（手绘）；带任何一点真实海拔的轨迹整条不动。"""

    @pytest.fixture
    def linestring_file(self, tmp_path: Path) -> Path:
        path = tmp_path / "tracks.kml"
        path.write_text(LINESTRING_KML, encoding="utf-8")
        return path

    @staticmethod
    def _tracks(tmp_path: Path, *coordinates: str) -> Path:
        """One Placemark — one track — per argument."""
        path = tmp_path / "tracks.kml"
        placemarks = "\n".join(PLACEMARK_KML.format(coordinates=item) for item in coordinates)
        path.write_text(DOCUMENT_KML.format(placemarks=placemarks), encoding="utf-8")
        return path

    @staticmethod
    def _altitudes(monkeypatch, values: list[float | None]) -> list[tuple[float, float]]:
        """Stub the API out and hand back the list it will be asked for."""
        queries: list[tuple[float, float]] = []

        def fake_get_altitudes(points, api_key=None):
            queries.extend(points)
            return values

        monkeypatch.setattr(edit.googleapi, "get_altitudes", fake_get_altitudes)
        return queries

    @staticmethod
    def _coordinates(path: Path) -> list[str | None]:
        tree = xmlutil.parse_file(path)
        return [c.text for c in xmlutil.findall(tree, "//kml:LineString/kml:coordinates")]

    def test_fills_altitudes_per_point(self, linestring_file: Path, monkeypatch):
        queries = self._altitudes(monkeypatch, [10.5, None, 12.5, 13.5])
        edit.fill_kml_altitude_from_google(linestring_file, "key")

        assert queries == [(39.0, 116.0), (39.1, 116.1), (40.0, 117.0), (40.1, 117.1)]
        assert self._coordinates(linestring_file) == [
            "116.0,39.0,10.5 116.1,39.1,0",  # None 高程写为 0
            "117.0,40.0,12.5 bad 117.1,40.1,13.5",  # 无效元组跳过且原样保留
            " ",  # 无有效坐标的节点不回写
        ]

    def test_a_track_without_any_altitude_is_filled(self, tmp_path: Path, monkeypatch):
        path = self._tracks(tmp_path, "116.0,39.0 116.1,39.1,0")  # 缺分量与 0 都算没有海拔
        queries = self._altitudes(monkeypatch, [10.5, 12.5])
        edit.fill_kml_altitude_from_google(path, "key")

        assert queries == [(39.0, 116.0), (39.1, 116.1)]
        assert self._coordinates(path) == ["116.0,39.0,10.5 116.1,39.1,12.5"]

    def test_a_track_with_one_real_altitude_is_left_alone(self, tmp_path: Path, monkeypatch):
        path = self._tracks(tmp_path, "116.0,39.0 116.1,39.1,110.0")
        before = path.read_bytes()

        def fail(*args, **kwargs):
            raise AssertionError("Google Elevation must not be queried")

        monkeypatch.setattr(edit.googleapi, "get_altitudes", fail)
        edit.fill_kml_altitude_from_google(path, "key")

        assert path.read_bytes() == before

    def test_only_the_tracks_without_altitude_are_filled(self, tmp_path: Path, monkeypatch):
        """一个文件里两种轨迹并存：设备记录的那条整条不动，手绘的那条才补。"""
        path = self._tracks(tmp_path, "116.0,39.0 116.1,39.1,110.0", "117.0,40.0 117.1,40.1")
        queries = self._altitudes(monkeypatch, [12.5, 13.5])
        edit.fill_kml_altitude_from_google(path, "key")

        assert queries == [(40.0, 117.0), (40.1, 117.1)]  # 只查了缺高程的那条
        assert self._coordinates(path) == [
            "116.0,39.0 116.1,39.1,110.0",
            "117.0,40.0,12.5 117.1,40.1,13.5",
        ]


class TestArchive:
    """进档先看归档身份（archive.json），出档先核对再动手。"""

    @staticmethod
    def _archive_dir(tmp_path: Path) -> Path:
        directory = tmp_path / "archive"
        make_archive(directory)
        return directory

    def test_push_creates_the_archive_and_both_collections(self, track_file: Path, tmp_path: Path):
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"

        _push(track_file, zip_path=zip_path)

        assert _zip_entry(track_file) in zipfile.ZipFile(zip_path).namelist()
        assert (zip_path.parent / "Default.kml").is_file()
        assert (zip_path.parent / "Default.Mobile.kml").is_file()

    def test_push_refuses_an_undeclared_directory(self, track_file: Path, tmp_path: Path):
        """E1：路径打错时当场报错，而不是静默新建第二份归档。"""
        undeclared = tmp_path / "typo"

        with pytest.raises(UserInputError, match="not a tracktool archive"):
            _push(track_file, zip_path=undeclared / "Archive.zip")

        assert not undeclared.exists()

    def test_push_leaves_the_source_alone(self, track_file: Path, tmp_path: Path):
        """E5：push 只进档不搬文件——源文件留在原地，Backup 不会被建出来。"""
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"

        _push(track_file, zip_path=zip_path)

        assert track_file.is_file()
        assert not (zip_path.parent / "Backup").exists()

    def test_a_second_push_appends_to_the_existing_archive(self, track_file: Path, tmp_path: Path):
        """已存在的归档不能被重建，否则第一条轨迹就没了。"""
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"
        _push(track_file, zip_path=zip_path)

        second = track_file.parent / "2024-05-02 second.kml"
        second.write_text(TRACK_KML, encoding="utf-8")
        _push(second, zip_path=zip_path)

        assert sorted(zipfile.ZipFile(zip_path).namelist()) == sorted([_zip_entry(track_file), _zip_entry(second)])

    def test_push_pop_roundtrip(self, track_file: Path, tmp_path: Path, monkeypatch):
        monkeypatch.chdir(track_file.parent)  # pop 落在当前目录，这里就是源文件所在目录
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"

        # push: 需要类型信息（源文件无 TrackTags）；--move 把原件收进 Backup
        _push(track_file, zip_path=zip_path, move=True)

        # ZIP 中存在
        with zipfile.ZipFile(zip_path) as zf:
            assert _zip_entry(track_file) in zf.namelist()

        # 原件移入 Backup
        assert (zip_path.parent / "Backup" / track_file.name).is_file()
        assert not track_file.exists()

        # 汇总文件已创建并包含轨迹
        desktop = zip_path.parent / "Default.kml"
        mobile = zip_path.parent / "Default.Mobile.kml"
        assert len(xmlutil.findall(xmlutil.parse_file(desktop), "//kml:Placemark")) == 1
        assert len(xmlutil.findall(xmlutil.parse_file(mobile), "//kml:LineString")) == 1

        # pop: 取回并从两个汇总移除
        archive.pop_kml_archive(track_file.stem, TrackKind.DEFAULT, str(zip_path))

        with zipfile.ZipFile(zip_path) as zf:
            assert _zip_entry(track_file) not in zf.namelist()
        assert track_file.is_file()
        assert len(xmlutil.findall(xmlutil.parse_file(desktop), "//kml:Placemark")) == 0
        assert len(xmlutil.findall(xmlutil.parse_file(mobile), "//kml:LineString")) == 0

    def test_pop_refuses_when_the_archive_is_missing(self, tmp_path: Path):
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"
        zip_path.unlink()  # 目录已声明，但 ZIP 被删了：照样拒绝

        with pytest.raises(UserInputError, match="KML compressed file does not exist"):
            archive.pop_kml_archive("2024-05-01 test", TrackKind.DEFAULT, str(zip_path))

        assert not zip_path.exists()  # 出档不创建任何东西

    def test_pop_refuses_when_the_collection_is_missing(self, tmp_path: Path):
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"
        with zipfile.ZipFile(zip_path, "a") as zf:
            zf.writestr("2024-05-01 test.kml", TRACK_KML)

        with pytest.raises(UserInputError, match="Collection KML file does not exist"):
            archive.pop_kml_archive("2024-05-01 test", TrackKind.DEFAULT, str(zip_path))

        # 核对发生在动手之前：归档没被取走
        assert "2024-05-01 test.kml" in zipfile.ZipFile(zip_path).namelist()

    def test_pop_refuses_when_the_track_is_not_in_the_zip(self, track_file: Path, tmp_path: Path):
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"
        _push(track_file, zip_path=zip_path)
        _drop_zip_entry(zip_path, _zip_entry(track_file))

        with pytest.raises(UserInputError, match="Track not found in ZIP"):
            archive.pop_kml_archive(track_file.stem, TrackKind.DEFAULT, str(zip_path))

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
            archive.pop_kml_archive(track_file.stem, TrackKind.DEFAULT, str(zip_path))

        assert _zip_entry(track_file) in zipfile.ZipFile(zip_path).namelist()

    def test_force_turns_the_disagreement_into_a_warning(self, track_file: Path, tmp_path: Path):
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"
        _push(track_file, zip_path=zip_path)
        _drop_zip_entry(zip_path, _zip_entry(track_file))

        # 轨迹只留在聚合里：跳过 ZIP 那一步，聚合照清
        archive.pop_kml_archive(track_file.stem, TrackKind.DEFAULT, str(zip_path), force=True)

        desktop = zip_path.parent / "Default.kml"
        mobile = zip_path.parent / "Default.Mobile.kml"
        assert len(xmlutil.findall(xmlutil.parse_file(desktop), "//kml:Placemark")) == 0
        assert len(xmlutil.findall(xmlutil.parse_file(mobile), "//kml:LineString")) == 0

    def test_pop_refuses_to_overwrite_an_existing_file(self, track_file: Path, tmp_path: Path, monkeypatch):
        monkeypatch.chdir(track_file.parent)
        zip_path = self._archive_dir(tmp_path) / "Archive.zip"
        _push(track_file, zip_path=zip_path)
        track_file.write_text("occupied", encoding="utf-8")

        with pytest.raises(UserInputError, match="already exists at destination"):
            archive.pop_kml_archive(track_file.stem, TrackKind.DEFAULT, str(zip_path))

        # 没落到磁盘就不删档：轨迹还在压缩包里
        assert _zip_entry(track_file) in zipfile.ZipFile(zip_path).namelist()


class TestArchiveInit:
    """`archive init` 是归档唯一的创建入口。"""

    def test_init_declares_the_directory(self, tmp_path: Path):
        directory = tmp_path / "archive"

        result = runner.invoke(app, ["archive", "init", str(directory)])

        assert result.exit_code == 0
        manifest = directory / "archive.json"
        assert manifest.is_file()
        assert json.loads(manifest.read_text(encoding="utf-8"))["zip"] == "Archive.zip"
        # 空 ZIP 是真 ZIP，不是 0 字节占位
        assert zipfile.ZipFile(directory / "Archive.zip").testzip() is None

    def test_init_refuses_an_already_declared_archive(self, tmp_path: Path):
        directory = tmp_path / "archive"
        make_archive(directory)

        result = runner.invoke(app, ["archive", "init", str(directory)])

        assert result.exit_code == 1
        assert isinstance(result.exception, UserInputError)

    def test_init_adopts_existing_files(self, tmp_path: Path, track_file: Path):
        """对已有归档文件的目录补办身份：ZIP 不被重建，轨迹一条不丢。"""
        directory = tmp_path / "archive"
        directory.mkdir()
        zip_path = directory / "Archive.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.write(track_file, track_file.name)

        result = runner.invoke(app, ["archive", "init", str(directory)])

        assert result.exit_code == 0
        # 收编不改数据：写入时的平铺条目原样保留（分层留给显式迁移）
        assert track_file.name in zipfile.ZipFile(zip_path).namelist()

    def test_init_in_plan_mode_writes_nothing(self, tmp_path: Path, monkeypatch):
        from tracktool.context import RunMode

        monkeypatch.setattr(ctx, "mode", RunMode.PLAN)
        directory = tmp_path / "archive"

        result = runner.invoke(app, ["--dry-run", "archive", "init", str(directory)])

        assert result.exit_code == 0
        assert not directory.exists()


class TestKmlPopCommand:
    """--force 必须真的接到归档层，而不是只写在 help 里。"""

    @staticmethod
    def _invoke(zip_path: Path, tmp_path: Path, monkeypatch, args: list[str]):
        cfg = Config(path=tmp_path / "config.json").load()
        cfg["archive_path"] = str(zip_path.parent)
        monkeypatch.setattr(ctx, "config", cfg)
        monkeypatch.chdir(tmp_path)  # pop 落在当前目录
        return runner.invoke(app, ["kml", "pop", *args])

    def test_archive_disagreement_needs_force(self, track_file: Path, tmp_path: Path, monkeypatch):
        archive_dir = tmp_path / "archive"
        zip_path = make_archive(archive_dir)
        _push(track_file, zip_path=zip_path)
        _drop_zip_entry(zip_path, _zip_entry(track_file))
        desktop = archive_dir / "Default.kml"

        refused = self._invoke(zip_path, tmp_path, monkeypatch, [track_file.stem])
        assert isinstance(refused.exception, UserInputError)
        assert len(xmlutil.findall(xmlutil.parse_file(desktop), "//kml:Placemark")) == 1

        forced = self._invoke(zip_path, tmp_path, monkeypatch, [track_file.stem, "--force"])
        assert forced.exit_code == 0
        assert len(xmlutil.findall(xmlutil.parse_file(desktop), "//kml:Placemark")) == 0


class TestTrackKind:
    """Issue #7: TrackKind StrEnum + set→get roundtrip."""

    @staticmethod
    def _kml_with_track_tags(tmp_path: Path, tag: str = "火车") -> Path:
        # set_kml_type 只更新已存在的 TrackTags 节点，
        # 往返测试需要先注入一个（2bulu 导出的 KML 均带此节点）
        kml_content = TRACK_KML.replace(
            "<Document>",
            f"<Document><ExtendedData><Data name='TrackTags'><value>{tag}</value></Data></ExtendedData>",
        )
        kml = tmp_path / "2024-05-01 test.kml"
        kml.write_text(kml_content, encoding="utf-8")
        return kml

    def test_set_get_roundtrip(self, tmp_path: Path):
        # kml set-type 写入的是英文名（如 "Train"），get 必须能读回，不再落 Unknown
        kml = self._kml_with_track_tags(tmp_path, "火车")
        kmlfile.set_kml_type(kml, TrackKind.TRAIN)
        assert kmlfile.get_kml_type(kml) is TrackKind.TRAIN

    def test_written_value_is_plain_string(self, tmp_path: Path):
        kml = self._kml_with_track_tags(tmp_path, "火车")
        kmlfile.set_kml_type(kml, TrackKind.FLIGHT)
        tree = xmlutil.parse_file(kml)
        node = xmlutil.find(tree, "/kml:kml/kml:Document/kml:ExtendedData/kml:Data[@name='TrackTags']/kml:value")
        assert (node.text or "") == "Flight"

    def test_cli_set_then_get(self, tmp_path: Path):
        kml = self._kml_with_track_tags(tmp_path, "火车")

        result = runner.invoke(app, ["kml", "set-type", str(kml), "Train"])
        assert result.exit_code == 0
        result = runner.invoke(app, ["kml", "type", str(kml)])
        assert result.exit_code == 0
        assert result.output.strip() == "Train"

    def test_cli_rejects_unknown_type(self, tmp_path: Path):
        # 非法类型值在 CLI 入口被 typer 拒绝，不再流向下游
        kml = tmp_path / "2024-05-01 test.kml"
        kml.write_text(TRACK_KML, encoding="utf-8")
        result = runner.invoke(app, ["kml", "set-type", str(kml), "Bogus"])
        assert result.exit_code != 0

    def test_cli_invalid_case_rejected(self, tmp_path: Path):
        # 小写 "default" 曾会静默走向 Unknown / KeyError，现在入口即拒
        kml = tmp_path / "2024-05-01 test.kml"
        kml.write_text(TRACK_KML, encoding="utf-8")
        result = runner.invoke(app, ["kml", "push", str(kml), "--type", "default"])
        assert result.exit_code != 0

    def test_unknown_is_not_a_type_anymore(self, tmp_path: Path):
        """E4：识别不出不是一种类型——Unknown 退出命令行取值域。"""
        kml = tmp_path / "2024-05-01 test.kml"
        kml.write_text(TRACK_KML, encoding="utf-8")

        result = runner.invoke(app, ["kml", "pop", "whatever", "--type", "Unknown"])
        # CliRunner 直接拿 typer 的保留码 2；经 cli_main 入口会归一成 1
        assert result.exit_code == 2

        result = runner.invoke(app, ["kml", "type", str(kml)])
        assert result.exit_code == 0
        assert result.output.strip() == "Unknown"  # 只是识别结果的如实呈现


def _kml_with_tag(tag: str) -> str:
    """带 TrackTags 的轨迹，类型由文件自己说明。"""
    return TRACK_KML.replace(
        "<Document>", f"<Document><ExtendedData><Data name='TrackTags'><value>{tag}</value></Data></ExtendedData>"
    )


class TestArchiveLayering:
    """E2：ZIP 条目按 <Kind>/<YYYY-MM>/<name> 分层。"""

    def test_two_kinds_sharing_a_file_name_are_two_entries(self, tmp_path: Path):
        """同名轨迹按类型各归各的 entry，不再互相遮挡静默跳过。"""
        zip_path = make_archive(tmp_path / "archive")
        plain = tmp_path / "2024-05-01 same.kml"
        plain.write_text(_kml_with_tag("徒步"), encoding="utf-8")
        other = tmp_path / "other"
        other.mkdir()
        train = other / "2024-05-01 same.kml"
        train.write_text(_kml_with_tag("火车"), encoding="utf-8")

        assert _push(plain, zip_path=zip_path, type_=None) == []
        assert _push(train, zip_path=zip_path, type_=None) == []

        names = zipfile.ZipFile(zip_path).namelist()
        assert "Default/2024-05/2024-05-01 same.kml" in names
        assert "Train/2024-05/2024-05-01 same.kml" in names

    def test_the_entry_month_comes_from_the_file_name(self, track_file: Path, tmp_path: Path):
        zip_path = make_archive(tmp_path / "archive")

        _push(track_file, zip_path=zip_path)

        assert "Default/2024-05/2024-05-01 test.kml" in zipfile.ZipFile(zip_path).namelist()


class TestArchiveStatusAndRebuild:
    """E2：视图是派生的——指纹回答「落后没有」，rebuild 从真值再生。"""

    def test_a_push_that_syncs_the_views_records_the_fingerprint(self, track_file: Path, tmp_path: Path):
        zip_path = make_archive(tmp_path / "archive")

        _push(track_file, zip_path=zip_path)

        assert archive.read_views_fingerprint(zip_path) == archive.archive_fingerprint(zip_path)
        result = runner.invoke(app, ["archive", "status", "--zip", str(zip_path)])
        assert result.exit_code == 0
        assert "in sync" in result.output

    def test_status_reports_never_synced_when_the_manifest_has_no_fingerprint(self, track_file: Path, tmp_path: Path):
        """迁移后的老归档：manifest 从没记过指纹，status 如实说「从未同步」。"""
        zip_path = make_archive(tmp_path / "archive")
        _push(track_file, zip_path=zip_path)
        manifest = zip_path.parent / "archive.json"
        data = json.loads(manifest.read_text(encoding="utf-8"))
        del data["views"]
        manifest.write_text(json.dumps(data), encoding="utf-8")

        result = runner.invoke(app, ["archive", "status", "--zip", str(zip_path)])

        assert result.exit_code == 0
        assert "never been synced" in result.output

    def test_status_reports_stale_when_the_zip_moves_behind_the_views(self, track_file: Path, tmp_path: Path):
        """真值动了而视图没跟上：指纹对不上，status 报「落后」。"""
        zip_path = make_archive(tmp_path / "archive")
        _push(track_file, zip_path=zip_path)
        with zipfile.ZipFile(zip_path, "a") as zf:
            zf.writestr("Default/2024-06/2024-06-01 late.kml", TRACK_KML)

        result = runner.invoke(app, ["archive", "status", "--zip", str(zip_path)])

        assert result.exit_code == 0
        assert "out of date" in result.output

    def test_rebuild_regenerates_the_views_from_the_zip(self, track_file: Path, tmp_path: Path):
        zip_path = make_archive(tmp_path / "archive")
        _push(track_file, zip_path=zip_path)
        (zip_path.parent / "Default.kml").unlink()
        (zip_path.parent / "Default.Mobile.kml").unlink()

        result = runner.invoke(app, ["archive", "rebuild", "--zip", str(zip_path)])

        assert result.exit_code == 0, result.output
        desktop = xmlutil.parse_file(zip_path.parent / "Default.kml")
        assert len(xmlutil.findall(desktop, "//kml:Placemark")) == 1
        mobile = xmlutil.parse_file(zip_path.parent / "Default.Mobile.kml")
        assert len(xmlutil.findall(mobile, "//kml:LineString")) == 1
        assert archive.read_views_fingerprint(zip_path) == archive.archive_fingerprint(zip_path)

    def test_rebuild_leaves_unclassified_entries_out_of_the_views(self, tmp_path: Path):
        """_unclassified 条目没有类型，任何视图都不收，rebuild 也不猜。"""
        zip_path = make_archive(tmp_path / "archive")
        untagged = tmp_path / "2024-05-01 raw.kml"
        untagged.write_text(TRACK_KML, encoding="utf-8")  # 没有 TrackTags
        archive.push_compressed_kml(untagged, zip_path)

        result = runner.invoke(app, ["archive", "rebuild", "--zip", str(zip_path)])

        assert result.exit_code == 0, result.output
        # 没有一个可归类的条目，就一个视图文件都不造（与 push 一致），status 也不喊缺文件
        assert not (zip_path.parent / "Default.kml").exists()
        result = runner.invoke(app, ["archive", "status", "--zip", str(zip_path)])
        assert result.exit_code == 0
        assert "Missing view files" not in result.output
        assert "in sync" in result.output

    def test_rebuild_in_plan_mode_writes_nothing(self, track_file: Path, tmp_path: Path):
        zip_path = make_archive(tmp_path / "archive")
        _push(track_file, zip_path=zip_path)
        desktop = zip_path.parent / "Default.kml"
        before = desktop.read_text(encoding="utf-8")

        result = runner.invoke(app, ["--dry-run", "archive", "rebuild", "--zip", str(zip_path)])

        assert result.exit_code == 0
        assert desktop.read_text(encoding="utf-8") == before


class TestGlobExpansion:
    """多文件入口（push / merge）的参数通配符：进程内展开，批内按路径排序。"""

    @staticmethod
    def _staging(tmp_path: Path) -> tuple[Path, Path, Path]:
        """两个轨迹文件，创建顺序与名字序相反，好让排序可断言。"""
        staging = tmp_path / "staging"
        staging.mkdir()
        early = staging / "2024-05-01 early.kml"
        late = staging / "2024-05-02 late.kml"
        early.write_text(TRACK_KML, encoding="utf-8")
        late.write_text(TRACK_KML, encoding="utf-8")
        return staging, early, late

    def test_push_expands_a_wildcard_in_sorted_order(self, tmp_path: Path):
        """pwsh 不展开通配符：工具自己展开，ZIP 追加序 = 路径序（与 rebuild 回放同名序）。"""
        staging, early, late = self._staging(tmp_path)
        zip_path = make_archive(tmp_path / "archive")

        result = runner.invoke(
            app, ["kml", "push", str(staging / "*.kml"), "--type", "Default", "--zip", str(zip_path)]
        )

        assert result.exit_code == 0
        with zipfile.ZipFile(zip_path) as zf:
            assert zf.namelist() == [_zip_entry(early), _zip_entry(late)]

    def test_push_wildcard_without_matches_is_a_user_error(self, tmp_path: Path):
        staging, _, _ = self._staging(tmp_path)
        zip_path = make_archive(tmp_path / "archive")

        result = runner.invoke(
            app, ["kml", "push", str(staging / "2020-*.kml"), "--type", "Default", "--zip", str(zip_path)]
        )

        assert result.exit_code == 1
        assert zipfile.ZipFile(zip_path).namelist() == []

    def test_push_literal_paths_keep_the_exact_semantics(self, tmp_path: Path):
        """字面量参数不吃 glob 语义：不存在的路径照旧退 1，不静默展开成空。"""
        staging, early, _ = self._staging(tmp_path)
        zip_path = make_archive(tmp_path / "archive")

        result = runner.invoke(
            app, ["kml", "push", str(early), str(staging / "missing.kml"), "--type", "Default", "--zip", str(zip_path)]
        )

        assert result.exit_code == 1
        assert zipfile.ZipFile(zip_path).namelist() == []

    def test_merge_expands_a_wildcard(self, tmp_path: Path, monkeypatch):
        staging, _, _ = self._staging(tmp_path)
        zip_path = make_archive(tmp_path / "archive")
        cfg = Config(path=tmp_path / "config.json").load()
        cfg["archive_path"] = str(zip_path.parent)
        monkeypatch.setattr(ctx, "config", cfg)
        output = tmp_path / "merged.kml"

        result = runner.invoke(app, ["kml", "merge", str(staging / "*.kml"), "-o", str(output)])

        assert result.exit_code == 0
        assert output.is_file()
        assert len(zipfile.ZipFile(zip_path).namelist()) == 2  # merge 也归档输入
