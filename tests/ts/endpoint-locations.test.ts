import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { administrativeLocation } from "../../dist/node/domain/administrative-location.js";
import { AppError } from "../../dist/node/domain/errors.js";
import {
  readTransaction,
  transaction,
} from "../../dist/node/infrastructure/archive/database.js";
import {
  deleteEntry,
  previewDeletion,
} from "../../dist/node/infrastructure/archive/deletion.js";
import {
  currentEndpointLocations,
  fillEndpointLocations,
} from "../../dist/node/infrastructure/archive/endpoint-locations.js";
import { fullBackup } from "../../dist/node/infrastructure/archive/full-backup.js";
import { trackDetail } from "../../dist/node/infrastructure/archive/track-reader.js";
import { VersionStore } from "../../dist/node/infrastructure/archive/versions.js";
import {
  ArchiveWriter,
  addEntry,
} from "../../dist/node/infrastructure/archive/writer.js";
import { GoogleGeocode } from "../../dist/node/infrastructure/geocode.js";
import { XmlWorkers } from "../../dist/node/infrastructure/xml/client.js";
import type { AddressComponent } from "../../dist/node/shared/endpoint-location.js";
const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of clean.splice(0).reverse()) await f();
});
const component = (
  type: string,
  name: string,
  short?: string,
): AddressComponent => ({ types: [type], long_name: name, short_name: short });
const cn = [
  component("country", "中国", "CN"),
  component("administrative_area_level_1", "浙江省"),
  component("locality", "杭州市"),
  component("sublocality_level_1", "西湖区"),
];
const location = administrativeLocation([{ address_components: cn }]);
const signal = new AbortController().signal;
async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tracktool-endpoints-"));
  clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "archive.sqlite3");
  await new ArchiveWriter().init(dir);
  const raw = Buffer.from(
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><MultiGeometry><LineString><coordinates>120,30 121,31</coordinates></LineString><LineString><coordinates>122,32 123,33</coordinates></LineString></MultiGeometry></Placemark></Document></kml>',
  );
  const entry = transaction(file, true, (db) =>
    addEntry(db, "a.kml", raw, "Default"),
  );
  const xml = new XmlWorkers();
  clean.push(() => xml.close());
  const getAdministrative = vi.fn(async () => structuredClone(location));
  return { dir, file, entry, xml, geocoder: { getAdministrative }, raw };
}
it("maps Chinese locality types, preserves provenance, handles municipalities and missing levels", () => {
  expect(location).toMatchObject({
    province: "浙江省",
    city: "杭州市",
    district: "西湖区",
    status: "complete",
    sources: { district: "sublocality_level_1" },
  });
  const municipality = administrativeLocation([
    {
      address_components: [
        cn[0]!,
        component("administrative_area_level_1", "北京市"),
        component("locality", "海淀区"),
      ],
    },
  ]);
  expect(municipality).toMatchObject({
    province: "北京市",
    city: "北京市",
    district: "海淀区",
    status: "complete",
  });
  const county = administrativeLocation([
    { address_components: [cn[0]!, cn[1]!, component("locality", "桐庐县")] },
  ]);
  expect(county).toMatchObject({
    city: null,
    district: "桐庐县",
    status: "partial",
  });
  expect(administrativeLocation([], true).status).toBe("zero_results");
  // Different results must not be stitched into a fictional complete hierarchy.
  expect(
    administrativeLocation([
      { address_components: cn.slice(0, 2) },
      { address_components: cn.slice(2) },
    ]).status,
  ).toBe("partial");
});
it("shares the Google request implementation while preserving the existing media result shape", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ status: "OK", results: [{ address_components: cn }] }),
      ),
    );
  const result = await new GoogleGeocode(request).getAdministrative(
    [30, 120],
    "secret",
    "zh-CN",
    signal,
  );
  expect(result).toEqual(location);
  const url = request.mock.calls[0]![0] as URL;
  expect(url.searchParams.get("latlng")).toBe("30,120");
  expect(url.searchParams.get("language")).toBe("zh-CN");
});
it("persists, resumes, deduplicates exact coordinates and survives full backup and controlled deletion", async () => {
  const f = await fixture();
  const revision = readTransaction(f.file, (db) =>
    db.prepare("SELECT revision FROM archive_meta").get(),
  );
  expect(
    await fillEndpointLocations(f.file, f.xml, f.geocoder, "key", signal),
  ).toMatchObject({ queries: 2, saved: 2 });
  expect(f.geocoder.getAdministrative.mock.calls).toHaveLength(2);
  expect(
    currentEndpointLocations(f.file, f.entry.id).endpoints.map((v) => [
      v.endpoint,
      v.latitude,
      v.longitude,
    ]),
  ).toEqual([
    ["start", 30, 120],
    ["end", 33, 123],
  ]);
  expect(trackDetail(f.file, f.entry.id).endpoint_locations).toHaveLength(2);
  expect(
    readTransaction(f.file, (db) =>
      db.prepare("SELECT revision FROM archive_meta").get(),
    ),
  ).toEqual(revision);
  expect(
    await fillEndpointLocations(f.file, f.xml, f.geocoder, "key", signal),
  ).toMatchObject({ skipped: 1, queries: 0 });
  const second = transaction(f.file, true, (db) =>
    addEntry(db, "b.kml", f.raw, "Default"),
  );
  expect(
    await fillEndpointLocations(f.file, f.xml, f.geocoder, "key", signal, {
      limit: 1,
    }),
  ).toMatchObject({ skipped: 1, reused: 2, queries: 0, saved: 2 });
  const backup = path.join(f.dir, "backup.sqlite3");
  await fullBackup(f.file, backup);
  expect(currentEndpointLocations(backup, second.id).endpoints).toHaveLength(2);
  const plan = previewDeletion(f.file, { entry_id: f.entry.id });
  deleteEntry(f.file, {
    archive_id: plan.archive_id,
    expected: plan.expected,
    request_key: "delete",
  });
  expect(
    readTransaction(f.file, (db) =>
      db.prepare("SELECT count(*) AS n FROM track_endpoint_locations").get(),
    ),
  ).toEqual({ n: 2 });
});
it("reordered/hidden segments get fresh associations without changing original names or other snapshots", async () => {
  const f = await fixture();
  await fillEndpointLocations(f.file, f.xml, f.geocoder, "key", signal);
  const detail = trackDetail(f.file, f.entry.id);
  const store = new VersionStore(f.file);
  store.publish({
    archive_id: detail.archive_id,
    request_key: "hide",
    kind: "presentation",
    algorithm_version: "test",
    params: {},
    inputs: [detail.entry],
    outputs: [
      {
        kind: "presentation",
        entry_id: f.entry.id,
        settings: {
          ...detail.settings,
          order: [...detail.settings.order].reverse(),
          ignored: [detail.settings.order[0]!],
        },
      },
    ],
  });
  expect(currentEndpointLocations(f.file, f.entry.id).endpoints).toHaveLength(
    0,
  );
  expect(
    await fillEndpointLocations(f.file, f.xml, f.geocoder, "key", signal),
  ).toMatchObject({ queries: 1, reused: 1, saved: 2 });
  expect(
    currentEndpointLocations(f.file, f.entry.id).endpoints.map((v) => [
      v.latitude,
      v.longitude,
    ]),
  ).toEqual([
    [32, 122],
    [33, 123],
  ]);
  expect(
    trackDetail(
      f.file,
      f.entry.id,
      detail.entry.version_id,
      detail.entry.presentation_id,
    ).endpoint_locations,
  ).toHaveLength(2);
});
it("keeps completed endpoints when the next request fails and retries only missing work", async () => {
  const f = await fixture();
  f.geocoder.getAdministrative.mockRejectedValueOnce(
    new AppError("TOOL", "Google geocoding request failed after 3 attempts"),
  );
  expect(
    await fillEndpointLocations(f.file, f.xml, f.geocoder, "key", signal),
  ).toMatchObject({ failed: 1, saved: 0 });
  f.geocoder.getAdministrative
    .mockResolvedValueOnce(location)
    .mockRejectedValueOnce(
      new AppError("TOOL", "Google geocoding request failed after 3 attempts"),
    );
  expect(
    await fillEndpointLocations(f.file, f.xml, f.geocoder, "key", signal),
  ).toMatchObject({ failed: 1, saved: 1 });
  expect(
    await fillEndpointLocations(f.file, f.xml, f.geocoder, "key", signal),
  ).toMatchObject({ queries: 1, saved: 1 });
});
it("partial results are retained and retried only on explicit request", async () => {
  const f = await fixture();
  f.geocoder.getAdministrative.mockResolvedValue(
    administrativeLocation([], true),
  );
  expect(
    await fillEndpointLocations(f.file, f.xml, f.geocoder, "key", signal),
  ).toMatchObject({ incomplete: 2 });
  expect(
    await fillEndpointLocations(f.file, f.xml, f.geocoder, "key", signal),
  ).toMatchObject({ queries: 0 });
  f.geocoder.getAdministrative.mockResolvedValue(location);
  expect(
    await fillEndpointLocations(f.file, f.xml, f.geocoder, "key", signal, {
      retryIncomplete: true,
    }),
  ).toMatchObject({ queries: 2, incomplete: 0 });
});
it("rejects results if the active presentation changes during the network request", async () => {
  const f = await fixture();
  const detail = trackDetail(f.file, f.entry.id);
  f.geocoder.getAdministrative.mockImplementationOnce(async () => {
    new VersionStore(f.file).publish({
      archive_id: detail.archive_id,
      request_key: "race",
      kind: "presentation",
      algorithm_version: "test",
      params: {},
      inputs: [detail.entry],
      outputs: [
        {
          kind: "presentation",
          entry_id: f.entry.id,
          settings: {
            ...detail.settings,
            ignored: [detail.settings.order[0]!],
          },
        },
      ],
    });
    return location;
  });
  expect(
    await fillEndpointLocations(f.file, f.xml, f.geocoder, "key", signal),
  ).toMatchObject({ failed: 1, saved: 0 });
  expect(currentEndpointLocations(f.file, f.entry.id).endpoints).toHaveLength(
    0,
  );
  expect(
    trackDetail(
      f.file,
      f.entry.id,
      detail.entry.version_id,
      detail.entry.presentation_id,
    ).endpoint_locations,
  ).toHaveLength(0);
});
it("aborting a lookup never writes its result", async () => {
  const f = await fixture(),
    controller = new AbortController();
  f.geocoder.getAdministrative.mockImplementationOnce(async () => {
    controller.abort();
    return location;
  });
  await expect(
    fillEndpointLocations(f.file, f.xml, f.geocoder, "key", controller.signal),
  ).rejects.toThrow();
  expect(currentEndpointLocations(f.file, f.entry.id).endpoints).toHaveLength(
    0,
  );
});
it("coalesces concurrent requests for identical endpoints", async () => {
  const f = await fixture();
  transaction(f.file, true, (db) => addEntry(db, "b.kml", f.raw, "Default"));
  f.geocoder.getAdministrative.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return location;
  });
  expect(
    await fillEndpointLocations(f.file, f.xml, f.geocoder, "key", signal),
  ).toMatchObject({ tracks: 2, queries: 2, reused: 2, saved: 4 });
  expect(f.geocoder.getAdministrative).toHaveBeenCalledTimes(2);
});
it("counts malformed tracks toward the requested batch limit", async () => {
  const f = await fixture();
  transaction(f.file, true, (db) =>
    addEntry(db, "0bad.kml", Buffer.from("broken XML"), "Default"),
  );
  expect(
    await fillEndpointLocations(f.file, f.xml, f.geocoder, "key", signal, {
      limit: 1,
    }),
  ).toMatchObject({ tracks: 1, failed: 1, queries: 0, saved: 0 });
  expect(f.geocoder.getAdministrative).not.toHaveBeenCalled();
});
it("offline mode reports missing evidence without calling Google or manufacturing a result", async () => {
  const f = await fixture();
  expect(
    await fillEndpointLocations(f.file, f.xml, f.geocoder, "", signal, {
      offline: true,
    }),
  ).toMatchObject({ queries: 0, pending: 2, saved: 0 });
  expect(f.geocoder.getAdministrative).not.toHaveBeenCalled();
  expect(currentEndpointLocations(f.file, f.entry.id).endpoints).toHaveLength(
    0,
  );
});
it("reuses an explicitly supplied full response and its original query time without network access", async () => {
  const f = await fixture();
  const time = "2026-10-16T00:00:00.000Z";
  const response = {
    status: "OK" as const,
    results: [{ address_components: cn }],
    plus_code: { global_code: "retained" },
  };
  expect(
    await fillEndpointLocations(f.file, f.xml, f.geocoder, "", signal, {
      offline: true,
      evidence: [
        {
          latitude: 30,
          longitude: 120,
          language: "zh-CN",
          queriedAt: time,
          response,
        },
        {
          latitude: 33,
          longitude: 123,
          language: "zh-CN",
          queriedAt: time,
          response,
        },
      ],
    }),
  ).toMatchObject({ queries: 0, reused: 2, saved: 2 });
  expect(f.geocoder.getAdministrative).not.toHaveBeenCalled();
  for (const row of currentEndpointLocations(f.file, f.entry.id).endpoints) {
    expect(row.queried_at).toBe(time);
    expect(row.location.raw_response).toEqual(response);
  }
});

it("refreshes complete endpoint evidence offline without changing query time or reading geometry", async () => {
  const f = await fixture();
  await fillEndpointLocations(f.file, f.xml, f.geocoder, "key", signal);
  const before = currentEndpointLocations(f.file, f.entry.id);
  f.geocoder.getAdministrative.mockClear();
  const run = vi.spyOn(f.xml, "run");
  try {
    const result = await fillEndpointLocations(
      f.file,
      f.xml,
      f.geocoder,
      "",
      signal,
      { offline: true, refresh: true },
    );
    expect(result).toMatchObject({ queries: 0, reparsed: 2, saved: 2 });
    expect(f.geocoder.getAdministrative).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(currentEndpointLocations(f.file, f.entry.id)).toEqual(before);
  } finally {
    run.mockRestore();
  }
});
