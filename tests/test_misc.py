"""Tests for dedup, config, and Set-Exif tag building."""

import json
from pathlib import Path

import pytest

from tracktool import dedup
from tracktool.config import Config
from tracktool.discover import list_files
from tracktool.errors import UserInputError
from tracktool.exif.write import SetExifError, SetExifOptions, build_position_params, build_tags


class TestListFiles:
    def test_a_directory_yields_only_media(self, tmp_path: Path):
        # 真实照片目录混入 .txt / .DS_Store 是常态，目录目标只收已知媒体扩展名
        (tmp_path / "a.jpg").touch()
        (tmp_path / "notes.txt").touch()
        (tmp_path / ".DS_Store").touch()
        (tmp_path / "b.arw").touch()

        assert list_files(tmp_path) == [tmp_path / "a.jpg", tmp_path / "b.arw"]

    def test_a_named_file_is_kept_whatever_it_is(self, tmp_path: Path):
        # 用户点名什么就处理什么，扩展名拦不住显式路径
        txt = tmp_path / "notes.txt"
        txt.touch()

        assert list_files(txt) == [txt]

    def test_an_explicit_list_is_handed_back_verbatim(self, tmp_path: Path):
        chosen = [tmp_path / "x.jpg", tmp_path / "y.txt"]
        assert list_files(chosen) == chosen

    def test_a_missing_path_raises(self, tmp_path: Path):
        with pytest.raises(UserInputError, match="does not exist"):
            list_files(tmp_path / "nope")


class TestBuildPositionParams:
    def test_decimal_2bulu_style(self):
        tags = build_position_params("39.908333 116.391389")
        assert tags["GPSLatitude"] == "39.908333"
        assert tags["GPSLatitudeRef"] == "N"
        assert tags["GPSLongitudeRef"] == "E"

    def test_negative_decimal(self):
        tags = build_position_params("-33.865 151.209")
        assert tags["GPSLatitude"] == "33.865"
        assert tags["GPSLatitudeRef"] == "S"

    def test_invalid_raises(self):
        with pytest.raises(SetExifError):
            build_position_params("999 999")

    def test_dms_exif_style(self):
        tags = build_position_params("39°54'30\"N, 116°23'29\"E")
        assert float(tags["GPSLatitude"]) == pytest.approx(39 + 54 / 60 + 30 / 3600)
        assert tags["GPSLatitudeRef"] == "N"
        assert float(tags["GPSLongitude"]) == pytest.approx(116 + 23 / 60 + 29 / 3600)
        assert tags["GPSLongitudeRef"] == "E"

    def test_dms_deg_style(self):
        tags = build_position_params("39deg 54'30\"N, 116deg 23'29\"E")
        assert float(tags["GPSLatitude"]) == pytest.approx(39 + 54 / 60 + 30 / 3600)
        assert tags["GPSLatitudeRef"] == "N"

    def test_google_earth_chinese(self):
        tags = build_position_params("39°54'30\" 北 116°23'29\" 东")
        assert float(tags["GPSLatitude"]) == pytest.approx(39 + 54 / 60 + 30 / 3600)
        assert tags["GPSLatitudeRef"] == "N"
        assert tags["GPSLongitudeRef"] == "E"

    def test_comma_decimal(self):
        tags = build_position_params("39.908333, 116.391389")
        assert tags["GPSLatitude"] == "39.908333"
        assert tags["GPSLongitudeRef"] == "E"


class TestBuildTags:
    def test_altitude_sign(self):
        positive = build_tags(SetExifOptions(altitude=100))
        negative = build_tags(SetExifOptions(altitude=-50))
        assert positive["GPSAltitudeRef"] == "Above Sea Level"
        assert negative["GPSAltitudeRef"] == "Below Sea Level"
        assert negative["GPSAltitude"] == "50"

    def test_tags_are_handed_over_verbatim(self):
        # overwrite 不在标签里：它是 write_tags 的开关，由后端负责参数化
        tags = build_tags(SetExifOptions(tags={"IPTC:City": "Beijing"}))
        assert tags["IPTC:City"] == "Beijing"


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
