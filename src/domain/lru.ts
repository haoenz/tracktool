/** Map-backed LRU bounded by entry count and total weight. */
export class LruStore<K, V> {
  private readonly map = new Map<K, V>();
  private total = 0;
  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number,
    private readonly weigh: (value: V) => number,
  ) {}
  get size(): number {
    return this.map.size;
  }
  get weight(): number {
    return this.total;
  }
  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Refresh recency so a long-lived selection is not evicted by a scan.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key: K, value: V): boolean {
    const weight = this.weigh(value);
    if (weight > this.maxWeight) return false;
    const previous = this.map.get(key);
    if (previous !== undefined) {
      this.total -= this.weigh(previous);
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.total += weight;
    while (this.map.size > this.maxEntries || this.total > this.maxWeight) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.total -= this.weigh(this.map.get(oldest)!);
      this.map.delete(oldest);
    }
    return true;
  }
  clear(): void {
    this.map.clear();
    this.total = 0;
  }
}
