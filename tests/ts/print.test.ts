import { describe, expect, it, afterEach, vi } from "vitest";
import { defaultMapState } from "../../src/shared/map-state.js";
import {
  PrintDocumentSchema,
  printDocument,
  resolvePrintTracks,
} from "../../src/shared/print.js";
import { Exports } from "../../src/infrastructure/maps/export.js";

const screenshot = Buffer.alloc(24);
screenshot.writeUInt32BE(1920, 16);
screenshot.writeUInt32BE(1440, 20);
vi.mock("playwright", () => ({
  chromium: {
    launch: async () => ({
      version: () => "test",
      close: async () => {},
      newPage: async () => ({
        on: () => {},
        goto: async () => {},
        locator: () => ({ waitFor: async () => {} }),
        evaluate: async () => ({ ready: true }),
        screenshot: async () => screenshot,
      }),
    }),
  },
}));
afterEach(() => vi.useRealTimers());
const document = () =>
  printDocument(defaultMapState(), "/old/archive.sqlite3", []);

describe("print documents", () => {
  it("has no track-count cap and validates the complete document", () => {
    const value = document();
    value.tracks = Array.from({ length: 20_001 }, (_, i) => ({
      entry: `${i}.kml`,
      sha256: "a".repeat(64),
    }));
    expect(PrintDocumentSchema.parse(value)).toEqual(value);
  });
  it("matches only paths in the active archive and reports missing/changed tracks", () => {
    const value = document();
    value.tracks = [
      { entry: "deleted.kml", sha256: "a".repeat(64) },
      { entry: "changed.kml", sha256: "b".repeat(64) },
    ];
    const resolved = resolvePrintTracks(value, {
      archive: "/current/archive.sqlite3",
      entries: [
        {
          id: "1",
          entry: "same-content.kml",
          sha256: "a".repeat(64),
          name: "",
          kind: "Default",
          date: "",
        },
        {
          id: "2",
          entry: "changed.kml",
          sha256: "c".repeat(64),
          name: "",
          kind: "Default",
          date: "",
        },
      ],
    });
    expect(resolved.tracks.map((t) => t.entry)).toEqual(["changed.kml"]);
    expect(resolved.warnings).toEqual([
      "文档来自其他轨迹库，已按当前库的 entry 路径匹配轨迹",
      "1 条轨迹已不存在",
      "1 条轨迹已更新",
    ]);
  });
  it("retains only five process-local PNG results for fifteen minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const exports = new Exports(() => "http://127.0.0.1", "test");
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(
        exports.submit(document(), [], {
          state: "unconfigured",
          crs: "wgs84",
          version: null,
          updating: false,
          maxZoom: 14,
        }),
      );
      await vi.waitFor(() =>
        expect(exports.summary(ids.at(-1)!).status).toBe("done"),
      );
    }
    expect(exports.list(document().archive)).toHaveLength(5);
    expect(() => exports.get(ids[0]!)).toThrow("过期");
    vi.setSystemTime(Date.now() + 15 * 60_000);
    expect(exports.list(document().archive)).toEqual([]);
    await exports.close();
  });
});

it("drops unsupported settings throughout print import and export", () => {
  const state = defaultMapState();
  const extended = {
    ...state,
    style: {
      ...state.style,
      color_mode: "category",
      endpoints: true,
      width: 12,
      power: { ...state.style.power, unused: true },
      overlays: [
        { id: "amap-labels", enabled: false, opacity: 1, unused: true },
      ],
    },
    camera: { ...state.camera, unused: true },
  };
  const value = printDocument(extended, "archive", []);
  expect(value.style).toEqual({
    ...state.style,
    overlays: [{ id: "amap-labels", enabled: false, opacity: 1 }],
  });
  expect(value.camera).toEqual(state.camera);
  expect(PrintDocumentSchema.parse({ ...value, unused: true }).camera).toEqual(
    state.camera,
  );
});

it("keeps an unfinished title editable until document validation", () => {
  const state = { ...defaultMapState(), title: "字".repeat(61) };
  const value = printDocument(state, "archive", []);
  expect(value.title).toBe(state.title);
  expect(PrintDocumentSchema.safeParse(value).success).toBe(false);
});
