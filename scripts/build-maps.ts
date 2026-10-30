import { cp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    clean: { type: "boolean" },
    "out-dir": { type: "string", default: "dist" },
  },
});
const output = values["out-dir"];
if (values.clean)
  await rm(path.join(output, "node"), { recursive: true, force: true });
else {
  const root = "resources/maps";
  await mkdir(path.join(output, "maps/static"), { recursive: true });
  await mkdir(path.join(output, "web/static"), { recursive: true });
  await cp(`${root}/data`, path.join(output, "maps/data"), { recursive: true });
  await cp(`${root}/static/vendor`, path.join(output, "maps/static/vendor"), {
    recursive: true,
  });
  await cp(`${root}/static/vendor`, path.join(output, "web/static/vendor"), {
    recursive: true,
  });
  const assets = JSON.parse(
    await readFile(`${root}/data/assets.json`, "utf8"),
  ) as Record<string, unknown>;
  const hash = createHash("sha256");
  for (const name of (await readdir("src/drawing")).sort())
    hash.update(await readFile(path.join("src/drawing", name)));
  for (const file of [
    "src/web/render.ts",
    "src/web/overview-layer.ts",
    "src/web/analysis-layer.ts",
    "src/web/map.css",
  ])
    if (existsSync(file)) hash.update(await readFile(file, "utf8"));
  assets.renderer_sha256 = hash.digest("hex");
  await writeFile(
    path.join(output, "maps/data/assets.json"),
    JSON.stringify(assets, null, 2) + "\n",
  );
}
