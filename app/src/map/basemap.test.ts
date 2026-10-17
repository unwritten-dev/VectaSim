import { describe, expect, it } from "vitest";
import type { StyleSpecification } from "maplibre-gl";
import { patchBasemapStyle } from "./basemap";
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

describe("patchBasemapStyle (Nachtcockpit, 01 §3.6)", () => {
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
