import { createHash } from "node:crypto";
import type { Presentation } from "../../domain/track-version.js";

/** UUID v5, URL namespace. Stable across retries and migration rehearsals. */
export function stableId(name: string): string {
  const hash = createHash("sha1")
    .update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
    .update(name)
    .digest();
  hash[6] = (hash[6]! & 15) | 80;
  hash[8] = (hash[8]! & 63) | 128;
  const s = hash.subarray(0, 16).toString("hex");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Expected a JSON value");
  return result;
}
export const hashJson = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function presentationDigest(value: Presentation): string {
  return hashJson({
    ...value,
    ignored: [...value.ignored].sort(),
    connections: [...value.connections].sort((a, b) => {
      const x = JSON.stringify([a.from, a.to]),
        y = JSON.stringify([b.from, b.to]);
      return x < y ? -1 : x > y ? 1 : 0;
    }),
  });
}
