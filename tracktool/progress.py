"""Parallel batch processing with a rich progress bar.

A ThreadPoolExecutor (I/O-bound workload) with a thread-safe progress counter.
Single-item inputs skip the progress display entirely.
"""

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
)

DEFAULT_WORKERS = 5  # mirrors the original ThrottleLimit


def run_parallel[T, R](
    items: list[T],
    fn: Callable[[T], R],
    activity: str = "Processing",
    parallel: bool = False,
) -> list[R]:
    """Apply fn to every item, in parallel when beneficial.

    Returns results in input order. `parallel` selects DEFAULT_WORKERS threads
    over a single worker; a single item is executed directly without a
    progress bar, matching the original fast path.
    """
    workers = DEFAULT_WORKERS if parallel else 1
    if not items:
        return []

    def progress_factory() -> Progress:
        return Progress(
            TextColumn("[progress.description]{task.description}"),
            SpinnerColumn(),
            BarColumn(),
            TaskProgressColumn(),
            MofNCompleteColumn(),
            TimeElapsedColumn(),
            console=None,
            transient=True,
        )

    def sequential() -> list[R]:
        if len(items) == 1:
            return [fn(items[0])]
        with progress_factory() as progress:
            task = progress.add_task(activity, total=len(items))
            results = []
            for item in items:
                results.append(fn(item))
                progress.advance(task)
            return results

    if workers <= 1 or len(items) == 1:
        return sequential()

    with progress_factory() as progress:
        task = progress.add_task(activity, total=len(items))

        def wrapped(item: T) -> R:
            result = fn(item)
            progress.advance(task)
            return result

        with ThreadPoolExecutor(max_workers=workers) as pool:
            return list(pool.map(wrapped, items))
