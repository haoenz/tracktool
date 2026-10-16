import { DisplaySettings } from "./display-settings.js";
import { editTracks } from "./track-editor-map.js";
import { TrackHistory } from "./track-history.js";
import "./work.css";
import { ArrowLeft } from "lucide-react";
import { useEditSnapshot } from "./edit-snapshot.js";
import { nearestPoint, previewAnnotations } from "../shared/edit-map.js";
import { useEffect, useState, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Input,
  Select,
  Space,
  Spin,
  Modal,
} from "./components/controls.js";
import { api, waitForWorkTask } from "./api.js";
import { useWorkspace } from "./workspace.js";
import { TrackEditorMap } from "./track-editor-map.js";
import type {
  EditRequest,
  EditPreview,
  EditGeometry,
  TrackDetail,
  Presentation,
  VersionRef,
  EntrySnapshot,
} from "../shared/track-edit.js";
import type { PublicConfig } from "../shared/contracts.js";
import type { WorkTask } from "../shared/work.js";

const editActions: Record<string, string> = {
  split_segment: "断开轨迹",
  prune: "删除轨迹点",
  draw: "补绘轨迹",
  fill_altitude: "补高程",
  set_tag: "修改标签",
  split_journey: "拆分行程",
};
const groupColors = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#9333ea",
  "#d97706",
  "#0891b2",
];
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
function TrackEditor({
  initialEntry,
  view = "edit",
  active: visible = true,
  onEntryChange,
}: {
  initialEntry: string;
  view?: "edit" | "display" | "history";
  active?: boolean;
  onEntryChange?: (id: string) => void;
}) {
  const workspace = useWorkspace(),
    cache = useQueryClient();
  const [entryId, setEntry] = useState(initialEntry),
    [segmentId, setSegment] = useState(""),
    [mode, setMode] = useState(""),
    [indices, setIndices] = useState(""),
    [start, setStart] = useState(0),
    [end, setEnd] = useState(0),
    [drawing, setDrawing] = useState<[number, number][]>([]),
    [after, setAfter] = useState<string | null>(null),
    [snapStart, setSnapStart] = useState<string>(),
    [snapEnd, setSnapEnd] = useState<string>(),
    [draftSettings, setSettings] = useState<Presentation>(),
    [settingsRef, setSettingsRef] = useState(""),
    [error, setError] = useState(""),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [directSave, setDirectSave] = useState(false),
    [preview, setPreview] = useState<EditPreview>(),
    [outputIndex, setOutputIndex] = useState(0),
    [showBefore, setShowBefore] = useState(false);
  const [assign, setAssign] = useState<Record<string, number>>({}),
    [journeys, setJourneys] = useState<
      {
        path: string;
        category: "Default" | "Train" | "Flight" | null;
        tag?: string;
      }[]
    >([]);
  const [taskId, taskLink] = useState<string | null>(null);
  const [editTouched, setEditTouched] = useState(false);
  const rangeAnchor = useRef<number | undefined>(undefined);
  const [candidates, setCandidates] = useState<
    { start: number; end: number }[]
  >([]);
  const [tag, setTag] = useState<string>();
  const config = useQuery({
    queryKey: ["work-bootstrap"],
    queryFn: () => api<{ config: PublicConfig }>("/api/work/bootstrap"),
    enabled: view === "edit",
  });
  const target = useEditSnapshot(entryId, detail);
  const tagData = useQuery({
    queryKey: ["track-tag", entryId, target.data?.entry.version_id],
    queryFn: () =>
      api<{ tag: string }>(
        `/api/tracks/${entryId}/tag?version_id=${target.data!.entry.version_id}`,
      ),
    enabled: mode === "set_tag" && !!target.data,
  });
  const geometryRef =
    preview?.before.find((e) => e.entry_id === entryId) ?? target.data?.entry;
  const geometry = useQuery({
    queryKey: [
      "track-geometry",
      entryId,
      geometryRef?.version_id,
      geometryRef?.presentation_id,
    ],
    queryFn: () =>
      api<EditGeometry>(
        `/api/tracks/${entryId}/geometry?${new URLSearchParams({ raw: "true", version_id: geometryRef!.version_id, presentation_id: geometryRef!.presentation_id })}`,
      ),
    enabled: !!geometryRef && (view !== "history" || !!preview),
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
    const d = target.data;
    if (!d) return;
    setSettings(structuredClone(d.settings));
    setSettingsRef(`${d.entry.entry_id}:${d.entry.generation}`);
    setSegment(d.settings.order[0] ?? "");
    setAfter(d.settings.order[0] ?? null);
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
    if (
      t.status === "succeeded" &&
      t.request.operation === "track:preview" &&
      !directSave
    ) {
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
        if (e) {
          setEntry(e.entry_id);
          onEntryChange?.(e.entry_id);
        }
      }
      setPreview(undefined);
      setIndices("");
      setDrawing([]);
      setCandidates([]);
      setStart(0);
      setEnd(0);
      setTag(undefined);
      setDirectSave(false);
      setEditTouched(false);
      setNote("编辑已保存，旧版本保留在历史中。");
      void cache.invalidateQueries({ queryKey: ["track-detail"] });
      void cache.invalidateQueries({ queryKey: ["track-history"] });
      void cache.invalidateQueries({ queryKey: ["track-catalog"] });
      void target.refetch();
      void workspace.refresh(workspace.archive);
    }
  }, [task.data?.id, task.data?.status]);
  const d = target.data,
    active = task.data && ["queued", "running"].includes(task.data.status);
  const settings =
    settingsRef === `${d?.entry.entry_id}:${d?.entry.generation}`
      ? draftSettings
      : d?.settings;
  const draftDirty =
    !!tag ||
    (mode === "split_journey" && editTouched) ||
    !!preview ||
    !!drawing.length ||
    !!indices.trim() ||
    end > start ||
    !!candidates.length ||
    (!!settings &&
      !!d &&
      JSON.stringify(settings) !== JSON.stringify(d.settings));
  const draftKey = `editor:${entryId}`;
  useEffect(() => {
    workspace.draft?.(draftKey, draftDirty);
    return () => workspace.draft?.(draftKey, false);
  }, [workspace.draft, draftKey, draftDirty]);
  const tagOptions = [
    ...new Set(
      ["Default", "Train", "Flight"].flatMap(
        (category) =>
          (config.data?.config[
            ("track_tag." + category) as keyof PublicConfig
          ] as string[] | undefined) ?? [],
      ),
    ),
  ].map((value) => ({ value, label: value }));
  const currentTag = tagData.data?.tag;
  const breaks = indices
    .split(/[,，\s]+/)
    .filter(Boolean)
    .map(Number);
  const splitError = journeys.some(
    (j) =>
      !j.path
        .split("/")
        .at(-1)
        ?.replace(/\.kml$/i, "")
        .trim(),
  )
    ? "请为每条行程填写名称。"
    : new Set(journeys.map((j) => j.path)).size !== journeys.length
      ? "行程名称不能重复。"
      : journeys.some((_, i) => !Object.values(assign).includes(i))
        ? "请给每条行程分配至少一个片段。"
        : journeys.some((j) => !j.tag)
          ? "请为每条行程选择活动标签。"
          : settings?.order.some(
                (id) =>
                  assign[id] === undefined || assign[id]! >= journeys.length,
              )
            ? "还有片段未分配。"
            : "";
  const canSave =
    !!d &&
    d.entry.state === "active" &&
    d.manifest_status === "ready" &&
    (mode === "split_segment"
      ? breaks.length > 0
      : mode === "prune"
        ? candidates.length > 0 ||
          (end > start && rangeAnchor.current === undefined)
        : mode === "draw"
          ? drawing.length >= 2
          : mode === "set_tag"
            ? !!tagData.data && !!tag && tag !== currentTag
            : mode === "split_journey"
              ? !splitError
              : mode === "fill_altitude");
  function tagCategory(value: string): "Default" | "Train" | "Flight" {
    return (
      (["Default", "Train", "Flight"] as const).find((category) =>
        (
          config.data?.config[
            ("track_tag." + category) as keyof PublicConfig
          ] as string[] | undefined
        )?.includes(value),
      ) ?? "Default"
    );
  }
  function journeyPath(
    name: string,
    category: "Default" | "Train" | "Flight" | null,
  ) {
    const folders = d?.entry.path.split("/").slice(1, -1) ?? [];
    return `${[category ?? "Default", ...folders].join("/")}/${name.replace(/[\\/]/g, "-").replace(/\.kml$/i, "")}.kml`;
  }
  function clearSelection() {
    setIndices("");
    setStart(0);
    setEnd(0);
    setCandidates([]);
    rangeAnchor.current = undefined;
    setNote("");
  }
  function resetDraft() {
    setEditTouched(false);
    clearSelection();
    setDrawing([]);
    setSnapStart(undefined);
    setSnapEnd(undefined);
    setTag(undefined);
    setPreview(undefined);
    taskLink(null);
    setError("");
    setNote("");
    if (d) {
      setSettings(structuredClone(d.settings));
      setAssign(
        Object.fromEntries(
          d.settings.order.map((id, i) => [id, i === 0 ? 0 : 1]),
        ),
      );
      setJourneys(
        [1, 2].map((n) => ({
          path: journeyPath(
            `${d.entry.path
              .split("/")
              .at(-1)!
              .replace(/\.kml$/i, "")}-行程${n}`,
            d.entry.category,
          ),
          category: d.entry.category,
        })),
      );
    }
  }
  function locateSegment(id: string) {
    const segment = geometry.data?.segments.find((s) => s.segment_id === id);
    if (segment)
      workspace.fit?.(editTracks({ segments: [segment], connections: [] }));
  }
  function chooseSegment(id: string) {
    setSegment(id);
    clearSelection();
    locateSegment(id);
  }
  function locateRange(start: number, end: number) {
    const coordinates = geometry.data?.segments
      .find((s) => s.segment_id === segmentId)
      ?.coordinates.slice(start, end);
    if (coordinates?.length)
      workspace.fit?.(
        editTracks({
          segments: [{ segment_id: segmentId, coordinates }],
          connections: [],
        }),
      );
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setDirectSave(false);
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
            sources: [],
            operation,
          };
    setNote("");
    const saveNow = [
      "split_segment",
      "prune",
      "draw",
      "set_tag",
      "presentation",
    ].includes(operation.kind);
    setDirectSave(saveNow);
    const created = await api<{ task_id: string }>(
      "/api/tracks/edit-previews",
      body,
    );
    setPreview(undefined);
    taskLink(created.task_id);
    if (saveNow) {
      const ready = await waitForWorkTask(created.task_id);
      await applyPreview(ready.output!.data as EditPreview);
    }
  }
  async function applyPreview(value: EditPreview) {
    const next = await api<{ task_id: string }>(
      `/api/tracks/edit-previews/${value.preview_id}/apply`,
      {
        schema: 1,
        archive_id: value.archive_id,
        preview_id: value.preview_id,
        preview_sha256: value.preview_sha256,
        request_key: `apply:${value.preview_id}`,
      },
    );
    taskLink(next.task_id);
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
        ranges: candidates.length ? candidates : [{ start, end }],
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
    if (mode === "fill_altitude") return make({ kind: "fill_altitude" });
    if (mode === "set_tag") {
      if (!tag) throw new Error("请选择活动标签");
      return make({ kind: "set_tag", tag });
    }
    if (mode === "split_journey" && editTouched)
      return make({
        kind: "split_journey",
        outputs: journeys.map((j, i) => ({
          ...j,
          path: journeyPath(
            `${j.path
              .split("/")
              .at(-1)!
              .replace(/\.kml$/i, "")} ${j.tag ?? ""}`.trim(),
            j.category,
          ),
          segment_ids: settings.order.filter((id) => assign[id] === i),
        })),
      });
  }
  function pick(p: [number, number]) {
    if (view !== "edit" || busy || active || !mode || (preview && !showBefore))
      return;
    if (mode === "draw") {
      const endpoint = geometry.data?.segments
        .map((s) => ({
          id: s.segment_id,
          point: drawing.length ? s.coordinates[0] : s.coordinates.at(-1),
        }))
        .filter((s) => s.point)
        .map((s) => ({
          ...s,
          distance:
            Math.hypot(
              (s.point![0] - p[0]) * Math.cos((p[1] * Math.PI) / 180),
              s.point![1] - p[1],
            ) * 111320,
        }))
        .sort((a, b) => a.distance - b.distance)[0];
      if (!drawing.length)
        setSnapStart(
          endpoint && endpoint.distance <= 30 ? endpoint.id : undefined,
        );
      else
        setSnapEnd(
          endpoint && endpoint.distance <= 30 ? endpoint.id : undefined,
        );
      setDrawing((v) => [...v, p]);
      return;
    }
    const coords = geometry.data?.segments.find(
      (s) => s.segment_id === segmentId,
    )?.coordinates;
    if (!coords?.length) return;
    const best = nearestPoint(coords, p);
    if (mode === "split_segment" && best < coords.length - 1)
      setIndices((s) =>
        [
          ...(s
            .split(/[,，\s]+/)
            .filter(Boolean)
            .includes(String(best))
            ? s.split(/[,，\s]+/).filter((x) => x && x !== String(best))
            : [...s.split(/[,，\s]+/).filter(Boolean), String(best)]),
        ].join(","),
      );
    else if (mode === "prune") {
      if (rangeAnchor.current === undefined) {
        rangeAnchor.current = best;
        setStart(best);
        setEnd(best);
      } else {
        setStart(Math.min(rangeAnchor.current, best));
        setEnd(Math.max(rangeAnchor.current, best) + 1);
        rangeAnchor.current = undefined;
      }
      setCandidates([]);
    }
    setNote("");
  }
  async function detect() {
    if (!d) return;
    clearSelection();
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
        `检测到 ${result.after_point_indices.length} 个候选断点，请检查后保存修改。`,
      );
    } else if (result.ranges?.length) {
      setCandidates(result.ranges);
      setStart(0);
      setEnd(0);
      setNote(
        `检测到 ${result.ranges.length} 个候选范围；可逐项排除，检查后保存修改。`,
      );
    } else setNote("未检测到候选漂移点。");
  }

  const segmentOptions =
    d?.segments.map((s) => ({
      value: s.segment_id,
      label: `段 ${s.ordinal + 1} · ${s.point_count} 点`,
    })) ?? [];
  let mapData = preview ? resultGeometry.data : geometry.data;
  if (!preview && view === "display" && geometry.data && settings) {
    const byId = new Map(
      geometry.data.segments.map((segment) => [segment.segment_id, segment]),
    );
    const ignored = new Set(settings.ignored);
    const edges = new Map<
      string,
      { from: string; to: string; connect: boolean }
    >();
    const put = (edge: { from: string; to: string; connect: boolean }) =>
      edges.set(JSON.stringify([edge.from, edge.to]), edge);
    for (let i = 1; i < settings.order.length; i++)
      put({
        from: settings.order[i - 1]!,
        to: settings.order[i]!,
        connect: settings.default_connect,
      });
    settings.connections.forEach(put);
    mapData = {
      segments: settings.order
        .filter((id) => !ignored.has(id))
        .flatMap((id) => (byId.get(id) ? [byId.get(id)!] : [])),
      connections: [...edges.values()].flatMap(({ from, to, connect }) => {
        const a = byId.get(from)?.coordinates.at(-1),
          b = byId.get(to)?.coordinates[0];
        return connect && !ignored.has(from) && !ignored.has(to) && a && b
          ? [[a, b]]
          : [];
      }),
    };
  }
  const visualDrawing = [...drawing];
  const snapA = geometry.data?.segments
      .find((s) => s.segment_id === snapStart)
      ?.coordinates.at(-1),
    snapB = geometry.data?.segments.find((s) => s.segment_id === snapEnd)
      ?.coordinates[0];
  if (visualDrawing.length && snapA) visualDrawing[0] = snapA;
  if (visualDrawing.length > 1 && snapB)
    visualDrawing[visualDrawing.length - 1] = snapB;
  const drawn =
    mapData && mode === "draw" && drawing.length && !preview
      ? {
          ...mapData,
          segments: [
            ...mapData.segments,
            { segment_id: "new-drawing", coordinates: visualDrawing },
          ],
        }
      : mapData;
  const coords =
    geometry.data?.segments.find((s) => s.segment_id === segmentId)
      ?.coordinates ?? [];
  const marked =
    !preview && mode === "prune"
      ? (candidates.length ? candidates : [{ start, end }])
          .map((r) => ({
            segment_id: "ux-delete",
            coordinates: coords.slice(r.start, r.end),
          }))
          .filter((s) => s.coordinates.length)
      : !preview && mode === "split_segment"
        ? indices
            .split(/[,，\s]+/)
            .filter(Boolean)
            .map(Number)
            .filter((i) => coords[i])
            .map((i) => ({ segment_id: "ux-break", coordinates: [coords[i]!] }))
        : [];
  const displayed = drawn && {
    ...drawn,
    segments: [
      ...drawn.segments,
      ...marked,
      ...(!preview && ["split_segment", "prune"].includes(mode)
        ? (() => {
            const line = mapData?.segments.find(
              (s) => s.segment_id === segmentId,
            )?.coordinates;
            return line?.length
              ? [
                  { segment_id: "ux-add", coordinates: [line[0]!] },
                  { segment_id: "ux-break", coordinates: [line.at(-1)!] },
                ]
              : [];
          })()
        : []),
      ...(preview && !showBefore
        ? previewAnnotations(geometry.data, preview, mapData)
        : []),
    ],
  };
  return (
    <div className="work-main track-editor">
      {[
        error,
        task.data?.error?.message,
        config.error?.message,
        tagData.error?.message,
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
      {(error || task.data?.error) && (
        <Button
          disabled={busy || !!active}
          onClick={() => {
            if (
              draftDirty &&
              !window.confirm("重新载入会放弃当前修改，是否继续？")
            )
              return;
            resetDraft();
            void target.refetch();
          }}
        >
          重新载入轨迹
        </Button>
      )}
      {target.isFetching && <Spin />}
      {d && settings && (
        <>
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
          {view === "display" && (
            <DisplaySettings
              settings={settings}
              segments={d.segments}
              geometry={geometry.data}
              selected={segmentId}
              busy={busy || !!active}
              dirty={draftDirty}
              onChange={setSettings}
              onSelect={(id) => {
                setSegment(id);
                const segment = geometry.data?.segments.find(
                  (s) => s.segment_id === id,
                );
                if (segment && !settings.ignored.includes(id))
                  workspace.fit?.(
                    editTracks({ segments: [segment], connections: [] }),
                  );
              }}
              onDiscard={() => {
                setSettings(structuredClone(d.settings));
                setError("");
                setNote("");
              }}
              onSave={() =>
                void run(() => make({ kind: "presentation", settings }))
              }
            />
          )}
          {view === "edit" && !mode && (
            <div className="grid grid-cols-2 gap-2" aria-label="选择编辑操作">
              {Object.entries(editActions).map(([key, label]) => (
                <Button
                  key={key}
                  className="h-auto min-h-12 whitespace-normal"
                  onClick={() => {
                    resetDraft();
                    setMode(key);
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
          )}
          {view === "edit" && mode && (
            <section aria-label={editActions[mode]} className="space-y-3">
              <div className="flex items-center gap-2">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="返回编辑操作"
                  disabled={busy || !!active}
                  onClick={() => {
                    if (
                      draftDirty &&
                      !window.confirm("有未保存的修改，是否放弃并返回？")
                    )
                      return;
                    resetDraft();
                    setMode("");
                  }}
                >
                  <ArrowLeft size={18} />
                </Button>
                <strong>{editActions[mode]}</strong>
              </div>
              <fieldset
                disabled={busy || !!active || !!preview}
                className="min-w-0 space-y-3"
              >
                {["split_segment", "prune"].includes(mode) && (
                  <div className="space-y-2" aria-label="选择编辑片段">
                    <p>
                      选择片段，地图会高亮并定位；绿色点为起点，橙色点为终点。
                    </p>
                    {segmentOptions.map((option) => (
                      <Button
                        key={option.value}
                        className="h-auto w-full justify-start whitespace-normal"
                        aria-pressed={segmentId === option.value}
                        variant={
                          segmentId === option.value ? "default" : "outline"
                        }
                        onClick={() => chooseSegment(option.value)}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                )}
                {mode === "split_segment" && (
                  <>
                    <p>
                      点击地图上的断开位置，再点同一位置可取消。断开后仍是一条行程。
                    </p>
                    <p>
                      已选 {breaks.length} 处断点，将形成 {breaks.length + 1}{" "}
                      个片段。
                    </p>
                    <Space wrap>
                      <Button onClick={() => void run(detect)}>
                        查找可能的断点
                      </Button>
                      <Button
                        disabled={!breaks.length}
                        onClick={() => setIndices("")}
                      >
                        清除选择
                      </Button>
                    </Space>
                    {breaks.map((point, i) => (
                      <div key={point} className="flex items-center gap-2">
                        <Button onClick={() => locateRange(point, point + 1)}>
                          查看断点 {i + 1}
                        </Button>
                        <Button
                          onClick={() =>
                            setIndices(
                              breaks.filter((p) => p !== point).join(","),
                            )
                          }
                        >
                          取消断点 {i + 1}
                        </Button>
                      </div>
                    ))}
                  </>
                )}
                {mode === "prune" && (
                  <>
                    <p>
                      {rangeAnchor.current !== undefined
                        ? "请选择删除范围的终点。"
                        : end > start || candidates.length
                          ? "红色部分将被删除，保存前请检查。"
                          : "请在地图选择删除范围的起点，然后选择终点。"}
                    </p>
                    <p>
                      将删除{" "}
                      {candidates.length
                        ? candidates.reduce((n, r) => n + r.end - r.start, 0)
                        : Math.max(0, end - start)}{" "}
                      个轨迹点。
                    </p>
                    <Space wrap>
                      <Button onClick={() => void run(detect)}>
                        查找漂移点
                      </Button>
                      <Button onClick={clearSelection}>重新选择</Button>
                      <Button onClick={clearSelection}>清除选择</Button>
                    </Space>
                    {candidates.map((r, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Button onClick={() => locateRange(r.start, r.end)}>
                          查看范围 {i + 1}（{r.end - r.start} 点）
                        </Button>
                        <Button
                          onClick={() =>
                            setCandidates(candidates.filter((_, j) => j !== i))
                          }
                        >
                          保留此范围
                        </Button>
                      </div>
                    ))}
                  </>
                )}
                {mode === "draw" && (
                  <>
                    <label>
                      在哪里补绘
                      <Select
                        aria-label="补绘位置"
                        value={after ?? "first"}
                        onChange={(v) => {
                          setAfter(v === "first" ? null : v);
                          setDrawing([]);
                          setSnapStart(undefined);
                          setSnapEnd(undefined);
                        }}
                        options={[
                          { value: "first", label: "轨迹最前面" },
                          ...segmentOptions.map((o) => ({
                            value: o.value,
                            label: `${o.label}之后`,
                          })),
                        ]}
                      />
                    </label>
                    <p>
                      点击地图依次画线，至少两个点。靠近已有端点时会自动吸附；手绘部分没有时间信息。
                    </p>
                    <p>已画 {drawing.length} 点。</p>
                    <Space wrap>
                      <Button
                        disabled={!drawing.length}
                        onClick={() => {
                          setDrawing(drawing.slice(0, -1));
                          setSnapEnd(undefined);
                          if (drawing.length <= 1) setSnapStart(undefined);
                        }}
                      >
                        撤回一点
                      </Button>
                      <Button
                        disabled={!drawing.length}
                        onClick={() => {
                          setDrawing([]);
                          setSnapStart(undefined);
                          setSnapEnd(undefined);
                        }}
                      >
                        重新绘制
                      </Button>
                    </Space>
                    {snapStart && (
                      <p>
                        起点已吸附到片段末尾{" "}
                        <Button onClick={() => setSnapStart(undefined)}>
                          取消起点吸附
                        </Button>
                      </p>
                    )}
                    {snapEnd && (
                      <p>
                        终点已吸附到片段开头{" "}
                        <Button onClick={() => setSnapEnd(undefined)}>
                          取消终点吸附
                        </Button>
                      </p>
                    )}
                  </>
                )}
                {mode === "fill_altitude" && (
                  <p>
                    为整段缺失高程的轨迹片段查询海拔，已有高程的片段保持不变。计算完成后查看结果，再决定是否保存。
                  </p>
                )}
                {mode === "set_tag" && (
                  <>
                    <p>当前标签：{currentTag ?? "未设置"}</p>
                    <Select
                      aria-label="活动标签"
                      placeholder="选择新标签"
                      value={tag ?? currentTag}
                      onChange={setTag}
                      options={tagOptions}
                    />
                  </>
                )}
                {mode === "split_journey" && (
                  <div onClickCapture={() => setEditTouched(true)}>
                    <p>
                      把片段分到不同的行程中。需要从片段中间拆开时，请先使用“断开轨迹”。
                    </p>
                    {journeys.map((journey, i) => (
                      <div key={i} className="rounded-md border p-3 space-y-2">
                        <strong
                          style={{ color: groupColors[i % groupColors.length] }}
                        >
                          行程 {i + 1}
                        </strong>
                        <label>
                          名称
                          <Input
                            aria-label={`行程 ${i + 1} 名称`}
                            value={journey.path
                              .split("/")
                              .at(-1)!
                              .replace(/\.kml$/i, "")}
                            onChange={(e) =>
                              setJourneys(
                                journeys.map((j, k) =>
                                  k === i
                                    ? {
                                        ...j,
                                        path: journeyPath(
                                          e.target.value,
                                          j.category,
                                        ),
                                      }
                                    : j,
                                ),
                              )
                            }
                          />
                        </label>
                        <Select
                          aria-label={`行程 ${i + 1} 活动标签`}
                          placeholder="选择活动标签"
                          value={journey.tag}
                          onChange={(value) => {
                            const category = tagCategory(value);
                            setJourneys(
                              journeys.map((j, k) =>
                                k === i
                                  ? {
                                      ...j,
                                      tag: value,
                                      category,
                                      path: journeyPath(
                                        j.path
                                          .split("/")
                                          .at(-1)!
                                          .replace(/\.kml$/i, ""),
                                        category,
                                      ),
                                    }
                                  : j,
                              ),
                            );
                          }}
                          options={tagOptions}
                        />
                        {segmentOptions
                          .filter((o) => assign[o.value] === i)
                          .map((o) => (
                            <label key={o.value} className="block">
                              <Button
                                variant="ghost"
                                onClick={() => locateSegment(o.value)}
                              >
                                {o.label}
                              </Button>
                              <Select
                                aria-label={`${o.label} 分配到`}
                                value={assign[o.value]}
                                onChange={(value) =>
                                  setAssign({ ...assign, [o.value]: value })
                                }
                                options={journeys.map((_, j) => ({
                                  value: j,
                                  label: `行程 ${j + 1}`,
                                }))}
                              />
                            </label>
                          ))}
                        {!Object.values(assign).includes(i) && (
                          <>
                            <p>尚未分配片段</p>
                            <Button
                              disabled={journeys.length <= 2}
                              onClick={() => {
                                setJourneys(journeys.filter((_, j) => j !== i));
                                setAssign(
                                  Object.fromEntries(
                                    Object.entries(assign).map(([id, n]) => [
                                      id,
                                      n > i ? n - 1 : n,
                                    ]),
                                  ),
                                );
                              }}
                            >
                              删除空行程
                            </Button>
                          </>
                        )}
                      </div>
                    ))}
                    <Button
                      onClick={() =>
                        setJourneys([
                          ...journeys,
                          {
                            path: journeyPath(
                              `新行程 ${journeys.length + 1}`,
                              d.entry.category,
                            ),
                            category: d.entry.category,
                          },
                        ])
                      }
                    >
                      增加行程
                    </Button>
                    {splitError && <p role="status">{splitError}</p>}
                  </div>
                )}
              </fieldset>
              <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t bg-background py-3">
                <span className="mr-auto text-sm">
                  {busy || active
                    ? "正在处理…"
                    : draftDirty
                      ? "未保存修改"
                      : "尚未修改"}
                </span>
                <Button
                  disabled={busy || !!active || !draftDirty}
                  onClick={resetDraft}
                >
                  放弃修改
                </Button>
                <Button
                  variant="default"
                  loading={busy || !!active}
                  disabled={!canSave || busy || !!active || !!preview}
                  onClick={() => void run(prepare)}
                >
                  {mode === "fill_altitude"
                    ? "计算高程"
                    : mode === "split_journey"
                      ? "确认拆分…"
                      : "保存"}
                </Button>
              </div>
            </section>
          )}
          {preview && !directSave && (
            <Modal
              title={mode === "fill_altitude" ? "补高程结果" : "确认拆分行程"}
              open
              closable={!busy && !active}
              onCancel={() => {
                setPreview(undefined);
                taskLink(null);
              }}
              footer={
                <>
                  <Button
                    disabled={busy || !!active}
                    onClick={() => {
                      setPreview(undefined);
                      taskLink(null);
                    }}
                  >
                    返回修改
                  </Button>
                  <Button
                    variant="default"
                    loading={busy || !!active}
                    onClick={() => void run(() => applyPreview(preview))}
                  >
                    {mode === "fill_altitude" ? "保存高程" : "确认拆分"}
                  </Button>
                </>
              }
            >
              {mode === "fill_altitude" ? (
                <p>
                  {preview.altitude
                    ? `已补齐 ${preview.altitude.filled} 个点，仍有 ${preview.altitude.remaining} 个点未补齐。`
                    : "高程计算完成。"}
                </p>
              ) : (
                <>
                  <p>
                    将生成以下 {preview.outputs.length}{" "}
                    条行程，原行程保留在历史中。
                  </p>
                  <ul>
                    {preview.outputs.map((o, i) => (
                      <li key={i}>
                        {o.path.split("/").at(-1)} · {o.segments.length} 个片段
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {preview.changes
                .flatMap((c) => c.warnings)
                .map((warning, i) => (
                  <Alert key={i} type="warning" title={warning} />
                ))}
            </Modal>
          )}
          {displayed && (view === "display" || !!mode) && (
            <TrackEditorMap
              key={entryId}
              geometry={displayed}
              active={visible && (view !== "history" || !!preview)}
              readOnly
              segmentColors={
                mode === "split_journey"
                  ? Object.fromEntries(
                      Object.entries(assign).map(([id, group]) => [
                        id,
                        groupColors[group % groupColors.length]!,
                      ]),
                    )
                  : undefined
              }
              onPick={pick}
              selectedSegment={
                mode === "draw" && drawing.length && !preview
                  ? "new-drawing"
                  : segmentId
              }
            />
          )}
        </>
      )}
    </div>
  );
}
export default function TrackEditorView(props: {
  initialEntry: string;
  view?: "edit" | "display" | "history";
  active?: boolean;
  onEntryChange?: (id: string) => void;
}) {
  return props.view === "history" ? (
    <TrackHistory entryId={props.initialEntry} active={props.active ?? true} />
  ) : (
    <TrackEditor {...props} />
  );
}
