"""Configuration management.

Config lives in the project root as `config.json`. The Google Maps API key
resolution order is: environment variable TRACKTOOL_GOOGLE_API_KEY > CLI
parameter > config file.
"""

import json
import os
import re
from functools import cached_property
from pathlib import Path
from typing import Any

from .errors import UserInputError
from .paths import display_path

# Anchored to the source tree, not the working directory: the settings are
# global to the tool, so a run from inside a photo folder must find the same
# file as a run from the project root.
CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.json"

ENV_API_KEY = "TRACKTOOL_GOOGLE_API_KEY"

DEFAULTS: dict[str, Any] = {
    "log_level": "INFO",
    "archive_path": "",
    "kml_backup_dir_name": "Backup",
    "output_filters": "",
    "google_api_key": "",
}

# Valid levels in decreasing verbosity.
LEVELS = ["DEBUG", "VERBOSE", "INFO", "WARNING", "ERROR"]


def normalize(key: str, value: str) -> str:
    """Validate and canonicalize a value for `config set <key> <value>`.

    Per-key rules: log_level is uppercased and must be one of LEVELS;
    archive_path is expanded to an absolute path. Other keys pass through.
    """
    if key == "log_level":
        level = value.upper()
        if level not in LEVELS:
            raise UserInputError(f"Unknown log level: {value} (one of {', '.join(LEVELS)})")
        return level
    if key == "archive_path":
        return str(Path(value).expanduser().resolve())
    return value


class Config:
    """Runtime configuration with lazy loading and persisted writes."""

    def __init__(self, path: Path = CONFIG_PATH) -> None:
        self.path = path
        self._data: dict[str, Any] = dict(DEFAULTS)

    def load(self, *, persist_migration: bool = True) -> Config:
        """Load and migrate in memory; callers can disable migration writes for previews."""
        if self.path.is_file():
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise ConfigError(f"Failed to read config {display_path(self.path)}: {exc}") from exc
            if not isinstance(loaded, dict):
                raise ConfigError(f"Config {display_path(self.path)} is not a JSON object")
            migrated = self._migrate_legacy_keys(loaded)
            self._data.update(loaded)
            if migrated and persist_migration:
                # config 在层序最底、够不着 log，所以平移不发声；效果用 config show 看
                self.save()
        return self

    def _migrate_legacy_keys(self, loaded: dict[str, Any]) -> bool:
        """kml_zip_path（ZIP 文件）-> archive_path（归档目录），读盘时平移一次。

        只在文件里真有旧键、且没有新键时动手：平移值取旧 ZIP 的父目录。返回
        是否改了内存数据，由调用方决定要不要回写。
        """
        if "kml_zip_path" not in loaded:
            return False
        if "archive_path" not in loaded:
            old = str(loaded["kml_zip_path"] or "")
            loaded["archive_path"] = str(Path(old).expanduser().resolve().parent) if old else ""
        del loaded["kml_zip_path"]
        return True

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self._data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    # -- item access ---------------------------------------------------------

    def __getitem__(self, key: str) -> Any:
        return self._data.get(key, DEFAULTS.get(key))

    def __setitem__(self, key: str, value: Any) -> None:
        self._data[key] = value
        # 派生值缓存在实例上、与配置键同名，改了来源就得作废——否则 config set
        # 之后还在用改之前编译出来的那份
        self.__dict__.pop(key, None)

    def __contains__(self, key: str) -> bool:
        return key in self._data

    def as_dict(self) -> dict[str, Any]:
        """A copy of the stored config values (defaults included)."""
        return dict(self._data)

    @property
    def log_level(self) -> str:
        level = str(self._data.get("log_level", "INFO")).upper()
        return level if level in LEVELS else "INFO"

    @property
    def kml_backup_dir_name(self) -> str:
        """The folder originals are moved into, defaulted when unset.

        `or` handles both an empty string and a missing key, so callers get a
        usable folder name instead of each deciding what "unset" means.
        """
        return str(self._data.get("kml_backup_dir_name") or DEFAULTS["kml_backup_dir_name"])

    @cached_property
    def output_filters(self) -> tuple[re.Pattern[str], ...]:
        """The ignorable-warning patterns, compiled once per Config.

        An empty value filters nothing. Compiling here rather than at each use
        is what keeps a write from recompiling the same patterns per file.
        """
        raw = str(self._data.get("output_filters", "") or "")
        return tuple(re.compile(part.strip()) for part in raw.split("|") if part.strip())

    # -- Google API key ------------------------------------------------------

    def google_api_key(self, override: str | None = None) -> str:
        """Resolve the Google Maps API key: env var > parameter > config."""
        key = os.environ.get(ENV_API_KEY) or override or str(self._data.get("google_api_key", "") or "")
        return key.strip()


class ConfigError(UserInputError):
    """The config file could not be read or is not a JSON object."""
