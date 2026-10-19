// 3D track "curtain" for the pitched map: a translucent wall from the ground up to the flown
// height and a band in altitude colour along its top edge, drawn by one MapLibre custom layer
// (WebGL2, no extra dependency).
//
// Why not fill-extrusion any more: an extrusion has one height per polygon, so the curtain was
// one rectangle per sample pair at the pair's mean height – a staircase along every climb and a
// saw-tooth top edge up close. Here the wall is a triangle strip with two vertices per track
// point (ground 0 m and the height above ground, trackChunks.altToCurtainM – the same scale
// the 3D aircraft model uses, so it sits on the edge); the GPU interpolates between them, the
// edge is a continuous slope. Between the 1 Hz samples a centripetal Catmull-Rom spline adds a
// few points where the track bends (turns, rotation, flare), so curves come out round; the
// spline passes through every kept sample, its height is clamped to the segment's end heights
// (no overshoot below the runway: a segment on the ground stays on the ground).
//
// The band is a quad strip over the same vertices, expanded in screen space in the vertex shader
// (miter joins), so it keeps ~3 css px at every zoom and pitch.
//
// Data: the live map appends points; they are thinned by a 3D Douglas-Peucker in blocks of
// COMMIT_POINTS, the vertices of finished blocks are written once (the GPU buffer grows by
// doubling, only the new part is uploaded) and only the short open tail up to the aircraft is
// rewritten per sample. The logbook map feeds the whole track once through the same path.
// Rendering happens only when MapLibre repaints (camera move) or new data arrives.
//
// Projection as in aircraftModel.ts: tile-local coordinates of a tile around the map centre and
// MapLibre's `projectTileFor3D` (Mercator, globe and the transition). Positions are stored as
// float hi + lo pairs of the Mercator coordinate and the tile origin is subtracted in two parts
// in the shader (emulated double precision), so the track neither jitters zoomed in at the far
// end of a long-haul flight nor needs re-uploading when the camera moves.

import type * as maplibregl from "maplibre-gl";
import type { TrackPoint } from "./common";
import { altToCurtainM } from "./trackChunks";

const EXTENT = 8192;
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
/** Floats per vertex: pos hi.xy lo.xy (4), height m (1), rgb (3), side (1), Δprev (3), Δnext (3). */
export const CURTAIN_FLOATS = 15;
/** Raw points per Douglas-Peucker block of the live track (~1 min at 1 Hz). */
export const COMMIT_POINTS = 64;
/** Douglas-Peucker tolerance: horizontal and vertical metres (the model is px-sized, a few m are invisible). */
export const TOL_H_M = 3;
export const TOL_V_M = 2;
/** Above this many kept points the tolerance doubles and the track is thinned again. */
export const MAX_CONTROL = 12_000;
/** Spline points added inside a bent segment ("2–4 between two samples"). */
export const SUB_BENT = 3;
/** A segment bends when its direction changes by more than this (deg) or its climb gradient by more than BEND_SLOPE. */
const BEND_DEG = 1;
const BEND_SLOPE = 0.01;
/** No spline on a segment this many times longer than a neighbour. */
const LOPSIDED = 2.5;
/** Longest straight piece (m): on the globe a longer one would cut below the surface (chord). */
export const MAX_SEG_M = 20_000;
/** Band width in css px. */
export const BAND_PX = 3;
/** Wall opacity at the bottom and at the top edge (the old extrusion was 0.14 throughout). */
export const WALL_ALPHA: [number, number] = [0.05, 0.2];

/** A curtain point: Mercator x (unwrapped across ±180°) and y, height above ground (m), altitude MSL (ft, colour). */
export interface CPt {
  x: number;
  y: number;
  h: number;
  alt: number;
}

type RGB = [number, number, number];

function hexRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as RGB;
}

/** The altitude ramp ([ft, "#rrggbb"], theme.TRACK_RAMP) as RGB stops. */
export function parseRamp(ramp: ReadonlyArray<readonly [number, string]>): Array<[number, RGB]> {
  return ramp.map(([a, c]) => [a, hexRgb(c)]);
}

/** Colour at `altFt`: linear between the stops, clamped at both ends – as the 2D line's `interpolate linear`. */
export function rampColor(altFt: number, ramp: Array<[number, RGB]>): RGB {
  if (!ramp.length) return [1, 1, 1];
  const a = Number.isFinite(altFt) ? altFt : 0;
  if (a <= ramp[0][0]) return ramp[0][1];
  for (let i = 1; i < ramp.length; i++) {
    const [a1, c1] = ramp[i];
    if (a <= a1) {
      const [a0, c0] = ramp[i - 1];
      const f = a1 > a0 ? (a - a0) / (a1 - a0) : 1;
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return ramp[ramp.length - 1][1];
}

const MAX_LAT = 85.051129;

/** Track point → curtain point; `refX` (the previous point's x) unwraps the antimeridian. */
export function toCPt(p: TrackPoint, refX?: number): CPt {
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, p.lat));
  let x = (p.lon + 180) / 360;
  const y = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
  if (refX !== undefined) x += Math.round(refX - x);
  const hFt = p.hFt != null && Number.isFinite(p.hFt) ? p.hFt : Number.isFinite(p.altFt) ? p.altFt : 0;
  return { x, y, h: altToCurtainM(hFt), alt: Number.isFinite(p.altFt) ? p.altFt : 0 };
}

/** Metres per Mercator unit at Mercator y (C · cos φ). */
export function metersPerUnit(y: number): number {
  return EARTH_CIRCUMFERENCE_M / Math.cosh(Math.PI * (1 - 2 * y));
}

/**
 * Douglas-Peucker in 3D (horizontal metres, height scaled by tolH/tolV): indices to keep,
 * ascending, first and last always. Iterative (no recursion depth limit on long tracks).
 */
export function simplifyIndices(pts: CPt[], tolH = TOL_H_M, tolV = TOL_V_M): number[] {
  const n = pts.length;
  if (n <= 2) return pts.map((_, i) => i);
  const k = metersPerUnit(pts[0].y);
  const vz = tolH / tolV;
  const X = (i: number) => pts[i].x * k;
  const Y = (i: number) => pts[i].y * k;
  const Z = (i: number) => pts[i].h * vz;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  const tol2 = tolH * tolH;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const ax = X(a), ay = Y(a), az = Z(a);
    const dx = X(b) - ax, dy = Y(b) - ay, dz = Z(b) - az;
    const len2 = dx * dx + dy * dy + dz * dz;
    let best = -1;
    let bestD = tol2;
    for (let i = a + 1; i < b; i++) {
      const px = X(i) - ax, py = Y(i) - ay, pz = Z(i) - az;
      const t = len2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / len2)) : 0;
      const ex = px - t * dx, ey = py - t * dy, ez = pz - t * dz;
      const d = ex * ex + ey * ey + ez * ez;
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

const reflect = (a: CPt, b: CPt): CPt => ({ x: 2 * a.x - b.x, y: 2 * a.y - b.y, h: 2 * a.h - b.h, alt: a.alt });

function turnDeg(a: CPt, b: CPt, c: CPt): number {
  const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
  const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
  if (lu === 0 || lv === 0) return 0;
  const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Climb gradient a → b (height m per horizontal m), 0 for a vertical step. */
function slope(a: CPt, b: CPt, k: number): number {
  const d = Math.hypot(b.x - a.x, b.y - a.y) * k;
  return d > 0.5 ? (b.h - a.h) / d : 0;
}

/**
 * Curve points of the segment p1 → p2 (p0, p3 its neighbours): p1 itself plus the spline points
 * inside (p2 excluded – it starts the next segment). A straight, evenly climbing segment adds
 * none; a bent one SUB_BENT; a long one is split every MAX_SEG_M. Height clamped to [h1, h2].
 */
export function segmentPoints(p0: CPt | null, p1: CPt, p2: CPt, p3: CPt | null, out: CPt[]): void {
  out.push(p1);
  const k = metersPerUnit(p1.y);
  const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const lenM = len * k;
  if (lenM < 1e-3) return;
  let q0 = p0 && Math.hypot(p1.x - p0.x, p1.y - p0.y) > 1e-12 ? p0 : reflect(p1, p2);
  let q3 = p3 && Math.hypot(p3.x - p2.x, p3.y - p2.y) > 1e-12 ? p3 : reflect(p2, p1);
  const s12 = slope(p1, p2, k);
  // a segment much longer than a neighbour is a thinned straight next to a curve: the spline
  // would bulge it out (metres) – it stays straight, the curve is drawn by the short neighbours
  const lopsided = (p0 != null && len > LOPSIDED * Math.hypot(p1.x - p0.x, p1.y - p0.y)) || (p3 != null && len > LOPSIDED * Math.hypot(p3.x - p2.x, p3.y - p2.y));
  const bent =
    !lopsided &&
    (turnDeg(q0, p1, p2) > BEND_DEG ||
    turnDeg(p1, p2, q3) > BEND_DEG ||
    (p0 != null && Math.abs(s12 - slope(q0, p1, k)) > BEND_SLOPE) ||
    (p3 != null && Math.abs(slope(p2, q3, k) - s12) > BEND_SLOPE));
  const pieces = Math.max(bent ? SUB_BENT + 1 : 1, Math.ceil(lenM / MAX_SEG_M));
  if (pieces <= 1) return;
  if (!bent) {
    // straight: plain linear split (globe chords only)
    for (let i = 1; i < pieces; i++) {
      const f = i / pieces;
      out.push({ x: p1.x + (p2.x - p1.x) * f, y: p1.y + (p2.y - p1.y) * f, h: p1.h + (p2.h - p1.h) * f, alt: p1.alt + (p2.alt - p1.alt) * f });
    }
    return;
  }
  // centripetal Catmull-Rom (Barry-Goldman), knots from the horizontal distances
  const knot = (a: CPt, b: CPt) => Math.sqrt(Math.max(1e-9, Math.hypot(b.x - a.x, b.y - a.y) * k));
  // a far neighbour (thinned straight) would pull the curve: limit it to 4× this segment
  const near = (from: CPt, to: CPt) => {
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    if (d <= 4 * len) return to;
    const f = (4 * len) / d;
    return { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f, h: from.h + (to.h - from.h) * f, alt: to.alt };
  };
  q0 = near(p1, q0);
  q3 = near(p2, q3);
  const t0 = 0;
  const t1 = t0 + knot(q0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, q3);
  const hLo = Math.min(p1.h, p2.h);
  const hHi = Math.max(p1.h, p2.h);
  const comp = (c0: number, c1: number, c2: number, c3: number, t: number) => {
    const a1 = ((t1 - t) / (t1 - t0)) * c0 + ((t - t0) / (t1 - t0)) * c1;
    const a2 = ((t2 - t) / (t2 - t1)) * c1 + ((t - t1) / (t2 - t1)) * c2;
    const a3 = ((t3 - t) / (t3 - t2)) * c2 + ((t - t2) / (t3 - t2)) * c3;
    const b1 = ((t2 - t) / (t2 - t0)) * a1 + ((t - t0) / (t2 - t0)) * a2;
    const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
    return ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
  };
  for (let i = 1; i < pieces; i++) {
    const f = i / pieces;
    const t = t1 + (t2 - t1) * f;
    out.push({
      x: comp(q0.x, p1.x, p2.x, q3.x, t),
      y: comp(q0.y, p1.y, p2.y, q3.y, t),
      h: Math.max(hLo, Math.min(hHi, comp(q0.h, p1.h, p2.h, q3.h, t))),
      alt: p1.alt + (p2.alt - p1.alt) * f,
    });
  }
}

/** Smooth curve through all of `ctrl` (tests, one-shot use): segmentPoints per pair plus the last point. */
export function curveThrough(ctrl: CPt[]): CPt[] {
  const out: CPt[] = [];
  for (let i = 0; i + 1 < ctrl.length; i++) segmentPoints(ctrl[i - 1] ?? null, ctrl[i], ctrl[i + 1], ctrl[i + 2] ?? null, out);
  if (ctrl.length) out.push(ctrl[ctrl.length - 1]);
  return out;
}

/**
 * Vertices of curve points: two per point (side −1 = ground / left edge of the band,
 * +1 = top / right edge), so one buffer serves as the wall's triangle strip and the band's
 * quad strip. `prev`/`next` are the neighbours outside `pts` (band direction at the ends).
 */
export function writeVertices(pts: CPt[], prev: CPt | null, next: CPt | null, ramp: Array<[number, RGB]>, out: Float32Array, offset: number): number {
  let o = offset;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const pp = i > 0 ? pts[i - 1] : prev;
    const pn = i < pts.length - 1 ? pts[i + 1] : next;
    const hx = Math.fround(p.x);
    const hy = Math.fround(p.y);
    const [r, g, b] = rampColor(p.alt, ramp);
    for (const side of [-1, 1]) {
      out[o++] = hx;
      out[o++] = hy;
      out[o++] = p.x - hx;
      out[o++] = p.y - hy;
      out[o++] = p.h;
      out[o++] = r;
      out[o++] = g;
      out[o++] = b;
      out[o++] = side;
      out[o++] = pp ? pp.x - p.x : 0;
      out[o++] = pp ? pp.y - p.y : 0;
      out[o++] = pp ? pp.h - p.h : 0;
      out[o++] = pn ? pn.x - p.x : 0;
      out[o++] = pn ? pn.y - p.y : 0;
      out[o++] = pn ? pn.h - p.h : 0;
    }
  }
  return o;
}

const same = (a: CPt, b: CPt) => Math.abs(a.x - b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12 && Math.abs(a.h - b.h) < 0.01;

/**
 * Incremental curtain geometry (CPU side). `sync` with the growing point list (and the
 * aircraft's current position as head): new points are thinned per block and their vertices
 * appended to `stable` (never rewritten); `tail` covers the open block up to the head.
 */
export class CurtainGeometry {
  /** Kept (thinned) points of the finished blocks. */
  ctrl: CPt[] = [];
  /** Raw points of the open block; [0] is the last kept point. */
  private pending: CPt[] = [];
  private head: CPt | null = null;
  /** Vertices of the finished segments (floats [0, stableLen)). */
  stable = new Float32Array(0);
  stableLen = 0;
  /** Segments of `ctrl` whose vertices are in `stable`. */
  private stableSegs = 0;
  private lastStable: CPt | null = null;
  /** Vertices of the open part, rewritten on every change. */
  tail = new Float32Array(0);
  /** Bumped on a reset (the GPU copy must be re-uploaded); `version` on every change. */
  generation = 0;
  version = 0;
  /** Douglas-Peucker tolerance factor (doubles when the track exceeds MAX_CONTROL). */
  tolScale = 1;
  /** Bounding box of every point (Mercator), for the tile choice. */
  bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  private consumed = 0;
  private firstRef: TrackPoint | null = null;
  private lastRef: TrackPoint | null = null;
  private lastX: number | undefined;
  private readonly ramp: Array<[number, RGB]>;

  constructor(ramp: ReadonlyArray<readonly [number, string]>) {
    this.ramp = parseRamp(ramp);
  }

  /** Vertex count (stable + tail). */
  get vertexCount(): number {
    return (this.stableLen + this.tail.length) / CURTAIN_FLOATS;
  }

  reset() {
    this.ctrl = [];
    this.pending = [];
    this.head = null;
    this.stableLen = 0;
    this.stableSegs = 0;
    this.lastStable = null;
    this.tail = new Float32Array(0);
    this.bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    this.consumed = 0;
    this.firstRef = this.lastRef = null;
    this.lastX = undefined;
    this.generation++;
    this.version++;
  }

  /**
   * Bring the geometry up to `points` (appended since the last call, or a new list: rebuilt).
   * `head`: the aircraft's position now (null clears it, undefined keeps the last one).
   * Returns whether anything changed.
   */
  sync(points: readonly TrackPoint[], head?: TrackPoint | null): boolean {
    const replaced = points.length < this.consumed || (this.consumed > 0 && (points[0] !== this.firstRef || points[this.consumed - 1] !== this.lastRef));
    let changed = false;
    if (replaced) {
      const scale = this.tolScale;
      this.reset();
      this.tolScale = scale;
      changed = true;
    }
    if (points.length > this.consumed) {
      for (let i = this.consumed; i < points.length; i++) this.append(toCPt(points[i], this.lastX));
      this.consumed = points.length;
      this.firstRef = points[0];
      this.lastRef = points[points.length - 1];
      changed = true;
      if (this.ctrl.length > MAX_CONTROL) {
        // too many kept points even after thinning: coarser, all again
        const scale = this.tolScale * 2;
        this.reset();
        this.tolScale = scale;
        return this.sync(points, head === undefined ? null : head);
      }
    }
    if (head !== undefined) {
      const h = head ? toCPt(head, this.lastX) : null;
      const prev = this.head;
      if (!(h === prev || (h && prev && same(h, prev)))) {
        this.head = h;
        if (h) this.grow(h);
        changed = true;
      }
    }
    if (changed) {
      this.rebuildTail();
      this.version++;
    }
    return changed;
  }

  private grow(p: CPt) {
    const b = this.bbox;
    b.minX = Math.min(b.minX, p.x);
    b.maxX = Math.max(b.maxX, p.x);
    b.minY = Math.min(b.minY, p.y);
    b.maxY = Math.max(b.maxY, p.y);
  }

  private append(p: CPt) {
    const last = this.pending[this.pending.length - 1];
    if (last && same(last, p)) return; // standing still: nothing new to draw
    this.lastX = p.x;
    this.grow(p);
    if (!this.ctrl.length) {
      this.ctrl.push(p);
      this.pending = [p];
      return;
    }
    this.pending.push(p);
    if (this.pending.length > COMMIT_POINTS) {
      const idx = simplifyIndices(this.pending, TOL_H_M * this.tolScale, TOL_V_M * this.tolScale);
      for (let i = 1; i < idx.length; i++) this.ctrl.push(this.pending[idx[i]]);
      this.pending = [this.pending[this.pending.length - 1]];
      this.advanceStable();
    }
  }

  /** Segments whose four spline points are all kept are final: write their vertices once. */
  private advanceStable() {
    const target = Math.max(0, this.ctrl.length - 2);
    if (target <= this.stableSegs) return;
    const c = this.ctrl;
    const pts: CPt[] = [];
    for (let j = this.stableSegs; j < target; j++) segmentPoints(c[j - 1] ?? null, c[j], c[j + 1], c[j + 2], pts);
    const need = this.stableLen + pts.length * 2 * CURTAIN_FLOATS;
    if (need > this.stable.length) {
      const grown = new Float32Array(Math.max(need, this.stable.length * 2, 4096));
      grown.set(this.stable.subarray(0, this.stableLen));
      this.stable = grown;
    }
    this.stableLen = writeVertices(pts, this.lastStable, c[target], this.ramp, this.stable, this.stableLen);
    this.lastStable = pts[pts.length - 1];
    this.stableSegs = target;
  }

  private rebuildTail() {
    const c = this.ctrl;
    if (!c.length) {
      this.tail = new Float32Array(0);
      return;
    }
    const list: CPt[] = c.slice(this.stableSegs);
    for (let i = 1; i < this.pending.length; i++) list.push(this.pending[i]);
    if (this.head && !same(this.head, list[list.length - 1])) list.push(this.head);
    if (list.length < 2 && this.stableSegs === 0) {
      this.tail = new Float32Array(0);
      return;
    }
    const before = this.stableSegs > 0 ? c[this.stableSegs - 1] : null;
    const pts: CPt[] = [];
    for (let i = 0; i + 1 < list.length; i++) segmentPoints(i === 0 ? before : list[i - 1], list[i], list[i + 1], list[i + 2] ?? null, pts);
    pts.push(list[list.length - 1]);
    const out = new Float32Array(pts.length * 2 * CURTAIN_FLOATS);
    writeVertices(pts, this.lastStable, null, this.ramp, out, 0);
    this.tail = out;
  }
}

// ---- GPU ------------------------------------------------------------------------------

const VERT = (prelude: string, define: string) => `#version 300 es
${prelude}
${define}
in vec4 a_pos;      // Mercator hi.xy, lo.xy
in float a_h;       // metres above the map's ground
in vec3 a_color;
in float a_side;    // -1 ground / left, +1 top / right
in vec3 a_prev;     // neighbour − self (Mercator xy, metres)
in vec3 a_next;
uniform vec2 u_ref_hi;
uniform vec2 u_ref_lo;
uniform float u_scale;     // tile units per Mercator unit
uniform float u_mode;      // 0 wall, 1 band
uniform vec2 u_viewport;   // drawing buffer px
uniform float u_half_px;   // half band width, drawing buffer px
uniform vec2 u_alpha;      // wall: bottom, top
out vec3 v_color;
out float v_alpha;
out float v_clip;

vec2 screenOf(vec4 c, vec2 halfVp) { return c.xy / max(c.w, 1e-6) * halfVp; }

void main() {
  vec2 p = ((a_pos.xy - u_ref_hi) + (a_pos.zw - u_ref_lo)) * u_scale;
  v_color = a_color;
  float ele;
  if (u_mode < 0.5) {
    bool top = a_side > 0.0;
    ele = top ? a_h : 0.0;
    v_alpha = top ? u_alpha.y : u_alpha.x;
    gl_Position = projectTileFor3D(p, ele);
  } else {
    ele = a_h;
    v_alpha = 1.0;
    vec4 c = projectTileFor3D(p, ele);
    vec2 halfVp = u_viewport * 0.5;
    vec2 s = screenOf(c, halfVp);
    vec2 d1 = vec2(0.0);
    vec2 d2 = vec2(0.0);
    if (dot(a_prev, a_prev) > 0.0) {
      vec4 cp = projectTileFor3D(p + a_prev.xy * u_scale, ele + a_prev.z);
      if (cp.w > 0.0) d1 = s - screenOf(cp, halfVp);
    }
    if (dot(a_next, a_next) > 0.0) {
      vec4 cn = projectTileFor3D(p + a_next.xy * u_scale, ele + a_next.z);
      if (cn.w > 0.0) d2 = screenOf(cn, halfVp) - s;
    }
    bool h1 = length(d1) > 1e-3;
    bool h2 = length(d2) > 1e-3;
    vec2 t1 = h1 ? normalize(d1) : (h2 ? normalize(d2) : vec2(1.0, 0.0));
    vec2 t2 = h2 ? normalize(d2) : t1;
    vec2 tm = t1 + t2;
    vec2 tan = length(tm) > 1e-3 ? normalize(tm) : t1;
    vec2 n = vec2(-tan.y, tan.x);
    float miter = 1.0 / max(dot(n, vec2(-t1.y, t1.x)), 0.5);
    c.xy += n * a_side * u_half_px * miter / halfVp * c.w;
    gl_Position = c;
  }
#ifdef GLOBE
  // projectTileFor3D keeps the depth: hide what lies behind the globe's horizon ourselves
  v_clip = u_projection_transition > 0.2
    ? dot(projectToSphere(p, p) * (1.0 + ele / GLOBE_RADIUS), u_projection_clipping_plane.xyz) + u_projection_clipping_plane.w
    : 1.0;
#else
  v_clip = 1.0;
#endif
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 v_color;
in float v_alpha;
in float v_clip;
out vec4 fragColor;
void main() {
  if (v_clip < 0.0) discard;
  fragColor = vec4(v_color * v_alpha, v_alpha);
}`;

const UNIFORMS = [
  "u_ref_hi",
  "u_ref_lo",
  "u_scale",
  "u_mode",
  "u_viewport",
  "u_half_px",
  "u_alpha",
  "u_projection_matrix",
  "u_projection_fallback_matrix",
  "u_projection_tile_mercator_coords",
  "u_projection_clipping_plane",
  "u_projection_transition",
] as const;
const ATTRS = [
  ["a_pos", 4, 0],
  ["a_h", 1, 4],
  ["a_color", 3, 5],
  ["a_side", 1, 8],
  ["a_prev", 3, 9],
  ["a_next", 3, 12],
] as const;

interface Program {
  prog: WebGLProgram;
  loc: Record<string, WebGLUniformLocation | null>;
  attr: number[];
}

/** Double → float hi + lo. */
const split = (v: number): [number, number] => {
  const hi = Math.fround(v);
  return [hi, v - hi];
};

/** Largest tile coordinate the globe shader takes for a normal vertex (beyond: pole vertex). */
const TILE_COORD_LIMIT = 30_000;

/**
 * Tile for the projection: around the map centre at the map's zoom, coarser when the track
 * reaches further than TILE_COORD_LIMIT tile units from it. `shift` moves the track by whole
 * worlds to the copy nearest the centre.
 */
export function pickTile(
  centre: { x: number; y: number },
  zoom: number,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
): { x: number; y: number; z: number; wrap: number; refX: number; refY: number; scale: number } {
  const wrap = Math.floor(centre.x);
  const fx = centre.x - wrap;
  const cy = Math.min(1 - 1e-9, Math.max(0, centre.y));
  const shift = Math.round(centre.x - (bbox.minX + bbox.maxX) / 2);
  let z = Math.max(0, Math.min(18, Math.floor(zoom)));
  for (;;) {
    const n = 2 ** z;
    const x = Math.min(n - 1, Math.floor(fx * n));
    const y = Math.min(n - 1, Math.floor(cy * n));
    const refX = wrap + x / n - shift;
    const refY = y / n;
    const reach = Math.max(Math.abs(bbox.minX - refX), Math.abs(bbox.maxX - refX), Math.abs(bbox.minY - refY), Math.abs(bbox.maxY - refY)) * n * EXTENT;
    if (z === 0 || !(reach > TILE_COORD_LIMIT)) return { x, y, z, wrap, refX, refY, scale: n * EXTENT };
    z--;
  }
}

/**
 * The custom layer. `sync` with the track (and the aircraft's position), `setEnabled` with the
 * 3D toggle; `onFail` fires once when WebGL refuses the shaders (caller: extrusion fallback).
 */
export class CurtainLayer implements maplibregl.CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  failed = false;
  onFail?: () => void;
  readonly geo: CurtainGeometry;
  /** CPU time of the last render call (ms) – the GPU work is a few thousand vertices. */
  lastRenderMs = 0;
  private map: maplibregl.Map | null = null;
  private programs = new Map<string, Program>();
  private vbo: WebGLBuffer | null = null;
  private capFloats = 0;
  private gpuStable = 0;
  private gpuGeneration = -1;
  private gpuVersion = -1;
  private enabled = false;

  constructor(id: string, ramp: ReadonlyArray<readonly [number, string]>) {
    this.id = id;
    this.geo = new CurtainGeometry(ramp);
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    this.map?.triggerRepaint();
  }

  /** See CurtainGeometry.sync; repaints when something changed. */
  sync(points: readonly TrackPoint[], head?: TrackPoint | null) {
    if (this.geo.sync(points, head) && this.enabled) this.map?.triggerRepaint();
  }

  onAdd(map: maplibregl.Map) {
    this.map = map;
  }

  onRemove(_map: maplibregl.Map, gl: WebGL2RenderingContext | WebGLRenderingContext) {
    if (this.vbo) gl.deleteBuffer(this.vbo);
    this.vbo = null;
    for (const p of this.programs.values()) gl.deleteProgram(p.prog);
    this.programs.clear();
    this.map = null;
  }

  private program(gl: WebGL2RenderingContext, shader: maplibregl.CustomRenderMethodInput["shaderData"]): Program | null {
    const cached = this.programs.get(shader.variantName);
    if (cached) return cached;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn("curtain shader:", gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT(shader.vertexShaderPrelude, shader.define));
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return null;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("curtain program:", gl.getProgramInfoLog(prog));
      return null;
    }
    const loc: Program["loc"] = {};
    for (const u of UNIFORMS) loc[u] = gl.getUniformLocation(prog, u);
    const p: Program = { prog, loc, attr: ATTRS.map(([name]) => gl.getAttribLocation(prog, name)) };
    this.programs.set(shader.variantName, p);
    return p;
  }

  /** Upload what changed: new stable vertices and the tail; everything after a reset or a grow. */
  private upload(gl: WebGL2RenderingContext) {
    const g = this.geo;
    if (!this.vbo) this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    if (g.generation === this.gpuGeneration && g.version === this.gpuVersion) return;
    const total = g.stableLen + g.tail.length;
    if (total > this.capFloats) {
      // grow by doubling: amortised, a 10 h flight reallocates a handful of times
      this.capFloats = 2 ** Math.ceil(Math.log2(Math.max(total * 1.5, 4096)));
      gl.bufferData(gl.ARRAY_BUFFER, this.capFloats * 4, gl.DYNAMIC_DRAW);
      this.gpuStable = 0;
    }
    if (g.generation !== this.gpuGeneration) {
      this.gpuStable = 0;
      this.gpuGeneration = g.generation;
    }
    if (g.stableLen > this.gpuStable) {
      gl.bufferSubData(gl.ARRAY_BUFFER, this.gpuStable * 4, g.stable.subarray(this.gpuStable, g.stableLen));
      this.gpuStable = g.stableLen;
    }
    if (g.tail.length) gl.bufferSubData(gl.ARRAY_BUFFER, g.stableLen * 4, g.tail);
    this.gpuVersion = g.version;
  }

  render(glAny: WebGL2RenderingContext | WebGLRenderingContext, args: maplibregl.CustomRenderMethodInput) {
    const map = this.map;
    const gl = glAny as WebGL2RenderingContext;
    const count = this.geo.vertexCount;
    if (!map || !this.enabled || this.failed || count < 4) return;
    const t0 = performance.now();
    const p = this.program(gl, args.shaderData);
    if (!p) {
      this.failed = true;
      this.onFail?.();
      return;
    }
    // own state from scratch, nothing assumed from the previous layer: no VAO of MapLibre's, our buffer
    gl.bindVertexArray(null);
    this.upload(gl);

    const c = map.getCenter();
    const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, c.lat));
    const centre = { x: (c.lng + 180) / 360, y: (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360 };
    const tile = pickTile(centre, map.getZoom(), this.geo.bbox);
    const data = args.getProjectionData({ tileID: { canonical: { x: tile.x, y: tile.y, z: tile.z }, wrap: tile.wrap }, applyGlobeMatrix: true });
    const [rxh, rxl] = split(tile.refX);
    const [ryh, ryl] = split(tile.refY);
    const ratio = typeof map.getPixelRatio === "function" ? map.getPixelRatio() : window.devicePixelRatio || 1;

    gl.useProgram(p.prog);
    const L = p.loc;
    gl.uniformMatrix4fv(L.u_projection_matrix, false, data.mainMatrix as Float32Array);
    if (L.u_projection_fallback_matrix) gl.uniformMatrix4fv(L.u_projection_fallback_matrix, false, data.fallbackMatrix as Float32Array);
    if (L.u_projection_tile_mercator_coords) gl.uniform4f(L.u_projection_tile_mercator_coords, ...(data.tileMercatorCoords as [number, number, number, number]));
    if (L.u_projection_clipping_plane) gl.uniform4f(L.u_projection_clipping_plane, ...(data.clippingPlane as [number, number, number, number]));
    if (L.u_projection_transition) gl.uniform1f(L.u_projection_transition, data.projectionTransition);
    gl.uniform2f(L.u_ref_hi, rxh, ryh);
    gl.uniform2f(L.u_ref_lo, rxl, ryl);
    gl.uniform1f(L.u_scale, tile.scale);
    gl.uniform2f(L.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(L.u_half_px, (BAND_PX / 2) * ratio);
    gl.uniform2f(L.u_alpha, WALL_ALPHA[0], WALL_ALPHA[1]);

    const stride = CURTAIN_FLOATS * 4;
    ATTRS.forEach(([, size, offset], i) => {
      const loc = p.attr[i];
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset * 4);
    });

    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.colorMask(true, true, true, true);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    // 1. wall: translucent, writes no depth – overlapping walls (circuits) just add up, no flicker,
    //    and it can neither z-fight with the band nor hide the model
    gl.depthMask(false);
    gl.uniform1f(L.u_mode, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, count);
    // 2. band: opaque, over the wall, with depth so a nearer stretch hides a farther one; pushed
    //    back a little (polygon offset), so the model and plumb line on the edge are never coplanar
    gl.depthMask(true);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 2);
    gl.uniform1f(L.u_mode, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, count);
    // leave clean: no offset, default depth write, premultiplied blending as MapLibre uses it
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(0, 0);
    gl.depthMask(true);
    for (const loc of p.attr) if (loc >= 0) gl.disableVertexAttribArray(loc);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.lastRenderMs = performance.now() - t0;
  }
}
