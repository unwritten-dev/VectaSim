import { describe, expect, it } from "vitest";
import { atcGeoJson, geoJsonKey, networksOf, pilotsGeoJson } from "./online";
import type { LocatedController, Pilot } from "../types";

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

const pilot = (network: Pilot["network"], callsign: string, onGround?: boolean): Pilot => ({
  network,
  cid: 1,
  callsign,
  latitude: 50,
  longitude: 8.5,
  altitudeFt: 3000,
  groundSpeedKt: 200,
  headingDeg: 250,
  transponder: "1000",
  aircraftShort: "A20N",
  departure: "EDDF",
  arrival: "LEPA",
  route: "",
  flightRules: "I",
  onGround,
});

const atc = (network: LocatedController["network"], callsign: string, facility: LocatedController["facility"]): LocatedController => ({
  network,
  cid: 2,
  callsign,
  frequency: "119.900",
  facility,
  visualRangeNm: 0,
  textAtis: [],
  atisCode: null,
  airport: "EDDF",
  latitude: 50.03,
  longitude: 8.57,
});

describe("both networks on one map", () => {
  it("tags every pilot with its network", () => {
    const fc = pilotsGeoJson([pilot("vatsim", "DLH1"), pilot("ivao", "TST1", true)]);
    expect(fc.features.map((f) => f.properties?.network)).toEqual(["vatsim", "ivao"]);
    expect(fc.features[1].properties?.ground).toBe(true);
    expect(fc.features[0].properties?.ground).toBe(false);
  });
  it("marks airports staffed on IVAO, VATSIM or both", () => {
    expect(networksOf([{ network: "ivao" }, { network: "ivao" }])).toBe("ivao");
    expect(networksOf([{ network: "vatsim" }, { network: "ivao" }])).toBe("both");
    const fc = atcGeoJson([atc("vatsim", "EDDF_TWR", "twr"), atc("ivao", "EDDF_APP", "app")]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties?.net).toBe("both");
    const stations = JSON.parse(String(fc.features[0].properties?.stations));
    expect(stations.map((s: { network: string }) => s.network)).toEqual(["vatsim", "ivao"]);
  });
});
