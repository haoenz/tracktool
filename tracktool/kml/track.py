"""The track as a value: points in time, and the question asked of them.

A KML track is a sequence of points, each with the moment it was recorded.
Loading one pairs the when[] and coord[] lists strictly — a KML whose lists
disagree in length is broken, and saying so at load time beats an index
slipping one position later. The one question a geotagging rule asks —
"which point is closest to this moment?" — is answered by `nearest`, which
keeps the binary search and its duration logic in one place.
"""

from bisect import bisect_left
from dataclasses import dataclass
from datetime import UTC, datetime

from ..errors import UserInputError
from . import xmlutil

# 2bulu 导出的时间戳形态（gx:when 文本）
_TIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


@dataclass(frozen=True)
class TrackPoint:
    """A place on the ground, recorded at a moment."""

    latitude: float
    longitude: float
    altitude: float
    time: datetime


@dataclass(frozen=True)
class TrackMatch:
    """The point a moment lands on, and how good the landing is."""

    point: TrackPoint
    seconds_from_nearest: float
    inside_duration: bool


@dataclass(frozen=True)
class Track:
    """One KML track: its name and its points in time order."""

    name: str
    points: tuple[TrackPoint, ...]

    @classmethod
    def from_kml(cls, tree: xmlutil.etree._ElementTree, name: str) -> Track:
        """Read every gx:coord/when pair of the document, strictly paired."""
        coord_texts = [(node.text or "").strip() for node in xmlutil.findall(tree, "//gx:coord")]
        when_texts = [(node.text or "").strip() for node in xmlutil.findall(tree, "//kml:when")]
        if len(coord_texts) != len(when_texts):
            raise UserInputError(
                f"KML track has {len(coord_texts)} coordinate(s) but {len(when_texts)} timestamp(s): {name}")

        points: list[TrackPoint] = []
        for coord_text, when_text in zip(coord_texts, when_texts, strict=True):
            if not coord_text and not when_text:
                continue
            parts = coord_text.split()
            if len(parts) < 2:
                raise UserInputError(f"KML track has a malformed coordinate {coord_text!r}: {name}")
            try:
                time = datetime.strptime(when_text, _TIME_FORMAT).replace(tzinfo=UTC)
            except ValueError as exc:
                raise UserInputError(f"KML track has a malformed timestamp {when_text!r}: {name}") from exc
            # gx:coord 是 "lon lat alt"，第三段（海拔）可能缺省
            longitude, latitude = float(parts[0]), float(parts[1])
            altitude = float(parts[2]) if len(parts) > 2 else 0.0
            points.append(TrackPoint(latitude, longitude, altitude, time))
        return cls(name, tuple(points))

    def nearest(self, time: datetime) -> TrackMatch | None:
        """The point closest in time, or None when the track has no points.

        A moment strictly inside the recording wins immediately; otherwise the
        caller decides whether the closest out-of-duration point is close enough.
        """
        times = [point.time for point in self.points]
        if not times:
            return None

        # 等价于 [Array]::BinarySearch：找到第一个 >= time 的位置
        insert_index = bisect_left(times, time)
        inside_duration = times[0] <= time <= times[-1]
        if insert_index == len(times):
            index = len(times) - 1
        elif insert_index > 0 and time - times[insert_index - 1] < times[insert_index] - time:
            index = insert_index - 1
        else:
            index = insert_index

        point = self.points[index]
        return TrackMatch(point, abs((time - point.time).total_seconds()), inside_duration)
