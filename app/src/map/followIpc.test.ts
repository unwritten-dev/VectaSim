// IPC budget of the live map while "Follow" is on: the follow camera ends a
// move with every follow frame, and every per-move refresh used to send its IPC calls each time.
// This harness drives the real debounces (MOVE_REFRESH) and the real airport diagram with a fake
// map through 10 s of following at zoom 14 and counts the backend calls per second.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const { addAirportDiagramLayers } = await import("./airportDiagram");
const { MOVE_REFRESH, boundedDebounce } = await import("./debounce");

class FakeMap {
  center = { lng: 8.57, lat: 50.04 };
  layers: Array<{ id: string; type: string }> = [];
  sources = new Map<string, { setData(d: unknown): void }>();
  handlers: Array<() => void> = [];
  getStyle = () => ({ sources: {}, layers: this.layers });
  getLayer = (id: string) => this.layers.find((l) => l.id === id);
  addLayer = (l: { id: string; type: string }) => void this.layers.push(l);
  getSource = (id: string) => this.sources.get(id);
  addSource = (id: string) => void this.sources.set(id, { setData() {} });
  getZoom = () => 14;
  getCenter = () => this.center;
  getBounds = () => ({ getWest: () => this.center.lng - 0.02, getEast: () => this.center.lng + 0.02, getSouth: () => this.center.lat - 0.01, getNorth: () => this.center.lat + 0.01 });
  on = (_e: string, fn: () => void) => void this.handlers.push(fn);
  off = (_e: string, fn: () => void) => void (this.handlers = this.handlers.filter((f) => f !== fn));
  moveend = () => this.handlers.forEach((f) => f());
}

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "airports_in_bbox") return Promise.resolve([{ ident: "EDDF", kind: "large" }]);
    if (cmd === "get_airport") return Promise.resolve({ airport: { ident: "EDDF" }, runways: [] });
    if (cmd === "nearest_airport") return Promise.resolve({ airport: { ident: "EDDF" }, distanceNm: 1 });
    return Promise.resolve([]);
  });
});
afterEach(() => vi.useRealTimers());

/** The live map's per-move refreshes, wired like LiveMap.tsx / AirportReadout.tsx (IPC only). */
function wireLiveMap(map: FakeMap) {
  const metars = boundedDebounce(() => void invoke("metars", { icaos: ["EDDF"] }), ...MOVE_REFRESH.metars);
  const airports = boundedDebounce(() => void invoke("airports_in_bbox", {}).then(() => metars()), ...MOVE_REFRESH.airports);
  const online = boundedDebounce(() => void invoke("online_snapshot_in_bbox", {}), ...MOVE_REFRESH.online);
  let current: string | null = null;
  const readout = boundedDebounce(
    () =>
      void invoke("nearest_airport", {}).then((n: { airport: { ident: string } }) => {
        if (n.airport.ident !== current) {
          current = n.airport.ident;
          return invoke("get_airport", { ident: current });
        }
      }),
    ...MOVE_REFRESH.readout,
  );
  map.on("moveend", airports);
  map.on("moveend", online);
  map.on("moveend", readout);
  addAirportDiagramLayers(map as never);
}

async function follow(map: FakeMap, seconds: number, hz: number) {
  for (let i = 0; i < seconds * hz; i++) {
    map.center = { lng: map.center.lng + 0.00002, lat: map.center.lat };
    map.moveend();
    await vi.advanceTimersByTimeAsync(1000 / hz);
  }
}

// Measured (20 s, zoom 14): 10 Hz follow frames → airports_in_bbox 4.0/s (dots 2 + diagram 2),
// nearest_airport 2.0/s, online_snapshot_in_bbox 1.0/s, metars 0.65/s, get_airport 0.05/s – 7.7/s
// in all; 30 Hz → 7.45/s. Before the bounded debounces the diagram and the readout ran on every moveend:
// about 24/s at a 10 Hz follow (and would be ~64/s at 30 Hz).
describe("IPC calls per second while following (zoom 14)", () => {
  it("bounded: about 8 calls per second, whatever the follow frame rate", async () => {
    const results: Record<string, Record<string, number>> = {};
    for (const hz of [10, 30]) {
      const map = new FakeMap();
      wireLiveMap(map);
      await vi.runAllTimersAsync();
      invoke.mockClear();
      const seconds = 20;
      await follow(map, seconds, hz);
      const per: Record<string, number> = {};
      for (const [cmd] of invoke.mock.calls) per[cmd as string] = (per[cmd as string] ?? 0) + 1 / seconds;
      results[`${hz} Hz`] = per;
      const total = Object.values(per).reduce((a, b) => a + b, 0);
      // airports 2 + diagram 2 + readout 2 + online 1 + METAR 0.67 (+ nothing for cached runways)
      expect(total).toBeLessThanOrEqual(8.5);
      expect(per.airports_in_bbox).toBeLessThanOrEqual(4.1); // live dots + diagram
      expect(per.nearest_airport).toBeLessThanOrEqual(2.05);
      expect(per.online_snapshot_in_bbox).toBeLessThanOrEqual(1.05);
      // the readout asks for the runways once (first lookup), the diagram has them cached
      expect(per.get_airport ?? 0).toBeLessThanOrEqual(0.1);
    }
    expect(Object.keys(results)).toHaveLength(2);
  });
});
