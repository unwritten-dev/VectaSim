// Mapping of the cached landing and approach facts onto one `StripFact` per flight
// (logbook flight strips). Pure: the strip only reads what this returns.

import type { StripFact } from "./FlightStrip";
import type { ApproachFact } from "./landing/approachTypes";

export type LandingStripFact = StripFact & { flightId: string; touchdownIndex: number };
type ApproachStripInput = Pick<ApproachFact, "flightId" | "approachIndex" | "outcome" | "stableFromFt" | "band">;

/**
 * Per flight: the landing is the last touchdown (highest index); the approach values come from
 * the landed approach (the last one if several, else the last touch-and-go); go-arounds are counted.
 */
export function stripFactsFrom(landingFacts: LandingStripFact[], approachFacts: ApproachStripInput[]): Map<string, StripFact> {
  const out = new Map<string, StripFact>();
  const tdIndex = new Map<string, number>();
  for (const x of landingFacts) {
    const prev = tdIndex.get(x.flightId);
    if (prev != null && prev > x.touchdownIndex) continue;
    tdIndex.set(x.flightId, x.touchdownIndex);
    out.set(x.flightId, {
      touchdownDistanceM: x.touchdownDistanceM,
      centerlineOffsetM: x.centerlineOffsetM,
      runwayIdent: x.runwayIdent,
      inTouchdownZone: x.inTouchdownZone,
    });
  }

  const rank = (a: ApproachStripInput) => (a.outcome === "landed" ? 2 : a.outcome === "touch_and_go" ? 1 : 0);
  const best = new Map<string, ApproachStripInput>();
  const goArounds = new Map<string, number>();
  for (const a of approachFacts) {
    if (a.outcome === "go_around") goArounds.set(a.flightId, (goArounds.get(a.flightId) ?? 0) + 1);
    if (rank(a) === 0) continue;
    const b = best.get(a.flightId);
    if (!b || rank(a) > rank(b) || (rank(a) === rank(b) && a.approachIndex > b.approachIndex)) best.set(a.flightId, a);
  }

  const ids = new Set([...best.keys(), ...goArounds.keys()]);
  for (const id of ids) {
    const a = best.get(id);
    const base: StripFact = out.get(id) ?? {};
    out.set(id, {
      ...base,
      ...(a ? { stableFromFt: a.stableFromFt, band: a.band } : {}),
      goArounds: goArounds.get(id) ?? 0,
    });
  }
  return out;
}
