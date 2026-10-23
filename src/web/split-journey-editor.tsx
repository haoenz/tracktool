import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, LocateFixed, Scissors, Link } from "lucide-react";
import type { PublicConfig } from "../shared/contracts.js";
import type { SegmentManifest } from "../shared/track-edit.js";
import { Button, Input } from "./components/controls.js";
import { TagPicker } from "./components/tag-picker.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover.js";

export type SplitJourney = {
  startSegmentId: string;
  path: string;
  category: "Default" | "Train" | "Flight" | null;
  tag?: string;
};

export const journeyColors = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#9333ea",
  "#d97706",
  "#0891b2",
];

export const journeyName = (journey: SplitJourney) =>
  journey.path
    .split("/")
    .at(-1)!
    .replace(/\.kml$/i, "");

export function SplitJourneyEditor({
  journeys,
  assignments,
  segments,
  selected,
  config,
  disabled,
  error,
  onName,
  onTag,
  onSplit,
  onLocate,
  onMerge,
}: {
  journeys: SplitJourney[];
  assignments: Record<string, number>;
  segments: SegmentManifest[];
  selected: string;
  config?: PublicConfig;
  disabled: boolean;
  error: string;
  onName: (index: number, name: string) => void;
  onTag: (index: number, tag: string) => void;
  onSplit: (id: string) => void;
  onLocate: (id: string) => void;
  onMerge: (index: number) => void;
}) {
  const [tagEditor, setTagEditor] = useState<string>();
  const nameInputs = useRef(new Map<string, HTMLInputElement>());
  const pendingFocus = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    // Boundary controls disappear after use; keep keyboard focus in the affected journey.
    if (pendingFocus.current) {
      nameInputs.current.get(pendingFocus.current)?.focus();
      pendingFocus.current = undefined;
    }
  }, [journeys]);
  if (segments.length < 2)
    return (
      <div className="space-y-3 rounded-md border bg-muted/40 p-3">
        <p className="text-sm">当前只有一个片段，需先断开轨迹才能拆分行程。</p>
      </div>
    );

  return (
    <section aria-label="行程分组" className="space-y-3">
      <p className="text-xs text-muted-foreground">
        在相邻片段之间设置分界，每条行程包含一组连续片段。
        点击片段可定位，颜色与地图对应。
      </p>
      {journeys.map((journey, index) => {
        const members = segments.filter(
          (segment) => assignments[segment.segment_id] === index,
        );
        return (
          <Fragment key={journey.startSegmentId}>
            {index > 0 && (
              <div className="flex items-center gap-2">
                <span className="h-px flex-1 bg-border" />
                <Button
                  variant="ghost"
                  className="h-8 gap-1.5 text-xs text-muted-foreground"
                  aria-label={`将行程 ${index + 1} 并入上一行程`}
                  title="取消此处分界，保留上一行程的名称和标签"
                  disabled={disabled}
                  onClick={() => {
                    setTagEditor(undefined);
                    pendingFocus.current = journeys[index - 1]!.startSegmentId;
                    onMerge(index);
                  }}
                >
                  <Link className="size-3.5" />
                  并入上一行程
                </Button>
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            <section
              aria-label={`行程 ${index + 1}`}
              className="min-w-0 overflow-hidden rounded-md border"
            >
              <div className="space-y-2 p-3">
                <div className="flex items-center gap-2 text-sm">
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor:
                        journeyColors[index % journeyColors.length],
                    }}
                  />
                  <h3 className="font-medium">行程 {index + 1}</h3>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {members.length} 个片段 ·{" "}
                    {members.reduce(
                      (sum, segment) => sum + segment.point_count,
                      0,
                    )}{" "}
                    点
                  </span>
                </div>
                <Input
                  ref={(input) => {
                    if (input)
                      nameInputs.current.set(journey.startSegmentId, input);
                    else nameInputs.current.delete(journey.startSegmentId);
                  }}
                  aria-label={`行程 ${index + 1} 名称`}
                  placeholder="行程名称"
                  value={journeyName(journey)}
                  disabled={disabled}
                  onChange={(event) => onName(index, event.target.value)}
                />
                <Popover
                  open={tagEditor === journey.startSegmentId}
                  onOpenChange={(open) =>
                    setTagEditor(open ? journey.startSegmentId : undefined)
                  }
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      className="h-8 w-full justify-between px-2 text-xs"
                      aria-label={`行程 ${index + 1} 活动标签`}
                      disabled={disabled || !config}
                    >
                      <span className="text-muted-foreground">活动标签</span>
                      <span className="ml-auto truncate">
                        {journey.tag ?? "选择标签"}
                      </span>
                      <ChevronDown className="size-3.5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    className="w-72 max-w-[calc(100vw-2rem)] p-3"
                  >
                    <TagPicker
                      config={config}
                      value={journey.tag}
                      ariaLabel={`行程 ${index + 1} 活动标签`}
                      onChange={(value) => {
                        onTag(index, value);
                        setTagEditor(undefined);
                      }}
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <ul className="border-t" aria-label={`行程 ${index + 1} 片段`}>
                {members.map((segment, memberIndex) => (
                  <Fragment key={segment.segment_id}>
                    {memberIndex > 0 && (
                      <li className="flex items-center gap-2 px-3">
                        <span className="flex-1 border-t border-dashed" />
                        <Button
                          variant="ghost"
                          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
                          aria-label={`在片段 ${members[memberIndex - 1]!.ordinal + 1} 与片段 ${segment.ordinal + 1} 之间拆分`}
                          disabled={disabled}
                          onClick={() => {
                            setTagEditor(undefined);
                            pendingFocus.current = segment.segment_id;
                            onSplit(segment.segment_id);
                          }}
                        >
                          <Scissors className="size-3.5" />
                          在此拆分
                        </Button>
                        <span className="flex-1 border-t border-dashed" />
                      </li>
                    )}
                    <li
                      className={`flex min-w-0 items-center gap-2 p-2 ${selected === segment.segment_id ? "bg-accent" : ""}`}
                    >
                      <Button
                        variant="ghost"
                        className="h-auto w-full min-w-0 justify-start gap-2 px-2 py-1.5 text-left"
                        aria-label={`定位片段 ${segment.ordinal + 1}`}
                        aria-pressed={selected === segment.segment_id}
                        disabled={disabled}
                        onClick={() => onLocate(segment.segment_id)}
                      >
                        <LocateFixed className="size-4 text-muted-foreground" />
                        <span>
                          片段 {segment.ordinal + 1}
                          <span className="block text-xs font-normal text-muted-foreground">
                            {segment.point_count} 点
                          </span>
                        </span>
                      </Button>
                    </li>
                  </Fragment>
                ))}
              </ul>
            </section>
          </Fragment>
        );
      })}
      <p className="text-xs text-muted-foreground" role="status">
        {segments.length} 个片段 ·{" "}
        {journeys.length > 1
          ? `将拆分为 ${journeys.length} 条行程`
          : "尚未设置分界"}
      </p>
      {error && (
        <p role="status" className="text-xs text-muted-foreground">
          {error}
        </p>
      )}
    </section>
  );
}
