import { expect, it } from "vitest";
import { LruStore } from "../../dist/node/domain/lru.js";

it("bounds entries and weight while refreshing recency", () => {
  const cache = new LruStore<string, { size: number }>(3, 10, (v) => v.size);
  cache.set("a", { size: 4 });
  cache.set("b", { size: 4 });
  cache.set("c", { size: 4 });
  expect(cache.get("a")).toBeUndefined();
  expect(cache.get("c")).toEqual({ size: 4 });

  // Reading b refreshes it, so c is the oldest when d arrives.
  expect(cache.get("b")).toEqual({ size: 4 });
  cache.set("d", { size: 4 });
  expect(cache.get("c")).toBeUndefined();
  expect(cache.get("b")).toEqual({ size: 4 });
  expect(cache.get("d")).toEqual({ size: 4 });

  // An item heavier than the whole budget is never cached.
  expect(cache.set("e", { size: 11 })).toBe(false);
  expect(cache.get("e")).toBeUndefined();
  expect(cache.weight).toBe(8);
});
