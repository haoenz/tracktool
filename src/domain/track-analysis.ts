import type { TrackData } from "./trackdata.js";
import { distance } from "./kml-edit.js";
import type {
  AnalysisSample,
  TrackAnalysis,
} from "../shared/track-analysis.js";

// Bump for changes to algorithm semantics or persisted result format.
export const ANALYSIS_VERSION = 4;
export const ANALYSIS_PARAMS = Object.freeze({
  moving_kmh: 1,
  maximum_interval_s: 300,
  maximum_kmh: 1500,
  altitude_median_radius: 2,
  altitude_deadband_m: 3,
  flat_slope: 0.03,
  profile_target_points: 6000,
  profile_endpoint_segment_limit: 2000,
});

export type AnalysisParams = {
  readonly [K in keyof typeof ANALYSIS_PARAMS]: number;
};

const finite = (n: number | undefined): number | null =>
  n !== undefined && Number.isFinite(n) ? n : null;

/** Include endpoint bridges in distance and elevation totals, but not movement statistics. */
export function analyzeTrack(
  data: TrackData,
  params: AnalysisParams = ANALYSIS_PARAMS,
): TrackAnalysis {
  const segments = data.tracks.flatMap((t) => t.segments);
  const count = segments.reduce((n, s) => n + s.longitude.length, 0);
  const stride = Math.max(1, Math.ceil(count / params.profile_target_points));
  const result: TrackAnalysis = {
    distance_m: 0,
    points: count,
    segments: segments.length,
    start_ms: null,
    end_ms: null,
    elapsed_s: null,
    moving_s: null,
    average_kmh: null,
    moving_average_kmh: null,
    max_kmh: null,
    min_altitude: null,
    max_altitude: null,
    ascent_m: null,
    descent_m: null,
    terrain: null,
    elevation_coverage: 0,
    time_complete: count > 1,
    excluded_speed_intervals: 0,
    sampled: stride > 1,
    samples: [],
  };
  let global = 0,
    previousTime: number | null = null;
  let lastAcceptedEnd: bigint | undefined;
  let movingDistance = 0,
    movingSeconds = 0,
    validIntervals = 0;
  let elevationDistance = 0,
    ascentDistance = 0,
    descentDistance = 0,
    flatDistance = 0;
  let ascent = 0,
    descent = 0,
    elevationIntervals = 0;
  let previousEndpoint: {
    position: [number, number];
    altitude: number | null;
  } | null = null;
  for (const [segmentIndex, segment] of segments.entries()) {
    const n = segment.longitude.length;
    if (n === 0) continue;
    if (previousEndpoint) {
      result.distance_m += distance(previousEndpoint.position, [
        segment.longitude[0]!,
        segment.latitude[0]!,
      ]);
      const firstAltitude = finite(segment.altitude?.[0]);
      if (previousEndpoint.altitude !== null && firstAltitude !== null) {
        const delta = firstAltitude - previousEndpoint.altitude;
        ascent += Math.max(0, delta);
        descent += Math.max(0, -delta);
        elevationIntervals++;
      }
    }
    previousEndpoint = {
      position: [segment.longitude[n - 1]!, segment.latitude[n - 1]!],
      altitude: finite(segment.altitude?.[n - 1]),
    };
    // Median of up to five adjacent valid heights, never across missing heights.
    const smooth = (i: number): number | null => {
      if (finite(segment.altitude?.[i]) === null) return null;
      const values = [segment.altitude![i]!];
      for (const direction of [-1, 1]) {
        for (
          let step = 1;
          step <= Math.min(params.altitude_median_radius, i, n - 1 - i);
          step++
        ) {
          const value = finite(segment.altitude?.[i + direction * step]);
          if (value === null) break;
          values.push(value);
        }
      }
      values.sort((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      return values.length % 2
        ? values[middle]!
        : (values[middle - 1]! + values[middle]!) / 2;
    };
    let previousAltitude: number | null = null,
      heightAnchor: number | null = null;
    let previousSample: AnalysisSample | undefined;
    let invalidSpeedSinceSample = false,
      invalidAltitudeSinceSample = false;
    for (let i = 0; i < n; i++, global++) {
      const position: [number, number] = [
        segment.longitude[i]!,
        segment.latitude[i]!,
      ];
      const meters = i
        ? distance(
            [segment.longitude[i - 1]!, segment.latitude[i - 1]!],
            position,
          )
        : 0;
      result.distance_m += meters;
      const time = segment.time_us ? Number(segment.time_us[i]!) / 1000 : null;
      if (global === 0) result.start_ms = time;
      if (global === count - 1) result.end_ms = time;
      if (time === null || (previousTime !== null && time < previousTime))
        result.time_complete = false;
      previousTime = time;
      let speed: number | null = null;
      if (i) {
        const seconds = segment.time_us
          ? Number(segment.time_us[i]! - segment.time_us[i - 1]!) / 1e6
          : null;
        if (
          seconds !== null &&
          seconds > 0 &&
          seconds <= params.maximum_interval_s &&
          (lastAcceptedEnd === undefined ||
            segment.time_us![i - 1]! >= lastAcceptedEnd) &&
          (meters / seconds) * 3.6 <= params.maximum_kmh
        ) {
          speed = (meters / seconds) * 3.6;
          validIntervals++;
          lastAcceptedEnd = segment.time_us![i]!;
          result.max_kmh = Math.max(result.max_kmh ?? 0, speed);
          if (speed >= params.moving_kmh) {
            movingDistance += meters;
            movingSeconds += seconds;
          }
        } else {
          result.excluded_speed_intervals++;
          if (seconds !== null && seconds <= 0) result.time_complete = false;
        }
      }
      const altitude = finite(segment.altitude?.[i]);
      if (altitude !== null) {
        result.min_altitude = Math.min(
          result.min_altitude ?? altitude,
          altitude,
        );
        result.max_altitude = Math.max(
          result.max_altitude ?? altitude,
          altitude,
        );
      }
      const smoothed = smooth(i);
      if (smoothed !== null && previousAltitude !== null) {
        elevationIntervals++;
        elevationDistance += meters;
        const slope = meters > 0 ? (smoothed - previousAltitude) / meters : 0;
        if (slope > params.flat_slope) ascentDistance += meters;
        else if (slope < -params.flat_slope) descentDistance += meters;
        else flatDistance += meters;
        const delta = smoothed - heightAnchor!;
        if (Math.abs(delta) >= params.altitude_deadband_m) {
          if (delta > 0) ascent += delta;
          else descent -= delta;
          heightAnchor = smoothed;
        }
      } else heightAnchor = smoothed;
      previousAltitude = smoothed;
      if (speed === null && i > 0) invalidSpeedSinceSample = true;
      if (altitude === null) invalidAltitudeSinceSample = true;
      if (
        global % stride === 0 ||
        global === count - 1 ||
        (segments.length <= params.profile_endpoint_segment_limit &&
          (i === 0 || i === n - 1))
      ) {
        const sample: AnalysisSample = {
          segment: segmentIndex,
          longitude: position[0],
          latitude: position[1],
          distance_m: result.distance_m,
          time_ms: time,
          altitude: invalidAltitudeSinceSample ? null : altitude,
          speed: invalidSpeedSinceSample || !previousSample ? null : speed,
        };
        result.samples.push(sample);
        previousSample = sample;
        invalidSpeedSinceSample = false;
        invalidAltitudeSinceSample = false;
      }
    }
  }
  // Elapsed time only needs valid endpoints; interior anomalies affect interval statistics.
  if (
    count > 1 &&
    result.start_ms !== null &&
    result.end_ms !== null &&
    result.end_ms >= result.start_ms
  ) {
    result.elapsed_s = (result.end_ms - result.start_ms) / 1000;
    // Overall average includes stops and gaps; interval validity only affects movement statistics.
    if (result.elapsed_s > 0)
      result.average_kmh = (result.distance_m / result.elapsed_s) * 3.6;
  }
  if (validIntervals) {
    result.moving_s = movingSeconds;
    result.moving_average_kmh =
      movingSeconds > 0 ? (movingDistance / movingSeconds) * 3.6 : null;
  }
  if (elevationIntervals) {
    result.ascent_m = ascent;
    result.descent_m = descent;
  }
  if (elevationDistance > 0)
    result.terrain = {
      ascent: ascentDistance / elevationDistance,
      descent: descentDistance / elevationDistance,
      flat: flatDistance / elevationDistance,
    };
  result.elevation_coverage =
    result.distance_m > 0 ? elevationDistance / result.distance_m : 0;
  return result;
}
