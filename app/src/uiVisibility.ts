// Whether anybody can see the window, for the backend's 1 Hz telemetry throttle (`set_ui_visible`).
// WebView2 never fires `visibilitychange` on minimise (document.hidden stays false), so Tauri's
// window state decides as well: minimising is a resize, after which isMinimized() says so;
// restoring is a resize again. `visibilitychange` stays as the fallback (tray hide, browser
// preview). Focus is not the signal: an unfocused window next to the sim is still visible – but a
// focus change is a reason to ask again (back from the tray, `show()` need not resize). Only the
// newest isMinimized() answer counts: minimise + quick restore are two resizes, and the older
// answer ("minimised") must not land last and keep the backend at 1 Hz.

/** Visible = the document is shown and the window is not minimised. */
export function uiVisible(state: { hidden: boolean; minimized: boolean }): boolean {
  return !state.hidden && !state.minimized;
}

/** The part of Tauri's window API the watcher needs (a stand-in in tests). */
export interface VisibilityWindowApi {
  onResized(cb: () => void): Promise<() => void>;
  isMinimized(): Promise<boolean>;
  /** Focus gained or lost (optional): re-check after the tray's show(). */
  onFocusChanged?(cb: () => void): Promise<() => void>;
}

/** The part of the document the watcher needs. */
export interface VisibilityDoc {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Calls `report(visible)` now and on every change (only changes): from `visibilitychange` on
 * `doc` and from resize + isMinimized on `win` (omitted: browser preview, the DOM alone decides).
 * `forget()`: someone else reported meanwhile (the tray hide), so the next check reports again.
 */
export function watchUiVisibility(
  report: (visible: boolean) => void,
  doc: VisibilityDoc,
  win?: VisibilityWindowApi,
): { stop: () => void; forget: () => void } {
  let minimized = false;
  let last: boolean | null = null;
  let closed = false;
  const push = () => {
    if (closed) return;
    const v = uiVisible({ hidden: doc.hidden, minimized });
    if (v === last) return;
    last = v;
    report(v);
  };
  // one IPC round trip at a time: a resize storm (window drag, minimise + restore) asks once
  // now and once more afterwards instead of once per resize
  let inflight = false;
  let again = false;
  const checkMinimized = () => {
    if (!win) return;
    if (inflight) {
      again = true;
      return;
    }
    inflight = true;
    void win
      .isMinimized()
      .then((m) => {
        // a newer check is pending: this answer is stale (minimise + quick restore), the
        // follow-up's answer counts
        if (again) return;
        minimized = m;
        push();
      })
      .catch(() => {})
      .then(() => {
        inflight = false;
        if (again && !closed) {
          again = false;
          checkMinimized();
        }
      });
  };
  const onVisibility = () => {
    push();
    checkMinimized();
  };
  doc.addEventListener("visibilitychange", onVisibility);
  const unlisteners: Array<() => void> = [];
  const keep = (p: Promise<() => void> | undefined) =>
    void p
      ?.then((f) => {
        if (closed) f();
        else unlisteners.push(f);
      })
      .catch(() => {});
  keep(win?.onResized(checkMinimized));
  keep(win?.onFocusChanged?.(checkMinimized));
  push();
  checkMinimized();
  return {
    stop: () => {
      closed = true;
      doc.removeEventListener("visibilitychange", onVisibility);
      unlisteners.splice(0).forEach((f) => f());
    },
    // no check here: right after the tray's hide() the document may not say "hidden" yet; the
    // next resize, focus change or visibilitychange reports
    forget: () => {
      last = null;
    },
  };
}
