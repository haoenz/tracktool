"""Read-only archive ↔ drawing orchestration; no archive writes or collection access."""

import re
import threading
from collections import OrderedDict
from pathlib import Path

from .drawing.geometry import geojson
from .drawing.state import validate_state
from .errors import UserInputError
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
            raise UserInputError("请先选择归档 ZIP")
        return Path(path).expanduser().resolve()

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
            raise UserInputError("每次最多选择 200 条完整 ZIP 路径")
        if len(set(entries)) != len(entries):
            raise UserInputError("选择中有重复 ZIP 路径")
        resolved = self._path(path)
        expected = expected or {}
        tracks, errors = [], []
        selected_points = 0
        with self.lock, open_archive(resolved) as archive:
            archive.list_entries()  # Reject an ambiguous directory even with cached geometry.
            stat = resolved.stat()
            signature = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
            for entry in entries:
                try:
                    key = (str(resolved), signature, entry)
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
            after = resolved.stat()
            if signature != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise UserInputError("读取期间归档发生变化，请停止其他归档写入后重试")
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
