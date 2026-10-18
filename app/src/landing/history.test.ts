import { describe, expect, it } from "vitest";
import { NNBSP } from "../format";
import type { TouchdownReport } from "../types";
import type { ApproachFact } from "./approachTypes";
import {
  approachFor,
  betterText,
  bucketOf,
  compareApproach,
  compareLanding,
  defaultScope,
  demoFilter,
  landingFor,
  median,
  monthCompare,
  patternSeries,
  peersPhrase,
  percentileBetter,
  quartiles,
  quota,
  scopeOpts,
  trendSeries,
  type HistLanding,
} from "./history";

const T0 = Date.UTC(2026, 9, 1, 12); // 1 Oct 2026

function lf(p: Partial<HistLanding>): HistLanding {
  return {
    flightId: "f",
    touchdownIndex: 0,
    timestampMs: T0,
    airportIcao: "EDDF",
    runwayIdent: "25C",
    aircraftIcaoType: "A20N",
    aircraftTitle: null,
    registration: null,
    landingRateFpm: -150,
    landingRateSource: "sim",
    peakG: 1.2,
    bounces: 0,
    touchdownDistanceM: 400,
    centerlineOffsetM: 1,
    inTouchdownZone: true,
    provider: "simconnect",
    ...p,
  };
}

function af(p: Partial<ApproachFact>): ApproachFact {
  return {
    flightId: "f",
    approachIndex: 0,
    version: 1,
    computedMs: 0,
    outcome: "landed",
    touchdownIndex: 0,
    airportIcao: "EDDF",
    runwayIdent: "25C",
    endedMs: T0,
    establishedNm: null,
    establishedHatFt: null,
    stableFromFt: 1000,
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
    g1000Pass: true,
    g500AltDevFt: null,
    g500IasDevKt: null,
    g500LatDevM: null,
    g500VsFpm: null,
    g500Pass: true,
    gpRmsFt: null,
    latRmsM: null,
    iasMadKt: null,
    vsSdFpm: null,
    gaLowestHatFt: null,
    detailJson: null,
    band: "stable",
    elevationSource: null,
    exceeded: [],
    exceedancesBelow500: 0,
    vappPlausible: null,
    thresholdHeightFt: null,
    goAroundDetectedBy: null,
    aircraftIcaoType: "A20N",
    aircraftTitle: null,
    registration: null,
    provider: "simconnect",
    ...p,
  };
}

function td(p: Partial<TouchdownReport>): TouchdownReport {
  return {
    timestampMs: T0,
    vsFpmMeasured: -100,
    vsFpmSim: -100,
    vsFpmHardest: -100,
    peakG: 1.1,
    pitchDeg: 3,
    bankDeg: 0,
    groundSpeedKt: 120,
    headingTrueDeg: 250,
    latitude: 50,
    longitude: 8.5,
    bounces: 0,
    touchAndGo: false,
    landingRateFpm: -100,
    landingRateSource: "sim",
    ...p,
  };
}

describe("statistics", () => {
  it("median and quartiles skip null / NaN", () => {
    expect(median([3, null, 1, undefined, Number.NaN, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([null, null])).toBeNull();
    const q = quartiles([1, 2, 3, 4, 5]);
    expect(q).toEqual({ median: 3, q1: 2, q3: 4, n: 5 });
  });

  it("percentile counts strictly worse peers, ties half", () => {
    // |fpm| lower is better: 155 beats 180, 200, 300 out of 4 peers (100 is better)
    expect(percentileBetter(155, [100, 180, 200, 300], true)).toBe(0.75);
    expect(percentileBetter(200, [200, 300], true)).toBe(0.75);
    // higher is better ("stabil ab")
    expect(percentileBetter(1000, [500, 800, 1200], false)).toBeCloseTo(2 / 3);
    expect(percentileBetter(null, [1, 2], true)).toBeNull();
    expect(percentileBetter(1, [null], true)).toBeNull();
  });

  it("quota ignores null", () => {
    expect(quota([true, false, null, true])).toEqual({ yes: 2, total: 3, rate: 2 / 3 });
    expect(quota([]).rate).toBeNull();
  });
});

describe("compareLanding", () => {
  const facts = [
    lf({ flightId: "a", landingRateFpm: -100, timestampMs: T0 + 5 }),
    lf({ flightId: "b", landingRateFpm: -180, timestampMs: T0 + 4, inTouchdownZone: false }),
    lf({ flightId: "c", landingRateFpm: -200, timestampMs: T0 + 3, centerlineOffsetM: null }),
    lf({ flightId: "d", landingRateFpm: -300, timestampMs: T0 + 2, runwayIdent: "07L", centerlineOffsetM: -4 }),
    lf({ flightId: "e", landingRateFpm: -400, timestampMs: T0 + 1, aircraftIcaoType: "B738" }),
  ];
  const me = lf({ flightId: "me", landingRateFpm: -155, timestampMs: T0 + 6, centerlineOffsetM: -2 });
  const all = [me, ...facts];

  it("compares |fpm| against the same runway, excluding itself", () => {
    const c = compareLanding(me, all, { sameRunway: true });
    expect(c.n).toBe(4);
    expect(c.rate.median).toBe(-190);
    // beats 180, 200, 400 of 100/180/200/400
    expect(c.rate.better).toBe(0.75);
    expect(c.tdz).toEqual({ current: true, yes: 3, total: 4, rate: 0.75 });
  });

  it("is null-safe for the centreline", () => {
    const c = compareLanding(me, all, { sameRunway: true });
    // peers |cl|: 1, 1, (null), 1 → n 3; me 2 → worse than all
    expect(c.centerline.n).toBe(3);
    expect(c.centerline.median).toBe(1);
    expect(c.centerline.value).toBe(2);
    expect(c.centerline.better).toBe(0);
    const none = compareLanding(lf({ flightId: "x", centerlineOffsetM: null }), all);
    expect(none.centerline.value).toBeNull();
    expect(none.centerline.better).toBeNull();
  });

  it("filters by type and limits to the newest peers", () => {
    expect(compareLanding(me, all, { sameType: true }).n).toBe(4);
    const lim = compareLanding(me, all, { limit: 2 });
    expect(lim.peers.map((p) => p.flightId)).toEqual(["a", "b"]);
    expect(lim.distance.better).toBeNull();
    expect(lim.distance.delta).toBe(0);
  });

  it("picks the first scope with enough peers", () => {
    const lonely = lf({ flightId: "z", runwayIdent: "18" });
    expect(defaultScope(me, all)).toBe("runway");
    expect(defaultScope(lonely, all)).toBe("type");
    expect(defaultScope(lf({ flightId: "q", runwayIdent: "18", aircraftIcaoType: "C172" }), all)).toBe("all");
    expect(compareLanding(me, all, scopeOpts("all")).n).toBe(5);
  });
});

describe("compareApproach", () => {
  const afacts = [
    af({ flightId: "a", stableFromFt: 1500, endedMs: T0 + 3 }),
    af({ flightId: "b", stableFromFt: 800, endedMs: T0 + 2, g500Pass: false }),
    af({ flightId: "c", stableFromFt: null, endedMs: T0 + 1, g1000Pass: null }),
    af({ flightId: "d", band: null, stableFromFt: null }), // never assessed: left out
  ];

  it("median over stable approaches, never-stable ranks lowest", () => {
    const me = af({ flightId: "me", stableFromFt: 1000 });
    const c = compareApproach(me, [me, ...afacts]);
    expect(c.n).toBe(3);
    expect(c.stableFrom.median).toBe(1150);
    expect(c.neverStable).toBe(1);
    // beats 800 and the never-stable one
    expect(c.stableFrom.better).toBeCloseTo(2 / 3);
    expect(c.gate1000).toEqual({ current: true, yes: 2, total: 2, rate: 1 });
    expect(c.gate500.rate).toBeCloseTo(2 / 3);
    const never = compareApproach(af({ flightId: "n", stableFromFt: null }), afacts);
    expect(never.stableFrom.value).toBeNull();
    expect(never.stableFrom.better).toBeCloseTo(1 / 6);
  });

  it("finds the approach of a landing", () => {
    const list = [
      af({ flightId: "p", approachIndex: 0, outcome: "touch_and_go", touchdownIndex: 0 }),
      af({ flightId: "p", approachIndex: 1, outcome: "landed", touchdownIndex: 1 }),
      af({ flightId: "p", approachIndex: 2, outcome: "go_around", touchdownIndex: null }),
    ];
    expect(approachFor(list, "p", 0)?.approachIndex).toBe(0);
    expect(approachFor(list, "p")?.approachIndex).toBe(1);
    expect(approachFor(list, "p", null, 2)?.approachIndex).toBe(2);
    expect(approachFor(list, "x")).toBeNull();
  });
});

describe("landingFor / demoFilter", () => {
  it("defaults to the flight's last touchdown with a fact", () => {
    const list = [lf({ flightId: "p", touchdownIndex: 2 }), lf({ flightId: "p", touchdownIndex: 5 })];
    expect(landingFor(list, "p")?.touchdownIndex).toBe(5);
    expect(landingFor(list, "p", 2)?.touchdownIndex).toBe(2);
    expect(landingFor(list, "p", 3)).toBeNull();
  });

  it("keeps demo peers only for a demo landing or when shown", () => {
    const list = [lf({ provider: "mock" }), lf({ provider: "simconnect" })];
    expect(demoFilter(list, lf({ provider: "simconnect" }), false)).toHaveLength(1);
    expect(demoFilter(list, lf({ provider: "mock" }), false)).toHaveLength(2);
    expect(demoFilter(list, null, true)).toHaveLength(2);
  });
});

describe("trendSeries", () => {
  it("per landing: oldest first with a moving median", () => {
    const facts = [-500, -100, -300, -200].map((r, i) => lf({ flightId: `f${i}`, landingRateFpm: r, timestampMs: T0 + (4 - i) * 1000 }));
    const s = trendSeries(facts, "flight", { window: 3 });
    expect(s.rate.map((p) => p.value)).toEqual([200, 300, 100, 500]);
    expect(s.rate.map((p) => p.rolling)).toEqual([200, 250, 200, 300]);
    expect(s.tdz.every((p) => p.value === 1)).toBe(true);
  });

  it("per month: median and TDZ quota per bucket, null-safe", () => {
    const sep = Date.UTC(2026, 8, 10);
    const facts = [
      lf({ flightId: "a", timestampMs: sep, landingRateFpm: -100, inTouchdownZone: false, centerlineOffsetM: null }),
      lf({ flightId: "b", timestampMs: sep + 1, landingRateFpm: -300, inTouchdownZone: true, centerlineOffsetM: null }),
      lf({ flightId: "c", timestampMs: T0, landingRateFpm: -200 }),
    ];
    const s = trendSeries(facts, "month", { approaches: [af({ endedMs: sep, stableFromFt: null }), af({ endedMs: T0, stableFromFt: 900 })] });
    expect(s.rate.map((p) => [p.key, p.value, p.n])).toEqual([
      ["2026-09", 200, 2],
      ["2026-10", 200, 1],
    ]);
    expect(s.tdz.map((p) => p.value)).toEqual([0.5, 1]);
    expect(s.tdz[1].rolling).toBe(0.75);
    expect(s.centerline.map((p) => p.value)).toEqual([null, 1]);
    expect(s.stableFrom.map((p) => p.value)).toEqual([null, 900]);
  });

  it("ISO weeks start on Monday", () => {
    // Sunday 18 Oct 2026 belongs to week 42, which started on Monday 12 Oct
    const b = bucketOf(Date.UTC(2026, 9, 18, 23), "week");
    expect(b.key).toBe("2026-W42");
    expect(b.startMs).toBe(Date.UTC(2026, 9, 12));
    expect(bucketOf(Date.UTC(2027, 0, 1), "week").key).toBe("2026-W53");
  });

  it("this month vs. the previous one", () => {
    const now = Date.UTC(2026, 9, 18);
    const facts = [lf({ timestampMs: Date.UTC(2026, 9, 2), landingRateFpm: -120 }), lf({ timestampMs: Date.UTC(2026, 8, 2), landingRateFpm: -240, inTouchdownZone: false })];
    const m = monthCompare(facts, [], now);
    expect(m.current).toMatchObject({ key: "2026-10", n: 1, rate: 120, tdzRate: 1, stableFrom: null });
    expect(m.previous).toMatchObject({ key: "2026-09", n: 1, rate: 240, tdzRate: 0 });
  });
});

describe("patternSeries", () => {
  it("joins touchdown reports with the full-stop fact", () => {
    const tds = [
      td({ touchAndGo: true, landingRateFpm: -220, timestampMs: T0 }),
      td({ touchAndGo: true, landingRateFpm: -90, bounces: 1, timestampMs: T0 + 1 }),
      td({ touchAndGo: false, landingRateFpm: -160, timestampMs: T0 + 2 }),
    ];
    const facts = [lf({ flightId: "p", touchdownIndex: 2, touchdownDistanceM: 450, centerlineOffsetM: null }), lf({ flightId: "other", touchdownIndex: 0 })];
    const approaches = [af({ flightId: "p", touchdownIndex: 0, outcome: "touch_and_go", stableFromFt: 600 })];
    const s = patternSeries(tds, facts, "p", approaches);
    expect(s.touchAndGos).toBe(2);
    expect(s.fullStops).toBe(1);
    expect(s.medianRateFpm).toBe(-160);
    expect(s.bestIndex).toBe(1);
    expect(s.rows[0]).toMatchObject({ distanceM: null, stableFromFt: 600, runway: "EDDF 25C" });
    expect(s.rows[2]).toMatchObject({ distanceM: 450, centerlineOffsetM: null, inTdz: true });
  });
});

describe("wording", () => {
  it("phrases the comparison", () => {
    expect(betterText(0.7)).toBe(`besser als 70${NNBSP}%`);
    expect(betterText(1)).toBe("besser als jede");
    expect(betterText(null)).toBeNull();
    expect(peersPhrase(20, "runway", lf({}))).toBe("deiner letzten 20 Landungen auf EDDF 25C");
    expect(peersPhrase(5, "all", lf({}))).toBe("deiner letzten 5 Landungen");
  });
});
