import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireModal, isModalOpen } from "./modalStack";

// node environment: a minimal document with the shell and <body>
const attrs = new Set<string>();
const classes = new Set<string>();
const shell = { setAttribute: (n: string) => void attrs.add(n), removeAttribute: (n: string) => void attrs.delete(n) };
const body = { classList: { toggle: (c: string, on: boolean) => void (on ? classes.add(c) : classes.delete(c)) } };

beforeEach(() => {
  attrs.clear();
  classes.clear();
  (globalThis as { document?: unknown }).document = { querySelector: () => shell, body };
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
});
