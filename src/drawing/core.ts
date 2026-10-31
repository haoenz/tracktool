import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import { frames, type MapState } from "../shared/map-state.js";
import type {
  MapConfig,
  MapPreset,
  SelectedTrack,
  TrackGeoJSON,
  Position,
} from "../shared/map.js";
import { ResourceHealth, type ResourceEvent } from "./resource-health.js";
export interface RenderReport {
  camera: MapState["camera"];
}
import { mapStyle, basemapPreset } from "./styles.js";
import { displayCoordinate, displayGeometry } from "./coordinates.js";
import { activeOverlays, canvasCrs, effectiveFeatures } from "./layers.js";
import { compositionPadding, trackBounds } from "./viewport.js";
import {
  projectTrackColor,
  trackColor,
  trackEndpoints,
  trackSegmentFeatures,
} from "./track-style.js";
/* Shared deterministic map renderer: fixed CSS-pixel frame, output DPR only. */
export { frames };
const empty: TrackGeoJSON = { type: "FeatureCollection", features: [] };
export class MapCanvas {
  frame: HTMLElement;
  state: MapState;
  config: MapConfig;
  preset: MapPreset | undefined;
  crs: string;
  onCamera?: (camera: MapState["camera"]) => void;
  onError?: (message: string) => void;
  readonly resources: ResourceHealth;
  get errors() {
    return this.resources.errors();
  }
  data: TrackGeoJSON;
  displayData?: TrackGeoJSON;
  loadedFont: boolean;
  exportPreview: boolean;
  printPreview: boolean;
  surround: { x: number; y: number };
  surroundSize?: [number, number, number];
  resizing: boolean;
  destroyed = false;
  mapElement: HTMLDivElement;
  overlay: HTMLCanvasElement;
  credit: HTMLDivElement;
  map: maplibregl.Map;
  fontReady: Promise<void>;
  private fontLoading = false;
  private textWidths = new Map<string, number>();
  private tracks: SelectedTrack[] = [];
  private endpoints: { start: Position; end: Position }[] = [];
  private displaySource: TrackGeoJSON = empty;

  constructor(
    frame: HTMLElement,
    state: MapState,
    config: MapConfig,
    onCamera?: (camera: MapState["camera"]) => void,
    onError?: (message: string) => void,
    handleResourceError?: (event: {
      error: Error;
      sourceId?: string;
    }) => boolean,
    onOverviewError?: (message: string) => void,
  ) {
    this.frame = frame;
    this.state = state;
    this.config = config;
    this.preset = basemapPreset(state, config);
    this.crs = canvasCrs(state, config);
    this.onCamera = onCamera;
    this.onError = onError;
    this.data = empty;
    this.loadedFont = false;
    // Export always starts in fixed-frame mode. The editor can explicitly
    // switch to viewport-wide browsing without modifying the saved state.
    this.exportPreview = true;
    this.printPreview = false;
    this.surround = { x: 0, y: 0 };
    this.resizing = false;
    frame.style.width = `${state.frame.width}px`;
    frame.style.height = `${state.frame.height}px`;
    frame.replaceChildren();
    this.mapElement = document.createElement("div");
    this.mapElement.className = "map";
    frame.append(this.mapElement);
    this.overlay = document.createElement("canvas");
    this.overlay.className = "overlay";
    frame.append(this.overlay);
    this.credit = document.createElement("div");
    this.credit.className = "credit";
    frame.append(this.credit);
    this.map = new maplibregl.Map({
      container: this.mapElement,
      style: mapStyle(state, config),
      center: displayCoordinate(state.camera.center, this.crs),
      zoom: state.camera.zoom,
      minZoom: 0,
      maxZoom: 18,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      renderWorldCopies: true,
      fadeDuration: 0,
      canvasContextAttributes: { preserveDrawingBuffer: true },
      localIdeographFontFamily: "MapNoto",
      trackResize: false,
      // MapLibre owns visible-tile ordering and aborts obsolete source requests.
      cancelPendingTileRequestsWhileZooming: true,
      pixelRatio: devicePixelRatio,
    });
    this.map.touchZoomRotate.disableRotation();
    const notify = () => {
      const blocked = ["base", "satellite", "tracks"].find((id) =>
        this.resources.blocked(id),
      );
      this.onError?.(
        blocked === "tracks"
          ? "轨迹显示加载失败，请重试"
          : blocked
            ? "底图加载失败，请重试"
            : "",
      );
      const overviewBlocked = Object.keys(
        this.map.getStyle()?.sources ?? {},
      ).some(
        (id) =>
          id.startsWith("overview-") &&
          this.resources.errors(id).length > 0 &&
          !this.resources.pending(id),
      );
      onOverviewError?.(overviewBlocked ? "轨迹概览加载失败，请重试" : "");
    };
    this.resources = new ResourceHealth(
      (id) => !!this.map.getSource(id),
      (id, tile) => {
        if (!this.destroyed && this.map.getSource(id))
          this.map.refreshTiles(id, tile ? [tile.tileID.canonical] : undefined);
      },
      notify,
    );
    this.map.on("error", (event) => {
      handleResourceError?.(event);
      this.resources.fail(event as unknown as ResourceEvent);
    });
    this.map.on("sourcedata", (event) =>
      this.resources.loaded(event as unknown as ResourceEvent),
    );
    this.map.on("idle", notify);
    this.map.on("dataabort", notify);
    this.map.on("render", () => this.draw());
    this.map.on("moveend", () => {
      if (this.resizing) return;
      const c = this.map.getCenter();
      const center = displayCoordinate([c.lng, c.lat], this.crs, true);
      this.state.camera = {
        center: [
          ((((center[0] + 180) % 360) + 360) % 360) - 180,
          Math.max(-85, Math.min(85, center[1])),
        ],
        zoom: this.map.getZoom(),
      };
      // GCJ inverse has a tiny numerical residual. Canonicalize the displayed
      // camera to the saved WGS84 camera so preview and fresh export agree.
      if (this.crs === "gcj02") this.setCamera(this.state.camera);
      this.onCamera?.(this.state.camera);
      if (this.surroundSize) this.setSurround(...this.surroundSize);
      this.draw();
    });
    this.fontReady = Promise.resolve();
    this.updateCredit();
  }
  private loadFont() {
    const pending = document.fonts
      .load("16px MapNoto", "中文地图")
      .then((fonts) => {
        if (!fonts.length) throw new Error("中文字体加载失败，请重试");
        this.loadedFont = true;
        this.textWidths.clear();
        if (!this.destroyed) this.draw();
      });
    void pending.catch((error: unknown) => {
      console.warn("[地图字体]", error);
    });
    return pending;
  }
  /** Load the bundled CJK font for export titles without blocking browsing. */
  private ensureFont() {
    if (this.loadedFont) return Promise.resolve();
    if (!this.fontLoading) {
      this.fontLoading = true;
      this.fontReady = this.loadFont();
      void this.fontReady
        .finally(() => {
          this.fontLoading = false;
        })
        .catch(() => {});
    }
    return this.fontReady;
  }
  private fontFamily() {
    return this.loadedFont
      ? "MapNoto"
      : 'system-ui, -apple-system, "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';
  }
  private measureText(
    ctx: CanvasRenderingContext2D,
    text: string,
    size: number,
  ) {
    const family = this.fontFamily();
    ctx.font = `${size}px ${family}`;
    const key = `${family}|${size.toFixed(3)}|${text}`;
    const cached = this.textWidths.get(key);
    if (cached !== undefined) return cached;
    const width = ctx.measureText(text).width;
    this.textWidths.set(key, width);
    return width;
  }
  retryResources() {
    this.resources.clear();
    this.onError?.("");
    if (this.exportPreview && !this.loadedFont)
      void this.ensureFont().catch(() => {});
    this.map.setStyle(mapStyle(this.state, this.config, this.displayData), {
      diff: false,
    });
  }
  // In the editor the map extends beyond the export frame. Symmetric extra
  // space preserves the frame's center and logical-pixel scale. Export uses 0.
  setSurround(width: number, height: number, scale = 1) {
    this.surroundSize = [width, height, scale];
    const x = Math.max(0, (width - this.state.frame.width) / 2);
    const y = Math.max(0, (height - this.state.frame.height) / 2);
    this.surround = { x, y };
    Object.assign(this.mapElement.style, {
      left: `${-x}px`,
      top: `${-y}px`,
      width: `${this.state.frame.width + 2 * x}px`,
      height: `${this.state.frame.height + 2 * y}px`,
    });
    this.resizing = true;
    try {
      // CSS already scales the preview. Render at its displayed
      // density instead of allocating a several-thousand-pixel mobile canvas.
      const pixelRatio = devicePixelRatio * scale;
      if (this.map.getPixelRatio() !== pixelRatio)
        this.map.setPixelRatio(pixelRatio);
      this.map.resize();
      const center = displayCoordinate(this.state.camera.center, this.crs);
      this.map.jumpTo({ center, zoom: this.state.camera.zoom });
      const actual = this.map.getCenter();
      if (
        Math.abs(actual.lat - center[1]) > 1e-8 ||
        Math.abs(actual.lng - center[0]) > 1e-8 ||
        Math.abs(this.map.getZoom() - this.state.camera.zoom) > 1e-8
      ) {
        // Keep the document synchronized with MapLibre's world constraints.
        this.state.camera = {
          center: displayCoordinate([actual.lng, actual.lat], this.crs, true),
          zoom: this.map.getZoom(),
        };
        this.onCamera?.(this.state.camera);
      }
    } finally {
      this.resizing = false;
    }
    this.draw();
  }
  /** Draw the frame decorations (title, credit) inside the export frame. */
  setPrintPreview(show: boolean) {
    this.printPreview = show;
    if (show && this.state.title) void this.ensureFont().catch(() => {});
    this.draw();
  }
  setExportPreview(show: boolean) {
    this.exportPreview = show;
    if (show) void this.ensureFont().catch(() => {});
    this.draw();
  }
  setCamera(camera: MapState["camera"]) {
    this.resizing = true;
    try {
      this.state.camera = structuredClone(camera);
      this.map.jumpTo({
        center: displayCoordinate(camera.center, this.crs),
        zoom: camera.zoom,
      });
    } finally {
      this.resizing = false;
    }
  }
  updateCredit() {
    this.credit.replaceChildren();
    const add = (label: string, url: string) => {
      const a = document.createElement("a");
      a.textContent = label;
      a.href = url;
      a.target = "_blank";
      a.rel = "noreferrer";
      if (this.credit.childNodes.length)
        this.credit.append(document.createTextNode(" · "));
      this.credit.append(a);
    };
    if (this.preset)
      this.credit.append(document.createTextNode(this.preset.attribution));
    else if (this.config.customVectorAttribution)
      this.credit.append(
        document.createTextNode(this.config.customVectorAttribution),
      );
    else {
      add("OpenFreeMap", "https://openfreemap.org/");
      add("© OpenMapTiles", "https://openmaptiles.org/");
      add(
        "© OpenStreetMap contributors",
        "https://www.openstreetmap.org/copyright",
      );
    }
    if (
      this.preset &&
      Object.values(effectiveFeatures(this.state, this.config)).some(
        (value) => value !== "none",
      )
    )
      add(
        this.config.customVectorAttribution || this.config.attribution,
        "https://openfreemap.org/",
      );
    for (const overlay of activeOverlays(this.state, this.config))
      add(
        overlay.attribution,
        overlay.group === "OpenInfraMap"
          ? "https://openinframap.org/"
          : overlay.group === "OpenSeaMap"
            ? "https://openseamap.org/"
            : overlay.group === "OpenRailwayMap"
              ? "https://openrailwaymap.org/"
              : "https://www.openstreetmap.org/copyright",
      );
  }
  setTracks(tracks: SelectedTrack[]) {
    this.tracks = tracks;
    this.endpoints = tracks.flatMap((track) => trackEndpoints(track) ?? []);
    this.data = {
      type: "FeatureCollection",
      features: tracks.flatMap((track) =>
        track.geojson.features.map((feature) => ({
          ...feature,
          properties: {
            ...feature.properties,
            project_entry: track.entry,
            project_color: projectTrackColor(track.entry, this.state.style),
          },
        })),
      ),
    };
    this.displaySource = {
      type: "FeatureCollection",
      features: tracks.flatMap((track) =>
        trackSegmentFeatures(track).map((feature) => ({
          ...feature,
          properties: {
            ...feature.properties,
            project_entry: track.entry,
            project_color: projectTrackColor(track.entry, this.state.style),
          },
        })),
      ),
    };
    this.displayData = displayGeometry(this.displaySource, this.crs);
    const apply = () =>
      (this.map.getSource("tracks") as GeoJSONSource | undefined)?.setData(
        this.displayData!,
      );
    // A loaded map may still be fetching tiles after a camera change. Its
    // GeoJSON source can be updated now; the one-shot initial `load` won't fire again.
    if (this.map.getSource("tracks")) apply();
    else this.map.once("styledata", apply);
  }
  apply(state: MapState) {
    const old = this.state;
    this.state = state;
    if (
      old.style.color_mode !== state.style.color_mode ||
      old.style.color !== state.style.color
    )
      this.setTracks(this.tracks);
    if (
      old.style.basemap !== state.style.basemap ||
      old.style.appearance !== state.style.appearance ||
      JSON.stringify([
        old.style.features,
        old.style.overlays,
        old.style.power,
      ]) !==
        JSON.stringify([
          state.style.features,
          state.style.overlays,
          state.style.power,
        ])
    ) {
      this.preset = basemapPreset(state, this.config);
      this.crs = canvasCrs(state, this.config);
      this.displayData = displayGeometry(this.displaySource, this.crs);
      this.resources.clear();
      this.map.setStyle(mapStyle(state, this.config, this.displayData));
      this.resizing = true;
      try {
        this.map.jumpTo({
          center: displayCoordinate(state.camera.center, this.crs),
          zoom: state.camera.zoom,
        });
      } finally {
        this.resizing = false;
      }
    } else if (this.map.getLayer("track-lines")) {
      this.map.setPaintProperty(
        "track-lines",
        "line-color",
        trackColor(state.style),
      );
      this.map.setPaintProperty("track-lines", "line-width", state.style.width);
      this.map.setPaintProperty(
        "track-halo",
        "line-width",
        state.style.width + 2,
      );
      this.map.setPaintProperty(
        "track-halo",
        "line-opacity",
        state.style.outline === false ? 0 : 0.8,
      );
      this.map.setPaintProperty(
        "track-points",
        "circle-color",
        trackColor(state.style),
      );
      this.map.setPaintProperty(
        "track-points",
        "circle-radius",
        state.style.width / 2,
      );
      this.map.setPaintProperty(
        "track-points",
        "circle-stroke-width",
        state.style.outline === false ? 0 : 1,
      );
    }
    if (
      old.frame.width !== state.frame.width ||
      old.frame.height !== state.frame.height
    ) {
      this.frame.style.width = `${state.frame.width}px`;
      this.frame.style.height = `${state.frame.height}px`;
      if (!this.surroundSize) this.map.resize();
    }
    this.updateCredit();
    this.draw();
  }
  fit(
    tracks?: SelectedTrack[],
    padding?: { left: number; right: number; top: number; bottom: number },
  ) {
    const coordinates: Position[] = [];
    const geometry = tracks
      ? displayGeometry(
          {
            type: "FeatureCollection",
            features: tracks.flatMap((t) => t.geojson.features),
          },
          this.crs,
        )
      : this.displayData || this.data;
    for (const f of geometry.features) {
      if (f.geometry.type === "MultiLineString")
        for (const segment of f.geometry.coordinates)
          for (const p of segment) coordinates.push(p);
      else for (const p of f.geometry.coordinates) coordinates.push(p);
    }
    const bounds = trackBounds(coordinates);
    if (!bounds)
      throw new Error("当前没有可显示的轨迹，请先显示至少一个片段。");
    this.map.fitBounds(bounds, {
      padding:
        padding ??
        compositionPadding(
          this.surround,
          !!this.state.title,
          this.credit.offsetHeight,
        ),
      maxZoom: 15,
      duration: 0,
    });
  }
  draw() {
    if (this.exportPreview && !this.loadedFont) return;
    const browsing = !this.exportPreview && this.surroundSize;
    const w = browsing ? this.surroundSize![0] : this.state.frame.width;
    const h = browsing ? this.surroundSize![1] : this.state.frame.height;
    const scale = browsing ? this.surroundSize![2] : 1;
    const unit = 1 / scale;
    const offsetX = (w - this.state.frame.width) / 2;
    const offsetY = (h - this.state.frame.height) / 2;
    const dpr = devicePixelRatio * scale;
    const canvas = this.overlay;
    canvas.style.left = `${-offsetX}px`;
    canvas.style.top = `${-offsetY}px`;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    if (
      canvas.width !== Math.round(w * dpr) ||
      canvas.height !== Math.round(h * dpr)
    ) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const dark = this.preset
      ? this.preset.imagery
      : this.state.style.appearance === "dark";
    ctx.fillStyle = dark ? "#f0eee5" : "#273b43";
    ctx.strokeStyle = dark ? "#202c33" : "#faf8f2";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3 * unit;
    if (this.state.style.endpoints) {
      ctx.font = `${12 * unit}px ${this.fontFamily()}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      for (const endpoints of this.endpoints) {
        for (const kind of ["start", "end"] as const) {
          const coordinate = displayCoordinate(endpoints[kind], this.crs);
          // Match the world copy closest to the camera at the date line.
          coordinate[0] +=
            360 * Math.round((this.map.getCenter().lng - coordinate[0]) / 360);
          const point = this.map.project(coordinate);
          const x = point.x - this.surround.x + offsetX;
          const y = point.y - this.surround.y + offsetY;
          if (x < 0 || y < 0 || x > w || y > h) continue;
          ctx.save();
          ctx.fillStyle = kind === "start" ? "#15803d" : "#c2410c";
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 2 * unit;
          ctx.beginPath();
          if (kind === "start") ctx.arc(x, y, 6 * unit, 0, 2 * Math.PI);
          else ctx.rect(x - 5 * unit, y - 5 * unit, 10 * unit, 10 * unit);
          ctx.fill();
          ctx.stroke();
          const label = kind === "start" ? "起" : "终";
          ctx.lineWidth = 3 * unit;
          ctx.strokeText(label, x, y - 9 * unit);
          ctx.fillText(label, x, y - 9 * unit);
          ctx.restore();
        }
      }
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if ((this.exportPreview || this.printPreview) && this.state.title) {
      ctx.lineWidth = 3;
      const frameWidth = this.state.frame.width;
      let size = 30;
      let width = this.measureText(ctx, this.state.title, size);
      while (width > frameWidth - 64 && size > 10) {
        size--;
        width = this.measureText(ctx, this.state.title, size);
      }
      // The title belongs to the exported frame, so it sits at the frame's top
      // in both the standalone export and the on-screen composition preview.
      ctx.strokeText(this.state.title, offsetX + frameWidth / 2, offsetY + 38);
      ctx.fillText(this.state.title, offsetX + frameWidth / 2, offsetY + 38);
    }
  }
  async ready(
    deadline = performance.now() + 65000,
    strict = true,
  ): Promise<RenderReport | undefined> {
    if (strict && this.exportPreview) await this.ensureFont();
    if (this.destroyed) return;
    if (performance.now() >= deadline)
      throw new Error("地图资源等待超时；请检查网络并重试");
    // Idle includes pending tile loads and source workers; two render frames
    // flush our canvas title after the idle event. No sleep-based screenshot.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          cleanup();
          reject(new Error("地图资源等待超时；请检查网络并重试"));
        },
        Math.max(0, deadline - performance.now()),
      );
      const cleanup = () => {
        clearTimeout(timer);
        this.map.off("idle", check);
        clearInterval(poll);
        this.map.off("remove", cancelled);
      };
      const cancelled = () => {
        cleanup();
        resolve();
      };
      const check = () => {
        if (strict && this.resources.pending()) return;
        if (strict && this.errors.length) {
          cleanup();
          reject(new Error("地图资源不完整，请重试后再导出或切换底图"));
          return;
        }
        if (
          this.map.loaded() &&
          this.map.areTilesLoaded() &&
          !this.map.isMoving()
        ) {
          cleanup();
          resolve();
        }
      };
      this.map.on("idle", check);
      const poll = setInterval(check, 100);
      this.map.on("remove", cancelled);
      check();
    });
    if (this.destroyed) return;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    if (this.destroyed) return;
    // A candidate can follow a camera/style edit during the two frame flush.
    // Recheck readiness against that final extent before allowing adoption.
    if (!this.map.loaded() || !this.map.areTilesLoaded() || this.map.isMoving())
      return this.ready(deadline, strict);
    this.draw();
    if (strict && this.errors.length)
      throw new Error("地图资源不完整，请重试后再导出或切换底图");
    return { camera: this.state.camera };
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resources.clear();
    this.map.remove();
    this.credit.remove();
  }
}
