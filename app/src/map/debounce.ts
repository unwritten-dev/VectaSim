// Debounce with an upper bound: calls `fn` once `waitMs` passed without a new call, but never
// later than `maxWaitMs` after the first call of a burst. The live map's online / METAR refresh
// runs on every `moveend`; the 3D follow camera eases to the aircraft on every telemetry sample
// (several `moveend`s per second, endlessly while airborne), so a plain trailing debounce never
// fired and traffic, ATC and METAR rings stayed empty after a cold start with the 3D view on.

export interface BoundedDebounce {
  (): void;
  /** Drops a pending call. */
  cancel(): void;
}

export function boundedDebounce(fn: () => void, waitMs: number, maxWaitMs: number): BoundedDebounce {
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Start of the pending burst (Date.now clock), null while nothing is pending. */
  let since: number | null = null;
  const fire = () => {
    timer = undefined;
    since = null;
    fn();
  };
  const call = () => {
    const now = Date.now();
    if (since === null) since = now;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(fire, Math.max(0, Math.min(waitMs, since + maxWaitMs - now)));
  };
  call.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    since = null;
  };
  return call;
}

/**
 * Wait / max-wait (ms) of the live map's per-move refreshes. While following, the camera ends a
 * move with every follow frame (up to 30 per second), so each refresh runs at most every max-wait:
 * ≈ 2 airport lookups, 1 online re-filter, 2 diagram and 2 readout lookups (zoomed in) and
 * ⅔ METAR batch per second (followIpc.test.ts measures it).
 */
export const MOVE_REFRESH = {
  airports: [150, 500],
  online: [250, 1000],
  metars: [600, 1500],
  traffic3d: [100, 300],
  diagram: [150, 500],
  readout: [150, 500],
} as const satisfies Record<string, readonly [number, number]>;
