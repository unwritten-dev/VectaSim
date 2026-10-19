import { describe, expect, it } from "vitest";
import {
  GONE_CLOSE_MS,
  aircraftTypeName,
  airlineFromCallsign,
  applyFeedUpdate,
  compassPoint,
  distanceBearing,
  findTraffic,
  flightRulesLabel,
  formatRegistration,
  greatCircle,
  plannedAltitude,
  registrationFromCallsign,
  registrationFromRemarks,
  selectTraffic,
  shouldClose,
  trafficKey,
  trafficRegistration,
  trendOf,
  verticalSpeedFpm,
} from "./trafficInfo";
import type { Pilot } from "../types";

const pilot = (over: Partial<Pilot> = {}): Pilot => ({
  network: "vatsim",
  cid: 1234567,
  callsign: "DLH4AB",
  latitude: 50,
  longitude: 8.5,
  altitudeFt: 30000,
  groundSpeedKt: 450,
  headingDeg: 250,
  transponder: "1000",
  aircraftShort: "A20N",
  departure: "EDDF",
  arrival: "LEPA",
  route: "ANEKI Y163 NATOR",
  flightRules: "I",
  ...over,
});

describe("registration", () => {
  it("reads REG/ from the remarks and adds the nationality dash", () => {
    expect(registrationFromRemarks("PBN/A1B1C1D1 DOF/261018 REG/DAIZB EET/LFFF0030")).toBe("D-AIZB");
    expect(registrationFromRemarks("reg/oelba /v/")).toBe("OE-LBA");
    expect(registrationFromRemarks("REG/D-AINA")).toBe("D-AINA");
    expect(registrationFromRemarks("PBN/A1 REG/9HQAA")).toBe("9H-QAA");
    expect(registrationFromRemarks("REG/A6EDA OPR/UAE")).toBe("A6-EDA");
    expect(registrationFromRemarks("REG/N123AB")).toBe("N123AB");
    expect(registrationFromRemarks("REG/JA8089")).toBe("JA8089");
    expect(registrationFromRemarks("REG/GEUUA")).toBe("G-EUUA");
    expect(registrationFromRemarks("REG/CFGKZ")).toBe("C-FGKZ");
  });

  it("ignores remarks without a registration", () => {
    expect(registrationFromRemarks("PBN/A1B1C1D1 /v/")).toBeNull();
    expect(registrationFromRemarks("")).toBeNull();
    expect(registrationFromRemarks(undefined)).toBeNull();
    // OPR/ or similar codes are not REG/
    expect(registrationFromRemarks("OPR/DLH")).toBeNull();
    expect(registrationFromRemarks("XREG/DAIZB")).toBeNull();
  });

  it("formats or rejects raw registrations", () => {
    expect(formatRegistration("daizb")).toBe("D-AIZB");
    expect(formatRegistration("HBJCA")).toBe("HB-JCA");
    expect(formatRegistration("--")).toBeNull();
    expect(formatRegistration("12345")).toBeNull();
    expect(formatRegistration("D-AIZB")).toBe("D-AIZB");
  });

  it("takes GA callsigns that are registrations, never airline callsigns", () => {
    expect(registrationFromCallsign("DEABC")).toBe("D-EABC");
    expect(registrationFromCallsign("N172SP")).toBe("N172SP");
    expect(registrationFromCallsign("OEKAT")).toBe("OE-KAT");
    expect(registrationFromCallsign("DLH4AB")).toBeNull();
    expect(registrationFromCallsign("EWG1234")).toBeNull();
    expect(trafficRegistration({ callsign: "DLH4AB", remarks: "REG/DAINA" })).toBe("D-AINA");
    expect(trafficRegistration({ callsign: "DLH4AB", remarks: "" })).toBeNull();
  });
});

describe("airline and type", () => {
  it("derives the airline from the callsign prefix", () => {
    expect(airlineFromCallsign("DLH4AB")).toEqual({ icao: "DLH", name: "Lufthansa" });
    expect(airlineFromCallsign("ewg7am")).toEqual({ icao: "EWG", name: "Eurowings" });
    // unknown code: the ICAO code alone
    expect(airlineFromCallsign("XYZ123")).toEqual({ icao: "XYZ", name: null });
    // GA, registrations, ATC-like callsigns
    expect(airlineFromCallsign("DEABC")).toBeNull();
    expect(airlineFromCallsign("N172SP")).toBeNull();
    expect(airlineFromCallsign("")).toBeNull();
  });

  it("names the type, falls back to the feed's model", () => {
    expect(aircraftTypeName("A20N")).toBe("Airbus A320neo");
    expect(aircraftTypeName("b77w")).toBe("Boeing 777-300ER");
    expect(aircraftTypeName("ZZZZ", "Homebuilt Special")).toBe("Homebuilt Special");
    expect(aircraftTypeName("ZZZZ")).toBeNull();
    expect(aircraftTypeName("ZZZZ", "ZZZZ")).toBeNull();
  });

  it("labels flight rules and filed levels", () => {
    expect(flightRulesLabel("I")).toBe("IFR");
    expect(flightRulesLabel("v")).toBe("VFR");
    expect(flightRulesLabel("")).toBeNull();
    expect(plannedAltitude("36000")).toEqual({ ft: 36000 });
    expect(plannedAltitude("F340")).toEqual({ ft: 34000 });
    expect(plannedAltitude("FL350")).toEqual({ ft: 35000 });
    expect(plannedAltitude("A045")).toEqual({ ft: 4500 });
    expect(plannedAltitude("350")).toEqual({ ft: 35000 });
    expect(plannedAltitude("VFR")).toEqual({ text: "VFR" });
    expect(plannedAltitude("")).toBeNull();
  });
});

describe("distance and bearing", () => {
  it("measures from the own aircraft to the traffic", () => {
    // one degree of latitude due north ≈ 60 nm
    const n = distanceBearing({ lat: 50, lon: 8 }, { lat: 51, lon: 8 });
    expect(n.nm).toBeCloseTo(60.04, 1);
    expect(n.deg).toBeCloseTo(0, 5);
    const e = distanceBearing({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
    expect(e.deg).toBeCloseTo(90, 5);
    const sw = distanceBearing({ lat: 50, lon: 8 }, { lat: 49, lon: 7 });
    expect(sw.deg).toBeGreaterThan(200);
    expect(sw.deg).toBeLessThan(220);
    // across the antimeridian: short way east
    const am = distanceBearing({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 });
    expect(am.nm).toBeCloseTo(60.04, 0);
    expect(am.deg).toBeCloseTo(90, 3);
  });

  it("names compass points in German", () => {
    expect(compassPoint(0, "de")).toBe("N");
    expect(compassPoint(44, "de")).toBe("NO");
    expect(compassPoint(90, "de")).toBe("O");
    expect(compassPoint(200, "de")).toBe("SSW");
    expect(compassPoint(359, "de")).toBe("N");
  });

  it("names compass points in English", () => {
    expect(compassPoint(44, "en")).toBe("NE");
    expect(compassPoint(90, "en")).toBe("E");
    expect(compassPoint(160, "en")).toBe("SSE");
    expect(compassPoint(200, "en")).toBe("SSW");
  });

  it("draws great circles continuously over the antimeridian", () => {
    const line = greatCircle({ lat: -33.9, lon: 151.2 }, { lat: 21.3, lon: -157.9 }, 32);
    expect(line).toHaveLength(33);
    expect(line[0]).toEqual([151.2, -33.9]);
    for (let i = 1; i < line.length; i++) expect(Math.abs(line[i][0] - line[i - 1][0])).toBeLessThan(10);
    expect(line[32][0]).toBeCloseTo(-157.9 + 360, 3);
    expect(line[32][1]).toBeCloseTo(21.3, 3);
  });
});

describe("selection over feed updates", () => {
  it("keys by network and CID", () => {
    expect(trafficKey({ network: "ivao", cid: 5 })).toBe("ivao:5");
    const list = [pilot({ network: "ivao", cid: 1234567, callsign: "IVAO1" }), pilot()];
    expect(findTraffic(list, { network: "vatsim", cid: 1234567 })?.callsign).toBe("DLH4AB");
    expect(findTraffic(list, { network: "ivao", cid: 1234567 })?.callsign).toBe("IVAO1");
    expect(findTraffic(list, { network: "ivao", cid: 9 })).toBeNull();
  });

  it("follows the pilot, computes the trend and survives repeats", () => {
    let s = selectTraffic({ network: "vatsim", cid: 1234567 });
    s = applyFeedUpdate(s, pilot({ name: "Pilot One", remarks: "REG/DAINA" }), 0);
    expect(verticalSpeedFpm(s)).toBeNull();
    // the other network polled: same position, no new sample
    s = applyFeedUpdate(s, pilot(), 5_000);
    expect(s.prev).toBeNull();
    // bulk data without detail fields keeps name and remarks
    expect(s.pilot?.name).toBe("Pilot One");
    expect(s.pilot?.remarks).toBe("REG/DAINA");
    s = applyFeedUpdate(s, pilot({ altitudeFt: 30500, latitude: 50.02 }), 15_000);
    expect(verticalSpeedFpm(s)).toBeCloseTo(2000, 5);
    expect(trendOf(verticalSpeedFpm(s))).toBe("climb");
    s = applyFeedUpdate(s, pilot({ altitudeFt: 30500, latitude: 50.04 }), 30_000);
    expect(trendOf(verticalSpeedFpm(s))).toBe("level");
    expect(s.pilot?.latitude).toBe(50.04);
  });

  it("marks the pilot gone and closes after 30 s, recovers if it comes back", () => {
    let s = applyFeedUpdate(selectTraffic({ network: "vatsim", cid: 1234567 }), pilot(), 0);
    s = applyFeedUpdate(s, null, 1_000);
    expect(s.goneSinceMs).toBe(1_000);
    // the last known state stays for the card
    expect(s.pilot?.callsign).toBe("DLH4AB");
    s = applyFeedUpdate(s, null, 16_000);
    expect(s.goneSinceMs).toBe(1_000);
    expect(shouldClose(s, 1_000 + GONE_CLOSE_MS - 1)).toBe(false);
    expect(shouldClose(s, 1_000 + GONE_CLOSE_MS)).toBe(true);
    s = applyFeedUpdate(s, pilot({ latitude: 50.1 }), 20_000);
    expect(s.goneSinceMs).toBeNull();
    expect(shouldClose(s, 1e9)).toBe(false);
  });
});
