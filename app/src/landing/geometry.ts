// Layout math for the landing debrief's runway diagram and approach chart. Pure, see
// geometry.test.ts. Runway coordinates come from the Rust analysis (landing.rs): x metres
// past the threshold along the runway, y metres right of the centreline.

import { t } from "../i18n";
import { fmt } from "../i18n/number";

export const M_PER_FT = 0.3048;
export const M_PER_NM = 1852;
/** Ground track shown before the threshold. */
export const TRACK_BEFORE_M = M_PER_NM;
/** The runway is drawn at least this many pixels wide (lateral axis exaggerated). */
export const MIN_RUNWAY_PX = 44;
/** With a fixed exaggeration the runway may get thinner (narrow window), but not below this. */
const MIN_DRAWN_RUNWAY_PX = 28;
/** Lateral extent beyond which track points are clipped (circling, go-arounds). */
const MAX_LATERAL_M = 600;
/** Drawn width of a runway whose width the database does not know (as the ±15 m fallback in landing.rs). */
export const UNKNOWN_WIDTH_DRAW_M = 30;

/** Width to draw: the database width, or UNKNOWN_WIDTH_DRAW_M when unknown. */
export function drawWidthM(widthM: number | null | undefined): number {
  return widthM != null && widthM > 0 ? widthM : UNKNOWN_WIDTH_DRAW_M;
}

export interface XY {
  x: number;
  y: number;
}

export interface RunwayLayoutInput {
  lengthM: number;
  widthM: number;
  /** Track and marker points in runway coordinates. */
  points: XY[];
  touchdown?: XY | null;
  /** Pixel width of the drawing. */
  widthPx: number;
  minHeightPx?: number;
  maxHeightPx?: number;
  /**
   * Fixed lateral exaggeration (yScale / xScale), so two drawings of different widths
   * (debrief and landing card) show the same landing alike; still never below true scale,
   * never wider than the height allows and never thinner than MIN_DRAWN_RUNWAY_PX.
   */
  exaggeration?: number;
}

export interface RunwayLayout {
  widthPx: number;
  heightPx: number;
  xMin: number;
  xMax: number;
  /** px per metre along / across the runway. */
  xScale: number;
  yScale: number;
  /** yScale / xScale; 1 = true to scale. */
  exaggeration: number;
  /** SVG y of the centreline. */
  cy: number;
  padLeft: number;
  toSvg: (p: XY) => [number, number];
  /** Distance marks along the runway (m past the threshold). */
  ticks: number[];
  /** Lateral positions (m) of the threshold "piano key" stripes. */
  stripes: number[];
}

const PAD_L = 24;
const PAD_R = 24;
const PAD_V = 34;

/** 1/2/5 × 10^n step of at least `minPx` pixels at `scale` px/m. */
export function niceDistanceStep(scale: number, minPx: number): number {
  const raw = minPx / Math.max(scale, 1e-9);
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * mag >= raw) return f * mag;
  return 10 * mag;
}

/** Number of threshold stripes for a runway width (ICAO Annex 14: 18 m → 4 … 60 m → 16). */
export function stripeCount(widthM: number): number {
  if (widthM >= 60) return 16;
  if (widthM >= 45) return 12;
  if (widthM >= 30) return 8;
  if (widthM >= 23) return 6;
  return 4;
}

/**
 * Top-down layout with the landing direction left → right. The along-runway axis is
 * to scale; the lateral axis is stretched so the runway is at least MIN_RUNWAY_PX wide,
 * but never compressed below true scale.
 */
export function runwayLayout(o: RunwayLayoutInput): RunwayLayout {
  const L = Math.max(o.lengthM, 1);
  const W = Math.max(o.widthM, 10);
  const minH = o.minHeightPx ?? 150;
  const maxH = o.maxHeightPx ?? 320;
  const inView = o.points.filter((p) => p.x >= -TRACK_BEFORE_M && Math.abs(p.y) <= MAX_LATERAL_M);
  const xs = inView.map((p) => p.x);
  if (o.touchdown) xs.push(o.touchdown.x);
  const xMin = Math.min(-TRACK_BEFORE_M * 0.25, ...xs) - 40;
  const xMax = Math.max(L, ...xs) + 60;
  const fullScale = (o.widthPx - PAD_L - PAD_R) / (xMax - xMin);

  let maxAbsY = W / 2;
  for (const p of inView) maxAbsY = Math.max(maxAbsY, Math.abs(p.y));
  if (o.touchdown) maxAbsY = Math.max(maxAbsY, Math.min(Math.abs(o.touchdown.y), MAX_LATERAL_M));
  const fit = (maxH / 2 - PAD_V) / (maxAbsY * 1.1);
  // a far-off touchdown that does not fit at true scale shrinks the whole drawing uniformly
  const xScale = Math.min(fullScale, fit);
  const yScale =
    o.exaggeration != null
      ? Math.max(xScale, Math.min(Math.max(xScale * o.exaggeration, MIN_DRAWN_RUNWAY_PX / W), fit))
      : Math.max(xScale, Math.min(MIN_RUNWAY_PX / W, fit));
  const padLeft = PAD_L + ((xMax - xMin) * (fullScale - xScale)) / 2;
  const heightPx = Math.round(Math.min(maxH, Math.max(minH, 2 * (maxAbsY * 1.1 * yScale + PAD_V))));
  const cy = heightPx / 2;

  const toSvg = (p: XY): [number, number] => [padLeft + (p.x - xMin) * xScale, cy + p.y * yScale];

  const step = niceDistanceStep(xScale, 56);
  const ticks: number[] = [];
  for (let d = step; d < L - step * 0.3; d += step) ticks.push(d);

  const n = stripeCount(W);
  // stripes cover the width minus 3 m edges, centreline gap in the middle
  const usable = W - 6;
  const pitch = usable / (n + 1);
  const stripes: number[] = [];
  for (let i = 0; i < n; i++) {
    const half = n / 2;
    const k = i < half ? i - half : i - half + 1;
    stripes.push(k * pitch);
  }

  return { widthPx: o.widthPx, heightPx, xMin, xMax, xScale, yScale, exaggeration: yScale / xScale, cy, padLeft, toSvg, ticks, stripes };
}

/** SVG path through points (in runway coordinates). */
export function pathOf(points: XY[], toSvg: (p: XY) => [number, number]): string {
  return points
    .map((p, i) => {
      const [x, y] = toSvg(p);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join("");
}

/**
 * Height (ft above the threshold) of a glidepath of `angleDeg`, `distM` before the threshold.
 * All lines share the glidepath origin of the nominal path (crossing the threshold at
 * `tchFt`), so the ±tolerance lines fan out from the same point like the analysis does.
 */
export function referenceHeightFt(distM: number, angleDeg: number, tchFt: number, nominalDeg = angleDeg): number {
  const rad = Math.PI / 180;
  const gpip = (tchFt * M_PER_FT) / Math.tan(nominalDeg * rad);
  return Math.max(0, ((distM + gpip) * Math.tan(angleDeg * rad)) / M_PER_FT);
}

/** Index of the sample whose `distM` is closest to `d` (samples ordered by time). */
export function nearestByDist<T extends { distM: number }>(samples: T[], d: number): number {
  let best = -1;
  let bestD = Infinity;
  samples.forEach((s, i) => {
    const e = Math.abs(s.distM - d);
    if (e < bestD) {
      bestD = e;
      best = i;
    }
  });
  return best;
}

/**
 * "3 m rechts", "12 m links", "auf der Mittellinie" (|y| < 0.5 m). Whole metres: the
 * runway coordinates are often only good to ±5 m (4 decimals), a decimal would be
 * false precision (OurAirports runway coordinates are only metre-accurate).
 */
export function sideLabel(lateralM: number): string {
  const a = Math.abs(lateralM);
  if (a < 0.5) return t("landing.side.onCentreline");
  return t(lateralM > 0 ? "landing.side.right" : "landing.side.left", { m: fmt(a, 0, "m") });
}
