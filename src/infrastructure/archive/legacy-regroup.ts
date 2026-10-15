import { AppError } from "../../domain/errors.js";
import { memberName } from "../../domain/archive.js";
import { MAX_KML_BYTES } from "../../domain/trackdata.js";
import { resolvedEdges } from "../../domain/presentation.js";
import { validatePresentation } from "../../domain/track-version.js";
import type { EditRequest } from "../../shared/track-edit.js";
import { readTransaction } from "./database.js";
import { archiveId, checkRef, type PublishRequest } from "./versions.js";
import { versionInput } from "./track-reader.js";
import { prepareSegmentEdit } from "./segment-editor.js";

type Regroup = Extract<EditRequest["operation"], { kind: "legacy_regroup" }>;
/** Reuse complete legacy results, preserving visibility and within-file edges. */
export async function prepareLegacyRegroup(
  file: string,
  archive: string,
  key: string,
  op: Regroup,
  signal?: AbortSignal,
) {
  const loaded = readTransaction(file, (db) => {
    if (archiveId(db) !== archive)
      throw new AppError("USER_INPUT", "轨迹库已切换");
    if (new Set(op.expected.map((r) => r.entry_id)).size !== op.expected.length)
      throw new AppError("USER_INPUT", "重组成员重复");
    const entries = op.expected.map((r) => checkRef(db, r));
    if (entries.some((e) => e.state !== "active"))
      throw new AppError("USER_INPUT", "重组只接受活动行程");
    if (entries.some((e) => e.category !== op.category))
      throw new AppError("USER_INPUT", "不同分类保持独立，重组不改分类");
    const path = memberName(op.path);
    if (
      !path.toLowerCase().endsWith(".kml") ||
      db.prepare("SELECT 1 FROM archive_entries WHERE path=?").get(path)
    )
      throw new AppError("USER_INPUT", "重组需要新的 KML 路径");
    const bytes = entries.reduce(
      (n, e) =>
        n +
        (
          db
            .prepare("SELECT raw_size FROM kml_objects WHERE sha256=?")
            .get(e.sha256) as { raw_size: number }
        ).raw_size,
      0,
    );
    if (bytes > MAX_KML_BYTES)
      throw new AppError("USER_INPUT", "重组输入总量超过 128 MiB");
    const inputs = entries.map((e) =>
      versionInput(db, e.entry_id, e.version_id, e.presentation_id),
    );
    const available = new Set(
      inputs.flatMap((s) =>
        s.segments.map((g) => JSON.stringify([s.version_id, g.segment_id])),
      ),
    );
    const selected = op.segments.map((s) =>
      JSON.stringify([s.version_id, s.segment_id]),
    );
    if (
      new Set(selected).size !== selected.length ||
      selected.length !== available.size ||
      selected.some((s) => !available.has(s))
    )
      throw new AppError(
        "USER_INPUT",
        "重组必须且只能保留每个成员的全部段一次；独立规划请排除整个成员",
      );
    // Preserve each member's existing relative order; only interleave different members.
    for (const s of inputs) {
      const order = op.segments
        .filter((g) => g.version_id === s.version_id)
        .map((g) => g.segment_id);
      if (order.some((id, i) => id !== s.settings.order[i]))
        throw new AppError("USER_INPUT", "重组不能改变原成员内部段顺序");
    }
    return inputs;
  });
  const target = op.expected[0]!,
    sources = op.expected.slice(1).map(({ generation, ...r }) => {
      void generation;
      return r;
    });
  const prepared = await prepareSegmentEdit(
    file,
    {
      archive_id: archive,
      request_key: key,
      target,
      sources,
      operation: {
        kind: "compose",
        segments: op.segments,
        default_connect: false,
      },
    },
    signal,
  );
  const { result } = prepared;
  const ids = new Map(
    op.segments.map((s, i) => [
      JSON.stringify([s.version_id, s.segment_id]),
      result.segments[i]!.segment_id,
    ]),
  );
  const mapped = (version: string, segment: string) =>
    ids.get(JSON.stringify([version, segment]))!;
  const settings = validatePresentation(
    {
      schema: 1,
      default_connect: false,
      order: result.segments.map((s) => s.segment_id),
      ignored: loaded.flatMap((s) =>
        s.settings.ignored.map((id) => mapped(s.version_id, id)),
      ),
      connections: loaded.flatMap((s) =>
        resolvedEdges(
          { ...s.settings, ignored: [] },
          s.segments.map((g) => g.segment_id),
        ).map((e) => ({
          from: mapped(s.version_id, e.from),
          to: mapped(s.version_id, e.to),
          connect: true,
        })),
      ),
    },
    result.segments.map((s) => s.segment_id),
  );
  result.settings = settings;
  result.changes = {
    added_points: 0,
    removed_points: 0,
    removed_ranges: [],
    removed_connections: [],
    before_edges: resolvedEdges(settings, settings.order),
    after_edges: resolvedEdges(settings, settings.order),
    warnings: ["保留原段及原展示；不自动连接不同文件，不推断来源种类。"],
  };
  const output = prepared.publish.outputs[0]!;
  if (output.kind !== "version") throw new Error("Expected regroup content");
  const { entry_id, ...content } = output;
  void entry_id;
  const publish: PublishRequest = {
    archive_id: archive,
    request_key: key,
    kind: "legacy_regroup",
    algorithm_version: "legacy-regroup-v1",
    params: { operation: op },
    inputs: op.expected,
    outputs: [
      ...op.expected.map((r) => ({
        kind: "state" as const,
        entry_id: r.entry_id,
        state: "superseded" as const,
      })),
      { ...content, path: op.path, category: op.category, settings },
    ],
  };
  return { publish, result };
}
