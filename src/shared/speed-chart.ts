import type { AnalysisSample } from "./track-analysis.js";

/** Only locally flagged spikes are excluded from the display range. */
export function speedChartMaximum(
  samples: readonly Pick<AnalysisSample, "speed" | "speed_spike">[],
): number {
  const valid = samples.filter(
    (p) => p.speed !== null && Number.isFinite(p.speed),
  );
  const normal = valid.filter((p) => !p.speed_spike);
  return Math.max(0, ...(normal.length ? normal : valid).map((p) => p.speed!));
}
