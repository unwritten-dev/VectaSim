// Grid of the story-card previews (Logbuch → Jahr) and the keys of the single-card view.
// Pure functions, so the sizing rule and the keyboard navigation are testable without a DOM.
import { FORMAT_SIZE, type CardFormat } from "./text";

/** Preview width bounds per format (CSS px) and the column range (minCols only where it fits). */
export const GRID_BOUNDS: Record<CardFormat, { min: number; max: number; minCols: number; maxCols: number }> = {
  portrait: { min: 240, max: 420, minCols: 1, maxCols: 8 },
  landscape: { min: 360, max: 680, minCols: 2, maxCols: 3 },
};

/** A column count within this share of the largest possible card counts as „as large“. */
const SIZE_TOLERANCE = 0.85;

export interface GridInput {
  /** Inner width of the grid area (px). */
  width: number;
  /** Height visible for the first row without scrolling (px). */
  height: number;
  count: number;
  format: CardFormat;
  /** Gap between cards (px). */
  gap: number;
  /** Height under each card: title and the Save/Copy buttons (px). */
  caption: number;
}

export interface GridLayout {
  columns: number;
  rows: number;
  /** Width of one card preview (px, whole pixels); the height follows from the format. */
  cardWidth: number;
}

/**
 * Column count and card width for the preview grid. Rule:
 * 1. Candidates: every column count whose columns are at least the format's minimum width
 *    (one column always qualifies), at most `maxCols` and the number of cards; landscape
 *    keeps at least two columns whenever two fit.
 * 2. Card width per candidate: the column width, but no wider than the format's maximum and
 *    no taller than the visible height (one whole card on screen) – the height limit never
 *    pushes it below the minimum width.
 * 3. Pick the largest card; among candidates within 85 % of that size the one with the fewest
 *    rows (a row less beats a few pixels), then the larger card.
 * So a big window shows big cards and scrolls vertically instead of a row of thumbnails, and
 * there is never a horizontal scrollbar.
 */
export function reviewGridLayout({ width, height, count, format, gap, caption }: GridInput): GridLayout {
  const { min, max, minCols, maxCols } = GRID_BOUNDS[format];
  const { w, h } = FORMAT_SIZE[format];
  const n = Math.max(1, count);
  const byHeight = Math.max(min, Math.min(max, (height - caption) / (h / w)));
  const options: GridLayout[] = [];
  for (let c = 1; c <= Math.min(n, maxCols); c++) {
    const col = (width - (c - 1) * gap) / c;
    if (c > 1 && col < min) break;
    options.push({ columns: c, rows: Math.ceil(n / c), cardWidth: Math.max(1, Math.floor(Math.min(col, byHeight))) });
  }
  const floor = Math.min(minCols, n, options.length);
  const allowed = options.filter((o) => o.columns >= floor);
  const best = Math.max(...allowed.map((o) => o.cardWidth));
  return allowed
    .filter((o) => o.cardWidth >= best * SIZE_TOLERANCE)
    .reduce((a, b) => (b.rows < a.rows || (b.rows === a.rows && b.cardWidth > a.cardWidth) ? b : a));
}

/** What a key does in the single-card view: another index, close, or nothing. */
export type LightboxKeyResult = { index: number } | "close" | null;

/** Arrow keys (and Page Up/Down, Home/End) step through the cards without wrapping; Esc closes. */
export function lightboxKey(key: string, index: number, count: number): LightboxKeyResult {
  const last = count - 1;
  switch (key) {
    case "Escape":
      return "close";
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
      return index < last ? { index: index + 1 } : null;
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      return index > 0 ? { index: index - 1 } : null;
    case "Home":
      return index > 0 ? { index: 0 } : null;
    case "End":
      return index < last ? { index: last } : null;
    default:
      return null;
  }
}
