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
  basemapRequest = 0;
const names = {
  Default: "普通",
  Train: "火车",
  Flight: "飞机",
  Unknown: "未分类",
};
function status(message, kind = "") {
  $("status").textContent = message;
  $("status").className = kind;
}
function error(e) {
  status(e.message || String(e), "error");
}
function dirty() {
  $("dirty").textContent = "有未保存的编辑";
}
function controls() {
  $("basemap").disabled = !state || pending > 0 || exporting;
  for (const id of ["save-project", "export"])
    $(id).disabled =
      !state ||
      pending > 0 ||
      selectionErrors.length > 0 ||
      versionsChanged ||
      exporting;
}
function resize() {
  if (!state) return;
  const stage = $("stage");
  const scale = Math.max(
    0.1,
    Math.min(
      (stage.clientWidth - 80) / state.frame.width,
      (stage.clientHeight - 320) / state.frame.height,
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
  renderer.credit.classList.toggle("viewport-credit", !show);
  (show ? $("frame") : $("stage")).append(renderer.credit);
  reserveCreditSpace();
}
$("toggle-frame").onclick = () => {
  const show = $("export-boundary").hidden;
  $("export-boundary").hidden = !show;
  $("toggle-frame").setAttribute("aria-pressed", String(show));
  $("frame-toggle-label").textContent = show ? "隐藏画框" : "显示画框";
  syncPreview();
};
function showPanel(name, show) {
  $(`${name}-panel`).hidden = !show;
  $(`toggle-${name}`).setAttribute("aria-expanded", String(show));
  // On a phone, show one tool window at a time and keep the map underneath.
  if (show && matchMedia("(max-width: 600px)").matches) {
    const other = name === "library" ? "inspector" : "library";
    showPanel(other, false);
  }
}
for (const name of ["library", "inspector"]) {
  $(`toggle-${name}`).onclick = () =>
    showPanel(name, $(`${name}-panel`).hidden);
  document.querySelector(`[data-close="${name}"]`).onclick = () => {
    showPanel(name, false);
    $(`toggle-${name}`).focus();
  };
}
if (matchMedia("(max-width: 900px)").matches) showPanel("inspector", false);
function makeRenderer() {
  creditObserver?.disconnect();
  renderer?.destroy();
  renderer = new MapCanvas(
    $("frame"),
    structuredClone(state),
    config,
    cityData.labels,
    (camera) => {
      state.camera = camera;
      dirty();
    },
    (message) =>
      status(
        "地图资源加载失败：" + message + "\n点击「重新加载地图 / 重试资源」。",
        "error",
      ),
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
    $(key).value = state.style[key];
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
  $("archive-name").textContent = state.archive || "尚未打开归档 ZIP";
  $("archive-name").title = state.archive;
  $("adopt-versions").hidden = !versionsChanged;
  controls();
}
function apply() {
  renderer.apply(structuredClone(state));
  syncFields();
  resize();
  dirty();
}
function visible() {
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
  $("list-count").textContent = `${filtered.length} / ${entries.length}`;
  $("selection-count").textContent =
    `已选 ${chosen.size} 条 · ${tracks.reduce((n, t) => n + t.points, 0).toLocaleString()} 点`;
  const fragment = document.createDocumentFragment();
  for (const e of filtered) {
    const label = document.createElement("label");
    label.className = "track-row";
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
    name.textContent = e.name;
    detail.textContent = `${names[e.kind] || e.kind} · ${e.entry}`;
    text.append(name, detail);
    label.append(checkbox, text);
    fragment.append(label);
  }
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = entries.length
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
        status(
          `已绘制 ${tracks.length} 条轨迹。可点击「适应所选轨迹」，然后调整构图。`,
        );
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
    renderer.setTracks([]);
    syncFields();
    list();
    dirty();
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
$("basemap").oninput = async () => {
  if (!state) return;
  const id = $("basemap").value;
  const request = ++basemapRequest;
  let switched = false;
  pending++;
  controls();
  status("正在检查并加载所选底图…", "busy");
  try {
    if (config.basemaps?.some((source) => source.id === id))
      await api("/api/basemap-check", { id });
    if (request !== basemapRequest) return;
    state.style.basemap = id;
    switched = true;
    makeRenderer();
    syncFields();
    dirty();
    const current = renderer;
    await current.ready();
    if (request === basemapRequest && current === renderer)
      status("地图样式已更新。");
  } catch (e) {
    if (request === basemapRequest) {
      $("basemap").value = state.style.basemap;
      error(
        switched
          ? e
          : new Error(e.message + "；保留原底图，可重新选择以重试。"),
      );
    }
  } finally {
    pending--;
    controls();
  }
};
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
  try {
    const result = await api("/api/project", state);
    if (result.errors.length)
      throw new Error(
        "源内容已变化或缺失：" + result.errors.map((e) => e.entry).join("、"),
      );
    download(
      new Blob([JSON.stringify(state, null, 2) + "\n"], {
        type: "application/json",
      }),
      "tracktool-map.json",
    );
    $("dirty").textContent = "项目已下载保存";
    status("已生成项目文件。下次点击「打开项目」选择此 JSON，即可恢复编辑。");
  } catch (e) {
    error(e);
  }
};
$("open-project").onclick = () => $("project-file").click();
$("project-file").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  basemapRequest++;
  styleRequest++;
  pending++;
  controls();
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error("项目文件超过 2 MiB");
    const result = await api("/api/project", JSON.parse(await file.text()));
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
    makeRenderer();
    syncFields();
    list();
    $("dirty").textContent = "已打开 " + file.name;
    await renderer.ready();
    if (selectionErrors.length)
      status(
        "项目已打开，但部分源轨迹缺失或内容变化：\n" +
          selectionErrors.map((e) => e.entry + ": " + e.error).join("\n") +
          "\n请取消有问题的条目，或恢复原归档后重新打开项目。",
        "error",
      );
    else if (versionsChanged)
      status(
        "项目记录的资源版本与当前版本不同。请检查预览，确认使用当前资源后另存项目。",
        "error",
      );
    else status("项目已恢复：轨迹、样式、视野、画框和标题。");
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
    status(
      `PNG 已导出 · ${job.report.width} × ${job.report.height} px · ${job.report.labels.length} 个地名。`,
    );
  } catch (e) {
    status(
      "导出失败：" + e.message + "\n修复网络或资源后，点击「导出 PNG」重试。",
      "error",
    );
  } finally {
    exporting = false;
    $("export").textContent = "导出 PNG ↗";
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
    status("正在重新加载地图资源…", "busy");
    makeRenderer();
    await renderer.ready();
    if (selectionErrors.length && state.archive) await loadSelection();
    else status("地图资源已重新加载，可以继续编辑或导出。");
  } catch (e) {
    error(e);
  }
};
window.addEventListener("beforeunload", (e) => {
  if ($("dirty").textContent === "有未保存的编辑" && state?.archive) {
    e.preventDefault();
    e.returnValue = "";
  }
});
boot();
