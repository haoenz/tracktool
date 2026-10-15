import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EditRequestSchema, EditApplySchema } from "../shared/track-edit.js";
import { ArchiveRefSchema } from "../shared/archive-actions.js";
import { AppError } from "../domain/errors.js";
import {
  bindSegments,
  detectSegmentDrift,
  detectSegmentGaps,
} from "../domain/presentation.js";
import { EditPreviews } from "../infrastructure/archive/edit-previews.js";
import { TaskQueue } from "../infrastructure/task-queue.js";
import {
  archiveId,
  checkRef,
  currentEntry,
} from "../infrastructure/archive/versions.js";
import {
  readTransaction,
  rawObject,
} from "../infrastructure/archive/database.js";
import {
  trackCatalog,
  trackDetail,
  trackHistory,
  operationDetail,
  versionInput,
  inputGeometry,
  requireVersioned,
} from "../infrastructure/archive/track-reader.js";
import { XmlWorkers } from "../infrastructure/xml/client.js";

const id = z.string().min(1).max(200),
  page = z.object({
    cursor: z.coerce.number().int().min(0).max(1000000).default(0),
  });
export function trackRoutes(
  app: FastifyInstance,
  get: () => Promise<{ queue: TaskQueue; edits: EditPreviews; file: string }>,
) {
  app.get("/api/tracks", async (req) => {
    const q = page
      .extend({ search: z.string().max(200).default("") })
      .parse(req.query);
    return trackCatalog((await get()).file, q.search, q.cursor);
  });
  app.get("/api/tracks/:entryId", async (req) => {
    const p = z.object({ entryId: id }).parse(req.params);
    const q = page.parse(req.query);
    return trackDetail(
      (await get()).file,
      p.entryId,
      undefined,
      undefined,
      q.cursor,
    );
  });
  app.get("/api/tracks/:entryId/versions", async (req) => {
    const p = z.object({ entryId: id }).parse(req.params);
    return trackHistory(
      (await get()).file,
      p.entryId,
      page.parse(req.query).cursor,
    );
  });
  app.get("/api/tracks/:entryId/versions/:versionId", async (req) => {
    const p = z.object({ entryId: id, versionId: id }).parse(req.params),
      q = page.extend({ presentation_id: id.optional() }).parse(req.query);
    return trackDetail(
      (await get()).file,
      p.entryId,
      p.versionId,
      q.presentation_id,
      q.cursor,
    );
  });
  app.get(
    "/api/tracks/:entryId/versions/:versionId/raw",
    async (req, reply) => {
      const p = z.object({ entryId: id, versionId: id }).parse(req.params);
      const raw = readTransaction((await get()).file, (db) => {
        requireVersioned(db);
        const row = db
          .prepare(
            "SELECT sha256 FROM track_versions WHERE entry_id=? AND id=?",
          )
          .get(p.entryId, p.versionId) as { sha256: string } | undefined;
        if (!row) throw new AppError("USER_INPUT", "版本不存在");
        return rawObject(db, row.sha256);
      });
      return reply
        .type("application/vnd.google-earth.kml+xml")
        .header("Content-Disposition", 'attachment; filename="track.kml"')
        .send(Buffer.from(raw));
    },
  );
  app.get("/api/tracks/:entryId/sources", async (req) => {
    const p = z.object({ entryId: id }).parse(req.params),
      q = page.parse(req.query);
    return readTransaction((await get()).file, (db) => {
      requireVersioned(db);
      currentEntry(db, p.entryId);
      const locations = db
        .prepare(
          "SELECT l.* FROM track_source_locations l JOIN track_versions v ON v.id=l.version_id WHERE v.entry_id=? ORDER BY l.rowid LIMIT 101 OFFSET ?",
        )
        .all(p.entryId, q.cursor);
      const lineage = db
        .prepare(
          "SELECT s.*,v.entry_id AS source_entry_id FROM track_segment_sources s JOIN track_versions o ON o.id=s.version_id JOIN track_versions v ON v.id=s.source_version_id WHERE o.entry_id=? ORDER BY s.rowid LIMIT 101 OFFSET ?",
        )
        .all(p.entryId, q.cursor);
      return {
        locations: locations.slice(0, 100),
        lineage: lineage.slice(0, 100),
        next_cursor:
          locations.length > 100 || lineage.length > 100
            ? q.cursor + 100
            : null,
      };
    });
  });
  app.get("/api/tracks/operations/:operationId", async (req) =>
    operationDetail(
      (await get()).file,
      z.object({ operationId: id }).parse(req.params).operationId,
    ),
  );
  app.get("/api/tracks/:entryId/geometry", async (req) => {
    const p = z.object({ entryId: id }).parse(req.params),
      q = z
        .object({ version_id: id.optional(), presentation_id: id.optional() })
        .parse(req.query);
    const input = readTransaction((await get()).file, (db) => {
      requireVersioned(db);
      const e = currentEntry(db, p.entryId);
      return versionInput(
        db,
        e.entry_id,
        q.version_id ?? e.version_id,
        q.presentation_id ?? e.presentation_id,
      );
    });
    return inputGeometry(input);
  });
  app.post("/api/tracks/detect", async (req) => {
    const q = z
      .object({
        archive_id: id,
        target: ArchiveRefSchema,
        segment_id: id,
        kind: z.enum(["gaps", "drift"]),
        options: z
          .object({
            gapSeconds: z.number().nonnegative().default(300),
            gapMeters: z.number().nonnegative().default(500),
            speedMps: z.number().nonnegative().default(30),
            jumpMeters: z.number().nonnegative().default(100),
            returnMeters: z.number().nonnegative().default(30),
            maxSeconds: z.number().nonnegative().default(120),
          })
          .strict()
          .default({
            gapSeconds: 300,
            gapMeters: 500,
            speedMps: 30,
            jumpMeters: 100,
            returnMeters: 30,
            maxSeconds: 120,
          }),
      })
      .strict()
      .parse(req.body);
    const input = readTransaction((await get()).file, (db) => {
      requireVersioned(db);
      if (archiveId(db) !== q.archive_id)
        throw new AppError("USER_INPUT", "轨迹库已切换");
      checkRef(db, q.target);
      return versionInput(
        db,
        q.target.entry_id,
        q.target.version_id,
        q.target.presentation_id,
      );
    });
    const xml = new XmlWorkers(1, 0);
    try {
      const data = (
        await xml.run(input.raw, { kind: "tracks", source: "detect" })
      ).tracks!;
      const s = bindSegments(data, input.segments).find(
        (s) => s.segment_id === q.segment_id,
      );
      if (!s) throw new AppError("USER_INPUT", "未知段");
      return q.kind === "gaps"
        ? { after_point_indices: detectSegmentGaps(s, q.options) }
        : { ranges: detectSegmentDrift(s, q.options) };
    } finally {
      await xml.close();
    }
  });
  app.post("/api/tracks/edit-previews", async (req, reply) => {
    const input = EditRequestSchema.parse(req.body),
      preview_id = randomUUID(),
      { queue } = await get();
    const task = await queue.preview({
      operation: "track:preview",
      inputs: [],
      options: { trackPreview: { id: preview_id, request: input } },
    });
    return reply.code(202).send({ task_id: task.id, preview_id });
  });
  app.get("/api/tracks/edit-previews/:previewId", async (req) => {
    const p = z.object({ previewId: z.string().uuid() }).parse(req.params),
      { edits, file } = await get();
    return edits.get(file, p.previewId);
  });
  app.get("/api/tracks/edit-previews/:previewId/geometry", async (req) => {
    const p = z.object({ previewId: z.string().uuid() }).parse(req.params),
      q = z
        .object({
          index: z.coerce.number().int().min(0).max(100).default(0),
          before: z.enum(["true", "false"]).default("false"),
        })
        .parse(req.query),
      { edits, file } = await get();
    return edits.geometry(
      file,
      p.previewId,
      q.index,
      undefined,
      q.before === "true",
    );
  });
  app.get("/api/tracks/edit-previews/:previewId/raw", async (req, reply) => {
    const p = z.object({ previewId: z.string().uuid() }).parse(req.params),
      q = z
        .object({ index: z.coerce.number().int().min(0).max(100).default(0) })
        .parse(req.query),
      { edits, file } = await get();
    return reply
      .type("application/vnd.google-earth.kml+xml")
      .header("Content-Disposition", 'attachment; filename="preview.kml"')
      .send(Buffer.from(edits.raw(file, p.previewId, q.index)));
  });
  app.post("/api/tracks/edit-previews/:previewId/apply", async (req, reply) => {
    const p = z.object({ previewId: z.string().uuid() }).parse(req.params),
      input = EditApplySchema.parse(req.body);
    if (p.previewId !== input.preview_id)
      throw new AppError("USER_INPUT", "预览标识不一致");
    const task = await (await get()).queue.applyEdit(input);
    return reply.code(202).send({ task_id: task.id });
  });
}
