import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ResourceHealth,
  type ResourceTile,
} from "../../src/drawing/resource-health.js";
const tile = (key: string): ResourceTile => ({
  state: "errored",
  uses: 1,
  tileID: { key, canonical: { x: 0, y: 0, z: 1 } },
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("retries a failed tile twice, logs once, then marks a wholly failed source blocking", async () => {
  const t = tile("one"),
    refresh = vi.fn(),
    h = new ResourceHealth(() => true, refresh, vi.fn());
  const e = { sourceId: "base", tile: t, error: new Error("network") };
  h.fail(e);
  expect(h.blocked("base")).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  h.fail(e);
  await vi.advanceTimersByTimeAsync(1500);
  h.fail(e);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(console.warn).toHaveBeenCalledTimes(1);
  expect(h.blocked("base")).toBe(true);
  t.state = "loaded";
  h.loaded(e);
  expect(h.errors()).toEqual([]);
  expect(h.blocked("base")).toBe(false);
});
it("one missing tile does not block browsing but remains an export error", async () => {
  const good = tile("good"),
    bad = tile("bad");
  good.state = "loaded";
  const h = new ResourceHealth(() => true, vi.fn(), vi.fn());
  h.loaded({ sourceId: "base", tile: good });
  const e = { sourceId: "base", tile: bad, error: new Error("missing tile") };
  h.fail(e);
  await vi.advanceTimersByTimeAsync(500);
  h.fail(e);
  await vi.advanceTimersByTimeAsync(1500);
  h.fail(e);
  expect(h.blocked("base")).toBe(false);
  expect(h.errors()).toEqual(["missing tile"]);
  bad.uses = 0;
  expect(h.errors()).toEqual([]);
});
it("success clears only the matching resource and stops its retry", async () => {
  const a = tile("a"),
    b = tile("b"),
    refresh = vi.fn();
  const h = new ResourceHealth(() => true, refresh, vi.fn());
  h.fail({ sourceId: "base", tile: a, error: new Error("a") });
  h.fail({ sourceId: "base", tile: b, error: new Error("b") });
  a.state = "loaded";
  h.loaded({ sourceId: "base", tile: a });
  expect(h.errors()).toEqual(["b"]);
  await vi.advanceTimersByTimeAsync(500);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledWith("base", b);
});
it("aborted and obsolete requests do not poison a later map", async () => {
  let exists = true;
  const refresh = vi.fn(),
    h = new ResourceHealth(() => exists, refresh, vi.fn());
  h.fail({ error: new DOMException("cancelled", "AbortError") });
  expect(h.errors()).toEqual([]);
  h.fail({ sourceId: "base", tile: tile("a"), error: new Error("old") });
  exists = false;
  await vi.advanceTimersByTimeAsync(3000);
  expect(refresh).not.toHaveBeenCalled();
  expect(h.errors()).toEqual([]);
  exists = true;
  h.fail({ sourceId: "base", tile: tile("b"), error: new Error("new") });
  h.clear();
  await vi.advanceTimersByTimeAsync(3000);
  expect(refresh).not.toHaveBeenCalled();
});
it("overview errors stay scoped to overview and metadata errors clear on successful load", () => {
  const h = new ResourceHealth(() => true, vi.fn(), vi.fn());
  h.fail({
    sourceId: "overview-abc",
    tile: tile("a"),
    error: new Error("overview"),
  });
  expect(h.errors()).toEqual([]);
  expect(h.errors("overview-abc")).toEqual(["overview"]);
  h.fail({ sourceId: "base", error: new Error("metadata") });
  h.loaded({ sourceId: "base", sourceDataType: "metadata" });
  expect(h.errors()).toEqual([]);
  expect(h.errors("overview-abc")).toEqual(["overview"]);
  h.clear();
});
