import type Database from "better-sqlite3";
import { AppError, checkCancelled } from "../../domain/errors.js";
import {
  ADMINISTRATIVE_RESOLVER_VERSION,
  reparseAdministrativeLocation,
  administrativeLocation,
} from "../../domain/administrative-location.js";
import { bindSegments } from "../../domain/presentation.js";
import type {
  AdministrativeLocation,
  EndpointLocation,
  GeocodeResponse,
} from "../../shared/endpoint-location.js";
import type { XmlPort } from "../../services/ports.js";
import type { ProjectTrack } from "../../shared/project-track.js";
import {
  readTransaction,
  transaction,
  rawObject,
  schemaVersion,
} from "./database.js";
import { resolveTrack, readPresentation } from "./presentation.js";

export function endpointLocations(
  db: Database.Database,
  presentation: string,
  language = "zh-CN",
): EndpointLocation[] {
  if (schemaVersion(db) < 6) return [];
  const rows = db
    .prepare(
      `SELECT endpoint,latitude,longitude,provider,language,resolver_version,queried_at,location_json FROM track_endpoint_locations
    WHERE presentation_id=? AND provider='google' AND language=? AND resolver_version<=? ORDER BY resolver_version DESC,endpoint DESC`,
    )
    .all(presentation, language, ADMINISTRATIVE_RESOLVER_VERSION) as (Omit<
    EndpointLocation,
    "location"
  > & { location_json: string })[];
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      if (seen.has(row.endpoint)) return false;
      seen.add(row.endpoint);
      return true;
    })
    .sort((a, b) => b.endpoint.localeCompare(a.endpoint))
    .map(({ location_json, ...row }) => ({
      ...row,
      location: JSON.parse(location_json) as AdministrativeLocation,
    }));
}
export function currentEndpointLocations(
  file: string,
  entry: string,
  language = "zh-CN",
) {
  return readTransaction(file, (db) => {
    const row = db
      .prepare("SELECT path FROM archive_entries WHERE id=? AND state='active'")
      .get(entry) as { path: string } | undefined;
    if (!row) throw new AppError("USER_INPUT", "活动轨迹不存在");
    const ref = resolveTrack(db, { entry: row.path });
    return {
      ...ref,
      endpoints: endpointLocations(db, ref.presentation_id!, language),
    };
  });
}
export type EndpointGeocoder = {
  getAdministrative(
    point: [number, number],
    key: string,
    language: string,
    signal: AbortSignal,
  ): Promise<AdministrativeLocation>;
};
export type EndpointEvidence = {
  latitude: number;
  longitude: number;
  language: string;
  queriedAt: string;
  response: GeocodeResponse;
};
export type FillEndpointOptions = {
  entry?: string;
  limit?: number;
  language?: string;
  dryRun?: boolean;
  refresh?: boolean;
  retryIncomplete?: boolean;
  offline?: boolean;
  completeEvidence?: boolean;
  evidence?: EndpointEvidence[];
  onProgress?: (value: Record<string, unknown>) => void;
};
export async function fillEndpointLocations(
  file: string,
  xml: XmlPort,
  geocoder: EndpointGeocoder,
  key: string,
  inputSignal: AbortSignal,
  options: FillEndpointOptions = {},
) {
  const controller = new AbortController();
  const signal = AbortSignal.any([inputSignal, controller.signal]);
  const language = options.language ?? "zh-CN";
  const evidence = new Map(
    (options.evidence ?? [])
      .filter((v) => v.language === language)
      .map((v) => [JSON.stringify([v.latitude, v.longitude]), v]),
  );
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1)
  )
    throw new AppError("USER_INPUT", "limit 必须为正整数");
  const entries = readTransaction(file, (db) => {
    if (schemaVersion(db) < 6 && !options.dryRun)
      throw new AppError(
        "USER_INPUT",
        "端点行政区需要 schema 6；请先执行 archive migrate",
      );
    if (schemaVersion(db) < 3)
      throw new AppError("USER_INPUT", "请先执行 archive migrate");
    return db
      .prepare(
        `SELECT id,path FROM archive_entries WHERE state='active' ${options.entry ? "AND id=?" : ""} ORDER BY path`,
      )
      .all(...(options.entry ? [options.entry] : [])) as {
      id: string;
      path: string;
    }[];
  });
  if (options.entry && !entries.length)
    throw new AppError("USER_INPUT", "活动轨迹不存在");
  const summary = {
    tracks: 0,
    skipped: 0,
    queries: 0,
    reused: 0,
    saved: 0,
    incomplete: 0,
    failed: 0,
    planned: 0,
    reparsed: 0,
    pending: 0,
    fallback: 0,
    conflicts: 0,
  };
  const reusable = (v: EndpointLocation) =>
    v.resolver_version === ADMINISTRATIVE_RESOLVER_VERSION &&
    !options.refresh &&
    (!options.retryIncomplete || v.location.status === "complete") &&
    (!options.completeEvidence ||
      v.location.status === "complete" ||
      v.location.raw_source === "full_response") &&
    (!evidence.has(JSON.stringify([v.latitude, v.longitude])) ||
      v.location.raw_source === "full_response");
  const plannedCoordinates = new Set<string>();
  const pending = new Map<
    string,
    Promise<{ location: AdministrativeLocation; queriedAt: string }>
  >();
  async function processEntry(entry: { id: string; path: string }) {
    checkCancelled(signal);
    let ref: ProjectTrack;
    let counted = false;
    try {
      const input = readTransaction(file, (db) => {
        const resolved = resolveTrack(db, { entry: entry.path });
        if (resolved.entry_id !== entry.id)
          throw new AppError("USER_INPUT", "轨迹已变化，请重试");
        const existing = endpointLocations(
          db,
          resolved.presentation_id!,
          language,
        );
        if (existing.length === 2 && existing.every(reusable))
          return { resolved, existing, skip: true };
        if (existing.length === 2)
          return {
            resolved,
            existing,
            endpoints: existing.map((v) => ({
              endpoint: v.endpoint,
              latitude: v.latitude,
              longitude: v.longitude,
            })),
          };
        return {
          resolved,
          existing,
          raw: rawObject(db, resolved.sha256),
          presentation: readPresentation(db, resolved),
        };
      });
      ref = input.resolved;
      if (input.skip) {
        summary.skipped++;
        return;
      }
      summary.tracks++;
      counted = true;
      let endpoints = input.endpoints;
      if (!endpoints) {
        const result = await xml.run(
          input.raw!,
          { kind: "tracks", source: entry.path },
          signal,
        );
        if (!result.tracks) throw new AppError("TOOL", "轨迹解析没有返回坐标");
        const bound = bindSegments(result.tracks, input.presentation!.segments);
        const byId = new Map(bound.map((s) => [s.segment_id, s]));
        const ignored = new Set(input.presentation!.settings.ignored);
        const visible = input
          .presentation!.settings.order.filter((id) => !ignored.has(id))
          .map((id) => byId.get(id)!)
          .filter((s) => s.longitude.length);
        if (!visible.length)
          throw new AppError("USER_INPUT", "当前展示没有有效轨迹点");
        const first = visible[0]!,
          last = visible.at(-1)!,
          end = last.longitude.length - 1;
        endpoints = [
          {
            endpoint: "start" as const,
            latitude: first.latitude[0]!,
            longitude: first.longitude[0]!,
          },
          {
            endpoint: "end" as const,
            latitude: last.latitude[end]!,
            longitude: last.longitude[end]!,
          },
        ];
      }
      for (const endpoint of endpoints) {
        checkCancelled(signal);
        if (
          ![endpoint.latitude, endpoint.longitude].every(Number.isFinite) ||
          Math.abs(endpoint.latitude) > 90 ||
          Math.abs(endpoint.longitude) > 180
        )
          throw new AppError("USER_INPUT", "端点坐标无效");
        if (
          input.existing.some(
            (v) =>
              v.endpoint === endpoint.endpoint &&
              v.latitude === endpoint.latitude &&
              v.longitude === endpoint.longitude &&
              reusable(v),
          )
        )
          continue;
        const coordinateKey = JSON.stringify([
          endpoint.latitude,
          endpoint.longitude,
        ]);
        const supplied = !options.refresh
          ? evidence.get(coordinateKey)
          : undefined;
        const stored = supplied
          ? {
              location_json: JSON.stringify(
                administrativeLocation(
                  supplied.response.results,
                  supplied.response.status === "ZERO_RESULTS",
                  { rawResponse: supplied.response },
                ),
              ),
              queried_at: supplied.queriedAt,
              resolver_version: ADMINISTRATIVE_RESOLVER_VERSION,
            }
          : (!options.refresh || options.offline) &&
            readTransaction(file, (db) => {
              if (schemaVersion(db) < 6) return undefined;
              return db
                .prepare(
                  `SELECT location_json,queried_at,resolver_version FROM track_endpoint_locations WHERE latitude=? AND longitude=? AND provider='google' AND language=? AND resolver_version<=? ORDER BY resolver_version DESC,(json_extract(location_json,'$.raw_source')='full_response') DESC,queried_at DESC LIMIT 1`,
                )
                .get(
                  endpoint.latitude,
                  endpoint.longitude,
                  language,
                  ADMINISTRATIVE_RESOLVER_VERSION,
                ) as
                | {
                    location_json: string;
                    queried_at: string;
                    resolver_version: number;
                  }
                | undefined;
            });
        const oldLocation = stored
          ? (JSON.parse(stored.location_json) as AdministrativeLocation)
          : undefined;
        const normalized =
          oldLocation && stored
            ? stored.resolver_version === ADMINISTRATIVE_RESOLVER_VERSION &&
              !options.refresh
              ? oldLocation
              : reparseAdministrativeLocation(oldLocation)
            : undefined;
        const cached =
          stored &&
          normalized &&
          (options.offline ||
            supplied ||
            normalized.status === "complete" ||
            (!options.retryIncomplete &&
              (!options.completeEvidence ||
                normalized.raw_source === "full_response")))
            ? { ...stored, location: normalized }
            : undefined;
        if (options.dryRun) {
          summary.planned++;
          const reuse = !!cached || plannedCoordinates.has(coordinateKey);
          if (!reuse && !options.offline) summary.queries++;
          plannedCoordinates.add(coordinateKey);
          options.onProgress?.({
            entry_id: entry.id,
            path: entry.path,
            ...endpoint,
            action:
              cached &&
              cached.resolver_version !== ADMINISTRATIVE_RESOLVER_VERSION
                ? "reparse"
                : reuse
                  ? "reuse"
                  : options.offline
                    ? "missing_evidence"
                    : "query",
            dry_run: true,
          });
          continue;
        }
        if (!cached && options.offline) {
          summary.pending++;
          options.onProgress?.({
            entry_id: entry.id,
            path: entry.path,
            ...endpoint,
            action: "missing_evidence",
          });
          continue;
        }
        let location: AdministrativeLocation, queriedAt: string;
        let reused = !!cached;
        if (cached) {
          location = cached.location;
          if (
            cached.resolver_version !== ADMINISTRATIVE_RESOLVER_VERSION ||
            options.refresh
          )
            summary.reparsed++;
          queriedAt = cached.queried_at;
          summary.reused++;
        } else {
          if (!key)
            throw new AppError("USER_INPUT", "Google API key is required");
          let lookup = pending.get(coordinateKey);
          if (!lookup) {
            summary.queries++;
            lookup = geocoder
              .getAdministrative(
                [endpoint.latitude, endpoint.longitude],
                key,
                language,
                signal,
              )
              .then((location) => ({
                location,
                queriedAt: new Date().toISOString(),
              }));
            pending.set(coordinateKey, lookup);
          } else {
            summary.reused++;
            reused = true;
          }
          try {
            ({ location, queriedAt } = await lookup);
          } catch (error) {
            pending.delete(coordinateKey);
            throw error;
          }
        }
        checkCancelled(signal);
        transaction(file, true, (db) => {
          const current = resolveTrack(db, { entry: entry.path });
          if (
            current.entry_id !== ref.entry_id ||
            current.version_id !== ref.version_id ||
            current.presentation_id !== ref.presentation_id
          )
            throw new AppError("USER_INPUT", "查询期间轨迹发生变化，请重试");
          db.prepare(
            `INSERT INTO track_endpoint_locations(presentation_id,endpoint,latitude,longitude,provider,language,resolver_version,status,location_json,queried_at)
          VALUES (?,?,?,?,'google',?,?,?,?,?) ON CONFLICT(presentation_id,endpoint,provider,language,resolver_version) DO UPDATE SET latitude=excluded.latitude,longitude=excluded.longitude,status=excluded.status,location_json=excluded.location_json,queried_at=excluded.queried_at`,
          ).run(
            ref.presentation_id!,
            endpoint.endpoint,
            endpoint.latitude,
            endpoint.longitude,
            language,
            ADMINISTRATIVE_RESOLVER_VERSION,
            location.status,
            JSON.stringify(location),
            queriedAt,
          );
        });
        summary.saved++;
        if (location.status !== "complete") summary.incomplete++;
        if (location.resolution?.mode === "fallback") summary.fallback++;
        if (location.resolution?.conflict_fields.length) summary.conflicts++;
        options.onProgress?.({
          entry_id: entry.id,
          path: entry.path,
          ...endpoint,
          location,
          reused,
        });
      }
    } catch (error) {
      checkCancelled(signal);
      summary.failed++;
      if (!counted) summary.tracks++;
      const message =
        error instanceof AppError ? error.message : "端点行政区处理失败";
      options.onProgress?.({
        entry_id: entry.id,
        path: entry.path,
        error: message,
      });
      // Credential/quota errors affect every following entry; preserve completed endpoints and stop.
      if (
        /Google API key|REQUEST_DENIED|OVER_QUERY_LIMIT|INVALID_REQUEST/.test(
          message,
        )
      )
        throw new AppError("TOOL", message);
    }
  }
  let cursor = 0;
  let fatal: unknown;
  async function worker() {
    try {
      while (cursor < entries.length && !signal.aborted) {
        if (options.limit && summary.tracks >= options.limit) break;
        await processEntry(entries[cursor++]!);
      }
      checkCancelled(signal);
    } catch (error) {
      fatal ??= error;
      controller.abort();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(4, entries.length) }, () => worker()),
  );
  if (fatal) throw fatal;
  checkCancelled(inputSignal);
  return summary;
}
