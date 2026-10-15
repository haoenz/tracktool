import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Input, InputNumber, Select, Space, Spin } from "antd";
import { api } from "./api.js";
import { useWorkspace } from "./workspace.js";
import { TrackEditorMap } from "./track-editor-map.js";
import type {
  EditRequest,
  EditPreview,
  EditGeometry,
  TrackDetail,
  VersionRef,
} from "../shared/track-edit.js";
import type { WorkTask } from "../shared/work.js";
import type { PublicConfig } from "../shared/contracts.js";

const actions = [
  ["split_segment", "拆分"],
  ["prune", "清理"],
  ["fill_altitude", "补高程"],
  ["set_tag", "修改标签"],
] as const;
type Action = (typeof actions)[number][0];
const labels: Record<string, string> = Object.fromEntries(actions);
const statuses: Record<string, string> = {
  queued: "排队中",
  running: "处理中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  partial: "部分失败",
};
const ref = (e: VersionRef): VersionRef => ({
  entry_id: e.entry_id,
  version_id: e.version_id,
  presentation_id: e.presentation_id,
  generation: e.generation,
  sha256: e.sha256,
});
async function readDetail(id: string) {
  const first = await api<TrackDetail>(`/api/tracks/${encodeURIComponent(id)}`);
  let cursor = first.next_cursor;
  while (cursor !== null) {
    const next = await api<TrackDetail>(
      `/api/tracks/${encodeURIComponent(id)}?cursor=${cursor}`,
    );
    if (next.entry.generation !== first.entry.generation)
      throw new Error("读取期间轨迹已变化，请重新打开详情");
    first.segments.push(...next.segments);
    cursor = next.next_cursor;
  }
  return first;
}
export default function TrackProperties({ entryId }: { entryId: string }) {
  const workspace = useWorkspace(),
    cache = useQueryClient();
  const [action, setAction] = useState<Action>(),
    [segment, setSegment] = useState(""),
    [indices, setIndices] = useState(""),
    [start, setStart] = useState(0),
    [end, setEnd] = useState(1),
    [tag, setTag] = useState<string>(),
    [taskId, setTaskId] = useState(""),
    [preview, setPreview] = useState<EditPreview>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState(""),
    [before, setBefore] = useState(false);
  const refreshed = useRef("");
  const detail = useQuery({
    queryKey: ["track-detail", entryId],
    queryFn: () => readDetail(entryId),
  });
  const config = useQuery({
    queryKey: ["work-bootstrap"],
    queryFn: () => api<{ config: PublicConfig }>("/api/work/bootstrap"),
  });
  const tasks = useQuery({
    queryKey: ["tasks"],
    queryFn: () => api<{ tasks: WorkTask[] }>("/api/work/tasks"),
    refetchInterval: 2000,
  });
  const previews =
    tasks.data?.tasks.filter((t) => {
      const r = t.request.options.trackPreview?.request;
      return r && "target" in r && r.target.entry_id === entryId;
    }) ?? [];
  const ids = new Set(previews.map((t) => t.request.options.trackPreview!.id));
  const history =
    tasks.data?.tasks.filter(
      (t) =>
        previews.includes(t) ||
        (t.request.options.trackApply &&
          ids.has(t.request.options.trackApply.preview_id)),
    ) ?? [];
  const task = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api<WorkTask>(`/api/work/tasks/${taskId}`),
    enabled: !!taskId,
    refetchInterval: (q) =>
      q.state.data && !["queued", "running"].includes(q.state.data.status)
        ? false
        : 700,
  });
  const active =
    !!task.data && ["queued", "running"].includes(task.data.status);
  const d = detail.data;
  const segmentId = segment || d?.settings.order[0] || "";
  const currentSegment = d?.segments.find((s) => s.segment_id === segmentId);
  const geometry = useQuery({
    queryKey: ["property-preview", preview?.preview_id, before],
    queryFn: () =>
      api<EditGeometry>(
        `/api/tracks/edit-previews/${preview!.preview_id}/geometry?index=0&before=${before}`,
      ),
    enabled: !!preview,
  });
  useEffect(() => {
    const t = task.data;
    if (t?.status !== "succeeded") return;
    if (t.request.operation === "track:preview") {
      setPreview(t.output!.data as EditPreview);
    } else if (
      t.request.operation === "track:apply" &&
      refreshed.current !== t.id
    ) {
      refreshed.current = t.id;
      setPreview(undefined);
      setNote("已保存到当前轨迹，旧版本保留。");
      for (const key of [
        "track-detail",
        "track-history",
        "overview",
        "overview-entries",
        "overview-detail",
        "overview-candidates",
      ])
        void cache.invalidateQueries({ queryKey: [key] });
      void workspace
        .refresh(workspace.archive)
        .catch((e: Error) => setError(e.message));
    }
  }, [task.data, cache, workspace]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function make(
    operation: Extract<EditRequest, { target: VersionRef }>["operation"],
  ) {
    if (!d) return;
    const result = await api<{ task_id: string }>("/api/tracks/edit-previews", {
      schema: 1,
      archive_id: d.archive_id,
      target: ref(d.entry),
      sources: [],
      operation,
    });
    setPreview(undefined);
    setBefore(false);
    setTaskId(result.task_id);
    void tasks.refetch();
  }
  async function prepare() {
    if (action === "split_segment")
      return make({
        kind: action,
        segment_id: segmentId,
        after_point_indices: indices
          .split(/[,，\s]+/)
          .filter(Boolean)
          .map(Number),
      });
    if (action === "prune")
      return make({
        kind: action,
        segment_id: segmentId,
        ranges: [{ start, end }],
      });
    if (action === "set_tag") {
      if (!tag) throw new Error("请选择活动标签");
      return make({ kind: action, tag });
    }
    if (action === "fill_altitude") return make({ kind: action });
  }
  async function detect() {
    if (!d) return;
    const result = await api<{
      after_point_indices?: number[];
      ranges?: { start: number; end: number }[];
    }>("/api/tracks/detect", {
      archive_id: d.archive_id,
      target: ref(d.entry),
      segment_id: segmentId,
      kind: action === "prune" ? "drift" : "gaps",
      options: {},
    });
    if (action === "prune" && result.ranges?.length)
      await make({
        kind: "prune",
        segment_id: segmentId,
        ranges: result.ranges,
      });
    else if (result.after_point_indices?.length) {
      setIndices(result.after_point_indices.join(","));
      setNote("已填入候选断点，请生成预览核对。");
    } else setNote("未检测到候选点，可手动指定。");
  }
  return (
    <section className="track-properties" aria-label="轨迹属性操作">
      <Space wrap>
        {actions.map(([key, label]) => (
          <Button
            key={key}
            disabled={
              busy ||
              active ||
              d?.entry.state !== "active" ||
              d?.manifest_status !== "ready"
            }
            type={action === key ? "primary" : "default"}
            onClick={() => {
              setAction(key);
              setPreview(undefined);
              setTaskId("");
              setError("");
              setNote("");
            }}
          >
            {label}
          </Button>
        ))}
      </Space>
      {detail.isFetching && <Spin />}
      {[
        error,
        detail.error?.message,
        config.error?.message,
        task.error?.message,
        geometry.error?.message,
      ]
        .filter(Boolean)
        .map((e, i) => (
          <Alert key={i} type="error" title={e} />
        ))}
      {d?.manifest_status !== "ready" && d?.manifest_error && (
        <Alert type="warning" title={d.manifest_error} />
      )}
      {note && <Alert type="info" title={note} />}
      {action && (
        <div className="property-form">
          <h3>{labels[action]}</h3>
          {["split_segment", "prune"].includes(action) && (
            <>
              <label>
                轨迹段
                <Select
                  virtual={false}
                  aria-label="轨迹段"
                  value={segmentId}
                  onChange={setSegment}
                  options={d?.segments.map((s) => ({
                    value: s.segment_id,
                    label: `段 ${s.ordinal + 1} · ${s.point_count} 点`,
                  }))}
                />
              </label>
              {action === "split_segment" ? (
                <>
                  <p>在指定点后断开，保留为同一条轨迹中的多个分段。</p>
                  <label>
                    断点序号
                    <Input
                      aria-label="断点序号"
                      value={indices}
                      onChange={(e) => setIndices(e.target.value)}
                      placeholder="从 0 开始，多个序号用逗号分隔"
                    />
                  </label>
                </>
              ) : (
                <>
                  <p>删除指定范围的点：包含起点、不包含终点，序号从 0 开始。</p>
                  <label>
                    起点序号
                    <InputNumber
                      aria-label="起点序号"
                      min={0}
                      max={Math.max(0, (currentSegment?.point_count ?? 1) - 1)}
                      value={start}
                      onChange={(v) => setStart(v ?? 0)}
                    />
                  </label>
                  <label>
                    终点序号
                    <InputNumber
                      aria-label="终点序号"
                      min={1}
                      max={currentSegment?.point_count}
                      value={end}
                      onChange={(v) => setEnd(v ?? 1)}
                    />
                  </label>
                </>
              )}
              <Button
                disabled={busy || active}
                onClick={() => void run(detect)}
              >
                自动检测{action === "prune" ? "漂移点" : "断点"}
              </Button>
            </>
          )}
          {action === "set_tag" && (
            <label>
              活动标签
              <Select
                virtual={false}
                aria-label="活动标签"
                value={tag}
                onChange={setTag}
                options={["Default", "Train", "Flight"]
                  .flatMap(
                    (c) =>
                      (config.data?.config[
                        ("track_tag." + c) as keyof PublicConfig
                      ] as string[] | undefined) ?? [],
                  )
                  .map((value) => ({ value, label: value }))}
              />
            </label>
          )}
          {action === "fill_altitude" && (
            <p>
              为缺失高程的点查询海拔。生成预览会使用后台配置的高程服务，确认保存后才写入轨迹。
            </p>
          )}
          <Button
            type="primary"
            loading={busy}
            disabled={active || !d || (action === "set_tag" && !tag)}
            onClick={() => void run(prepare)}
          >
            生成编辑预览
          </Button>
        </div>
      )}
      {task.data && (
        <div role="status">
          <p>
            {task.data.request.operation === "track:apply" ? "保存" : "预览"} ·{" "}
            {statuses[task.data.status] ?? task.data.status}
          </p>
          {task.data.error && (
            <Alert type="error" title={task.data.error.message} />
          )}
          {active && (
            <Button
              onClick={() =>
                void run(async () => {
                  await api(`/api/work/tasks/${taskId}/cancel`, {
                    revision: task.data!.revision,
                  });
                  await task.refetch();
                })
              }
            >
              取消任务
            </Button>
          )}
        </div>
      )}
      {preview && (
        <div className="property-preview">
          <h3>编辑预览</h3>
          {preview.operation.kind === "set_tag" && (
            <p>活动标签：{preview.operation.tag}</p>
          )}
          {preview.operation.kind === "fill_altitude" && (
            <p>预览结果已包含补全的高程。</p>
          )}
          {preview.changes.map((c, i) => (
            <p key={i}>
              增加 {c.added_points} 点，移除 {c.removed_points} 点。
              {c.warnings.join("；")}
            </p>
          ))}
          <p>
            {preview.outputs[0]?.segments.length} 段 ·{" "}
            {preview.outputs[0]?.segments.reduce(
              (n, s) => n + s.point_count,
              0,
            )}{" "}
            点
          </p>
          <Space wrap>
            <Button onClick={() => setBefore(!before)}>
              {before ? "查看编辑后" : "查看编辑前"}
            </Button>
            <Button
              type="primary"
              disabled={busy || active}
              onClick={() =>
                void run(async () => {
                  const next = await api<{ task_id: string }>(
                    `/api/tracks/edit-previews/${preview.preview_id}/apply`,
                    {
                      schema: 1,
                      archive_id: preview.archive_id,
                      preview_id: preview.preview_id,
                      preview_sha256: preview.preview_sha256,
                      request_key: `apply:${preview.preview_id}`,
                    },
                  );
                  setTaskId(next.task_id);
                })
              }
            >
              确认保存到轨迹
            </Button>
          </Space>
          {geometry.data && <TrackEditorMap geometry={geometry.data} />}
        </div>
      )}
      <details>
        <summary>该轨迹的处理记录</summary>
        {tasks.error && <Alert type="error" title={tasks.error.message} />}
        {!history.length && <p>暂无处理记录</p>}
        {history.map((t) => (
          <p key={t.id}>
            <Button
              onClick={() => {
                setPreview(undefined);
                setTaskId(t.id);
              }}
            >
              {t.request.operation === "track:apply"
                ? "保存"
                : (labels[
                    t.request.options.trackPreview?.request.operation.kind ?? ""
                  ] ?? "预览")}{" "}
              · {statuses[t.status] ?? t.status} ·{" "}
              {new Date(t.createdAt).toLocaleString()}
            </Button>
          </p>
        ))}
      </details>
    </section>
  );
}
