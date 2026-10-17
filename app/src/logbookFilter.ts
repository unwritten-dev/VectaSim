// Logbook search and quick filters. Pure, see logbookFilter.test.ts.

import type { FlightRow } from "./types";
import { fmtDate } from "./format";
import { isDemoRow } from "./totals";

export type QuickFilter = "all" | "completed" | "interrupted" | "landed";

export const QUICK_FILTERS: Array<{ id: QuickFilter; label: string }> = [
  { id: "all", label: "Alle" },
  { id: "completed", label: "Gespeichert" },
  { id: "interrupted", label: "Unvollständig" },
  { id: "landed", label: "Mit Landung" },
];

export interface FlightFilter {
  query: string;
  quick: QuickFilter;
  /** Include demo (mock) flights (setting `show_demo`). */
  showDemo: boolean;
}

export function callsignOf(f: FlightRow): string {
  return f.callsign || (f.aircraft.atcAirline ? `${f.aircraft.atcAirline} ${f.aircraft.atcFlightNumber}`.trim() : f.aircraft.atcId || "");
}

/** Everything a search term may match: route, aircraft, registration, callsign, date. */
export function searchText(f: FlightRow): string {
  const dep = f.depIcao ?? f.plannedDep ?? "";
  const arr = f.arrIcao ?? f.plannedArr ?? "";
  const ms = f.offBlockMs ?? f.createdMs;
  const iso = Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "";
  return [
    dep,
    arr,
    `${dep}-${arr}`,
    `${dep}→${arr}`,
    f.plannedDep ?? "",
    f.plannedArr ?? "",
    f.aircraft.title,
    f.aircraft.atcModel,
    f.aircraft.atcType,
    f.aircraft.atcId,
    callsignOf(f),
    f.callsign ?? "",
    `${f.aircraft.atcAirline}${f.aircraft.atcFlightNumber}`,
    fmtDate(ms),
    iso,
  ]
    .join(" ")
    .toLowerCase();
}

/** Every whitespace-separated term must appear somewhere ("eddf a20n", "17.10.2026"). */
export function matchesQuery(f: FlightRow, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = searchText(f);
  return terms.every((t) => hay.includes(t.replace(/->|→/g, "-")) || hay.includes(t));
}

export function matchesQuick(f: FlightRow, quick: QuickFilter): boolean {
  switch (quick) {
    case "completed":
      return f.state === "completed";
    case "interrupted":
      return f.state === "interrupted";
    case "landed":
      return f.landingCount > 0 || f.landingVsFpm != null;
    default:
      return true;
  }
}

export function filterFlights(rows: FlightRow[], filter: FlightFilter): FlightRow[] {
  return rows.filter((f) => (filter.showDemo || !isDemoRow(f)) && matchesQuick(f, filter.quick) && matchesQuery(f, filter.query));
}

/** Id `delta` rows away from `current` (clamped); the first row when nothing is selected. */
export function moveSelection(ids: string[], current: string | null, delta: number): string | null {
  if (!ids.length) return null;
  const i = current ? ids.indexOf(current) : -1;
  if (i < 0) return delta < 0 ? ids[ids.length - 1] : ids[0];
  return ids[Math.max(0, Math.min(ids.length - 1, i + delta))];
}
