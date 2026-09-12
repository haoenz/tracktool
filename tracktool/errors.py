"""The error contract the CLI honours.

Every failure the user can act on derives from AppError: it carries the exit
code for its kind of failure, so cli_main reports it as a single log line
instead of a traceback. Any exception that is not an AppError is a bug and
keeps its traceback.

UserInputError also derives from ValueError so the parsing modules can keep
reading a bad value as "try to parse it, else fall back" with a plain
`except ValueError`; the CLI keys off AppError, never off ValueError.
"""

from __future__ import annotations

# 退出码表（cli_main 与各批次命令共同维护）：
#   0  全部成功
#   1  用户输入错误——路径、坐标、时间戳、配置、KML 格式
#   2  外部工具或 API 失败——exiftool 不可用、Google 拒绝/超额
#   3  部分失败——逐文件隔离后仍有文件未处理完
EXIT_SUCCESS = 0
EXIT_USER_ERROR = 1
EXIT_TOOL_ERROR = 2
EXIT_PARTIAL = 3


class AppError(Exception):
    """An expected failure: one log line plus this exit code, no traceback."""

    exit_code: int = EXIT_USER_ERROR


class UserInputError(AppError, ValueError):
    """Bad path, coordinate, timestamp, config, or file content."""

    exit_code = EXIT_USER_ERROR


class ToolError(AppError):
    """An external tool or API is unavailable or refused the request."""

    exit_code = EXIT_TOOL_ERROR
