import { describe, expect, it } from "vitest";
import { trackHeightAt } from "./common";
import type { TrackSample } from "../types";
import { OWN_ICON_SIZE, OWN_LAYERS, PULSE_MAX, PULSE_MIN, PULSE_PERIOD_MS, haloSvg, ownAircraftGeoJson, ownHaloColorsOf, ownLayerMoves, pulseOpacity } from "./ownAircraft";
import { OWN_AIRCRAFT, THEMES, contrastRatio } from "../themes";
import { trafficColorsOf } from "./aircraftIcons";
import { altToCurtainM, curtainRuns } from "./trackChunks";

const pose = { lon: 8.5, lat: 50, headingDeg: 70, altFt: 12_000, cat: "medium" as const };

describe("ownAircraftGeoJson", () => {
  it("2D: height 0, no model flag", () => {
    const p = ownAircraftGeoJson(pose, false, true).features[0].properties!;
    expect(p.hM).toBe(0);
    expect(p.m).toBe(0);
    expect(p.heading).toBe(70);
    expect(p.sizeFactor).toBe(1.3);
  });

  it("3D: the curtain's height scale, model flag only while the model draws", () => {
    expect(ownAircraftGeoJson(pose, true, true).features[0].properties!.hM).toBeCloseTo(12_000 * 0.3048, 6);
    expect(ownAircraftGeoJson(pose, true, true).features[0].properties!.m).toBe(1);
    expect(ownAircraftGeoJson(pose, true, false).features[0].properties!.m).toBe(0);
  });

  it("sits on top of the curtain: same height as the last wall segment at constant altitude", () => {
    const wall = curtainRuns([
      { lon: 8.4, lat: 50, altFt: 12_000 },
      { lon: 8.5, lat: 50, altFt: 12_000 },
    ]);
    expect(wall[0].properties!.hM).toBe(altToCurtainM(12_000));
    expect(ownAircraftGeoJson(pose, true).features[0].properties!.hM).toBe(wall[0].properties!.hM);
  });

  it("no position: empty", () => {
    expect(ownAircraftGeoJson(null, true).features).toHaveLength(0);
    expect(ownAircraftGeoJson({ ...pose, lat: NaN }, false).features).toHaveLength(0);
  });
});

describe("ownLayerMoves", () => {
  const own = [...OWN_LAYERS, "aircraft-model"];
  it("nothing to do when the own layers are already the top of the stack", () => {
    expect(ownLayerMoves(["bg", "traffic", ...own], own)).toEqual([]);
  });
  it("a layer added later (weather overlay) moves them all back on top, in order", () => {
    expect(ownLayerMoves(["bg", ...own, "weather-radar"], own)).toEqual(own);
    expect(ownLayerMoves(["bg", "aircraft", "aircraft-halo", "aircraft-model"], own)).toEqual(own);
  });
  it("ignores own layers that do not exist (yet)", () => {
    expect(ownLayerMoves(["bg", "aircraft-halo", "aircraft"], own)).toEqual([]);
    expect(ownLayerMoves(["aircraft", "bg"], own)).toEqual(["aircraft"]);
  });
  it("is idempotent: applying the moves leaves nothing to move", () => {
    let order = ["bg", "aircraft-halo", "labels", "aircraft", "aircraft-model", "radar"];
    for (const id of ownLayerMoves(order, own)) order = [...order.filter((x) => x !== id), id];
    expect(order.slice(-3)).toEqual(own);
    expect(ownLayerMoves(order, own)).toEqual([]);
  });
});

describe("pulseOpacity", () => {
  it("breathes between min and max once per period", () => {
    expect(pulseOpacity(0)).toBeCloseTo(PULSE_MIN, 6);
    expect(pulseOpacity(PULSE_PERIOD_MS / 2)).toBeCloseTo(PULSE_MAX, 6);
    expect(pulseOpacity(PULSE_PERIOD_MS)).toBeCloseTo(PULSE_MIN, 6);
    for (let t = 0; t < 5000; t += 77) {
      expect(pulseOpacity(t)).toBeGreaterThanOrEqual(PULSE_MIN - 1e-9);
      expect(pulseOpacity(t)).toBeLessThanOrEqual(PULSE_MAX + 1e-9);
    }
  });
});

describe("own aircraft contrast in every theme", () => {
  for (const t of THEMES) {
    it(`${t.name}: ring ≥ 3:1 on the land, own fill distinct from the traffic`, () => {
      const c = ownHaloColorsOf(t);
      expect(contrastRatio(c.ring, t.map.land)).toBeGreaterThanOrEqual(3);
      // the dark edge of the symbol separates the yellow from the land (light themes) or stands as a casing (dark)
      expect(Math.max(contrastRatio(OWN_AIRCRAFT, t.map.land), contrastRatio(t.colors.aircraftEdge, t.map.land))).toBeGreaterThanOrEqual(3);
      // yellow vs the traffic's blue-grey: the own plane is not "one of them"
      expect(contrastRatio(OWN_AIRCRAFT, trafficColorsOf(t).fill)).toBeGreaterThanOrEqual(1.4);
      expect(haloSvg(c)).toContain(c.ring);
    });
  }
  it("own symbol is ~30 % above the old size", () => {
    expect(OWN_ICON_SIZE / 1.3).toBeGreaterThanOrEqual(1.25);
  });
});

describe("trackHeightAt (3D replay cursor)", () => {
  const s = (tMs: number, altitudeMslFt: number, altitudeAglFt: number, onGround: boolean) =>
    ({ tMs, latitude: 50, longitude: 8 + tMs / 1e6, altitudeMslFt, altitudeAglFt, onGround }) as unknown as TrackSample;
  const samples = [s(0, 364, 4, true), s(1000, 1364, 1000, false), s(2000, 364, 4, true)];
  it("0 on the ground, the AGL in the air, interpolated in between, null outside", () => {
    expect(trackHeightAt(samples, 0)).toBe(0);
    expect(trackHeightAt(samples, 1000)).toBe(1000);
    expect(trackHeightAt(samples, 500)).toBe(500);
    expect(trackHeightAt(samples, 2000)).toBe(0);
    expect(trackHeightAt(samples, 3000)).toBeNull();
  });
});
