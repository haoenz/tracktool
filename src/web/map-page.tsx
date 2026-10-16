import { TrackInsights, type AnalysisOverlay } from "./track-insights.js";
import { Popover as PopoverPrimitive } from "radix-ui";
import { toast } from "sonner";
import { Eye, EyeOff, Square, SquareCheck, SquareMinus, LoaderCircle, Funnel, ListChecks, ArrowDownWideNarrow, Settings as SettingsIcon, List, Upload, FileOutput, LocateFixed, Download, Ellipsis, Trash2, Pencil, SlidersHorizontal, History, ChevronRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.js";
import { SheetHandle } from "./components/sheet-handle.js";
import { StartupScreen } from "./components/startup-screen.js";
import { PanelHeader } from "./components/panel-header.js";
import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
  RadioGroup,
  Switch,
} from "./components/controls.js";
import { Link, useSearchParams } from "react-router-dom";
import { WorkspaceContext, type Panel, type EditMap } from "./workspace.js";
import {
  operationLabel,
  type Operation,
} from "../shared/work.js";
import type {
  Catalog,
  Cities,
  MapConfig,
  Selection,
  SelectedTrack,
} from "../shared/map.js";
import { useOverview, rememberedCamera, rememberCamera } from "./overview.js";
import type { OverviewVisibility } from "./overview-layer.js";
import type { OverviewEntry, OverviewStatus } from "../shared/overview.js";
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
import projectIcon from "./project-icon.svg";
const TrackEditor = lazy(() => import("./track-editor.js"));
const ArchiveAction = lazy(() =>
  import("./work-page.js").then((m) => ({ default: m.ArchiveWorkPage })),
);
import { useSessionState } from "./session-state.js";
import Settings from "./settings.js";
const panels: Record<Panel, string> = {
  library: "轨迹库",
  style: "地图样式",
  export: "出图",
  project: "项目",
  archive: "轨迹库管理",
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
    return <StartupScreen />;
  return <Editor initial={bootstrap.data} cities={cities.data} />;
}
function Editor({ initial, cities }: { initial: Bootstrap; cities: Cities }) {
  const [libraryVisibility, setLibraryVisibility] =
    useSessionState<OverviewVisibility>(
      `tracktool:${initial.initialArchive}:visibility`,
      {
        all: true,
        exceptions: {},
      },
    );
  const [browseState, setBrowseState] = useState(() => ({
      ...initial.state,
      camera: rememberedCamera(initial.initialArchive) ?? initial.state.camera,
    })),
    [projectState, setProjectState] = useState<Project>(),
    [projectTracks, setProjectTracks] = useState<SelectedTrack[]>([]),
    [baseline, setBaseline] = useState(""),
    [leaving, setLeaving] = useState(false),
    [catalog, setCatalog] = useState<Catalog>(),
    [browseFilter, setBrowseFilter] = useSessionState(
      `tracktool:${initial.initialArchive}:search`,
      "",
    ),
    [savedBrowseKind, setBrowseKind] = useSessionState<string | string[]>(
      `tracktool:${initial.initialArchive}:kind`,
      [],
    ),
    [projectFilter, setProjectFilter] = useState(""),
    [projectKind, setProjectKind] = useState<string[]>([]),
    [names, setNames] = useState<string[]>([]),
    [name, setName] = useState(""),
    [currentName, setCurrentName] = useState(""),
    [openName, setOpenName] = useState<string>(),
    [saveAs, setSaveAs] = useState(false),
    [batchMode, setBatchMode] = useState(false),
    [batch, setBatch] = useSessionState<Record<string, string>>(
      `tracktool:${initial.initialArchive}:batch`,
      {},
    ),
    [candidateCamera, setCandidateCamera] = useState<Project["camera"]>(),
    [sheet, setSheet] = useState("half"),
    [editing, setEditing] = useState(false),
    [drawHeader, setDrawHeader] = useState<{ onBack: () => void }>(),
    [detailOpen, setDetailOpen] = useState(true),
    [projectTab, setProjectTab] = useState("content"),
    [projectSearch, setProjectSearch] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [exporting, setExporting] = useState(false),
    [switching, setSwitching] = useState(""),
    [preview, setPreview] = useState(false),
    [sourceErrors, setSourceErrors] = useState<Selection["errors"]>([]),
    [versionChanged, setVersionChanged] = useState(false);
  const [browseDates, setBrowseDates] = useSessionState(
    `tracktool:${initial.initialArchive}:dates`,
    {
      from: "",
      to: "",
      sort: "date-desc",
    },
  );
  const [projectDates, setProjectDates] = useState({
    from: "",
    to: "",
    sort: "date-desc",
  });
  const [projectVisibility, setProjectVisibility] =
    useState<OverviewVisibility>({ all: true, exceptions: {} });
  const [activity, setActivity] = useState("正在读取轨迹…");
  const [drafts, setDrafts] = useState<Record<string, boolean>>({});
  const reportDraft = useCallback(
    (key: string, dirty: boolean) =>
      setDrafts((old) => (old[key] === dirty ? old : { ...old, [key]: dirty })),
    [],
  );
  const hasDraft = Object.values(drafts).some(Boolean);
  const [editMap, setEditMap] = useState<EditMap>();
  const inProject = projectState !== undefined;
  const state = projectState ?? browseState;
  const browseVisibility = inProject ? projectVisibility : libraryVisibility;
  const setBrowseVisibility = inProject
    ? setProjectVisibility
    : setLibraryVisibility;
  const filter = inProject ? projectFilter : browseFilter;
  const setFilter = inProject ? setProjectFilter : setBrowseFilter;
  const browseKind = useMemo(() => Array.isArray(savedBrowseKind)
    ? savedBrowseKind : savedBrowseKind === "all" ? [] : [savedBrowseKind], [savedBrowseKind]);
  const kind = inProject ? projectKind : browseKind;
  const setKind = inProject ? setProjectKind : setBrowseKind;
  const savedDates = inProject ? projectDates : browseDates;
  const dates = savedDates.sort === "name"
    ? { ...savedDates, sort: "date-desc" }
    : savedDates;
  const setDates = inProject ? setProjectDates : setBrowseDates;
  const [filterDraft, setFilterDraft] = useState<{
    kind: string[];
    from: string;
    to: string;
    candidates: string[];
  }>();
  const [sortOpen, setSortOpen] = useState(false);
  const invalidDateRange = !!(filterDraft?.from && filterDraft.to && filterDraft.from > filterDraft.to);
  function applyListFilters() {
    if (!filterDraft || invalidDateRange) return;
    setKind(filterDraft.kind);
    overview.setCandidates(filterDraft.candidates);
    setDates({ ...dates, from: filterDraft.from, to: filterDraft.to });
    overview.setOffset(0);
    setFilterDraft(undefined);
  }
  const tracks = projectTracks;
  const dirty =
    inProject && (!currentName || JSON.stringify(projectState) !== baseline);
  const setState = (update: Project | ((prev: Project) => Project)) => {
    if (inProject)
      setProjectState((prev) =>
        typeof update === "function" ? update(prev!) : update,
      );
    else setBrowseState(update);
  };
  const setTracks = setProjectTracks;
  const browsePanel = useRef("library");
  const [params, setParams] = useSearchParams();
  const rawPanel = params.get("panel") ?? "none";
  const panel = Object.hasOwn(panels, rawPanel)
    ? ["archive"].includes(rawPanel)
      ? "library"
      : rawPanel === "style"
        ? "settings"
        : (rawPanel as Panel)
    : undefined;
  const [archiveAction, setArchiveAction] = useState<Operation>();
  const [downloadingTrack, setDownloadingTrack] = useState(false);
  const [libraryList, setLibraryList] = useSessionState(`tracktool.library-list:${initial.initialArchive}`, false);
  const [analysisOverlay, setAnalysisOverlay] = useState<AnalysisOverlay>();
  const [detailAction, setDetailAction] = useState<{
    operation: Operation;
    entry: string;
  }>();
  const [editorView, setEditorView] = useState<"edit" | "display" | "history">("edit");
  const editorTitles = { edit: "编辑轨迹", display: "分段管理", history: "历史记录" };
  const controls = useRef<HTMLElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const [menuExpanded, setMenuExpanded] = useState(!!panel && panel !== "settings");
  const [exportEntries, setExportEntries] = useState<string[]>();
  const [exportKind, setExportKind] = useState<"zip" | "kml" | "png">();
  const exportPage = panel === "export" || panel === "project";
  const exportPanel = exportPage && (exportKind === "png" || panel === "project");
  const [inspection, setInspection] = useState<{
    id: string;
    tracks: SelectedTrack[];
    camera: Project["camera"];
  }>();
  const inspectionSequence = useRef(0);
  const openPanel = (next: Panel, task?: string) => {
    if (next === "export" || next === "project") setExportKind("png");
    if (inProject && next === "library" && panel !== "library")
      setCandidateCamera(structuredClone(stateRef.current.camera));
    if (next === "library" && (inProject || task === "imported")) setLibraryList(true);
    if (task === "imported") {
      setArchiveAction(undefined);
      setFilter("");
      setKind([]);
      setDates({ from: "", to: "", sort: "date-desc" });
      setDetailOpen(false);
    }
    setDetailAction(undefined);
    if (!inProject && !exportPanel && (next === "export" || next === "project"))
      browsePanel.current = rawPanel;
    setParams(
      task
        ? { panel: next, task: task }
        : { panel: next },
    );
  };
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
  const browseOverview = useOverview(
    browseCrs,
    browseFilter,
    browseKind,
    true,
    browseDates,
  );
  const projectOverview = useOverview(
    crs,
    projectFilter,
    projectKind,
    inProject,
    projectDates,
  );
  const overview = inProject ? projectOverview : browseOverview;
  const filtersApplied = !!(kind.length > 0 || dates.from || dates.to || overview.candidates.length);
  const listVisible = panel === "library" && !(overview.id && detailOpen) && !archiveAction;
  const scrollKey = `${inProject}:${panel}:${panel === "library" && detailOpen && overview.id ? overview.id : "list"}:${panel === "library" ? (archiveAction ?? (libraryList ? "list" : "home")) : ""}:${exportPanel ? projectTab : ""}:${panel === "library" && editing}`;
  useLayoutEffect(() => {
    const el = controls.current;
    if (el) el.scrollTop = scrollPositions.current.get(scrollKey) ?? 0;
  }, [scrollKey]);
  const previousDetail = useRef(false);
  useLayoutEffect(() => {
    if (panel !== "library") return;
    if (detailOpen && !previousDetail.current)
      controls.current
        ?.querySelector<HTMLElement>(".track-detail-heading")
        ?.focus({ preventScroll: true });
    else if (!detailOpen && previousDetail.current)
      controls.current
        ?.querySelector<HTMLElement>('.track-row-name[aria-pressed="true"]')
        ?.focus({ preventScroll: true });
    previousDetail.current = detailOpen;
  }, [detailOpen, panel]);
  const fitted = useRef(!!rememberedCamera(initial.initialArchive));
  const browsing = (!inProject || panel === "library") && !inspection;
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
      if (dirty || hasDraft) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, hasDraft]);
  const select = async (entries: string[]) => {
    setActivity("正在读取完整轨迹…");
    if (!catalog) return;
    if (entries.length > 200) {
      setError("出图工程最多 200 条轨迹，请缩小选择范围；未添加任何轨迹。");
      return;
    }
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
      return true;
    } catch (e) {
      if (!controller.signal.aborted) setError(message(e));
    } finally {
      if (sequence === operations.current) setBusy(false);
    }
  };
  const chooseBrowse = (next: OverviewVisibility) => {
    setBrowseVisibility(next);
    setNotice("已更新地图显示");
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
    setActivity("正在更新工程展示…");
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
    setActivity("正在导出展示 KML…");
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
    setActivity("正在读取工程…");
    if (!confirmDiscard()) return;
    if (
      hasDraft &&
      !window.confirm("载入工程会离开当前轨迹编辑，是否放弃未提交的草稿？")
    )
      return;
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
              name: openName,
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
      setProjectKind([]);
      projectOverview.setId("");
      projectOverview.setOffset(0);
      setProjectState(result.state);
      setProjectTracks(result.tracks);
      setPreview(true);
      setCurrentName(value === undefined ? openName! : "");
      setName(value === undefined ? openName! : "");
      openPanel("export");
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
  const save = async (asNew = false) => {
    setActivity("正在保存工程…");
    const targetName = (asNew || !currentName ? name : currentName).trim();
    if (!targetName) {
      setSaveAs(true);
      return false;
    }
    if (
      (asNew || !currentName) &&
      names.includes(targetName) &&
      !window.confirm(`覆盖项目「${targetName}」？`)
    )
      return false;
    setBusy(true);
    setError("");
    const snapshot = structuredClone(state);
    try {
      await api("/api/projects/save", { name: targetName, state: snapshot });
      setCurrentName(targetName);
      setName(targetName);
      setSaveAs(false);
      setBaseline(JSON.stringify(snapshot));
      await refreshNames(state.archive);
      setNotice(`工程「${targetName}」已保存到当前轨迹库`);
      return JSON.stringify(stateRef.current) === JSON.stringify(snapshot);
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const newProject = async (entries: string[] = []) => {
    setActivity("正在建立出图工程…");
    if (busy || switching || inspection) return;
    if (
      hasDraft &&
      !window.confirm("进入工程会离开当前轨迹编辑，是否放弃未提交的草稿？")
    )
      return;
    setBusy(true);
    setError("");
    try {
      const next = structuredClone(initial.state);
      next.archive = catalog?.archive ?? initial.initialArchive;
      next.camera = structuredClone(browseState.camera);
      next.style = structuredClone(browseState.style);
      if (entries.length > 200)
        throw new Error("出图工程最多 200 条轨迹，请缩小选择范围。");
      const chosen = entries.length
        ? await api<Selection>("/api/selection", {
            archive: next.archive,
            entries,
          })
        : undefined;
      if (chosen?.errors.length)
        throw new Error(chosen.errors.map((e) => e.error).join("；"));
      next.tracks =
        chosen?.tracks.map(
          (t) => t.reference ?? { entry: t.entry, sha256: t.sha256 },
        ) ?? [];
      next.schema = next.tracks.every((t) => t.entry_id) ? 3 : 2;
      if (!exportPanel) browsePanel.current = rawPanel;
      fitted.current = true;
      setProjectFilter("");
      setProjectKind([]);
      projectOverview.setId("");
      projectOverview.setOffset(0);
      setProjectState(next);
      setProjectTracks(chosen?.tracks ?? []);
      setCurrentName("");
      setBaseline(JSON.stringify(next));
      setName("");
      setSourceErrors([]);
      setVersionChanged(false);
      setPreview(true);
      setNotice("已新建出图工程；在「内容」中添加轨迹。");
      openPanel("export");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const returnToBrowse = async () => {
    setActivity("正在恢复浏览地图…");
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
      setNotice("PNG 已导出到浏览器下载目录");
    } catch (e) {
      setError(message(e));
    } finally {
      setExporting(false);
    }
  };
  useEffect(() => {
    if (!notice) return;
    toast.success(notice, { id: "workspace-notice", duration: 4000 });
    setNotice("");
  }, [notice]);
  const overviewError = browsing
    ? overview.tileError ||
      (!overview.query.data?.version
        ? (overview.query.error?.message ?? overview.query.data?.error ?? "")
        : "")
    : "";
  const loadingText = exporting
    ? "正在导出地图…"
    : switching
      ? "正在准备新底图…"
      : busy
        ? activity
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
  async function allMatching(signal?: AbortSignal): Promise<OverviewEntry[]> {
    if (!overview.version) throw new Error("请等待列表加载完成");
    const rows: OverviewEntry[] = [];
    for (let offset = 0; ; offset += 500) {
      const result = await overview.fetchEntries({ version: overview.version, q: filter, kinds: JSON.stringify(kind), ...dates, offset: String(offset), limit: "500" }, signal);
      rows.push(...result.entries);
      if (rows.length >= result.total || !result.entries.length) return rows;
    }
  }
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const visibilityScope = JSON.stringify([inProject, overview.version, filter, kind, dates, overview.candidates]);
  const visibilityScopeRef = useRef(visibilityScope);
  visibilityScopeRef.current = visibilityScope;
  async function toggleListVisibility() {
    setVisibilityBusy(true);
    setError("");
    try {
      const rows = await allMatching();
      if (visibilityScopeRef.current !== visibilityScope || !rows.length) return;
      setBrowseVisibility((previous) => {
        const show = !rows.some(
          (row) => previous.all !== Object.hasOwn(previous.exceptions, row.id),
        );
        if (!overview.candidates.length && !filter && !kind.length && !dates.from && !dates.to)
          return { all: show, exceptions: {} };
        const exceptions = { ...previous.exceptions };
        for (const row of rows) {
          if (show === previous.all) delete exceptions[row.id];
          else exceptions[row.id] = row.entry;
        }
        return { ...previous, exceptions };
      });
      setNotice(`已更新当前列表 ${rows.length} 条轨迹的地图显示`);
    } catch (e) {
      setError(message(e));
    } finally {
      setVisibilityBusy(false);
    }
  }
  const fitTracks = (selected: SelectedTrack[]) => {
    viewport.current?.fit(selected);
  };
  const [batchSelecting, setBatchSelecting] = useState(false);
  const batchRequest = useRef(0);
  function clearBatch(exit = false) {
    batchRequest.current++;
    setBatchSelecting(false);
    setBatch({});
    if (exit) setBatchMode(false);
  }
  function toggleBatchEntry(entry: OverviewEntry) {
    setBatch((old) => {
      const next = { ...old };
      if (Object.hasOwn(next, entry.id)) delete next[entry.id];
      else next[entry.id] = entry.entry;
      return next;
    });
  }
  async function selectAllMatching(checked = true) {
    const request = ++batchRequest.current;
    const scope = visibilityScope;
    setBatchSelecting(true);
    try {
      const rows = await allMatching();
      if (request !== batchRequest.current || scope !== visibilityScopeRef.current) return;
      setBatch((old) => {
        const next = { ...old };
        for (const row of rows) {
          if (checked) next[row.id] = row.entry;
          else delete next[row.id];
        }
        return next;
      });
    } catch (e) {
      if (request === batchRequest.current) setError(message(e));
    } finally {
      if (request === batchRequest.current) setBatchSelecting(false);
    }
  }
  const visible = overview.list.data?.entries ?? [];
  const needsVisibilityRows = Object.keys(browseVisibility.exceptions).length > 0 && (overview.list.data?.total ?? 0) > visible.length;
  const visibilityRows = useQuery({
    queryKey: ["overview-visibility-rows", overview.version, filter, kind, dates, overview.candidates],
    enabled: listVisible && (needsVisibilityRows || (batchMode && (overview.list.data?.total ?? 0) > visible.length)) && !!overview.version,
    queryFn: ({ signal }) => allMatching(signal),
  });
  const visibilityPending = overview.list.isFetching || (needsVisibilityRows && visibilityRows.isPending);
  const visibilityEntries = needsVisibilityRows ? visibilityRows.data : visible;
  const visibleCount = visibilityEntries?.filter((e) => browseVisibility.all !== Object.hasOwn(browseVisibility.exceptions, e.id)).length ?? 0;
  const listVisibility = visibilityPending || (needsVisibilityRows && visibilityRows.isError)
    ? undefined
    : !needsVisibilityRows && !Object.keys(browseVisibility.exceptions).length
      ? browseVisibility.all ? "all" : "none"
      : !visibleCount ? "none" : visibleCount === visibilityEntries?.length ? "all" : "mixed";
  const visibilityLabel = listVisibility === "all" ? "全部显示" : listVisibility === "none" ? "全部隐藏" : listVisibility === "mixed" ? "部分显示" : "正在确认显示状态";
  const batchCount = Object.keys(batch).length;
  const batchEntries = (overview.list.data?.total ?? 0) > visible.length ? visibilityRows.data : visible;
  const batchPending = overview.list.isFetching || ((overview.list.data?.total ?? 0) > visible.length && visibilityRows.isPending);
  const selectedInFilter = batchEntries?.filter((e) => Object.hasOwn(batch, e.id)).length ?? 0;
  const batchAllSelected = !!batchEntries?.length && selectedInFilter === batchEntries.length;
  const batchMixed = selectedInFilter > 0 && !batchAllSelected;
  const selectedOnPage = visible.filter((e) => Object.hasOwn(batch, e.id)).length;
  const pageSelected = visible.length > 0 && selectedOnPage === visible.length;
  const invalid = sourceErrors.length > 0 || versionChanged;
  return (
    <WorkspaceContext.Provider
      value={{
        archive: catalog?.archive ?? initial.initialArchive,
        selected: [],
        draft: reportDraft,
        editMap: setEditMap,
        fit: fitTracks,
        open: openPanel,
        inspect,
        showTrack: (id) => {
          openPanel("library", "imported");
          browseOverview.setCandidates([]);
          browseOverview.setId(id);
          setDetailOpen(true);
          setEditing(false);
        },
        refresh: refreshCatalog,
      }}
    >
      <div
        className={`map-app${inProject ? " in-project" : ""}`}
        data-sheet={sheet}
      >
        <header className="map-header">
          <button
            className="project-icon"
            type="button"
            aria-label={menuExpanded ? "收起项目菜单" : "展开项目菜单"}
            aria-expanded={menuExpanded}
            aria-controls="map-tools"
            onClick={() => {
              setMenuExpanded(!menuExpanded);
              if (menuExpanded) setParams({ panel: "none" });
            }}
          >
            <img src={projectIcon} alt="" width="40" height="40" />
          </button>
          <nav id="map-tools" aria-label="地图工具" hidden={!menuExpanded}>
            <Button
              variant={panel === "library" && !archiveAction ? "default" : "ghost"}
              aria-label="打开轨迹列表"
              aria-expanded={panel === "library" && !archiveAction}
              aria-controls="map-panel"
              title="轨迹列表"
              onClick={() => {
                if (panel === "library" && !archiveAction) {
                  setParams({ panel: "none" });
                  return;
                }
                openPanel("library");
                setLibraryList(true);
                if (archiveAction) setDetailOpen(false);
                setArchiveAction(undefined);
              }}
            >
              <List size={22} aria-hidden="true" />
            </Button>
            <Button
              variant={panel === "library" && archiveAction === "archive:push" ? "default" : "ghost"}
              aria-label="上传轨迹"
              title="上传轨迹"
              onClick={() => {
                openPanel("library");
                setDetailOpen(false);
                overview.setCandidates([]);
                setArchiveAction("archive:push");
              }}
            >
              <Upload size={22} aria-hidden="true" />
            </Button>
            <Button
              variant={exportPage ? "default" : "ghost"}
              aria-label="导出轨迹"
              title="导出轨迹"
              onClick={() => {
                setExportKind(undefined);
                setParams({ panel: "export" });
              }}
            >
              <FileOutput size={22} aria-hidden="true" />
            </Button>
          </nav>
        </header>
        <Button
          className="map-settings-button"
          variant={panel === "settings" ? "default" : "outline"}
          aria-label="设置"
          title="设置"
          aria-expanded={panel === "settings"}
          aria-controls="map-panel"
          onClick={() =>
            panel === "settings"
              ? setParams({ panel: "none" })
              : openPanel("settings")
          }
        >
          <SettingsIcon size={22} aria-hidden="true" />
        </Button>
        {inProject && (
          <div className="project-bar" role="region" aria-label="当前出图工程">
            <strong>{currentName || "未命名工程"}</strong>
            <span className="save-state" role="status">
              {dirty ? "未保存" : "已保存"}
            </span>
            <Button
              disabled={busy || invalid || !!switching}
              onClick={() => void save()}
            >
              保存
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setName(`${currentName || "新工程"}-副本`);
                setSaveAs(true);
              }}
            >
              另存为
            </Button>
            <Button
              disabled={busy || exporting || !!switching}
              onClick={() => {
                if (
                  hasDraft &&
                  !window.confirm(
                    "退出工程会离开当前轨迹编辑，是否放弃未提交的编辑草稿？",
                  )
                )
                  return;
                if (dirty) setLeaving(true);
                else void returnToBrowse();
              }}
            >
              退出工程
            </Button>

          </div>
        )}
        <div className="map-content">
          <aside
            id="map-panel"
            ref={controls}
            onScroll={(e) =>
              scrollPositions.current.set(scrollKey, e.currentTarget.scrollTop)
            }
            className={`map-controls${panel === "library" && overview.id && detailOpen && !editing && !archiveAction ? " track-detail-panel" : ""}${listVisible ? " track-list-panel" : ""}${panel && ["archive", "settings"].includes(panel) ? " wide" : ""}`}
            hidden={!panel}
            aria-label="地图控制面板"
          >
            <SheetHandle panel={controls} value={sheet} onChange={setSheet} />
            {!listVisible && (
            <PanelHeader
              title={
                panel === "library" && archiveAction
                  ? operationLabel(archiveAction)
                    : panel === "library" && overview.id && detailOpen
                      ? editing ? drawHeader && editorView === "display" ? "补绘轨迹" : editorTitles[editorView] : overview.selected?.name ?? "正在读取轨迹…"
                      : panel === "library" && libraryList ? "轨迹列表" : exportPage ? "导出轨迹" : panel ? panels[panel] : ""
              }
              headingClassName={panel === "library" && overview.id && detailOpen ? "track-detail-heading" : undefined}
              backLabel={
                panel === "library" && archiveAction
                  ? "返回轨迹库"
                  : panel === "library" && overview.id && detailOpen
                    ? editing ? drawHeader && editorView === "display" ? "返回分段管理" : "返回详情" : "返回列表"
                    : inProject && !exportPage ? "回到工程" : "返回轨迹库"
              }
              onBack={
                panel === "library" && archiveAction
                  ? () => setArchiveAction(undefined)
                    : panel === "library" && overview.id && detailOpen
                      ? () => {
                          if (editing) {
                            if (drawHeader && editorView === "display") {
                              drawHeader.onBack(); return;
                            }
                            setEditing(false); return;
                          }
                          setDetailOpen(false);
                          setLibraryList(true);
                          setDetailAction(undefined);
                        }
                      : panel === "library" && libraryList && !inProject
                        ? () => setLibraryList(false)
                        : inProject && !exportPage
                        ? () => openPanel("export")
                        : exportPage || (!inProject && panel === "settings")
                          ? () => openPanel("library")
                          : undefined
              }
            />
            )}
            {exportPage && (
              <section aria-label="轨迹导出类型">
                {exportEntries && <p>已选择 {exportEntries.length} 条轨迹用于导出。</p>}
                <label htmlFor="track-export-kind">导出类型</label>
                <Select
                  id="track-export-kind"
                  aria-label="导出类型"
                  placeholder="请选择导出类型"
                  disabled={busy}
                  value={panel === "project" ? "png" : exportKind}
                  options={[
                    { value: "zip", label: "ZIP" },
                    { value: "kml", label: "聚合KML" },
                    { value: "png", label: "PNG图像" },
                  ]}
                  onChange={(value) => {
                    if (value === "png" && exportEntries) {
                      if (exportEntries.length > 200) {
                        setError("PNG 出图最多支持 200 条轨迹，请缩小选择范围，或选择 ZIP / 聚合 KML。");
                        return;
                      }
                      if (inProject) void select(exportEntries).then((ok) => { if (ok) setExportKind("png"); });
                      else void newProject(exportEntries);
                      return;
                    }
                    setExportKind(value as "zip" | "kml" | "png");
                    if (panel === "project") setParams({ panel: "export" });
                  }}
                />
                {(exportKind === "zip" || exportKind === "kml") && panel !== "project" && (
                  <Suspense fallback={<Spin />}>
                    <ArchiveAction
                      key={`${exportKind}:${JSON.stringify(exportEntries)}`}
                      entries={exportEntries}
                      fixedOperation={exportKind === "zip" ? "archive:backup" : "archive:rebuild"}
                    />
                  </Suspense>
                )}
              </section>
            )}
            {exportPanel && inProject && (
              <div className="library-actions">
                <Button onClick={() => openPanel("library")}>从轨迹库添加</Button>
              </div>
            )}

            {exportPanel && (
              <section className="project-entry" hidden={inProject}>
                <>
                    <p className="overview-hint">
                      新建工程后单独选择出图轨迹，地图上的显示开关不影响出图范围。
                    </p>
                    <Button
                      variant="default"
                      disabled={busy || !!switching || !!inspection || !catalog}
                      onClick={() => void newProject(exportEntries)}
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
              </section>
            )}
            <section
              className="track-list-section"
              hidden={
                panel !== "library" ||
                (!!overview.id && detailOpen) ||
                !!archiveAction
              }
            >
              <div className="track-list-content">
              {overview.query.data?.state === "unconfigured" && (
                <p>后台尚未配置轨迹库</p>
              )}
              {overview.query.data?.summary?.entries === 0 && (
                <p>
                  轨迹库为空，可以导入 KML 开始浏览。
                  <Button onClick={() => setArchiveAction("archive:push")}>
                    导入 KML
                  </Button>
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
                  <div className="list-visibility-toolbar">
                    {batchMode ? (
                      <Button
                        variant="ghost"
                        className="list-visibility-button"
                        aria-label={batchAllSelected ? "清空全部勾选" : "勾选全部筛选结果"}
                        title={batchAllSelected ? "取消当前筛选的全部勾选（包含所有分页）" : "勾选当前筛选的全部轨迹（包含所有分页）"}
                        aria-pressed={batchMixed ? "mixed" : batchAllSelected}
                        aria-busy={batchSelecting || batchPending || undefined}
                        disabled={batchSelecting || batchPending || !overview.list.data?.total || !batchEntries}
                        onClick={() => void selectAllMatching(!batchAllSelected)}
                      >
                        {batchAllSelected ? <SquareCheck size={20} aria-hidden="true" /> : batchMixed ? <SquareMinus size={20} aria-hidden="true" /> : <Square size={20} aria-hidden="true" />}
                        {(batchSelecting || batchPending) && (
                          <span className="visibility-loading-mask" aria-hidden="true">
                            <LoaderCircle size={20} className="animate-spin" />
                          </span>
                        )}
                      </Button>
                    ) : (
                    <Button
                      variant="ghost"
                      aria-label="切换当前列表可见性"
                      className="list-visibility-button"
                      title={`${visibilityLabel}：点击${listVisibility === "none" ? "全部显示" : "全部隐藏"}（包含所有分页）`}
                      aria-pressed={listVisibility === undefined ? undefined : listVisibility === "mixed" ? "mixed" : listVisibility === "all"}
                      aria-busy={visibilityBusy || visibilityPending || undefined}
                      data-visibility={listVisibility ?? "pending"}
                      disabled={visibilityBusy || visibilityPending || !overview.list.data?.total}
                      onClick={() => void toggleListVisibility()}
                    >
                      {listVisibility === "none" ? <EyeOff size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}
                      {(visibilityBusy || visibilityPending) && (
                        <span className="visibility-loading-mask" aria-hidden="true">
                          <LoaderCircle size={20} className="animate-spin" />
                        </span>
                      )}
                    </Button>
                    )}
                    <Button
                      className="list-filter-button"
                      variant={filtersApplied ? "secondary" : "ghost"}
                      aria-label="筛选"
                      aria-haspopup="dialog"
                      title={filtersApplied ? "筛选：已设置" : "筛选"}
                      onClick={() => setFilterDraft({ kind, from: dates.from, to: dates.to, candidates: overview.candidates })}
                    >
                      <Funnel size={20} aria-hidden="true" />
                      {filtersApplied && <span className="filter-indicator" aria-label="已设置" />}
                    </Button>
                    <Input
                      id="filter"
                      aria-label="筛选轨迹"
                      placeholder="搜索轨迹"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                    <Popover open={sortOpen} onOpenChange={setSortOpen}>
                      <PopoverTrigger asChild>
                        <Button variant={dates.sort === "date-desc" ? "ghost" : "secondary"} aria-label="排序" title="排序">
                          <ArrowDownWideNarrow size={20} aria-hidden="true" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="list-sort-menu" aria-label="排序">
                        <p className="mb-3 font-medium">排序</p>
                        <RadioGroup
                          value={dates.sort}
                          onValueChange={(sort) => { setDates({ ...dates, sort }); setSortOpen(false); }}
                          options={[
                            { value: "date-desc", label: "日期从新到旧" },
                            { value: "date-asc", label: "日期从旧到新" },
                          ]}
                        />
                      </PopoverContent>
                    </Popover>
                    <Button
                      variant={batchMode ? "secondary" : "ghost"}
                      aria-label="批量操作"
                      title="批量操作"
                      aria-pressed={batchMode}
                      onClick={() => { if (batchMode) clearBatch(true); else setBatchMode(true); }}
                    >
                      <ListChecks size={20} aria-hidden="true" />
                    </Button>
                  </div>
                  <div className="map-track-list" aria-busy={overview.list.isFetching}>
                    {overview.list.isFetching ? (
                      <div className="track-list-status" role="status">正在读取轨迹列表…</div>
                    ) : overview.list.data?.total === 0 ? (
                      <div className="track-list-status" role="status">无匹配</div>
                    ) : null}
                    {!overview.list.isFetching && visible.map((e, index) => (
                      <Fragment key={e.id}>
                        {(index === 0 ||
                            e.date.slice(0, 7) !==
                              visible[index - 1]!.date.slice(0, 7)) && (
                            <h4 className="month-heading">
                              {e.date.slice(0, 7) || "日期未知"}
                            </h4>
                          )}
                        <div
                          className={`overview-row${(batchMode ? Object.hasOwn(batch, e.id) : overview.id === e.id) ? " selected" : ""}`}
                        >
                          <button
                            className="track-row-name"
                            aria-label={`${batchMode ? "选择" : "查看"} ${e.entry}`}
                            disabled={batchMode && batchSelecting}
                            aria-pressed={batchMode ? Object.hasOwn(batch, e.id) : overview.id === e.id}
                            onClick={() => {
                              if (batchMode) { toggleBatchEntry(e); return; }
                              if (
                                e.id !== overview.id &&
                                hasDraft &&
                                !window.confirm(
                                  "当前轨迹有编辑草稿，切换轨迹将放弃草稿。是否继续？",
                                )
                              )
                                return;
                              overview.setId(e.id);
                              setDetailOpen(true);
                              setEditing(false);
                            }}
                          >
                            <strong title={e.name.replace(/\.kml$/i, "")}>{e.name.replace(/\.kml$/i, "")}</strong>
                            {e.distance_m !== undefined && (
                              <span className="track-distance">
                                {(e.distance_m / 1000).toFixed(1)} km
                              </span>
                            )}
                          </button>
                          {batchMode ? (
                            <Checkbox
                              aria-label={`选择 ${e.name}`}
                              checked={Object.hasOwn(batch, e.id)}
                              disabled={batchSelecting}
                              onCheckedChange={() => toggleBatchEntry(e)}
                            />
                          ) : (
                            <Button
                              className="track-row-visibility"
                              variant="ghost"
                              aria-label={`${browseVisibility.all !== Object.hasOwn(browseVisibility.exceptions, e.id) ? "隐藏" : "显示"} ${e.name}`}
                              aria-pressed={
                                browseVisibility.all !==
                                Object.hasOwn(browseVisibility.exceptions, e.id)
                              }
                              onClick={() =>
                                toggleBrowse(
                                  e.id,
                                  e.entry,
                                  !(
                                    browseVisibility.all !==
                                    Object.hasOwn(
                                      browseVisibility.exceptions,
                                      e.id,
                                    )
                                  ),
                                )
                              }
                            >
                              <svg
                                width="20"
                                height="20"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                aria-hidden="true"
                              >
                                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                                <circle cx="12" cy="12" r="3" />
                                {!(
                                  browseVisibility.all !==
                                  Object.hasOwn(browseVisibility.exceptions, e.id)
                                ) && <path d="M3 3l18 18" />}
                              </svg>
                            </Button>
                          )}
                          {e.error && (
                            <span className="map-error">{e.error}</span>
                          )}
                        </div>
                      </Fragment>
                    ))}
                  </div>
                  {overview.list.error && !overview.list.data && (
                    <div role="alert">
                      {overview.list.error.message}
                      <Button onClick={() => void overview.list.refetch()}>
                        重试列表
                      </Button>
                    </div>
                  )}
                  {(batchMode || (overview.list.data?.total ?? 0) > 50) && (
                    <div className="track-list-footer">
                      {batchMode && (
                        <div className="page-selection" role="region" aria-label="多选范围">
                          <Checkbox
                            checked={pageSelected ? true : selectedOnPage > 0 ? "indeterminate" : false}
                            disabled={!visible.length || overview.list.isFetching || batchSelecting}
                            onCheckedChange={(checked) => {
                              setBatch((old) => {
                                const next = { ...old };
                                for (const e of visible) {
                                  if (checked) next[e.id] = e.entry;
                                  else delete next[e.id];
                                }
                                return next;
                              });
                            }}
                          >全选本页</Checkbox>
                        </div>
                      )}
                      <Pagination
                        current={Math.floor(overview.offset / 50) + 1}
                        pageSize={50}
                        total={overview.list.data?.total ?? 0}
                        onChange={(page) => overview.setOffset((page - 1) * 50)}
                        showQuickJumper
                        hideOnSinglePage
                      />
                    </div>
                  )}
                  {batchMode && batchCount > 0 && (
                    <div className="batch-action-bar" role="region" aria-label="所选轨迹操作">
                      <span aria-live="polite">已选 {batchCount} 条</span>
                      <Button
                        variant="default"
                        disabled={busy || batchSelecting}
                        onClick={() => {
                          setExportEntries(Object.values(batch));
                          openPanel("export");
                          setExportKind(undefined);
                        }}
                      >导出</Button>
                    </div>
                  )}

                </>
              )}
              </div>
            </section>
            <section hidden={panel !== "settings"}>
              <Settings inProject={inProject}>
                <h3>地图样式</h3>
                <label>底图</label>
                <Select
                  searchable

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
                        onCheckedChange={(v) =>
                          change((s) => {
                            s.style.overlays = s.style.overlays
                              .filter((i) => i.id !== o.id)
                              .concat({
                                id: o.id,
                                enabled: v,
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
            {exportPanel && inProject && (
              <div className="project-tabs" role="group" aria-label="出图设置">
                <Button onClick={() => setProjectTab("content")}>内容</Button>
                <Button onClick={() => setProjectTab("style")}>样式</Button>
                <Button onClick={() => setProjectTab("output")}>
                  画框与输出
                </Button>
                <Button onClick={() => setProjectTab("more")}>更多</Button>
              </div>
            )}
            <section hidden={!exportPanel || !inProject}>
              <div hidden={projectTab !== "content"}>
                <label htmlFor="export-tracks">出图轨迹（最多 200 条）</label>
                <Select
                  id="export-tracks"
                  aria-label="出图轨迹"
                  multiple
                  searchable

                  maxCount={200}

                  style={{ width: "100%" }}
                  value={state.tracks.map((t) => t.entry)}
                  disabled={busy}
                  onChange={(entries: string[]) => void select(entries)}
                  options={catalog?.entries.map((e) => ({
                    value: e.entry,
                    label: e.entry,
                  }))}
                />
                <p className="overview-hint">
                  出图范围独立保存，不受轨迹库显示勾选影响。
                </p>
                <Button
                  disabled={!tracks.length}
                  onClick={() => fitTracks(tracks)}
                >
                  适合出图轨迹
                </Button>
                <div className="map-actions">
                  <Button onClick={() => openPanel("settings")}>
                    调整底图
                  </Button>
                </div>
              </div>
              <div hidden={projectTab !== "style"}>
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
              </div>
              <div hidden={projectTab !== "output"}>
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
                  onCheckedChange={setPreview}
                  aria-label="出图预览"
                />{" "}
                出图预览
              </div>
              <div className="project-export-actions">
                <Button
                  variant="default"
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
                <small>
                  PNG 是地图图片；展示 KML 包含连接／忽略设置；原始 KML
                  在轨迹库下载。
                </small>
              </div>
            </section>
            <section
              hidden={
                !exportPanel ||
                (inProject
                  ? projectTab !== "content" && projectTab !== "more"
                  : panel !== "project")
              }
            >
              <h2>{inProject ? "项目" : "打开已有工程"}</h2>
              <div hidden={!inProject}>
                <div hidden={projectTab !== "content"}>
                  <Input
                    aria-label="搜索工程轨迹"
                    value={projectSearch}
                    onChange={(e) => setProjectSearch(e.target.value)}
                    placeholder="搜索工程轨迹"
                  />
                  <p>
                    已加入 {projectTracks.length}/200 条{" "}
                    <Button onClick={() => openPanel("library")}>
                      添加轨迹
                    </Button>
                    <Button onClick={() => void select([])}>移除全部</Button>
                    {projectSearch && (
                      <Button
                        onClick={() =>
                          void select(
                            state.tracks
                              .filter((t) => !t.entry.includes(projectSearch))
                              .map((t) => t.entry),
                          )
                        }
                      >
                        移除搜索结果（
                        {
                          projectTracks.filter((t) =>
                            t.entry.includes(projectSearch),
                          ).length
                        }
                        ）
                      </Button>
                    )}
                  </p>
                  {projectTracks
                    .filter((t) => t.entry.includes(projectSearch))
                    .map((track) => (
                      <div key={track.entry}>
                        <Button
                          onClick={() =>
                            void select(
                              state.tracks
                                .filter((t) => t.entry !== track.entry)
                                .map((t) => t.entry),
                            )
                          }
                        >
                          移除 {track.entry.split("/").at(-1)}
                        </Button>
                        <ProjectPresentation
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
                      </div>
                    ))}
                </div>
              </div>
              <div hidden={inProject && projectTab !== "more"}>
                <Select
                  aria-label="已保存项目"
                  placeholder="选择项目"
                  value={openName}
                  options={names.map((value) => ({ value, label: value }))}
                  onChange={setOpenName}
                />
                <div className="map-actions">
                  <Button
                    onClick={() => void load()}
                    disabled={!openName || busy}
                  >
                    载入项目
                  </Button>
                  <Button onClick={() => file.current?.click()}>
                    导入 JSON
                  </Button>
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
                        await load(
                          JSON.parse(await selected.text()) as unknown,
                        );
                      } catch (e) {
                        setError(message(e));
                      }
                  }}
                />
              </div>
            </section>
            {overview.id && (
              <section
                hidden={
                  panel !== "library" ||
                  !detailOpen ||
                  !!archiveAction
                }
              >
                <div role="region" aria-label="轨迹详情">
                  <div className="track-summary" hidden={editing}>
                    {!overview.selected && !overview.detail.error && !overview.matching.error && (
                      <div className="track-detail-loading" role="status">
                        <Spin decorative />
                        <span>正在读取轨迹详情…</span>
                      </div>
                    )}
                    {(overview.detail.error ?? overview.matching.error) && (
                      <p role="alert">
                        {(overview.detail.error ?? overview.matching.error)?.message}
                        <Button
                          size="sm"
                          onClick={() => {
                            void overview.detail.refetch();
                            void overview.matching.refetch();
                          }}
                        >
                          重试详情
                        </Button>
                      </p>
                    )}
                    {overview.selected && (
                      <TrackInsights
                        key={`${initial.initialArchive}:${overview.selected.id}:${overview.selected.sha256}`}
                        entry={overview.selected}
                        scope={initial.initialArchive}
                        active={panel === "library" && detailOpen && !editing && !archiveAction}
                        onOverlay={setAnalysisOverlay}
                      >
                        <div className="track-detail-toolbar">
                          <Button
                            variant="default"
                            className="track-edit-primary"
                            onClick={() => {
                              if (
                                editorView !== "edit" &&
                                hasDraft &&
                                !window.confirm("切换编辑功能将放弃当前草稿，是否继续？")
                              )
                                return;
                              setEditorView("edit");
                              setEditing(true);
                              setDetailAction(undefined);
                            }}
                          >
                            <Pencil aria-hidden="true" />
                            编辑轨迹
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="定位轨迹"
                            title="定位轨迹"
                            disabled={
                              editMap
                                ? !editMap.tracks.some((track) => track.points > 0)
                                : !overview.selectedTrack
                            }
                            onClick={() =>
                              fitTracks(editMap ? editMap.tracks : [overview.selectedTrack!])
                            }
                          >
                            <LocateFixed aria-hidden="true" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="下载轨迹"
                            title="下载轨迹"
                            loading={downloadingTrack}
                            disabled={
                              !overview.detail.data ||
                              overview.detail.data.entry.id !== overview.id ||
                              overview.detail.data.entry.sha256 !== overview.selected?.sha256
                            }
                            onClick={() => {
                              const entry = overview.detail.data!.entry;
                              setDownloadingTrack(true);
                              void request(
                                `/api/tracks/${encodeURIComponent(entry.id)}/download?sha256=${entry.sha256}`,
                              )
                                .then(async (response) => {
                                  const url = URL.createObjectURL(await response.blob());
                                  const anchor = document.createElement("a");
                                  anchor.href = url;
                                  anchor.download =
                                    entry.entry.split("/").at(-1) ?? "track.kml";
                                  anchor.click();
                                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                                })
                                .catch((error) =>
                                  toast.error(
                                    error instanceof Error ? error.message : "下载失败，请重试",
                                  ),
                                )
                                .finally(() => setDownloadingTrack(false));
                            }}
                          >
                            {!downloadingTrack && <Download aria-hidden="true" />}
                          </Button>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label="更多轨迹操作"
                                title="更多轨迹操作"
                              >
                                <Ellipsis aria-hidden="true" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent align="end" className="w-44 p-1">
                              <PopoverPrimitive.Close asChild>
                                <Button
                                  variant="ghost"
                                  className="w-full justify-start text-destructive"
                                  disabled={!overview.selected}
                                  onClick={() =>
                                    setDetailAction({
                                      operation: "archive:delete",
                                      entry: overview.selected!.entry,
                                    })
                                  }
                                >
                                  <Trash2 aria-hidden="true" />
                                  删除轨迹
                                </Button>
                              </PopoverPrimitive.Close>
                            </PopoverContent>
                          </Popover>
                        </div>
                        <div className="track-detail-links">
                          {(["display", "history"] as const).map((view) => (
                            <Button
                              key={view}
                              variant="ghost"
                              className="track-detail-link"
                              aria-label={editorTitles[view]}
                              onClick={() => {
                                if (
                                  view !== editorView &&
                                  hasDraft &&
                                  !window.confirm("切换编辑功能将放弃当前草稿，是否继续？")
                                )
                                  return;
                                setEditorView(view);
                                setEditing(true);
                                setDetailAction(undefined);
                              }}
                            >
                              {view === "display" ? (
                                <SlidersHorizontal aria-hidden="true" />
                              ) : (
                                <History aria-hidden="true" />
                              )}
                              <span>
                                <strong>{editorTitles[view]}</strong>
                              </span>
                              <ChevronRight aria-hidden="true" />
                            </Button>
                          ))}
                        </div>
                      </TrackInsights>
                    )}
                  </div>
                  <Suspense fallback={<Spin />}>
                    <div hidden={!editing}>
                      {(editorView === "edit" || (editing && detailOpen && panel === "library" && !archiveAction)) && <TrackEditor
                        key={`${overview.id}:${editorView}`}
                        view={editorView}
                        onDrawHeaderChange={setDrawHeader}
                        initialEntry={overview.id}
                        onEntryChange={(id) => {
                          overview.setId(id);
                          setEditing(false);
                        }}
                        active={editing && detailOpen && panel === "library" && !archiveAction}
                      />}
                    </div>
                  </Suspense>
                  {detailAction && (
                    <Suspense fallback={<Spin />}>
                      <ArchiveAction
                        key={`${overview.id}:${detailAction.operation}`}
                        fixedOperation={detailAction.operation}
                        entry={detailAction.entry}
                      />
                    </Suspense>
                  )}
                </div>
              </section>
            )}
            <section
              hidden={!archiveAction || panel !== "library"}
              aria-label="轨迹库操作"
            >
              {archiveAction && (
                <Suspense fallback={<Spin />}>
                  <ArchiveAction
                    key={archiveAction}
                    fixedOperation={archiveAction}
                  />
                </Suspense>
              )}
            </section>
          </aside>
          <MapViewport
            ref={viewport}
            state={
              inspection
                ? { ...state, camera: inspection.camera, title: "" }
                : inProject && browsing
                  ? { ...state, camera: candidateCamera ?? state.camera }
                  : state
            }
            config={config}
            cities={cities.labels}
            tracks={
              editMap?.tracks ??
              inspection?.tracks ??
              (inProject && !browsing ? tracks : [])
            }
            preview={
              inProject && preview && !inspection && !browsing && !editMap
            }
            overview={overview.query.data}
            overviewSelected={overview.id}
            overviewVisibility={browseVisibility}
            hideOverview={!browsing || !!editMap}
            analysisOverlay={panel === "library" && detailOpen && !editing && !archiveAction && browsing && !editMap && !inspection && analysisOverlay?.key === (overview.selected ? overview.selected.id + overview.selected.sha256 : "") ? analysisOverlay : undefined}
            highlightSegment={editMap?.segment}
            onPointPick={editMap?.pick}
            onOverviewPick={(hits) => {
              if (!hits.length || editMap || !browsing) return;
              if (
                hasDraft &&
                (hits.length !== 1 || hits[0]?.id !== overview.id) &&
                !window.confirm(
                  "当前轨迹有编辑草稿，切换轨迹将放弃草稿。是否继续？",
                )
              )
                return;
              setFilter("");
              setKind([]);
              setDates({ ...dates, from: "", to: "" });
              setFilterDraft(undefined);
              overview.pick(hits.map((h) => h.id));
              setDetailOpen(hits.length === 1);
              setMenuExpanded(true);
              setLibraryList(true);
              setArchiveAction(undefined);
              setSheet("half");
              openPanel("library");
              setEditing(false);
            }}
            onOverviewLoading={overview.setLoading}
            onOverviewVersion={overview.published}
            onOverviewError={(error) => {
              overview.setTileError(error);
              if (error) void overview.query.refetch();
            }}
            onCamera={(camera) => {
              if (inspection) {
                setInspection((old) => (old ? { ...old, camera } : old));
                return;
              }
              if (inProject && browsing) {
                setCandidateCamera(camera);
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
          title="筛选"
          open={!!filterDraft}
          onCancel={() => setFilterDraft(undefined)}
          footer={[
            <Button key="reset" onClick={() => setFilterDraft({ kind: [], from: "", to: "", candidates: [] })}>重置</Button>,
            <Button key="cancel" onClick={() => setFilterDraft(undefined)}>取消</Button>,
            <Button key="apply" variant="default" disabled={invalidDateRange} onClick={applyListFilters}>应用</Button>,
          ]}
        >
          {filterDraft && (
            <div className="list-filter-fields">
              {filterDraft.candidates.length > 0 && (
                <div className="list-location-filter" role="group" aria-label="位置筛选">
                  <span className="filter-category">位置</span>
                  <span className="filter-result">点选附近：{filterDraft.candidates.length}条</span>
                  <Button size="sm" variant="outline" aria-label="清除位置筛选" onClick={() => setFilterDraft({ ...filterDraft, candidates: [] })}>清除</Button>
                </div>
              )}
              <label htmlFor="filter-kind">轨迹分类</label>
              <Select id="filter-kind" aria-label="轨迹分类" multiple clearable placeholder="全部分类" value={filterDraft.kind}
                options={[
                  ...Array.from(new Set(catalog?.entries.map((e) => e.kind) ?? [])).map((value) => ({ value, label: value })),
                ]}
                onChange={(kind) => setFilterDraft({ ...filterDraft, kind: kind ?? [] })}
              />
              <div className="list-filter-dates">
                <div>
                  <label htmlFor="filter-from">起始日期</label>
                  <div className="filter-date-input" data-empty={!filterDraft.from}>
                    <Input id="filter-from" type="date" value={filterDraft.from} onChange={(e) => setFilterDraft({ ...filterDraft, from: e.target.value })} />
                  </div>
                </div>
                <div>
                  <label htmlFor="filter-to">截止日期</label>
                  <div className="filter-date-input" data-empty={!filterDraft.to}>
                    <Input id="filter-to" type="date" value={filterDraft.to} onChange={(e) => setFilterDraft({ ...filterDraft, to: e.target.value })} />
                  </div>
                </div>
              </div>
              {invalidDateRange && <p role="alert">截止日期不能早于起始日期。</p>}

            </div>
          )}
        </Modal>
        <Modal
          title="另存工程"
          open={saveAs}
          onCancel={() => setSaveAs(false)}
          onOk={() => void save(true)}
          confirmLoading={busy}
          okButtonProps={{ disabled: !name.trim() || invalid }}
        >
          <label htmlFor="save-as-name">另存为名称</label>
          <Input
            id="save-as-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {error && <p role="alert">{error}</p>}
        </Modal>
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
              variant="default"
              loading={busy}
              disabled={
                busy || (!currentName && !name.trim()) || invalid || !!switching
              }
              onClick={async () => {
                if (await save()) await returnToBrowse();
              }}
            >
              保存并返回
            </Button>,
          ]}
        >
          <p>
            工程有未保存的修改。返回后会恢复进入工程前的浏览视野、筛选和显示。
          </p>
          {currentName ? (
            <p>保存到当前工程「{currentName}」</p>
          ) : (
            <>
              <label htmlFor="leave-project-name">新工程名称</label>
              <Input
                id="leave-project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </>
          )}
          {invalid && (
            <p role="alert">请先解决轨迹或资源版本问题，才能保存工程。</p>
          )}
          {error && <p role="alert">{error}</p>}
        </Modal>
        {inspection && (
          <div
            className="inspection-banner"
            role="region"
            aria-label="轨迹结果地图"
          >
            <PanelHeader
              title={`结果检查 · ${inspection.tracks.length} 条轨迹`}
              backLabel="返回原地图"
              onBack={() => {
                inspectionSequence.current++;
                setInspection(undefined);
                openPanel("library");
              }}
            />
            <span>临时显示，尚未入库</span>
            <Button onClick={() => fitTracks(inspection.tracks)}>定位结果</Button>

          </div>
        )}
        {showLoading && loadingText && (
          <div className="map-status" role="status">
            <Spin decorative /> {loadingText}
          </div>
        )}
        {overviewError && (
          <div className="overview-resource-error" role="alert">
            轨迹概览暂时不可用
            <Button size="sm" onClick={() => void retryOverview()}>
              重试概览
            </Button>
          </div>
        )}

        <div
          className="map-errors"
          hidden={!error && !sourceErrors.length && !versionChanged}
        >
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
