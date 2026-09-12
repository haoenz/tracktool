"""The one place a command's dependencies are reached from.

The CLI entry point builds a single AppContext and the rest of the package
reads it here: one way to reach the config, one way to reach the metadata
backend. Before this there were two ways to reach the config — a module
singleton, plus three functions carrying an extra `cfg` argument whose only
purpose was to let a test inject one; which of the two a given function used
was historical accident rather than design.

Tests replace a whole field instead of mutating a shared object:

    monkeypatch.setattr(ctx, "config", Config(path=tmp_path / "config.json").load())
    monkeypatch.setattr(ctx, "backend", InMemoryBackend())

Replacing the field also keeps one test's state out of the next: monkeypatch
restores the attribute it patched, but would not undo writes made into the
object behind it.
"""

from dataclasses import dataclass, field

from .config import Config
from .metadata import MetadataBackend


def _exiftool_backend() -> MetadataBackend:
    """Built on first use: exiftool.py imports this module, so importing it back
    at module level would be a cycle."""
    from .exiftool import ExiftoolBackend

    return ExiftoolBackend()


@dataclass
class AppContext:
    """The dependencies one command run needs, built once at the entry point."""

    config: Config = field(default_factory=Config)
    backend: MetadataBackend = field(default_factory=_exiftool_backend)


ctx = AppContext()
