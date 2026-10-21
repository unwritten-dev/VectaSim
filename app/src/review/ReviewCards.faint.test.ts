import { describe, expect, it } from "vitest";
import source from "./ReviewCards.tsx?raw";

// App.css rule: --text-faint (textFaint) is for decoration and axes only, never information;
// it stays below 3:1 in several themes (themes.test). In the exported review cards every
// <text>/<tspan> carries information (ranks, page numbers, legends, zero values), so none may
// be faint; bars and runway markings may stay faint (their values are labelled).
describe("review cards: no faint text", () => {
  it("no <text> or <tspan> is filled with textFaint", () => {
    const offenders = [...source.matchAll(/<(text|tspan)\b[^>]*\btextFaint\b[^>]*>/g)].map((m) => m[0]);
    expect(offenders).toEqual([]);
  });
  it("the decorative uses are still there (the check is not vacuous)", () => {
    expect(source).toMatch(/<rect\b[^>]*textFaint/);
  });
});
