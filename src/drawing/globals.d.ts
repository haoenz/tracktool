import type { MapCanvas, RenderReport } from "./core.js";
declare global {
  interface Window {
    renderStatus: Partial<RenderReport> & { ready?: boolean; error?: string };
    renderer?: MapCanvas;
  }
}
export {};
