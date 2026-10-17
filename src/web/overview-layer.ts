import type {
  Map as LibreMap,
  MapMouseEvent,
  ExpressionSpecification,
} from "maplibre-gl";
import type { OverviewStatus } from "../shared/overview.js";

import { TRACK_STYLES } from "../shared/track-style.js";

const categoryPaint = (key: "color" | "opacity"): ExpressionSpecification => [
  "match",
  ["get", "kind"],
  "Default",
  TRACK_STYLES.Default[key],
  "Train",
  TRACK_STYLES.Train[key],
  "Flight",
  TRACK_STYLES.Flight[key],
  TRACK_STYLES.Unknown[key],
];

export type OverviewHit = { id: string; segment: string };
export type OverviewVisibility = {
  all: boolean;
  exceptions: Record<string, string>;
};
/** Browser-only layers; the independent export renderer never installs these. */
export class OverviewLayer {
  private status?: OverviewStatus;
  private current?: string;
  private pending?: string;
  private selected = "";
  private analysisSelected = false;
  private hidden = false;
  private visibility?: OverviewVisibility;
  private serial = 0;
  private scale = 1;
  private hoverTimer?: number;
  private hoverEvent?: MapMouseEvent;
  constructor(
    private map: LibreMap,
    private crs: string,
    private onPick: (hits: OverviewHit[]) => void,
    private onLoading: (loading: boolean) => void,
    private onVersion: (version: string) => void,
    private resourceErrors: (source: string) => boolean = () => false,
  ) {
    map.setTransformRequest((url) => {
      const parsed = new URL(url, location.href);
      return parsed.origin === location.origin &&
        parsed.pathname.startsWith("/api/overview/")
        ? {
            url,
            headers: {
              "X-Tracktool-Token":
                document.querySelector<HTMLMetaElement>(
                  'meta[name="tracktool-token"]',
                )?.content ?? "",
            },
          }
        : { url };
    });
    map.on("style.load", this.restore);
    map.on("idle", this.idle);
    map.on("sourcedata", this.loaded);
    map.on("dataloading", this.loading);
    map.on("click", this.click);
    map.on("mousemove", this.hover);
  }
  handlesError(event: { sourceId?: string }) {
    if (!event.sourceId?.startsWith("overview-")) return false;
    this.onLoading(false);
    return true;
  }
  update(
    status: OverviewStatus | undefined,
    selected: string,
    hidden: boolean,
    visibility?: OverviewVisibility,
    analysisSelected = false,
  ) {
    this.selected = selected;
    this.analysisSelected = analysisSelected;
    this.hidden = hidden;
    this.visibility = visibility;
    if (status?.crs === this.crs) this.status = status;
    if (this.map.isStyleLoaded()) this.install();
    this.paint();
  }
  setScale(scale: number) {
    if (scale === this.scale) return;
    this.scale = scale;
    this.paint();
  }
  retry() {
    this.remove(this.pending);
    this.pending = undefined;
    if (this.map.isStyleLoaded()) this.install(true);
  }
  get hasErrors() {
    return [this.current, this.pending].some(
      (id) => !!id && this.resourceErrors(id),
    );
  }
  private restore = () => {
    for (const id of Object.keys(this.map.getStyle().sources))
      if (id.startsWith("overview-")) this.remove(id);
    this.current = this.pending = undefined;
    this.install();
  };
  private install(force = false) {
    const s = this.status;
    if (!s?.version || !s.tiles || this.hidden) return;
    const prefix = `overview-${s.version}`;
    if (
      !force &&
      (this.current?.startsWith(prefix) || this.pending?.startsWith(prefix))
    )
      return;
    this.remove(this.pending);
    const id = `${prefix}-${++this.serial}`;
    this.pending = id;
    this.map.addSource(id, {
      type: "vector",
      tiles: [
        new URL(s.tiles, location.href).href
          .replace(/%7B/g, "{")
          .replace(/%7D/g, "}"),
      ],
      minzoom: 0,
      maxzoom: s.maxZoom,
      promoteId: "trackId",
    });
    this.map.addLayer(
      {
        id: `${id}-line`,
        type: "line",
        source: id,
        "source-layer": "tracks",
        filter: [
          "all",
          ["==", ["get", "role"], "line"],
          ["==", ["get", "trackId"], ""],
        ],
        paint: {
          "line-color": "#ce4b26",
          "line-width": 2.5,
          "line-opacity": 0.9,
        },
      },
      this.map.getLayer("track-halo") ? "track-halo" : undefined,
    );
    this.map.addLayer(
      {
        id: `${id}-point`,
        type: "circle",
        source: id,
        "source-layer": "tracks",
        filter: [
          "all",
          ["==", ["get", "role"], "point"],
          ["==", ["get", "trackId"], ""],
        ],
        paint: {
          "circle-color": "#ce4b26",
          "circle-radius": 3,
          "circle-opacity": 1,
          "circle-stroke-width": 0,
        },
      },
      this.map.getLayer("track-halo") ? "track-halo" : undefined,
    );
    this.onLoading(true);
  }
  private idle = () => this.install();
  private loading = (event: { sourceId?: string }) => {
    if (event.sourceId === this.current || event.sourceId === this.pending)
      this.onLoading(true);
  };
  private loaded = (event: { sourceId: string; isSourceLoaded?: boolean }) => {
    if (!event.isSourceLoaded || this.resourceErrors(event.sourceId)) return;
    if (event.sourceId === this.pending) {
      const old = this.current;
      this.current = this.pending;
      this.pending = undefined;
      this.remove(old);
      this.paint();
      this.onVersion(this.current!.slice(9, 41));
    }
    if (event.sourceId === this.current) this.onLoading(false);
  };
  private paint() {
    const id = this.current;
    if (!id || !this.map.getLayer(`${id}-line`)) return;
    for (const role of ["line", "point"]) {
      const filter: ExpressionSpecification = ["==", ["get", "role"], role];
      const visibility = this.visibility;
      const ids = Object.keys(visibility?.exceptions ?? {});
      const member: ExpressionSpecification = [
        "in",
        ["get", "trackId"],
        ["literal", ids],
      ];
      this.map.setFilter(
        `${id}-${role}`,
        !visibility || (visibility.all && !ids.length)
          ? filter
          : ["all", filter, visibility.all ? ["!", member] : member],
      );
    }
    const selected: ExpressionSpecification = [
      "==",
      ["get", "trackId"],
      this.selected,
    ];
    this.map.setPaintProperty(
      `${id}-line`,
      "line-color",
      this.analysisSelected
        ? ["case", selected, "#94a3b8", categoryPaint("color")]
        : categoryPaint("color"),
    );
    this.map.setPaintProperty(`${id}-line`, "line-width", [
      "case",
      selected,
      5 / this.scale,
      2.5 / this.scale,
    ]);
    this.map.setPaintProperty(
      `${id}-line`,
      "line-opacity",
      this.hidden ? 0 : ["case", selected, 1, categoryPaint("opacity")],
    );
    this.map.setPaintProperty(
      `${id}-point`,
      "circle-color",
      this.analysisSelected
        ? ["case", selected, "#94a3b8", categoryPaint("color")]
        : categoryPaint("color"),
    );
    this.map.setPaintProperty(`${id}-point`, "circle-radius", [
      "case",
      selected,
      6 / this.scale,
      3 / this.scale,
    ]);
    this.map.setPaintProperty(
      `${id}-point`,
      "circle-opacity",
      this.hidden ? 0 : ["case", selected, 1, categoryPaint("opacity")],
    );
  }
  private hits(event: MapMouseEvent) {
    if (
      !this.current ||
      this.hidden ||
      !this.map.getLayer(`${this.current}-line`)
    )
      return [];
    const { x, y } = event.point;
    const radius = 8 / this.scale;
    const features = this.map.queryRenderedFeatures(
      [
        [x - radius, y - radius],
        [x + radius, y + radius],
      ],
      { layers: [`${this.current}-line`, `${this.current}-point`] },
    );
    return [
      ...new Map(
        features.map((f) => [
          String(f.properties.trackId),
          {
            id: String(f.properties.trackId),
            segment: String(f.properties.segmentId),
          },
        ]),
      ).values(),
    ];
  }
  private click = (event: MapMouseEvent) => this.onPick(this.hits(event));
  private hover = (event: MapMouseEvent) => {
    this.hoverEvent = event;
    if (this.hoverTimer !== undefined) return;
    // queryRenderedFeatures is comparatively expensive; cap it at 20 Hz
    // instead of running for every mousemove event.
    this.hoverTimer = window.setTimeout(() => {
      this.hoverTimer = undefined;
      const pending = this.hoverEvent;
      if (!pending) return;
      const canvas = this.map.getCanvas();
      const cursor = this.hits(pending).length ? "pointer" : "";
      if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
    }, 50);
  };
  private remove(id?: string) {
    if (!id) return;
    for (const kind of ["line", "point"])
      if (this.map.getLayer(`${id}-${kind}`))
        this.map.removeLayer(`${id}-${kind}`);
    if (this.map.getSource(id)) this.map.removeSource(id);
  }
  destroy() {
    if (this.hoverTimer !== undefined) window.clearTimeout(this.hoverTimer);
    this.map.off("style.load", this.restore);
    this.map.off("idle", this.idle);
    this.map.off("sourcedata", this.loaded);
    this.map.off("dataloading", this.loading);
    this.map.off("click", this.click);
    this.map.off("mousemove", this.hover);
  }
}
