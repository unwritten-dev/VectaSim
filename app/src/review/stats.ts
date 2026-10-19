// Jahresrückblick („Dein Jahr 2026“): everything the story cards show, aggregated in the
// frontend from the existing commands (`list_flights`, `landing_facts_recent`,
// `approach_facts_recent`, `visited_countries`). Pure (stats.test.ts).
//
// Rules (the same as everywhere else in the logbook):
// - Demo flights (provider mock/replay) only count with „Demo-Flüge einbeziehen“ (countedFlights).
// - Flights still in progress (`state = active`) do not count yet.
// - Imported flights (`provider = import:*`) count for hours, distance, routes, fleet, months,
//   airports and countries – never for landings or approaches (their landing rate is a typed
//   value, not a measurement).
// - A flight belongs to the period by its off-block time (else take-off, landing, on-block,
//   creation), in UTC or local time like the rest of the app (`local`).

import type { FlightRow } from "../types";
import type { ApproachFact } from "../landing/approachTypes";
import type { Band, RunwayFact } from "../landing/types";
import type { CountryVisit } from "../countries/countries";
import { vsBandOf } from "../landing/facts";
import { median } from "../landing/history";
import { approachSummary } from "../landing/approachStats";
import { tdzRate } from "../landing/dispersionStats";
import { countedFlights, isDemoRow, isImportedRow } from "../totals";
import { effectiveAircraftTitle, effectiveArr, effectiveDep, effectiveRegistration } from "../logbookFilter";
import { LOCALE, getLanguage, t, tIn, type Language } from "../i18n";

/** Equatorial circumference of the earth in nm (40 075 km). */
export const EARTH_NM = 21_639;

export type PeriodMode = "year" | "last12";

export interface MonthBucket {
  /** "2026-07" */
  key: string;
  year: number;
  /** 0–11 */
  month: number;
  startMs: number;
  endMs: number;
}

export interface Period {
  mode: PeriodMode;
  /** Calendar year, or the year the 12 months end in. */
  year: number;
  /** Inclusive start, exclusive end. */
  startMs: number;
  endMs: number;
  local: boolean;
  months: MonthBucket[];
}

/** Month names from Intl.DateTimeFormat, cached per language and width. */
const monthCache = new Map<string, string[]>();
function monthNames(lang: Language, width: "long" | "short"): string[] {
  const key = `${lang}:${width}`;
  let names = monthCache.get(key);
  if (!names) {
    const f = new Intl.DateTimeFormat(LOCALE[lang], { month: width, timeZone: "UTC" });
    // short: three letters without the dot ("Mär", "Sep" / "Mar", "Sep"), as on the cards so far
    names = Array.from({ length: 12 }, (_, m) => {
      const s = f.format(Date.UTC(2000, m, 15));
      return width === "short" ? s.replace(/\.$/, "").slice(0, 3) : s;
    });
    monthCache.set(key, names);
  }
  return names;
}

/** "Januar" / "January". */
export const monthName = (m: number, lang: Language = getLanguage()): string => monthNames(lang, "long")[((m % 12) + 12) % 12];
/** "Jan", "Mär" / "Jan", "Mar". */
export const monthShort = (m: number, lang: Language = getLanguage()): string => monthNames(lang, "short")[((m % 12) + 12) % 12];

const monthStart = (y: number, m: number, local: boolean): number => (local ? new Date(y, m, 1).getTime() : Date.UTC(y, m, 1));

function ymd(ms: number, local: boolean): { y: number; m: number; d: number } {
  const t = new Date(ms);
  return local ? { y: t.getFullYear(), m: t.getMonth(), d: t.getDate() } : { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}

function months(y0: number, m0: number, n: number, local: boolean): MonthBucket[] {
  const out: MonthBucket[] = [];
  for (let i = 0; i < n; i++) {
    const y = y0 + Math.floor((m0 + i) / 12);
    const m = (m0 + i) % 12;
    out.push({ key: `${y}-${String(m + 1).padStart(2, "0")}`, year: y, month: m, startMs: monthStart(y, m, local), endMs: monthStart(m === 11 ? y + 1 : y, (m + 1) % 12, local) });
  }
  return out;
}

/**
 * The period of the review: a calendar year, or the last 12 calendar months up to and
 * including the month of `nowMs` („letzte 12 Monate“, Nov 2025 – Okt 2026).
 */
export function periodOf(mode: PeriodMode, year: number, nowMs: number, local: boolean): Period {
  if (mode === "year") {
    const ms = months(year, 0, 12, local);
    return { mode, year, startMs: ms[0].startMs, endMs: ms[11].endMs, local, months: ms };
  }
  const now = ymd(nowMs, local);
  const total = now.y * 12 + now.m - 11;
  const ms = months(Math.floor(total / 12), total % 12, 12, local);
  return { mode, year: now.y, startMs: ms[0].startMs, endMs: ms[11].endMs, local, months: ms };
}

/** "2026" / "Nov 2025 – Okt 2026" ("Nov 2025 – Oct 2026"). */
export function periodLabel(p: Period, lang: Language = getLanguage()): string {
  if (p.mode === "year") return String(p.year);
  const a = p.months[0];
  const b = p.months[11];
  return `${monthShort(a.month, lang)} ${a.year} – ${monthShort(b.month, lang)} ${b.year}`;
}

/** Headline above every card: „Dein Jahr 2026“ / „Deine letzten 12 Monate“ ("Your year 2026"). */
export const periodTitle = (p: Period, lang: Language = getLanguage()): string =>
  p.mode === "year" ? tIn(lang, "review.periodTitle.year", { year: String(p.year) }) : tIn(lang, "review.periodTitle.last12");

export const inPeriod = (ms: number | null | undefined, p: Pick<Period, "startMs" | "endMs">): boolean => typeof ms === "number" && ms >= p.startMs && ms < p.endMs;

/** When the flight happened: off-block, else take-off, landing, on-block, creation. */
export function flightTimeMs(f: Pick<FlightRow, "offBlockMs" | "takeoffMs" | "landingMs" | "onBlockMs" | "createdMs">): number {
  return f.offBlockMs ?? f.takeoffMs ?? f.landingMs ?? f.onBlockMs ?? f.createdMs;
}

/** Block time, else air time, else 0. */
export function blockMsOf(f: Pick<FlightRow, "offBlockMs" | "onBlockMs" | "takeoffMs" | "landingMs">): number {
  if (f.onBlockMs != null && f.offBlockMs != null) return Math.max(0, f.onBlockMs - f.offBlockMs);
  if (f.landingMs != null && f.takeoffMs != null) return Math.max(0, f.landingMs - f.takeoffMs);
  return 0;
}

/** Flights the review counts at all: demo by the setting, not the one still in progress. */
export function reviewFlights(rows: FlightRow[], showDemo: boolean): FlightRow[] {
  return countedFlights(rows, showDemo).filter((f) => f.state !== "active");
}

/** Years with at least one counted flight, newest first. */
export function yearsWithFlights(rows: FlightRow[], showDemo: boolean, local: boolean): number[] {
  const ys = new Set<number>();
  for (const f of reviewFlights(rows, showDemo)) ys.add(ymd(flightTimeMs(f), local).y);
  return [...ys].sort((a, b) => b - a);
}

/** ICAO designator in an MSFS ATC model ("TT:ATCCOM.AC_MODEL_A20N.0.text", "$$:B738"); as map/aircraftIcons.ts. */
function icaoFromAtcModel(raw: string): string {
  const m = /AC_MODEL_([A-Z0-9]{2,4})/i.exec(raw);
  if (m) return m[1].toUpperCase();
  const t = raw.replace(/^\$\$:/, "").trim().toUpperCase();
  return /^[A-Z0-9]{2,4}$/.test(t) ? t : "";
}

/** Aircraft type: ICAO designator from the ATC model, else the model text, else the title. */
export function typeOf(f: FlightRow): string {
  const m = f.aircraft?.atcModel ?? "";
  return icaoFromAtcModel(m) || m.replace(/^TT:ATCCOM\.(AC_MODEL|ATC_NAME)[ _]?/i, "").split(".")[0].trim() || effectiveAircraftTitle(f).trim() || t("review.unknownType");
}

const icao = (s: string | null | undefined): string | null => {
  const v = s?.trim().toUpperCase();
  return v ? v : null;
};

// ---- result -----------------------------------------------------------------------------

export type LonLat = [number, number];

export interface RouteStat {
  dep: string;
  arr: string;
  flights: number;
  blockMs: number;
  /** Longest recorded distance of the route, nm. */
  distanceNm: number;
}

export interface Leg {
  dep: string;
  arr: string;
  from: LonLat;
  to: LonLat;
  flights: number;
}

export interface FlightPick {
  flightId: string;
  dep: string | null;
  arr: string | null;
  distanceNm: number;
  blockMs: number;
  ms: number;
}

export interface FleetStat {
  key: string;
  /** Most used aircraft title of the type / the type of the registration. */
  detail: string;
  flights: number;
  blockMs: number;
  /** Registration of the airframe (fleet by registration), for masking. */
  registration?: string;
}

export interface LandingPick {
  flightId: string;
  ms: number;
  fpm: number;
  airport: string | null;
  runway: string | null;
}

export interface LandingPoint {
  /** Metres past the threshold. */
  x: number;
  /** Metres from the centreline, + = right; null = not measurable. */
  y: number | null;
  band: Band;
  fpm: number;
  inZone: boolean;
}

export interface LandingYear {
  /** Landings that count: runway facts plus flights with only a landing rate. */
  count: number;
  /** Median |landing rate|, fpm (positive). */
  medianFpm: number | null;
  best: LandingPick | null;
  hardest: LandingPick | null;
  bands: Record<Band, number>;
  /** Touchdown points with a runway (the year's Streubild). */
  points: LandingPoint[];
  tdz: { inZone: number; total: number; rate: number | null };
  /** Flights with a landing rate but no runway fact (no matched runway, older than the facts window). */
  rateOnly: number;
  /** The facts window (newest 200) does not reach back to the period start: the Streubild may miss older landings. */
  partial: boolean;
}

export interface ApproachYear {
  count: number;
  /** Approaches with a band (assessed below 1000 ft). */
  assessed: number;
  stable: number;
  stableRate: number | null;
  meanStableFromFt: number | null;
  goArounds: number;
  bands: { stable: number; deviations: number; unstable: number };
  partial: boolean;
}

/**
 * „Mit Sternchen“: recorded flights with pause, time acceleration, slew or a position jump
 * (IntegrityFlags of the flight row). Imported flights carry no such flags and are left out.
 */
export interface FlagYear {
  /** Recorded (not imported) flights of the period. */
  recorded: number;
  /** Recorded flights with at least one flag. */
  flights: number;
  paused: number;
  /** Sum of the paused time, ms. */
  pausedMs: number;
  timeAccel: number;
  /** Highest simulation rate seen (1 = none). */
  maxSimRate: number;
  slew: number;
  teleport: number;
}

export interface MonthStat extends MonthBucket {
  flights: number;
  blockMs: number;
  distanceNm: number;
}

export interface DayStat {
  /** Start of the day (UTC / local midnight). */
  ms: number;
  flights: number;
  blockMs: number;
}

export interface CountryYear {
  iso2: string;
  flights: number;
  /** First landing there ever falls into the period. */
  isNew: boolean;
}

export interface YearReview {
  period: Period;
  flights: number;
  imported: number;
  blockMs: number;
  distanceNm: number;
  /** distance / earth circumference */
  earthLaps: number;
  airports: number;
  countries: CountryYear[];
  newCountries: number;
  routes: RouteStat[];
  routeCount: number;
  longest: FlightPick | null;
  legs: Leg[];
  types: FleetStat[];
  registrations: FleetStat[];
  landings: LandingYear;
  approaches: ApproachYear;
  flags: FlagYear;
  months: MonthStat[];
  /** Index into `months`; null without flights. */
  busiestMonth: number | null;
  busiestDay: DayStat | null;
}

export interface ReviewInput {
  flights: FlightRow[];
  /** `landing_facts_recent` (newest first). */
  landings: RunwayFact[];
  /** `approach_facts_recent` (newest first). */
  approaches: ApproachFact[];
  /** `visited_countries` → countries. */
  visits: CountryVisit[];
  /** Airport coordinates for flights without recorded dep/arr positions (imports). */
  coords?: Map<string, LonLat>;
  showDemo: boolean;
}

/** Facts window of the backend (`FACTS_MAX_LIMIT`). */
export const FACTS_WINDOW = 200;

const TOP_N = 5;

const byFlightsThenHours = <T extends { flights: number; blockMs: number }>(a: T, b: T) => b.flights - a.flights || b.blockMs - a.blockMs;
const byHoursThenFlights = <T extends { flights: number; blockMs: number }>(a: T, b: T) => b.blockMs - a.blockMs || b.flights - a.flights;

const isImportProvider = (p: string | null | undefined) => p?.startsWith("import:") ?? false;
const isDemoProvider = (p: string | null | undefined) => p === "mock" || p === "replay";

/** Measured landings/approaches that count: no import, demo only with the setting. */
const measuredFact = (provider: string | null | undefined, showDemo: boolean) => !isImportProvider(provider) && (showDemo || !isDemoProvider(provider));

export function buildReview(input: ReviewInput, period: Period): YearReview {
  const { showDemo } = input;
  const local = period.local;
  const all = reviewFlights(input.flights, showDemo);
  const rows = all.filter((f) => inPeriod(flightTimeMs(f), period));
  const ids = new Set(rows.map((f) => f.id));

  // ---- totals, airports
  let blockMs = 0;
  let distanceNm = 0;
  const airports = new Set<string>();
  for (const f of rows) {
    blockMs += blockMsOf(f);
    distanceNm += f.distanceNm || 0;
    const d = icao(effectiveDep(f));
    const a = icao(effectiveArr(f));
    if (d) airports.add(d);
    if (a) airports.add(a);
  }

  // ---- routes, legs, longest
  const routes = new Map<string, RouteStat>();
  const legs = new Map<string, Leg>();
  let longest: FlightPick | null = null;
  for (const f of rows) {
    const dep = icao(effectiveDep(f));
    const arr = icao(effectiveArr(f));
    const nm = f.distanceNm || 0;
    if (nm > 0 && (!longest || nm > longest.distanceNm)) longest = { flightId: f.id, dep, arr, distanceNm: nm, blockMs: blockMsOf(f), ms: flightTimeMs(f) };
    if (!dep || !arr || dep === arr) continue;
    const key = `${dep}>${arr}`;
    const r = routes.get(key) ?? { dep, arr, flights: 0, blockMs: 0, distanceNm: 0 };
    r.flights += 1;
    r.blockMs += blockMsOf(f);
    r.distanceNm = Math.max(r.distanceNm, nm);
    routes.set(key, r);
    // the recorded position only belongs to the recorded airport, not to a correction
    const from: LonLat | null = f.depLat != null && f.depLon != null && dep === icao(f.depIcao) ? [f.depLon, f.depLat] : (input.coords?.get(dep) ?? null);
    const to: LonLat | null = f.arrLat != null && f.arrLon != null && arr === icao(f.arrIcao) ? [f.arrLon, f.arrLat] : (input.coords?.get(arr) ?? null);
    if (from && to) {
      const lk = dep < arr ? `${dep}|${arr}` : `${arr}|${dep}`;
      const l = legs.get(lk) ?? { dep, arr, from, to, flights: 0 };
      l.flights += 1;
      legs.set(lk, l);
    }
  }
  const routeList = [...routes.values()].sort((a, b) => byFlightsThenHours(a, b) || b.distanceNm - a.distanceNm || `${a.dep}${a.arr}`.localeCompare(`${b.dep}${b.arr}`));

  // ---- fleet
  const types = new Map<string, FleetStat & { titles: Map<string, number> }>();
  const regs = new Map<string, FleetStat>();
  for (const f of rows) {
    const t = typeOf(f);
    const ty = types.get(t) ?? { key: t, detail: "", flights: 0, blockMs: 0, titles: new Map() };
    ty.flights += 1;
    ty.blockMs += blockMsOf(f);
    const title = effectiveAircraftTitle(f).trim();
    if (title && title !== t) ty.titles.set(title, (ty.titles.get(title) ?? 0) + 1);
    types.set(t, ty);
    const reg = effectiveRegistration(f).trim().toUpperCase();
    if (reg) {
      const r = regs.get(reg) ?? { key: reg, detail: t, flights: 0, blockMs: 0, registration: reg };
      r.flights += 1;
      r.blockMs += blockMsOf(f);
      regs.set(reg, r);
    }
  }
  const typeList: FleetStat[] = [...types.values()]
    .sort((a, b) => byHoursThenFlights(a, b) || a.key.localeCompare(b.key))
    .slice(0, TOP_N)
    .map(({ titles, ...s }) => ({ ...s, detail: [...titles.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "" }));
  const regList = [...regs.values()].sort((a, b) => byHoursThenFlights(a, b) || a.key.localeCompare(b.key)).slice(0, TOP_N);

  // ---- landings (measured only)
  const facts = input.landings.filter((x) => measuredFact(x.provider, showDemo) && inPeriod(x.timestampMs, period));
  const factFlights = new Set(facts.map((x) => x.flightId));
  const rateOnly = rows.filter((f) => !isImportedRow(f) && f.landingVsFpm != null && !factFlights.has(f.id));
  const picks: LandingPick[] = [
    ...facts.map((x) => ({ flightId: x.flightId, ms: x.timestampMs, fpm: x.landingRateFpm, airport: x.airportIcao || null, runway: x.runwayIdent || null })),
    ...rateOnly.map((f) => ({ flightId: f.id, ms: f.landingMs ?? flightTimeMs(f), fpm: f.landingVsFpm as number, airport: icao(effectiveArr(f)), runway: null })),
  ].filter((p) => Number.isFinite(p.fpm));
  const bands: Record<Band, number> = { smooth: 0, normal: 0, firm: 0, hard: 0 };
  let best: LandingPick | null = null;
  let hardest: LandingPick | null = null;
  for (const p of picks) {
    bands[vsBandOf(p.fpm)] += 1;
    if (!best || Math.abs(p.fpm) < Math.abs(best.fpm) || (Math.abs(p.fpm) === Math.abs(best.fpm) && p.ms < best.ms)) best = p;
    if (!hardest || Math.abs(p.fpm) > Math.abs(hardest.fpm) || (Math.abs(p.fpm) === Math.abs(hardest.fpm) && p.ms < hardest.ms)) hardest = p;
  }
  const oldestFact = input.landings.length ? Math.min(...input.landings.map((x) => x.timestampMs)) : Infinity;
  const landings: LandingYear = {
    count: picks.length,
    medianFpm: median(picks.map((p) => Math.abs(p.fpm))),
    best,
    hardest,
    bands,
    points: facts
      .filter((x) => Number.isFinite(x.touchdownDistanceM))
      .map((x) => ({
        x: x.touchdownDistanceM,
        y: typeof x.centerlineOffsetM === "number" && Number.isFinite(x.centerlineOffsetM) ? x.centerlineOffsetM : null,
        band: vsBandOf(x.landingRateFpm),
        fpm: x.landingRateFpm,
        inZone: x.inTouchdownZone,
      })),
    tdz: tdzRate(facts),
    rateOnly: rateOnly.length,
    partial: input.landings.length >= FACTS_WINDOW && oldestFact > period.startMs,
  };

  // ---- approaches (measured only)
  const aFacts = input.approaches.filter((x) => measuredFact(x.provider, showDemo) && inPeriod(x.endedMs, period));
  const sum = approachSummary(aFacts);
  const withBand = aFacts.filter((x) => x.band != null);
  const stable = withBand.filter((x) => x.band === "stable").length;
  const oldestApproach = input.approaches.length ? Math.min(...input.approaches.map((x) => x.endedMs)) : Infinity;
  const approaches: ApproachYear = {
    count: aFacts.length,
    assessed: withBand.length,
    stable,
    stableRate: withBand.length ? stable / withBand.length : null,
    meanStableFromFt: sum.meanStableFromFt,
    goArounds: sum.goArounds,
    bands: {
      stable,
      deviations: withBand.filter((x) => x.band === "deviations").length,
      unstable: withBand.filter((x) => x.band === "unstable" || x.band === "unstableBelow500").length,
    },
    partial: input.approaches.length >= FACTS_WINDOW && oldestApproach > period.startMs,
  };

  // ---- flags („Mit Sternchen“)
  const flags = flagStats(rows);

  // ---- months, busiest day
  const monthStats: MonthStat[] = period.months.map((m) => ({ ...m, flights: 0, blockMs: 0, distanceNm: 0 }));
  const days = new Map<number, DayStat>();
  for (const f of rows) {
    const ms = flightTimeMs(f);
    const m = monthStats.find((b) => ms >= b.startMs && ms < b.endMs);
    if (m) {
      m.flights += 1;
      m.blockMs += blockMsOf(f);
      m.distanceNm += f.distanceNm || 0;
    }
    const d = ymd(ms, local);
    const day = local ? new Date(d.y, d.m, d.d).getTime() : Date.UTC(d.y, d.m, d.d);
    const ds = days.get(day) ?? { ms: day, flights: 0, blockMs: 0 };
    ds.flights += 1;
    ds.blockMs += blockMsOf(f);
    days.set(day, ds);
  }
  let busiestMonth: number | null = null;
  monthStats.forEach((m, i) => {
    if (m.flights === 0) return;
    if (busiestMonth == null || byFlightsThenHours(m, monthStats[busiestMonth]) < 0) busiestMonth = i;
  });
  const busiestDay = [...days.values()].sort((a, b) => byFlightsThenHours(a, b) || a.ms - b.ms)[0] ?? null;

  // ---- countries (arrivals of completed flights, as the Länder view)
  const timeOf = new Map(all.map((f) => [f.id, flightTimeMs(f)]));
  const countries: CountryYear[] = [];
  for (const v of input.visits) {
    const here = v.flightIds.filter((id) => ids.has(id));
    if (!here.length) continue;
    const before = v.flightIds.some((id) => {
      const t = timeOf.get(id);
      return t != null && t < period.startMs;
    });
    countries.push({ iso2: v.iso2, flights: here.length, isNew: !before });
  }
  countries.sort((a, b) => b.flights - a.flights || a.iso2.localeCompare(b.iso2));

  return {
    period,
    flights: rows.length,
    imported: rows.filter(isImportedRow).length,
    blockMs,
    distanceNm,
    earthLaps: distanceNm / EARTH_NM,
    airports: airports.size,
    countries,
    newCountries: countries.filter((c) => c.isNew).length,
    routes: routeList.slice(0, TOP_N),
    routeCount: routeList.length,
    longest,
    legs: [...legs.values()].sort((a, b) => b.flights - a.flights),
    types: typeList,
    registrations: regList,
    landings,
    approaches,
    flags,
    months: monthStats,
    busiestMonth,
    busiestDay,
  };
}

/** Pause, time acceleration, slew and position jumps of the recorded flights (imports carry no flags). */
export function flagStats(rows: FlightRow[]): FlagYear {
  const out: FlagYear = { recorded: 0, flights: 0, paused: 0, pausedMs: 0, timeAccel: 0, maxSimRate: 1, slew: 0, teleport: 0 };
  for (const f of rows) {
    if (isImportedRow(f)) continue;
    out.recorded += 1;
    const i = f.integrity ?? ({} as Partial<FlightRow["integrity"]>);
    const pausedMs = Math.max(0, i.pausedMs ?? 0);
    // the same conditions as the marks in the flight list (FlightStrip.tsx)
    const paused = (i.pauseCount ?? 0) > 0 || pausedMs > 0;
    const accel = !!i.timeAccelerationDetected;
    const slew = !!i.slewDetected;
    const jump = !!i.teleportDetected;
    if (paused) {
      out.paused += 1;
      out.pausedMs += pausedMs;
    }
    if (accel) {
      out.timeAccel += 1;
      if (Number.isFinite(i.maxSimRate)) out.maxSimRate = Math.max(out.maxSimRate, i.maxSimRate as number);
    }
    if (slew) out.slew += 1;
    if (jump) out.teleport += 1;
    if (paused || accel || slew || jump) out.flights += 1;
  }
  return out;
}

/** Demo flights the review leaves out (hint below the cards). */
export const demoLeftOut = (rows: FlightRow[], showDemo: boolean): number => (showDemo ? 0 : rows.filter(isDemoRow).length);
