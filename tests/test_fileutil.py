"""Tests for fileutil: move_to_folder, quarantine, and the run_per_file
batch contract (one file's failure is isolated, counted and reported back)."""

import logging
from pathlib import Path

from tracktool.fileutil import BatchResult, FileFailure, move_to_folder, quarantine, run_per_file


class TestMoveToFolder:
    def test_moves_and_creates_folder(self, tmp_path: Path):
        file = tmp_path / "a.txt"
        file.write_text("x")
        move_to_folder(file, "Failed")
        assert (tmp_path / "Failed" / "a.txt").is_file()
        assert not file.exists()

    def test_existing_target_keeps_both(self, tmp_path: Path):
        file = tmp_path / "a.txt"
        file.write_text("new")
        target_dir = tmp_path / "Failed"
        target_dir.mkdir()
        (target_dir / "a.txt").write_text("old")
        move_to_folder(file, "Failed")
        assert (target_dir / "a.txt").read_text() == "old"
        assert file.exists()

    def test_explicit_parent(self, tmp_path: Path):
        file = tmp_path / "a.kml"
        file.write_text("x")
        other = tmp_path / "elsewhere"
        other.mkdir()
        move_to_folder(file, "Backup", other)
        assert (other / "Backup" / "a.kml").is_file()


class TestQuarantine:
    def test_noop_without_folder(self, tmp_path: Path):
        file = tmp_path / "a.txt"
        file.write_text("x")
        quarantine(file, None)
        assert file.exists()

    def test_moves_with_folder(self, tmp_path: Path):
        file = tmp_path / "a.txt"
        file.write_text("x")
        quarantine(file, "Failed")
        assert (tmp_path / "Failed" / "a.txt").is_file()


class TestRunPerFile:
    def test_batch_continues_after_failure(self, tmp_path: Path):
        for name in ("a.txt", "bad.txt", "c.txt"):
            (tmp_path / name).write_text("x")
        files = sorted(tmp_path.glob("*.txt"))

        def process(file: Path) -> str:
            if file.name == "bad.txt":
                raise RuntimeError("boom")
            return file.stem.upper()

        result = run_per_file(files, process, failed_folder_name="Failed")

        assert result.succeeded == ["A", "C"]
        assert result.failed == [tmp_path / "bad.txt"]
        assert not result.ok
        assert (tmp_path / "Failed" / "bad.txt").is_file()
        assert not (tmp_path / "bad.txt").exists()

    def test_failure_without_failed_folder(self, tmp_path: Path):
        (tmp_path / "a.txt").write_text("x")
        (tmp_path / "bad.txt").write_text("x")
        files = sorted(tmp_path.glob("*.txt"))

        def process(file: Path) -> str:
            if file.name == "bad.txt":
                raise RuntimeError("boom")
            return "ok"

        result = run_per_file(files, process)

        assert result.succeeded == ["ok"]
        assert result.failed == [tmp_path / "bad.txt"]
        assert (tmp_path / "bad.txt").exists()  # left in place

    def test_no_failure_returns_all_results(self, tmp_path: Path):
        files = [tmp_path / f"{i}.txt" for i in range(5)]
        for file in files:
            file.write_text("x")
        result = run_per_file(files, lambda f: f.name)
        assert result.succeeded == [f.name for f in files]
        assert result.ok

    def test_sequential_and_parallel_agree(self, tmp_path: Path):
        files = [tmp_path / f"{i}.txt" for i in range(10)]
        for file in files:
            file.write_text("x")

        def process(file: Path) -> str:
            if file.stem == "3":
                raise RuntimeError("boom")
            return file.stem

        sequential = run_per_file(files, process, failed_folder_name="F")
        parallel = run_per_file(files, process, failed_folder_name="F", parallel=True)
        assert sequential.succeeded == parallel.succeeded == ["0", "1", "2", "4", "5", "6", "7", "8", "9"]
        # 失败清单也按输入顺序，不受并行调度影响
        assert sequential.failed == parallel.failed == [tmp_path / "3.txt"]
        assert len(list((tmp_path / "F").iterdir())) == 1  # bad.txt moved once per run

    def test_empty_input(self, tmp_path: Path):
        assert run_per_file([], lambda f: f) == BatchResult()

    def test_rejects_exception_types(self, tmp_path: Path):
        # 逐文件隔离对任意异常生效（包括 KeyboardInterrupt 之外的 ExiftoolError 等）
        (tmp_path / "a.txt").write_text("x")

        class WeirdError(Exception):
            pass

        def process(file: Path) -> None:
            raise WeirdError("odd")

        result = run_per_file([tmp_path / "a.txt"], process)
        assert result.succeeded == []
        assert result.failed == [tmp_path / "a.txt"]


class TestFileFailure:
    """A FileFailure is the expected kind of per-file failure: counted like any
    other, but its reason is logged where it is raised."""

    def test_counted_and_quarantined(self, tmp_path: Path):
        file = tmp_path / "a.txt"
        file.write_text("x")

        def process(file: Path) -> None:
            raise FileFailure("nothing to process here")

        result = run_per_file([file], process, failed_folder_name="Failed")

        assert result.failed == [file]
        assert (tmp_path / "Failed" / "a.txt").is_file()

    def test_reason_is_not_relogged_as_an_error(self, tmp_path: Path, caplog):
        # 抛出方已经给出可见日志；runner 只在 DEBUG 记一行，另加一条 WARNING 汇总
        file = tmp_path / "a.txt"
        file.write_text("x")

        def process(file: Path) -> None:
            raise FileFailure("no matching GPS data")

        run_per_file([file], process, activity="Setting GPS info from KML")

        assert "1 file(s) failed" in caplog.text
        assert not [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert "no matching GPS data" not in caplog.text  # DEBUG 细节，默认级别不可见

    def test_quarantine_can_be_skipped(self, tmp_path: Path):
        # 校验不符这类失败要计数，但文件应留在原位
        file = tmp_path / "a.txt"
        file.write_text("x")

        def process(file: Path) -> None:
            raise FileFailure("existing GPS disagrees with the KML", quarantine=False)

        result = run_per_file([file], process, failed_folder_name="Failed")

        assert result.failed == [file]
        assert file.exists()
        # APPLY preflights the directory before it knows which failures opt out.
        assert list((tmp_path / "Failed").iterdir()) == []

    def test_unexpected_errors_are_still_logged_as_errors(self, tmp_path: Path, caplog):
        file = tmp_path / "a.txt"
        file.write_text("x")

        def process(file: Path) -> None:
            raise RuntimeError("genuine bug")

        run_per_file([file], process, activity="Checking altitude data")

        assert "Checking altitude data failed: genuine bug" in caplog.text


class TestBatchResult:
    def test_merge_keeps_both_halves(self, tmp_path: Path):
        first = BatchResult([None], [tmp_path / "a.jpg"])
        second = BatchResult([None, None], [tmp_path / "b.jpg", tmp_path / "c.jpg"])

        first.merge(second)

        assert first.succeeded == [None, None, None]
        assert [p.name for p in first.failed] == ["a.jpg", "b.jpg", "c.jpg"]

    def test_ok_tracks_failures(self, tmp_path: Path):
        assert BatchResult([1, 2]).ok
        assert not BatchResult([1], [tmp_path / "bad.jpg"]).ok

    def test_every_file_failing_is_not_ok(self, tmp_path: Path):
        # 全批次失败必须能被调用方识别（旧实现只返回空列表，看起来就是成功）
        files = [tmp_path / f"{i}.txt" for i in range(3)]
        for file in files:
            file.write_text("x")

        def process(file: Path) -> None:
            raise RuntimeError("boom")

        result = run_per_file(files, process)

        assert result.succeeded == []
        assert result.failed == files
        assert not result.ok
