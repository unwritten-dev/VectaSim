import { describe, expect, it } from "vitest";
import type { TrackSample } from "../types";
import type { TrackEvent } from "../trackEvents";
import { trackEventsGeoJson } from "./trackEventLayers";

const sample = (tMs: number, longitude: number): TrackSample => ({
  tMs,
  latitude: 10,
  longitude,
  altitudeMslFt: 5000,
  altitudeAglFt: 5000,
  groundSpeedKt: 300,
  iasKt: 250,
  verticalSpeedFpm: 0,
  headingTrueDeg: 90,
  pitchDeg: 0,
  bankDeg: 0,
  gForce: 1,
  onGround: false,
  flapsIndex: 0,
  gearPct: 0,
  fuelTotalKg: 1000,
});

describe("trackEventsGeoJson", () => {
  it("H-5: a run across the antimeridian is unwrapped (the short way, not around the world)", () => {
    const samples = [sample(0, 179.98), sample(1000, 179.99), sample(2000, -179.99), sample(3000, -179.98)];
    const run: TrackEvent = { id: "r", group: "gear", kind: "gearDown", tone: "neutral", tMs: 0, endTMs: 3000, latitude: 10, longitude: 179.98, aglFt: 5000, iasKt: 250 };
    const line = trackEventsGeoJson([run], samples).features.find((f) => f.geometry.type === "LineString")!;
    const lons = (line.geometry as GeoJSON.LineString).coordinates.map((c) => c[0]);
    expect(lons[0]).toBeCloseTo(179.98, 6);
    expect(lons[3]).toBeCloseTo(180.02, 6);
    for (let i = 1; i < lons.length; i++) expect(Math.abs(lons[i] - lons[i - 1])).toBeLessThan(1);
  });
});
