import { describe, expect, it } from "vitest";
import { geoJsonKey } from "./online";

const fc = (alt: number): GeoJSON.FeatureCollection => ({
  type: "FeatureCollection",
  features: [{ type: "Feature", properties: { callsign: "DLH1", alt }, geometry: { type: "Point", coordinates: [8, 50] } }],
});

describe("geoJsonKey", () => {
  it("is stable for equal content and changes with it", () => {
    expect(geoJsonKey(fc(35000))).toBe(geoJsonKey(fc(35000)));
    expect(geoJsonKey(fc(35000))).not.toBe(geoJsonKey(fc(35100)));
    expect(geoJsonKey({ type: "FeatureCollection", features: [] })).not.toBe(geoJsonKey(fc(0)));
  });
});
