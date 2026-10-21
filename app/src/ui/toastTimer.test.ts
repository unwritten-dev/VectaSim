import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_REST_MS, toastTimer } from "./toastTimer";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(durationMs: number | null, hold = false) {
  let away = false;
  const onExpire = vi.fn();
  const tm = toastTimer({ durationMs, holdWhileUnfocused: hold, windowAway: () => away, onExpire, now: () => Date.now() });
  return { tm, onExpire, setAway: (v: boolean) => (away = v) };
}

describe("toast timer", () => {
  it("expires after its duration", () => {
    const { tm, onExpire } = setup(5000);
    tm.start();
    vi.advanceTimersByTime(4999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("errors (no duration) stay", () => {
    const { tm, onExpire } = setup(null);
    tm.start();
    tm.pause();
    tm.start();
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("hover pauses and resumes with the rest, at least 1.5 s", () => {
    const { tm, onExpire } = setup(5000);
    tm.start();
    vi.advanceTimersByTime(2000);
    tm.pause();
    vi.advanceTimersByTime(10_000); // pointer rests on the toast
    expect(onExpire).not.toHaveBeenCalled();
    tm.start();
    vi.advanceTimersByTime(2999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);

    const late = setup(5000);
    late.tm.start();
    vi.advanceTimersByTime(4900);
    late.tm.pause();
    late.tm.start();
    vi.advanceTimersByTime(MIN_REST_MS - 1);
    expect(late.onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(late.onExpire).toHaveBeenCalledTimes(1);
  });

  it("holdWhileUnfocused: no countdown in the background, the full duration once back", () => {
    const { tm, onExpire, setAway } = setup(4000, true);
    setAway(true);
    tm.start(); // landing while the pilot is in the sim
    vi.advanceTimersByTime(30_000);
    expect(onExpire).not.toHaveBeenCalled();
    setAway(false);
    tm.back();
    vi.advanceTimersByTime(3000);
    setAway(true);
    tm.away();
    vi.advanceTimersByTime(30_000);
    expect(onExpire).not.toHaveBeenCalled();
    setAway(false);
    tm.back();
    vi.advanceTimersByTime(3999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("dispose stops it", () => {
    const { tm, onExpire } = setup(1000);
    tm.start();
    tm.dispose();
    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("a toast held by focus or pointer does not restart when the window comes back", () => {
    const { tm, onExpire, setAway } = setup(4000, true);
    tm.start();
    vi.advanceTimersByTime(1000);
    tm.pause("focus"); // Alt+T
    setAway(true);
    tm.away();
    tm.pause("hover"); // pointer passes over it while the window is in the background
    vi.advanceTimersByTime(30_000);
    setAway(false);
    tm.back();
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
    tm.resume("hover");
    vi.advanceTimersByTime(60_000);
    // the focus still rests on it
    expect(onExpire).not.toHaveBeenCalled();
    tm.resume("focus");
    vi.advanceTimersByTime(3999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("a second pause (hover while focused) does not shorten the rest twice", () => {
    const { tm, onExpire } = setup(5000);
    tm.start();
    vi.advanceTimersByTime(2000);
    tm.pause("focus");
    vi.advanceTimersByTime(2000);
    tm.pause("hover");
    tm.resume("hover");
    tm.resume("focus");
    vi.advanceTimersByTime(2999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
