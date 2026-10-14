#!/usr/bin/env node
import { execute } from "@oclif/core";
// Python accepts common flags before the command; oclif expects command-local flags.
const argv = process.argv.slice(2);
const globals: string[] = [];
while (argv[0]) {
  if (/^(--dry-run|--verbose|--quiet|-[vq]+|--config=)/.test(argv[0]))
    globals.push(argv.shift()!);
  else if (argv[0] === "--config" && argv[1])
    globals.push(argv.shift()!, argv.shift()!);
  else break;
}
// Tag-list removal is a positional value (for example -散步), not a flag.
if (argv[0] === "config" && argv[1] === "set" && !argv.includes("--")) {
  const positional: number[] = [];
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--config") {
      i++;
      continue;
    }
    if (/^(--config=|--dry-run$|--verbose$|--quiet$|-[vq]+$)/.test(token))
      continue;
    positional.push(i);
  }
  const valueIndex = positional[1];
  if (valueIndex !== undefined && argv[valueIndex]!.startsWith("-")) {
    const value = argv.splice(valueIndex, 1)[0]!;
    argv.push(...globals.splice(0), "--", value);
  }
}
await execute({ dir: import.meta.url, args: [...argv, ...globals] });
