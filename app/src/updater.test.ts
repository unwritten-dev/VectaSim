import { afterEach, describe, expect, it, vi } from "vitest";

const check = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: (...a: unknown[]) => check(...a) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
const showToast = vi.fn((o: { id?: string }) => o.id ?? "t");
vi.mock("./ui/Toast", () => ({ showToast: (o: { id?: string }) => showToast(o) }));

import { setLanguageSetting } from "./i18n";
import { checkForUpdate, installUpdate, setRecordingCheck } from "./updater";

const last = () => showToast.mock.calls[showToast.mock.calls.length - 1][0];

afterEach(() => {
  check.mockReset();
  showToast.mockClear();
  setRecordingCheck(() => false);
});

describe("update toasts follow the UI language", () => {
  it("offers the update in English without promising a background download", async () => {
    setLanguageSetting("en");
    check.mockResolvedValue({ version: "0.5.0", body: null, date: null, downloadAndInstall: vi.fn() });
    const s = await checkForUpdate({ silent: true });
    expect(s.phase).toBe("available");
    const o = last() as { title: string; body: string; actions: { label: string }[] };
    expect(o.title).toBe("Update 0.5.0 available");
    expect(o.body).toBe("“Install now” downloads the update, backs up the logbook and restarts VectaSim.");
    expect(o.actions[0].label).toBe("Install now");
  });

  it("speaks German when the UI does, also when a recording blocks the install", async () => {
    setLanguageSetting("de");
    check.mockResolvedValue({ version: "0.5.0", body: null, date: null, downloadAndInstall: vi.fn() });
    await checkForUpdate({ silent: true });
    expect((last() as { title: string }).title).toBe("Update 0.5.0 verfügbar");
    setRecordingCheck(() => true);
    await installUpdate();
    const o = last() as { title: string; body: string };
    expect(o.title).toBe("Aufzeichnung läuft – Update nach dem Flug");
    expect(o.body).toContain("Version 0.5.0");
  });

  it("a manual check that finds nothing says so; a silent one stays quiet", async () => {
    setLanguageSetting("en");
    check.mockResolvedValue(null);
    await checkForUpdate({ silent: true });
    expect(showToast).not.toHaveBeenCalled();
    await checkForUpdate();
    expect((last() as { title: string }).title).toBe("VectaSim is up to date");
  });
});
