import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Select,
  Spin,
  Modal,
  Pagination,
  Switch,
  message as toast,
} from "antd";
import { Link, useSearchParams } from "react-router-dom";
import { WorkspaceContext, type Panel } from "./workspace.js";
import type { WorkTask } from "../shared/work.js";
import type {
  Catalog,
  Cities,
  MapConfig,
  Selection,
  SelectedTrack,
} from "../shared/map.js";
import { useOverview, rememberedCamera, rememberCamera } from "./overview.js";
import type { OverviewVisibility } from "./overview-layer.js";
import { TRACK_STYLES } from "../shared/track-style.js";
import type { OverviewStatus } from "../shared/overview.js";
import type { Project } from "../shared/project.js";
import { frames } from "../drawing/core.js";
import {
  featureControls,
  featureReason,
  overlayReason,
  reconcileOverlays,
  cityReason,
} from "../drawing/layers.js";
import { api, request } from "./api.js";
import { MapViewport, type Viewport } from "./map-viewport.js";
import { ProjectPresentation } from "./project-presentation.js";
import type { Presentation } from "../shared/track-edit.js";
import "maplibre-gl/dist/maplibre-gl.css";
import "./map.css";
const WorkPage = lazy(() => import("./work-page.js"));
const TasksPage = lazy(() =>
  import("./work-page.js").then((m) => ({ default: m.TasksPage })),
);
import Settings from "./settings.js";
const panels: Record<Panel, string> = {
  library: "轨迹库",
  style: "地图样式",
  export: "出图",
  project: "项目",
  archive: "轨迹库管理",
  tracks: "轨迹处理",
  tasks: "处理记录",
  settings: "设置",
};
type Bootstrap = {
  config: MapConfig;
  state: Project;
  initialArchive: string;
  directory: string;
};
type Loaded = { state: Project; versionsChanged: boolean } & Selection;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const download = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
export default function MapPage() {
  const [params] = useSearchParams();
  const bootstrap = useQuery({
    queryKey: ["map-bootstrap"],
    // Bootstrap resources own the renderer lifetime; refresh them on page reload.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) =>
      api<Bootstrap>("/api/bootstrap", undefined, signal),
  });
  const cities = useQuery({
    queryKey: ["cities"],
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) => api<Cities>("/api/cities", undefined, signal),
  });
  if (bootstrap.isError || cities.isError)
    return (
      <div role="alert">
        <Alert
          type="error"
          title="地图资源加载失败"
          description={(bootstrap.error ?? cities.error)?.message}
        />
        <Button
          onClick={() => {
            void bootstrap.refetch();
            void cities.refetch();
          }}
        >
          重试
        </Button>
        <Link to="/map?panel=settings">设置</Link>
        {params.get("panel") === "settings" && (
          <Suspense fallback={<Spin />}>
            <Settings />
          </Suspense>
        )}
      </div>
    );
  if (!bootstrap.data || !cities.data)
    return (
      <div role="status">
        <Spin /> 正在准备地图与字体…
      </div>
    );
  return <Editor initial={bootstrap.data} cities={cities.data} />;
}
function Editor({ initial, cities }: { initial: Bootstrap; cities: Cities }) {
  const [messages, messageHolder] = toast.useMessage({ maxCount: 1 });
  const [browseVisibility, setBrowseVisibility] = useState<OverviewVisibility>({
    all: true,
    exceptions: {},
  });
  const [browseState, setBrowseState] = useState(() => ({
      ...initial.state,
      camera: rememberedCamera(initial.initialArchive) ?? initial.state.camera,
    })),
    [browseTracks, setBrowseTracks] = useState<SelectedTrack[]>([]),
    [projectState, setProjectState] = useState<Project>(),
    [projectTracks, setProjectTracks] = useState<SelectedTrack[]>([]),
    [baseline, setBaseline] = useState(""),
    [leaving, setLeaving] = useState(false),
    [catalog, setCatalog] = useState<Catalog>(),
    [browseFilter, setBrowseFilter] = useState(""),
    [browseKind, setBrowseKind] = useState("all"),
    [projectFilter, setProjectFilter] = useState(""),
    [projectKind, setProjectKind] = useState("all"),
    [names, setNames] = useState<string[]>([]),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [exporting, setExporting] = useState(false),
    [switching, setSwitching] = useState(""),
    [preview, setPreview] = useState(false),
    [sourceErrors, setSourceErrors] = useState<Selection["errors"]>([]),
    [versionChanged, setVersionChanged] = useState(false);
  const inProject = projectState !== undefined;
  const state = projectState ?? browseState;
  const filter = inProject ? projectFilter : browseFilter;
  const setFilter = inProject ? setProjectFilter : setBrowseFilter;
  const kind = inProject ? projectKind : browseKind;
  const setKind = inProject ? setProjectKind : setBrowseKind;
  const tracks = inProject ? projectTracks : browseTracks;
  const dirty = inProject && JSON.stringify(projectState) !== baseline;
  const setState = (update: Project | ((prev: Project) => Project)) => {
    if (inProject)
      setProjectState((prev) =>
        typeof update === "function" ? update(prev!) : update,
      );
    else setBrowseState(update);
  };
  const setTracks = inProject ? setProjectTracks : setBrowseTracks;
  const browsePanel = useRef("library");
  const [params, setParams] = useSearchParams();
  const rawPanel = params.get("panel") ?? "library";
  const panel = Object.hasOwn(panels, rawPanel)
    ? rawPanel === "style"
      ? "settings"
      : (rawPanel as Panel)
    : undefined;
  const trackPanel = useRef<Panel>("library");
  const group =
    panel === "archive" || panel === "library"
      ? "library"
      : panel === "tracks" || panel === "tasks"
        ? "processing"
        : "export";
  const exportPanel = panel === "export" || panel === "project";
  const [visited, setVisited] = useState<Set<Panel>>(new Set());
  const [inspection, setInspection] = useState<{
    id: string;
    tracks: SelectedTrack[];
    camera: Project["camera"];
  }>();
  const inspectionSequence = useRef(0);
  const activeTasks = useQuery({
    queryKey: ["tasks"],
    queryFn: ({ signal }) =>
      api<{ tasks: WorkTask[] }>("/api/work/tasks", undefined, signal),
    refetchInterval: 3000,
  });
  const running =
    activeTasks.data?.tasks.filter(
      (t) =>
        !t.request.operation.startsWith("exif:") &&
        ["queued", "running"].includes(t.status),
    ).length ?? 0;
  const openPanel = (next: Panel, task?: string) => {
    if (!inProject && !exportPanel && (next === "export" || next === "project"))
      browsePanel.current = rawPanel;
    setParams(
      task
        ? { panel: next, [next === "tasks" ? "id" : "task"]: task }
        : { panel: next },
    );
  };
  useEffect(() => {
    if (panel) {
      setVisited((old) => new Set([...old, panel]));
      if (panel !== "settings") trackPanel.current = panel;
    }
  }, [panel]);
  const refreshCatalog = async (path: string) => {
    if (
      catalog &&
      path !== catalog.archive &&
      path.replace(/[/\\]archive\.sqlite3$/, "") !==
        catalog.archive.replace(/[/\\]archive\.sqlite3$/, "")
    ) {
      throw new Error(
        "该处理记录来自其他轨迹库；当前网页只使用后台配置的轨迹库。",
      );
    }
    if (!catalog) {
      await openArchive(initial.initialArchive);
      return;
    }
    const next = await api<Catalog>("/api/archive", { path: catalog.archive });
    setCatalog(next);
    setNotice("轨迹库已刷新；当前地图选择和构图已保留。");
  };
  const inspect = async (id: string) => {
    const sequence = ++inspectionSequence.current;
    const result = await api<{ tracks: SelectedTrack[] }>(
      `/api/work/tasks/${id}/geometry`,
      {},
    );
    if (sequence !== inspectionSequence.current) return;
    setInspection({
      id,
      tracks: result.tracks,
      camera: stateRef.current.camera,
    });
    setParams({ panel: "none" });
  };
  useEffect(() => {
    if (inspection) viewport.current?.fit(inspection.tracks);
  }, [inspection?.id]);
  const viewport = useRef<Viewport>(null),
    selection = useRef<AbortController | undefined>(undefined),
    operations = useRef(0),
    sourceSequence = useRef(0),
    stateRef = useRef(state),
    file = useRef<HTMLInputElement>(null);
  stateRef.current = state;
  const config = initial.config;
  const crs =
    config.basemaps.find((b) => b.id === state.style.basemap)?.crs === "gcj02"
      ? "gcj02"
      : "wgs84";
  const browseCrs =
    config.basemaps.find((b) => b.id === browseState.style.basemap)?.crs ===
    "gcj02"
      ? "gcj02"
      : "wgs84";
  const browseOverview = useOverview(browseCrs, browseFilter, browseKind);
  const projectOverview = useOverview(
    crs,
    projectFilter,
    projectKind,
    inProject,
  );
  const overview = inProject ? projectOverview : browseOverview;
  const fitted = useRef(!!rememberedCamera(initial.initialArchive));
  const browsing = !inProject && !inspection;
  useEffect(() => {
    if (
      !fitted.current &&
      overview.query.data?.bounds &&
      overview.query.data.version &&
      browsing
    ) {
      fitted.current = true;
      viewport.current?.fitOverview(overview.query.data.bounds);
    }
  }, [overview.query.data?.version, browsing]);
  const retryOverview = async () => {
    try {
      await overview.retry();
      viewport.current?.retryOverview();
    } catch (e) {
      overview.setTileError(message(e));
    }
  };
  const confirmDiscard = () =>
    !dirty || window.confirm("有尚未保存的修改，是否放弃？");
  const change = (edit: (next: Project) => void) => {
    setState((prev) => {
      const next = structuredClone(prev);
      edit(next);
      return next;
    });
  };
  const refreshNames = async (path: string) =>
    setNames(
      (await api<{ names: string[] }>("/api/projects", { archive: path }))
        .names,
    );
  const openArchive = async (path = initial.initialArchive, force = false) => {
    if (!force && !confirmDiscard()) return;
    const sequence = ++operations.current;
    selection.current?.abort();
    setBusy(true);
    setError("");
    try {
      const data = await api<Catalog>("/api/archive", { path });
      if (sequence !== operations.current) return;
      setCatalog(data);
      if (!inProject) setBrowseVisibility({ all: true, exceptions: {} });
      setTracks([]);
      setSourceErrors([]);
      setName("");
      setState((prev) => ({ ...prev, archive: data.archive, tracks: [] }));
      setBaseline("");
      await refreshNames(data.archive);
    } catch (e) {
      setError(message(e));
    } finally {
      if (sequence === operations.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (initial.initialArchive) void openArchive(initial.initialArchive, true);
    return () => {
      operations.current++;
      sourceSequence.current++;
      selection.current?.abort();
    };
  }, []);
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  const select = async (entries: string[]) => {
    if (!catalog) return;
    selection.current?.abort();
    const controller = new AbortController();
    selection.current = controller;
    const sequence = ++operations.current;
    setBusy(true);
    setError("");
    try {
      const result = await api<Selection>(
        "/api/selection",
        {
          archive: catalog.archive,
          entries: inProject
            ? entries.filter(
                (entry) => !state.tracks.some((t) => t.entry === entry),
              )
            : entries,
        },
        controller.signal,
      );
      if (sequence !== operations.current) return;
      if (inProject) {
        result.tracks = entries.flatMap(
          (entry) =>
            projectTracks.find((t) => t.entry === entry) ??
            result.tracks.find((t) => t.entry === entry) ??
            [],
        );
        result.errors = [
          ...sourceErrors.filter(
            (e) =>
              entries.includes(e.entry) &&
              state.tracks.some((t) => t.entry === e.entry),
          ),
          ...result.errors,
        ];
      }
      setTracks(result.tracks);
      setSourceErrors(result.errors);
      change((s) => {
        s.archive = result.archive;
        const previous = new Map(s.tracks.map((t) => [t.entry, t]));
        s.tracks = entries.flatMap((entry) => {
          const old = inProject ? previous.get(entry) : undefined;
          const track = result.tracks.find((t) => t.entry === entry);
          return (
            old ??
            (track ? (track.reference ?? { entry, sha256: track.sha256 }) : [])
          );
        });
        s.schema = s.tracks.every((t) => t.entry_id) ? 3 : 2;
      });
      setNotice(
        `已选择 ${result.tracks.length} 条轨迹，共 ${result.tracks.reduce((n, t) => n + t.points, 0).toLocaleString()} 个点`,
      );
    } catch (e) {
      if (!controller.signal.aborted) setError(message(e));
    } finally {
      if (sequence === operations.current) setBusy(false);
    }
  };
  const chooseBrowse = (next: OverviewVisibility) => {
    setBrowseVisibility(next);
    if (next.all === Object.hasOwn(next.exceptions, browseOverview.id)) {
      browseOverview.setId("");
      browseOverview.setCandidates([]);
    }
    const entries = next.all ? [] : Object.values(next.exceptions);
    // Visibility uses vector tile filters, so selecting the whole archive never
    // downloads every track. Detailed geometry remains bounded for editing/export.
    if (!next.all && entries.length <= 200) void select(entries);
    else {
      selection.current?.abort();
      operations.current++;
      setBusy(false);
      setBrowseTracks([]);
      setBrowseState((s) => ({ ...s, tracks: [] }));
      setSourceErrors([]);
      setNotice(
        next.all
          ? "已更新地图显示"
          : `已显示 ${entries.length} 条轨迹；处理或出图请选不超过 200 条。`,
      );
    }
  };
  const toggleBrowse = (id: string, entry: string, checked: boolean) => {
    const exceptions = { ...browseVisibility.exceptions };
    if (checked === browseVisibility.all) delete exceptions[id];
    else exceptions[id] = entry;
    chooseBrowse({ ...browseVisibility, exceptions });
  };
  const projectPresentation = async (
    entry_id: string,
    settings: Presentation | null | undefined,
  ) => {
    setBusy(true);
    setError("");
    try {
      const result = await api<Loaded>(
        settings === undefined
          ? "/api/project/update-track"
          : "/api/project/presentation",
        {
          state: stateRef.current,
          entry_id,
          ...(settings === undefined ? {} : { settings }),
        },
      );
      if (result.errors.length)
        throw new Error(result.errors.map((e) => e.error).join("；"));
      setProjectState(result.state);
      setProjectTracks(result.tracks);
      setSourceErrors([]);
      setNotice("当前项目已更新，保存项目后保留；库默认展示未改动。");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const exportKml = async () => {
    setBusy(true);
    setError("");
    try {
      const { job } = await api<{ job: string }>(
        "/api/export-kml",
        stateRef.current,
      );
      download(
        await (await request(`/api/jobs/${job}/kml`)).blob(),
        "tracktool-display.kml",
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const switchBase = async (id: string) => {
    const sequence = ++sourceSequence.current;
    viewport.current?.cancel();
    setSwitching(id);
    setError("");
    const next = structuredClone(stateRef.current);
    next.style.basemap = id;
    const notes = reconcileOverlays(next, config);
    try {
      if (config.basemaps.some((b) => b.id === id))
        await api("/api/basemap-check", { id });
      if (sequence !== sourceSequence.current) return;
      const targetCrs =
        config.basemaps.find((b) => b.id === id)?.crs === "gcj02"
          ? "gcj02"
          : "wgs84";
      let prepared: OverviewStatus | undefined;
      if (browsing) {
        const deadline = Date.now() + 120000;
        while (sequence === sourceSequence.current) {
          prepared = await api<OverviewStatus>(
            `/api/overview?crs=${targetCrs}`,
          );
          if (prepared.version || prepared.state === "unconfigured") break;
          if (prepared.state === "error") throw new Error(prepared.error);
          if (Date.now() > deadline)
            throw new Error("轨迹概览准备超时，请重试");
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (sequence !== sourceSequence.current) return;
      if (await viewport.current?.stage(next, prepared)) {
        change((s) => {
          s.style.basemap = id;
          s.style.overlays = next.style.overlays;
        });
        setNotice(notes.join("；"));
      }
    } catch (e) {
      if (sequence === sourceSequence.current)
        setError(`底图切换失败，原地图已保留：${message(e)}；可再次选择重试`);
    } finally {
      if (sequence === sourceSequence.current) setSwitching("");
    }
  };
  const load = async (value?: unknown) => {
    if (!confirmDiscard()) return;
    setBusy(true);
    setError("");
    selection.current?.abort();
    const sequence = ++operations.current;
    ++sourceSequence.current;
    viewport.current?.cancel();
    try {
      const result =
        value === undefined
          ? await api<Loaded>("/api/projects/load", {
              archive: state.archive,
              name,
            })
          : await api<Loaded>(
              "/api/project",
              value && typeof value === "object" && !Array.isArray(value)
                ? {
                    ...value,
                    archive: catalog?.archive ?? initial.initialArchive,
                  }
                : value,
            );
      const data = result.state.archive
        ? await api<Catalog>("/api/archive", { path: result.state.archive })
        : undefined;
      if (sequence !== operations.current) return;
      if (
        !(await viewport.current?.stage(result.state, undefined, {
          tracks: result.tracks,
          preview: true,
          hideOverview: true,
        }))
      )
        return;
      if (!inProject && !exportPanel) browsePanel.current = rawPanel;
      fitted.current = true;
      setProjectFilter("");
      setProjectKind("all");
      projectOverview.setId("");
      projectOverview.setOffset(0);
      setProjectState(result.state);
      setProjectTracks(result.tracks);
      setPreview(true);
      if (value !== undefined) setName("");
      setSourceErrors(result.errors);
      setCatalog(data);
      setVersionChanged(result.versionsChanged);
      setBaseline(JSON.stringify(result.state));
      setNotice(
        typeof result.state.migration === "string"
          ? result.state.migration
          : "项目已载入",
      );
      if (result.state.archive) await refreshNames(result.state.archive);
    } catch (e) {
      setError(message(e));
    } finally {
      if (sequence === operations.current) setBusy(false);
    }
  };
  const save = async () => {
    if (names.includes(name) && !window.confirm(`覆盖项目「${name}」？`))
      return false;
    setBusy(true);
    setError("");
    const snapshot = structuredClone(state);
    try {
      await api("/api/projects/save", { name, state: snapshot });
      setBaseline(JSON.stringify(snapshot));
      await refreshNames(state.archive);
      setNotice("项目已保存");
      return JSON.stringify(stateRef.current) === JSON.stringify(snapshot);
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const newProject = async () => {
    if (busy || switching || inspection) return;
    setBusy(true);
    setError("");
    try {
      const entries = browseTracks.length
        ? browseTracks.map((t) => t.entry)
        : overview.selected
          ? [overview.selected.entry]
          : [];
      const result = entries.length
        ? await api<Selection>("/api/selection", {
            archive: catalog?.archive,
            entries,
          })
        : { tracks: [], errors: [] };
      if (result.errors.length)
        throw new Error(
          result.errors.map((e) => `${e.entry}：${e.error}`).join("；"),
        );
      const next = structuredClone(initial.state);
      next.archive = catalog?.archive ?? initial.initialArchive;
      next.camera = structuredClone(browseState.camera);
      next.style = structuredClone(browseState.style);
      next.tracks = result.tracks.map(
        (t) => t.reference ?? { entry: t.entry, sha256: t.sha256 },
      );
      next.schema = next.tracks.every((t) => t.entry_id) ? 3 : 2;
      if (!exportPanel) browsePanel.current = rawPanel;
      fitted.current = true;
      setProjectFilter("");
      setProjectKind("all");
      projectOverview.setId("");
      projectOverview.setOffset(0);
      setProjectState(next);
      setProjectTracks(result.tracks);
      setBaseline(JSON.stringify(next));
      setName("");
      setSourceErrors([]);
      setVersionChanged(false);
      setPreview(true);
      setNotice("已新建出图工程；带入当前视野与所选轨迹。");
      openPanel("export");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const returnToBrowse = async () => {
    setBusy(true);
    setError("");
    try {
      if (
        !(await viewport.current?.stage(
          browseState,
          browseOverview.query.data,
          {
            tracks: [],
            preview: false,
            hideOverview: false,
          },
        ))
      )
        return;
      setProjectState(undefined);
      setProjectTracks([]);
      setSourceErrors([]);
      setVersionChanged(false);
      setPreview(false);
      setLeaving(false);
      setNotice("");
      setParams({ panel: browsePanel.current });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const exportPng = async () => {
    setExporting(true);
    setError("");
    try {
      await viewport.current?.ready();
      const { job } = await api<{ job: string }>("/api/export", state);
      let done = false;
      for (let i = 0; i < 240; i++) {
        const result = await api<{ status: string; error: string }>(
          `/api/jobs/${job}`,
        );
        if (result.status === "failed") throw new Error(result.error);
        if (result.status === "done") {
          download(
            await (await request(`/api/jobs/${job}/png`)).blob(),
            "tracktool-map.png",
          );
          done = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!done) throw new Error("导出等待超时");
      setNotice("PNG 已导出");
    } catch (e) {
      setError(message(e));
    } finally {
      setExporting(false);
    }
  };
  useEffect(() => {
    if (!notice) return;
    void messages.success({ content: notice, duration: 4 });
    setNotice("");
  }, [notice, messages]);
  const overviewError = browsing
    ? (overview.query.error?.message ??
      overview.query.data?.error ??
      overview.tileError)
    : "";
  const loadingText = exporting
    ? "正在导出地图…"
    : switching
      ? "正在准备新底图…"
      : busy
        ? "正在读取轨迹…"
        : browsing &&
            !overviewError &&
            (overview.query.isPending ||
              overview.query.data?.state === "building" ||
              overview.query.data?.updating ||
              overview.loading)
          ? overview.query.data?.progress
            ? `正在准备轨迹 · ${overview.query.data.progress.completed}/${overview.query.data.progress.total}`
            : "正在加载轨迹…"
          : "";
  const [showLoading, setShowLoading] = useState(false);
  const loading = !!loadingText;
  useEffect(() => {
    if (!loading) {
      setShowLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowLoading(true), 180);
    return () => clearTimeout(timer);
  }, [loading]);
  const visible = overview.list.data?.entries ?? [];
  const invalid = sourceErrors.length > 0 || versionChanged;
  return (
    <WorkspaceContext.Provider
      value={{
        archive: catalog?.archive ?? initial.initialArchive,
        selected: tracks,
        open: openPanel,
        inspect,
        refresh: refreshCatalog,
      }}
    >
      <div className="map-app">
        {messageHolder}
        <header className="map-header">
          <div className="map-brand">
            <span className="brand">TRACKTOOL</span>
            <h1>轨迹地图</h1>
          </div>
          <nav aria-label="地图工具">
            <Button
              type={panel && panel !== "settings" ? "primary" : "text"}
              aria-pressed={!!panel && panel !== "settings"}
              onClick={() =>
                panel && panel !== "settings"
                  ? setParams({ panel: "none" })
                  : openPanel(trackPanel.current)
              }
            >
              轨迹
            </Button>
            <Button
              type={panel === "settings" ? "primary" : "text"}
              aria-pressed={panel === "settings"}
              onClick={() =>
                panel === "settings"
                  ? setParams({ panel: "none" })
                  : openPanel("settings")
              }
            >
              设置
            </Button>
          </nav>
        </header>
        <div className="map-content">
          <aside
            className={`map-controls${panel && ["archive", "tracks", "tasks", "settings"].includes(panel) ? " wide" : ""}`}
            hidden={!panel}
            aria-label="地图控制面板"
          >
            <div className="panel-heading">
              <div className="panel-title">
                <h2>{panel === "settings" ? "设置" : "轨迹"}</h2>
                <Button
                  aria-label="收起控制面板"
                  onClick={() => setParams({ panel: "none" })}
                >
                  收起
                </Button>
              </div>
              {panel !== "settings" && (
                <nav
                  className="track-tabs"
                  aria-label="轨迹功能"
                  role="tablist"
                >
                  {(
                    [
                      ["library", "轨迹库"],
                      ["processing", "轨迹处理"],
                      ["export", "轨迹导出"],
                    ] as const
                  ).map(([key, label]) => (
                    <Button
                      key={key}
                      role="tab"
                      aria-selected={group === key}
                      type={group === key ? "primary" : "text"}
                      onClick={() =>
                        openPanel(key === "processing" ? "tracks" : key)
                      }
                    >
                      {label}
                    </Button>
                  ))}
                </nav>
              )}
            </div>
            {panel !== "settings" && (
              <>
                <span className="save-state">
                  {inProject ? (dirty ? "未保存" : "出图工程") : "浏览地图"}
                </span>
                {group === "library" && (
                  <nav className="panel-subnav" aria-label="轨迹库操作">
                    <Button
                      type={panel === "library" ? "primary" : "default"}
                      onClick={() => openPanel("library")}
                    >
                      查看
                    </Button>
                    <Button
                      type={panel === "archive" ? "primary" : "default"}
                      onClick={() => openPanel("archive")}
                    >
                      管理轨迹库
                    </Button>
                  </nav>
                )}
                {group === "processing" && (
                  <nav className="panel-subnav" aria-label="轨迹处理操作">
                    <Button
                      type={panel === "tracks" ? "primary" : "default"}
                      onClick={() => openPanel("tracks")}
                    >
                      处理轨迹
                    </Button>
                    <Button
                      type={panel === "tasks" ? "primary" : "default"}
                      onClick={() => openPanel("tasks")}
                    >
                      处理记录{running ? ` · ${running} 项进行中` : ""}
                    </Button>
                  </nav>
                )}
              </>
            )}
            {exportPanel && (
              <section className="project-entry">
                <h3>地图出图</h3>
                {inProject ? (
                  <Button
                    disabled={busy || exporting || !!switching || !!inspection}
                    onClick={() =>
                      dirty ? setLeaving(true) : void returnToBrowse()
                    }
                  >
                    返回浏览
                  </Button>
                ) : (
                  <>
                    <p className="overview-hint">
                      选择轨迹并制作地图图片；新建时带入当前视野与选择。
                    </p>
                    <Button
                      type="primary"
                      disabled={
                        busy ||
                        !!switching ||
                        !!inspection ||
                        !catalog ||
                        (!browseTracks.length &&
                          !!overview.id &&
                          !overview.selected)
                      }
                      onClick={() => void newProject()}
                    >
                      新建出图工程
                    </Button>
                    <Button
                      disabled={busy || !!switching || !!inspection || !catalog}
                      onClick={() => openPanel("project")}
                    >
                      打开已有工程
                    </Button>
                  </>
                )}
              </section>
            )}
            <section hidden={panel !== "library"}>
              <details className="category-legend">
                <summary>轨迹分类图例</summary>
                {Object.entries(TRACK_STYLES).map(([key, style]) => (
                  <div key={key}>
                    <span
                      className="legend-line"
                      style={{
                        background: style.color,
                        opacity: style.opacity,
                      }}
                    />
                    <span>{style.label}</span>
                    <small>
                      {Math.round(style.opacity * 1000) / 10}% 不透明度
                    </small>
                  </div>
                ))}
              </details>
              <div className="library-intro">
                <p>
                  {catalog
                    ? `${overview.query.data?.summary?.entries ?? catalog.entries.length} 条轨迹 · 已选 ${tracks.length} 条`
                    : busy
                      ? "正在读取后台配置的轨迹库。"
                      : "未能读取轨迹库，请检查后台配置。"}
                </p>
              </div>
              {overview.query.data?.state === "unconfigured" && (
                <p>后台尚未配置轨迹库</p>
              )}
              {overview.query.data?.summary?.entries === 0 && (
                <p>
                  轨迹库为空，可以导入 KML 开始浏览。
                  <Button onClick={() => openPanel("archive")}>导入 KML</Button>
                </p>
              )}
              {!!overview.query.data?.summary?.invalid && (
                <p className="overview-hint">
                  {overview.query.data.summary.invalid}{" "}
                  条轨迹存在异常，可在列表查看原因。
                </p>
              )}
              {!catalog && (
                <Button
                  loading={busy}
                  onClick={() => void openArchive(initial.initialArchive, true)}
                >
                  重新读取轨迹库
                </Button>
              )}
              {catalog && (
                <>
                  <p className="overview-hint">
                    {inProject
                      ? "勾选需要出图的轨迹；地图只显示工程所选轨迹。"
                      : "勾选控制地图显示，初始全选。搜索只筛选列表；清空后可只勾选要查看的轨迹。"}
                  </p>
                  <label htmlFor="filter">筛选轨迹</label>
                  <Input
                    id="filter"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  <Select
                    aria-label="轨迹分类"
                    value={kind}
                    options={[
                      { value: "all", label: "全部分类" },
                      ...Array.from(
                        new Set(catalog.entries.map((e) => e.kind)),
                      ).map((value) => ({ value, label: value })),
                    ]}
                    onChange={setKind}
                  />
                  <div className="map-track-list">
                    {visible.map((e) => (
                      <div
                        key={e.id}
                        className={`overview-row${overview.id === e.id ? " selected" : ""}`}
                      >
                        <Checkbox
                          checked={
                            inProject
                              ? state.tracks.some((t) => t.entry === e.entry)
                              : browseVisibility.all !==
                                Object.hasOwn(browseVisibility.exceptions, e.id)
                          }
                          disabled={busy}
                          onChange={(v) =>
                            inProject
                              ? void select(
                                  v.target.checked
                                    ? [
                                        ...state.tracks.map((t) => t.entry),
                                        e.entry,
                                      ]
                                    : state.tracks
                                        .filter((t) => t.entry !== e.entry)
                                        .map((t) => t.entry),
                                )
                              : toggleBrowse(e.id, e.entry, v.target.checked)
                          }
                        >
                          {e.entry}
                        </Checkbox>
                        <Button
                          size="small"
                          aria-label={`查看 ${e.entry}`}
                          aria-pressed={overview.id === e.id}
                          onClick={() => {
                            overview.setCandidates([]);
                            overview.setId(e.id);
                          }}
                        >
                          查看
                        </Button>
                        {e.error && (
                          <span className="map-error">{e.error}</span>
                        )}
                      </div>
                    ))}
                  </div>
                  {overview.list.isFetching && <span>正在读取轨迹列表…</span>}
                  {overview.list.error && (
                    <div role="alert">
                      {overview.list.error.message}
                      <Button onClick={() => void overview.list.refetch()}>
                        重试列表
                      </Button>
                    </div>
                  )}
                  {overview.list.data?.total === 0 && <p>没有匹配的轨迹。</p>}
                  <Pagination
                    showSizeChanger={false}
                    simple
                    current={Math.floor(overview.offset / 50) + 1}
                    pageSize={50}
                    total={overview.list.data?.total ?? 0}
                    onChange={(page) => overview.setOffset((page - 1) * 50)}
                    hideOnSinglePage
                  />
                  <div className="map-actions">
                    {!inProject && (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          chooseBrowse({ all: true, exceptions: {} })
                        }
                      >
                        全选轨迹
                      </Button>
                    )}
                    <Button
                      onClick={() => {
                        const bounds = overview.query.data?.bounds;
                        if (bounds) viewport.current?.fitOverview(bounds);
                      }}
                      disabled={!overview.query.data?.bounds}
                    >
                      查看全库
                    </Button>
                    <Button
                      disabled={busy || !visible.length || visible.length > 200}
                      onClick={() =>
                        inProject
                          ? void select(visible.map((e) => e.entry))
                          : chooseBrowse({
                              all: false,
                              exceptions: Object.fromEntries(
                                visible.map((e) => [e.id, e.entry]),
                              ),
                            })
                      }
                    >
                      选择本页轨迹
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        inProject
                          ? void select([])
                          : chooseBrowse({ all: false, exceptions: {} })
                      }
                    >
                      清空选择
                    </Button>
                    <Button
                      onClick={() => viewport.current?.fit(tracks)}
                      disabled={!tracks.length}
                    >
                      适合轨迹
                    </Button>
                  </div>
                </>
              )}
              {!!tracks.length && (
                <>
                  <h2>已选轨迹</h2>
                  <div className="map-track-list">
                    {tracks.map((t) => (
                      <div key={t.entry}>
                        <span>{t.entry}</span>
                        <div className="map-actions">
                          <Button
                            size="small"
                            aria-label={`定位 ${t.entry}`}
                            onClick={() => viewport.current?.fit([t])}
                          >
                            定位
                          </Button>
                          <Button
                            size="small"
                            aria-label={`移除 ${t.entry}`}
                            disabled={busy}
                            onClick={() =>
                              inProject
                                ? void select(
                                    state.tracks
                                      .filter((s) => s.entry !== t.entry)
                                      .map((s) => s.entry),
                                  )
                                : chooseBrowse({
                                    ...browseVisibility,
                                    exceptions: Object.fromEntries(
                                      Object.entries(
                                        browseVisibility.exceptions,
                                      ).filter(
                                        ([, entry]) => entry !== t.entry,
                                      ),
                                    ),
                                  })
                            }
                          >
                            移除
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {!!tracks.length && (
                <Button
                  type="primary"
                  block
                  onClick={() => openPanel("tracks")}
                >
                  处理已选轨迹 · {tracks.length}
                </Button>
              )}
            </section>
            <section hidden={panel !== "settings"}>
              <Settings inProject={inProject}>
                <h3>地图样式</h3>
                <label>底图</label>
                <Select
                  showSearch
                  optionFilterProp="label"
                  aria-label="底图"
                  value={switching || state.style.basemap}
                  loading={!!switching}
                  onChange={(id) => void switchBase(id)}
                  options={[
                    { value: "light", label: "浅色矢量" },
                    { value: "dark", label: "深色矢量" },
                    ...(config.satellite
                      ? [{ value: "satellite", label: "自定义卫星" }]
                      : []),
                    ...config.basemaps.map((b) => ({
                      value: b.id,
                      label: `${b.group} · ${b.name}`,
                    })),
                  ]}
                />
                <label>城市标注</label>
                <Select
                  aria-label="城市标注"
                  value={state.style.cities}
                  disabled={!!cityReason(state, config)}
                  options={[
                    { value: "county", label: "县级及以上" },
                    { value: "none", label: "关闭" },
                  ]}
                  onChange={(value) =>
                    change((s) => {
                      s.style.cities = value;
                    })
                  }
                />
                <details>
                  <summary>地图要素与叠加层</summary>
                  {Object.entries(featureControls).map(
                    ([key, [label, options]]) => (
                      <div key={key} title={featureReason(state, config, key)}>
                        <label>{label}</label>
                        <Select
                          aria-label={label}
                          disabled={!!featureReason(state, config, key)}
                          value={state.style.features[key]}
                          options={Object.entries(options).map(
                            ([value, label]) => ({
                              value,
                              label,
                            }),
                          )}
                          onChange={(value) =>
                            change((s) => {
                              s.style.features[key] = value;
                            })
                          }
                        />
                      </div>
                    ),
                  )}
                  {config.overlays.map((o) => (
                    <div key={o.id} title={overlayReason(state, config, o)}>
                      <Checkbox
                        disabled={!!overlayReason(state, config, o)}
                        checked={state.style.overlays.some(
                          (s) => s.id === o.id && s.enabled,
                        )}
                        onChange={(v) =>
                          change((s) => {
                            s.style.overlays = s.style.overlays
                              .filter((i) => i.id !== o.id)
                              .concat({
                                id: o.id,
                                enabled: v.target.checked,
                                opacity: 1,
                              });
                          })
                        }
                      >
                        {o.name}
                      </Checkbox>
                      <InputNumber
                        aria-label={`${o.name}透明度`}
                        min={0.1}
                        max={1}
                        step={0.1}
                        value={
                          state.style.overlays.find((s) => s.id === o.id)
                            ?.opacity ?? 1
                        }
                        onChange={(value) =>
                          change((s) => {
                            const item = s.style.overlays.find(
                              (i) => i.id === o.id,
                            );
                            if (item) item.opacity = value ?? 1;
                          })
                        }
                      />
                    </div>
                  ))}
                  <label>电力最低电压（kV）</label>
                  <Select
                    aria-label="电力最低电压"
                    value={state.style.power.min_voltage}
                    options={[0, 110, 220, 500].map((value) => ({
                      value,
                      label: String(value),
                    }))}
                    onChange={(value) =>
                      change((s) => {
                        s.style.power.min_voltage = value;
                      })
                    }
                  />
                  <label>电力设施</label>
                  <Select
                    aria-label="电力设施"
                    value={state.style.power.facilities}
                    options={[
                      ["none", "关闭"],
                      ["substations", "变电站"],
                      ["generation", "发电设施"],
                      ["all", "全部"],
                    ].map(([value, label]) => ({ value, label }))}
                    onChange={(value) =>
                      change((s) => {
                        s.style.power.facilities = value;
                      })
                    }
                  />
                </details>
              </Settings>
            </section>
            <section hidden={!exportPanel || !inProject}>
              <div className="map-actions">
                <Button onClick={() => openPanel("library")}>
                  选择轨迹 · {tracks.length}
                </Button>
                <Button onClick={() => openPanel("settings")}>调整底图</Button>
              </div>
              <h3>工程样式</h3>
              <div hidden={!inProject}>
                <label htmlFor="title">标题</label>
                <Input
                  id="title"
                  value={state.title}
                  onChange={(e) =>
                    change((s) => {
                      s.title = e.target.value;
                    })
                  }
                />
                <label htmlFor="track-color">轨迹颜色</label>
                <input
                  id="track-color"
                  type="color"
                  value={state.style.color}
                  onChange={(e) =>
                    change((s) => {
                      s.style.color = e.target.value;
                    })
                  }
                />
                <label>线宽</label>
                <InputNumber
                  aria-label="线宽"
                  min={0.5}
                  max={12}
                  step={0.5}
                  value={state.style.width}
                  onChange={(v) =>
                    change((s) => {
                      s.style.width = v ?? 3;
                    })
                  }
                />
              </div>
              <h2>画框与输出</h2>
              <label>画框比例</label>
              <Select
                aria-label="画框比例"
                value={state.frame.ratio}
                options={Object.keys(frames).map((value) => ({
                  value,
                  label: value,
                }))}
                onChange={(ratio: Project["frame"]["ratio"]) =>
                  change((s) => {
                    const [width, height] = frames[ratio] as [number, number];
                    s.frame = { ratio, width, height };
                    const outputWidth = Math.max(
                      256,
                      Math.min(
                        4096,
                        Math.round(s.output.width),
                        Math.floor((4096 * width) / height),
                      ),
                    );
                    s.output = {
                      width: outputWidth,
                      height: Math.round((outputWidth * height) / width),
                    };
                  })
                }
              />
              <label>输出宽度（像素）</label>
              <InputNumber
                aria-label="输出宽度"
                min={Math.max(
                  256,
                  Math.ceil((256 * state.frame.width) / state.frame.height),
                )}
                max={Math.min(
                  4096,
                  Math.floor((4096 * state.frame.width) / state.frame.height),
                )}
                step={1}
                precision={0}
                value={state.output.width}
                onChange={(v) =>
                  change((s) => {
                    s.output = {
                      width: v ?? 1920,
                      height: Math.round(
                        ((v ?? 1920) * s.frame.height) / s.frame.width,
                      ),
                    };
                  })
                }
              />
              <p>
                {state.output.width} × {state.output.height} px
              </p>
              <Switch
                checked={preview}
                onChange={setPreview}
                aria-label="出图预览"
              />{" "}
              出图预览
              <Button
                type="primary"
                block
                onClick={() => void exportPng()}
                loading={exporting}
                disabled={busy || !!switching || invalid || !!inspection}
              >
                导出 PNG
              </Button>
              <Button
                onClick={() => void exportKml()}
                disabled={busy || invalid || !!inspection}
              >
                导出展示 KML
              </Button>
            </section>
            <section
              hidden={!exportPanel || (!inProject && panel !== "project")}
            >
              <h2>{inProject ? "项目" : "打开已有工程"}</h2>
              <div hidden={!inProject}>
                {projectTracks.map((track) => (
                  <ProjectPresentation
                    key={track.entry}
                    track={track}
                    busy={busy}
                    onApply={(settings) =>
                      void projectPresentation(
                        track.reference!.entry_id!,
                        settings,
                      )
                    }
                    onUpdate={() =>
                      void projectPresentation(
                        track.reference!.entry_id!,
                        undefined,
                      )
                    }
                  />
                ))}
                <label htmlFor="project-name">项目名称</label>
                <Input
                  id="project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <div className="map-actions">
                  <Button
                    onClick={() => void save()}
                    disabled={
                      !state.archive ||
                      !name.trim() ||
                      busy ||
                      invalid ||
                      !!switching
                    }
                  >
                    保存项目
                  </Button>
                </div>
              </div>
              <Select
                aria-label="已保存项目"
                placeholder="选择项目"
                value={names.includes(name) ? name : undefined}
                options={names.map((value) => ({ value, label: value }))}
                onChange={setName}
              />
              <div className="map-actions">
                <Button
                  onClick={() => void load()}
                  disabled={!names.includes(name) || busy}
                >
                  载入项目
                </Button>
                <Button onClick={() => file.current?.click()}>导入 JSON</Button>
                <Button
                  hidden={!inProject}
                  onClick={() =>
                    download(
                      new Blob([JSON.stringify(state, null, 2)], {
                        type: "application/json",
                      }),
                      "tracktool-project.json",
                    )
                  }
                >
                  导出 JSON
                </Button>
              </div>
              <input
                ref={file}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={async (e) => {
                  const selected = e.target.files?.[0];
                  e.target.value = "";
                  if (selected)
                    try {
                      await load(JSON.parse(await selected.text()) as unknown);
                    } catch (e) {
                      setError(message(e));
                    }
                }}
              />
            </section>
            <Suspense fallback={<Spin />}>
              {(["archive", "tracks"] as const).map(
                (group) =>
                  (visited.has(group) || panel === group) && (
                    <section key={group} hidden={panel !== group}>
                      <h3>{panels[group]}</h3>
                      <WorkPage group={group} />
                    </section>
                  ),
              )}
              {(visited.has("tasks") || panel === "tasks") && (
                <section hidden={panel !== "tasks"}>
                  <h3>处理记录</h3>
                  <TasksPage />
                </section>
              )}
            </Suspense>
          </aside>
          <MapViewport
            ref={viewport}
            state={
              inspection
                ? { ...state, camera: inspection.camera, title: "" }
                : state
            }
            config={config}
            cities={cities.labels}
            tracks={inspection?.tracks ?? (inProject ? tracks : [])}
            preview={inProject && preview && !inspection}
            overview={overview.query.data}
            overviewSelected={overview.id}
            overviewVisibility={browseVisibility}
            hideOverview={!browsing}
            onOverviewPick={(hits) => overview.pick(hits.map((h) => h.id))}
            onOverviewLoading={overview.setLoading}
            onOverviewVersion={browseOverview.published}
            onOverviewError={(error) => {
              overview.setTileError(error);
              void overview.query.refetch();
            }}
            onCamera={(camera) => {
              if (inspection) {
                setInspection((old) => (old ? { ...old, camera } : old));
                return;
              }
              if (
                JSON.stringify(stateRef.current.camera) !==
                JSON.stringify(camera)
              ) {
                fitted.current = true;
                if (browsing) rememberCamera(initial.initialArchive, camera);
                if (inProject)
                  change((s) => {
                    s.camera = camera;
                  });
                else setState((prev) => ({ ...prev, camera }));
              }
            }}
            onError={setError}
          />
        </div>
        <Modal
          title="保存工程后返回浏览？"
          open={leaving}
          closable={!busy}
          maskClosable={!busy}
          onCancel={() => {
            if (!busy) setLeaving(false);
          }}
          footer={[
            <Button
              key="cancel"
              disabled={busy}
              onClick={() => setLeaving(false)}
            >
              取消
            </Button>,
            <Button
              key="discard"
              disabled={busy}
              onClick={() => void returnToBrowse()}
            >
              放弃修改并返回
            </Button>,
            <Button
              key="save"
              aria-label="保存并返回"
              type="primary"
              loading={busy}
              disabled={busy || !name.trim() || invalid || !!switching}
              onClick={async () => {
                if (await save()) await returnToBrowse();
              }}
            >
              保存并返回
            </Button>,
          ]}
        >
          <p>工程有未保存的修改。返回后会恢复进入工程前的浏览视野与选择。</p>
          <label htmlFor="leave-project-name">项目名称</label>
          <Input
            id="leave-project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {invalid && (
            <p role="alert">请先解决轨迹或资源版本问题，才能保存工程。</p>
          )}
          {error && <p role="alert">{error}</p>}
        </Modal>
        <Modal
          title={`此处有 ${overview.candidates.length} 条轨迹`}
          open={overview.candidates.length > 1}
          onCancel={() => overview.setCandidates([])}
          footer={null}
        >
          <p>选择要查看的轨迹；重叠的轨迹均保留。</p>
          {overview.matching.isPending && <Spin />}
          {overview.matching.error && (
            <p role="alert">
              {overview.matching.error.message}
              <Button onClick={() => void overview.matching.refetch()}>
                重试候选
              </Button>
            </p>
          )}
          <Pagination
            showSizeChanger={false}
            simple
            pageSize={100}
            current={overview.candidateOffset / 100 + 1}
            total={overview.candidates.length}
            onChange={(page) => overview.setCandidateOffset((page - 1) * 100)}
            hideOnSinglePage
          />
          {overview.matching.data?.entries.map((e) => (
            <Button
              block
              key={e.id}
              onClick={() => {
                overview.setId(e.id);
                overview.setCandidates([]);
              }}
            >
              {e.entry}
            </Button>
          ))}
        </Modal>
        {overview.id && browsing && (!panel || panel === "library") && (
          <div className="overview-detail" role="region" aria-label="轨迹详情">
            <Button
              className="detail-close"
              size="small"
              onClick={() => overview.setId("")}
            >
              关闭详情
            </Button>
            <strong>{overview.selected?.name ?? "正在读取轨迹…"}</strong>
            <p>{overview.selected?.entry}</p>
            {overview.selected && (
              <p>
                {overview.selected.points.toLocaleString()} 个点 ·{" "}
                {overview.selected.segments} 段 · {overview.selected.kind}
              </p>
            )}
            {overview.detail.isFetching && <span>正在读取详情…</span>}
            {(overview.detail.error ?? overview.matching.error) && (
              <p role="alert">
                {(overview.detail.error ?? overview.matching.error)?.message}
                <Button
                  size="small"
                  onClick={() => {
                    void overview.detail.refetch();
                    void overview.matching.refetch();
                  }}
                >
                  重试详情
                </Button>
              </p>
            )}
            <Button
              disabled={!overview.selectedTrack}
              onClick={() => viewport.current?.fit([overview.selectedTrack!])}
            >
              定位此轨迹
            </Button>
          </div>
        )}
        {inspection && (
          <div
            className="inspection-banner"
            role="region"
            aria-label="轨迹结果地图"
          >
            <strong>结果检查 · {inspection.tracks.length} 条轨迹</strong>
            <span>临时显示，尚未入库</span>
            <Button onClick={() => viewport.current?.fit(inspection.tracks)}>
              定位结果
            </Button>
            <Button
              onClick={() => {
                const id = inspection.id;
                inspectionSequence.current++;
                setInspection(undefined);
                openPanel("tasks", id);
              }}
            >
              返回原地图
            </Button>
          </div>
        )}
        {showLoading && loadingText && (
          <div className="map-status" role="status">
            <Spin size="small" /> {loadingText}
          </div>
        )}
        <div
          className="map-errors"
          hidden={
            !error && !sourceErrors.length && !versionChanged && !overviewError
          }
        >
          {overviewError && (
            <div role="alert">
              概览加载失败：{overviewError}
              <Button size="small" onClick={() => void retryOverview()}>
                重试概览
              </Button>
            </div>
          )}
          {error && (
            <div role="alert" className="map-error">
              {error}
            </div>
          )}
          {sourceErrors.map((e) => (
            <div key={e.entry} role="alert" className="map-error">
              {e.entry}：{e.error}
            </div>
          ))}
          {versionChanged && (
            <Alert
              type="warning"
              title="项目资源版本已变化；请确认后另存为新项目"
              action={
                <Button
                  onClick={() => {
                    if (window.confirm("确认使用当前地图、字体与渲染版本？")) {
                      change((s) => {
                        s.versions = config.versions;
                      });
                      setName(`${name || "项目"}-新版本`);
                      setVersionChanged(false);
                    }
                  }}
                >
                  使用当前资源
                </Button>
              }
            />
          )}
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}
