// Band markers for plots and legends: a shape per band (facts.ts BAND_SHAPE /
// APPROACH_BAND_SHAPE) on top of the band colour, so a band never depends on colour alone
// (deuteranopia/protanopia, monochrome themes). All shapes have about the area of a circle
// of radius `r`, so no band looks heavier than another.

import type { CSSProperties } from "react";
import type { BandShape } from "./facts";

/** SVG path of a band shape centred on (x, y). */
export function shapePath(shape: Exclude<BandShape, "circle">, x: number, y: number, r: number): string {
  const f = (v: number) => v.toFixed(2);
  if (shape === "square") {
    const h = r * 0.9;
    return `M${f(x - h)},${f(y - h)}H${f(x + h)}V${f(y + h)}H${f(x - h)}Z`;
  }
  if (shape === "diamond") {
    const d = r * 1.27;
    return `M${f(x)},${f(y - d)}L${f(x + d)},${f(y)}L${f(x)},${f(y + d)}L${f(x - d)},${f(y)}Z`;
  }
  // equilateral, centroid on (x, y)
  const s = r * 2.69;
  const h = (s * Math.sqrt(3)) / 2;
  return `M${f(x)},${f(y - (2 * h) / 3)}L${f(x + s / 2)},${f(y + h / 3)}L${f(x - s / 2)},${f(y + h / 3)}Z`;
}

export function ShapeMark({ shape, x, y, r, style, className }: { shape: BandShape; x: number; y: number; r: number; style?: CSSProperties; className?: string }) {
  if (shape === "circle") return <circle cx={x} cy={y} r={r} style={style} className={className} />;
  return <path d={shapePath(shape, x, y, r)} style={style} className={className} />;
}

/** Legend swatch: the shape in the band colour, 12 × 12 px, decorative (the label follows). */
export function BandSwatch({ shape, color, hollow = false }: { shape: BandShape; color: string; hollow?: boolean }) {
  return (
    <svg className="band-swatch" width={12} height={12} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <ShapeMark shape={shape} x={6} y={shape === "triangle" ? 6.6 : 6} r={4} style={hollow ? { fill: "none", stroke: color, strokeWidth: 1.5 } : { fill: color }} />
    </svg>
  );
}
