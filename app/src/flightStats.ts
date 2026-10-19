// Which logbook flights count in statistics (counters, airports, countries, fleet, year review).
// Mirrors the backend rule (crates/vectasim-store/src/store.rs FlightRow::counts_in_stats /
// counts_in_stats_sql): a discarded ground session never counts; a recorded flight counts once
// it took off or touched down; an imported flight (provider "import:…") carries its own facts
// and always counts. The logbook list itself still shows every flight.

import type { FlightRow } from "./types";

export type StatsRow = Pick<FlightRow, "state" | "provider" | "takeoffMs" | "landingCount">;

/** The flight counts in statistics (same rule as the backend's `counts_in_stats`). */
export function countsInStats(f: StatsRow): boolean {
  if (f.state === "discarded") return false;
  return (f.provider?.startsWith("import:") ?? false) || f.takeoffMs != null || (f.landingCount ?? 0) > 0;
}
