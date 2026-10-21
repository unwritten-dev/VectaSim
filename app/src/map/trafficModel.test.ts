import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pilot } from "../types";
import { TRAFFIC_3D_SOURCE, TRAFFIC_CURTAIN, TRAFFIC_MODEL_LAYER, Traffic3D } from "./trafficModel";

const pilot = (cid: number, lon: number, over: Partial<Pilot> = {}): Pilot => ({
  network: "vatsim",
  cid,
  callsign: `TST${cid}`,
  latitude: 50,
  longitude: lon,
  altitudeFt: 12_000,
  groundSpeedKt: 300,
  headingDeg: 90,
  transponder: "2000",
  aircraftShort: "A320",
  departure: "EDDF",
  arrival: "EGLL",
  route: "",
  flightRules: "I",
  ...over,
});

/** The map surface Traffic3D touches: layers with filters, sources, camera, repaint. */
class FakeMap {
  zoom = 9;
  layers: Array<{ id: string; type?: string; filter?: unknown; paint?: Record<string, unknown>; onRemove?: () => void }> = [
    { id: "vatsim-pilots", type: "symbol" },
    { id: "vatsim-pilots-label", type: "symbol" },
    { id: "traffic-selected", type: "circle" },
  ];
  sources = new Map<string, { data?: GeoJSON.FeatureCollection; setData(d: GeoJSON.FeatureCollection): void }>();
  repaints = 0;
  constructor() {
    for (const id of [TRAFFIC_3D_SOURCE, "traffic-3d-sel"]) this.addSource(id);
  }
  getZoom = () => this.zoom;
  getCenter = () => ({ lng: 8.5, lat: 50 });
  getBounds = () => ({ getWest: () => 8, getEast: () => 9, getSouth: () => 49.7, getNorth: () => 50.3 });
  getCanvas = () => ({ clientWidth: 800 });
  getLayer = (id: string) => this.layers.find((l) => l.id === id);
  addLayer = (l: { id: string }, before?: string) => {
    const at = before ? this.layers.findIndex((x) => x.id === before) : -1;
    if (at < 0) this.layers.push(l);
    else this.layers.splice(at, 0, l);
  };
  removeLayer = (id: string) => void (this.layers = this.layers.filter((l) => l.id !== id));
  getSource = (id: string) => this.sources.get(id);
  addSource(id: string) {
    const s: { data?: GeoJSON.FeatureCollection; setData(d: GeoJSON.FeatureCollection): void } = { setData: (d) => void (s.data = d) };
    this.sources.set(id, s);
  }
  setFilter = (id: string, f: unknown) => {
    const l = this.getLayer(id);
    if (l) l.filter = f;
  };
  setPaintProperty = (id: string, k: string, v: unknown) => {
    const l = this.getLayer(id);
    if (l) l.paint = { ...l.paint, [k]: v };
  };
  setLayoutProperty() {}
  once() {}
  triggerRepaint = () => void this.repaints++;
}

const COLORS = { body: "#8fa3b8", accent: "#22d3ee", dark: "#0b0f14", light: false };

beforeEach(() => {
  vi.stubGlobal("window", { setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, devicePixelRatio: 1 });
  vi.stubGlobal("document", { hidden: false, hasFocus: () => true });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("Traffic3D on a (fake) map", () => {
  it("attach adds the model layer below the flat symbols and the selected aircraft's curtain", () => {
    const m = new FakeMap();
    const t = new Traffic3D(() => Promise.resolve([]));
    t.attach(m as never, COLORS);
    const order = m.layers.map((l) => l.id);
    expect(order.indexOf(TRAFFIC_MODEL_LAYER)).toBeLessThan(order.indexOf("vatsim-pilots"));
    expect(order).toContain(TRAFFIC_CURTAIN);
    // a second attach (theme change) replaces the instances, it does not add them twice
    t.attach(m as never, COLORS);
    expect(m.layers.filter((l) => l.id === TRAFFIC_MODEL_LAYER)).toHaveLength(1);
    t.dispose();
  });

  it("3D and zoomed in: the aircraft become models, the flat symbols hide exactly those (filter), labels follow", () => {
    const m = new FakeMap();
    const t = new Traffic3D(() => Promise.resolve([]));
    t.attach(m as never, COLORS);
    t.setPilots([pilot(1, 8.4), pilot(2, 8.6), pilot(3, 20)]);
    t.update(true, true);
    expect(t.active).toBe(true);
    expect([...t.picked].sort()).toEqual(["vatsim:1", "vatsim:2"]);
    expect(m.getLayer("vatsim-pilots")?.filter).toEqual(["!", ["in", ["get", "key"], ["literal", t.picked]]]);
    expect(m.getSource(TRAFFIC_3D_SOURCE)?.data?.features).toHaveLength(2);
    // zoomed out (below the hysteresis): models off, flat symbols unfiltered, labels cleared
    m.zoom = 6;
    t.update(true, true);
    expect(t.active).toBe(false);
    expect(m.getLayer("vatsim-pilots")?.filter).toBeNull();
    expect(m.getSource(TRAFFIC_3D_SOURCE)?.data?.features).toHaveLength(0);
    t.dispose();
  });

  it("2D view or traffic hidden: no models", () => {
    const m = new FakeMap();
    const t = new Traffic3D(() => Promise.resolve([]));
    t.attach(m as never, COLORS);
    t.setPilots([pilot(1, 8.4)]);
    t.update(false, true);
    expect(t.active).toBe(false);
    t.update(true, false);
    expect(t.active).toBe(false);
    t.dispose();
  });

  it("the selected aircraft is always a model; its ring on the ground hides while it is drawn", () => {
    const m = new FakeMap();
    const t = new Traffic3D(() => Promise.resolve([]));
    t.attach(m as never, COLORS);
    t.setPilots([pilot(1, 8.4), pilot(9, 8.9)]);
    t.update(true, true);
    t.setSelected("vatsim:9");
    expect(t.picked).toContain("vatsim:9");
    expect(m.getLayer("traffic-selected")?.paint?.["circle-stroke-opacity"]).toBe(0);
    expect(t.selectedPose()).not.toBeNull();
    t.setSelected(null);
    expect(m.getLayer("traffic-selected")?.paint?.["circle-stroke-opacity"]).toBe(1);
    t.dispose();
  });

  it("the height reference is fetched for the view and re-used while the view stays inside it", async () => {
    const m = new FakeMap();
    const fetch = vi.fn(() => Promise.resolve([{ ident: "EDDF", kind: "large", name: "", latitude: 50, longitude: 8.4, elevationFt: 364, country: "", municipality: "", iata: "" }]));
    const t = new Traffic3D(fetch);
    t.attach(m as never, COLORS);
    t.setPilots([pilot(1, 8.41, { altitudeFt: 1364 })]);
    t.update(true, true);
    t.update(true, true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(t.tracks.get("vatsim:1")!.hFt).toBe(1364);
    await new Promise((r) => setTimeout(r, 0));
    // 1364 ft MSL next to a 364 ft field: 1000 ft above the map's ground (grid-indexed lookup)
    expect(t.tracks.get("vatsim:1")!.hFt).toBeCloseTo(1000, 0);
    t.dispose();
  });

  it("labels are not re-sent for every re-filter of the same feed (at most once a second) nor when empty", () => {
    const m = new FakeMap();
    let sends = 0;
    const src = m.getSource(TRAFFIC_3D_SOURCE)!;
    const set = src.setData;
    src.setData = (d) => {
      sends++;
      set(d);
    };
    const t = new Traffic3D(() => Promise.resolve([]));
    t.attach(m as never, COLORS);
    t.update(false, true);
    const empty = sends;
    t.setPilots([pilot(1, 8.4)]);
    t.setPilots([pilot(1, 8.4)]);
    expect(sends).toBe(empty);
    t.update(true, true); // the set of models changes: at once
    const shown = sends;
    expect(shown).toBe(empty + 1);
    t.setPilots([pilot(1, 8.4)]);
    t.setPilots([pilot(1, 8.4)]);
    expect(sends).toBe(shown);
    t.dispose();
  });
});

describe("H-5 / H-7: the selected aircraft's loop", () => {
  it("sleeps between follow frames instead of asking for every display frame; pauses while its layer is removed", () => {
    vi.useFakeTimers();
    const frames: Array<(t: number) => void> = [];
    vi.stubGlobal("requestAnimationFrame", (f: (t: number) => void) => frames.push(f));
    const m = new FakeMap();
    const t = new Traffic3D(() => Promise.resolve([]));
    const followFrames: number[] = [];
    t.onSelectedFrame = (now) => followFrames.push(now);
    t.attach(m as never, COLORS);
    t.setPilots([pilot(1, 8.4), pilot(9, 8.6)]);
    t.update(true, true);
    t.setSelected("vatsim:9");
    // the loop asks for one frame and runs the follow step in it
    expect(frames.length).toBe(1);
    frames.shift()!(0);
    expect(followFrames).toHaveLength(1);
    // then no frame is asked for during the follow interval (a 60–144 Hz display used to wake it every frame)
    vi.advanceTimersByTime(20);
    expect(frames).toHaveLength(0);
    vi.advanceTimersByTime(20);
    expect(frames).toHaveLength(1);
    frames.shift()!(40);
    expect(followFrames).toHaveLength(2);
    // the model layer removed (theme change): no follow step, curtain or label work, only a slow check
    t.layer!.onRemove(m as never, { deleteBuffer() {}, deleteProgram() {}, deleteVertexArray() {} } as never);
    vi.advanceTimersByTime(40);
    frames.shift()?.(80);
    expect(followFrames).toHaveLength(2);
    vi.advanceTimersByTime(100);
    expect(frames).toHaveLength(0);
    // re-attached (the new style load): the loop goes on by itself
    t.attach(m as never, COLORS);
    vi.advanceTimersByTime(300);
    while (frames.length) frames.shift()!(400);
    expect(followFrames.length).toBeGreaterThan(2);
    t.dispose();
    vi.useRealTimers();
  });
});
