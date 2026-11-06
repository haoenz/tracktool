import type { Query, QueryClient } from "@tanstack/react-query";

const key = ["overview-detail"];
const maxPoints = 100_000;

export function configureOverviewDetailCache(client: QueryClient) {
  client.setQueryDefaults(key, {
    // Geometry is immutable within an overview version; a new version has a new key.
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
  const recent = new WeakMap<Query, number>();
  let clock = 0;
  return client.getQueryCache().subscribe((event) => {
    if (
      event.query.queryKey[0] !== key[0] ||
      !(
        event.type === "observerAdded" ||
        event.type === "observerRemoved" ||
        (event.type === "updated" && event.action.type === "success")
      )
    )
      return;
    recent.set(event.query, ++clock);
    const retained = client
      .getQueryCache()
      .findAll({ queryKey: key })
      .filter(
        (query) =>
          query.getObserversCount() === 0 &&
          query.state.fetchStatus === "idle" &&
          query.state.data !== undefined,
      )
      .sort((a, b) => (recent.get(b) ?? 0) - (recent.get(a) ?? 0));
    let points = 0;
    for (const query of retained) {
      const data = query.state.data as { entry: { points: number } };
      const size = data.entry.points;
      // Active viewers keep their data; oversized tracks are released on deselection.
      if (points + size > maxPoints) client.getQueryCache().remove(query);
      else points += size;
    }
  });
}
