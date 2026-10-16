/** Local statistics only: no vehicle type, speed ceiling or acceleration limit. */
export const SPEED_OUTLIER_DEFAULTS = Object.freeze({
  radius_s: 60,
  sigma: 3,
  relative_scale: 0.03,
  minimum_neighbors: 7,
  maximum_neighbors: 101,
});
export type SpeedOutlierOptions = {
  readonly [K in keyof typeof SPEED_OUTLIER_DEFAULTS]: number;
};

const median = (values: number[]) => {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2
    ? values[middle]!
    : (values[middle - 1]! + values[middle]!) / 2;
};

function runsOf(
  values: ArrayLike<number>,
  times: ArrayLike<number>,
  radius: number,
) {
  const runs: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i]) || !Number.isFinite(times[i])) {
      if (i > start) runs.push([start, i]);
      start = i + 1;
    } else if (
      i > start &&
      (times[i]! <= times[i - 1]! || times[i]! - times[i - 1]! > radius)
    ) {
      runs.push([start, i]);
      start = i;
    }
  }
  if (start < values.length) runs.push([start, values.length]);
  return runs;
}

/** Time-local Hampel test; sparse windows borrow nearest in-run observations. */
function localOutliers(
  values: ArrayLike<number>,
  times: ArrayLike<number>,
  options: SpeedOutlierOptions,
  noiseFloors?: ArrayLike<number>,
): Set<number> {
  const radius = options.radius_s * 1000;
  const runs = runsOf(values, times, radius);
  let flagged = new Set<number>();
  // Freeze each pass's reference set: results must not depend on traversal order.
  for (let pass = 0; pass < 2; pass++) {
    const next = new Set(flagged);
    for (const [begin, end] of runs) {
      const accepted: number[] = [];
      for (let i = begin; i < end; i++) if (!flagged.has(i)) accepted.push(i);
      let rank = 0;
      let left = begin,
        right = begin;
      for (let i = begin; i < end; i++) {
        while (times[i]! - times[left]! > radius) left++;
        while (right < end && times[right]! - times[i]! <= radius) right++;
        if (flagged.has(i)) continue;
        while (accepted[rank]! < i) rank++;
        const neighbors: number[] = [],
          floors: number[] = [];
        // Bound CPU for dense recordings without shrinking the time window.
        const count = Math.min(right - left, options.maximum_neighbors);
        for (let j = 0; j < count; j++) {
          const index =
            count === 1
              ? left
              : left + Math.round((j * (right - left - 1)) / (count - 1));
          if (index === i || flagged.has(index)) continue;
          neighbors.push(values[index]!);
          if (noiseFloors) floors.push(noiseFloors[index]!);
        }
        if (neighbors.length < options.minimum_neighbors) {
          // A short observation next to a gap can have too few time-window
          // neighbors even though the same run contains ample nearby context.
          // Take the closest accepted observations, never crossing a run break.
          neighbors.length = 0;
          floors.length = 0;
          let before = rank - 1,
            after = rank + 1;
          while (
            neighbors.length < options.minimum_neighbors &&
            (before >= 0 || after < accepted.length)
          ) {
            const useBefore =
              before >= 0 &&
              (after >= accepted.length ||
                times[i]! - times[accepted[before]!]! <=
                  times[accepted[after]!]! - times[i]!);
            const index = useBefore ? accepted[before--]! : accepted[after++]!;
            neighbors.push(values[index]!);
            if (noiseFloors) floors.push(noiseFloors[index]!);
          }
        }
        if (neighbors.length < options.minimum_neighbors) continue;
        const center = median(neighbors);
        const mad = median(neighbors.map((v) => Math.abs(v - center)));
        // Flat sections have zero MAD. A data-relative floor tolerates small
        // fluctuations without imposing any absolute speed/acceleration limit.
        const scale = Math.max(
          1.4826 * mad,
          Math.abs(center) * options.relative_scale,
          floors.length ? median(floors) : 0,
        );
        const tolerance = Math.max(
          options.sigma * scale,
          Number.EPSILON * Math.max(1, Math.abs(center)) * 16,
        );
        if (Math.abs(values[i]! - center) > tolerance) next.add(i);
      }
    }
    if (next.size === flagged.size) break;
    flagged = next;
  }
  return flagged;
}

/**
 * Detect local speed and rate-of-change outliers before chart sampling.
 * Missing/reversed/duplicate times and gaps longer than the radius break context.
 * A real abrupt stop/start may also be unusual; flags describe observations,
 * not proof of GPS errors. Original speeds are never modified.
 */
export function speedSpikes(
  speeds: ArrayLike<number>,
  times: ArrayLike<number>,
  options: SpeedOutlierOptions = SPEED_OUTLIER_DEFAULTS,
): Set<number> {
  const flagged = localOutliers(speeds, times, options);
  const changes = new Float64Array(speeds.length).fill(NaN);
  const floors = new Float64Array(speeds.length).fill(NaN);
  for (let i = 1; i < speeds.length; i++) {
    const seconds = (times[i]! - times[i - 1]!) / 1000;
    if (
      !Number.isFinite(speeds[i]) ||
      !Number.isFinite(speeds[i - 1]) ||
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      seconds > options.radius_s
    )
      continue;
    changes[i] = (speeds[i]! - speeds[i - 1]!) / seconds;
    floors[i] =
      (Math.max(Math.abs(speeds[i]!), Math.abs(speeds[i - 1]!)) *
        options.relative_scale) /
      seconds;
  }
  for (const i of localOutliers(changes, times, options, floors)) {
    // Attribute an unusual edge to its higher-speed endpoint, including tails
    // descending from a previously detected peak. Low-speed outliers are
    // already handled by the symmetric speed test above.
    if (changes[i]! > 0) flagged.add(i);
    else if (changes[i]! < 0) flagged.add(i - 1);
  }
  return flagged;
}
