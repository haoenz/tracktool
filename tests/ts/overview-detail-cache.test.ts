import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { configureOverviewDetailCache } from "../../src/web/overview-detail-cache.js";

const clients: QueryClient[] = [];
function client() {
  const value = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  configureOverviewDetailCache(value);
  clients.push(value);
  return value;
}
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  vi.useRealTimers();
});
const key = (id: string, version = "version-a") => [
  "overview-detail",
  version,
  id,
];
const detail = (points = 10) => ({ entry: { points } });

it("reuses immutable details, isolates versions and does not cache failures", async () => {
  const cache = client();
  const queryFn = vi.fn(async () => detail());
  await cache.fetchQuery({ queryKey: key("a"), queryFn });
  await cache.fetchQuery({ queryKey: key("a"), queryFn });
  expect(queryFn).toHaveBeenCalledTimes(1);
  await cache.fetchQuery({ queryKey: key("a", "version-b"), queryFn });
  expect(queryFn).toHaveBeenCalledTimes(2);
  const failed = vi
    .fn()
    .mockRejectedValueOnce(new Error("失败"))
    .mockResolvedValue(detail());
  await expect(
    cache.fetchQuery({ queryKey: key("b"), queryFn: failed }),
  ).rejects.toThrow("失败");
  await cache.fetchQuery({ queryKey: key("b"), queryFn: failed });
  expect(failed).toHaveBeenCalledTimes(2);
});

it("retains more than eight details within the point budget, evicts least recently viewed data and expires unused data", async () => {
  vi.useFakeTimers();
  const cache = client();
  for (let i = 0; i < 20; i++)
    cache.setQueryData(key(String(i)), detail(5_000));
  expect(
    cache.getQueryCache().findAll({ queryKey: ["overview-detail"] }),
  ).toHaveLength(20);
  const observer = new QueryObserver(cache, {
    queryKey: key("0"),
    enabled: false,
  });
  observer.subscribe(() => {})();
  cache.setQueryData(key("20"), detail(5_000));
  expect(cache.getQueryData(key("0"))).toBeDefined();
  expect(cache.getQueryData(key("1"))).toBeUndefined();
  expect(
    cache.getQueryCache().findAll({ queryKey: ["overview-detail"] }),
  ).toHaveLength(20);
  await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
  expect(
    cache.getQueryCache().findAll({ queryKey: ["overview-detail"] }),
  ).toHaveLength(0);
});

it("bounds retained points and releases oversized tracks only after deselection", () => {
  const cache = client();
  cache.setQueryData(key("a"), detail(60_000));
  cache.setQueryData(key("b"), detail(60_000));
  expect(cache.getQueryData(key("a"))).toBeUndefined();
  expect(cache.getQueryData(key("b"))).toBeDefined();
  const observer = new QueryObserver(cache, {
    queryKey: key("large"),
    enabled: false,
  });
  const unsubscribe = observer.subscribe(() => {});
  cache.setQueryData(key("large"), detail(200_000));
  expect(cache.getQueryData(key("large"))).toBeDefined();
  unsubscribe();
  expect(cache.getQueryData(key("large"))).toBeUndefined();
  expect(cache.getQueryData(key("b"))).toBeDefined();
  cache.setQueryData(["track-detail", "editor"], detail(300_000));
  expect(cache.getQueryData(["track-detail", "editor"])).toBeDefined();
});
