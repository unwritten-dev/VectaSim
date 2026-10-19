// What the window's close button (X, Alt+F4, taskbar "Close window") does.
//
// With the tray icon on and "Close hides VectaSim in the notification area" on (both the
// default), closing only hides the window: recording, overlays and Discord go on, a double click
// on the tray icon brings it back. "Quit" in the tray menu really quits (the backend emits
// `app:quit` first, so the close that follows is not turned into a hide) and still asks while a
// flight is being recorded. Without a tray icon (switched off, or it could not be created)
// closing quits as before.

export type CloseAction = "hide" | "ask" | "close";

export interface CloseContext {
  /** "Quit" from the tray menu is under way. */
  quitting: boolean;
  /** The tray icon exists right now (backend `tray_active`). */
  trayActive: boolean;
  /** Setting `tray_close` (default on). */
  closeToTray: boolean;
  /** A real flight is being recorded (not the demo). */
  recording: boolean;
}

export function closeAction(c: CloseContext): CloseAction {
  if (!c.quitting && c.trayActive && c.closeToTray) return "hide";
  return c.recording ? "ask" : "close";
}

const HINT_KEY = "vectasim.trayCloseHinted";

/** True once per installation: the first hide explains where VectaSim went. */
export function takeTrayHint(): boolean {
  try {
    if (localStorage.getItem(HINT_KEY) === "1") return false;
    localStorage.setItem(HINT_KEY, "1");
    return true;
  } catch {
    return false;
  }
}
