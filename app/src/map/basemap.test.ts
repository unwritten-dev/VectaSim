import { describe, expect, it } from "vitest";
import type { StyleSpecification } from "maplibre-gl";
import { labelTextField, localizeLabels, patchBasemapStyle, referencesMissingIcon } from "./basemap";
import { themeById } from "../themes";

const style = {
  version: 8,
  sources: {},
  layers: [
    { id: "background", type: "background", paint: { "background-color": "rgb(12,12,12)" } },
    { id: "water", type: "fill", source: "o", paint: { "fill-color": "rgb(27,27,29)" } },
    { id: "aeroway-runway", type: "line", source: "o", minzoom: 11, paint: { "line-color": "#000", "line-width": 4 } },
    { id: "railway_minor", type: "line", source: "o", paint: { "line-color": "rgb(35,35,35)" } },
    { id: "building", type: "fill", source: "o", minzoom: 12, paint: { "fill-color": "rgb(10,10,10)" } },
    { id: "place_city_large", type: "symbol", source: "o", layout: { "text-size": 14 }, paint: { "text-color": "rgb(101,101,101)" } },
    { id: "something_else", type: "line", source: "o", paint: { "line-color": "red" } },
  ],
} as unknown as StyleSpecification;

type L = { paint?: Record<string, unknown>; layout?: Record<string, unknown>; minzoom?: number };
const layerOf = (s: StyleSpecification, id: string) => s.layers.find((l) => l.id === id) as unknown as L | undefined;

describe("patchBasemapStyle (Nachtcockpit)", () => {
  const out = patchBasemapStyle(style, themeById("nachtcockpit"));
  const layer = (id: string) => layerOf(out, id)!;

  it("makes runways visible and tints land and water", () => {
    expect(layer("background").paint?.["background-color"]).toBe("#0b0f14");
    expect(layer("water").paint?.["fill-color"]).toBe("#0d1822");
    expect(layer("aeroway-runway").paint?.["line-color"]).toBe("#4a5563");
    // untouched paint keys survive
    expect(layer("aeroway-runway").paint?.["line-width"]).toBe(4);
  });

  it("hides railways, raises building minzoom, quiets city labels", () => {
    expect(layer("railway_minor").layout?.visibility).toBe("none");
    expect(layer("building").minzoom).toBe(14);
    expect(layer("place_city_large").paint?.["text-color"]).toBe("#7d8896");
    expect(layer("place_city_large").layout?.["text-size"]).toBe(14);
    expect(layer("place_city_large").layout?.["text-letter-spacing"]).toBe(0.08);
  });

  it("leaves unknown layers and the input alone, adds no grid", () => {
    expect(layer("something_else").paint?.["line-color"]).toBe("red");
    expect((style.layers[0] as { paint: Record<string, unknown> }).paint["background-color"]).toBe("rgb(12,12,12)");
    expect(layerOf(out, "vectasim-graticule")).toBeUndefined();
  });
});

describe("patchBasemapStyle (light themes)", () => {
  it("Papierkarte: paper land, map-blue water, ink runway, graticule below buildings", () => {
    const out = patchBasemapStyle(style, themeById("papierkarte"));
    expect(layerOf(out, "background")!.paint?.["background-color"]).toBe("#f1ebdc");
    expect(layerOf(out, "water")!.paint?.["fill-color"]).toBe("#c9dce6");
    expect(layerOf(out, "aeroway-runway")!.paint?.["line-color"]).toBe("#2e3238");
    const ids = out.layers.map((l) => l.id);
    expect(ids.indexOf("vectasim-graticule")).toBeGreaterThan(-1);
    expect(ids.indexOf("vectasim-graticule")).toBeLessThan(ids.indexOf("building"));
    expect(out.sources["vectasim-graticule"]).toBeTruthy();
  });
});

describe("basemap labels in the UI language (UX 1.11 / 5.2)", () => {
  const named = {
    version: 8,
    sources: {},
    layers: [
      { id: "place_country_major", type: "symbol", source: "o", "source-layer": "place", layout: { "text-field": "{name:latin}\n{name:nonlatin}" } },
      { id: "poi_label", type: "symbol", source: "o", "source-layer": "poi", layout: { "text-field": ["get", "name"] } },
      { id: "housenumber", type: "symbol", source: "o", "source-layer": "housenumber", layout: { "text-field": "{housenumber}" } },
      { id: "vatsim-pilots-label", type: "symbol", source: "g", layout: { "text-field": ["get", "callsign"] } },
    ],
  } as unknown as StyleSpecification;

  it("German: name:de, then Latin, then the local name; only basemap name labels", () => {
    const out = patchBasemapStyle(named, themeById("signal"), "de");
    expect(layerOf(out, "place_country_major")!.layout?.["text-field"]).toEqual(["coalesce", ["get", "name:de"], ["get", "name_de"], ["get", "name:latin"], ["get", "name"]]);
    expect(layerOf(out, "poi_label")!.layout?.["text-field"]).toEqual(labelTextField("de"));
    expect(layerOf(out, "housenumber")!.layout?.["text-field"]).toBe("{housenumber}");
    expect(layerOf(out, "vatsim-pilots-label")!.layout?.["text-field"]).toEqual(["get", "callsign"]);
    // the patched place layer keeps its theme patch too
    expect(layerOf(out, "place_country_major")!.layout?.["text-letter-spacing"]).toBe(0.08);
  });

  it("English: name:en", () => {
    const out = patchBasemapStyle(named, themeById("signal"), "en");
    expect(layerOf(out, "place_country_major")!.layout?.["text-field"]).toEqual(labelTextField("en"));
    expect(JSON.stringify(labelTextField("en"))).toContain("name:en");
  });

  it("localizeLabels re-labels a running map", () => {
    const calls: Array<[string, unknown]> = [];
    localizeLabels({ getStyle: () => ({ layers: named.layers as never }), setLayoutProperty: (id: string, _n: string, v: unknown) => calls.push([id, v]) }, "en");
    expect(calls.map((c) => c[0])).toEqual(["place_country_major", "poi_label"]);
    expect(calls[0][1]).toEqual(labelTextField("en"));
  });
});

describe("missing sprite icon (Image \"circle-11\" could not be loaded)", () => {
  const withDot = {
    version: 8,
    sources: {},
    layers: [
      { id: "place_town", type: "symbol", source: "o", layout: { "icon-image": ["step", ["zoom"], "circle-11", 9, ""], "text-field": "{name}" } },
      { id: "road_oneway", type: "symbol", source: "o", layout: { "icon-image": "oneway" } },
    ],
  } as unknown as StyleSpecification;

  it("finds the id in a plain value and inside an expression", () => {
    expect(referencesMissingIcon("circle-11")).toBe(true);
    expect(referencesMissingIcon(["step", ["zoom"], "circle-11", 9, ""])).toBe(true);
    expect(referencesMissingIcon("circle_11")).toBe(false);
    expect(referencesMissingIcon(undefined)).toBe(false);
  });

  it("drops only that icon-image; other icons and the label stay", () => {
    const out = patchBasemapStyle(withDot, themeById("nachtcockpit"));
    expect(layerOf(out, "place_town")!.layout?.["icon-image"]).toBeUndefined();
    expect(layerOf(out, "place_town")!.layout?.["text-field"]).toBeDefined();
    // the input is untouched
    expect((withDot.layers[0] as unknown as L).layout?.["icon-image"]).toBeDefined();
  });
});
