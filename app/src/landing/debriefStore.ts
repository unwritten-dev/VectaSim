// Which landing debrief is open. A tiny external store (like ui/Toast.tsx) so the
// logbook, the landing toast and the live view can open it without prop drilling;
// App renders <LandingDebrief> for it.

import { useSyncExternalStore } from "react";

export interface DebriefTarget {
  flightId: string;
  /** Touchdown index within the flight; null = the last one. */
  touchdownIndex: number | null;
  /** Approach index within the flight (approach_analysis); null = the one of the shown touchdown, else the last. */
  approachIndex: number | null;
}

let current: DebriefTarget | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openDebrief(flightId: string, touchdownIndex: number | null = null, approachIndex: number | null = null) {
  current = { flightId, touchdownIndex, approachIndex };
  emit();
}

/**
 * True while the debrief (the app's only modal) is open: global shortcuts (Ctrl+1/2/3,
 * Ctrl+., Ctrl+F) check this and stay quiet, so nothing changes or takes focus behind it.
 */
export function isDebriefOpen(): boolean {
  return current != null;
}

export function closeDebrief() {
  if (!current) return;
  current = null;
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useDebrief(): DebriefTarget | null {
  return useSyncExternalStore(subscribe, () => current);
}
