import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "./components/controls.js";
import { api } from "./api.js";
import type { OverviewEntry } from "../shared/overview.js";
import type {
  AnalysisMetric,
  AnalysisSample,
  TrackAnalysis,
} from "../shared/track-analysis.js";

export type AnalysisOverlay = {
  key: string;
  metric: AnalysisMetric | "original";
  analysis: TrackAnalysis;
  sample?: AnalysisSample;
};
const number = (n: number | null | undefined, unit = "", digits = 1) =>
  n == null
    ? "无数据"
    : `${n.toLocaleString("zh-CN", { maximumFractionDigits: digits })}${unit}`;
export function duration(seconds: number | null | undefined) {
  if (seconds == null) return "无数据";
  const s = Math.round(seconds);
  return s >= 3600
    ? `${Math.floor(s / 3600)}小时${Math.floor((s % 3600) / 60)}分`
    : `${Math.floor(s / 60)}分${s % 60}秒`;
}
const date = (ms: number | null | undefined) =>
  ms == null
    ? "无数据"
    : new Date(ms).toLocaleString("zh-CN", { hour12: false });
const unit = (metric: AnalysisMetric) => (metric === "speed" ? "km/h" : "m");
export function metricRange(
  data: TrackAnalysis,
  metric: AnalysisMetric,
): [number, number] | undefined {
  const values = data.samples.flatMap((p) =>
    p[metric] === null ? [] : [p[metric]!],
  );
  if (!values.length) return undefined;
  return [Math.min(...values), Math.max(...values)];
}
function Stats({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="analysis-stat-list">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
export function TrackInsights({
  entry,
  scope,
  active,
  onOverlay,
  children,
}: {
  entry: OverviewEntry;
  scope: string;
  active: boolean;
  onOverlay: (value: AnalysisOverlay | undefined) => void;
  children: ReactNode;
}) {
  const [metric, setMetric] = useState<AnalysisMetric>("altitude");
  const [axis, setAxis] = useState<"distance" | "time">("distance");
  const [overlay, setOverlay] = useState<AnalysisMetric | "original">(
    "original",
  );
  const [hover, setHover] = useState<AnalysisSample>();
  const query = useQuery({
    queryKey: ["track-analysis", scope, entry.id, entry.sha256],
    queryFn: ({ signal }) =>
      api<TrackAnalysis>(
        `/api/tracks/${encodeURIComponent(entry.id)}/analysis?sha256=${entry.sha256}`,
        undefined,
        signal,
      ),
    enabled: active,
    staleTime: Infinity,
    gcTime: 60_000,
    retry: 1,
  });
  const data = query.data;
  const pendingText =
    query.isFetching || query.isPending ? "计算中..." : "计算失败";
  const distance = data?.distance_m ?? entry.distance_m;
  useEffect(() => {
    onOverlay(
      active && data
        ? {
            key: entry.id + entry.sha256,
            metric: overlay,
            analysis: data,
            sample: hover,
          }
        : undefined,
    );
    return () => onOverlay(undefined);
  }, [active, data, entry.id, entry.sha256, overlay, hover, onOverlay]);
  const currentAxis = data?.time_complete ? axis : "distance";
  const range = data && metricRange(data, metric);
  const overlayRange =
    data && overlay !== "original" ? metricRange(data, overlay) : undefined;
  const timeRows: [string, string][] = [
    ["运动耗时", duration(data?.moving_s)],
    ["平均速度", number(data?.average_kmh, " km/h")],
    ["运动平均速度", number(data?.moving_average_kmh, " km/h")],
    ["最高速度", number(data?.max_kmh, " km/h")],
  ];
  const heightRows: [string, string][] = [
    ["最高海拔", number(data?.max_altitude, " m", 0)],
    ["最低海拔", number(data?.min_altitude, " m", 0)],
    ["累计爬升", number(data?.ascent_m, " m", 0)],
    ["累计下降", number(data?.descent_m, " m", 0)],
  ];
  return (
    <>
      <div className="track-route" aria-label="起终点行政区划">
        <strong>未知</strong>
        <span aria-hidden="true">→</span>
        <strong>未知</strong>
      </div>
      <p className="analysis-muted track-route-caption">
        起点 / 终点 · 省、市、区县待补充
      </p>
      <div className="track-summary-meta">
        <span className="track-tag">{entry.tags || "未设置 tag"}</span>
      </div>
      <dl className="track-stats">
        <div>
          <dt>总里程 / km</dt>
          <dd>
            {distance === undefined
              ? data
                ? "无数据"
                : pendingText
              : number(distance / 1000)}
          </dd>
        </div>
        <div>
          <dt>耗时</dt>
          <dd>{data ? duration(data.elapsed_s) : pendingText}</dd>
        </div>
      </dl>
      <Stats
        rows={[
          ["开始时间", data ? date(data.start_ms) : pendingText],
          ["结束时间", data ? date(data.end_ms) : pendingText],
        ]}
      />
      {children}
      {!data && !query.isError && (
        <section
          className="track-analysis"
          aria-label="轨迹分析"
          aria-busy="true"
        >
          <h3>轨迹分析</h3>
          <div className="analysis-empty" role="status">
            计算中...
          </div>
        </section>
      )}
      {query.error && (
        <div role="alert">
          统计计算失败：{query.error.message}
          <Button size="sm" onClick={() => void query.refetch()}>
            重试统计
          </Button>
        </div>
      )}
      {data && (
        <>
          <details className="analysis-more">
            <summary>更多统计</summary>
            <h3>时间与速度</h3>
            <Stats rows={timeRows} />
            <h3>海拔与地形</h3>
            <Stats rows={heightRows} />
            {data.terrain ? (
              <>
                <div className="terrain-bar" aria-hidden="true">
                  {(["ascent", "descent", "flat"] as const).map((key) => (
                    <span
                      key={key}
                      className={key}
                      style={{ flexGrow: data.terrain![key] }}
                    />
                  ))}
                </div>
                <Stats
                  rows={[
                    ["爬升占比", number(data.terrain.ascent * 100, "%")],
                    ["下降占比", number(data.terrain.descent * 100, "%")],
                    ["平路占比", number(data.terrain.flat * 100, "%")],
                  ]}
                />
              </>
            ) : (
              <p className="analysis-muted">地形占比无数据</p>
            )}
          </details>
          <section className="track-analysis" aria-label="轨迹分析">
            <div className="analysis-heading">
              <h3>轨迹分析</h3>
              <div
                className="analysis-switch"
                role="group"
                aria-label="图表指标"
              >
                {(["altitude", "speed"] as const).map((value) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={metric === value ? "secondary" : "ghost"}
                    aria-pressed={metric === value}
                    onClick={() => {
                      setMetric(value);
                      setHover(undefined);
                    }}
                  >
                    {value === "altitude" ? "海拔" : "速度"}
                  </Button>
                ))}
              </div>
            </div>
            <Stats
              rows={metric === "altitude" ? heightRows : timeRows.slice(1)}
            />
            <div className="analysis-chart-controls">
              <span>{unit(metric)}</span>
              <div role="group" aria-label="图表横轴">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-pressed={currentAxis === "distance"}
                  onClick={() => setAxis("distance")}
                >
                  里程
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-pressed={currentAxis === "time"}
                  disabled={!data.time_complete || data.elapsed_s === null}
                  onClick={() => setAxis("time")}
                >
                  时间
                </Button>
              </div>
            </div>
            {range ? (
              <ProfileChart
                data={data}
                metric={metric}
                axis={currentAxis}
                hover={hover}
                onHover={setHover}
              />
            ) : (
              <div className="analysis-empty">
                没有可用的{metric === "altitude" ? "海拔" : "速度"}数据
              </div>
            )}
            <div className="analysis-hover" aria-live="polite">
              {hover ? (
                <>
                  <strong>{number(hover[metric], ` ${unit(metric)}`)}</strong>
                  <span>
                    里程 {number(hover.distance_m / 1000, " km", 2)} ·{" "}
                    {hover.time_ms === null
                      ? "无时间记录"
                      : date(hover.time_ms)}
                  </span>
                </>
              ) : (
                <span>在图表上移动、触摸或使用方向键查看轨迹位置</span>
              )}
            </div>
            <div className="analysis-overlay-controls">
              <span>地图着色</span>
              <div
                className="analysis-switch"
                role="group"
                aria-label="地图着色"
              >
                {(["original", "speed", "altitude"] as const).map((value) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={overlay === value ? "secondary" : "ghost"}
                    aria-pressed={overlay === value}
                    disabled={value !== "original" && !metricRange(data, value)}
                    onClick={() => setOverlay(value)}
                  >
                    {value === "original"
                      ? "原始"
                      : value === "speed"
                        ? "速度"
                        : "海拔"}
                  </Button>
                ))}
              </div>
            </div>
            {overlayRange && overlay !== "original" && (
              <div className="analysis-legend" aria-label="地图着色色标">
                <div />
                <span>{number(overlayRange[0], ` ${unit(overlay)}`)}</span>
                <span>{number(overlayRange[1], ` ${unit(overlay)}`)}</span>
                <small>灰色表示缺少有效数据</small>
              </div>
            )}
          </section>
          <details className="analysis-method">
            <summary>统计口径与数据说明</summary>
            <p>
              总里程包含按文件顺序连接相邻非空分段首尾点的距离。耗时为有效起止时间之差，包含中途停留和分段间隔；平均速度为总里程除以耗时。
            </p>
            <p>
              运动判定为区间速度 ≥ 1
              km/h；运动平均速度为这些区间的里程除以运动耗时。段间连接不参与运动和最高速度统计。非正或重叠时间间隔、超过
              5 分钟的采样间隔、超过 1500 km/h
              的速度不参与速度统计；这些规则不能识别所有定位漂移。
            </p>
            <p>
              最高、最低海拔取有效原始值。爬升和下降采用最多五点中值平滑、3 m
              累积阈值；地形按平滑后坡度区分，±3%
              内为平路，按有效海拔里程计算占比。这些是估算值。
            </p>
            <p>
              有效海拔里程占比：{number(data.elevation_coverage * 100, "%")}。
              {data.time_complete
                ? "时间记录完整。"
                : "部分时间缺失或顺序异常；起止时间有效时仍计算耗时。"}
              {data.excluded_speed_intervals > 0 &&
                `有 ${data.excluded_speed_intervals} 个区间不参与速度统计，运动数据仅覆盖有效区间；平均速度仍按总里程除以耗时计算。`}
            </p>
            {data.sampled && <p>图表和地图着色已抽样；统计使用完整轨迹点。</p>}
          </details>
        </>
      )}
    </>
  );
}
function ProfileChart({
  data,
  metric,
  axis,
  hover,
  onHover,
}: {
  data: TrackAnalysis;
  metric: AnalysisMetric;
  axis: "distance" | "time";
  hover?: AnalysisSample;
  onHover: (sample?: AnalysisSample) => void;
}) {
  const range = metricRange(data, metric)!;
  const width = 320,
    height = 160,
    left = 36,
    right = 310,
    top = 12,
    bottom = 130;
  const min = range[0],
    max = range[1];
  const extent = Math.max(
    axis === "distance" ? data.distance_m : (data.elapsed_s ?? 0) * 1000,
    1,
  );
  const xValue = (p: AnalysisSample) =>
    axis === "distance"
      ? p.distance_m
      : (p.time_ms ?? data.start_ms ?? 0) - (data.start_ms ?? 0);
  const x = (p: AnalysisSample) => left + (xValue(p) / extent) * (right - left);
  const y = (v: number) =>
    bottom - (max === min ? 0.5 : (v - min) / (max - min)) * (bottom - top);
  const paths = useMemo(() => {
    const groups: AnalysisSample[][] = [];
    let current: AnalysisSample[] = [];
    for (const sample of data.samples) {
      if (
        sample[metric] === null ||
        (current.length && sample.segment !== current[0]!.segment)
      ) {
        if (current.length) groups.push(current);
        current = [];
      }
      if (sample[metric] !== null) current.push(sample);
    }
    if (current.length) groups.push(current);
    return groups;
  }, [data, metric]);
  const pick = (clientX: number, rect: DOMRect) => {
    const target =
      Math.max(
        0,
        Math.min(
          1,
          (((clientX - rect.left) / rect.width) * width - left) /
            (right - left),
        ),
      ) * extent;
    let closest: AnalysisSample | undefined,
      difference = Infinity;
    for (const sample of data.samples) {
      if (Math.abs(xValue(sample) - target) < difference) {
        closest = sample;
        difference = Math.abs(xValue(sample) - target);
      }
    }
    onHover(closest);
  };
  return (
    <svg
      className="analysis-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${metric === "altitude" ? "海拔" : "速度"}变化图，横轴为${axis === "distance" ? "累计里程" : "经过时间"}`}
      tabIndex={0}
      onPointerMove={(e) =>
        pick(e.clientX, e.currentTarget.getBoundingClientRect())
      }
      onPointerDown={(e) =>
        pick(e.clientX, e.currentTarget.getBoundingClientRect())
      }
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") onHover(undefined);
      }}
      onBlur={() => onHover(undefined)}
      onKeyDown={(e) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const index = hover ? data.samples.indexOf(hover) : -1;
        const next =
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? data.samples.length - 1
              : Math.max(
                  0,
                  Math.min(
                    data.samples.length - 1,
                    index + (e.key === "ArrowRight" ? 1 : -1),
                  ),
                );
        onHover(data.samples[next]);
      }}
    >
      <title>{metric === "altitude" ? "海拔变化图" : "速度变化图"}</title>
      {[min, (min + max) / 2, max]
        .filter((v, i, all) => all.indexOf(v) === i)
        .map((value) => (
          <g key={value}>
            <line
              x1={left}
              x2={right}
              y1={y(value)}
              y2={y(value)}
              stroke="#e7ece8"
            />
            <text x={left - 5} y={y(value) + 3} textAnchor="end">
              {number(value, "", 0)}
            </text>
          </g>
        ))}
      {paths.map((points, index) => {
        const path = points
          .map(
            (p, i) =>
              `${i ? "L" : "M"}${x(p).toFixed(2)},${y(p[metric]!).toFixed(2)}`,
          )
          .join(" ");
        return (
          <g key={index}>
            {metric === "altitude" && (
              <path
                d={`${path} L${x(points.at(-1)!)},${bottom} L${x(points[0]!)},${bottom} Z`}
                fill="#2c806b18"
              />
            )}
            <path
              d={path}
              fill="none"
              stroke={metric === "altitude" ? "#2c806b" : "#3179bb"}
              strokeWidth="1.8"
            />
            {points.length === 1 && (
              <circle
                cx={x(points[0]!)}
                cy={y(points[0]![metric]!)}
                r="2"
                fill="#3179bb"
              />
            )}
          </g>
        );
      })}
      <text x={left} y="150">
        0
      </text>
      <text x={right} y="150" textAnchor="end">
        {axis === "distance"
          ? number(data.distance_m / 1000, " km")
          : duration(data.elapsed_s)}
      </text>
      {hover && (
        <g>
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={top}
            y2={bottom}
            stroke="#60756a"
            strokeDasharray="3 3"
          />
          {hover[metric] !== null && (
            <circle
              cx={x(hover)}
              cy={y(hover[metric]!)}
              r="4"
              fill="#fff"
              stroke="#2c806b"
              strokeWidth="2"
            />
          )}
        </g>
      )}
    </svg>
  );
}
