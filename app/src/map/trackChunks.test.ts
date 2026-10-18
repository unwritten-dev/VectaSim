import { describe, expect, it } from "vitest";
import { ALT_BAND_FT, ChunkedTrack, bandedRuns, bandedTrackGeoJson, curtainGeoJson, curtainRuns, thinPoints, type TimedPoint } from "./trackChunks";

const pt = (i: number, altFt: number): TimedPoint => ({ lon: i * 0.01, lat: 50, altFt, tMs: i * 1000 });

/** Coordinates of all runs, joined at shared points, as one sequence. */
function joined(features: GeoJSON.Feature[]): number[][] {
  const out: number[][] = [];
  for (const f of features) {
    const c = (f.geometry as GeoJSON.LineString).coordinates;
    out.push(...(out.length ? c.slice(1) : c));
  }
  return out;
}

describe("bandedRuns", () => {
  it("merges a level segment into one feature", () => {
    const pts = Array.from({ length: 100 }, (_, i) => pt(i, 35000));
    const f = bandedRuns(pts);
    expect(f).toHaveLength(1);
    expect((f[0].geometry as GeoJSON.LineString).coordinates).toHaveLength(100);
    expect(f[0].properties?.alt).toBe((Math.floor(35000 / ALT_BAND_FT) + 0.5) * ALT_BAND_FT);
  });

  it("splits at band changes without gaps", () => {
    // climb 50 ft per point: a new band every 4 points
    const pts = Array.from({ length: 41 }, (_, i) => pt(i, i * 50));
    const f = bandedRuns(pts);
    expect(f.length).toBeGreaterThan(5);
    expect(f.length).toBeLessThan(40);
    expect(joined(f)).toEqual(pts.map((p) => [p.lon, p.lat]));
  });

  it("handles empty and single-point input", () => {
    expect(bandedRuns([])).toEqual([]);
    expect(bandedRuns([pt(0, 0)])).toEqual([]);
    expect(bandedTrackGeoJson([pt(0, 0), pt(1, 0)]).features).toHaveLength(1);
  });

  it("assigns ids from idBase when given", () => {
    const pts = Array.from({ length: 21 }, (_, i) => pt(i, i * 100));
    const f = bandedRuns(pts, 0, 20, 600);
    expect(f.map((x) => x.id)).toEqual(f.map((_, i) => 600 + i));
  });
});

describe("thinPoints", () => {
  it("keeps short input and first/last of long input", () => {
    expect(thinPoints([1, 2, 3], 5)).toEqual([1, 2, 3]);
    const long = Array.from({ length: 10_000 }, (_, i) => i);
    const t = thinPoints(long, 100);
    expect(t).toHaveLength(100);
    expect(t[0]).toBe(0);
    expect(t[99]).toBe(9999);
  });
});

describe("ChunkedTrack", () => {
  it("closes a chunk every N points and keeps the open block small", () => {
    const tr = new ChunkedTrack(10);
    const closed: GeoJSON.Feature[][] = [];
    for (let i = 0; i < 35; i++) {
      const c = tr.push(pt(i, 1000));
      if (c) closed.push(c);
    }
    // chunks [0..10], [10..20], [20..30]; open block [30..34]
    expect(tr.closed).toBe(3);
    expect(closed).toHaveLength(3);
    const live = tr.liveGeoJson().features;
    expect(joined(live)).toHaveLength(5);
    // history + live together are exactly the track, no gaps, no duplicates
    const all = [...tr.historyGeoJson().features, ...live];
    expect(joined(all)).toEqual(tr.points.map((p) => [p.lon, p.lat]));
  });

  it("gives history features unique ids across chunks (updateData requirement)", () => {
    const tr = new ChunkedTrack(10);
    for (let i = 0; i < 60; i++) tr.push(pt(i, i * 120));
    const ids = tr.historyGeoJson().features.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => typeof id === "number")).toBe(true);
  });

  it("bounds the per-sample payload by the chunk size", () => {
    const tr = new ChunkedTrack();
    let maxLiveCoords = 0;
    for (let i = 0; i < 36_000; i += 1) {
      tr.push(pt(i, 3000 + Math.sin(i / 50) * 2000));
      if (i % 97 === 0) maxLiveCoords = Math.max(maxLiveCoords, joined(tr.liveGeoJson().features).length);
    }
    expect(tr.closed).toBe(59);
    expect(maxLiveCoords).toBeLessThanOrEqual(601);
  });

  it("seed keeps newer points that arrived while the request was in flight", () => {
    const tr = new ChunkedTrack(10);
    tr.push(pt(20, 0));
    tr.push(pt(21, 0));
    tr.seed(Array.from({ length: 21 }, (_, i) => pt(i, 0))); // 0..20
    expect(tr.points.map((p) => p.tMs / 1000)).toEqual(Array.from({ length: 22 }, (_, i) => i));
    expect(tr.closed).toBe(2);
    expect(tr.lastMs).toBe(21_000);
  });

  it("re-seeding (remount) replaces instead of doubling", () => {
    const tr = new ChunkedTrack(10);
    const seed = Array.from({ length: 15 }, (_, i) => pt(i, 0));
    tr.seed(seed);
    tr.seed(seed);
    expect(tr.points).toHaveLength(15);
  });

  it("reset empties everything", () => {
    const tr = new ChunkedTrack(10);
    for (let i = 0; i < 25; i++) tr.push(pt(i, 0));
    tr.reset();
    expect(tr.points).toHaveLength(0);
    expect(tr.closed).toBe(0);
    expect(tr.historyGeoJson().features).toHaveLength(0);
    expect(tr.liveGeoJson().features).toHaveLength(0);
  });
});

describe("curtainRuns (3D view)", () => {
  it("one closed convex rectangle per consecutive pair, extruded to the pair's mean altitude in metres", () => {
    const pts = Array.from({ length: 50 }, (_, i) => pt(i, 35000));
    const f = curtainRuns(pts);
    expect(f).toHaveLength(49);
    const ring = (f[0].geometry as GeoJSON.Polygon).coordinates[0];
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    expect(f[0].properties?.alt).toBe(35000);
    expect(f[0].properties?.hM).toBeCloseTo(35000 * 0.3048, 3);
    expect(f[0].properties?.ribbonM).toBeGreaterThan(0);
  });

  it("follows the altitude sample by sample instead of stepping per band", () => {
    const f = curtainRuns([pt(0, 1000), pt(1, 1100), pt(2, 1200)]);
    expect(f.map((g) => g.properties?.alt)).toEqual([1050, 1150]);
  });

  it("is a thin strip: ±3 m around the line, on both sides, and neighbours share their end points", () => {
    const f = curtainRuns([pt(0, 1000), pt(1, 1000), pt(2, 1000)]);
    const r0 = (f[0].geometry as GeoJSON.Polygon).coordinates[0];
    const r1 = (f[1].geometry as GeoJSON.Polygon).coordinates[0];
    // the line runs east–west at lat 50: the offset is purely in latitude, 3 m ≈ 2.7e-5°
    for (const [, lat] of r0) expect(Math.abs(lat - 50)).toBeCloseTo(3 / 111_320, 7);
    expect(r0.some(([, lat]) => lat > 50) && r0.some(([, lat]) => lat < 50)).toBe(true);
    expect(r1[0]).toEqual(r0[1]);
    expect(r1[3]).toEqual(r0[2]);
  });

  it("skips a pair without movement", () => {
    expect(curtainRuns([pt(0, 1000), pt(0, 1000), pt(1, 1000)])).toHaveLength(1);
  });

  it("curtainGeoJson thins a long track and copes with an empty one", () => {
    expect(curtainGeoJson([]).features).toHaveLength(0);
    const pts = Array.from({ length: 20000 }, (_, i) => pt(i, 30000 + (i % 2) * 1000));
    expect(curtainGeoJson(pts, 1000).features).toHaveLength(999);
  });
});
