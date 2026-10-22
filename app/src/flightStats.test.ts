import { describe, expect, it } from "vitest";
import { countsInStats, type StatsRow } from "./flightStats";

const row = (p: Partial<StatsRow>): StatsRow => ({ state: "completed", provider: "simconnect", takeoffMs: null, landingCount: 0, phase: "shutdown", distanceNm: 0, ...p });

describe("countsInStats", () => {
  it("never counts a discarded ground session", () => {
    expect(countsInStats(row({ state: "discarded" }))).toBe(false);
    expect(countsInStats(row({ state: "discarded", takeoffMs: 1, landingCount: 1 }))).toBe(false);
    expect(countsInStats(row({ state: "discarded", provider: "import:volanta_import" }))).toBe(false);
  });
  it("counts a recorded flight with a take-off or a touchdown", () => {
    expect(countsInStats(row({ takeoffMs: 1_000 }))).toBe(true);
    expect(countsInStats(row({ landingCount: 1 }))).toBe(true);
    expect(countsInStats(row({ state: "interrupted", takeoffMs: 1_000 }))).toBe(true);
    // start in the air: no take-off time, but a landing
    expect(countsInStats(row({ state: "completed", takeoffMs: undefined, landingCount: 2 }))).toBe(true);
  });
  it("does not count a recorded flight that only taxied (rows from before 0.5.1)", () => {
    expect(countsInStats(row({}))).toBe(false);
    expect(countsInStats(row({ state: "interrupted" }))).toBe(false);
    expect(countsInStats(row({ provider: null }))).toBe(false);
  });
  it("counts a flight that ended in the air only once it covered a distance (no ghost rows)", () => {
    // start in the air, interrupted in cruise after 120 nm: counts
    expect(countsInStats(row({ state: "interrupted", phase: "cruise", distanceNm: 120 }))).toBe(true);
    // MSFS load placeholder: "climb" at 0° N / 0° E, 0 nm → never counts
    expect(countsInStats(row({ state: "interrupted", phase: "climb", distanceNm: 0 }))).toBe(false);
    expect(countsInStats(row({ state: "interrupted", phase: "climb", distanceNm: 0.9 }))).toBe(false);
    expect(countsInStats(row({ state: "interrupted", phase: "final", distanceNm: 1 }))).toBe(true);
    // a ground phase with distance is still a taxi-only recording
    expect(countsInStats(row({ state: "completed", phase: "taxiIn", distanceNm: 5 }))).toBe(false);
  });
  it("always counts an imported flight", () => {
    expect(countsInStats(row({ provider: "import:vectasim" }))).toBe(true);
    expect(countsInStats(row({ provider: "import:generic", state: "completed" }))).toBe(true);
  });
});
