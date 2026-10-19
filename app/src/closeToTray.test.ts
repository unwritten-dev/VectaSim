import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAction, takeTrayHint } from "./closeToTray";
import { parsePrefs } from "./prefs";

const base = { quitting: false, trayActive: true, closeToTray: true, recording: false };

afterEach(() => vi.unstubAllGlobals());

describe("close button", () => {
  it("hides into the tray by default, also during a recording", () => {
    expect(closeAction(base)).toBe("hide");
    expect(closeAction({ ...base, recording: true })).toBe("hide");
  });

  it("quits when the tray icon is missing or the option is off – asking during a recording", () => {
    expect(closeAction({ ...base, trayActive: false })).toBe("close");
    expect(closeAction({ ...base, closeToTray: false })).toBe("close");
    expect(closeAction({ ...base, closeToTray: false, recording: true })).toBe("ask");
  });

  it("Quit from the tray menu really quits and still asks mid-flight", () => {
    expect(closeAction({ ...base, quitting: true })).toBe("close");
    expect(closeAction({ ...base, quitting: true, recording: true })).toBe("ask");
  });

  it("tray icon and close-to-tray are on unless switched off", () => {
    expect(parsePrefs([])).toMatchObject({ trayMinimize: true, trayClose: true });
    expect(parsePrefs([["tray_minimize", "0"], ["tray_close", "0"]])).toMatchObject({ trayMinimize: false, trayClose: false });
    expect(parsePrefs([["tray_minimize", "1"]])).toMatchObject({ trayMinimize: true });
  });

  it("explains the first hide once", () => {
    const m = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) });
    expect(takeTrayHint()).toBe(true);
    expect(takeTrayHint()).toBe(false);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(takeTrayHint()).toBe(false);
  });
});
