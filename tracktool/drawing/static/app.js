import { api, MapCanvas, frames } from "./core.js";
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
    message = "正在加载所选底图，原地图仍可浏览…";
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
    stage.clientWidth / scale,
    stage.clientHeight / scale,
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
function syncFields() {
  for (const key of ["basemap", "color", "width", "cities"])
    if (key !== "basemap" || !switching) $(key).value = state.style[key];
  $("width-value").value = state.style.width;
  const source = config.basemaps?.find(
    (item) => item.id === state.style.basemap,
  );
  $("basemap-note").textContent = source
    ? [
        source.has_text
          ? "底图自带文字、道路名或景点；地名开关只控制叠加城市文字。"
          : "无文字影像，可独立叠加城市地名。",
        source.overlay_only ? "此选项只显示透明路网，背景为纯色。" : "",
        source.crs === "gcj02"
          ? "已适配 Google 中国地图坐标；原始轨迹不变。"
          : "",
        source.available ? "" : "缺少本机地图凭据，暂不可用。",
      ]
        .filter(Boolean)
        .join(" ")
    : "";
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
    staged.style.basemap = candidate.state.style.basemap;
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
async function switchBasemap(id) {
  if (!state) return;
  cancelSwitch();
  const request = basemapRequest;
  switching = true;
  failedBasemap = undefined;
  controls();
  status("正在加载所选底图，原地图仍可浏览…", "busy");
  const frame = document.createElement("div");
  frame.className = "frame staging-frame";
  frame.setAttribute("aria-hidden", "true");
  $("frame-holder").append(frame);
  let staged;
  try {
    const next = structuredClone(state);
    next.style.basemap = id;
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
    state.style.basemap = id;
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
    status("地图样式已更新。");
  } catch (e) {
    if (request === basemapRequest) {
      failedBasemap = id;
      cancelSwitch();
      frame.remove();
      $("basemap").value = state.style.basemap;
      error(
        new Error(
          e.message + "；保留原底图，点击「重试资源」或重新选择以重试。",
        ),
      );
    }
  } finally {
    if (request === basemapRequest) switching = false;
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
  const catalog = result.state.archive
    ? await api("/api/archive", { path: result.state.archive })
    : { entries: [] };
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
  makeRenderer();
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
  else status("项目已恢复：轨迹、样式、视野、画框和标题。");
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
    option.textContent = config.satellite
      ? "卫星 · 自定义数据源"
      : "卫星 · 尚未配置";
    $("preset-basemaps")?.remove();
    const group = document.createElement("optgroup");
    group.id = "preset-basemaps";
    group.label = "内置地图源";
    for (const source of config.basemaps || []) {
      const entry = document.createElement("option");
      entry.value = source.id;
      entry.textContent = source.name + (source.available ? "" : " · 缺少凭据");
      entry.disabled = !source.available;
      group.append(entry);
    }
    $("basemap").append(group);
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
    await switchBasemap(failedBasemap || state.style.basemap);
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
