import { NNBSP } from "../format";
import { describe, expect, it } from "vitest";
import { MIN_RUNWAY_PX, TRACK_BEFORE_M, nearestByDist, niceDistanceStep, pathOf, referenceHeightFt, runwayLayout, sideLabel, stripeCount } from "./geometry";

describe("runwayLayout", () => {
  const base = { lengthM: 2000, widthM: 45, widthPx: 1000 };

  it("keeps the along axis to scale and stretches the lateral axis to a readable width", () => {
    const L = runwayLayout({ ...base, points: [{ x: -1800, y: 5 }, { x: 0, y: 2 }, { x: 500, y: 3 }], touchdown: { x: 500, y: 3 } });
    // threshold and runway end map to the expected pixels
    const [x0, cy] = L.toSvg({ x: 0, y: 0 });
    const [x1] = L.toSvg({ x: 2000, y: 0 });
    expect(x1 - x0).toBeCloseTo(2000 * L.xScale, 6);
    expect(cy).toBe(L.heightPx / 2);
    // the runway is drawn at least MIN_RUNWAY_PX wide, so the lateral axis is exaggerated
    expect(45 * L.yScale).toBeGreaterThanOrEqual(MIN_RUNWAY_PX - 1e-9);
    expect(L.exaggeration).toBeGreaterThan(1);
    // right of the centreline is below it on screen
    expect(L.toSvg({ x: 0, y: 10 })[1]).toBeGreaterThan(cy);
    // the view starts no further out than the shown track
    expect(L.xMin).toBeGreaterThanOrEqual(-TRACK_BEFORE_M - 40);
    expect(L.xMax).toBeGreaterThanOrEqual(2000);
  });

  it("never compresses below true scale and grows to fit a far-off touchdown", () => {
    const L = runwayLayout({ ...base, points: [], touchdown: { x: 800, y: -450 }, maxHeightPx: 320 });
    expect(L.yScale).toBeGreaterThanOrEqual(L.xScale);
    expect(L.heightPx).toBeLessThanOrEqual(320);
    expect(L.heightPx).toBeGreaterThan(150);
  });

  it("ignores far-off track points (circling) for the extent", () => {
    const near = runwayLayout({ ...base, points: [{ x: -500, y: 2 }], touchdown: { x: 400, y: 0 } });
    const wild = runwayLayout({ ...base, points: [{ x: -500, y: 2 }, { x: -800, y: 3000 }], touchdown: { x: 400, y: 0 } });
    expect(wild.heightPx).toBe(near.heightPx);
  });

  it("puts distance ticks inside the runway and symmetric threshold stripes", () => {
    const L = runwayLayout({ ...base, points: [], touchdown: null });
    expect(L.ticks.length).toBeGreaterThan(2);
    expect(L.ticks.every((d) => d > 0 && d < 2000)).toBe(true);
    expect(L.stripes).toHaveLength(12);
    expect(L.stripes.reduce((s, v) => s + v, 0)).toBeCloseTo(0, 6);
    expect(Math.max(...L.stripes.map(Math.abs))).toBeLessThan(45 / 2);
  });
});

describe("helpers", () => {
  it("niceDistanceStep gives 1/2/2.5/5 steps of at least minPx", () => {
    expect(niceDistanceStep(0.3, 56)).toBe(200);
    expect(niceDistanceStep(1, 56)).toBe(100);
    expect(niceDistanceStep(0.1, 56)).toBe(1000);
  });

  it("stripeCount follows ICAO widths", () => {
    expect(stripeCount(18)).toBe(4);
    expect(stripeCount(30)).toBe(8);
    expect(stripeCount(45)).toBe(12);
    expect(stripeCount(60)).toBe(16);
  });

  it("referenceHeightFt crosses the threshold at TCH and fans out from the same origin", () => {
    expect(referenceHeightFt(0, 3, 50)).toBeCloseTo(50, 6);
    // 1 nm before the threshold on 3°: about 318 + 50 ft
    expect(referenceHeightFt(1852, 3, 50)).toBeCloseTo(((1852 + 291.0) * Math.tan((3 * Math.PI) / 180)) / 0.3048, 0);
    const gpip = (50 * 0.3048) / Math.tan((3 * Math.PI) / 180);
    expect(referenceHeightFt(-gpip, 3.7, 50, 3)).toBeCloseTo(0, 6);
    expect(referenceHeightFt(1852, 3.7, 50, 3)).toBeGreaterThan(referenceHeightFt(1852, 3, 50));
  });

  it("nearestByDist and pathOf", () => {
    const s = [{ distM: 300 }, { distM: 150 }, { distM: -20 }];
    expect(nearestByDist(s, 140)).toBe(1);
    expect(nearestByDist(s, -100)).toBe(2);
    expect(pathOf([{ x: 0, y: 0 }, { x: 1, y: 2 }], (p) => [p.x * 10, p.y * 10])).toBe("M0.0,0.0L10.0,20.0");
  });

  it("sideLabel", () => {
    expect(sideLabel(0.2)).toBe("auf der Mittellinie");
    expect(sideLabel(3.04).split(NNBSP).join(" ")).toBe("3,0 m rechts");
    expect(sideLabel(-580.4).split(NNBSP).join(" ")).toBe("580 m links");
  });
});

describe("runwayLayout far-off touchdown", () => {
  it("shrinks uniformly so a touchdown 450 m beside a short runway stays inside the drawing", () => {
    const L = runwayLayout({ lengthM: 670, widthM: 30, widthPx: 1250, points: [{ x: -1800, y: -600 }, { x: 0, y: -500 }], touchdown: { x: 246, y: -455 }, maxHeightPx: 320 });
    const [x, y] = L.toSvg({ x: 246, y: -455 });
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(L.heightPx);
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(1250);
    expect(L.yScale).toBeGreaterThanOrEqual(L.xScale);
  });
});
