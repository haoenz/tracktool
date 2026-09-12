"""Regression tests for issue #1: per-file error isolation in parallel batches.

A file whose processing fails must not abort the batch: the remaining files
are still processed and the failed file is moved into the failed folder when
one is configured. Before the run_per_file refactor only exif/google.py did
this; position.py and media.py aborted the whole batch on the first error.
"""

import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest
from conftest import TRACK_KML
from typer.testing import CliRunner

from tracktool import cli, exiftool
from tracktool.config import Config
from tracktool.context import ctx
from tracktool.exif.position import SetPositionOptions, set_position_from_kml

# 测试依赖真实 exiftool（读标签 / 写 GPS），以及 ffmpeg 生成样本 JPEG
pytestmark = pytest.mark.skipif(shutil.which("exiftool") is None, reason="requires exiftool")

runner = CliRunner()


def _make_jpeg(path: Path) -> None:
    """Real one-frame JPEG (exiftool rejects hand-written minimal bytes)."""
    ret = subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", str(path)],
        capture_output=True)
    assert ret.returncode == 0, ret.stderr.decode(errors="replace")


def _make_geotaggable_jpeg(path: Path) -> None:
    """JPEG with a timestamp inside the track (00:01:30 UTC = 08:01:30+08:00)."""
    _make_jpeg(path)
    exiftool.invoke(str(path),
                    "-ExifIFD:DateTimeOriginal=2024:05:01 08:01:30",
                    "-ExifIFD:OffsetTimeOriginal=+08:00",
                    "-overwrite_original")


def _write_kml_zip(tmp_path: Path) -> Path:
    """KML ZIP keyed by the date the position matcher looks up in filenames."""
    zip_path = tmp_path / "Archive.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("2024-05-01 test.kml", TRACK_KML)
    return zip_path


@pytest.fixture
def media_dir(tmp_path: Path, monkeypatch) -> tuple[Path, Config]:
    """Media directory plus a test Config installed as the context's config, so
    the batch entry points resolve the test ZIP without being handed one."""
    cfg = Config(path=tmp_path / "config.json").load()
    cfg["kml_zip_path"] = str(_write_kml_zip(tmp_path))
    monkeypatch.setattr(ctx, "config", cfg)
    directory = tmp_path / "media"
    directory.mkdir()
    return directory, cfg


def _batch_with_bad_file(media_dir: Path, parallel: bool = False) -> list[Path]:
    """One unreadable file among two geotaggable ones; runs one batch."""
    good1, good2 = media_dir / "2024-05-01 a.jpg", media_dir / "2024-05-01 b.jpg"
    for file in (good1, good2):
        _make_geotaggable_jpeg(file)
    # 未知格式会在读取标签时抛 ExiftoolError——旧实现在此中止整个批次
    bad = media_dir / "no-time.jpg"
    bad.write_bytes(b"\x00")

    set_position_from_kml(media_dir, options=SetPositionOptions(failed_folder_name="Failed"),
                          parallel=parallel)
    return [good1, good2]


class TestSetPositionBatchIsolation:
    def test_exception_in_one_file_does_not_abort_batch(self, media_dir):
        media_dir, cfg = media_dir
        good1, good2 = _batch_with_bad_file(media_dir)

        # 批次完成：两个好文件都拿到了 KML 的 GPS 数据
        for file in (good1, good2):
            assert exiftool.get_media_tag(file, "GPSPosition"), f"{file.name} not geotagged"
        # 失败文件被移入 failed folder
        assert (media_dir / "Failed" / "no-time.jpg").is_file()
        assert not (media_dir / "no-time.jpg").exists()

    def test_parallel_isolation_matches_sequential(self, media_dir):
        media_dir, cfg = media_dir
        good1, good2 = _batch_with_bad_file(media_dir, parallel=True)

        for file in (good1, good2):
            assert exiftool.get_media_tag(file, "GPSPosition"), f"{file.name} not geotagged"
        assert (media_dir / "Failed" / "no-time.jpg").is_file()

    def test_missing_timestamp_moves_file_to_failed_folder(self, media_dir):
        media_dir, cfg = media_dir
        good = media_dir / "2024-05-01 a.jpg"
        _make_geotaggable_jpeg(good)
        # 可读但无时间戳的 JPEG：media_time 为 None 的显式失败路径
        timeless = media_dir / "timeless.jpg"
        _make_jpeg(timeless)

        set_position_from_kml(media_dir, options=SetPositionOptions(
            failed_folder_name="Failed"))

        assert exiftool.get_media_tag(good, "GPSPosition")
        assert (media_dir / "Failed" / "timeless.jpg").is_file()

    def test_batch_reports_the_files_it_could_not_process(self, media_dir):
        media_dir, cfg = media_dir
        for name in ("2024-05-01 a.jpg", "2024-05-01 b.jpg"):
            _make_geotaggable_jpeg(media_dir / name)
        bad = media_dir / "no-time.jpg"
        bad.write_bytes(b"\x00")

        result = set_position_from_kml(media_dir, options=SetPositionOptions(
            failed_folder_name="Failed"))

        assert result.succeeded == [None, None]  # 两个好文件都处理了
        assert [p.name for p in result.failed] == ["no-time.jpg"]
        assert not result.ok


class TestCliExitCodeReflectsBatch:
    """The batch outcome has to reach the exit code: a run where nothing was
    processed used to be indistinguishable from a successful one."""

    def _invoke(self, media_dir: Path, zip_path: str):
        # media_dir fixture 已把 ctx.config 指向临时路径，CLI 不会读用户真实配置
        return runner.invoke(cli.app, ["exif", "set-position", str(media_dir),
                                       "--zip", zip_path, "--failed-folder", "Failed",
                                       "--overwrite"])

    def test_partial_failure_exits_three(self, media_dir):
        media_dir, cfg = media_dir
        good = media_dir / "2024-05-01 a.jpg"
        _make_geotaggable_jpeg(good)
        (media_dir / "no-time.jpg").write_bytes(b"\x00")

        result = self._invoke(media_dir, cfg["kml_zip_path"])

        assert result.exit_code == cli.EXIT_PARTIAL
        assert (media_dir / "Failed" / "no-time.jpg").is_file()
        assert exiftool.get_media_tag(good, "GPSPosition")  # 好文件仍被处理

    def test_every_file_failing_exits_three_too(self, media_dir):
        media_dir, cfg = media_dir
        (media_dir / "no-time.jpg").write_bytes(b"\x00")

        result = self._invoke(media_dir, cfg["kml_zip_path"])

        assert result.exit_code == cli.EXIT_PARTIAL
