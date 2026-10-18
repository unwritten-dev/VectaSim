// Logbook search and quick filters. Pure, see logbookFilter.test.ts.

import type { FlightRow } from "./types";
import { fmtDate } from "./format";
import { isDemoRow } from "./totals";

export type QuickFilter = "all" | "completed" | "interrupted" | "landed";

export const QUICK_FILTERS: Array<{ id: QuickFilter; label: string }> = [
  { id: "all", label: "Alle" },
  { id: "completed", label: "Abgeschlossen" },
  { id: "interrupted", label: "Unvollständig" },
  { id: "landed", label: "Mit Landung" },
];

export interface FlightFilter {
  query: string;
  quick: QuickFilter;
  /** Include demo (mock) flights (setting `show_demo`). */
  showDemo: boolean;
  /** Chip filter „Tags“: flights carrying at least one of these (case-insensitive); empty = all. */
  tags?: string[];
}

/** A pilot's correction when set, else the recorded value. */
function corrected(user: string | null | undefined, recorded: string | null | undefined): string | null {
  const u = user?.trim();
  return u ? u : (recorded ?? null);
}

/** Departure as shown: the correction (Notizen & Tags → Korrigieren) over the recorded ICAO. */
export function effectiveDep(f: FlightRow): string | null {
  return corrected(f.userDepIcao, f.depIcao);
}

export function effectiveArr(f: FlightRow): string | null {
  return corrected(f.userArrIcao, f.arrIcao);
}

export function effectiveAircraftTitle(f: FlightRow): string {
  return corrected(f.userAircraftTitle, f.aircraft.title) ?? "";
}

/** Registration as shown: the correction, else the airframe the flight is booked onto, else the ATC ID. */
export function effectiveRegistration(f: FlightRow): string {
  return corrected(f.userRegistration, f.airframeReg ?? f.aircraft.atcId) ?? "";
}

/** The recorded callsign (SimBrief/sim, else airline + flight number, else the ATC ID). */
export function recordedCallsignOf(f: FlightRow): string {
  return f.callsign || (f.aircraft.atcAirline ? `${f.aircraft.atcAirline} ${f.aircraft.atcFlightNumber}`.trim() : f.aircraft.atcId || "");
}

/** Callsign as shown: the pilot's correction over the recorded one. */
export function callsignOf(f: FlightRow): string {
  return f.userCallsign?.trim() || recordedCallsignOf(f);
}

/** Tooltip of a corrected value: "Sim: ASXGS" (null when not corrected or the same). */
export function originalTitle(user: string | null | undefined, recorded: string | null | undefined): string | null {
  const u = user?.trim();
  if (!u || u === (recorded ?? "")) return null;
  return `Sim: ${recorded || "–"}`;
}

/** First non-empty line of the notes (strip tooltip), cut to `max` characters. */
export function notesFirstLine(notes: string | null | undefined, max = 120): string | null {
  const line = (notes ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Same rule as the backend (`normalize_tags`): longest tag, most tags per flight. */
export const TAG_MAX_CHARS = 30;
export const TAGS_MAX = 20;
export const NOTES_MAX_CHARS = 2000;

/** Trim, collapse whitespace, drop commas, cut to 30, drop case-insensitive duplicates, at most 20. */
export function normalizeTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const clean = t.replace(/,/g, " ").split(/\s+/).filter(Boolean).join(" ").slice(0, TAG_MAX_CHARS).trimEnd();
    if (!clean || out.some((o) => o.toLowerCase() === clean.toLowerCase())) continue;
    out.push(clean);
    if (out.length === TAGS_MAX) break;
  }
  return out;
}

/** Tags of `rows` with their number of flights, most used first (same rule as `list_tags`). */
export function tagCounts(rows: FlightRow[]): Array<{ tag: string; count: number }> {
  const byKey = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const f of rows) {
    for (const t of normalizeTags(f.tags ?? [])) {
      const e = byKey.get(t.toLowerCase()) ?? { count: 0, spellings: new Map<string, number>() };
      e.count += 1;
      e.spellings.set(t, (e.spellings.get(t) ?? 0) + 1);
      byKey.set(t.toLowerCase(), e);
    }
  }
  return [...byKey.values()]
    .map((e) => ({ tag: [...e.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0], count: e.count }))
    .sort((a, b) => b.count - a.count || a.tag.toLowerCase().localeCompare(b.tag.toLowerCase()));
}

export function matchesTags(f: FlightRow, tags: string[] | undefined): boolean {
  if (!tags?.length) return true;
  const own = new Set((f.tags ?? []).map((t) => t.toLowerCase()));
  return tags.some((t) => own.has(t.toLowerCase()));
}

/**
 * Everything a search term may match: route, aircraft, registration, callsign, date – and
 * the pilot's notes, tags and corrections (the recorded values still match too).
 */
export function searchText(f: FlightRow): string {
  const dep = effectiveDep(f) ?? f.plannedDep ?? "";
  const arr = effectiveArr(f) ?? f.plannedArr ?? "";
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
    f.depIcao ?? "",
    f.arrIcao ?? "",
    f.userCallsign ?? "",
    f.userAircraftTitle ?? "",
    f.userRegistration ?? "",
    f.airframeReg ?? "",
    f.notes ?? "",
    ...(f.tags ?? []).map((t) => `${t} #${t}`),
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
  return rows.filter(
    (f) => (filter.showDemo || !isDemoRow(f)) && matchesQuick(f, filter.quick) && matchesTags(f, filter.tags) && matchesQuery(f, filter.query),
  );
}

/** Id `delta` rows away from `current` (clamped); the first row when nothing is selected. */
export function moveSelection(ids: string[], current: string | null, delta: number): string | null {
  if (!ids.length) return null;
  const i = current ? ids.indexOf(current) : -1;
  if (i < 0) return delta < 0 ? ids[ids.length - 1] : ids[0];
  return ids[Math.max(0, Math.min(ids.length - 1, i + delta))];
}

/** Days a deleted flight stays in the Papierkorb (backend `TRASH_RETENTION_DAYS`). */
export const TRASH_DAYS = 30;

/** Whole days until a flight deleted at `deletedMs` is removed for good (0 = at the next start). */
export function trashDaysLeft(deletedMs: number, nowMs: number, days = TRASH_DAYS): number {
  return Math.max(0, Math.ceil((deletedMs + days * 86_400_000 - nowMs) / 86_400_000));
}
