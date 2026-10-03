"""Configuration management.

Config lives in the project root as `config.json`. The Google Maps API key
resolution order is: environment variable TRACKTOOL_GOOGLE_API_KEY > CLI
parameter > config file.

The activity table lives here too, under the `track_tag.*` keys, because the
vocabulary is the user's and not the code's: 2bulu decides what activities a
track can be, so adding one has to be a one-line edit of data rather than a
change to the source. The keys name the three categories the *archive layout*
already uses, and their values are the activities that belong to each, so
`track_tag_map` is that same data read backwards — one table in both
directions, never two spellings of it.
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

# 活动名（TrackTags 的取值）按类别分组，键是 `track_tag.<类别>`。类别名借用归档
# 布局那三个：集合文件名（Train.kml）、ZIP 条目前缀（Train/2026-05/）和 `--type`
# 取值域都是它们，配置里不必再发明一套。
TRACK_TAG_PREFIX = "track_tag."

DEFAULTS: dict[str, Any] = {
    "log_level": "INFO",
    "archive_path": "",
    "kml_backup_dir_name": "Backup",
    "output_filters": "",
    "google_api_key": "",
    f"{TRACK_TAG_PREFIX}Default": ["默认", "徒步", "爬山", "骑行", "驾车", "摩托", "轮船", "散步"],
    f"{TRACK_TAG_PREFIX}Train": ["轨交", "缆车", "地铁", "火车"],
    f"{TRACK_TAG_PREFIX}Flight": ["飞机", "滑翔"],
}

# 三个类别名，取自上面那些键本身，因此一处拼写。kmlfile.TrackKind 是同一组名字
# 的枚举形态；config 在层序上低于 kml（kml 可以 import 它，它不能反向 import），
# 漂移由一条测试钉住，而不是由 import 保证。
TRACK_KIND_NAMES: tuple[str, ...] = tuple(
    key[len(TRACK_TAG_PREFIX) :] for key in DEFAULTS if key.startswith(TRACK_TAG_PREFIX)
)

# Valid levels in decreasing verbosity.
LEVELS = ["DEBUG", "VERBOSE", "INFO", "WARNING", "ERROR"]


def describe_keys() -> str:
    """The key list `config set` reports, with the activity table collapsed to one entry.

    The table's keys are long and their number is the user's to grow; printing
    all of them would bury the handful a reader is choosing between.
    """
    plain = sorted(key for key in DEFAULTS if not key.startswith(TRACK_TAG_PREFIX))
    return ", ".join([*plain, f"{TRACK_TAG_PREFIX}<{'|'.join(TRACK_KIND_NAMES)}>"])


def parse_tag_spec(spec: str) -> tuple[str, list[str]]:
    """Split a `track_tag.*` value into its sign and the activity names it carries.

    `+` adds to the category, `-` removes from it, no sign replaces the whole
    list, and an empty value clears it. Names are comma-separated; a blank one is
    refused rather than skipped, so a stray comma cannot pass for a name and a
    hand-typed list cannot quietly drop the activity it meant to add.
    """
    sign = spec[:1] if spec[:1] in ("+", "-") else ""
    body = spec[len(sign) :]
    if not body.strip():
        if sign:
            raise UserInputError(f"Nothing follows {sign} in: {spec!r}")
        return "", []
    names = [part.strip() for part in body.split(",")]
    if any(not name for name in names):
        raise UserInputError(f"Empty activity name in: {spec!r} (names are comma-separated)")
    return sign, list(dict.fromkeys(names))


def normalize(key: str, value: str) -> str:
    """Validate and canonicalize a value for `config set <key> <value>`.

    Per-key rules: log_level is uppercased and must be one of LEVELS;
    archive_path is expanded to an absolute path; a track_tag key only has its
    spec checked — turning `+地铁` into a list needs the table's current state,
    which is `Config.set_tag_list`'s. Other keys pass through.
    """
    if key == "log_level":
        level = value.upper()
        if level not in LEVELS:
            raise UserInputError(f"Unknown log level: {value} (one of {', '.join(LEVELS)})")
        return level
    if key == "archive_path":
        return str(Path(value).expanduser().resolve())
    if key.startswith(TRACK_TAG_PREFIX):
        category = key[len(TRACK_TAG_PREFIX) :]
        if category not in TRACK_KIND_NAMES:
            raise UserInputError(f"Unknown track category: {category} (one of {', '.join(TRACK_KIND_NAMES)})")
        parse_tag_spec(value)
        return value
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

    # -- activity table ------------------------------------------------------

    @cached_property
    def track_tag_map(self) -> dict[str, str]:
        """The activity table read backwards: activity name -> category name.

        One lookup is all a classification needs, and it is the same table the
        `config set` writes go into. A key naming no category, a value that is
        not a list, and one activity filed under two categories are errors
        rather than silent no-ops: each leaves "which category is this track"
        without a single answer.
        """
        table: dict[str, str] = {}
        for key, activities in self._data.items():
            if not key.startswith(TRACK_TAG_PREFIX):
                continue
            category = key[len(TRACK_TAG_PREFIX) :]
            if category not in TRACK_KIND_NAMES:
                raise ConfigError(f"Unknown track category in config: {key} (one of {', '.join(TRACK_KIND_NAMES)})")
            if not isinstance(activities, list):
                raise ConfigError(f"{key} must be a list of activity names")
            for activity in activities:
                name = str(activity).strip()
                if not name:
                    raise ConfigError(f"Empty activity name in {key}")
                owner = table.setdefault(name, category)
                if owner != category:
                    raise ConfigError(f'Activity "{name}" is listed under both {owner} and {category}')
        return table

    def set_tag_list(self, key: str, spec: str) -> list[str]:
        """Write one category's activity list from a `+`/`-`/replace spec.

        Adding an activity takes it out of the other categories: an activity
        belongs to one category, so re-filing one is a single command and the
        table cannot end up answering twice. Returns the category as it now
        stands, which is what the caller reports.
        """
        category = key[len(TRACK_TAG_PREFIX) :] if key.startswith(TRACK_TAG_PREFIX) else ""
        if category not in TRACK_KIND_NAMES:
            raise UserInputError(f"Unknown track category: {key} (one of {', '.join(TRACK_KIND_NAMES)})")
        sign, named = parse_tag_spec(spec)
        current = [str(activity) for activity in (self._data.get(key) or [])]
        if sign == "+":
            listed = current + [name for name in named if name not in current]
        elif sign == "-":
            listed = [name for name in current if name not in named]
        else:
            listed = list(named)
        if sign != "-":
            for other in TRACK_KIND_NAMES:
                if other == category:
                    continue
                other_key = f"{TRACK_TAG_PREFIX}{other}"
                held = [str(activity) for activity in (self._data.get(other_key) or [])]
                kept = [name for name in held if name not in named]
                if kept != held:
                    self._data[other_key] = kept
        self._data[key] = listed
        # track_tag_map 是 cached_property，但它的名字不是一个配置键，__setitem__
        # 那套「按同名键作废缓存」够不到它——这里显式作废，否则 config set 之后
        # 还在用改之前那张表
        self.__dict__.pop("track_tag_map", None)
        return listed

    # -- Google API key ------------------------------------------------------

    def google_api_key(self, override: str | None = None) -> str:
        """Resolve the Google Maps API key: env var > parameter > config."""
        key = os.environ.get(ENV_API_KEY) or override or str(self._data.get("google_api_key", "") or "")
        return key.strip()


class ConfigError(UserInputError):
    """The config file could not be read or is not a JSON object."""
