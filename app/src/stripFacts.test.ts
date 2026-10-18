import { describe, expect, it } from "vitest";
import { stripFactsFrom, type LandingStripFact } from "./stripFacts";

const landing = (p: Partial<LandingStripFact>): LandingStripFact => ({ flightId: "a", touchdownIndex: 0, touchdownDistanceM: 400, ...p });

describe("stripFactsFrom", () => {
  it("keeps the last touchdown of a flight", () => {
    const m = stripFactsFrom([landing({ touchdownIndex: 1, touchdownDistanceM: 600 }), landing({ touchdownIndex: 0, touchdownDistanceM: 300 })], []);
    expect(m.get("a")?.touchdownDistanceM).toBe(600);
  });

  it("takes the landed approach and counts go-arounds", () => {
    const m = stripFactsFrom(
      [landing({ runwayIdent: "25R" })],
      [
        { flightId: "a", approachIndex: 2, outcome: "landed", stableFromFt: 1200, band: "stable" },
        { flightId: "a", approachIndex: 1, outcome: "go_around", stableFromFt: null, band: "unstable" },
        { flightId: "a", approachIndex: 0, outcome: "touch_and_go", stableFromFt: 500, band: "deviations" },
      ],
    );
    expect(m.get("a")).toEqual({
      touchdownDistanceM: 400,
      centerlineOffsetM: undefined,
      runwayIdent: "25R",
      inTouchdownZone: undefined,
      stableFromFt: 1200,
      band: "stable",
      goArounds: 1,
    });
  });

  it("falls back to the last touch-and-go and keeps never-stable as null", () => {
    const m = stripFactsFrom(
      [],
      [
        { flightId: "b", approachIndex: 0, outcome: "touch_and_go", stableFromFt: 800, band: "deviations" },
        { flightId: "b", approachIndex: 1, outcome: "touch_and_go", stableFromFt: null, band: "unstable" },
      ],
    );
    expect(m.get("b")).toEqual({ stableFromFt: null, band: "unstable", goArounds: 0 });
  });

  it("gives a flight with only go-arounds the count, no approach values", () => {
    const m = stripFactsFrom([], [{ flightId: "c", approachIndex: 0, outcome: "go_around", stableFromFt: null, band: null }]);
    expect(m.get("c")).toEqual({ goArounds: 1 });
  });

  it("keeps the landing only for flights without approach facts", () => {
    const m = stripFactsFrom([landing({ flightId: "d" })], []);
    expect(m.get("d")).not.toHaveProperty("goArounds");
  });
});
