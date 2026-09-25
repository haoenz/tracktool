"""Tests for dedup, config, and Set-Exif tag building."""

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from tracktool import dedup
from tracktool.cli import app
from tracktool.config import Config, normalize
from tracktool.context import ctx
from tracktool.discover import list_files
from tracktool.errors import UserInputError
from tracktool.exif.write import SetExifError, SetExifOptions, build_position_params, build_tags

runner = CliRunner()


class TestListFiles:
    def test_a_directory_yields_only_media(self, tmp_path: Path):
        # 真实照片目录混入 .txt / .DS_Store 是常态，目录目标只收已知媒体扩展名
        (tmp_path / "a.jpg").touch()
        (tmp_path / "notes.txt").touch()
        (tmp_path / ".DS_Store").touch()
        (tmp_path / "b.arw").touch()

        assert list_files(tmp_path) == [tmp_path / "a.jpg", tmp_path / "b.arw"]

    def test_a_named_file_is_kept_whatever_it_is(self, tmp_path: Path):
        # 用户点名什么就处理什么，扩展名拦不住显式路径
        txt = tmp_path / "notes.txt"
        txt.touch()

        assert list_files(txt) == [txt]

    def test_an_explicit_list_is_handed_back_verbatim(self, tmp_path: Path):
        chosen = [tmp_path / "x.jpg", tmp_path / "y.txt"]
        assert list_files(chosen) == chosen

    def test_a_missing_path_raises(self, tmp_path: Path):
        with pytest.raises(UserInputError, match="does not exist"):
            list_files(tmp_path / "nope")


class TestBuildPositionParams:
    def test_decimal_2bulu_style(self):
        tags = build_position_params("39.908333 116.391389")
        assert tags["GPSLatitude"] == "39.908333"
        assert tags["GPSLatitudeRef"] == "N"
        assert tags["GPSLongitudeRef"] == "E"

    def test_negative_decimal(self):
        tags = build_position_params("-33.865 151.209")
        assert tags["GPSLatitude"] == "33.865"
        assert tags["GPSLatitudeRef"] == "S"

    def test_invalid_raises(self):
        with pytest.raises(SetExifError):
            build_position_params("999 999")

    def test_dms_exif_style(self):
        tags = build_position_params("39°54'30\"N, 116°23'29\"E")
        assert float(tags["GPSLatitude"]) == pytest.approx(39 + 54 / 60 + 30 / 3600)
        assert tags["GPSLatitudeRef"] == "N"
        assert float(tags["GPSLongitude"]) == pytest.approx(116 + 23 / 60 + 29 / 3600)
        assert tags["GPSLongitudeRef"] == "E"

    def test_dms_deg_style(self):
        tags = build_position_params("39deg 54'30\"N, 116deg 23'29\"E")
        assert float(tags["GPSLatitude"]) == pytest.approx(39 + 54 / 60 + 30 / 3600)
        assert tags["GPSLatitudeRef"] == "N"

    def test_google_earth_chinese(self):
        tags = build_position_params("39°54'30\" 北 116°23'29\" 东")
        assert float(tags["GPSLatitude"]) == pytest.approx(39 + 54 / 60 + 30 / 3600)
        assert tags["GPSLatitudeRef"] == "N"
        assert tags["GPSLongitudeRef"] == "E"

    def test_comma_decimal(self):
        tags = build_position_params("39.908333, 116.391389")
        assert tags["GPSLatitude"] == "39.908333"
        assert tags["GPSLongitudeRef"] == "E"


class TestBuildTags:
    def test_altitude_sign(self):
        positive = build_tags(SetExifOptions(altitude=100))
        negative = build_tags(SetExifOptions(altitude=-50))
        assert positive["GPSAltitudeRef"] == "Above Sea Level"
        assert negative["GPSAltitudeRef"] == "Below Sea Level"
        assert negative["GPSAltitude"] == "50"

    def test_tags_are_handed_over_verbatim(self):
        # overwrite 不在标签里：它是 write_tags 的开关，由后端负责参数化
        tags = build_tags(SetExifOptions(tags={"IPTC:City": "Beijing"}))
        assert tags["IPTC:City"] == "Beijing"


class TestConfig:
    def test_defaults_and_roundtrip(self, tmp_path: Path):
        cfg = Config(path=tmp_path / "config.json")
        cfg.load()
        assert cfg["log_level"] == "INFO"
        cfg["kml_backup_dir_name"] = "Old"
        cfg.save()
        reloaded = Config(path=tmp_path / "config.json").load()
        assert reloaded["kml_backup_dir_name"] == "Old"

    def test_backup_dir_name_falls_back_to_the_default(self, tmp_path: Path):
        # 未设与空值都读作默认值：调用方不再各自决定「没有」是什么意思
        cfg = Config(path=tmp_path / "config.json").load()
        assert cfg.kml_backup_dir_name == "Backup"
        cfg["kml_backup_dir_name"] = ""
        assert cfg.kml_backup_dir_name == "Backup"
        cfg["kml_backup_dir_name"] = "Old"
        assert cfg.kml_backup_dir_name == "Old"

    def test_output_filters_compile_once_and_follow_a_change(self, tmp_path: Path):
        cfg = Config(path=tmp_path / "config.json").load()
        assert cfg.output_filters == ()

        cfg["output_filters"] = "ARW|JPG"
        compiled = cfg.output_filters
        assert [pattern.pattern for pattern in compiled] == ["ARW", "JPG"]
        assert cfg.output_filters is compiled  # 编译一次，不是每次读取重编

        cfg["output_filters"] = "TIF"
        assert [pattern.pattern for pattern in cfg.output_filters] == ["TIF"]

    def test_api_key_env_priority(self, tmp_path: Path, monkeypatch):
        monkeypatch.setenv("TRACKTOOL_GOOGLE_API_KEY", "env-key")
        cfg = Config(path=tmp_path / "config.json").load()
        cfg["google_api_key"] = "file-key"
        assert cfg.google_api_key() == "env-key"
        assert cfg.google_api_key("param-key") == "env-key"
        monkeypatch.delenv("TRACKTOOL_GOOGLE_API_KEY")
        assert cfg.google_api_key() == "file-key"
        assert cfg.google_api_key("param-key") == "param-key"


class TestLegacyKeyMigration:
    """kml_zip_path（ZIP 文件）-> archive_path（归档目录）在 load 时平移一次。"""

    def _load(self, tmp_path: Path, content: dict) -> tuple[Config, Path]:
        path = tmp_path / "config.json"
        path.write_text(json.dumps(content), encoding="utf-8")
        cfg = Config(path=path).load()
        return cfg, path

    def test_old_key_is_moved_to_the_parent_directory(self, tmp_path: Path):
        cfg, path = self._load(tmp_path, {"kml_zip_path": str(tmp_path / "arch" / "Archive.zip")})

        assert cfg["archive_path"] == str(tmp_path / "arch")
        stored = json.loads(path.read_text(encoding="utf-8"))
        assert "kml_zip_path" not in stored
        assert stored["archive_path"] == str(tmp_path / "arch")

    def test_an_old_key_that_is_there_twice_keeps_the_new_value(self, tmp_path: Path):
        cfg, path = self._load(tmp_path, {"kml_zip_path": str(tmp_path / "a.zip"),
                                          "archive_path": str(tmp_path / "b")})

        assert cfg["archive_path"] == str(tmp_path / "b")
        stored = json.loads(path.read_text(encoding="utf-8"))
        assert "kml_zip_path" not in stored

    def test_an_empty_old_key_migrates_to_an_empty_new_one(self, tmp_path: Path):
        cfg, _ = self._load(tmp_path, {"kml_zip_path": ""})
        assert cfg["archive_path"] == ""

    def test_a_file_without_the_old_key_is_left_alone(self, tmp_path: Path):
        cfg, _ = self._load(tmp_path, {"log_level": "DEBUG"})
        assert cfg["archive_path"] == ""
        assert cfg["log_level"] == "DEBUG"


class TestNormalize:
    def test_log_level_is_uppercased_and_validated(self):
        assert normalize("log_level", "debug") == "DEBUG"
        with pytest.raises(UserInputError, match="Unknown log level"):
            normalize("log_level", "LOUD")

    def test_archive_path_becomes_absolute(self, tmp_path: Path):
        assert normalize("archive_path", str(tmp_path / "x")) == str(tmp_path / "x")
        assert Path(normalize("archive_path", "~/tracks")).is_absolute()

    def test_other_keys_pass_through(self):
        assert normalize("kml_backup_dir_name", "Old") == "Old"
        assert normalize("output_filters", "ARW|JPG") == "ARW|JPG"


class TestConfigSetCommand:
    """`config set` 是唯一的写入入口：校验、归一化、拒绝未知键都在这一层。"""

    def _install(self, tmp_path: Path, monkeypatch) -> Path:
        path = tmp_path / "config.json"
        cfg = Config(path=path).load()
        cfg.save()  # 落一份默认配置：拒绝路径下文件应保持原样
        monkeypatch.setattr(ctx, "config", cfg)
        return path

    def test_set_log_level(self, tmp_path: Path, monkeypatch):
        path = self._install(tmp_path, monkeypatch)
        result = runner.invoke(app, ["config", "set", "log_level", "debug"])
        assert result.exit_code == 0
        stored = json.loads(path.read_text(encoding="utf-8"))
        assert stored["log_level"] == "DEBUG"

    def test_set_archive_path_stores_absolute(self, tmp_path: Path, monkeypatch):
        path = self._install(tmp_path, monkeypatch)
        result = runner.invoke(app, ["config", "set", "archive_path", "~/tracks"])
        assert result.exit_code == 0
        stored = json.loads(path.read_text(encoding="utf-8"))
        assert Path(stored["archive_path"]).is_absolute()

    def test_invalid_log_level_exits_one_without_writing(self, tmp_path: Path, monkeypatch):
        path = self._install(tmp_path, monkeypatch)
        result = runner.invoke(app, ["config", "set", "log_level", "LOUD"])
        assert result.exit_code == 1
        stored = json.loads(path.read_text(encoding="utf-8"))
        assert stored["log_level"] == "INFO"

    def test_unknown_key_is_rejected(self, tmp_path: Path, monkeypatch):
        # 连字符 typo（log-level）不能静默产生垃圾键
        path = self._install(tmp_path, monkeypatch)
        result = runner.invoke(app, ["config", "set", "log-level", "DEBUG"])
        assert result.exit_code == 1
        stored = json.loads(path.read_text(encoding="utf-8"))
        assert "log-level" not in stored

    def test_unknown_key_rejected_even_if_already_in_file(self, tmp_path: Path, monkeypatch):
        # 合法键集合是 DEFAULTS 而非已加载数据：文件里已有的垃圾键同样放不进 config set
        path = self._install(tmp_path, monkeypatch)
        stored = json.loads(path.read_text(encoding="utf-8"))
        stored["log-level"] = "DEBUG"  # 模拟历史遗留的垃圾键
        path.write_text(json.dumps(stored), encoding="utf-8")
        monkeypatch.setattr(ctx, "config", Config(path=path).load())
        result = runner.invoke(app, ["config", "set", "log-level", "VERBOSE"])
        assert result.exit_code == 1
        assert json.loads(path.read_text(encoding="utf-8"))["log-level"] == "DEBUG"

    def test_missing_value_lists_keys(self, tmp_path: Path, monkeypatch):
        # 参数解析层的缺参报错也要带键列表，不能只剩 typer 的 usage 提示
        path = self._install(tmp_path, monkeypatch)
        result = runner.invoke(app, ["config", "set", "log_level"])
        assert result.exit_code == 1
        assert "Available keys" in str(result.exception)
        assert json.loads(path.read_text(encoding="utf-8"))["log_level"] == "INFO"

    def test_no_arguments_lists_keys(self, tmp_path: Path, monkeypatch):
        self._install(tmp_path, monkeypatch)  # 只为让键列表可查；本测试不读回文件
        result = runner.invoke(app, ["config", "set"])
        assert result.exit_code == 1
        assert "Available keys" in str(result.exception)


class TestDedup:
    def test_hash_and_compare(self, tmp_path: Path):
        dir_a = tmp_path / "a"
        dir_b = tmp_path / "b"
        dir_a.mkdir()
        dir_b.mkdir()
        (dir_a / "shared.txt").write_text("same")
        (dir_b / "shared.txt").write_text("same")
        (dir_a / "only_a.txt").write_text("a only")
        (dir_b / "only_b.txt").write_text("b only")

        result = dedup.compare_directories([dir_a, dir_b])
        only_paths = {p.name for files in result.values() for p in files}
        assert only_paths == {"only_a.txt", "only_b.txt"}

        unique = dedup.compare_directories([dir_a, dir_b], unique=True)
        unique_paths = {p.name for files in unique.values() for p in files}
        assert unique_paths == {"only_a.txt", "only_b.txt"}

    def test_hash_log_roundtrip(self, tmp_path: Path):
        directory = tmp_path / "files"
        directory.mkdir()
        (directory / "f.txt").write_text("data")
        log_path = tmp_path / "log.json"

        dedup.get_directories_hash([directory], hash_log_path=log_path)
        assert log_path.is_file()
        stored = json.loads(log_path.read_text(encoding="utf-8"))
        assert str(directory / "f.txt") in stored

        # clear log drops entries for deleted files
        (directory / "f.txt").unlink()
        dedup.prune_hash_log(log_path)
        stored = json.loads(log_path.read_text(encoding="utf-8"))
        assert str(directory / "f.txt") not in stored

    def test_find_duplicates(self, tmp_path: Path):
        directory = tmp_path / "dupes"
        directory.mkdir()
        (directory / "one.txt").write_text("same content")
        (directory / "two.txt").write_text("same content")
        (directory / "three.txt").write_text("different")

        groups = dedup.find_duplicate_files(directory)
        assert len(groups) == 1
        assert len(groups[0].files) == 2
