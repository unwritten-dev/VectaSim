import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, setLanguageSetting, t } from "./i18n";
import { maskPath } from "./format";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const { importErrorToast, profileKeySourceText, profileSourceText } = await import("./ApproachProfilesPanel");
const { default: AssessedWith } = await import("./landing/AssessedWith");

afterEach(() => setLanguageSetting("en"));

const html = (node: unknown) => (isValidElement(node) ? renderToStaticMarkup(node) : String(node));

describe("approach profiles panel", () => {
  it("a file error shows a plain explanation, the path only (masked) behind Details", () => {
    setLanguageSetting("en");
    const raw = String.raw`C:\Users\Max\Documents\va.json: The process cannot access the file because it is being used by another process. (os error 32)`;
    const toast = importErrorToast(raw, t, maskPath);
    expect(toast.title).toBe("Profile not imported");
    expect(toast.announce).toContain(t("settings.approachProfiles.importFileError"));
    expect(toast.announce).not.toContain("Users");
    const body = html(toast.body);
    expect(body).toContain("<details");
    expect(body).toContain(String.raw`%USERPROFILE%\Documents\va.json`);
    expect(body).not.toContain("Max");
  });

  it("a recognised cause keeps its own next step", () => {
    setLanguageSetting("en");
    const toast = importErrorToast(String.raw`C:\Users\Max\va.json: Access is denied. (os error 5)`, t, (s) => s);
    expect(toast.announce).toContain(t("errors.accessDenied.hint"));
  });

  it("a refused profile keeps its readable reason as the text, without the repeated title", () => {
    setLanguageSetting("de");
    const toast = importErrorToast("Profil nicht importiert: unbekannter Schlüssel „foo“", t, (s) => s);
    expect(toast.title).toBe("Profil nicht importiert");
    expect(toast.body).toBe("unbekannter Schlüssel „foo“");
  });

  it("built-in sources come from i18n (no P0–P4 shorthand), custom ones as written", () => {
    setLanguageSetting("de");
    const turboprop = { id: "turboprop", name: "x", builtin: true, overrides: {}, effective: [], source: "P3: ATR …", sources: { thrustCheck: "VectaSim convention: …" } };
    expect(profileSourceText(turboprop, t)).toBe("ATR Flight Safety 2021 (±5 kt); Schubprüfung aus (VectaSim-Konvention)");
    expect(profileKeySourceText(turboprop, "thrustCheck", t)).toMatch(/^VectaSim-Konvention: /);
    expect(profileKeySourceText(turboprop, "vsS1Fpm", t)).toBeNull();
    for (const id of ["generic", "airbus", "boeing", "turboprop", "ga_piston"]) {
      expect(profileSourceText({ ...turboprop, id }, t)).not.toMatch(/^P\d/);
    }
    const custom = { id: "my-va", name: "My VA", builtin: false, overrides: {}, effective: [], source: "Our SOP 4.2" };
    expect(profileSourceText(custom, t)).toBe("Our SOP 4.2");
  });

  it("“Assessed with” is focusable and describes itself with the profile values", () => {
    const h = renderToStaticMarkup(
      <I18nProvider lang="en">
        <AssessedWith profileId="airbus" />
      </I18nProvider>,
    );
    expect(h).toContain('tabindex="0"');
    const id = /aria-describedby="([^"]+)"/.exec(h)?.[1];
    expect(id).toBeTruthy();
    expect(h).toContain(`id="${id}" class="sr-only"`);
    expect(h).not.toContain("aria-label");
  });
});
