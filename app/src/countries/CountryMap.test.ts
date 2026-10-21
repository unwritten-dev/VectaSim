import { describe, expect, it, vi } from "vitest";
import type { VisitedAirport } from "./countries";

vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url", () => ({ default: "worker.js" }));

const { addCountryLayers, pinsGeoJson, selectionBounds } = await import("./CountryMap");

const square = (iso2: string, w: number, s: number, e: number, n: number): GeoJSON.Feature => ({
  type: "Feature",
  properties: { iso2 },
  geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
});
const outlines: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [square("DE", 6, 47, 15, 55), square("RU", -180, 41, 180, 82)] };
const apt = (ident: string, iso2: string, lon: number, lat: number): VisitedAirport => ({ ident, name: ident, latitude: lat, longitude: lon, iso2, landings: 1 });

describe("country map helpers", () => {
  it("pins only while shown", () => {
    const a = [apt("EDDF", "DE", 8.57, 50.03)];
    expect(pinsGeoJson(a, true).features).toEqual([{ type: "Feature", properties: { ident: "EDDF", iso2: "DE" }, geometry: { type: "Point", coordinates: [8.57, 50.03] } }]);
    expect(pinsGeoJson(a, false).features).toEqual([]);
  });

  it("selection bounds: the outline, else the visited airports plus 1°, never a world-wide box", () => {
    expect(selectionBounds(outlines, [], "DE")).toEqual([
      [6, 47],
      [15, 55],
    ]);
    // Monaco has no outline at 1:110m
    const mc = selectionBounds(outlines, [apt("LNMC", "MC", 7.42, 43.73)], "MC")!;
    expect(mc.flat().map((v) => +v.toFixed(6))).toEqual([6.42, 42.73, 8.42, 44.73]);
    expect(selectionBounds(outlines, [], "RU")).toBeNull();
    expect(selectionBounds(outlines, [], "XX")).toBeNull();
  });
});

describe("country layers on a (fake) map", () => {
  it("fills and outlines below the first basemap label, pins on top", () => {
    const layers: Array<{ id: string; type: string }> = [
      { id: "background", type: "background" },
      { id: "place_city", type: "symbol" },
    ];
    const sources: string[] = [];
    const map = {
      getStyle: () => ({ layers }),
      addSource: (id: string) => void sources.push(id),
      addLayer: (l: { id: string; type: string }, before?: string) => {
        const at = before ? layers.findIndex((x) => x.id === before) : -1;
        if (at < 0) layers.push(l);
        else layers.splice(at, 0, l);
      },
    };
    addCountryLayers(map as never, outlines);
    expect(sources).toEqual(["countries", "visited-airports"]);
    expect(layers.map((l) => l.id)).toEqual(["background", "countries-fill", "countries-line", "countries-selected", "place_city", "visited-airports-dot", "visited-airports-label"]);
  });
});
