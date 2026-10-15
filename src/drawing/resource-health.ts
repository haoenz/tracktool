/** Tile references come from MapLibre's source events; uses=0 means no active viewport needs it. */
export interface ResourceTile {
  state: string;
  uses: number;
  aborted?: boolean;
  tileID: { key: string; canonical: { x: number; y: number; z: number } };
}
export interface ResourceEvent {
  sourceId?: string;
  tile?: ResourceTile;
  sourceDataType?: string;
  error?: Error;
}
type Failure = {
  source?: string;
  tile?: ResourceTile;
  message: string;
  attempts: number;
  timer?: ReturnType<typeof setTimeout>;
};
export class ResourceHealth {
  private failures = new Map<string, Failure>();
  private tiles = new Map<string, Set<ResourceTile>>();
  private reported = new Set<string>();
  constructor(
    private exists: (source: string) => boolean,
    private refresh: (source: string, tile?: ResourceTile) => void,
    private changed: () => void,
  ) {}
  private key(e: ResourceEvent) {
    return `${e.sourceId ?? "style"}:${e.tile?.tileID.key ?? "metadata"}`;
  }
  private remember(e: ResourceEvent) {
    if (e.sourceId && e.tile) {
      if (!this.tiles.has(e.sourceId)) this.tiles.set(e.sourceId, new Set());
      this.tiles.get(e.sourceId)!.add(e.tile);
    }
  }
  fail(e: ResourceEvent) {
    if (e.error?.name === "AbortError" || e.tile?.aborted) return;
    this.remember(e);
    const key = this.key(e),
      old = this.failures.get(key);
    const failure: Failure = old ?? {
      source: e.sourceId,
      tile: e.tile,
      message: "",
      attempts: 0,
    };
    failure.message = e.error?.message || "地图资源加载失败";
    failure.tile = e.tile;
    this.failures.set(key, failure);
    if (!this.reported.has(key)) {
      console.warn("[地图资源]", {
        source: e.sourceId,
        tile: e.tile?.tileID.canonical,
        error: e.error,
        retry: !!e.sourceId && !!e.tile,
      });
      this.reported.add(key);
    }
    if (e.sourceId && e.tile && failure.attempts < 2 && !failure.timer) {
      failure.timer = setTimeout(
        () => {
          failure.timer = undefined;
          this.prune();
          if (!this.failures.has(key)) return;
          failure.attempts++;
          console.debug("[地图资源重试]", {
            source: failure.source,
            tile: failure.tile?.tileID.canonical,
            attempt: failure.attempts,
          });
          this.refresh(failure.source!, failure.tile);
          this.changed();
        },
        failure.attempts === 0 ? 500 : 1500,
      );
    }
    this.changed();
  }
  loaded(e: ResourceEvent) {
    this.remember(e);
    if (
      e.tile?.state === "loaded" ||
      (!e.tile && ["metadata", "content"].includes(e.sourceDataType ?? ""))
    )
      this.remove(this.key(e));
    this.prune();
    this.changed();
  }
  private remove(key: string) {
    const failure = this.failures.get(key);
    if (failure?.timer) clearTimeout(failure.timer);
    this.failures.delete(key);
    this.reported.delete(key);
  }
  prune() {
    for (const [key, f] of this.failures) {
      if (
        (f.source && !this.exists(f.source)) ||
        (f.tile &&
          (f.tile.uses === 0 ||
            f.tile.aborted ||
            f.tile.state === "loaded" ||
            f.tile.state === "unloaded"))
      )
        this.remove(key);
    }
    for (const [source, tiles] of this.tiles) {
      for (const tile of tiles)
        if (
          !this.exists(source) ||
          tile.uses === 0 ||
          tile.aborted ||
          tile.state === "unloaded"
        )
          tiles.delete(tile);
      if (!tiles.size) this.tiles.delete(source);
    }
  }
  pending(source?: string) {
    this.prune();
    return [...this.failures.values()].some(
      (f) =>
        (!source || f.source === source) &&
        (f.timer ||
          f.tile?.state === "loading" ||
          f.tile?.state === "reloading"),
    );
  }
  errors(source?: string) {
    this.prune();
    return [...this.failures.values()]
      .filter((f) =>
        source ? f.source === source : !f.source?.startsWith("overview-"),
      )
      .map((f) => f.message);
  }
  blocked(source: string) {
    if (!this.errors(source).length || this.pending(source)) return false;
    return ![...(this.tiles.get(source) ?? [])].some(
      (t) => t.uses > 0 && t.state === "loaded",
    );
  }
  clear() {
    for (const key of this.failures.keys()) this.remove(key);
    this.tiles.clear();
  }
}
