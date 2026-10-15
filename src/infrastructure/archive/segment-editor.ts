import { z } from "zod";
import { AppError } from "../../domain/errors.js";
import { MAX_KML_BYTES } from "../../domain/trackdata.js";
import {
  SegmentEditSchema,
  type SegmentInput,
} from "../../domain/segment-edit.js";
import {
  validatePresentation,
  type SegmentManifest,
} from "../../domain/track-version.js";
import { ArchiveRefSchema } from "../../shared/archive-actions.js";
import type { XmlPort } from "../../services/ports.js";
import { XmlWorkers } from "../xml/client.js";
import { readTransaction, rawObject } from "./database.js";
import { archiveId, checkRef, type PublishRequest } from "./versions.js";
import { presentationDigest } from "./identity.js";

const id = z.string().min(1).max(200);
const historical = z
  .object({
    entry_id: id,
    version_id: id,
    presentation_id: id,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const SegmentEditRequestSchema = z
  .object({
    archive_id: id,
    request_key: id,
    target: ArchiveRefSchema,
    sources: z.array(historical).max(1000).default([]),
    operation: SegmentEditSchema,
  })
  .strict();
export type SegmentEditRequest = z.input<typeof SegmentEditRequestSchema>;
/** Read-only preparation for P3's persistent preview workflow. Publish only the returned checked artifact. */
export async function prepareSegmentEdit(
  file: string,
  input: SegmentEditRequest,
  signal?: AbortSignal,
  port?: XmlPort,
) {
  const parsed = SegmentEditRequestSchema.safeParse(input);
  if (!parsed.success) throw new AppError("USER_INPUT", parsed.error.message);
  const request = parsed.data;
  const loaded = readTransaction(file, (db) => {
    if (archiveId(db) !== request.archive_id)
      throw new AppError("USER_INPUT", "Archive identity changed");
    const target = checkRef(db, request.target);
    if (target.state !== "active")
      throw new AppError(
        "USER_INPUT",
        "Editing requires an active target entry",
      );
    const refs = [request.target, ...request.sources];
    if (new Set(refs.map((r) => r.version_id)).size !== refs.length)
      throw new AppError("USER_INPUT", "Duplicate edit source version");
    if (request.operation.kind !== "compose" && request.sources.length)
      throw new AppError(
        "USER_INPUT",
        "Additional sources require composition",
      );
    let sourceBytes = 0;
    const sources: SegmentInput[] = refs.map((ref) => {
      const row = db
        .prepare(
          `SELECT v.sha256,v.manifest_status,p.settings_json,p.settings_sha256,o.raw_size FROM track_versions v JOIN track_presentations p ON p.version_id=v.id JOIN kml_objects o ON o.sha256=v.sha256 WHERE v.id=? AND v.entry_id=? AND p.id=?`,
        )
        .get(ref.version_id, ref.entry_id, ref.presentation_id) as
        | {
            sha256: string;
            manifest_status: string;
            settings_json: string;
            settings_sha256: string;
            raw_size: number;
          }
        | undefined;
      if (!row || row.sha256 !== ref.sha256 || row.manifest_status !== "ready")
        throw new AppError(
          "USER_INPUT",
          "Source version, presentation or content is unavailable",
        );
      sourceBytes += row.raw_size;
      if (sourceBytes > MAX_KML_BYTES)
        throw new AppError("USER_INPUT", "Composition inputs exceed 128 MiB");
      const segments = (
        db
          .prepare(
            "SELECT segment_id,ordinal,locator_json,geometry_kind,source_kind,point_count,time_status FROM track_segments WHERE version_id=? ORDER BY ordinal",
          )
          .all(ref.version_id) as (Omit<SegmentManifest, "locator"> & {
          locator_json: string;
        })[]
      ).map(({ locator_json, ...s }) => ({
        ...s,
        locator: JSON.parse(locator_json) as number[],
      }));
      const settings = validatePresentation(
        JSON.parse(row.settings_json),
        segments.map((s) => s.segment_id),
      );
      if (presentationDigest(settings) !== row.settings_sha256)
        throw new AppError("USER_INPUT", "Presentation checksum mismatch");
      return {
        version_id: ref.version_id,
        raw: rawObject(db, row.sha256),
        segments,
        settings,
      };
    });
    return { target, sources };
  });
  const owned = port ? undefined : new XmlWorkers(1, 0),
    xml = port ?? owned!;
  try {
    const [source, ...additional] = loaded.sources;
    const result = (
      await xml.run(
        source!.raw,
        {
          kind: "segment-edit",
          input: {
            version_id: source!.version_id,
            segments: source!.segments,
            settings: source!.settings,
          },
          operation: request.operation,
          seed: `${request.archive_id}:${request.request_key}`,
          additional,
        },
        signal,
      )
    ).segment_edit!;
    const usedVersions = new Set(
      result.sources.map((s) => s.source_version_id),
    );
    const publish: PublishRequest = {
      archive_id: request.archive_id,
      request_key: request.request_key,
      kind:
        request.operation.kind === "reverse"
          ? "compose"
          : request.operation.kind,
      algorithm_version: "segments-v1",
      params: { operation: request.operation },
      inputs: [request.target],
      historical_inputs: request.sources
        .filter((s) => usedVersions.has(s.version_id))
        .map((s) => ({ version_id: s.version_id, sha256: s.sha256 })),
      outputs:
        request.operation.kind === "presentation"
          ? [
              {
                kind: "presentation",
                entry_id: request.target.entry_id,
                settings: result.settings,
              },
            ]
          : [
              {
                kind: "version",
                entry_id: request.target.entry_id,
                path: loaded.target.path,
                category: loaded.target.category,
                raw: result.raw,
                segment_ids: result.segments.map((s) => s.segment_id),
                source_kinds: Object.fromEntries(
                  result.segments.map((s) => [s.ordinal, s.source_kind]),
                ),
                sources: result.sources,
                settings: result.settings,
              },
            ],
    };
    return { publish, result };
  } finally {
    await owned?.close();
  }
}
