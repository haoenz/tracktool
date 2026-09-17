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
    "kml_zip_path": "",
    "kml_backup_dir_name": "Backup",
    "output_filters": "",
    "google_api_key": "",
}

# Valid levels in decreasing verbosity.
LEVELS = ["DEBUG", "VERBOSE", "INFO", "WARNING", "ERROR"]


def normalize(key: str, value: str) -> str:
    """Validate and canonicalize a value for `config set <key> <value>`.

    Per-key rules: log_level is uppercased and must be one of LEVELS;
    kml_zip_path is expanded to an absolute path. Other keys pass through.
    """
    if key == "log_level":
        level = value.upper()
        if level not in LEVELS:
            raise UserInputError(f"Unknown log level: {value} (one of {', '.join(LEVELS)})")
        return level
    if key == "kml_zip_path":
        return str(Path(value).expanduser().resolve())
    return value


class Config:
    """Runtime configuration with lazy loading and persisted writes."""

    def __init__(self, path: Path = CONFIG_PATH) -> None:
        self.path = path
        self._data: dict[str, Any] = dict(DEFAULTS)

    def load(self) -> Config:
        if self.path.is_file():
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise ConfigError(f"Failed to read config {display_path(self.path)}: {exc}") from exc
            if not isinstance(loaded, dict):
                raise ConfigError(f"Config {display_path(self.path)} is not a JSON object")
            self._data.update(loaded)
        return self

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
