import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { GRID_BOUNDS, lightboxKey, reviewGridLayout, type GridInput } from "./layout";
import { LightboxBody } from "./ReviewLightbox";
import type { CardFormat } from "./text";

const base = { gap: 16, caption: 72 };
const grid = (width: number, height: number, count: number, format: CardFormat = "portrait", extra: Partial<GridInput> = {}) =>
  reviewGridLayout({ width, height, count, format, ...base, ...extra });

/** Total width of the grid – must never exceed the available width (no horizontal scrolling). */
const used = (l: { columns: number; cardWidth: number }) => l.columns * l.cardWidth + (l.columns - 1) * base.gap;

describe("reviewGridLayout", () => {
  it("full screen (≈2000×1090): large portrait cards at the maximum width instead of a thumbnail row", () => {
    for (const n of [7, 8]) {
      const l = grid(1900, 900, n);
      expect(l.cardWidth).toBe(GRID_BOUNDS.portrait.max);
      expect(l.columns).toBe(4);
      expect(l.rows).toBe(2);
      expect(used(l)).toBeLessThanOrEqual(1900);
    }
  });

  it("1440×900: cards fit the visible height, a row less beats a few pixels", () => {
    const l = grid(1340, 720, 8);
    // tallest card fitting 720 px is (720-72)·1080/1920 = 364 px; 4 columns give 323 px (within 85 %) in 2 rows
    expect(l.columns).toBe(4);
    expect(l.rows).toBe(2);
    expect(l.cardWidth).toBe(323);
    expect((l.cardWidth * 1920) / 1080 + base.caption).toBeLessThanOrEqual(720);
  });

  it("1024×640: 3 portrait columns at the minimum width, scrolling vertically", () => {
    const l = grid(920, 430, 8);
    expect(l.columns).toBe(3);
    expect(l.cardWidth).toBe(GRID_BOUNDS.portrait.min);
    expect(used(l)).toBeLessThanOrEqual(920);
  });

  it("never narrower than the minimum while two columns fit, and never wider than the space", () => {
    for (const width of [500, 700, 920, 1100, 1340, 1600, 1900, 2500, 3800]) {
      for (const height of [400, 600, 900, 1400]) {
        for (const n of [1, 5, 7, 8]) {
          for (const f of ["portrait", "landscape"] as const) {
            const l = grid(width, height, n, f);
            expect(used(l), `${f} ${width}×${height} n=${n}`).toBeLessThanOrEqual(width);
            expect(l.cardWidth).toBeLessThanOrEqual(GRID_BOUNDS[f].max);
            if (l.columns > 1) expect(l.cardWidth).toBeGreaterThanOrEqual(GRID_BOUNDS[f].min);
            expect(l.columns).toBeLessThanOrEqual(Math.min(n, GRID_BOUNDS[f].maxCols));
            expect(l.rows).toBe(Math.ceil(n / l.columns));
          }
        }
      }
    }
  });

  it("a narrow window falls back to one column as wide as the space", () => {
    const l = grid(300, 700, 8);
    expect(l.columns).toBe(1);
    expect(l.cardWidth).toBe(300);
    expect(grid(200, 700, 8).cardWidth).toBe(200);
  });

  it("few cards on a wide screen: one row, no empty columns", () => {
    const l = grid(1900, 900, 3);
    expect(l.columns).toBe(3);
    expect(l.rows).toBe(1);
    expect(l.cardWidth).toBe(GRID_BOUNDS.portrait.max);
  });

  it("landscape: 3 columns on a wide screen, 2 on medium widths, never more than 3", () => {
    const wide = grid(1900, 900, 8, "landscape");
    expect(wide.columns).toBe(3);
    expect(wide.cardWidth).toBe(Math.floor((1900 - 32) / 3));
    const mid = grid(1340, 720, 8, "landscape");
    expect(mid.columns).toBe(2);
    expect(mid.cardWidth).toBe(662);
    const small = grid(920, 430, 8, "landscape");
    expect(small.columns).toBe(2);
    expect(small.cardWidth).toBe(452);
    expect(grid(3800, 1400, 8, "landscape").columns).toBe(3);
  });

  it("a low window limits the landscape card to the visible height", () => {
    const l = grid(1900, 400, 8, "landscape");
    expect((l.cardWidth * 675) / 1200 + base.caption).toBeLessThanOrEqual(400);
  });
});

describe("lightboxKey", () => {
  it("arrow keys step without wrapping", () => {
    expect(lightboxKey("ArrowRight", 0, 7)).toEqual({ index: 1 });
    expect(lightboxKey("ArrowDown", 2, 7)).toEqual({ index: 3 });
    expect(lightboxKey("ArrowLeft", 3, 7)).toEqual({ index: 2 });
    expect(lightboxKey("ArrowUp", 1, 7)).toEqual({ index: 0 });
    expect(lightboxKey("ArrowRight", 6, 7)).toBeNull();
    expect(lightboxKey("ArrowLeft", 0, 7)).toBeNull();
  });

  it("Home/End jump, Esc closes, other keys do nothing", () => {
    expect(lightboxKey("Home", 4, 8)).toEqual({ index: 0 });
    expect(lightboxKey("End", 4, 8)).toEqual({ index: 7 });
    expect(lightboxKey("End", 7, 8)).toBeNull();
    expect(lightboxKey("Escape", 4, 8)).toBe("close");
    expect(lightboxKey("Enter", 4, 8)).toBeNull();
    expect(lightboxKey("a", 4, 8)).toBeNull();
  });

  it("walking through all cards with the arrows visits each once", () => {
    const seen = [0];
    let i = 0;
    for (;;) {
      const r = lightboxKey("ArrowRight", i, 8);
      if (r == null || r === "close") break;
      i = r.index;
      seen.push(i);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("LightboxBody", () => {
  const titles = ["Overview", "Your routes", "Your fleet"];
  const render = (index: number, lang: "en" | "de" = "en") =>
    renderToStaticMarkup(
      <I18nProvider lang={lang}>
        <LightboxBody titles={titles} index={index} format="portrait" onIndex={() => {}} onClose={() => {}} actions={<button>Save</button>} titleId="lb-t">
          <svg viewBox="0 0 1080 1920" />
        </LightboxBody>
      </I18nProvider>,
    );

  it("shows title, position and the aspect ratio of the format", () => {
    const html = render(1);
    expect(html).toContain('id="lb-t"');
    expect(html).toContain("Your routes");
    expect(html).toContain("2 of 3");
    expect(html).toContain("--review-ar:0.5625");
    expect(html).toContain('viewBox="0 0 1080 1920"');
  });

  it("disables the previous button on the first card and the next button on the last", () => {
    const first = render(0);
    expect(first).toMatch(/disabled=""[^>]*aria-label="Previous card"/);
    expect(first).not.toMatch(/disabled=""[^>]*aria-label="Next card"/);
    const last = render(2);
    expect(last).toMatch(/disabled=""[^>]*aria-label="Next card"/);
    expect(last).not.toMatch(/disabled=""[^>]*aria-label="Previous card"/);
  });

  it("German texts", () => {
    const html = render(0, "de");
    expect(html).toContain("1 von 3");
    expect(html).toContain("Schließen");
    expect(html).toContain("Nächste Karte");
  });
});
