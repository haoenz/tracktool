"""Tests for issues #4 and #5: the shared zero-altitude predicate and the
shared KML ZIP path resolution."""

import zipfile
from pathlib import Path

import pytest
from conftest import TRACK_KML

from tracktool.config import Config
from tracktool.context import ctx
from tracktool.errors import UserInputError
from tracktool.kml.archive import resolve_zip_path
from tracktool.metadata import is_missing_altitude


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
    """resolve_zip_path reads its config from the context, so each test installs
    its own Config there rather than passing one in."""

    @staticmethod
    def _install(tmp_path: Path, monkeypatch, **values) -> Config:
        cfg = Config(path=tmp_path / "config.json").load()
        for key, value in values.items():
            cfg[key] = value
        monkeypatch.setattr(ctx, "config", cfg)
        return cfg

    def test_explicit_path_wins(self, tmp_path: Path, monkeypatch):
        zip_path = tmp_path / "Archive.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("placeholder.txt", "x")
        self._install(tmp_path, monkeypatch, kml_zip_path=str(tmp_path / "other.zip"))

        assert resolve_zip_path(str(zip_path)) == zip_path.resolve()

    def test_falls_back_to_config(self, tmp_path: Path, monkeypatch):
        zip_path = tmp_path / "FromConfig.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("2024-05-01 test.kml", TRACK_KML)
        self._install(tmp_path, monkeypatch, kml_zip_path=str(zip_path))

        assert resolve_zip_path(None) == zip_path.resolve()

    def test_unset_path_raises(self, tmp_path: Path, monkeypatch):
        self._install(tmp_path, monkeypatch, kml_zip_path="")
        with pytest.raises(UserInputError, match="not configured"):
            resolve_zip_path(None)

    def test_a_path_that_is_not_there_yet_resolves(self, tmp_path: Path, monkeypatch):
        """位置与存在性是两件事：解析只管位置，建归档的命令自己负责创建。"""
        self._install(tmp_path, monkeypatch, kml_zip_path="")
        missing = tmp_path / "nope.zip"
        assert resolve_zip_path(str(missing)) == missing.resolve()

    def test_merge_kml_creates_the_archive_it_files_into(self, tmp_path: Path, monkeypatch):
        """归档缺失时 merge 的归档步骤把它建出来，而不是报错退出。"""
        from tracktool.kml.edit import merge_kml

        zip_path = tmp_path / "Fresh.zip"
        self._install(tmp_path, monkeypatch, kml_zip_path=str(zip_path),
                      kml_backup_dir_name="Backup")

        src = tmp_path / "2024-05-01 test.kml"
        src.write_text(TRACK_KML, encoding="utf-8")

        merge_kml([src], tmp_path / "merged.kml", no_archive=False)

        assert (tmp_path / "merged.kml").is_file()
        assert "2024-05-01 test.kml" in zipfile.ZipFile(zip_path).namelist()
        assert (tmp_path / "Backup" / src.name).is_file()

    def test_merge_kml_writes_nothing_when_the_archive_cannot_be_prepared(
            self, tmp_path: Path, monkeypatch):
        """归档这一步失败时不留半成品：合并结果还没写，源文件也没搬走。"""
        from tracktool.kml.edit import merge_kml

        blocked = tmp_path / "blocked"
        blocked.write_text("not a directory", encoding="utf-8")
        self._install(tmp_path, monkeypatch, kml_zip_path=str(blocked / "Archive.zip"),
                      kml_backup_dir_name="Backup")

        src = tmp_path / "2024-05-01 test.kml"
        src.write_text(TRACK_KML, encoding="utf-8")

        with pytest.raises(UserInputError, match="Cannot create archive directory"):
            merge_kml([src], tmp_path / "merged.kml", no_archive=False)

        assert not (tmp_path / "merged.kml").exists()
        assert src.is_file()

    def test_merge_kml_archive_uses_shared_resolution(self, tmp_path: Path, monkeypatch):
        """merge_kml 的归档步骤走共享 resolve_zip_path（#5）并保持原有行为。"""
        from tracktool.kml.edit import merge_kml

        zip_path = tmp_path / "Archive.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("placeholder.txt", "x")
        self._install(tmp_path, monkeypatch, kml_zip_path=str(zip_path),
                      kml_backup_dir_name="Backup")

        src = tmp_path / "2024-05-01 test.kml"
        src.write_text(TRACK_KML, encoding="utf-8")

        merge_kml([src], tmp_path / "merged.kml", no_archive=False)

        assert "2024-05-01 test.kml" in zipfile.ZipFile(zip_path).namelist()
        assert (zip_path.parent / "Backup" / src.name).is_file()
