import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireModal, chooseReturnFocus, dispatchModalKey, isBackdropClick, isModalOpen, modalKeyAction, nextTabStop, tabOrder, topModalRoot } from "./modalStack";

// node environment: a minimal document with the shell and <body>
const attrs = new Set<string>();
const classes = new Set<string>();
const shell = { setAttribute: (n: string) => void attrs.add(n), removeAttribute: (n: string) => void attrs.delete(n) };
const body = { classList: { toggle: (c: string, on: boolean) => void (on ? classes.add(c) : classes.delete(c)) } };

/** A modal root that records its own `inert`. */
function fakeRoot() {
  const a = new Set<string>();
  return { el: { setAttribute: (n: string) => void a.add(n), removeAttribute: (n: string) => void a.delete(n) } as unknown as HTMLElement, inert: () => a.has("inert") };
}
const key = (k: string, defaultPrevented = false) => ({ key: k, defaultPrevented }) as KeyboardEvent;

beforeEach(() => {
  attrs.clear();
  classes.clear();
  (globalThis as { document?: unknown }).document = { querySelector: () => shell, body, scrollingElement: null };
});
afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

describe("modal stack", () => {
  it("keeps the shell inert until the last modal closes", () => {
    const lightbox = acquireModal();
    const debrief = acquireModal();
    expect(attrs.has("inert")).toBe(true);
    expect(classes.has("modal-open")).toBe(true);
    debrief.release();
    // the lightbox is still open: the background must stay unusable
    expect(attrs.has("inert")).toBe(true);
    expect(isModalOpen()).toBe(true);
    lightbox.release();
    expect(attrs.has("inert")).toBe(false);
    expect(classes.has("modal-open")).toBe(false);
    expect(isModalOpen()).toBe(false);
  });

  it("only the topmost modal handles keys", () => {
    const below = acquireModal();
    const top = acquireModal();
    expect(top.isTop()).toBe(true);
    expect(below.isTop()).toBe(false);
    top.release();
    expect(below.isTop()).toBe(true);
    below.release();
  });

  it("release is idempotent and order-independent", () => {
    const a = acquireModal();
    const b = acquireModal();
    a.release();
    a.release();
    expect(isModalOpen()).toBe(true);
    expect(b.isTop()).toBe(true);
    b.release();
    expect(isModalOpen()).toBe(false);
  });

  it("makes every modal below the topmost inert (debrief over lightbox, editor over debrief)", () => {
    const lb = fakeRoot();
    const db = fakeRoot();
    const rwe = fakeRoot();
    const lightbox = acquireModal({ root: () => lb.el });
    expect(lb.inert()).toBe(false);
    const debrief = acquireModal({ root: () => db.el });
    expect([lb.inert(), db.inert()]).toEqual([true, false]);
    const editor = acquireModal({ root: () => rwe.el });
    expect([lb.inert(), db.inert(), rwe.inert()]).toEqual([true, true, false]);
    expect(topModalRoot()).toBe(rwe.el);
    editor.release();
    expect([lb.inert(), db.inert()]).toEqual([true, false]);
    expect(topModalRoot()).toBe(db.el);
    debrief.release();
    expect(lb.inert()).toBe(false);
    lightbox.release();
    expect(topModalRoot()).toBeNull();
  });

  it("a modal closed from below clears its own inert and leaves the top one usable", () => {
    const lb = fakeRoot();
    const db = fakeRoot();
    const lightbox = acquireModal({ root: () => lb.el });
    const debrief = acquireModal({ root: () => db.el });
    lightbox.release();
    expect(lb.inert()).toBe(false);
    expect(db.inert()).toBe(false);
    expect(debrief.isTop()).toBe(true);
    debrief.release();
  });

  it("hands a key to the topmost modal only (Esc closes the innermost layer)", () => {
    const lowerKey = vi.fn();
    const upperKey = vi.fn();
    const lower = acquireModal({ onKey: lowerKey });
    const upper = acquireModal({ onKey: upperKey });
    dispatchModalKey(key("Escape"));
    expect(upperKey).toHaveBeenCalledTimes(1);
    expect(lowerKey).not.toHaveBeenCalled();
    upper.release();
    dispatchModalKey(key("Escape"));
    expect(lowerKey).toHaveBeenCalledTimes(1);
    lower.release();
    dispatchModalKey(key("Escape"));
    expect(lowerKey).toHaveBeenCalledTimes(1);
  });
});

describe("modal keys", () => {
  it("Esc closes, or is swallowed while closing is off; Tab is trapped", () => {
    expect(modalKeyAction(key("Escape"), true)).toBe("close");
    expect(modalKeyAction(key("Escape"), false)).toBe("block");
    expect(modalKeyAction(key("Tab"), true)).toBe("tab");
    expect(modalKeyAction(key("ArrowRight"), true)).toBeNull();
  });

  it("leaves a key an inner layer already handled (popover Esc) alone", () => {
    expect(modalKeyAction(key("Escape", true), true)).toBeNull();
    expect(modalKeyAction(key("Tab", true), true)).toBeNull();
  });
});

describe("tab order", () => {
  it("puts positive tabindex first (ascending, ties in DOM order), then DOM order, drops negatives", () => {
    const els = [
      { id: "a", tabIndex: 0 },
      { id: "b", tabIndex: 2 },
      { id: "c", tabIndex: -1 },
      { id: "d", tabIndex: 1 },
      { id: "e", tabIndex: 0 },
      { id: "f", tabIndex: 2 },
    ];
    expect(tabOrder(els).map((e) => e.id)).toEqual(["d", "b", "f", "a", "e"]);
  });

  it("wraps around at both ends and leaves the middle to the browser", () => {
    expect(nextTabStop(3, 2, false)).toBe(0); // Tab on the last → first
    expect(nextTabStop(3, 0, true)).toBe(2); // Shift+Tab on the first → last
    expect(nextTabStop(3, 1, false)).toBeNull();
    expect(nextTabStop(3, 1, true)).toBeNull();
    expect(nextTabStop(3, 0, false)).toBeNull();
  });

  it("pulls focus that is on no tab stop (dialog, body) to the first or last", () => {
    expect(nextTabStop(4, -1, false)).toBe(0);
    expect(nextTabStop(4, -1, true)).toBe(3);
    expect(nextTabStop(1, 0, false)).toBe(0);
    expect(nextTabStop(1, 0, true)).toBe(0);
  });

  it("swallows Tab when there is nothing to focus", () => {
    expect(nextTabStop(0, -1, false)).toBe(-1);
    expect(nextTabStop(0, -1, true)).toBe(-1);
  });
});

describe("focus return", () => {
  const usable = (el: { ok: boolean }) => el.ok;
  const given = { id: "given", ok: true };
  const opener = { id: "opener", ok: true };
  const top = { id: "lightbox", ok: true };
  const layout = { id: "main.layout", ok: true };

  it("prefers the given element, then the opener", () => {
    expect(chooseReturnFocus([given, opener, top, layout], usable)).toBe(given);
    expect(chooseReturnFocus([null, opener, top, layout], usable)).toBe(opener);
  });

  it("skips an opener that is gone or behind another modal (toast button, inert shell)", () => {
    const goneOpener = { id: "toast", ok: false };
    expect(chooseReturnFocus([undefined, goneOpener, top, layout], usable)).toBe(top);
    expect(chooseReturnFocus([undefined, goneOpener, null, layout], usable)).toBe(layout);
    expect(chooseReturnFocus([undefined, goneOpener, null, null], usable)).toBeNull();
  });
});

describe("backdrop click", () => {
  const isBackdrop = (t: string) => t === "backdrop" || t === "stage";

  it("closes only when press and release are both on the backdrop", () => {
    expect(isBackdropClick("backdrop", "backdrop", isBackdrop)).toBe(true);
    expect(isBackdropClick("stage", "backdrop", isBackdrop)).toBe(true);
    expect(isBackdropClick("card", "backdrop", isBackdrop)).toBe(false); // selection dragged out
    expect(isBackdropClick("backdrop", "button", isBackdrop)).toBe(false);
    expect(isBackdropClick(null, "backdrop", isBackdrop)).toBe(false);
  });
});
