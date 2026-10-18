import { describe, expect, it } from "vitest";
import {
  ON_TIME_THRESHOLD_MIN,
  PIREP_SCHEMA,
  actualFromRow,
  actualFromSummary,
  buildPirep,
  fmtPunctuality,
  fmtPvaDelta,
  fmtPvaValue,
  fuelAt,
  integrityIssues,
  parseOfp,
  pirepFileName,
  planFromRow,
  planVsActual,
  punctuality,
} from "./pirep";
import type { FlightDetail, FlightRow, FlightSummary, IntegrityFlags, Ofp, TouchdownReport, TrackSample } from "./types";

/** Compare against typographic output with plain spaces / "-". */
const NARROW = new RegExp(`[${String.fromCharCode(0x202f, 0xa0)}]`, "g");
const plain = (s: string) => s.replace(NARROW, " ").split(String.fromCharCode(0x2212)).join("-");

const T0 = Date.UTC(2026, 9, 16, 8, 0, 0); // 2026-10-16 08:00z
const MIN = 60_000;
const S = (ms: number) => ms / 1000;

const clean: IntegrityFlags = {
  pausedMs: 0,
  pauseCount: 0,
  slewDetected: false,
  timeAccelerationDetected: false,
  maxSimRate: 1,
  crashed: false,
  fuelIncreasedAirborne: false,
};

function ofp(over: Partial<Ofp> = {}): Ofp {
  return {
    requestId: "1",
    generatedAtS: S(T0) - 3600,
    airac: "2510",
    sourceUnits: "kgs",
    airlineIcao: "DLH",
    flightNumber: "4YA",
    callsign: "DLH4YA",
    originIcao: "EDDF",
    originName: "Frankfurt",
    originRunway: "25C",
    destinationIcao: "LIRF",
    destinationName: "Rome",
    destinationRunway: "16R",
    alternateIcao: "LIRN",
    alternateName: "Naples",
    aircraftIcao: "A20N",
    aircraftName: "A320neo",
    registration: "D-AINA",
    route: "ANEKI Y163 …",
    cruiseAltitudeFt: 36000,
    routeDistanceNm: 620,
    greatCircleDistanceNm: 520,
    costIndex: "25",
    passengers: 150,
    times: {
      schedOutS: S(T0),
      schedOffS: S(T0 + 15 * MIN),
      schedOnS: S(T0 + 110 * MIN),
      schedInS: S(T0 + 120 * MIN),
      estOutS: 0,
      estOffS: 0,
      estOnS: 0,
      estInS: 0,
      blockS: 120 * 60,
      enrouteS: 95 * 60,
      taxiOutS: 15 * 60,
      taxiInS: 10 * 60,
      enduranceS: 0,
    },
    fuel: {
      taxiKg: 200,
      tripKg: 5300,
      contingencyKg: 265,
      alternateKg: 900,
      reserveKg: 1100,
      extraKg: 500,
      minTakeoffKg: 7565,
      planTakeoffKg: 8065,
      planRampKg: 8265,
      planLandingKg: 2765,
    },
    weights: {
      oewKg: 0,
      payloadKg: 0,
      cargoKg: 0,
      paxCount: 150,
      estZfwKg: 58400,
      maxZfwKg: 0,
      estTowKg: 66465,
      maxTowKg: 0,
      estLdwKg: 61165,
      maxLdwKg: 0,
      estRampKg: 0,
    },
    navlog: [],
    ...over,
  };
}

function row(over: Partial<FlightRow> = {}): FlightRow {
  return {
    id: "f-1",
    state: "completed",
    phase: "shutdown",
    createdMs: T0 - 10 * MIN,
    updatedMs: T0 + 200 * MIN,
    offBlockMs: T0 + 4 * MIN, // 4 min late
    takeoffMs: T0 + 16 * MIN, // 12 min taxi
    landingMs: T0 + 116 * MIN, // 100 min air
    onBlockMs: T0 + 128 * MIN, // 12 min taxi in, 8 min late at the gate
    depLat: 50.0333,
    depLon: 8.5706,
    arrLat: 41.8003,
    arrLon: 12.2389,
    maxAltMslFt: 36020,
    distanceNm: 612.4,
    fuelStartKg: 8300,
    fuelEndKg: 2700,
    aircraft: { title: "A320neo Lufthansa", atcType: "AIRBUS", atcModel: "A20N", atcId: "D-AINA", atcAirline: "Lufthansa", atcFlightNumber: "4YA" },
    provider: "simconnect",
    simName: "MSFS 2024",
    depIcao: "EDDF",
    arrIcao: "LIRF",
    callsign: "DLH4YA",
    plannedDep: "EDDF",
    plannedArr: "LIRF",
    plannedBlockS: 120 * 60,
    plannedFuelRampKg: 8265,
    plannedFuelLandingKg: 2765,
    hasOfp: true,
    integrity: clean,
    landingVsFpm: -142,
    landingCount: 1,
    airframeReg: "D-AINA",
    ...over,
  } as FlightRow;
}

function td(over: Partial<TouchdownReport> = {}): TouchdownReport {
  return {
    timestampMs: T0 + 116 * MIN,
    vsFpmMeasured: -150,
    vsFpmSim: -142,
    vsFpmHardest: -142,
    peakG: 1.318,
    pitchDeg: 4,
    bankDeg: 0,
    groundSpeedKt: 135,
    headingTrueDeg: 160,
    latitude: 41.8,
    longitude: 12.2,
    bounces: 0,
    touchAndGo: false,
    landingRateFpm: -142,
    landingRateSource: "sim",
    ...over,
  };
}

function sample(tMs: number, fuel: number): TrackSample {
  return {
    tMs,
    latitude: 0,
    longitude: 0,
    altitudeMslFt: 0,
    altitudeAglFt: 0,
    groundSpeedKt: 0,
    iasKt: 0,
    verticalSpeedFpm: 0,
    headingTrueDeg: 0,
    pitchDeg: 0,
    bankDeg: 0,
    gForce: 1,
    onGround: true,
    flapsIndex: 0,
    gearPct: 1,
    fuelTotalKg: fuel,
  };
}

const track = [sample(T0 + 4 * MIN, 8300), sample(T0 + 16 * MIN, 8120), sample(T0 + 60 * MIN, 5000), sample(T0 + 116 * MIN, 2860), sample(T0 + 128 * MIN, 2700)];

describe("planVsActual", () => {
  it("compares every line with an OFP and a track", () => {
    const r = row();
    const p = planVsActual(actualFromRow(r, track), planFromRow(r), ofp());
    const L = p.byKey;
    expect(L.offBlock?.delta).toBe(4 * MIN);
    expect(L.takeoff?.delta).toBe(1 * MIN);
    expect(L.landing?.delta).toBe(6 * MIN);
    expect(L.onBlock?.delta).toBe(8 * MIN);
    expect(L.taxiOut).toMatchObject({ plan: 15 * MIN, actual: 12 * MIN, delta: -3 * MIN });
    expect(L.taxiIn).toMatchObject({ plan: 10 * MIN, actual: 12 * MIN, delta: 2 * MIN });
    expect(L.block).toMatchObject({ plan: 120 * MIN, actual: 124 * MIN, delta: 4 * MIN, warn: null });
    expect(L.air).toMatchObject({ plan: 95 * MIN, actual: 100 * MIN });
    // trip from the track: 8120 at takeoff, 2860 at the landing
    expect(L.tripFuel).toMatchObject({ plan: 5300, actual: 5260, delta: -40, approx: false });
    expect(L.blockFuel).toMatchObject({ plan: 8265 - 2765, actual: 5600 });
    expect(L.landingFuel).toMatchObject({ plan: 2765, actual: 2860, approx: false, warn: null });
    expect(L.fuelStart).toMatchObject({ plan: 8265, actual: 8300 });
    expect(L.distance).toMatchObject({ plan: 620, actual: 612.4 });
    expect(L.cruise).toMatchObject({ plan: 36000, actual: 36020, delta: 20 });
    expect(p.delayOutMin).toBe(4);
    expect(p.delayInMin).toBe(8);
    expect(p.headline).toEqual({ status: "onTime", delayMin: 8, label: "pünktlich", event: "in" });
    expect(p.lines.map((l) => l.key)).toEqual([
      "offBlock",
      "takeoff",
      "landing",
      "onBlock",
      "taxiOut",
      "taxiIn",
      "block",
      "air",
      "fuelStart",
      "tripFuel",
      "blockFuel",
      "landingFuel",
      "distance",
      "cruise",
    ]);
  });

  it("estimates trip fuel without a track and marks the landing fuel as on-block value", () => {
    const r = row();
    const L = planVsActual(actualFromRow(r), planFromRow(r), ofp()).byKey;
    expect(L.tripFuel).toMatchObject({ actual: 5600 - 200, approx: true });
    expect(L.tripFuel?.note).toContain("geschätzt");
    expect(L.landingFuel).toMatchObject({ actual: 2700, approx: true, warn: "Weniger Treibstoff bei der Landung als geplant" });
  });

  it("falls back to the row's plan columns without an OFP", () => {
    const r = row();
    const L = planVsActual(actualFromRow(r), planFromRow(r), null).byKey;
    expect(L.block).toMatchObject({ plan: 120 * MIN, delta: 4 * MIN });
    expect(L.landingFuel?.plan).toBe(2765);
    expect(L.offBlock?.plan).toBeNull();
    expect(L.taxiOut?.plan).toBeNull();
    expect(L.tripFuel?.plan).toBeNull();
    expect(L.distance?.plan).toBeNull();
  });

  it("treats OFP zeros as 'not given' (no taxi plan → –)", () => {
    const o = ofp();
    o.times = { ...o.times, taxiOutS: 0, taxiInS: 0, schedOutS: 0 };
    const p = planVsActual(actualFromRow(row()), null, o);
    expect(p.byKey.taxiOut?.plan).toBeNull();
    expect(p.byKey.taxiOut?.delta).toBeNull();
    expect(p.delayOutMin).toBeNull();
    expect(p.departure).toBeNull();
  });

  it("flags a block time 15 min or more over plan and the arrival as late", () => {
    const r = row({ onBlockMs: T0 + 140 * MIN });
    const p = planVsActual(actualFromRow(r), planFromRow(r), ofp());
    expect(p.byKey.block?.warn).toContain("über Plan");
    expect(p.delayInMin).toBe(20);
    expect(p.arrival?.status).toBe("late");
    expect(p.headline?.label).toBe("verspätet");
  });

  it("lets durations run live but gives no delta until the flight is done", () => {
    const f: FlightSummary = {
      state: "active",
      phase: "cruise",
      offBlockMs: T0,
      takeoffMs: T0 + 10 * MIN,
      maxAltitudeMslFt: 30000,
      distanceNm: 120,
      fuelStartKg: 8000,
      touchdowns: [],
      integrity: clean,
    };
    const t = { timestampMs: T0 + 40 * MIN, fuelTotalKg: 6500 } as Parameters<typeof actualFromSummary>[1];
    const p = planVsActual(actualFromSummary(f, t), null, ofp());
    expect(p.byKey.block).toMatchObject({ actual: 40 * MIN, running: true, delta: null });
    expect(p.byKey.air).toMatchObject({ actual: 30 * MIN, running: true, delta: null });
    expect(p.byKey.blockFuel).toMatchObject({ actual: 1500, running: true, delta: null });
    expect(p.byKey.landingFuel?.actual).toBeNull();
    expect(p.byKey.tripFuel?.actual).toBeNull();
    expect(p.byKey.offBlock?.delta).toBe(0);
    expect(p.headline?.status).toBe("onTime");
  });
});

describe("punctuality", () => {
  it("uses the 15-minute airline definition", () => {
    expect(punctuality(ON_TIME_THRESHOLD_MIN, "in")?.status).toBe("onTime");
    expect(punctuality(ON_TIME_THRESHOLD_MIN + 1, "in")?.status).toBe("late");
    expect(punctuality(-20, "out")?.status).toBe("onTime");
    expect(punctuality(null, "out")).toBeNull();
    expect(plain(fmtPunctuality(punctuality(-3, "in")))).toBe("pünktlich (-3 min)");
    expect(fmtPunctuality(punctuality(0, "in"))).toBe("pünktlich (±0 min)");
    expect(fmtPunctuality(punctuality(22, "in"))).toBe("verspätet (+22 min)");
  });
});

describe("formatting", () => {
  it("formats plan/actual cells and deltas", () => {
    const r = row();
    const L = planVsActual(actualFromRow(r, track), planFromRow(r), ofp()).byKey;
    expect(fmtPvaValue("time", L.offBlock?.plan)).toBe("08:00z");
    expect(plain(fmtPvaValue("duration", L.block?.actual))).toBe("2 h 04 min");
    expect(plain(fmtPvaValue("weight", 5300, "kg"))).toBe("5 300 kg");
    expect(plain(fmtPvaValue("distance", 612.4))).toBe("612 nm");
    expect(fmtPvaValue("altitude", 36000)).toBe("FL360");
    expect(fmtPvaValue("time", null)).toBe("–");
    expect(plain(fmtPvaDelta(L.offBlock!))).toBe("+4 min");
    expect(plain(fmtPvaDelta(L.taxiOut!))).toBe("-3 min");
    expect(plain(fmtPvaDelta(L.tripFuel!, "kg"))).toBe("-40 kg");
    expect(plain(fmtPvaDelta(L.distance!))).toBe("-8 nm");
    expect(plain(fmtPvaDelta(L.cruise!))).toBe("±0 ft");
  });
});

describe("helpers", () => {
  it("reads fuel from the track at a time", () => {
    expect(fuelAt(track, T0 + 16 * MIN)).toBe(8120);
    expect(fuelAt(track, T0 + 17 * MIN)).toBe(8120);
    expect(fuelAt(track, T0)).toBe(8300); // before the first sample
    expect(fuelAt([], T0)).toBeNull();
    expect(fuelAt(track, null)).toBeNull();
  });

  it("parses the stored OFP defensively", () => {
    expect(parseOfp(JSON.stringify(ofp()))?.callsign).toBe("DLH4YA");
    expect(parseOfp("{broken")).toBeNull();
    expect(parseOfp('{"route":"DCT"}')).toBeNull();
    expect(parseOfp(null)).toBeNull();
  });

  it("has no plan for a row without one", () => {
    expect(planFromRow(row({ hasOfp: false, plannedBlockS: null, plannedDep: null }))).toBeNull();
  });

  it("lists integrity findings", () => {
    expect(integrityIssues(clean)).toEqual([]);
    expect(integrityIssues({ ...clean, slewDetected: true, pauseCount: 2, pausedMs: 90_000 })).toEqual(["Slew", "2× Pause (1 min 30 s)"]);
  });
});

describe("buildPirep", () => {
  const detail = (over: Partial<FlightRow> = {}, tds: TouchdownReport[] = [td()]): FlightDetail => ({
    flight: row(over),
    touchdowns: tds,
    phases: [],
    hasTrack: true,
    ofpJson: JSON.stringify(ofp()),
  });

  it("builds the JSON with a stable schema", () => {
    const { json } = buildPirep(detail(), ofp(), { stableFromFt: 1500, band: "stable" }, { appVersion: "0.4.0", track });
    expect(json.schema).toBe(PIREP_SCHEMA);
    expect(json.generator).toEqual({ name: "VectaSim", version: "0.4.0" });
    expect(json).toMatchObject({
      flightId: "f-1",
      callsign: "DLH4YA",
      flightNumber: "DLH4YA",
      departure: "EDDF",
      arrival: "LIRF",
      alternate: "LIRN",
      date: "2026-10-16",
      distanceNm: 612.4,
      plannedDistanceNm: 620,
      maxAltitudeFt: 36020,
      plannedCruiseFt: 36000,
    });
    expect(json.times).toEqual({
      offBlock: "2026-10-16T08:04:00Z",
      takeoff: "2026-10-16T08:16:00Z",
      landing: "2026-10-16T09:56:00Z",
      onBlock: "2026-10-16T10:08:00Z",
      schedOut: "2026-10-16T08:00:00Z",
      schedIn: "2026-10-16T10:00:00Z",
      blockMin: 124,
      airMin: 100,
      taxiOutMin: 12,
      taxiInMin: 12,
      plannedBlockMin: 120,
      plannedAirMin: 95,
    });
    expect(json.fuel).toEqual({
      unit: "kg",
      start: 8300,
      end: 2700,
      used: 5600,
      trip: 5260,
      tripEstimated: false,
      plannedTrip: 5300,
      plannedRamp: 8265,
      landing: 2860,
      plannedLanding: 2765,
    });
    expect(json.landing).toEqual({ rateFpm: -142, rateSource: "sim", maxG: 1.32, bounces: 0, touchdowns: 1, stableFromFt: 1500, approachBand: "stable" });
    expect(json.punctuality).toEqual({ thresholdMin: 15, delayOutMin: 4, delayInMin: 8, status: "onTime" });
    expect(json.integrity.clean).toBe(true);
    expect(json.aircraft).toEqual({ title: "A320neo Lufthansa", icao: "A20N", registration: "D-AINA" });
    expect(json.sim).toEqual({ name: "MSFS 2024", provider: "simconnect" });
    // round-trips through JSON without losing keys (no undefined values)
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it("writes the text version for VA forms", () => {
    const { text } = buildPirep(detail(), ofp(), { stableFromFt: 1500, band: "stable" }, { appVersion: "0.4.0", track });
    expect(text).toBe(
      [
        "PIREP DLH4YA",
        "Callsign             DLH4YA",
        "Flugnr. / Flight     DLH4YA",
        "DEP / ARR            EDDF - LIRF (ALTN LIRN)",
        "Datum / Date         16.10.2026 (UTC)",
        "OUT / OFF / ON / IN  08:04z / 08:16z / 09:56z / 10:08z",
        "STD / STA            08:00z / 10:00z",
        "Block / Air          2:04 / 1:40 (Plan 2:00 / 1:35)",
        "Taxi out / in        12 / 12 min",
        "Distanz / Dist       612 nm (Plan 620 nm)",
        "Max. Alt             36020 ft (Plan FL360)",
        "Fuel Start / End     8300 / 2700 kg (Block 5600 kg)",
        "Trip Fuel            5260 kg (Plan 5300 kg)",
        "Landerate / LDG      -142 fpm | max. 1.32 g | Bounces 0",
        "Anflug / Appr        stabil ab 1500 ft",
        "Pünktlichkeit        pünktlich (+8 min On-Block)",
        "Integrität           OK",
        "Sim                  MSFS 2024",
        "Flugzeug / Acft      A20N - A320neo Lufthansa",
        "Reg.                 D-AINA",
        "-- VectaSim 0.4.0 (pirep/v1)",
        "",
      ].join("\n"),
    );
  });

  it("works without a plan, approach or track and in lb", () => {
    const d = detail({ hasOfp: false, plannedBlockS: null, plannedDep: null, plannedArr: null, plannedFuelRampKg: null, plannedFuelLandingKg: null, callsign: null });
    const { json, text } = buildPirep(d, null, null, { weightUnit: "lb" });
    expect(json.generator.version).toBeNull();
    expect(json.callsign).toBe("Lufthansa 4YA");
    expect(json.flightNumber).toBe("4YA");
    expect(json.times.schedOut).toBeNull();
    expect(json.fuel.trip).toBe(5600); // block fuel, no planned taxi to subtract
    expect(json.fuel.tripEstimated).toBe(true);
    expect(json.punctuality.status).toBeNull();
    expect(json.landing.stableFromFt).toBeNull();
    expect(text).not.toContain("STD / STA");
    expect(text).not.toContain("Anflug");
    expect(text).toContain("Fuel Start / End     18298 / 5952 lb");
    expect(text).toContain("Trip Fuel            ca. 12346 lb");
    expect(text).toContain("Pünktlichkeit        -");
  });

  it("judges the last full stop, lists integrity issues and says 'nie stabil'", () => {
    const d = detail({ integrity: { ...clean, slewDetected: true }, landingVsFpm: -300 }, [td({ peakG: 1.9, bounces: 2, touchAndGo: false, landingRateFpm: -300 }), td({ touchAndGo: true, peakG: 1.1 })]);
    const { json, text } = buildPirep(d, ofp(), { stableFromFt: null, band: "unstable" });
    expect(json.landing).toMatchObject({ rateFpm: -300, maxG: 1.9, bounces: 2, touchdowns: 2, stableFromFt: null, approachBand: "unstable" });
    expect(json.integrity).toMatchObject({ clean: false, issues: ["Slew"], slew: true });
    expect(text).toContain("Anflug / Appr        nie stabil");
    expect(text).toContain("Integrität           Slew");
  });

  it("names the file after route and date", () => {
    expect(pirepFileName(buildPirep(detail(), ofp()).json)).toBe("pirep-EDDF-LIRF-2026-10-16.json");
  });
});
