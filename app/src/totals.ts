// Logbook totals computed client-side from the flight list, so demo (mock) flights can be
// left out (setting `show_demo`). Pure, see totals.test.ts.

import type { FlightRow } from "./types";

export interface LogTotals {
  flights: number;
  completed: number;
  blockTimeMs: number;
  flightTimeMs: number;
  distanceNm: number;
  /** Flights with a full-stop landing. */
  landings: number;
  /** Mean of each flight's last full-stop landing rate (fpm, negative = descending). */
  avgLandingVsFpm: number | null;
}

export const isDemoRow = (f: Pick<FlightRow, "provider">) => f.provider === "mock";

/** Flights that count: all, or all but demo flights. */
export function countedFlights<T extends Pick<FlightRow, "provider">>(rows: T[], showDemo: boolean): T[] {
  return showDemo ? rows : rows.filter((f) => !isDemoRow(f));
}

export function computeTotals(rows: FlightRow[]): LogTotals {
  let completed = 0;
  let block = 0;
  let air = 0;
  let distance = 0;
  let landings = 0;
  let vsSum = 0;
  for (const f of rows) {
    if (f.state === "completed") completed += 1;
    if (f.onBlockMs != null && f.offBlockMs != null) block += Math.max(0, f.onBlockMs - f.offBlockMs);
    if (f.landingMs != null && f.takeoffMs != null) air += Math.max(0, f.landingMs - f.takeoffMs);
    distance += f.distanceNm || 0;
    if (f.landingVsFpm != null) {
      landings += 1;
      vsSum += f.landingVsFpm;
    }
  }
  return {
    flights: rows.length,
    completed,
    blockTimeMs: block,
    flightTimeMs: air,
    distanceNm: distance,
    landings,
    avgLandingVsFpm: landings ? vsSum / landings : null,
  };
}
