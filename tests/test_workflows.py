"""Workflows: a multi-step command is a plan, and its steps are the batch.

Filing N tracks is a sequence of steps — one collection each, then the ZIP,
then the backup folder — and each step works on the whole batch, so the
archive is read and written once instead of once per track. These tests pin
both halves: the sequence a preview shows, and the single read/write that
makes the batch worth having.
"""

import zipfile
from pathlib import Path

import pytest
from conftest import TRACK_KML
from typer.testing import CliRunner

from tracktool import workflows
from tracktool.actions import describe
from tracktool.cli import app
from tracktool.config import Config
from tracktool.context import ctx
from tracktool.errors import UserInputError
from tracktool.kml import xmlutil
from tracktool.kml.kmlfile import TrackType

runner = CliRunner()


def _tagged(value: str) -> str:
    """The fixture track with a TrackTags value, so its type comes from the file."""
    return TRACK_KML.replace(
        "<Document>",
        f"<Document><ExtendedData><Data name='TrackTags'><value>{value}</value></Data></ExtendedData>")


PLAIN_KML = _tagged("徒步")  # -> Default
TRAIN_KML = _tagged("火车")  # -> Train


def _track(directory: Path, name: str, content: str = TRACK_KML) -> Path:
    path = directory / name
    path.write_text(content, encoding="utf-8")
    return path


def _archive(tmp_path: Path) -> Path:
    """An empty archive directory, and the ZIP path an archive would have in it."""
    directory = tmp_path / "archive"
    directory.mkdir()
    return directory / "Archive.zip"


def _kinds(result) -> list[str]:
    return [describe(action)[0] for entry in result.succeeded for action in entry]


class TestPushBatch:
    def test_every_track_of_the_batch_is_filed_everywhere(self, tmp_path: Path):
        zip_path = _archive(tmp_path)
        tracks = [_track(tmp_path, f"2024-05-0{i} t{i}.kml") for i in (1, 2, 3)]

        result = workflows.push_tracks(tracks, str(zip_path), TrackType.DEFAULT)

        assert result.ok
        assert sorted(zipfile.ZipFile(zip_path).namelist()) == sorted(t.name for t in tracks)
        desktop = xmlutil.parse_file(zip_path.parent / "Default.kml")
        assert len(xmlutil.findall(desktop, "//kml:Placemark")) == 3
        mobile = xmlutil.parse_file(zip_path.parent / "Default.Mobile.kml")
        assert sorted(n.get("id") for n in xmlutil.findall(mobile, "//kml:LineString")) == [
            "2024-05-01 t1", "2024-05-02 t2", "2024-05-03 t3"]
        assert sorted(p.name for p in (zip_path.parent / "Backup").iterdir()) == sorted(t.name for t in tracks)
        assert not any(track.exists() for track in tracks)

    def test_the_collection_is_read_and_written_once_for_the_whole_batch(self, tmp_path: Path, monkeypatch):
        zip_path = _archive(tmp_path)
        workflows.push_tracks([_track(tmp_path, "2024-05-01 first.kml")], str(zip_path), TrackType.DEFAULT)
        tracks = [_track(tmp_path, f"2024-05-0{i} t{i}.kml") for i in (2, 3, 4)]
        desktop_path = zip_path.parent / "Default.kml"

        reads: list[Path] = []
        writes: list[Path] = []
        real_parse, real_save = xmlutil.parse_file, xmlutil.save
        monkeypatch.setattr(xmlutil, "parse_file", lambda path: (reads.append(Path(path)), real_parse(path))[1])
        monkeypatch.setattr(xmlutil, "save", lambda tree, path: (writes.append(Path(path)), real_save(tree, path))[1])

        workflows.push_tracks(tracks, str(zip_path), TrackType.DEFAULT)

        # 三条轨迹：聚合读一次、写一次（逐条进档会是各三次）
        assert reads.count(desktop_path) == 1
        assert writes.count(desktop_path) == 1
        assert len(xmlutil.findall(xmlutil.parse_file(desktop_path), "//kml:Placemark")) == 4

    def test_tracks_of_different_types_go_to_their_own_collections(self, tmp_path: Path):
        zip_path = _archive(tmp_path)
        plain = _track(tmp_path, "2024-05-01 a.kml", PLAIN_KML)
        train = _track(tmp_path, "2024-05-02 b.kml", TRAIN_KML)

        result = workflows.push_tracks([plain, train], str(zip_path))  # 类型由文件自己说明

        assert result.ok
        assert len(xmlutil.findall(xmlutil.parse_file(zip_path.parent / "Default.kml"), "//kml:Placemark")) == 1
        assert len(xmlutil.findall(xmlutil.parse_file(zip_path.parent / "Train.kml"), "//kml:Placemark")) == 1
        assert (zip_path.parent / "Train.Mobile.kml").is_file()

    def test_no_archive_files_the_collections_and_skips_the_zip(self, tmp_path: Path):
        zip_path = _archive(tmp_path)
        track = _track(tmp_path, "2024-05-01 a.kml")

        workflows.push_tracks([track], str(zip_path), TrackType.DEFAULT, no_archive=True)

        assert not zip_path.exists()
        assert (zip_path.parent / "Default.kml").is_file()
        assert (zip_path.parent / "Default.Mobile.kml").is_file()
        assert (zip_path.parent / "Backup" / track.name).is_file()

    def test_the_plan_names_the_steps_in_order(self, tmp_path: Path, plan_mode):
        zip_path = _archive(tmp_path)

        result = workflows.push_tracks([_track(tmp_path, "2024-05-01 a.kml")], str(zip_path), TrackType.DEFAULT)

        assert _kinds(result) == ["add to collection", "add to mobile collection",
                                  "append to ZIP", "move to backup folder"]
        assert list(zip_path.parent.iterdir()) == []  # 计划只是计划


class TestATrackThatCannotBeFiled:
    def test_an_unknown_type_is_a_failure_and_the_rest_goes_on(self, tmp_path: Path):
        zip_path = _archive(tmp_path)
        good = _track(tmp_path, "2024-05-01 good.kml", PLAIN_KML)
        untagged = _track(tmp_path, "2024-05-02 untagged.kml", TRACK_KML)  # 没有 TrackTags

        result = workflows.push_tracks([good, untagged], str(zip_path))

        assert [p.name for p in result.failed] == [untagged.name]
        assert zipfile.ZipFile(zip_path).namelist() == [good.name]
        assert (zip_path.parent / "Backup" / good.name).is_file()
        assert untagged.is_file()  # 没被搬走，也没被塞进聚合

    def test_an_undated_filename_is_a_failure(self, tmp_path: Path):
        zip_path = _archive(tmp_path)
        track = _track(tmp_path, "no date here.kml")

        result = workflows.push_tracks([track], str(zip_path), TrackType.DEFAULT)

        assert result.failed == [track]
        assert track.is_file()
        assert list(zip_path.parent.iterdir()) == []  # 一条轨迹都没进档，就什么都不该建

    def test_a_file_that_is_not_kml_is_a_failure(self, tmp_path: Path):
        zip_path = _archive(tmp_path)
        broken = _track(tmp_path, "2024-05-01 broken.kml", "<not-kml")

        result = workflows.push_tracks([broken], str(zip_path), TrackType.DEFAULT)

        assert result.failed == [broken]
        assert broken.is_file()


class TestTheCommand:
    def test_a_batch_left_partly_unfiled_exits_three(self, tmp_path: Path, monkeypatch):
        zip_path = _archive(tmp_path)
        good = _track(tmp_path, "2024-05-01 good.kml")
        bad = _track(tmp_path, "undated.kml")
        monkeypatch.setattr(ctx, "config", Config(path=tmp_path / "config.json").load())

        result = runner.invoke(app, ["kml", "push", str(good), str(bad),
                                     "--zip", str(zip_path), "--type", "Default"])

        assert result.exit_code == 3, result.output
        assert zipfile.ZipFile(zip_path).namelist() == [good.name]
        assert bad.is_file()

    def test_a_preview_names_the_steps_and_the_tracks(self, tmp_path: Path, plan_mode):
        zip_path = _archive(tmp_path)
        tracks = [_track(tmp_path, f"2024-05-0{i} t{i}.kml") for i in (1, 2)]

        result = runner.invoke(app, ["--dry-run", "kml", "push", *[str(t) for t in tracks],
                                     "--zip", str(zip_path), "--type", "Default"])

        assert result.exit_code == 0, result.output
        assert "add to collection" in result.output
        assert "2024-05-01 t1" in result.output and "2024-05-02 t2" in result.output
        assert list(zip_path.parent.iterdir()) == []


class TestResolveVid:
    def test_without_a_vid_directory_there_is_nothing_to_do(self, tmp_path: Path):
        result = workflows.resolve_vid_exif(tmp_path)

        assert result.ok and not result.succeeded
        assert list(tmp_path.iterdir()) == []

    def test_an_existing_vid_original_stops_the_run(self, tmp_path: Path):
        (tmp_path / "VID").mkdir()
        (tmp_path / "VID_original").mkdir()

        with pytest.raises(UserInputError, match="already exists"):
            workflows.resolve_vid_exif(tmp_path)
