import { describe, expect, it } from "vitest";
import { filterFlights, matchesQuery, moveSelection } from "./logbookFilter";
import type { FlightRow } from "./types";

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
    aircraft: { title: "Fenix A320", atcModel: "A320", atcType: "Airbus", atcId: "D-AIZZ", atcAirline: "Lufthansa", atcFlightNumber: "400" },
    provider: "simconnect",
    depIcao: "EDDF",
    arrIcao: "EDDM",
    callsign: "DLH4AB",
    hasOfp: false,
    integrity,
    landingVsFpm: -140,
    landingCount: 1,
    ...over,
  };
}

const rows: FlightRow[] = [
  row({ id: "a" }),
  row({ id: "b", state: "interrupted", depIcao: "EGLL", arrIcao: null, landingVsFpm: null, landingCount: 0, callsign: null, offBlockMs: Date.UTC(2026, 8, 1, 8, 0) }),
  row({ id: "c", provider: "mock", aircraft: { title: "Mock Airlines A320neo", atcModel: "A20N", atcType: "", atcId: "D-AVCT", atcAirline: "Mock Air", atcFlightNumber: "VS001" } }),
  row({ id: "d", state: "active", arrIcao: null, landingVsFpm: null, landingCount: 0 }),
];

const ids = (list: FlightRow[]) => list.map((f) => f.id);

describe("matchesQuery", () => {
  it("matches route, aircraft, registration, callsign and date", () => {
    expect(matchesQuery(rows[0], "eddf")).toBe(true);
    expect(matchesQuery(rows[0], "EDDF EDDM")).toBe(true);
    expect(matchesQuery(rows[0], "eddf-eddm")).toBe(true);
    expect(matchesQuery(rows[0], "eddf->eddm")).toBe(true);
    expect(matchesQuery(rows[0], "fenix")).toBe(true);
    expect(matchesQuery(rows[0], "d-aizz")).toBe(true);
    expect(matchesQuery(rows[0], "dlh4ab")).toBe(true);
    expect(matchesQuery(rows[0], "17.10.2026")).toBe(true);
    expect(matchesQuery(rows[0], "2026-10-17")).toBe(true);
    expect(matchesQuery(rows[0], "17.10.")).toBe(true);
  });
  it("needs every term", () => {
    expect(matchesQuery(rows[0], "eddf egll")).toBe(false);
    expect(matchesQuery(rows[0], "")).toBe(true);
    expect(matchesQuery(rows[0], "   ")).toBe(true);
  });
  it("falls back to the airline + flight number when no callsign is set", () => {
    expect(matchesQuery(rows[1], "lufthansa 400")).toBe(true);
  });
});

describe("filterFlights", () => {
  it("hides demo flights unless enabled", () => {
    expect(ids(filterFlights(rows, { query: "", quick: "all", showDemo: false }))).toEqual(["a", "b", "d"]);
    expect(ids(filterFlights(rows, { query: "", quick: "all", showDemo: true }))).toEqual(["a", "b", "c", "d"]);
  });
  it("applies quick filters", () => {
    expect(ids(filterFlights(rows, { query: "", quick: "completed", showDemo: true }))).toEqual(["a", "c"]);
    expect(ids(filterFlights(rows, { query: "", quick: "interrupted", showDemo: true }))).toEqual(["b"]);
    expect(ids(filterFlights(rows, { query: "", quick: "landed", showDemo: false }))).toEqual(["a"]);
  });
  it("combines search and quick filter", () => {
    expect(ids(filterFlights(rows, { query: "a20n", quick: "completed", showDemo: true }))).toEqual(["c"]);
    expect(ids(filterFlights(rows, { query: "egll", quick: "completed", showDemo: true }))).toEqual([]);
  });
});

describe("moveSelection", () => {
  const list = ["a", "b", "c"];
  it("moves and clamps", () => {
    expect(moveSelection(list, "a", 1)).toBe("b");
    expect(moveSelection(list, "c", 1)).toBe("c");
    expect(moveSelection(list, "a", -1)).toBe("a");
    expect(moveSelection(list, "b", 10)).toBe("c");
  });
  it("starts at an end when nothing (or a hidden row) is selected", () => {
    expect(moveSelection(list, null, 1)).toBe("a");
    expect(moveSelection(list, "zz", -1)).toBe("c");
    expect(moveSelection([], "a", 1)).toBeNull();
  });
});
