import { describe, expect, it } from "vitest";
import {
  QUICK_FILTERS,
  callsignOf,
  effectiveAircraftTitle,
  effectiveArr,
  effectiveDep,
  effectiveRegistration,
  filterFlights,
  matchesQuery,
  moveSelection,
  normalizeTags,
  notesFirstLine,
  originalTitle,
  recordedCallsignOf,
  tagCounts,
  trashDaysLeft,
} from "./logbookFilter";
import { importSourceLabel, isDemoRow, isImportedRow } from "./totals";
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

describe("QUICK_FILTERS", () => {
  it("names finished flights „Abgeschlossen“ (every flight is saved)", () => {
    expect(QUICK_FILTERS.map((q) => q.label)).toEqual(["Alle", "Abgeschlossen", "Unvollständig", "Mit Landung"]);
    expect(QUICK_FILTERS.map((q) => q.label)).not.toContain("Gespeichert");
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

describe("trashDaysLeft", () => {
  const day = 86_400_000;
  it("counts whole days until the purge", () => {
    expect(trashDaysLeft(0, 0)).toBe(30);
    expect(trashDaysLeft(0, 1)).toBe(30);
    expect(trashDaysLeft(0, 29.5 * day)).toBe(1);
    expect(trashDaysLeft(0, 30 * day)).toBe(0);
    expect(trashDaysLeft(0, 45 * day)).toBe(0);
    expect(trashDaysLeft(0, 2 * day, 7)).toBe(5);
  });
});

describe("Notizen & Tags", () => {
  const noted = row({
    id: "n",
    notes: "Böiger Seitenwind\nzweiter Anflug nach Go-around",
    tags: ["VATSIM", "Event"],
    userDepIcao: "EDDK",
    userCallsign: "EWG9X",
    userAircraftTitle: "A321neo Eurowings",
    userRegistration: "D-AEWA",
    rating: 4,
  });
  const list = [noted, row({ id: "p", tags: ["training"] }), row({ id: "q" })];

  it("search finds notes, tags and corrections – and the recorded values still", () => {
    expect(matchesQuery(noted, "seitenwind")).toBe(true);
    expect(matchesQuery(noted, "go-around")).toBe(true);
    expect(matchesQuery(noted, "vatsim")).toBe(true);
    expect(matchesQuery(noted, "#event")).toBe(true);
    expect(matchesQuery(noted, "eddk")).toBe(true);
    expect(matchesQuery(noted, "eddk-eddm")).toBe(true);
    expect(matchesQuery(noted, "eddf")).toBe(true);
    expect(matchesQuery(noted, "ewg9x")).toBe(true);
    expect(matchesQuery(noted, "d-aewa")).toBe(true);
    expect(matchesQuery(noted, "a321neo")).toBe(true);
    expect(matchesQuery(rows[0], "seitenwind")).toBe(false);
  });

  it("the tag filter keeps flights with at least one selected tag (case-insensitive)", () => {
    const f = (tags: string[]) => ids(filterFlights(list, { query: "", quick: "all", showDemo: true, tags }));
    expect(f([])).toEqual(["n", "p", "q"]);
    expect(f(["vatsim"])).toEqual(["n"]);
    expect(f(["vatsim", "TRAINING"])).toEqual(["n", "p"]);
    expect(f(["unknown"])).toEqual([]);
    expect(ids(filterFlights(list, { query: "wind", quick: "all", showDemo: true, tags: ["training"] }))).toEqual([]);
  });

  it("corrections overlay the recorded values", () => {
    expect(effectiveDep(noted)).toBe("EDDK");
    expect(effectiveArr(noted)).toBe("EDDM");
    expect(callsignOf(noted)).toBe("EWG9X");
    expect(recordedCallsignOf(noted)).toBe("DLH4AB");
    expect(effectiveAircraftTitle(noted)).toBe("A321neo Eurowings");
    expect(effectiveRegistration(noted)).toBe("D-AEWA");
    expect(effectiveRegistration(rows[0])).toBe("D-AIZZ");
    expect(effectiveDep(row({ userDepIcao: "  " }))).toBe("EDDF");
    expect(originalTitle(noted.userDepIcao, noted.depIcao)).toBe("Sim: EDDF");
    expect(originalTitle(null, "EDDF")).toBeNull();
    expect(originalTitle("EDDF", "EDDF")).toBeNull();
    expect(originalTitle("EDDK", null)).toBe("Sim: –");
  });

  it("normalises tags like the backend", () => {
    expect(normalizeTags(["  VATSIM ", "vatsim", "Night  Flight", "a,b", "", "x".repeat(40)])).toEqual(["VATSIM", "Night Flight", "a b", "x".repeat(30)]);
    expect(normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(20);
  });

  it("counts tags over flights, most used first", () => {
    expect(tagCounts([noted, row({ tags: ["vatsim"] }), row({ tags: ["vatsim", "Anflug"] })])).toEqual([
      { tag: "vatsim", count: 3 },
      { tag: "Anflug", count: 1 },
      { tag: "Event", count: 1 },
    ]);
  });

  it("gives the first line of the notes for the strip tooltip", () => {
    expect(notesFirstLine(noted.notes)).toBe("Böiger Seitenwind");
    expect(notesFirstLine("\n  \nzweite")).toBe("zweite");
    expect(notesFirstLine("")).toBeNull();
    expect(notesFirstLine(null)).toBeNull();
    expect(notesFirstLine("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("imported flights", () => {
  it("are recognised by their provider prefix", () => {
    expect(isImportedRow(row({ provider: "import:volanta_import" }))).toBe(true);
    expect(isImportedRow(row({ provider: "import:generic" }))).toBe(true);
    for (const provider of ["simconnect", "mock", "replay", "importer", null, undefined]) expect(isImportedRow(row({ provider }))).toBe(false);
    expect(isDemoRow(row({ provider: "import:vectasim" }))).toBe(false);
  });

  it("name their source", () => {
    expect(importSourceLabel(row({ provider: "import:volanta_import" }))).toBe("Volanta");
    expect(importSourceLabel(row({ provider: "import:simtoolkitpro" }))).toBe("SimToolkitPro");
    expect(importSourceLabel(row({ provider: "import:somethingnew" }))).toBe("somethingnew");
    expect(importSourceLabel(row({ provider: "simconnect" }))).toBeNull();
  });

  it("stay findable and filterable like any other flight", () => {
    const imported = row({ id: "imp", provider: "import:volanta_import", depIcao: "EDDF", arrIcao: "EGLL" });
    expect(matchesQuery(imported, "EGLL")).toBe(true);
  });
});
