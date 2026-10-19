// Stable order for the Dispatch panel's "Verkehr in der Nähe" list.
//
// Sorting by distance on every render made lines move under the mouse pointer (the own aircraft
// moves every second, the feed every 15 s), so a click could open the neighbouring aircraft.
// The list is re-sorted only when a new feed snapshot arrives and the pointer / focus is not in
// the list; otherwise the previous order is kept, aircraft that left are dropped and newcomers
// are appended at the end.

export interface Ranked<T> {
  key: string;
  item: T;
  d: number;
}

/**
 * @param prev   keys in the order last shown
 * @param ranked candidates, any order (sorted by `d` here)
 * @param resort true = sort by distance from scratch (new feed state, list not hovered)
 */
export function stableNearest<T>(prev: readonly string[], ranked: Ranked<T>[], max: number, resort: boolean): Ranked<T>[] {
  const sorted = [...ranked].sort((a, b) => a.d - b.d);
  if (resort || prev.length === 0) return sorted.slice(0, max);
  const byKey = new Map(ranked.map((r) => [r.key, r]));
  const kept = prev.map((k) => byKey.get(k)).filter((r): r is Ranked<T> => !!r);
  const keptKeys = new Set(kept.map((r) => r.key));
  const fresh = sorted.filter((r) => !keptKeys.has(r.key));
  return [...kept, ...fresh].slice(0, max);
}
