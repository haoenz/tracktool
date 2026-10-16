import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Spin } from "./components/controls.js";
import { useWorkspace } from "./workspace.js";
import { api } from "./api.js";
import { MapViewport, type Viewport } from "./map-viewport.js";
import type { EditGeometry } from "../shared/track-edit.js";
import type { Project } from "../shared/project.js";
import type {
  Cities,
  MapConfig,
  SelectedTrack,
  Feature,
} from "../shared/map.js";
export function TrackEditorMap({
  geometry,
  onPick,
  selectedSegment,
  active = true,
  readOnly = false,
  autoFit = false,
  segmentColors,
}: {
  geometry: EditGeometry;
  onPick?: (p: [number, number]) => void;
  selectedSegment?: string;
  active?: boolean;
  readOnly?: boolean;
  autoFit?: boolean;
  segmentColors?: Record<string, string>;
}) {
  const workspace = useWorkspace();
  if (workspace.editMap)
    return (
      <WorkspaceEditMap
        geometry={geometry}
        onPick={onPick}
        selectedSegment={selectedSegment}
        active={active}
        readOnly={readOnly}
        autoFit={autoFit}
        segmentColors={segmentColors}
      />
    );
  return (
    <StandaloneEditorMap
      geometry={geometry}
      onPick={onPick}
      selectedSegment={selectedSegment}
    />
  );
}
function StandaloneEditorMap({
  geometry,
  onPick,
  selectedSegment,
}: {
  geometry: EditGeometry;
  onPick?: (p: [number, number]) => void;
  selectedSegment?: string;
}) {
  const bootstrap = useQuery({
    queryKey: ["work-map-bootstrap"],
    queryFn: ({ signal }) =>
      api<{ state: Project; config: MapConfig }>(
        "/api/bootstrap",
        undefined,
        signal,
      ),
  });
  const cities = useQuery({
    queryKey: ["cities"],
    queryFn: ({ signal }) => api<Cities>("/api/cities", undefined, signal),
  });
  if (bootstrap.error || cities.error)
    return (
      <Alert type="error" title={(bootstrap.error ?? cities.error)?.message} />
    );
  if (!bootstrap.data || !cities.data) return <Spin />;
  return (
    <EditorMap
      {...bootstrap.data}
      cities={cities.data}
      geometry={geometry}
      onPick={onPick}
      selectedSegment={selectedSegment}
    />
  );
}
function EditorMap({
  state: initial,
  config,
  cities,
  geometry,
  onPick,
  selectedSegment,
}: {
  state: Project;
  config: MapConfig;
  cities: Cities;
  geometry: EditGeometry;
  onPick?: (p: [number, number]) => void;
  selectedSegment?: string;
}) {
  const [state, setState] = useState({ ...initial, title: "" }),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false);
  const ref = useRef<Viewport>(null);
  const tracks = useMemo(() => editTracks(geometry), [geometry]);
  // Do not refit on each drawn point: users keep their working view.
  const initialTracks = useRef(tracks);
  useEffect(() => {
    let active = true;
    void ref.current
      ?.ready()
      .then(async () => {
        if (active) {
          if (initialTracks.current.some((track) => track.points > 0))
            ref.current?.fit(initialTracks.current);
          await ref.current?.ready();
          if (active) setReady(true);
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      active = false;
    };
  }, []);
  return (
    <section aria-label="段编辑地图" data-status={ready ? "ready" : "loading"}>
      <Button
        disabled={!tracks.some((track) => track.points > 0)}
        onClick={() => ref.current?.fit(tracks)}
      >
        定位轨迹
      </Button>
      <p>蓝色为当前选中段或正在补绘的线。</p>
      {!ready && !error && <p role="status">正在定位轨迹…</p>}
      {error && <Alert type="error" title={error} />}
      <div className="work-map">
        <MapViewport
          ref={ref}
          state={state}
          config={config}
          cities={cities.labels}
          tracks={tracks}
          preview={false}
          onCamera={(camera) => setState((s) => ({ ...s, camera }))}
          onError={setError}
          onPointPick={ready ? onPick : undefined}
          exposeRenderer={false}
          highlightSegment={selectedSegment ?? ""}
        />
      </div>
    </section>
  );
}
function unwrap(points: [number, number][]): [number, number][] {
  return points.reduce<[number, number][]>((out, [x, y]) => {
    const previous = out.at(-1);
    out.push([previous ? x + 360 * Math.round((previous[0] - x) / 360) : x, y]);
    return out;
  }, []);
}

function WorkspaceEditMap({
  geometry,
  onPick,
  selectedSegment,
  active,
  readOnly,
  autoFit,
  segmentColors,
}: {
  geometry: EditGeometry;
  onPick?: (p: [number, number]) => void;
  selectedSegment?: string;
  active: boolean;
  readOnly: boolean;
  autoFit: boolean;
  segmentColors?: Record<string, string>;
}) {
  const workspace = useWorkspace();
  const tracks = useMemo(
    () => editTracks(geometry, segmentColors),
    [geometry, segmentColors],
  );
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const setMap = workspace.editMap;
  const fitRef = useRef(workspace.fit);
  fitRef.current = workspace.fit;
  useEffect(() => {
    if (active && autoFit && tracks.some((t) => t.points > 0))
      fitRef.current?.(tracks);
  }, [active, autoFit, tracks]);

  useEffect(() => {
    if (!active) return;
    setMap?.((old) =>
      old &&
      old.segment === selectedSegment &&
      JSON.stringify(old.tracks) === JSON.stringify(tracks)
        ? old
        : {
            tracks,
            segment: selectedSegment,
            pick: (p) => pickRef.current?.(p),
          },
    );
  }, [active, tracks, selectedSegment, setMap]);
  useEffect(
    () => () => {
      if (active) setMap?.(undefined);
    },
    [active, setMap],
  );
  return (
    <section aria-label="段编辑地图" data-status="ready">
      {!readOnly && (
        <p>
          在主地图操作。蓝色为当前段／补绘；绿色表示新增；红色为删除范围；橙色点为断开位置。底图坐标已转换为原始
          WGS84 点索引。
        </p>
      )}
    </section>
  );
}
export function editTracks(
  geometry: EditGeometry,
  colors?: Record<string, string>,
): SelectedTrack[] {
  return [
    {
      entry: "编辑预览",
      sha256: "0".repeat(64),
      points: geometry.segments.reduce((n, s) => n + s.coordinates.length, 0),
      geojson: {
        type: "FeatureCollection",
        features: [
          ...geometry.segments.map((s): Feature => ({
            type: "Feature",
            properties: {
              segment_id: s.segment_id,
              ...(colors?.[s.segment_id]
                ? { edit_color: colors[s.segment_id] }
                : {}),
            },
            geometry:
              s.coordinates.length === 1
                ? { type: "MultiPoint", coordinates: s.coordinates }
                : {
                    type: "MultiLineString",
                    coordinates: [unwrap(s.coordinates)],
                  },
          })),
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "MultiLineString",
              coordinates: [...geometry.connections.map(unwrap)],
            },
          },
        ],
      },
    },
  ];
}
