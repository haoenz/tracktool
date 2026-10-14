import type { TrackData } from "./trackdata.js";
import { AppError } from "./errors.js";
export interface NearestPoint {
  latitude: number;
  longitude: number;
  altitude: number;
  seconds: number;
  inside: boolean;
  name: string;
  time: bigint;
}
export function validateTrackOrder(data: TrackData, name: string): void {
  let previous: bigint | undefined;
  for (const feature of data.tracks)
    for (const segment of feature.segments)
      for (const time of segment.time_us ?? []) {
        if (previous !== undefined && previous > time)
          throw new AppError(
            "USER_INPUT",
            `KML timestamps are not in order: ${name}`,
          );
        previous = time;
      }
}
export function nearestPoint(
  data: TrackData,
  name: string,
  time: bigint,
  tolerance: number,
  validate = true,
): NearestPoint | undefined {
  const segments = data.tracks
    .flatMap((t) => t.segments)
    .filter((s) => s.time_us?.length);
  if (validate) validateTrackOrder(data, name);
  if (!segments.length) return undefined;
  const start = segments[0]!.time_us![0]!,
    end = segments.at(-1)!.time_us!.at(-1)!,
    inside = time >= start && time <= end;
  if (
    Number(time < start ? start - time : time > end ? time - end : 0n) / 1e6 >
    tolerance
  )
    return undefined;
  let best: NearestPoint | undefined;
  for (const s of segments) {
    const times = s.time_us!;
    let lo = 0,
      hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (times[mid]! < time) lo = mid + 1;
      else hi = mid;
    }
    let index = lo === times.length ? lo - 1 : lo;
    if (
      lo > 0 &&
      lo < times.length &&
      time - times[lo - 1]! < times[lo]! - time
    )
      index = lo - 1;
    const stamp = times[index]!,
      seconds = Number(time > stamp ? time - stamp : stamp - time) / 1e6;
    if (seconds > tolerance) continue;
    const point = {
      latitude: s.latitude[index]!,
      longitude: s.longitude[index]!,
      altitude: Number.isFinite(s.altitude?.[index]) ? s.altitude![index]! : 0,
      seconds,
      inside,
      name,
      time: stamp,
    };
    // Within one track equal distance selects the later instant, as Python bisect_left does.
    if (
      !best ||
      seconds < best.seconds ||
      (seconds === best.seconds && stamp > best.time)
    )
      best = point;
  }
  return best;
}
export function betterMatch(
  a: NearestPoint,
  b: NearestPoint | undefined,
): boolean {
  if (!b) return true;
  const left = [
      a.seconds,
      !a.inside,
      a.name,
      a.time,
      a.latitude,
      a.longitude,
      a.altitude,
    ],
    right = [
      b.seconds,
      !b.inside,
      b.name,
      b.time,
      b.latitude,
      b.longitude,
      b.altitude,
    ];
  for (let i = 0; i < left.length; i++) {
    if (left[i]! < right[i]!) return true;
    if (left[i]! > right[i]!) return false;
  }
  return false;
}
