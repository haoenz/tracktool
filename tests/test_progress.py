"""The progress seam: the batch reports numbers, someone else decides the look."""

from pathlib import Path

from tracktool import progress
from tracktool.context import ctx
from tracktool.fileutil import run_per_file


class TestRunParallel:
    def test_every_completion_is_reported_in_order(self):
        seen: list[tuple[int, int]] = []

        result = progress.run_parallel(
            list("abc"), str.upper, on_progress=lambda done, total: seen.append((done, total))
        )

        assert result == ["A", "B", "C"]
        assert seen == [(1, 3), (2, 3), (3, 3)]

    def test_no_reporter_no_calls(self):
        results: list[object] = []
        seen: list[object] = []

        progress.run_parallel([1, 2], results.append)
        progress.run_parallel([1], results.append, on_progress=seen.append)

        # 单元素快速路径不报告；不给回调则什么都不发生
        assert results == [1, 2, 1]
        assert seen == []

    def test_parallel_results_keep_input_order(self):
        result = progress.run_parallel(
            [3, 1, 4, 1, 5], lambda n: n * 2, parallel=True, on_progress=lambda done, total: None
        )

        assert result == [6, 2, 8, 2, 10]


class TestBatchReportsThroughContext:
    def test_run_per_file_reports_through_the_installed_reporter(self, tmp_path: Path, monkeypatch):
        # 执行层只调 ctx.reporter 给的回调；rich 与否它不知道
        seen: list[tuple[int, int]] = []
        monkeypatch.setattr(ctx, "reporter", lambda activity: lambda done, total: seen.append((done, total)))
        files = [tmp_path / f"{i}.jpg" for i in range(3)]
        for file in files:
            file.touch()

        run_per_file(files, lambda file: file.read_bytes(), activity="Testing")

        assert seen == [(1, 3), (2, 3), (3, 3)]

    def test_the_default_reporter_is_the_rich_one(self):
        from tracktool.progress import rich_reporter

        assert ctx.reporter is rich_reporter
