import { AnalysisLayer } from "./analysis-layer.js";
import type { AnalysisOverlay } from "./track-insights.js";
import {
  forwardRef,
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
import { MapCanvas } from "../drawing/core.js";
import type { Project } from "../shared/project.js";
import type { MapConfig, CityLabel, SelectedTrack } from "../shared/map.js";
import { displayCoordinate } from "../shared/coordinates.js";
type Transition = {
  tracks: SelectedTrack[];
  preview: boolean;
  hideOverview: boolean;
};
export interface Viewport {
  fit(tracks?: SelectedTrack[]): void;
  stage(
    state: Project,
    overview?: OverviewStatus,
    transition?: Transition,
  ): Promise<boolean>;
  fitOverview(bounds: [number, number, number, number]): void;
  retryOverview(): void;
  cancel(): void;
  ready(): Promise<unknown>;
}
type Props = {
  state: Project;
  config: MapConfig;
  cities: CityLabel[];
  tracks: SelectedTrack[];
  preview: boolean;
  overview?: OverviewStatus;
  overviewSelected?: string;
  overviewVisibility?: OverviewVisibility;
  hideOverview?: boolean;
  onOverviewPick?: (hits: OverviewHit[]) => void;
  onOverviewLoading?: (loading: boolean) => void;
  onOverviewVersion?: (version: string) => void;
  onOverviewError?: (message: string) => void;
  onCamera: (camera: Project["camera"]) => void;
  onError: (message: string) => void;
  onPointPick?: (position: [number, number]) => void;
  exposeRenderer?: boolean;
  highlightSegment?: string;
  analysisOverlay?: AnalysisOverlay;
};
export const MapViewport = forwardRef<Viewport, Props>(
  function MapViewport(props, ref) {
    const stage = useRef<HTMLDivElement>(null),
      holder = useRef<HTMLDivElement>(null),
      credit = useRef<HTMLDivElement>(null),
      current = useRef<MapCanvas | undefined>(undefined),
      candidate = useRef<MapCanvas | undefined>(undefined),
      serial = useRef(0),
      latest = useRef(props);
    const [resourceError, setResourceError] = useState("");
    const transition = useRef<Transition | undefined>(undefined);
    const layers = useRef(new Map<MapCanvas, OverviewLayer>());
    const analysisLayers = useRef(new Map<MapCanvas, AnalysisLayer>());
    latest.current = props;
    const highlight = (map: MapCanvas) => {
      if (latest.current.highlightSegment === undefined) return;
      for (const [layer, property] of [
        ["track-lines", "line-color"],
        ["track-points", "circle-color"],
      ]) {
        if (map.map.getLayer(layer!))
          map.map.setPaintProperty(layer!, property!, [
            "case",
            ["==", ["get", "segment_id"], "ux-delete"],
            "#dc2626",
            ["==", ["get", "segment_id"], "ux-add"],
            "#16a34a",
            ["==", ["get", "segment_id"], "ux-break"],
            "#ea580c",
            ["has", "edit_color"],
            ["get", "edit_color"],
            ["==", ["get", "segment_id"], latest.current.highlightSegment],
            "#1677ff",
            "#64748b",
          ]);
      }
    };
    const updateOverview = (map: MapCanvas, status = latest.current.overview) =>
      layers.current
        .get(map)
        ?.update(
          status,
          latest.current.overviewSelected ?? "",
          (map === candidate.current
            ? transition.current?.hideOverview
            : undefined) ??
            latest.current.hideOverview ??
            true,
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
      const { width, height } = stage.current.getBoundingClientRect();
      for (const map of [current.current, candidate.current]) {
        if (!map) continue;
        const preview =
          (map === candidate.current
            ? transition.current?.preview
            : undefined) ?? latest.current.preview;
        const { frame } = map.state,
          scale = Math.max(
            0.1,
            Math.min(
              (width - 40) / frame.width,
              (height - 70) / frame.height,
              1,
            ),
          );
        map.frame.style.transform = `scale(${scale})`;
        layers.current.get(map)?.setScale(scale);
        analysisLayers.current.get(map)?.setScale(scale);
        if (map === current.current) {
          holder.current.style.width = `${frame.width * scale}px`;
          holder.current.style.height = `${frame.height * scale}px`;
        }
        if (map === current.current && credit.current) {
          const parent = preview ? map.frame : credit.current;
          if (map.credit.parentElement !== parent) parent.append(map.credit);
        }
        map.setExportPreview(preview);
        map.setSurround(
          preview ? frame.width : width / scale,
          preview ? frame.height : height / scale,
          scale,
        );
      }
    };
    const cancel = () => {
      serial.current++;
      destroy(candidate.current);
      candidate.current?.frame.remove();
      candidate.current = undefined;
      transition.current = undefined;
    };
    const create = (
      state: Project,
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
        latest.current.cities,
        (camera) => {
          if (current.current === map) {
            if (!transition.current) candidate.current?.setCamera(camera);
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
          if (!map.destroyed) setResourceError("地图加载未完成，请重试");
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
      return () => {
        window.removeEventListener("online", online);
        observer.disconnect();
        cancel();
        destroy(map);
        destroy(current.current);
        holder.current?.replaceChildren();
        current.current = undefined;
        if (latest.current.exposeRenderer !== false) delete window.renderer;
      };
    }, [props.config, props.cities]); // Stable bootstrap resources own the renderer lifetime.
    useEffect(() => {
      current.current?.apply(structuredClone(props.state));
      current.current?.setCamera(props.state.camera);
      if (candidate.current && !transition.current) {
        const next = structuredClone(props.state);
        next.style = candidate.current.state.style;
        candidate.current.apply(next);
        candidate.current.setCamera(props.state.camera);
      }
      layout();
    }, [props.state, props.preview]);
    useEffect(() => {
      if (current.current) highlight(current.current);
    }, [props.state, props.highlightSegment]);
    useEffect(() => {
      current.current?.setTracks(props.tracks);
      if (current.current) highlight(current.current);
      if (!transition.current) candidate.current?.setTracks(props.tracks);
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
    useImperativeHandle(ref, () => ({
      retryOverview: () => {
        if (current.current) layers.current.get(current.current)?.retry();
      },
      fitOverview: ([west, south, east, north]) =>
        current.current?.map.fitBounds(
          [
            [west, south],
            [east, north],
          ],
          { padding: 65, maxZoom: 15, duration: 0 },
        ),
      fit: (tracks) => {
        const map = current.current;
        if (!map) return;
        const panel = document.querySelector<HTMLElement>(
          ".map-controls:not([hidden])",
        );
        const box = panel?.getBoundingClientRect();
        const bounds = stage.current?.getBoundingClientRect();
        const frame = map.frame.getBoundingClientRect();
        const canvas = map.mapElement.getBoundingClientRect();
        const scale = canvas.width / map.mapElement.clientWidth;
        if (!bounds || !scale) return;
        // Fit inside the actual visible canvas, not the smaller export frame's
        // existing surround padding plus an overlapping sheet (which can leave
        // a negative fitting area on phones).
        const area = latest.current.preview ? frame : bounds;
        const mobile = window.innerWidth <= 700;
        const headerBottom = Math.max(
          ...[".map-header", ".project-bar"].map(
            (selector) =>
              document.querySelector(selector)?.getBoundingClientRect()
                .bottom ?? 0,
          ),
        );
        const left =
          Math.max(area.left, !mobile && box ? box.right : area.left) + 16;
        const right = area.right - 16;
        const top =
          Math.max(
            area.top,
            headerBottom,
            latest.current.preview && map.state.title
              ? frame.top + 90 * scale
              : area.top,
          ) + 16;
        const bottom =
          Math.min(area.bottom, mobile && box ? box.top : area.bottom) - 16;
        if (right <= left || bottom <= top) {
          latest.current.onError("地图可见区域太小，请收起面板后再定位。");
          return;
        }
        map.fit(tracks, {
          left: (left - canvas.left) / scale,
          right: (canvas.right - right) / scale,
          top: (top - canvas.top) / scale,
          bottom: (canvas.bottom - bottom) / scale,
        });
      },
      cancel,
      ready: async () => {
        const map = current.current;
        if (map?.errors.length) map.retryResources();
        return map?.ready();
      },
      stage: async (state, overview, options) => {
        cancel();
        transition.current = options;
        const sequence = serial.current;
        const next = create(state, true, overview);
        candidate.current = next;
        if (options) next.setTracks(options.tracks);
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
          transition.current = undefined;
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
          transition.current = undefined;
          throw error;
        }
      },
    }));
    return (
      <div
        className={`map-stage${props.preview ? " export-preview" : " browsing"}`}
        ref={stage}
        aria-label="地图预览"
      >
        <div className="frame-holder" ref={holder} />
        <div className="viewport-credit" ref={credit} />
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
  },
);
