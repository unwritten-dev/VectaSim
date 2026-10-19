import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAP_STYLE_EVENT,
  MAP_STYLE_STORAGE_KEY,
  SATELLITE_LAYER,
  SATELLITE_MAX_ZOOM,
  SATELLITE_SOURCE,
  SATELLITE_TILES,
  applySatellite,
  keptOverImagery,
  loadMapStyle,
  satelliteBeforeId,
  saveMapStyle,
  type SatelliteTarget,
} from "./satellite";

/** In-memory localStorage for the node test environment. */
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

describe("map style choice", () => {
  it("defaults to the map and only reads an explicit satellite", () => {
    expect(loadMapStyle()).toBe("map");
    localStorage.setItem(MAP_STYLE_STORAGE_KEY, "garbage");
    expect(loadMapStyle()).toBe("map");
    localStorage.setItem(MAP_STYLE_STORAGE_KEY, "satellite");
    expect(loadMapStyle()).toBe("satellite");
  });

  it("persists the choice and tells every map", () => {
    const seen: string[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener(MAP_STYLE_EVENT, on);
    saveMapStyle("satellite");
    saveMapStyle("map");
    window.removeEventListener(MAP_STYLE_EVENT, on);
    expect(seen).toEqual(["satellite", "map"]);
    expect(localStorage.getItem(MAP_STYLE_STORAGE_KEY)).toBe("map");
  });

  it("falls back to the map without storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadMapStyle()).toBe("map");
  });
});

describe("satellite tiles", () => {
  it("uses the CC BY 2017 edition in Web Mercator, row before column", () => {
    expect(SATELLITE_TILES).toBe("https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2017_3857/default/g/{z}/{y}/{x}.jpg");
    expect(SATELLITE_MAX_ZOOM).toBeLessThanOrEqual(15);
  });
});

const STYLE = [
  { id: "background", type: "background" },
  { id: "water", type: "fill", source: "openmaptiles", "source-layer": "water" },
  { id: "water_name", type: "symbol", source: "openmaptiles", "source-layer": "water_name" },
  { id: "highway_minor", type: "line", source: "openmaptiles", "source-layer": "transportation" },
  { id: "boundary_country_z5-", type: "line", source: "openmaptiles", "source-layer": "boundary" },
  { id: "place_city", type: "symbol", source: "openmaptiles", "source-layer": "place" },
  { id: "track", type: "line", source: "track" },
] as const;

function fakeMap() {
  const layers: Array<{ id: string; type: string; source?: string; "source-layer"?: string }> = STYLE.map((l) => ({ ...l }));
  const sources = new Set(["openmaptiles", "track"]);
  const layout = new Map<string, unknown>();
  const paint = new Map<string, unknown>([["place_city|text-color", "#abcdef"]]);
  const map: SatelliteTarget & { layers: typeof layers; layout: typeof layout; paint: typeof paint } = {
    layers,
    layout,
    paint,
    getStyle: () => ({ layers }),
    getSource: (id) => (sources.has(id) ? {} : undefined),
    addSource: (id) => void sources.add(id),
    removeSource: (id) => void sources.delete(id),
    getLayer: (id) => layers.find((l) => l.id === id),
    addLayer: (layer, before) => {
      const l = layer as (typeof layers)[number];
      const at = before ? layers.findIndex((x) => x.id === before) : layers.length;
      layers.splice(at < 0 ? layers.length : at, 0, l);
    },
    removeLayer: (id) => void layers.splice(layers.findIndex((l) => l.id === id), 1),
    getLayoutProperty: (id, k) => layout.get(`${id}|${k}`),
    setLayoutProperty: (id, k, v) => void layout.set(`${id}|${k}`, v),
    getPaintProperty: (id, k) => paint.get(`${id}|${k}`),
    setPaintProperty: (id, k, v) => void (v === undefined ? paint.delete(`${id}|${k}`) : paint.set(`${id}|${k}`, v)),
  };
  return map;
}

describe("applySatellite", () => {
  it("keeps names and country borders over the imagery, hides the rest of the basemap", () => {
    expect(keptOverImagery(STYLE[5])).toBe("label");
    expect(keptOverImagery(STYLE[2])).toBe("label");
    expect(keptOverImagery(STYLE[4])).toBe("border");
    expect(keptOverImagery(STYLE[3])).toBeNull();
    expect(keptOverImagery(STYLE[6])).toBeNull();
  });

  it("puts the imagery right above the background", () => {
    expect(satelliteBeforeId([...STYLE])).toBe("water");
    const m = fakeMap();
    applySatellite(m, true);
    expect(m.layers.map((l) => l.id).slice(0, 3)).toEqual(["background", SATELLITE_LAYER, "water"]);
    expect(m.getSource(SATELLITE_SOURCE)).toBeDefined();
    expect(m.layout.get("water|visibility")).toBe("none");
    expect(m.layout.get("highway_minor|visibility")).toBe("none");
    expect(m.layout.get("place_city|visibility")).toBeUndefined();
    // our own layers are never touched
    expect(m.layout.get("track|visibility")).toBeUndefined();
    expect(m.paint.get("place_city|text-color")).toBe("#f2f5f8");
  });

  it("is idempotent and restores the vector map exactly", () => {
    const m = fakeMap();
    applySatellite(m, true);
    applySatellite(m, true);
    expect(m.layers.filter((l) => l.id === SATELLITE_LAYER)).toHaveLength(1);
    applySatellite(m, false);
    expect(m.getLayer(SATELLITE_LAYER)).toBeUndefined();
    expect(m.getSource(SATELLITE_SOURCE)).toBeUndefined();
    expect(m.layout.get("water|visibility")).toBe("visible");
    expect(m.paint.get("place_city|text-color")).toBe("#abcdef");
    expect(m.paint.has("place_city|text-halo-width")).toBe(false);
  });
});
