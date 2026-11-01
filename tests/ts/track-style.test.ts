import { expect, test } from "vitest";
import { defaultMapState, MapStyleSchema } from "../../src/shared/map-state.js";
import {
  defaultTrackAppearance,
  TrackAppearanceSchema,
} from "../../src/shared/track-style.js";
import { printDocument, PrintDocumentSchema } from "../../src/shared/print.js";

test("track appearance validates bounds and opaque RGB colors", () => {
  for (const width of [1, 8]) {
    const style = defaultTrackAppearance();
    style.width = style.current.width = width;
    style.categories.Default.opacity = width === 1 ? 0.05 : 1;
    expect(TrackAppearanceSchema.safeParse(style).success).toBe(true);
  }
  for (const width of [0, 8.1, NaN, Infinity]) {
    expect(
      TrackAppearanceSchema.safeParse({ ...defaultTrackAppearance(), width })
        .success,
    ).toBe(false);
    const style = defaultTrackAppearance();
    style.current.width = width;
    expect(TrackAppearanceSchema.safeParse(style).success).toBe(false);
  }
  for (const opacity of [0, 0.049, 1.01, NaN]) {
    const style = defaultTrackAppearance();
    style.categories.Flight.opacity = opacity;
    expect(TrackAppearanceSchema.safeParse(style).success).toBe(false);
  }
  for (const color of ["red", "#fff", "#ff000080", "#zzzzzz"]) {
    const style = defaultTrackAppearance();
    style.current.color = color;
    expect(TrackAppearanceSchema.safeParse(style).success).toBe(false);
  }
});

test("display defaults fill missing appearance without sharing mutable state", () => {
  const style: Record<string, unknown> = { ...defaultMapState().style };
  delete style.tracks;
  const first = MapStyleSchema.parse(style);
  first.tracks.categories.Flight.color = "#abcdef";
  expect(MapStyleSchema.parse(style).tracks).toEqual(defaultTrackAppearance());
});

test("print documents preserve a detached track appearance snapshot", () => {
  const state = defaultMapState();
  state.style.tracks.width = 6.5;
  state.style.tracks.categories.Flight = { color: "#123abc", opacity: 0.85 };
  state.style.tracks.current = { color: "#abcdef", width: 7 };
  const document = printDocument(state, "temporary-archive", []);
  expect(
    PrintDocumentSchema.parse(JSON.parse(JSON.stringify(document))).style
      .tracks,
  ).toEqual(state.style.tracks);
  state.style.tracks.categories.Flight.color = "#ffffff";
  expect(document.style.tracks.categories.Flight.color).toBe("#123abc");
});
