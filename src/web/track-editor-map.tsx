import { useEffect, useMemo, useRef } from "react";
import { useWorkspace } from "./workspace.js";
import type { EditGeometry } from "../shared/track-edit.js";
import type { SelectedTrack, Feature } from "../shared/map.js";
function unwrap(points: [number, number][]): [number, number][] {
  return points.reduce<[number, number][]>((out, [x, y]) => {
    const previous = out.at(-1);
    out.push([previous ? x + 360 * Math.round((previous[0] - x) / 360) : x, y]);
    return out;
  }, []);
}

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
      fitRef.current(tracks);
  }, [active, autoFit, tracks]);

  useEffect(() => {
    if (!active) return;
    setMap((old) => {
      if (old && old.segment === selectedSegment) {
        // One serialization per state change instead of two: reuse the
        // previous push's signature rather than re-encoding its tracks.
        const signature = JSON.stringify(tracks);
        if (old.signature === signature) return old;
        return {
          tracks,
          segment: selectedSegment,
          pick: (p) => pickRef.current?.(p),
          signature,
        };
      }
      return {
        tracks,
        segment: selectedSegment,
        pick: (p) => pickRef.current?.(p),
        signature: JSON.stringify(tracks),
      };
    });
  }, [active, tracks, selectedSegment, setMap]);
  useEffect(
    () => () => {
      if (active) setMap(undefined);
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
