"""How a path reads in console output.

A path shown to the user is oriented, not spelled out. The working directory
is where the user just typed the command, so a path below it is the one they
recognize; one that climbs further up is easier to read as an absolute path
than as a ladder of `..`. Paths below the home directory take the same
shortcut through `~`.

This is how a path is *drawn*, never how it is stored: config values, the
hash log and the KML files keep the real form, so a command that writes a
path into a file must not route it through here. Nothing here touches the
file system — the comparisons are lexical.
"""

import os
from pathlib import Path

# 只剩一级 .. 时才值得用相对形式；两级以上（`..\..\a\b`）不如绝对路径好读
_MAX_PARENTS = 1


def display_path(path: str | Path) -> str:
    """The form of `path` to show: relative to the working directory, else
    below home as `~...`, else absolute."""
    relative = _relative_to_cwd(path)
    if relative is not None:
        return relative
    remainder = _below_home(path)
    if remainder is None:
        return str(Path(path).absolute())
    return str(Path("~", *remainder.parts)) if remainder.parts else "~"


def _relative_to_cwd(path: str | Path) -> str | None:
    """`path` relative to the working directory, or None when that form does
    not exist (another drive or mount) or climbs more than _MAX_PARENTS."""
    try:
        relative = os.path.relpath(path)
    except OSError, ValueError:
        # 换盘符/UNC 没有相对形式；工作目录已不存在时 relpath 同样会失败
        return None
    if sum(1 for part in Path(relative).parts if part == "..") > _MAX_PARENTS:
        return None
    return relative


def _below_home(path: str | Path) -> Path | None:
    """`path` below the home directory as a relative path, or None.

    Compared part by part instead of by relpath so that Windows case
    differences still match while the remainder keeps its own spelling.
    """
    absolute = Path(path).absolute()
    home = Path.home()
    if len(absolute.parts) < len(home.parts):
        return None
    head, tail = absolute.parts[: len(home.parts)], absolute.parts[len(home.parts) :]
    if [os.path.normcase(part) for part in head] != [os.path.normcase(part) for part in home.parts]:
        return None
    return Path(*tail)
