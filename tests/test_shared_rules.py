"""Tests for issues #4 and #5: the shared zero-altitude predicate and the
shared KML archive resolution."""

import zipfile
from pathlib import Path

import pytest
from conftest import TRACK_KML, make_archive

from tracktool.config import Config
from tracktool.context import ctx
from tracktool.errors import UserInputError
from tracktool.kml.archive import UNCLASSIFIED, zip_entry_name
from tracktool.metadata import is_missing_altitude
from tracktool.workspace import resolve_archive


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


class TestResolveArchive:
    """resolve_archive reads its config from the context, so each test installs
    its own Config there rather than passing one in."""

    @staticmethod
    def _install(tmp_path: Path, monkeypatch, **values) -> Config:
        cfg = Config(path=tmp_path / "config.json").load()
        for key, value in values.items():
            cfg[key] = value
        monkeypatch.setattr(ctx, "config", cfg)
        return cfg

    def test_explicit_zip_path_wins(self, tmp_path: Path, monkeypatch):
        zip_path = make_archive(tmp_path / "archive")
        self._install(tmp_path, monkeypatch, archive_path=str(make_archive(tmp_path / "other")))

        archive_dir, resolved = resolve_archive(str(zip_path))
        assert resolved == zip_path.resolve()
        assert archive_dir == zip_path.parent.resolve()

    def test_falls_back_to_config(self, tmp_path: Path, monkeypatch):
        zip_path = make_archive(tmp_path / "archive")
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("2024-05-01 test.kml", TRACK_KML)
        self._install(tmp_path, monkeypatch, archive_path=str(zip_path.parent))

        assert resolve_archive(None) == (zip_path.parent.resolve(), zip_path.resolve())

    def test_the_manifest_names_the_zip(self, tmp_path: Path, monkeypatch):
        """ZIP 文件名记在 archive.json 里，不必非叫 Archive.zip。"""
        directory = tmp_path / "archive"
        make_archive(directory)
        (directory / "archive.json").write_text('{"version": 1, "zip": "Tracks.zip"}', encoding="utf-8")
        self._install(tmp_path, monkeypatch, archive_path=str(directory))

        _, zip_file = resolve_archive(None)
        assert zip_file == (directory / "Tracks.zip").resolve()

    def test_unset_path_raises(self, tmp_path: Path, monkeypatch):
        self._install(tmp_path, monkeypatch, archive_path="")
        with pytest.raises(UserInputError, match="not configured"):
            resolve_archive(None)

    def test_an_undeclared_directory_is_refused(self, tmp_path: Path, monkeypatch):
        """归档是声明出来的：没有 archive.json 的目录一律拒绝，哪怕 ZIP 明确给出。

        这是 E1 的核心契约——路径打错时当场报错，而不是静默新建第二份归档。
        """
        self._install(tmp_path, monkeypatch, archive_path=str(tmp_path / "nope"))
        with pytest.raises(UserInputError, match="not a tracktool archive"):
            resolve_archive(None)

        bare_zip = tmp_path / "bare" / "Archive.zip"
        with pytest.raises(UserInputError, match="not a tracktool archive"):
            resolve_archive(str(bare_zip))

    def test_merge_kml_refuses_an_undeclared_archive(self, tmp_path: Path, monkeypatch):
        """归档未声明时 merge 拒绝整个归档步骤，而不是把归档建出来。"""
        from tracktool.kml.edit import merge_kml

        self._install(tmp_path, monkeypatch, archive_path=str(tmp_path / "fresh"), kml_backup_dir_name="Backup")

        src = tmp_path / "2024-05-01 test.kml"
        src.write_text(TRACK_KML, encoding="utf-8")

        with pytest.raises(UserInputError, match="not a tracktool archive"):
            merge_kml([src], tmp_path / "merged.kml")

        assert not (tmp_path / "merged.kml").exists()
        assert src.is_file()

    def test_merge_kml_writes_nothing_when_the_manifest_cannot_be_read(self, tmp_path: Path, monkeypatch):
        """归档这一步失败时不留半成品：合并结果还没写，源文件也没搬走。"""
        from tracktool.kml.edit import merge_kml

        blocked = tmp_path / "blocked"
        blocked.write_text("not a directory", encoding="utf-8")
        self._install(tmp_path, monkeypatch, archive_path=str(blocked), kml_backup_dir_name="Backup")

        src = tmp_path / "2024-05-01 test.kml"
        src.write_text(TRACK_KML, encoding="utf-8")

        with pytest.raises(UserInputError):
            merge_kml([src], tmp_path / "merged.kml")

        assert not (tmp_path / "merged.kml").exists()
        assert src.is_file()

    def test_merge_kml_archive_uses_shared_resolution(self, tmp_path: Path, monkeypatch):
        """merge_kml 的归档步骤走共享 resolve_archive（#5）并保持原有行为。"""
        from tracktool.kml.edit import merge_kml

        zip_path = make_archive(tmp_path / "archive")
        self._install(tmp_path, monkeypatch, archive_path=str(zip_path.parent), kml_backup_dir_name="Backup")

        src = tmp_path / "2024-05-01 test.kml"
        src.write_text(TRACK_KML, encoding="utf-8")

        merge_kml([src], tmp_path / "merged.kml", move=True)

        # merge 产物没有类型信息，落在 _unclassified 而不是被猜一个类型
        assert zip_entry_name(src, UNCLASSIFIED) in zipfile.ZipFile(zip_path).namelist()
        assert (zip_path.parent / "Backup" / src.name).is_file()
