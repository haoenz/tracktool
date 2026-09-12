"""The one place a command's dependencies are reached from.

The CLI entry point builds a single AppContext and the rest of the package
reads it here. Before this there were two ways to reach the config — a module
singleton, plus three functions carrying an extra `cfg` argument whose only
purpose was to let a test inject one; which of the two a given function used
was historical accident rather than design.

Tests replace a whole field instead of mutating a shared object:

    monkeypatch.setattr(ctx, "config", Config(path=tmp_path / "config.json").load())

Replacing the field also keeps one test's config out of the next: monkeypatch
restores the attribute it patched, but would not undo writes made into the
object behind it.
"""

from dataclasses import dataclass, field

from .config import Config


@dataclass
class AppContext:
    """The dependencies one command run needs, built once at the entry point."""

    config: Config = field(default_factory=Config)


ctx = AppContext()
