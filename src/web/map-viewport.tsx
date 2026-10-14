import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { OverviewLayer, type OverviewHit } from "./overview-layer.js";
import type { OverviewStatus } from "../shared/overview.js";
import { MapCanvas } from "../drawing/core.js";
import type { Project } from "../shared/project.js";
import type { MapConfig, CityLabel, SelectedTrack } from "../shared/map.js";
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
  hideOverview?: boolean;
  onOverviewPick?: (hits: OverviewHit[]) => void;
  onOverviewLoading?: (loading: boolean) => void;
  onOverviewVersion?: (version: string) => void;
  onOverviewError?: (message: string) => void;
  onCamera: (camera: Project["camera"]) => void;
  onError: (message: string) => void;
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
    const transition = useRef<Transition | undefined>(undefined);
    const layers = useRef(new Map<MapCanvas, OverviewLayer>());
    latest.current = props;
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
        );
    const destroy = (map?: MapCanvas) => {
      if (!map) return;
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
          if (current.current === map) latest.current.onError(message);
        },
        (event) => {
          if (!layer.current?.handlesError(event)) return false;
          if (current.current === map)
            latest.current.onOverviewError?.(event.error.message);
          return true;
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
      );
      layers.current.set(map, layer.current);
      updateOverview(map, overview);
      map.setTracks(latest.current.tracks);
      return map;
    };
    useEffect(() => {
      const map = create(latest.current.state);
      current.current = map;
      window.renderer = map;
      layout();
      void map
        .ready()
        .then(() => {
          if (!map.destroyed) stage.current!.dataset.status = "ready";
        })
        .catch((e: unknown) => {
          if (!map.destroyed)
            latest.current.onError(e instanceof Error ? e.message : String(e));
        });
      const observer = new ResizeObserver(layout);
      observer.observe(stage.current!);
      return () => {
        observer.disconnect();
        cancel();
        destroy(map);
        destroy(current.current);
        holder.current?.replaceChildren();
        current.current = undefined;
        delete window.renderer;
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
      current.current?.setTracks(props.tracks);
      if (!transition.current) candidate.current?.setTracks(props.tracks);
    }, [props.tracks]);
    useEffect(() => {
      if (current.current) updateOverview(current.current);
      if (candidate.current) updateOverview(candidate.current);
    }, [props.overview, props.overviewSelected, props.hideOverview]);
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
      fit: (tracks) => current.current?.fit(tracks),
      cancel,
      ready: async () => current.current?.ready(),
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
      </div>
    );
  },
);
