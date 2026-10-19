import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LandingFact } from "../types";
import { setLanguageSetting } from "../i18n";
import {
  aircraftKey,
  applyFilter,
  covariance,
  dispersionStats,
  distanceText,
  ellipseInput,
  ellipsePoints,
  filterOptions,
  lateralText,
  linear,
  mean,
  sigmaEllipse,
  stdDev,
  tdzRate,
} from "./dispersionStats";

// jsdom reports en-US: pin the reference language (the en case switches explicitly)
beforeEach(() => setLanguageSetting("de"));
afterEach(() => setLanguageSetting("de"));

function fact(p: Partial<LandingFact>): LandingFact {
  return {
    flightId: "f",
    touchdownIndex: 0,
    timestampMs: 0,
    airportIcao: "EDDF",
    runwayIdent: "25C",
    aircraftIcaoType: "A20N",
    aircraftTitle: "Airbus A320neo",
    registration: null,
    landingRateFpm: -200,
    landingRateSource: "sim",
    peakG: 1.1,
    bounces: 0,
    touchdownDistanceM: 400,
    centerlineOffsetM: 0,
    inTouchdownZone: true,
    provider: "msfs",
    ...p,
  };
}

describe("mean / stdDev", () => {
  it("handles empty and single inputs", () => {
    expect(mean([])).toBeNull();
    expect(stdDev([])).toBeNull();
    expect(stdDev([5])).toBe(0);
  });
  it("uses the sample standard deviation", () => {
    expect(mean([2, 4, 4, 4, 5, 5, 7, 9])).toBe(5);
    // population sd is 2, sample sd sqrt(32/7)
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 10);
  });
});

describe("covariance / sigmaEllipse", () => {
  it("needs two points", () => {
    expect(covariance([{ x: 1, y: 1 }])).toBeNull();
    expect(sigmaEllipse([{ x: 1, y: 1 }])).toBeNull();
  });

  it("is axis-aligned for uncorrelated spread", () => {
    const pts = [
      { x: -10, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: -2 },
      { x: 0, y: 2 },
    ];
    const c = covariance(pts)!;
    expect(c.sxy).toBeCloseTo(0, 12);
    const e = sigmaEllipse(pts)!;
    expect(e.cx).toBe(0);
    expect(e.cy).toBe(0);
    expect(e.rx).toBeCloseTo(Math.sqrt(200 / 3), 10);
    expect(e.ry).toBeCloseTo(Math.sqrt(8 / 3), 10);
    expect(e.angle).toBeCloseTo(0, 12);
  });

  it("follows a correlated spread", () => {
    const pts = [0, 1, 2, 3, 4].map((v) => ({ x: v, y: v }));
    const e = sigmaEllipse(pts)!;
    expect(e.angle).toBeCloseTo(Math.PI / 4, 10);
    expect(e.ry).toBeCloseTo(0, 6);
    // variance along the diagonal: 2 * var(x)
    expect(e.rx).toBeCloseTo(Math.sqrt(2 * 2.5), 10);
    expect(e.cx).toBe(2);
  });

  it("outline points lie on the ellipse", () => {
    const e = { cx: 100, cy: 2, rx: 50, ry: 3, angle: 0.3 };
    for (const p of ellipsePoints(e, 16)) {
      const dx = p.x - e.cx;
      const dy = p.y - e.cy;
      const u = dx * Math.cos(e.angle) + dy * Math.sin(e.angle);
      const v = -dx * Math.sin(e.angle) + dy * Math.cos(e.angle);
      expect((u / e.rx) ** 2 + (v / e.ry) ** 2).toBeCloseTo(1, 10);
    }
  });
});

describe("dispersionStats / tdzRate", () => {
  it("counts the touchdown zone and averages distance and |offset|", () => {
    const facts = [
      fact({ touchdownDistanceM: 300, centerlineOffsetM: -2, inTouchdownZone: true }),
      fact({ touchdownDistanceM: 500, centerlineOffsetM: 4, inTouchdownZone: true }),
      fact({ touchdownDistanceM: 1000, centerlineOffsetM: 0, inTouchdownZone: false }),
    ];
    expect(tdzRate(facts)).toEqual({ inZone: 2, total: 3, rate: 2 / 3 });
    const s = dispersionStats(facts);
    expect(s.count).toBe(3);
    expect(s.inTdz).toBe(2);
    expect(s.meanDistM).toBeCloseTo(600, 10);
    expect(s.sdDistM).toBeCloseTo(Math.sqrt((300 ** 2 + 100 ** 2 + 400 ** 2) / 2), 10);
    expect(s.meanOffsetM).toBeCloseTo(2 / 3, 10);
    expect(s.meanAbsOffsetM).toBe(2);
  });

  it("is empty without landings", () => {
    expect(tdzRate([]).rate).toBeNull();
    const s = dispersionStats([]);
    expect(s.meanDistM).toBeNull();
    expect(s.tdzRate).toBeNull();
  });
});

describe("filters", () => {
  const facts = [
    fact({ aircraftIcaoType: "A20N", airportIcao: "EDDF" }),
    fact({ aircraftIcaoType: "B738", airportIcao: "EDDM" }),
    fact({ aircraftIcaoType: "A20N", airportIcao: "EDDM" }),
    fact({ aircraftIcaoType: null, aircraftTitle: "  ", airportIcao: "EDDM" }),
  ];

  it("falls back to title and Unbekannt for the aircraft", () => {
    expect(aircraftKey(fact({ aircraftIcaoType: null, aircraftTitle: "Cessna 172" }))).toBe("Cessna 172");
    expect(aircraftKey(facts[3])).toBe("Unbekannt");
  });

  it("lists options by frequency", () => {
    expect(filterOptions(facts, (f) => f.airportIcao)).toEqual([
      { key: "EDDM", count: 3 },
      { key: "EDDF", count: 1 },
    ]);
    expect(filterOptions(facts, aircraftKey).map((o) => o.key)).toEqual(["A20N", "B738", "Unbekannt"]);
  });

  it("combines both filters and applies the limit afterwards", () => {
    expect(applyFilter(facts, { aircraft: "A20N", airport: "EDDM" }, 20)).toEqual([facts[2]]);
    expect(applyFilter(facts, { aircraft: null, airport: "EDDM" }, 2)).toEqual([facts[1], facts[2]]);
    expect(applyFilter(facts, { aircraft: null, airport: null }, 20)).toHaveLength(4);
  });
});

describe("linear", () => {
  it("maps a domain onto a range", () => {
    const f = linear(-200, 3000, 40, 680);
    expect(f(-200)).toBe(40);
    expect(f(3000)).toBe(680);
    expect(f(1400)).toBe(360);
  });
});

describe("landings without measurable lateral offset (derived runway)", () => {
  const derived = { ...fact({ touchdownDistanceM: 380 }), centerlineOffsetM: null, touchdownDistanceUncertaintyM: 50, runwaySource: "derived" as const };

  it("are left out of the centreline mean and the ellipse, not of the distance", () => {
    const s = dispersionStats([fact({ centerlineOffsetM: -4 }), fact({ centerlineOffsetM: 2 }), derived]);
    expect(s.count).toBe(3);
    expect(s.lateralCount).toBe(2);
    expect(s.meanOffsetM).toBeCloseTo(-1);
    expect(s.meanAbsOffsetM).toBeCloseTo(3);
    expect(s.meanDistM).toBeCloseTo((400 + 400 + 380) / 3);
    expect(ellipseInput([fact({}), derived])).toEqual([{ x: 400, y: 0 }]);
    expect(dispersionStats([derived]).meanAbsOffsetM).toBeNull();
  });

  it("say so in text", () => {
    expect(lateralText(derived)).toBe("Querablage nicht messbar");
    expect(distanceText(derived).replace(/\u202f/g, " ")).toBe("380 ± 50 m");
    expect(distanceText(fact({})).replace(/\u202f/g, " ")).toBe("400 m");
  });

  it("say so in English", () => {
    setLanguageSetting("en");
    expect(lateralText(derived)).toBe("Lateral offset not measurable");
    expect(distanceText(fact({ touchdownDistanceM: 1250 })).replace(/\u202f/g, " ")).toBe("1,250 m");
    expect(aircraftKey(fact({ aircraftIcaoType: null, aircraftTitle: null }))).toBe("Unknown");
  });
});
