"""Tests for fileutil: move_to_folder, quarantine, and run_per_file batching."""

from pathlib import Path

from tracktool.fileutil import move_to_folder, quarantine, run_per_file


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

        def process(file: Path) -> str:
            if file.name == "bad.txt":
                raise RuntimeError("boom")
            return file.stem.upper()

        results = run_per_file(list(tmp_path.glob("*.txt")), process,
                               failed_folder_name="Failed")
        assert results == ["A", "C"]
        assert (tmp_path / "Failed" / "bad.txt").is_file()
        assert not (tmp_path / "bad.txt").exists()

    def test_failure_without_failed_folder(self, tmp_path: Path):
        (tmp_path / "a.txt").write_text("x")
        (tmp_path / "bad.txt").write_text("x")

        def process(file: Path) -> str:
            if file.name == "bad.txt":
                raise RuntimeError("boom")
            return "ok"

        results = run_per_file(list(tmp_path.glob("*.txt")), process)
        assert results == ["ok"]
        assert (tmp_path / "bad.txt").exists()  # left in place

    def test_no_failure_returns_all_results(self, tmp_path: Path):
        files = [tmp_path / f"{i}.txt" for i in range(5)]
        for file in files:
            file.write_text("x")
        results = run_per_file(files, lambda f: f.name)
        assert results == [f.name for f in files]

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
        assert sequential == parallel == ["0", "1", "2", "4", "5", "6", "7", "8", "9"]
        assert len(list((tmp_path / "F").iterdir())) == 1  # bad.txt moved once per run

    def test_empty_input(self, tmp_path: Path):
        assert run_per_file([], lambda f: f) == []

    def test_rejects_exception_types(self, tmp_path: Path):
        # 逐文件隔离对任意异常生效（包括 KeyboardInterrupt 之外的 ExiftoolError 等）
        (tmp_path / "a.txt").write_text("x")

        class WeirdError(Exception):
            pass

        def process(file: Path) -> None:
            raise WeirdError("odd")

        assert run_per_file([tmp_path / "a.txt"], process) == []
