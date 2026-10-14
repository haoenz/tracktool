import { cp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
if (process.argv.includes("--clean"))
  await rm("dist/node", { recursive: true, force: true });
else {
  const root = "resources/maps";
  await mkdir("dist/maps/static", { recursive: true });
  await mkdir("dist/web/static", { recursive: true });
  await cp(`${root}/data`, "dist/maps/data", { recursive: true });
  await cp(`${root}/static/vendor`, "dist/maps/static/vendor", {
    recursive: true,
  });
  await cp(`${root}/static/vendor`, "dist/web/static/vendor", {
    recursive: true,
  });
  const assets = JSON.parse(
    await readFile(`${root}/data/assets.json`, "utf8"),
  ) as Record<string, unknown>;
  const hash = createHash("sha256");
  for (const name of (await readdir("src/drawing")).sort())
    hash.update(await readFile(path.join("src/drawing", name)));
  hash.update(await readFile("src/web/render.ts", "utf8"));
  hash.update(await readFile("src/web/map.css", "utf8"));
  assets.renderer_sha256 = hash.digest("hex");
  await writeFile(
    "dist/maps/data/assets.json",
    JSON.stringify(assets, null, 2) + "\n",
  );
}
