import "maplibre-gl/dist/maplibre-gl.css";
import "./map.css";
import { MapCanvas } from "../drawing/core.js";
import type {} from "../drawing/globals.js";
import type { MapConfig } from "../shared/map.js";
import type { OverviewStatus, OverviewVisibility } from "../shared/overview.js";
import type { PrintDocument } from "../shared/print.js";
import { OverviewLayer } from "./overview-layer.js";
import { api } from "./api.js";
window.renderStatus = { ready: false };
try {
  const job = new URLSearchParams(location.search).get("job") ?? "";
  const payload = await api<{
    document: PrintDocument;
    visible: { id: string; entry: string }[];
    overview: OverviewStatus;
    config: MapConfig;
  }>(`/api/render/${encodeURIComponent(job)}`);
  const renderer = new MapCanvas(
    document.getElementById("frame")!,
    payload.document,
    payload.config,
  );
  const visibility: OverviewVisibility = {
    all: false,
    exceptions: Object.fromEntries(
      payload.visible.map((track) => [track.id, track.entry]),
    ),
  };
  const layer = new OverviewLayer(
    renderer.map,
    renderer.crs,
    () => {},
    () => {},
    () => {},
    (id) => renderer.resources.errors(id).length > 0,
  );
  layer.update(payload.overview, "", false, visibility, false);
  window.renderer = renderer;
  const report = await renderer.ready();
  if (layer.hasErrors) throw new Error("轨迹概览加载失败，请重试");
  window.renderStatus = { ready: true, ...report };
} catch (error) {
  window.renderStatus = {
    error: error instanceof Error ? error.message : "导出失败",
  };
}
document.body.dataset.renderStatus = window.renderStatus.ready
  ? "ready"
  : "error";
