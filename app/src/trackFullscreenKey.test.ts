import { describe, expect, it } from "vitest";
import { isFullscreenKey } from "./trackFullscreenKey";

const key = (target: unknown, p: Partial<{ key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
  key: "f",
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  target: target as EventTarget | null,
  ...p,
});

describe("full-screen key", () => {
  const button = { tagName: "BUTTON" };
  it("plain F on a non-editable target, either case", () => {
    expect(isFullscreenKey(key(button))).toBe(true);
    expect(isFullscreenKey(key(button, { key: "F" }))).toBe(true);
    expect(isFullscreenKey(key(button, { ctrlKey: true }))).toBe(false);
    expect(isFullscreenKey(key(button, { key: "g" }))).toBe(false);
  });

  it("text fields, selects and editable content keep the key", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "select"]) expect(isFullscreenKey(key({ tagName }))).toBe(false);
    expect(isFullscreenKey(key({ tagName: "DIV", isContentEditable: true }))).toBe(false);
  });

  it("with a dialog: only targets inside it (a focused toast is outside)", () => {
    const inside = { tagName: "DIV" };
    const dialog = { contains: (n: Node | null) => (n as unknown) === inside };
    expect(isFullscreenKey(key(inside), dialog)).toBe(true);
    expect(isFullscreenKey(key({ tagName: "BUTTON" }), dialog)).toBe(false);
  });
});
