import { TrackStyleSettings } from "./track-style-settings.js";
import type { ArchiveAction as ArchiveActionKind } from "./work-page.js";
import { useQuery } from "@tanstack/react-query";
import {
  FileOutput,
  List,
  Map as MapIcon,
  Settings as SettingsIcon,
  Upload,
} from "lucide-react";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { canvasCrs, reconcileOverlays } from "../drawing/layers.js";
import type { MapState } from "../shared/map-state.js";
import { frames, mapTitleError } from "../shared/map-state.js";
import type { Catalog, MapConfig, SelectedTrack } from "../shared/map.js";
import type { OverviewEntry, OverviewStatus } from "../shared/overview.js";
import type { MapExport, PrintDocument, PrintTrack } from "../shared/print.js";
import {
  printDocument,
  PrintDocumentSchema,
  resolvePrintTracks,
} from "../shared/print.js";
import type { HistoryEvent } from "../shared/track-edit.js";
import { operationLabel, type Operation } from "../shared/work.js";
import { api, request } from "./api.js";
import appIcon from "./app-icon.svg";
import { basemapLabel } from "./basemap-catalog.js";
import { BasemapPicker } from "./basemap-picker.js";
import {
  Alert,
  Button,
  Input,
  Modal,
  Select,
  Spin,
} from "./components/controls.js";
import { PanelHeader } from "./components/panel-header.js";
import { PanelLoading } from "./components/panel-loading.js";
import { SheetHandle } from "./components/sheet-handle.js";
import { StartupScreen } from "./components/startup-screen.js";
import { DeleteTrackDialog } from "./delete-track-dialog.js";
import { DetailPanel } from "./detail-panel.js";
import { downloadBlob } from "./lib/download.js";
import { LibraryList } from "./library-list.js";
import { MapContentSettings } from "./map-content-settings.js";
import { MapViewport, type Viewport } from "./map-viewport.js";
import "./map.css";
import type { OverviewHit, OverviewVisibility } from "./overview-layer.js";
import {
  rememberCamera,
  rememberedCamera,
  useOverview,
  type OverviewListScope,
} from "./overview.js";
import { PrintPanel } from "./print-panel.js";
import {
  rememberedPrintDraft,
  rememberedPrintFrame,
  rememberPrintDraft,
  rememberPrintFrame,
} from "./print-session.js";
import {
  deletePrint,
  listPrints,
  savePrint,
  type StoredPrint,
} from "./print-store.js";
import { useSessionState } from "./session-state.js";
import Settings from "./settings.js";
import { useTheme } from "./theme.js";
import { TrackDetailLinks } from "./track-detail-links.js";
import { TrackDetailToolbar } from "./track-detail-toolbar.js";
import type { AnalysisOverlay } from "./track-insights.js";
import { useEntryVisibility } from "./visibility-preference.js";
import { WorkspaceContext, type EditMap, type Panel } from "./workspace.js";
const TrackEditor = lazy(() => import("./track-editor.js"));
const ArchiveAction = lazy(() =>
  import("./work-page.js").then((m) => ({ default: m.ArchiveWorkPage })),
);
const panels: Record<Panel, string> = {
  library: "轨迹库",
  export: "导出",
  print: "出图",
  settings: "设置",
};
const emptyTracks: SelectedTrack[] = [];
const emptyEntries: OverviewEntry[] = [];
type Bootstrap = {
  config: MapConfig;
  state: MapState;
  initialArchive: string;
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
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
  if (bootstrap.isError)
    return (
      <div role="alert">
        <Alert
          type="error"
          title="地图资源加载失败"
          description={bootstrap.error?.message}
        />
        <Button
          onClick={() => {
            void bootstrap.refetch();
          }}
        >
          重试
        </Button>
        <Link to="/map?panel=settings">设置</Link>
        {params.get("panel") === "settings" && (
          <Suspense fallback={<PanelLoading>正在加载设置…</PanelLoading>}>
            <Settings />
          </Suspense>
        )}
      </div>
    );
  if (!bootstrap.data) return <StartupScreen />;
  return <Editor initial={bootstrap.data} />;
}
function Editor({ initial }: { initial: Bootstrap }) {
  const [starting, setStarting] = useState(true);
  const finishStartup = useCallback(() => setStarting(false), []);
  const { appearance } = useTheme();
  const [libraryVisibility, setLibraryVisibility] = useEntryVisibility(
    `tracktool:${initial.initialArchive}:visibility`,
  );
  const [mapState, setMapState] = useState<MapState>(() => ({
    ...initial.state,
    ...rememberedPrintFrame(initial.initialArchive),
    style: { ...initial.state.style, appearance },
    camera: rememberedCamera(initial.initialArchive) ?? initial.state.camera,
  }));
  const initialPrintView = useRef(
    JSON.stringify([mapState, libraryVisibility]),
  );
  const [printError, setPrintError] = useState("");
  const printSession = useRef<{ id?: string; saved: string; sealed?: boolean }>(
    {
      id: rememberedPrintDraft(initial.initialArchive),
      saved: "",
    },
  );
  const printWrites = useRef(Promise.resolve());
  const draftWarning = () =>
    toast.error("浏览器无法保存出图草稿，请及时导出 JSON。", {
      id: "print-draft-error",
      duration: 8000,
    });
  const [printDrafts, setPrintDrafts] = useState<StoredPrint[]>([]);
  const [catalog, setCatalog] = useState<Catalog>();
  const [browseFilter, setBrowseFilter] = useSessionState(
    `tracktool:${initial.initialArchive}:search`,
    "",
  );
  const [savedBrowseKind, setBrowseKind] = useSessionState<string | string[]>(
    `tracktool:${initial.initialArchive}:kind`,
    [],
  );
  const [batchMode, setBatchMode] = useState(false);
  const [browseBatch, setBrowseBatch] = useSessionState<Record<string, string>>(
    `tracktool:${initial.initialArchive}:batch`,
    {},
  );
  const [sheet, setSheet] = useState("half");
  const [editing, setEditing] = useState(false);
  const [editorHeader, setEditorHeader] = useState<{
    title: string;
    backLabel: string;
    onBack: () => void;
  }>();
  const [detailOpen, setDetailOpen] = useState(true);
  const [error, setError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [switching, setSwitching] = useState("");
  const [basemapError, setBasemapError] = useState("");
  const [displaySaveState, setDisplaySaveState] = useState<
    "" | "saving" | "saved" | "error"
  >("");
  const [baseRetry, setBaseRetry] = useState<{
    id: string;
    style?: MapState["style"];
  }>();
  const [displayRetry, setDisplayRetry] = useState(0);
  const [cameraLocked, setCameraLocked] = useState(false);
  const [guides, setGuides] = useState(false);
  const [browseDates, setBrowseDates] = useSessionState(
    `tracktool:${initial.initialArchive}:dates`,
    {
      from: "",
      to: "",
      sort: "date-desc",
    },
  );
  const activity = "正在读取轨迹…";
  const [drafts, setDrafts] = useState<Record<string, boolean>>({});
  const reportDraft = useCallback(
    (key: string, dirty: boolean) =>
      setDrafts((old) => (old[key] === dirty ? old : { ...old, [key]: dirty })),
    [],
  );
  const hasDraft = Object.values(drafts).some(Boolean);
  const [editMap, setEditMap] = useState<EditMap>();
  const cameraSave = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const batch = browseBatch;
  const setBatch = setBrowseBatch;
  const state = mapState;
  const previousAppearance = useRef(appearance);
  useEffect(() => {
    if (previousAppearance.current === appearance) return;
    previousAppearance.current = appearance;
    setMapState((previous) => ({
      ...previous,
      style: { ...previous.style, appearance },
    }));
  }, [appearance]);
  const browseVisibility = libraryVisibility;
  const setBrowseVisibility = setLibraryVisibility;
  const [mapScope, setMapScope] = useState<OverviewListScope>();
  const filter = mapScope?.search ?? browseFilter;
  const setFilter = (search: string) => {
    if (mapScope) setMapScope({ ...mapScope, search, offset: 0 });
    else setBrowseFilter(search);
  };
  const browseKind = useMemo(
    () =>
      Array.isArray(savedBrowseKind)
        ? savedBrowseKind
        : savedBrowseKind === "all"
          ? []
          : [savedBrowseKind],
    [savedBrowseKind],
  );
  const kind = mapScope?.kind ?? browseKind;
  const dates =
    mapScope?.dates ??
    (browseDates.sort === "name"
      ? { ...browseDates, sort: "date-desc" as const }
      : browseDates);
  const setDates = (dates: OverviewListScope["dates"]) => {
    if (mapScope) setMapScope({ ...mapScope, dates, offset: 0 });
    else setBrowseDates(dates);
  };
  const [importedScope, setImportedScope] = useState<string[]>();
  const [filterDraft, setFilterDraft] = useState<{
    kind: string[];
    from: string;
    to: string;
    candidates: string[];
  }>();
  const invalidDateRange = !!(
    filterDraft?.from &&
    filterDraft.to &&
    filterDraft.from > filterDraft.to
  );
  function applyListFilters() {
    if (!filterDraft || invalidDateRange) return;
    if (mapScope) {
      if (!filterDraft.candidates.length) setMapScope(undefined);
      else
        setMapScope({
          ...mapScope,
          kind: filterDraft.kind,
          candidates: filterDraft.candidates,
          dates: { ...dates, from: filterDraft.from, to: filterDraft.to },
          offset: 0,
        });
    } else {
      setBrowseKind(filterDraft.kind);
      overview.setCandidates(filterDraft.candidates);
      setDates({ ...dates, from: filterDraft.from, to: filterDraft.to });
      overview.setOffset(0);
    }
    setFilterDraft(undefined);
  }
  const setState = (update: MapState | ((prev: MapState) => MapState)) => {
    const next =
      typeof update === "function" ? update(stateRef.current) : update;
    stateRef.current = next;
    setMapState(next);
  };
  const [params, setParams] = useSearchParams();
  const rawPanel = params.get("panel") ?? "none";
  const panel = Object.hasOwn(panels, rawPanel)
    ? (rawPanel as Panel)
    : undefined;
  // The composition mask belongs to the print panel, so a reload restores the
  // same view instead of a full screen map without a frame.
  const printMode = panel === "print";
  const [archiveAction, setArchiveAction] = useState<ArchiveActionKind>();
  const [downloadingTrack, setDownloadingTrack] = useState(false);
  const [libraryList, setLibraryList] = useSessionState(
    `tracktool.library-list:${initial.initialArchive}`,
    false,
  );
  const [analysisOverlay, setAnalysisOverlay] = useState<AnalysisOverlay>();
  const [detailAction, setDetailAction] = useState<{
    operation: Operation;
    entry: string;
  }>();
  const [editorView, setEditorView] = useState<"edit" | "display" | "history">(
    "edit",
  );
  const editorTitles = {
    edit: "编辑轨迹",
    display: "分段管理",
    history: "历史记录",
  };
  const controls = useRef<HTMLElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const [menuExpanded, setMenuExpanded] = useState(
    !!panel && panel !== "settings",
  );
  useEffect(() => {
    document.title = panel
      ? `Tracktool · ${panels[panel]}`
      : "Tracktool · 地图";
  }, [panel]);
  const [exportEntries, setExportEntries] = useState<string[]>();
  const [exportKind, setExportKind] = useState<"zip" | "kml" | "png">();
  const openPanel = (next: Panel, task?: string) => {
    if (next === "library" && task === "imported") setLibraryList(true);
    if (task === "imported") {
      setMapScope(undefined);
      setArchiveAction(undefined);
      setBrowseFilter("");
      setBrowseKind([]);
      setBrowseDates({ from: "", to: "", sort: "date-desc" });
      setDetailOpen(false);
    }
    setDetailAction(undefined);
    setParams(task ? { panel: next, task: task } : { panel: next });
  };
  const refreshCatalog = async (
    path: string,
    options?: { quiet?: boolean },
  ) => {
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
    if (!options?.quiet) setNotice("轨迹库已刷新；当前地图选择和构图已保留。");
  };
  const viewport = useRef<Viewport>(null),
    operations = useRef(0),
    sourceSequence = useRef(0),
    stateRef = useRef(state),
    savedDisplayStyle = useRef(JSON.stringify(initial.state.style)),
    displaySaveSequence = useRef(0),
    displaySaveQueue = useRef<Promise<unknown>>(Promise.resolve());
  stateRef.current = state;
  useEffect(() => {
    const serialized = JSON.stringify(mapState.style);
    if (serialized === savedDisplayStyle.current) {
      setDisplaySaveState("");
      return;
    }
    setDisplaySaveState("saving");
    const sequence = ++displaySaveSequence.current;
    const timer = setTimeout(() => {
      // Serialize requests so a slow older save cannot land after a newer one.
      displaySaveQueue.current = displaySaveQueue.current
        .catch(() => {})
        .then(() => api("/api/display", { style: mapState.style }))
        .then(() => {
          if (sequence !== displaySaveSequence.current) return;
          savedDisplayStyle.current = serialized;
          setDisplaySaveState("saved");
        })
        .catch(() => {
          if (sequence === displaySaveSequence.current)
            setDisplaySaveState("error");
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [mapState.style, displayRetry]);
  useEffect(() => {
    setBasemapError("");
    setBaseRetry(undefined);
    cancelPendingBase();
  }, [panel]);
  const config = initial.config;
  // The basemap covers the viewport, so its CRS decides the render canvas.
  const crs = canvasCrs(state, config);
  const browseCrs = crs;
  const browseOverview = useOverview(
    browseCrs,
    browseFilter,
    browseKind,
    true,
    browseDates,
    mapScope,
  );
  const overview = browseOverview;
  const retryOverview = async () => {
    try {
      await overview.retry();
      viewport.current?.retryOverview();
    } catch (e) {
      overview.setTileError(message(e));
    }
  };
  const selectedVisible =
    !!overview.selected &&
    browseVisibility.all !==
      Object.hasOwn(browseVisibility.exceptions, overview.selected.id);
  const detailHistory = useQuery({
    queryKey: ["track-history", overview.id, "timeline", 0],
    queryFn: () =>
      api<{ events: HistoryEvent[]; next_cursor: number | null }>(
        `/api/tracks/${overview.id}/history?cursor=0`,
      ),
    enabled:
      !!overview.id &&
      panel === "library" &&
      detailOpen &&
      !editing &&
      !archiveAction,
  });
  const detailLinks = (["display", "history"] as const).filter((view) =>
    view === "display"
      ? overview.selected?.segments !== 1
      : !!detailHistory.data &&
        (detailHistory.data.next_cursor !== null ||
          detailHistory.data.events.length > 1 ||
          detailHistory.data.events.some(
            (event) => !["import", "push"].includes(event.kind),
          )),
  );
  const filtersApplied = !!(
    kind.length > 0 ||
    dates.from ||
    dates.to ||
    overview.candidates.length
  );
  const listVisible =
    panel === "library" && !(overview.id && detailOpen) && !archiveAction;
  const listScrollKey = JSON.stringify([
    mapScope ? "map" : "browse",
    filter,
    kind,
    dates,
    overview.candidates,
    overview.offset,
  ]);
  const scrollKey = `${panel}:${panel === "library" && detailOpen && overview.id ? overview.id : listScrollKey}:${panel === "library" ? (archiveAction ?? "list") : ""}:${panel === "library" && editing}`;
  useLayoutEffect(() => {
    const el = controls.current;
    if (el && (!listVisible || !overview.list.isFetching))
      el.scrollTop = scrollPositions.current.get(scrollKey) ?? 0;
  }, [scrollKey, listVisible, overview.list.isFetching]);
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
  useEffect(() => {
    if (
      !starting &&
      !fitted.current &&
      overview.query.data?.bounds &&
      overview.query.data.version &&
      !printMode
    ) {
      fitted.current = true;
      viewport.current?.fitOverview(overview.query.data.bounds);
    }
  }, [starting, overview.query.data, printMode]);
  const change = (edit: (next: MapState) => void) => {
    setState((prev) => {
      const next = structuredClone(prev);
      edit(next);
      return next;
    });
  };
  const openArchive = async (path = initial.initialArchive) => {
    const sequence = ++operations.current;
    setBusy(true);
    setError((previous) =>
      previous === `轨迹库读取失败：${catalogError}` ? "" : previous,
    );
    setCatalogError("");
    try {
      const data = await api<Catalog>("/api/archive", { path });
      if (sequence !== operations.current) return;
      setCatalog(data);
    } catch (e) {
      if (sequence !== operations.current) return;
      const text = message(e);
      setError(`轨迹库读取失败：${text}`);
      setCatalogError(text);
    } finally {
      if (sequence === operations.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (initial.initialArchive) void openArchive(initial.initialArchive);
    return () => {
      operations.current++;
      sourceSequence.current++;
    };
  }, []);
  useEffect(() => {
    if (!catalogError) return;
    // Reconnect only retries this read; user mutations are never replayed.
    const retry = () => void openArchive();
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [catalogError]);
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => {
      if (hasDraft) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [hasDraft]);
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
  const cancelPendingBase = () => {
    ++sourceSequence.current;
    viewport.current?.cancel();
    setSwitching("");
  };
  const switchBase = async (id: string, restore?: MapState["style"]) => {
    if (!restore && id === stateRef.current.style.basemap) {
      if (switching) {
        cancelPendingBase();
        setBasemapError("");
      }
      return;
    }
    const sequence = ++sourceSequence.current;
    viewport.current?.cancel();
    setSwitching(id);
    setError("");
    setBasemapError("");
    setBaseRetry(undefined);
    const next = structuredClone(stateRef.current);
    if (restore) next.style = structuredClone(restore);
    next.style.basemap = id;
    reconcileOverlays(next, config);
    try {
      if (config.basemaps.some((b) => b.id === id))
        await api("/api/basemap-check", { id });
      if (sequence !== sourceSequence.current) return;
      const targetCrs = canvasCrs(next, config);
      let prepared: OverviewStatus | undefined;
      const deadline = Date.now() + 120000;
      while (sequence === sourceSequence.current) {
        prepared = await api<OverviewStatus>(`/api/overview?crs=${targetCrs}`);
        if (prepared.version || prepared.state === "unconfigured") break;
        if (prepared.state === "error") throw new Error(prepared.error);
        if (Date.now() > deadline) throw new Error("轨迹概览准备超时，请重试");
        await new Promise((r) => setTimeout(r, 500));
      }
      if (sequence !== sourceSequence.current) return;
      const staged = await viewport.current?.stage(next, prepared);
      if (sequence !== sourceSequence.current) return;
      if (!staged) throw new Error("底图未准备完成，请重试");
      if (staged) {
        if (restore) {
          change((s) => {
            s.style = structuredClone(next.style);
          });
          setNotice("已恢复地图设置");
        } else {
          // Reconcile against the latest style so edits made while the
          // basemap was loading are not overwritten by the starting snapshot.
          const latest = structuredClone(stateRef.current);
          latest.style.basemap = id;
          reconcileOverlays(latest, config);
          change((s) => {
            s.style.basemap = id;
            s.style.overlays = latest.style.overlays;
          });
        }
      }
    } catch (e) {
      if (sequence === sourceSequence.current) {
        setBaseRetry({ id, style: restore });
        setBasemapError(
          restore
            ? `切换回「${basemapLabel(config, id)}」失败：${message(e)}`
            : `切换到「${basemapLabel(config, id)}」失败：${message(e)}`,
        );
      }
    } finally {
      if (sequence === sourceSequence.current) setSwitching("");
    }
  };
  useEffect(() => {
    if (!notice) return;
    toast.success(notice, { id: "workspace-notice", duration: 4000 });
    setNotice("");
  }, [notice]);
  const overviewError =
    overview.tileError ||
    (!overview.query.data?.version
      ? (overview.query.error?.message ?? overview.query.data?.error ?? "")
      : "");
  const listLoading =
    overview.list.isFetching || (overview.list.isPending && !overviewError);
  const loadingText = exporting
    ? "正在导出地图…"
    : switching
      ? "正在准备新底图…"
      : busy
        ? activity
        : !overviewError &&
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
      const result = await overview.fetchEntries(
        {
          version: overview.version,
          q: filter,
          kinds: JSON.stringify(kind),
          ...dates,
          offset: String(offset),
          limit: "500",
        },
        signal,
      );
      rows.push(...result.entries);
      if (rows.length >= result.total || !result.entries.length) return rows;
    }
  }
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const visibilityScope = JSON.stringify([
    overview.version,
    filter,
    kind,
    dates,
    overview.candidates,
  ]);
  const visibilityScopeRef = useRef(visibilityScope);
  visibilityScopeRef.current = visibilityScope;
  async function toggleListVisibility() {
    setVisibilityBusy(true);
    setError("");
    try {
      const rows = await allMatching();
      if (visibilityScopeRef.current !== visibilityScope || !rows.length)
        return;
      setBrowseVisibility((previous) => {
        const show = !rows.some(
          (row) => previous.all !== Object.hasOwn(previous.exceptions, row.id),
        );
        if (
          !overview.candidates.length &&
          !filter &&
          !kind.length &&
          !dates.from &&
          !dates.to
        )
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
  const fitTracks = (selected: SelectedTrack[], avoidPanel = true) => {
    try {
      viewport.current?.fit(selected, avoidPanel);
    } catch (error) {
      setError(message(error));
    }
  };
  const [batchSelecting, setBatchSelecting] = useState(false);
  const batchRequest = useRef(0);
  function clearBatch(exit = false) {
    batchRequest.current++;
    setBatchSelecting(false);
    setBatch({});
    if (exit) setBatchMode(false);
  }
  function returnFromExport(cancelSelection = false) {
    if (cancelSelection) clearBatch(true);
    setExportEntries(undefined);
    setExportKind(undefined);
    setLibraryList(true);
    setDetailOpen(false);
    setArchiveAction(undefined);
    openPanel("library");
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
      if (
        request !== batchRequest.current ||
        scope !== visibilityScopeRef.current
      )
        return;
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
  const visible = overview.list.data?.entries ?? emptyEntries;
  const hasVisibilityExceptions = useMemo(
    () => Object.keys(browseVisibility.exceptions).length > 0,
    [browseVisibility.exceptions],
  );
  const needsVisibilityRows =
    hasVisibilityExceptions &&
    (overview.list.data?.total ?? 0) > visible.length;
  const visibilityRows = useQuery({
    queryKey: [
      "overview-visibility-rows",
      overview.version,
      filter,
      kind,
      dates,
      overview.candidates,
    ],
    enabled:
      listVisible &&
      (needsVisibilityRows ||
        (batchMode && (overview.list.data?.total ?? 0) > visible.length)) &&
      !!overview.version,
    queryFn: ({ signal }) => allMatching(signal),
  });
  const visibilityPending =
    overview.list.isFetching ||
    (needsVisibilityRows && visibilityRows.isPending);
  const batchEntries =
    (overview.list.data?.total ?? 0) > visible.length
      ? visibilityRows.data
      : visible;
  const batchPending =
    overview.list.isFetching ||
    ((overview.list.data?.total ?? 0) > visible.length &&
      visibilityRows.isPending);
  function clearSelection() {
    // Editing owns map clicks and Escape; never discard its draft implicitly.
    if (editing || editMap || hasDraft || busy) return;
    overview.setId("");
    setDetailOpen(false);
    setDetailAction(undefined);
  }
  // Map events fire after this render. Keep stable wrappers so MapViewport can
  // bail out of panel-driven re-renders while still seeing the latest state.
  const viewportHandlers = useRef<{
    pick: (hits: OverviewHit[]) => void;
    camera: (camera: MapState["camera"]) => void;
    error: (error: string) => void;
  }>({
    pick: () => {},
    camera: () => {},
    error: () => {},
  });
  viewportHandlers.current.pick = (hits) => {
    if (editMap || editing || busy) return;
    if (!hits.length) {
      clearSelection();
      return;
    }
    if (
      hasDraft &&
      (hits.length !== 1 || hits[0]?.id !== overview.id) &&
      !window.confirm("当前轨迹有编辑草稿，切换轨迹将放弃草稿。是否继续？")
    )
      return;
    setFilterDraft(undefined);
    if (hits.length > 1)
      setMapScope({
        search: "",
        kind: [],
        dates: { from: "", to: "", sort: dates.sort },
        candidates: hits.map((hit) => hit.id),
        offset: 0,
      });
    overview.setId(hits.length === 1 ? hits[0]!.id : "");
    setDetailOpen(hits.length === 1);
    setMenuExpanded(true);
    setLibraryList(true);
    setArchiveAction(undefined);
    setSheet("half");
    openPanel("library");
    setEditing(false);
  };
  viewportHandlers.current.camera = (camera) => {
    const previous = stateRef.current.camera;
    if (
      previous.zoom === camera.zoom &&
      previous.center[0] === camera.center[0] &&
      previous.center[1] === camera.center[1]
    )
      return;
    // Initial layout may constrain the camera before overview bounds arrive.
    // Only later camera changes should cancel the first automatic fit.
    if (!starting) fitted.current = true;
    // "moveend" fires after every pan; defer the session write so a drag does
    // not serialize storage on each stop.
    if (cameraSave.current) clearTimeout(cameraSave.current);
    cameraSave.current = setTimeout(
      () => rememberCamera(initial.initialArchive, camera),
      400,
    );
    setState((prev) => ({ ...prev, camera }));
  };
  viewportHandlers.current.error = (error) => {
    overview.setTileError(error);
    if (error) void overview.query.refetch();
  };
  const handleOverviewPick = useCallback(
    (hits: OverviewHit[]) => viewportHandlers.current.pick(hits),
    [],
  );
  const handleCamera = useCallback(
    (camera: MapState["camera"]) => viewportHandlers.current.camera(camera),
    [],
  );
  const handleOverviewError = useCallback(
    (error: string) => viewportHandlers.current.error(error),
    [],
  );
  const handleSample = useCallback(
    (sample?: import("../shared/track-analysis.js").AnalysisSample) =>
      viewport.current?.setAnalysisSample(sample),
    [],
  );
  const titleError = mapTitleError(state.title);
  const visibleTracks = useMemo<PrintTrack[]>(() => {
    if (!catalog) return [];
    return catalog.entries
      .filter((entry) =>
        browseVisibility.all
          ? !Object.hasOwn(browseVisibility.exceptions, entry.id)
          : Object.hasOwn(browseVisibility.exceptions, entry.id),
      )
      .map((entry) => ({ entry: entry.entry, sha256: entry.sha256 }));
  }, [catalog, browseVisibility]);
  const printValue = useMemo(
    () =>
      catalog
        ? printDocument(state, catalog.archive, visibleTracks)
        : undefined,
    [catalog, state, visibleTracks],
  );
  const currentPrint = useRef(printValue);
  currentPrint.current = printValue;
  const initialPrintSave = useRef(true);
  const [draftsLoaded, setDraftsLoaded] = useState(false);
  const applyPrint = useCallback(
    (value: PrintDocument, saveNew = false) => {
      if (!catalog) return;
      const { tracks, warnings } = resolvePrintTracks(value, catalog);
      const exceptions = Object.fromEntries(
        tracks.map((track) => [track.id, track.entry]),
      );
      const style = { ...value.style };
      if (
        style.basemap !== "vector" &&
        !config.basemaps.some((basemap) => basemap.id === style.basemap)
      )
        style.basemap = stateRef.current.style.basemap;
      const next: MapState = {
        style,
        camera: value.camera,
        frame: value.frame,
        output: value.output,
        title: value.title,
      };
      reconcileOverlays(next, config);
      stateRef.current = next;
      setMapState(next);
      setPrintError("");
      setLibraryVisibility({ all: false, exceptions });
      rememberPrintDraft(initial.initialArchive);
      printSession.current = {
        saved: saveNew
          ? ""
          : JSON.stringify(
              printDocument(
                next,
                catalog.archive,
                tracks.map(({ entry, sha256 }) => ({ entry, sha256 })),
              ),
            ),
      };
      setNotice(warnings.join("；") || "已载入出图文档");
    },
    [catalog, config, setLibraryVisibility],
  );
  useEffect(() => {
    if (!catalog || draftsLoaded) return;
    let active = true;
    void listPrints()
      .then((saved) => {
        if (!active) return;
        setPrintDrafts(saved);
        if (
          printSession.current.id &&
          !saved.some((row) => row.id === printSession.current.id)
        ) {
          printSession.current.id = undefined;
          rememberPrintDraft(initial.initialArchive);
        }
        setDraftsLoaded(true);
      })
      .catch(() => {
        if (active) {
          setDraftsLoaded(true);
          draftWarning();
        }
      });
    return () => {
      active = false;
    };
  }, [catalog, draftsLoaded, applyPrint]);
  useEffect(() => {
    rememberPrintFrame(initial.initialArchive, state);
    rememberCamera(initial.initialArchive, state.camera);
  }, [
    initial.initialArchive,
    state.frame,
    state.output,
    state.title,
    state.camera,
  ]);
  const persistPrint = (
    value: PrintDocument,
    session = printSession.current,
    force = false,
  ) => {
    const serialized = JSON.stringify(value);
    // Serial writes prevent rapid edits/export from creating competing drafts.
    printWrites.current = printWrites.current
      .then(async () => {
        if (session.sealed && !force) return;
        if (session.saved === serialized && (session.id || !force)) return;
        session.id = await savePrint(value, session.id);
        session.saved = serialized;
        if (printSession.current === session)
          rememberPrintDraft(initial.initialArchive, session.id);
        setPrintDrafts(await listPrints());
      })
      .catch(draftWarning)
      .then(() => {});
  };
  const finishPrint = (
    value: PrintDocument,
    session = printSession.current,
  ) => {
    // A completed export seals its snapshot, including delayed autosaves that
    // were queued before completion. Edits made during rendering continue anew.
    session.sealed = true;
    persistPrint(value, session, true);
    if (printSession.current === session) {
      printSession.current = { saved: JSON.stringify(value) };
      rememberPrintDraft(initial.initialArchive);
      if (
        currentPrint.current &&
        JSON.stringify(currentPrint.current) !== JSON.stringify(value)
      )
        persistPrint(currentPrint.current);
    }
  };
  useEffect(() => {
    if (!printValue || !draftsLoaded) return;
    if (initialPrintSave.current) {
      initialPrintSave.current = false;
      // Catalog/IDB may finish loading after the user has already edited.
      // Only the untouched initial view can be skipped as a baseline.
      if (
        JSON.stringify([state, browseVisibility]) === initialPrintView.current
      ) {
        printSession.current.saved = JSON.stringify(printValue);
        return;
      }
    }
    const session = printSession.current;
    const timer = setTimeout(() => persistPrint(printValue, session), 500);
    return () => clearTimeout(timer);
  }, [printValue, draftsLoaded]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (
        event.defaultPrevented ||
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]',
        )
      )
        return;
      if (panel === "print") setParams({ panel: "none" });
      else clearSelection();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  const refreshPrintDrafts = useCallback(async () => {
    if (!catalog) return;
    try {
      setPrintDrafts(await listPrints());
    } catch {
      /* A blocked IndexedDB must not block printing. */
    }
  }, [catalog]);
  const exportPrint = async () => {
    if (!printValue || !catalog || titleError || exporting) return;
    setExporting(true);
    setPrintError("");
    const session = printSession.current;
    try {
      persistPrint(printValue, session, true);
      const { job, warnings } = await api<{ job: string; warnings: string[] }>(
        "/api/print",
        {
          document: printValue,
        },
      );
      if (warnings.length) toast.warning(warnings.join("；"));
      const deadline = Date.now() + 5 * 60_000;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        if (Date.now() > deadline)
          throw new Error("图片生成超时，请重试或稍后检查结果");
        const status = await api<MapExport>(`/api/jobs/${job}`);
        if (status.status === "done") {
          downloadBlob(
            await (await request(`/api/jobs/${job}/png`)).blob(),
            status.fileName,
          );
          setNotice(`已生成 ${status.fileName}`);
          finishPrint(printValue, session);
          void refreshPrintDrafts();
          break;
        }
        if (status.status === "failed")
          throw new Error(status.error || "图片生成失败，请重试");
      }
    } catch (e) {
      setPrintError(message(e));
    } finally {
      setExporting(false);
    }
  };
  const importPrint = async (file: File) => {
    setPrintError("");
    try {
      const parsed = PrintDocumentSchema.safeParse(
        JSON.parse(await file.text()),
      );
      if (!parsed.success)
        throw new Error(parsed.error.issues[0]?.message || "出图文档格式无效");
      applyPrint(parsed.data, true);
      openPanel("print");
    } catch (e) {
      setPrintError(`出图文档无法读取：${message(e)}`);
    }
  };
  const exportPrintJson = () => {
    if (!printValue) return;
    setPrintError("");
    try {
      downloadBlob(
        new Blob([JSON.stringify(printValue, null, 2)], {
          type: "application/json",
        }),
        `${(printValue.title || "tracktool-print").replace(/[/\\:*?"<>|]/g, "-")}.json`,
      );
      finishPrint(printValue);
    } catch (error) {
      setPrintError(`出图文档导出失败：${message(error)}`);
    }
  };
  const restorePrint = (draft: StoredPrint) => {
    const parsed = PrintDocumentSchema.safeParse(draft.document);
    if (!parsed.success) {
      setPrintError("出图草稿格式无效，请删除或导入有效 JSON");
      return;
    }
    applyPrint(parsed.data, true);
    openPanel("print");
  };
  const removePrint = async (id: string) => {
    try {
      await printWrites.current;
      await deletePrint(id);
    } catch {
      /* A blocked IndexedDB leaves the draft in place. */
    }
    if (id === printSession.current.id) {
      printSession.current.sealed = true;
      printSession.current = { saved: "" };
      rememberPrintDraft(initial.initialArchive);
    }
    await refreshPrintDrafts();
  };
  const setPrintRatio = (ratio: MapState["frame"]["ratio"]) => {
    change((next) => {
      const [width, height] = frames[ratio];
      next.frame = { ratio, width, height };
      const outputWidth = Math.max(
        Math.ceil((256 * width) / height),
        Math.min(next.output.width, Math.floor((4096 * width) / height), 4096),
      );
      next.output = {
        width: outputWidth,
        height: Math.round((outputWidth * height) / width),
      };
    });
  };
  const setPrintWidth = (width: number) => {
    change((next) => {
      next.output = {
        width,
        height: Math.round((width * next.frame.height) / next.frame.width),
      };
    });
  };
  return (
    <WorkspaceContext.Provider
      value={{
        archive: catalog?.archive ?? initial.initialArchive,
        draft: reportDraft,
        editMap: setEditMap,
        fit: fitTracks,
        open: openPanel,
        showTracks: (ids) => {
          openPanel("library", "imported");
          setImportedScope(ids);
          overview.setCandidates(ids);
          overview.setId("");
          setLibraryList(true);
        },
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
        className="map-app"
        data-sheet={sheet}
        inert={starting}
        aria-hidden={starting || undefined}
      >
        <header className="map-header">
          <button
            className="app-icon"
            type="button"
            aria-label={menuExpanded ? "收起菜单" : "展开菜单"}
            aria-expanded={menuExpanded}
            aria-controls="map-tools"
            onClick={() => {
              setMenuExpanded(!menuExpanded);
              if (menuExpanded) setParams({ panel: "none" });
            }}
          >
            <img src={appIcon} alt="" width="40" height="40" />
          </button>
          <nav id="map-tools" aria-label="地图工具" hidden={!menuExpanded}>
            <Button
              variant={
                panel === "library" && !archiveAction ? "default" : "ghost"
              }
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
              variant={
                panel === "library" && archiveAction === "archive:push"
                  ? "default"
                  : "ghost"
              }
              aria-label="上传轨迹"
              aria-expanded={
                panel === "library" && archiveAction === "archive:push"
              }
              aria-controls="map-panel"
              title="上传轨迹"
              onClick={() => {
                if (panel === "library" && archiveAction === "archive:push") {
                  setParams({ panel: "none" });
                  return;
                }
                openPanel("library");
                setDetailOpen(false);
                setMapScope(undefined);
                overview.setCandidates([]);
                setArchiveAction("archive:push");
              }}
            >
              <Upload size={22} aria-hidden="true" />
            </Button>
            <Button
              variant={panel === "export" ? "default" : "ghost"}
              aria-label="导出轨迹"
              aria-expanded={panel === "export"}
              aria-controls="map-panel"
              title="导出轨迹"
              onClick={() => {
                if (panel === "export") {
                  setParams({ panel: "none" });
                  return;
                }
                setExportKind(undefined);
                setExportEntries(undefined);
                setParams({ panel: "export" });
              }}
            >
              <FileOutput size={22} aria-hidden="true" />
            </Button>
            <Button
              variant={panel === "print" ? "default" : "ghost"}
              aria-label={panel === "print" ? "退出出图" : "出图"}
              aria-expanded={panel === "print"}
              title={panel === "print" ? "退出出图" : "出图"}
              onClick={() => {
                setMenuExpanded(false);
                if (panel === "print") setParams({ panel: "none" });
                else openPanel("print");
              }}
            >
              <MapIcon size={22} aria-hidden="true" />
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
        <div className="map-content">
          <aside
            id="map-panel"
            ref={controls}
            onScroll={(e) => {
              if (
                e.currentTarget.offsetParent &&
                (!listVisible || !listLoading)
              )
                scrollPositions.current.set(
                  scrollKey,
                  e.currentTarget.scrollTop,
                );
            }}
            className={`map-controls${panel === "library" && overview.id && detailOpen && !editing && !archiveAction ? " track-detail-panel" : ""}${listVisible ? " track-list-panel" : ""}${panel && panel === "settings" ? " wide" : ""}`}
            hidden={!panel}
            aria-label="地图控制面板"
          >
            <SheetHandle panel={controls} value={sheet} onChange={setSheet} />
            {!listVisible &&
              panel !== "export" &&
              panel !== "settings" &&
              archiveAction !== "archive:push" && (
                <PanelHeader
                  title={
                    panel === "library" && archiveAction
                      ? operationLabel(archiveAction)
                      : panel === "library" && overview.id && detailOpen
                        ? editing
                          ? (editorHeader?.title ?? editorTitles[editorView])
                          : (overview.selected?.name ?? "正在读取轨迹…")
                        : panel === "library" && libraryList
                          ? "轨迹列表"
                          : panel
                            ? panels[panel]
                            : ""
                  }
                  headingClassName={
                    panel === "library" && overview.id && detailOpen
                      ? "track-detail-heading"
                      : undefined
                  }
                  backLabel={
                    panel === "library" && archiveAction
                      ? "返回轨迹库"
                      : panel === "library" && overview.id && detailOpen
                        ? editing
                          ? (editorHeader?.backLabel ?? "返回详情")
                          : "返回列表"
                        : panel === "print"
                          ? "退出出图"
                          : "返回轨迹库"
                  }
                  onBack={
                    panel === "library" && archiveAction
                      ? () => setArchiveAction(undefined)
                      : panel === "library" && overview.id && detailOpen
                        ? () => {
                            if (editing) {
                              if (editorHeader) {
                                editorHeader.onBack();
                                return;
                              }
                              setEditing(false);
                              return;
                            }
                            setDetailOpen(false);
                            setLibraryList(true);
                            setDetailAction(undefined);
                          }
                        : panel === "library" && libraryList
                          ? () => setLibraryList(false)
                          : panel === "print"
                            ? () => setParams({ panel: "none" })
                            : undefined
                  }
                />
              )}
            {panel === "export" && (
              <section aria-label="轨迹导出类型" className="export-panel">
                <PanelHeader
                  title="导出轨迹"
                  backLabel={exportEntries ? "返回轨迹列表" : undefined}
                  onBack={exportEntries ? () => returnFromExport() : undefined}
                />
                <div className="export-scope">
                  <span className="settings-field-label">导出范围</span>
                  <p>
                    {exportEntries
                      ? `已选择 ${exportEntries.length} 条轨迹用于导出。`
                      : "轨迹库中的全部轨迹"}
                  </p>
                  {exportEntries ? (
                    <Button
                      variant="link"
                      className="export-cancel-selection"
                      onClick={() => returnFromExport(true)}
                    >
                      取消选择并返回列表
                    </Button>
                  ) : (
                    <p className="export-hint">
                      如需导出部分轨迹，请先在轨迹列表中批量选择。
                    </p>
                  )}
                </div>
                <label
                  className="settings-field-label"
                  htmlFor="track-export-kind"
                >
                  导出类型
                </label>
                <Select
                  id="track-export-kind"
                  aria-label="导出类型"
                  placeholder="请选择导出类型"
                  disabled={busy}
                  value={exportKind}
                  options={[
                    { value: "zip", label: "压缩包" },
                    { value: "kml", label: "聚合KML" },
                    { value: "png", label: "PNG图像" },
                  ]}
                  onChange={(value) => {
                    if (value === "png") {
                      setExportKind(undefined);
                      setMenuExpanded(false);
                      openPanel("print");
                      return;
                    }
                    setExportKind(value as "zip" | "kml");
                  }}
                />
                {!exportKind && (
                  <p className="export-hint export-empty">
                    压缩包保存独立轨迹，KML 汇总轨迹；PNG 在当前地图上取景出图。
                  </p>
                )}
                {(exportKind === "zip" || exportKind === "kml") && (
                  <Suspense
                    fallback={<PanelLoading>正在加载导出面板…</PanelLoading>}
                  >
                    <ArchiveAction
                      key={`${exportKind}:${JSON.stringify(exportEntries)}`}
                      entries={exportEntries}
                      fixedOperation={
                        exportKind === "zip"
                          ? "archive:backup"
                          : "archive:rebuild"
                      }
                    />
                  </Suspense>
                )}
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
                {mapScope && (
                  <PanelHeader
                    title="此处的轨迹"
                    backLabel="返回筛选结果"
                    onBack={() => setMapScope(undefined)}
                  />
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
                {!catalog &&
                  (!initial.initialArchive ? (
                    <div className="track-list-status" role="status">
                      后台尚未配置轨迹库
                    </div>
                  ) : catalogError ? (
                    <div className="track-list-status" role="alert">
                      轨迹库读取失败：{catalogError}
                      <Button size="sm" onClick={() => void openArchive()}>
                        重试读取轨迹库
                      </Button>
                    </div>
                  ) : (
                    <PanelLoading>正在读取轨迹库…</PanelLoading>
                  ))}
                {catalog && (
                  <LibraryList
                    scrollKey={listScrollKey}
                    toolbar={{
                      batchMode,
                      batchBusy: batchSelecting || batchPending,
                      batchDisabled:
                        batchSelecting ||
                        batchPending ||
                        !overview.list.data?.total ||
                        !batchEntries,
                      onSelectAll: (checked) => void selectAllMatching(checked),
                      visibilityBusy: visibilityBusy || visibilityPending,
                      visibilityDisabled:
                        visibilityBusy ||
                        visibilityPending ||
                        !overview.list.data?.total,
                      onToggleVisibility: () => void toggleListVisibility(),
                      filtersApplied,
                      onOpenFilters: () =>
                        setFilterDraft({
                          kind,
                          from: dates.from,
                          to: dates.to,
                          candidates: overview.candidates,
                        }),
                      filter,
                      onFilter: setFilter,
                      sort: dates.sort,
                      onSort: (sort: string) => setDates({ ...dates, sort }),
                      onToggleBatch: () => {
                        if (batchMode) clearBatch(true);
                        else setBatchMode(true);
                      },
                    }}
                    entries={visible}
                    matchingEntries={visibilityRows.data}
                    visibilityPending={visibilityPending}
                    visibilityError={visibilityRows.isError}
                    selectedId={overview.id}
                    visibility={browseVisibility}
                    batch={batch}
                    batchSelecting={batchSelecting}
                    loading={listLoading}
                    fetching={overview.list.isFetching}
                    error={
                      !overview.list.data
                        ? overview.list.error?.message
                        : undefined
                    }
                    onRetry={() => void overview.list.refetch()}
                    total={overview.list.data?.total}
                    offset={overview.offset}
                    onOffset={(offset) => {
                      if (mapScope) setMapScope({ ...mapScope, offset });
                      else overview.setOffset(offset);
                    }}
                    onOpen={(entry) => {
                      if (
                        entry.id !== overview.id &&
                        hasDraft &&
                        !window.confirm(
                          "当前轨迹有编辑草稿，切换轨迹将放弃草稿。是否继续？",
                        )
                      )
                        return;
                      overview.setId(entry.id);
                      setDetailOpen(true);
                      setEditing(false);
                    }}
                    onToggleBatch={toggleBatchEntry}
                    onToggleVisible={(entry, checked) =>
                      toggleBrowse(entry.id, entry.entry, checked)
                    }
                    onSelectPage={(checked) =>
                      setBatch((old) => {
                        const next = { ...old };
                        for (const entry of visible) {
                          if (checked) next[entry.id] = entry.entry;
                          else delete next[entry.id];
                        }
                        return next;
                      })
                    }
                    exportDisabled={busy || batchSelecting}
                    onExport={() => {
                      setExportEntries(Object.values(batch));
                      openPanel("export");
                      setExportKind(undefined);
                    }}
                  />
                )}
              </div>
            </section>
            {panel === "settings" && (
              <section>
                <Settings
                  tracks={<TrackStyleSettings state={state} change={change} />}
                  status={
                    displaySaveState === "error" && (
                      <p className="settings-error" role="alert">
                        显示样式保存失败
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDisplayRetry((n) => n + 1)}
                        >
                          重试保存
                        </Button>
                      </p>
                    )
                  }
                >
                  <BasemapPicker
                    config={config}
                    crs={crs}
                    value={state.style.basemap}
                    error={basemapError}
                    onPick={(id) => void switchBase(id)}
                    onRetry={
                      baseRetry
                        ? () => void switchBase(baseRetry.id, baseRetry.style)
                        : undefined
                    }
                  />
                  <MapContentSettings
                    state={state}
                    config={config}
                    change={change}
                    notify={setNotice}
                  />
                </Settings>
              </section>
            )}
            {overview.id && (
              <DetailPanel
                hidden={panel !== "library" || !detailOpen || !!archiveAction}
                editing={editing}
                entry={overview.selected}
                scope={initial.initialArchive}
                insightsActive={
                  panel === "library" &&
                  detailOpen &&
                  !editing &&
                  !archiveAction
                }
                onOverlay={setAnalysisOverlay}
                onSample={handleSample}
                error={
                  overview.detail.error ?? overview.matching.error ?? undefined
                }
                onRetry={() => {
                  void overview.detail.refetch();
                  void overview.matching.refetch();
                }}
                editor={
                  <Suspense fallback={<Spin />}>
                    <div hidden={!editing}>
                      {(editorView === "edit" ||
                        (editing &&
                          detailOpen &&
                          panel === "library" &&
                          !archiveAction)) && (
                        <TrackEditor
                          key={overview.id + ":" + editorView}
                          view={editorView}
                          onHeaderChange={setEditorHeader}
                          initialEntry={overview.id}
                          onEntryChange={(id) => {
                            overview.setId(id);
                            setEditing(false);
                          }}
                          active={
                            editing &&
                            detailOpen &&
                            panel === "library" &&
                            !archiveAction
                          }
                        />
                      )}
                    </div>
                  </Suspense>
                }
                dialog={
                  detailAction ? (
                    <DeleteTrackDialog
                      key={detailAction.entry}
                      entry={detailAction.entry}
                      onClose={() => setDetailAction(undefined)}
                      onDeleted={() => {
                        setDetailAction(undefined);
                        setDetailOpen(false);
                        setEditing(false);
                        overview.setId("");
                        setLibraryList(true);
                      }}
                    />
                  ) : undefined
                }
              >
                <TrackDetailToolbar
                  onLocate={() =>
                    fitTracks(
                      editMap ? editMap.tracks : [overview.selectedTrack!],
                      false,
                    )
                  }
                  locateDisabled={
                    editMap
                      ? !editMap.tracks.some((track) => track.points > 0)
                      : !overview.selectedTrack
                  }
                  visible={selectedVisible}
                  visibilityDisabled={!overview.selected}
                  onToggleVisible={() =>
                    toggleBrowse(
                      overview.selected!.id,
                      overview.selected!.entry,
                      !selectedVisible,
                    )
                  }
                  onEdit={() => {
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
                  downloading={downloadingTrack}
                  downloadDisabled={
                    !overview.detail.data ||
                    overview.detail.data.entry.id !== overview.id ||
                    overview.detail.data.entry.sha256 !==
                      overview.selected?.sha256
                  }
                  onDownload={() => {
                    const entry = overview.detail.data!.entry;
                    setDownloadingTrack(true);
                    void request(
                      "/api/tracks/" +
                        encodeURIComponent(entry.id) +
                        "/download?sha256=" +
                        entry.sha256,
                    )
                      .then(async (response) =>
                        downloadBlob(
                          await response.blob(),
                          entry.entry.split("/").at(-1) ?? "track.kml",
                        ),
                      )
                      .catch((error) =>
                        toast.error(
                          error instanceof Error
                            ? error.message
                            : "下载失败，请重试",
                        ),
                      )
                      .finally(() => setDownloadingTrack(false));
                  }}
                  deleteDisabled={!overview.selected}
                  onDelete={() =>
                    setDetailAction({
                      operation: "archive:delete",
                      entry: overview.selected!.entry,
                    })
                  }
                />
                <TrackDetailLinks
                  views={detailLinks}
                  titles={editorTitles}
                  onSelect={(view) => {
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
                />
              </DetailPanel>
            )}
            <section
              hidden={!archiveAction || panel !== "library"}
              aria-label="轨迹库操作"
            >
              {archiveAction && (
                <Suspense
                  fallback={
                    <PanelLoading>
                      {archiveAction === "archive:push"
                        ? "正在加载上传面板…"
                        : "正在加载轨迹库操作…"}
                    </PanelLoading>
                  }
                >
                  <ArchiveAction
                    key={archiveAction}
                    fixedOperation={archiveAction}
                  />
                </Suspense>
              )}
            </section>
            {panel === "print" && (
              <PrintPanel
                state={state}
                visibleCount={visibleTracks.length}
                busy={busy}
                exporting={exporting}
                error={printError}
                drafts={printDrafts}
                guides={guides}
                cameraLocked={cameraLocked}
                onRatio={setPrintRatio}
                onWidth={setPrintWidth}
                onTitle={(title) =>
                  change((next) => {
                    next.title = title;
                  })
                }
                onExport={() => void exportPrint()}
                onExportJson={exportPrintJson}
                onImportJson={(file) => void importPrint(file)}
                onRestore={restorePrint}
                onDelete={(id) => void removePrint(id)}
                onOpenLibrary={() => openPanel("library")}
                onGuides={setGuides}
                onCameraLocked={setCameraLocked}
                onFit={() => {
                  if (overview.query.data?.bounds)
                    viewport.current?.fitOverview(overview.query.data.bounds);
                }}
              />
            )}
          </aside>
          <MapViewport
            ref={viewport}
            geolocation
            state={state}
            config={config}
            tracks={editMap?.tracks ?? emptyTracks}
            overview={overview.query.data}
            overviewSelected={printMode ? "" : overview.id}
            overviewVisibility={browseVisibility}
            hideOverview={!!editMap}
            analysisOverlay={
              panel === "library" &&
              detailOpen &&
              !editing &&
              !archiveAction &&
              !editMap &&
              analysisOverlay?.key ===
                (overview.selected
                  ? overview.selected.id + overview.selected.sha256
                  : "")
                ? analysisOverlay
                : undefined
            }
            print={printMode}
            cameraLocked={(printMode && cameraLocked) || busy}
            guides={guides}
            highlightSegment={editMap?.segment}
            onPointPick={editMap?.pick}
            onOverviewPick={printMode ? undefined : handleOverviewPick}
            onOverviewLoading={overview.setLoading}
            onOverviewVersion={overview.published}
            onOverviewError={handleOverviewError}
            onCamera={handleCamera}
            onError={setError}
            onInitialized={finishStartup}
          />
        </div>
        <Modal
          title="筛选"
          open={!!filterDraft}
          onCancel={() => setFilterDraft(undefined)}
          footer={[
            <Button
              key="reset"
              onClick={() =>
                setFilterDraft({ kind: [], from: "", to: "", candidates: [] })
              }
            >
              重置
            </Button>,
            <Button key="cancel" onClick={() => setFilterDraft(undefined)}>
              取消
            </Button>,
            <Button
              key="apply"
              variant="default"
              disabled={invalidDateRange}
              onClick={applyListFilters}
            >
              应用
            </Button>,
          ]}
        >
          {filterDraft && (
            <div className="list-filter-fields">
              {filterDraft.candidates.length > 0 && (
                <div
                  className="list-location-filter"
                  role="group"
                  aria-label={
                    filterDraft.candidates === importedScope
                      ? "导入范围"
                      : "位置筛选"
                  }
                >
                  <span className="filter-category">
                    {filterDraft.candidates === importedScope ? "导入" : "位置"}
                  </span>
                  <span className="filter-result">
                    {filterDraft.candidates === importedScope
                      ? "本次导入"
                      : "点选附近"}
                    ：{filterDraft.candidates.length}条
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={
                      filterDraft.candidates === importedScope
                        ? "清除导入筛选"
                        : "清除位置筛选"
                    }
                    onClick={() =>
                      setFilterDraft({ ...filterDraft, candidates: [] })
                    }
                  >
                    清除
                  </Button>
                </div>
              )}
              <label htmlFor="filter-kind">轨迹分类</label>
              <Select
                id="filter-kind"
                aria-label="轨迹分类"
                multiple
                clearable
                placeholder="全部分类"
                value={filterDraft.kind}
                options={[
                  ...Array.from(
                    new Set(catalog?.entries.map((e) => e.kind) ?? []),
                  ).map((value) => ({ value, label: value })),
                ]}
                onChange={(kind) =>
                  setFilterDraft({ ...filterDraft, kind: kind ?? [] })
                }
              />
              <div className="list-filter-dates">
                <div>
                  <label htmlFor="filter-from">起始日期</label>
                  <div
                    className="filter-date-input"
                    data-empty={!filterDraft.from}
                  >
                    <Input
                      id="filter-from"
                      type="date"
                      value={filterDraft.from}
                      onChange={(e) =>
                        setFilterDraft({ ...filterDraft, from: e.target.value })
                      }
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="filter-to">截止日期</label>
                  <div
                    className="filter-date-input"
                    data-empty={!filterDraft.to}
                  >
                    <Input
                      id="filter-to"
                      type="date"
                      value={filterDraft.to}
                      onChange={(e) =>
                        setFilterDraft({ ...filterDraft, to: e.target.value })
                      }
                    />
                  </div>
                </div>
              </div>
              {invalidDateRange && (
                <p role="alert">截止日期不能早于起始日期。</p>
              )}
            </div>
          )}
        </Modal>
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

        <div className="map-errors" hidden={!error}>
          {error && (
            <>
              <div role="alert" className="map-error">
                {error}
              </div>
              <div className="map-actions">
                {catalogError &&
                  error === `轨迹库读取失败：${catalogError}` && (
                    <Button size="sm" onClick={() => void openArchive()}>
                      重试读取轨迹库
                    </Button>
                  )}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="关闭错误提示"
                  onClick={() => setError("")}
                >
                  关闭
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
      {starting && <StartupScreen />}
    </WorkspaceContext.Provider>
  );
}
