import { describe, expect, it } from "vitest";
import type { ApproachFact } from "./approachTypes";
import {
  GATE_TOLERANCE,
  applyApproachFilter,
  approachAircraftKey,
  approachFilterOptions,
  approachSummary,
  gateHits,
  gatePassRate,
  gatePoint,
  lateralAt,
  meanOf,
  niceHalfRange,
  withinTolerance,
} from "./approachStats";

function fact(p: Partial<ApproachFact>): ApproachFact {
  return {
    flightId: "f",
    approachIndex: 0,
    version: 1,
    computedMs: 0,
    outcome: "landed",
    touchdownIndex: 0,
    airportIcao: "EDDF",
    runwayIdent: "25R",
    endedMs: 1,
    establishedNm: null,
    establishedHatFt: null,
    stableFromFt: null,
    vappKt: null,
    vappSource: null,
    gpDeg: null,
    gpSource: null,
    g10AltDevFt: null,
    g10IasKt: null,
    g10EnergyDevFt: null,
    gfafAltDevFt: null,
    gfafIasDevKt: null,
    g1000AltDevFt: null,
    g1000IasDevKt: null,
    g1000LatDevM: null,
    g1000VsFpm: null,
    g1000Pass: null,
    g500AltDevFt: null,
    g500IasDevKt: null,
    g500LatDevM: null,
    g500VsFpm: null,
    g500Pass: null,
    gpRmsFt: null,
    latRmsM: null,
    iasMadKt: null,
    vsSdFpm: null,
    gaLowestHatFt: null,
    detailJson: null,
    band: null,
    elevationSource: null,
    exceeded: [],
    exceedancesBelow500: 0,
    vappPlausible: null,
    thresholdHeightFt: null,
    goAroundDetectedBy: null,
    aircraftIcaoType: "A320",
    aircraftTitle: null,
    registration: null,
    provider: null,
    ...p,
  };
}

describe("withinTolerance", () => {
  it("checks the box inclusively on both axes", () => {
    const t = GATE_TOLERANCE.ft1000;
    expect(withinTolerance({ altDevFt: 100, iasDevKt: 20 }, t)).toBe(true);
    expect(withinTolerance({ altDevFt: -100, iasDevKt: -5 }, t)).toBe(true);
    expect(withinTolerance({ altDevFt: 101, iasDevKt: 0 }, t)).toBe(false);
    expect(withinTolerance({ altDevFt: 0, iasDevKt: 21 }, t)).toBe(false);
    expect(withinTolerance({ altDevFt: 0, iasDevKt: -6 }, t)).toBe(false);
  });
  it("ignores the speed axis at 10 NM", () => {
    expect(withinTolerance({ altDevFt: 400, iasDevKt: 90 }, GATE_TOLERANCE.tenNm)).toBe(true);
    expect(withinTolerance({ altDevFt: -501, iasDevKt: 0 }, GATE_TOLERANCE.tenNm)).toBe(false);
  });
  it("uses the FAF limits -5/+40 kt, +-300 ft", () => {
    expect(withinTolerance({ altDevFt: 300, iasDevKt: 40 }, GATE_TOLERANCE.faf)).toBe(true);
    expect(withinTolerance({ altDevFt: 0, iasDevKt: 41 }, GATE_TOLERANCE.faf)).toBe(false);
  });
});

describe("gatePoint / gateHits", () => {
  it("needs both values; derives the 10 NM speed deviation from Vapp", () => {
    expect(gatePoint(fact({ g1000AltDevFt: 40 }), "ft1000")).toBeNull();
    expect(gatePoint(fact({ g1000AltDevFt: 40, g1000IasDevKt: 6 }), "ft1000")).toEqual({ altDevFt: 40, iasDevKt: 6 });
    expect(gatePoint(fact({ g10AltDevFt: 200, g10IasKt: 210 }), "tenNm")).toBeNull();
    expect(gatePoint(fact({ g10AltDevFt: 200, g10IasKt: 210, vappKt: 140 }), "tenNm")).toEqual({ altDevFt: 200, iasDevKt: 70 });
  });
  it("counts the points inside the box among the measurable ones", () => {
    const facts = [fact({ g500AltDevFt: 10, g500IasDevKt: 3 }), fact({ g500AltDevFt: 80, g500IasDevKt: 3 }), fact({ g500AltDevFt: null, g500IasDevKt: 3 })];
    expect(gateHits(facts, "ft500")).toEqual({ inside: 1, total: 2 });
  });
});

describe("gatePassRate", () => {
  it("leaves unreached gates (null) out of the quota", () => {
    const facts = [fact({ g1000Pass: true }), fact({ g1000Pass: false }), fact({ g1000Pass: null }), fact({ g1000Pass: true })];
    const r = gatePassRate(facts, "ft1000");
    expect(r.passed).toBe(2);
    expect(r.total).toBe(3);
    expect(r.rate).toBeCloseTo(2 / 3);
    expect(gatePassRate([fact({})], "ft500")).toEqual({ passed: 0, total: 0, rate: null });
  });
});

describe("meanOf / approachSummary", () => {
  it("averages only the measurable values", () => {
    expect(meanOf([1000, null, 500, undefined, NaN])).toEqual({ mean: 750, n: 2 });
    expect(meanOf([null])).toEqual({ mean: null, n: 0 });
  });
  it("summarises stable-from, never-stable, gates and go-arounds", () => {
    const s = approachSummary([
      fact({ stableFromFt: 1500, band: "stable", g1000Pass: true, g500Pass: true }),
      fact({ stableFromFt: 700, band: "deviations", g1000Pass: false, g500Pass: true }),
      fact({ stableFromFt: null, band: "unstableBelow500", g1000Pass: false, g500Pass: false }),
      fact({ outcome: "go_around", stableFromFt: null, band: null }),
    ]);
    expect(s.count).toBe(4);
    expect(s.goArounds).toBe(1);
    expect(s.meanStableFromFt).toBe(1100);
    expect(s.stableN).toBe(2);
    expect(s.neverStable).toBe(1);
    expect(s.gate1000).toMatchObject({ passed: 1, total: 3 });
    expect(s.gate500).toMatchObject({ passed: 2, total: 3 });
  });
});

describe("filter", () => {
  it("keys aircraft by type, then title, and skips missing airports", () => {
    expect(approachAircraftKey(fact({ aircraftIcaoType: " ", aircraftTitle: "Cessna" }))).toBe("Cessna");
    expect(approachAircraftKey(fact({ aircraftIcaoType: null }))).toBe("Unbekannt");
    const facts = [fact({ airportIcao: "EDDF" }), fact({ airportIcao: null }), fact({ airportIcao: "EDDF" }), fact({ airportIcao: "EDDM" })];
    expect(approachFilterOptions(facts, (f) => f.airportIcao)).toEqual([
      { key: "EDDF", count: 2 },
      { key: "EDDM", count: 1 },
    ]);
    expect(applyApproachFilter(facts, { aircraft: null, airport: "EDDF" }, 1)).toHaveLength(1);
  });
});

describe("niceHalfRange", () => {
  it("rounds up, keeps the minimum and caps", () => {
    expect(niceHalfRange([], 25, 5, 60)).toBe(25);
    expect(niceHalfRange([-31, 12], 25, 5, 60)).toBe(35);
    expect(niceHalfRange([400], 25, 5, 60)).toBe(60);
  });
});

describe("lateralAt", () => {
  it("is not measurable against a runway derived from the own track", () => {
    expect(lateralAt(fact({ g500LatDevM: 4 }), "ft500")).toBe(4);
    expect(lateralAt(fact({ g500LatDevM: 4, runwaySource: "user" }), "ft500")).toBe(4);
    expect(lateralAt(fact({ g500LatDevM: 4, runwaySource: "derived" }), "ft500")).toBeNull();
    expect(lateralAt(fact({ g1000LatDevM: 4, runwaySource: "databaseDerived" }), "ft1000")).toBeNull();
  });
});
