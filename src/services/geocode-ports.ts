export interface Location {
  country: string;
  state: string;
  city: string;
  country_code_iso: string;
}
export interface GeocodePort {
  get(
    point: [number, number],
    key: string,
    language: string,
    signal: AbortSignal,
  ): Promise<Location>;
}
