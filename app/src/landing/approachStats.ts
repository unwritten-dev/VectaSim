// Pure helpers for the approach dispersion view ("Anflüge", ApproachDispersion.tsx).
// Input are the cached `ApproachFact`s (newest first); `null` always means "not measurable"
// and is left out of every mean / quota – never counted as a failure.

import type { ApproachBand, ApproachFact } from "./approachTypes";
import { APPROACH_BAND_SHAPE, type BandShape } from "./facts";
import { isDerivedSource } from "./types";

/** The four gates drawn as scatter panels, high to low. */
export type ScatterGate = "tenNm" | "faf" | "ft1000" | "ft500";
export const SCATTER_GATES: ScatterGate[] = ["tenNm", "faf", "ft1000", "ft500"];

export const GATE_LABEL: Record<ScatterGate, string> = {
  tenNm: "10 NM",
  faf: "FAF",
  ft1000: "1000 ft",
  ft500: "500 ft",
};

/** Tolerance box of a gate: altitude vs the path (ft, + = high), IAS − Vapp (kt, + = fast); null = no limit on that axis. */
export interface Tolerance {
  altLoFt: number;
  altHiFt: number;
  iasLoKt: number | null;
  iasHiKt: number | null;
}

/**
 * 10 NM: ±500 ft (its speed limit is an absolute 250 kt, not a deviation – no box on x);
 * FAF: ±300 ft, −5/+40 kt; 1000/500 ft: ±1 GS dot as height at the gate on a 3° path
 * (≈ ±100 / ±50 ft), −5/+20 kt.
 */
export const GATE_TOLERANCE: Record<ScatterGate, Tolerance> = {
  tenNm: { altLoFt: -500, altHiFt: 500, iasLoKt: null, iasHiKt: null },
  faf: { altLoFt: -300, altHiFt: 300, iasLoKt: -5, iasHiKt: 40 },
  ft1000: { altLoFt: -100, altHiFt: 100, iasLoKt: -5, iasHiKt: 20 },
  ft500: { altLoFt: -50, altHiFt: 50, iasLoKt: -5, iasHiKt: 20 },
};

/** EASA/D4S band tokens (05 §7.1) – never violet/magenta; same mapping as APPROACH_BAND_VAR in facts.ts. */
export const APPROACH_BAND_VAR: Record<ApproachBand, string> = {
  stable: "var(--aband-stable)",
  deviations: "var(--aband-dev)",
  unstable: "var(--aband-unstable)",
  unstableBelow500: "var(--aband-unstable)",
};
/** Marker shape per band (facts.ts APPROACH_BAND_SHAPE); an approach without band is a circle. */
export const shapeOf = (b: ApproachBand | null | undefined): BandShape => (b ? APPROACH_BAND_SHAPE[b] : "circle");
export const APPROACH_BAND_LABEL: Record<ApproachBand, string> = {
  stable: "stabil",
  deviations: "mit Abweichungen",
  unstable: "instabil",
  unstableBelow500: "instabil unter 500 ft",
};
export const APPROACH_BANDS: ApproachBand[] = ["stable", "deviations", "unstable", "unstableBelow500"];
/** Colour of an approach without band (never below 1000 ft). */
export const NO_BAND_VAR = "var(--text-muted)";

export const bandVar = (b: ApproachBand | null | undefined): string => (b ? APPROACH_BAND_VAR[b] : NO_BAND_VAR);

export const isGoAround = (f: Pick<ApproachFact, "outcome">): boolean => f.outcome === "go_around";

/** Stable key of one approach (hover coupling, React keys). */
export const approachKey = (f: Pick<ApproachFact, "flightId" | "approachIndex">): string => `${f.flightId}#${f.approachIndex}`;

export interface GatePoint {
  /** IAS − Vapp, kt (+ = fast). */
  iasDevKt: number;
  /** Height vs the reference path, ft (+ = high). */
  altDevFt: number;
}

/**
 * The scatter point of a gate; null when one of the two values is not measurable. At 10 NM the
 * fact holds the absolute IAS, so the deviation is derived with the approach's Vapp.
 */
export function gatePoint(f: ApproachFact, gate: ScatterGate): GatePoint | null {
  let alt: number | null;
  let ias: number | null;
  switch (gate) {
    case "tenNm":
      alt = f.g10AltDevFt;
      ias = f.g10IasKt != null && f.vappKt != null ? f.g10IasKt - f.vappKt : null;
      break;
    case "faf":
      alt = f.gfafAltDevFt;
      ias = f.gfafIasDevKt;
      break;
    case "ft1000":
      alt = f.g1000AltDevFt;
      ias = f.g1000IasDevKt;
      break;
    case "ft500":
      alt = f.g500AltDevFt;
      ias = f.g500IasDevKt;
      break;
  }
  if (alt == null || ias == null || !Number.isFinite(alt) || !Number.isFinite(ias)) return null;
  return { iasDevKt: ias, altDevFt: alt };
}

/** Inside the tolerance box (limits inclusive; an axis without limit always fits). */
export function withinTolerance(p: GatePoint, t: Tolerance): boolean {
  if (p.altDevFt < t.altLoFt || p.altDevFt > t.altHiFt) return false;
  if (t.iasLoKt != null && p.iasDevKt < t.iasLoKt) return false;
  if (t.iasHiKt != null && p.iasDevKt > t.iasHiKt) return false;
  return true;
}

/**
 * Lateral offset at a low gate, m (+ = right); null = not measurable – also with a runway
 * derived from the own ground roll: its axis is the pilot's own line, not the centreline.
 */
export function lateralAt(f: ApproachFact, gate: "ft1000" | "ft500"): number | null {
  if (isDerivedSource(f.runwaySource)) return null;
  const v = gate === "ft1000" ? f.g1000LatDevM : f.g500LatDevM;
  return v != null && Number.isFinite(v) ? v : null;
}

/** Approaches whose lateral offset is not measurable because the runway was derived from the track. */
export function derivedLateralCount(facts: ApproachFact[]): number {
  return facts.filter((f) => isDerivedSource(f.runwaySource)).length;
}

/** Mean of the measurable values; null when none is. */
export function meanOf(xs: Array<number | null | undefined>): { mean: number | null; n: number } {
  const v = xs.filter((x): x is number => x != null && Number.isFinite(x));
  return { mean: v.length ? v.reduce((s, x) => s + x, 0) / v.length : null, n: v.length };
}

export interface PassRate {
  passed: number;
  /** Approaches where the gate was measurable (pass ≠ null). */
  total: number;
  rate: number | null;
}

export function gatePassRate(facts: ApproachFact[], gate: "ft1000" | "ft500"): PassRate {
  const vals = facts.map((f) => (gate === "ft1000" ? f.g1000Pass : f.g500Pass)).filter((v): v is boolean => v != null);
  const passed = vals.filter(Boolean).length;
  return { passed, total: vals.length, rate: vals.length ? passed / vals.length : null };
}

export interface ApproachSummary {
  count: number;
  goArounds: number;
  /** Mean "stabil ab" over the approaches that became stable, ft. */
  meanStableFromFt: number | null;
  stableN: number;
  /** Approaches with a band (assessed below 1000 ft) that never became stable. */
  neverStable: number;
  gate1000: PassRate;
  gate500: PassRate;
  /** Mean |lateral offset| at 500 ft over the approaches where it is measurable, m. */
  meanAbsLat500M: number | null;
  lat500N: number;
}

export function approachSummary(facts: ApproachFact[]): ApproachSummary {
  const s = meanOf(facts.map((f) => f.stableFromFt));
  const lat = meanOf(facts.map((f) => {
    const v = lateralAt(f, "ft500");
    return v == null ? null : Math.abs(v);
  }));
  return {
    count: facts.length,
    goArounds: facts.filter(isGoAround).length,
    meanStableFromFt: s.mean,
    stableN: s.n,
    neverStable: facts.filter((f) => f.band != null && f.stableFromFt == null).length,
    gate1000: gatePassRate(facts, "ft1000"),
    gate500: gatePassRate(facts, "ft500"),
    meanAbsLat500M: lat.mean,
    lat500N: lat.n,
  };
}

/** Points of a gate with how many are inside the box. */
export function gateHits(facts: ApproachFact[], gate: ScatterGate): { inside: number; total: number } {
  const pts = facts.map((f) => gatePoint(f, gate)).filter((p): p is GatePoint => p != null);
  return { inside: pts.filter((p) => withinTolerance(p, GATE_TOLERANCE[gate])).length, total: pts.length };
}

// ---- filter (same behaviour as dispersionStats, typed for ApproachFact) ----

/** Filter key of the aircraft: ICAO type, else the title, else "Unbekannt". */
export function approachAircraftKey(f: Pick<ApproachFact, "aircraftIcaoType" | "aircraftTitle">): string {
  return f.aircraftIcaoType?.trim() || f.aircraftTitle?.trim() || "Unbekannt";
}

export interface ApproachFilter {
  aircraft: string | null;
  airport: string | null;
}

/** Distinct values with counts, most frequent first; null keys (no airport) are left out. */
export function approachFilterOptions(facts: ApproachFact[], keyOf: (f: ApproachFact) => string | null): Array<{ key: string; count: number }> {
  const m = new Map<string, number>();
  for (const f of facts) {
    const k = keyOf(f);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function applyApproachFilter(facts: ApproachFact[], f: ApproachFilter, limit: number): ApproachFact[] {
  return facts
    .filter((x) => (f.aircraft == null || approachAircraftKey(x) === f.aircraft) && (f.airport == null || x.airportIcao === f.airport))
    .slice(0, limit);
}

/** Symmetric axis half-range: at least `min`, rounded up to `step`, at most `max`. */
export function niceHalfRange(values: number[], min: number, step: number, max: number): number {
  const m = values.reduce((a, v) => Math.max(a, Math.abs(v)), 0);
  return Math.min(max, Math.max(min, Math.ceil(m / step) * step));
}
