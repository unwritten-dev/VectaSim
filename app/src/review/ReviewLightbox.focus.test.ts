import { describe, expect, it, vi } from "vitest";
import { keepLightboxFocus } from "./ReviewLightbox";

const el = (over: Record<string, unknown> = {}) => ({ focus: vi.fn<(o?: FocusOptions) => void>(), ...over }) as unknown as Element & { focus: ReturnType<typeof vi.fn<(o?: FocusOptions) => void>>; disabled?: boolean };

function root(enabledNav: ReturnType<typeof el> | null, inside: unknown[]) {
  return { contains: (n: Node | null) => inside.includes(n), querySelector: vi.fn(() => enabledNav) };
}

describe("keepLightboxFocus", () => {
  it("moves the focus to the other arrow when › got disabled on the last card", () => {
    const next = el({ disabled: true });
    const prev = el();
    const close = el();
    const r = root(prev, [next, prev, close]);
    expect(keepLightboxFocus(r, next, null, close)).toBe(prev);
    expect(prev.focus).toHaveBeenCalled();
    expect(r.querySelector).toHaveBeenCalledWith(".review-lightbox-nav:not(:disabled)");
  });

  it("recovers from a focus dropped to <body>; falls back to Schließen with a single card", () => {
    const body = el();
    const close = el();
    expect(keepLightboxFocus(root(null, [close]), body, body, close)).toBe(close);
    expect(close.focus).toHaveBeenCalled();
  });

  it("leaves a focus that is still valid alone", () => {
    const prev = el();
    const toast = el();
    const close = el();
    expect(keepLightboxFocus(root(prev, [prev, close]), prev, null, close)).toBeNull();
    expect(keepLightboxFocus(root(prev, [prev, close]), toast, null, close)).toBeNull();
    expect(prev.focus).not.toHaveBeenCalled();
  });
});
