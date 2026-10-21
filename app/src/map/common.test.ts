import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackSample } from "../types";
import { addCurtainLayers, drawCurtainTrack, routeGeoJson, segmentsGeoJson, setCurtainVisible, trackHeightAt, trackPoseAt } from "./common";
import type { CurtainLayer } from "./curtainLayer";

const sample = (tMs: number, over: Partial<TrackSample> = {}): TrackSample => ({
  tMs,
  latitude: 50,
  longitude: 8,
  altitudeMslFt: 1000,
  altitudeAglFt: 600,
  groundSpeedKt: 120,
  iasKt: 120,
  verticalSpeedFpm: 0,
  headingTrueDeg: 90,
  pitchDeg: 2,
  bankDeg: 0,
  gForce: 1,
  onGround: false,
  flapsIndex: 0,
  gearPct: 0,
  fuelTotalKg: 1000,
  ...over,
});

describe("trackPoseAt (replay cursor)", () => {
  const track = [sample(0, { headingTrueDeg: 350 }), sample(1000, { longitude: 8.01, headingTrueDeg: 10, altitudeMslFt: 1100 })];
  it("null outside the track or without a time", () => {
    expect(trackPoseAt(track, null)).toBeNull();
    expect(trackPoseAt(track, -1)).toBeNull();
    expect(trackPoseAt(track, 2000)).toBeNull();
  });
  it("heading interpolated the short way across north", () => {
    const p = trackPoseAt(track, 500)!;
    expect(p.headingDeg! % 360).toBeCloseTo(0, 6);
    expect(p.onGround).toBe(false);
  });
  it("samples without heading (rebuilt debrief track): the heading comes from the positions", () => {
    const flat = [sample(0, { headingTrueDeg: 0 }), sample(1000, { longitude: 8.01, headingTrueDeg: 0 })];
    expect(trackPoseAt(flat, 500)!.headingDeg).toBeCloseTo(90, 0);
  });
});

describe("trackHeightAt (3D cursor)", () => {
  it("interpolates the ground-relative heights; null outside", () => {
    const track = [sample(0, { onGround: true, altitudeAglFt: 0, altitudeMslFt: 364 }), sample(1000, { altitudeMslFt: 864, altitudeAglFt: 500 })];
    expect(trackHeightAt(track, 0)).toBe(0);
    const mid = trackHeightAt(track, 500)!;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(trackHeightAt(track, 1000)!);
    expect(trackHeightAt(track, 5000)).toBeNull();
    expect(trackHeightAt([], 0)).toBeNull();
  });
});

describe("track and route GeoJSON", () => {
  it("one segment per pair with the mean altitude", () => {
    const fc = segmentsGeoJson([
      { lon: 8, lat: 50, altFt: 1000 },
      { lon: 8.1, lat: 50, altFt: 2000 },
      { lon: 8.2, lat: 50, altFt: 3000 },
    ]);
    expect(fc.features.map((f) => f.properties?.alt)).toEqual([1500, 2500]);
  });
  it("route: fixes as points plus one line; (0,0) and non-finite fixes dropped", () => {
    const fc = routeGeoJson([
      { ident: "A", latitude: 50, longitude: 8, altitudeFt: 0 },
      { ident: "ZERO", latitude: 0, longitude: 0, altitudeFt: 0 },
      { ident: "B", latitude: 51, longitude: 9, altitudeFt: 0 },
    ] as never);
    expect(fc.features.filter((f) => f.geometry.type === "Point")).toHaveLength(2);
    expect(fc.features.filter((f) => f.geometry.type === "LineString")).toHaveLength(1);
  });
});

/** A map for the curtain helpers: layers, sources with setData, `remove` listeners. */
class FakeMap {
  layers: Array<{ id: string; type?: string; layout?: Record<string, unknown> }> = [];
  sources = new Map<string, { data?: unknown; setData(d: unknown): void }>();
  removeListeners: Array<() => void> = [];
  getLayer = (id: string) => this.layers.find((l) => l.id === id);
  addLayer = (l: { id: string }) => void this.layers.push(l);
  removeLayer = (id: string) => void (this.layers = this.layers.filter((l) => l.id !== id));
  getSource = (id: string) => this.sources.get(id);
  addSource = (id: string) => {
    const s = { data: undefined as unknown, setData: (d: unknown) => void (s.data = d) };
    this.sources.set(id, s);
  };
  setLayoutProperty = (id: string, k: string, v: unknown) => {
    const l = this.getLayer(id);
    if (l) l.layout = { ...l.layout, [k]: v };
  };
  once = (ev: string, fn: () => void) => void (ev === "remove" && this.removeListeners.push(fn));
  triggerRepaint() {}
}

describe("curtain fallback (shaders refused)", () => {
  let frames: Array<() => void>;
  beforeEach(() => {
    vi.useFakeTimers();
    frames = [];
    vi.stubGlobal("window", { setTimeout, clearTimeout, devicePixelRatio: 1 });
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const pts = [
    { lon: 8, lat: 50, altFt: 1000, hFt: 600 },
    { lon: 8.01, lat: 50, altFt: 1100, hFt: 700 },
  ];

  it("the extrusion pair takes over on the next frame and gets the track at most once a second", () => {
    const m = new FakeMap();
    addCurtainLayers(m as never, "c");
    const layer = m.getLayer("c") as unknown as CurtainLayer;
    setCurtainVisible(m as never, "c", true);
    layer.onFail?.();
    frames.shift()!();
    expect(m.getLayer("c-fallback-wall")?.layout?.visibility).toBe("visible");
    drawCurtainTrack(m as never, "c", pts, null);
    drawCurtainTrack(m as never, "c", pts, null);
    expect((m.getSource("c-fallback")?.data as GeoJSON.FeatureCollection).features).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect((m.getSource("c-fallback")?.data as GeoJSON.FeatureCollection).features.length).toBeGreaterThan(0);
  });

  it("the rebuild timer does not outlive the map", () => {
    const m = new FakeMap();
    addCurtainLayers(m as never, "c");
    (m.getLayer("c") as unknown as CurtainLayer).onFail?.();
    frames.shift()!();
    drawCurtainTrack(m as never, "c", pts, null);
    m.getSource = () => {
      throw new Error("map removed");
    };
    for (const fn of m.removeListeners) fn();
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
  });

  it("fallback: false (traffic curtain) adds no extrusion", () => {
    const m = new FakeMap();
    addCurtainLayers(m as never, "t", undefined, { fallback: false });
    (m.getLayer("t") as unknown as CurtainLayer).onFail?.();
    frames.shift()!();
    expect(m.getSource("t-fallback")).toBeUndefined();
  });
});

describe("H-7: drawCurtainTrack skips a removed curtain layer", () => {
  it("between removeCustomLayers and the next style load the old instance gets no sync", () => {
    const m = new FakeMap();
    addCurtainLayers(m as never, "c");
    const layer = m.getLayer("c") as unknown as CurtainLayer;
    const sync = vi.spyOn(layer, "sync");
    drawCurtainTrack(m as never, "c", [{ lon: 8, lat: 50, altFt: 1000, hFt: 600 }], null);
    expect(sync).toHaveBeenCalledTimes(1);
    layer.onRemove(m as never, { deleteBuffer() {}, deleteProgram() {} } as never);
    drawCurtainTrack(m as never, "c", [{ lon: 8, lat: 50, altFt: 1000, hFt: 600 }], null);
    expect(sync).toHaveBeenCalledTimes(1);
  });
});
