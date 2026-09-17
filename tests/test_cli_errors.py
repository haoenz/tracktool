"""Tests for the CLI top-level error handler: expected failures — every
AppError subclass, plus typer's own usage errors — become one clean log line
plus that error's exit code, without a traceback. Anything that is not an
AppError is a bug and keeps its traceback. External tool/API failures exit 2,
a batch that left files unprocessed exits 3."""

import sys
from pathlib import Path

import pytest
import typer
from conftest import TRACK_KML
from lxml import etree
from typer.testing import CliRunner

from tracktool import cli, exiftool
from tracktool.cli import app, cli_main
from tracktool.config import ConfigError
from tracktool.context import RunMode, ctx
from tracktool.errors import EXIT_TOOL_ERROR, AppError, ToolError, UserInputError
from tracktool.exif.write import SetExifError
from tracktool.exiftool import ExiftoolError
from tracktool.fileutil import BatchResult
from tracktool.googleapi import GoogleApiError

runner = CliRunner()


class TestCliMainHandler:
    def test_app_error_becomes_clean_exit(self, monkeypatch, capsys):
        # 命令体抛 AppError -> cli_main 记一行 error 并以该异常自带的退出码退出
        def failing_app() -> None:
            raise SetExifError("Invalid GPS position: 999 999")

        monkeypatch.setattr("tracktool.cli.app", failing_app)
        with pytest.raises(SystemExit) as exc_info:
            cli_main()
        assert exc_info.value.code == cli.EXIT_USER_ERROR == 1
        captured = capsys.readouterr()
        assert "Invalid GPS position: 999 999" in captured.err

    def test_unexpected_exception_keeps_traceback(self, monkeypatch):
        # AppError 之外的异常（真实 bug）必须原样传播，保留调试现场
        def buggy_app() -> None:
            raise IndexError("genuine bug")

        monkeypatch.setattr("tracktool.cli.app", buggy_app)
        with pytest.raises(IndexError):
            cli_main()

    def test_success_passes_through(self, monkeypatch):
        ran = []

        def working_app() -> None:
            ran.append(True)

        monkeypatch.setattr("tracktool.cli.app", working_app)
        cli_main()  # no SystemExit
        assert ran == [True]


class TestAppErrorHierarchy:
    """Exit codes live on the error classes, not on a whitelist in the CLI."""

    def test_hierarchy_encodes_the_exit_codes(self):
        assert issubclass(UserInputError, AppError)
        assert issubclass(ToolError, AppError)
        assert UserInputError.exit_code == cli.EXIT_USER_ERROR == 1
        assert ToolError.exit_code == EXIT_TOOL_ERROR == 2

    @pytest.mark.parametrize("exc", [
        ConfigError("bad config"),
        UserInputError("bad value"),
        SetExifError("bad position"),
    ])
    def test_user_errors_exit_one(self, monkeypatch, exc):
        def failing_app() -> None:
            raise exc

        monkeypatch.setattr("tracktool.cli.app", failing_app)
        with pytest.raises(SystemExit) as exc_info:
            cli_main()
        assert exc_info.value.code == cli.EXIT_USER_ERROR == 1

    @pytest.mark.parametrize("exc", [
        ExiftoolError("exiftool not found"),
        GoogleApiError("API quota exceeded"),
    ])
    def test_tool_errors_exit_two(self, monkeypatch, exc):
        def failing_app() -> None:
            raise exc

        monkeypatch.setattr("tracktool.cli.app", failing_app)
        with pytest.raises(SystemExit) as exc_info:
            cli_main()
        assert exc_info.value.code == EXIT_TOOL_ERROR == 2

    def test_help_and_version_still_work(self):
        # typer 自己的控制流（Exit）不受兜底影响
        result = runner.invoke(app, ["--version"])
        assert result.exit_code == 0
        assert "tracktool" in result.output


class TestStdlibErrorsAreNotSwallowed:
    """裸 stdlib 类型不再兜底。以前 ValueError / OSError / FileNotFoundError /
    XMLSyntaxError 都在白名单里，任何一处 stdlib 报错都会被当成「用户输入错误」
    一行带过——真 bug 因此丢掉 traceback。现在只有 AppError 派生类被折叠。"""

    @pytest.mark.parametrize("exc", [
        ValueError("bad value"),
        FileNotFoundError("missing.zip"),
        OSError("io blew up"),
        etree.XMLSyntaxError("malformed KML", 1, 1, 1),
    ])
    def test_stdlib_types_propagate(self, monkeypatch, exc):
        def failing_app() -> None:
            raise exc

        monkeypatch.setattr("tracktool.cli.app", failing_app)
        with pytest.raises(type(exc)):
            cli_main()


class TestExitCodeTable:
    """0 全成功 / 1 用户输入 / 2 外部工具或 API / 3 部分失败。"""

    @pytest.mark.parametrize("argv", [
        ["nosuchcommand"],                        # 命令名打错
        ["exif", "set", "--nonexistent-option"],  # 选项不认识
        ["exif", "set"],                          # 缺必填参数
    ])
    def test_usage_errors_fold_into_user_error(self, monkeypatch, argv):
        # typer 给用法错误留的是 2，与 EXIT_TOOL_ERROR 同值；cli_main 必须把
        # 这一来源归一成 1，否则调用方分不清「参数拼错」和「外部工具挂了」
        monkeypatch.setattr(sys, "argv", ["tracktool", *argv])
        with pytest.raises(SystemExit) as exc_info:
            cli_main()
        assert exc_info.value.code == cli.EXIT_USER_ERROR == 1

    def test_partial_batch_exits_three(self, tmp_path: Path):
        batch = BatchResult(succeeded=[None, None], failed=[tmp_path / "bad.jpg"])
        with pytest.raises(typer.Exit) as exc_info:
            cli._finish(batch)
        assert exc_info.value.exit_code == cli.EXIT_PARTIAL == 3

    def test_finished_batch_does_not_exit(self, tmp_path: Path):
        cli._finish(BatchResult(succeeded=[None]))
        cli._finish(BatchResult())  # nothing to process is still success

    def test_preview_batch_reports_the_failure_and_still_exits_three(self, tmp_path: Path,
                                                                    plan_mode, caplog):
        # 预演与退出码同属一次调用：会显示计划的命令照样要为失败的文件退 3
        batch = BatchResult(failed=[tmp_path / "bad.jpg"])
        with pytest.raises(typer.Exit) as exc_info:
            cli._finish(batch)
        assert exc_info.value.exit_code == cli.EXIT_PARTIAL
        assert "would fail" in caplog.text

    def test_all_files_failing_is_not_success(self, tmp_path: Path):
        batch = BatchResult(succeeded=[], failed=[tmp_path / f"{i}.jpg" for i in range(3)])
        with pytest.raises(typer.Exit) as exc_info:
            cli._finish(batch)
        assert exc_info.value.exit_code == cli.EXIT_PARTIAL == 3


class TestRunModeFlag:
    """--dry-run 是整次运行的模式：声明一次，写在子命令之前。"""

    @staticmethod
    def _kml(tmp_path: Path) -> str:
        kml = tmp_path / "2024-05-01 test.kml"
        kml.write_text(TRACK_KML, encoding="utf-8")
        return str(kml)

    def test_the_flag_sits_before_the_subcommand(self, tmp_path: Path):
        result = runner.invoke(app, ["--dry-run", "kml", "type", self._kml(tmp_path)])

        assert result.exit_code == 0, result.output
        assert ctx.mode is RunMode.PLAN

    def test_without_the_flag_the_run_applies(self, tmp_path: Path):
        result = runner.invoke(app, ["kml", "type", self._kml(tmp_path)])

        assert result.exit_code == 0, result.output
        assert ctx.mode is RunMode.APPLY

    def test_after_the_subcommand_it_is_a_usage_error(self, tmp_path: Path):
        result = runner.invoke(app, ["kml", "split", self._kml(tmp_path),
                                     "2024-05-01T00:01:00Z", "--dry-run"])

        assert result.exit_code != 0
        # 旧写法明确不再成立：把开关收到全局一处，代价就是这个
        assert "--dry-run" in result.output

    def test_a_command_that_never_had_the_flag_now_has_it(self, tmp_path: Path):
        result = runner.invoke(app, ["--dry-run", "kml", "split", self._kml(tmp_path),
                                     "2024-05-01T00:01:00Z"])

        assert result.exit_code == 0, result.output
        assert not (tmp_path / "2024-05-01 test-Splited-1.kml").exists()


class TestToolUnavailable:
    def test_missing_exiftool_binary_raises_tool_error(self, monkeypatch):
        # 工具不可用属于「外部工具或 API 失败」（退出 2）：subprocess 抛的是
        # FileNotFoundError（stdlib），落在旧白名单里会被误报成用户输入错误 1
        monkeypatch.setattr(exiftool, "_EXECUTABLE", "no-such-exiftool-binary")
        with pytest.raises(ExiftoolError) as exc_info:
            exiftool.invoke("-ver")
        assert exc_info.value.exit_code == EXIT_TOOL_ERROR == 2
