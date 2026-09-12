"""Configuration management.

Config lives at ~/.tracktool/config.json and keeps the same field names as the
original PowerShell module's config.json so an old config can be imported
verbatim. The Google Maps API key resolution order is: environment variable
TRACKTOOL_GOOGLE_API_KEY > CLI parameter > config file.
"""

import json
import os
from pathlib import Path
from typing import Any

CONFIG_DIR = Path.home() / ".tracktool"
CONFIG_PATH = CONFIG_DIR / "config.json"

ENV_API_KEY = "TRACKTOOL_GOOGLE_API_KEY"

DEFAULTS: dict[str, Any] = {
    "trackToolLogLevel": "INFO",
    "kmlCompressedFilePath": "",
    "kmlBackupDirName": "Backup",
    "outputFilters": "",
    "googleMapApiKey": "",
}

# Valid levels in decreasing verbosity (mirrors the PowerShell module).
LEVELS = ["DEBUG", "VERBOSE", "INFO", "WARNING", "ERROR"]


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
                raise ConfigError(f"Failed to read config {self.path}: {exc}") from exc
            if not isinstance(loaded, dict):
                raise ConfigError(f"Config {self.path} is not a JSON object")
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

    @property
    def log_level(self) -> str:
        level = str(self._data.get("trackToolLogLevel", "INFO")).upper()
        return level if level in LEVELS else "INFO"

    @property
    def output_filters(self) -> list[str]:
        raw = str(self._data.get("outputFilters", "") or "")
        return [f for f in (part.strip() for part in raw.split("|")) if f]

    # -- Google API key ------------------------------------------------------

    def google_api_key(self, override: str | None = None) -> str:
        """Resolve the Google Maps API key: env var > parameter > config."""
        key = os.environ.get(ENV_API_KEY) or override or str(self._data.get("googleMapApiKey", "") or "")
        return key.strip()

    # -- migration -----------------------------------------------------------

    def import_legacy(self, legacy_path: Path) -> None:
        """Import an original PowerShell module config.json."""
        try:
            legacy = json.loads(legacy_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ConfigError(f"Failed to read legacy config {legacy_path}: {exc}") from exc
        if not isinstance(legacy, dict):
            raise ConfigError(f"Legacy config {legacy_path} is not a JSON object")
        for key in DEFAULTS:
            if key in legacy:
                self._data[key] = legacy[key]
        self.save()


class ConfigError(Exception):
    pass


# Module-level singleton used across the app.
config = Config()
