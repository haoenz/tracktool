"""Colored console logging built on rich, mirroring Write-Log semantics.

Levels (decreasing verbosity): DEBUG, VERBOSE, INFO, WARNING, ERROR.
A message is shown when its level is >= the configured level. -v enables
VERBOSE, -vv enables DEBUG.
"""

from __future__ import annotations

import sys

from rich.console import Console
from rich.theme import Theme

from .config import LEVELS, config

_THEME = Theme({
    "log.debug": "grey58",
    "log.verbose": "cyan",
    "log.info": "green",
    "log.warning": "yellow",
    "log.error": "bold red",
})

_console = Console(stderr=True, theme=_THEME)
_threshold = config.log_level


def set_level(level: str) -> None:
    global _threshold
    level = level.upper()
    if level not in LEVELS:
        raise ValueError(f"Unknown log level: {level}")
    _threshold = level


def _should_print(level: str) -> bool:
    return LEVELS.index(level) >= LEVELS.index(_threshold)


def log(message: str, level: str = "INFO", target: str | None = None) -> None:
    """Log a message; `target` prefixes the message like the PowerShell -Target."""
    if not _should_print(level):
        return
    text = f"[{target}] {message}" if target else message
    _console.print(f"[log.{level.lower()}]{text}[/log.{level.lower()}]")


def debug(message: str, target: str | None = None) -> None:
    log(message, "DEBUG", target)


def verbose(message: str, target: str | None = None) -> None:
    log(message, "VERBOSE", target)


def info(message: str, target: str | None = None) -> None:
    log(message, "INFO", target)


def warning(message: str, target: str | None = None) -> None:
    log(message, "WARNING", target)


def error(message: str, target: str | None = None) -> None:
    log(message, "ERROR", target)


def console() -> Console:
    """Shared console for user-facing output (tables, progress) on stdout."""
    return _console


def is_stderr_tty() -> bool:
    return sys.stderr.isatty()
