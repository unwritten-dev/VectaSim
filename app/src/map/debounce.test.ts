import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boundedDebounce } from "./debounce";

describe("boundedDebounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("fires once after a quiet period", () => {
    const fn = vi.fn();
    const d = boundedDebounce(fn, 250, 1000);
    d();
    d();
    vi.advanceTimersByTime(249);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // regression: the 3D follow camera ends a move every ~150 ms while airborne; a plain debounce
  // never fired and the live map stayed without traffic, ATC and METAR rings after a cold start
  it("still fires while calls keep coming faster than the wait", () => {
    const fn = vi.fn();
    const d = boundedDebounce(fn, 250, 1000);
    for (let t = 0; t < 3000; t += 150) {
      d();
      vi.advanceTimersByTime(150);
    }
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("cancel drops the pending call and starts a fresh burst", () => {
    const fn = vi.fn();
    const d = boundedDebounce(fn, 250, 1000);
    d();
    d.cancel();
    vi.advanceTimersByTime(2000);
    expect(fn).not.toHaveBeenCalled();
    d();
    vi.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
