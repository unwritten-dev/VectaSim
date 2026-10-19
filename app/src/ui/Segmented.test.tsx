import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Segmented, radioKeyIndex } from "./Segmented";

describe("Segmented", () => {
  it("is one tab stop on the checked option", () => {
    const html = renderToStaticMarkup(<Segmented aria-label="Unit" options={[{ value: "kg", label: "kg" }, { value: "lb", label: "lb" }]} value="lb" onChange={() => {}} />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/aria-checked="false" tabindex="-1"[^>]*>kg/);
    expect(html).toMatch(/aria-checked="true" tabindex="0"[^>]*>lb/);
  });

  it("falls back to the first option as tab stop when nothing is checked", () => {
    const html = renderToStaticMarkup(<Segmented inline options={[{ value: 1, label: "1" }, { value: 2, label: "2" }]} value={3} onChange={() => {}} />);
    expect(html.startsWith("<span")).toBe(true);
    expect(html).toMatch(/tabindex="0"[^>]*>1</);
  });

  it("arrow keys move and wrap, Home/End jump", () => {
    expect(radioKeyIndex("ArrowRight", 0, 3)).toBe(1);
    expect(radioKeyIndex("ArrowDown", 2, 3)).toBe(0);
    expect(radioKeyIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(radioKeyIndex("ArrowUp", 1, 3)).toBe(0);
    expect(radioKeyIndex("Home", 2, 3)).toBe(0);
    expect(radioKeyIndex("End", 0, 3)).toBe(2);
    expect(radioKeyIndex("Enter", 0, 3)).toBeNull();
  });
});
