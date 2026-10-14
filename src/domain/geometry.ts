import { AppError } from "./errors.js";
import type { TrackData } from "./trackdata.js";
import type { Position, TrackGeoJSON } from "../shared/map.js";
// Python round uses ties-to-even; preserve the exact antimeridian tie behavior.
export function roundEven(n: number): number {
  const floor = Math.floor(n);
  return n - floor === 0.5
    ? floor % 2 === 0
      ? floor
      : floor + 1
    : Math.round(n);
}
export function geojson(data: TrackData): TrackGeoJSON {
  const lines: Position[][] = [],
    points: Position[] = [];
  for (const track of data.tracks)
    for (const s of track.segments) {
      if (s.longitude.length !== s.latitude.length)
        throw new AppError("USER_INPUT", "坐标数组长度不一致");
      const coordinates: Position[] = [];
      for (let i = 0; i < s.longitude.length; i++) {
        let lon = s.longitude[i]!;
        const lat = s.latitude[i]!;
        if (Math.abs(lat) > 85.05112878)
          throw new AppError(
            "USER_INPUT",
            "轨迹超出 Web Mercator 纬度范围 ±85.05112878°，无法完整绘制",
          );
        if (i) lon += 360 * roundEven((coordinates[i - 1]![0] - lon) / 360);
        coordinates.push([lon, lat]);
      }
      if (coordinates.length === 1) points.push(coordinates[0]!);
      else if (coordinates.length) lines.push(coordinates);
    }
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "MultiLineString", coordinates: lines },
      },
      {
        type: "Feature",
        properties: {},
        geometry: { type: "MultiPoint", coordinates: points },
      },
    ],
  };
}
