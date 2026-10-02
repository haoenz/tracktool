"""How a path is drawn in console output.

The rule: relative to the working directory when that form exists and climbs at
most one level, otherwise `~...` below the home directory, otherwise absolute.
Stored paths are a different matter — they keep their real form.
"""

import json
import logging
import os
from pathlib import Path

import pytest
from typer.testing import CliRunner

from tracktool import log, paths
from tracktool.cli import app
from tracktool.config import Config
from tracktool.context import ctx

runner = CliRunner()


@pytest.fixture
def fake_home(tmp_path: Path, monkeypatch) -> Path:
    """Home two levels above the working directory, so the home rule is reached
    only where the relative form would climb too far."""
    home = tmp_path.parent.parent / "fake-home"
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(Path, "home", staticmethod(lambda: home))
    monkeypatch.chdir(tmp_path)
    return home


class TestDisplayPath:
    def test_below_the_working_directory(self, tmp_path: Path, fake_home: Path):
        target = tmp_path / "work" / "a.kml"  # 不存在也照样相对：判断是纯词汇的
        assert paths.display_path(target) == str(Path("work", "a.kml"))

    def test_the_working_directory_itself(self, tmp_path: Path, fake_home: Path):
        assert paths.display_path(tmp_path) == "."

    def test_one_level_up(self, tmp_path: Path, fake_home: Path):
        assert paths.display_path(tmp_path.parent / "x.kml") == str(Path("..", "x.kml"))

    def test_two_levels_up_is_absolute(self, tmp_path: Path, fake_home: Path):
        target = tmp_path.parent.parent / "x.kml"
        assert paths.display_path(target) == str(target.absolute())

    def test_below_home_uses_a_tilde(self, fake_home: Path):
        assert paths.display_path(fake_home / "docs" / "a.kml") == str(Path("~", "docs", "a.kml"))

    def test_home_itself(self, fake_home: Path):
        assert paths.display_path(fake_home) == "~"

    def test_relative_wins_over_home_when_it_is_short_enough(self, tmp_path: Path, monkeypatch):
        # home 就在 cwd 下面时，`home\a.kml` 比 `~\a.kml` 更贴近用户当前所在的位置
        home = tmp_path / "home"
        home.mkdir()
        monkeypatch.setattr(Path, "home", staticmethod(lambda: home))
        monkeypatch.chdir(tmp_path)
        assert paths.display_path(home / "a.kml") == str(Path("home", "a.kml"))

    @pytest.mark.skipif(os.name != "nt", reason="盘符是 Windows 的概念")
    def test_another_drive_is_absolute(self, tmp_path: Path, monkeypatch):
        monkeypatch.setattr(Path, "home", staticmethod(lambda: Path("C:/Users/nobody")))
        monkeypatch.chdir(tmp_path)
        target = Path("Z:/tracks/a.kml")
        assert paths.display_path(target) == str(target)

    @pytest.mark.skipif(os.name != "nt", reason="大小写不敏感是 Windows 的行为")
    def test_home_matches_regardless_of_case(self, tmp_path: Path, monkeypatch):
        parent = tmp_path.parent.parent
        monkeypatch.setattr(Path, "home", staticmethod(lambda: parent / "FakeHome"))
        monkeypatch.chdir(tmp_path)
        assert paths.display_path(parent / "fakehome" / "a.kml") == str(Path("~", "a.kml"))

    def test_a_plain_name_is_left_alone(self, tmp_path: Path, fake_home: Path):
        assert paths.display_path("a.kml") == "a.kml"


class TestPathsInOutput:
    def test_a_log_target_is_relative(self, tmp_path: Path, fake_home: Path, caplog):
        caplog.set_level(logging.INFO)
        target = tmp_path / "work" / "a.kml"
        log.info("Archiving KML track", target=str(target))
        assert f"[{Path('work', 'a.kml')}] Archiving KML track" in caplog.text
        assert str(tmp_path) not in caplog.text

    def test_stored_paths_are_shown_verbatim(self, tmp_path: Path, monkeypatch):
        # config show 打印的就是文件里的值：忠实展示，不跟着显示规则走
        monkeypatch.setattr(ctx, "config", Config(path=tmp_path / "config.json").load())
        stored = str(tmp_path / "archive")
        ctx.config["archive_path"] = stored

        result = runner.invoke(app, ["config", "show"])

        assert result.exit_code == 0
        assert json.loads(result.output)["archive_path"] == stored
