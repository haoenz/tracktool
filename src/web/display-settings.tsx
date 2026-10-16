import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  GripVertical,
  Link,
  Unlink,
} from "lucide-react";
import { Button, Space } from "./components/controls.js";
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
}) {
  const [dragging, setDragging] = useState<string>(),
    [limit, setLimit] = useState(100),
    [notice, setNotice] = useState("");
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
  function connect(from: string, to: string, value: boolean) {
    onChange({
      ...settings,
      connections: [
        ...settings.connections.filter((e) => e.from !== from || e.to !== to),
        { from, to, connect: value },
      ],
    });
  }
  function reorder(id: string, to: string) {
    const fromIndex = settings.order.indexOf(id),
      toIndex = settings.order.indexOf(to);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    const order = [...settings.order];
    order.splice(fromIndex, 1);
    order.splice(toIndex, 0, id);
    const connections = settings.connections.filter(
      (e) => order.indexOf(e.from) < order.indexOf(e.to),
    );
    onChange({ ...settings, order, connections });
    setNotice(
      connections.length < settings.connections.length
        ? "顺序已调整；方向不再符合新顺序的连接已取消，请检查地图。"
        : "顺序已调整。",
    );
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
      <p>
        拖动排列片段，点击眼睛显示或隐藏，点击片段间的连接按钮切换连线。只改变展示，原始轨迹数据保留。
      </p>
      <fieldset disabled={busy} className="min-w-0 space-y-3">
        <Space wrap>
          <Button disabled={visible.length < 2} onClick={() => batch(true)}>
            全部连接
          </Button>
          <Button onClick={() => batch(false)}>全部断开</Button>
        </Space>
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        <ol className="space-y-2" aria-label="显示片段列表">
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
                  className={`rounded-md border p-2 ${selected === id ? "border-primary bg-accent" : "border-border"} ${hidden ? "opacity-50" : ""} ${dragging === id ? "ring-2 ring-primary" : ""}`}
                >
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`拖动${name(id)}`}
                      className="touch-none cursor-grab shrink-0"
                      onPointerDown={(e) => {
                        if (busy) return;
                        setDragging(id);
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }}
                      onPointerCancel={() => setDragging(undefined)}
                      onPointerUp={(e) => {
                        if (dragging) {
                          const to = document
                            .elementFromPoint(e.clientX, e.clientY)
                            ?.closest<HTMLElement>("[data-display-segment]")
                            ?.dataset.displaySegment;
                          if (to) reorder(dragging, to);
                        }
                        setDragging(undefined);
                      }}
                    >
                      <GripVertical size={16} />
                    </Button>
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
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`上移${name(id)}`}
                      disabled={!i}
                      onClick={() => reorder(id, settings.order[i - 1]!)}
                    >
                      <ArrowUp size={16} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`下移${name(id)}`}
                      disabled={i === settings.order.length - 1}
                      onClick={() => reorder(id, settings.order[i + 1]!)}
                    >
                      <ArrowDown size={16} />
                    </Button>
                  </div>
                </div>
                {next && (
                  <div className="py-1 pl-8">
                    <Button
                      variant="ghost"
                      aria-label={`${name(id)}与${name(next)}${connected(id, next) ? "已连接" : "未连接"}`}
                      aria-pressed={connected(id, next)}
                      onClick={() => connect(id, next, !connected(id, next))}
                    >
                      {connected(id, next) ? (
                        <Link size={14} />
                      ) : (
                        <Unlink size={14} />
                      )}
                      {connected(id, next) ? "已连接" : "未连接"} · 到
                      {name(next)}
                    </Button>
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
        <span className="mr-auto text-sm">
          {dirty ? "未保存修改" : "已保存"}
        </span>
        <Button
          disabled={busy || !dirty}
          onClick={() => {
            onDiscard();
            setNotice("");
          }}
        >
          放弃修改
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
