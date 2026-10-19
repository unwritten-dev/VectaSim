import { describe, expect, it } from "vitest";
import {
  COMMIT_POINTS,
  CURTAIN_FLOATS,
  CurtainGeometry,
  MAX_SEG_M,
  SUB_BENT,
  curveThrough,
  metersPerUnit,
  parseRamp,
  pickTile,
  rampColor,
  segmentPoints,
  simplifyIndices,
  toCPt,
  writeVertices,
  type CPt,
} from "./curtainLayer";
import { altToCurtainM, withGroundHeights } from "./trackChunks";
import type { TrackPoint } from "./common";

const RAMP: Array<[number, string]> = [
  [0, "#000000"],
  [10_000, "#ff0000"],
  [40_000, "#ffffff"],
];

/** Vertex `v` of a float array as named fields. */
function vertex(a: Float32Array, v: number) {
  const o = v * CURTAIN_FLOATS;
  return { x: a[o] + a[o + 2], y: a[o + 1] + a[o + 3], h: a[o + 4], rgb: [a[o + 5], a[o + 6], a[o + 7]], side: a[o + 8], prev: [a[o + 9], a[o + 10], a[o + 11]], next: [a[o + 12], a[o + 13], a[o + 14]] };
}

/** All vertices (stable + tail) of a geometry. */
function vertices(g: CurtainGeometry) {
  const all = new Float32Array(g.stableLen + g.tail.length);
  all.set(g.stable.subarray(0, g.stableLen));
  all.set(g.tail, g.stableLen);
  return Array.from({ length: all.length / CURTAIN_FLOATS }, (_, i) => vertex(all, i));
}

const lastVertex = (g: CurtainGeometry) => {
  const v = vertices(g);
  return v[v.length - 1];
};

/** A circuit-like track at 1 Hz: take-off roll, climb, a 180° turn, descent, landing roll. */
function circuit(): TrackPoint[] {
  const out: TrackPoint[] = [];
  const v = 60 / 111_320; // ~60 m/s in degrees latitude
  let lat = 50;
  let lon = 8.5;
  let hdg = 0;
  for (let i = 0; i < 600; i++) {
    let agl: number;
    let onGround = false;
    if (i < 30) {
      agl = 0;
      onGround = true;
    } else if (i < 150) agl = (i - 30) * 8;
    else if (i < 450) agl = 960;
    else if (i < 570) agl = (570 - i) * 8;
    else {
      agl = 0;
      onGround = true;
    }
    if (i >= 200 && i < 260) hdg += 3; // 180° turn
    if (i >= 380 && i < 440) hdg += 3;
    const r = (hdg * Math.PI) / 180;
    lat += v * Math.cos(r);
    lon += (v * Math.sin(r)) / Math.cos((lat * Math.PI) / 180);
    out.push({ lon, lat, altFt: 364 + agl, aglFt: agl, onGround });
  }
  return withGroundHeights(out);
}

describe("colour ramp (as the 2D line)", () => {
  const ramp = parseRamp(RAMP);
  it("clamps below the first and above the last stop", () => {
    expect(rampColor(-500, ramp)).toEqual([0, 0, 0]);
    expect(rampColor(60_000, ramp)).toEqual([1, 1, 1]);
    expect(rampColor(Number.NaN, ramp)).toEqual([0, 0, 0]);
  });
  it("interpolates linearly between the stops", () => {
    const [r, g, b] = rampColor(5_000, ramp);
    expect(r).toBeCloseTo(0.5, 6);
    expect(g).toBe(0);
    expect(b).toBe(0);
    expect(rampColor(25_000, ramp)[1]).toBeCloseTo(0.5, 6);
  });
});

describe("curtain points", () => {
  it("height above ground on the model's scale, colour by MSL", () => {
    const p = toCPt({ lon: 8, lat: 50, altFt: 3364, hFt: 3000 });
    expect(p.h).toBe(altToCurtainM(3000));
    expect(p.alt).toBe(3364);
    expect(toCPt({ lon: 8, lat: 50, altFt: 0, hFt: 0 }).h).toBe(altToCurtainM(0));
  });
  it("unwraps the antimeridian against the previous point", () => {
    const a = toCPt({ lon: 179.9, lat: 0, altFt: 0 });
    const b = toCPt({ lon: -179.9, lat: 0, altFt: 0 }, a.x);
    expect(b.x - a.x).toBeCloseTo(0.2 / 360, 9);
  });
});

describe("Douglas-Peucker (3D)", () => {
  const line = (n: number, h: (i: number) => number): CPt[] => Array.from({ length: n }, (_, i) => ({ x: 0.5 + i * 1e-6, y: 0.33, h: h(i), alt: 0 }));
  it("a straight, even climb collapses to its ends", () => {
    expect(simplifyIndices(line(200, (i) => i * 2))).toEqual([0, 199]);
  });
  it("keeps the corner of a climb that levels off (vertical tolerance)", () => {
    const idx = simplifyIndices(line(200, (i) => Math.min(i, 100) * 3));
    expect(idx).toContain(100);
    expect(idx.length).toBeLessThan(6);
  });
  it("keeps the first and the last point and never more than given", () => {
    const pts = line(50, (i) => (i % 2) * 30);
    const idx = simplifyIndices(pts);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(49);
    expect(idx.length).toBeLessThanOrEqual(50);
  });
});

describe("spline between the samples", () => {
  const k = metersPerUnit(0.33);
  const P = (xm: number, ym: number, h: number): CPt => ({ x: 0.5 + xm / k, y: 0.33 + ym / k, h, alt: h * 3 });
  it("a straight, evenly climbing segment adds no points", () => {
    const out: CPt[] = [];
    segmentPoints(P(0, 0, 0), P(60, 0, 10), P(120, 0, 20), P(180, 0, 30), out);
    expect(out).toHaveLength(1);
  });
  it("a bent segment adds SUB_BENT points, starts at p1 and stays near the chord", () => {
    const out: CPt[] = [];
    const p1 = P(60, 0, 300);
    const p2 = P(120, 10, 300);
    segmentPoints(P(0, 0, 300), p1, p2, P(170, 40, 300), out);
    expect(out).toHaveLength(SUB_BENT + 1);
    expect(out[0]).toBe(p1);
    for (const q of out) expect(q.h).toBe(300);
  });
  it("the height never overshoots the segment's end heights – on the ground it stays 1 m", () => {
    const ground = altToCurtainM(0);
    const out: CPt[] = [];
    // rolling, then the rotation: the segment on the runway stays on the runway
    segmentPoints(P(0, 0, ground), P(60, 0, ground), P(120, 5, ground), P(180, 15, 40), out);
    for (const q of out) expect(q.h).toBe(ground);
    const out2: CPt[] = [];
    segmentPoints(P(0, 0, 0), P(60, 0, 0), P(120, 0, 50), P(180, 0, 50), out2);
    for (const q of out2) {
      expect(q.h).toBeGreaterThanOrEqual(0);
      expect(q.h).toBeLessThanOrEqual(50);
    }
  });
  it("the curve passes through every control point and keeps both ends", () => {
    const ctrl = [P(0, 0, 1), P(60, 0, 50), P(110, 30, 100), P(130, 90, 150), P(120, 150, 150)];
    const c = curveThrough(ctrl);
    expect(c[0]).toBe(ctrl[0]);
    expect(c[c.length - 1]).toBe(ctrl[ctrl.length - 1]);
    for (const p of ctrl) expect(c).toContain(p);
    expect(c.length).toBeGreaterThan(ctrl.length);
  });
  it("a long straight piece is split every MAX_SEG_M (globe chord)", () => {
    const out: CPt[] = [];
    segmentPoints(null, P(0, 0, 11_000), P(100_000, 0, 11_000), null, out);
    expect(out).toHaveLength(Math.ceil(100_000 / MAX_SEG_M));
  });
});

describe("vertex strip", () => {
  const ramp = parseRamp(RAMP);
  it("two vertices per point: ground/left (−1) then top/right (+1), same position and height", () => {
    const pts: CPt[] = [
      { x: 0.5, y: 0.3, h: 10, alt: 10_000 },
      { x: 0.5001, y: 0.3, h: 20, alt: 0 },
    ];
    const out = new Float32Array(4 * CURTAIN_FLOATS);
    expect(writeVertices(pts, null, null, ramp, out, 0)).toBe(out.length);
    const v = [0, 1, 2, 3].map((i) => vertex(out, i));
    expect(v.map((q) => q.side)).toEqual([-1, 1, -1, 1]);
    expect(v[0].x).toBeCloseTo(0.5, 12);
    expect(v[2].x).toBeCloseTo(0.5001, 12);
    expect(v[0].h).toBe(10);
    expect(v[3].h).toBe(20);
    expect(v[0].rgb).toEqual([1, 0, 0]);
    // neighbour deltas: none before the first, none after the last
    expect(v[0].prev).toEqual([0, 0, 0]);
    expect(v[0].next[0]).toBeCloseTo(0.0001, 9);
    expect(v[0].next[2]).toBe(10);
    expect(v[3].next).toEqual([0, 0, 0]);
  });
  it("hi + lo keeps the Mercator position to well below a millimetre", () => {
    const x = 0.523456789012345;
    const out = new Float32Array(2 * CURTAIN_FLOATS);
    writeVertices([{ x, y: 0.3, h: 1, alt: 0 }], null, null, ramp, out, 0);
    expect(Math.abs(vertex(out, 0).x - x) * metersPerUnit(0.3)).toBeLessThan(1e-3);
  });
});

describe("CurtainGeometry", () => {
  it("starts and ends on the ground: the last vertex is the last point at 1 m", () => {
    const g = new CurtainGeometry(RAMP);
    const pts = circuit();
    g.sync(pts);
    const v = vertices(g);
    expect(v.length % 2).toBe(0);
    const ground = altToCurtainM(0);
    expect(v[0].h).toBe(ground);
    expect(v[v.length - 1].h).toBe(ground);
    const last = toCPt(pts[pts.length - 1]);
    expect(v[v.length - 1].x).toBeCloseTo(last.x, 10);
    expect(v[v.length - 1].y).toBeCloseTo(last.y, 10);
    // the wall's bottom is the ground: side −1 at height h, drawn at 0 m by the shader – the strip alternates
    for (let i = 0; i < v.length; i += 2) {
      expect(v[i].side).toBe(-1);
      expect(v[i + 1].side).toBe(1);
      expect(v[i].h).toBe(v[i + 1].h);
      expect(v[i].h).toBeGreaterThanOrEqual(ground);
    }
  });

  it("thins a circuit and still follows it (every point within a few metres of the strip)", () => {
    const g = new CurtainGeometry(RAMP);
    const pts = circuit();
    g.sync(pts);
    expect(g.ctrl.length).toBeLessThan(pts.length / 3);
    const v = vertices(g).filter((q) => q.side === 1);
    const k = metersPerUnit(v[0].y);
    for (const p of pts.filter((_, i) => i % 7 === 0)) {
      const c = toCPt(p);
      let best = Infinity;
      for (let i = 1; i < v.length; i++) {
        const a = v[i - 1];
        const b = v[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / l2)) : 0;
        best = Math.min(best, Math.hypot(a.x + t * dx - c.x, a.y + t * dy - c.y) * k);
      }
      expect(best).toBeLessThan(4);
    }
  });

  it("incremental appends equal one build of the whole list", () => {
    const pts = circuit();
    const once = new CurtainGeometry(RAMP);
    once.sync(pts);
    const inc = new CurtainGeometry(RAMP);
    const live: TrackPoint[] = [];
    for (const p of pts) {
      live.push(p);
      inc.sync(live);
    }
    expect(inc.ctrl.length).toBe(once.ctrl.length);
    expect(inc.vertexCount).toBe(once.vertexCount);
    expect(Array.from(inc.stable.subarray(0, inc.stableLen))).toEqual(Array.from(once.stable.subarray(0, once.stableLen)));
  });

  it("stable vertices are written once; per sample only the tail changes", () => {
    const pts = circuit();
    const g = new CurtainGeometry(RAMP);
    const live: TrackPoint[] = [];
    let maxTail = 0;
    let shrunk = false;
    let prevStable = 0;
    for (const p of pts) {
      live.push(p);
      g.sync(live, { ...p, lon: p.lon + 1e-5 });
      if (g.stableLen < prevStable) shrunk = true;
      prevStable = g.stableLen;
      maxTail = Math.max(maxTail, g.tail.length / CURTAIN_FLOATS);
    }
    expect(shrunk).toBe(false);
    expect(g.stableLen).toBeGreaterThan(0);
    // the open block: at most COMMIT_POINTS raw points (+ spline points, + the head)
    expect(maxTail).toBeLessThanOrEqual((COMMIT_POINTS + 4) * (SUB_BENT + 1) * 2);
  });

  it("the head reaches the aircraft at its height (the model sits on the edge)", () => {
    const g = new CurtainGeometry(RAMP);
    const pts = circuit().slice(0, 200);
    const now: TrackPoint = { lon: pts[199].lon + 0.0005, lat: pts[199].lat, altFt: 1400, hFt: 1036 };
    g.sync(pts, now);
    const v = vertices(g);
    const end = v[v.length - 1];
    expect(end.h).toBeCloseTo(altToCurtainM(1036), 3);
    expect(end.x).toBeCloseTo(toCPt(now).x, 10);
    // undefined keeps the head, null removes it
    g.sync(pts);
    expect(lastVertex(g).h).toBeCloseTo(altToCurtainM(1036), 3);
    g.sync(pts, null);
    expect(lastVertex(g).x).toBeCloseTo(toCPt(pts[199]).x, 10);
  });

  it("a new list (seed, reset) rebuilds; an empty one clears", () => {
    const g = new CurtainGeometry(RAMP);
    const pts = circuit();
    g.sync(pts);
    const gen = g.generation;
    g.sync(pts.map((p) => ({ ...p })));
    expect(g.generation).toBe(gen + 1);
    g.sync([]);
    expect(g.vertexCount).toBe(0);
  });

  it("a standing aircraft adds nothing", () => {
    const g = new CurtainGeometry(RAMP);
    const p: TrackPoint = { lon: 8, lat: 50, altFt: 364, hFt: 0 };
    g.sync(Array.from({ length: 300 }, () => ({ ...p })));
    expect(g.vertexCount).toBe(0);
  });

  it("a 10 h flight (36 000 samples) stays a few thousand vertices", () => {
    const pts: TrackPoint[] = [];
    let lon = 8.5;
    let lat = 50;
    for (let i = 0; i < 36_000; i++) {
      // climb, cruise with step climbs and gentle turns, descent; small noise like the sim
      const t = i / 36_000;
      const alt = t < 0.05 ? (t / 0.05) * 35_000 : t > 0.93 ? ((1 - t) / 0.07) * 35_000 : 35_000 + (t > 0.5 ? 2000 : 0);
      const hdg = 1.2 + 0.3 * Math.sin(i / 3000);
      lon += (250 / 111_320 / Math.cos((lat * Math.PI) / 180)) * Math.sin(hdg);
      lat += (250 / 111_320) * Math.cos(hdg) * 0.2;
      pts.push({ lon, lat, altFt: alt, hFt: alt });
    }
    const g = new CurtainGeometry(RAMP);
    const t0 = performance.now();
    g.sync(pts);
    const ms = performance.now() - t0;
    expect(g.vertexCount).toBeLessThan(30_000);
    expect(ms).toBeLessThan(1500);
  });
});

describe("projection tile", () => {
  it("around the centre at the map's zoom for a short track", () => {
    const t = pickTile({ x: 0.5237, y: 0.3383 }, 12.4, { minX: 0.5236, maxX: 0.5238, minY: 0.3382, maxY: 0.3384 });
    expect(t.z).toBe(12);
    expect(t.wrap).toBe(0);
    expect(t.refX).toBeCloseTo(t.x / 4096, 12);
    expect(t.scale).toBe(4096 * 8192);
  });
  it("coarser when the track reaches far (the globe shader takes far tile coords as poles)", () => {
    const t = pickTile({ x: 0.52, y: 0.33 }, 14, { minX: 0.45, maxX: 0.6, minY: 0.3, maxY: 0.36 });
    expect(t.z).toBeLessThan(14);
    expect(0.1 * 2 ** t.z * 8192).toBeLessThanOrEqual(30_000);
  });
  it("shifts the track by whole worlds to the copy nearest the centre", () => {
    const t = pickTile({ x: 1.02, y: 0.4 }, 5, { minX: 0.0, maxX: 0.04, minY: 0.39, maxY: 0.41 });
    expect(t.wrap).toBe(1);
    // ref = the tile's origin in the track's own world: the track sits right at the centre
    expect(0.02 - t.refX).toBeGreaterThanOrEqual(0);
    expect(0.02 - t.refX).toBeLessThan(1 / 2 ** t.z);
  });
});
