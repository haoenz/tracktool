import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Database from "better-sqlite3";
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from "@zip.js/zip.js";
import {
  ArchiveWriter,
  addEntry,
} from "../../dist/node/infrastructure/archive/writer.js";
import type { FaultPoint } from "../../dist/node/infrastructure/archive/writer.js";
import {
  transaction,
  rawObject,
} from "../../dist/node/infrastructure/archive/database.js";
import { SCHEMA_3 } from "../../dist/node/infrastructure/archive/schema-v3.js";
import {
  previewDeletion,
  deleteEntry,
} from "../../dist/node/infrastructure/archive/deletion.js";
import {
  SCHEMA,
  MIGRATE_1,
} from "../../dist/node/infrastructure/archive/schema.js";
import { readZip } from "../../dist/node/infrastructure/archive/zip.js";
import { digest } from "../../dist/node/infrastructure/durable-files.js";
import { withDocument } from "../../dist/node/infrastructure/xml/document.js";
import { exportDisplay } from "../../dist/node/infrastructure/archive/display-export.js";
import expected from "./fixtures/m4/python.json";
const fixture = (n: string) =>
  fileURLToPath(new URL(`./fixtures/m4/${n}`, import.meta.url));
const raw = readFileSync(fixture("2026-10-01 轨迹.kml"));
const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(path.join(os.tmpdir(), "tracktool-m4-archive-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
async function initialized(version = 4) {
  const directory = tmp();
  const writer = new ArchiveWriter();
  if (version === 4) await writer.init(directory);
  else {
    const db = new Database(path.join(directory, "archive.sqlite3"));
    db.exec(version === 3 ? SCHEMA_3 : SCHEMA + MIGRATE_1);
    db.prepare(
      "INSERT INTO archive_meta(singleton,archive_id) VALUES (1,'legacy')",
    ).run();
    db.close();
  }
  return { directory, writer, file: path.join(directory, "archive.sqlite3") };
}
async function zipBytes(names: [string, Uint8Array, number?][]) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
    level: 0,
  });
  for (const [name, bytes, mode] of names)
    await writer.add(name, new Uint8ArrayReader(bytes), {
      externalFileAttributes: mode,
      versionMadeBy: 3 * 256 + 20,
    });
  return writer.close();
}
it.each(["stored", "deflate", "bzip2", "lzma", "zstd"])(
  "imports Python %s ZIP, preserves all raw bytes and exports a verified roundtrip",
  async (codec) => {
    const d = tmp(),
      w = new ArchiveWriter();
    await w.init(d, fixture(`${codec}.zip`));
    const file = path.join(d, "archive.sqlite3");
    expect(w.status(file)).toMatchObject({
      entries: 2,
      revision: 2,
      pending: 0,
    });
    const original: Record<string, string> = {};
    await readZip(fixture(`${codec}.zip`), (n, b) => {
      original[n] = digest(b);
    });
    const output = path.join(d, "out.zip");
    const result = await w.backup(file, output);
    expect(result.warnings?.some((w) => w.includes("保留原字节"))).toBe(true);
    transaction(file, false, (db) => {
      for (const hash of Object.values(original))
        expect(digest(rawObject(db, hash))).toBe(hash);
      const rows = db
        .prepare(
          "SELECT e.path,v.manifest_status FROM archive_entries e JOIN track_versions v ON v.id=e.current_version_id",
        )
        .all() as { path: string; manifest_status: string }[];
      for (const row of rows)
        if (row.manifest_status === "ready")
          original[row.path] = digest(exportDisplay(db, row.path));
    });
    const roundtrip: Record<string, string> = {};
    await readZip(output, (n, b) => {
      roundtrip[n] = digest(b);
    });
    expect(roundtrip).toEqual(original);
    expect(w.status(file).zip_fresh).toBe(true);
  },
);
it.each([
  "../escape.kml",
  "/absolute.kml",
  "a//b.kml",
  "a/./b.kml",
  "a\\b.kml",
  "C:/bad.kml",
  "bad\u0001.kml",
])("rejects unsafe ZIP path %s without publishing database", async (name) => {
  const d = tmp(),
    zip = path.join(d, "bad.zip");
  writeFileSync(zip, await zipBytes([[name, raw]]));
  await expect(
    new ArchiveWriter().init(path.join(d, "dest"), zip),
  ).rejects.toThrow();
  expect(existsSync(path.join(d, "dest/archive.sqlite3"))).toBe(false);
});
it.each(["crc", "symlink", "non-kml", "invalid"])(
  "rejects %s ZIP before publishing",
  async (kind) => {
    const d = tmp(),
      zip = path.join(d, "bad.zip");
    let bytes = Buffer.from(
      await zipBytes([
        ["ok.kml", raw],
        ...(kind === "non-kml"
          ? [["bad.txt", raw] as [string, Uint8Array]]
          : []),
        ...(kind === "symlink"
          ? [["link.kml", raw, 0o120777 << 16] as [string, Uint8Array, number]]
          : []),
      ]),
    );
    if (kind === "crc")
      bytes = Buffer.from(
        bytes.toString("latin1").replace("untouched", "corrupted"),
        "latin1",
      );
    if (kind === "invalid") bytes = Buffer.from("broken");
    writeFileSync(zip, bytes);
    await expect(
      new ArchiveWriter().init(path.join(d, "dest"), zip),
    ).rejects.toThrow();
    expect(existsSync(path.join(d, "dest/archive.sqlite3"))).toBe(false);
  },
);
it("push deduplicates bytes/revisions, preserves conflicting backup sources, pop refuses overwrite", async () => {
  const { directory: d, writer: w, file } = await initialized();
  const source = path.join(d, "2026-10-01 轨迹.kml");
  writeFileSync(source, raw);
  const input = {
    source,
    category: "Train" as const,
    member: "Train/2026-10/2026-10-01 轨迹.kml",
    sha256: digest(raw),
  };
  await w.push({
    kind: "push",
    database: file,
    entries: [input],
    backup: path.join(d, "Backup"),
    move: false,
  });
  await w.push({
    kind: "push",
    database: file,
    entries: [input],
    backup: path.join(d, "Backup"),
    move: false,
  });
  expect(w.status(file)).toMatchObject({ entries: 1, revision: 1 });
  const out = path.join(d, "out");
  mkdirSync(out);
  writeFileSync(path.join(out, path.basename(source)), "occupied");
  await expect(
    w.execute({
      kind: "download",
      database: file,
      name: path.basename(source),
      output: out,
    }),
  ).rejects.toThrow("overwrite");
  expect(w.status(file).entries).toBe(1);
  mkdirSync(path.join(d, "Backup"));
  writeFileSync(path.join(d, "Backup", path.basename(source)), "different");
  expect(
    (
      await w.push({
        kind: "push",
        database: file,
        entries: [input],
        backup: path.join(d, "Backup"),
        move: true,
      })
    ).warnings,
  ).toHaveLength(1);
  expect(existsSync(source)).toBe(true);
  rmSync(path.join(out, path.basename(source)));
  await w.execute({
    kind: "download",
    database: file,
    name: path.basename(source),
    output: out,
  });
  expect(readFileSync(path.join(out, path.basename(source)))).toEqual(raw);
  expect(w.status(file)).toMatchObject({ entries: 1, revision: 1 });
  const plan = previewDeletion(file, { name: path.basename(source) });
  deleteEntry(file, {
    archive_id: plan.archive_id,
    expected: plan.expected,
    request_key: "remove",
  });
  expect(w.status(file)).toMatchObject({ entries: 0, pending: 0, revision: 2 });
});
it.each([
  "intent-committed",
  "target-durable",
  "source-removed",
] as FaultPoint[])("recovers push after interruption at %s", async (point) => {
  const { directory: d, file } = await initialized();
  const source = path.join(d, "2026-10-01 原始.kml");
  writeFileSync(source, raw);
  const w = new ArchiveWriter(undefined, (p) => {
    if (p === point) throw new Error("injected");
  });
  await expect(
    w.push({
      kind: "push",
      database: file,
      entries: [
        {
          source,
          category: "Train",
          member: "Train/a.kml",
          sha256: digest(raw),
        },
      ],
      backup: path.join(d, "Backup"),
      move: true,
    }),
  ).rejects.toThrow("injected");
  expect(w.status(file).pending).toBe(1);
  const recovery = new ArchiveWriter();
  expect(await recovery.recover(file)).toBe(1);
  expect(await recovery.recover(file)).toBe(0);
  expect(existsSync(source)).toBe(false);
  expect(readFileSync(path.join(d, "Backup", path.basename(source)))).toEqual(
    raw,
  );
  expect(recovery.status(file).entries).toBe(1);
});
it("changed source and symlink recovery targets are never overwritten or removed", async () => {
  const { directory: d, file } = await initialized(),
    source = path.join(d, "a.kml");
  writeFileSync(source, raw);
  const w = new ArchiveWriter(undefined, (p) => {
    if (p === "intent-committed") throw new Error("injected");
  });
  await expect(
    w.push({
      kind: "push",
      database: file,
      entries: [
        { source, category: null, member: "a.kml", sha256: digest(raw) },
      ],
      backup: path.join(d, "Backup"),
      move: true,
    }),
  ).rejects.toThrow();
  writeFileSync(source, "changed");
  const recovery = new ArchiveWriter();
  await expect(recovery.recover(file)).rejects.toThrow("Source changed");
  expect(readFileSync(source, "utf8")).toBe("changed");
  expect(recovery.status(file).pending).toBe(1);
  rmSync(path.join(d, "Backup/a.kml"));
  symlinkSync(source, path.join(d, "Backup/a.kml"));
  await expect(recovery.recover(file)).rejects.toThrow("overwrite");
  expect(readFileSync(source, "utf8")).toBe("changed");
});
it.each(["export-published", "before-export-commit"] as FaultPoint[])(
  "failed export at %s restores previous bytes and receipts",
  async (point) => {
    const { directory: d, writer: w, file } = await initialized();
    transaction(file, true, (db) => addEntry(db, "a.kml", raw, "Train"));
    const output = path.join(d, "out.zip");
    await w.backup(file, output);
    const before = readFileSync(output);
    transaction(file, true, (db) => addEntry(db, "b.kml", raw, "Train"));
    await expect(
      new ArchiveWriter(undefined, (p) => {
        if (p === point) throw new Error("injected");
      }).backup(file, output),
    ).rejects.toThrow("injected");
    expect(readFileSync(output)).toEqual(before);
    expect(w.status(file)).toMatchObject({
      revision: 2,
      zip_revision: 1,
      zip_fresh: false,
    });
  },
);
it("older export cannot replace a newer receipt for the same target", async () => {
  const { directory: d, file, writer: w } = await initialized();
  transaction(file, true, (db) => addEntry(db, "a.kml", raw, "Train"));
  const output = path.join(d, "out.zip");
  let release!: () => void, ready!: () => void;
  const barrier = new Promise<void>((r) => {
    ready = r;
  });
  const held = new Promise<void>((r) => {
    release = r;
  });
  const old = new ArchiveWriter(undefined, async (p) => {
    if (p === "before-export-publish") {
      ready();
      await held;
    }
  }).backup(file, output);
  await barrier;
  transaction(file, true, (db) => addEntry(db, "b.kml", raw, "Train"));
  await w.backup(file, output);
  const before = readFileSync(output);
  release();
  await expect(old).rejects.toThrow("newer snapshot");
  expect(readFileSync(output)).toEqual(before);
});
it("schema upgrade is explicit, transactional and preserves existing raw bytes", async () => {
  const directory = tmp(),
    file = path.join(directory, "archive.sqlite3"),
    w = new ArchiveWriter();
  const db = new Database(file);
  db.exec(SCHEMA);
  db.exec(
    "INSERT INTO archive_meta(singleton,archive_id) VALUES (1,'v1-fixture'); PRAGMA user_version=1; BEGIN",
  );
  addEntry(db, "a.kml", raw, "Train");
  db.exec("COMMIT");
  db.close();
  expect(() => w.status(file)).toThrow("schema 1");
  await w.migrate(file);
  expect(w.status(file).entries).toBe(1);
  transaction(file, false, (db) =>
    expect(Buffer.from(rawObject(db, digest(raw)))).toEqual(raw),
  );
});
it("all six legacy collections match Python semantic output", async () => {
  const { directory: d, file, writer: w } = await initialized(2);
  transaction(file, true, (db) =>
    addEntry(db, "Train/2026-10/2026-10-01 轨迹.kml", raw, "Train"),
  );
  await w.execute({ kind: "rebuild", database: file, output: d });
  for (const name of [
    "Default",
    "Default.Mobile",
    "Train",
    "Train.Mobile",
    "Flight",
    "Flight.Mobile",
  ] as const) {
    const bytes = readFileSync(path.join(d, `${name}.kml`));
    withDocument(bytes, (doc) => {
      const ns = { kml: "http://www.opengis.net/kml/2.2" };
      expect(doc.find("//kml:name/text()", ns).map((n) => n.content)).toEqual(
        expected[name].names,
      );
      expect(
        doc.find("//kml:coordinates/text()", ns).map((n) => n.content),
      ).toEqual(expected[name].lines);
      expect(
        doc.find("//kml:description/text()", ns).map((n) => n.content),
      ).toEqual(expected[name].descriptions);
    });
  }
  expect(w.status(file).views_revision).toBe(1);
  expect(readdirSync(d).filter((n) => n.endsWith(".kml"))).toHaveLength(6);
});
it("legacy schema 2 pop intents recover with their original removal semantics", async () => {
  const { directory, file, writer } = await initialized(2);
  transaction(file, true, (db) => {
    const e = addEntry(db, "Train/a.kml", raw, "Train");
    db.prepare(
      "INSERT INTO file_operations VALUES ('old-pop','pop',?,?,NULL,?)",
    ).run(e.id, e.sha256, path.join(directory, "popped", "a.kml"));
  });
  const crash = new ArchiveWriter(undefined, (p) => {
    if (p === "target-durable") throw new Error("injected");
  });
  await expect(crash.recover(file)).rejects.toThrow("injected");
  expect(writer.status(file)).toMatchObject({ entries: 1, pending: 1 });
  await writer.recover(file);
  expect(writer.status(file)).toMatchObject({
    entries: 0,
    pending: 0,
    revision: 2,
  });
  expect(readFileSync(path.join(directory, "popped", "a.kml"))).toEqual(raw);
});
it("a backup directory alias of the source directory never removes the source", async () => {
  const { directory, file, writer } = await initialized();
  const source = path.join(directory, "a.kml");
  writeFileSync(source, raw);
  const alias = path.join(directory, "alias");
  symlinkSync(directory, alias, "dir");
  await writer.push({
    kind: "push",
    database: file,
    entries: [{ source, category: null, member: "a.kml", sha256: digest(raw) }],
    backup: alias,
    move: true,
  });
  expect(readFileSync(source)).toEqual(raw);
  expect(writer.status(file).pending).toBe(0);
});
it("conflicting paths roll back the whole push and retain every source", async () => {
  const { directory, file, writer } = await initialized();
  transaction(file, true, (db) => addEntry(db, "conflict.kml", raw, null));
  const first = path.join(directory, "first.kml"),
    second = path.join(directory, "second.kml");
  writeFileSync(first, raw);
  writeFileSync(second, "different");
  await expect(
    writer.push({
      kind: "push",
      database: file,
      entries: [
        {
          source: first,
          category: null,
          member: "new.kml",
          sha256: digest(raw),
        },
        {
          source: second,
          category: null,
          member: "conflict.kml",
          sha256: digest(Buffer.from("different")),
        },
      ],
      backup: path.join(directory, "Backup"),
      move: true,
    }),
  ).rejects.toThrow("conflict");
  expect(writer.status(file)).toMatchObject({
    entries: 1,
    revision: 1,
    pending: 0,
  });
  expect(existsSync(first) && existsSync(second)).toBe(true);
});
it("download preview checks target conflicts without recovery or mutation", async () => {
  const { directory, file, writer } = await initialized();
  transaction(file, true, (db) => addEntry(db, "Train/a.kml", raw, "Train"));
  const before = readFileSync(file);
  await writer.execute({
    kind: "download",
    database: file,
    name: "a",
    output: directory,
    preview: true,
  });
  expect(readFileSync(file)).toEqual(before);
  expect(existsSync(path.join(directory, "a.kml"))).toBe(false);
  writeFileSync(path.join(directory, "a.kml"), "occupied");
  await expect(
    writer.execute({
      kind: "download",
      database: file,
      name: "a",
      output: directory,
      preview: true,
    }),
  ).rejects.toThrow("overwrite");
});
it("reads Python forced ZIP64 and CP437 names; validates directory CRC and duplicate names", async () => {
  const names: string[] = [];
  await readZip(fixture("cp437.zip"), (name) => {
    names.push(name);
  });
  expect(names).toEqual(["café.kml"]);
  const zip64: string[] = [];
  await readZip(fixture("zip64.zip"), (name) => {
    zip64.push(name);
  });
  expect(zip64).toHaveLength(2);
  for (const name of ["duplicate.zip", "directory-crc.zip"])
    await expect(
      new ArchiveWriter().init(tmp(), fixture(name)),
    ).rejects.toThrow();
});

it("recovers an already committed schema 1 pop before explicit migration", async () => {
  const directory = tmp(),
    file = path.join(directory, "archive.sqlite3"),
    target = path.join(directory, "old.kml"),
    db = new Database(file);
  db.exec(SCHEMA);
  db.pragma("user_version=1");
  db.prepare(
    "INSERT INTO archive_meta(singleton,archive_id) VALUES (1,'schema1')",
  ).run();
  const e = addEntry(db, "a.kml", raw, "Train");
  db.prepare("INSERT INTO file_operations VALUES ('old','pop',?,?,NULL,?)").run(
    e.id,
    e.sha256,
    target,
  );
  db.close();
  const writer = new ArchiveWriter();
  await expect(
    writer.execute({ kind: "migrate", database: file }),
  ).rejects.toThrow(/recover/);
  await writer.recover(file);
  expect(readFileSync(target)).toEqual(raw);
  await writer.execute({ kind: "migrate", database: file });
  expect(writer.status(file)).toMatchObject({
    entries: 0,
    pending: 0,
    revision: 3,
  });
});
