import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectionSpecification, StyleSpecification } from "maplibre-gl";
import { GLOBE_EVENT, GLOBE_STORAGE_KEY, applyProjection, loadGlobe, projectionFor, saveGlobe, withProjection } from "./projection";

function fakeMap(initial?: string) {
  let proj: ProjectionSpecification | undefined = initial ? { type: initial } : undefined;
  const set = vi.fn((p: ProjectionSpecification) => {
    proj = p;
  });
  return { getProjection: () => proj, setProjection: set, set };
}

describe("projectionFor / applyProjection", () => {
  it("maps the switch to the MapLibre projection name", () => {
    expect(projectionFor(true)).toBe("globe");
    expect(projectionFor(false)).toBe("mercator");
  });

  it("switches to the globe and back, and does nothing when it already matches", () => {
    const m = fakeMap();
    // no projection set = MapLibre's default Mercator
    expect(applyProjection(m, false)).toBe(false);
    expect(applyProjection(m, true)).toBe(true);
    expect(m.getProjection()).toEqual({ type: "globe" });
    expect(applyProjection(m, true)).toBe(false);
    expect(applyProjection(m, false)).toBe(true);
    expect(m.getProjection()).toEqual({ type: "mercator" });
    expect(m.set).toHaveBeenCalledTimes(2);
  });
});

describe("withProjection", () => {
  const style = { version: 8, sources: {}, layers: [] } as StyleSpecification;
  it("puts the projection into the style without touching the original", () => {
    expect(withProjection(style, true)).toEqual({ ...style, projection: { type: "globe" } });
    expect(withProjection(style, false)).toEqual({ ...style, projection: { type: "mercator" } });
    expect(style).not.toHaveProperty("projection");
  });
  it("adds the globe sky in the page colour, but keeps a sky the style brings", () => {
    const out = withProjection(style, true, "#101418") as StyleSpecification;
    expect(out.sky?.["sky-color"]).toBe("#101418");
    expect(out.sky?.["atmosphere-blend"]).toBeDefined();
    const own = { ...style, sky: { "sky-color": "#000000" } } as StyleSpecification;
    expect((withProjection(own, true, "#101418") as StyleSpecification).sky).toEqual({ "sky-color": "#000000" });
  });
  it("passes a style URL through (projection applied after load)", () => {
    expect(withProjection("https://example.org/style.json", true)).toBe("https://example.org/style.json");
  });
});

describe("loadGlobe / saveGlobe", () => {
  let store: Map<string, string>;
  let events: boolean[];
  beforeEach(() => {
    store = new Map();
    events = [];
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    const target = new EventTarget();
    target.addEventListener(GLOBE_EVENT, (e) => events.push((e as CustomEvent<boolean>).detail));
    vi.stubGlobal("window", target);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("defaults to the globe", () => {
    expect(loadGlobe()).toBe(true);
  });

  it("persists the choice and announces it", () => {
    saveGlobe(false);
    expect(store.get(GLOBE_STORAGE_KEY)).toBe("0");
    expect(loadGlobe()).toBe(false);
    saveGlobe(true);
    expect(loadGlobe()).toBe(true);
    expect(events).toEqual([false, true]);
  });

  it("falls back to the globe when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadGlobe()).toBe(true);
  });
});
