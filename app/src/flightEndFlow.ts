// The end of a recording as the shell sees it (App.tsx onFlightEvent): `flightEnded` and – for a
// ground session – `flightDiscarded` with the same `timestampMs`. The backend sends both right
// after each other, but the UI must not depend on their order or on how fast `list_flights`
// answers:
//
// - `flightDiscarded` first: the end line is never written ("Flight saved" for a session
//   that saved nothing), no card, no toast;
// - `flightEnded` first: the side effects (taskbar flash, after-flight card, card autosave,
//   "Flight saved" toast) wait until the discard check has settled – a short grace period
//   next to the `list_flights` call – and run only for the row of exactly this end (on-block ==
//   end time), never for an older flight that `rows[0]` would be once the session is in the
//   trash.
//
// The connection-lost toast goes with any end: the flight it reassured about is over. All
// effects are injected, so both orders are tested without Tauri (flightEndFlow.test.ts).

import { discardedToast, isFlightEndedLine, noteDiscarded, wasDiscarded } from "./flightEvents";
import type { AfterFlight } from "./live/AfterFlightCard";
import type { FlightEvent, FlightRow } from "./types";
import type { ToastOptions } from "./ui/Toast";

/** How long a `flightEnded` waits for a `flightDiscarded` of the same time before it counts. */
export const DISCARD_SETTLE_MS = 300;
/** The ended flight's row: its on-block time equals the end time (tolerance for rounding). */
const END_MATCH_MS = 1000;

export type FlightEnd = Extract<FlightEvent, { kind: "flightEnded" }>;
export type FlightDiscard = Extract<FlightEvent, { kind: "flightDiscarded" }>;

export interface FlightEndDeps {
  /** Newest logbook row (`list_flights` limit 1). */
  latestFlight: () => Promise<FlightRow | undefined>;
  /** Resolves after `ms` (setTimeout; immediate in tests). */
  wait: (ms: number) => Promise<void>;
  pushEvent: (line: string) => void;
  replaceEvent: (match: (text: string) => boolean, line: string) => boolean;
  requestAttention: () => void;
  setAfterFlight: (f: AfterFlight | null) => void;
  autoSaveCard: (flightId: string) => void;
  showToast: (o: ToastOptions) => void;
  dismissToast: (id: string) => void;
  /** The "Flight saved" toast for a finished flight (shown away from the map only). */
  savedToast: (done: AfterFlight) => ToastOptions | null;
  /** How long the discarded notice stays. */
  toastMs: number;
}

/** after-flight card data of a completed row. */
export function afterFlightOf(row: FlightRow): AfterFlight | null {
  if (row.state !== "completed" || !row.onBlockMs) return null;
  return {
    flightId: row.id,
    depIcao: row.depIcao,
    arrIcao: row.arrIcao,
    landingRateFpm: row.landingVsFpm,
    blockMs: row.offBlockMs ? row.onBlockMs - row.offBlockMs : null,
    onBlockMs: row.onBlockMs,
  };
}

/** The row belongs to the end at `endMs` (not an older flight). */
export function rowEndedAt(row: FlightRow | undefined, endMs: number): boolean {
  return !!row?.onBlockMs && Math.abs(row.onBlockMs - endMs) <= END_MATCH_MS;
}

/** `flightDiscarded`: the session's end line becomes "discarded", card and saved toast go. */
export function onFlightDiscarded(e: FlightDiscard, line: string | null, deps: FlightEndDeps): void {
  noteDiscarded(e.timestampMs);
  if (line && !deps.replaceEvent(isFlightEndedLine, line)) deps.pushEvent(line);
  deps.setAfterFlight(null);
  deps.dismissToast("flight-saved");
  deps.dismissToast("landing");
  deps.dismissToast("conn");
  deps.showToast(discardedToast(deps.toastMs));
}

/** `flightEnded`: the end line now, the rest once a `flightDiscarded` can no longer come. */
export async function onFlightEnded(e: FlightEnd, line: string | null, deps: FlightEndDeps): Promise<void> {
  // the discarded notice came first: its line already stands, nothing more to say
  if (wasDiscarded(e.timestampMs)) return;
  if (line) deps.pushEvent(line);
  // the flight the "connection lost" toast reassured about is over (interrupted or saved)
  deps.dismissToast("conn");
  let row: FlightRow | undefined;
  try {
    [row] = await Promise.all([deps.latestFlight(), deps.wait(DISCARD_SETTLE_MS)]);
  } catch {
    /* logbook not readable right now: the event line under Details → Events remains */
    return;
  }
  // a ground session: flightDiscarded arrived meanwhile, rows[0] would be an older flight
  if (wasDiscarded(e.timestampMs)) return;
  deps.requestAttention();
  const done = row && rowEndedAt(row, e.timestampMs) ? afterFlightOf(row) : null;
  if (!done) return;
  deps.setAfterFlight(done);
  // optional: the landing card goes to the pictures folder by itself (setting card_autosave)
  if (done.landingRateFpm != null) deps.autoSaveCard(done.flightId);
  // the card carries the landing now; one notice is enough
  deps.dismissToast("landing");
  const toast = deps.savedToast(done);
  if (toast) deps.showToast(toast);
}
