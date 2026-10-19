// Jahresrückblick: the static world map of the cards – an equirectangular projection of the
// Natural Earth outlines (`countries_geojson`, the same source as the Länder view) and great
// circles between the year's airports. Pure (geo.test.ts), no map library.

import type { LonLat } from "./stats";

export interface View {
  /** Degrees: west, south, east, north. */
  w: number;
  s: number;
  e: number;
  n: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The whole world without Antarctica. */
export const WORLD: View = { w: -170, s: -57, e: 190, n: 80 };

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/**
 * Projection of `view` into `box`: equirectangular with the parallels squashed by cos(mid
 * latitude), centred, aspect kept (the view grows in the shorter direction).
 */
export function projector(view: View, box: Box): { px: (p: LonLat) => [number, number]; view: View } {
  const k = Math.cos(rad(Math.max(-60, Math.min(60, (view.s + view.n) / 2))));
  let lonSpan = view.e - view.w;
  let latSpan = view.n - view.s;
  // degrees per pixel in both directions, in "squashed" units
  const sx = (lonSpan * k) / box.w;
  const sy = latSpan / box.h;
  const scale = Math.max(sx, sy);
  lonSpan = (box.w * scale) / k;
  latSpan = box.h * scale;
  const cLon = (view.w + view.e) / 2;
  const cLat = (view.s + view.n) / 2;
  const v: View = { w: cLon - lonSpan / 2, e: cLon + lonSpan / 2, s: cLat - latSpan / 2, n: cLat + latSpan / 2 };
  const px = ([lon, lat]: LonLat): [number, number] => [box.x + ((lon - v.w) / lonSpan) * box.w, box.y + ((v.n - lat) / latSpan) * box.h];
  return { px, view: v };
}

/** Points along the great circle from a to b (n segments). */
export function greatCircle(a: LonLat, b: LonLat, n = 48): LonLat[] {
  const [l1, p1] = [rad(a[0]), rad(a[1])];
  const [l2, p2] = [rad(b[0]), rad(b[1])];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (!(d > 1e-9)) return [a, b];
  const out: LonLat[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    out.push([deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.sqrt(x * x + y * y)))]);
  }
  // continuous longitudes (no jump at ±180°), so the line stays one piece
  for (let i = 1; i < out.length; i++) {
    while (out[i][0] - out[i - 1][0] > 180) out[i][0] -= 360;
    while (out[i][0] - out[i - 1][0] < -180) out[i][0] += 360;
  }
  return out;
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

/** SVG path of a line through the points. */
export function linePath(pts: Array<[number, number]>): string {
  return pts.map(([x, y], i) => `${i ? "L" : "M"}${f1(x)} ${f1(y)}`).join("");
}

/**
 * The view around the points: their bounding box plus a margin, at least `minSpan`
 * degrees of longitude; the whole world when they span more than 200°.
 */
export function fitView(points: LonLat[], minSpan = 24): View {
  if (!points.length) return WORLD;
  let w = Infinity;
  let e = -Infinity;
  let s = Infinity;
  let n = -Infinity;
  for (const [lon, lat] of points) {
    w = Math.min(w, lon);
    e = Math.max(e, lon);
    s = Math.min(s, lat);
    n = Math.max(n, lat);
  }
  if (e - w > 200) return WORLD;
  const padLon = Math.max((e - w) * 0.12, (minSpan - (e - w)) / 2, 2);
  const padLat = Math.max((n - s) * 0.15, 2);
  return { w: w - padLon, e: e + padLon, s: Math.max(-80, s - padLat), n: Math.min(85, n + padLat) };
}

type Ring = number[][];

function polygonsOf(g: GeoJSON.Geometry | null | undefined): Ring[][] {
  if (!g) return [];
  if (g.type === "Polygon") return [g.coordinates as Ring[]];
  if (g.type === "MultiPolygon") return g.coordinates as Ring[][];
  return [];
}

export interface CountryShape {
  iso2: string;
  d: string;
}

/**
 * Country outlines as SVG paths in the projection; polygons entirely outside `view` are left
 * out. Copies shifted by ±360° are drawn where the view reaches past the antimeridian.
 */
export function countryPaths(outlines: GeoJSON.FeatureCollection | null | undefined, view: View, box: Box): CountryShape[] {
  if (!outlines) return [];
  const { px, view: v } = projector(view, box);
  const shifts = [0, ...(v.e > 180 ? [360] : []), ...(v.w < -180 ? [-360] : [])];
  const out: CountryShape[] = [];
  for (const f of outlines.features) {
    const iso2 = (f.properties?.iso2 as string | undefined) ?? "";
    let d = "";
    for (const poly of polygonsOf(f.geometry)) {
      const outer = poly[0] ?? [];
      let w = Infinity;
      let e = -Infinity;
      let s = Infinity;
      let n = -Infinity;
      for (const [x, y] of outer) {
        w = Math.min(w, x);
        e = Math.max(e, x);
        s = Math.min(s, y);
        n = Math.max(n, y);
      }
      for (const sh of shifts) {
        if (e + sh < v.w || w + sh > v.e || n < v.s || s > v.n) continue;
        for (const ring of poly) d += `${linePath(ring.map(([x, y]) => px([x + sh, y])))}Z`;
      }
    }
    if (d) out.push({ iso2, d });
  }
  return out;
}
