"""Tests for issues #4 and #5: the shared zero-altitude predicate and the
shared KML ZIP path resolution."""

import zipfile
from pathlib import Path

import pytest
from conftest import TRACK_KML

from tracktool.config import Config
from tracktool.exif.write import is_missing_altitude
from tracktool.kml.archive import resolve_zip_path


class TestIsMissingAltitude:
    def test_zero_values_count_as_missing(self):
        # 读数走 -n，海拔是带符号十进制；0 在半球的两个方向上都是 0
        assert is_missing_altitude("0")
        assert is_missing_altitude("0.0")
        assert is_missing_altitude(0)
        assert is_missing_altitude(-0.0)

    def test_empty_counts_as_missing(self):
        assert is_missing_altitude("")
        assert is_missing_altitude(None)

    def test_real_altitude_is_present(self):
        assert not is_missing_altitude("100")
        assert not is_missing_altitude("-12.5")

    def test_non_numeric_is_present(self):
        # 非数值形态无法判为零，按旧行为视为有值
        assert not is_missing_altitude(" ")


class TestResolveZipPath:
    def test_explicit_path_wins(self, tmp_path: Path):
        zip_path = tmp_path / "Archive.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("placeholder.txt", "x")
        cfg = Config(path=tmp_path / "config.json").load()
        cfg["kml_zip_path"] = str(tmp_path / "other.zip")

        assert resolve_zip_path(str(zip_path), cfg) == zip_path.resolve()

    def test_falls_back_to_config(self, tmp_path: Path):
        zip_path = tmp_path / "FromConfig.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("2024-05-01 test.kml", TRACK_KML)
        cfg = Config(path=tmp_path / "config.json").load()
        cfg["kml_zip_path"] = str(zip_path)

        assert resolve_zip_path(None, cfg) == zip_path.resolve()

    def test_missing_file_raises(self, tmp_path: Path):
        cfg = Config(path=tmp_path / "config.json").load()
        cfg["kml_zip_path"] = ""
        with pytest.raises(FileNotFoundError, match="does not exist"):
            resolve_zip_path(None, cfg)
        with pytest.raises(FileNotFoundError, match="does not exist"):
            resolve_zip_path(str(tmp_path / "nope.zip"), cfg)

    def test_merge_kml_archive_uses_shared_resolution(self, tmp_path: Path):
        """merge_kml 的归档步骤走共享 resolve_zip_path（#5）并保持原有行为。"""
        from tracktool.kml.edit import merge_kml

        zip_path = tmp_path / "Archive.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("placeholder.txt", "x")
        cfg = Config(path=tmp_path / "config.json").load()
        cfg["kml_zip_path"] = str(zip_path)
        cfg["kml_backup_dir_name"] = "Backup"

        src = tmp_path / "2024-05-01 test.kml"
        src.write_text(TRACK_KML, encoding="utf-8")

        merge_kml([src], tmp_path / "merged.kml", no_archive=False, cfg=cfg)

        assert "2024-05-01 test.kml" in zipfile.ZipFile(zip_path).namelist()
        assert (zip_path.parent / "Backup" / src.name).is_file()
