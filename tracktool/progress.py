"""Parallel batch processing with a rich progress bar.

Replaces the PowerShell ForEach-ObjectWithProgress runspace-injection machinery:
a ThreadPoolExecutor (I/O-bound workload) with a thread-safe progress counter.
Single-item inputs skip the progress display entirely, like the original.
"""

from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import TypeVar

from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
)

T = TypeVar("T")
R = TypeVar("R")

DEFAULT_WORKERS = 5  # mirrors the original ThrottleLimit


def run_parallel[T, R](
    items: list[T],
    fn: Callable[[T], R],
    workers: int = DEFAULT_WORKERS,
    activity: str = "Processing",
    show_progress: bool = True,
) -> list[R]:
    """Apply fn to every item, in parallel when beneficial.

    Returns results in input order. A single item is executed directly without
    a progress bar, matching the original fast path.
    """
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
        if not show_progress:
            return [fn(item) for item in items]
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
