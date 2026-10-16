import { administrativeLocation } from "../domain/administrative-location.js";
import type {
  GeocodeResponse,
  GeocodeResult,
} from "../shared/endpoint-location.js";
import type { GeocodePort, Location } from "../services/media-ports.js";
import { AppError, checkCancelled } from "../domain/errors.js";
import { setTimeout as delay } from "node:timers/promises";
export class GoogleGeocode implements GeocodePort {
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly sleep = (ms: number, signal: AbortSignal) =>
      delay(ms, undefined, { signal }),
  ) {}
  async get(
    point: [number, number],
    key: string,
    language: string,
    signal: AbortSignal,
  ): Promise<Location> {
    const payload = await this.query(point, key, language, signal);
    const components =
      payload.status === "ZERO_RESULTS"
        ? []
        : (payload.results ?? []).flatMap((r) => r.address_components ?? []);
    const value = (types: string[], short = false) => {
      const c =
        components.find((c) => c.types.includes(types[0]!)) ??
        components.find((c) => types.slice(1).some((t) => c.types.includes(t)));
      return c?.[short ? "short_name" : "long_name"] ?? "";
    };
    return {
      country: value(["country"]),
      state: value(["administrative_area_level_1"]),
      city: value([
        "locality",
        "administrative_area_level_2",
        "postal_town",
        "sublocality_level_1",
        "sublocality",
      ]),
      country_code_iso: value(["country"], true),
    };
  }
  async getAdministrative(
    point: [number, number],
    key: string,
    language: string,
    signal: AbortSignal,
  ) {
    const payload = await this.query(point, key, language, signal);
    return administrativeLocation(
      payload.results ?? [],
      payload.status === "ZERO_RESULTS",
      { rawResponse: payload },
    );
  }
  private async query(
    point: [number, number],
    key: string,
    language: string,
    signal: AbortSignal,
  ) {
    if (!key) throw new AppError("TOOL", "Google API key is required");
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.search = new URLSearchParams({
      latlng: point.join(","),
      key,
      language,
    }).toString();
    let payload:
      | {
          status?: string;
          results?: GeocodeResult[];
          [key: string]: unknown;
        }
      | undefined;
    for (let attempt = 0; attempt < 3; attempt++)
      try {
        checkCancelled(signal);
        const response = await this.request(url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        });
        if (!response.ok) throw new Error("HTTP failure");
        payload = (await response.json()) as typeof payload;
        break;
      } catch {
        checkCancelled(signal);
        if (attempt === 2)
          throw new AppError(
            "TOOL",
            "Google geocoding request failed after 3 attempts",
          );
        try {
          await this.sleep(1000 * 2 ** attempt, signal);
        } catch {
          checkCancelled(signal);
          throw new AppError("TOOL", "Google retry failed");
        }
      }
    if (!payload || !["OK", "ZERO_RESULTS"].includes(payload.status ?? ""))
      throw new AppError(
        "TOOL",
        `Google geocoding API: ${["OVER_QUERY_LIMIT", "REQUEST_DENIED", "INVALID_REQUEST", "UNKNOWN_ERROR"].includes(payload?.status ?? "") ? payload!.status : "invalid response"}`,
      );
    if (!Array.isArray(payload.results))
      throw new AppError("TOOL", "Google geocoding API: invalid response");
    return payload as GeocodeResponse;
  }
}
