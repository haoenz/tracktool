"""Archive reads and validated project persistence at the drawing boundary."""

import re
import threading
from collections import OrderedDict
from pathlib import Path

from .drawing.geometry import geojson
from .drawing.state import validate_state
from .errors import UserInputError
from .kml import index, storage
from .kml.archive_reader import open_archive
from .kml.trackdata import KmlTrackData


class MapWorkspace:
    """Bounded compact-array cache. Style/camera changes never call this layer."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.cache: OrderedDict[tuple, tuple[KmlTrackData, str, int]] = OrderedDict()
        self.points = 0

    @staticmethod
    def _path(path: str) -> Path:
        if not path:
            raise UserInputError("请先选择 SQLite 归档")
        return storage.database_path(path)

    def catalog(self, path: str) -> dict:
        resolved = self._path(path)
        with open_archive(resolved) as archive:
            entries = archive.list_entries()
        return {
            "archive": str(resolved),
            "entries": [
                {
                    "entry": e.path,
                    "name": e.name,
                    "kind": e.kind.value if e.kind else "Unknown",
                    "date": match[0] if (match := re.search(r"\d{4}-\d{2}-\d{2}", e.name)) else "",
                }
                for e in entries
            ],
        }

    def selection(self, path: str, entries: list[str], expected: dict[str, str] | None = None) -> dict:
        if not isinstance(entries, list) or len(entries) > 200 or any(not isinstance(e, str) for e in entries):
            raise UserInputError("每次最多选择 200 条完整归档路径")
        if len(set(entries)) != len(entries):
            raise UserInputError("选择中有重复归档路径")
        resolved = self._path(path)
        expected = expected or {}
        tracks, errors = [], []
        selected_points = 0
        with self.lock, open_archive(resolved) as archive:
            for entry in entries:
                try:
                    key = (str(resolved), archive.fingerprint(entry), index.PARSER_VERSION)
                    if key not in self.cache:
                        data, fingerprint = archive.read_track_data_with_fingerprint(entry, max_bytes=128 * 1024 * 1024)
                        count = sum(len(s.longitude) for t in data.tracks for s in t.segments)
                        if count > 2_000_000:
                            raise UserInputError("单条轨迹超过 200 万点，请先拆分后再选择")
                        while self.cache and (self.points + count > 2_000_000 or len(self.cache) >= 128):
                            self.points -= self.cache.popitem(last=False)[1][2]
                        self.cache[key] = (data, fingerprint, count)
                        self.points += count
                    self.cache.move_to_end(key)
                    data, fingerprint, count = self.cache[key]
                    selected_points += count
                    if selected_points > 2_000_000:
                        raise UserInputError("本次选择超过 200 万点，请减少所选轨迹")
                    if entry in expected and fingerprint != expected[entry]:
                        raise UserInputError("源内容已变化；请重新选择该轨迹并保存为新项目")
                    tracks.append(
                        {
                            "entry": entry,
                            "sha256": fingerprint,
                            "points": count,
                            "geojson": geojson((s.longitude, s.latitude) for t in data.tracks for s in t.segments),
                        }
                    )
                except UserInputError as exc:
                    errors.append({"entry": entry, "error": str(exc)})
        return {"archive": str(resolved), "tracks": tracks, "errors": errors}

    def project(self, value: dict) -> tuple[dict, dict]:
        state = validate_state(value)
        if not state["archive"]:
            if state["tracks"]:
                raise UserInputError("项目有轨迹但没有归档引用")
            return state, {"tracks": [], "errors": []}
        selected = self.selection(
            state["archive"], [t["entry"] for t in state["tracks"]], {t["entry"]: t["sha256"] for t in state["tracks"]}
        )
        return state, selected

    def save(self, name: str, value: dict) -> None:
        state, selected = self.project(value)
        if selected["errors"]:
            raise UserInputError("源轨迹缺失或变化，不能保存项目")
        storage.save_project(self._path(state["archive"]), name, state)

    def load(self, path: str, name: str) -> tuple[dict, dict]:
        state = storage.load_project(self._path(path), name)
        state["archive"] = str(self._path(path))
        return self.project(state)

    def projects(self, path: str) -> list[str]:
        return storage.project_names(self._path(path))
