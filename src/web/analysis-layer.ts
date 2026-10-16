import type { Map as LibreMap, GeoJSONSource } from "maplibre-gl";
import type { FeatureCollection, Feature, LineString, Point } from "geojson";
import { displayCoordinate } from "../shared/coordinates.js";
import type { AnalysisOverlay } from "./track-insights.js";

/** Temporary browsing overlays; never installed in the export renderer. */
export class AnalysisLayer {
  private value?: AnalysisOverlay;
  private geometry?: FeatureCollection<LineString>;
  private signature?: string;
  private dirty = true;
  private scale = 1;
  constructor(
    private map: LibreMap,
    private crs: string,
  ) {
    map.on("style.load", this.reset);
    map.on("idle", this.restore);
  }
  setScale(scale: number) {
    this.scale = scale;
    if (this.map.getLayer("analysis-profile"))
      this.map.setPaintProperty("analysis-profile", "line-width", 5 / scale);
    if (this.map.getLayer("analysis-cursor")) {
      this.map.setPaintProperty("analysis-cursor", "circle-radius", 7 / scale);
      this.map.setPaintProperty(
        "analysis-cursor",
        "circle-stroke-width",
        3 / scale,
      );
    }
  }
  update(value?: AnalysisOverlay) {
    const signature = value ? `${value.key}:${value.metric}` : "";
    if (
      signature !== this.signature ||
      value?.analysis !== this.value?.analysis
    ) {
      this.signature = signature;
      this.geometry = { type: "FeatureCollection", features: [] };
      if (value && value.metric !== "original") {
        const metric = value.metric;
        const values = value.analysis.samples.flatMap((p) =>
          p[metric] === null ? [] : [p[metric]!],
        );
        const min = Math.min(...values),
          max = Math.max(...values);
        const features: Feature<LineString>[] = [];
        for (let i = 1; i < value.analysis.samples.length; i++) {
          const a = value.analysis.samples[i - 1]!,
            b = value.analysis.samples[i]!;
          if (a.segment !== b.segment) continue;
          const start = displayCoordinate([a.longitude, a.latitude], this.crs);
          const end = displayCoordinate([b.longitude, b.latitude], this.crs);
          while (end[0] - start[0] > 180) end[0] -= 360;
          while (end[0] - start[0] < -180) end[0] += 360;
          const v =
            metric === "altitude" &&
            (a.altitude === null || b.altitude === null)
              ? null
              : b[metric];
          const ratio =
            v === null ? null : max === min ? 0.5 : (v - min) / (max - min);
          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: [start, end] },
            properties: {
              color:
                ratio === null
                  ? "#94a3b8"
                  : `hsl(${220 - ratio * 190}, 72%, 48%)`,
            },
          });
        }
        this.geometry.features = features;
      }
      this.value = value;
      this.dirty = true;
      this.restore();
    } else {
      this.value = value;
      this.cursor();
    }
  }
  private reset = () => {
    this.dirty = true;
    this.restore();
  };
  private restore = () => {
    if (!this.dirty || !this.map.isStyleLoaded()) return;
    this.dirty = false;
    if (!this.map.getSource("analysis-profile")) {
      this.map.addSource("analysis-profile", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      this.map.addLayer({
        id: "analysis-profile",
        type: "line",
        source: "analysis-profile",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 5 / this.scale },
      });
      this.map.addSource("analysis-cursor", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      this.map.addLayer({
        id: "analysis-cursor",
        type: "circle",
        source: "analysis-cursor",
        paint: {
          "circle-radius": 7 / this.scale,
          "circle-color": "#fff",
          "circle-stroke-color": "#21634f",
          "circle-stroke-width": 3 / this.scale,
        },
      });
    }
    (this.map.getSource("analysis-profile") as GeoJSONSource).setData(
      this.geometry ?? { type: "FeatureCollection", features: [] },
    );
    this.cursor();
  };
  private cursor() {
    const source = this.map.getSource("analysis-cursor") as
      GeoJSONSource | undefined;
    const sample = this.value?.sample;
    const features: Feature<Point>[] = sample
      ? [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "Point",
              coordinates: displayCoordinate(
                [sample.longitude, sample.latitude],
                this.crs,
              ),
            },
          },
        ]
      : [];
    source?.setData({ type: "FeatureCollection", features });
  }
  destroy() {
    this.map.off("style.load", this.reset);
    this.map.off("idle", this.restore);
    for (const id of ["analysis-cursor", "analysis-profile"]) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
      if (this.map.getSource(id)) this.map.removeSource(id);
    }
  }
}
