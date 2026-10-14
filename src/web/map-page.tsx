import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Select,
  Spin,
  Switch,
} from "antd";
import { Link } from "react-router-dom";
import type {
  Catalog,
  Cities,
  MapConfig,
  Selection,
  SelectedTrack,
} from "../shared/map.js";
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
import "maplibre-gl/dist/maplibre-gl.css";
import "./map.css";
type Bootstrap = {
  config: MapConfig;
  state: Project;
  initialArchive: string;
  directory: string;
};
type Loaded = { state: Project; versionsChanged: boolean } & Selection;
type Folder = {
  path: string;
  parent: string;
  directories: { name: string; path: string }[];
  archives: { name: string; path: string }[];
};
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
  const bootstrap = useQuery({
    queryKey: ["map-bootstrap"],
    queryFn: ({ signal }) =>
      api<Bootstrap>("/api/bootstrap", undefined, signal),
  });
  const cities = useQuery({
    queryKey: ["cities"],
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
        <Link to="/settings">设置</Link>
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
  const [state, setState] = useState(initial.state),
    [tracks, setTracks] = useState<SelectedTrack[]>([]),
    [catalog, setCatalog] = useState<Catalog>(),
    [archive, setArchive] = useState(initial.initialArchive),
    [filter, setFilter] = useState(""),
    [kind, setKind] = useState("all"),
    [names, setNames] = useState<string[]>([]),
    [name, setName] = useState(""),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [exporting, setExporting] = useState(false),
    [switching, setSwitching] = useState(""),
    [preview, setPreview] = useState(true),
    [collapsed, setCollapsed] = useState(false),
    [folder, setFolder] = useState<Folder>(),
    [sourceErrors, setSourceErrors] = useState<Selection["errors"]>([]),
    [versionChanged, setVersionChanged] = useState(false);
  const viewport = useRef<Viewport>(null),
    selection = useRef<AbortController | undefined>(undefined),
    operations = useRef(0),
    sourceSequence = useRef(0),
    stateRef = useRef(state),
    file = useRef<HTMLInputElement>(null);
  stateRef.current = state;
  const config = initial.config;
  const confirmDiscard = () =>
    !dirty || window.confirm("有尚未保存的修改，是否放弃？");
  const change = (edit: (next: Project) => void) => {
    setState((prev) => {
      const next = structuredClone(prev);
      edit(next);
      return next;
    });
    setDirty(true);
  };
  const refreshNames = async (path: string) =>
    setNames(
      (await api<{ names: string[] }>("/api/projects", { archive: path }))
        .names,
    );
  const openArchive = async (path = archive, force = false) => {
    if (!force && !confirmDiscard()) return;
    const sequence = ++operations.current;
    selection.current?.abort();
    setBusy(true);
    setError("");
    try {
      const data = await api<Catalog>("/api/archive", { path });
      if (sequence !== operations.current) return;
      setCatalog(data);
      setArchive(data.archive);
      setTracks([]);
      setSourceErrors([]);
      setName("");
      setState((prev) => ({ ...prev, archive: data.archive, tracks: [] }));
      setDirty(false);
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
        { archive: catalog.archive, entries },
        controller.signal,
      );
      if (sequence !== operations.current) return;
      setTracks(result.tracks);
      setSourceErrors(result.errors);
      change((s) => {
        s.archive = result.archive;
        s.tracks = result.tracks.map((t) => ({
          entry: t.entry,
          sha256: t.sha256,
        }));
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
      if (await viewport.current?.stage(next)) {
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
          : await api<Loaded>("/api/project", value);
      const data = result.state.archive
        ? await api<Catalog>("/api/archive", { path: result.state.archive })
        : undefined;
      if (sequence !== operations.current) return;
      if (!(await viewport.current?.stage(result.state))) return;
      setState(result.state);
      setTracks(result.tracks);
      setSourceErrors(result.errors);
      setCatalog(data);
      setArchive(result.state.archive);
      setVersionChanged(result.versionsChanged);
      setDirty(false);
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
      return;
    setBusy(true);
    setError("");
    const snapshot = structuredClone(state);
    try {
      await api("/api/projects/save", { name, state: snapshot });
      if (JSON.stringify(stateRef.current) === JSON.stringify(snapshot))
        setDirty(false);
      await refreshNames(state.archive);
      setNotice("项目已保存");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const browse = async (path = archive || initial.directory) => {
    try {
      setFolder(
        await api<Folder>(`/api/browse?path=${encodeURIComponent(path)}`),
      );
    } catch (e) {
      setError(message(e));
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
  const visible =
    catalog?.entries.filter(
      (e) =>
        (kind === "all" || e.kind === kind) &&
        e.entry.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
    ) ?? [];
  const invalid = sourceErrors.length > 0 || versionChanged;
  return (
    <div className="map-app">
      <header className="map-header">
        <h1>轨迹地图</h1>
        <span>{dirty ? "未保存" : "已同步"}</span>
        <span className="grow" />
        <Button onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? "展开控制面板" : "收起控制面板"}
        </Button>
        <Link
          to="/settings"
          onClick={(e) => {
            if (!confirmDiscard()) e.preventDefault();
          }}
        >
          设置
        </Link>
        {[
          ["/archive", "归档"],
          ["/tracks", "轨迹处理"],
          ["/media", "媒体"],
          ["/tasks", "任务"],
        ].map(([to, label]) => (
          <Link
            key={to}
            to={to!}
            onClick={(event) => {
              if (!confirmDiscard()) event.preventDefault();
            }}
          >
            {label}
          </Link>
        ))}
        <Button
          type="primary"
          onClick={() => void exportPng()}
          loading={exporting}
          disabled={busy || !!switching || invalid}
        >
          导出 PNG
        </Button>
      </header>
      <div className="map-content">
        <aside
          className={`map-controls${collapsed ? " collapsed" : ""}`}
          aria-label="地图控制面板"
        >
          <h2>归档与轨迹</h2>
          <label htmlFor="archive">服务端归档路径</label>
          <Input
            id="archive"
            value={archive}
            onChange={(e) => setArchive(e.target.value)}
            onPressEnter={() => void openArchive()}
          />
          <div className="map-actions">
            <Button onClick={() => void openArchive()} loading={busy}>
              打开归档
            </Button>
            <Button onClick={() => void browse()}>浏览目录</Button>
          </div>
          {catalog && (
            <>
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
                  <Checkbox
                    key={e.entry}
                    checked={state.tracks.some((t) => t.entry === e.entry)}
                    disabled={busy}
                    onChange={(v) =>
                      void select(
                        v.target.checked
                          ? [...state.tracks.map((t) => t.entry), e.entry]
                          : state.tracks
                              .filter((t) => t.entry !== e.entry)
                              .map((t) => t.entry),
                      )
                    }
                  >
                    {e.entry}
                  </Checkbox>
                ))}
              </div>
              <div className="map-actions">
                <Button
                  disabled={busy || visible.length > 200}
                  onClick={() => void select(visible.map((e) => e.entry))}
                >
                  选择筛选结果
                </Button>
                <Button disabled={busy} onClick={() => void select([])}>
                  清空选择
                </Button>
                <Button
                  onClick={() => viewport.current?.fit()}
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
                          void select(
                            state.tracks
                              .filter((s) => s.entry !== t.entry)
                              .map((s) => s.entry),
                          )
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
          <h2>地图样式</h2>
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
            {Object.entries(featureControls).map(([key, [label, options]]) => (
              <div key={key} title={featureReason(state, config, key)}>
                <label>{label}</label>
                <Select
                  aria-label={label}
                  disabled={!!featureReason(state, config, key)}
                  value={state.style.features[key]}
                  options={Object.entries(options).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                  onChange={(value) =>
                    change((s) => {
                      s.style.features[key] = value;
                    })
                  }
                />
              </div>
            ))}
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
                    state.style.overlays.find((s) => s.id === o.id)?.opacity ??
                    1
                  }
                  onChange={(value) =>
                    change((s) => {
                      const item = s.style.overlays.find((i) => i.id === o.id);
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
          <h2>项目</h2>
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
                !state.archive || !name.trim() || busy || invalid || !!switching
              }
            >
              保存项目
            </Button>
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
        </aside>
        <MapViewport
          ref={viewport}
          state={state}
          config={config}
          cities={cities.labels}
          tracks={tracks}
          preview={preview}
          onCamera={(camera) => {
            if (
              JSON.stringify(stateRef.current.camera) !== JSON.stringify(camera)
            )
              change((s) => {
                s.camera = camera;
              });
          }}
          onError={setError}
        />
      </div>
      <div className="map-status" role="status">
        {busy
          ? "正在读取归档…"
          : switching
            ? "正在准备新底图…"
            : notice || "打开归档后选择轨迹，可拖动地图调整视野。"}
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
      <Modal
        title="浏览服务端目录"
        open={!!folder}
        footer={null}
        onCancel={() => setFolder(undefined)}
      >
        <p>{folder?.path}</p>
        <Button onClick={() => void browse(folder?.parent)}>上一级</Button>
        {folder?.directories.map((d) => (
          <p key={d.path}>
            <Button type="link" onClick={() => void browse(d.path)}>
              {d.name}/
            </Button>
          </p>
        ))}
        {folder?.archives.map((d) => (
          <p key={d.path}>
            <Button
              onClick={() => {
                setFolder(undefined);
                void openArchive(d.path);
              }}
            >
              {d.name}
            </Button>
          </p>
        ))}
      </Modal>
    </div>
  );
}
