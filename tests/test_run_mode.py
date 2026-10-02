"""PLAN mode: the whole run describes its work instead of doing it.

The mode is not a parameter a command can forget to pass — it sits on the
context, and every write in the package goes through one of the handful of
primitives exercised here. So these tests are the safety net for the claim
"no command can silently write during a preview": each primitive is asked to
work under PLAN and has to leave the disk exactly as it was.
"""

import zipfile
from pathlib import Path

import pytest
from conftest import TRACK_KML, InMemoryBackend, make_archive
from typer.testing import CliRunner

from tracktool import workflows
from tracktool.cli import app
from tracktool.config import Config
from tracktool.context import ctx
from tracktool.errors import UserInputError
from tracktool.fileutil import move_to_folder
from tracktool.kml import archive, xmlutil
from tracktool.kml.kmlfile import TrackKind

runner = CliRunner()


def _kml(tmp_path: Path, name: str = "2024-05-01 test.kml") -> Path:
    path = tmp_path / name
    path.write_text(TRACK_KML, encoding="utf-8")
    return path


class TestKmlWritesAreReported:
    def test_saving_a_document_reports_instead_of_writing(self, tmp_path: Path, plan_mode):
        target = tmp_path / "out.kml"

        assert xmlutil.save(xmlutil.parse_string(TRACK_KML), target) is False
        assert not target.exists()

    def test_saving_for_real_writes(self, tmp_path: Path):
        target = tmp_path / "out.kml"

        assert xmlutil.save(xmlutil.parse_string(TRACK_KML), target) is True
        assert target.is_file()

    def test_splitting_a_track_leaves_no_part_files(self, tmp_path: Path, plan_mode):
        source = _kml(tmp_path)

        runner.invoke(app, ["--dry-run", "kml", "split", str(source), "2024-05-01T00:01:00Z"])

        assert sorted(p.name for p in tmp_path.glob("*.kml")) == [source.name]

    def test_cleaning_bad_points_leaves_no_fixed_file(self, tmp_path: Path, plan_mode):
        source = _kml(tmp_path)

        runner.invoke(app, ["--dry-run", "kml", "prune", str(source), "116.1 39.1 110"])

        assert sorted(p.name for p in tmp_path.glob("*.kml")) == [source.name]

    def test_setting_the_track_type_leaves_the_file_alone(self, tmp_path: Path, plan_mode):
        source = tmp_path / "2024-05-01 test.kml"
        source.write_text(
            TRACK_KML.replace(
                "<Document>",
                "<Document><ExtendedData><Data name='TrackTags'><value>火车</value></Data></ExtendedData>",
            ),
            encoding="utf-8",
        )

        runner.invoke(app, ["--dry-run", "kml", "set-type", str(source), "Flight"])

        node = xmlutil.find(
            xmlutil.parse_file(source), "/kml:kml/kml:Document/kml:ExtendedData/kml:Data[@name='TrackTags']/kml:value"
        )
        assert (node.text or "") == "火车"


class TestArchiveWritesAreReported:
    def test_pushing_an_undeclared_archive_creates_nothing(self, tmp_path: Path, plan_mode):
        """预演也不越过归档身份：未声明的目录直接报错，什么都不建。"""
        source = _kml(tmp_path)
        archive_dir = tmp_path / "archive"

        result = runner.invoke(
            app, ["--dry-run", "kml", "push", str(source), "--zip", str(archive_dir / "Archive.zip")]
        )

        assert result.exit_code == 1
        assert not archive_dir.exists()  # 目录没建
        assert source.is_file()  # 也没被搬走

    def test_popping_a_track_creates_nothing(self, tmp_path: Path, monkeypatch):
        source = _kml(tmp_path)
        zip_path = make_archive(tmp_path / "archive")
        workflows.push_tracks([source], str(zip_path), TrackKind.DEFAULT, move=True)
        before = sorted(p.name for p in zip_path.parent.iterdir())

        monkeypatch.chdir(tmp_path)
        result = runner.invoke(app, ["--dry-run", "kml", "pop", source.stem, "--zip", str(zip_path)])

        assert result.exit_code == 0, result.output
        assert not (tmp_path / source.name).exists()
        assert sorted(p.name for p in zip_path.parent.iterdir()) == before

    def test_the_directory_and_the_zip_are_not_created(self, tmp_path: Path, plan_mode):
        zip_path = tmp_path / "archive" / "Archive.zip"

        archive.ensure_archive_directory(zip_path.parent)
        archive.ensure_zip_file(zip_path)
        archive.push_compressed_kml(_kml(tmp_path), zip_path)

        assert not zip_path.parent.exists()

    def test_extraction_still_refuses_a_destination_in_the_way(self, tmp_path: Path, plan_mode):
        # 出档的核对在预演里照样成立：目标已存在就报错，不静默丢条目
        zip_path = tmp_path / "Archive.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("2024-05-01 test.kml", TRACK_KML)
        (tmp_path / "2024-05-01 test.kml").write_text("occupied", encoding="utf-8")

        with pytest.raises(UserInputError, match="already exists at destination"):
            archive.pop_compressed_kml("2024-05-01 test", zip_path, tmp_path)

        assert "2024-05-01 test.kml" in zipfile.ZipFile(zip_path).namelist()


class TestMovesAndSideFilesAreReported:
    def test_moving_a_file_creates_no_folder(self, tmp_path: Path, plan_mode):
        file = tmp_path / "a.txt"
        file.write_text("x", encoding="utf-8")

        move_to_folder(file, "Failed")

        assert file.is_file()
        assert not (tmp_path / "Failed").exists()

    def test_grouping_media_leaves_every_file_where_it_was(self, tmp_path: Path, plan_mode):
        (tmp_path / "a.jpg").touch()
        (tmp_path / "b.mp4").touch()

        runner.invoke(app, ["--dry-run", "exif", "group", str(tmp_path)])

        assert sorted(p.name for p in tmp_path.iterdir()) == ["a.jpg", "b.mp4"]

    def test_a_config_value_is_not_persisted(self, tmp_path: Path, plan_mode, monkeypatch):
        config = Config(path=tmp_path / "config.json").load()
        monkeypatch.setattr(ctx, "config", config)

        result = runner.invoke(app, ["--dry-run", "config", "set", "log_level", "DEBUG"])

        assert result.exit_code == 0, result.output
        assert not config.path.exists()


class TestReadOnlyCommandsStillReport:
    def test_find_missing_prints_its_findings_without_a_plan(self, tmp_path: Path, monkeypatch):
        # show-missing 只读：它的结果不是计划，预演不该把它换成一张空表
        (tmp_path / "a.jpg").touch()
        monkeypatch.setattr(ctx, "backend", InMemoryBackend())

        result = runner.invoke(app, ["--dry-run", "exif", "show-missing", str(tmp_path), "GPSPosition"])

        assert result.exit_code == 0, result.output
        assert "GPSPosition" in result.output
        assert "Nothing to do" not in result.output


class TestTheFlagIsGlobal:
    def test_a_shift_is_not_applied(self, tmp_path: Path, monkeypatch):
        backend = InMemoryBackend({tmp_path / "a.jpg": {"GPSAltitude": "100"}})
        monkeypatch.setattr(ctx, "backend", backend)
        (tmp_path / "a.jpg").touch()

        result = runner.invoke(app, ["--dry-run", "exif", "shift-altitude", str(tmp_path), "10"])

        assert result.exit_code == 0, result.output
        assert backend.writes == []
        assert "would shift" in result.output or "write tags" in result.output

    def test_the_same_command_writes_when_the_flag_is_absent(self, tmp_path: Path, monkeypatch):
        backend = InMemoryBackend({tmp_path / "a.jpg": {"GPSAltitude": "100"}})
        monkeypatch.setattr(ctx, "backend", backend)
        (tmp_path / "a.jpg").touch()

        result = runner.invoke(app, ["exif", "shift-altitude", str(tmp_path), "10"])

        assert result.exit_code == 0, result.output
        assert backend.writes == [
            (tmp_path / "a.jpg", {"GPSAltitudeRef": "Above Sea Level", "GPSAltitude": "110.0"}, False)
        ]
