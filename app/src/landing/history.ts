// "Du gegen dich": a landing / approach compared with the pilot's own history, trends over
// time and the touchdowns of one flight as a series (circuits). Pure (history.test.ts).
//
// Input are the cached facts (`landing_facts_recent`, `approach_facts_recent`, newest first).
// `null` always means "not measurable" and is left out of every median / quota – never
// counted as good or bad. The centreline offset is typed as a number in the backend mirror,
// but older caches may hold null, so it is treated as nullable here.

import type { LandingFact, TouchdownReport } from "../types";
import type { ApproachFact } from "./approachTypes";
import { isDerivedSource } from "./types";
import { isRated } from "./rated";
import { t } from "../i18n";
import { NNBSP, fmtNum } from "../i18n/number";

/** A landing fact whose centreline offset may be missing. */
export type HistLanding = Omit<LandingFact, "centerlineOffsetM"> & { centerlineOffsetM: number | null };

/** Comparison set: same runway (airport + ident), same aircraft type, or all landings. */
export type Scope = "runway" | "type" | "all";
export const SCOPES: Scope[] = ["runway", "type", "all"];

/** Below this many comparable landings no comparison is shown. */
export const MIN_PEERS = 3;
/** Default size of the comparison set ("deine letzten 20"). */
export const DEFAULT_PEERS = 20;

const isNum = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

// ---- statistics -------------------------------------------------------------------------

/** Quantile with linear interpolation (R type 7) of an ascending array. */
function quantileSorted(s: number[], p: number): number {
  if (s.length === 1) return s[0];
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo] + (s[hi] - s[lo]) * (h - lo);
}

export interface Quartiles {
  median: number | null;
  q1: number | null;
  q3: number | null;
  /** Measurable values (nulls / NaN left out). */
  n: number;
}

/** Median and quartiles of the measurable values. */
export function quartiles(xs: Array<number | null | undefined>): Quartiles {
  const s = xs.filter(isNum).sort((a, b) => a - b);
  if (s.length === 0) return { median: null, q1: null, q3: null, n: 0 };
  return { median: quantileSorted(s, 0.5), q1: quantileSorted(s, 0.25), q3: quantileSorted(s, 0.75), n: s.length };
}

export function median(xs: Array<number | null | undefined>): number | null {
  return quartiles(xs).median;
}

/**
 * Share of the peers the value beats, 0..1 ("besser als 70 %"): peers strictly worse count,
 * ties count half. `lowerIsBetter` for |fpm| and |centreline|. null without value or peers.
 */
export function percentileBetter(value: number | null | undefined, peers: Array<number | null | undefined>, lowerIsBetter: boolean): number | null {
  if (!isNum(value)) return null;
  const p = peers.filter(isNum);
  if (p.length === 0) return null;
  let score = 0;
  for (const x of p) {
    if (x === value) score += 0.5;
    else if (lowerIsBetter ? x > value : x < value) score += 1;
  }
  return score / p.length;
}

/** Share of `true` among the measurable booleans. */
export function quota(xs: Array<boolean | null | undefined>): { yes: number; total: number; rate: number | null } {
  const v = xs.filter((x): x is boolean => typeof x === "boolean");
  const yes = v.filter(Boolean).length;
  return { yes, total: v.length, rate: v.length ? yes / v.length : null };
}

// ---- keys and filters -------------------------------------------------------------------

/** Aircraft key: ICAO type, else the title, else "Unbekannt" / "Unknown" (as dispersionStats.aircraftKey). */
export function typeKey(f: { aircraftIcaoType?: string | null; aircraftTitle?: string | null }): string {
  return f.aircraftIcaoType?.trim() || f.aircraftTitle?.trim() || t("landingHistory.unknownType");
}

export const runwayKey = (f: { airportIcao?: string | null; runwayIdent?: string | null }): string | null =>
  f.airportIcao && f.runwayIdent ? `${f.airportIcao} ${f.runwayIdent}` : null;

export const isDemoFact = (f: { provider?: string | null }): boolean => f.provider === "mock" || f.provider === "replay";

/**
 * Peers of a demo landing are all facts; peers of a real one only the real ones unless demo
 * flights are shown – so the mock always has something to compare and demo never skews a real
 * pilot's numbers.
 */
export function demoFilter<T extends { provider?: string | null }>(facts: T[], current: { provider?: string | null } | null, showDemo: boolean): T[] {
  if (showDemo || (current && isDemoFact(current))) return facts;
  return facts.filter((f) => !isDemoFact(f));
}

export interface CompareOpts {
  sameRunway?: boolean;
  sameType?: boolean;
  /** Newest peers taken, default 20. */
  limit?: number;
}

export const scopeOpts = (scope: Scope, limit = DEFAULT_PEERS): CompareOpts => ({ sameRunway: scope === "runway", sameType: scope === "type", limit });

// ---- landing comparison -----------------------------------------------------------------

export interface MetricCompare {
  value: number | null;
  median: number | null;
  q1: number | null;
  q3: number | null;
  /** Peers with a measurable value. */
  n: number;
  /** Share of the peers this one beats, 0..1; null when "better" is undefined for the metric. */
  better: number | null;
  /** value − median (signed, in the metric's own sign). */
  delta: number | null;
}

function metric(value: number | null | undefined, peers: Array<number | null | undefined>, better: null | "lower" | "higher", key: (v: number) => number = (v) => v): MetricCompare {
  const q = quartiles(peers);
  const v = isNum(value) ? value : null;
  return {
    value: v,
    median: q.median,
    q1: q.q1,
    q3: q.q3,
    n: q.n,
    better: better == null || v == null ? null : percentileBetter(key(v), peers.filter(isNum).map(key), better === "lower"),
    delta: v != null && q.median != null ? v - q.median : null,
  };
}

export interface LandingComparison {
  /** Comparable landings (the current one excluded), newest first, at most `limit`. */
  peers: HistLanding[];
  n: number;
  /** Signed landing rate (fpm, negative = descending); `better` compares |fpm|, lower is better. */
  rate: MetricCompare;
  /** Metres behind the threshold; no "better" (the aim depends on the runway). */
  distance: MetricCompare;
  /** |Centreline offset| m; lower is better; null-safe. */
  centerline: MetricCompare;
  /** TDZ quota of the peers and whether this one was inside. */
  tdz: { current: boolean; yes: number; total: number; rate: number | null };
}

export const sameLanding = (a: Pick<LandingFact, "flightId" | "touchdownIndex">, b: Pick<LandingFact, "flightId" | "touchdownIndex">) =>
  a.flightId === b.flightId && a.touchdownIndex === b.touchdownIndex;

/** The landing compared with the pilot's other landings (same runway / same type / all). */
export function compareLanding(fact: HistLanding, facts: HistLanding[], opts: CompareOpts = {}): LandingComparison {
  const rk = runwayKey(fact);
  const tk = typeKey(fact);
  const peers = facts
    .filter((f) => !sameLanding(f, fact))
    .filter((f) => !opts.sameRunway || (rk != null && runwayKey(f) === rk))
    .filter((f) => !opts.sameType || typeKey(f) === tk)
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .slice(0, opts.limit ?? DEFAULT_PEERS);
  const abs = (v: number) => Math.abs(v);
  const cl = (v: number | null) => (isNum(v) ? Math.abs(v) : null);
  const t = quota(peers.map((f) => f.inTouchdownZone));
  return {
    peers,
    n: peers.length,
    rate: metric(fact.landingRateFpm, peers.map((f) => f.landingRateFpm), "lower", abs),
    distance: metric(fact.touchdownDistanceM, peers.map((f) => f.touchdownDistanceM), null),
    centerline: metric(cl(fact.centerlineOffsetM), peers.map((f) => cl(f.centerlineOffsetM)), "lower"),
    tdz: { current: fact.inTouchdownZone, ...t },
  };
}

// ---- approach comparison ----------------------------------------------------------------

export interface ApproachComparison {
  peers: ApproachFact[];
  n: number;
  /**
   * "stabil ab" (ft); higher is better. The median is over the peers that became stable; for
   * the percentile a never-stable approach ranks below every stable one.
   */
  stableFrom: MetricCompare;
  /** Assessed peers that never became stable. */
  neverStable: number;
  gate1000: { current: boolean | null; yes: number; total: number; rate: number | null };
  gate500: { current: boolean | null; yes: number; total: number; rate: number | null };
}

/** Assessed below 1000 ft (has a band) – the only approaches with a meaningful "stabil ab". */
const assessed = (f: ApproachFact) => f.band != null;

export function compareApproach(afact: ApproachFact, afacts: ApproachFact[], opts: CompareOpts = {}): ApproachComparison {
  const rk = runwayKey(afact);
  const tk = typeKey(afact);
  const peers = afacts
    .filter((f) => !(f.flightId === afact.flightId && f.approachIndex === afact.approachIndex))
    .filter(assessed)
    .filter((f) => !opts.sameRunway || (rk != null && runwayKey(f) === rk))
    .filter((f) => !opts.sameType || typeKey(f) === tk)
    .sort((a, b) => b.endedMs - a.endedMs)
    .slice(0, opts.limit ?? DEFAULT_PEERS);
  const q = quartiles(peers.map((f) => f.stableFromFt));
  const rank = (v: number | null) => (isNum(v) ? v : -1);
  const current = assessed(afact) ? rank(afact.stableFromFt) : null;
  const value = isNum(afact.stableFromFt) ? afact.stableFromFt : null;
  return {
    peers,
    n: peers.length,
    stableFrom: {
      value,
      median: q.median,
      q1: q.q1,
      q3: q.q3,
      n: q.n,
      better: current == null ? null : percentileBetter(current, peers.map((f) => rank(f.stableFromFt)), false),
      delta: value != null && q.median != null ? value - q.median : null,
    },
    neverStable: peers.filter((f) => f.stableFromFt == null).length,
    gate1000: { current: afact.g1000Pass, ...quota(peers.map((f) => f.g1000Pass)) },
    gate500: { current: afact.g500Pass, ...quota(peers.map((f) => f.g500Pass)) },
  };
}

/**
 * The approach that belongs to a landing: the given index, else the one that ended in this
 * touchdown, else the flight's last landed approach, else its last approach.
 */
export function approachFor(afacts: ApproachFact[], flightId: string, touchdownIndex?: number | null, approachIndex?: number | null): ApproachFact | null {
  const own = afacts.filter((f) => f.flightId === flightId).sort((a, b) => a.approachIndex - b.approachIndex);
  if (own.length === 0) return null;
  if (approachIndex != null) return own.find((f) => f.approachIndex === approachIndex) ?? null;
  if (touchdownIndex != null) {
    const hit = own.find((f) => f.touchdownIndex === touchdownIndex);
    if (hit) return hit;
  }
  const landed = own.filter((f) => f.outcome === "landed");
  return landed[landed.length - 1] ?? own[own.length - 1];
}

/** The landing fact of a flight: the given touchdown, else its last one with a fact. */
export function landingFor(facts: HistLanding[], flightId: string, touchdownIndex?: number | null): HistLanding | null {
  const own = facts.filter((f) => f.flightId === flightId);
  if (touchdownIndex != null) return own.find((f) => f.touchdownIndex === touchdownIndex) ?? null;
  return own.reduce<HistLanding | null>((best, f) => (best == null || f.touchdownIndex > best.touchdownIndex ? f : best), null);
}

/** First scope with enough peers (runway → type → all); "all" when none has. */
export function defaultScope(fact: HistLanding, facts: HistLanding[], limit = DEFAULT_PEERS): Scope {
  for (const s of SCOPES) if (compareLanding(fact, facts, scopeOpts(s, limit)).n >= MIN_PEERS) return s;
  return "all";
}

// ---- trends -----------------------------------------------------------------------------

export type Bucket = "flight" | "week" | "month";

export interface TrendPoint {
  /** Landing key ("flightId#index"), ISO week ("2026-W42") or month ("2026-10"). */
  key: string;
  /** Start of the bucket / time of the landing, epoch ms. */
  tMs: number;
  /** Values that went into the point. */
  n: number;
  /** Per landing: the value; per bucket: the median (TDZ: the quota 0..1). */
  value: number | null;
  /** Moving median of the last `window` point values (TDZ: moving quota). */
  rolling: number | null;
  /** Spread of the bucket (per landing: null). */
  q1: number | null;
  q3: number | null;
}

export interface TrendSeries {
  bucket: Bucket;
  window: number;
  /** |fpm|, lower is better. */
  rate: TrendPoint[];
  /** Metres behind the threshold. */
  distance: TrendPoint[];
  /** |Centreline| m. */
  centerline: TrendPoint[];
  /** "stabil ab" ft (approach facts; empty without). */
  stableFrom: TrendPoint[];
  /** Lateral guidance: localiser RMS 1000 → 50 ft, dots (approach facts with a known centreline; empty without). */
  lateral: TrendPoint[];
  /** TDZ quota 0..1. */
  tdz: TrendPoint[];
}

const DAY_MS = 86_400_000;

/** Start of the UTC month / ISO week (Monday) of a time, with its key. */
export function bucketOf(tMs: number, bucket: "week" | "month"): { key: string; startMs: number } {
  const d = new Date(tMs);
  if (bucket === "month") {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    return { key: `${y}-${String(m + 1).padStart(2, "0")}`, startMs: Date.UTC(y, m, 1) };
  }
  const day = Math.floor(tMs / DAY_MS) * DAY_MS;
  const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
  const monday = day - dow * DAY_MS;
  // ISO year/week: the Thursday of the week decides the year
  const thu = new Date(monday + 3 * DAY_MS);
  const isoYear = thu.getUTCFullYear();
  const week = Math.floor((thu.getTime() - Date.UTC(isoYear, 0, 1)) / (7 * DAY_MS)) + 1;
  return { key: `${isoYear}-W${String(week).padStart(2, "0")}`, startMs: monday };
}

interface Raw {
  key: string;
  tMs: number;
  v: number | null;
}

function series(raw: Raw[], bucket: Bucket, window: number, kind: "median" | "quota"): TrendPoint[] {
  const chrono = [...raw].sort((a, b) => a.tMs - b.tMs);
  let pts: Omit<TrendPoint, "rolling">[];
  if (bucket === "flight") {
    pts = chrono.map((r) => ({ key: r.key, tMs: r.tMs, n: isNum(r.v) ? 1 : 0, value: isNum(r.v) ? r.v : null, q1: null, q3: null }));
  } else {
    const groups = new Map<string, { startMs: number; vs: Array<number | null> }>();
    for (const r of chrono) {
      const b = bucketOf(r.tMs, bucket);
      const g = groups.get(b.key) ?? { startMs: b.startMs, vs: [] };
      g.vs.push(r.v);
      groups.set(b.key, g);
    }
    pts = [...groups.entries()].map(([key, g]) => {
      const q = quartiles(g.vs);
      const value = kind === "quota" ? (q.n ? g.vs.filter(isNum).reduce((s, x) => s + x, 0) / q.n : null) : q.median;
      return { key, tMs: g.startMs, n: q.n, value, q1: kind === "quota" ? null : q.q1, q3: kind === "quota" ? null : q.q3 };
    });
  }
  return pts.map((p, i) => {
    const win = pts.slice(Math.max(0, i - window + 1), i + 1).map((x) => x.value);
    const vals = win.filter(isNum);
    const rolling = vals.length === 0 ? null : kind === "quota" ? vals.reduce((s, x) => s + x, 0) / vals.length : median(vals);
    return { ...p, rolling };
  });
}

/**
 * Trend series oldest first: per landing (moving median over `window` landings), per ISO week or
 * per month (median of the bucket, moving median over `window` buckets). "stabil ab" comes from
 * the approach facts (never-stable approaches left out, as everywhere).
 */
export function trendSeries(facts: HistLanding[], bucket: Bucket = "flight", opts: { approaches?: ApproachFact[]; window?: number } = {}): TrendSeries {
  const window = Math.max(1, opts.window ?? (bucket === "flight" ? 5 : 3));
  const key = (f: HistLanding) => `${f.flightId}#${f.touchdownIndex}`;
  const raw = (v: (f: HistLanding) => number | null): Raw[] => facts.map((f) => ({ key: key(f), tMs: f.timestampMs, v: v(f) }));
  const approaches = (opts.approaches ?? []).filter(assessed);
  return {
    bucket,
    window,
    rate: series(raw((f) => Math.abs(f.landingRateFpm)), bucket, window, "median"),
    distance: series(raw((f) => f.touchdownDistanceM), bucket, window, "median"),
    centerline: series(raw((f) => (isNum(f.centerlineOffsetM) ? Math.abs(f.centerlineOffsetM) : null)), bucket, window, "median"),
    stableFrom: series(
      approaches.map((a) => ({ key: `${a.flightId}#a${a.approachIndex}`, tMs: a.endedMs, v: a.stableFromFt })),
      bucket,
      window,
      "median",
    ),
    lateral: series(
      approaches
        .filter((a) => a.locRmsDots != null && !isDerivedSource(a.runwaySource))
        .map((a) => ({ key: `${a.flightId}#a${a.approachIndex}`, tMs: a.endedMs, v: a.locRmsDots ?? null })),
      bucket,
      window,
      "median",
    ),
    tdz: series(raw((f) => (f.inTouchdownZone ? 1 : 0)), bucket, window, "quota"),
  };
}

export interface PeriodStats {
  key: string;
  n: number;
  /** Median |fpm|. */
  rate: number | null;
  distance: number | null;
  stableFrom: number | null;
  tdzRate: number | null;
}

function periodStats(key: string, facts: HistLanding[], approaches: ApproachFact[]): PeriodStats {
  return {
    key,
    n: facts.length,
    rate: median(facts.map((f) => Math.abs(f.landingRateFpm))),
    distance: median(facts.map((f) => f.touchdownDistanceM)),
    stableFrom: median(approaches.filter(assessed).map((a) => a.stableFromFt)),
    tdzRate: quota(facts.map((f) => f.inTouchdownZone)).rate,
  };
}

/** "Dieser Monat vs. Vormonat" (UTC months). */
export function monthCompare(facts: HistLanding[], approaches: ApproachFact[], nowMs: number): { current: PeriodStats; previous: PeriodStats } {
  const cur = bucketOf(nowMs, "month");
  const prev = bucketOf(cur.startMs - 1, "month");
  const inMonth = (t: number, k: string) => bucketOf(t, "month").key === k;
  return {
    current: periodStats(cur.key, facts.filter((f) => inMonth(f.timestampMs, cur.key)), approaches.filter((a) => inMonth(a.endedMs, cur.key))),
    previous: periodStats(prev.key, facts.filter((f) => inMonth(f.timestampMs, prev.key)), approaches.filter((a) => inMonth(a.endedMs, prev.key))),
  };
}

// ---- circuits (touch-and-goes of one flight) -------------------------------------------

export interface PatternRow {
  touchdownIndex: number;
  timestampMs: number;
  touchAndGo: boolean;
  landingRateFpm: number;
  landingRateSource: TouchdownReport["landingRateSource"];
  /** false: unrated (slewed / fast-forwarded down) – no rate, left out of best and median. */
  rated: boolean;
  peakG: number;
  bounces: number;
  /** From the landing fact (only where one exists – usually the full stop). */
  distanceM: number | null;
  centerlineOffsetM: number | null;
  inTdz: boolean | null;
  runway: string | null;
  /** From the approach fact that ended in this touchdown. */
  stableFromFt: number | null;
}

export interface PatternSeries {
  rows: PatternRow[];
  touchAndGos: number;
  fullStops: number;
  /** Median of the signed landing rates. */
  medianRateFpm: number | null;
  /** Touchdown with the smallest |fpm|. */
  bestIndex: number | null;
}

/**
 * All touchdowns of a flight as a series (circuit training): the touchdown reports carry rate,
 * g and bounces; facts and approach facts add touchdown point and "stabil ab" where they exist.
 */
export function patternSeries(touchdowns: TouchdownReport[], facts: HistLanding[], flightId: string, approaches: ApproachFact[] = []): PatternSeries {
  const rows: PatternRow[] = touchdowns.map((t, i) => {
    const f = facts.find((x) => x.flightId === flightId && x.touchdownIndex === i);
    const a = approaches.find((x) => x.flightId === flightId && x.touchdownIndex === i);
    return {
      touchdownIndex: i,
      timestampMs: t.timestampMs,
      touchAndGo: t.touchAndGo,
      landingRateFpm: t.landingRateFpm,
      landingRateSource: t.landingRateSource,
      rated: isRated(t),
      peakG: t.peakG,
      bounces: t.bounces,
      distanceM: f ? f.touchdownDistanceM : null,
      centerlineOffsetM: f && isNum(f.centerlineOffsetM) ? f.centerlineOffsetM : null,
      inTdz: f ? f.inTouchdownZone : null,
      runway: f ? runwayKey(f) : a ? runwayKey(a) : null,
      stableFromFt: a && isNum(a.stableFromFt) ? a.stableFromFt : null,
    };
  });
  const rated = rows.filter((r) => r.rated);
  const best = rated.reduce<PatternRow | null>((b, r) => (b == null || Math.abs(r.landingRateFpm) < Math.abs(b.landingRateFpm) ? r : b), null);
  return {
    rows,
    touchAndGos: rows.filter((r) => r.touchAndGo).length,
    fullStops: rows.filter((r) => !r.touchAndGo).length,
    medianRateFpm: median(rated.map((r) => r.landingRateFpm)),
    bestIndex: best?.touchdownIndex ?? null,
  };
}

// ---- wording ----------------------------------------------------------------------------

/** "auf EDDF 25C", "mit A20N", "" (all) – in the active language. */
export function scopePhrase(scope: Scope, f: { airportIcao?: string | null; runwayIdent?: string | null; aircraftIcaoType?: string | null; aircraftTitle?: string | null }): string {
  if (scope === "runway") {
    const rk = runwayKey(f);
    return rk ? t("landingHistory.scope.runway", { runway: rk }) : t("landingHistory.scope.thisRunway");
  }
  if (scope === "type") return t("landingHistory.scope.type", { type: typeKey(f) });
  return "";
}

/** "besser als 70 %" / "besser als jede" (reads with a following genitive); null without percentile. */
export function betterText(p: number | null | undefined): string | null {
  if (p == null || !Number.isFinite(p)) return null;
  if (p >= 1) return t("landingHistory.betterAll");
  return t("landingHistory.betterPct", { pct: `${fmtNum(Math.round(p * 100), 0)}${NNBSP}%` });
}

/** "deiner letzten 20 Landungen auf EDDF 25C" (genitive, for the after-flight line). */
export function peersPhrase(n: number, scope: Scope, f: Parameters<typeof scopePhrase>[1]): string {
  return [t("landingHistory.peers", { count: n }), scopePhrase(scope, f)].filter(Boolean).join(" ");
}
