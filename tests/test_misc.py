"""Tests for dedup, config, and Set-Exif position param building."""

import json
from pathlib import Path

import pytest

from tracktool import dedup
from tracktool.config import Config
from tracktool.exif.write import SetExifError, SetExifOptions, build_params, build_position_params


class TestBuildPositionParams:
    def test_decimal_2bulu_style(self):
        params = build_position_params("39.908333 116.391389")
        assert "-GPSLatitude=39.908333" in params
        assert "-GPSLatitudeRef=N" in params
        assert "-GPSLongitudeRef=E" in params

    def test_negative_decimal(self):
        params = build_position_params("-33.865 151.209")
        assert "-GPSLatitude=33.865" in params
        assert "-GPSLatitudeRef=S" in params

    def test_invalid_raises(self):
        with pytest.raises(SetExifError):
            build_position_params("999 999")

    def test_dms_passthrough(self):
        params = build_position_params("39°54'30\"N, 116°23'29\"E")
        assert params == ["-GPSPosition=39°54'30\"N, 116°23'29\"E"]

    def test_google_earth_chinese(self):
        params = build_position_params("39°54'30\" 北 116°23'29\" 东")
        assert params[0].startswith("-GPSPosition=39°54'30\" N, 116°23'29\" E")


class TestBuildParams:
    def test_altitude_sign(self):
        positive = build_params(SetExifOptions(altitude=100))
        negative = build_params(SetExifOptions(altitude=-50))
        assert "-GPSAltitudeRef=Above Sea Level" in positive
        assert "-GPSAltitudeRef=Below Sea Level" in negative
        assert "-GPSAltitude=50" in negative

    def test_overwrite_and_tags(self):
        params = build_params(SetExifOptions(tags={"IPTC:City": "Beijing"}, overwrite=True))
        assert "-IPTC:City=Beijing" in params
        assert "-overwrite_original" in params


class TestConfig:
    def test_defaults_and_roundtrip(self, tmp_path: Path):
        cfg = Config(path=tmp_path / "config.json")
        cfg.load()
        assert cfg["log_level"] == "INFO"
        cfg["kml_backup_dir_name"] = "Old"
        cfg.save()
        reloaded = Config(path=tmp_path / "config.json").load()
        assert reloaded["kml_backup_dir_name"] == "Old"

    def test_api_key_env_priority(self, tmp_path: Path, monkeypatch):
        monkeypatch.setenv("TRACKTOOL_GOOGLE_API_KEY", "env-key")
        cfg = Config(path=tmp_path / "config.json").load()
        cfg["google_api_key"] = "file-key"
        assert cfg.google_api_key() == "env-key"
        assert cfg.google_api_key("param-key") == "env-key"
        monkeypatch.delenv("TRACKTOOL_GOOGLE_API_KEY")
        assert cfg.google_api_key() == "file-key"
        assert cfg.google_api_key("param-key") == "param-key"


class TestDedup:
    def test_hash_and_compare(self, tmp_path: Path):
        dir_a = tmp_path / "a"
        dir_b = tmp_path / "b"
        dir_a.mkdir()
        dir_b.mkdir()
        (dir_a / "shared.txt").write_text("same")
        (dir_b / "shared.txt").write_text("same")
        (dir_a / "only_a.txt").write_text("a only")
        (dir_b / "only_b.txt").write_text("b only")

        result = dedup.compare_directories([dir_a, dir_b])
        only_paths = {p.name for files in result.values() for p in files}
        assert only_paths == {"only_a.txt", "only_b.txt"}

        unique = dedup.compare_directories([dir_a, dir_b], unique=True)
        unique_paths = {p.name for files in unique.values() for p in files}
        assert unique_paths == {"only_a.txt", "only_b.txt"}

    def test_hash_log_roundtrip(self, tmp_path: Path):
        directory = tmp_path / "files"
        directory.mkdir()
        (directory / "f.txt").write_text("data")
        log_path = tmp_path / "log.json"

        dedup.get_directories_hash([directory], hash_log_path=log_path)
        assert log_path.is_file()
        stored = json.loads(log_path.read_text(encoding="utf-8"))
        assert str(directory / "f.txt") in stored

        # clear log drops entries for deleted files
        (directory / "f.txt").unlink()
        dedup.clear_hash_log(log_path)
        stored = json.loads(log_path.read_text(encoding="utf-8"))
        assert str(directory / "f.txt") not in stored

    def test_find_duplicates(self, tmp_path: Path):
        directory = tmp_path / "dupes"
        directory.mkdir()
        (directory / "one.txt").write_text("same content")
        (directory / "two.txt").write_text("same content")
        (directory / "three.txt").write_text("different")

        groups = dedup.find_duplicate_files(directory)
        assert len(groups) == 1
        assert len(groups[0].files) == 2
