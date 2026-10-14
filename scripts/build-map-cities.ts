/** Rebuild from an explicitly downloaded CN.zip; never fetch implicitly. */
import { readFile, writeFile } from "node:fs/promises";
import { buildGazetteer } from "../dist/node/infrastructure/gazetteer.js";
const [source, destination] = process.argv.slice(2);
if (!source || !destination)
  throw new Error(
    "Usage: pnpm cities SOURCE_CN.zip DESTINATION.json (run pnpm build first)",
  );
await writeFile(
  destination,
  JSON.stringify(await buildGazetteer(await readFile(source))) + "\n",
  { flag: "wx" },
);
