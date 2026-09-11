"""Tests for the CLI top-level error handler (issue #2): expected domain
errors are reported as one clean log line + exit code 1, without a traceback;
unexpected exceptions keep their traceback."""

import pytest
from lxml import etree
from typer.testing import CliRunner

from tracktool.cli import app, cli_main
from tracktool.config import ConfigError
from tracktool.exif.write import SetExifError

runner = CliRunner()


class TestCliMainHandler:
    def test_domain_error_becomes_clean_exit(self, monkeypatch, capsys):
        # 命令体抛领域异常 -> cli_main 记一行 error 并以 1 退出
        def failing_app() -> None:
            raise SetExifError("Invalid GPS coordinates: 999 999")

        monkeypatch.setattr("tracktool.cli.app", failing_app)
        with pytest.raises(SystemExit) as exc_info:
            cli_main()
        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        assert "Invalid GPS coordinates: 999 999" in captured.err

    def test_unlisted_exception_keeps_traceback(self, monkeypatch):
        # 兜底白名单之外的异常（真实 bug）必须原样传播，保留调试现场
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


class TestTopLevelExceptions:
    """Each listed domain exception type is covered by the handler."""

    @pytest.mark.parametrize("exc", [
        ConfigError("bad config"),
        FileNotFoundError("missing.zip"),
        ValueError("bad value"),
        SetExifError("bad position"),
        etree.XMLSyntaxError("malformed KML", 1, 1, 1),
    ])
    def test_all_listed_types_are_caught(self, monkeypatch, exc):
        def failing_app() -> None:
            raise exc

        monkeypatch.setattr("tracktool.cli.app", failing_app)
        with pytest.raises(SystemExit) as exc_info:
            cli_main()
        assert exc_info.value.code == 1

    def test_help_and_version_still_work(self):
        # typer 自己的控制流（Exit）不受兜底影响
        result = runner.invoke(app, ["--version"])
        assert result.exit_code == 0
        assert "tracktool" in result.output
