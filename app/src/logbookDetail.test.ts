import { describe, expect, it, vi } from "vitest";
import { FULL_TRACK_DEBOUNCE_MS, loadFlightDetail, type DetailLoadDeps } from "./logbookDetail";
import type { FlightDetail, TrackSample } from "./types";

const detail = (state: string, hasTrack = true) => ({ flight: { id: "f1", state }, hasTrack }) as unknown as FlightDetail;
const sample = (n: number) => Array.from({ length: n }, () => ({}) as TrackSample);

function deps(over: Partial<DetailLoadDeps> & { flight?: FlightDetail | null } = {}) {
  const calls: string[] = [];
  const flight = over.flight === undefined ? detail("completed") : over.flight;
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push(cmd === "get_track" ? `get_track:${args?.preview ? "preview" : "full"}` : cmd);
    if (cmd === "get_flight") return flight;
    if (cmd === "get_track") return sample(args?.preview ? 2 : 50);
    if (cmd === "get_live_track") return sample(7);
    return null;
  }) as unknown as DetailLoadDeps["invoke"];
  const d: DetailLoadDeps = { invoke, cancelled: () => false, wait: () => Promise.resolve(), onDetail: vi.fn(), onTrack: vi.fn(), ...over };
  return { d, calls };
}

describe("loadFlightDetail", () => {
  it("loads flight, preview, then (after the debounce) the full track", async () => {
    const wait = vi.fn(() => Promise.resolve());
    const { d, calls } = deps({ wait });
    await loadFlightDetail("f1", false, d);
    expect(calls).toEqual(["get_flight", "get_track:preview", "get_track:full"]);
    expect(wait).toHaveBeenCalledWith(FULL_TRACK_DEBOUNCE_MS);
    expect(d.onTrack).toHaveBeenLastCalledWith(sample(50));
  });

  it("never requests the full track once the selection moved on during the debounce", async () => {
    let cancelled = false;
    const { d, calls } = deps({ cancelled: () => cancelled, wait: async () => void (cancelled = true) });
    await loadFlightDetail("f1", false, d);
    expect(calls).toEqual(["get_flight", "get_track:preview"]);
  });

  it("stops after the preview when cancelled meanwhile (no follow-up call)", async () => {
    let cancelled = false;
    const { d, calls } = deps({ cancelled: () => cancelled });
    const inner = d.invoke;
    d.invoke = (async (cmd: string, args?: Record<string, unknown>) => {
      const r = await inner(cmd, args);
      if (cmd === "get_track") cancelled = true;
      return r;
    }) as DetailLoadDeps["invoke"];
    await loadFlightDetail("f1", false, d);
    expect(calls).toEqual(["get_flight", "get_track:preview"]);
    expect(d.onTrack).not.toHaveBeenCalled();
  });

  it("refreshing the shown flight skips preview and debounce", async () => {
    const wait = vi.fn(() => Promise.resolve());
    const { d, calls } = deps({ wait });
    await loadFlightDetail("f1", true, d);
    expect(calls).toEqual(["get_flight", "get_track:full"]);
    expect(wait).not.toHaveBeenCalled();
  });

  it("falls back to the live buffer for the running flight without a stored track", async () => {
    const { d, calls } = deps({ flight: detail("active", false) });
    await loadFlightDetail("f1", false, d);
    expect(calls).toEqual(["get_flight", "get_live_track"]);
    expect(d.onTrack).toHaveBeenLastCalledWith(sample(7));
  });

  it("does nothing more for an unknown flight", async () => {
    const { d, calls } = deps({ flight: null });
    await loadFlightDetail("f1", false, d);
    expect(calls).toEqual(["get_flight"]);
    expect(d.onDetail).toHaveBeenCalledWith(null);
  });
});
