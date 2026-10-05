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
        from functools import partial

        from tracktool import log
        from tracktool.progress import rich_reporter

        # 默认 reporter 仍是 rich 那一个，只是把 console 焊在装配处：进度条与日志
        # 必须画在同一个 Console 对象上，Rich 的 Live 才擦得掉自己
        assert isinstance(ctx.reporter, partial)
        assert ctx.reporter.func is rich_reporter
        assert ctx.reporter.keywords == {"console": log.console()}


class TestRichReporter:
    def test_the_first_frame_counts_the_file_it_follows(self, monkeypatch):
        """首帧就得带上第 1 个文件——report 是在它处理完之后才被调用的。"""
        from rich.console import Console

        from tracktool.progress import rich_reporter

        events: list[tuple[str, int | None]] = []

        class FakeProgress:
            def __init__(self, *columns, **kwargs):
                pass

            def add_task(self, description, total, completed):
                events.append(("add", completed))
                return 0

            def start(self):
                events.append(("start", None))

            def update(self, task_id, completed):
                events.append(("update", completed))

            def stop(self):
                events.append(("stop", None))

        monkeypatch.setattr("rich.progress.Progress", FakeProgress)

        report = rich_reporter("Testing", console=Console())
        report(1, 3)
        report(2, 3)
        report(3, 3)

        # 起画前数据就已补齐（0/N 那一帧不会出现），此后每完成一个只是更新
        assert events == [("add", 1), ("start", None), ("update", 2), ("update", 3), ("stop", None)]
