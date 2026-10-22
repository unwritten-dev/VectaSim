// When does a shown flight's approach assessment (`approach_analysis`) change without the flight
// itself changing? A new assessment profile, Vapp or landing flaps in the fleet
// (airframes.rs → `approach:facts` with the registration + `flight:metrics`), a custom profile
// imported, replaced or deleted (approach.rs → `approach:profiles` + `approach:facts` +
// `flight:metrics`, no payload), the facts of a just ended flight (`approach:facts` /
// `flight:metrics` with its id) and a runway correction in the debrief, which the backend does
// not announce (`save_user_runway` / `delete_user_runway` drop the facts silently) – the frontend
// signals that one itself (`notifyApproachDataChanged`).
//
// `watchApproachChanges` folds all of these into one debounced callback per shown flight; the
// flight detail (markers, metrics row, full-screen view) and the landing summary reload on it.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/** Backend events that may change a flight's assessment. */
export const APPROACH_CHANGE_EVENTS = ["approach:facts", "approach:profiles", "flight:metrics"] as const;

/** Profile changes come as two or three events within milliseconds: one reload for all. */
export const APPROACH_CHANGE_DEBOUNCE_MS = 300;

export interface ApproachTarget {
  flightId: string;
  /** Registration of the airframe the flight is booked onto (`FlightRow.airframeReg`). */
  registration?: string | null;
}

/**
 * Does an event payload concern this flight? No payload or an empty string (a flight unbooked
 * from its airframe, `set_flight_airframe` with no registration) = every flight; else a flight
 * id (`spawn_store_facts`) or a registration (`upsert_airframe`, rebook, merge, delete).
 */
export function concernsFlight(payload: unknown, target: ApproachTarget): boolean {
  if (typeof payload !== "string") return payload == null;
  const p = payload.trim();
  if (!p) return true;
  if (p === target.flightId) return true;
  const reg = target.registration?.trim();
  return !!reg && p.toUpperCase() === reg.toUpperCase();
}

// ---- in-window signal ----------------------------------------------------------------------

type LocalListener = (payload: string | null) => void;
const local = new Set<LocalListener>();

/** Listen to `notifyApproachDataChanged` (same window only). */
export function onLocalApproachChange(cb: LocalListener): () => void {
  local.add(cb);
  return () => {
    local.delete(cb);
  };
}

/**
 * The approach / landing facts changed in a way the backend does not announce (runway
 * correction): the shown flight detail and landing summary reload. (The facts store and the
 * logbook strips reload on the `logbook:changed` RunwayEditor emits as well.)
 * `flightId` null = possibly every flight (a runway is shared).
 */
export function notifyApproachDataChanged(flightId: string | null = null): void {
  [...local].forEach((cb) => cb(flightId));
}

// ---- watcher ---------------------------------------------------------------------------------

/** Calls `onChange` (debounced, trailing) when an event may have changed the flight's assessment. */
export function watchApproachChanges(target: ApproachTarget, onChange: () => void, debounceMs = APPROACH_CHANGE_DEBOUNCE_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const hit = (payload: unknown) => {
    if (stopped || !concernsFlight(payload, target)) return;
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!stopped) onChange();
    }, debounceMs);
  };
  const unlisten = APPROACH_CHANGE_EVENTS.map((name) => listen(name, (e) => hit(e.payload)));
  const offLocal = onLocalApproachChange(hit);
  return () => {
    stopped = true;
    if (timer != null) clearTimeout(timer);
    offLocal();
    unlisten.forEach((u) => u.then((f) => f()).catch(() => {}));
  };
}

/** A counter that goes up when the flight's assessment may have changed (dependency for a reload effect). */
export function useApproachRevision(flightId: string, registration?: string | null): number {
  const [rev, setRev] = useState(0);
  useEffect(() => watchApproachChanges({ flightId, registration }, () => setRev((n) => n + 1)), [flightId, registration]);
  return rev;
}
