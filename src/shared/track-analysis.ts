export type AnalysisMetric = "altitude" | "speed";
export type AnalysisSample = {
  segment: number;
  longitude: number;
  latitude: number;
  distance_m: number;
  time_ms: number | null;
  altitude: number | null;
  speed_spike?: boolean; // Local statistical speed outlier; display only.
  speed: number | null; // km/h, preceding interval within this segment
};
export type TrackAnalysis = {
  distance_m: number;
  points: number;
  segments: number;
  start_ms: number | null;
  end_ms: number | null;
  elapsed_s: number | null;
  moving_s: number | null;
  average_kmh: number | null;
  moving_average_kmh: number | null;
  max_kmh: number | null;
  min_altitude: number | null;
  max_altitude: number | null;
  ascent_m: number | null;
  descent_m: number | null;
  terrain: { ascent: number; descent: number; flat: number } | null;
  elevation_coverage: number;
  time_complete: boolean;
  time_issues: { missing: boolean; duplicate: boolean; reversed: boolean };
  excluded_speed_intervals: number;
  sampled: boolean;
  samples: AnalysisSample[];
};
