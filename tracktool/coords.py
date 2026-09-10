"""Coordinate conversion and geodesic distance.

Ports ConvertTo-DecimalCoord (DMS -> decimal, 4 input styles including Chinese
direction letters) and Get-GeoDistance (Haversine, R = 6371000 m).
"""

from __future__ import annotations

import math
import re

from . import log

# 度(°/deg)分(')秒(") + 方向(N/S/E/W/北南东西)，输出与 PowerShell 版一致的小数位
_DMS_PATTERN = re.compile(
    r"^\s*(\d{1,2})\s*(?:deg|°)\s*(\d{1,2})'\s*(\d{1,2}(?:\.\d+)?)\"\s*([NS北南])\s*,?\s*"
    r"(\d{1,3})\s*(?:deg|°)\s*(\d{1,2})'\s*(\d{1,2}(?:\.\d+)?)\"\s*([EW东西])\s*$"
)

# Plain decimal "lat,lon"
_DECIMAL_PATTERN = re.compile(r"^-?\d+\.?\d*\s*,\s*-?\d+\.?\d*$")


def decimal_coord(coordinate: str) -> str | None:
    """Convert a DMS coordinate string to "lat,lon" with 15 decimals.

    Returns None (and logs an error) when the format is unrecognized.
    """
    if coordinate is None:
        return None
    m = _DMS_PATTERN.match(coordinate)
    if not m:
        log.error(f"Invalid coordinate format: {coordinate}")
        return None

    lat_deg, lat_min, lat_sec, lat_ref = float(m[1]), float(m[2]), float(m[3]), m[4]
    lon_deg, lon_min, lon_sec, lon_ref = float(m[5]), float(m[6]), float(m[7]), m[8]

    lat = lat_deg + lat_min / 60.0 + lat_sec / 3600.0
    if lat_ref in ("S", "南"):
        lat = -lat
    lon = lon_deg + lon_min / 60.0 + lon_sec / 3600.0
    if lon_ref in ("W", "西"):
        lon = -lon
    return f"{lat:.15f},{lon:.15f}"


def is_decimal_coord(coordinate: str) -> bool:
    return bool(_DECIMAL_PATTERN.match(coordinate or ""))


def geo_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine distance between two points in meters."""
    radius = 6371000.0
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (
        math.sin(d_lat / 2) * math.sin(d_lat / 2)
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) * math.sin(d_lon / 2)
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return radius * c
