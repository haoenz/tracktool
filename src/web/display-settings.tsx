import { useMemo, useState } from "react";
import { Eye, EyeOff, Plus } from "lucide-react";
import { Button, Select, Checkbox } from "./components/controls.js";
import type {
  EditGeometry,
  Presentation,
  SegmentManifest,
} from "../shared/track-edit.js";

export function DisplaySettings({
  showTunnels,
  onShowTunnels,
  settings,
  segments,
  geometry,
  selected,
  busy,
  dirty,
  onChange,
  onSelect,
  onSave,
  onDiscard,
  onInsert,
  insertDisabled,
}: {
  showTunnels: boolean;
  onShowTunnels: (value: boolean) => void;
  settings: Presentation;
  segments: SegmentManifest[];
  geometry?: EditGeometry;
  selected: string;
  busy: boolean;
  dirty: boolean;
  onChange: (s: Presentation) => void;
  onSelect: (id: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  onInsert: (after: string) => void;
  insertDisabled: boolean;
}) {
  const [limit, setLimit] = useState(100);
  const distances = useMemo(
    () =>
      new Map(
        geometry?.segments.map((segment) => {
          const points = segment.coordinates;
          let meters = 0;
          for (let j = 1; points && j < points.length; j++) {
            const [a, b] = [points[j - 1]!, points[j]!],
              rad = Math.PI / 180;
            const h =
              Math.sin(((b[1] - a[1]) * rad) / 2) ** 2 +
              Math.cos(a[1] * rad) *
                Math.cos(b[1] * rad) *
                Math.sin(((b[0] - a[0]) * rad) / 2) ** 2;
            meters += 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
          }
          return [segment.segment_id, meters] as const;
        }),
      ),
    [geometry],
  );
  const name = (id: string) =>
    `片段 ${(segments.find((s) => s.segment_id === id)?.ordinal ?? 0) + 1}`;
  function annotate(
    from: string,
    to: string,
    reason: "tunnel" | "other" | "unknown",
  ) {
    onChange({
      ...settings,
      gaps: [
        ...settings.gaps.filter((gap) => gap.from !== from || gap.to !== to),
        ...(reason === "unknown" ? [] : [{ from, to, reason }]),
      ],
    });
  }
  return (
    <section aria-label="分段管理" className="space-y-3">
      <Checkbox checked={showTunnels} onCheckedChange={onShowTunnels}>
        显示本行程的隧道连接线
      </Checkbox>
      <p className="text-xs text-muted-foreground">
        隧道按开关显示连接线；其他中断和未分类保持断开。显隐仅保存到应用设置。
      </p>
      <fieldset disabled={busy} className="min-w-0 space-y-3">
        <ol className="space-y-1" aria-label="显示片段列表">
          {settings.order.slice(0, limit).map((id, i) => {
            const hidden = settings.ignored.includes(id),
              segment = segments.find((s) => s.segment_id === id)!;
            const next = settings.order[i + 1];
            const points = geometry?.segments.find(
              (s) => s.segment_id === id,
            )?.coordinates;
            const meters = distances.get(id) ?? 0;
            return (
              <li key={id} data-display-segment={id}>
                <div
                  className={`rounded-md border p-2 ${selected === id ? "border-primary bg-accent" : "border-border"} ${hidden ? "opacity-50" : ""}`}
                >
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`${hidden ? "显示" : "隐藏"}${name(id)}`}
                      aria-pressed={!hidden}
                      onClick={() =>
                        onChange({
                          ...settings,
                          ignored: hidden
                            ? settings.ignored.filter((x) => x !== id)
                            : [...settings.ignored, id],
                        })
                      }
                    >
                      {hidden ? <EyeOff size={16} /> : <Eye size={16} />}
                    </Button>
                    <Button
                      className="h-auto min-w-0 flex-1 whitespace-normal justify-start text-left"
                      variant="ghost"
                      aria-pressed={selected === id}
                      onClick={() => onSelect(id)}
                    >
                      <span>
                        {name(id)}
                        {hidden && " · 已隐藏"}
                        <br />
                        <span className="text-xs text-muted-foreground">
                          {points
                            ? `${(meters / 1000).toFixed(2)} 公里 · `
                            : ""}
                          {segment.point_count} 点
                          {segment.source_kind === "hand_drawn"
                            ? " · 手绘"
                            : ""}
                        </span>
                      </span>
                    </Button>
                  </div>
                </div>
                {(next || settings.order[i + 1]) && (
                  <div className="flex items-center gap-1">
                    {next && (
                      <Select
                        aria-label={`${name(id)}与${name(next)}的中断原因`}
                        value={
                          settings.gaps.find(
                            (gap) => gap.from === id && gap.to === next,
                          )?.reason ?? "unknown"
                        }
                        options={[
                          { value: "unknown", label: "未分类" },
                          { value: "tunnel", label: "隧道" },
                          { value: "other", label: "其他中断" },
                        ]}
                        onChange={(reason: "unknown" | "tunnel" | "other") =>
                          annotate(id, next, reason)
                        }
                      />
                    )}
                    {settings.order[i + 1] && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6"
                        aria-label={`在${name(id)}与${name(settings.order[i + 1]!)}之间补绘轨迹`}
                        title={
                          dirty ? "请先保存或取消分段修改" : "插入补绘轨迹"
                        }
                        disabled={insertDisabled || dirty}
                        onClick={() => onInsert(id)}
                      >
                        <Plus size={14} />
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {limit < settings.order.length && (
          <Button onClick={() => setLimit(limit + 100)}>显示更多片段</Button>
        )}
      </fieldset>
      <div
        className="flex flex-wrap items-center gap-2 border-t bg-background py-3"
        role="group"
        aria-label="保存显示设置"
      >
        <Button disabled={busy || !dirty} onClick={onDiscard}>
          取消
        </Button>
        <Button
          variant="default"
          loading={busy}
          disabled={busy || !dirty}
          onClick={onSave}
        >
          保存
        </Button>
      </div>
    </section>
  );
}
