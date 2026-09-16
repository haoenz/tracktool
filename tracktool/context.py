"""The one place a command's dependencies are reached from.

The CLI entry point triggers the assembly of a single AppContext and the rest
of the package reads it here: one way to reach the config, one way to reach the
metadata backend, one way to reach a progress reporter. Before this there were
two ways to reach the config — a module singleton, plus three functions carrying
an extra `cfg` argument whose only purpose was to let a test inject one;
which of the two a given function used was historical accident rather than
design.

This module is also the composition root. Naming the adapters is what puts it
above them in the import contract, not below: `context` builds `exiftool`, so
`context` may import `exiftool`, and the adapter takes what it needs from the
config through its constructor instead of reaching back up. The backend is
built around the same Config instance the rest of the package reads, so loading
the config file reaches the adapter too.

Tests replace a whole field instead of mutating a shared object:

    monkeypatch.setattr(ctx, "config", Config(path=tmp_path / "config.json").load())
    monkeypatch.setattr(ctx, "backend", InMemoryBackend())

Replacing the field also keeps one test's state out of the next: monkeypatch
restores the attribute it patched, but would not undo writes made into the
object behind it.
"""

from collections.abc import Callable
from dataclasses import dataclass

from .config import Config
from .exiftool import ExiftoolBackend
from .metadata import MetadataBackend
from .progress import rich_reporter

# 执行层调它拿进度回调；画什么由入口层决定
Reporter = Callable[[str], Callable[[int, int], None]]


@dataclass
class AppContext:
    """The dependencies one command run needs, built once at the entry point."""

    config: Config
    backend: MetadataBackend
    reporter: Reporter


def build_context() -> AppContext:
    """Assemble a context around the real adapters, over one Config instance."""
    config = Config()
    return AppContext(config=config, backend=ExiftoolBackend(config), reporter=rich_reporter)


ctx = build_context()
