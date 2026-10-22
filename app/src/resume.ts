// After a crash: what the "Flug fortsetzen?" toast and the logbook's "Zusammenführen" hint say.
// Pure functions (tested in resume.test.ts); App.tsx and Logbook.tsx do the invoking.

import { t } from "./i18n";
import { fmt, fmtClock, fmtDuration } from "./i18n/number";
import type { FlightRow, MergeCandidate, ResumeCandidate } from "./types";

/** The toast closes after this long; no answer = the new flight stays (backend default). */
export const RESUME_TOAST_MS = 60_000;
/** Same as the backend: an offer for a last position older than this is not shown. */
export const RESUME_MAX_AGE_MS = 30 * 60_000;

export interface ResumePrompt {
  /** Toast id: one toast per flight. */
  id: string;
  title: string;
  body: string;
}

export interface ResumeContext {
  /** Demo or replay is running: never offered. */
  demo: boolean;
  nowMs: number;
  /** Flights the pilot already answered for. */
  answered?: ReadonlySet<string>;
}

const DASH4 = "····";

/** "EDDF → EGLL" / "EDDF → …" */
function route(dep?: string | null, arr?: string | null): string {
  return `${dep || DASH4} → ${arr || "…"}`;
}

/**
 * Whether and how to ask "Flug fortsetzen?" for a `flight:resumable` event; null = not at all
 * (demo, already answered, stale or broken payload).
 */
export function resumeCandidate(c: ResumeCandidate | null | undefined, ctx: ResumeContext): ResumePrompt | null {
  if (!c || !c.flightId || ctx.demo || ctx.answered?.has(c.flightId)) return null;
  if (!Number.isFinite(c.lastMs) || ctx.nowMs - c.lastMs > RESUME_MAX_AGE_MS) return null;
  const ago = Math.max(0, ctx.nowMs - c.lastMs);
  const flight = `${c.callsign ? `${c.callsign} · ` : ""}${route(c.dep, c.arr)}`;
  const vars = { flight, ago: fmtDuration(ago, { seconds: false }), distance: fmt(c.distanceNm, 1, "nm") };
  return {
    id: `resume-${c.flightId}`,
    title: t("resume.title"),
    body: c.offBlockMs ? t("resume.bodySince", { ...vars, since: fmtClock(c.offBlockMs, { local: false }) }) : t("resume.body", vars),
  };
}

/** Logbook hint of a merge candidate: "Vermutlich Fortsetzung von EDDF → … (12:04z)". */
export function mergeHint(c: MergeCandidate): { text: string; detail: string } {
  const f = c.first;
  const at = f.offBlockMs ?? f.createdMs;
  return {
    text: t("resume.merge.text", {
      second: route(c.second.depIcao, c.second.arrIcao ?? c.second.plannedArr),
      first: route(f.depIcao, f.arrIcao ?? f.plannedArr),
      time: fmtClock(at),
    }),
    detail: t("resume.merge.detail", { gap: fmtDuration(c.gapMs, { seconds: false }), offset: fmt(c.distanceNm, 1, "nm") }),
  };
}

/**
 * The store's merge refusals (`Invalid::Merge*`, `FlightNotFound`, the running flight in
 * `lib.rs merge_flights`) arrive already in the UI language and say why – shown as they are.
 * Anything else (SQLite, I/O) is technical: null, the caller shows it behind "Details".
 */
const MERGE_REFUSAL_RE =
  /^(Flug nicht gefunden|Flight not found|Ein Flug lässt sich nicht mit sich selbst|A flight cannot be merged with itself|Flüge im Papierkorb|Flights in the trash|Nur ein unterbrochener Flug|Only an interrupted flight|Vom ersten Flug ist kein Ende|The end of the first flight|Der zweite Flug beginnt|The second flight starts|Zwischen den Flügen liegen|There are \d+ min between the flights|Die Position(en)? (am Übergang|liegen)|The position(s are| at the transition)|Der laufende Flug|The running flight)/;

export function mergeRefusal(raw: string): string | null {
  const s = raw.trim();
  return MERGE_REFUSAL_RE.test(s) && !s.includes("\n") ? s : null;
}

/** Stable key of a candidate pair (for "Ignorieren"). */
export function mergeKey(c: MergeCandidate): string {
  return `${c.first.id}>${c.second.id}`;
}

/**
 * Tooltip of a strip's state badge: interrupted flights say why and how long until the
 * next flight (when one continues it); a resumed/merged flight names its recording gap.
 */
export function gapTitle(f: FlightRow, gapToNextMs?: number | null): string | null {
  const gap = f.integrity.gapMs ?? 0;
  const inside = gap > 0 ? t("resume.gap.inside", { gap: fmtDuration(gap, { seconds: false }) }) : null;
  if (f.state !== "interrupted") return gap > 0 ? t("resume.gap.resumed", { gap: fmtDuration(gap, { seconds: false }) }) : null;
  const next =
    gapToNextMs != null ? t("resume.gap.nextFlight", { gap: fmtDuration(gapToNextMs, { seconds: false }) }) : t("resume.gap.noShutdown");
  return [t("resume.gap.interrupted"), next, inside].filter(Boolean).join(". ");
}
