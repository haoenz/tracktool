"""Bounded single-flight scheduler; each waiter owns its own cancellation."""

import threading
import time
from collections import Counter
from collections.abc import Callable
from concurrent.futures import CancelledError, Future, TimeoutError
from dataclasses import dataclass, field

from ..errors import UserInputError


@dataclass
class Download:
    key: str
    provider: str
    run: Callable
    future: Future = field(default_factory=Future)
    consumers: dict[int, tuple[bool, Callable[[], bool]]] = field(default_factory=dict)
    running: bool = False


class Downloads:
    def __init__(self, workers: int, limits: dict[str, int], max_pending: int = 512) -> None:
        self.condition = threading.Condition()
        self.limits = limits
        self.max_pending = max_pending
        self.tasks: dict[str, Download] = {}
        self.active: Counter = Counter()
        self.stats: Counter = Counter()
        self.closed = False
        self.serial = 0
        self.export_turn = True
        self.threads = [
            threading.Thread(target=self._worker, name=f"map-tile-{i}", daemon=True) for i in range(workers)
        ]
        for thread in self.threads:
            thread.start()

    def load(self, key: str, provider: str, run: Callable, cancelled: Callable[[], bool], export: bool):
        with self.condition:
            if self.closed or cancelled():
                raise CancelledError()
            task = self.tasks.get(key)
            if task is None:
                if len(self.tasks) >= self.max_pending:
                    raise UserInputError("地图下载队列已满，请稍后重试")
                task = self.tasks[key] = Download(key, provider, run)
            else:
                self.stats["shared"] += 1
            self.serial += 1
            consumer = self.serial
            task.consumers[consumer] = (export, cancelled)
            self.condition.notify_all()
        try:
            deadline = time.monotonic() + 90
            while True:
                if cancelled():
                    raise CancelledError()
                if time.monotonic() > deadline:
                    raise UserInputError("地图下载等待超时，请重试")
                try:
                    return task.future.result(timeout=0.05)
                except TimeoutError:
                    if task.future.done():
                        raise
        finally:
            with self.condition:
                task.consumers.pop(consumer, None)
                self.condition.notify_all()

    def _next(self) -> Download | None:
        candidates = []
        for key, task in list(self.tasks.items()):
            if task.running:
                continue
            task.consumers = {k: v for k, v in task.consumers.items() if not v[1]()}
            if not task.consumers:
                task.future.cancel()
                del self.tasks[key]
                self.stats["skipped"] += 1
            elif self.active[task.provider] < self.limits.get(task.provider, self.limits["custom"]):
                candidates.append(task)
        if not candidates:
            return None
        # FIFO within each class. Alternating classes prevents starvation in either direction.
        task = next(
            (t for t in candidates if any(v[0] for v in t.consumers.values()) == self.export_turn), candidates[0]
        )
        self.export_turn = not self.export_turn
        task.running = True
        self.active[task.provider] += 1
        self.stats["started"] += 1
        return task

    def _worker(self) -> None:
        while True:
            with self.condition:
                if self.closed:
                    return
                task = self._next()
                while task is None and not self.closed:
                    self.condition.wait(0.05)
                    if not self.closed:
                        task = self._next()
                if self.closed:
                    return
            assert task is not None
            try:
                result = task.run()
            except BaseException as exc:
                task.future.set_exception(exc)
            else:
                task.future.set_result(result)
            finally:
                with self.condition:
                    self.tasks.pop(task.key, None)
                    self.active[task.provider] -= 1
                    self.condition.notify_all()

    def close(self) -> None:
        with self.condition:
            self.closed = True
            for task in self.tasks.values():
                if not task.running:
                    task.future.cancel()
            self.condition.notify_all()
        for thread in self.threads:
            thread.join()
