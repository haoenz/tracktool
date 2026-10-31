import { AnalysisLayer } from "./analysis-layer.js";
import type { AnalysisOverlay } from "./track-insights.js";
import type { PaddingOptions } from "maplibre-gl";
import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  OverviewLayer,
  type OverviewHit,
  type OverviewVisibility,
} from "./overview-layer.js";
import type { OverviewStatus } from "../shared/overview.js";
import type { AnalysisSample } from "../shared/track-analysis.js";
import { MapCanvas } from "../drawing/core.js";
import { compositionPadding } from "../drawing/viewport.js";
import { trackColor } from "../drawing/track-style.js";
import type { MapState } from "../shared/map-state.js";
import type { MapConfig, SelectedTrack } from "../shared/map.js";
import { displayCoordinate } from "../shared/coordinates.js";
import { MapLocationButton } from "./map-location-button.js";
export interface Viewport {
  fit(tracks?: SelectedTrack[]): void;
  stage(state: MapState, overview?: OverviewStatus): Promise<boolean>;
  fitOverview(bounds: [number, number, number, number]): void;
  retryOverview(): void;
  setAnalysisSample(sample?: AnalysisSample): void;
  cancel(): void;
  ready(): Promise<unknown>;
}
type Props = {
  state: MapState;
  config: MapConfig;
  tracks: SelectedTrack[];
  print?: boolean;
  cameraLocked?: boolean;
  guides?: boolean;
  geolocation?: boolean;
  overview?: OverviewStatus;
  overviewSelected?: string;
  overviewVisibility?: OverviewVisibility;
  hideOverview?: boolean;
  onOverviewPick?: (hits: OverviewHit[]) => void;
  onOverviewLoading?: (loading: boolean) => void;
  onOverviewVersion?: (version: string) => void;
  onOverviewError?: (message: string) => void;
  onCamera: (camera: MapState["camera"]) => void;
  onError: (message: string) => void;
  onInitialized?: () => void;
  onPointPick?: (position: [number, number]) => void;
  exposeRenderer?: boolean;
  highlightSegment?: string;
  highlightEntry?: string;
  analysisOverlay?: AnalysisOverlay;
};
export const MapViewport = memo(
  forwardRef<Viewport, Props>(function MapViewport(props, ref) {
    const stage = useRef<HTMLDivElement>(null),
      holder = useRef<HTMLDivElement>(null),
      credit = useRef<HTMLDivElement>(null),
      locationControl = useRef<HTMLDivElement>(null),
      locationMarker = useRef<HTMLDivElement>(null),
      location = useRef<[number, number] | undefined>(undefined),
      current = useRef<MapCanvas | undefined>(undefined),
      candidate = useRef<MapCanvas | undefined>(undefined),
      serial = useRef(0),
      latest = useRef(props);
    const [resourceError, setResourceError] = useState("");
    const layers = useRef(new Map<MapCanvas, OverviewLayer>());
    const analysisLayers = useRef(new Map<MapCanvas, AnalysisLayer>());
    latest.current = props;
    const updateLocation = () => {
      const marker = locationMarker.current;
      const map = current.current;
      if (!marker) return;
      if (!map || !location.current || !stage.current) {
        marker.hidden = true;
        return;
      }
      const coordinate = displayCoordinate(location.current, map.crs);
      coordinate[0] +=
        360 * Math.round((map.map.getCenter().lng - coordinate[0]) / 360);
      const point = map.map.project(coordinate);
      const canvas = map.mapElement.getBoundingClientRect();
      const bounds = stage.current.getBoundingClientRect();
      const scale = canvas.width / map.mapElement.clientWidth;
      const x = canvas.left - bounds.left + point.x * scale;
      const y = canvas.top - bounds.top + point.y * scale;
      marker.hidden = x < 0 || y < 0 || x > bounds.width || y > bounds.height;
      // Canvas focus can scroll the clipped stage. Absolute positioning uses
      // its content coordinates, while projection above uses screen pixels.
      marker.style.transform = `translate(${x + stage.current.scrollLeft}px, ${y + stage.current.scrollTop}px) translate(-50%, -50%)`;
    };
    const highlight = (map: MapCanvas) => {
      const selected = latest.current.highlightSegment;
      const entry = latest.current.highlightEntry;
      for (const [layer, property] of [
        ["track-lines", "line-color"],
        ["track-points", "circle-color"],
      ]) {
        if (map.map.getLayer(layer!)) {
          const color: unknown[] = [
            "case",
            ["==", ["get", "segment_id"], "ux-delete"],
            "#dc2626",
            ["==", ["get", "segment_id"], "ux-add"],
            "#16a34a",
            ["==", ["get", "segment_id"], "ux-break"],
            "#ea580c",
            ["==", ["get", "segment_id"], "ux-located"],
            "#e11d48",
            ["has", "edit_color"],
            ["get", "edit_color"],
          ];
          if (selected !== undefined)
            color.push(
              entry === undefined
                ? ["==", ["get", "segment_id"], selected]
                : [
                    "all",
                    ["==", ["get", "segment_id"], selected],
                    ["==", ["get", "project_entry"], entry],
                  ],
              "#1677ff",
            );
          else if (entry !== undefined)
            color.push(["==", ["get", "project_entry"], entry], "#1677ff");
          color.push(
            selected !== undefined || entry !== undefined
              ? "#64748b"
              : trackColor(latest.current.state.style),
          );
          map.map.setPaintProperty(layer!, property!, color);
        }
      }
      if (map.map.getLayer("track-points")) {
        map.map.setPaintProperty("track-points", "circle-radius", [
          "case",
          ["==", ["get", "segment_id"], "ux-located"],
          7 * map.displayScale,
          (latest.current.state.style.width / 2) * map.displayScale,
        ]);
        map.map.setPaintProperty("track-points", "circle-stroke-width", [
          "case",
          ["==", ["get", "segment_id"], "ux-located"],
          2 * map.displayScale,
          latest.current.state.style.outline === false ? 0 : map.displayScale,
        ]);
      }
    };
    const updateOverview = (map: MapCanvas, status = latest.current.overview) =>
      layers.current
        .get(map)
        ?.update(
          status,
          latest.current.overviewSelected ?? "",
          latest.current.hideOverview ?? true,
          latest.current.overviewVisibility,
          !!latest.current.analysisOverlay &&
            latest.current.analysisOverlay.metric !== "original",
        );
    const destroy = (map?: MapCanvas) => {
      if (!map) return;
      analysisLayers.current.get(map)?.destroy();
      analysisLayers.current.delete(map);
      layers.current.get(map)?.destroy();
      layers.current.delete(map);
      map.destroy();
    };
    const layout = () => {
      if (!stage.current || !holder.current) return;
      const bounds = stage.current.getBoundingClientRect();
      const { width, height } = bounds;
      const mobile = width <= 700;
      const panel = document.getElementById("map-panel");
      if (locationControl.current) {
        const panelTop =
          mobile && panel && panel.offsetParent !== null
            ? panel.getBoundingClientRect().top
            : bounds.bottom;
        locationControl.current.style.bottom = `${Math.max(32, bounds.bottom - panelTop + 8)}px`;
        locationControl.current.hidden = panelTop - bounds.top < 120;
      }
      const rect =
        latest.current.print && panel?.offsetParent !== null
          ? panel?.getBoundingClientRect()
          : undefined;
      // Reserve the same space in browse mode, so entering print or changing
      // aspect ratio never scales the underlying map. All ratios fit a square.
      const left = mobile ? 0 : Math.min(width - 40, 396);
      const top = mobile ? 80 : 0;
      const bottom = mobile ? height * 0.48 + 24 : 0;
      const scale = Math.max(
        0.05,
        Math.min(
          (width - left - 40) / 960,
          (height - top - bottom - 40) / 960,
          1,
        ),
      );
      const shiftX =
        latest.current.print && !mobile
          ? ((rect?.right ?? left) - bounds.left) / 2
          : 0;
      const shiftY =
        latest.current.print && mobile
          ? (top + (rect ? rect.top - bounds.top : height - bottom) - height) /
            2
          : 0;
      // Browsing sizes are screen pixels; print previews retain document pixels.
      const displayScale = latest.current.print
        ? 1
        : (mobile ? 1.2 : 1) / scale;
      for (const map of [current.current, candidate.current]) {
        if (!map) continue;
        const { frame } = map.state;
        // Layout zoom keeps the oversized map in the browser's layout bounds.
        // A transformed export frame can clip its overflowing canvas on mobile.
        map.frame.style.zoom = mobile ? String(scale) : "";
        map.frame.style.transform = mobile ? "" : `scale(${scale})`;
        map.setDisplayScale(displayScale, latest.current.print ? 1 : scale);
        layers.current.get(map)?.setScale(scale, displayScale);
        analysisLayers.current.get(map)?.setScale(scale);
        if (map === current.current) {
          holder.current.style.width = `${frame.width * scale}px`;
          holder.current.style.height = `${frame.height * scale}px`;
        }
        if (map === current.current) {
          // The export keeps the credit inside the frame; the composition
          // preview shows the same strip so the frame matches the output.
          const parent = latest.current.print ? map.frame : credit.current;
          if (parent && map.credit.parentElement !== parent)
            parent.append(map.credit);
        }
        map.setPrintPreview(!!latest.current.print);
        map.setExportPreview(false);
        // The map stays full screen, so the surroundings grow to cover the
        // shift and the camera keeps pointing at the frame center.
        if (map === current.current && holder.current)
          holder.current.style.transform = `translate(${shiftX}px, ${shiftY}px)`;
        map.setSurround(
          (width + left + 2) / scale,
          (height + (mobile ? bottom : 0) + 2) / scale,
          scale,
        );
        const locked = !!latest.current.cameraLocked;
        for (const handler of [
          map.map.dragPan,
          map.map.scrollZoom,
          map.map.boxZoom,
          map.map.doubleClickZoom,
          map.map.keyboard,
          map.map.touchZoomRotate,
        ]) {
          if (locked) handler.disable();
          else handler.enable();
        }
        map.map.touchZoomRotate.disableRotation();
        highlight(map);
      }
      updateLocation();
    };
    const cancel = () => {
      serial.current++;
      destroy(candidate.current);
      candidate.current?.frame.remove();
      candidate.current = undefined;
    };
    const create = (
      state: MapState,
      staging = false,
      overview?: OverviewStatus,
    ) => {
      const frame = document.createElement("div");
      frame.className = `map-frame${staging ? " staging" : ""}`;
      holder.current!.append(frame);
      const layer: { current?: OverviewLayer } = {};
      const map = new MapCanvas(
        frame,
        structuredClone(state),
        latest.current.config,
        (camera) => {
          if (current.current === map) {
            candidate.current?.setCamera(camera);
            latest.current.onCamera(camera);
          }
        },
        (message) => {
          if (current.current === map) setResourceError(message);
        },
        (event) => {
          if (!layer.current?.handlesError(event)) return false;
          return true;
        },
        (message) => {
          if (current.current === map)
            latest.current.onOverviewError?.(message);
        },
      );
      map.map.on("style.load", () => highlight(map));
      map.map.on("render", () => {
        if (current.current === map) updateLocation();
      });
      layer.current = new OverviewLayer(
        map.map,
        map.crs,
        (hits) => {
          if (current.current === map) latest.current.onOverviewPick?.(hits);
        },
        (loading) => {
          if (current.current === map)
            latest.current.onOverviewLoading?.(loading);
        },
        (version) => {
          if (current.current === map)
            latest.current.onOverviewVersion?.(version);
        },
        (id) => map.resources.errors(id).length > 0,
      );
      layers.current.set(map, layer.current);
      const analysis = new AnalysisLayer(map.map, map.crs);
      analysisLayers.current.set(map, analysis);
      analysis.update(latest.current.analysisOverlay);
      map.map.on("click", (event) => {
        if (current.current !== map || !latest.current.onPointPick) return;
        const point = displayCoordinate(
          [event.lngLat.lng, event.lngLat.lat],
          map.crs,
          true,
        );
        latest.current.onPointPick([
          ((((point[0] + 180) % 360) + 360) % 360) - 180,
          point[1],
        ]);
      });
      updateOverview(map, overview);
      map.setTracks(latest.current.tracks);
      return map;
    };
    useEffect(() => {
      const map = create(latest.current.state);
      current.current = map;
      if (latest.current.exposeRenderer !== false) window.renderer = map;
      const initialized = () => {
        if (!map.destroyed && current.current === map)
          latest.current.onInitialized?.();
      };
      // The first paint covers the fixed export frame with the full viewport.
      // Waiting for idle here would block the workspace on slow tile requests.
      map.map.once("render", initialized);
      layout();
      void map
        .ready(undefined, false)
        .then(() => {
          if (!map.destroyed) {
            highlight(map);
            stage.current!.dataset.status = "ready";
          }
        })
        .catch((e: unknown) => {
          if (!map.destroyed) {
            setResourceError("地图加载未完成，请重试");
            initialized();
          }
          console.warn("[地图初始化]", e);
        });
      const online = () => {
        const active = current.current;
        if (
          active &&
          (active.errors.length || layers.current.get(active)?.hasErrors)
        )
          active.retryResources();
      };
      window.addEventListener("online", online);
      const observer = new ResizeObserver(layout);
      observer.observe(stage.current!);
      const panel = document.getElementById("map-panel");
      if (panel) observer.observe(panel);
      return () => {
        map.map.off("render", initialized);
        window.removeEventListener("online", online);
        observer.disconnect();
        cancel();
        destroy(map);
        destroy(current.current);
        holder.current?.replaceChildren();
        current.current = undefined;
        if (latest.current.exposeRenderer !== false) delete window.renderer;
      };
    }, [props.config]); // Stable bootstrap resources own the renderer lifetime.
    useEffect(() => {
      current.current?.apply(structuredClone(props.state));
      current.current?.setCamera(props.state.camera);
      if (candidate.current) {
        const next = structuredClone(props.state);
        next.style = candidate.current.state.style;
        candidate.current.apply(next);
        candidate.current.setCamera(props.state.camera);
      }
      layout();
    }, [props.state]);
    useEffect(layout, [props.cameraLocked, props.print]);
    useEffect(() => {
      if (current.current) highlight(current.current);
    }, [props.state, props.highlightSegment, props.highlightEntry]);
    useEffect(() => {
      current.current?.setTracks(props.tracks);
      if (current.current) highlight(current.current);
      candidate.current?.setTracks(props.tracks);
    }, [props.tracks]);
    useEffect(() => {
      if (current.current) updateOverview(current.current);
      if (candidate.current) updateOverview(candidate.current);
    }, [
      props.overview,
      props.overviewSelected,
      props.hideOverview,
      props.overviewVisibility,
      props.analysisOverlay?.metric,
    ]);
    useEffect(() => {
      for (const layer of analysisLayers.current.values())
        layer.update(props.analysisOverlay);
    }, [props.analysisOverlay]);
    const fitPadding = (
      map: MapCanvas,
    ): Required<PaddingOptions> | undefined => {
      if (latest.current.print)
        return compositionPadding(
          map.surround,
          !!map.state.title,
          map.credit.offsetHeight,
        );
      const bounds = stage.current?.getBoundingClientRect();
      const canvas = map.mapElement.getBoundingClientRect();
      const scale = canvas.width / map.mapElement.clientWidth;
      if (!bounds || !scale || bounds.width <= 0 || bounds.height <= 0) return;
      const margin = Math.min(16, bounds.width / 4, bounds.height / 4);
      let left = bounds.left + margin;
      const right = bounds.right - margin;
      const top = bounds.top + margin;
      let bottom = bounds.bottom - margin;
      const panel = document.getElementById("map-panel");
      if (panel && panel.offsetParent !== null) {
        const rect = panel.getBoundingClientRect();
        if (bounds.width <= 700) {
          if (rect.top - margin > top + 32) bottom = rect.top - margin;
        } else if (rect.right + margin < right - 32) {
          left = rect.right + margin;
        }
      }
      // MapLibre fits the oversized logical canvas. Convert the visible,
      // unobscured screen rectangle back into that canvas's coordinate space.
      return {
        left: Math.max(0, (left - canvas.left) / scale),
        right: Math.max(0, (canvas.right - right) / scale),
        top: Math.max(0, (top - canvas.top) / scale),
        bottom: Math.max(0, (canvas.bottom - bottom) / scale),
      };
    };
    useImperativeHandle(ref, () => ({
      retryOverview: () => {
        if (current.current) layers.current.get(current.current)?.retry();
      },
      // Chart hover updates the analysis layer imperatively: keeping the
      // sample in page state re-rendered the whole workspace per pointer move.
      setAnalysisSample: (sample) => {
        const overlay = latest.current.analysisOverlay;
        if (!overlay) return;
        for (const layer of analysisLayers.current.values())
          layer.update({ ...overlay, sample });
      },
      fitOverview: ([west, south, east, north]) => {
        const map = current.current;
        if (!map) return;
        const padding = fitPadding(map);
        if (!padding) return;
        map.map.fitBounds(
          [
            [west, south],
            [east, north],
          ],
          { padding, maxZoom: 15, duration: 0 },
        );
      },
      fit: (tracks) => {
        const map = current.current;
        if (!map) return;
        const padding = fitPadding(map);
        if (padding) map.fit(tracks, padding);
      },
      cancel,
      ready: async () => {
        const map = current.current;
        if (map?.errors.length) map.retryResources();
        return map?.ready();
      },
      stage: async (state, overview) => {
        cancel();
        const sequence = serial.current;
        const next = create(state, true, overview);
        candidate.current = next;
        updateOverview(next, overview);
        layout();
        try {
          await next.ready();
          if (layers.current.get(next)?.hasErrors)
            throw new Error("新底图的轨迹概览加载失败，请重试");
          if (sequence !== serial.current || next.destroyed) return false;
          const old = current.current;
          current.current = next;
          candidate.current = undefined;
          next.frame.classList.remove("staging");
          setResourceError("");
          destroy(old);
          old?.frame.remove();
          window.renderer = next;
          layout();
          if (overview?.version)
            latest.current.onOverviewVersion?.(overview.version);
          return true;
        } catch (error) {
          if (sequence !== serial.current) return false;
          destroy(next);
          next.frame.remove();
          candidate.current = undefined;
          throw error;
        }
      },
    }));
    return (
      <div
        className={`map-stage${props.print ? " print" : ""}`}
        ref={stage}
        onScroll={updateLocation}
        data-locked={props.cameraLocked || undefined}
        aria-label="地图预览"
      >
        <div
          className="frame-holder"
          data-guides={props.guides || undefined}
          ref={holder}
        />
        <div className="viewport-credit" ref={credit} />
        {props.geolocation && !props.print && (
          <div
            ref={locationMarker}
            className="map-location-marker"
            role="img"
            aria-label="定位位置"
            title="最近一次 GPS 定位的位置"
            hidden
          />
        )}
        {props.geolocation && !props.print && (
          <div className="map-location-control" ref={locationControl}>
            <MapLocationButton
              disabled={!!props.cameraLocked}
              onLocate={(position) => {
                const map = current.current;
                if (!map || latest.current.cameraLocked) return;
                location.current = position;
                updateLocation();
                const center = displayCoordinate(position, map.crs);
                const scale =
                  map.mapElement.getBoundingClientRect().width /
                  map.mapElement.clientWidth;
                map.map.fitBounds([center, center], {
                  padding: fitPadding(map),
                  maxZoom: Math.min(20, 15 - Math.log2(scale || 1)),
                  duration: 0,
                });
              }}
            />
          </div>
        )}
        {resourceError && (
          <div className="map-resource-error" role="alert">
            {resourceError}
            <button
              type="button"
              onClick={() => current.current?.retryResources()}
            >
              重试地图
            </button>
          </div>
        )}
      </div>
    );
  }),
);
MapViewport.displayName = "MapViewport";
