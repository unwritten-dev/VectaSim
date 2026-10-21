import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
const zoomMock = vi.fn((_f: number) => Promise.resolve());
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: (f: number) => zoomMock(f) }) }));

const toastMock = vi.fn();
vi.mock("./ui/Toast", () => ({ showToast: (...args: unknown[]) => toastMock(...args) }));

import { ZOOM_STEPS, getPrefs, getZoom, initZoom, parsePrefs, setPref, setZoom, stepZoom, togglePrivacyMode } from "./prefs";
import { getLanguage, setLanguageSetting, type LanguageSetting } from "./i18n";

/** The prefs store owns the language (publish → setLanguageSetting), so switch it there. */
async function switchLanguage(lang: LanguageSetting) {
  invokeMock.mockResolvedValueOnce(undefined);
  await setPref("language", lang);
  setLanguageSetting(lang);
}

beforeEach(() => {
  invokeMock.mockReset();
  toastMock.mockReset();
});
afterEach(() => setLanguageSetting("de"));

describe("togglePrivacyMode", () => {
  it("toasts in English when the UI is English", async () => {
    await switchLanguage("en");
    expect(getLanguage()).toBe("en");
    invokeMock.mockResolvedValue(undefined);
    await togglePrivacyMode(true);
    expect(toastMock).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Streamer mode on", body: expect.stringMatching(/^Registrations, callsigns/) }));
    await togglePrivacyMode(false);
    expect(toastMock).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Streamer mode off", body: "Everything is shown in full again." }));
  });

  it("toasts in German when the UI is German", async () => {
    await switchLanguage("de");
    invokeMock.mockResolvedValue(undefined);
    await togglePrivacyMode(true);
    expect(toastMock).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Streamer-Modus an" }));
    await togglePrivacyMode(false);
  });

  it("reports a failure with a translated title and no raw error text", async () => {
    await switchLanguage("en");
    invokeMock.mockRejectedValue("database is locked");
    await togglePrivacyMode(true);
    const arg = toastMock.mock.lastCall?.[0] as { title: string; body: string; tone: string };
    expect(arg.tone).toBe("warn");
    expect(arg.title).toBe("Streamer mode not switched");
    expect(arg.body).not.toContain("database is locked");
    expect(getPrefs().privacyMode).toBe(false);
  });
});

describe("setPref rollback", () => {
  it("reverts only the failed key and keeps a parallel change", async () => {
    let rejectFirst: (e: unknown) => void = () => {};
    invokeMock.mockImplementationOnce(() => new Promise((_, reject) => (rejectFirst = reject))).mockResolvedValueOnce(undefined);
    const startDemo = getPrefs().showDemo;
    const startUnit = getPrefs().weightUnit;
    const first = setPref("showDemo", !startDemo);
    const second = setPref("weightUnit", startUnit === "kg" ? "lb" : "kg");
    await second;
    rejectFirst(new Error("disk full"));
    await expect(first).rejects.toThrow("disk full");
    expect(getPrefs().showDemo).toBe(startDemo);
    expect(getPrefs().weightUnit).toBe(startUnit === "kg" ? "lb" : "kg");
  });

  it("does not undo a later value of the same key", async () => {
    let rejectFirst: (e: unknown) => void = () => {};
    invokeMock.mockImplementationOnce(() => new Promise((_, reject) => (rejectFirst = reject))).mockResolvedValueOnce(undefined);
    const first = setPref("timeLocal", true);
    await setPref("timeLocal", false);
    rejectFirst(new Error("x"));
    await expect(first).rejects.toThrow();
    expect(getPrefs().timeLocal).toBe(false);
  });
});

describe("parsePrefs defaults", () => {
  it("an empty settings table gives the documented defaults", () => {
    const p = parsePrefs([]);
    // off unless switched on
    for (const k of ["timeLocal", "showDemo", "privacyMode", "cardAutosave", "cardHideReg", "discordPresence"] as const) expect(p[k], k).toBe(false);
    // on unless switched off
    for (const k of ["airframePhotos", "simbriefAuto", "notifications", "notifyLanding", "simTextLanding", "notifySaved", "notifyConnection", "notifyUpdate", "trayMinimize", "trayClose"] as const)
      expect(p[k], k).toBe(true);
    expect(p.weightUnit).toBe("kg");
    expect(p.language).toBe("system");
  });
  it("reads stored values and ignores unknown ones", () => {
    const p = parsePrefs([
      ["notifications", "0"],
      ["notify_landing", "0"],
      ["airframe_photos", "0"],
      ["simbrief_auto", "0"],
      ["weight_unit", "lbs"],
      ["language", "fr"],
      ["theme", "nope"],
    ]);
    expect(p.notifications).toBe(false);
    expect(p.notifyLanding).toBe(false);
    expect(p.notifySaved).toBe(true);
    expect(p.airframePhotos).toBe(false);
    expect(p.simbriefAuto).toBe(false);
    expect(p.weightUnit).toBe("kg");
    expect(p.language).toBe("system");
    expect(p.theme).toBe(parsePrefs([]).theme);
  });
});

describe("zoom", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    zoomMock.mockClear();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    setZoom(1);
  });

  it("snaps to the nearest step, applies and remembers it", () => {
    setZoom(1.4);
    expect(getZoom()).toBe(1.5);
    expect(zoomMock).toHaveBeenLastCalledWith(1.5);
    expect(store.get("vectasim.zoom")).toBe("1.5");
    setZoom(0.1);
    expect(getZoom()).toBe(ZOOM_STEPS[0]);
  });
  it("Ctrl+Plus/Minus walk the steps and stop at both ends", () => {
    setZoom(1);
    stepZoom(1);
    expect(getZoom()).toBe(1.1);
    for (let i = 0; i < 10; i++) stepZoom(1);
    expect(getZoom()).toBe(1.5);
    for (let i = 0; i < 10; i++) stepZoom(-1);
    expect(getZoom()).toBe(0.8);
  });
  it("initZoom restores the stored factor (snapped) and falls back to 100 %", () => {
    store.set("vectasim.zoom", "1.26");
    zoomMock.mockClear();
    initZoom();
    expect(getZoom()).toBe(1.25);
    expect(zoomMock).toHaveBeenCalledWith(1.25);
    store.set("vectasim.zoom", "garbage");
    initZoom();
    expect(getZoom()).toBe(1);
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    initZoom();
    expect(getZoom()).toBe(1);
  });
});
