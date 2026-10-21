import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FRAME_MS_BACKGROUND,
  FRAME_MS_FOCUSED,
  capRenders,
  followFrameMs,
  frameAfter,
  onWindowReturn,
  resetWindowState,
  setWindowFocused,
  setWindowMinimized,
  watchWindow,
  windowAway,
  windowUnfocused,
  type WindowApi,
} from "./frameCap";

afterEach(() => {
  vi.useRealTimers();
  resetWindowState();
});

describe("follow frame budget", () => {
  it("30 fps with the window focused, 15 fps while the simulator has the focus", () => {
    expect(followFrameMs({ hasFocus: () => true })).toBe(FRAME_MS_FOCUSED);
    expect(followFrameMs({ hasFocus: () => false })).toBe(FRAME_MS_BACKGROUND);
    expect(followFrameMs(undefined)).toBe(FRAME_MS_FOCUSED);
    expect(FRAME_MS_FOCUSED).toBeCloseTo(33.3, 1);
  });
});

describe("window state (Tauri events, DOM fallback)", () => {
  const focusedDoc = { hasFocus: () => true, hidden: false };

  it("Tauri's focus loss counts even when the document still claims the focus", () => {
    expect(windowUnfocused(focusedDoc)).toBe(false);
    setWindowFocused(false);
    expect(windowUnfocused(focusedDoc)).toBe(true);
    expect(followFrameMs(focusedDoc)).toBe(FRAME_MS_BACKGROUND);
    setWindowFocused(true);
    expect(followFrameMs(focusedDoc)).toBe(FRAME_MS_FOCUSED);
    // without a Tauri event the document decides
    resetWindowState();
    expect(followFrameMs({ hasFocus: () => false })).toBe(FRAME_MS_BACKGROUND);
  });

  it("minimised or hidden is away (WebView2 keeps document.hidden false when minimised)", () => {
    expect(windowAway(focusedDoc)).toBe(false);
    expect(windowAway({ hidden: true })).toBe(true);
    setWindowMinimized(true);
    expect(windowAway(focusedDoc)).toBe(true);
    setWindowMinimized(false);
    expect(windowAway(focusedDoc)).toBe(false);
  });

  it("leaving the minimised state tells the return listeners once", () => {
    const back = vi.fn();
    const off = onWindowReturn(back);
    setWindowMinimized(false);
    setWindowMinimized(true);
    setWindowMinimized(true);
    expect(back).not.toHaveBeenCalled();
    setWindowMinimized(false);
    expect(back).toHaveBeenCalledTimes(1);
    off();
    setWindowMinimized(true);
    setWindowMinimized(false);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("getting the focus back tells them too (back from the tray: hidden, never minimised)", () => {
    const back = vi.fn();
    onWindowReturn(back);
    setWindowFocused(false);
    expect(back).not.toHaveBeenCalled();
    setWindowFocused(true);
    expect(back).toHaveBeenCalledTimes(1);
    // no change, no call
    setWindowFocused(true);
    expect(back).toHaveBeenCalledTimes(1);
  });
});

describe("watchWindow", () => {
  function fakeWindow(start: { focused: boolean; minimized: boolean }) {
    let focusCb: ((e: { payload: boolean }) => void) | undefined;
    let resizeCb: (() => void) | undefined;
    const state = { ...start };
    const unlistened: string[] = [];
    const api: WindowApi = {
      onFocusChanged: (cb) => {
        focusCb = cb;
        return Promise.resolve(() => void unlistened.push("focus"));
      },
      onResized: (cb) => {
        resizeCb = cb;
        return Promise.resolve(() => void unlistened.push("resize"));
      },
      isMinimized: () => Promise.resolve(state.minimized),
      isFocused: () => Promise.resolve(state.focused),
    };
    return { api, state, unlistened, focus: (f: boolean) => focusCb?.({ payload: f }), resize: () => resizeCb?.() };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const doc = { hasFocus: () => true, hidden: false };

  it("takes the initial state, then focus events and minimise / restore (a resize)", async () => {
    const w = fakeWindow({ focused: false, minimized: false });
    const stop = watchWindow(w.api);
    await flush();
    expect(windowUnfocused(doc)).toBe(true);
    w.focus(true);
    expect(windowUnfocused(doc)).toBe(false);
    w.state.minimized = true;
    w.resize();
    await flush();
    expect(windowAway(doc)).toBe(true);
    const back = vi.fn();
    onWindowReturn(back);
    w.state.minimized = false;
    w.resize();
    await flush();
    expect(windowAway(doc)).toBe(false);
    expect(back).toHaveBeenCalledTimes(1);
    stop();
    expect(w.unlistened.sort()).toEqual(["focus", "resize"]);
  });

  it("a focus event that arrives before the initial query is not overwritten by it", async () => {
    const w = fakeWindow({ focused: false, minimized: false });
    watchWindow(w.api);
    w.focus(true);
    await flush();
    expect(windowUnfocused(doc)).toBe(false);
  });

  it("resize events during a pending isMinimized query merge into one follow-up query (H-4)", async () => {
    let calls = 0;
    let resizeCb: (() => void) | undefined;
    const answers: Array<(m: boolean) => void> = [];
    const api: WindowApi = {
      onFocusChanged: () => Promise.resolve(() => {}),
      onResized: (cb) => {
        resizeCb = cb;
        return Promise.resolve(() => {});
      },
      isMinimized: () => {
        calls++;
        return new Promise<boolean>((r) => answers.push(r));
      },
      isFocused: () => Promise.resolve(true),
    };
    watchWindow(api);
    expect(calls).toBe(1);
    // a window dragged larger: dozens of resizes while the first query is under way
    for (let i = 0; i < 30; i++) resizeCb?.();
    expect(calls).toBe(1);
    answers.shift()!(false);
    await flush();
    // …and exactly one more, which reads the final state
    expect(calls).toBe(2);
    answers.shift()!(true);
    await flush();
    expect(windowAway(doc)).toBe(true);
    expect(calls).toBe(2);
  });

  it("without Tauri (browser preview, tests) nothing is watched and nothing throws", () => {
    expect(() => watchWindow()()).not.toThrow();
    expect(windowUnfocused(doc)).toBe(false);
  });
});

describe("capRenders (every map frame outside gestures)", () => {
  function fakeMap() {
    const m = {
      frames: [] as number[],
      t: 0,
      renderCbs: new Set<() => void>(),
      triggerRepaint() {
        m.frames.push(m.t);
        for (const f of m.renderCbs) f();
      },
      on: (_: "render", f: () => void) => m.renderCbs.add(f),
      off: (_: "render", f: () => void) => m.renderCbs.delete(f),
    };
    return m;
  }

  it("requests of a 60 Hz loop give 30 frames/s focused and 15 unfocused", () => {
    vi.useFakeTimers();
    for (const [ms, lo, hi] of [
      [FRAME_MS_FOCUSED, 28, 31],
      [FRAME_MS_BACKGROUND, 14, 16],
    ] as const) {
      const m = fakeMap();
      const cap = capRenders(m, () => false, () => ms, () => false, () => m.t);
      for (m.t = 0; m.t < 1000; m.t += 1000 / 60) {
        vi.advanceTimersByTime(1000 / 60);
        m.triggerRepaint();
        m.triggerRepaint();
      }
      expect(m.frames.length).toBeGreaterThanOrEqual(lo);
      expect(m.frames.length).toBeLessThanOrEqual(hi);
      cap.dispose();
    }
  });

  it("a gesture or camera animation renders every request at once", () => {
    vi.useFakeTimers();
    const m = fakeMap();
    let gesture = true;
    capRenders(m, () => gesture, () => FRAME_MS_BACKGROUND, () => false, () => m.t);
    for (let i = 0; i < 60; i++) {
      m.t = (i * 1000) / 60;
      m.triggerRepaint();
    }
    expect(m.frames.length).toBe(60);
    // after the gesture the budget applies again
    gesture = false;
    m.frames.length = 0;
    for (m.t = 1000; m.t < 2000; m.t += 1000 / 60) {
      vi.advanceTimersByTime(1000 / 60);
      m.triggerRepaint();
    }
    expect(m.frames.length).toBeLessThanOrEqual(16);
  });

  it("no frame while away; one frame on return, without a backlog", () => {
    vi.useFakeTimers();
    const m = fakeMap();
    let away = false;
    const cap = capRenders(m, () => false, () => FRAME_MS_FOCUSED, () => away, () => m.t);
    m.triggerRepaint();
    expect(m.frames).toHaveLength(1);
    // a budget frame that comes due while away is dropped as well
    m.t = 10;
    m.triggerRepaint();
    away = true;
    vi.advanceTimersByTime(100);
    for (let i = 0; i < 100; i++) m.triggerRepaint();
    expect(m.frames).toHaveLength(1);
    away = false;
    m.t = 5000;
    cap.resume();
    cap.resume();
    expect(m.frames).toEqual([0, 5000]);
  });

  it("restoring the window (onWindowReturn) draws the missed frame", () => {
    const m = fakeMap();
    capRenders(m, () => false, () => FRAME_MS_FOCUSED, () => windowAway({ hidden: false }), () => m.t);
    setWindowMinimized(true);
    m.triggerRepaint();
    expect(m.frames).toHaveLength(0);
    m.t = 1000;
    setWindowMinimized(false);
    expect(m.frames).toEqual([1000]);
  });

  it("R1: back from the tray (document.hidden → visible) draws the missed frame without any Tauri event", () => {
    const m = fakeMap();
    const doc = Object.assign(new EventTarget(), { hidden: true });
    const cap = capRenders(m, () => false, () => FRAME_MS_FOCUSED, () => windowAway(doc), () => m.t, doc);
    // hidden to the tray: an ease frame and a source update are dropped
    m.triggerRepaint();
    m.triggerRepaint();
    expect(m.frames).toHaveLength(0);
    // a visibilitychange to hidden (or a second one) draws nothing
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(m.frames).toHaveLength(0);
    m.t = 2000;
    doc.hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(m.frames).toEqual([2000]);
    // nothing missed since: the next change draws nothing extra
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(m.frames).toEqual([2000]);
    // after dispose the listener is gone
    cap.dispose();
    doc.hidden = true;
    m.triggerRepaint();
    doc.hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(m.frames.length).toBeLessThanOrEqual(2);
  });

  it("R1: the focus coming back from Tauri resumes as well (tray restore without visibilitychange)", () => {
    const m = fakeMap();
    let hidden = true;
    capRenders(m, () => false, () => FRAME_MS_FOCUSED, () => hidden, () => m.t, undefined);
    setWindowFocused(false);
    m.triggerRepaint();
    expect(m.frames).toHaveLength(0);
    hidden = false;
    m.t = 3000;
    setWindowFocused(true);
    expect(m.frames).toEqual([3000]);
  });

  it("dispose puts the map's own triggerRepaint back", () => {
    class ProtoMap {
      frames = 0;
      triggerRepaint() {
        this.frames++;
      }
      on() {}
      off() {}
    }
    const m = new ProtoMap();
    const cap = capRenders(m, () => false, () => 1000, () => true);
    m.triggerRepaint();
    expect(m.frames).toBe(0);
    cap.dispose();
    expect(Object.prototype.hasOwnProperty.call(m, "triggerRepaint")).toBe(false);
    m.triggerRepaint();
    expect(m.frames).toBe(1);
  });
});

describe("frameAfter (loops asleep between their frames)", () => {
  it("sleeps in a timer, then waits for the next animation frame", () => {
    vi.useFakeTimers();
    const frames: Array<(t: number) => void> = [];
    vi.stubGlobal("requestAnimationFrame", (f: (t: number) => void) => frames.push(f));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const cb = vi.fn();
    frameAfter(FRAME_MS_FOCUSED, cb);
    // no frame asked for until shortly before the delay is over
    vi.advanceTimersByTime(FRAME_MS_FOCUSED - 10);
    expect(frames).toHaveLength(0);
    vi.advanceTimersByTime(10);
    expect(frames).toHaveLength(1);
    frames.shift()!(123);
    expect(cb).toHaveBeenCalledWith(123);
    // no delay: the next frame at once; cancel drops it
    const cancel = frameAfter(0, cb);
    expect(frames).toHaveLength(1);
    cancel();
    const sleeping = frameAfter(100, cb);
    sleeping();
    vi.advanceTimersByTime(200);
    expect(frames).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
