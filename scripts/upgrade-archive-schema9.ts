import Database from "better-sqlite3";
import { linkSync, mkdirSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { AppError } from "../dist/node/domain/errors.js";
import { validatePresentation } from "../dist/node/domain/track-version.js";
import {
  SCHEMA,
  SCHEMA_VERSION,
} from "../dist/node/infrastructure/archive/schema.js";
import {
  canonical,
  hashJson,
  presentationDigest,
} from "../dist/node/infrastructure/archive/identity.js";
import {
  removeStaging,
  verifyArchive,
} from "../dist/node/infrastructure/archive/full-backup.js";
import {
  present,
  syncDirectory,
  syncFile,
  temporary,
} from "../dist/node/infrastructure/durable-files.js";

const legacy = z
  .object({
    schema: z.literal(1),
    default_connect: z.boolean(),
    order: z.array(z.string()),
    ignored: z.array(z.string()),
    connections: z.array(
      z
        .object({ from: z.string(), to: z.string(), connect: z.boolean() })
        .strict(),
    ),
  })
  .strict();
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';

/** Offline conversion only. The application continues to accept just its current schema. */
export async function upgradeSchema9(sourceFile: string, output: string) {
  if (SCHEMA_VERSION !== 10)
    throw new AppError("USER_INPUT", "此一次性工具只用于升级到 schema 10");
  if (!output.endsWith(".sqlite3") || present(output))
    throw new AppError(
      "USER_INPUT",
      "升级目标必须是不存在的 .sqlite3 文件，不能覆盖旧库",
    );
  const source = new Database(sourceFile, {
    readonly: true,
    fileMustExist: true,
  });
  const snapshot = temporary(output),
    stage = temporary(output);
  let db: Database.Database | undefined;
  try {
    mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    // SQLite's backup API includes committed WAL content without rewriting the source.
    closeSync(openSync(snapshot, "wx", 0o600));
    closeSync(openSync(stage, "wx", 0o600));
    await source.backup(snapshot);
    db = new Database(stage);
    db.pragma("synchronous=FULL");
    db.exec(SCHEMA);
    db.prepare("ATTACH DATABASE ? AS old").run(snapshot);
    if (db.pragma("old.user_version", { simple: true }) !== 9)
      throw new AppError("USER_INPUT", "源文件必须是 schema 9 轨迹库");
    if (
      db.pragma("old.integrity_check", { simple: true }) !== "ok" ||
      (db.pragma("old.foreign_key_check") as unknown[]).length
    )
      throw new AppError("USER_INPUT", "源轨迹库完整性校验失败");
    const tables = (schema: string) =>
      db!
        .prepare(
          `SELECT name FROM ${schema}.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all() as { name: string }[];
    const original = tables("old");
    if (
      JSON.stringify(original) !==
      JSON.stringify(
        tables("main").filter((t) => t.name !== "track_gap_annotations"),
      )
    )
      throw new AppError("USER_INPUT", "源轨迹库表结构不符合 schema 9");
    if (db.prepare("SELECT 1 FROM old.file_operations LIMIT 1").get())
      throw new AppError(
        "USER_INPUT",
        "旧库存在未完成文件操作，请先用旧版完成恢复",
      );
    const triggers = db
      .prepare("SELECT name,sql FROM main.sqlite_schema WHERE type='trigger'")
      .all() as { name: string; sql: string }[];
    // The archive has cyclic entry/version/snapshot references. Validate the complete graph before publishing.
    db.pragma("foreign_keys=OFF");
    db.exec("BEGIN IMMEDIATE");
    for (const trigger of triggers)
      db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    const counts: Record<string, number> = {};
    for (const { name } of original) {
      const columns = (schema: string) =>
        (
          db!.pragma(`${schema}.table_info(${quote(name)})`) as {
            name: string;
          }[]
        ).map((c) => c.name);
      if (JSON.stringify(columns("main")) !== JSON.stringify(columns("old")))
        throw new AppError("USER_INPUT", `旧表字段不匹配：${name}`);
      db.exec(
        `INSERT INTO main.${quote(name)} SELECT * FROM old.${quote(name)}`,
      );
      counts[name] = (
        db.prepare(`SELECT count(*) AS n FROM main.${quote(name)}`).get() as {
          n: number;
        }
      ).n;
    }
    let unclassifiedConnections = 0;
    for (const row of db
      .prepare(
        "SELECT id,version_id,settings_json,settings_sha256 FROM track_presentations",
      )
      .all() as {
      id: string;
      version_id: string;
      settings_json: string;
      settings_sha256: string;
    }[]) {
      const settings = legacy.parse(JSON.parse(row.settings_json));
      const positions = new Map(settings.order.map((id, i) => [id, i]));
      const seen = new Set<string>();
      const edges = new Map<string, boolean>();
      for (let i = 1; i < settings.order.length; i++)
        edges.set(
          JSON.stringify([settings.order[i - 1], settings.order[i]]),
          settings.default_connect,
        );
      for (const edge of settings.connections) {
        const key = JSON.stringify([edge.from, edge.to]);
        if (
          seen.has(key) ||
          !positions.has(edge.from) ||
          !positions.has(edge.to) ||
          positions.get(edge.from)! >= positions.get(edge.to)!
        )
          throw new AppError("USER_INPUT", "旧连接设置无效");
        seen.add(key);
        edges.set(key, edge.connect);
      }
      const ordered = [...settings.connections].sort((a, b) => {
        const x = JSON.stringify([a.from, a.to]),
          y = JSON.stringify([b.from, b.to]);
        return x < y ? -1 : x > y ? 1 : 0;
      });
      if (
        hashJson({
          ...settings,
          ignored: [...settings.ignored].sort(),
          connections: ordered,
        }) !== row.settings_sha256
      )
        throw new AppError("USER_INPUT", "旧展示快照摘要校验失败");
      const ids = (
        db
          .prepare("SELECT segment_id FROM track_segments WHERE version_id=?")
          .all(row.version_id) as { segment_id: string }[]
      ).map((s) => s.segment_id);
      const next = validatePresentation(
        {
          schema: 1,
          order: settings.order,
          ignored: settings.ignored,
          gaps: [],
        },
        ids,
      );
      // Neither a connected nor a disconnected edge proves the cause of a gap.
      unclassifiedConnections += [...edges.values()].filter(Boolean).length;
      db.prepare(
        "UPDATE track_presentations SET settings_json=?,settings_sha256=? WHERE id=?",
      ).run(
        canonical({
          schema: next.schema,
          order: next.order,
          ignored: next.ignored,
        }),
        presentationDigest(next),
        row.id,
      );
    }
    db.exec(
      "UPDATE archive_meta SET revision=revision+1,storage_revision=storage_revision+1,export_revision=NULL,views_revision=NULL",
    );
    for (const trigger of triggers) db.exec(trigger.sql);
    const stamp = verifyArchive(db);
    db.exec("COMMIT");
    db.pragma("foreign_keys=ON");
    db.exec("DETACH DATABASE old");
    db.close();
    db = undefined;
    syncFile(stage);
    linkSync(stage, output);
    syncDirectory(path.dirname(output));
    return {
      source: sourceFile,
      output,
      ...stamp,
      counts,
      unclassified_connections: unclassifiedConnections,
      message: "升级完成，原库保留；旧连接均待分类，不自动认定为隧道。",
    };
  } finally {
    if (db?.inTransaction) db.exec("ROLLBACK");
    db?.close();
    source.close();
    removeStaging(snapshot);
    removeStaging(stage);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [source, output, ...extra] = process.argv.slice(2);
  if (!source || !output || extra.length) {
    process.stderr.write(
      "用法：node scripts/upgrade-archive-schema9.ts 源库.sqlite3 新库.sqlite3\n",
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(
        JSON.stringify(
          await upgradeSchema9(path.resolve(source), path.resolve(output)),
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
