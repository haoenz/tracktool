import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  InputNumber,
  Select,
  Space,
  Spin,
  Typography,
} from "antd";
import { api, request } from "./api.js";
import { useWorkspace } from "./workspace.js";
import { TrackEditorMap } from "./track-editor-map.js";
import type {
  EditRequest,
  EditPreview,
  EditGeometry,
  TrackDetail,
  Presentation,
  VersionSummary,
  VersionRef,
  EntrySnapshot,
} from "../shared/track-edit.js";
import type { WorkTask } from "../shared/work.js";

type Catalog = {
  archive_id: string;
  entries: { id: string; path: string }[];
  next_cursor: number | null;
};
type Selection = {
  version_id: string;
  segment_id: string;
  reverse: boolean;
  name: string;
};
const reference = (e: VersionRef): VersionRef => ({
  entry_id: e.entry_id,
  version_id: e.version_id,
  presentation_id: e.presentation_id,
  generation: e.generation,
  sha256: e.sha256,
});
async function detail(id: string) {
  let value = await api<TrackDetail>(`/api/tracks/${encodeURIComponent(id)}`);
  const segments = [...value.segments];
  while (value.next_cursor !== null) {
    const next = await api<TrackDetail>(
      `/api/tracks/${encodeURIComponent(id)}?cursor=${value.next_cursor}`,
    );
    if (next.entry.generation !== value.entry.generation)
      throw new Error("读取期间轨迹已变化，请刷新");
    segments.push(...next.segments);
    value = next;
  }
  return { ...value, segments };
}
export default function TrackEditor() {
  const workspace = useWorkspace(),
    cache = useQueryClient(),
    [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(""),
    [cursor, setCursor] = useState(0),
    [entryId, setEntry] = useState(""),
    [segmentId, setSegment] = useState(""),
    [mode, setMode] = useState("split_segment"),
    [indices, setIndices] = useState(""),
    [start, setStart] = useState(0),
    [end, setEnd] = useState(1),
    [drawing, setDrawing] = useState<[number, number][]>([]),
    [after, setAfter] = useState<string | null>(null),
    [snapStart, setSnapStart] = useState<string>(),
    [snapEnd, setSnapEnd] = useState<string>(),
    [draftSettings, setSettings] = useState<Presentation>(),
    [settingsRef, setSettingsRef] = useState(""),
    [error, setError] = useState(""),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<EditPreview>(),
    [outputIndex, setOutputIndex] = useState(0),
    [showBefore, setShowBefore] = useState(false),
    [historyCursor, setHistoryCursor] = useState(0),
    [segmentPage, setSegmentPage] = useState(0),
    [coordinateText, setCoordinateText] = useState("");
  const [sources, setSources] = useState<
      Extract<EditRequest, { target: VersionRef }>["sources"]
    >([]),
    [selections, setSelections] = useState<Selection[]>([]),
    [sourceId, setSourceId] = useState<string>(),
    [assign, setAssign] = useState<Record<string, number>>({}),
    [journeys, setJourneys] = useState<
      { path: string; category: "Default" | "Train" | "Flight" | null }[]
    >([]),
    [edgeTo, setEdgeTo] = useState<string>();
  const taskId = params.get("panel") === "tracks" ? params.get("task") : null;
  const catalog = useQuery({
    queryKey: ["track-catalog", search, cursor],
    queryFn: () =>
      api<Catalog>(
        `/api/tracks?search=${encodeURIComponent(search)}&cursor=${cursor}`,
      ),
  });
  const target = useQuery({
    queryKey: ["track-detail", entryId],
    queryFn: () => detail(entryId),
    enabled: !!entryId,
  });
  const history = useQuery({
    queryKey: ["track-history", entryId, historyCursor],
    queryFn: () =>
      api<{ versions: VersionSummary[]; next_cursor: number | null }>(
        `/api/tracks/${entryId}/versions?cursor=${historyCursor}`,
      ),
    enabled: !!entryId,
  });
  const geometry = useQuery({
    queryKey: ["track-geometry", entryId, target.data?.entry.generation],
    queryFn: () => api<EditGeometry>(`/api/tracks/${entryId}/geometry`),
    enabled: !!target.data,
  });
  const task = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api<WorkTask>(`/api/work/tasks/${taskId}`),
    enabled: !!taskId,
    refetchInterval: (q) =>
      q.state.data && !["running", "queued"].includes(q.state.data.status)
        ? false
        : 700,
  });
  const resultGeometry = useQuery({
    queryKey: ["edit-geometry", preview?.preview_id, outputIndex, showBefore],
    queryFn: () =>
      api<EditGeometry>(
        `/api/tracks/edit-previews/${preview!.preview_id}/geometry?index=${outputIndex}&before=${showBefore}`,
      ),
    enabled: !!preview,
  });
  useEffect(() => {
    if (!entryId && catalog.data) {
      const selected = catalog.data.entries.find(
        (e) => e.path === workspace.selected[0]?.entry,
      );
      if (selected) setEntry(selected.id);
    }
  }, [entryId, catalog.data, workspace.selected]);
  useEffect(() => {
    const d = target.data;
    if (!d) return;
    setSettings(structuredClone(d.settings));
    setSettingsRef(`${d.entry.entry_id}:${d.entry.generation}`);
    setSegment(d.settings.order[0] ?? "");
    setAfter(d.settings.order[0] ?? null);
    setSelections(
      d.settings.order.map((id) => ({
        version_id: d.entry.version_id,
        segment_id: id,
        reverse: false,
        name: `当前 · 段 ${d.segments.find((s) => s.segment_id === id)!.ordinal + 1}`,
      })),
    );
    setSources([]);
    setAssign(
      Object.fromEntries(
        d.settings.order.map((id, i) => [id, i === 0 ? 0 : 1]),
      ),
    );
    setJourneys(
      [1, 2].map((n) => ({
        path: d.entry.path.replace(/\.kml$/i, `-行程${n}.kml`),
        category: d.entry.category,
      })),
    );
  }, [target.data]);
  useEffect(() => {
    const t = task.data;
    if (!t) return;
    if (
      t.request.options.trackPreview &&
      !entryId &&
      "target" in t.request.options.trackPreview.request
    )
      setEntry(t.request.options.trackPreview.request.target.entry_id);
    if (t.status === "succeeded" && t.request.operation === "track:preview") {
      setPreview(t.output!.data as EditPreview);
      setOutputIndex(0);
      setShowBefore(false);
    }
    if (t.status === "succeeded" && t.request.operation === "track:apply") {
      const result = t.output?.data as
        { entries?: EntrySnapshot[] } | undefined;
      if (
        !entryId ||
        result?.entries?.some(
          (e) => e.entry_id === entryId && e.state !== "active",
        )
      ) {
        const e = result?.entries?.find((e) => e.state === "active");
        if (e) setEntry(e.entry_id);
      }
      setPreview(undefined);
      setNote("编辑已保存，旧版本保留在历史中。");
      void cache.invalidateQueries({ queryKey: ["track-detail"] });
      void cache.invalidateQueries({ queryKey: ["track-history"] });
      void cache.invalidateQueries({ queryKey: ["track-catalog"] });
      void workspace.refresh(workspace.archive);
    }
  }, [task.data?.id, task.data?.status]);
  const d = target.data,
    selected = d?.segments.find((s) => s.segment_id === segmentId),
    active = task.data && ["queued", "running"].includes(task.data.status);
  const settings =
    settingsRef === `${d?.entry.entry_id}:${d?.entry.generation}`
      ? draftSettings
      : d?.settings;
  function changeEntry(id: string) {
    setEntry(id);
    setPreview(undefined);
    setError("");
    setNote("");
    setHistoryCursor(0);
    setSegmentPage(0);
    setParams({ panel: "tracks" });
    setDrawing([]);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function make(
    operation: Exclude<EditRequest["operation"], { kind: "legacy_regroup" }>,
  ) {
    if (!d) return;
    const body: EditRequest =
      operation.kind === "restore_group"
        ? { schema: 1, archive_id: d.archive_id, operation }
        : {
            schema: 1,
            archive_id: d.archive_id,
            target: reference(d.entry),
            sources: operation.kind === "compose" ? sources : [],
            operation,
          };
    const created = await api<{ task_id: string }>(
      "/api/tracks/edit-previews",
      body,
    );
    setPreview(undefined);
    setParams({ panel: "tracks", task: created.task_id });
  }
  function setIgnored(id: string, on: boolean) {
    setSettings((s) =>
      s
        ? {
            ...s,
            ignored: on
              ? [...s.ignored.filter((x) => x !== id), id]
              : s.ignored.filter((x) => x !== id),
          }
        : s,
    );
  }
  function connection(from: string, to: string, value: string) {
    setSettings((s) =>
      s
        ? {
            ...s,
            connections: [
              ...s.connections.filter((e) => e.from !== from || e.to !== to),
              ...(value === "default"
                ? []
                : [{ from, to, connect: value === "yes" }]),
            ],
          }
        : s,
    );
  }
  function move(id: string, delta: number) {
    if (!settings) return;
    const order = [...settings.order],
      i = order.indexOf(id),
      j = i + delta;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    const connections = settings.connections.filter(
      (e) => order.indexOf(e.from) < order.indexOf(e.to),
    );
    setSettings({ ...settings, order, connections });
    if (connections.length !== settings.connections.length)
      setNote(
        `调整顺序移除了 ${settings.connections.length - connections.length} 条倒向连接，请在预览核对。`,
      );
  }
  async function prepare() {
    if (!d || !settings) return;
    if (mode === "presentation")
      return make({ kind: "presentation", settings });
    if (mode === "split_segment")
      return make({
        kind: "split_segment",
        segment_id: segmentId,
        after_point_indices: indices
          .split(/[,，\s]+/)
          .filter(Boolean)
          .map(Number),
      });
    if (mode === "prune")
      return make({
        kind: "prune",
        segment_id: segmentId,
        ranges: [{ start, end }],
      });
    if (mode === "draw")
      return make({
        kind: "draw",
        after_segment_id: after,
        coordinates: drawing,
        ...(snapStart
          ? { snap_start: { segment_id: snapStart, endpoint: "end" as const } }
          : {}),
        ...(snapEnd
          ? { snap_end: { segment_id: snapEnd, endpoint: "start" as const } }
          : {}),
      });
    if (mode === "compose")
      return make({
        kind: "compose",
        segments: selections.map(({ name, ...s }) => {
          void name;
          return s;
        }),
        default_connect: settings.default_connect,
      });
    if (mode === "split_journey")
      return make({
        kind: "split_journey",
        outputs: journeys.map((j, i) => ({
          ...j,
          segment_ids: settings.order.filter((id) => assign[id] === i),
        })),
      });
  }
  function pick(p: [number, number]) {
    if (preview && !showBefore) return;
    if (mode === "draw") {
      setDrawing((v) => [...v, p]);
      return;
    }
    const coords = geometry.data?.segments.find(
      (s) => s.segment_id === segmentId,
    )?.coordinates;
    if (!coords?.length) return;
    let best = 0,
      distance = Infinity;
    coords.forEach(([x, y], i) => {
      const dx = ((((x - p[0] + 180) % 360) + 360) % 360) - 180,
        ds = (dx * Math.cos((p[1] * Math.PI) / 180)) ** 2 + (y - p[1]) ** 2;
      if (ds < distance) {
        best = i;
        distance = ds;
      }
    });
    if (mode === "split_segment")
      setIndices((s) =>
        [
          ...new Set([...s.split(/[,，\s]+/).filter(Boolean), String(best)]),
        ].join(","),
      );
    else if (mode === "prune") {
      setStart(best);
      setEnd(Math.min(best + 1, coords.length));
    }
    setNote(`已选择段内第 ${best} 个点（从 0 开始）。`);
  }
  async function detect() {
    if (!d) return;
    const result = await api<{
      after_point_indices?: number[];
      ranges?: { start: number; end: number }[];
    }>("/api/tracks/detect", {
      archive_id: d.archive_id,
      target: reference(d.entry),
      segment_id: segmentId,
      kind: mode === "prune" ? "drift" : "gaps",
      options: {},
    });
    if (result.after_point_indices) {
      setIndices(result.after_point_indices.join(","));
      setNote(
        `检测到 ${result.after_point_indices.length} 个候选断点，请查看预览。`,
      );
    } else if (result.ranges?.length) {
      await make({
        kind: "prune",
        segment_id: segmentId,
        ranges: result.ranges,
      });
    } else setNote("未检测到候选漂移点。");
  }
  async function addSource() {
    if (!sourceId || !d) return;
    const value = await detail(sourceId);
    if (
      value.entry.version_id === d.entry.version_id ||
      sources.some((s) => s.version_id === value.entry.version_id)
    )
      throw new Error("这个来源已加入");
    const { generation, ...ref } = reference(value.entry);
    void generation;
    setSources((s) => [...s, ref]);
    setSelections((s) => [
      ...s,
      ...value.settings.order.map((id) => ({
        version_id: value.entry.version_id,
        segment_id: id,
        reverse: false,
        name: `${value.entry.path} · 段 ${value.segments.find((s) => s.segment_id === id)!.ordinal + 1}`,
      })),
    ]);
  }
  async function undo(operationId: string) {
    const op = await api<{
      effects: { after: EntrySnapshot }[];
      deleted: boolean;
    }>(`/api/tracks/operations/${operationId}`);
    if (op.deleted) throw new Error("组内条目已删除，无法撤销");
    await make({
      kind: "restore_group",
      operation_id: operationId,
      expected: op.effects.map((e) => reference(e.after)),
    });
  }
  async function download(version: string, entry = entryId) {
    const response = await request(
        `/api/tracks/${entry}/versions/${version}/raw`,
      ),
      url = URL.createObjectURL(await response.blob()),
      a = document.createElement("a");
    a.href = url;
    a.download = d?.entry.path.split("/").at(-1) ?? "track.kml";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const segmentOptions =
    d?.segments.map((s) => ({
      value: s.segment_id,
      label: `段 ${s.ordinal + 1} · ${s.point_count} 点`,
    })) ?? [];
  const mapData = preview ? resultGeometry.data : geometry.data;
  const displayed =
    mapData && mode === "draw" && drawing.length && !preview
      ? {
          ...mapData,
          segments: [
            ...mapData.segments,
            { segment_id: "new-drawing", coordinates: drawing },
          ],
        }
      : mapData;
  return (
    <div className="work-main track-editor">
      <Typography.Title level={2}>行程编辑</Typography.Title>
      <p>
        断开轨迹、修复或补绘仍保存为一条行程；只有「拆成独立行程」会产生多个
        KML。
      </p>
      {[
        error,
        catalog.error?.message,
        target.error?.message,
        geometry.error?.message,
        resultGeometry.error?.message,
      ]
        .filter(Boolean)
        .map((e, i) => (
          <Alert key={i} type="error" title={e} />
        ))}
      {note && (
        <Alert type="info" title={note} closable onClose={() => setNote("")} />
      )}
      <label>
        查找行程
        <Input
          aria-label="查找行程"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setCursor(0);
          }}
        />
      </label>
      <Select
        aria-label="编辑行程"
        virtual={false}
        placeholder="选择轨迹库中的行程"
        value={entryId || undefined}
        onChange={changeEntry}
        options={catalog.data?.entries.map((e) => ({
          value: e.id,
          label: e.path,
        }))}
        style={{ width: "100%" }}
      />
      <Space>
        <Button
          disabled={!cursor}
          onClick={() => setCursor(Math.max(0, cursor - 200))}
        >
          上一页行程
        </Button>
        <Button
          disabled={catalog.data?.next_cursor == null}
          onClick={() => setCursor(catalog.data!.next_cursor!)}
        >
          下一页行程
        </Button>
        <Button
          onClick={() => {
            if (entryId) void target.refetch();
            void catalog.refetch();
          }}
        >
          刷新
        </Button>
      </Space>
      {target.isFetching && <Spin />}
      {d && settings && (
        <>
          <p>
            {d.entry.path} · 第 {d.entry.generation} 次变更
          </p>
          {d.entry.state !== "active" && (
            <Alert
              type="info"
              title="该行程已成为历史来源，可从历史中查看或撤销原操作组。"
            />
          )}
          {d.manifest_status !== "ready" && (
            <Alert
              type="warning"
              title="此版本暂不可编辑"
              description={d.manifest_error}
            />
          )}
          <Card title="段列表与连接">
            <Checkbox
              checked={settings.default_connect}
              onChange={(e) =>
                setSettings({ ...settings, default_connect: e.target.checked })
              }
            >
              默认连接相邻段
            </Checkbox>
            {settings.order
              .slice(segmentPage, segmentPage + 100)
              .map((id, offset) => {
                const i = segmentPage + offset;
                const s = d.segments.find((s) => s.segment_id === id)!;
                const to = settings.order[i + 1],
                  override = settings.connections.find(
                    (e) => e.from === id && e.to === to,
                  );
                return (
                  <div className="edit-segment" key={id}>
                    <Space wrap>
                      <Button
                        type={segmentId === id ? "primary" : "default"}
                        onClick={() => setSegment(id)}
                      >
                        段 {s.ordinal + 1}
                      </Button>
                      <span>
                        {s.geometry_kind} · {s.point_count} 点 ·{" "}
                        {s.time_status === "present"
                          ? "有时间"
                          : s.time_status === "absent"
                            ? "无时间"
                            : "时间不完整"}{" "}
                        ·{" "}
                        {s.source_kind === "hand_drawn"
                          ? "手绘"
                          : s.source_kind === "measured"
                            ? "实测"
                            : "来源未确认"}
                      </span>
                      <Checkbox
                        checked={settings.ignored.includes(id)}
                        onChange={(e) => setIgnored(id, e.target.checked)}
                      >
                        忽略段 {s.ordinal + 1}
                      </Checkbox>
                      <Button
                        aria-label={`上移段 ${s.ordinal + 1}`}
                        disabled={!i}
                        onClick={() => move(id, -1)}
                      >
                        上移
                      </Button>
                      <Button
                        aria-label={`下移段 ${s.ordinal + 1}`}
                        disabled={i === settings.order.length - 1}
                        onClick={() => move(id, 1)}
                      >
                        下移
                      </Button>
                      <Button
                        disabled={busy || !!active}
                        onClick={() =>
                          void run(() =>
                            make({ kind: "reverse", segment_id: id }),
                          )
                        }
                      >
                        反向预览
                      </Button>
                    </Space>
                    {to && (
                      <label>
                        与下一段连接{" "}
                        <Select
                          aria-label={`段 ${s.ordinal + 1} 的连接`}
                          value={
                            override
                              ? override.connect
                                ? "yes"
                                : "no"
                              : "default"
                          }
                          onChange={(v) => connection(id, to, v)}
                          options={[
                            { value: "default", label: "跟随默认" },
                            { value: "yes", label: "连接" },
                            { value: "no", label: "断开" },
                          ]}
                        />
                      </label>
                    )}
                  </div>
                );
              })}
            <Space>
              <Button
                disabled={!segmentPage}
                onClick={() => setSegmentPage(Math.max(0, segmentPage - 100))}
              >
                上一页段
              </Button>
              <Button
                disabled={segmentPage + 100 >= settings.order.length}
                onClick={() => setSegmentPage(segmentPage + 100)}
              >
                下一页段
              </Button>
            </Space>
            <details>
              <summary>跨段连接覆盖</summary>
              <Space wrap>
                <span>从当前选择段到</span>
                <Select
                  aria-label="连接目标段"
                  value={edgeTo}
                  onChange={setEdgeTo}
                  options={segmentOptions.filter(
                    (s) =>
                      settings.order.indexOf(s.value) >
                      settings.order.indexOf(segmentId),
                  )}
                />
                <Button
                  disabled={!edgeTo}
                  onClick={() => edgeTo && connection(segmentId, edgeTo, "yes")}
                >
                  增加连接
                </Button>
              </Space>
              {settings.connections.map((e) => (
                <p key={`${e.from}/${e.to}`}>
                  {segmentOptions.find((s) => s.value === e.from)?.label} →{" "}
                  {segmentOptions.find((s) => s.value === e.to)?.label}：
                  {e.connect ? "连接" : "断开"}
                  <Button onClick={() => connection(e.from, e.to, "default")}>
                    移除覆盖
                  </Button>
                </p>
              ))}
            </details>
            <Button
              disabled={busy || !!active}
              onClick={() =>
                void run(() => make({ kind: "presentation", settings }))
              }
            >
              预览展示设置
            </Button>
            <p>忽略中段不会自动连接两侧；需要跨接时可明确增加连接。</p>
          </Card>
          <Card title="编辑操作">
            <Select
              aria-label="段编辑操作"
              virtual={false}
              value={mode}
              onChange={(v) => {
                setMode(v);
                setPreview(undefined);
              }}
              options={[
                { value: "split_segment", label: "内部断开（一个 KML）" },
                { value: "prune", label: "删除漂移点" },
                { value: "draw", label: "插入手绘" },
                { value: "compose", label: "组合库内片段" },
                { value: "split_journey", label: "拆成独立行程" },
                { value: "presentation", label: "仅保存展示设置" },
              ]}
              style={{ width: "100%" }}
            />
            {["split_segment", "prune"].includes(mode) && (
              <>
                <p>
                  当前：段 {selected ? selected.ordinal + 1 : "—"}
                  。可在地图点击附近采样点，也可填写点索引。
                </p>
                <Button
                  disabled={busy || !!active}
                  onClick={() => void run(detect)}
                >
                  自动检测候选
                </Button>
              </>
            )}
            {mode === "split_segment" && (
              <label>
                在这些点之后断开（从 0 开始，逗号分隔）
                <Input
                  aria-label="断点索引"
                  value={indices}
                  onChange={(e) => setIndices(e.target.value)}
                />
              </label>
            )}
            {mode === "prune" && (
              <Space wrap>
                <label>
                  删除起点（含）
                  <InputNumber
                    aria-label="删除起点"
                    min={0}
                    value={start}
                    onChange={(v) => setStart(v ?? 0)}
                  />
                </label>
                <label>
                  删除终点（不含）
                  <InputNumber
                    aria-label="删除终点"
                    min={1}
                    value={end}
                    onChange={(v) => setEnd(v ?? 1)}
                  />
                </label>
              </Space>
            )}
            {mode === "draw" && (
              <>
                <p>
                  点击地图依次补绘，至少两个点；不会添加时间。已画{" "}
                  {drawing.length} 点。
                </p>
                <Space wrap>
                  <Button onClick={() => setDrawing((v) => v.slice(0, -1))}>
                    撤回末点
                  </Button>
                  <Button onClick={() => setDrawing([])}>清空补绘</Button>
                </Space>
                <label>
                  插入位置
                  <Select
                    aria-label="补绘插入位置"
                    value={after ?? "first"}
                    onChange={(v) => setAfter(v === "first" ? null : v)}
                    options={[
                      { value: "first", label: "最前" },
                      ...segmentOptions.map((s) => ({
                        ...s,
                        label: `${s.label} 之后`,
                      })),
                    ]}
                  />
                </label>
                <label>
                  起点吸附到段尾
                  <Select
                    aria-label="起点吸附"
                    allowClear
                    value={snapStart}
                    onChange={setSnapStart}
                    options={segmentOptions}
                  />
                </label>
                <label>
                  终点吸附到段首
                  <Select
                    aria-label="终点吸附"
                    allowClear
                    value={snapEnd}
                    onChange={setSnapEnd}
                    options={segmentOptions}
                  />
                </label>
                <details>
                  <summary>填写 WGS84 坐标</summary>
                  <Input.TextArea
                    aria-label="手绘坐标"
                    value={coordinateText}
                    onChange={(e) => setCoordinateText(e.target.value)}
                    placeholder="每行 经度,纬度"
                  />
                  <Button
                    onClick={() => {
                      const values = coordinateText
                        .split("\n")
                        .filter(Boolean)
                        .map((l) => l.split(/[,，\s]+/).map(Number));
                      if (
                        values.length < 2 ||
                        values.some(
                          (v) => v.length !== 2 || !v.every(Number.isFinite),
                        )
                      )
                        setError("请输入至少两行经度,纬度");
                      else setDrawing(values as [number, number][]);
                    }}
                  >
                    使用填写坐标
                  </Button>
                </details>
              </>
            )}
            {mode === "compose" && (
              <>
                <p>
                  按下方顺序组合成当前行程的新版本。来源行程仍保留；可先搜索行程，再加入片段。
                </p>
                <Space wrap>
                  <Select
                    aria-label="组合来源行程"
                    value={sourceId}
                    onChange={setSourceId}
                    options={catalog.data?.entries.map((e) => ({
                      value: e.id,
                      label: e.path,
                    }))}
                    style={{ minWidth: 180, maxWidth: "100%" }}
                  />
                  <Button
                    disabled={!sourceId}
                    onClick={() => void run(addSource)}
                  >
                    加入来源片段
                  </Button>
                </Space>
                {selections.map((s, i) => (
                  <div
                    className="edit-segment"
                    key={`${s.version_id}/${s.segment_id}`}
                  >
                    <span>
                      {i + 1}. {s.name}
                    </span>
                    <Space wrap>
                      <Checkbox
                        checked={s.reverse}
                        onChange={(e) =>
                          setSelections((v) =>
                            v.map((x, j) =>
                              j === i ? { ...x, reverse: e.target.checked } : x,
                            ),
                          )
                        }
                      >
                        反向
                      </Checkbox>
                      <Button
                        disabled={!i}
                        onClick={() =>
                          setSelections((v) => {
                            const n = [...v];
                            [n[i - 1], n[i]] = [n[i]!, n[i - 1]!];
                            return n;
                          })
                        }
                      >
                        提前
                      </Button>
                      <Button
                        onClick={() =>
                          setSelections((v) => v.filter((_, j) => j !== i))
                        }
                      >
                        移除片段
                      </Button>
                    </Space>
                  </div>
                ))}
              </>
            )}
            {mode === "split_journey" && (
              <>
                <p>
                  每个段分配一次。需要在段内分开时，先使用内部断开；全部新行程成功保存后，原行程转为历史来源。
                </p>
                {journeys.map((j, i) => (
                  <div className="edit-segment" key={i}>
                    <label>
                      行程 {i + 1} 路径
                      <Input
                        aria-label={`行程 ${i + 1} 路径`}
                        value={j.path}
                        onChange={(e) =>
                          setJourneys((v) =>
                            v.map((x, k) =>
                              k === i ? { ...x, path: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </label>
                    <Select
                      aria-label={`行程 ${i + 1} 分类`}
                      value={j.category ?? "unknown"}
                      options={["Default", "Train", "Flight", "unknown"].map(
                        (x) => ({
                          value: x,
                          label: x === "unknown" ? "未分类" : x,
                        }),
                      )}
                      onChange={(v) =>
                        setJourneys((old) =>
                          old.map((x, k) =>
                            k === i
                              ? {
                                  ...x,
                                  category:
                                    v === "unknown"
                                      ? null
                                      : (v as "Default" | "Train" | "Flight"),
                                }
                              : x,
                          ),
                        )
                      }
                    />
                  </div>
                ))}
                <Button
                  onClick={() =>
                    setJourneys((v) => [
                      ...v,
                      {
                        path: d.entry.path.replace(
                          /\.kml$/i,
                          `-行程${v.length + 1}.kml`,
                        ),
                        category: d.entry.category,
                      },
                    ])
                  }
                >
                  增加行程
                </Button>
                {segmentOptions.map((s) => (
                  <label className="edit-segment" key={s.value}>
                    {s.label}
                    <Select
                      aria-label={`${s.label} 归属`}
                      value={assign[s.value]}
                      options={journeys.map((_, i) => ({
                        value: i,
                        label: `行程 ${i + 1}`,
                      }))}
                      onChange={(v) =>
                        setAssign((a) => ({ ...a, [s.value]: v }))
                      }
                    />
                  </label>
                ))}
              </>
            )}
            <Button
              type="primary"
              aria-label="生成编辑预览"
              loading={busy}
              disabled={
                !!active ||
                d.entry.state !== "active" ||
                d.manifest_status !== "ready"
              }
              onClick={() => void run(prepare)}
            >
              生成编辑预览
            </Button>
          </Card>
          {preview && (
            <Card title="待确认的编辑预览">
              <p>
                生成 {preview.outputs.length}{" "}
                份结果；应用后保留输入版本。有效期至{" "}
                {new Date(preview.expires_at).toLocaleString()}。
              </p>
              {preview.outputs.map((o, i) => (
                <p key={i}>
                  {o.path} · {o.segments.length} 段 ·{" "}
                  {o.segments.reduce((n, s) => n + s.point_count, 0)} 点 ·{" "}
                  {o.state}
                </p>
              ))}
              {preview.changes.map((c, i) => (
                <div key={i}>
                  <p>
                    结果 {i + 1}：增加 {c.added_points} 点，移除{" "}
                    {c.removed_points} 点；连接 {c.before_edges.length} →{" "}
                    {c.after_edges.length}；移除 {c.removed_connections.length}{" "}
                    条旧覆盖。
                  </p>
                  {c.warnings.map((w, j) => (
                    <Alert key={j} type="warning" title={w} />
                  ))}
                </div>
              ))}
              <Space wrap>
                <Checkbox
                  checked={showBefore}
                  onChange={(e) => setShowBefore(e.target.checked)}
                >
                  查看编辑前
                </Checkbox>
                <Select
                  aria-label="预览结果"
                  value={outputIndex}
                  onChange={setOutputIndex}
                  options={preview.outputs.map((o, i) => ({
                    value: i,
                    label: o.path,
                  }))}
                />
                <Button
                  type="primary"
                  disabled={!!active || busy}
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
                      setParams({ panel: "tracks", task: next.task_id });
                    })
                  }
                >
                  确认应用编辑
                </Button>
              </Space>
            </Card>
          )}
          {displayed && (
            <TrackEditorMap
              key={entryId}
              geometry={displayed}
              onPick={pick}
              selectedSegment={
                mode === "draw" && drawing.length && !preview
                  ? "new-drawing"
                  : segmentId
              }
            />
          )}
          <Card title="版本历史">
            {history.error && (
              <Alert type="error" title={history.error.message} />
            )}
            <p>下载保留完整原始字节；恢复先生成预览，后续版本仍保留。</p>
            {history.data?.versions.map((v) => (
              <HistoryRow
                key={v.id}
                version={v}
                onDownload={() => void run(() => download(v.id))}
                onRestore={(p) =>
                  void run(() =>
                    make({
                      kind: "restore_version",
                      version_id: v.id,
                      presentation_id: p,
                    }),
                  )
                }
                onUndo={() => void run(() => undo(v.operation_id))}
              />
            ))}
            <Space>
              <Button
                disabled={!historyCursor}
                onClick={() =>
                  setHistoryCursor(Math.max(0, historyCursor - 50))
                }
              >
                较新版本
              </Button>
              <Button
                disabled={history.data?.next_cursor == null}
                onClick={() => setHistoryCursor(history.data!.next_cursor!)}
              >
                较早版本
              </Button>
            </Space>
            <Sources
              entryId={entryId}
              download={(entry, version) =>
                void run(() => download(version, entry))
              }
            />
          </Card>
        </>
      )}
      {task.data && (
        <Card title="编辑任务">
          <p>
            {task.data.status === "succeeded"
              ? "已完成"
              : task.data.status === "running"
                ? "处理中"
                : task.data.status === "queued"
                  ? "排队中"
                  : task.data.status}
          </p>
          {task.data.error && (
            <Alert type="error" title={task.data.error.message} />
          )}
          <Space wrap>
            <Button onClick={() => workspace.open("tasks", task.data!.id)}>
              查看完整处理记录
            </Button>
            {active ? (
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
            ) : (
              task.data.request.operation === "track:apply" &&
              task.data.status !== "succeeded" && (
                <Button
                  onClick={() =>
                    void run(async () => {
                      const t = await api<WorkTask>(
                        `/api/work/tasks/${taskId}/retry`,
                        {},
                      );
                      setParams({ panel: "tracks", task: t.id });
                    })
                  }
                >
                  用原请求重试应用
                </Button>
              )
            )}
          </Space>
        </Card>
      )}
    </div>
  );
}
function HistoryRow({
  version: v,
  onDownload,
  onRestore,
  onUndo,
}: {
  version: VersionSummary;
  onDownload: () => void;
  onRestore: (p: string) => void;
  onUndo: () => void;
}) {
  const [p, setP] = useState(v.presentations[0]?.id);
  return (
    <div className="edit-segment">
      <p>
        版本 {v.version_no} ·{" "}
        {v.origin === "migration_baseline"
          ? "迁移基线"
          : v.origin === "imported"
            ? "导入内容"
            : "编辑结果"}{" "}
        · {new Date(v.created_at).toLocaleString()}
      </p>
      <Space wrap>
        <Button onClick={onDownload}>下载版本 {v.version_no}</Button>
        <Select
          aria-label={`版本 ${v.version_no} 展示快照`}
          value={p}
          onChange={setP}
          options={v.presentations.map((s, i) => ({
            value: s.id,
            label: `展示 ${v.presentations.length - i} · ${new Date(s.created_at).toLocaleString()}`,
          }))}
        />
        <Button disabled={!p} onClick={() => p && onRestore(p)}>
          预览恢复版本 {v.version_no}
        </Button>
        <Button onClick={onUndo}>预览撤销该操作组</Button>
      </Space>
    </div>
  );
}
function Sources({
  entryId,
  download,
}: {
  entryId: string;
  download: (entry: string, version: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [cursor, setCursor] = useState(0);
  const query = useQuery({
    queryKey: ["track-sources", entryId, cursor],
    enabled: open,
    queryFn: () =>
      api<{
        locations: {
          display_name: string;
          source_role: string;
          version_id: string;
        }[];
        lineage: {
          source_entry_id: string;
          source_version_id: string;
          source_start: number | null;
          source_end_exclusive: number | null;
          evidence_kind: string;
        }[];
        next_cursor: number | null;
      }>(`/api/tracks/${entryId}/sources?cursor=${cursor}`),
  });
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>输入来源与原件</summary>
      <p>迁移基线或较早候选不等于已核实原件。</p>
      {query.error && <Alert type="error" title={query.error.message} />}{" "}
      {query.data?.locations.map((s, i) => (
        <p key={i}>
          {s.display_name} · {s.source_role}
          <Button onClick={() => download(entryId, s.version_id)}>
            下载来源
          </Button>
        </p>
      ))}
      {query.data?.lineage.map((s, i) => (
        <p key={i}>
          来源点范围 [{s.source_start ?? "?"}, {s.source_end_exclusive ?? "?"})
          · {s.evidence_kind}
          <Button
            onClick={() => download(s.source_entry_id, s.source_version_id)}
          >
            下载输入版本
          </Button>
        </p>
      ))}
      <Space>
        <Button
          disabled={!cursor}
          onClick={() => setCursor(Math.max(0, cursor - 100))}
        >
          上一页来源
        </Button>
        <Button
          disabled={query.data?.next_cursor == null}
          onClick={() => setCursor(query.data!.next_cursor!)}
        >
          下一页来源
        </Button>
      </Space>
    </details>
  );
}
