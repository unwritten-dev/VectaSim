import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// capture the Tauri event handlers instead of talking to a backend
const handlers = new Map<string, Set<(e: { payload: unknown }) => void>>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name)!.add(cb);
    return () => handlers.get(name)?.delete(cb);
  }),
}));

const { APPROACH_CHANGE_DEBOUNCE_MS, concernsFlight, notifyApproachDataChanged, watchApproachChanges } = await import("./approachChanges");

const fire = (name: string, payload: unknown = null) => handlers.get(name)?.forEach((cb) => cb({ payload }));
const target = { flightId: "f-1", registration: "D-AINA" };

beforeEach(() => {
  handlers.clear();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("approach changes of the shown flight", () => {
  it("payloads: none = every flight, else the flight id or the booked registration", () => {
    expect(concernsFlight(null, target)).toBe(true);
    expect(concernsFlight(undefined, target)).toBe(true);
    expect(concernsFlight("", target)).toBe(true);
    expect(concernsFlight("f-1", target)).toBe(true);
    expect(concernsFlight("d-aina", target)).toBe(true);
    expect(concernsFlight("f-2", target)).toBe(false);
    expect(concernsFlight("D-ABCD", target)).toBe(false);
    expect(concernsFlight("D-AINA", { flightId: "f-1" })).toBe(false);
    expect(concernsFlight({ x: 1 }, target)).toBe(false);
  });

  it("a profile change (three events in a row) reloads once, after the debounce", async () => {
    const onChange = vi.fn();
    const stop = watchApproachChanges(target, onChange);
    await Promise.resolve();
    expect([...handlers.keys()].sort()).toEqual(["approach:facts", "approach:profiles", "flight:metrics"]);
    // import / delete of a custom profile: approach.rs profiles_changed
    fire("approach:profiles");
    fire("approach:facts");
    fire("flight:metrics");
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(APPROACH_CHANGE_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    // fleet edit of this airframe: airframes.rs upsert_airframe
    fire("approach:facts", "D-AINA");
    fire("flight:metrics");
    vi.advanceTimersByTime(APPROACH_CHANGE_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });

  it("rebooking or unbooking the shown flight reloads it (airframes.rs results_invalidated)", async () => {
    const onChange = vi.fn();
    const stop = watchApproachChanges(target, onChange);
    await Promise.resolve();
    // unbooked: an empty registration means every flight
    fire("approach:facts", "");
    vi.advanceTimersByTime(APPROACH_CHANGE_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    fire("approach:facts", "  ");
    vi.advanceTimersByTime(APPROACH_CHANGE_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(2);
    // booked onto another airframe: the facts event names the new one (the row still says the
    // old one), the metrics event without payload still reaches the shown flight
    fire("approach:facts", "D-ABCD");
    fire("flight:metrics");
    vi.advanceTimersByTime(APPROACH_CHANGE_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(3);
    stop();
  });

  it("events of other flights and airframes leave the shown one alone", async () => {
    const onChange = vi.fn();
    const stop = watchApproachChanges(target, onChange);
    await Promise.resolve();
    fire("approach:facts", "f-2");
    fire("flight:metrics", "f-2");
    fire("approach:facts", "D-ABCD");
    vi.advanceTimersByTime(APPROACH_CHANGE_DEBOUNCE_MS * 2);
    expect(onChange).not.toHaveBeenCalled();
    // the flight's own facts at flight end
    fire("approach:facts", "f-1");
    vi.advanceTimersByTime(APPROACH_CHANGE_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it("the runway correction (no backend event) reloads through the in-window signal", async () => {
    const onChange = vi.fn();
    const stop = watchApproachChanges(target, onChange);
    await Promise.resolve();
    notifyApproachDataChanged();
    vi.advanceTimersByTime(APPROACH_CHANGE_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    notifyApproachDataChanged("f-9");
    vi.advanceTimersByTime(APPROACH_CHANGE_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stopping cancels a pending reload and unlistens", async () => {
    const onChange = vi.fn();
    const stop = watchApproachChanges(target, onChange);
    await Promise.resolve();
    fire("approach:profiles");
    stop();
    vi.advanceTimersByTime(APPROACH_CHANGE_DEBOUNCE_MS * 2);
    notifyApproachDataChanged();
    vi.advanceTimersByTime(APPROACH_CHANGE_DEBOUNCE_MS * 2);
    expect(onChange).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect([...handlers.values()].every((s) => s.size === 0)).toBe(true);
  });
});
