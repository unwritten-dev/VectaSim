import { useSyncExternalStore } from "react";

/** One line of the live event list (Karte → Seitenpanel → Flug → Ereignisse). */
export interface LogLine {
  ms: number;
  text: string;
}

/**
 * Lines kept per provider session. A go-around flight brings ~40 lines (phases twice, touchdown,
 * outcome, pauses); a long session with several circuits more – the newest ones stay.
 */
export const EVENT_LOG_MAX = 200;
const STORAGE_KEY = "vectasim.liveEvents";

interface Stored {
  provider: string | null;
  lines: LogLine[];
}

/**
 * The event list of the running provider session (newest first). It lives outside the React
 * tree – App used to hold it in component state, so anything that remounted App (a Fast Refresh
 * or a reload of the webview while the flight goes on) emptied it, while flight, off-block and
 * block time came back from the backend snapshot: after the go-around the badge read 1 instead
 * of 27. A copy in sessionStorage carries it over a reload of the page; it belongs to the
 * provider it was written for and is dropped when another one reports in (`syncEventProvider`).
 */
let state: Stored = load();
const listeners = new Set<() => void>();

function load(): Stored {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { provider: null, lines: [] };
    const v = JSON.parse(raw) as Partial<Stored>;
    const lines = Array.isArray(v.lines) ? v.lines.filter((l): l is LogLine => !!l && typeof l.ms === "number" && typeof l.text === "string") : [];
    return { provider: typeof v.provider === "string" ? v.provider : null, lines: lines.slice(0, EVENT_LOG_MAX) };
  } catch {
    return { provider: null, lines: [] };
  }
}

function commit(next: Stored) {
  state = next;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked or full: the list still works for this page */
  }
  listeners.forEach((l) => l());
}

export function getEvents(): LogLine[] {
  return state.lines;
}

/** Newest first; beyond `EVENT_LOG_MAX` the oldest line goes. */
export function pushEvent(text: string, ms: number = Date.now()) {
  commit({ ...state, lines: [{ ms, text }, ...state.lines].slice(0, EVENT_LOG_MAX) });
}

/** Another provider session starts empty (demo started or ended). */
export function clearEvents(provider: string | null = state.provider) {
  commit({ provider, lines: [] });
}

/**
 * The provider of the current status: the list belongs to it. A different one than the list was
 * written for (also after a reload while the provider changed) empties it; the same one keeps it.
 */
export function syncEventProvider(provider: string) {
  if (state.provider === provider) return;
  // first status of a fresh page: lines that came in before it are this provider's
  if (state.provider == null) commit({ ...state, provider });
  else clearEvents(provider);
}

export function subscribeEvents(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useEventLog(): LogLine[] {
  return useSyncExternalStore(subscribeEvents, getEvents, getEvents);
}

/** Tests: forget the module state (sessionStorage is the caller's). */
export function resetEventLogForTests() {
  state = load();
  listeners.clear();
}
