import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import type { Project } from "../shared/project.js";
import type {
  MapConfig,
  MapPreset,
  CityLabel,
  SelectedTrack,
  TrackGeoJSON,
  Position,
} from "../shared/map.js";
import { ResourceHealth, type ResourceEvent } from "./resource-health.js";
export interface DrawnLabel {
  id: string;
  name: string;
  level: number;
  x: number;
  y: number;
  box: [number, number, number, number];
  normalized: string;
}
export interface RenderReport {
  labels: DrawnLabel[];
  camera: Project["camera"];
}
import { mapStyle, basemapPreset } from "./styles.js";
import { displayCoordinate, displayGeometry } from "./coordinates.js";
import { activeOverlays, cityReason, effectiveFeatures } from "./layers.js";
/* Shared deterministic map renderer: fixed CSS-pixel frame, output DPR only. */
export const frames = {
  "4:3": [960, 720],
  "3:2": [960, 640],
  "16:9": [960, 540],
  "1:1": [960, 960],
  "3:4": [720, 960],
  "2:3": [640, 960],
};
const empty: TrackGeoJSON = { type: "FeatureCollection", features: [] };
export class MapCanvas {
  frame: HTMLElement;
  state: Project;
  config: MapConfig;
  cities: CityLabel[];
  preset: MapPreset | undefined;
  crs: string;
  onCamera?: (camera: Project["camera"]) => void;
  onError?: (message: string) => void;
  readonly resources: ResourceHealth;
  get errors() {
    return this.resources.errors();
  }
  data: TrackGeoJSON;
  displayData?: TrackGeoJSON;
  labels: DrawnLabel[];
  loadedFont: boolean;
  exportPreview: boolean;
  surround: { x: number; y: number };
  surroundSize?: [number, number, number];
  resizing: boolean;
  destroyed = false;
  mapElement: HTMLDivElement;
  overlay: HTMLCanvasElement;
  credit: HTMLDivElement;
  map: maplibregl.Map;
  fontReady: Promise<void>;
  private fontFailed = false;

  constructor(
    frame: HTMLElement,
    state: Project,
    config: MapConfig,
    cities: CityLabel[],
    onCamera?: (camera: Project["camera"]) => void,
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
    this.crs = this.preset?.crs || "wgs84";
    this.cities = cities;
    this.onCamera = onCamera;
    this.onError = onError;
    this.data = empty;
    this.labels = [];
    this.loadedFont = false;
    // Export always starts in fixed-frame mode. The editor can explicitly
    // switch to viewport-wide browsing without modifying the saved state.
    this.exportPreview = true;
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
    this.fontReady = this.loadFont();
    this.updateCredit();
  }
  private loadFont() {
    const pending = document.fonts
      .load("16px MapNoto", "中文地图")
      .then((fonts) => {
        if (!fonts.length) throw new Error("中文字体加载失败，请重试");
        this.loadedFont = true;
        this.fontFailed = false;
        if (!this.destroyed) this.draw();
      });
    void pending.catch((error: unknown) => {
      this.fontFailed = true;
      console.warn("[地图字体]", error);
    });
    return pending;
  }
  retryResources() {
    this.resources.clear();
    this.onError?.("");
    if (!this.loadedFont) this.fontReady = this.loadFont();
    this.map.setStyle(mapStyle(this.state, this.config, this.displayData), {
      diff: false,
    });
  }
  // In the editor the map extends beyond the export frame. Symmetric extra
  // space preserves the frame's center and logical-pixel scale. Export uses 0.
  setSurround(width: number, height: number, scale = 1) {
    this.surroundSize = [width, height, scale];
    const x = Math.max(0, Math.ceil((width - this.state.frame.width) / 2));
    // Never let the editor's extra space invoke MapLibre's pole constraints
    // and change the camera on resize. Beyond Mercator's poles is background.
    const world = 512 * 2 ** this.map.getZoom();
    const latitude = maplibregl.MercatorCoordinate.fromLngLat(
      this.map.getCenter(),
    ).y;
    const available = Math.floor(
      world * Math.min(latitude, 1 - latitude) -
        this.state.frame.height / 2 -
        1e-6,
    );
    const y = Math.max(
      0,
      Math.min(available, Math.ceil((height - this.state.frame.height) / 2)),
    );
    this.surround = { x, y };
    Object.assign(this.mapElement.style, {
      left: `${-x}px`,
      top: `${-y}px`,
      width: `${this.state.frame.width + 2 * x}px`,
      height: `${this.state.frame.height + 2 * y}px`,
    });
    this.resizing = true;
    try {
      this.map.resize();
    } finally {
      this.resizing = false;
    }
    this.draw();
  }
  setExportPreview(show: boolean) {
    this.exportPreview = show;
    this.draw();
  }
  setCamera(camera: Project["camera"]) {
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
    else if (this.state.style.basemap === "satellite")
      this.credit.append(
        document.createTextNode(this.config.satelliteAttribution + " "),
      );
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
      (this.preset || this.state.style.basemap === "satellite") &&
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
    if (
      this.state.style.cities === "county" &&
      !cityReason(this.state, this.config)
    )
      add("GeoNames · CC BY 4.0", "https://www.geonames.org/");
  }
  setTracks(tracks: SelectedTrack[]) {
    this.data = {
      type: "FeatureCollection",
      features: tracks.flatMap((t) => t.geojson.features),
    };
    this.displayData = displayGeometry(this.data, this.crs);
    const apply = () =>
      (this.map.getSource("tracks") as GeoJSONSource | undefined)?.setData(
        this.displayData!,
      );
    // A loaded map may still be fetching tiles after a camera change. Its
    // GeoJSON source can be updated now; the one-shot initial `load` won't fire again.
    if (this.map.getSource("tracks")) apply();
    else this.map.once("styledata", apply);
  }
  apply(state: Project) {
    const old = this.state;
    this.state = state;
    if (
      old.style.basemap !== state.style.basemap ||
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
      this.crs = this.preset?.crs || "wgs84";
      this.displayData = displayGeometry(this.data, this.crs);
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
      this.map.setPaintProperty("track-lines", "line-color", state.style.color);
      this.map.setPaintProperty("track-lines", "line-width", state.style.width);
      this.map.setPaintProperty(
        "track-halo",
        "line-width",
        state.style.width + 2,
      );
      this.map.setPaintProperty(
        "track-points",
        "circle-color",
        state.style.color,
      );
      this.map.setPaintProperty(
        "track-points",
        "circle-radius",
        state.style.width / 2,
      );
    }
    if (
      old.frame.width !== state.frame.width ||
      old.frame.height !== state.frame.height
    ) {
      this.frame.style.width = `${state.frame.width}px`;
      this.frame.style.height = `${state.frame.height}px`;
      this.map.resize();
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
    if (!coordinates.length) throw new Error("请先选择至少一条有效轨迹");
    // Choose the minimal longitude arc, including trips across the date line.
    const lons = coordinates
      .map((p) => ((p[0] % 360) + 360) % 360)
      .sort((a, b) => a - b);
    let gap = -1,
      start = lons[0]!;
    for (let i = 0; i < lons.length; i++) {
      const next =
        lons[(i + 1) % lons.length]! + (i === lons.length - 1 ? 360 : 0);
      if (next - lons[i]! > gap) {
        gap = next - lons[i]!;
        start = next % 360;
      }
    }
    let west = Infinity,
      east = -Infinity,
      south = 90,
      north = -90;
    for (const [lon, lat] of coordinates) {
      let x = ((lon % 360) + 360) % 360;
      if (x < start - 1e-8) x += 360;
      west = Math.min(west, x);
      east = Math.max(east, x);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
    if (west > 180) {
      west -= 360;
      east -= 360;
    }
    this.map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      {
        padding: padding ?? {
          top: this.surround.y + (this.state.title ? 90 : 55),
          bottom: this.surround.y + 55,
          left: this.surround.x + 55,
          right: this.surround.x + 55,
        },
        maxZoom: 15,
        duration: 0,
      },
    );
  }
  draw() {
    if (!this.loadedFont) return;
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
      : this.state.style.basemap !== "light";
    ctx.fillStyle = dark ? "#f0eee5" : "#273b43";
    ctx.strokeStyle = dark ? "#202c33" : "#faf8f2";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3 * unit;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const boxes: [number, number, number, number][] = [];
    this.labels = [];
    if (this.exportPreview && this.state.title) {
      let size = 30;
      ctx.font = `${size}px MapNoto`;
      while (ctx.measureText(this.state.title).width > w - 64 && size > 10) {
        size--;
        ctx.font = `${size}px MapNoto`;
      }
      ctx.strokeText(this.state.title, w / 2, 38);
      ctx.fillText(this.state.title, w / 2, 38);
      boxes.push([0, 0, w, 72]);
    }
    if (
      this.state.style.cities === "none" ||
      cityReason(this.state, this.config)
    )
      return;
    const zoom = this.map.getZoom() + Math.log2(scale),
      center = this.map.getCenter().lng;
    for (const city of this.cities) {
      if (zoom < [0, 3, 5, 6.5][city.level]!) continue;
      const position = displayCoordinate(city.position, this.crs);
      const lon = position[0] + 360 * Math.round((center - position[0]) / 360);
      const projected = this.map.project([lon, position[1]]);
      // Round sub-pixel arithmetic noise so expanded preview and isolated
      // export have exactly the same label collision decisions and reports.
      const x =
        Math.round((projected.x - this.surround.x + offsetX) * 1e6) / 1e6;
      const y =
        Math.round((projected.y - this.surround.y + offsetY) * 1e6) / 1e6;
      const size = [22, 20, 17, 14][city.level]! * unit;
      ctx.font = `${size}px MapNoto`;
      const tw = ctx.measureText(city.name).width;
      const box: [number, number, number, number] = [
        x - tw / 2 - 5 * unit,
        y - size / 2 - 5 * unit,
        x + tw / 2 + 5 * unit,
        y + size / 2 + 5 * unit,
      ];
      if (
        box[0] < 16 * unit ||
        box[1] < 16 * unit ||
        box[2] > w - 16 * unit ||
        box[3] > h - 30 * unit
      )
        continue;
      const normalized = city.name.replace(/[市区县]$/, "");
      if (
        this.labels.some(
          (l) =>
            l.normalized === normalized &&
            Math.hypot(l.x - x, l.y - y) < 90 * unit,
        )
      )
        continue;
      if (
        boxes.some(
          (b) =>
            box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1],
        )
      )
        continue;
      boxes.push(box);
      ctx.strokeText(city.name, x, y);
      ctx.fillText(city.name, x, y);
      this.labels.push({
        id: city.id,
        name: city.name,
        level: city.level,
        x,
        y,
        box,
        normalized,
      });
    }
  }
  async ready(
    deadline = performance.now() + 65000,
    strict = true,
  ): Promise<RenderReport | undefined> {
    if (strict) {
      if (this.fontFailed) this.fontReady = this.loadFont();
      await this.fontReady;
    }
    if (this.destroyed) return;
    if (performance.now() >= deadline)
      throw new Error("地图资源等待超时；请检查网络并重试");
    // Idle includes pending tile loads and source workers; two render frames
    // flush our canvas labels after the idle event. No sleep-based screenshot.
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
    return { labels: this.labels, camera: this.state.camera };
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resources.clear();
    this.map.remove();
    this.credit.remove();
  }
}
