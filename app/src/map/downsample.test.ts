import { describe, expect, it } from "vitest";
import { minMaxBucketIndices } from "./downsample";

describe("minMaxBucketIndices", () => {
  const t = (i: number) => i * 1000;

  it("keeps everything for short input", () => {
    expect(minMaxBucketIndices(10, 100, t, [() => 0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(minMaxBucketIndices(0, 100, t, [])).toEqual([]);
  });

  it("bounds the output by the bucket count and keeps first/last", () => {
    const n = 36_000;
    const idx = minMaxBucketIndices(n, 700, t, [(i) => Math.sin(i), (i) => i % 7, (i) => -i]);
    expect(idx.length).toBeLessThanOrEqual(700 * 8);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(n - 1);
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
  });

  it("keeps a one-sample spike a stride would skip", () => {
    const n = 20_000;
    const spike = 12_345;
    const vs = (i: number) => (i === spike ? -900 : -50);
    const idx = minMaxBucketIndices(n, 500, t, [vs]);
    expect(idx).toContain(spike);
  });

  it("buckets by time, so a recording gap does not swallow samples", () => {
    // 1000 samples, then a long gap, then 1000 more
    const tt = (i: number) => (i < 1000 ? i * 1000 : 10_000_000 + i * 1000);
    const idx = minMaxBucketIndices(2000, 100, tt, [(i) => i]);
    expect(idx).toContain(999);
    expect(idx).toContain(1000);
  });
});
