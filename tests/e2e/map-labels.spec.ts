import { test, expect } from "@playwright/test";
import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";
import type {} from "../../src/drawing/globals.js";
import type { MapConfig } from "../../src/shared/map.js";
import type { MapState } from "../../src/shared/map-state.js";
import { labelVectorTile } from "../../dist/node/infrastructure/maps/vector-labels.js";
import { resetDisplay } from "./display-reset.js";

for (const place of ["country", "state"] as const)
  for (const tied of [false, true])
    test(`${place} labels keep ${tied ? "equal-rank winners" : "important places"} while panning across tiles`, async ({
      page,
      request,
    }) => {
      await resetDisplay(request);
      const names = ["主要地名", "次要地名"];
      const index = geojsonvt(
        {
          type: "FeatureCollection",
          features: names.map((name, i) => ({
            type: "Feature",
            id: 100 + i,
            properties: {
              name,
              class: place,
              rank: tied ? 2 : i === 0 ? 1 : 6,
            },
            geometry: {
              type: "Point",
              coordinates: [i === 0 ? -0.05 : 0.05, 20],
            },
          })),
        },
        {
          extent: 4096,
          tolerance: 0,
          buffer: 0,
          maxZoom: 14,
          indexMaxZoom: 5,
          indexMaxPoints: 0,
        },
      );
      const tileColumns = new Set<number>();
      await page.route("**/tiles/vector/**", async (route) => {
        const match = new URL(route.request().url()).pathname.match(
          /\/(\d+)\/(\d+)\/(\d+)\.pbf$/,
        )!;
        const [z, x, y] = match.slice(1).map(Number) as [
          number,
          number,
          number,
        ];
        const tile = index.getTile(z, x, y) ?? { features: [] };
        if (tile.features.length) tileColumns.add(x);
        await route.fulfill({
          contentType: "application/x-protobuf",
          body: labelVectorTile(
            Buffer.from(
              vtpbf.fromGeojsonVt(
                { place: tile },
                { version: 2, extent: 4096 },
              ),
            ),
          ),
        });
      });
      // CJK glyphs are generated locally; no external glyph requests in tests.
      await page.route("**/glyphs/**", (route) =>
        route.fulfill({
          contentType: "application/x-protobuf",
          body: Buffer.alloc(0),
        }),
      );
      await page.route("**/api/bootstrap", async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as {
          config: MapConfig;
          state: MapState;
        };
        body.config.vectorLayers!.place = {
          name: "String",
          class: "String",
          rank: "Number",
        };
        body.state.style.features.places = "all";
        body.state.camera = {
          center: [-1, 20],
          zoom: place === "country" ? 3 : 5,
        };
        await route.fulfill({ response, json: body });
      });
      await page.goto("/map");
      await page.waitForFunction(() =>
        window.renderer?.map.getLayer("place-country"),
      );
      let winner: string | undefined;
      let geometry: unknown;
      for (const longitude of [-1, 1, -2, 2, -1]) {
        const result = await page.evaluate(
          async ({ longitude, place }) => {
            const r = window.renderer!;
            const scale =
              r.mapElement.getBoundingClientRect().width /
              r.mapElement.clientWidth;
            const zoom = (place === "country" ? 3 : 5) - Math.log2(scale);
            await new Promise<void>((resolve) => {
              r.map.once("idle", () => resolve());
              r.setCamera({ center: [longitude, 20], zoom });
            });
            return {
              zoom: r.map.getZoom(),
              expectedZoom: zoom,
              features: r.map
                .queryRenderedFeatures(undefined, {
                  layers: [`place-${place}`],
                })
                .map((feature) => ({
                  name: String(feature.properties["tracktool:name"]),
                  geometry: feature.geometry,
                })),
            };
          },
          { longitude, place },
        );
        expect(result.zoom).toBeCloseTo(result.expectedZoom, 8);
        const displayed = [
          ...new Set(result.features.map((feature) => feature.name)),
        ];
        expect(displayed).toHaveLength(1);
        winner ??= displayed[0]!;
        geometry ??= result.features[0]!.geometry;
        expect(displayed).toEqual([tied ? winner : names[0]]);
        expect(result.features[0]!.geometry).toEqual(geometry);
      }
      expect(tileColumns.size).toBeGreaterThanOrEqual(2);
    });
