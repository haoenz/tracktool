import { afterEach, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { ArchiveWriter } from "../../dist/node/infrastructure/archive/writer.js";
import { digest } from "../../dist/node/infrastructure/durable-files.js";
import {
  transaction,
  rawObject,
} from "../../dist/node/infrastructure/archive/database.js";
const root = fileURLToPath(new URL("../..", import.meta.url));
const cli = path.join(root, "dist/node/cli/main.js");
const writerUrl = pathToFileURL(
  path.join(root, "dist/node/infrastructure/archive/writer.js"),
).href;
const raw = readFileSync(
  new URL("./fixtures/m4/2026-10-01 轨迹.kml", import.meta.url),
);
const dirs: string[] = [];
function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tracktool-m4-cli-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
function run(dir: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [cli, "--config", path.join(dir, "config.json"), ...args],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, TRACKTOOL_GOOGLE_API_KEY: "" },
      timeout: 12000,
    },
  );
}
async function setup() {
  const dir = tmp();
  const archive = path.join(dir, "archive");
  await new ArchiveWriter().init(archive);
  writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ archive_path: archive }),
  );
  const file = path.join(dir, "2026-10-01 中文.kml");
  writeFileSync(file, raw);
  return { dir, archive, file };
}
function child(code: string) {
  const process_ = spawn(
    process.execPath,
    ["--input-type=module", "-e", code],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let output = "";
  process_.stderr!.on("data", (b) => {
    output += String(b);
  });
  const done = new Promise<{
    code: number | null;
    signal: string | null;
    output: string;
  }>((resolve, reject) => {
    process_.once("error", reject);
    process_.once("close", (code, signal) => resolve({ code, signal, output }));
  });
  return { process: process_, done };
}
it("CLI init/type/tag/push/status/rebuild/backup/download/delete retains stdout contracts and original bytes", async () => {
  const { dir, archive, file } = await setup();
  expect(run(dir, "kml", "type", file).stdout.trim()).toBe("Train");
  expect(run(dir, "kml", "type", file, "--raw").stdout.trim()).toBe("火车");
  const init = run(dir, "archive", "init", path.join(dir, "second"));
  expect(init.status, init.stderr).toBe(0);
  const tag = run(
    dir,
    "--dry-run",
    "-vv",
    "kml",
    "set-tag",
    file,
    "--tag",
    "徒步",
  );
  expect(tag.status, tag.stderr).toBe(0);
  expect(tag.stderr).toContain("DEBUG");
  expect(readFileSync(file)).toEqual(raw);
  const push = run(dir, "kml", "push", file, "--move");
  expect(push.status, push.stderr).toBe(0);
  expect(existsSync(file)).toBe(false);
  expect(
    readFileSync(path.join(archive, "Backup", path.basename(file))),
  ).toEqual(raw);
  const status = run(dir, "archive", "status");
  expect(status.status, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({
    entries: 1,
    revision: 1,
    pending: 0,
  });
  for (const op of ["rebuild", "backup"]) {
    const result = run(dir, "archive", op);
    expect(result.status, result.stderr).toBe(0);
  }
  expect(run(dir, "kml", "pop", path.basename(file)).status).not.toBe(0);
  const download = run(dir, "kml", "download", path.basename(file));
  expect(download.status, download.stderr).toBe(0);
  expect(JSON.parse(run(dir, "archive", "status").stdout).entries).toBe(1);
  const deletion = run(dir, "kml", "delete", path.basename(file));
  expect(deletion.status, deletion.stderr).toBe(0);
  expect(JSON.parse(run(dir, "archive", "status").stdout).entries).toBe(0);
  expect(readFileSync(file)).toEqual(raw);
  expect(run(dir, "archive", "undo").status).toBe(1);
  expect(run(dir, "archive", "log").status).toBe(0);
}, 30000);
it("CLI split/prune/merge and retired converter, wildcard batches and partial exit preserve expected behavior", async () => {
  const { dir, file } = await setup();
  const split = run(dir, "kml", "split", file, "2026-10-01T00:00:01.400000Z");
  expect(split.status, split.stderr).toBe(0);
  expect(existsSync(file.replace(".kml", "-Splited-1.kml"))).toBe(true);
  const prune = run(dir, "kml", "prune", file, "--auto");
  expect(prune.status, prune.stderr).toBe(0);
  expect(existsSync(file.replace(".kml", "-Fixed.kml"))).toBe(true);
  const lines = path.join(dir, "2026-10-02 lines.kml");
  writeFileSync(
    lines,
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>A</name><LineString><coordinates>1,2 3,4</coordinates></LineString></Placemark></Document></kml>',
  );
  const convert = run(dir, "kml", "to-multigeom", lines);
  expect(convert.status, convert.stderr).not.toBe(0);
  expect(existsSync(lines.replace(".kml", "-Merged.kml"))).toBe(false);
  const plan = run(dir, "--dry-run", "kml", "fill-altitude", lines);
  expect(plan.status, plan.stderr).toBe(0);
  expect(plan.stderr).toContain("Would query");
  const merge = run(
    dir,
    "kml",
    "merge",
    file,
    lines,
    "-o",
    path.join(dir, "merged.kml"),
    "--keep",
  );
  expect(merge.status, merge.stderr).toBe(0);
  expect(readFileSync(file)).toEqual(raw);
  writeFileSync(path.join(dir, "2026-10-03 bad.kml"), "broken");
  const partial = run(
    dir,
    "--dry-run",
    "kml",
    "push",
    path.join(dir, "2026-10-0[13]*.kml"),
    "--keep",
  );
  expect(partial.status, partial.stderr).toBe(3);
  expect(partial.stdout).not.toContain("\u001b[");
});
it("dry-run performs no archive writes or pending recovery and no Google requests", async () => {
  const { dir, archive, file } = await setup(),
    database = path.join(archive, "archive.sqlite3");
  const interrupted = new ArchiveWriter(undefined, (p) => {
    if (p === "intent-committed") throw new Error("stop");
  });
  await expect(
    interrupted.push({
      kind: "push",
      database,
      entries: [
        {
          source: file,
          sha256: digest(raw),
          category: "Train",
          member: "Train/a.kml",
        },
      ],
      backup: path.join(archive, "Backup"),
      move: true,
    }),
  ).rejects.toThrow();
  const before = readFileSync(database);
  for (const args of [
    ["archive", "recover"],
    ["archive", "migrate"],
    ["archive", "backup"],
    ["archive", "rebuild"],
    ["kml", "push", file],
  ]) {
    const result = run(dir, "--dry-run", ...args);
    expect(result.status, result.stderr).toBe(0);
  }
  expect(readFileSync(database)).toEqual(before);
  expect(existsSync(file)).toBe(true);
  expect(existsSync(path.join(archive, "Backup"))).toBe(false);
  expect(existsSync(path.join(archive, "Archive.zip"))).toBe(false);
  const recover = run(dir, "archive", "recover");
  expect(recover.status, recover.stderr).toBe(0);
  expect(existsSync(file)).toBe(false);
});
it("real process death after durable target is recovered by a new CLI process", async () => {
  const { dir, archive, file } = await setup(),
    database = path.join(archive, "archive.sqlite3");
  const request = {
    kind: "push",
    database,
    entries: [
      {
        source: file,
        sha256: digest(raw),
        category: "Train",
        member: "Train/a.kml",
      },
    ],
    backup: path.join(archive, "Backup"),
    move: true,
  };
  const crash = child(
    `import {ArchiveWriter} from ${JSON.stringify(writerUrl)};await new ArchiveWriter(undefined,p=>{if(p==='target-durable')process.kill(process.pid,'SIGKILL');}).execute(${JSON.stringify(request)});`,
  );
  const result = await crash.done;
  if (process.platform === "win32") expect(result.code).not.toBe(0);
  else expect(result.signal, result.output).toBe("SIGKILL");
  expect(new ArchiveWriter().status(database).pending).toBe(1);
  expect(existsSync(file)).toBe(true);
  const recover = run(dir, "archive", "recover");
  expect(recover.status, recover.stderr).toBe(0);
  expect(new ArchiveWriter().status(database)).toMatchObject({
    pending: 0,
    entries: 1,
  });
  expect(
    readFileSync(path.join(archive, "Backup", path.basename(file))),
  ).toEqual(raw);
});
it("two CLI writers serialize identical content and move both sources without duplicate revision", async () => {
  const { dir, archive, file } = await setup();
  const otherDir = path.join(dir, "other");
  mkdirSync(otherDir);
  const other = path.join(otherDir, path.basename(file));
  writeFileSync(other, raw);
  const runs = [file, other].map((source) =>
    child(
      `import {ArchiveWriter} from ${JSON.stringify(writerUrl)};await new ArchiveWriter().execute(${JSON.stringify({ kind: "push", database: path.join(archive, "archive.sqlite3"), entries: [{ source, sha256: digest(raw), category: "Train", member: "Train/a.kml" }], backup: path.join(archive, "Backup"), move: true })});`,
    ),
  );
  const results = await Promise.all(runs.map((r) => r.done));
  for (const result of results) expect(result.code, result.output).toBe(0);
  expect(existsSync(file)).toBe(false);
  expect(existsSync(other)).toBe(false);
  expect(
    new ArchiveWriter().status(path.join(archive, "archive.sqlite3")),
  ).toMatchObject({ entries: 1, revision: 1, pending: 0 });
});
it("cross-process init and merge-output races have exactly one winner without overwrite", async () => {
  const { dir, archive, file } = await setup(),
    target = path.join(dir, "race");
  const inits = [0, 1].map(() =>
    child(
      `import {ArchiveWriter} from ${JSON.stringify(writerUrl)};await new ArchiveWriter().init(${JSON.stringify(target)});`,
    ),
  );
  const results = await Promise.all(inits.map((r) => r.done));
  expect(results.map((r) => r.code).sort()).toEqual([0, 1]);
  const output = path.join(dir, "merged.kml");
  const sourceCode = `import {spawnSync} from 'node:child_process';const r=spawnSync(process.execPath,${JSON.stringify([cli, "--config", path.join(dir, "config.json"), "kml", "merge", file, "--keep", "-o", output])},{encoding:'utf8'});process.stderr.write(r.stderr);process.exit(r.status);`;
  const merges = [child(sourceCode), child(sourceCode)];
  expect(
    (await Promise.all(merges.map((r) => r.done))).map((r) => r.code).sort(),
  ).toEqual([0, 1]);
  expect(readFileSync(file)).toEqual(raw);
  transaction(path.join(archive, "archive.sqlite3"), false, (db) =>
    expect(Buffer.from(rawObject(db, digest(raw)))).toEqual(raw),
  );
});

it("CLI full backup and restore preserve the library and refuse to overwrite destinations", async () => {
  const { dir, archive, file } = await setup();
  expect(run(dir, "kml", "push", file, "--keep").status).toBe(0);
  const backup = path.join(dir, "full.sqlite3"),
    restored = path.join(dir, "restored");
  expect(
    run(dir, "--dry-run", "archive", "full-backup", "--output", backup).status,
  ).toBe(0);
  expect(existsSync(backup)).toBe(false);
  const copied = run(dir, "archive", "full-backup", "--output", backup);
  expect(copied.status, copied.stderr).toBe(0);
  const result = run(dir, "archive", "restore-backup", backup, restored);
  expect(result.status, result.stderr).toBe(0);
  expect(
    new ArchiveWriter().status(path.join(restored, "archive.sqlite3")),
  ).toMatchObject({ schema: 6, entries: 1 });
  expect(run(dir, "archive", "full-backup", "--output", backup).status).toBe(1);
  expect(run(dir, "archive", "restore-backup", backup, archive).status).toBe(1);
});

it("default CLI import retains originals, rejects mixed invalid batches and needs no Backup", async () => {
  const { dir, archive, file } = await setup();
  const bad = path.join(dir, "2026-10-02 bad.kml");
  writeFileSync(bad, "<kml>");
  const rejected = run(dir, "kml", "push", file, bad);
  expect(rejected.status).not.toBe(0);
  const writer = new ArchiveWriter();
  const database = path.join(archive, "archive.sqlite3");
  expect(writer.status(database)).toMatchObject({ entries: 0, pending: 0 });
  expect(existsSync(path.join(archive, "Backup"))).toBe(false);
  const accepted = run(dir, "kml", "push", file);
  expect(accepted.status, accepted.stderr).toBe(0);
  expect(readFileSync(file)).toEqual(raw);
  expect(existsSync(path.join(archive, "Backup"))).toBe(false);
  expect(writer.status(database)).toMatchObject({ entries: 1, pending: 0 });
  expect(run(dir, "kml", "push", file).status).toBe(0);
  expect(writer.status(database)).toMatchObject({ entries: 1, pending: 0 });
}, 30000);

it.each(["push-entry-written", "push-before-commit"])(
  "process death at %s rolls back direct import and reupload succeeds",
  async (point) => {
    const { dir, archive, file } = await setup();
    const database = path.join(archive, "archive.sqlite3");
    const request = {
      kind: "push",
      database,
      move: false,
      backup: path.join(archive, "Backup"),
      entries: [0, 1].map((n) => ({
        source: file,
        sha256: digest(raw),
        category: "Train",
        member: `Train/${n}.kml`,
      })),
    };
    const crash = child(
      `import {ArchiveWriter} from ${JSON.stringify(writerUrl)};await new ArchiveWriter(undefined,p=>{if(p===${JSON.stringify(point)})process.kill(process.pid,'SIGKILL');}).execute(${JSON.stringify(request)});`,
    );
    const result = await crash.done;
    if (process.platform === "win32") expect(result.code).not.toBe(0);
    else expect(result.signal, result.output).toBe("SIGKILL");
    const writer = new ArchiveWriter();
    expect(writer.status(database)).toMatchObject({
      entries: 0,
      pending: 0,
      revision: 0,
    });
    expect(existsSync(path.join(archive, "Backup"))).toBe(false);
    expect(readFileSync(file)).toEqual(raw);
    const retry = run(dir, "kml", "push", file);
    expect(retry.status, retry.stderr).toBe(0);
    expect(writer.status(database)).toMatchObject({ entries: 1, pending: 0 });
  },
  30000,
);
