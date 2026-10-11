"""Parallel batch processing with progress reporting.

A ThreadPoolExecutor (I/O-bound workload) with a thread-safe completion
count. Single-item inputs skip the thread pool and the reporting entirely.
What progress looks like is the caller's business: run_parallel fires an
`on_progress(done, total)` callback and never touches a console.
"""

from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Lock
from typing import TYPE_CHECKING

from rich.console import Console

if TYPE_CHECKING:
    from rich.progress import Progress, TaskID

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
    over a single worker. `on_progress(done, total)` fires at zero and per completed
    item (and a single-item fast path reports nothing at all).
    """
    if not items:
        return []
    if len(items) == 1:
        return [fn(items[0])]

    with batch_progress(len(items), on_progress) as advance:

        def wrapped(item: T) -> R:
            result = fn(item)
            advance()
            return result

        if not parallel:
            return [wrapped(item) for item in items]
        with ThreadPoolExecutor(max_workers=DEFAULT_WORKERS) as pool:
            return list(pool.map(wrapped, items))


@contextmanager
def batch_progress(total: int, on_progress: Callable[[int, int], None] | None) -> Iterator[Callable[[], None]]:
    """Show a batch before work starts, and finish only after it is committed.

    Call advance after each item. The final completion is held until the
    scope exits successfully, keeping the display alive during batch saves,
    ZIP validation and publication. Close live reporters even on interruption;
    ordinary callback reporters need no cleanup. Serialize worker reports so
    completion counts cannot arrive out of order.
    """
    done = 0
    lock = Lock()

    def advance() -> None:
        nonlocal done
        with lock:
            done += 1
            if on_progress is not None and done < total:
                on_progress(done, total)

    try:
        if on_progress is not None and total:
            on_progress(0, total)
        yield advance
        if on_progress is not None and total:
            on_progress(total, total)
    finally:
        close = getattr(on_progress, "close", None)
        if close is not None:
            close()


def rich_reporter(activity: str, *, console: Console) -> _RichReporter:
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
    return _RichReporter(progress, activity)


class _RichReporter:
    def __init__(self, progress: Progress, activity: str) -> None:
        self.progress = progress
        self.activity = activity
        self.task_id: TaskID | None = None
        self.closed = False

    def __call__(self, done: int, total: int) -> None:
        if self.task_id is None:
            self.task_id = self.progress.add_task(self.activity, total=total, completed=done)
            self.progress.start()
        else:
            self.progress.update(self.task_id, completed=done)
        if done >= total:
            self.close()

    def close(self) -> None:
        if self.task_id is not None and not self.closed:
            self.progress.stop()
            self.closed = True
