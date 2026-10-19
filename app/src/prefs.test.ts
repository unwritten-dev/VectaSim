import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }) }));

const toastMock = vi.fn();
vi.mock("./ui/Toast", () => ({ showToast: (...args: unknown[]) => toastMock(...args) }));

import { getPrefs, setPref, togglePrivacyMode } from "./prefs";
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
