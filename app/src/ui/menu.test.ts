import { describe, expect, it } from "vitest";
import { menuKeyIndex } from "./menu";

describe("menuKeyIndex", () => {
  it("↑/↓ wrap around, Home/End jump", () => {
    expect(menuKeyIndex("ArrowDown", 0, 3)).toBe(1);
    expect(menuKeyIndex("ArrowDown", 2, 3)).toBe(0);
    expect(menuKeyIndex("ArrowUp", 0, 3)).toBe(2);
    expect(menuKeyIndex("Home", 2, 3)).toBe(0);
    expect(menuKeyIndex("End", 0, 3)).toBe(2);
  });
  it("starts at the first/last item when the focus is not in the menu", () => {
    expect(menuKeyIndex("ArrowDown", -1, 3)).toBe(0);
    expect(menuKeyIndex("ArrowUp", -1, 3)).toBe(2);
  });
  it("ignores other keys and empty menus", () => {
    expect(menuKeyIndex("a", 0, 3)).toBeNull();
    expect(menuKeyIndex("ArrowDown", -1, 0)).toBeNull();
  });
});
