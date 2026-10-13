import { api, MapCanvas, frames } from "./core.js";
import {
  featureControls,
  featureReason,
  overlayReason,
  cityReason,
  reconcileOverlays,
} from "./layers.js";
const $ = (id) => document.getElementById(id);
let state,
  config,
  cityData,
  renderer,
  entries = [],
  chosen = new Set(),
  tracks = [],
  selectionErrors = [],
  versionsChanged = false,
  pending = 0,
  requestId = 0,
  exporting = false,
  lastBlobUrl,
  creditObserver,
  styleRequest = 0,
  basemapRequest = 0,
  candidate,
  switching = false,
  failedBasemap,
  failedProject,
  statusTimer,
  activeTool = "library",
  previousTool = "library",
  selectedOnly = false,
  projectName = "",
  savedProjectName = "",
  hasChanges = false,
  editRevision = 0,
  projectNames = [];
const names = {
  Default: "普通",
  Train: "火车",
  Flight: "飞机",
  Unknown: "未分类",
};
function status(message, kind = "") {
  if (switching && kind !== "error") {
    message = "正在加载地图组合，原地图仍可浏览…";
    kind = "busy";
  }
  if (!kind && versionsChanged) {
    message += "\n项目资源版本不同，请检查预览并确认使用当前资源版本。";
    kind = "error";
  }
  $("status").textContent = message;
  $("status").className = kind;
  clearTimeout(statusTimer);
  $("status-window").hidden = false;
  $("retry").hidden = kind !== "error" || versionsChanged;
  $("download-again").hidden =
    !lastBlobUrl || !message.startsWith("PNG 已导出");
  if (!kind)
    statusTimer = setTimeout(() => {
      $("status-window").hidden = true;
    }, 5000);
}
function error(e) {
  status(e.message || String(e), "error");
}
function dirty() {
  hasChanges = true;
  editRevision++;
  projectIdentity();
}
function projectIdentity() {
  $("project-name").textContent = projectName || "未命名项目";
  $("project-name").title = projectName || "未命名项目";
  $("dirty").textContent = hasChanges
    ? "有修改"
    : savedProjectName
      ? "已保存"
      : "尚未保存";
}
function canReplaceProject() {
  return (
    !hasChanges || confirm("当前项目有未保存的修改，是否放弃这些修改并继续？")
  );
}
function controls() {
  $("stage").setAttribute("aria-busy", String(switching));
  $("basemap").disabled = !state || pending > 0 || exporting;
  for (const id of [
    "save-project",
    "save-db-project",
    "save-as-project",
    "export",
  ])
    $(id).disabled =
      !state ||
      pending > 0 ||
      selectionErrors.length > 0 ||
      versionsChanged ||
      switching ||
      exporting;
  $("save-db-project").disabled ||= !state?.archive;
  $("save-as-project").disabled ||= !state?.archive;
  $("load-db-project").disabled =
    !state?.archive || pending > 0 || switching || exporting;
  for (const id of ["new-project", "open-project", "browse"])
    $(id).disabled = !state || pending > 0 || switching || exporting;
  $("open-export").disabled = !state;
  for (const field of document.querySelectorAll("[data-layer-control]"))
    field.disabled =
      !state || pending > 0 || exporting || field.dataset.blocked === "true";
}
function resize() {
  if (!state) return;
  const stage = $("stage");
  const scale = Math.max(
    0.1,
    Math.min(
      (stage.clientWidth - (stage.clientWidth > 900 ? 680 : 48)) /
        state.frame.width,
      (stage.clientHeight - 200) / state.frame.height,
      1,
    ),
  );
  $("frame").style.transform = `scale(${scale})`;
  $("frame-holder").style.width = state.frame.width * scale + "px";
  $("frame-holder").style.height = state.frame.height * scale + "px";
  renderer?.setSurround(
    renderer?.exportPreview ? state.frame.width : stage.clientWidth / scale,
    renderer?.exportPreview ? state.frame.height : stage.clientHeight / scale,
    scale,
  );
  if (candidate) {
    candidate.frame.style.transform = $("frame").style.transform;
    candidate.setSurround(...renderer.surroundSize);
  }
  $("preview-scale").textContent = `预览 ${Math.round(scale * 100)}%`;
}
new ResizeObserver(resize).observe($("stage"));
function reserveCreditSpace() {
  const height =
    renderer && $("export-boundary").hidden
      ? renderer.credit.getBoundingClientRect().height + 8
      : 0;
  document.body.style.setProperty("--credit-space", `${height}px`);
}
function syncPreview() {
  if (!renderer) return;
  const show = !$("export-boundary").hidden;
  renderer.setExportPreview(show);
  candidate?.setExportPreview(show);
  renderer.credit.classList.toggle("viewport-credit", !show);
  (show ? $("frame") : $("stage")).append(renderer.credit);
  reserveCreditSpace();
  resize();
}
function showTools(show) {
  $("tool-panel").hidden = !show;
  $("toggle-tools").hidden = show;
  $("toggle-tools").setAttribute("aria-expanded", String(show));
  $("toggle-tools").textContent =
    activeTool === "output" ? "出图设置" : "轨迹与样式";
}
function selectTool(name) {
  if (name === "output" && activeTool !== "output") previousTool = activeTool;
  activeTool = name;
  for (const tool of ["library", "inspector", "output"]) {
    $(`${tool}-panel`).hidden = tool !== name;
    if (tool !== "output") {
      $(`toggle-${tool}`).setAttribute("aria-selected", String(tool === name));
      $(`toggle-${tool}`).tabIndex = tool === name ? 0 : -1;
    }
  }
  $("tool-tabs").hidden = name === "output";
  $("output-heading").hidden = name !== "output";
  $("export-boundary").hidden = name !== "output";
  $("open-export").setAttribute("aria-pressed", String(name === "output"));
  showTools(true);
  syncPreview();
}
for (const name of ["library", "inspector"]) {
  $(`toggle-${name}`).onclick = () => selectTool(name);
  $(`toggle-${name}`).onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? "library"
        : event.key === "End"
          ? "inspector"
          : name === "library"
            ? "inspector"
            : "library";
    selectTool(next);
    $(`toggle-${next}`).focus();
  };
}
$("toggle-tools").onclick = () => showTools(true);
$("close-tools").onclick = $("preview-only").onclick = () => {
  showTools(false);
  $("toggle-tools").focus();
};
$("open-export").onclick = () => selectTool("output");
$("leave-export").onclick = () => selectTool(previousTool);
$("toggle-filters").onclick = () => {
  $("filters").hidden = !$("filters").hidden;
  $("toggle-filters").setAttribute(
    "aria-expanded",
    String(!$("filters").hidden),
  );
};
for (const [id, selected] of [
  ["show-all", false],
  ["show-selected", true],
])
  $(id).onclick = () => {
    selectedOnly = selected;
    list();
  };
document.addEventListener("click", (event) => {
  if (
    !$("project-menu").contains(event.target) ||
    event.target.closest(".menu-items button")
  )
    $("project-menu").open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") $("project-menu").open = false;
});
for (const button of document.querySelectorAll("[data-dismiss]"))
  button.onclick = () => $(button.dataset.dismiss).close();
function makeRenderer() {
  cancelSwitch();
  creditObserver?.disconnect();
  renderer?.destroy();
  renderer = new MapCanvas(
    $("frame"),
    structuredClone(state),
    config,
    cityData.labels,
    (camera) => {
      state.camera = camera;
      candidate?.setCamera(camera);
      dirty();
    },
    (message) =>
      status("地图资源加载失败：" + message + "\n点击「重试资源」。", "error"),
  );
  renderer.setTracks(tracks);
  window.tracktool = {
    get state() {
      return structuredClone(state);
    },
    get renderer() {
      return renderer;
    },
  };
  resize();
  syncPreview();
  creditObserver = new ResizeObserver(reserveCreditSpace);
  creditObserver.observe(renderer.credit);
}
function layerDraft() {
  return structuredClone(candidate?.state.style || state.style);
}
function updateLayerStyle(style) {
  return switchBasemap(style.basemap, style);
}
function buildLayerControls() {
  $("feature-controls").replaceChildren();
  const extra = document.createElement("details"),
    summary = document.createElement("summary");
  summary.textContent = "更多要素：兴趣点、建筑、自然地名";
  extra.append(summary);
  for (const [key, [title, options]] of Object.entries(featureControls)) {
    const label = document.createElement("label");
    label.textContent = title;
    const select = document.createElement("select");
    select.id = `feature-${key}`;
    select.dataset.layerControl = "";
    for (const [value, text] of Object.entries(options))
      select.add(new Option(text, value));
    select.onchange = () => {
      const style = layerDraft();
      style.features[key] = select.value;
      updateLayerStyle(style);
    };
    const hint = document.createElement("small");
    hint.id = `feature-${key}-note`;
    hint.className = "hint";
    label.append(select, hint);
    (["places", "roads", "road_names", "boundaries"].includes(key)
      ? $("feature-controls")
      : extra
    ).append(label);
  }
  $("feature-controls").append(extra);
  $("overlay-controls").replaceChildren();
  const groups = new Map();
  for (const source of config.overlays) {
    if (!groups.has(source.group)) {
      const group = document.createElement("fieldset"),
        legend = document.createElement("legend");
      legend.textContent = source.group;
      group.append(legend);
      groups.set(source.group, group);
      $("overlay-controls").append(group);
    }
    const row = document.createElement("div");
    row.className = "overlay-row";
    const label = document.createElement("label"),
      check = document.createElement("input");
    check.type = "checkbox";
    check.id = `overlay-${source.id}`;
    check.dataset.layerControl = "";
    label.append(check, document.createTextNode(source.name));
    check.onchange = () => {
      const style = layerDraft();
      let entry = style.overlays.find((o) => o.id === source.id);
      if (!entry) {
        entry = { id: source.id, enabled: false, opacity: 1 };
        style.overlays.push(entry);
      }
      entry.enabled = check.checked;
      updateLayerStyle(style);
    };
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = 0.1;
    slider.max = 1;
    slider.step = 0.1;
    slider.id = `opacity-${source.id}`;
    slider.dataset.layerControl = "";
    slider.setAttribute("aria-label", `${source.name}不透明度`);
    slider.onchange = () => {
      const style = layerDraft();
      const entry = style.overlays.find((o) => o.id === source.id);
      if (entry) {
        entry.opacity = Number(slider.value);
        updateLayerStyle(style);
      }
    };
    const note = document.createElement("small");
    note.id = `overlay-${source.id}-note`;
    note.className = "hint";
    row.append(label, slider, note);
    groups.get(source.group).append(row);
  }
  $("power-voltage").onchange = () => {
    const s = layerDraft();
    s.power.min_voltage = Number($("power-voltage").value);
    updateLayerStyle(s);
  };
  $("power-facilities").onchange = () => {
    const s = layerDraft();
    s.power.facilities = $("power-facilities").value;
    updateLayerStyle(s);
  };
}
function syncLayers() {
  if (!config || !state || !$("feature-roads")) return;
  for (const key of Object.keys(featureControls)) {
    const field = $("feature-" + key),
      reason = featureReason(state, config, key);
    field.value = state.style.features[key];
    field.dataset.blocked = String(!!reason);
    $("feature-" + key + "-note").textContent = reason;
  }
  for (const source of config.overlays) {
    const entry = state.style.overlays.find((o) => o.id === source.id),
      check = $("overlay-" + source.id),
      slider = $("opacity-" + source.id);
    const reason = overlayReason(state, config, source);
    check.checked = !!entry?.enabled;
    check.dataset.blocked = String(!!reason && !entry?.enabled);
    slider.value = entry?.opacity || 1;
    slider.hidden = !entry?.enabled;
    slider.dataset.blocked = String(!entry?.enabled);
    $("overlay-" + source.id + "-note").textContent =
      reason ||
      `${source.crs.toUpperCase()} · ${source.format === "vector" ? "矢量" : source.tile_size + "px"} · ${source.minzoom}–${source.maxzoom} 级${entry?.enabled ? " · 不透明度 " + Math.round(entry.opacity * 100) + "%" : ""}`;
  }
  $("power-controls").hidden = !state.style.overlays.some(
    (o) => o.id === "openinframap-power" && o.enabled,
  );
  $("power-voltage").value = state.style.power.min_voltage;
  $("power-facilities").value = state.style.power.facilities;
  $("cities-note").textContent = cityReason(state, config);
}
function syncFields() {
  for (const key of ["basemap", "color", "width", "cities"])
    if (key !== "basemap" || !switching) $(key).value = state.style[key];
  $("width-value").value = state.style.width;
  const source = config.basemaps?.find(
    (item) => item.id === state.style.basemap,
  );
  $("basemap-note").textContent = source
    ? `${source.content_note} ${source.crs.toUpperCase()} · ${source.addressing} · ${source.tile_size}px · 原生 ${source.minzoom}–${source.maxzoom} 级。${source.coverage}`
    : state.style.basemap === "satellite"
      ? "自定义无字影像 · WGS84 · XYZ · 256px · 0–18 级；覆盖由配置的服务决定。"
      : "WGS84 · OpenFreeMap / OpenMapTiles 矢量数据；要素可独立控制。";
  syncLayers();
  $("ratio").value = state.frame.ratio;
  $("pixels").value = Math.max(state.output.width, state.output.height);
  $("title").value = state.title;
  $("output-size").textContent =
    `${state.output.width} × ${state.output.height} px`;
  $("frame-caption").textContent = state.frame.ratio;
  const parts = state.archive?.replaceAll("\\", "/").split("/") || [];
  $("archive-name").textContent = parts.length
    ? parts.at(-2) || parts.at(-1)
    : "未打开归档";
  $("archive-name").title = state.archive;
  $("browse").textContent = state.archive ? "切换…" : "打开…";
  $("adopt-versions").hidden = !versionsChanged;
  controls();
}
function apply() {
  renderer.apply(structuredClone(state));
  if (candidate) {
    const staged = structuredClone(state);
    staged.style = {
      ...candidate.state.style,
      color: state.style.color,
      width: state.style.width,
      cities: state.style.cities,
    };
    candidate.apply(staged);
  }
  syncFields();
  resize();
  dirty();
}
function visible() {
  // Selected view is independent of filters, including missing project references.
  if (selectedOnly) {
    const known = new Map(entries.map((e) => [e.entry, e]));
    return [...chosen].map(
      (entry) =>
        known.get(entry) || {
          entry,
          name: entry.split("/").at(-1),
          kind: "Unknown",
          date: "",
        },
    );
  }
  const q = $("search").value.toLocaleLowerCase(),
    from = $("date-from").value,
    to = $("date-to").value,
    kind = $("kind").value;
  return entries.filter(
    (e) =>
      (!q || e.entry.toLocaleLowerCase().includes(q)) &&
      (!from || (e.date && e.date >= from)) &&
      (!to || (e.date && e.date <= to)) &&
      (!kind || e.kind === kind),
  );
}
function list() {
  const focused = document.activeElement?.getAttribute("aria-label");
  const scrollTop = $("track-list").scrollTop;
  const filtered = visible();
  $("list-count").textContent = selectedOnly
    ? `${filtered.length} 条已选`
    : `${filtered.length} / ${entries.length} 条`;
  $("show-selected").textContent = `已选 ${chosen.size}`;
  $("show-selected").setAttribute("aria-pressed", String(selectedOnly));
  $("show-all").setAttribute("aria-pressed", String(!selectedOnly));
  $("select-visible").hidden = selectedOnly;
  $("clear").disabled = !chosen.size;
  $("search").disabled = selectedOnly;
  $("toggle-filters").disabled = selectedOnly;
  $("filter-chips").hidden = selectedOnly;
  if (selectedOnly) {
    $("filters").hidden = true;
    $("toggle-filters").setAttribute("aria-expanded", "false");
  }
  const chips = document.createDocumentFragment();
  for (const [id, prefix] of [
    ["date-from", "自 "],
    ["date-to", "至 "],
    ["kind", ""],
  ]) {
    if (!$(id).value) continue;
    const chip = document.createElement("button");
    chip.textContent =
      prefix + (id === "kind" ? names[$(id).value] : $(id).value) + " ×";
    chip.setAttribute(
      "aria-label",
      "清除筛选：" + chip.textContent.slice(0, -2),
    );
    chip.onclick = () => {
      $(id).value = "";
      list();
    };
    chips.append(chip);
  }
  $("filter-chips").replaceChildren(chips);
  $("selection-count").textContent =
    `已选 ${chosen.size} 条 · ${tracks.reduce((n, t) => n + t.points, 0).toLocaleString()} 点`;
  const fragment = document.createDocumentFragment();
  for (const e of filtered) {
    const row = document.createElement("div");
    row.className = "track-row";
    const label = document.createElement("label");
    label.title = e.entry;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = chosen.has(e.entry);
    checkbox.setAttribute("aria-label", e.entry);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) chosen.add(e.entry);
      else chosen.delete(e.entry);
      loadSelection();
    });
    const text = document.createElement("span"),
      name = document.createElement("strong"),
      detail = document.createElement("small");
    name.textContent = e.name.replace(/\.kml$/i, "");
    const issue = selectionErrors.find((item) => item.entry === e.entry);
    detail.textContent = issue
      ? "无法读取 · 可取消选择"
      : [e.date || "无日期", names[e.kind] || e.kind].join(" · ");
    if (issue) {
      detail.className = "track-error";
      row.title = issue.error;
    }
    text.append(name, detail);
    label.append(checkbox, text);
    const locate = document.createElement("button");
    locate.className = "locate";
    locate.textContent = "◎";
    locate.title = "定位这条轨迹";
    locate.setAttribute("aria-label", "定位 " + e.name);
    locate.onclick = () => locateTrack(e.entry);
    row.append(label, locate);
    fragment.append(row);
  }
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = selectedOnly
      ? "尚未选择轨迹，去「全部轨迹」添加。"
      : entries.length
        ? "没有匹配的轨迹，请调整筛选条件。"
        : "请打开本地轨迹归档。";
    fragment.append(empty);
  }
  $("track-list").replaceChildren(fragment);
  $("track-list").scrollTop = scrollTop;
  if (focused) {
    const checkbox = [...$("track-list").querySelectorAll("input")].find(
      (item) => item.getAttribute("aria-label") === focused,
    );
    checkbox?.focus({ preventScroll: true });
  }
}
async function locateTrack(entry) {
  pending++;
  controls();
  const generation = requestId;
  try {
    const result =
      tracks.find((t) => t.entry === entry) ||
      (
        await api("/api/selection", {
          archive: state.archive,
          entries: [entry],
        })
      ).tracks[0];
    if (generation !== requestId) return;
    if (!result) throw new Error("这条轨迹暂时无法定位，请选择它查看详情。");
    // Fit one geometry without changing the displayed selection.
    renderer.fit([result]);
    dirty();
    if (matchMedia("(max-width: 600px)").matches) showTools(false);
  } catch (e) {
    error(e);
  } finally {
    pending--;
    controls();
  }
}
async function loadSelection() {
  const id = ++requestId;
  pending++;
  controls();
  status("正在读取所选轨迹…", "busy");
  list();
  try {
    const result = await api("/api/selection", {
      archive: state.archive,
      entries: [...chosen],
    });
    if (id !== requestId) return;
    tracks = result.tracks;
    selectionErrors = result.errors;
    state.tracks = tracks.map(({ entry, sha256 }) => ({ entry, sha256 }));
    renderer.setTracks(tracks);
    candidate?.setTracks(tracks);
    dirty();
    list();
    if (selectionErrors.length)
      status(
        "以下轨迹未能绘制，取消选择或修复源文件后重试；保存和导出已暂停。\n" +
          selectionErrors.map((e) => `${e.entry}: ${e.error}`).join("\n"),
        "error",
      );
    else {
      await renderer.ready();
      if (id === requestId)
        status(`已绘制 ${tracks.length} 条轨迹。可点击「定位轨迹」查看全部。`);
    }
  } catch (e) {
    if (id === requestId) {
      selectionErrors = [{ error: e.message }];
      error(e);
    }
  } finally {
    pending--;
    controls();
  }
}
async function openArchive(path) {
  pending++;
  controls();
  status("正在读取归档目录…", "busy");
  try {
    const result = await api("/api/archive", { path });
    requestId++;
    state.archive = result.archive;
    state.tracks = [];
    entries = result.entries;
    tracks = [];
    selectionErrors = [];
    chosen = new Set();
    selectedOnly = false;
    projectName = savedProjectName = "";
    renderer.setTracks([]);
    candidate?.setTracks([]);
    syncFields();
    list();
    hasChanges = false;
    projectIdentity();
    $("file-dialog").close();
    status(`已打开归档，共 ${entries.length} 条。按日期、类型筛选后选择轨迹。`);
  } finally {
    pending--;
    controls();
  }
}
let parentFolder;
let browseRequestId = 0;
async function browse(path) {
  const id = ++browseRequestId;
  try {
    const result = await api("/api/browse?path=" + encodeURIComponent(path));
    if (id !== browseRequestId) return;
    $("folder-path").value = result.path;
    parentFolder = result.parent;
    $("browse-error").textContent = "";
    const fragment = document.createDocumentFragment();
    for (const [group, icon] of [
      [result.directories, "▸"],
      [result.archives, "◇"],
    ])
      for (const item of group) {
        const b = document.createElement("button");
        b.textContent = `${icon} ${item.name}`;
        b.onclick = () =>
          icon === "▸"
            ? browse(item.path)
            : openArchive(item.path).catch(
                (e) => ($("browse-error").textContent = e.message),
              );
        fragment.append(b);
      }
    $("folder-list").replaceChildren(fragment);
  } catch (e) {
    if (id === browseRequestId) $("browse-error").textContent = e.message;
  }
}
$("folder-path").oninput = () => {
  browseRequestId++;
  $("folder-list").replaceChildren();
  $("browse-error").textContent = "点击「前往」读取此目录。";
};
$("browse").onclick = () => {
  if (!canReplaceProject()) return;
  $("file-dialog").showModal();
  browse($("folder-path").value || ".");
};
$("close-dialog").onclick = () => $("file-dialog").close();
$("go-folder").onclick = () => browse($("folder-path").value);
$("folder-path").onkeydown = (e) => {
  if (e.key === "Enter") browse(e.target.value);
};
$("parent-folder").onclick = () => browse(parentFolder);
for (const id of ["search", "date-from", "date-to", "kind"])
  $(id).addEventListener("input", list);
$("select-visible").onclick = () => {
  const next = new Set([...chosen, ...visible().map((e) => e.entry)]);
  if (next.size > 200)
    return error(new Error("每次最多展示 200 条轨迹，请缩小筛选范围。"));
  for (const e of visible()) chosen.add(e.entry);
  if (state.archive) loadSelection();
};
$("clear").onclick = () => {
  chosen.clear();
  if (state.archive) loadSelection();
};
$("fit").onclick = () => {
  try {
    renderer.fit();
    dirty();
  } catch (e) {
    error(e);
  }
};
$("zoom-in").onclick = () => renderer?.map.zoomIn({ duration: 0 });
$("zoom-out").onclick = () => renderer?.map.zoomOut({ duration: 0 });
function cancelSwitch() {
  basemapRequest++;
  if (candidate) {
    candidate.destroy();
    candidate.frame.remove();
    candidate = undefined;
  }
  switching = false;
}
async function switchBasemap(id, requestedStyle) {
  if (!state) return;
  failedProject = undefined;
  requestedStyle = structuredClone(
    requestedStyle || candidate?.state.style || state.style,
  );
  cancelSwitch();
  const request = basemapRequest;
  switching = true;
  failedBasemap = undefined;
  controls();
  status("正在加载地图组合，原地图仍可浏览…", "busy");
  const frame = document.createElement("div");
  frame.className = "frame staging-frame";
  frame.setAttribute("aria-hidden", "true");
  $("frame-holder").append(frame);
  let staged;
  try {
    const next = structuredClone(state);
    next.style = structuredClone(
      requestedStyle || candidate?.state.style || state.style,
    );
    next.style.basemap = id;
    const notes = reconcileOverlays(next, config);
    staged = candidate = new MapCanvas(frame, next, config, cityData.labels);
    staged.setTracks(tracks);
    staged.setExportPreview(renderer.exportPreview);
    resize();
    const deadline = performance.now() + 65000;
    while (true) {
      await staged.ready(deadline);
      if (request !== basemapRequest || staged.destroyed) return;
      if (!renderer.map.isMoving()) break;
      // Preserve an in-progress gesture on the old map. Its moveend callback
      // sends the final WGS84 camera to the candidate before we try again.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Adopt camera, source, geometry, labels and attribution in one JS turn.
    // The committed project remains untouched until the whole candidate is ready.
    creditObserver?.disconnect();
    const previous = renderer;
    state.style = structuredClone(staged.state.style);
    staged.onCamera = (camera) => {
      state.camera = camera;
      candidate?.setCamera(camera);
      dirty();
    };
    staged.onError = (message) =>
      status("地图资源加载失败：" + message + "；请重试资源。", "error");
    previous.destroy();
    $("frame").replaceChildren(...frame.childNodes);
    staged.frame = $("frame");
    frame.remove();
    renderer = staged;
    candidate = undefined;
    switching = false;
    syncPreview();
    creditObserver = new ResizeObserver(reserveCreditSpace);
    creditObserver.observe(renderer.credit);
    syncFields();
    dirty();
    $("layer-notice").textContent = notes.join("；");
    status(notes.length ? notes.join("；") : "地图样式已更新。");
  } catch (e) {
    if (request === basemapRequest) {
      failedBasemap = {
        id,
        style: structuredClone(
          staged?.state.style || requestedStyle || state.style,
        ),
      };
      cancelSwitch();
      frame.remove();
      $("basemap").value = state.style.basemap;
      error(
        new Error(
          e.message +
            "；保留原底图与叠加层，点击「重试资源」或重新选择以重试。",
        ),
      );
    }
  } finally {
    if (request === basemapRequest) switching = false;
    syncLayers();
    controls();
  }
}
$("basemap").oninput = () => switchBasemap($("basemap").value);
for (const key of ["color", "width", "cities"])
  $(key).addEventListener("input", () => {
    if (!state) return;
    state.style[key] = key === "width" ? Number($(key).value) : $(key).value;
    const request = ++styleRequest;
    apply();
    const current = renderer;
    current
      .ready()
      .then(() => {
        if (request === styleRequest && current === renderer)
          status("地图样式已更新。");
      })
      .catch((e) => {
        if (request === styleRequest && current === renderer) error(e);
      });
  });
function outputSize() {
  const long = Number($("pixels").value);
  if (!Number.isInteger(long) || long < 480 || long > 4096)
    throw new Error("输出长边应为 480–4096 的整数");
  const { width: w, height: h } = state.frame;
  state.output = {
    width: Math.round((long * w) / Math.max(w, h)),
    height: Math.round((long * h) / Math.max(w, h)),
  };
}
$("ratio").onchange = () => {
  const ratio = $("ratio").value;
  const [width, height] = frames[ratio];
  state.frame = { ratio, width, height };
  try {
    outputSize();
    apply();
  } catch (e) {
    error(e);
  }
};
$("pixels").onchange = () => {
  try {
    outputSize();
    apply();
  } catch (e) {
    error(e);
  }
};
$("title").oninput = () => {
  state.title = $("title").value;
  apply();
};
function download(blob, name) {
  const a = document.createElement("a"),
    url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
$("save-project").onclick = async () => {
  pending++;
  controls();
  const snapshot = structuredClone(state);
  try {
    const result = await api("/api/project", snapshot);
    if (result.errors.length)
      throw new Error(
        "源内容已变化或缺失：" + result.errors.map((e) => e.entry).join("、"),
      );
    download(
      new Blob([JSON.stringify(snapshot, null, 2) + "\n"], {
        type: "application/json",
      }),
      (projectName || "tracktool-map").replace(/[\\/:*?"<>|]/g, "_") + ".json",
    );
    status(
      "项目文件已导出。可从「项目 → 导入项目文件」恢复构图；轨迹仍保存在归档中。",
    );
  } catch (e) {
    error(e);
  } finally {
    pending--;
    controls();
  }
};
$("open-project").onclick = () => $("project-file").click();
$("project-file").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !canReplaceProject()) return;
  cancelSwitch();
  failedBasemap = undefined;
  styleRequest++;
  pending++;
  controls();
  status("正在加载项目，原地图仍可浏览…", "busy");
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error("项目文件超过 2 MiB");
    const imported = JSON.parse(await file.text());
    if (
      state.archive &&
      imported.archive !== state.archive &&
      confirm("是否将项目轨迹关联到当前归档？将逐条验证原始内容指纹。")
    )
      imported.archive = state.archive;
    const result = await api("/api/project", imported);
    await restoreProject(result, file.name.replace(/\.json$/i, ""));
  } catch (e) {
    error(e);
  } finally {
    pending--;
    controls();
  }
};
async function restoreProject(result, name, fromDatabase = false) {
  failedProject = undefined;
  status("正在加载项目，原地图仍可浏览…", "busy");
  const catalog = result.state.archive
    ? await api("/api/archive", { path: result.state.archive })
    : { entries: [] };
  const frame = document.createElement("div");
  frame.className = "frame staging-frame";
  frame.setAttribute("aria-hidden", "true");
  $("frame-holder").append(frame);
  let staged;
  try {
    staged = new MapCanvas(
      frame,
      structuredClone(result.state),
      config,
      cityData.labels,
    );
    staged.setTracks(result.tracks);
    staged.setExportPreview(renderer.exportPreview);
    const scale = Math.max(
      0.1,
      Math.min(
        (stage.clientWidth - (stage.clientWidth > 900 ? 680 : 48)) /
          result.state.frame.width,
        (stage.clientHeight - 200) / result.state.frame.height,
        1,
      ),
    );
    frame.style.transform = `scale(${scale})`;
    staged.setSurround(
      staged.exportPreview
        ? result.state.frame.width
        : stage.clientWidth / scale,
      staged.exportPreview
        ? result.state.frame.height
        : stage.clientHeight / scale,
      scale,
    );
    await staged.ready();
  } catch (e) {
    staged?.destroy();
    frame.remove();
    failedProject = { result, name, fromDatabase };
    throw new Error(
      e.message + "；保留原项目和地图，点击「重试资源」重新打开目标项目。",
    );
  }
  failedProject = undefined;
  requestId++;
  state = result.state;
  tracks = result.tracks;
  selectionErrors = result.errors;
  versionsChanged = result.versionsChanged;
  chosen = new Set(state.tracks.map((t) => t.entry));
  entries = catalog.entries;
  selectedOnly = false;
  projectName = name;
  savedProjectName = fromDatabase ? name : "";
  creditObserver?.disconnect();
  renderer.destroy();
  $("frame").replaceChildren(...frame.childNodes);
  staged.frame = $("frame");
  staged.frame.style.width = state.frame.width + "px";
  staged.frame.style.height = state.frame.height + "px";
  frame.remove();
  renderer = staged;
  staged.onCamera = (camera) => {
    state.camera = camera;
    candidate?.setCamera(camera);
    dirty();
  };
  staged.onError = (message) =>
    status("地图资源加载失败：" + message + "；请重试资源。", "error");
  creditObserver = new ResizeObserver(reserveCreditSpace);
  creditObserver.observe(renderer.credit);
  resize();
  syncPreview();
  syncFields();
  list();
  hasChanges = false;
  projectIdentity();
  await renderer.ready();
  if (selectionErrors.length) {
    selectedOnly = true;
    selectTool("library");
    list();
    status(
      "项目已打开，但部分源轨迹缺失或内容变化：\n" +
        selectionErrors.map((e) => e.entry + ": " + e.error).join("\n") +
        "\n请在「已选」中取消有问题的条目，或恢复原归档后重新打开项目。",
      "error",
    );
  } else if (versionsChanged)
    status(
      "项目记录的资源版本与当前版本不同。请检查预览，确认使用当前资源后另存项目。",
      "error",
    );
  else
    status(
      "项目已恢复：轨迹、样式、视野、画框和标题。" + (state.migration || ""),
    );
  $("layer-notice").textContent = state.migration || "";
}
async function saveNamedProject(name) {
  const revision = editRevision;
  const snapshot = structuredClone(state);
  pending++;
  controls();
  $("confirm-save").disabled = true;
  status("正在保存项目…", "busy");
  try {
    await api("/api/projects/save", { name, state: snapshot });
    projectName = savedProjectName = name;
    if (editRevision === revision) hasChanges = false;
    projectIdentity();
    $("save-dialog").close();
    status("项目已保存到当前轨迹库。");
  } finally {
    pending--;
    controls();
    $("confirm-save").disabled = false;
  }
}
function askProjectName(copy = false) {
  $("save-title").textContent = copy ? "项目另存为" : "保存项目";
  $("project-name-input").value = projectName
    ? projectName + (copy ? " 副本" : "")
    : "";
  $("save-error").textContent = "";
  $("save-dialog").showModal();
  $("project-name-input").focus();
}
$("save-db-project").onclick = () =>
  savedProjectName
    ? saveNamedProject(savedProjectName).catch(error)
    : askProjectName();
$("save-as-project").onclick = () => askProjectName(true);
$("save-form").onsubmit = async (event) => {
  event.preventDefault();
  if ($("confirm-save").disabled) return;
  const name = $("project-name-input").value.trim();
  if (!name) {
    $("save-error").textContent = "请输入项目名称。";
    return;
  }
  $("confirm-save").disabled = true;
  try {
    const { names } = await api("/api/projects", { archive: state.archive });
    if (names.includes(name) && !confirm(`项目「${name}」已存在，是否覆盖？`))
      return;
    await saveNamedProject(name);
  } catch (e) {
    $("save-error").textContent = e.message;
  } finally {
    $("confirm-save").disabled = false;
  }
};
function projectList() {
  const query = $("project-search").value.toLocaleLowerCase();
  const matched = projectNames.filter((name) =>
    name.toLocaleLowerCase().includes(query),
  );
  const fragment = document.createDocumentFragment();
  for (const name of matched) {
    const button = document.createElement("button");
    button.textContent = name;
    button.onclick = () => openSavedProject(name);
    fragment.append(button);
  }
  if (!matched.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = projectNames.length
      ? "没有匹配的项目。"
      : "还没有项目。选择轨迹后，点击「保存」创建一个。";
    fragment.append(empty);
  }
  $("project-list").replaceChildren(fragment);
}
$("project-search").oninput = projectList;
$("load-db-project").onclick = async () => {
  pending++;
  controls();
  try {
    const { names } = await api("/api/projects", { archive: state.archive });
    projectNames = names;
    $("project-search").value = "";
    $("projects-error").textContent = "";
    projectList();
    $("projects-dialog").showModal();
  } catch (e) {
    error(e);
  } finally {
    pending--;
    controls();
  }
};
async function openSavedProject(name) {
  if (!canReplaceProject()) return;
  pending++;
  controls();
  $("project-search").disabled = true;
  for (const button of $("project-list").querySelectorAll("button"))
    button.disabled = true;
  try {
    cancelSwitch();
    failedBasemap = undefined;
    styleRequest++;
    const result = await api("/api/projects/load", {
      archive: state.archive,
      name,
    });
    $("projects-dialog").close();
    await restoreProject(result, name, true);
  } catch (e) {
    $("projects-error").textContent = e.message;
    error(e);
  } finally {
    pending--;
    controls();
    $("project-search").disabled = false;
    projectList();
  }
}
$("new-project").onclick = async () => {
  if (!canReplaceProject()) return;
  pending++;
  controls();
  try {
    const { state: fresh } = await api("/api/bootstrap");
    fresh.archive = state.archive;
    cancelSwitch();
    failedBasemap = undefined;
    styleRequest++;
    await restoreProject(
      { state: fresh, tracks: [], errors: [], versionsChanged: false },
      "",
    );
    for (const id of ["search", "date-from", "date-to", "kind"])
      $(id).value = "";
    selectTool("library");
    list();
    status("新项目已就绪，选择轨迹开始编辑。");
  } catch (e) {
    error(e);
  } finally {
    pending--;
    controls();
  }
};
$("adopt-versions").onclick = () => {
  state.versions = structuredClone(config.versions);
  versionsChanged = false;
  syncFields();
  dirty();
  status("已采用当前资源版本，请保存为新项目。");
};
$("export").onclick = async () => {
  try {
    outputSize();
  } catch (e) {
    error(e);
    $("pixels").focus();
    return;
  }
  exporting = true;
  controls();
  $("export").textContent = "正在导出…";
  status("正在按目标尺寸重新渲染，等待底图、字体与标签排版…", "busy");
  try {
    const result = await api("/api/export", state);
    let job;
    do {
      await new Promise((resolve) => setTimeout(resolve, 700));
      job = await api(`/api/jobs/${result.job}`);
    } while (["queued", "rendering"].includes(job.status));
    if (job.status === "failed") throw new Error(job.error);
    const response = await fetch(`/api/jobs/${result.job}/png`, {
      headers: {
        "X-Tracktool-Token": document.querySelector(
          'meta[name="session-token"]',
        ).content,
      },
    });
    if (!response.ok) throw new Error("图片下载失败，请重新导出");
    const blob = await response.blob();
    download(blob, "tracktool-map.png");
    if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
    lastBlobUrl = URL.createObjectURL(blob);
    $("download-again").href = lastBlobUrl;
    $("download-again").download = "tracktool-map.png";
    $("download-again").hidden = false;
    $("output-download-again").href = lastBlobUrl;
    $("output-download-again").download = "tracktool-map.png";
    $("output-download-again").hidden = false;
    status(
      `PNG 已导出 · ${job.report.width} × ${job.report.height} px · ${job.report.labels.length} 个地名。`,
    );
  } catch (e) {
    status(
      "导出失败：" + e.message + "\n修复网络或资源后，点击「下载 PNG」重试。",
      "error",
    );
  } finally {
    exporting = false;
    $("export").textContent = "下载 PNG";
    controls();
  }
};
async function boot() {
  pending++;
  controls();
  try {
    const payload = await api("/api/bootstrap");
    config = payload.config;
    state = state || payload.state;
    cityData = await api("/api/cities");
    $("folder-path").value = payload.directory;
    const option = $("basemap").querySelector("[value=satellite]");
    option.disabled = !config.satellite;
    option.hidden = !config.satellite;
    $("custom-basemaps").hidden = !config.satellite;
    option.textContent = config.satellite
      ? "卫星 · 自定义数据源"
      : "卫星 · 尚未配置";
    $("basemap")
      .querySelectorAll("[data-preset-basemap]")
      .forEach((entry) => entry.remove());
    const groups = new Map(
      Array.from($("basemap").querySelectorAll("optgroup"), (group) => [
        group.label,
        group,
      ]),
    );
    for (const source of config.basemaps || []) {
      let group = groups.get(source.group);
      if (!group) {
        group = document.createElement("optgroup");
        group.label = source.group;
        groups.set(source.group, group);
        $("basemap").insertBefore(group, $("custom-basemaps"));
      }
      const entry = document.createElement("option");
      entry.dataset.presetBasemap = "";
      entry.value = source.id;
      entry.textContent = source.name + (source.available ? "" : " · 缺少凭据");
      entry.disabled = !source.available;
      group.append(entry);
    }
    for (const group of $("basemap").querySelectorAll("optgroup"))
      if (!group.children.length) group.remove();
    buildLayerControls();
    await document.fonts.load("16px MapNoto", "中文地图");
    makeRenderer();
    syncFields();
    list();
    $("initial-loading").hidden = true;
    await renderer.ready();
    status("地图已就绪。打开本地归档，开始选择旅途。");
    if (payload.initialArchive && !state.archive)
      await openArchive(payload.initialArchive);
  } catch (e) {
    error(e);
  } finally {
    pending--;
    controls();
  }
}
$("retry").onclick = async () => {
  try {
    if (!config || !renderer) return await boot();
    if (failedProject) {
      const target = failedProject;
      pending++;
      controls();
      try {
        await restoreProject(target.result, target.name, target.fromDatabase);
      } finally {
        pending--;
        controls();
      }
      return;
    }
    await switchBasemap(
      failedBasemap?.id || state.style.basemap,
      failedBasemap?.style,
    );
    if (!failedBasemap && selectionErrors.length && state.archive)
      await loadSelection();
  } catch (e) {
    error(e);
  }
};
window.addEventListener("beforeunload", (e) => {
  if (hasChanges && state?.archive) {
    e.preventDefault();
    e.returnValue = "";
  }
});
boot();
