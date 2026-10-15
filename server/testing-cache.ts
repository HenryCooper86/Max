/** Only genuinely failed indexing may supplement a successful durable read.
 * Metrics bounds this set to its retained memory window; any store observation
 * of a repaired row clears the marker, even outside a summary request. */
export const unindexedTestingSessions = new Set<string>();

/** Internal ownership only: clone at public response boundaries. Eviction never
 * limits evidence; oversized values simply use the complete uncached path. */
export class BoundedTestingCache<T> {
  private entries = new Map<string, { value: T; weight: number }>();
  private weight = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, valueWeight: number): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.weight -= previous.weight;
      this.entries.delete(key);
    }
    const weight = key.length * 2 + valueWeight;
    if (!Number.isFinite(weight) || weight < 0 || weight > this.maxWeight) return;
    while (this.entries.size && (this.entries.size >= this.maxEntries || this.weight + weight > this.maxWeight)) {
      const oldest = this.entries.keys().next().value!;
      this.weight -= this.entries.get(oldest)!.weight;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, weight });
    this.weight += weight;
  }

  clear(): void {
    this.entries.clear();
    this.weight = 0;
  }
}
