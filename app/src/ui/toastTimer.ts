// Auto-dismiss timer of one toast, without React so it can be unit-tested (Toast.tsx → ToastCard).
//   - `durationMs: null` (errors) never expires;
//   - hover/focus pauses, leaving resumes with what was left (at least 1.5 s);
//   - `holdWhileUnfocused` (landing notice while the pilot is in the sim): no countdown while
//     the window is in the background, and back in front the full duration starts again –
//     unless the pointer or the focus still rests on the toast (a landing notice reached with
//     Alt+T must not vanish under the focus after the window was away and back).

export interface ToastTimerOptions {
  durationMs: number | null;
  holdWhileUnfocused?: boolean;
  /** Window hidden or without focus. */
  windowAway: () => boolean;
  onExpire: () => void;
  now?: () => number;
}

/** What holds a toast open: the pointer over it, the focus inside it. */
export type ToastHold = "hover" | "focus";

export interface ToastTimer {
  /** Start (mount): clears every hold. */
  start(): void;
  /** Hover/focus: stop and keep the rest; the hold stays until `resume` with the same reason. */
  pause(reason?: ToastHold): void;
  /** Mouse leave / focus left the toast: runs again once no hold is left. */
  resume(reason: ToastHold): void;
  /** Window lost focus / hidden (only with holdWhileUnfocused). */
  away(): void;
  /** Window back in front (only with holdWhileUnfocused): the full duration again. */
  back(): void;
  dispose(): void;
}

/** Shortest rest after a pause, so a toast never vanishes right under the pointer. */
export const MIN_REST_MS = 1500;

export function toastTimer(o: ToastTimerOptions): ToastTimer {
  const now = o.now ?? Date.now;
  let remaining = o.durationMs;
  let started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const held = () => !!o.holdWhileUnfocused && o.windowAway();
  const holds = new Set<ToastHold>();

  const run = () => {
    if (remaining == null || held() || holds.size > 0) return;
    started = now();
    clear();
    timer = setTimeout(() => {
      timer = undefined;
      o.onExpire();
    }, remaining);
  };
  return {
    start() {
      holds.clear();
      run();
    },
    pause(reason = "hover") {
      holds.add(reason);
      // not running (already paused, or held in the background): nothing elapsed to subtract
      if (remaining == null || timer === undefined) return;
      clear();
      remaining = Math.max(MIN_REST_MS, remaining - (now() - started));
    },
    resume(reason) {
      holds.delete(reason);
      run();
    },
    away() {
      if (remaining == null) return;
      clear();
    },
    back() {
      if (o.windowAway() || remaining == null) return;
      remaining = o.durationMs;
      run();
    },
    dispose: clear,
  };
}
