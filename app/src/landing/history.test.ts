import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NNBSP } from "../format";
import { setLanguageSetting } from "../i18n";
import type { FlightMetricsFact, TouchdownReport } from "../types";
import type { ApproachFact } from "./approachTypes";
import {
  approachFor,
  betterText,
  bucketOf,
  compareApproach,
  compareFlightMetric,
  compareGate500,
  compareLanding,
  defaultScope,
  demoFilter,
  flightMetricLines,
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
  typeKey,
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
    // lateral RMS only where measurable (known centreline)
    const l = trendSeries(facts, "month", {
      approaches: [
        af({ endedMs: sep, stableFromFt: 1000, locRmsDots: 0.2 }),
        af({ endedMs: sep + 1, approachIndex: 1, stableFromFt: 1000, locRmsDots: 0.4 }),
        af({ endedMs: T0, stableFromFt: 900, locRmsDots: 0.9, runwaySource: "derived" }),
        af({ endedMs: T0, approachIndex: 2, stableFromFt: 900, locRmsDots: null }),
      ],
    });
    expect(l.lateral.map((p) => [p.key, p.n])).toEqual([["2026-09", 2]]);
    expect(l.lateral[0].value).toBeCloseTo(0.3);
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
  // jsdom reports en-US: pin the reference language, the en case switches explicitly
  beforeEach(() => setLanguageSetting("de"));
  afterEach(() => setLanguageSetting("de"));

  it("phrases the comparison", () => {
    expect(betterText(0.7)).toBe(`besser als 70${NNBSP}%`);
    expect(betterText(1)).toBe("besser als jede");
    expect(betterText(null)).toBeNull();
    expect(peersPhrase(20, "runway", lf({}))).toBe("deiner letzten 20 Landungen auf EDDF 25C");
    expect(peersPhrase(5, "all", lf({}))).toBe("deiner letzten 5 Landungen");
    expect(peersPhrase(1, "type", lf({}))).toBe("deiner letzten 1 Landung mit A20N");
    expect(typeKey({ aircraftIcaoType: null, aircraftTitle: " " })).toBe("Unbekannt");
  });

  it("phrases the comparison in English", () => {
    setLanguageSetting("en");
    expect(betterText(0.7)).toBe(`better than 70${NNBSP}%`);
    expect(betterText(1)).toBe("better than all");
    expect(peersPhrase(20, "runway", lf({}))).toBe("your last 20 landings on EDDF 25C");
    expect(peersPhrase(1, "type", lf({}))).toBe("your last 1 landing in the A20N");
    expect(peersPhrase(5, "runway", lf({ runwayIdent: "" }))).toBe("your last 5 landings on this runway");
    expect(typeKey({ aircraftIcaoType: null, aircraftTitle: null })).toBe("Unknown");
  });
});

// ---- per-flight metrics -------------------------------------------------------------------

function mf(p: Partial<FlightMetricsFact>): FlightMetricsFact {
  return {
    flightId: "m",
    timestampMs: T0,
    aircraftIcaoType: "A20N",
    aircraftTitle: null,
    provider: "simconnect",
    version: 1,
    computedMs: 0,
    airportIcao: "EDDF",
    runwayIdent: "25C",
    rotationRateDegS: null,
    rotationPeakDegS: null,
    rotationDurationS: null,
    gearDownAglFt: null,
    gearDownDistNm: null,
    landingFlapsAglFt: null,
    exceedances: null,
    stable1000: null,
    stable500: null,
    ...p,
  };
}

describe("flight metrics comparison", () => {
  // current flight on EDDF 25C in an A20N; two more on the runway, three more of the type elsewhere
  const cur = mf({ flightId: "cur", timestampMs: T0 + 10, rotationRateDegS: 2.3, gearDownAglFt: 1850, gearDownDistNm: 5.8, landingFlapsAglFt: 1200, exceedances: 2, stable1000: true, stable500: false });
  const peers = [
    mf({ flightId: "r1", rotationRateDegS: 2.5, gearDownAglFt: 2000, gearDownDistNm: 6, landingFlapsAglFt: 1500, exceedances: 0, stable500: true }),
    mf({ flightId: "r2", rotationRateDegS: 2.7, gearDownAglFt: 2200, gearDownDistNm: 7, landingFlapsAglFt: 1500, exceedances: 1, stable500: true }),
    mf({ flightId: "t1", airportIcao: "EDDM", runwayIdent: "26R", rotationRateDegS: 2.6, gearDownAglFt: 2100, gearDownDistNm: 6.5, landingFlapsAglFt: 1400, exceedances: 1, stable500: false }),
    mf({ flightId: "t2", airportIcao: "EDDM", runwayIdent: "26R", rotationRateDegS: 2.6, gearDownAglFt: null, landingFlapsAglFt: 1600, exceedances: 2, stable500: true }),
    mf({ flightId: "o1", aircraftIcaoType: "B738", airportIcao: "EDDM", runwayIdent: "26R", rotationRateDegS: 3.5, gearDownAglFt: 3000, exceedances: 5, stable500: true }),
  ];
  const all = [cur, ...peers];

  it("median like the landing rate, the current flight left out", () => {
    const r = compareFlightMetric(cur, all, (f) => f.rotationRateDegS, "type")!;
    expect([r.scope, r.n, r.value]).toEqual(["type", 4, 2.3]);
    expect(r.median).toBeCloseTo(2.6);
    expect(r.delta).toBeCloseTo(-0.3);
  });

  it("widens runway → type → all until MIN_PEERS values exist", () => {
    // only two other flights on EDDF 25C: the type is used
    expect(compareFlightMetric(cur, all, (f) => f.rotationRateDegS, "runway")!.scope).toBe("type");
    // gear: only three of the type have a value – still the type; without o1's type all
    const gear = compareFlightMetric(cur, all, (f) => f.gearDownAglFt, "runway")!;
    expect([gear.scope, gear.n, gear.median]).toEqual(["type", 3, 2100]);
    const few = [cur, peers[0], peers[4]];
    expect(compareFlightMetric(cur, few, (f) => f.gearDownAglFt, "runway")).toBeNull();
    expect(compareFlightMetric(mf({ gearDownAglFt: null }), all, (f) => f.gearDownAglFt, "all")).toBeNull();
  });

  it("500 ft gate as a quota", () => {
    expect(compareGate500(cur, all, "type")).toMatchObject({ current: false, yes: 3, total: 4, scope: "type" });
    expect(compareGate500(mf({ stable500: null }), all, "all")).toBeNull();
  });

  it("sentences in English and German", () => {
    setLanguageSetting("en");
    const lines = flightMetricLines(cur, all, "type");
    expect(lines.map((l) => l.id)).toEqual(["rotation", "gearDown", "landingFlaps", "exceedances", "gates"]);
    const text = (id: string) => lines.find((l) => l.id === id)!.text.replace(new RegExp(NNBSP, "g"), " ");
    expect(text("rotation")).toBe("Rotation 2.3 °/s – your median in the A20N is 2.6 °/s (4 flights)");
    expect(text("gearDown")).toBe("Gear down at 1,850 ft AGL / 5.8 nm – your median in the A20N is 2,100 ft / 6.5 nm (3 flights)");
    expect(text("landingFlaps")).toBe("Landing flaps set at 1,200 ft AGL – your median in the A20N is 1,500 ft (4 flights)");
    expect(text("exceedances")).toBe("2 exceedances on final – your median in the A20N is 1 (4 flights)");
    expect(text("gates")).toBe("Gates 1000 ft stable, 500 ft unstable – stable at 500 ft in 3 of 4 flights in the A20N");
    expect(lines.find((l) => l.id === "gates")!.warn).toBe(true);
    // all flights: no scope phrase
    expect(flightMetricLines(cur, all, "all")[0].text.replace(new RegExp(NNBSP, "g"), " ")).toBe("Rotation 2.3 °/s – your median is 2.6 °/s (5 flights)");
    setLanguageSetting("de");
    const de = flightMetricLines(cur, all, "type").map((l) => l.text.replace(new RegExp(NNBSP, "g"), " "));
    expect(de[0]).toBe("Rotation 2,3 °/s – dein Median mit A20N: 2,6 °/s (4 Flüge)");
    expect(de[3]).toBe("2 Überschreitungen im Endanflug – dein Median mit A20N: 1 (4 Flüge)");
    setLanguageSetting("en");
  });

  it("a rotation outside the band is flagged with the shared band word", () => {
    setLanguageSetting("en");
    const slow = mf({ flightId: "slow", timestampMs: T0 + 10, rotationRateDegS: 1.2 });
    const l = flightMetricLines(slow, [slow, ...peers], "all")[0];
    expect(l.warn).toBe(true);
    expect(l.text).toContain("· slow");
  });

  it("trend series per flight, flights without the value left out", () => {
    const tr = trendSeries([], "flight", { metrics: all });
    expect(tr.rotation.map((p) => p.value)).toHaveLength(6);
    expect(tr.gearDown.map((p) => p.value)).toHaveLength(5);
    expect(tr.exceedances.map((p) => p.value)).toEqual([0, 1, 1, 2, 5, 2]);
  });
});

describe("assessment profiles keep comparisons apart", () => {
  it("compares an approach only with approaches of the same profile (missing = generic)", () => {
    const peers = [
      af({ flightId: "g1", stableFromFt: 1500, endedMs: T0 + 3 }),
      af({ flightId: "g2", stableFromFt: 1000, endedMs: T0 + 2, profileId: "generic" }),
      af({ flightId: "a1", stableFromFt: 500, endedMs: T0 + 1, profileId: "airbus" }),
      af({ flightId: "a2", stableFromFt: 600, endedMs: T0, profileId: "airbus" }),
    ];
    const generic = compareApproach(af({ flightId: "me", stableFromFt: 1200 }), peers);
    expect(generic.peers.map((p) => p.flightId)).toEqual(["g1", "g2"]);
    const airbus = compareApproach(af({ flightId: "me", stableFromFt: 1200, profileId: "airbus" }), peers);
    expect(airbus.peers.map((p) => p.flightId)).toEqual(["a1", "a2"]);
    expect(airbus.stableFrom.median).toBe(550);
  });

  it("exceedances and gates only against flights of the same profile; rotation against all", () => {
    const cur = mf({ flightId: "cur", rotationRateDegS: 2.4, exceedances: 2, stable500: false, approachProfile: "ga_piston" });
    const peers = [
      mf({ flightId: "g1", rotationRateDegS: 2.5, exceedances: 0, stable500: true }),
      mf({ flightId: "g2", rotationRateDegS: 2.6, exceedances: 0, stable500: true }),
      mf({ flightId: "g3", rotationRateDegS: 2.7, exceedances: 1, stable500: true }),
      mf({ flightId: "p1", rotationRateDegS: 2.2, exceedances: 3, stable500: false, approachProfile: "ga_piston" }),
      mf({ flightId: "p2", rotationRateDegS: 2.1, exceedances: 4, stable500: false, approachProfile: "ga_piston" }),
      mf({ flightId: "p3", rotationRateDegS: 2.0, exceedances: 5, stable500: true, approachProfile: "ga_piston" }),
    ];
    const all = [cur, ...peers];
    expect(compareFlightMetric(cur, all, (f) => f.rotationRateDegS, "all")!.n).toBe(6);
    const exc = compareFlightMetric(cur, all, (f) => f.exceedances, "all", 20, true)!;
    expect([exc.n, exc.median]).toEqual([3, 4]);
    expect(compareGate500(cur, all, "all")).toMatchObject({ yes: 1, total: 3 });
    expect(compareGate500(cur, all.slice(0, 4), "all")).toBeNull();
  });

  it("trend series of one profile", () => {
    const landings = [lf({ flightId: "x", timestampMs: T0 })];
    const approaches = [
      af({ flightId: "x", stableFromFt: 1000, endedMs: T0 }),
      af({ flightId: "y", approachIndex: 0, stableFromFt: 400, endedMs: T0 + 1, profileId: "ga_piston" }),
    ];
    const metrics = [mf({ flightId: "x", exceedances: 1 }), mf({ flightId: "y", timestampMs: T0 + 1, exceedances: 6, approachProfile: "ga_piston" })];
    const g = trendSeries(landings, "flight", { approaches, metrics, profile: "generic" });
    expect(g.stableFrom.map((p) => p.value)).toEqual([1000]);
    expect(g.exceedances.map((p) => p.value)).toEqual([1]);
    const p = trendSeries(landings, "flight", { approaches, metrics, profile: "ga_piston" });
    expect(p.stableFrom.map((x) => x.value)).toEqual([400]);
    expect(p.exceedances.map((x) => x.value)).toEqual([6]);
  });
});
