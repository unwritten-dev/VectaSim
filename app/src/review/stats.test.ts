import { describe, expect, it } from "vitest";
import type { FlightRow } from "../types";
import type { RunwayFact } from "../landing/types";
import type { ApproachFact } from "../landing/approachTypes";
import type { CountryVisit } from "../countries/countries";
import { EARTH_NM, FACTS_WINDOW, buildReview, flagStats, flightTimeMs, periodLabel, periodOf, typeOf, yearsWithFlights, type ReviewInput } from "./stats";

const H = 3_600_000;
const at = (iso: string) => Date.parse(iso);

let n = 0;
function flight(p: Partial<FlightRow> & { when: string; hours?: number }): FlightRow {
  const off = at(p.when);
  const hours = p.hours ?? 1;
  n += 1;
  const { when: _w, hours: _h, ...rest } = p;
  return {
    id: `f${n}`,
    state: "completed",
    phase: "parked" as FlightRow["phase"],
    createdMs: off,
    updatedMs: off,
    offBlockMs: off,
    takeoffMs: off + 0.1 * H,
    landingMs: off + (hours - 0.1) * H,
    onBlockMs: off + hours * H,
    maxAltMslFt: 30000,
    distanceNm: 300,
    aircraft: { title: "Airbus A320neo", atcModel: "TT:ATCCOM.AC_MODEL_A20N.0.text", atcType: "", atcId: "D-AINA", atcAirline: "", atcFlightNumber: "" },
    provider: "simconnect",
    depIcao: "EDDF",
    arrIcao: "EGLL",
    hasOfp: false,
    integrity: {} as FlightRow["integrity"],
    landingVsFpm: -150,
    landingCount: 1,
    ...rest,
  };
}

function fact(f: FlightRow, p: Partial<RunwayFact> = {}): RunwayFact {
  return {
    flightId: f.id,
    touchdownIndex: 0,
    timestampMs: f.landingMs as number,
    airportIcao: f.arrIcao ?? "",
    runwayIdent: "27L",
    landingRateFpm: f.landingVsFpm ?? -100,
    landingRateSource: "sim",
    peakG: 1.2,
    bounces: 0,
    touchdownDistanceM: 420,
    centerlineOffsetM: 1.5,
    inTouchdownZone: true,
    provider: f.provider,
    ...p,
  };
}

function approach(f: FlightRow, p: Partial<ApproachFact> = {}): ApproachFact {
  return {
    flightId: f.id,
    approachIndex: 0,
    outcome: "landed",
    endedMs: f.landingMs as number,
    band: "stable",
    stableFromFt: 1500,
    provider: f.provider ?? null,
    ...p,
  } as ApproachFact;
}

const input = (flights: FlightRow[], extra: Partial<ReviewInput> = {}): ReviewInput => ({ flights, landings: [], approaches: [], visits: [], showDemo: false, ...extra });
const Y2026 = periodOf("year", 2026, at("2026-10-18T12:00:00Z"), false);

describe("periodOf", () => {
  it("calendar year: 1 Jan to 1 Jan, 12 months", () => {
    expect(Y2026.startMs).toBe(at("2026-01-01T00:00:00Z"));
    expect(Y2026.endMs).toBe(at("2027-01-01T00:00:00Z"));
    expect(Y2026.months.map((m) => m.key)[0]).toBe("2026-01");
    expect(periodLabel(Y2026)).toBe("2026");
  });

  it("last 12 months: the 12 calendar months up to and including the current one", () => {
    const p = periodOf("last12", 0, at("2026-10-18T12:00:00Z"), false);
    expect(p.startMs).toBe(at("2025-11-01T00:00:00Z"));
    expect(p.endMs).toBe(at("2026-11-01T00:00:00Z"));
    expect(p.months.map((m) => m.key)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(periodLabel(p, "de")).toBe("Nov 2025 – Okt 2026");
    expect(periodLabel(p, "en")).toBe("Nov 2025 – Oct 2026");
  });
});

describe("buildReview: totals", () => {
  it("counts flights, block hours, distance, airports and earth laps of the period only", () => {
    const fs = [
      flight({ when: "2026-03-01T08:00:00Z", hours: 2, distanceNm: 500 }),
      flight({ when: "2026-07-01T08:00:00Z", hours: 3, distanceNm: 1000, depIcao: "EGLL", arrIcao: "KJFK" }),
      flight({ when: "2025-12-31T23:00:00Z", hours: 5, distanceNm: 9999 }), // previous year
    ];
    const r = buildReview(input(fs), Y2026);
    expect(r.flights).toBe(2);
    expect(r.blockMs).toBe(5 * H);
    expect(r.distanceNm).toBe(1500);
    expect(r.airports).toBe(3);
    expect(r.earthLaps).toBeCloseTo(1500 / EARTH_NM);
  });

  it("calendar year vs. last 12 months pick different flights", () => {
    const fs = [flight({ when: "2025-11-15T08:00:00Z" }), flight({ when: "2026-02-01T08:00:00Z" }), flight({ when: "2025-10-30T08:00:00Z" })];
    expect(buildReview(input(fs), Y2026).flights).toBe(1);
    expect(buildReview(input(fs), periodOf("last12", 0, at("2026-10-18T12:00:00Z"), false)).flights).toBe(2);
  });

  it("leaves out demo flights (unless shown) and the flight in progress", () => {
    const fs = [flight({ when: "2026-05-01T08:00:00Z" }), flight({ when: "2026-05-02T08:00:00Z", provider: "mock" }), flight({ when: "2026-05-03T08:00:00Z", state: "active" })];
    expect(buildReview(input(fs), Y2026).flights).toBe(1);
    expect(buildReview(input(fs, { showDemo: true }), Y2026).flights).toBe(2);
  });

  it("uses the pilot's corrections for airports and falls back to air time without block times", () => {
    const f = flight({ when: "2026-05-01T08:00:00Z", userArrIcao: "EGKK", offBlockMs: null, onBlockMs: null });
    const r = buildReview(input([f]), Y2026);
    expect(r.routes[0]).toMatchObject({ dep: "EDDF", arr: "EGKK" });
    expect(r.blockMs).toBeCloseTo(0.8 * H);
    expect(flightTimeMs(f)).toBe(f.takeoffMs);
  });
});

describe("buildReview: routes and fleet", () => {
  it("top routes by flights, then hours; longest flight by distance; legs need coordinates", () => {
    const fs = [
      flight({ when: "2026-01-01T08:00:00Z", depIcao: "EDDF", arrIcao: "EGLL" }),
      flight({ when: "2026-01-02T08:00:00Z", depIcao: "EDDF", arrIcao: "EGLL" }),
      flight({ when: "2026-01-03T08:00:00Z", depIcao: "EGLL", arrIcao: "EDDF", hours: 4 }),
      flight({ when: "2026-01-04T08:00:00Z", depIcao: "EDDF", arrIcao: "FAOR", distanceNm: 4800, hours: 10 }),
    ];
    const coords = new Map<string, [number, number]>([
      ["EDDF", [8.57, 50.03]],
      ["EGLL", [-0.46, 51.47]],
    ]);
    const r = buildReview(input(fs, { coords }), Y2026);
    expect(r.routes.map((x) => `${x.dep}-${x.arr}:${x.flights}`)).toEqual(["EDDF-EGLL:2", "EDDF-FAOR:1", "EGLL-EDDF:1"]);
    expect(r.routeCount).toBe(3);
    expect(r.longest).toMatchObject({ dep: "EDDF", arr: "FAOR", distanceNm: 4800 });
    // both directions share one leg on the map, FAOR has no coordinates
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0].flights).toBe(3);
  });

  it("fleet by hours: ICAO type from the ATC model, registrations upper-cased", () => {
    const b738 = { title: "Boeing 737-800 TUI", atcModel: "B738", atcType: "", atcId: "d-atua", atcAirline: "", atcFlightNumber: "" };
    const fs = [flight({ when: "2026-01-01T08:00:00Z", hours: 1 }), flight({ when: "2026-01-02T08:00:00Z", hours: 1 }), flight({ when: "2026-01-03T08:00:00Z", hours: 5, aircraft: b738 })];
    const r = buildReview(input(fs), Y2026);
    expect(r.types.map((t) => [t.key, t.flights])).toEqual([
      ["B738", 1],
      ["A20N", 2],
    ]);
    expect(r.types[1].detail).toBe("Airbus A320neo");
    expect(r.registrations.map((x) => x.key)).toEqual(["D-ATUA", "D-AINA"]);
    expect(typeOf(flight({ when: "2026-01-01T00:00:00Z", aircraft: { ...b738, atcModel: "" } }))).toBe("Boeing 737-800 TUI");
  });
});

describe("buildReview: landings and approaches", () => {
  it("median, bands, best/hardest and TDZ from measured landings; imports never count", () => {
    const a = flight({ when: "2026-04-01T08:00:00Z", landingVsFpm: -90 });
    const b = flight({ when: "2026-04-02T08:00:00Z", landingVsFpm: -250 });
    const c = flight({ when: "2026-04-03T08:00:00Z", landingVsFpm: -650 });
    const imp = flight({ when: "2026-04-04T08:00:00Z", landingVsFpm: -40, provider: "import:volanta_import" });
    const noRunway = flight({ when: "2026-04-05T08:00:00Z", landingVsFpm: -400 });
    const r = buildReview(input([a, b, c, imp, noRunway], { landings: [fact(a), fact(b, { inTouchdownZone: false, centerlineOffsetM: null }), fact(c)] }), Y2026);
    const ld = r.landings;
    expect(ld.count).toBe(4);
    expect(ld.rateOnly).toBe(1);
    expect(ld.medianFpm).toBe((250 + 400) / 2);
    expect(ld.bands).toEqual({ smooth: 1, normal: 1, firm: 1, hard: 1 });
    expect(ld.best).toMatchObject({ fpm: -90, airport: "EGLL", runway: "27L" });
    expect(ld.hardest).toMatchObject({ fpm: -650 });
    expect(ld.points).toHaveLength(3);
    expect(ld.points[1].y).toBeNull();
    expect(ld.tdz).toMatchObject({ inZone: 2, total: 3 });
    // the import still counts as a flight
    expect(r.flights).toBe(5);
    expect(r.imported).toBe(1);
  });

  it("leaves out demo landings and facts outside the period", () => {
    const a = flight({ when: "2026-04-01T08:00:00Z", landingVsFpm: null });
    const demo = flight({ when: "2026-04-02T08:00:00Z", provider: "mock", landingVsFpm: null });
    const old = flight({ when: "2025-04-02T08:00:00Z", landingVsFpm: null });
    const r = buildReview(input([a, demo, old], { landings: [fact(a), fact(demo), fact(old)] }), Y2026);
    expect(r.landings.count).toBe(1);
  });

  it("flags a facts window that does not reach the period start", () => {
    const fs = Array.from({ length: 200 }, (_, i) => flight({ when: new Date(at("2026-09-01T00:00:00Z") + i * H * 3).toISOString(), landingVsFpm: null }));
    const r = buildReview(input(fs, { landings: fs.map((f) => fact(f)) }), Y2026);
    expect(r.landings.partial).toBe(true);
    expect(r.landings.points).toHaveLength(200);
  });

  it("approaches: stable share of the assessed, mean „stabil ab“, go-arounds; imports excluded", () => {
    const a = flight({ when: "2026-04-01T08:00:00Z" });
    const imp = flight({ when: "2026-04-02T08:00:00Z", provider: "import:generic" });
    const r = buildReview(
      input([a, imp], {
        approaches: [
          approach(a, { stableFromFt: 1000 }),
          approach(a, { approachIndex: 1, outcome: "go_around", band: "unstableBelow500", stableFromFt: null }),
          approach(a, { approachIndex: 2, band: "deviations", stableFromFt: 500 }),
          approach(a, { approachIndex: 3, band: null, stableFromFt: null }),
          approach(imp),
        ],
      }),
      Y2026,
    );
    const ap = r.approaches;
    expect(ap.count).toBe(4);
    expect(ap.assessed).toBe(3);
    expect(ap.stable).toBe(1);
    expect(ap.stableRate).toBeCloseTo(1 / 3);
    expect(ap.meanStableFromFt).toBe(750);
    expect(ap.goArounds).toBe(1);
    expect(ap.bands).toEqual({ stable: 1, deviations: 1, unstable: 1 });
  });
});

describe("buildReview: months and countries", () => {
  it("bars per month, busiest month and day", () => {
    const fs = [
      flight({ when: "2026-07-01T08:00:00Z" }),
      flight({ when: "2026-07-01T14:00:00Z", hours: 2 }),
      flight({ when: "2026-07-20T08:00:00Z" }),
      flight({ when: "2026-03-05T08:00:00Z", hours: 9 }),
    ];
    const r = buildReview(input(fs), Y2026);
    expect(r.months).toHaveLength(12);
    expect(r.months[6]).toMatchObject({ flights: 3, blockMs: 4 * H });
    expect(r.months[2].flights).toBe(1);
    expect(r.busiestMonth).toBe(6);
    expect(r.busiestDay).toMatchObject({ ms: at("2026-07-01T00:00:00Z"), flights: 2, blockMs: 3 * H });
  });

  it("countries of the period, new when never landed there before", () => {
    const before = flight({ when: "2025-05-01T08:00:00Z" });
    const a = flight({ when: "2026-05-01T08:00:00Z" });
    const b = flight({ when: "2026-05-02T08:00:00Z", arrIcao: "LFPG" });
    const visit = (iso2: string, ids: string[]): CountryVisit => ({ iso2, landings: ids.length, firstMs: 0, lastMs: 0, airports: [], flightIds: ids });
    const r = buildReview(input([before, a, b], { visits: [visit("GB", [a.id, before.id]), visit("FR", [b.id]), visit("US", ["gone"])] }), Y2026);
    expect(r.countries).toEqual([
      { iso2: "FR", flights: 1, isNew: true },
      { iso2: "GB", flights: 1, isNew: false },
    ]);
    expect(r.newCountries).toBe(1);
  });

  it("years with flights, newest first, demo by the setting", () => {
    const fs = [flight({ when: "2024-05-01T08:00:00Z" }), flight({ when: "2026-05-01T08:00:00Z" }), flight({ when: "2023-05-01T08:00:00Z", provider: "replay" })];
    expect(yearsWithFlights(fs, false, false)).toEqual([2026, 2024]);
    expect(yearsWithFlights(fs, true, false)).toEqual([2026, 2024, 2023]);
  });
});

describe("flags („Mit Sternchen“)", () => {
  const integ = (p: Partial<FlightRow["integrity"]>): FlightRow["integrity"] => ({
    pausedMs: 0,
    pauseCount: 0,
    slewDetected: false,
    timeAccelerationDetected: false,
    maxSimRate: 1,
    crashed: false,
    fuelIncreasedAirborne: false,
    ...p,
  });

  it("counts recorded flights with pause, time acceleration, slew or a position jump – each flight once", () => {
    const fs = [
      flight({ when: "2026-02-01T08:00:00Z", integrity: integ({}) }),
      flight({ when: "2026-02-02T08:00:00Z", integrity: integ({ pauseCount: 2, pausedMs: 30 * 60_000 }) }),
      flight({ when: "2026-02-03T08:00:00Z", integrity: integ({ pauseCount: 1, pausedMs: 15 * 60_000, timeAccelerationDetected: true, maxSimRate: 4 }) }),
      flight({ when: "2026-02-04T08:00:00Z", integrity: integ({ timeAccelerationDetected: true, maxSimRate: 16, slewDetected: true }) }),
      flight({ when: "2026-02-05T08:00:00Z", integrity: integ({ teleportDetected: true }) }),
      // crash and fuel are no asterisk here
      flight({ when: "2026-02-06T08:00:00Z", integrity: integ({ crashed: true, fuelIncreasedAirborne: true }) }),
    ];
    const r = buildReview(input(fs), Y2026);
    expect(r.flags).toEqual({ recorded: 6, flights: 4, paused: 2, pausedMs: 45 * 60_000, timeAccel: 2, maxSimRate: 16, slew: 1, teleport: 1 });
  });

  it("leaves out imports, demo flights (without the setting), other periods and missing flags", () => {
    const fs = [
      flight({ when: "2026-03-01T08:00:00Z", provider: "import:volanta_import", integrity: integ({ slewDetected: true }) }),
      flight({ when: "2026-03-02T08:00:00Z", provider: "mock", integrity: integ({ slewDetected: true }) }),
      flight({ when: "2025-03-02T08:00:00Z", integrity: integ({ slewDetected: true }) }),
      flight({ when: "2026-03-03T08:00:00Z" }), // integrity {} as in older rows
    ];
    const r = buildReview(input(fs), Y2026);
    expect(r.flags).toMatchObject({ recorded: 1, flights: 0, slew: 0 });
    expect(buildReview(input(fs, { showDemo: true }), Y2026).flags).toMatchObject({ recorded: 2, flights: 1, slew: 1 });
    expect(flagStats([])).toEqual({ recorded: 0, flights: 0, paused: 0, pausedMs: 0, timeAccel: 0, maxSimRate: 1, slew: 0, teleport: 0 });
  });

  it("a time acceleration without a rate keeps the rate at 1", () => {
    const r = flagStats([flight({ when: "2026-04-01T08:00:00Z", integrity: integ({ timeAccelerationDetected: true, maxSimRate: Number.NaN }) })]);
    expect(r).toMatchObject({ flights: 1, timeAccel: 1, maxSimRate: 1 });
  });
});

describe("facts window (partial)", () => {
  it("landings and approaches are marked partial when the newest 200 do not reach back to the period start", () => {
    const f = flight({ when: "2026-09-01T08:00:00Z" });
    const many = Array.from({ length: FACTS_WINDOW }, (_, i) => fact(f, { touchdownIndex: i, timestampMs: at("2026-09-01T09:00:00Z") + i }));
    const appr = Array.from({ length: FACTS_WINDOW }, (_, i) => approach(f, { approachIndex: i, endedMs: at("2026-09-01T09:00:00Z") + i }));
    const r = buildReview(input([f], { landings: many, approaches: appr }), Y2026);
    expect(r.landings.partial).toBe(true);
    expect(r.approaches.partial).toBe(true);
    const few = buildReview(input([f], { landings: many.slice(0, 10), approaches: appr.slice(0, 10) }), Y2026);
    expect(few.landings.partial).toBe(false);
    expect(few.approaches.partial).toBe(false);
  });
});
