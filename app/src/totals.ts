// Logbook totals computed client-side from the flight list, so demo (mock) flights can be
// left out (setting `show_demo`). Pure, see totals.test.ts.

import type { FlightRow } from "./types";
import { countsInStats, type StatsRow } from "./flightStats";

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

export const isDemoRow = (f: Pick<FlightRow, "provider">) => f.provider === "mock" || f.provider === "replay";

/** Flights from a CSV import (`provider = "import:<preset>"`): no track, no touchdowns, no integrity data. */
export const isImportedRow = (f: Pick<FlightRow, "provider">) => f.provider?.startsWith("import:") ?? false;

const IMPORT_SOURCE: Record<string, string> = { vectasim: "VectaSim-CSV", volanta_import: "Volanta", simtoolkitpro: "SimToolkitPro", generic: "CSV" };

/** Where an imported flight came from ("Volanta"); null for a recorded flight. */
export function importSourceLabel(f: Pick<FlightRow, "provider">): string | null {
  if (!isImportedRow(f)) return null;
  const preset = (f.provider ?? "").slice("import:".length);
  return IMPORT_SOURCE[preset] ?? (preset || "CSV");
}

/**
 * Flights that count in statistics: the backend rule (`countsInStats`: no discarded ground
 * session, a recorded flight took off or landed), and demo flights only with the setting.
 */
export function countedFlights<T extends StatsRow>(rows: T[], showDemo: boolean): T[] {
  return rows.filter((f) => countsInStats(f) && (showDemo || !isDemoRow(f)));
}

/** Demo flights the setting leaves out of the statistics (ones that would count otherwise). */
export function demoLeftOut(rows: StatsRow[], showDemo: boolean): number {
  return showDemo ? 0 : rows.filter((f) => isDemoRow(f) && countsInStats(f)).length;
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
