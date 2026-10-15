import type Database from "better-sqlite3";
import { deflateSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { AppError } from "../../domain/errors.js";
import { memberName, type Category } from "../../domain/archive.js";
import { MAX_KML_BYTES } from "../../domain/trackdata.js";
import {
  validatePresentation,
  type EntrySnapshot,
  type EntryState,
  type Manifest,
  type Presentation,
  type SegmentManifest,
  type VersionRef,
} from "../../domain/track-version.js";
import { digest } from "../durable-files.js";
import { readManifest } from "../xml/manifest.js";
import { importedPresentation } from "../xml/display.js";
import {
  canonical,
  hashJson,
  presentationDigest,
  stableId,
} from "./identity.js";
import { rawObject, schemaVersion, transaction } from "./database.js";

export type OperationKind =
  | "import"
  | "migration_baseline"
  | "split_segment"
  | "prune"
  | "draw"
  | "compose"
  | "split_journey"
  | "restore"
  | "presentation"
  | "withdraw"
  | "source_link"
  | "reindex_manifest"
  | "set_tag"
  | "fill_altitude"
  | "legacy_regroup";
export type SourceLocation = {
  container: string;
  member: string | null;
  display_name: string;
  source_role:
    | "imported_file"
    | "legacy_result"
    | "earlier_candidate"
    | "verified_original";
  evidence: Record<string, unknown>;
};
export type SegmentSource = {
  ordinal: number;
  source_version_id: string;
  source_segment_id: string;
  start?: number;
  end_exclusive?: number;
  evidence_kind: "exact" | "ordered_subsequence" | "manual";
  evidence: Record<string, unknown>;
};
type VersionOutput = {
  kind: "version";
  entry_id?: string;
  raw: Uint8Array;
  path: string;
  category: Category | null;
  origin?: "imported" | "derived" | "legacy_result";
  state?: EntryState;
  settings?: Presentation;
  source_kinds?: Record<number, SegmentManifest["source_kind"]>;
  segment_ids?: string[];
  sources?: SegmentSource[];
  location?: SourceLocation;
};
type Output =
  | VersionOutput
  | { kind: "presentation"; entry_id: string; settings: Presentation }
  | { kind: "state"; entry_id: string; state: EntryState };
export type PublishRequest = {
  archive_id: string;
  request_key: string;
  kind: OperationKind;
  algorithm_version: string;
  params: Record<string, unknown>;
  inputs: VersionRef[];
  outputs: Output[];
  historical_inputs?: { version_id: string; sha256: string }[];
};
export type PublishResult = { operation_id: string; entries: EntrySnapshot[] };

export function archiveId(db: Database.Database): string {
  return (
    db
      .prepare("SELECT archive_id FROM archive_meta WHERE singleton=1")
      .get() as { archive_id: string }
  ).archive_id;
}
export function currentEntry(db: Database.Database, id: string): EntrySnapshot {
  const row = db
    .prepare(
      `SELECT e.id AS entry_id,e.path,e.category,e.filename_date,e.state,e.generation,
    e.current_version_id AS version_id,e.current_presentation_id AS presentation_id,v.sha256
    FROM archive_entries e JOIN track_versions v ON e.current_version_id=v.id WHERE e.id=?`,
    )
    .get(id) as EntrySnapshot | undefined;
  if (!row) throw new AppError("USER_INPUT", `Entry not found: ${id}`);
  return row;
}
export function checkRef(
  db: Database.Database,
  ref: VersionRef,
  allowPending = false,
): EntrySnapshot {
  const current = currentEntry(db, ref.entry_id);
  if (
    current.generation !== ref.generation ||
    current.version_id !== ref.version_id ||
    current.presentation_id !== ref.presentation_id ||
    current.sha256 !== ref.sha256
  )
    throw new AppError(
      "USER_INPUT",
      "Track changed since preview; refresh and retry",
    );
  if (
    !allowPending &&
    db
      .prepare("SELECT 1 FROM file_operations WHERE entry_id=?")
      .get(ref.entry_id)
  )
    throw new AppError(
      "USER_INPUT",
      "Entry has a pending file operation; run archive recover",
    );
  return current;
}
export function insertOperation(
  db: Database.Database,
  value: {
    id: string;
    kind: OperationKind;
    params: Record<string, unknown>;
    algorithm_version: string;
    created_at: string;
    request_key: string;
    request_sha256: string;
    result: PublishResult;
  },
): void {
  db.prepare("INSERT INTO track_operations VALUES (?,?,?,?,?,?,?,?)").run(
    value.id,
    value.kind,
    canonical(value.params),
    value.algorithm_version,
    value.created_at,
    value.request_key,
    value.request_sha256,
    canonical(value.result),
  );
}
export function insertVersion(
  db: Database.Database,
  entry: EntrySnapshot,
  operation: string,
  created: string,
  raw: Uint8Array,
  manifest: Manifest,
  origin: "migration_baseline" | "imported" | "legacy_result" | "derived",
  versionNo: number,
): void {
  if (raw.length > MAX_KML_BYTES)
    throw new AppError("USER_INPUT", "KML entry exceeds the 128 MiB limit");
  db.prepare("INSERT OR IGNORE INTO kml_objects VALUES (?,'zlib',?,?)").run(
    entry.sha256,
    raw.length,
    deflateSync(raw),
  );
  db.prepare("INSERT INTO track_versions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    entry.version_id,
    entry.entry_id,
    versionNo,
    entry.sha256,
    operation,
    created,
    entry.path,
    entry.category,
    entry.filename_date,
    origin,
    manifest.status,
    manifest.error,
  );
  const statement = db.prepare(
    "INSERT INTO track_segments VALUES (?,?,?,?,1,?,?,?,?)",
  );
  for (const s of manifest.segments)
    statement.run(
      entry.version_id,
      s.segment_id,
      s.ordinal,
      canonical(s.locator),
      s.geometry_kind,
      s.source_kind,
      s.point_count,
      s.time_status,
    );
}
export function insertPresentation(
  db: Database.Database,
  entry: EntrySnapshot,
  operation: string,
  created: string,
  settings: Presentation,
): void {
  const ids = (
    db
      .prepare(
        "SELECT segment_id FROM track_segments WHERE version_id=? ORDER BY ordinal",
      )
      .all(entry.version_id) as { segment_id: string }[]
  ).map((s) => s.segment_id);
  const value = validatePresentation(settings, ids);
  db.prepare("INSERT INTO track_presentations VALUES (?,?,?,?,?,?)").run(
    entry.presentation_id,
    entry.version_id,
    operation,
    created,
    canonical(value),
    presentationDigest(value),
  );
}
export function publishEntry(
  db: Database.Database,
  entry: EntrySnapshot,
  before: EntrySnapshot | null,
  operation: string,
): void {
  if (before)
    db.prepare(
      `UPDATE archive_entries SET path=?,category=?,filename_date=?,current_version_id=?,current_presentation_id=?,state=?,generation=? WHERE id=? AND generation=?`,
    ).run(
      entry.path,
      entry.category,
      entry.filename_date,
      entry.version_id,
      entry.presentation_id,
      entry.state,
      entry.generation,
      entry.entry_id,
      before.generation,
    );
  else
    db.prepare("INSERT INTO archive_entries VALUES (?,?,?,?,?,?,?,?)").run(
      entry.entry_id,
      entry.path,
      entry.category,
      entry.filename_date,
      entry.version_id,
      entry.presentation_id,
      entry.state,
      entry.generation,
    );
  db.prepare("INSERT INTO track_operation_effects VALUES (?,?,?,?)").run(
    operation,
    entry.entry_id,
    before ? canonical(before) : null,
    canonical(entry),
  );
}
export function insertLocation(
  db: Database.Database,
  entry: EntrySnapshot,
  operation: string,
  location: SourceLocation,
): void {
  db.prepare(
    "INSERT INTO track_source_locations VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    randomUUID(),
    operation,
    entry.version_id,
    entry.sha256,
    location.container,
    location.member,
    location.display_name,
    location.source_role,
    canonical(location.evidence),
  );
}
function checkDeletedOperation(
  db: Database.Database,
  operationId: string,
): void {
  if (
    schemaVersion(db) >= 4 &&
    db
      .prepare(
        "SELECT 1 FROM track_operation_deletions WHERE operation_id=? LIMIT 1",
      )
      .get(operationId)
  )
    throw new AppError(
      "USER_INPUT",
      "Operation contains deleted members; replay and group restore are unavailable",
    );
}
function replay(
  db: Database.Database,
  key: string,
  hash: string,
): PublishResult | undefined {
  const prior = db
    .prepare(
      "SELECT id,request_sha256,result_json FROM track_operations WHERE request_key=?",
    )
    .get(key) as
    { id: string; request_sha256: string; result_json: string } | undefined;
  if (!prior) return;
  checkDeletedOperation(db, prior.id);
  if (prior.request_sha256 !== hash)
    throw new AppError(
      "USER_INPUT",
      "Idempotency key reused with different request",
    );
  return JSON.parse(prior.result_json) as PublishResult;
}
function requireArchive(db: Database.Database, id: string): void {
  if (schemaVersion(db) < 3)
    throw new AppError(
      "USER_INPUT",
      "Version writes require schema 3 or later; run archive migrate explicitly",
    );
  if (archiveId(db) !== id)
    throw new AppError("USER_INPUT", "Archive identity changed");
  if (!db.inTransaction)
    throw new Error("Version writes require a transaction");
}
/** Called inside one reserved transaction. All outputs and pointer changes commit together. */
export function publishVersions(
  db: Database.Database,
  request: PublishRequest,
): PublishResult {
  requireArchive(db, request.archive_id);
  if (!request.request_key || !request.outputs.length)
    throw new AppError(
      "USER_INPUT",
      "Operation requires a request key and outputs",
    );
  const hash = hashJson({
    ...request,
    outputs: request.outputs.map((o) =>
      o.kind === "version" ? { ...o, raw: digest(o.raw) } : o,
    ),
  });
  const previous = replay(db, request.request_key, hash);
  if (previous) return previous;
  const before = new Map(
    request.inputs.map((ref) => [ref.entry_id, checkRef(db, ref)]),
  );
  if (before.size !== request.inputs.length)
    throw new AppError("USER_INPUT", "Duplicate operation input");
  for (const ref of request.historical_inputs ?? []) {
    if (
      db
        .prepare(
          "SELECT 1 FROM file_operations f JOIN track_versions v ON v.entry_id=f.entry_id WHERE v.id=?",
        )
        .get(ref.version_id)
    )
      throw new AppError(
        "USER_INPUT",
        "Historical input has a pending file operation; run archive recover",
      );
    if (
      !db
        .prepare("SELECT 1 FROM track_versions WHERE id=? AND sha256=?")
        .get(ref.version_id, ref.sha256)
    )
      throw new AppError(
        "USER_INPUT",
        "Historical input is missing or differs",
      );
  }
  const operation = stableId(
      `${request.archive_id}:operation:${request.request_key}`,
    ),
    created = new Date().toISOString();
  const prepared = request.outputs.map((output, index) => {
    const old = output.entry_id ? before.get(output.entry_id) : undefined;
    if (output.entry_id && !old)
      throw new AppError(
        "USER_INPUT",
        "Every changed entry requires a current source reference",
      );
    const entryId = old?.entry_id ?? stableId(`${operation}:entry:${index}`);
    const version =
      output.kind === "version"
        ? stableId(`${operation}:version:${index}`)
        : old!.version_id;
    const entry: EntrySnapshot = {
      entry_id: entryId,
      version_id: version,
      presentation_id:
        output.kind === "state"
          ? old!.presentation_id
          : stableId(`${operation}:presentation:${index}`),
      generation: (old?.generation ?? 0) + 1,
      path: output.kind === "version" ? memberName(output.path) : old!.path,
      category: output.kind === "version" ? output.category : old!.category,
      filename_date:
        output.kind === "version"
          ? (/\d{4}-\d{2}-\d{2}/.exec(output.path)?.[0] ?? null)
          : old!.filename_date,
      sha256: output.kind === "version" ? digest(output.raw) : old!.sha256,
      state:
        output.kind === "presentation"
          ? old!.state
          : (output.state ?? "active"),
    };
    if (output.kind === "version" && !entry.path.toLowerCase().endsWith(".kml"))
      throw new AppError("USER_INPUT", "Archive entries must be KML");
    const manifest =
      output.kind === "version"
        ? readManifest(output.raw, (n) => stableId(`${version}:segment:${n}`))
        : null;
    if (manifest && output.kind === "version") {
      if (output.segment_ids) {
        if (
          output.segment_ids.length !== manifest.segments.length ||
          new Set(output.segment_ids).size !== output.segment_ids.length ||
          output.segment_ids.some((id) => !id || id.length > 200)
        )
          throw new AppError(
            "USER_INPUT",
            "Segment identities must match the complete output manifest",
          );
        manifest.segments.forEach((segment, index) => {
          segment.segment_id = output.segment_ids![index]!;
        });
      }
      for (const [ordinal, kind] of Object.entries(output.source_kinds ?? {})) {
        const segment = manifest.segments[Number(ordinal)];
        if (!segment)
          throw new AppError("USER_INPUT", "Unknown provenance segment");
        segment.source_kind = kind;
      }
      if (
        manifest.status !== "ready" &&
        output.origin !== "imported" &&
        request.kind !== "import" &&
        request.kind !== "restore"
      )
        throw new AppError(
          "USER_INPUT",
          `Cannot publish edited KML: ${manifest.error}`,
        );
    }
    return { output, old: old ?? null, entry, manifest };
  });
  if (new Set(prepared.map((p) => p.entry.entry_id)).size !== prepared.length)
    throw new AppError("USER_INPUT", "Duplicate output entry");
  const result = {
    operation_id: operation,
    entries: prepared.map((p) => p.entry),
  };
  insertOperation(db, {
    id: operation,
    kind: request.kind,
    params: request.params,
    algorithm_version: request.algorithm_version,
    created_at: created,
    request_key: request.request_key,
    request_sha256: hash,
    result,
  });
  request.inputs.forEach((ref, index) =>
    db
      .prepare("INSERT INTO track_operation_inputs VALUES (?,?,?,?)")
      .run(operation, ref.version_id, "input", index),
  );
  (request.historical_inputs ?? []).forEach((ref, index) =>
    db
      .prepare("INSERT INTO track_operation_inputs VALUES (?,?,?,?)")
      .run(
        operation,
        ref.version_id,
        "historical",
        request.inputs.length + index,
      ),
  );
  const inputVersions = new Set(
    [...request.inputs, ...(request.historical_inputs ?? [])].map(
      (i) => i.version_id,
    ),
  );
  for (const { output, old, entry, manifest } of prepared) {
    if (output.kind === "version") {
      const number = (
        db
          .prepare(
            "SELECT coalesce(max(version_no),0)+1 AS n FROM track_versions WHERE entry_id=?",
          )
          .get(entry.entry_id) as { n: number }
      ).n;
      insertVersion(
        db,
        entry,
        operation,
        created,
        output.raw,
        manifest!,
        output.origin ?? "derived",
        number,
      );
      for (const source of output.sources ?? []) {
        const segment = manifest!.segments[source.ordinal];
        if (!segment || !inputVersions.has(source.source_version_id))
          throw new AppError(
            "USER_INPUT",
            "Lineage must reference an operation input and output segment",
          );
        db.prepare(
          "INSERT INTO track_segment_sources VALUES (?,?,?,?,?,?,?,?,?,?)",
        ).run(
          randomUUID(),
          operation,
          entry.version_id,
          segment.segment_id,
          source.source_version_id,
          source.source_segment_id,
          source.start ?? null,
          source.end_exclusive ?? null,
          source.evidence_kind,
          canonical(source.evidence),
        );
      }
      if (output.location)
        insertLocation(db, entry, operation, output.location);
    }
    if (output.kind !== "state") {
      const imported =
        output.kind === "version" && manifest!.status === "ready"
          ? importedPresentation(output.raw, manifest!.segments)
          : undefined;
      const settings = output.settings ??
        imported ?? {
          schema: 1,
          default_connect: true,
          order: manifest!.segments.map((s) => s.segment_id),
          ignored: [],
          connections: [],
        };
      insertPresentation(db, entry, operation, created, settings);
    }
    publishEntry(db, entry, old, operation);
  }
  return result;
}

/** Import compatibility adapter. A reserved historical path cannot silently acquire new bytes. */
export function addVersionedEntry(
  db: Database.Database,
  name: string,
  raw: Uint8Array,
  category: Category | null,
  location?: SourceLocation,
): { id: string; path: string; sha256: string } {
  const found = db
    .prepare("SELECT id,state FROM archive_entries WHERE path=?")
    .get(name) as { id: string; state: EntryState } | undefined;
  if (found) {
    const old = currentEntry(db, found.id);
    if (old.sha256 !== digest(raw) || old.state !== "active")
      throw new AppError(
        "USER_INPUT",
        `Archive path conflict; source retained: ${name}`,
      );
    return { id: old.entry_id, path: old.path, sha256: old.sha256 };
  }
  const entry = publishVersions(db, {
    archive_id: archiveId(db),
    request_key: randomUUID(),
    kind: "import",
    algorithm_version: "import-v1",
    params: {},
    inputs: [],
    outputs: [
      {
        kind: "version",
        raw,
        path: name,
        category,
        origin: "imported",
        ...(location ? { location } : {}),
      },
    ],
  }).entries[0]!;
  return { id: entry.entry_id, path: entry.path, sha256: entry.sha256 };
}

export class VersionStore {
  constructor(private readonly file: string) {}
  publish(request: PublishRequest): PublishResult {
    return transaction(this.file, true, (db) => publishVersions(db, request));
  }
  current(entryId: string): EntrySnapshot {
    return transaction(this.file, false, (db) => currentEntry(db, entryId));
  }
  history(entryId: string): unknown[] {
    return transaction(this.file, false, (db) =>
      db
        .prepare(
          "SELECT * FROM track_versions WHERE entry_id=? ORDER BY version_no",
        )
        .all(entryId),
    );
  }
  read(versionId: string): Uint8Array {
    return transaction(this.file, false, (db) => {
      const row = db
        .prepare("SELECT sha256 FROM track_versions WHERE id=?")
        .get(versionId) as { sha256: string } | undefined;
      if (!row) throw new AppError("USER_INPUT", "Version not found");
      return rawObject(db, row.sha256);
    });
  }
  /** Supplement immutable historical versions without changing their bytes or the active view. */
  linkSources(request: {
    archive_id: string;
    request_key: string;
    locations: {
      version_id: string;
      sha256: string;
      location: SourceLocation;
    }[];
    lineage?: {
      version_id: string;
      segment_id: string;
      source: Omit<SegmentSource, "ordinal">;
    }[];
  }): PublishResult {
    return transaction(this.file, true, (db) => {
      requireArchive(db, request.archive_id);
      const hash = hashJson(request),
        prior = replay(db, request.request_key, hash);
      if (prior) return prior;
      if (
        !request.request_key ||
        (!request.locations.length && !request.lineage?.length)
      )
        throw new AppError("USER_INPUT", "Source linking requires evidence");
      const operation = stableId(
          `${request.archive_id}:operation:${request.request_key}`,
        ),
        result = { operation_id: operation, entries: [] };
      insertOperation(db, {
        id: operation,
        kind: "source_link",
        params: {
          locations: request.locations,
          lineage: request.lineage ?? [],
        },
        algorithm_version: "source-link-v1",
        created_at: new Date().toISOString(),
        request_key: request.request_key,
        request_sha256: hash,
        result,
      });
      const inputs = new Set<string>();
      for (const item of request.locations) {
        const version = db
          .prepare(
            "SELECT entry_id FROM track_versions WHERE id=? AND sha256=?",
          )
          .get(item.version_id, item.sha256) as
          { entry_id: string } | undefined;
        if (!version)
          throw new AppError(
            "USER_INPUT",
            "Source bytes do not match the stored version",
          );
        insertLocation(
          db,
          {
            ...currentEntry(db, version.entry_id),
            version_id: item.version_id,
            sha256: item.sha256,
          },
          operation,
          item.location,
        );
        inputs.add(item.version_id);
      }
      for (const { version_id, segment_id, source } of request.lineage ?? []) {
        db.prepare(
          "INSERT INTO track_segment_sources VALUES (?,?,?,?,?,?,?,?,?,?)",
        ).run(
          randomUUID(),
          operation,
          version_id,
          segment_id,
          source.source_version_id,
          source.source_segment_id,
          source.start ?? null,
          source.end_exclusive ?? null,
          source.evidence_kind,
          canonical(source.evidence),
        );
        inputs.add(version_id);
        inputs.add(source.source_version_id);
      }
      [...inputs].forEach((v, i) =>
        db
          .prepare("INSERT INTO track_operation_inputs VALUES (?,?,?,?)")
          .run(operation, v, "source_link", i),
      );
      return result;
    });
  }
  /** Content restore creates another version; later content versions remain available. */
  restoreVersion(
    archive: string,
    ref: VersionRef,
    targetVersion: string,
    targetPresentation: string,
    requestKey: string,
  ): PublishResult {
    return transaction(this.file, true, (db) => {
      requireArchive(db, archive);
      const target = db
        .prepare(
          `SELECT v.*,p.settings_json FROM track_versions v JOIN track_presentations p ON p.version_id=v.id WHERE v.id=? AND v.entry_id=? AND p.id=?`,
        )
        .get(targetVersion, ref.entry_id, targetPresentation) as
        | {
            sha256: string;
            path: string;
            category: Category | null;
            settings_json: string;
          }
        | undefined;
      if (!target)
        throw new AppError(
          "USER_INPUT",
          "Restore target does not belong to this entry/version",
        );
      const segments = db
        .prepare(
          "SELECT segment_id,ordinal,source_kind FROM track_segments WHERE version_id=? ORDER BY ordinal",
        )
        .all(targetVersion) as {
        segment_id: string;
        ordinal: number;
        source_kind: SegmentManifest["source_kind"];
      }[];
      const operation = stableId(`${archive}:operation:${requestKey}`),
        version = stableId(`${operation}:version:0`);
      const ids = new Map(
        segments.map((s) => [
          s.segment_id,
          stableId(`${version}:segment:${s.ordinal}`),
        ]),
      );
      const settings = validatePresentation(
        JSON.parse(target.settings_json),
        segments.map((s) => s.segment_id),
      );
      return publishVersions(db, {
        archive_id: archive,
        request_key: requestKey,
        kind: "restore",
        algorithm_version: "restore-version-v1",
        params: {
          version_id: targetVersion,
          presentation_id: targetPresentation,
        },
        inputs: [ref],
        historical_inputs: [
          { version_id: targetVersion, sha256: target.sha256 },
        ],
        outputs: [
          {
            kind: "version",
            entry_id: ref.entry_id,
            raw: rawObject(db, target.sha256),
            path: target.path,
            category: target.category,
            source_kinds: Object.fromEntries(
              segments.map((s) => [s.ordinal, s.source_kind]),
            ),
            sources: segments.map((s) => ({
              ordinal: s.ordinal,
              source_version_id: targetVersion,
              source_segment_id: s.segment_id,
              evidence_kind: "exact",
              evidence: { restored: true },
            })),
            settings: {
              ...settings,
              order: settings.order.map((id) => ids.get(id)!),
              ignored: settings.ignored.map((id) => ids.get(id)!),
              connections: settings.connections.map((e) => ({
                ...e,
                from: ids.get(e.from)!,
                to: ids.get(e.to)!,
              })),
            },
          },
        ],
      });
    });
  }
  /** Restore every effect of an operation, guarded against intervening edits to any member. */
  restore(
    archive: string,
    operationId: string,
    requestKey: string,
    expected: VersionRef[],
    context:
      { preview_id: string; preview_sha256: string } | undefined = undefined,
  ): PublishResult {
    return transaction(this.file, true, (db) => {
      requireArchive(db, archive);
      const hash = hashJson({
        archive,
        operationId,
        requestKey,
        expected,
        ...(context ? { context } : {}),
      });
      const prior = replay(db, requestKey, hash);
      if (prior) return prior;
      checkDeletedOperation(db, operationId);
      const effects = db
        .prepare(
          "SELECT entry_id,before_json,after_json FROM track_operation_effects WHERE operation_id=? ORDER BY entry_id",
        )
        .all(operationId) as {
        entry_id: string;
        before_json: string | null;
        after_json: string;
      }[];
      if (
        !effects.length ||
        effects.length !== expected.length ||
        new Set(expected.map((e) => e.entry_id)).size !== effects.length
      )
        throw new AppError(
          "USER_INPUT",
          "Restore requires the complete operation group",
        );
      const current = new Map(
        expected.map((ref) => [ref.entry_id, checkRef(db, ref)]),
      );
      const restored = effects.map((effect) => {
        const old = current.get(effect.entry_id),
          applied = JSON.parse(effect.after_json) as EntrySnapshot;
        if (!old || canonical(old) !== canonical(applied))
          throw new AppError(
            "USER_INPUT",
            "Operation group changed; restore is no longer safe",
          );
        const value = effect.before_json
          ? (JSON.parse(effect.before_json) as EntrySnapshot)
          : { ...old, state: "source_only" as const };
        return { old, entry: { ...value, generation: old.generation + 1 } };
      });
      const operation = stableId(`${archive}:operation:${requestKey}`),
        result = {
          operation_id: operation,
          entries: restored.map((r) => r.entry),
        };
      insertOperation(db, {
        id: operation,
        kind: "restore",
        params: { operation_id: operationId, ...context },
        algorithm_version: "restore-v1",
        created_at: new Date().toISOString(),
        request_key: requestKey,
        request_sha256: hash,
        result,
      });
      [
        ...new Set(
          restored.flatMap((r) => [r.old.version_id, r.entry.version_id]),
        ),
      ].forEach((version, i) =>
        db
          .prepare("INSERT INTO track_operation_inputs VALUES (?,?,?,?)")
          .run(operation, version, "restore", i),
      );
      for (const { old, entry } of restored)
        publishEntry(db, entry, old, operation);
      return result;
    });
  }
}
