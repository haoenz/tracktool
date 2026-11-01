import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  LoaderCircle,
  LocateFixed,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PublicConfig } from "../shared/contracts.js";
import { nearestPoint, previewAnnotations } from "../shared/edit-map.js";
import { samePresentation } from "../shared/presentation-equality.js";
import type {
  AltitudePreview,
  EditGeometry,
  EditPreview,
  EditRequest,
  EntrySnapshot,
  Presentation,
  TrackDetail,
  VersionRef,
} from "../shared/track-edit.js";
import { AltitudePreviewTable } from "./altitude-preview-table.js";
import { api, requestWorkTask, waitForWorkTask } from "./api.js";
import { Alert, Button, Modal, Select, Spin } from "./components/controls.js";
import { isRegisteredTag, TagPicker } from "./components/tag-picker.js";
import { DisplaySettings } from "./display-settings.js";
import { useEditSnapshot } from "./edit-snapshot.js";
import { importError } from "./import-error.js";
import {
  journeyColors,
  journeyName,
  SplitJourneyEditor,
  type SplitJourney,
} from "./split-journey-editor.js";
import { editTracks, TrackEditorMap } from "./track-editor-map.js";
import { TrackHistory } from "./track-history.js";
import "./work.css";
import { useWorkspace } from "./workspace.js";

const editActions: Record<string, string> = {
  split_segment: "断开轨迹",
  prune: "删除轨迹点",
  draw: "补绘轨迹",
  fill_altitude: "填充高程",
  set_tag: "修改标签",
  split_journey: "拆分行程",
};
// Draw mode colors the track before and after the insertion point differently.
const drawBeforeColor = "#0891b2";
const drawAfterColor = "#9333ea";
const distanceMeters = (a: [number, number], b: [number, number]) => {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b[1] - a[1]) * rad) / 2) ** 2 +
    Math.cos(a[1] * rad) *
      Math.cos(b[1] * rad) *
      Math.sin(((b[0] - a[0]) * rad) / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
};
const formatDistance = (meters: number) =>
  meters < 1000
    ? `${Math.round(meters)} m`
    : `${(meters / 1000).toFixed(2)} 公里`;
const formatInterval = (seconds: number) => {
  const s = Math.round(seconds);
  return s < 60
    ? `${s} 秒`
    : s < 3600
      ? `${Math.floor(s / 60)} 分 ${s % 60} 秒`
      : `${(s / 3600).toFixed(1)} 小时`;
};
const fileSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.ceil(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
  onHeaderChange,
}: {
  initialEntry: string;
  view?: "edit" | "display" | "history";
  active?: boolean;
  onEntryChange?: (id: string) => void;
  onHeaderChange?: (
    header:
      { title: string; backLabel: string; onBack: () => void } | undefined,
  ) => void;
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
  const [locatedAltitude, setLocatedAltitude] = useState<{
    segment_id: string;
    longitude: number;
    latitude: number;
  }>();
  const [locatedBreak, setLocatedBreak] = useState<number>();
  const [automaticBreaks, setAutomaticBreaks] = useState<number[]>([]);
  const [journeys, setJourneys] = useState<SplitJourney[]>([]);
  const [drawMethod, setDrawMethod] = useState("map");
  const [importKml, setImportKml] = useState("");
  const [importFile, setImportFile] = useState<{
    name: string;
    size: number;
  }>();
  const [importFailure, setImportFailure] = useState("");
  const [importDragging, setImportDragging] = useState(false);
  const [taskId, taskLink] = useState<string | null>(null);
  const [editTouched, setEditTouched] = useState(false);
  const rangeAnchor = useRef<number | undefined>(undefined);
  const importInput = useRef<HTMLInputElement>(null);
  const importDragDepth = useRef(0);
  const [candidates, setCandidates] = useState<
    { start: number; end: number }[]
  >([]);
  const [tag, setTag] = useState<string>();
  const config = useQuery({
    queryKey: ["work-bootstrap"],
    queryFn: () => api<{ config: PublicConfig }>("/api/work/bootstrap"),
    enabled: visible && view === "edit",
  });
  const target = useEditSnapshot(entryId, detail, visible);
  const tagData = useQuery({
    queryKey: ["track-tag", entryId, target.data?.entry.version_id],
    queryFn: () =>
      api<{ tag: string }>(
        `/api/tracks/${entryId}/tag?version_id=${target.data!.entry.version_id}`,
      ),
    enabled: visible && mode === "set_tag" && !!target.data,
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
    enabled: visible && !!geometryRef && (view !== "history" || !!preview),
  });
  const task = useQuery({
    queryKey: ["task", taskId],
    queryFn: ({ signal }) =>
      requestWorkTask(`/api/work/tasks/${taskId}`, undefined, signal),
    enabled: visible && !!taskId,
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
  const altitudeResult = useQuery({
    queryKey: ["edit-altitude", preview?.preview_id, outputIndex],
    queryFn: () =>
      api<AltitudePreview>(
        `/api/tracks/edit-previews/${preview!.preview_id}/altitude?index=${outputIndex}`,
      ),
    enabled: !!preview && preview.operation.kind === "fill_altitude",
  });
  useEffect(() => {
    const d = target.data;
    if (!d) return;
    setSettings(structuredClone(d.settings));
    setSettingsRef(`${d.entry.entry_id}:${d.entry.generation}`);
    setSegment(d.settings.order[0] ?? "");
    setAfter(d.settings.order[0] ?? null);
    setJourneys([
      {
        startSegmentId: d.settings.order[0] ?? "",
        path: d.entry.path.replace(/\.kml$/i, "-行程1.kml"),
        category: d.entry.category,
      },
    ]);
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
      setAutomaticBreaks([]);
      setDrawing([]);
      setCandidates([]);
      if (view === "display") setMode("");
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
    (!!settings && !!d && !samePresentation(settings, d.settings));
  const draftKey = `editor:${entryId}`;
  useEffect(() => {
    if (!mode || view === "history") return;
    onHeaderChange?.({
      title: editActions[mode]!,
      backLabel: view === "display" ? "返回分段管理" : "返回编辑操作",
      onBack: () => {
        if (busy || active) return;
        if (draftDirty && !window.confirm("有未保存的修改，是否放弃并返回？"))
          return;
        resetDraft();
        setMode("");
      },
    });
    return () => onHeaderChange?.(undefined);
  }, [view, mode, busy, active, d, draftDirty, onHeaderChange]);
  useEffect(() => {
    workspace.draft?.(draftKey, draftDirty);
    return () => workspace.draft?.(draftKey, false);
  }, [workspace.draft, draftKey, draftDirty]);
  const currentTag = tagData.data?.tag;
  const breaks = indices
    .split(/[,，\s]+/)
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
  const journeySegments = journeys.map(
    (journey, index) =>
      settings?.order.slice(
        settings.order.indexOf(journey.startSegmentId),
        journeys[index + 1]
          ? settings.order.indexOf(journeys[index + 1]!.startSegmentId)
          : undefined,
      ) ?? [],
  );
  const assign = Object.fromEntries(
    journeySegments.flatMap((ids, index) => ids.map((id) => [id, index])),
  );
  const splitError =
    (settings?.order.length ?? 0) < 2
      ? "请先断开轨迹，再拆分行程。"
      : journeys.length < 2
        ? "请在相邻片段之间设置至少一处分界。"
        : journeys.some(
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
                        assign[id] === undefined ||
                        assign[id]! >= journeys.length,
                    )
                  ? "还有片段未分配。"
                  : "";
  const missingAltitude =
    mode === "fill_altitude"
      ? geometry.data?.missing_altitude_points
      : undefined;
  const hasMissingAltitude =
    missingAltitude === undefined || missingAltitude > 0;
  const altitudeSegments =
    missingAltitude && geometry.data
      ? geometry.data.segments.flatMap((segment, index) => {
          const missing = segment.missing_altitude_points ?? 0;
          if (!missing) return [];
          return [
            {
              id: segment.segment_id,
              ordinal:
                d?.segments.find((s) => s.segment_id === segment.segment_id)
                  ?.ordinal ?? index,
              points: segment.coordinates.length,
              missing,
            },
          ];
        })
      : [];
  const altitudePoints =
    geometry.data?.segments.reduce(
      (n, segment) => n + segment.coordinates.length,
      0,
    ) ?? 0;
  const fillAltitudeFailure =
    mode === "fill_altitude" && !preview && (!!error || !!task.data?.error);
  const altitudeGroups = useMemo(() => {
    const whole = new Map(
      altitudeResult.data?.segments.map((segment) => [
        segment.segment_id,
        segment.whole,
      ]) ?? [],
    );
    const groups: {
      segment_id: string;
      segment_ordinal: number;
      whole: boolean;
      points: AltitudePreview["points"];
    }[] = [];
    for (const point of altitudeResult.data?.points ?? []) {
      const last = groups.at(-1);
      if (last?.segment_id === point.segment_id) last.points.push(point);
      else
        groups.push({
          segment_id: point.segment_id,
          segment_ordinal: point.segment_ordinal,
          whole: whole.get(point.segment_id) ?? false,
          points: [point],
        });
    }
    return groups;
  }, [altitudeResult.data]);
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
          ? drawing.length >= 2 && (drawMethod === "map" || !!importKml)
          : mode === "set_tag"
            ? !!tagData.data && !!tag && tag !== currentTag
            : mode === "split_journey"
              ? !splitError
              : mode === "fill_altitude"
                ? hasMissingAltitude
                : true);
  const importLocked = busy || !!active || !!preview;
  const drawSegmentColors =
    mode === "draw" && settings
      ? (() => {
          const at = after === null ? 0 : settings.order.indexOf(after) + 1;
          return Object.fromEntries(
            settings.order.map((id, i) => [
              id,
              i < at ? drawBeforeColor : drawAfterColor,
            ]),
          );
        })()
      : undefined;
  const importFailureInfo = importError(importFailure);
  const showDraftState =
    mode !== "draw" && mode !== "set_tag" && mode !== "split_journey";
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
    setAutomaticBreaks([]);
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
    setImportKml("");
    setImportFile(undefined);
    setImportFailure("");
    setImportDragging(false);
    setSnapStart(undefined);
    setSnapEnd(undefined);
    setTag(undefined);
    setPreview(undefined);
    taskLink(null);
    setError("");
    setNote("");
    if (d) {
      setSettings(structuredClone(d.settings));
      setJourneys([
        {
          startSegmentId: d.settings.order[0] ?? "",
          path: journeyPath(
            `${d.entry.path
              .split("/")
              .at(-1)!
              .replace(/\.kml$/i, "")}-行程1`,
            d.entry.category,
          ),
          category: d.entry.category,
        },
      ]);
    }
  }
  function clearImport() {
    setImportKml("");
    setImportFile(undefined);
    setImportFailure("");
    setDrawing([]);
    setImportDragging(false);
    setError("");
    setNote("");
  }
  function acceptImport(file: File) {
    if (busy || active || preview) return;
    setDrawing([]);
    setImportKml("");
    setImportFailure("");
    setImportFile({ name: file.name, size: file.size });
    void run(async () => {
      if (!/\.kml$/i.test(file.name)) throw new Error("请选择 KML 文件。");
      if (file.size > 8 * 1024 * 1024)
        throw new Error("KML 文件不能超过 8 MiB");
      const kml = await file.text();
      const result = await api<{ coordinates: [number, number][] }>(
        "/api/tracks/import-line",
        { kml },
      );
      setImportKml(kml);
      setDrawing(result.coordinates.map(([x, y]) => [x, y]));
      workspace.fit(
        editTracks({
          segments: [
            {
              segment_id: "new-drawing",
              coordinates: result.coordinates,
            },
          ],
          connections: [],
        }),
      );
    }, setImportFailure);
  }
  function locateSegment(id: string) {
    const segment = geometry.data?.segments.find((s) => s.segment_id === id);
    if (segment)
      workspace.fit(editTracks({ segments: [segment], connections: [] }));
  }
  const pendingLocate = useRef(false);
  function locateTrack() {
    if (!geometry.data) {
      pendingLocate.current = true;
      return;
    }
    workspace.fit(editTracks(geometry.data));
  }
  useEffect(() => {
    if (!pendingLocate.current || !geometry.data) return;
    pendingLocate.current = false;
    workspace.fit(editTracks(geometry.data));
  }, [geometry.data, workspace.fit]);
  useEffect(() => {
    setLocatedAltitude(undefined);
  }, [preview?.preview_id]);
  useEffect(() => {
    setLocatedBreak(undefined);
  }, [entryId, segmentId, mode, indices, preview?.preview_id]);
  function locateAltitudePoint(point: {
    segment_id: string;
    longitude: number;
    latitude: number;
  }) {
    workspace.fit(
      editTracks({
        segments: [
          {
            segment_id: point.segment_id,
            coordinates: [[point.longitude, point.latitude]],
          },
        ],
        connections: [],
      }),
    );
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
      workspace.fit(
        editTracks({
          segments: [{ segment_id: segmentId, coordinates }],
          connections: [],
        }),
      );
  }
  async function run(
    action: () => Promise<void>,
    onError?: (message: string) => void,
  ) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setDirectSave(false);
      if (onError) onError(message);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }
  async function make(operation: EditRequest["operation"]) {
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
        ...(drawMethod === "import" ? { import_kml: importKml } : {}),
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
          category: j.category,
          tag: j.tag,
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
    if (
      (view !== "edit" && !(view === "display" && mode === "draw")) ||
      busy ||
      active ||
      !mode ||
      (preview && !showBefore)
    )
      return;
    if (mode === "draw") {
      if (drawMethod !== "map") return;
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
    if (mode === "split_segment" && best < coords.length - 1) {
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
      setAutomaticBreaks((points) => points.filter((point) => point !== best));
    } else if (mode === "prune") {
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
    if (mode === "prune") clearSelection();
    else setNote("");
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
    if (mode === "split_segment") {
      const added = [...new Set(result.after_point_indices ?? [])].filter(
        (point) => !breaks.includes(point),
      );
      setIndices([...breaks, ...added].sort((a, b) => a - b).join(","));
      setAutomaticBreaks((points) => [...new Set([...points, ...added])]);
      setNote(
        added.length
          ? `新增 ${added.length} 处自动断点，已保留原有选择，请检查后保存修改。`
          : "未发现新的断点，已保留原有选择。",
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
  const pruneCount = candidates.length
    ? candidates.reduce((n, r) => n + r.end - r.start, 0)
    : Math.max(0, end - start);

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
  const segmentTimes = geometry.data?.segments.find(
    (s) => s.segment_id === segmentId,
  )?.time_us;
  const breakRows = breaks.map((point) => {
    const from = coords[point],
      to = coords[point + 1],
      start = segmentTimes?.[point],
      end = segmentTimes?.[point + 1];
    return {
      point,
      meters: from && to ? distanceMeters(from, to) : undefined,
      seconds:
        start === undefined || end === undefined
          ? undefined
          : (end - start) / 1e6,
    };
  });
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
      ...(mode === "split_segment" &&
      !preview &&
      locatedBreak !== undefined &&
      breaks.includes(locatedBreak) &&
      coords[locatedBreak]
        ? [
            {
              segment_id: "ux-located",
              coordinates: [coords[locatedBreak]!],
            },
          ]
        : []),
      ...(mode === "fill_altitude" && preview && locatedAltitude
        ? [
            {
              segment_id: "ux-located",
              coordinates: [
                [locatedAltitude.longitude, locatedAltitude.latitude] as [
                  number,
                  number,
                ],
              ],
            },
          ]
        : []),
    ],
  };
  return (
    <div className="track-editor">
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
      {(error || task.data?.error) &&
        !fillAltitudeFailure &&
        mode !== "prune" && (
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
          {view === "display" && !mode && (
            <DisplaySettings
              settings={settings}
              segments={d.segments}
              geometry={geometry.data}
              selected={segmentId}
              busy={busy || !!active}
              dirty={draftDirty}
              insertDisabled={
                d.entry.state !== "active" || d.manifest_status !== "ready"
              }
              onInsert={(id) => {
                resetDraft();
                setAfter(id);
                setMode("draw");
                locateTrack();
              }}
              onChange={setSettings}
              onSelect={(id) => {
                setSegment(id);
                const segment = geometry.data?.segments.find(
                  (s) => s.segment_id === id,
                );
                if (segment && !settings.ignored.includes(id))
                  workspace.fit(
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
              {Object.entries(editActions)
                .filter(([key]) => key !== "draw")
                .map(([key, label]) => (
                  <Button
                    key={key}
                    className="h-auto min-h-12 whitespace-normal"
                    onClick={() => {
                      resetDraft();
                      setMode(key);
                      locateTrack();
                    }}
                  >
                    {label}
                  </Button>
                ))}
            </div>
          )}
          {(view === "edit" || view === "display") && mode && (
            <section aria-label={editActions[mode]} className="space-y-3">
              {mode === "fill_altitude" && preview ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {preview.altitude
                      ? `查询成功 ${preview.altitude.filled} 个点${
                          preview.altitude.remaining
                            ? `（失败 ${preview.altitude.remaining} 个点）`
                            : ""
                        }。`
                      : "高程查询完成。"}
                  </p>
                  {altitudeResult.isPending && <Spin />}
                  {altitudeResult.error && (
                    <Alert type="error" title={altitudeResult.error.message} />
                  )}
                  {altitudeResult.data &&
                    altitudeResult.data.points.length > 0 && (
                      <AltitudePreviewTable
                        groups={altitudeGroups}
                        onLocate={(point) => {
                          setLocatedAltitude(point);
                          locateAltitudePoint(point);
                        }}
                      />
                    )}
                  <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-background py-3">
                    <Button
                      disabled={busy || !!active}
                      onClick={() => {
                        setPreview(undefined);
                        taskLink(null);
                      }}
                    >
                      取消
                    </Button>
                    <Button
                      variant="default"
                      loading={busy || !!active}
                      onClick={() => void run(() => applyPreview(preview))}
                    >
                      保存
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <fieldset
                    disabled={busy || !!active || !!preview}
                    className="min-w-0 space-y-3"
                  >
                    {mode === "split_segment" && segmentOptions.length > 1 && (
                      <Select
                        aria-label="选择编辑片段"
                        value={segmentId}
                        options={segmentOptions}
                        onChange={chooseSegment}
                        disabled={busy || !!active || !!preview}
                      />
                    )}
                    {mode === "prune" && (
                      <div className="space-y-2" aria-label="选择编辑片段">
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
                        <p className="text-xs text-muted-foreground">
                          {breaks.length > 0
                            ? `已选${breaks.length}处断点，各断点距与下一个点的间隔如下`
                            : "点击地图选择断开位置，重复点击同一位置可取消。"}
                        </p>
                        {breakRows.length > 0 && (
                          <div className="max-h-72 overflow-auto rounded-md border">
                            <table
                              className="w-full text-sm"
                              aria-label="已选断点"
                            >
                              <thead className="sticky top-0 bg-muted">
                                <tr>
                                  <th className="p-2 text-left">
                                    <span className="sr-only">定位</span>
                                  </th>
                                  <th className="p-2 text-left">距离</th>
                                  <th className="p-2 text-left">时间</th>
                                  <th className="p-2 text-left">来源</th>
                                  <th className="w-10 p-2">
                                    <span className="sr-only">取消</span>
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {breakRows.map(
                                  ({ point, meters, seconds }, i) => (
                                    <tr key={point} className="border-t">
                                      <td className="p-2">
                                        <Button
                                          variant="ghost"
                                          className="h-7 w-7 p-0"
                                          aria-label={`定位断点 ${i + 1}`}
                                          title="定位"
                                          onClick={() => {
                                            setLocatedBreak(point);
                                            locateRange(point, point + 1);
                                          }}
                                        >
                                          <LocateFixed className="size-4" />
                                        </Button>
                                      </td>
                                      <td className="p-2">
                                        {meters === undefined
                                          ? "—"
                                          : formatDistance(meters)}
                                      </td>
                                      <td className="p-2">
                                        {seconds === undefined
                                          ? "—"
                                          : formatInterval(seconds)}
                                      </td>
                                      <td className="p-2 text-xs text-muted-foreground">
                                        {automaticBreaks.includes(point)
                                          ? "自动"
                                          : "手选"}
                                      </td>
                                      <td className="p-2">
                                        <Button
                                          variant="ghost"
                                          className="h-7 w-7 p-0"
                                          aria-label={`取消断点 ${i + 1}`}
                                          title="取消断点"
                                          onClick={() => {
                                            setIndices(
                                              breaks
                                                .filter((p) => p !== point)
                                                .join(","),
                                            );
                                            setAutomaticBreaks((points) =>
                                              points.filter((p) => p !== point),
                                            );
                                          }}
                                        >
                                          <X className="size-4" />
                                        </Button>
                                      </td>
                                    </tr>
                                  ),
                                )}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </>
                    )}
                    {mode === "prune" && (
                      <>
                        {rangeAnchor.current !== undefined ? (
                          <p>请选择删除范围的终点。</p>
                        ) : !(end > start || candidates.length) ? (
                          <p>请在地图选择删除范围的起点，然后选择终点。</p>
                        ) : null}
                        {(end > start || !!candidates.length) && (
                          <p className="text-xs text-destructive">
                            {`将删除${pruneCount}个轨迹点`}
                          </p>
                        )}
                        {candidates.map((r, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <Button onClick={() => locateRange(r.start, r.end)}>
                              查看范围 {i + 1}（{r.end - r.start} 点）
                            </Button>
                            <Button
                              onClick={() =>
                                setCandidates(
                                  candidates.filter((_, j) => j !== i),
                                )
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
                        <Select
                          aria-label="补绘方式"
                          value={drawMethod}
                          options={[
                            { value: "map", label: "地图绘制" },
                            { value: "import", label: "上传轨迹" },
                          ]}
                          onChange={(value) => {
                            resetDraft();
                            setDrawMethod(value);
                          }}
                        />
                        {drawMethod === "import" ? (
                          <>
                            <input
                              ref={importInput}
                              className="sr-only"
                              tabIndex={-1}
                              type="file"
                              accept=".kml,application/vnd.google-earth.kml+xml"
                              aria-label="导入 KML 轨迹"
                              disabled={importLocked}
                              onChange={(event) => {
                                const file = event.target.files?.[0];
                                event.target.value = "";
                                if (file) acceptImport(file);
                              }}
                            />
                            <div
                              className={`import-dropzone compact${importDragging ? " dragging" : ""}`}
                              aria-disabled={importLocked}
                              onDragEnter={(event) => {
                                event.preventDefault();
                                if (
                                  !importLocked &&
                                  event.dataTransfer.types.includes("Files")
                                ) {
                                  importDragDepth.current++;
                                  setImportDragging(true);
                                }
                              }}
                              onDragOver={(event) => {
                                event.preventDefault();
                                event.dataTransfer.dropEffect = importLocked
                                  ? "none"
                                  : "copy";
                              }}
                              onDragLeave={(event) => {
                                event.preventDefault();
                                if (--importDragDepth.current <= 0) {
                                  importDragDepth.current = 0;
                                  setImportDragging(false);
                                }
                              }}
                              onDrop={(event) => {
                                event.preventDefault();
                                importDragDepth.current = 0;
                                setImportDragging(false);
                                const files = event.dataTransfer.files;
                                if (importLocked) return;
                                if (files.length > 1) {
                                  setError("补绘一次只能导入一个 KML 文件。");
                                  return;
                                }
                                const file = files[0];
                                if (file) acceptImport(file);
                              }}
                            >
                              <Upload
                                className="import-upload-icon"
                                aria-hidden="true"
                              />
                              <div>
                                {importFile && <strong>更换补绘文件</strong>}
                                <span>支持格式：.kml</span>
                              </div>
                              <Button
                                variant={importFile ? "outline" : "default"}
                                disabled={importLocked}
                                onClick={() => importInput.current?.click()}
                              >
                                {importFile ? "更换文件" : "选择文件"}
                              </Button>
                            </div>
                            {importFile && (
                              <section
                                aria-label="已选 KML 文件"
                                className="import-files"
                              >
                                <article
                                  className="import-file"
                                  aria-label={importFile.name}
                                  data-stage={
                                    importKml
                                      ? "done"
                                      : busy
                                        ? "reading"
                                        : "error"
                                  }
                                >
                                  <div className="import-file-main">
                                    <span
                                      className="import-state-icon"
                                      aria-hidden="true"
                                    >
                                      {busy ? (
                                        <LoaderCircle className="animate-spin" />
                                      ) : importKml ? (
                                        <Check />
                                      ) : (
                                        <CircleAlert />
                                      )}
                                    </span>
                                    <div className="import-file-info">
                                      <strong title={importFile.name}>
                                        {importFile.name}
                                      </strong>
                                      <div className="import-file-meta">
                                        <span>{fileSize(importFile.size)}</span>
                                        <span>
                                          {busy
                                            ? "正在检查轨迹"
                                            : importKml
                                              ? `检查通过 · ${drawing.length} 点`
                                              : importFailureInfo.label}
                                        </span>
                                      </div>
                                    </div>
                                    <div className="import-row-actions">
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        disabled={importLocked}
                                        title="移除文件"
                                        aria-label={`移除 ${importFile.name}`}
                                        onClick={clearImport}
                                      >
                                        <X aria-hidden="true" />
                                      </Button>
                                    </div>
                                  </div>
                                  {!busy &&
                                    !importKml &&
                                    importFailureInfo.detail && (
                                      <p className="import-file-error">
                                        {importFailureInfo.detail}
                                      </p>
                                    )}
                                </article>
                              </section>
                            )}
                          </>
                        ) : (
                          <>
                            <p className="text-xs text-muted-foreground">
                              点击地图绘制至少两个点，靠近端点自动吸附。
                            </p>
                            <p className="text-xs text-muted-foreground">
                              <span style={{ color: drawBeforeColor }}>
                                青色
                              </span>
                              为插入点之前的轨迹，
                              <span style={{ color: drawAfterColor }}>
                                紫色
                              </span>
                              为之后的轨迹。
                            </p>
                            <p className="text-right">
                              已画 {drawing.length} 点。
                            </p>
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
                      </>
                    )}
                    {mode === "fill_altitude" &&
                      (missingAltitude === undefined ? (
                        <Spin />
                      ) : missingAltitude === 0 ? (
                        <Alert
                          type="info"
                          title="该轨迹的高程数据完整，无需填充。"
                        />
                      ) : (
                        <div className="space-y-2">
                          <dl className="grid grid-cols-3 gap-2 rounded-md border p-3 text-sm">
                            <div>
                              <dt className="text-xs text-muted-foreground">
                                轨迹点
                              </dt>
                              <dd className="font-medium">{altitudePoints}</dd>
                            </div>
                            <div>
                              <dt className="text-xs text-muted-foreground">
                                缺失高程
                              </dt>
                              <dd className="font-medium">{missingAltitude}</dd>
                            </div>
                            <div>
                              <dt className="text-xs text-muted-foreground">
                                涉及片段
                              </dt>
                              <dd className="font-medium">
                                {altitudeSegments.length}
                              </dd>
                            </div>
                          </dl>
                          <ul className="max-h-40 space-y-1 overflow-auto text-sm">
                            {altitudeSegments.map((segment) => (
                              <li
                                key={segment.id}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                              >
                                <span className="font-medium">
                                  段 {segment.ordinal + 1}
                                </span>
                                <span className="flex items-center gap-2 text-muted-foreground">
                                  <span>
                                    缺 {segment.missing} / {segment.points} 点
                                  </span>
                                  <span className="rounded-full border px-2 py-0.5 text-xs">
                                    {segment.missing === segment.points
                                      ? "整段缺失"
                                      : "部分缺失"}
                                  </span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    {mode === "set_tag" &&
                      (tagData.data && config.data ? (
                        <TagPicker
                          config={config.data.config}
                          value={tag ?? currentTag}
                          onChange={setTag}
                          legend={
                            !currentTag ||
                            !isRegisteredTag(config.data.config, currentTag) ? (
                              <span
                                className={
                                  currentTag
                                    ? "tag-picker-note"
                                    : "tag-picker-missing"
                                }
                              >
                                当前：{currentTag || "未设置"}
                              </span>
                            ) : undefined
                          }
                        />
                      ) : (
                        !tagData.error && !config.error && <Spin />
                      ))}
                    {mode === "split_journey" && (
                      <SplitJourneyEditor
                        journeys={journeys}
                        assignments={assign}
                        segments={settings.order.flatMap((id) => {
                          const segment = d.segments.find(
                            (s) => s.segment_id === id,
                          );
                          return segment ? [segment] : [];
                        })}
                        selected={segmentId}
                        config={config.data?.config}
                        disabled={busy || !!active || !!preview}
                        error={splitError}
                        onName={(index, name) => {
                          setEditTouched(true);
                          setJourneys(
                            journeys.map((j, i) =>
                              i === index
                                ? { ...j, path: journeyPath(name, j.category) }
                                : j,
                            ),
                          );
                        }}
                        onTag={(index, value) => {
                          setEditTouched(true);
                          const category = tagCategory(value);
                          setJourneys(
                            journeys.map((j, i) =>
                              i === index
                                ? {
                                    ...j,
                                    tag: value,
                                    category,
                                    path: journeyPath(journeyName(j), category),
                                  }
                                : j,
                            ),
                          );
                        }}
                        onLocate={(id) => {
                          setSegment(id);
                          locateSegment(id);
                        }}
                        onSplit={(id) => {
                          if (journeys.some((j) => j.startSegmentId === id))
                            return;
                          const group = assign[id];
                          if (group === undefined) return;
                          setEditTouched(true);
                          let number = journeys.length + 1;
                          const baseName = d.entry.path
                            .split("/")
                            .at(-1)!
                            .replace(/\.kml$/i, "");
                          while (
                            journeys.some(
                              (j) =>
                                journeyName(j) === `${baseName}-行程${number}`,
                            )
                          )
                            number++;
                          setJourneys([
                            ...journeys.slice(0, group + 1),
                            {
                              startSegmentId: id,
                              path: journeyPath(
                                `${baseName}-行程${number}`,
                                d.entry.category,
                              ),
                              category: d.entry.category,
                            },
                            ...journeys.slice(group + 1),
                          ]);
                        }}
                        onMerge={(index) => {
                          if (index < 1) return;
                          setEditTouched(true);
                          setJourneys(journeys.filter((_, i) => i !== index));
                        }}
                      />
                    )}
                  </fieldset>
                  <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-background py-3">
                    {mode !== "fill_altitude" &&
                      mode !== "prune" &&
                      mode !== "split_segment" && (
                        <span className="mr-auto text-sm">
                          {busy || active
                            ? "正在处理…"
                            : showDraftState
                              ? draftDirty
                                ? "未保存修改"
                                : "尚未修改"
                              : ""}
                        </span>
                      )}
                    {mode === "draw" && drawMethod === "map" && (
                      <Button
                        disabled={
                          !drawing.length || busy || !!active || !!preview
                        }
                        onClick={() => {
                          setDrawing(drawing.slice(0, -1));
                          setSnapEnd(undefined);
                          if (drawing.length <= 1) setSnapStart(undefined);
                        }}
                      >
                        撤回
                      </Button>
                    )}
                    {(mode === "prune" || mode === "split_segment") && (
                      <Button
                        disabled={busy || !!active || !!preview}
                        onClick={() => void run(detect)}
                      >
                        {mode === "split_segment" ? "查找断点" : "查找漂移点"}
                      </Button>
                    )}
                    {mode !== "fill_altitude" && (
                      <Button
                        disabled={busy || !!active || !draftDirty}
                        onClick={resetDraft}
                      >
                        取消
                      </Button>
                    )}
                    <Button
                      variant={mode === "prune" ? "destructive" : "default"}
                      loading={busy || !!active}
                      disabled={!canSave || busy || !!active || !!preview}
                      onClick={() => void run(prepare)}
                    >
                      {mode === "fill_altitude"
                        ? "查询"
                        : mode === "split_journey"
                          ? "确认"
                          : mode === "prune"
                            ? "删除"
                            : "保存"}
                    </Button>
                  </div>
                </>
              )}
            </section>
          )}
          {preview && !directSave && mode === "split_journey" && (
            <Modal
              title="确认拆分行程"
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
                    确认
                  </Button>
                </>
              }
            >
              <p>
                将生成以下 {preview.outputs.length} 条行程，原行程保留在历史中。
              </p>
              <ul
                className="max-h-72 space-y-2 overflow-auto"
                aria-label="拆分结果"
              >
                {preview.outputs.map((o, i) => (
                  <li
                    key={i}
                    className="flex min-w-0 items-start gap-2 rounded-md border p-3"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-1.5 size-2.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor:
                          journeyColors[i % journeyColors.length],
                      }}
                    />
                    <div className="min-w-0 text-sm">
                      <p className="break-words font-medium">
                        {journeys[i]
                          ? journeyName(journeys[i]!)
                          : o.path
                              .split("/")
                              .at(-1)
                              ?.replace(/\.kml$/i, "")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {journeys[i]?.tag} · {o.segments.length} 个片段 ·{" "}
                        {o.segments.reduce(
                          (sum, segment) => sum + segment.point_count,
                          0,
                        )}{" "}
                        点
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
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
                        journeyColors[group % journeyColors.length]!,
                      ]),
                    )
                  : drawSegmentColors
              }
              onPick={pick}
              selectedSegment={
                view === "display" && !mode
                  ? segmentId
                  : mode === "draw" && drawing.length && !preview
                    ? "new-drawing"
                    : mode === "split_segment" ||
                        mode === "prune" ||
                        (mode === "split_journey" && !preview)
                      ? segmentId
                      : undefined
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
  onHeaderChange?: (
    header:
      { title: string; backLabel: string; onBack: () => void } | undefined,
  ) => void;
}) {
  return props.view === "history" ? (
    <TrackHistory entryId={props.initialEntry} active={props.active ?? true} />
  ) : (
    <TrackEditor {...props} />
  );
}
