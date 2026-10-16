import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  OverviewCrs,
  OverviewEntry,
  OverviewStatus,
} from "../shared/overview.js";
import type { TrackGeoJSON, SelectedTrack } from "../shared/map.js";
import type { Project } from "../shared/project.js";
import { api } from "./api.js";

export interface OverviewEntries {
  version: string;
  total: number;
  entries: OverviewEntry[];
}
export interface OverviewDetail {
  version: string;
  crs: "wgs84";
  entry: OverviewEntry;
  geometry: TrackGeoJSON;
}
export function rememberedCamera(
  archive: string,
): Project["camera"] | undefined {
  try {
    const v = JSON.parse(
      sessionStorage.getItem(`tracktool-browse:${archive}`) ?? "null",
    ) as Project["camera"] | null;
    if (
      v &&
      Array.isArray(v.center) &&
      v.center.length === 2 &&
      v.center.every(Number.isFinite) &&
      Math.abs(v.center[1]!) <= 85 &&
      Number.isFinite(v.zoom) &&
      v.zoom >= 0 &&
      v.zoom <= 18
    )
      return v;
  } catch {
    /* Storage may be disabled. */
  }
}
export function rememberCamera(archive: string, camera: Project["camera"]) {
  try {
    sessionStorage.setItem(
      `tracktool-browse:${archive}`,
      JSON.stringify(camera),
    );
  } catch {
    /* Optional session persistence. */
  }
}
export function useOverview(
  crs: OverviewCrs,
  search: string,
  kind: string,
  active = true,
  dates: { from: string; to: string; sort: string } = {
    from: "",
    to: "",
    sort: "date-desc",
  },
) {
  const [version, setVersion] = useState<string>();
  const [id, setId] = useState("");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const [candidateOffset, setCandidateOffset] = useState(0);
  const [queryText, setQueryText] = useState(search);
  const [tileError, setTileError] = useState("");
  const [loading, setLoading] = useState(false);
  const query = useQuery({
    queryKey: ["overview", crs],
    enabled: active,
    queryFn: ({ signal }) =>
      api<OverviewStatus>(`/api/overview?crs=${crs}`, undefined, signal),
    refetchInterval: active ? 2000 : false,
    retry: (count, error) => count < 2 && !error.message.includes("版本已过期"),
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 2000),
  });
  useEffect(() => {
    const timer = setTimeout(() => {
      setQueryText(search);
      setOffset(0);
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(
    () => setOffset(0),
    [kind, version, dates.from, dates.to, dates.sort],
  );
  const listVersion = version ?? query.data?.version;
  const list = useQuery({
    queryKey: ["overview-entries", listVersion, queryText, kind, offset, dates],
    enabled: active && !!listVersion,
    queryFn: ({ signal }) =>
      api<OverviewEntries>(
        `/api/overview/entries?${new URLSearchParams({ version: listVersion!, q: queryText, kind, ...dates, offset: String(offset), limit: "50" })}`,
        undefined,
        signal,
      ),
    retry: (count, error) => count < 2 && !error.message.includes("版本已过期"),
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 2000),
  });
  const matching = useQuery({
    queryKey: [
      "overview-candidates",
      listVersion,
      candidates,
      candidateOffset,
      id,
    ],
    enabled: active && !!listVersion && (!!candidates.length || !!id),
    queryFn: ({ signal }) =>
      api<OverviewEntries>(
        `/api/overview/entries?${new URLSearchParams({ version: listVersion!, ids: (candidates.length ? candidates.slice(candidateOffset, candidateOffset + 100) : [id]).join(",") })}`,
        undefined,
        signal,
      ),
    retry: (count, error) => count < 2 && !error.message.includes("版本已过期"),
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 2000),
  });
  const detail = useQuery({
    queryKey: ["overview-detail", listVersion, id],
    enabled: active && !!listVersion && !!id,
    queryFn: ({ signal }) =>
      api<OverviewDetail>(
        `/api/overview/entries/${encodeURIComponent(id)}/geometry?version=${listVersion}`,
        undefined,
        signal,
      ),
    retry: (count, error) => count < 2 && !error.message.includes("版本已过期"),
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 2000),
    gcTime: 0,
  });
  const loggedErrors = useRef(new Map<string, string>());
  useEffect(() => {
    for (const [resource, error] of [
      ["overview", query.error],
      ["list", list.error],
      ["matching", matching.error],
      ["detail", detail.error],
    ] as const) {
      if (!error) {
        loggedErrors.current.delete(resource);
        continue;
      }
      if (loggedErrors.current.get(resource) === error.message) continue;
      loggedErrors.current.set(resource, error.message);
      console.warn("[轨迹资源]", { resource, error });
    }
  }, [query.error, list.error, matching.error, detail.error]);
  const selected =
    matching.data?.entries.find((e) => e.id === id) ?? detail.data?.entry;
  const selectedTrack: SelectedTrack | undefined = detail.data
    ? {
        entry: detail.data.entry.entry,
        sha256: detail.data.entry.sha256,
        points: detail.data.entry.points,
        geojson: detail.data.geometry,
      }
    : undefined;
  // An expired version is replaced from status, never retried in a tight request loop.
  const recovery = useRef("");
  useEffect(() => {
    const error = list.error ?? matching.error ?? detail.error;
    if (
      error?.message.includes("版本已过期") &&
      recovery.current !== listVersion
    ) {
      recovery.current = listVersion ?? "";
      setVersion(undefined);
      void query.refetch();
    }
  }, [list.error, matching.error, detail.error, listVersion]);
  return {
    query,
    list,
    detail,
    selected,
    selectedTrack,
    id,
    setId,
    candidates,
    setCandidates,
    candidateOffset,
    setCandidateOffset,
    matching,
    offset,
    setOffset,
    version: listVersion,
    tileError,
    setTileError,
    loading,
    setLoading,
    published: (next: string) => {
      setVersion(next);
      setTileError("");
    },
    pick: (ids: string[]) => {
      setCandidateOffset(0);
      setCandidates(ids.length > 1 ? ids : []);
      setId(ids.length === 1 ? ids[0]! : "");
    },
    retry: async () => {
      setTileError("");
      await api(`/api/overview/retry?crs=${crs}`, {});
      await query.refetch();
    },
  };
}
