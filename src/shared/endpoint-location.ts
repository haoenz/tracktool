export type AddressComponent = {
  types: string[];
  long_name?: string;
  short_name?: string;
};
export type GeocodeResult = {
  address_components?: AddressComponent[];
  types?: string[];
  place_id?: string;
  partial_match?: boolean;
  [key: string]: unknown;
};
export type GeocodeResponse = {
  status: "OK" | "ZERO_RESULTS";
  results: GeocodeResult[];
  [key: string]: unknown;
};
export type AdministrativeField = "country" | "province" | "city" | "district";
export type FieldResolution =
  "resolved" | "missing" | "not_applicable" | "conflict";
export type AdministrativeResolution = {
  mode: "resolved" | "fallback" | "zero_results";
  fields: Record<AdministrativeField, FieldResolution>;
  selected_result_index: number | null;
  conflict_fields: AdministrativeField[];
  evidence: Partial<
    Record<
      AdministrativeField,
      { result_index: number; component_type: string }
    >
  >;
  reasons: string[];
  hierarchy: { field: AdministrativeField; name: string }[];
};
export type AdministrativeLocation = {
  country: string | null;
  country_code: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  sources: Record<string, string>;
  components: AddressComponent[];
  status: "complete" | "partial" | "zero_results";
  resolution?: AdministrativeResolution;
  raw_response?: GeocodeResponse;
  raw_source?: "full_response" | "legacy_components";
};
export type EndpointLocation = {
  endpoint: "start" | "end";
  latitude: number;
  longitude: number;
  language: string;
  provider: "google";
  resolver_version: number;
  queried_at: string;
  location: AdministrativeLocation;
};
