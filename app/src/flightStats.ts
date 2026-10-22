// Which logbook flights count in statistics (counters, airports, countries, fleet, year review).
// Mirrors the backend rule (crates/vectasim-store/src/store.rs FlightRow::counts_in_stats /
// counts_in_stats_sql): a discarded ground session never counts; a recorded flight counts once
// it took off or touched down, or when it ended in an airborne phase (climb … final, e.g. a
// start in the air that was interrupted) after covering at least AIRBORNE_ONLY_MIN_DISTANCE_NM –
// the distance keeps the ghost rows of an MSFS load placeholder (0 nm at 0° N / 0° E) out; an
// imported flight (provider "import:…") carries its own facts and always counts. The logbook
// list itself still shows every flight.

import type { FlightRow } from "./types";

export type StatsRow = Pick<FlightRow, "state" | "provider" | "takeoffMs" | "landingCount" | "phase" | "distanceNm">;

/** An airborne-only flight counts from this distance on (store.rs AIRBORNE_ONLY_MIN_DISTANCE_NM). */
export const AIRBORNE_ONLY_MIN_DISTANCE_NM = 1;
const AIRBORNE_PHASES = new Set(["climb", "cruise", "descent", "approach", "final"]);

/** The flight counts in statistics (same rule as the backend's `counts_in_stats`). */
export function countsInStats(f: StatsRow): boolean {
  if (f.state === "discarded") return false;
  return (
    (f.provider?.startsWith("import:") ?? false) ||
    f.takeoffMs != null ||
    (f.landingCount ?? 0) > 0 ||
    (AIRBORNE_PHASES.has(f.phase) && (f.distanceNm ?? 0) >= AIRBORNE_ONLY_MIN_DISTANCE_NM)
  );
}
