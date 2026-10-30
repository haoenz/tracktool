import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, LocateFixed } from "lucide-react";
import { Button } from "./components/controls.js";
import type { AltitudePreview } from "../shared/track-edit.js";

type Point = AltitudePreview["points"][number];
export type AltitudeGroup = {
  segment_id: string;
  segment_ordinal: number;
  whole: boolean;
  points: Point[];
};
const PAGE = 200;

/** Missing-height rows can reach tens of thousands; render a page at a time. */
export function AltitudePreviewTable({
  groups,
  onLocate,
}: {
  groups: AltitudeGroup[];
  onLocate: (point: Point) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [limits, setLimits] = useState<Record<string, number>>({});
  return (
    <div className="max-h-72 overflow-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-muted">
          <tr>
            <th className="w-10 p-2">
              <span className="sr-only">定位</span>
            </th>
            <th className="p-2 text-left">经度</th>
            <th className="p-2 text-left">纬度</th>
            <th className="p-2 text-left">高程</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const folded = groups.length > 1 && !!collapsed[group.segment_id];
            const limit = limits[group.segment_id] ?? PAGE;
            return (
              <Fragment key={group.segment_id}>
                {groups.length > 1 && (
                  <tr className="border-t bg-muted/60">
                    <th colSpan={4} className="p-0">
                      <button
                        type="button"
                        className="flex w-full items-center gap-1 p-2 text-left font-medium"
                        aria-expanded={!folded}
                        onClick={() =>
                          setCollapsed((value) => ({
                            ...value,
                            [group.segment_id]: !value[group.segment_id],
                          }))
                        }
                      >
                        {folded ? (
                          <ChevronRight className="size-4" />
                        ) : (
                          <ChevronDown className="size-4" />
                        )}
                        段 {group.segment_ordinal + 1}
                        {group.whole ? "（整段缺失）" : "（部分缺失）"} ·{" "}
                        {group.points.length} 个点
                      </button>
                    </th>
                  </tr>
                )}
                {!folded && (
                  <>
                    {group.points.slice(0, limit).map((point) => (
                      <tr
                        key={`${point.segment_id}:${point.index}`}
                        className="border-t"
                      >
                        <td className="p-2">
                          <Button
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            aria-label={`定位第 ${point.index + 1} 点`}
                            title="定位"
                            onClick={() => onLocate(point)}
                          >
                            <LocateFixed className="size-4" />
                          </Button>
                        </td>
                        <td className="p-2">{point.longitude.toFixed(6)}</td>
                        <td className="p-2">{point.latitude.toFixed(6)}</td>
                        <td className="p-2">
                          {point.altitude === null
                            ? "未补齐"
                            : `${point.altitude.toFixed(2)} m`}
                        </td>
                      </tr>
                    ))}
                    {group.points.length > limit && (
                      <tr className="border-t">
                        <td className="p-2 text-center" colSpan={4}>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setLimits((value) => ({
                                ...value,
                                [group.segment_id]: limit + PAGE,
                              }))
                            }
                          >
                            显示更多（剩余 {group.points.length - limit} 个点）
                          </Button>
                        </td>
                      </tr>
                    )}
                  </>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
