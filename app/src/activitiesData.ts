// Aggregation for the logbook section "Flughäfen" (Activities.tsx). Uses the airports as the
// list, the detail and the year review show them: the pilot's correction, else the recorded ICAO.

import type { FlightRow } from "./types";
import { effectiveArr, effectiveDep } from "./logbookFilter";
import { countedFlights } from "./totals";

export interface AirportCount {
  departures: number;
  arrivals: number;
}

/** Departures/arrivals per airport (ICAO trimmed and upper-cased), in first-seen order. */
export function airportCounts(flights: FlightRow[]): Map<string, AirportCount> {
  const counts = new Map<string, AirportCount>();
  const bump = (icao: string | null, field: keyof AirportCount) => {
    const code = icao?.trim().toUpperCase();
    if (!code) return;
    const c = counts.get(code) ?? { departures: 0, arrivals: 0 };
    c[field] += 1;
    counts.set(code, c);
  };
  for (const f of flights) {
    bump(effectiveDep(f), "departures");
    bump(effectiveArr(f), "arrivals");
  }
  return counts;
}

/**
 * Airports of the flights that count (flightStats.ts: no discarded ground session, no taxi-only
 * row; demo flights only with the setting), as the "Flughäfen" section lists them.
 */
export function visitedAirportCounts(all: FlightRow[], showDemo: boolean): Map<string, AirportCount> {
  return airportCounts(countedFlights(all, showDemo));
}
