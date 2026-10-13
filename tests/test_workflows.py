"""Workflows: a multi-step command is a plan, and its steps are the batch.

Filing N tracks is a sequence of steps — one collection each, then the ZIP,
then the backup folder that collects the sources, skipped by --keep — and each
step works on the whole batch, so the archive is read and written once instead
of once per track. These tests pin both halves: the sequence a preview shows,
and the single read/write that makes the batch worth having.
"""

from pathlib import Path

import pytest
from conftest import TRACK_KML, make_archive
from typer.testing import CliRunner

from tracktool import workflows
from tracktool.actions import describe
from tracktool.errors import UserInputError
from tracktool.fileutil import BatchResult

runner = CliRunner()


def _tagged(value: str) -> str:
    """The fixture track with a TrackTags value, so its type comes from the file."""
    return TRACK_KML.replace(
        "<Document>", f"<Document><ExtendedData><Data name='TrackTags'><value>{value}</value></Data></ExtendedData>"
    )


PLAIN_KML = _tagged("徒步")  # -> Default
TRAIN_KML = _tagged("火车")  # -> Train


def _track(directory: Path, name: str, content: str = TRACK_KML) -> Path:
    path = directory / name
    path.write_text(content, encoding="utf-8")
    return path


def _archive(tmp_path: Path) -> Path:
    """An empty archive directory, and the ZIP path an archive would have in it."""
    return make_archive(tmp_path / "archive")


def _kinds(result) -> list[str]:
    return [describe(action)[0] for entry in result.succeeded for action in entry]


class TestResolveVid:
    def test_without_a_vid_directory_there_is_nothing_to_do(self, tmp_path: Path):
        result = workflows.resolve_vid_exif(tmp_path)

        assert result.ok and not result.succeeded
        assert list(tmp_path.iterdir()) == []

    def test_a_file_where_vid_original_belongs_is_a_user_error(self, tmp_path: Path):
        (tmp_path / "VID").mkdir()
        (tmp_path / "VID_original").write_text("occupied", encoding="utf-8")

        with pytest.raises(UserInputError, match="in the way"):
            workflows.resolve_vid_exif(tmp_path)


class TestResolveVidResumes:
    """重跑接着做：每一步做没做过由磁盘上的现状决定，而不是被一个已存在的
    VID_original 拦下、让用户手工收拾半个目录。"""

    @staticmethod
    def _stub(monkeypatch) -> dict[str, object]:
        """把转换与补 GPS 换成记录调用的替身，测试不碰 ffmpeg / exiftool。"""
        calls: dict[str, object] = {}

        def convert(source, **kwargs):
            calls["convert"] = (source, kwargs["output_directory"])
            return BatchResult()

        def repair(path, **kwargs):
            calls["repair"] = path
            return BatchResult()

        monkeypatch.setattr(workflows, "convert_to_mp4", convert)
        monkeypatch.setattr(workflows, "resolve_missing_gps", repair)
        return calls

    def test_a_first_run_swaps_the_directory_and_converts_from_the_original(self, tmp_path: Path, monkeypatch):
        calls = self._stub(monkeypatch)
        (tmp_path / "VID").mkdir()
        (tmp_path / "VID" / "a.mp4").touch()

        result = workflows.resolve_vid_exif(tmp_path)

        assert result.ok
        assert (tmp_path / "VID_original" / "a.mp4").is_file()
        assert (tmp_path / "VID").is_dir() and not any((tmp_path / "VID").iterdir())
        assert calls["convert"] == ((tmp_path / "VID_original").resolve(), (tmp_path / "VID").resolve())
        assert calls["repair"] == (tmp_path / "VID").resolve()

    def test_a_rerun_after_an_interruption_converts_what_is_left(self, tmp_path: Path, monkeypatch):
        calls = self._stub(monkeypatch)
        (tmp_path / "VID_original").mkdir()  # 名字改完了
        (tmp_path / "VID_original" / "a.mp4").touch()
        (tmp_path / "VID").mkdir()  # 转换做到一半

        result = workflows.resolve_vid_exif(tmp_path)

        assert result.ok
        assert calls["convert"] == ((tmp_path / "VID_original").resolve(), (tmp_path / "VID").resolve())
        assert calls["repair"] == (tmp_path / "VID").resolve()

    def test_a_rerun_recreates_the_directory_an_interruption_left_out(self, tmp_path: Path, monkeypatch):
        calls = self._stub(monkeypatch)
        (tmp_path / "VID_original").mkdir()  # 改名做完，新目录还没建

        workflows.resolve_vid_exif(tmp_path)

        assert (tmp_path / "VID").is_dir()
        assert calls["convert"] == ((tmp_path / "VID_original").resolve(), (tmp_path / "VID").resolve())
        assert calls["repair"] == (tmp_path / "VID").resolve()

    def test_a_preview_of_a_first_run_leaves_the_directory_alone(self, tmp_path: Path, monkeypatch, plan_mode):
        calls = self._stub(monkeypatch)
        (tmp_path / "VID").mkdir()
        (tmp_path / "VID" / "a.mp4").touch()

        workflows.resolve_vid_exif(tmp_path)

        assert not (tmp_path / "VID_original").exists()
        assert (tmp_path / "VID" / "a.mp4").is_file()
        # 待转换的文件还在 VID 里，所以预演里的源就是 VID；补 GPS 那一步只说明会做
        assert calls["convert"] == ((tmp_path / "VID").resolve(), (tmp_path / "VID").resolve())
        assert "repair" not in calls

    def test_a_preview_of_a_rerun_reaches_the_repair_it_can_preview(self, tmp_path: Path, monkeypatch, plan_mode):
        calls = self._stub(monkeypatch)
        (tmp_path / "VID_original").mkdir()
        (tmp_path / "VID").mkdir()

        workflows.resolve_vid_exif(tmp_path)

        # 两个目录都在：产物已经落盘，这一步的预览是真的，不是一句「会做」
        assert calls["convert"] == ((tmp_path / "VID_original").resolve(), (tmp_path / "VID").resolve())
        assert calls["repair"] == (tmp_path / "VID").resolve()
