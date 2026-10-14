import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { MapCanvas } from "../drawing/core.js";
import type { Project } from "../shared/project.js";
import type { MapConfig, CityLabel, SelectedTrack } from "../shared/map.js";
export interface Viewport {
  fit(tracks?: SelectedTrack[]): void;
  stage(state: Project): Promise<boolean>;
  cancel(): void;
  ready(): Promise<unknown>;
}
type Props = {
  state: Project;
  config: MapConfig;
  cities: CityLabel[];
  tracks: SelectedTrack[];
  preview: boolean;
  onCamera: (camera: Project["camera"]) => void;
  onError: (message: string) => void;
};
export const MapViewport = forwardRef<Viewport, Props>(
  function MapViewport(props, ref) {
    const stage = useRef<HTMLDivElement>(null),
      holder = useRef<HTMLDivElement>(null),
      current = useRef<MapCanvas | undefined>(undefined),
      candidate = useRef<MapCanvas | undefined>(undefined),
      serial = useRef(0),
      latest = useRef(props);
    latest.current = props;
    const layout = () => {
      if (!stage.current || !holder.current) return;
      const { width, height } = stage.current.getBoundingClientRect();
      for (const map of [current.current, candidate.current]) {
        if (!map) continue;
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
        if (map === current.current) {
          holder.current.style.width = `${frame.width * scale}px`;
          holder.current.style.height = `${frame.height * scale}px`;
        }
        map.setExportPreview(latest.current.preview);
        map.setSurround(
          latest.current.preview ? frame.width : width / scale,
          latest.current.preview ? frame.height : height / scale,
          scale,
        );
      }
    };
    const cancel = () => {
      serial.current++;
      candidate.current?.destroy();
      candidate.current?.frame.remove();
      candidate.current = undefined;
    };
    const create = (state: Project, staging = false) => {
      const frame = document.createElement("div");
      frame.className = `map-frame${staging ? " staging" : ""}`;
      holder.current!.append(frame);
      const map = new MapCanvas(
        frame,
        structuredClone(state),
        latest.current.config,
        latest.current.cities,
        (camera) => {
          if (current.current === map) {
            candidate.current?.setCamera(camera);
            latest.current.onCamera(camera);
          }
        },
        (message) => {
          if (current.current === map) latest.current.onError(message);
        },
      );
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
        map.destroy();
        current.current?.destroy();
        holder.current?.replaceChildren();
        current.current = undefined;
        delete window.renderer;
      };
    }, [props.config, props.cities]); // Stable bootstrap resources own the renderer lifetime.
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
    }, [props.state, props.preview]);
    useEffect(() => {
      current.current?.setTracks(props.tracks);
      candidate.current?.setTracks(props.tracks);
    }, [props.tracks]);
    useImperativeHandle(ref, () => ({
      fit: (tracks) => current.current?.fit(tracks),
      cancel,
      ready: async () => current.current?.ready(),
      stage: async (state) => {
        cancel();
        const sequence = serial.current;
        const next = create(state, true);
        candidate.current = next;
        layout();
        try {
          await next.ready();
          if (sequence !== serial.current || next.destroyed) return false;
          const old = current.current;
          current.current = next;
          candidate.current = undefined;
          next.frame.classList.remove("staging");
          old?.destroy();
          old?.frame.remove();
          window.renderer = next;
          layout();
          return true;
        } catch (error) {
          if (sequence !== serial.current) return false;
          next.destroy();
          next.frame.remove();
          candidate.current = undefined;
          throw error;
        }
      },
    }));
    return (
      <div className="map-stage" ref={stage} aria-label="地图预览">
        <div className="frame-holder" ref={holder} />
      </div>
    );
  },
);
