import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLanguageSetting } from "../i18n";
import { CATEGORY_COLOR } from "../theme";
import { DEFAULT_WEATHER, saveWeatherPrefs, setWeatherMaster, getWeatherState } from "./weatherOverlay";
import { METAR_LEGEND, WeatherLegend, metarLegend } from "./WeatherToggle";

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  setWeatherMaster(true);
  saveWeatherPrefs({ ...DEFAULT_WEATHER });
  vi.unstubAllGlobals();
});

describe("METAR legend", () => {
  it("shows while Wetter and the METAR rings are on, dimmed below their zoom", () => {
    setWeatherMaster(true);
    saveWeatherPrefs({ metar: true, radar: false, clouds: false });
    expect(metarLegend(getWeatherState(), 9, 7)).toEqual({ belowZoom: false });
    expect(metarLegend(getWeatherState(), 5, 7)).toEqual({ belowZoom: true });
    saveWeatherPrefs({ metar: false, radar: true, clouds: false });
    expect(metarLegend(getWeatherState(), 9, 7)).toBeNull();
    saveWeatherPrefs({ metar: true, radar: false, clouds: false });
    setWeatherMaster(false);
    expect(metarLegend(getWeatherState(), 9, 7)).toBeNull();
  });

  it("names the five ring colours with the map's own colours and explains them", () => {
    setLanguageSetting("en");
    setWeatherMaster(true);
    saveWeatherPrefs({ metar: true, radar: false, clouds: false });
    const html = renderToStaticMarkup(createElement(WeatherLegend, { zoom: 9, metarZoom: 7 }));
    expect(METAR_LEGEND.map((c) => c.cat)).toEqual(["VFR", "MVFR", "IFR", "LIFR", "UNKNOWN"]);
    for (const c of METAR_LEGEND) expect(html).toContain(`border-color:${CATEGORY_COLOR[c.cat]}`);
    expect(html).toContain("LIFR: ceiling below 500 ft or visibility below 1 SM");
    // zoomed out: no swatches, only when the rings appear
    const far = renderToStaticMarkup(createElement(WeatherLegend, { zoom: 5, metarZoom: 7 }));
    expect(far).toContain("from zoom 7");
    expect(far).not.toContain("metar-ring");
  });

  it("is German in the German UI and absent when nothing is shown", () => {
    setLanguageSetting("de");
    setWeatherMaster(true);
    saveWeatherPrefs({ metar: true, radar: false, clouds: false });
    expect(renderToStaticMarkup(createElement(WeatherLegend, { zoom: 9 }))).toContain("VFR: Wolkenuntergrenze über 3000 ft");
    saveWeatherPrefs({ metar: false, radar: false, clouds: false });
    expect(renderToStaticMarkup(createElement(WeatherLegend, { zoom: 9 }))).toBe("");
  });
});
