import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Spin } from "antd";
import { api } from "./api.js";
import { MapViewport } from "./map-viewport.js";
import type { Viewport } from "./map-viewport.js";
import type { Project } from "../shared/project.js";
import type { MapConfig, Cities, SelectedTrack } from "../shared/map.js";
import "./map.css";
export default function WorkMap({ id }: { id: string }) {
  const bootstrap = useQuery({
      queryKey: ["work-map-bootstrap"],
      queryFn: ({ signal }) =>
        api<{ state: Project; config: MapConfig }>(
          "/api/bootstrap",
          undefined,
          signal,
        ),
    }),
    cities = useQuery({
      queryKey: ["cities"],
      queryFn: ({ signal }) => api<Cities>("/api/cities", undefined, signal),
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
  const error = bootstrap.error ?? cities.error ?? geometry.error;
  if (error) return <Alert type="error" title={error.message} />;
  if (!bootstrap.data || !cities.data || !geometry.data) return <Spin />;
  return (
    <Preview
      state={bootstrap.data.state}
      config={bootstrap.data.config}
      cities={cities.data}
      tracks={geometry.data.tracks}
    />
  );
}
function Preview(props: {
  state: Project;
  config: MapConfig;
  cities: Cities;
  tracks: SelectedTrack[];
}) {
  const [state, setState] = useState(() => ({
      ...props.state,
      title: "",
      tracks: props.tracks.map((t) => ({ entry: t.entry, sha256: t.sha256 })),
    })),
    [error, setError] = useState("");
  const viewport = useRef<Viewport>(null);
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
          state={state}
          config={props.config}
          cities={props.cities.labels}
          tracks={props.tracks}
          preview={false}
          onCamera={(camera) => setState((old) => ({ ...old, camera }))}
          onError={setError}
        />
      </div>
    </section>
  );
}
