// After a crash: what the "Flug fortsetzen?" toast and the logbook's "Zusammenführen" hint say.
// Pure functions (tested in resume.test.ts); App.tsx and Logbook.tsx do the invoking.

import { fmt, fmtClock, fmtDuration } from "./format";
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
  const since = c.offBlockMs ? ` seit ${fmtClock(c.offBlockMs, { local: false })}` : "";
  const ago = Math.max(0, ctx.nowMs - c.lastMs);
  const who = c.callsign ? `${c.callsign} · ` : "";
  return {
    id: `resume-${c.flightId}`,
    title: "Flug fortsetzen?",
    body:
      `${who}${route(c.dep, c.arr)}${since}. Aufzeichnung vor ${fmtDuration(ago, { seconds: false })} abgebrochen, ` +
      `${fmt(c.distanceNm, 1, "nm")} von hier. Ohne Antwort zählt der Rest als neuer Flug.`,
  };
}

/** Logbook hint of a merge candidate: "Vermutlich Fortsetzung von EDDF → … (12:04z)". */
export function mergeHint(c: MergeCandidate): { text: string; detail: string } {
  const f = c.first;
  const at = f.offBlockMs ?? f.createdMs;
  return {
    text: `${route(c.second.depIcao, c.second.arrIcao ?? c.second.plannedArr)} ist vermutlich die Fortsetzung von ${route(f.depIcao, f.arrIcao ?? f.plannedArr)} (${fmtClock(at)})`,
    detail: `Lücke ${fmtDuration(c.gapMs, { seconds: false })} · ${fmt(c.distanceNm, 1, "nm")} Versatz`,
  };
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
  const inside = gap > 0 ? `Aufzeichnungslücke ${fmtDuration(gap, { seconds: false })}` : null;
  if (f.state !== "interrupted") return inside ? `${inside} (fortgesetzt nach Absturz/Neustart)` : null;
  const next =
    gapToNextMs != null
      ? `Nächster Flug folgt nach ${fmtDuration(gapToNextMs, { seconds: false })} – „Zusammenführen“ über dem Logbuch`
      : "Ohne Abstellen beendet (Absturz, Neustart oder neu geladener Flug)";
  return ["Aufzeichnung unterbrochen", next, inside].filter(Boolean).join(". ");
}
