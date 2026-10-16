import type {
  AdministrativeField,
  AdministrativeLocation,
  AdministrativeResolution,
  GeocodeResponse,
  GeocodeResult,
} from "../shared/endpoint-location.js";
import {
  ADMINISTRATIVE_FIELDS as fields,
  parseAdministrativeCandidate,
  sameBinding,
  type AdministrativeCandidate,
  type Binding,
} from "./administrative-profiles.js";

export const ADMINISTRATIVE_RESOLVER_VERSION = 2;
function depth(c: AdministrativeCandidate) {
  return Math.max(-1, ...fields.map((f, i) => (c.bindings[f] ? i : -1)));
}
function tier(c: AdministrativeCandidate, field: AdministrativeField) {
  if (c.result.partial_match) return 0;
  if (c.bindings[field]?.self) return 3;
  if (c.result.types?.includes("plus_code")) return 1;
  return 2;
}
function rank(c: AdministrativeCandidate) {
  const d = depth(c);
  const binding = c.bindings[fields[d] ?? "country"];
  return [
    c.countryCode ? 1 : 0,
    c.result.partial_match ? 0 : 1,
    d,
    tier(c, fields[d] ?? "country"),
    -(binding?.preference ?? 0),
    Object.keys(c.bindings).length,
    // With otherwise equal evidence, prefer the localized political hierarchy.
    Object.values(c.bindings).filter((b) => /[\u3400-\u9fff]/.test(b.name))
      .length,
  ];
}
function order(a: AdministrativeCandidate, b: AdministrativeCandidate) {
  const left = rank(a),
    right = rank(b);
  for (let i = 0; i < left.length; i++)
    if (left[i] !== right[i]) return right[i]! - left[i]!;
  // Independent of provider result order (except the reported evidence index).
  const identity = (c: AdministrativeCandidate) =>
    JSON.stringify(
      fields.map((f) => [f, c.bindings[f]?.name, c.bindings[f]?.type]),
    );
  return identity(a).localeCompare(identity(b), "en");
}
function equivalent(
  a: AdministrativeCandidate,
  b: AdministrativeCandidate,
  field: AdministrativeField,
) {
  if (field === "country" && a.countryCode && b.countryCode)
    return a.countryCode === b.countryCode;
  const x = a.bindings[field],
    y = b.bindings[field];
  if (!x || !y) return true;
  if (
    x.self &&
    y.self &&
    a.result.place_id &&
    a.result.place_id === b.result.place_id
  )
    return true;
  return sameBinding(x, y);
}
/** Resolve a coherent hierarchy. Conflicting peer evidence collapses to its common ancestor. */
export function administrativeLocation(
  results: GeocodeResult[],
  zeroResults = false,
  options: { rawResponse?: GeocodeResponse; legacy?: boolean } = {},
): AdministrativeLocation {
  const candidates = (zeroResults ? [] : results)
    .map(parseAdministrativeCandidate)
    .filter((c) => depth(c) >= 0)
    .sort(order);
  const base = candidates[0];
  const bindings: Partial<Record<AdministrativeField, Binding>> = {
    ...base?.bindings,
  };
  const resolution: AdministrativeResolution = {
    mode: "fallback",
    fields: {
      country: "missing",
      province: "missing",
      city: "missing",
      district: "missing",
    },
    selected_result_index: base?.index ?? null,
    conflict_fields: [],
    evidence: {},
    reasons: [],
    hierarchy: [],
  };
  if (options.legacy) resolution.reasons.push("legacy_evidence_only");
  const conflict = new Set<AdministrativeField>();
  // Resolve each level independently before discarding descendants. This can also retain
  // the common province when city/district candidates disagree.
  for (const [i, field] of fields.entries()) {
    const evidence = candidates.filter(
      (c) =>
        c.bindings[field] &&
        !c.result.partial_match &&
        (field === "country" ||
          !base?.countryCode ||
          c.countryCode === base.countryCode),
    );
    const self = evidence.filter((c) => c.bindings[field]!.self);
    let peers: AdministrativeCandidate[];
    if (self.length) {
      const preference = Math.min(
        ...self.map((c) => c.bindings[field]!.preference),
      );
      peers = self.filter((c) => c.bindings[field]!.preference === preference);
    } else {
      const maxTier = Math.max(0, ...evidence.map((c) => tier(c, field)));
      peers = evidence.filter((c) => tier(c, field) === maxTier);
    }
    if (field === "country") peers = evidence; // Cross-border uncertainty must never be hidden by ranking.
    const anchor = peers[0];
    if (!anchor) continue;
    const different =
      peers.some((c) => !equivalent(c, anchor, field)) ||
      (!!base?.bindings[field] &&
        self.length > 0 &&
        !equivalent(base, anchor, field));
    if (different) {
      conflict.add(field);
      for (const lower of fields.slice(i)) delete bindings[lower];
      resolution.conflict_fields.push(field);
      resolution.reasons.push(`conflicting_${field}`);
      break;
    }
    // Never graft an unrelated parent onto the selected child chain. Missing fields
    // stay missing unless another result explicitly identifies the SAME entity.
    if (
      !bindings[field] &&
      base?.result.place_id &&
      base.result.place_id === anchor.result.place_id &&
      fields.every((f) => equivalent(base, anchor, f))
    )
      bindings[field] = anchor.bindings[field];
  }
  // All candidates may agree on a parent absent from a selected partial-match result;
  // prefer a coherent result with that parent, rather than independently filling fields.
  let countryCode = bindings.country ? (base?.countryCode ?? null) : null;
  if (conflict.has("country")) countryCode = null;
  const sources: Record<string, string> = {};
  for (const field of fields) {
    const b = bindings[field];
    resolution.fields[field] = conflict.has(field)
      ? "conflict"
      : b
        ? "resolved"
        : !resolution.conflict_fields.length && base?.notApplicable.has(field)
          ? "not_applicable"
          : "missing";
    if (b) {
      sources[field] = b.type;
      resolution.evidence[field] = {
        result_index: b.resultIndex,
        component_type: b.type,
      };
      resolution.hierarchy.push({ field, name: b.name });
    }
  }
  if (resolution.conflict_fields.length)
    resolution.reasons.push("common_ancestor_fallback");
  else if (fields.some((f) => resolution.fields[f] === "missing"))
    resolution.reasons.push("missing_administrative_level");
  if (fields.some((f) => resolution.fields[f] === "not_applicable"))
    resolution.reasons.push("regional_hierarchy");
  const complete = fields.every((f) =>
    ["resolved", "not_applicable"].includes(resolution.fields[f]),
  );
  resolution.mode = zeroResults
    ? "zero_results"
    : complete
      ? "resolved"
      : "fallback";
  const value = (field: AdministrativeField) => bindings[field]?.name ?? null;
  return {
    country: value("country"),
    country_code: countryCode,
    province: value("province"),
    city: value("city"),
    district: value("district"),
    sources,
    components: base?.result.address_components ?? [],
    status: zeroResults ? "zero_results" : complete ? "complete" : "partial",
    resolution,
    raw_source: options.legacy ? "legacy_components" : "full_response",
    ...(!options.legacy
      ? {
          raw_response: options.rawResponse ?? {
            status: zeroResults ? ("ZERO_RESULTS" as const) : ("OK" as const),
            results,
          },
        }
      : {}),
  };
}
export function reparseAdministrativeLocation(
  location: AdministrativeLocation,
) {
  if (location.raw_response)
    return administrativeLocation(
      location.raw_response.results,
      location.raw_response.status === "ZERO_RESULTS",
      { rawResponse: location.raw_response },
    );
  return administrativeLocation(
    [{ address_components: location.components }],
    location.status === "zero_results",
    { legacy: true },
  );
}
