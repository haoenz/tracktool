import { useEffect, useState } from "react";
import { Button, Checkbox, Select } from "antd";
import type { SelectedTrack } from "../shared/map.js";
import type { Presentation } from "../shared/track-edit.js";
export function ProjectPresentation({
  track,
  busy,
  onApply,
  onUpdate,
}: {
  track: SelectedTrack;
  busy: boolean;
  onApply: (settings: Presentation | null) => void;
  onUpdate: () => void;
}) {
  const [settings, setSettings] = useState(track.presentation?.settings);
  const [from, setFrom] = useState<string>(),
    [to, setTo] = useState<string>();
  const [page, setPage] = useState(0);
  useEffect(() => {
    setSettings(track.presentation?.settings);
    setPage(0);
  }, [track]);
  if (!settings || !track.reference?.entry_id || !track.presentation)
    return null;
  const label = (id: string) =>
    `段 ${(track.presentation!.segments.find((s) => s.segment_id === id)?.ordinal ?? 0) + 1}`;
  const edge = (from: string, to: string, value: string) =>
    setSettings({
      ...settings,
      connections: [
        ...settings.connections.filter((e) => e.from !== from || e.to !== to),
        ...(value === "default"
          ? []
          : [{ from, to, connect: value === "yes" }]),
      ],
    });
  const move = (id: string, delta: number) => {
    const order = [...settings.order],
      i = order.indexOf(id),
      j = i + delta;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    setSettings({
      ...settings,
      order,
      connections: settings.connections.filter(
        (e) => order.indexOf(e.from) < order.indexOf(e.to),
      ),
    });
  };
  return (
    <details className="project-presentation">
      <summary>{track.entry} · 项目段设置</summary>
      <p>仅改变当前项目。忽略中段不会自动跨接；调整顺序会移除倒向连接。</p>
      {!track.presentation.current && (
        <p>库中已有其它版本或该行程已被替代，当前项目继续使用固定历史。</p>
      )}
      <Checkbox
        checked={settings.default_connect}
        onChange={(e) =>
          setSettings({ ...settings, default_connect: e.target.checked })
        }
      >
        项目默认连接相邻段
      </Checkbox>
      {settings.order.slice(page * 100, (page + 1) * 100).map((id, index) => {
        const i = page * 100 + index,
          next = settings.order[i + 1];
        return (
          <div key={id} className="project-segment">
            <Checkbox
              checked={settings.ignored.includes(id)}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  ignored: e.target.checked
                    ? [...settings.ignored, id]
                    : settings.ignored.filter((s) => s !== id),
                })
              }
            >
              项目忽略{label(id)}
            </Checkbox>
            <Button
              size="small"
              aria-label={`项目上移${label(id)}`}
              disabled={i === 0}
              onClick={() => move(id, -1)}
            >
              上移
            </Button>
            <Button
              size="small"
              aria-label={`项目下移${label(id)}`}
              disabled={i === settings.order.length - 1}
              onClick={() => move(id, 1)}
            >
              下移
            </Button>
            {next && (
              <Select
                aria-label={`项目${label(id)}连接`}
                value={
                  settings.connections.find(
                    (e) => e.from === id && e.to === next,
                  )?.connect === undefined
                    ? "default"
                    : settings.connections.find(
                          (e) => e.from === id && e.to === next,
                        )!.connect
                      ? "yes"
                      : "no"
                }
                options={[
                  { value: "default", label: "跟随默认" },
                  { value: "yes", label: "连接下一段" },
                  { value: "no", label: "断开下一段" },
                ]}
                onChange={(v) => edge(id, next, v)}
              />
            )}
          </div>
        );
      })}
      <div className="map-actions">
        <Button disabled={!page} onClick={() => setPage(page - 1)}>
          上一页段设置
        </Button>
        <Button
          disabled={(page + 1) * 100 >= settings.order.length}
          onClick={() => setPage(page + 1)}
        >
          下一页段设置
        </Button>
      </div>
      <p>明确增加跨段连接</p>
      <Select
        aria-label="项目跨接起段"
        placeholder="起段"
        value={from}
        options={settings.order.map((id) => ({ value: id, label: label(id) }))}
        onChange={setFrom}
      />
      <Select
        aria-label="项目跨接终段"
        placeholder="终段"
        value={to}
        options={settings.order
          .filter(
            (id) =>
              from && settings.order.indexOf(id) > settings.order.indexOf(from),
          )
          .map((id) => ({ value: id, label: label(id) }))}
        onChange={setTo}
      />
      <Button
        disabled={
          !from ||
          !to ||
          settings.order.indexOf(from) >= settings.order.indexOf(to)
        }
        onClick={() => edge(from!, to!, "yes")}
      >
        增加跨接
      </Button>
      {settings.connections
        .filter(
          (e) =>
            settings.order.indexOf(e.to) !== settings.order.indexOf(e.from) + 1,
        )
        .map((e) => (
          <div key={e.from + e.to}>
            {label(e.from)} → {label(e.to)}
            <Button onClick={() => edge(e.from, e.to, "default")}>
              移除跨接
            </Button>
          </div>
        ))}
      <div className="map-actions">
        <Button disabled={busy} onClick={() => onApply(settings)}>
          应用到当前项目
        </Button>
        <Button disabled={busy} onClick={() => onApply(null)}>
          恢复固定快照设置
        </Button>
      </div>
      <Button disabled={busy} onClick={onUpdate}>
        采用库中当前版本并重置项目覆盖
      </Button>
    </details>
  );
}
