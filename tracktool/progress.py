"""Parallel batch processing with progress reporting.

A ThreadPoolExecutor (I/O-bound workload) with a thread-safe completion
count. Single-item inputs skip the thread pool and the reporting entirely.
What progress looks like is the caller's business: run_parallel fires an
`on_progress(done, total)` callback and never touches a console.
"""

import itertools
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

from rich.console import Console

DEFAULT_WORKERS = 5


def run_parallel[T, R](
    items: list[T],
    fn: Callable[[T], R],
    *,
    parallel: bool = False,
    on_progress: Callable[[int, int], None] | None = None,
) -> list[R]:
    """Apply fn to every item, in parallel when beneficial.

    Returns results in input order. `parallel` selects DEFAULT_WORKERS threads
    over a single worker. `on_progress(done, total)` fires once per completed
    item (and a single-item fast path reports nothing at all).
    """
    workers = DEFAULT_WORKERS if parallel else 1
    if not items:
        return []

    def sequential() -> list[R]:
        if len(items) == 1:
            return [fn(items[0])]
        results = []
        for done, item in enumerate(items, 1):
            results.append(fn(item))
            if on_progress is not None:
                on_progress(done, len(items))
        return results

    if workers <= 1 or len(items) == 1:
        return sequential()

    # itertools.count 的 __next__ 是 C 实现，线程安全，足够当完成计数用
    completed = itertools.count(1)

    def wrapped(item: T) -> R:
        result = fn(item)
        if on_progress is not None:
            on_progress(next(completed), len(items))
        return result

    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(wrapped, items))


def rich_reporter(activity: str, *, console: Console) -> Callable[[int, int], None]:
    """A progress display for one batch: starts on the first report, clears
    itself once the count reaches its total (transient, so nothing lingers).

    The display draws on the console it is handed, and no other. Sharing one
    console with the log handler is what keeps the two from fighting over the
    terminal: `Live` clears its own region by moving the cursor, which only
    works because the log's write goes through the console the live render is
    hooked to. Two console objects — rich's global one is stdout, the handler's
    is stderr — mean neither knows about the other, and the log line gets
    stapled to the end of the bar. So the console is required rather than
    defaulted: a default would quietly be that global one and reopen the hole.
    """
    from rich.progress import (
        BarColumn,
        MofNCompleteColumn,
        Progress,
        SpinnerColumn,
        TaskProgressColumn,
        TextColumn,
        TimeElapsedColumn,
    )

    progress = Progress(
        TextColumn("[progress.description]{task.description}"),
        SpinnerColumn(),
        BarColumn(),
        TaskProgressColumn(),
        MofNCompleteColumn(),
        TimeElapsedColumn(),
        console=console,
        transient=True,
    )
    task_id = None

    def report(done: int, total: int) -> None:
        nonlocal task_id
        if task_id is None:
            # 首次报告是在第 1 个文件处理完之后才来的：先把数据补齐再起 Live，
            # 否则第一帧写着 0/N，和上面刚打出的那行日志自相矛盾
            task_id = progress.add_task(activity, total=total, completed=done)
            progress.start()
        else:
            progress.update(task_id, completed=done)
        if done >= total:
            progress.stop()

    return report
