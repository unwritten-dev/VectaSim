import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addLayerOnce, addSourceOnce, removeCustomLayers, replaceCustomLayer } from "./styleOnce";
import { addAirportLayers, addCurtainLayers, addRouteLayers, addTrackLayers } from "./common";
import { addOwnAircraftLayers } from "./ownAircraft";

/** Just enough of maplibregl.Map: throws on duplicates exactly like MapLibre's Style does. */
class FakeMap {
  sources = new Map<string, unknown>();
  layers: Array<{ id: string; type?: string; onRemove?: () => void }> = [];
  removed: string[] = [];
  getSource(id: string) {
    return this.sources.get(id);
  }
  getLayer(id: string) {
    return this.layers.find((l) => l.id === id);
  }
  addSource(id: string, spec: unknown) {
    if (this.sources.has(id)) throw new Error(`Source "${id}" already exists.`);
    this.sources.set(id, spec);
  }
  addLayer(layer: { id: string; type?: string }, before?: string) {
    if (this.getLayer(layer.id)) throw new Error(`Layer "${layer.id}" already exists on this map.`);
    const at = before ? this.layers.findIndex((l) => l.id === before) : -1;
    if (at < 0) this.layers.push(layer);
    else this.layers.splice(at, 0, layer);
  }
  removeLayer(id: string) {
    const l = this.getLayer(id);
    l?.onRemove?.();
    this.removed.push(id);
    this.layers = this.layers.filter((x) => x.id !== id);
  }
  getStyle() {
    return { layers: this.layers };
  }
  getLayersOrder() {
    return this.layers.map((l) => l.id);
  }
  setLayoutProperty() {}
  once() {}
  on() {}
  triggerRepaint() {}
}

beforeEach(() => vi.stubGlobal("window", { setTimeout, clearTimeout, devicePixelRatio: 1 }));
afterEach(() => vi.unstubAllGlobals());

describe("styleOnce helpers", () => {
  it("add a source / layer once, skip the second time", () => {
    const m = new FakeMap();
    expect(addSourceOnce(m as never, "a", { type: "geojson", data: { type: "FeatureCollection", features: [] } })).toBe(true);
    expect(addSourceOnce(m as never, "a", { type: "geojson", data: { type: "FeatureCollection", features: [] } })).toBe(false);
    expect(addLayerOnce(m as never, { id: "l", type: "line", source: "a" })).toBe(true);
    expect(addLayerOnce(m as never, { id: "l", type: "line", source: "a" })).toBe(false);
    expect(m.layers).toHaveLength(1);
  });

  it("a missing `before` layer puts the layer on top instead of failing", () => {
    const m = new FakeMap();
    addLayerOnce(m as never, { id: "x", type: "background" }, "nope");
    expect(m.getLayersOrder()).toEqual(["x"]);
  });

  it("replaceCustomLayer swaps the instance and frees the old one (onRemove)", () => {
    const m = new FakeMap();
    const freed: string[] = [];
    const mk = (tag: string) => ({ id: "model", type: "custom" as const, render() {}, onRemove: () => freed.push(tag) });
    replaceCustomLayer(m as never, mk("first") as never);
    replaceCustomLayer(m as never, mk("second") as never);
    expect(m.layers).toHaveLength(1);
    expect(freed).toEqual(["first"]);
  });
});

describe("layer setup is idempotent (theme change before the first load, double style load)", () => {
  it("running the whole setup twice on one style neither throws nor duplicates", () => {
    const m = new FakeMap();
    const setup = () => {
      addAirportLayers(m as never);
      addRouteLayers(m as never, "route");
      addTrackLayers(m as never, ["track-history", "track-live"]);
      addCurtainLayers(m as never, "track-3d");
      addOwnAircraftLayers(m as never, "aircraft");
    };
    setup();
    const order = m.getLayersOrder();
    const sources = [...m.sources.keys()];
    expect(() => setup()).not.toThrow();
    expect([...m.sources.keys()]).toEqual(sources);
    expect(m.getLayersOrder().sort()).toEqual([...order].sort());
    // the WebGL curtain was replaced by a fresh instance, not added twice
    expect(m.removed).toEqual(["track-3d"]);
    expect(m.layers.filter((l) => l.id === "track-3d")).toHaveLength(1);
  });
});

describe("removeCustomLayers (before setStyle on a theme change)", () => {
  it("removes only the custom layers and calls their onRemove (GL resources freed)", () => {
    const m = new FakeMap();
    const freed: string[] = [];
    m.addLayer({ id: "bg", type: "background" });
    m.addLayer({ id: "track-3d", type: "custom", onRemove: () => freed.push("track-3d") } as never);
    m.addLayer({ id: "airports", type: "circle" });
    m.addLayer({ id: "aircraft-model", type: "custom", onRemove: () => freed.push("aircraft-model") } as never);
    expect(removeCustomLayers(m as never)).toEqual(["track-3d", "aircraft-model"]);
    expect(freed).toEqual(["track-3d", "aircraft-model"]);
    expect(m.getLayersOrder()).toEqual(["bg", "airports"]);
  });

  it("a style that refuses the removal (not loaded yet) is skipped without throwing", () => {
    const m = new FakeMap();
    m.addLayer({ id: "c", type: "custom" });
    m.removeLayer = () => {
      throw new Error("Style is not done loading.");
    };
    expect(() => removeCustomLayers(m as never)).not.toThrow();
    expect(removeCustomLayers(m as never)).toEqual([]);
  });
});
