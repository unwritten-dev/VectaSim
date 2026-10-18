// High-frequency live data (sim:telemetry 10 Hz, sim:flight with every telemetry emit,
// sim:stats 1 Hz) lives here instead of in App's state: a module store read through
// useSyncExternalStore with selectors, so only the components that show a value re-render
// when it changes – not the root and with it the logbook, settings or countries view.

import { useCallback, useRef, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import type { FlightSummary, GeoPoint, Stats, Telemetry } from "./types";

export interface LiveState {
  telemetry: Telemetry | null;
  flight: FlightSummary | null;
  stats: Stats | null;
}

const EMPTY: LiveState = { telemetry: null, flight: null, stats: null };

let state: LiveState = EMPTY;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function getLiveState(): LiveState {
  return state;
}

function patch(p: Partial<LiveState>) {
  state = { ...state, ...p };
  emit();
}

export const setTelemetry = (telemetry: Telemetry | null) => patch({ telemetry });
export const setFlight = (flight: FlightSummary | null) => patch({ flight });
export const setStats = (stats: Stats | null) => patch({ stats });

/**
 * Another provider (demo started/ended): its session starts empty. `init` carries what the
 * new status snapshot already knows (last telemetry, flight); stats always start over.
 */
export function resetLive(init: Partial<Pick<LiveState, "telemetry" | "flight">> = {}) {
  state = { ...EMPTY, ...init };
  emit();
}

export function subscribeLive(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/**
 * Registers the sim:telemetry / sim:flight / sim:stats listeners once. `acceptTelemetry` gates
 * the telemetry frames: one still in flight from a provider that was just stopped would put the
 * old aircraft back on the map, so telemetry only counts while a provider is connected. Returns
 * the cleanup (App calls this from its mount effect).
 */
export function startTelemetryListeners(acceptTelemetry: () => boolean = () => true): () => void {
  const unlisteners = [
    listen<Telemetry>("sim:telemetry", (e) => {
      if (acceptTelemetry()) setTelemetry(e.payload);
    }),
    listen<FlightSummary>("sim:flight", (e) => setFlight(e.payload)),
    listen<Stats>("sim:stats", (e) => setStats(e.payload)),
  ];
  return () => {
    unlisteners.forEach((p) => p.then((un) => un()).catch(() => {}));
  };
}

// ---- selectors -------------------------------------------------------------------------

/**
 * Memoised selection: returns the previous result while `equals` says nothing changed, so
 * useSyncExternalStore sees the same snapshot and skips the re-render. Pure (testable without
 * a DOM); the hook keeps one per component.
 */
export function createSelection<T>() {
  let has = false;
  let lastState: LiveState | undefined;
  let lastSelector: ((s: LiveState) => T) | undefined;
  let lastValue: T;
  return (s: LiveState, selector: (s: LiveState) => T, equals: (a: T, b: T) => boolean): T => {
    // a selector that closes over props is new per render: run it again then
    if (has && s === lastState && selector === lastSelector) return lastValue;
    const next = selector(s);
    lastState = s;
    lastSelector = selector;
    if (has && equals(lastValue, next)) return lastValue;
    has = true;
    lastValue = next;
    return next;
  };
}

/** Subscribe to a slice of the live state; re-renders only when `equals` reports a change. */
export function useTelemetrySelector<T>(selector: (s: LiveState) => T, equals: (a: T, b: T) => boolean = Object.is): T {
  const selection = useRef<ReturnType<typeof createSelection<T>> | null>(null);
  if (!selection.current) selection.current = createSelection<T>();
  const sel = selection.current;
  // the latest selector/equals of this render (closures over props are fine)
  const getSnapshot = useCallback(() => sel(state, selector, equals), [sel, selector, equals]);
  return useSyncExternalStore(subscribeLive, getSnapshot, getSnapshot);
}

const selectTelemetry = (s: LiveState) => s.telemetry;
const selectFlight = (s: LiveState) => s.flight;
const selectStats = (s: LiveState) => s.stats;

/** Every telemetry sample (the map, the systems list). */
export const useTelemetry = () => useTelemetrySelector(selectTelemetry);
/** Every flight summary (the side panel's times and totals). */
export const useFlight = () => useTelemetrySelector(selectFlight);
export const useStats = () => useTelemetrySelector(selectStats);

const sameGeo = (a: GeoPoint | null | undefined, b: GeoPoint | null | undefined) =>
  a === b || (!!a && !!b && a.latitude === b.latitude && a.longitude === b.longitude) || (a == null && b == null);

/** What recordingStatus reads of a flight: state and off-block. */
export type RecFlight = Pick<FlightSummary, "state" | "offBlockMs">;
export const recFlightEqual = (a: RecFlight | null, b: RecFlight | null) =>
  a === b || (!!a && !!b && a.state === b.state && (a.offBlockMs ?? null) === (b.offBlockMs ?? null));
/**
 * The flight for the recording status (App, sidebar button, settings): the object only
 * changes when state or off-block do – not with each sim:flight (sent with every telemetry).
 */
export const useRecFlight = (): FlightSummary | null => useTelemetrySelector(selectFlight, recFlightEqual);

/** The flight fields the live view's frame needs (route, phase, cards); totals are not part of it. */
export type FlightHead = Pick<FlightSummary, "state" | "phase" | "offBlockMs" | "takeoffMs" | "landingMs" | "departure" | "arrival">;
export const flightHeadEqual = (a: FlightHead | null, b: FlightHead | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.state === b.state &&
    a.phase === b.phase &&
    (a.offBlockMs ?? null) === (b.offBlockMs ?? null) &&
    (a.takeoffMs ?? null) === (b.takeoffMs ?? null) &&
    (a.landingMs ?? null) === (b.landingMs ?? null) &&
    sameGeo(a.departure, b.departure) &&
    sameGeo(a.arrival, b.arrival));
export const useFlightHead = (): FlightHead | null => useTelemetrySelector(selectFlight, flightHeadEqual);

/** Equality for small value objects of numbers/booleans/strings (one level). */
export function shallowEqual<T extends object | null>(a: T, b: T): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  if (ka.length !== Object.keys(rb).length) return false;
  return ka.every((k) => Object.is(ra[k], rb[k]));
}
