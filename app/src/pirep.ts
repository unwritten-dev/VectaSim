// Plan against actual and the PIREP package of one flight. Everything here is pure (no Tauri
// calls, no React), so it can be unit-tested and shared by the logbook detail (FlightDetail)
// and the live side panel (LiveView → "Ist gegen Plan").
//
// Sources:
//   plan   = SimBrief OFP attached to the flight (Ofp, stored as `ofpJson`), falling back to the
//            plan columns of the flight row (plannedBlockS, plannedFuelRampKg/LandingKg);
//   actual = flight row / live summary (off/takeoff/landing/on-block, fuel start/end, distance,
//            max altitude) and, when given, the track (fuel at takeoff and at the landing).
// Deltas are always actual minus plan.

import type { FlightDetail, FlightRow, FlightSummary, IntegrityFlags, Ofp, Telemetry, TouchdownReport, TrackSample } from "./types";
import type { ApproachBand } from "./landing/approachTypes";
import { haversineNm, type WeightUnit } from "./format";
import { DASH, SEPARATORS, fmt, fmtAltitude, fmtClock, fmtDate, fmtDeltaKg, fmtDeltaMin, fmtDuration, fmtSigned, fmtWeight } from "./i18n/number";
import { RESOURCES, getLanguage, tIn, type Language, type TKey, type Vars } from "./i18n";
import { translate } from "./i18n/translate";
import { callsignOf } from "./logbookFilter";

/** Airline on-time definition (A15/D15): up to 15 minutes after schedule counts as on time. */
export const ON_TIME_THRESHOLD_MIN = 15;
/** Version tag of the PIREP JSON; bump only for incompatible changes. */
export const PIREP_SCHEMA = "pirep/v1";

const isNum = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);
/** OFP numbers use 0 for "not given". */
const pos = (n: number | null | undefined): number | null => (isNum(n) && n > 0 ? n : null);
const sub = (a: number | null | undefined, b: number | null | undefined): number | null => (isNum(a) && isNum(b) ? a - b : null);
const durMs = (from: number | null | undefined, to: number | null | undefined): number | null => {
  const d = sub(to, from);
  return d != null && d >= 0 ? d : null;
};

// ---- inputs ------------------------------------------------------------------------------

/** What was flown. `nowMs`/`fuelNowKg` (live only) let block/air time and fuel run on. */
export interface PvaActual {
  offBlockMs?: number | null;
  takeoffMs?: number | null;
  landingMs?: number | null;
  onBlockMs?: number | null;
  fuelStartKg?: number | null;
  fuelEndKg?: number | null;
  /** Fuel on board at takeoff / at the landing, from the track (null without one). */
  fuelTakeoffKg?: number | null;
  fuelLandingKg?: number | null;
  /** Integrated track distance. */
  distanceNm?: number | null;
  maxAltFt?: number | null;
  depLat?: number | null;
  depLon?: number | null;
  arrLat?: number | null;
  arrLon?: number | null;
  nowMs?: number | null;
  fuelNowKg?: number | null;
}

/** The plan columns a flight row keeps even without (or with an unreadable) OFP. */
export interface PvaPlan {
  dep?: string | null;
  arr?: string | null;
  callsign?: string | null;
  blockS?: number | null;
  fuelRampKg?: number | null;
  fuelLandingKg?: number | null;
}

/** Fuel on board at `ms` from the track: the last sample at or before it (first sample as fallback). */
export function fuelAt(track: readonly TrackSample[] | null | undefined, ms: number | null | undefined): number | null {
  if (!track?.length || !isNum(ms)) return null;
  let best: TrackSample | null = null;
  for (const s of track) {
    if (s.tMs <= ms) best = s;
    else break;
  }
  const v = (best ?? track[0]).fuelTotalKg;
  return isNum(v) && v > 0 ? v : null;
}

export function actualFromRow(row: FlightRow, track?: readonly TrackSample[] | null): PvaActual {
  return {
    offBlockMs: row.offBlockMs,
    takeoffMs: row.takeoffMs,
    landingMs: row.landingMs,
    onBlockMs: row.onBlockMs,
    fuelStartKg: row.fuelStartKg,
    fuelEndKg: row.fuelEndKg,
    fuelTakeoffKg: fuelAt(track, row.takeoffMs),
    fuelLandingKg: fuelAt(track, row.landingMs),
    distanceNm: row.distanceNm,
    maxAltFt: row.maxAltMslFt,
    depLat: row.depLat,
    depLon: row.depLon,
    arrLat: row.arrLat,
    arrLon: row.arrLon,
  };
}

/** Live: the running flight; the telemetry clock and fuel stand in for what is not final yet. */
export function actualFromSummary(f: FlightSummary | null | undefined, t?: Telemetry | null): PvaActual {
  return {
    offBlockMs: f?.offBlockMs,
    takeoffMs: f?.takeoffMs,
    landingMs: f?.landingMs,
    onBlockMs: f?.onBlockMs,
    fuelStartKg: f?.fuelStartKg,
    fuelEndKg: f?.fuelEndKg,
    // once landed the fuel at the landing is (about) what is on board now, until on-block
    fuelLandingKg: f?.landingMs ? (f.fuelEndKg ?? t?.fuelTotalKg ?? null) : null,
    distanceNm: f?.distanceNm,
    maxAltFt: f?.maxAltitudeMslFt,
    depLat: f?.departure?.latitude,
    depLon: f?.departure?.longitude,
    arrLat: f?.arrival?.latitude,
    arrLon: f?.arrival?.longitude,
    nowMs: t?.timestampMs,
    fuelNowKg: t?.fuelTotalKg,
  };
}

/** Plan columns of a row; null when no plan is attached. */
export function planFromRow(row: FlightRow): PvaPlan | null {
  if (!row.hasOfp && row.plannedBlockS == null && !row.plannedDep) return null;
  return {
    dep: row.plannedDep,
    arr: row.plannedArr,
    callsign: row.callsign,
    blockS: row.plannedBlockS,
    fuelRampKg: row.plannedFuelRampKg,
    fuelLandingKg: row.plannedFuelLandingKg,
  };
}

/** The stored OFP document (`FlightDetail.ofpJson`), or null if missing or unreadable. */
export function parseOfp(json: string | null | undefined): Ofp | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Partial<Ofp> | null;
    // a minimal shape check: the store keeps our own serialisation of `Ofp`
    if (!o || typeof o !== "object" || !o.times || !o.fuel) return null;
    return o as Ofp;
  } catch {
    return null;
  }
}

// ---- plan against actual -----------------------------------------------------------------

export type PvaKind = "time" | "duration" | "weight" | "distance" | "altitude";
export type PvaKey =
  | "offBlock"
  | "takeoff"
  | "landing"
  | "onBlock"
  | "taxiOut"
  | "taxiIn"
  | "block"
  | "air"
  | "fuelStart"
  | "tripFuel"
  | "blockFuel"
  | "landingFuel"
  | "distance"
  | "cruise";

export interface PvaLine {
  key: PvaKey;
  label: string;
  kind: PvaKind;
  /** ms epoch (time), ms (duration), kg, nm or ft. */
  plan: number | null;
  actual: number | null;
  /** actual − plan in the same unit; null when either side is missing or the actual still runs. */
  delta: number | null;
  /** The actual is still running (live, flight not finished). */
  running?: boolean;
  /** The actual is an estimate (see `note`). */
  approx?: boolean;
  /** Where a value comes from, for the tooltip. */
  note?: string;
  /** Set when the deviation deserves attention. */
  warn?: string | null;
}

export type PunctualityStatus = "onTime" | "late";

export interface Punctuality {
  status: PunctualityStatus;
  /** Delay in whole minutes (negative = early). */
  delayMin: number;
  /** "pünktlich" / "verspätet" ("on time" / "late"), in the language it was built for. */
  label: string;
  /** Which event: out = off-block (D15), in = on-block (A15). */
  event: "out" | "in";
}

export interface PlanVsActual {
  lines: PvaLine[];
  byKey: Partial<Record<PvaKey, PvaLine>>;
  /** Off-block / on-block against the schedule, whole minutes. */
  delayOutMin: number | null;
  delayInMin: number | null;
  /** Departure (D15) and arrival (A15) punctuality; `headline` = arrival when known, else departure. */
  departure: Punctuality | null;
  arrival: Punctuality | null;
  headline: Punctuality | null;
}

const delayMin = (actual: number | null | undefined, plan: number | null | undefined): number | null => {
  const d = sub(actual, plan);
  return d == null ? null : Math.round(d / 60000);
};

export function punctuality(delay: number | null, event: "out" | "in", lang: Language = getLanguage()): Punctuality | null {
  if (delay == null) return null;
  const late = delay > ON_TIME_THRESHOLD_MIN;
  return { status: late ? "late" : "onTime", delayMin: delay, label: tIn(lang, late ? "logbook.pva.late" : "logbook.pva.onTime"), event };
}

/**
 * Plan against actual for one flight. `plan` are the row's plan columns (may be null), `ofp` the
 * full OFP (may be null); OFP values win where both exist. Without either, every plan is null.
 */
export function planVsActual(actual: PvaActual, plan: PvaPlan | null, ofp?: Ofp | null, lang: Language = getLanguage()): PlanVsActual {
  const tr = (key: TKey, vars?: Vars) => translate(RESOURCES, lang, key, vars);
  const a = actual;
  const t = ofp?.times;
  const fuel = ofp?.fuel;
  const s2ms = (s: number | null | undefined) => (pos(s) != null ? (s as number) * 1000 : null);

  const lines: PvaLine[] = [];
  const add = (l: Omit<PvaLine, "delta"> & { delta?: number | null }) => {
    const delta = l.delta !== undefined ? l.delta : l.running ? null : sub(l.actual, l.plan);
    lines.push({ ...l, delta });
  };

  // event times
  add({ key: "offBlock", label: tr("logbook.pva.offBlock"), kind: "time", plan: s2ms(t?.schedOutS), actual: pos(a.offBlockMs) });
  add({ key: "takeoff", label: tr("logbook.pva.takeoff"), kind: "time", plan: s2ms(t?.schedOffS), actual: pos(a.takeoffMs) });
  add({ key: "landing", label: tr("logbook.pva.landing"), kind: "time", plan: s2ms(t?.schedOnS), actual: pos(a.landingMs) });
  add({ key: "onBlock", label: tr("logbook.pva.onBlock"), kind: "time", plan: s2ms(t?.schedInS), actual: pos(a.onBlockMs) });

  // durations; live they run on with the telemetry clock until the closing event
  const now = pos(a.nowMs);
  const running = (from: number | null | undefined, to: number | null | undefined) => {
    if (pos(to) != null) return { value: durMs(from, to), running: false };
    if (pos(from) != null && now != null) return { value: durMs(from, now), running: true };
    return { value: null, running: false };
  };
  const taxiOut = running(a.offBlockMs, a.takeoffMs);
  add({ key: "taxiOut", label: tr("logbook.pva.taxiOut"), kind: "duration", plan: s2ms(t?.taxiOutS), actual: taxiOut.value, running: taxiOut.running, note: tr("logbook.pva.taxiOutNote") });
  const taxiIn = running(a.landingMs, a.onBlockMs);
  add({ key: "taxiIn", label: tr("logbook.pva.taxiIn"), kind: "duration", plan: s2ms(t?.taxiInS), actual: taxiIn.value, running: taxiIn.running, note: tr("logbook.pva.taxiInNote") });
  const block = running(a.offBlockMs, a.onBlockMs);
  const blockPlan = s2ms(t?.blockS) ?? s2ms(plan?.blockS);
  const blockDelta = block.running ? null : sub(block.value, blockPlan);
  add({
    key: "block",
    label: tr("logbook.pva.block"),
    kind: "duration",
    plan: blockPlan,
    actual: block.value,
    running: block.running,
    delta: blockDelta,
    warn: blockDelta != null && blockDelta >= ON_TIME_THRESHOLD_MIN * 60000 ? tr("logbook.pva.blockWarn", { delta: fmtDeltaMin(block.value, blockPlan, lang) }) : null,
  });
  const air = running(a.takeoffMs, a.landingMs);
  add({ key: "air", label: tr("logbook.pva.air"), kind: "duration", plan: s2ms(t?.enrouteS), actual: air.value, running: air.running, note: tr("logbook.pva.airNote") });

  // fuel
  const rampPlan = pos(fuel?.planRampKg) ?? pos(plan?.fuelRampKg);
  const landingPlan = pos(fuel?.planLandingKg) ?? pos(plan?.fuelLandingKg);
  add({ key: "fuelStart", label: tr("logbook.pva.fuelStart"), kind: "weight", plan: rampPlan, actual: pos(a.fuelStartKg), note: tr("logbook.pva.fuelStartNote") });

  const blockFuelEnd = pos(a.fuelEndKg) ?? (pos(a.onBlockMs) == null ? pos(a.fuelNowKg) : null);
  const blockFuelRunning = pos(a.fuelEndKg) == null && blockFuelEnd != null;
  const blockFuel = sub(a.fuelStartKg, blockFuelEnd);
  const tripPlan = pos(fuel?.tripKg);
  const taxiFuelPlan = pos(fuel?.taxiKg);
  const blockFuelPlan = rampPlan != null && landingPlan != null ? rampPlan - landingPlan : tripPlan != null ? tripPlan + (taxiFuelPlan ?? 0) : null;

  // trip: takeoff → landing; exact from the track, else block fuel minus the planned taxi fuel
  let trip: number | null = null;
  let tripApprox = false;
  let tripNote = tr("logbook.pva.tripNoteTrack");
  if (pos(a.fuelTakeoffKg) != null && pos(a.fuelLandingKg) != null && pos(a.landingMs) != null) {
    trip = (a.fuelTakeoffKg as number) - (a.fuelLandingKg as number);
  } else if (blockFuel != null && !blockFuelRunning && pos(a.onBlockMs) != null) {
    trip = blockFuel - (taxiFuelPlan ?? 0);
    tripApprox = true;
    tripNote = taxiFuelPlan != null ? tr("logbook.pva.tripNoteEstimated") : tr("logbook.pva.tripNoteEstimatedNoTaxi");
  }
  add({ key: "tripFuel", label: tr("logbook.pva.tripFuel"), kind: "weight", plan: tripPlan, actual: trip, approx: tripApprox, note: tripNote });
  add({
    key: "blockFuel",
    label: tr("logbook.pva.blockFuel"),
    kind: "weight",
    plan: blockFuelPlan,
    actual: blockFuel,
    running: blockFuelRunning,
    note: tr("logbook.pva.blockFuelNote"),
  });

  const landingFuel = pos(a.fuelLandingKg) ?? (pos(a.landingMs) != null ? pos(a.fuelEndKg) : null);
  const landingApprox = pos(a.fuelLandingKg) == null && landingFuel != null;
  add({
    key: "landingFuel",
    label: tr("logbook.pva.landingFuel"),
    kind: "weight",
    plan: landingPlan,
    actual: landingFuel,
    approx: landingApprox,
    note: landingApprox ? tr("logbook.pva.landingFuelNoteOnBlock") : tr("logbook.pva.landingFuelNote"),
    warn: landingFuel != null && landingPlan != null && landingFuel < landingPlan - 0.5 ? tr("logbook.pva.landingFuelWarn") : null,
  });

  // distance and altitude
  const gc =
    isNum(a.depLat) && isNum(a.depLon) && isNum(a.arrLat) && isNum(a.arrLon) ? haversineNm(a.depLat, a.depLon, a.arrLat, a.arrLon) : null;
  const dist = pos(a.distanceNm);
  const distRunning = pos(a.onBlockMs) == null && pos(a.landingMs) == null && dist != null && now != null;
  add({
    key: "distance",
    label: tr("logbook.pva.distance"),
    kind: "distance",
    plan: pos(ofp?.routeDistanceNm),
    actual: dist,
    running: distRunning,
    note: gc != null ? tr("logbook.pva.distanceNoteGc", { gc: fmt(gc, 0, "nm", lang) }) : tr("logbook.pva.distanceNote"),
  });
  add({ key: "cruise", label: tr("logbook.pva.cruise"), kind: "altitude", plan: pos(ofp?.cruiseAltitudeFt), actual: pos(a.maxAltFt), note: tr("logbook.pva.cruiseNote") });

  const byKey: Partial<Record<PvaKey, PvaLine>> = {};
  for (const l of lines) byKey[l.key] = l;

  const delayOut = delayMin(byKey.offBlock?.actual, byKey.offBlock?.plan);
  const delayIn = delayMin(byKey.onBlock?.actual, byKey.onBlock?.plan);
  const departure = punctuality(delayOut, "out", lang);
  const arrival = punctuality(delayIn, "in", lang);
  return { lines, byKey, delayOutMin: delayOut, delayInMin: delayIn, departure, arrival, headline: arrival ?? departure };
}

/** A plan/actual cell for display ("08:15z", "1 h 05 min", "5 300 kg", "612 nm", "FL360"). */
export function fmtPvaValue(kind: PvaKind, v: number | null | undefined, unit?: WeightUnit): string {
  if (!isNum(v)) return DASH;
  switch (kind) {
    case "time":
      return fmtClock(v);
    case "duration":
      return fmtDuration(v, { seconds: false });
    case "weight":
      return fmtWeight(v, unit);
    case "distance":
      return fmt(v, 0, "nm");
    case "altitude":
      return fmtAltitude(v);
  }
}

/** The Δ cell ("+7 min", "−265 kg", "+12 nm", "−1 000 ft"). */
export function fmtPvaDelta(l: PvaLine, unit?: WeightUnit): string {
  if (l.delta == null || l.actual == null || l.plan == null) return DASH;
  switch (l.kind) {
    case "time":
    case "duration":
      return fmtDeltaMin(l.actual, l.plan);
    case "weight":
      return fmtDeltaKg(l.actual, l.plan, unit);
    case "distance":
      return fmtSigned(Math.round(l.delta), 0, "nm");
    case "altitude":
      return fmtSigned(Math.round(l.delta / 100) * 100, 0, "ft");
  }
}

/** "pünktlich (+4 min)" / "verspätet (+22 min)". */
export function fmtPunctuality(p: Punctuality | null, lang: Language = getLanguage()): string {
  if (!p) return DASH;
  const d = p.delayMin;
  return `${p.label} (${d > 0 ? "+" : d < 0 ? SEPARATORS[lang].minus : "±"}${Math.abs(d)} min)`;
}

// ---- integrity ---------------------------------------------------------------------------

/** Integrity findings in UI words (the given language), empty when the flight is clean. */
export function integrityIssues(i: IntegrityFlags, lang: Language = getLanguage()): string[] {
  return [
    i.slewDetected && tIn(lang, "logbook.integrity.slew"),
    i.timeAccelerationDetected && tIn(lang, "logbook.integrity.timeAccel", { rate: fmt(i.maxSimRate, 0, "", lang) }),
    i.crashed && tIn(lang, "logbook.integrity.crash"),
    i.fuelIncreasedAirborne && tIn(lang, "logbook.integrity.fuelIncreased"),
    i.teleportDetected && tIn(lang, "logbook.integrity.teleport"),
    i.pauseCount > 0 && tIn(lang, "logbook.integrity.pause", { n: i.pauseCount, duration: fmtDuration(i.pausedMs, {}, lang) }),
  ].filter((s): s is string => typeof s === "string");
}

// ---- PIREP -------------------------------------------------------------------------------

/** What the PIREP takes from the approach analysis of the landed approach (optional). */
export interface PirepApproach {
  /** "stabil ab" in ft above touchdown; null = never stable. */
  stableFromFt: number | null;
  band: ApproachBand | null;
}

export interface PirepMeta {
  appVersion?: string | null;
  /** Track of the flight (fuel at takeoff/landing for the trip fuel). */
  track?: readonly TrackSample[] | null;
  /** Unit of the text version (JSON is always kg). */
  weightUnit?: WeightUnit;
  /** Language of the text version and of the integrity findings (default: the UI language). */
  lang?: Language;
}

/** `pirep/v1`: stable keys, null for unknown values, times ISO 8601 UTC, weights kg. */
export interface PirepJson {
  schema: typeof PIREP_SCHEMA;
  generator: { name: "VectaSim"; version: string | null };
  flightId: string;
  callsign: string | null;
  flightNumber: string | null;
  departure: string | null;
  arrival: string | null;
  alternate: string | null;
  plannedDeparture: string | null;
  plannedArrival: string | null;
  date: string | null;
  times: {
    offBlock: string | null;
    takeoff: string | null;
    landing: string | null;
    onBlock: string | null;
    schedOut: string | null;
    schedIn: string | null;
    blockMin: number | null;
    airMin: number | null;
    taxiOutMin: number | null;
    taxiInMin: number | null;
    plannedBlockMin: number | null;
    plannedAirMin: number | null;
  };
  distanceNm: number | null;
  plannedDistanceNm: number | null;
  greatCircleNm: number | null;
  maxAltitudeFt: number | null;
  plannedCruiseFt: number | null;
  fuel: {
    unit: "kg";
    start: number | null;
    end: number | null;
    used: number | null;
    trip: number | null;
    tripEstimated: boolean;
    plannedTrip: number | null;
    plannedRamp: number | null;
    landing: number | null;
    plannedLanding: number | null;
  };
  landing: {
    rateFpm: number | null;
    rateSource: "sim" | "measured" | null;
    maxG: number | null;
    bounces: number | null;
    touchdowns: number;
    stableFromFt: number | null;
    approachBand: ApproachBand | null;
  };
  punctuality: {
    thresholdMin: number;
    delayOutMin: number | null;
    delayInMin: number | null;
    status: PunctualityStatus | null;
  };
  integrity: {
    clean: boolean;
    issues: string[];
    pausedS: number;
    pauseCount: number;
    slew: boolean;
    timeAcceleration: boolean;
    maxSimRate: number;
    crashed: boolean;
    fuelIncreasedAirborne: boolean;
    teleport: boolean;
  };
  aircraft: { title: string | null; icao: string | null; registration: string | null };
  sim: { name: string | null; provider: string | null };
}

export interface Pirep {
  json: PirepJson;
  text: string;
}

const iso = (ms: number | null | undefined) => (pos(ms) != null ? new Date(ms as number).toISOString().replace(/\.\d{3}Z$/, "Z") : null);
const minutes = (ms: number | null | undefined) => (isNum(ms) ? Math.round(ms / 60000) : null);
const round = (n: number | null | undefined, digits = 0) => (isNum(n) ? Number(n.toFixed(digits)) : null);
const str = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

/** The touchdown the flight is judged by: the last full stop (else the last contact). */
function judgedTouchdown(tds: readonly TouchdownReport[]): TouchdownReport | null {
  for (let i = tds.length - 1; i >= 0; i--) if (!tds[i].touchAndGo) return tds[i];
  return tds.length ? tds[tds.length - 1] : null;
}

/**
 * PIREP of a logged flight as text (for VA forms, copied to the clipboard) and as JSON
 * (`pirep/v1`). `plan` is the attached OFP (null without one); `landing` the landed approach
 * from the approach analysis, if known.
 */
export function buildPirep(detail: FlightDetail, plan: Ofp | null, landing?: PirepApproach | null, meta: PirepMeta = {}): Pirep {
  const row = detail.flight;
  const lang = meta.lang ?? getLanguage();
  const pva = planVsActual(actualFromRow(row, meta.track), planFromRow(row), plan, lang);
  const L = pva.byKey;
  const td = judgedTouchdown(detail.touchdowns);
  const issues = integrityIssues(row.integrity, lang);
  const i = row.integrity;

  // "DLH4YA" from the OFP, else the flight number the sim reports (its airline is a name, not a code)
  const flightNumber = str(plan?.flightNumber) ? `${plan?.airlineIcao ?? ""}${plan?.flightNumber}` : str(row.aircraft.atcFlightNumber);
  const gc =
    isNum(row.depLat) && isNum(row.depLon) && isNum(row.arrLat) && isNum(row.arrLon) ? haversineNm(row.depLat, row.depLon, row.arrLat, row.arrLon) : null;
  const used = sub(row.fuelStartKg, row.fuelEndKg);

  const json: PirepJson = {
    schema: PIREP_SCHEMA,
    generator: { name: "VectaSim", version: str(meta.appVersion) },
    flightId: row.id,
    callsign: str(plan?.callsign) ?? str(callsignOf(row)),
    flightNumber,
    departure: str(row.depIcao),
    arrival: str(row.arrIcao),
    alternate: str(plan?.alternateIcao),
    plannedDeparture: str(plan?.originIcao) ?? str(row.plannedDep),
    plannedArrival: str(plan?.destinationIcao) ?? str(row.plannedArr),
    date: iso(row.offBlockMs ?? row.createdMs)?.slice(0, 10) ?? null,
    times: {
      offBlock: iso(row.offBlockMs),
      takeoff: iso(row.takeoffMs),
      landing: iso(row.landingMs),
      onBlock: iso(row.onBlockMs),
      schedOut: iso(L.offBlock?.plan),
      schedIn: iso(L.onBlock?.plan),
      blockMin: minutes(L.block?.actual),
      airMin: minutes(L.air?.actual),
      taxiOutMin: minutes(L.taxiOut?.actual),
      taxiInMin: minutes(L.taxiIn?.actual),
      plannedBlockMin: minutes(L.block?.plan),
      plannedAirMin: minutes(L.air?.plan),
    },
    distanceNm: round(row.distanceNm, 1),
    plannedDistanceNm: round(L.distance?.plan, 0),
    greatCircleNm: round(gc, 1),
    maxAltitudeFt: round(row.maxAltMslFt, 0),
    plannedCruiseFt: round(L.cruise?.plan, 0),
    fuel: {
      unit: "kg",
      start: round(row.fuelStartKg),
      end: round(row.fuelEndKg),
      used: round(used),
      trip: round(L.tripFuel?.actual),
      tripEstimated: !!L.tripFuel?.approx,
      plannedTrip: round(L.tripFuel?.plan),
      plannedRamp: round(L.fuelStart?.plan),
      landing: round(L.landingFuel?.actual),
      plannedLanding: round(L.landingFuel?.plan),
    },
    landing: {
      rateFpm: round(row.landingVsFpm ?? td?.landingRateFpm),
      rateSource: td?.landingRateSource ?? null,
      maxG: round(td?.peakG, 2),
      bounces: td ? td.bounces : null,
      touchdowns: detail.touchdowns.length,
      stableFromFt: landing ? round(landing.stableFromFt) : null,
      approachBand: landing?.band ?? null,
    },
    punctuality: {
      thresholdMin: ON_TIME_THRESHOLD_MIN,
      delayOutMin: pva.delayOutMin,
      delayInMin: pva.delayInMin,
      status: pva.headline?.status ?? null,
    },
    integrity: {
      clean: issues.length === 0,
      issues,
      pausedS: Math.round(i.pausedMs / 1000),
      pauseCount: i.pauseCount,
      slew: i.slewDetected,
      timeAcceleration: i.timeAccelerationDetected,
      maxSimRate: i.maxSimRate,
      crashed: i.crashed,
      fuelIncreasedAirborne: i.fuelIncreasedAirborne,
      teleport: !!i.teleportDetected,
    },
    aircraft: {
      title: str(row.aircraft.title),
      icao: str(plan?.aircraftIcao) ?? str(row.aircraft.atcModel),
      registration: str(row.airframeReg) ?? str(row.aircraft.atcId) ?? str(plan?.registration),
    },
    sim: { name: str(row.simName), provider: str(row.provider) },
  };

  return { json, text: pirepText(json, pva, meta.weightUnit ?? "kg", lang) };
}

// The text goes into foreign web forms: plain ASCII digits, "-" as minus, "." as decimal point,
// UTC clock times "08:15z" regardless of the time preference. Labels in the UI language
// (German labels keep their English twin, "Datum / Date"); numbers go in as strings so the
// placeholders do not group them.
const z = (isoTime: string | null) => (isoTime ? `${isoTime.slice(11, 16)}z` : "--:--");
const hmm = (min: number | null) => (min == null ? "-:--" : `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`);
const signed = (n: number | null, unit: string) => (n == null ? "-" : `${n > 0 ? "+" : ""}${n} ${unit}`);
const LB_PER_KG = 1 / 0.45359237;

function pirepText(p: PirepJson, pva: PlanVsActual, unit: WeightUnit, lang: Language): string {
  const tr = (key: TKey, vars?: Vars) => translate(RESOURCES, lang, key, vars);
  const w = (kg: number | null) => (kg == null ? "-" : `${Math.round(unit === "lb" ? kg * LB_PER_KG : kg)}`);
  const or = (s: string | null) => s ?? "-";
  const t = p.times;
  const f = p.fuel;
  const l = p.landing;
  const date = p.times.offBlock
    ? fmtDate(Date.parse(p.times.offBlock), { local: false, lang })
    : p.date
      ? lang === "de"
        ? p.date.split("-").reverse().join(".")
        : p.date
      : "-";
  const plan = (s: string) => ` (${tr("logbook.pirep.plan", { value: s })})`;
  const lines: [string, string][] = [
    ["Callsign", or(p.callsign)],
    [tr("logbook.pirep.flightNo"), or(p.flightNumber)],
    ["DEP / ARR", `${or(p.departure)} - ${or(p.arrival)}${p.alternate ? ` (ALTN ${p.alternate})` : ""}`],
    [tr("logbook.pirep.date"), tr("logbook.pirep.dateUtc", { date })],
    ["OUT / OFF / ON / IN", `${z(t.offBlock)} / ${z(t.takeoff)} / ${z(t.landing)} / ${z(t.onBlock)}`],
  ];
  if (t.schedOut || t.schedIn) lines.push(["STD / STA", `${z(t.schedOut)} / ${z(t.schedIn)}`]);
  lines.push(
    ["Block / Air", `${hmm(t.blockMin)} / ${hmm(t.airMin)}${t.plannedBlockMin != null ? plan(`${hmm(t.plannedBlockMin)} / ${hmm(t.plannedAirMin)}`) : ""}`],
    ["Taxi out / in", `${t.taxiOutMin ?? "-"} / ${t.taxiInMin ?? "-"} min`],
    [tr("logbook.pirep.distance"), `${p.distanceNm != null ? Math.round(p.distanceNm) : "-"} nm${p.plannedDistanceNm != null ? plan(`${p.plannedDistanceNm} nm`) : ""}`],
    ["Max. Alt", `${p.maxAltitudeFt ?? "-"} ft${p.plannedCruiseFt != null ? plan(`FL${Math.round(p.plannedCruiseFt / 100)}`) : ""}`],
    ["Fuel Start / End", `${w(f.start)} / ${w(f.end)} ${unit} (Block ${w(f.used)} ${unit})`],
    [
      "Trip Fuel",
      `${f.trip != null ? (f.tripEstimated ? tr("logbook.pirep.approx", { value: `${w(f.trip)} ${unit}` }) : `${w(f.trip)} ${unit}`) : "-"}${f.plannedTrip != null ? plan(`${w(f.plannedTrip)} ${unit}`) : ""}`,
    ],
    [tr("logbook.pirep.landingRate"), `${l.rateFpm != null ? `${l.rateFpm} fpm` : "-"} | max. ${l.maxG != null ? l.maxG.toFixed(2) : "-"} g | Bounces ${l.bounces ?? "-"}`],
  );
  if (l.stableFromFt !== null || l.approachBand)
    lines.push([tr("logbook.pirep.approach"), l.stableFromFt != null ? tr("logbook.pirep.stableFrom", { alt: String(l.stableFromFt) }) : tr("logbook.pirep.neverStable")]);
  const pu = pva.headline;
  lines.push(
    [tr("logbook.pirep.punctuality"), pu ? `${pu.label} (${signed(pu.delayMin, "min")} ${tr(pu.event === "in" ? "logbook.pva.onBlock" : "logbook.pva.offBlock")})` : "-"],
    [tr("logbook.pirep.integrity"), p.integrity.clean ? "OK" : p.integrity.issues.join(", ")],
    ["Sim", or(p.sim.name ?? p.sim.provider)],
    [tr("logbook.pirep.aircraft"), [p.aircraft.icao, p.aircraft.title].filter(Boolean).join(" - ") || "-"],
    [tr("logbook.pirep.registration"), or(p.aircraft.registration)],
  );
  const width = Math.max(...lines.map(([k]) => k.length));
  const body = lines.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join("\n");
  return `PIREP${p.callsign ? ` ${p.callsign}` : ""}\n${body}\n-- VectaSim${p.generator.version ? ` ${p.generator.version}` : ""} (${p.schema})\n`;
}

/** Default file name of the PIREP JSON: "pirep-EDDF-LIRF-2026-10-16.json". */
export function pirepFileName(p: PirepJson, lang: Language = getLanguage()): string {
  const safe = (s: string | null) => (s ?? "XXXX").replace(/[^A-Za-z0-9_-]/g, "");
  return `pirep-${safe(p.departure ?? p.plannedDeparture)}-${safe(p.arrival ?? p.plannedArrival)}-${p.date ?? tIn(lang, "logbook.pirep.undated")}.json`;
}
