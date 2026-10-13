import { api, MapCanvas } from "./core.js";
window.renderStatus = { ready: false };
try {
  const job = new URLSearchParams(location.search).get("job");
  const [payload, cities] = await Promise.all([
    api(`/api/render/${encodeURIComponent(job)}`),
    api("/api/cities"),
  ]);
  await document.fonts.load("16px MapNoto", "中文地图");
  const renderer = new MapCanvas(
    document.getElementById("frame"),
    payload.state,
    payload.config,
    cities.labels,
  );
  renderer.setTracks(payload.tracks);
  window.renderer = renderer;
  const report = await renderer.ready();
  window.renderStatus = { ready: true, ...report };
} catch (error) {
  window.renderStatus = { error: error.message };
}

document.body.dataset.renderStatus = window.renderStatus.ready
  ? "ready"
  : "error";
