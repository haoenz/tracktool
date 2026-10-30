import { afterEach, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArchiveWriter } from "../../dist/node/infrastructure/archive/writer.js";
import { digest } from "../../dist/node/infrastructure/durable-files.js";
import { xmlStats } from "../../dist/node/infrastructure/xml/document.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/m4/${name}`, import.meta.url));
const dirs: string[] = [];
function tmp() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "tracktool-parse-"));
  dirs.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of dirs)
    rmSync(directory, { recursive: true, force: true });
  dirs.length = 0;
});

it("parses an imported document once and reuses statistics for identical content", async () => {
  const directory = tmp(),
    database = path.join(directory, "archive.sqlite3"),
    writer = new ArchiveWriter();
  await writer.init(directory);
  const raw = readFileSync(fixture("2026-10-01 轨迹.kml")),
    first = path.join(directory, "first.kml"),
    second = path.join(directory, "second.kml");
  copyFileSync(fixture("2026-10-01 轨迹.kml"), first);
  copyFileSync(fixture("2026-10-01 轨迹.kml"), second);
  const sha256 = digest(raw);
  xmlStats.parses = 0;
  await writer.push({
    kind: "push",
    database,
    entries: [
      {
        source: first,
        category: "Default",
        member: "Default/2026-10/2026-10-01 轨迹.kml",
        sha256,
      },
    ],
    backup: path.join(directory, "Backup"),
    move: true,
  });
  expect(xmlStats.parses).toBe(1);

  // Same bytes under a new member: manifest and presentation still need one
  // parse, while the analysis cache avoids the statistics traversal.
  await writer.push({
    kind: "push",
    database,
    entries: [
      {
        source: second,
        category: "Default",
        member: "Default/2026-10/2026-10-01 副本.kml",
        sha256,
      },
    ],
    backup: path.join(directory, "Backup"),
    move: true,
  });
  expect(xmlStats.parses).toBe(2);
});
