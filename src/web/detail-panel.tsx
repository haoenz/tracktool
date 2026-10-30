import type { ReactNode } from "react";
import type { OverviewEntry } from "../shared/overview.js";
import type { AnalysisSample } from "../shared/track-analysis.js";
import { Button, Spin } from "./components/controls.js";
import { TrackInsights, type AnalysisOverlay } from "./track-insights.js";

/** Detail shell: loading/error states, the insights frame and its editor slot. */
export function DetailPanel({
  hidden,
  editing,
  entry,
  scope,
  insightsActive,
  onOverlay,
  onSample,
  error,
  onRetry,
  children,
  editor,
  dialog,
}: {
  hidden: boolean;
  editing: boolean;
  entry?: OverviewEntry;
  scope: string;
  insightsActive: boolean;
  onOverlay: (value: AnalysisOverlay | undefined) => void;
  onSample?: (sample?: AnalysisSample) => void;
  error?: Error;
  onRetry: () => void;
  children: ReactNode;
  editor?: ReactNode;
  dialog?: ReactNode;
}) {
  return (
    <section hidden={hidden}>
      <div role="region" aria-label="轨迹详情">
        <div className="track-summary" hidden={editing}>
          {!entry && !error && (
            <div className="track-detail-loading" role="status">
              <Spin decorative />
              <span>正在读取轨迹详情…</span>
            </div>
          )}
          {error && (
            <p role="alert">
              {error.message}
              <Button size="sm" onClick={onRetry}>
                重试详情
              </Button>
            </p>
          )}
          {entry && (
            <TrackInsights
              key={scope + ":" + entry.id + ":" + entry.sha256}
              entry={entry}
              scope={scope}
              active={insightsActive}
              onOverlay={onOverlay}
              onSample={onSample}
            >
              {children}
            </TrackInsights>
          )}
        </div>
        {editor}
        {dialog}
      </div>
    </section>
  );
}
