"""Coordinate parsing and geodesic distance.

parse_coordinate turns a user-supplied coordinate string into (lat, lon)
decimal degrees, accepting DMS in the styles exiftool and Google both print
(deg or °, N/S/E/W and 北南东西) as well as plain decimal "lat,lon". Distance
uses geopy's geodesic (Karney's algorithm on the WGS84 ellipsoid).

Nothing here parses media metadata: exiftool is read in -n mode, which already
yields signed decimals, so this parser only serves command-line arguments.
"""

import re

from geopy.distance import geodesic

# 度(°/deg)分(')秒(") + 方向(N/S/E/W/北南东西)
_DMS_PATTERN = re.compile(
    r"^\s*(\d{1,2})\s*(?:deg|°)\s*(\d{1,2})'\s*(\d{1,2}(?:\.\d+)?)\"\s*([NS北南])\s*,?\s*"
    r"(\d{1,3})\s*(?:deg|°)\s*(\d{1,2})'\s*(\d{1,2}(?:\.\d+)?)\"\s*([EW东西])\s*$"
)

# 十进制 "lat,lon"
_DECIMAL_PATTERN = re.compile(r"^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$")


def parse_coordinate(coordinate: str) -> tuple[float, float] | None:
    """(lat, lon) decimal degrees from a DMS or decimal string.

    Returns None when the format is unrecognized; the caller reports it.
    """
    text = (coordinate or "").strip()

    m = _DMS_PATTERN.match(text)
    if m:
        lat_deg, lat_min, lat_sec, lat_ref = float(m[1]), float(m[2]), float(m[3]), m[4]
        lon_deg, lon_min, lon_sec, lon_ref = float(m[5]), float(m[6]), float(m[7]), m[8]
        lat = lat_deg + lat_min / 60.0 + lat_sec / 3600.0
        if lat_ref in ("S", "南"):
            lat = -lat
        lon = lon_deg + lon_min / 60.0 + lon_sec / 3600.0
        if lon_ref in ("W", "西"):
            lon = -lon
        return lat, lon

    m = _DECIMAL_PATTERN.match(text)
    if m:
        return float(m[1]), float(m[2])

    return None


def geo_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Geodesic distance between two points in meters (WGS84 ellipsoid)."""
    return geodesic((lat1, lon1), (lat2, lon2)).meters
