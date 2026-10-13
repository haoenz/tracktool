"""Rendering boundary: parallel coordinate arrays become segmented GeoJSON."""

from collections.abc import Iterable, Sequence

from ..errors import UserInputError


def geojson(segments: Iterable[tuple[Sequence[float], Sequence[float]]]) -> dict:
    lines, points = [], []
    for longitude, latitude in segments:
        if len(longitude) != len(latitude):
            raise UserInputError("坐标数组长度不一致")
        if any(abs(lat) > 85.05112878 for lat in latitude):
            raise UserInputError("轨迹超出 Web Mercator 纬度范围 ±85.05112878°，无法完整绘制")
        coordinates = list(zip(longitude, latitude, strict=True))
        # A singleton segment is a point, never a line to its neighbour.
        if len(coordinates) == 1:
            points.extend(coordinates)
        elif coordinates:
            # Unwrap each segment independently to avoid a line across the globe.
            unwrapped = [coordinates[0]]
            for lon, lat in coordinates[1:]:
                previous = unwrapped[-1][0]
                unwrapped.append((lon + 360 * round((previous - lon) / 360), lat))
            lines.append(unwrapped)
    return {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {}, "geometry": {"type": "MultiLineString", "coordinates": lines}},
            {"type": "Feature", "properties": {}, "geometry": {"type": "MultiPoint", "coordinates": points}},
        ],
    }
