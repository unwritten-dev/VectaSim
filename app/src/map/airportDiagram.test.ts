import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runway } from "../types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const { addAirportDiagramLayers, bearing, findAerowaySource, runwaysGeoJson } = await import("./airportDiagram");

const rwy = (over: Partial<Runway> = {}): Runway => ({
  airport: "EDDF",
  surface: "ASP",
  leIdent: "07C",
  leLatitude: 50.0326,
  leLongitude: 8.5345,
  leHeadingDeg: 68,
  heIdent: "25C",
  heLatitude: 50.0451,
  heLongitude: 8.5869,
  heHeadingDeg: 248,
  widthFt: 197,
  ...over,
});

describe("runway bearing", () => {
  it("north, east, south and west", () => {
    expect(bearing(50, 8, 51, 8)).toBeCloseTo(0, 6);
    expect(bearing(0, 8, 0, 9)).toBeCloseTo(90, 6);
    expect(bearing(51, 8, 50, 8)).toBeCloseTo(180, 6);
    expect(bearing(0, 9, 0, 8)).toBeCloseTo(270, 6);
  });
});

describe("runwaysGeoJson", () => {
  it("a line per runway and a designator per end, rotated along the heading", () => {
    const fc = runwaysGeoJson([rwy()]);
    expect(fc.features).toHaveLength(3);
    const [line, le, he] = fc.features;
    expect(line.geometry.type).toBe("LineString");
    expect(line.properties?.grass).toBe(false);
    expect(le.properties).toEqual({ ident: "07C", rotate: 68 });
    expect(he.properties).toEqual({ ident: "25C", rotate: 248 });
    // ~120 m inside the threshold, towards the other end
    const [lon, lat] = (le.geometry as GeoJSON.Point).coordinates;
    expect(lon).toBeGreaterThan(8.5345);
    expect(lat).toBeGreaterThan(50.0326);
  });

  it("without headings: from the thresholds, the other end reversed; grass and missing ends", () => {
    const fc = runwaysGeoJson([
      rwy({ leHeadingDeg: null, heHeadingDeg: null, surface: "GRASS" }),
      rwy({ leLatitude: null }),
      rwy({ heLatitude: 50.0326, heLongitude: 8.5345 }),
    ]);
    expect(fc.features).toHaveLength(3);
    expect(fc.features[0].properties?.grass).toBe(true);
    const leHdg = fc.features[1].properties?.rotate as number;
    const heHdg = fc.features[2].properties?.rotate as number;
    expect(leHdg).toBeCloseTo(bearing(50.0326, 8.5345, 50.0451, 8.5869), 6);
    expect(heHdg).toBeCloseTo((leHdg + 180) % 360, 6);
  });
});

/** Just enough of a MapLibre map for the diagram: style, sources with setData, camera, events. */
class FakeMap {
  zoom = 14;
  center = { lng: 8.57, lat: 50.04 };
  layers: Array<{ id: string; type: string; source?: string; "source-layer"?: string }> = [{ id: "aeroway_fill", type: "fill", source: "openmaptiles", "source-layer": "aeroway" }];
  sources = new Map<string, { setData: (d: unknown) => void; data?: unknown }>([["openmaptiles", { setData() {} }]]);
  handlers = new Map<string, Array<() => void>>();
  getStyle() {
    return { sources: { openmaptiles: { type: "vector" } }, layers: this.layers };
  }
  getLayer(id: string) {
    return this.layers.find((l) => l.id === id);
  }
  addLayer(l: { id: string; type: string }) {
    if (this.getLayer(l.id)) throw new Error(`Layer "${l.id}" already exists.`);
    this.layers.push(l);
  }
  getSource(id: string) {
    return this.sources.get(id);
  }
  addSource(id: string) {
    if (this.sources.has(id)) throw new Error(`Source "${id}" already exists.`);
    const src: { setData: (d: unknown) => void; data?: unknown } = {
      setData: (d) => {
        src.data = d;
      },
    };
    this.sources.set(id, src);
  }
  getZoom() {
    return this.zoom;
  }
  getCenter() {
    return this.center;
  }
  getBounds() {
    const { lng, lat } = this.center;
    return { getWest: () => lng - 0.02, getEast: () => lng + 0.02, getSouth: () => lat - 0.01, getNorth: () => lat + 0.01 };
  }
  on(ev: string, fn: () => void) {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
  }
  off(ev: string, fn: () => void) {
    this.handlers.set(
      ev,
      (this.handlers.get(ev) ?? []).filter((f) => f !== fn),
    );
  }
  fire(ev: string) {
    for (const f of this.handlers.get(ev) ?? []) f();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  invoke.mockImplementation((cmd: string, args: { ident?: string }) => {
    if (cmd === "airports_in_bbox") return Promise.resolve([{ ident: "EDDF", kind: "large" }, { ident: "EDFE", kind: "small" }, { ident: "XHEL", kind: "heliport" }]);
    if (cmd === "get_airport") return Promise.resolve({ runways: args.ident === "EDDF" ? [rwy()] : [] });
    return Promise.resolve(null);
  });
});
afterEach(() => vi.useRealTimers());

describe("airport diagram on a (fake) map", () => {
  it("finds the basemap's aeroway source and adds its layers once (a second style load does not throw)", () => {
    const m = new FakeMap();
    expect(findAerowaySource(m as never)).toBe("openmaptiles");
    const off = addAirportDiagramLayers(m as never);
    const count = m.layers.length;
    expect(m.layers.some((l) => l.id === "apd-taxiway")).toBe(true);
    expect(m.sources.has("apd-rwy")).toBe(true);
    off();
    expect(() => addAirportDiagramLayers(m as never)()).not.toThrow();
    expect(m.layers.length).toBe(count);
  });

  it("draws the runways of the airports in view; asks each airport only once", async () => {
    const m = new FakeMap();
    addAirportDiagramLayers(m as never);
    await vi.runAllTimersAsync();
    const data = m.sources.get("apd-rwy")?.data as GeoJSON.FeatureCollection;
    expect(data.features).toHaveLength(3);
    m.fire("moveend");
    await vi.advanceTimersByTimeAsync(600);
    expect(invoke.mock.calls.filter(([c]) => c === "get_airport")).toHaveLength(2); // EDDF, EDFE – no heliport
  });

  it("below zoom 11 nothing is asked", async () => {
    const m = new FakeMap();
    m.zoom = 9;
    addAirportDiagramLayers(m as never);
    m.fire("moveend");
    await vi.advanceTimersByTimeAsync(1000);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("IPC budget while following: a moveend per follow frame (30 Hz) costs at most 2 lookups per second", async () => {
    const m = new FakeMap();
    addAirportDiagramLayers(m as never);
    await vi.runAllTimersAsync();
    invoke.mockClear();
    const seconds = 10;
    for (let i = 0; i < seconds * 30; i++) {
      m.center = { lng: m.center.lng + 0.00005, lat: m.center.lat };
      m.fire("moveend");
      await vi.advanceTimersByTimeAsync(1000 / 30);
    }
    const perSecond = invoke.mock.calls.filter(([c]) => c === "airports_in_bbox").length / seconds;
    expect(perSecond).toBeLessThanOrEqual(2.1);
    expect(perSecond).toBeGreaterThan(1);
    // the runways are cached: no get_airport for the same airports again
    expect(invoke.mock.calls.filter(([c]) => c === "get_airport")).toHaveLength(0);
  });
});
