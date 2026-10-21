import { describe, expect, it } from "vitest";
import { uiVisible, watchUiVisibility, type VisibilityWindowApi } from "./uiVisibility";

const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeDoc() {
  const listeners = new Set<() => void>();
  return {
    hidden: false,
    addEventListener: (_: string, f: () => void) => void listeners.add(f),
    removeEventListener: (_: string, f: () => void) => void listeners.delete(f),
    fire() {
      for (const f of listeners) f();
    },
    listeners,
  };
}

interface FakeWin {
  minimized: boolean;
  unlistened: boolean;
  api: VisibilityWindowApi;
  resize(): void;
}

function fakeWin(): FakeWin {
  let resized: (() => void) | null = null;
  const w: FakeWin = {
    minimized: false,
    unlistened: false,
    api: {
      onResized: (cb: () => void) => {
        resized = cb;
        return Promise.resolve(() => {
          w.unlistened = true;
        });
      },
      isMinimized: () => Promise.resolve(w.minimized),
    },
    resize() {
      resized?.();
    },
  };
  return w;
}

describe("uiVisible", () => {
  it("is visible only when shown and not minimised", () => {
    expect(uiVisible({ hidden: false, minimized: false })).toBe(true);
    expect(uiVisible({ hidden: false, minimized: true })).toBe(false); // WebView2 minimise
    expect(uiVisible({ hidden: true, minimized: false })).toBe(false); // tray / tab hidden
    expect(uiVisible({ hidden: true, minimized: true })).toBe(false);
  });
});

describe("watchUiVisibility", () => {
  it("reports minimise and restore from Tauri although document.hidden stays false", async () => {
    const doc = fakeDoc();
    const win = fakeWin();
    const seen: boolean[] = [];
    const w = watchUiVisibility((v) => seen.push(v), doc, win.api);
    await flush();
    expect(seen).toEqual([true]);
    win.minimized = true;
    win.resize();
    await flush();
    expect(seen).toEqual([true, false]);
    win.minimized = false;
    win.resize();
    await flush();
    expect(seen).toEqual([true, false, true]);
    w.stop();
    expect(win.unlistened).toBe(true);
    expect(doc.listeners.size).toBe(0);
  });

  it("reports only changes (a resize drag does not spam the backend)", async () => {
    const doc = fakeDoc();
    const win = fakeWin();
    const seen: boolean[] = [];
    const w = watchUiVisibility((v) => seen.push(v), doc, win.api);
    win.resize();
    win.resize();
    await flush();
    expect(seen).toEqual([true]);
    w.stop();
  });

  it("falls back to visibilitychange without Tauri", () => {
    const doc = fakeDoc();
    const seen: boolean[] = [];
    const w = watchUiVisibility((v) => seen.push(v), doc);
    doc.hidden = true;
    doc.fire();
    doc.hidden = false;
    doc.fire();
    expect(seen).toEqual([true, false, true]);
    w.stop();
  });

  it("reports again after forget() (the tray hide reported on its own)", async () => {
    const doc = fakeDoc();
    const win = fakeWin();
    const seen: boolean[] = [];
    const w = watchUiVisibility((v) => seen.push(v), doc, win.api);
    await flush();
    w.forget();
    win.resize(); // shown again from the tray
    await flush();
    expect(seen).toEqual([true, true]);
    w.stop();
  });
});

describe("watchUiVisibility ordering", () => {
  it("an older isMinimized answer arriving last does not win", async () => {
    const answers: Array<(m: boolean) => void> = [];
    let resized: () => void = () => {};
    let focused: () => void = () => {};
    const win: VisibilityWindowApi = {
      onResized: (cb) => {
        resized = cb;
        return Promise.resolve(() => {});
      },
      onFocusChanged: (cb) => {
        focused = cb;
        return Promise.resolve(() => {});
      },
      isMinimized: () => new Promise<boolean>((r) => answers.push(r)),
    };
    const seen: boolean[] = [];
    const w = watchUiVisibility((v) => seen.push(v), fakeDoc(), win);
    await flush();
    answers.shift()!(false); // start
    await flush();
    resized(); // minimise
    resized(); // restored right away
    const [minimiseAnswer, restoreAnswer] = answers.splice(0);
    restoreAnswer(false);
    await flush();
    minimiseAnswer(true); // the stale one arrives last
    await flush();
    expect(seen).toEqual([true]);

    // back from the tray: show() without a resize – the focus change asks again
    w.forget();
    answers.splice(0).forEach((r) => r(false));
    await flush();
    focused();
    answers.splice(0).forEach((r) => r(false));
    await flush();
    expect(seen).toEqual([true, true]);
    w.stop();
  });
});
