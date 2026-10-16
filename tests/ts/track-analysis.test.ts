import { describe, expect, test } from "vitest";
import {
  analyzeTrack,
  ANALYSIS_PARAMS,
} from "../../src/domain/track-analysis.js";
import type { TrackData, TrackSegment } from "../../src/domain/trackdata.js";

const segment = (
  longitudes: number[],
  heights?: number[],
  seconds?: number[],
): TrackSegment => ({
  kind: "gx:Track",
  geometry_id: "",
  longitude: Float64Array.from(longitudes),
  latitude: new Float64Array(longitudes.length),
  altitude: heights ? Float64Array.from(heights) : null,
  time_us: seconds
    ? BigInt64Array.from(seconds.map((s) => BigInt(s * 1e6)))
    : null,
});
const data = (...segments: TrackSegment[]): TrackData => ({
  source: "",
  name: "",
  track_tags: "",
  start_name: "",
  end_name: "",
  tracks: [{ index: 0, placemark_id: "", name: "", segments }],
});

describe("track statistics", () => {
  test("reports each time issue independently and retains combined issues", () => {
    const issues = (times?: number[]) =>
      analyzeTrack(data(segment([0, 0.001, 0.002], undefined, times)))
        .time_issues;
    expect(issues([0, 30, 60])).toEqual({
      missing: false,
      duplicate: false,
      reversed: false,
    });
    expect(issues()).toEqual({
      missing: true,
      duplicate: false,
      reversed: false,
    });
    expect(issues([0, 0, 60])).toEqual({
      missing: false,
      duplicate: true,
      reversed: false,
    });
    expect(issues([0, -10, 60])).toEqual({
      missing: false,
      duplicate: false,
      reversed: true,
    });
    expect(
      analyzeTrack(
        data(
          segment([0, 0.001, 0.002], undefined, [10, 10, 5]),
          segment([0.003]),
        ),
      ).time_issues,
    ).toEqual({ missing: true, duplicate: true, reversed: true });
    expect(
      analyzeTrack(
        data(
          segment([0, 0.001], undefined, [0, 30]),
          segment([0.002, 0.003], undefined, [20, 60]),
        ),
      ).time_issues.reversed,
    ).toBe(true);
    expect(
      analyzeTrack(
        data(
          segment([0, 0.001], undefined, [0, 30]),
          segment([0.002, 0.003], undefined, [30, 60]),
        ),
      ).time_complete,
    ).toBe(true);
  });
  test("includes segment bridges in distance and elevation, but not movement", () => {
    const value = analyzeTrack(
      data(
        segment([0, 0.001], [10, 20], [0, 60]),
        segment([0.003, 0.004], [1000, 990], [3600, 3660]),
      ),
    );
    expect(value.distance_m).toBeCloseTo(445.278, 2);
    expect(value.elapsed_s).toBe(3660);
    expect(value.moving_s).toBe(120);
    expect(value.moving_average_kmh).toBeCloseTo(6.679, 2);
    expect(value.average_kmh).toBeCloseTo(0.438, 2);
    expect(value.max_kmh).toBeCloseTo(6.679, 2);
    expect(value.ascent_m).toBe(990);
    expect(value.descent_m).toBe(10);
    expect(value.terrain?.ascent).toBeCloseTo(0.5);
    expect(value.terrain?.descent).toBeCloseTo(0.5);
    expect(value.samples[2]?.speed).toBeNull();
  });
  test("bridges single-point segments across tracks and empty segments", () => {
    const input = data(segment([0], [10]), segment([]));
    input.tracks.push({
      index: 1,
      placemark_id: "",
      name: "",
      segments: [segment([0.001], [8])],
    });
    const value = analyzeTrack(input);
    expect(value.distance_m).toBeCloseTo(111.319, 2);
    expect(value.ascent_m).toBe(0);
    expect(value.descent_m).toBe(2);
    expect(value.samples.at(-1)?.distance_m).toBe(value.distance_m);
    expect(value.moving_s).toBeNull();
    expect(value.max_kmh).toBeNull();
    expect(value.terrain).toBeNull();
  });
  test("does not bridge missing endpoint heights using other known heights", () => {
    const value = analyzeTrack(
      data(segment([0], [10]), segment([0.001]), segment([0.002], [100])),
    );
    expect(value.distance_m).toBeCloseTo(222.639, 2);
    expect(value.ascent_m).toBeNull();
    expect(value.descent_m).toBeNull();
  });
  test("preserves unknown values instead of fabricating zeros", () => {
    const value = analyzeTrack(data(segment([0, 0.001, 0.002])));
    expect(value.elapsed_s).toBeNull();
    expect(value.moving_s).toBeNull();
    expect(value.max_kmh).toBeNull();
    expect(value.min_altitude).toBeNull();
    expect(value.ascent_m).toBeNull();
    expect(value.terrain).toBeNull();
    expect(
      value.samples.every((p) => p.altitude === null && p.speed === null),
    ).toBe(true);
  });
  test("distinguishes stationary intervals from absent time", () => {
    const value = analyzeTrack(
      data(segment([0, 0, 0], [10, 10, 10], [0, 30, 60])),
    );
    expect(value.elapsed_s).toBe(60);
    expect(value.moving_s).toBe(0);
    expect(value.average_kmh).toBe(0);
    expect(value.moving_average_kmh).toBeNull();
    expect(value.max_kmh).toBe(0);
  });
  test("rejects duplicate/reversed times, long gaps and implausible jumps", () => {
    for (const times of [
      [0, 0],
      [2, 1],
      [0, 301],
      [0, 0.001],
    ]) {
      const value = analyzeTrack(data(segment([0, 0.01], [0, 10], times)));
      expect(value.max_kmh).toBeNull();
      if (value.elapsed_s !== null && value.elapsed_s > 0)
        expect(value.average_kmh).toBeCloseTo(
          (value.distance_m / value.elapsed_s) * 3.6,
        );
      else expect(value.average_kmh).toBeNull();
      expect(value.moving_s).toBeNull();
      expect(value.excluded_speed_intervals).toBe(1);
    }
  });
  test("overlapping segments do not double-count moving time", () => {
    const value = analyzeTrack(
      data(
        segment([0, 0.001, 0.002], undefined, [0, 30, 60]),
        segment([0, 0.001, 0.002], undefined, [30, 60, 90]),
      ),
    );
    expect(value.time_complete).toBe(false);
    expect(value.elapsed_s).toBe(90);
    expect(value.moving_s).toBe(90);
    expect(value.excluded_speed_intervals).toBe(1);
  });
  test("valid endpoints retain elapsed time despite interior timestamp anomalies", () => {
    for (const times of [
      [0, 0, 60],
      [0, -10, 60],
    ]) {
      const value = analyzeTrack(
        data(segment([0, 0.001, 0.002], undefined, times)),
      );
      expect(value.time_complete).toBe(false);
      expect(value.elapsed_s).toBe(60);
      expect(value.average_kmh).toBeCloseTo((value.distance_m / 60) * 3.6);
      expect(value.excluded_speed_intervals).toBeGreaterThan(0);
    }
    const partial = analyzeTrack(
      data(
        segment([0, 0.001], undefined, [0, 30]),
        segment([0.002, 0.003]),
        segment([0.004, 0.005], undefined, [90, 120]),
      ),
    );
    expect(partial.time_complete).toBe(false);
    expect(partial.elapsed_s).toBe(120);
    expect(partial.average_kmh).toBeCloseTo((partial.distance_m / 120) * 3.6);
  });
  test("elapsed time distinguishes zero, reversed and missing endpoints", () => {
    expect(
      analyzeTrack(data(segment([0, 0], undefined, [10, 10]))).elapsed_s,
    ).toBe(0);
    expect(
      analyzeTrack(data(segment([0, 0], undefined, [10, 9]))).elapsed_s,
    ).toBeNull();
    for (const segments of [
      [segment([0]), segment([0, 0.001], undefined, [10, 60])],
      [segment([0, 0.001], undefined, [0, 10]), segment([0.002])],
    ])
      expect(analyzeTrack(data(...segments)).elapsed_s).toBeNull();
    expect(
      analyzeTrack(data(segment([0], undefined, [10]))).elapsed_s,
    ).toBeNull();
  });
  test("does not bridge missing heights and discloses partial coverage", () => {
    const value = analyzeTrack(
      data(segment([0, 0.001, 0.002, 0.003, 0.004], [0, 10, NaN, 100, 110])),
    );
    expect(value.ascent_m).toBeLessThan(30);
    expect(value.elevation_coverage).toBeCloseTo(0.5);
    expect(value.samples[2]?.altitude).toBeNull();
    expect(value.max_altitude).toBe(110);
  });
  test("suppresses sub-threshold height jitter without losing real cumulative climbing", () => {
    const flat = analyzeTrack(
      data(
        segment(
          [0, 0.001, 0.002, 0.003, 0.004, 0.005],
          [100, 101, 99, 100, 101, 100],
        ),
      ),
    );
    expect(flat.ascent_m).toBe(0);
    expect(flat.descent_m).toBe(0);
    const climb = analyzeTrack(
      data(segment([0, 0.001, 0.002, 0.003, 0.004], [0, 1, 2, 3, 4])),
    );
    expect(climb.ascent_m).toBeGreaterThanOrEqual(3);
  });
  test("bounds profile payload but computes statistics from every point", () => {
    const n = 20000;
    const value = analyzeTrack(
      data(segment(Array.from({ length: n }, (_, i) => i / 100000))),
    );
    expect(value.points).toBe(n);
    expect(value.samples.length).toBeLessThanOrEqual(6002);
    expect(value.samples.at(-1)?.distance_m).toBe(value.distance_m);
    expect(value.sampled).toBe(true);
    expect(value.distance_m).toBeCloseTo(22262.78, 0);
  });
});

const speedTrack = (
  speeds: number[],
  seconds = speeds.map((_, i) => i * 2),
) => {
  let lon = 0;
  const longitudes = seconds.map((time, i) => {
    if (i)
      lon += ((speeds[i]! / 3.6) * (time - seconds[i - 1]!)) / 111319.490793;
    return lon;
  });
  return segment(longitudes, undefined, seconds);
};

test("flags raw local speed outliers before profile sampling without changing statistics", () => {
  const speeds = [
    ...Array<number>(30).fill(120),
    809,
    296,
    ...Array<number>(30).fill(120),
  ];
  const track = data(speedTrack(speeds));
  const full = analyzeTrack(track);
  expect(full.samples[30]?.speed_spike).toBe(true);
  expect(full.samples[31]?.speed_spike).toBe(true);
  const sampled = analyzeTrack(track, {
    ...ANALYSIS_PARAMS,
    profile_target_points: 21,
  });
  expect(sampled.samples.find((s) => s.time_ms === 60000)?.speed_spike).toBe(
    true,
  );
  expect(sampled.max_kmh).toBe(full.max_kmh);
  expect(full.max_kmh).toBeCloseTo(809);
  expect(sampled.average_kmh).toBe(full.average_kmh);
});

test("does not infer speed outliers across segment boundaries", () => {
  const result = analyzeTrack(
    data(
      speedTrack(Array<number>(30).fill(10)),
      speedTrack(
        Array<number>(30).fill(500),
        Array.from({ length: 30 }, (_, i) => 60 + i * 2),
      ),
    ),
  );
  expect(result.samples.some((s) => s.speed_spike)).toBe(false);
});

test("detects a high observation before a recording gap using preceding context", () => {
  const speeds = [
    ...Array<number>(30).fill(118),
    498,
    ...Array<number>(30).fill(114),
  ];
  const seconds = speeds.map((_, i) =>
    i < 30 ? i * 2 : i === 30 ? 64 : 221 + (i - 31) * 2,
  );
  const result = analyzeTrack(data(speedTrack(speeds, seconds)));
  expect(result.samples[30]?.speed_spike).toBe(true);
  expect(result.samples[31]?.speed_spike).not.toBe(true);
});
