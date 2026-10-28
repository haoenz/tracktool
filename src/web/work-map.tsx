import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Spin } from "./components/controls.js";
import { api } from "./api.js";
import { MapViewport } from "./map-viewport.js";
import type { Viewport } from "./map-viewport.js";
import type { MapState } from "../shared/map-state.js";
import type { MapConfig, SelectedTrack } from "../shared/map.js";
import "./map.css";
import { useTheme } from "./theme.js";
export default function WorkMap({ id }: { id: string }) {
  const bootstrap = useQuery({
      queryKey: ["work-map-bootstrap"],
      queryFn: ({ signal }) =>
        api<{ state: MapState; config: MapConfig }>(
          "/api/bootstrap",
          undefined,
          signal,
        ),
    }),
    geometry = useQuery({
      queryKey: ["work-map", id],
      queryFn: ({ signal }) =>
        api<{ tracks: SelectedTrack[] }>(
          "/api/work/tasks/" + id + "/geometry",
          {},
          signal,
        ),
    });
  const error = bootstrap.error ?? geometry.error;
  if (error) return <Alert type="error" title={error.message} />;
  if (!bootstrap.data || !geometry.data) return <Spin />;
  return (
    <Preview
      state={bootstrap.data.state}
      config={bootstrap.data.config}
      tracks={geometry.data.tracks}
    />
  );
}
function Preview(props: {
  state: MapState;
  config: MapConfig;
  tracks: SelectedTrack[];
}) {
  const { appearance } = useTheme();
  const [state, setState] = useState(() => ({
      ...props.state,
      title: "",
    })),
    [error, setError] = useState("");
  const viewport = useRef<Viewport>(null);
  const themedState = useMemo(
    () => ({ ...state, style: { ...state.style, appearance } }),
    [state, appearance],
  );
  useEffect(() => {
    let active = true;
    void viewport.current
      ?.ready()
      .then(() => {
        if (active) viewport.current?.fit(props.tracks);
      })
      .catch((e) => setError(String(e)));
    return () => {
      active = false;
    };
  }, [props.tracks]);
  return (
    <section aria-label="轨迹结果地图">
      {error && <Alert type="error" title={error} />}
      <Button onClick={() => viewport.current?.fit(props.tracks)}>
        缩放到全部轨迹
      </Button>
      <div className="work-map">
        <MapViewport
          ref={viewport}
          state={themedState}
          config={props.config}
          tracks={props.tracks}
          onCamera={(camera) => setState((old) => ({ ...old, camera }))}
          onError={setError}
        />
      </div>
    </section>
  );
}
