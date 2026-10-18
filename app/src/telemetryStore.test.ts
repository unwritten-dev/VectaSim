import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FlightSummary, Stats, Telemetry } from "./types";

// capture the Tauri event handlers instead of talking to a backend
const handlers = new Map<string, (e: { payload: unknown }) => void>();
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return unlisten;
  }),
}));

const store = await import("./telemetryStore");
const { createSelection, flightHeadEqual, getLiveState, recFlightEqual, resetLive, setFlight, setStats, setTelemetry, shallowEqual, startTelemetryListeners, subscribeLive } = store;

const tel = (p: Partial<Telemetry> = {}) => ({ latitude: 50, longitude: 8, onGround: true, timestampMs: 1, ...p }) as Telemetry;
const flight = (p: Partial<FlightSummary> = {}) =>
  ({ state: "active", phase: "cruise", offBlockMs: 100, distanceNm: 1, departure: { latitude: 50, longitude: 8 }, arrival: null, ...p }) as FlightSummary;

beforeEach(() => {
  resetLive();
  handlers.clear();
  unlisten.mockClear();
});

describe("telemetryStore", () => {
  it("notifies subscribers per update and stops after unsubscribe", () => {
    const l = vi.fn();
    const un = subscribeLive(l);
    setTelemetry(tel());
    setStats({ frames: 1, rateHz: 10 } as Stats);
    expect(l).toHaveBeenCalledTimes(2);
    un();
    setFlight(flight());
    expect(l).toHaveBeenCalledTimes(2);
    expect(getLiveState().flight?.state).toBe("active");
  });

  it("reset clears stats and takes what the new status snapshot knows", () => {
    setTelemetry(tel({ latitude: 1 }));
    setFlight(flight());
    setStats({ frames: 5, rateHz: 10 });
    resetLive({ telemetry: tel({ latitude: 2 }) });
    const s = getLiveState();
    expect(s.telemetry?.latitude).toBe(2);
    expect(s.flight).toBeNull();
    expect(s.stats).toBeNull();
    resetLive();
    expect(getLiveState()).toEqual({ telemetry: null, flight: null, stats: null });
  });

  it("registers the listeners and gates telemetry while not connected", async () => {
    let connected = false;
    const stop = startTelemetryListeners(() => connected);
    await Promise.resolve();
    expect([...handlers.keys()].sort()).toEqual(["sim:flight", "sim:stats", "sim:telemetry"]);
    handlers.get("sim:telemetry")!({ payload: tel({ latitude: 3 }) });
    expect(getLiveState().telemetry).toBeNull();
    connected = true;
    handlers.get("sim:telemetry")!({ payload: tel({ latitude: 4 }) });
    expect(getLiveState().telemetry?.latitude).toBe(4);
    // flight and stats are not gated (same as before in App)
    handlers.get("sim:flight")!({ payload: flight() });
    handlers.get("sim:stats")!({ payload: { frames: 2, rateHz: 9.8 } });
    expect(getLiveState().flight?.phase).toBe("cruise");
    expect(getLiveState().stats?.rateHz).toBe(9.8);
    stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(unlisten).toHaveBeenCalledTimes(3);
  });
});

describe("createSelection", () => {
  it("keeps the previous value while equals says unchanged", () => {
    const sel = createSelection<{ lat: number } | null>();
    const pick = (s: ReturnType<typeof getLiveState>) => (s.telemetry ? { lat: Math.round(s.telemetry.latitude) } : null);
    setTelemetry(tel({ latitude: 50.1 }));
    const a = sel(getLiveState(), pick, shallowEqual);
    setTelemetry(tel({ latitude: 50.2 }));
    const b = sel(getLiveState(), pick, shallowEqual);
    expect(b).toBe(a); // same reference: useSyncExternalStore skips the render
    setTelemetry(tel({ latitude: 51.2 }));
    const c = sel(getLiveState(), pick, shallowEqual);
    expect(c).not.toBe(a);
    expect(c).toEqual({ lat: 51 });
  });

  it("does not run the selector again for the same state and selector", () => {
    const sel = createSelection<number>();
    const pick = vi.fn((s: ReturnType<typeof getLiveState>) => s.telemetry?.latitude ?? 0);
    setTelemetry(tel());
    sel(getLiveState(), pick, Object.is);
    sel(getLiveState(), pick, Object.is);
    expect(pick).toHaveBeenCalledTimes(1);
    // a new selector (closure over new props) runs again on the same state
    const other = (s: ReturnType<typeof getLiveState>) => (s.telemetry?.latitude ?? 0) + 1;
    expect(sel(getLiveState(), other, Object.is)).toBe(51);
  });

  it("a boolean selector only changes when the boolean does", () => {
    const sel = createSelection<boolean>();
    const near = (s: ReturnType<typeof getLiveState>) => (s.telemetry?.latitude ?? 0) > 50;
    const seen: boolean[] = [];
    for (const lat of [49, 49.5, 50.5, 51, 52]) {
      setTelemetry(tel({ latitude: lat }));
      const v = sel(getLiveState(), near, Object.is);
      if (seen[seen.length - 1] !== v) seen.push(v);
    }
    expect(seen).toEqual([false, true]);
  });
});

describe("flight equalities", () => {
  it("recording status ignores the running totals", () => {
    expect(recFlightEqual(flight({ distanceNm: 1 }), flight({ distanceNm: 2 }))).toBe(true);
    expect(recFlightEqual(flight(), flight({ state: "completed" }))).toBe(false);
    expect(recFlightEqual(flight(), flight({ offBlockMs: 200 }))).toBe(false);
    expect(recFlightEqual(null, flight())).toBe(false);
    expect(recFlightEqual(null, null)).toBe(true);
  });

  it("the live view's frame ignores totals but follows phase, times and points", () => {
    expect(flightHeadEqual(flight({ distanceNm: 1, maxAltitudeMslFt: 1 }), flight({ distanceNm: 9, maxAltitudeMslFt: 9 }))).toBe(true);
    expect(flightHeadEqual(flight(), flight({ phase: "descent" }))).toBe(false);
    expect(flightHeadEqual(flight(), flight({ landingMs: 5 }))).toBe(false);
    expect(flightHeadEqual(flight(), flight({ departure: { latitude: 50, longitude: 8 } }))).toBe(true);
    expect(flightHeadEqual(flight(), flight({ departure: { latitude: 50, longitude: 9 } }))).toBe(false);
    expect(flightHeadEqual(flight({ arrival: null }), flight({ arrival: undefined }))).toBe(true);
  });

  it("shallowEqual compares one level", () => {
    expect(shallowEqual({ a: 1, b: true }, { a: 1, b: true })).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(shallowEqual<{ a: number } | null>(null, { a: 1 })).toBe(false);
  });
});

describe("useTelemetrySelector", () => {
  it("reads the store in a render (server snapshot; no DOM for update counts in this setup)", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Lat = () => createElement("span", null, String(store.useTelemetrySelector((s) => s.telemetry?.latitude ?? "–")));
    expect(renderToStaticMarkup(createElement(Lat))).toBe("<span>–</span>");
    setTelemetry(tel({ latitude: 47 }));
    expect(renderToStaticMarkup(createElement(Lat))).toBe("<span>47</span>");
  });
});
