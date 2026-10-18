// Min/max bucket downsampling for line charts (profile chart).
//
// One bucket per pixel column (by time, so recording gaps stay gaps); every bucket keeps its
// first and last sample plus the min and max of each series. Unlike a fixed stride this keeps
// short spikes (the V/S peak at touchdown, a GS jump) that fall between stride points.

/**
 * Indices (ascending, unique) to draw. `t(i)` must be non-decreasing; `series` are value
 * getters. With n ≤ 4 · buckets nothing is dropped.
 */
export function minMaxBucketIndices(n: number, buckets: number, t: (i: number) => number, series: Array<(i: number) => number>): number[] {
  if (n <= 0) return [];
  buckets = Math.max(1, Math.floor(buckets));
  if (n <= buckets * 4) return Array.from({ length: n }, (_, i) => i);
  const t0 = t(0);
  const span = Math.max(1, t(n - 1) - t0);
  const out: number[] = [];
  const sCount = series.length;
  const minI = new Array<number>(sCount);
  const maxI = new Array<number>(sCount);
  const minV = new Array<number>(sCount);
  const maxV = new Array<number>(sCount);
  let start = 0;
  const emit = (end: number) => {
    // bucket [start, end)
    const picked = new Set<number>([start, end - 1]);
    for (let s = 0; s < sCount; s++) {
      picked.add(minI[s]);
      picked.add(maxI[s]);
    }
    for (const i of [...picked].sort((a, b) => a - b)) out.push(i);
  };
  const reset = (i: number) => {
    for (let s = 0; s < sCount; s++) {
      const v = series[s](i);
      minI[s] = maxI[s] = i;
      minV[s] = maxV[s] = v;
    }
  };
  let bucket = 0;
  reset(0);
  for (let i = 1; i < n; i++) {
    const b = Math.min(buckets - 1, Math.floor(((t(i) - t0) / span) * buckets));
    if (b !== bucket) {
      emit(i);
      start = i;
      bucket = b;
      reset(i);
      continue;
    }
    for (let s = 0; s < sCount; s++) {
      const v = series[s](i);
      if (v < minV[s]) {
        minV[s] = v;
        minI[s] = i;
      }
      if (v > maxV[s]) {
        maxV[s] = v;
        maxI[s] = i;
      }
    }
  }
  emit(n);
  return out;
}
