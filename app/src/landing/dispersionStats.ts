// Pure statistics and layout helpers for the dispersion view ("Streubild").
// Coordinates are runway metres: x along the runway from the threshold, y from the
// centreline, positive = right in landing direction (as in vectasim_core::landing).

import { t } from "../i18n";
import { fmt, fmtNum } from "../i18n/number";
import { sideLabel } from "./geometry";
import type { RunwayFact } from "./types";

export interface Pt {
  x: number;
  y: number;
}

export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

/** Sample standard deviation (n − 1); 0 for a single value, null for none. */
export function stdDev(xs: number[]): number | null {
  const m = mean(xs);
  if (m === null) return null;
  if (xs.length < 2) return 0;
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
}

/** Sample covariance matrix [[sxx, sxy], [sxy, syy]] (n − 1); null below two points. */
export function covariance(pts: Pt[]): { sxx: number; sxy: number; syy: number } | null {
  if (pts.length < 2) return null;
  const mx = mean(pts.map((p) => p.x))!;
  const my = mean(pts.map((p) => p.y))!;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const d = pts.length - 1;
  return { sxx: sxx / d, sxy: sxy / d, syy: syy / d };
}

/** 1σ covariance ellipse: centre, semi-axes (m) and rotation of the major axis from +x (radians). */
export interface Ellipse {
  cx: number;
  cy: number;
  /** Semi-axis along `angle` (the larger one). */
  rx: number;
  ry: number;
  angle: number;
}

export function sigmaEllipse(pts: Pt[], k = 1): Ellipse | null {
  const c = covariance(pts);
  if (!c) return null;
  const tr = (c.sxx + c.syy) / 2;
  const disc = Math.sqrt(((c.sxx - c.syy) / 2) ** 2 + c.sxy ** 2);
  const l1 = Math.max(tr + disc, 0);
  const l2 = Math.max(tr - disc, 0);
  return {
    cx: mean(pts.map((p) => p.x))!,
    cy: mean(pts.map((p) => p.y))!,
    rx: k * Math.sqrt(l1),
    ry: k * Math.sqrt(l2),
    angle: 0.5 * Math.atan2(2 * c.sxy, c.sxx - c.syy),
  };
}

/** Outline of an ellipse as points in runway metres (to map through a non-uniform scale). */
export function ellipsePoints(e: Ellipse, n = 48): Pt[] {
  const cos = Math.cos(e.angle);
  const sin = Math.sin(e.angle);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    const u = e.rx * Math.cos(t);
    const v = e.ry * Math.sin(t);
    out.push({ x: e.cx + u * cos - v * sin, y: e.cy + u * sin + v * cos });
  }
  return out;
}

export interface DispersionStats {
  count: number;
  inTdz: number;
  /** Share in the touchdown zone, 0..1 (null without landings). */
  tdzRate: number | null;
  meanDistM: number | null;
  sdDistM: number | null;
  /** Mean signed lateral offset (bias: + right / − left), over the measurable ones. */
  meanOffsetM: number | null;
  /** Mean |lateral offset| – how far from the centreline on average (measurable ones only). */
  meanAbsOffsetM: number | null;
  /** Landings whose lateral offset is measurable (runway not derived from the own track). */
  lateralCount: number;
}

export function tdzRate(facts: Pick<RunwayFact, "inTouchdownZone">[]): { inZone: number; total: number; rate: number | null } {
  const inZone = facts.filter((f) => f.inTouchdownZone).length;
  return { inZone, total: facts.length, rate: facts.length ? inZone / facts.length : null };
}

/** Lateral offset of a landing, null when not measurable (derived runway) or not finite. */
export function lateralOf(f: Pick<RunwayFact, "centerlineOffsetM">): number | null {
  const y = f.centerlineOffsetM;
  return y != null && Number.isFinite(y) ? y : null;
}

/** "412 m", with the threshold uncertainty of a derived runway "412 ± 50 m". */
export function distanceText(f: Pick<RunwayFact, "touchdownDistanceM" | "touchdownDistanceUncertaintyM">): string {
  const u = f.touchdownDistanceUncertaintyM;
  return u != null && u > 0 ? `${fmtNum(f.touchdownDistanceM, 0)} ± ${fmt(u, 0, "m")}` : fmt(f.touchdownDistanceM, 0, "m");
}

/** Lateral offset as text; a derived runway has none. */
export function lateralText(f: Pick<RunwayFact, "centerlineOffsetM">): string {
  const y = lateralOf(f);
  return y == null ? t("dispersion.lateralUnmeasurable") : sideLabel(y);
}

/** Points for the 1σ ellipse: only landings with a measurable lateral offset. */
export function ellipseInput(facts: RunwayFact[]): Pt[] {
  return facts.flatMap((f) => {
    const y = lateralOf(f);
    return y == null ? [] : [{ x: f.touchdownDistanceM, y }];
  });
}

export function dispersionStats(facts: RunwayFact[]): DispersionStats {
  const d = facts.map((f) => f.touchdownDistanceM);
  const y = facts.map(lateralOf).filter((v): v is number => v != null);
  const t = tdzRate(facts);
  return {
    count: facts.length,
    inTdz: t.inZone,
    tdzRate: t.rate,
    meanDistM: mean(d),
    sdDistM: stdDev(d),
    meanOffsetM: mean(y),
    meanAbsOffsetM: mean(y.map(Math.abs)),
    lateralCount: y.length,
  };
}

/** Filter key of the aircraft: ICAO type, else the title, else "Unbekannt". */
export function aircraftKey(f: Pick<RunwayFact, "aircraftIcaoType" | "aircraftTitle">): string {
  return f.aircraftIcaoType?.trim() || f.aircraftTitle?.trim() || t("landingHistory.unknownType");
}

export interface FilterOption {
  key: string;
  count: number;
}

/** Distinct values with their counts, most frequent first, then alphabetically. */
export function filterOptions<T extends RunwayFact>(facts: T[], keyOf: (f: T) => string): FilterOption[] {
  const m = new Map<string, number>();
  for (const f of facts) m.set(keyOf(f), (m.get(keyOf(f)) ?? 0) + 1);
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export interface DispersionFilter {
  aircraft: string | null;
  airport: string | null;
}

export function applyFilter<T extends RunwayFact>(facts: T[], f: DispersionFilter, limit: number): T[] {
  return facts.filter((x) => (f.aircraft == null || aircraftKey(x) === f.aircraft) && (f.airport == null || x.airportIcao === f.airport)).slice(0, limit);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Linear map of [d0, d1] onto [r0, r1]. */
export function linear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const k = (r1 - r0) / (d1 - d0 || 1);
  return (v) => r0 + (v - d0) * k;
}
