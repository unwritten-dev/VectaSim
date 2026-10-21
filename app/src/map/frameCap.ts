// Frame budget of the live map. The simulator runs on the same PC and GPU: while the map follows a
// moving aircraft, MapLibre used to render at the display's full rate (60–144 Hz) without pause – a
// 150 ms camera ease per 10 Hz sample, overlapping seamlessly, plus the model's pose blend. Now:
//
// - follow moves that change less than half a pixel (and 2 m of camera height) are not sent, an
//   invisible model pose change neither blends nor repaints (aircraftModel.poseChangeVisible) –
//   zoomed out at cruise nothing is rendered between the samples that matter;
// - every map frame that is not part of a user gesture or a MapLibre camera animation (follow
//   camera, model blends, traffic, the source updates of each sample) is at most FRAME_MS_FOCUSED
//   apart (30 fps), and at most FRAME_MS_BACKGROUND (15 fps) while the window has no focus – the
//   usual case on the sim PC: the simulator has the focus and VectaSim sits on a second screen,
//   still visible, so it keeps moving, just with half the frames (capRenders). Capping only our own
//   animation loops was not enough: measured at a real window (2026-10-20), the per-sample source
//   updates kept the unfocused map at ~19 frames/s, the focused one at ~20;
// - a minimised window renders nothing. WebView2 does not tell the page (measured: document.hidden
//   stays false, requestAnimationFrame keeps running at the display rate, the map kept rendering
//   ~10 frames/s), so the Tauri window state is watched (watchWindow). The focus comes from Tauri as
//   well (onFocusChanged), document.hasFocus() is the fallback. A window that is only covered by
//   another one has no signal at all (document.hidden stays false there too): it renders at the
//   unfocused rate. A window hidden to the tray (close button) does set document.hidden: the
//   frame dropped meanwhile is drawn on `visibilitychange` → visible and when Tauri reports the
//   focus back (capRenders → resume), not only when leaving the minimised state;
// - our own per-frame loops (follow glide, the selected traffic model) sleep between their
//   frames (frameAfter) instead of waking at the display rate only to skip.
//
// User gestures (drag, zoom, rotate) and MapLibre's own camera animations stay at the full rate.

import { getCurrentWindow } from "@tauri-apps/api/window";

/** At most this far apart (ms) while the window has the focus: 30 fps. */
export const FRAME_MS_FOCUSED = 1000 / 30;
/** …and while another window (the simulator) has it: 15 fps. */
export const FRAME_MS_BACKGROUND = 1000 / 15;

/**
 * The window as Tauri reports it (unknown / not minimised until told: browser preview, tests,
 * before the first event). Module-wide: one window, several loops read it.
 */
const win: { focused: boolean | null; minimized: boolean } = { focused: null, minimized: false };
const returnListeners = new Set<() => void>();

/**
 * Tauri's window focus (onFocusChanged). Gaining it tells the onWindowReturn listeners as well: a
 * window brought back from the tray (hidden, never minimised) gets the focus, and that may be the
 * only signal of its return.
 */
export function setWindowFocused(focused: boolean) {
  const was = win.focused;
  win.focused = focused;
  if (focused && was !== true) notifyReturn();
}

function notifyReturn() {
  for (const f of [...returnListeners]) f();
}

/** Tauri's minimised state; leaving it tells the onWindowReturn listeners. */
export function setWindowMinimized(minimized: boolean) {
  const was = win.minimized;
  win.minimized = minimized;
  if (was && !minimized) notifyReturn();
}

/** Called when the window may show again (left the minimised state, got the focus back); returns the unsubscribe. */
export function onWindowReturn(f: () => void): () => void {
  returnListeners.add(f);
  return () => void returnListeners.delete(f);
}

/** Back to "unknown" (tests). */
export function resetWindowState() {
  win.focused = null;
  win.minimized = false;
  returnListeners.clear();
}

type Doc = Partial<Pick<Document, "hasFocus" | "hidden">>;
const currentDoc = (): Doc | undefined => (typeof document !== "undefined" ? document : undefined);

/** Another window has the focus: Tauri says so, or (fallback) the document does. */
export function windowUnfocused(doc: Doc | undefined = currentDoc()): boolean {
  if (win.focused === false) return true;
  try {
    return !!doc?.hasFocus && doc.hasFocus() === false;
  } catch {
    return false;
  }
}

/** Nothing of the map can be seen: the document is hidden or the window minimised (or in the tray). */
export function windowAway(doc: Doc | undefined = currentDoc()): boolean {
  return !!doc?.hidden || win.minimized;
}

/** Minimum time between two map frames outside gestures, by window focus. */
export function followFrameMs(doc: Doc | undefined = currentDoc()): number {
  return windowUnfocused(doc) ? FRAME_MS_BACKGROUND : FRAME_MS_FOCUSED;
}

/** The part of Tauri's window API watchWindow needs (a stand-in in tests). */
export interface WindowApi {
  onFocusChanged(cb: (e: { payload: boolean }) => void): Promise<() => void>;
  onResized(cb: () => void): Promise<() => void>;
  isMinimized(): Promise<boolean>;
  isFocused(): Promise<boolean>;
}

/**
 * Keeps the module's window state in step with Tauri: the focus from onFocusChanged, minimised from
 * isMinimized after every resize and focus change (minimising is a resize; the tray hides the window
 * right after it, restoring from the tray is a resize again). One isMinimized query at a time:
 * the resize events of a window being dragged larger (dozens a second) that arrive while one is
 * under way merge into a single follow-up query, so the last state is still read. Without Tauri
 * (browser preview) nothing happens and the DOM decides. Returns the unsubscribe.
 */
export function watchWindow(api?: WindowApi): () => void {
  let w: WindowApi;
  try {
    w = api ?? (getCurrentWindow() as unknown as WindowApi);
  } catch {
    return () => {};
  }
  let closed = false;
  const unlisten: Array<() => void> = [];
  const keep = (p: Promise<() => void>) =>
    p
      .then((f) => {
        if (closed) f();
        else unlisten.push(f);
      })
      .catch(() => {});
  let querying = false;
  let again = false;
  const checkMinimized = () => {
    if (closed) return;
    if (querying) {
      again = true;
      return;
    }
    querying = true;
    const done = () => {
      querying = false;
      if (again) {
        again = false;
        checkMinimized();
      }
    };
    w.isMinimized()
      .then((m) => {
        if (!closed) setWindowMinimized(m);
      })
      .catch(() => {})
      .finally(done);
  };
  keep(
    w.onFocusChanged(({ payload }) => {
      setWindowFocused(payload);
      checkMinimized();
    }),
  );
  keep(w.onResized(checkMinimized));
  void w
    .isFocused()
    .then((f) => {
      // an event that came first is newer
      if (!closed && win.focused === null) setWindowFocused(f);
    })
    .catch(() => {});
  checkMinimized();
  return () => {
    closed = true;
    for (const f of unlisten.splice(0)) f();
  };
}

/** The part of a MapLibre map capRenders needs. */
export interface RepaintableMap {
  triggerRepaint(): void;
  on(type: "render", f: () => void): unknown;
  off(type: "render", f: () => void): unknown;
}

/**
 * Caps every frame of `map` outside gestures and camera animations (`fullRate()`) by wrapping its
 * triggerRepaint – the one door all of MapLibre's frame requests go through (source updates, camera
 * jumps, custom layers, the continuation of its own render loop): at most one frame per `minMs()`,
 * requests in between merge into one at the end of the budget. While `away()` (minimised, hidden)
 * no frame at all; the first one after it is drawn by `resume` – called on onWindowReturn (left
 * the minimised state, focus back from Tauri) and on `visibilitychange` of `doc` (tray hide and
 * restore set document.hidden). dispose restores the original method.
 */
export function capRenders(
  map: RepaintableMap,
  fullRate: () => boolean,
  minMs: () => number = followFrameMs,
  away: () => boolean = windowAway,
  now: () => number = () => performance.now(),
  doc: Pick<EventTarget, "addEventListener" | "removeEventListener"> | undefined = typeof document !== "undefined" ? document : undefined,
): { resume(): void; dispose(): void } {
  const own = Object.prototype.hasOwnProperty.call(map, "triggerRepaint") ? map.triggerRepaint : undefined;
  const repaint = map.triggerRepaint.bind(map);
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let missed = false;
  const onRender = () => {
    last = now();
  };
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const draw = () => {
    last = now();
    repaint();
  };
  map.on("render", onRender);
  map.triggerRepaint = () => {
    if (away()) {
      cancel();
      missed = true;
      return;
    }
    if (fullRate()) {
      cancel();
      repaint();
      return;
    }
    if (timer !== undefined) return;
    const wait = last + minMs() - now();
    if (wait <= 0) draw();
    else
      timer = setTimeout(() => {
        timer = undefined;
        if (away()) missed = true;
        else draw();
      }, wait);
  };
  const resume = () => {
    if (!missed || away()) return;
    missed = false;
    cancel();
    draw();
  };
  const offReturn = onWindowReturn(resume);
  // resume itself checks away(): a change to hidden does nothing
  const onVisibility = () => resume();
  doc?.addEventListener("visibilitychange", onVisibility);
  return {
    resume,
    dispose() {
      cancel();
      offReturn();
      doc?.removeEventListener("visibilitychange", onVisibility);
      map.off("render", onRender);
      if (own) map.triggerRepaint = own;
      else delete (map as Partial<RepaintableMap>).triggerRepaint;
    },
  };
}

/**
 * Tolerance of the "frame due" checks of those loops (ms): an animation frame's timestamp is the
 * start of its frame, up to a few ms before the callback runs.
 */
export const FRAME_SLACK_MS = 4;

/**
 * Runs `cb` on the first animation frame at least `delayMs` from now: sleeps in a timer until
 * shortly before (the loops that render at the follow frame rate woke at the display's 60–144 Hz
 * only to skip), then waits for the frame. `delayMs <= 0`: the next frame. Returns the cancel.
 */
export function frameAfter(delayMs: number, cb: (t: number) => void): () => void {
  let raf: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const frame = () => {
    timer = undefined;
    raf = requestAnimationFrame((t) => {
      raf = undefined;
      cb(t);
    });
  };
  // the frame after the timer comes up to one display frame later: wake that much early
  const sleep = delayMs - FRAME_SLACK_MS;
  if (sleep > 1) timer = setTimeout(frame, sleep);
  else frame();
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    if (raf !== undefined) cancelAnimationFrame(raf);
    timer = raf = undefined;
  };
}
