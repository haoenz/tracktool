import { AppError, checkCancelled } from "../domain/errors.js";
import type { ElevationPort } from "../services/kml-service.js";
import { setTimeout as delay } from "node:timers/promises";
// Python round(x, 2) uses ties-to-even. Exact binary halfway cases are odd eighths.
function roundElevation(value: number): number {
  const eighths = value * 8;
  if (Number.isSafeInteger(eighths) && Math.abs(eighths % 2) === 1) {
    const lower = Math.floor(value * 100);
    return (lower % 2 === 0 ? lower : lower + 1) / 100;
  }
  return Number(value.toFixed(2));
}
export class GoogleElevation implements ElevationPort {
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly sleep: (
      ms: number,
      signal: AbortSignal,
    ) => Promise<unknown> = (ms, signal) => delay(ms, undefined, { signal }),
  ) {}
  async get(
    locations: [number, number][],
    key: string,
    signal: AbortSignal,
  ): Promise<(number | null)[]> {
    if (!key) throw new AppError("TOOL", "Google API key is required");
    const batches: string[][] = [];
    let batch: string[] = [];
    const prefix =
      "https://maps.googleapis.com/maps/api/elevation/json?locations=";
    for (const point of locations) {
      const next = point.join(",");
      if (
        batch.length &&
        (batch.length === 512 ||
          prefix.length +
            [...batch, next].join("|").length +
            5 +
            encodeURIComponent(key).length >
            8192)
      ) {
        batches.push(batch);
        batch = [];
      }
      batch.push(next);
    }
    if (batch.length) batches.push(batch);
    const values: (number | null)[] = [];
    for (const group of batches) {
      checkCancelled(signal);
      let payload:
        { status?: string; results?: { elevation?: unknown }[] } | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await this.request(
            `${prefix}${group.join("|")}&key=${encodeURIComponent(key)}`,
            { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) },
          );
          if (!response.ok) throw new Error("HTTP request failed");
          payload = (await response.json()) as typeof payload;
          break;
        } catch {
          checkCancelled(signal);
          if (attempt === 2)
            throw new AppError(
              "TOOL",
              "Google elevation request failed after 3 attempts",
            );
          try {
            await this.sleep(1000 * 2 ** attempt, signal);
          } catch {
            checkCancelled(signal);
            throw new AppError("TOOL", "Google elevation retry failed");
          }
        }
      }
      if (!payload || !["OK", "ZERO_RESULTS"].includes(payload.status ?? ""))
        throw new AppError(
          "TOOL",
          `Google elevation API: ${["OVER_QUERY_LIMIT", "REQUEST_DENIED", "INVALID_REQUEST", "UNKNOWN_ERROR"].includes(payload?.status ?? "") ? payload!.status : "invalid response"}`,
        );
      for (let i = 0; i < group.length; i++) {
        const elevation =
          payload.status === "OK" ? payload.results?.[i]?.elevation : undefined;
        values.push(
          typeof elevation === "number" && Number.isFinite(elevation)
            ? roundElevation(elevation)
            : null,
        );
      }
    }
    return values;
  }
}
