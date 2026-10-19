// Edge cases of the logbook search and quick filters (logbookFilter.ts) beyond
// logbookFilter.test.ts: fallbacks, unusual rows, purity.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setLanguageSetting } from "./i18n";
import { callsignOf, filterFlights, matchesQuery, matchesQuick, moveSelection, searchText } from "./logbookFilter";
import type { FlightRow } from "./types";

// the search matches the displayed (German) date
beforeAll(() => setLanguageSetting("de"));
afterAll(() => setLanguageSetting("system"));

const integrity = { pausedMs: 0, pauseCount: 0, slewDetected: false, timeAccelerationDetected: false, maxSimRate: 1, crashed: false, fuelIncreasedAirborne: false };

function row(over: Partial<FlightRow>): FlightRow {
  return {
    id: "x",
    state: "completed",
    phase: "shutdown",
    createdMs: Date.UTC(2026, 9, 17, 14, 30),
    updatedMs: 0,
    offBlockMs: Date.UTC(2026, 9, 17, 14, 30),
    maxAltMslFt: 0,
    distanceNm: 0,
    aircraft: { title: "PMDG 737-800", atcModel: "B738", atcType: "Boeing", atcId: "D-ABCD", atcAirline: "Condor", atcFlightNumber: "1234" },
    provider: "simconnect",
    depIcao: "EDDF",
    arrIcao: "LEPA",
    callsign: "CFG1234",
    hasOfp: false,
    integrity,
    landingVsFpm: -180,
    landingCount: 1,
    ...over,
  };
}

describe("callsignOf", () => {
  it("prefers the callsign, then airline + flight number, then the registration", () => {
    expect(callsignOf(row({}))).toBe("CFG1234");
    expect(callsignOf(row({ callsign: "" }))).toBe("Condor 1234");
    expect(callsignOf(row({ callsign: null, aircraft: { ...row({}).aircraft, atcFlightNumber: "" } }))).toBe("Condor");
    expect(callsignOf(row({ callsign: null, aircraft: { ...row({}).aircraft, atcAirline: "" } }))).toBe("D-ABCD");
    expect(callsignOf(row({ callsign: null, aircraft: { title: "", atcModel: "", atcType: "", atcId: "", atcAirline: "", atcFlightNumber: "" } }))).toBe("");
  });
});

describe("searchText / matchesQuery", () => {
  it("falls back to the planned route when the flown one is unknown", () => {
    const planned = row({ depIcao: null, arrIcao: null, plannedDep: "EDDH", plannedArr: "LOWW" });
    expect(matchesQuery(planned, "eddh")).toBe(true);
    expect(matchesQuery(planned, "eddh-loww")).toBe(true);
    expect(matchesQuery(planned, "EDDH→LOWW")).toBe(true);
  });
  it("finds an airport that differs from the plan (diversion) by both", () => {
    const diverted = row({ arrIcao: "LEIB", plannedArr: "LEPA" });
    expect(matchesQuery(diverted, "leib")).toBe(true);
    expect(matchesQuery(diverted, "lepa")).toBe(true);
    expect(matchesQuery(diverted, "eddf-leib")).toBe(true);
  });
  it("matches the airline and flight number written together", () => {
    expect(matchesQuery(row({ callsign: null }), "condor1234")).toBe(true);
  });
  it("is case-insensitive and ignores extra whitespace", () => {
    expect(matchesQuery(row({}), "  pmdg   B738  ")).toBe(true);
    expect(matchesQuery(row({}), "Boeing d-abcd")).toBe(true);
  });
  it("has no date terms for a row without a usable time and does not throw", () => {
    const undated = row({ offBlockMs: null, createdMs: 0 });
    expect(() => searchText(undated)).not.toThrow();
    expect(searchText(undated)).not.toContain("1970");
    expect(matchesQuery(undated, "2026")).toBe(false);
    expect(matchesQuery(undated, "eddf")).toBe(true);
  });
  it("uses the creation time when there is no off-block time", () => {
    const parked = row({ offBlockMs: null, createdMs: Date.UTC(2025, 0, 5, 9, 0) });
    expect(matchesQuery(parked, "2025-01-05")).toBe(true);
  });
  it("does not treat a search term as a regular expression", () => {
    expect(matchesQuery(row({}), ".*")).toBe(false);
    expect(matchesQuery(row({}), "(")).toBe(false);
  });
});

describe("matchesQuick", () => {
  it("counts a flight with a landing rate but no landing count as landed", () => {
    expect(matchesQuick(row({ landingCount: 0, landingVsFpm: -95 }), "landed")).toBe(true);
    expect(matchesQuick(row({ landingCount: 0, landingVsFpm: null }), "landed")).toBe(false);
    expect(matchesQuick(row({ landingCount: 2, landingVsFpm: undefined }), "landed")).toBe(true);
  });
  it("keeps active flights out of the completed and interrupted filters", () => {
    const active = row({ state: "active" });
    expect(matchesQuick(active, "completed")).toBe(false);
    expect(matchesQuick(active, "interrupted")).toBe(false);
    expect(matchesQuick(active, "all")).toBe(true);
  });
});

describe("filterFlights", () => {
  const rows = [
    row({ id: "1" }),
    row({ id: "2", provider: "replay" }),
    row({ id: "3", provider: null, state: "interrupted" }),
    row({ id: "4", provider: "mock" }),
  ];
  it("treats replayed and mock flights as demo flights, a missing provider as real", () => {
    expect(filterFlights(rows, { query: "", quick: "all", showDemo: false }).map((f) => f.id)).toEqual(["1", "3"]);
  });
  it("keeps the order and does not touch the input", () => {
    const before = rows.map((f) => f.id);
    const out = filterFlights(rows, { query: "eddf", quick: "all", showDemo: true });
    expect(out.map((f) => f.id)).toEqual(["1", "2", "3", "4"]);
    expect(rows.map((f) => f.id)).toEqual(before);
    expect(out).not.toBe(rows);
  });
  it("returns nothing for an empty list", () => {
    expect(filterFlights([], { query: "x", quick: "landed", showDemo: false })).toEqual([]);
  });
});

describe("moveSelection", () => {
  it("handles a single row and a zero step", () => {
    expect(moveSelection(["only"], "only", 1)).toBe("only");
    expect(moveSelection(["only"], "only", -1)).toBe("only");
    expect(moveSelection(["a", "b"], "b", 0)).toBe("b");
    expect(moveSelection(["a", "b"], null, 0)).toBe("a");
  });
});
