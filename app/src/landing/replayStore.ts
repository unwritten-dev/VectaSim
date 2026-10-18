// Shared time cursor of the debrief (and of the logbook detail): every chart reads `tMs` and
// draws its cursor there, hovering/clicking a chart sets it, the ReplayBar plays it back.
// Plain external stores (useSyncExternalStore); one per context – the debrief has its own, so
// opening it over the logbook does not move the logbook's cursor and closing it resets cleanly.

import { createContext, useContext, useSyncExternalStore } from "react";
import type { ApproachAnalysis, MarkerKind } from "./approachTypes";
import type { LandingAnalysis } from "./types";

export type ReplaySpeed = 1 | 2 | 4 | 8;
export const REPLAY_SPEEDS: ReplaySpeed[] = [1, 2, 4, 8];

export interface ReplayRange {
  startMs: number;
  endMs: number;
}

/** A jump target of the transport bar (10 nm, FAF, gates, threshold, touchdown, standstill). */
export interface ReplayMarker {
  key: string;
  label: string;
  tMs: number;
}

export interface ReplayState {
  /** Cursor time, epoch ms; null = no cursor. */
  tMs: number | null;
  playing: boolean;
  speed: ReplaySpeed;
  /** Playable span; null = not configured (hover-only cursor, no transport bar). */
  range: ReplayRange | null;
  /** Jump targets inside the range, time order. */
  markers: ReplayMarker[];
}

export interface ReplayStore {
  get(): ReplayState;
  subscribe(l: () => void): () => void;
  /** Range and markers of what is shown; the cursor is clamped into the new range. */
  configure(range: ReplayRange | null, markers?: ReplayMarker[]): void;
  /** Pins the cursor (click, slider, keys); clamped into the range when one is set. */
  setCursor(tMs: number | null): void;
  /** Preview while the pointer is over a chart; null = back to the pinned cursor. Ignored while playing. */
  hover(tMs: number | null): void;
  play(): void;
  pause(): void;
  toggle(): void;
  setSpeed(speed: ReplaySpeed): void;
  /** ± seconds from the cursor (from the range start without one); pauses. */
  step(seconds: number): void;
  /** To a marker (or its key); keeps playing when it was. */
  jumpTo(marker: ReplayMarker | string): void;
  /** Home / End. */
  toStart(): void;
  toEnd(): void;
  /** Advances a running playback by `dtMs` of real time × speed; stops at the end. */
  advance(dtMs: number): void;
  /** Everything back to the initial state (range and markers too). */
  reset(): void;
}

const INITIAL: ReplayState = { tMs: null, playing: false, speed: 1, range: null, markers: [] };

const clampTo = (t: number, r: ReplayRange | null) => (r ? Math.min(r.endMs, Math.max(r.startMs, t)) : t);

export function createReplayStore(): ReplayStore {
  let state: ReplayState = INITIAL;
  /** The cursor a hover returns to. */
  let pinned: number | null = null;
  const listeners = new Set<() => void>();

  const set = (next: Partial<ReplayState>) => {
    const merged = { ...state, ...next };
    if (
      merged.tMs === state.tMs &&
      merged.playing === state.playing &&
      merged.speed === state.speed &&
      merged.range === state.range &&
      merged.markers === state.markers
    )
      return;
    state = merged;
    listeners.forEach((l) => l());
  };
  const pin = (t: number | null, extra: Partial<ReplayState> = {}) => {
    pinned = t == null ? null : clampTo(t, state.range);
    set({ tMs: pinned, ...extra });
  };

  const store: ReplayStore = {
    get: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    configure(range, markers = []) {
      const r = range && Number.isFinite(range.startMs) && Number.isFinite(range.endMs) && range.endMs > range.startMs ? range : null;
      const same = r && state.range && r.startMs === state.range.startMs && r.endMs === state.range.endMs;
      const ms = markers.filter((m) => Number.isFinite(m.tMs) && (!r || (m.tMs >= r.startMs && m.tMs <= r.endMs))).sort((a, b) => a.tMs - b.tMs);
      const sameMarkers = ms.length === state.markers.length && ms.every((m, i) => m.key === state.markers[i].key && m.tMs === state.markers[i].tMs);
      const range2 = same ? state.range : r;
      if (pinned != null) pinned = clampTo(pinned, range2);
      set({
        range: range2,
        markers: sameMarkers ? state.markers : ms,
        tMs: state.tMs == null ? null : clampTo(state.tMs, range2),
        playing: range2 ? state.playing : false,
      });
    },
    setCursor: (t) => pin(t),
    hover(t) {
      if (state.playing) return;
      set({ tMs: t == null ? pinned : clampTo(t, state.range) });
    },
    play() {
      const r = state.range;
      if (!r) return;
      // from the start when there is no cursor or it sits at the end
      const t = state.tMs == null || state.tMs >= r.endMs ? r.startMs : clampTo(state.tMs, r);
      pin(t, { playing: true });
    },
    pause() {
      if (state.playing) pin(state.tMs, { playing: false });
    },
    toggle() {
      if (state.playing) store.pause();
      else store.play();
    },
    setSpeed(speed) {
      if (REPLAY_SPEEDS.includes(speed)) set({ speed });
    },
    step(seconds) {
      const base = state.tMs ?? state.range?.startMs;
      if (base == null) return;
      pin(base + seconds * 1000, { playing: false });
    },
    jumpTo(marker) {
      const m = typeof marker === "string" ? state.markers.find((x) => x.key === marker) : marker;
      if (!m) return;
      pin(m.tMs);
    },
    toStart() {
      if (state.range) pin(state.range.startMs, { playing: false });
    },
    toEnd() {
      if (state.range) pin(state.range.endMs, { playing: false });
    },
    advance(dtMs) {
      const r = state.range;
      if (!state.playing || !r || !(dtMs > 0)) return;
      const t = (state.tMs ?? r.startMs) + dtMs * state.speed;
      if (t >= r.endMs) pin(r.endMs, { playing: false });
      else pin(t);
    },
    reset() {
      pinned = null;
      set(INITIAL);
    },
  };
  return store;
}

/** The logbook's cursor (flight detail: profile chart ↔ track map). */
export const logbookReplay = createReplayStore();
/** The landing debrief's cursor; reset when the debrief closes. */
export const debriefReplay = createReplayStore();

/** Which store the charts below use; without a provider the logbook's. */
export const ReplayContext = createContext<ReplayStore>(logbookReplay);

export function useReplayStore(): ReplayStore {
  return useContext(ReplayContext);
}

/** Subscribes to the whole state (re-renders on every playback frame – keep it to small cursor parts). */
export function useReplay(store?: ReplayStore): ReplayState {
  const ctx = useContext(ReplayContext);
  const s = store ?? ctx;
  return useSyncExternalStore(s.subscribe, s.get, s.get);
}

/** Only the cursor time. */
export function useReplayCursor(store?: ReplayStore): number | null {
  const ctx = useContext(ReplayContext);
  const s = store ?? ctx;
  const get = () => s.get().tMs;
  return useSyncExternalStore(s.subscribe, get, get);
}

/** A primitive derived from the cursor time; re-renders only when it changes (table highlights). */
export function useReplaySelect<R extends string | number | boolean | null>(select: (tMs: number | null) => R, store?: ReplayStore): R {
  const ctx = useContext(ReplayContext);
  const s = store ?? ctx;
  const get = () => select(s.get().tMs);
  return useSyncExternalStore(s.subscribe, get, get);
}

/** Index of the item whose time is nearest to `tMs` (null without a cursor or items). */
export function nearestIndex(times: readonly (number | null | undefined)[], tMs: number | null): number | null {
  if (tMs == null) return null;
  let best: number | null = null;
  let bestE = Infinity;
  times.forEach((t, i) => {
    if (t == null) return;
    const e = Math.abs(t - tMs);
    if (e < bestE) {
      bestE = e;
      best = i;
    }
  });
  return best;
}

// ---------------------------------------------------------------------------------------
// Interpolation

type Timed = { tMs: number };

/** First index with tMs >= t (samples in time order). */
export function lowerBoundT(samples: readonly Timed[], t: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].tMs < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The sample at `tMs`, linearly interpolated between the two neighbouring samples (time
 * order): finite numbers are interpolated, everything else (booleans, null, strings) comes
 * from the nearer neighbour; a number next to null is taken from the nearer one as well.
 * Null for no samples or a time outside [first, last].
 */
export function sampleAt<T extends Timed>(samples: readonly T[], tMs: number | null | undefined): T | null {
  if (tMs == null || !Number.isFinite(tMs) || samples.length === 0) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (tMs < first.tMs || tMs > last.tMs) return null;
  const i = lowerBoundT(samples, tMs);
  const b = samples[i];
  if (b.tMs === tMs || i === 0) return b;
  const a = samples[i - 1];
  const span = b.tMs - a.tMs;
  const f = span > 0 ? (tMs - a.tMs) / span : 0;
  const near = f < 0.5 ? a : b;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(near)) {
    const va = (a as Record<string, unknown>)[k];
    const vb = (b as Record<string, unknown>)[k];
    out[k] = typeof va === "number" && typeof vb === "number" && Number.isFinite(va) && Number.isFinite(vb) ? va + (vb - va) * f : (near as Record<string, unknown>)[k];
  }
  out.tMs = tMs;
  return out as T;
}

/**
 * Time at which `value(sample)` reaches `v`, interpolated on the first segment that brackets
 * it (distance axes: flown distance, runway x); the nearest sample's time when none does.
 * Samples where `value` is null are skipped. Null without usable samples.
 */
export function timeAtValue<T extends Timed>(samples: readonly T[], value: (s: T) => number | null | undefined, v: number): number | null {
  let prev: T | null = null;
  let pv = 0;
  let best: number | null = null;
  let bestE = Infinity;
  for (const s of samples) {
    const sv = value(s);
    if (sv == null || !Number.isFinite(sv)) continue;
    const e = Math.abs(sv - v);
    if (e < bestE) {
      bestE = e;
      best = s.tMs;
    }
    if (prev && (pv - v) * (sv - v) <= 0 && pv !== sv) {
      return prev.tMs + ((v - pv) / (sv - pv)) * (s.tMs - prev.tMs);
    }
    prev = s;
    pv = sv;
  }
  return best;
}

/** Initial bearing a → b, ° true (0 = north). */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return ((Math.atan2(y, x) / r) % 360 + 360) % 360;
}

/** Heading of a sampled track at `tMs` from its positions (for tracks without a heading field). */
export function trackBearingAt(samples: readonly (Timed & { latitude: number; longitude: number })[], tMs: number): number | null {
  if (samples.length < 2) return null;
  let i = Math.min(samples.length - 1, Math.max(1, lowerBoundT(samples, tMs)));
  // skip standing still (same position): look back for a real displacement
  let a = samples[i - 1];
  const b = samples[i];
  while (i > 1 && a.latitude === b.latitude && a.longitude === b.longitude) a = samples[--i - 1];
  if (a.latitude === b.latitude && a.longitude === b.longitude) return null;
  return bearingDeg(a.latitude, a.longitude, b.latitude, b.longitude);
}

/** Circular interpolation of two headings, °. */
export function lerpHeading(a: number, b: number, f: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * f + 360) % 360;
}

// ---------------------------------------------------------------------------------------
// The debrief's playback span and jump targets

const APPROACH_MARKER_LABEL: Partial<Record<MarkerKind, string>> = {
  tenNm: "10 nm",
  faf: "FAF",
  gate1000: "1000 ft",
  gate500: "500 ft",
  threshold: "Schwelle",
  touchdown: "Aufsetzen",
  goAround: "Durchstarten",
};

/**
 * Range and markers of the debrief's transport bar: from the first approach sample (without
 * an approach analysis from 1000 ft, else the start of the landing track) to the standstill
 * (end of the rollout; the approach's last sample for a go-around). Markers: 10 nm, FAF,
 * 1000 ft, 500 ft, threshold, touchdown (go-around: lowest point), standstill.
 */
export function debriefReplayPlan(a: LandingAnalysis | null, apr: ApproachAnalysis | null): { range: ReplayRange | null; markers: ReplayMarker[] } {
  const markers: ReplayMarker[] = [];
  let startMs: number | null = null;
  let endMs: number | null = null;
  const aprOk = apr && apr.samples.length >= 2 ? apr : null;
  if (aprOk) {
    startMs = aprOk.samples[0].tMs;
    endMs = aprOk.samples[aprOk.samples.length - 1].tMs;
    const seen = new Set<string>();
    for (const m of aprOk.markers) {
      const label = APPROACH_MARKER_LABEL[m.kind];
      if (!label || seen.has(m.kind)) continue;
      // the last pass of a gate is the one the gate checks use
      const lastOfKind = [...aprOk.markers].reverse().find((x) => x.kind === m.kind)!;
      seen.add(m.kind);
      markers.push({ key: m.kind, label, tMs: lastOfKind.tMs });
    }
  }
  if (a && a.samples.length >= 2) {
    const s = a.samples;
    const g1000 = a.gates.find((g) => g.gateFt === 1000)?.sample?.tMs;
    if (startMs == null) startMs = g1000 != null && g1000 > s[0].tMs ? g1000 : s[0].tMs;
    endMs = Math.max(endMs ?? -Infinity, s[s.length - 1].tMs);
    if (!aprOk) {
      for (const g of a.gates) if (g.sample && (g.gateFt === 1000 || g.gateFt === 500)) markers.push({ key: `gate${g.gateFt}`, label: `${g.gateFt} ft`, tMs: g.sample.tMs });
      if (a.threshold) markers.push({ key: "threshold", label: "Schwelle", tMs: a.threshold.tMs });
      markers.push({ key: "touchdown", label: "Aufsetzen", tMs: a.touchdown.timestampMs });
    }
    if (a.rollout) markers.push({ key: "standstill", label: "Stillstand", tMs: s[s.length - 1].tMs });
  }
  if (startMs == null || endMs == null || !(endMs > startMs)) return { range: null, markers: [] };
  const range = { startMs, endMs };
  return { range, markers: markers.filter((m) => m.tMs >= startMs! && m.tMs <= endMs!).sort((p, q) => p.tMs - q.tMs) };
}
