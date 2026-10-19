import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { NNBSP } from "../format";
import { getPrefs, loadPrefs, parsePrefs } from "../prefs";
import { I18nProvider, RESOURCES, getLanguage, getLanguageSetting, isLanguageSetting, languageOfTag, resolveLanguage, setLanguageSetting, systemLanguage, t, tIn, timeBaseLabel, useLanguage, useT, type TKey } from ".";
import { isPluralForms, translate, type Resources } from "./translate";

afterEach(() => setLanguageSetting("de"));

describe("language setting", () => {
  it("maps BCP 47 tags to a supported language", () => {
    expect(languageOfTag("de-DE")).toBe("de");
    expect(languageOfTag("de-AT")).toBe("de");
    expect(languageOfTag("en_US")).toBe("en");
    expect(languageOfTag("EN")).toBe("en");
    expect(languageOfTag("fr-FR")).toBeNull();
    expect(languageOfTag("")).toBeNull();
    expect(languageOfTag(undefined)).toBeNull();
  });
  it("system follows Windows, else German", () => {
    expect(systemLanguage(["en-GB"])).toBe("en");
    expect(systemLanguage(["de-CH"])).toBe("de");
    expect(systemLanguage(["fr-FR", "en-US"])).toBe("en");
    expect(systemLanguage(["fr-FR"])).toBe("de");
    expect(systemLanguage([])).toBe("de");
    expect(resolveLanguage("system", ["en-US"])).toBe("en");
    expect(resolveLanguage("de", ["en-US"])).toBe("de");
    expect(resolveLanguage("en", ["de-DE"])).toBe("en");
  });
  it("validates stored values", () => {
    for (const v of ["de", "en", "system"]) expect(isLanguageSetting(v)).toBe(true);
    for (const v of ["fr", "", null, undefined, 1]) expect(isLanguageSetting(v)).toBe(false);
  });
  it("setLanguageSetting resolves system with the given preference", () => {
    setLanguageSetting("system", ["en-US"]);
    expect(getLanguageSetting()).toBe("system");
    expect(getLanguage()).toBe("en");
    setLanguageSetting("system", ["it-IT"]);
    expect(getLanguage()).toBe("de");
  });
});

describe("prefs field `language`", () => {
  it("parses the stored value, default system", () => {
    expect(parsePrefs([["language", "en"]]).language).toBe("en");
    expect(parsePrefs([["language", "de"]]).language).toBe("de");
    expect(parsePrefs([["language", "klingon"]]).language).toBe("system");
    expect(parsePrefs([]).language).toBe("system");
  });
  it("loading the prefs switches the active language", async () => {
    invokeMock.mockResolvedValueOnce([["language", "en"]]);
    await loadPrefs();
    expect(getPrefs().language).toBe("en");
    expect(getLanguage()).toBe("en");
    expect(t("nav.map")).toBe("Map");
    invokeMock.mockResolvedValueOnce([["language", "de"]]);
    await loadPrefs();
    expect(t("nav.map")).toBe("Karte");
  });
});

describe("translate", () => {
  it("pilot keys in both languages", () => {
    expect(tIn("de", "nav.map")).toBe("Karte");
    expect(tIn("en", "nav.map")).toBe("Map");
    expect(tIn("de", "nav.countries")).toBe("Länder");
    expect(tIn("de", "band.firm")).toBe("fest");
    expect(tIn("en", "band.firm")).toBe("firm");
  });
  it("plural via Intl.PluralRules with the count formatted for the language", () => {
    expect(tIn("de", "count.flights", { count: 1 })).toBe("1 Flug");
    expect(tIn("de", "count.flights", { count: 0 })).toBe("0 Flüge");
    expect(tIn("de", "count.flights", { count: 2 })).toBe("2 Flüge");
    expect(tIn("de", "count.flights", { count: 1500 })).toBe(`1${NNBSP}500 Flüge`);
    expect(tIn("en", "count.flights", { count: 1 })).toBe("1 flight");
    expect(tIn("en", "count.flights", { count: 1500 })).toBe("1,500 flights");
    expect(tIn("en", "count.landings", { count: 0 })).toBe("0 landings");
  });
  it("placeholders: numbers formatted, strings as they are, missing ones visible", () => {
    expect(tIn("de", "band.vsScale", { smooth: 150, normal: 300, firm: 600 })).toBe("sanft < 150 · normal < 300 · fest < 600 · hart ≥ 600 fpm");
    expect(tIn("en", "band.vsScale", { smooth: "150", normal: 300, firm: 600 })).toBe("smooth < 150 · normal < 300 · firm < 600 · hard ≥ 600 fpm");
    expect(tIn("de", "band.vsScale", { smooth: 150 })).toBe("sanft < 150 · normal < {normal} · fest < {firm} · hart ≥ {firm} fpm");
  });
  it("falls back to German, then to the key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res: Resources = { de: { a: { b: "nur deutsch", n: { one: "{count} Ding", other: "{count} Dinge" } } }, en: { a: {} } };
    expect(translate(res, "en", "a.b")).toBe("nur deutsch");
    expect(translate(res, "en", "a.n", { count: 1 })).toBe("1 Ding");
    expect(translate(res, "en", "a.missing")).toBe("a.missing");
    expect(translate(res, "de", "a")).toBe("a"); // a namespace is not a leaf
    expect(translate(res, "de", "a.b.c")).toBe("a.b.c");
    warn.mockRestore();
  });
  it("plural without a count uses `other`", () => {
    const res: Resources = { de: { n: { one: "ein", other: "viele" } }, en: {} };
    expect(translate(res, "de", "n")).toBe("viele");
    expect(translate(res, "de", "n", { count: Number.NaN })).toBe("viele");
  });
  it("recognises plural objects", () => {
    expect(isPluralForms({ one: "a", other: "b" })).toBe(true);
    expect(isPluralForms({ other: "b" })).toBe(true);
    expect(isPluralForms({ one: "a" })).toBe(false);
    expect(isPluralForms({ other: "b", map: "c" })).toBe(false);
    expect(isPluralForms("x")).toBe(false);
  });
  it("the plain t() follows the active language", () => {
    setLanguageSetting("en");
    expect(t("nav.logbook")).toBe("Logbook");
    expect(t("count.bounces", { count: 2 })).toBe("2 bounces");
    setLanguageSetting("de");
    expect(t("nav.logbook")).toBe("Logbuch");
  });
  it("time base label", () => {
    expect(timeBaseLabel(false, "de")).toBe("UTC");
    expect(timeBaseLabel(true, "de")).toBe("Ortszeit");
    expect(timeBaseLabel(true, "en")).toBe("Local time");
  });
  it("keys are typed (compile-time checks)", () => {
    // @ts-expect-error unknown key
    expect(t("nav.nope")).toBe("nav.nope");
    // @ts-expect-error plural keys need { count }
    expect(t("count.flights")).toBe("{count} Flüge");
    const k: TKey = "band.hard";
    expect(t(k)).toBe("hart");
    expect(Object.keys(RESOURCES)).toEqual(["de", "en"]);
  });
});

function Probe() {
  const tt = useT();
  const lang = useLanguage();
  return (
    <span data-lang={lang}>
      {tt("nav.map")} · {tt("count.landings", { count: 3 })}
    </span>
  );
}

describe("I18nProvider / useT", () => {
  it("renders in the active language", () => {
    setLanguageSetting("de");
    expect(renderToStaticMarkup(<I18nProvider><Probe /></I18nProvider>)).toBe('<span data-lang="de">Karte · 3 Landungen</span>');
    setLanguageSetting("en");
    expect(renderToStaticMarkup(<I18nProvider><Probe /></I18nProvider>)).toBe('<span data-lang="en">Map · 3 landings</span>');
  });
  it("a pinned provider overrides the setting for its subtree", () => {
    setLanguageSetting("de");
    expect(renderToStaticMarkup(<I18nProvider lang="en"><Probe /></I18nProvider>)).toBe('<span data-lang="en">Map · 3 landings</span>');
  });
  it("works without a provider (global language)", () => {
    setLanguageSetting("en");
    expect(renderToStaticMarkup(<Probe />)).toBe('<span data-lang="en">Map · 3 landings</span>');
  });
});
