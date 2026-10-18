import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { DisplayStore } from "../../src/infrastructure/display-store.js";
import { defaultProject } from "../../src/shared/project.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function store() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tracktool-display-"));
  temporary.push(dir);
  return new DisplayStore(path.join(dir, "display.json"));
}

test("display style round-trips and serializes queued writes", async () => {
  const display = await store();
  const first = defaultProject().style;
  const second = {
    ...first,
    features: { ...first.features, places: "all" },
  };
  await Promise.all([display.save(first), display.save(second)]);
  expect(await display.load()).toEqual(second);
  expect(JSON.parse(await readFile(display.path, "utf8"))).toMatchObject({
    schema: 1,
    style: second,
  });
});

test("corrupt, unknown-schema and invalid style files fall back to defaults", async () => {
  const display = await store();
  await writeFile(display.path, "{");
  expect(await display.load()).toBeUndefined();
  await writeFile(display.path, JSON.stringify({ schema: 99, style: {} }));
  expect(await display.load()).toBeUndefined();
  await writeFile(
    display.path,
    JSON.stringify({ schema: 1, style: { basemap: "not-a-map" } }),
  );
  expect(await display.load()).toBeUndefined();
});

test("clear removes the persisted style", async () => {
  const display = await store();
  await display.save(defaultProject().style);
  await display.clear();
  expect(await display.load()).toBeUndefined();
});
