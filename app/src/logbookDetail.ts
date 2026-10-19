// Loading the selected logbook flight (Logbook.tsx): flight row first, then a tiny preview track,
// then – debounced – the full track. Fast ↑/↓ through the list must not request the full track
// of every flight it passes, so every follow-up call checks `cancelled` first and the full track
// waits FULL_TRACK_DEBOUNCE_MS (a newer selection cancels it before it is sent).

import type { FlightDetail as Detail, TrackSample } from "./types";

/** Delay before the full track of a newly selected flight is requested. */
export const FULL_TRACK_DEBOUNCE_MS = 150;

export interface DetailLoadDeps {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  /** True once the selection moved on (effect cleanup). */
  cancelled: () => boolean;
  /** Resolves after `ms` (setTimeout; injectable for tests). */
  wait: (ms: number) => Promise<void>;
  onDetail: (d: Detail | null) => void;
  onTrack: (track: TrackSample[]) => void;
}

/**
 * Loads flight `id`. `keepTrack`: the same flight is already shown (store refresh of the running
 * flight, retry) – no preview and no debounce, the full track replaces the shown one.
 */
export async function loadFlightDetail(id: string, keepTrack: boolean, deps: DetailLoadDeps): Promise<void> {
  const { invoke, cancelled, wait, onDetail, onTrack } = deps;
  const d = await invoke<Detail | null>("get_flight", { id });
  if (cancelled()) return;
  onDetail(d);
  if (!d) return;
  const active = d.flight.state === "active";
  if (d.hasTrack && !keepTrack) {
    const p = await invoke<TrackSample[] | null>("get_track", { id, preview: true });
    if (cancelled()) return;
    if (p) onTrack(p);
  }
  if (!keepTrack) {
    await wait(FULL_TRACK_DEBOUNCE_MS);
    if (cancelled()) return;
  }
  let full = d.hasTrack ? await invoke<TrackSample[] | null>("get_track", { id, preview: false }) : null;
  if (cancelled()) return;
  // the running flight's track may not be written yet: use the recorder's live buffer
  if ((!full || full.length === 0) && active) {
    full = await invoke<TrackSample[]>("get_live_track");
    if (cancelled()) return;
  }
  if (full) onTrack(full);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
