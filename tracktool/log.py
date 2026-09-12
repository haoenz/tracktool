"""Logging via stdlib logging with rich's RichHandler.

Levels (decreasing verbosity): DEBUG, VERBOSE, INFO, WARNING, ERROR —
VERBOSE is a custom level (15) between DEBUG and INFO. -v enables VERBOSE,
-vv enables DEBUG. A message is shown when its level >= the configured level,
which stdlib logging handles natively.

Level policy:
- INFO: command-level summaries and results (counts, one-shot state changes).
- VERBOSE: per-file actions inside batch loops (moved, converted, tag writes).
- DEBUG: parsing/protocol details (tag values, timestamps, API request params).

Library helpers stay quiet about severity: a condition is logged at its
decision point by the caller that acts on it (e.g. mediatime returns None and
the caller decides whether that is a warning, an error, or ignorable).

Wording: fact before consequence ("...; file skipped", "...; keeping existing
hash"), no trailing punctuation; stored tags by EXIF tag name (GPSPosition),
concepts in plain words (GPS data).
"""

import logging

from rich.console import Console
from rich.logging import RichHandler
from rich.theme import Theme

from .config import LEVELS
from .errors import UserInputError

VERBOSE = 15  # between DEBUG (10) and INFO (20)
logging.addLevelName(VERBOSE, "VERBOSE")

_THEME = Theme({"logging.level.verbose": "cyan"})

# Shared console on stderr: keeps stdout clean for machine-readable output.
_console = Console(stderr=True, theme=_THEME)

_LEVEL_NUMBERS: dict[str, int] = {name: logging.getLevelName(name) for name in LEVELS}

_logger = logging.getLogger("tracktool")
_logger.propagate = False
_handler = RichHandler(console=_console, show_path=False, markup=False,
                       highlighter=None, rich_tracebacks=True)
_handler.setFormatter(logging.Formatter("%(message)s"))
_logger.addHandler(_handler)
_logger.setLevel(logging.INFO)


def set_level(level: str) -> None:
    level = level.upper()
    if level not in LEVELS:
        raise UserInputError(f"Unknown log level: {level}")
    _logger.setLevel(_LEVEL_NUMBERS[level])


def _log(message: str, level: str = "INFO", target: str | None = None) -> None:
    """Log a message; `target` is prefixed to the message as "[target] message"."""
    text = f"[{target}] {message}" if target else message
    _logger.log(_LEVEL_NUMBERS[level], text)


def debug(message: str, target: str | None = None) -> None:
    _log(message, "DEBUG", target)


def verbose(message: str, target: str | None = None) -> None:
    _log(message, "VERBOSE", target)


def info(message: str, target: str | None = None) -> None:
    _log(message, "INFO", target)


def warning(message: str, target: str | None = None) -> None:
    _log(message, "WARNING", target)


def error(message: str, target: str | None = None) -> None:
    _log(message, "ERROR", target)


def console() -> Console:
    """Shared console for user-facing output (tables, progress) on stderr."""
    return _console
