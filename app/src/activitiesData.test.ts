import { describe, expect, it } from "vitest";
import { airportCounts, visitedAirportCounts } from "./activitiesData";
import type { FlightRow } from "./types";

const integrity = { pausedMs: 0, pauseCount: 0, slewDetected: false, timeAccelerationDetected: false, maxSimRate: 1, crashed: false, fuelIncreasedAirborne: false };

function row(over: Partial<FlightRow>): FlightRow {
  return {
    id: "x",
    state: "completed",
    phase: "shutdown",
    createdMs: 0,
    updatedMs: 0,
    offBlockMs: 0,
    maxAltMslFt: 0,
    distanceNm: 0,
    aircraft: { title: "A320", atcModel: "A320", atcType: "Airbus", atcId: "D-AIZZ", atcAirline: "", atcFlightNumber: "" },
    provider: "simconnect",
    depIcao: "EDDF",
    arrIcao: "EDDM",
    callsign: null,
    hasOfp: false,
    integrity,
    landingVsFpm: null,
    landingCount: 1,
    ...over,
  };
}

describe("airportCounts", () => {
  it("counts the pilot's corrected airports, not the recorded ones", () => {
    const counts = airportCounts([
      row({ id: "a" }),
      // recorded EDDF → EDDM, corrected by the pilot to EDDS → EDDN
      row({ id: "b", userDepIcao: "EDDS", userArrIcao: "eddn " }),
    ]);
    expect(counts.get("EDDF")).toEqual({ departures: 1, arrivals: 0 });
    expect(counts.get("EDDM")).toEqual({ departures: 0, arrivals: 1 });
    expect(counts.get("EDDS")).toEqual({ departures: 1, arrivals: 0 });
    expect(counts.get("EDDN")).toEqual({ departures: 0, arrivals: 1 });
  });

  it("skips missing airports and merges case variants", () => {
    const counts = airportCounts([row({ depIcao: "eddf", arrIcao: null }), row({ depIcao: " ", arrIcao: "EDDF" })]);
    expect([...counts.keys()]).toEqual(["EDDF"]);
    expect(counts.get("EDDF")).toEqual({ departures: 1, arrivals: 1 });
  });
});

describe("visitedAirportCounts", () => {
  it("leaves out discarded ground sessions, taxi-only rows and (by the setting) demo flights", () => {
    const all = [
      row({ id: "a" }),
      row({ id: "b", state: "discarded", depIcao: "EGLL", arrIcao: "EGLL", landingCount: 0 }),
      row({ id: "c", depIcao: "LFPG", arrIcao: "LFPG", landingCount: 0, takeoffMs: null }),
      row({ id: "d", provider: "mock", depIcao: "KJFK", arrIcao: "KBOS" }),
    ];
    const counts = visitedAirportCounts(all, false);
    expect([...counts.keys()]).toEqual(["EDDF", "EDDM"]);
    expect([...visitedAirportCounts(all, true).keys()]).toEqual(["EDDF", "EDDM", "KJFK", "KBOS"]);
  });
});
