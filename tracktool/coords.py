"""Coordinate parsing and geodesic distance.

`Coordinate.parse` is the one place that turns a user-supplied position string
into a coordinate. It accepts decimal degrees ("31.2, 121.5" or "31.2 121.5")
and DMS in every style the tools this project talks to print or accept —
deg or °, N/S/E/W and 北南东西 — so a command never has to say which format
it wants: every command accepts every format.

Nothing here parses media metadata: exiftool is read in -n mode, which already
yields signed decimals, so this parser only serves user input. Distance uses
geopy's geodesic (Karney's algorithm on the WGS84 ellipsoid).
"""

import re
from dataclasses import dataclass

from geopy.distance import geodesic

# 度(°/deg 可省略)分(')秒(") + 方向(N/S/E/W/北南东西)，两半球之间可有逗号
_DMS_PATTERN = re.compile(
    r"^\s*(\d{1,2})\s*(?:deg|°)?\s*(\d{1,2})\s*'\s*(\d{1,2}(?:\.\d+)?)\s*\"\s*([NS北南])\s*,?\s*"
    r"(\d{1,3})\s*(?:deg|°)?\s*(\d{1,2})\s*'\s*(\d{1,2}(?:\.\d+)?)\s*\"\s*([EW东西])\s*$"
)

# 十进制 "lat,lon" 或 "lat lon"
_DECIMAL_PATTERN = re.compile(r"^(-?\d+\.?\d*)\s*[,\s]\s*(-?\d+\.?\d*)$")


@dataclass(frozen=True)
class Coordinate:
    """A position in decimal degrees; the one form every consumer works with."""

    latitude: float
    longitude: float

    @classmethod
    def parse(cls, text: str) -> Coordinate | None:
        """Parse any accepted position spelling; None when nothing matches."""
        text = (text or "").strip()

        if m := _DMS_PATTERN.match(text):
            latitude = cls._dms_degrees(m[1], m[2], m[3], m[4])
            longitude = cls._dms_degrees(m[5], m[6], m[7], m[8])
            if latitude is None or longitude is None:
                return None
            return cls(latitude, longitude)

        if m := _DECIMAL_PATTERN.match(text):
            latitude, longitude = float(m[1]), float(m[2])
            if abs(latitude) > 90 or abs(longitude) > 180:
                return None
            return cls(latitude, longitude)

        return None

    @staticmethod
    def _dms_degrees(degrees: str, minutes: str, seconds: str, hemisphere: str) -> float | None:
        value = float(degrees) + float(minutes) / 60.0 + float(seconds) / 3600.0
        if hemisphere in ("S", "南", "W", "西"):
            value = -value
        return value if abs(value) <= (90 if hemisphere in ("N", "S", "北", "南") else 180) else None


def parse_coordinate(coordinate: str) -> tuple[float, float] | None:
    """(lat, lon) decimal degrees from any accepted position spelling.

    Returns None when the format is unrecognized; the caller reports it.
    """
    parsed = Coordinate.parse(coordinate)
    return (parsed.latitude, parsed.longitude) if parsed else None


def geo_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Geodesic distance between two points in meters (WGS84 ellipsoid)."""
    return geodesic((lat1, lon1), (lat2, lon2)).meters
