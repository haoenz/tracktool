import { useMemo, useState } from "react";
import { Eye, EyeOff, Link, Unlink, Plus } from "lucide-react";
import { Button } from "./components/controls.js";
import type {
  EditGeometry,
  Presentation,
  SegmentManifest,
} from "../shared/track-edit.js";

export function DisplaySettings({
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
  const visible = settings.order.filter((id) => !settings.ignored.includes(id));
  const name = (id: string) =>
    `片段 ${(segments.find((s) => s.segment_id === id)?.ordinal ?? 0) + 1}`;
  const connected = (from: string, to: string) =>
    settings.connections.find((e) => e.from === from && e.to === to)?.connect ??
    (settings.order.indexOf(to) === settings.order.indexOf(from) + 1 &&
      settings.default_connect);
  const allConnected =
    visible.length > 1 &&
    visible.slice(1).every((to, i) => connected(visible[i]!, to));
  function connect(from: string, to: string, value: boolean) {
    onChange({
      ...settings,
      connections: [
        ...settings.connections.filter((e) => e.from !== from || e.to !== to),
        { from, to, connect: value },
      ],
    });
  }
  function batch(value: boolean) {
    onChange({
      ...settings,
      default_connect: false,
      connections: value
        ? visible
            .slice(1)
            .map((to, i) => ({ from: visible[i]!, to, connect: true }))
        : [],
    });
  }
  return (
    <section aria-label="分段管理" className="space-y-3">
      <fieldset disabled={busy} className="min-w-0 space-y-3">
        <ol className="space-y-1" aria-label="显示片段列表">
          {settings.order.slice(0, limit).map((id, i) => {
            const hidden = settings.ignored.includes(id),
              segment = segments.find((s) => s.segment_id === id)!;
            const next = !hidden ? visible[visible.indexOf(id) + 1] : undefined;
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
                      <div className="ml-8 flex w-8 flex-col items-center">
                        <span
                          aria-hidden="true"
                          className="h-1 w-px bg-border"
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-6"
                          aria-label={`${name(id)}与${name(next)}${connected(id, next) ? "已连接" : "未连接"}`}
                          aria-pressed={connected(id, next)}
                          onClick={() =>
                            connect(id, next, !connected(id, next))
                          }
                        >
                          {connected(id, next) ? (
                            <Link size={14} />
                          ) : (
                            <Unlink size={14} />
                          )}
                        </Button>
                        <span
                          aria-hidden="true"
                          className="h-1 w-px bg-border"
                        />
                      </div>
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
        <Button
          className="mr-auto"
          disabled={busy || visible.length < 2}
          onClick={() => batch(!allConnected)}
        >
          {allConnected ? "全部断开" : "全部连接"}
        </Button>
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
