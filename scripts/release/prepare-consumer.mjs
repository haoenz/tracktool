import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
const [target, packages] = process.argv.slice(2);
if (!target || !packages)
  throw new Error("Usage: prepare-consumer TARGET PACKAGE_DIRECTORY");
const files = (await readdir(packages)).filter((f) => f.endsWith(".tgz"));
if (files.length !== 1) throw new Error("Expected exactly one packed release");
await mkdir(target, { recursive: true });
await writeFile(
  path.join(target, "package.json"),
  JSON.stringify(
    {
      name: "tracktool-release-consumer",
      private: true,
      type: "module",
      dependencies: {
        tracktool: `file:${path.resolve(packages, files[0]).replaceAll("\\", "/")}`,
      },
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  path.join(target, "pnpm-workspace.yaml"),
  "allowBuilds:\n  better-sqlite3: true\n  sharp: true\n",
);
