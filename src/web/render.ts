import "maplibre-gl/dist/maplibre-gl.css";
import "./map.css";
import { MapCanvas } from "../drawing/core.js";
import type {} from "../drawing/globals.js";
import type { Project } from "../shared/project.js";
import type { MapConfig, SelectedTrack } from "../shared/map.js";
import { api } from "./api.js";
window.renderStatus = { ready: false };
try {
  const job = new URLSearchParams(location.search).get("job") ?? "";
  const payload = await api<{
    state: Project;
    tracks: SelectedTrack[];
    config: MapConfig;
  }>(`/api/render/${encodeURIComponent(job)}`);
  const renderer = new MapCanvas(
    document.getElementById("frame")!,
    payload.state,
    payload.config,
  );
  renderer.setTracks(payload.tracks);
  window.renderer = renderer;
  const report = await renderer.ready();
  window.renderStatus = { ready: true, ...report };
} catch (error) {
  window.renderStatus = {
    error: error instanceof Error ? error.message : "导出失败",
  };
}
document.body.dataset.renderStatus = window.renderStatus.ready
  ? "ready"
  : "error";
