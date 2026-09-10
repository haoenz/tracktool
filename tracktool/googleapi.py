"""Google Maps API clients: Elevation (batched) and reverse Geocoding.

Ports Invoke-GoogleApiRequest (exponential-backoff retry, quota/auth errors are
fatal), Get-AltitudeFromGoogle (URL-length batching: max 512 locations and
8192-char URL per request) and Get-LocationFromGoogle (address component
extraction with locality fallback chain).
"""

import time
from dataclasses import dataclass

import requests

from . import coords as coords_mod
from . import log
from .config import Config, config

ELEVATION_URL_PREFIX = "https://maps.googleapis.com/maps/api/elevation/json?locations="
MAX_URL_LENGTH = 8192
MAX_LOCATIONS_PER_REQUEST = 512

GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"


class GoogleApiError(Exception):
    pass


def _resolve_key(override: str | None, cfg: Config) -> str:
    key = cfg.google_api_key(override)
    if not key:
        log.error("Google Maps API key not found in configuration")
        raise GoogleApiError("API key is required. Set TRACKTOOL_GOOGLE_API_KEY, pass --api-key, or set it in config")
    return key


def _resolve_decimal(coordinate: str) -> str:
    """Any accepted coordinate form -> 'lat,lon' decimal."""
    if coords_mod.is_decimal_coord(coordinate):
        return coordinate
    decimal = coords_mod.decimal_coord(coordinate)
    if not decimal:
        log.error(f"Failed to convert coordinate: {coordinate}")
        raise GoogleApiError(f"Invalid coordinate format: {coordinate}")
    return decimal


def _request_json(api_url: str, api_name: str, retry_count: int = 3, timeout: int = 30) -> dict:
    """GET with exponential backoff; fatal on quota/denied statuses."""
    attempt = 0
    while attempt < retry_count:
        attempt += 1
        try:
            response = requests.get(api_url, timeout=timeout)
            response.raise_for_status()
            payload = response.json()
        except requests.RequestException as exc:
            if attempt < retry_count:
                delay = 2 ** (attempt - 1)
                log.warning(
                    f"{api_name} transient error (attempt {attempt}/{retry_count}): {exc}. Retrying in {delay}s...")
                time.sleep(delay)
                continue
            log.error(f"{api_name} failed after {retry_count} attempt(s): {exc}")
            raise GoogleApiError(str(exc)) from exc

        status = payload.get("status")
        if status in ("OK", "ZERO_RESULTS"):
            return payload
        if status == "OVER_QUERY_LIMIT":
            log.error("Google API quota exceeded. Try again tomorrow.")
            raise GoogleApiError("API quota exceeded")
        if status == "REQUEST_DENIED":
            log.error("API request denied. Check your API key.")
            raise GoogleApiError("API key invalid or unauthorized")
        log.error(f"{api_name} returned error status: {status}")
        if payload.get("error_message"):
            log.error(f"Error message: {payload['error_message']}")
        raise GoogleApiError(f"API request failed: {status}")

    raise GoogleApiError(f"{api_name} exhausted retries")  # unreachable safeguard


def _batch_coordinates(decimal_coords: list[str]) -> list[list[str]]:
    """Split coordinates into batches honoring the 512-location and URL-length caps."""
    url_suffix_len = len("&key=") + 40  # key length varies; keep headroom like the original
    available = MAX_URL_LENGTH - len(ELEVATION_URL_PREFIX) - url_suffix_len

    batches: list[list[str]] = []
    current: list[str] = []
    current_length = 0
    for coord in decimal_coords:
        add_length = len(coord) + (1 if current else 0)  # '|' separator
        if current and (len(current) >= MAX_LOCATIONS_PER_REQUEST or current_length + add_length > available):
            batches.append(current)
            current = []
            current_length = 0
            add_length = len(coord)
        current.append(coord)
        current_length += add_length
    if current:
        batches.append(current)
    return batches


def get_altitudes(
    coordinates: list[str],
    api_key: str | None = None,
    retry_count: int = 3,
    timeout: int = 30,
    cfg: Config = config,
) -> list[float | None]:
    """Query elevations for coordinates in any supported format, auto-batched."""
    key = _resolve_key(api_key, cfg)
    if not coordinates:
        return []

    decimal_coords = [_resolve_decimal(c) for c in coordinates]
    batches = _batch_coordinates(decimal_coords)
    log.debug(f"Total coordinates: {len(decimal_coords)}, batches: {len(batches)}")

    elevations: list[float | None] = []
    for index, batch in enumerate(batches, 1):
        locations = "|".join(batch)
        api_url = f"{ELEVATION_URL_PREFIX}{locations}&key={key}"
        log.debug(f"Batch {index}/{len(batches)}: {len(batch)} coords, URL length {len(api_url)}")

        response = _request_json(api_url, f"Google Elevation API (batch {index}/{len(batches)})", retry_count, timeout)
        if response.get("status") == "OK":
            log.debug(f"Batch {index} OK, received {len(response.get('results', []))} results")
            for result in response.get("results", []):
                elevation = result.get("elevation")
                elevations.append(round(elevation, 2) if elevation is not None else None)
    return elevations


@dataclass
class Location:
    country: str = ""
    state: str = ""
    city: str = ""
    country_code_iso: str = ""


def _component_value(results: list[dict], types: list[str], short_name: bool = False) -> str:
    """First match on types[0] across all results, then any of types[1:]."""
    for result in results:
        for component in result.get("address_components", []):
            if types[0] in component.get("types", []):
                return component.get("short_name" if short_name else "long_name", "")
    if len(types) > 1:
        for result in results:
            for component in result.get("address_components", []):
                for wanted in types[1:]:
                    if wanted in component.get("types", []):
                        return component.get("short_name" if short_name else "long_name", "")
    return ""


def _parse_reverse_geocode(results: list[dict]) -> Location:
    return Location(
        country=_component_value(results, ["country"]),
        state=_component_value(results, ["administrative_area_level_1"]),
        city=_component_value(results, ["locality", "administrative_area_level_2", "postal_town",
                                         "sublocality_level_1", "sublocality"]),
        country_code_iso=_component_value(results, ["country"], short_name=True),
    )


def get_location(
    coordinate: str,
    api_key: str | None = None,
    retry_count: int = 3,
    timeout: int = 30,
    language: str = "en",
    cfg: Config = config,
) -> Location:
    """Reverse geocode one coordinate."""
    key = _resolve_key(api_key, cfg)
    decimal = _resolve_decimal(coordinate)

    api_url = f"{GEOCODE_URL}?latlng={decimal}&language={language}&key={key}"
    log.debug(f"Querying Google reverse geocoding API for coordinate: {decimal}")

    response = _request_json(api_url, "Google Geocoding API", retry_count, timeout)
    if response.get("status") == "ZERO_RESULTS":
        log.warning(f"No reverse geocoding result found for coordinate: {decimal}")
        return Location()

    results = response.get("results", [])
    location = _parse_reverse_geocode(results)
    log.debug(
        f"Reverse geocoding OK: {location.country} / {location.state} / {location.city} / {location.country_code_iso}")
    return location
