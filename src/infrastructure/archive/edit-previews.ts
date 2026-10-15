import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { AppError, checkCancelled } from "../../domain/errors.js";
import { memberName } from "../../domain/archive.js";
import { MAX_KML_BYTES } from "../../domain/trackdata.js";
import type {
  SegmentInput,
  SegmentEditResult,
} from "../../domain/segment-edit.js";
import {
  EditRequestSchema,
  EditApplySchema,
  type EditRequest,
  type EditApply,
  type EditPreview,
  type EntrySnapshot,
} from "../../shared/track-edit.js";
import { digest } from "../durable-files.js";
import { readTransaction } from "./database.js";
import { canonical, hashJson } from "./identity.js";
import {
  archiveId,
  checkRef,
  VersionStore,
  type PublishRequest,
  type PublishResult,
} from "./versions.js";
import { prepareSegmentEdit } from "./segment-editor.js";
import { prepareLegacyRegroup } from "./legacy-regroup.js";
import {
  inputGeometry,
  requireVersioned,
  versionInput,
} from "./track-reader.js";

type Artifact = {
  raw: Uint8Array;
  segments: SegmentInput["segments"];
  settings: SegmentInput["settings"];
  path: string;
  state: EntrySnapshot["state"];
};
type WirePublish = Omit<PublishRequest, "outputs"> & {
  outputs: (
    | Exclude<PublishRequest["outputs"][number], { kind: "version" }>
    | (Omit<
        Extract<PublishRequest["outputs"][number], { kind: "version" }>,
        "raw"
      > & { object: number })
  )[];
};
type Manifest = Omit<EditPreview, "preview_sha256"> & {
  algorithm_version: "edit-preview-v1";
  request: EditRequest;
  publish?: WirePublish;
  objects: { sha256: string; size: number }[];
};
const noChanges = (): SegmentEditResult["changes"] => ({
  added_points: 0,
  removed_points: 0,
  removed_ranges: [],
  removed_connections: [],
  before_edges: [],
  after_edges: [],
  warnings: [],
});
function checkArtifacts(values: Artifact[]) {
  if (values.reduce((n, a) => n + a.raw.length, 0) > MAX_KML_BYTES)
    throw new AppError("USER_INPUT", "预览产物总量超过 128 MiB");
  if (
    values.reduce(
      (n, a) => n + a.segments.reduce((n, s) => n + s.point_count, 0),
      0,
    ) > 2_000_000
  )
    throw new AppError("USER_INPUT", "预览产物总点数超过 200 万");
}
function fail(reason: string, message: string): never {
  throw new EditError(reason, message);
}
export class EditError extends AppError {
  constructor(
    readonly reason: string,
    message: string,
    readonly status = reason === "PREVIEW_EXPIRED" ? 410 : 409,
  ) {
    super("USER_INPUT", message);
  }
}

/** Immutable, hashed preview manifests and bounded KML blobs live in the task state DB, never in the archive. */
export class EditPreviews {
  private db: Database.Database;
  constructor(
    file: string,
    private now = () => Date.now(),
    readonly = false,
  ) {
    if (readonly) {
      this.db = new Database(file, { readonly: true, fileMustExist: true });
      return;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode=WAL");
    this.db.pragma("synchronous=FULL");
    this.db.pragma("busy_timeout=5000");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS edit_previews(id TEXT PRIMARY KEY,archive_id TEXT NOT NULL,expires_at INTEGER NOT NULL,sha256 TEXT NOT NULL,manifest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS edit_preview_objects(preview_id TEXT NOT NULL,ordinal INTEGER NOT NULL,raw BLOB NOT NULL,PRIMARY KEY(preview_id,ordinal));",
    );
  }
  close() {
    this.db.close();
  }
  async create(
    file: string,
    id: string,
    input: EditRequest,
    signal?: AbortSignal,
  ): Promise<EditPreview> {
    const request = EditRequestSchema.parse(input);
    const prior = this.db
      .prepare("SELECT manifest FROM edit_previews WHERE id=?")
      .get(id) as { manifest: string } | undefined;
    if (prior) {
      if (
        canonical((JSON.parse(prior.manifest) as Manifest).request) !==
        canonical(request)
      )
        fail("IDEMPOTENCY_CONFLICT", "预览标识已用于其他请求");
      return this.get(file, id);
    }
    const before = readTransaction(file, (db) => {
      requireVersioned(db);
      if (archiveId(db) !== request.archive_id)
        fail("SOURCE_CHANGED", "轨迹库已切换");
      return "target" in request
        ? [checkRef(db, request.target)]
        : request.operation.expected.map((ref) => checkRef(db, ref));
    });
    let publish: PublishRequest | undefined;
    const artifacts: Artifact[] = [],
      changes: EditPreview["changes"] = [];
    if (request.operation.kind === "legacy_regroup") {
      const prepared = await prepareLegacyRegroup(
        file,
        request.archive_id,
        id,
        request.operation,
        signal,
      );
      publish = prepared.publish;
      artifacts.push({
        ...prepared.result,
        path: request.operation.path,
        state: "active",
      });
      changes.push(prepared.result.changes);
    } else if (request.operation.kind === "restore_group") {
      const operationId = request.operation.operation_id;
      readTransaction(file, (db) => {
        if (
          db
            .prepare(
              "SELECT 1 FROM track_operation_deletions WHERE operation_id=?",
            )
            .get(operationId)
        )
          fail("RESTORE_DEPENDENCY_CHANGED", "组内条目已被删除，无法撤销");
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
          effects.length !== before.length ||
          new Set(before.map((e) => e.entry_id)).size !== effects.length
        )
          fail("RESTORE_DEPENDENCY_CHANGED", "撤销必须包含完整操作组");
        for (const e of effects) {
          const current = before.find((b) => b.entry_id === e.entry_id);
          if (
            !current ||
            canonical(current) !== canonical(JSON.parse(e.after_json))
          )
            fail(
              "RESTORE_DEPENDENCY_CHANGED",
              "组内轨迹已被后续修改，无法整组撤销",
            );
          const restored = e.before_json
            ? (JSON.parse(e.before_json) as EntrySnapshot)
            : { ...current, state: "source_only" as const };
          const size = db
            .prepare(
              "SELECT o.raw_size FROM kml_objects o JOIN track_versions v ON v.sha256=o.sha256 WHERE v.id=?",
            )
            .get(restored.version_id) as { raw_size: number } | undefined;
          if (
            !size ||
            artifacts.reduce((n, a) => n + a.raw.length, 0) + size.raw_size >
              MAX_KML_BYTES
          )
            throw new AppError(
              "USER_INPUT",
              "恢复组输入不存在或总量超过 128 MiB",
            );
          const source = versionInput(
            db,
            restored.entry_id,
            restored.version_id,
            restored.presentation_id,
          );
          artifacts.push({
            ...source,
            path: restored.path,
            state: restored.state,
          });
          changes.push(noChanges());
          checkArtifacts(artifacts);
        }
      });
    } else {
      if (!("target" in request)) throw new Error("Missing target");
      if (before[0]!.state !== "active")
        throw new AppError(
          "USER_INPUT",
          "请通过撤销原操作组恢复非活动行程，避免新旧行程同时展示",
        );
      const op = request.operation;
      if (op.kind === "restore_version") {
        if (request.sources.length)
          throw new AppError("USER_INPUT", "恢复版本不接受额外来源");
        const source = readTransaction(file, (db) =>
          versionInput(
            db,
            request.target.entry_id,
            op.version_id,
            op.presentation_id,
          ),
        );
        artifacts.push({ ...source, path: before[0]!.path, state: "active" });
        changes.push(noChanges());
        publish = {
          archive_id: request.archive_id,
          request_key: id,
          kind: "restore",
          algorithm_version: "restore-version-v2",
          params: { operation: op },
          inputs: [request.target],
          historical_inputs: [
            { version_id: op.version_id, sha256: digest(source.raw) },
          ],
          outputs: [
            {
              kind: "version",
              entry_id: request.target.entry_id,
              path: before[0]!.path,
              category: before[0]!.category,
              raw: source.raw,
              settings: source.settings,
              segment_ids: source.segments.map((s) => s.segment_id),
              source_kinds: Object.fromEntries(
                source.segments.map((s) => [s.ordinal, s.source_kind]),
              ),
              sources: source.segments.map((s) => ({
                ordinal: s.ordinal,
                source_version_id: source.version_id,
                source_segment_id: s.segment_id,
                start: 0,
                end_exclusive: s.point_count,
                evidence_kind: "exact",
                evidence: { restored: true },
              })),
            },
          ],
        };
      } else if (op.kind === "split_journey") {
        if (request.sources.length)
          throw new AppError("USER_INPUT", "拆分行程不接受额外来源");
        const source = readTransaction(file, (db) =>
          versionInput(
            db,
            request.target.entry_id,
            request.target.version_id,
            request.target.presentation_id,
          ),
        );
        const ids = op.outputs.flatMap((o) => o.segment_ids),
          paths = op.outputs.map((o) => memberName(o.path));
        if (
          new Set(ids).size !== ids.length ||
          ids.length !== source.segments.length ||
          ids.some((id) => !source.settings.order.includes(id))
        )
          throw new AppError(
            "USER_INPUT",
            "每个段必须且只能分配到一个新行程；先内部断段再分配",
          );
        if (
          new Set(paths).size !== paths.length ||
          paths.some((p) => !p.toLowerCase().endsWith(".kml"))
        )
          throw new AppError("USER_INPUT", "新行程路径必须是不同的 KML 路径");
        readTransaction(file, (db) => {
          for (const p of paths)
            if (db.prepare("SELECT 1 FROM archive_entries WHERE path=?").get(p))
              throw new AppError("USER_INPUT", `轨迹路径已存在：${p}`);
        });
        publish = {
          archive_id: request.archive_id,
          request_key: id,
          kind: "split_journey",
          algorithm_version: "split-journey-v1",
          params: { operation: op },
          inputs: [request.target],
          outputs: [
            {
              kind: "state",
              entry_id: request.target.entry_id,
              state: "superseded",
            },
          ],
        };
        for (const [i, out] of op.outputs.entries()) {
          const prepared = await prepareSegmentEdit(
            file,
            {
              archive_id: request.archive_id,
              request_key: `${id}:${i}`,
              target: request.target,
              operation: {
                kind: "compose",
                segments: out.segment_ids.map((segment_id) => ({
                  version_id: source.version_id,
                  segment_id,
                })),
                default_connect: source.settings.default_connect,
              },
            },
            signal,
          );
          const settings = {
            ...source.settings,
            order: out.segment_ids,
            ignored: source.settings.ignored.filter((s) =>
              out.segment_ids.includes(s),
            ),
            connections: source.settings.connections.filter(
              (e) =>
                out.segment_ids.includes(e.from) &&
                out.segment_ids.includes(e.to),
            ),
          };
          // Preserve only original logical neighbours; a removed intermediate must not invent a new default edge.
          for (let j = 1; j < out.segment_ids.length; j++) {
            const a = out.segment_ids[j - 1]!,
              b = out.segment_ids[j]!;
            if (
              source.settings.order.indexOf(b) !==
                source.settings.order.indexOf(a) + 1 &&
              !settings.connections.some((e) => e.from === a && e.to === b)
            )
              settings.connections.push({ from: a, to: b, connect: false });
          }
          const output = prepared.publish.outputs[0]!;
          if (output.kind !== "version")
            throw new Error("Expected content output");
          const { entry_id: _entry, ...rest } = output;
          void _entry;
          publish.outputs.push({
            ...rest,
            path: out.path,
            category: out.category,
            settings,
          });
          artifacts.push({
            ...prepared.result,
            settings,
            path: out.path,
            state: "active",
          });
          changes.push(prepared.result.changes);
          checkArtifacts(artifacts);
        }
      } else {
        const prepared = await prepareSegmentEdit(
          file,
          {
            archive_id: request.archive_id,
            request_key: id,
            target: request.target,
            sources: request.sources,
            operation: op,
          },
          signal,
        );
        publish = prepared.publish;
        artifacts.push({
          ...prepared.result,
          path: before[0]!.path,
          state: "active",
        });
        changes.push(prepared.result.changes);
      }
    }
    checkCancelled(signal);
    if (artifacts.reduce((n, a) => n + a.raw.length, 0) > MAX_KML_BYTES)
      throw new AppError("USER_INPUT", "预览产物总量超过 128 MiB");
    if (
      artifacts.reduce(
        (n, a) => n + a.segments.reduce((n, s) => n + s.point_count, 0),
        0,
      ) > 2_000_000
    )
      throw new AppError("USER_INPUT", "预览产物总点数超过 200 万");
    // Recheck targets after asynchronous XML work; unrelated archive revisions do not invalidate a preview.
    readTransaction(file, (db) => {
      if (archiveId(db) !== request.archive_id)
        fail("SOURCE_CHANGED", "轨迹库已切换");
      for (const ref of before) checkRef(db, ref);
    });
    const objects = artifacts.map((a) => ({
      sha256: digest(a.raw),
      size: a.raw.length,
    }));
    const wire = publish
      ? {
          ...publish,
          outputs: publish.outputs.map((o) => {
            if (o.kind !== "version") return o;
            const { raw, ...rest } = o;
            const object = objects.findIndex((a) => a.sha256 === digest(raw));
            if (object < 0) throw new Error("Missing artifact");
            return { ...rest, object };
          }),
        }
      : undefined;
    const manifest: Manifest = {
      preview_id: id,
      archive_id: request.archive_id,
      created_at: new Date(this.now()).toISOString(),
      expires_at: new Date(this.now() + 86400000).toISOString(),
      algorithm_version: "edit-preview-v1",
      request,
      operation: request.operation,
      before,
      outputs: artifacts.map((a) => ({
        path: a.path,
        state: a.state,
        sha256: digest(a.raw),
        segments: a.segments,
        settings: a.settings,
      })),
      changes,
      objects,
      ...(wire ? { publish: wire } : {}),
    };
    const sha = hashJson(manifest);
    this.db
      .transaction(() => {
        this.db
          .prepare(
            "DELETE FROM edit_preview_objects WHERE preview_id IN (SELECT id FROM edit_previews WHERE expires_at<?)",
          )
          .run(this.now());
        this.db
          .prepare("DELETE FROM edit_previews WHERE expires_at<?")
          .run(this.now());
        const { bytes } = this.db
          .prepare(
            "SELECT coalesce(sum(length(raw)),0) bytes FROM edit_preview_objects",
          )
          .get() as { bytes: number };
        if (
          bytes + objects.reduce((n, o) => n + o.size, 0) >
          1024 * 1024 * 1024
        )
          throw new AppError(
            "USER_INPUT",
            "未过期预览已占用 1 GiB，请稍后或清理预览状态后重试",
          );
        this.db
          .prepare("INSERT INTO edit_previews VALUES (?,?,?,?,?)")
          .run(
            id,
            request.archive_id,
            Date.parse(manifest.expires_at),
            sha,
            canonical(manifest),
          );
        artifacts.forEach((a, i) =>
          this.db
            .prepare("INSERT INTO edit_preview_objects VALUES (?,?,?)")
            .run(id, i, a.raw),
        );
      })
      .immediate();
    return this.summary(manifest, sha);
  }
  private summary(m: Manifest, sha: string): EditPreview {
    const { publish, objects, request, algorithm_version, ...summary } = m;
    void publish;
    void objects;
    void request;
    void algorithm_version;
    return { ...summary, preview_sha256: sha };
  }
  private read(file: string, id: string, expected?: string) {
    const row = this.db
      .prepare("SELECT manifest,sha256 FROM edit_previews WHERE id=?")
      .get(id) as { manifest: string; sha256: string } | undefined;
    if (!row) fail("PREVIEW_EXPIRED", "预览不存在或已清理，请重新预览");
    const m = JSON.parse(row.manifest) as Manifest;
    if (
      hashJson(m) !== row.sha256 ||
      (expected && expected !== row.sha256) ||
      m.preview_id !== id
    )
      fail("PREVIEW_CHANGED", "预览清单校验失败");
    readTransaction(file, (db) => {
      requireVersioned(db);
      if (archiveId(db) !== m.archive_id)
        fail("SOURCE_CHANGED", "轨迹库已切换");
    });
    if (Date.parse(m.expires_at) < this.now())
      fail("PREVIEW_EXPIRED", "预览已过期，请重新预览");
    if (m.algorithm_version !== "edit-preview-v1")
      fail("PREVIEW_CHANGED", "预览算法版本不再支持");
    return { m, sha: row.sha256 };
  }
  get(file: string, id: string) {
    const { m, sha } = this.read(file, id);
    return this.summary(m, sha);
  }
  private object(id: string, index: number, m: Manifest): Uint8Array {
    const expected = m.objects[index],
      row = this.db
        .prepare(
          "SELECT raw FROM edit_preview_objects WHERE preview_id=? AND ordinal=?",
        )
        .get(id, index) as { raw: Buffer } | undefined;
    if (
      !expected ||
      !row ||
      row.raw.length !== expected.size ||
      digest(row.raw) !== expected.sha256
    )
      fail("PREVIEW_CHANGED", "预览 KML 产物校验失败");
    return row.raw;
  }
  raw(file: string, id: string, index: number) {
    const { m } = this.read(file, id);
    return this.object(id, index, m);
  }
  async geometry(
    file: string,
    id: string,
    index: number,
    signal?: AbortSignal,
    before = false,
  ) {
    const { m } = this.read(file, id),
      out = m.outputs[index];
    if (before) {
      const e = m.before[Math.min(index, m.before.length - 1)];
      if (!e) throw new AppError("USER_INPUT", "输入不存在");
      const input = readTransaction(file, (db) =>
        versionInput(db, e.entry_id, e.version_id, e.presentation_id),
      );
      return inputGeometry(input, signal);
    }
    if (!out) throw new AppError("USER_INPUT", "输出不存在");
    return inputGeometry(
      {
        version_id: id,
        raw: this.object(id, index, m),
        segments: out.segments,
        settings: out.settings,
      },
      signal,
    );
  }
  apply(file: string, input: EditApply, signal?: AbortSignal): PublishResult {
    const request = EditApplySchema.parse(input);
    checkCancelled(signal);
    // Archive receipt survives preview expiry, cleanup, restart and loss of task completion.
    const prior = readTransaction(file, (db) => {
      requireVersioned(db);
      if (archiveId(db) !== request.archive_id)
        fail("SOURCE_CHANGED", "轨迹库已切换");
      const row = db
        .prepare(
          "SELECT id,params_json,result_json FROM track_operations WHERE request_key=?",
        )
        .get(request.request_key) as
        { id: string; params_json: string; result_json: string } | undefined;
      if (!row) return;
      const params = JSON.parse(row.params_json) as {
        preview_id?: string;
        preview_sha256?: string;
      };
      if (
        params.preview_id !== request.preview_id ||
        params.preview_sha256 !== request.preview_sha256
      )
        fail("IDEMPOTENCY_CONFLICT", "请求键已用于不同的操作");
      if (
        db
          .prepare(
            "SELECT 1 FROM track_operation_deletions WHERE operation_id=?",
          )
          .get(row.id)
      )
        fail("RESTORE_DEPENDENCY_CHANGED", "操作包含已删除条目，不能回放");
      return JSON.parse(row.result_json) as PublishResult;
    });
    if (prior) return prior;
    const { m } = this.read(file, request.preview_id, request.preview_sha256);
    if (m.archive_id !== request.archive_id)
      fail("SOURCE_CHANGED", "预览不属于该轨迹库");
    // Check every object, including presentation-only previews and group restores.
    const objects = m.objects.map((_, i) =>
      this.object(request.preview_id, i, m),
    );
    const context = {
      preview_id: request.preview_id,
      preview_sha256: request.preview_sha256,
    };
    checkCancelled(signal);
    try {
      if (m.request.operation.kind === "restore_group")
        return new VersionStore(file).restore(
          request.archive_id,
          m.request.operation.operation_id,
          request.request_key,
          m.request.operation.expected,
          context,
        );
      if (!m.publish) throw new Error("Missing prepared request");
      const prepared: PublishRequest = {
        ...m.publish,
        request_key: request.request_key,
        params: { ...m.publish.params, ...context },
        outputs: m.publish.outputs.map((o) => {
          if (o.kind !== "version") return o;
          const { object, ...rest } = o;
          return { ...rest, raw: objects[object]! };
        }),
      };
      return new VersionStore(file).publish(prepared);
    } catch (error) {
      if (error instanceof AppError && error.code === "USER_INPUT")
        fail("SOURCE_CHANGED", error.message);
      throw error;
    }
  }
}
