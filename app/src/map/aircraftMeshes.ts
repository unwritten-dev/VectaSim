// Low-poly meshes of the 3D aircraft models (own aircraft: aircraftModel.ts, traffic:
// trafficModel.ts), one per shape class, generated once on first use.
//
// Model units: length 1 along +y (nose at +0.5), x to the right wing, z up. Every class is built
// from a few closed parts: the fuselage as a loft over elliptical cross-sections (rounded nose,
// tail cone drawn up), wings and tail surfaces as thin lofted profiles (rounded leading edge,
// sharp trailing edge, tips shrunk into a rounded end), nacelles as short 8-segment bodies of
// revolution with an open, darker intake, propeller blades and rotor blades as thin beams, the
// helicopter with a drop-shaped cabin, tail boom and skids. Fuselage, nacelles and surfaces are
// smooth-shaded (per-vertex normals averaged over the part); hard edges remain where parts meet,
// at trailing edges and at caps (duplicated vertices), the thin beams stay flat-shaded.
//
// Vertex layout (VERTEX_FLOATS): position (3), normal (3), contour direction (3, the normal
// averaged over every face at that position, so the inflated contour hull stays closed), tone (1,
// 1 = body colour, lower = darker: intakes, blades). The class follows the 2D symbol's
// classification (aircraftIcons.ts: ICAO designator → title → weight) and refines it by engine
// type; the on-screen size uses the same wake factor as the 2D symbol (WAKE_SIZE).

import { WAKE_SIZE, wakeCategory, type WakeCategory } from "./aircraftIcons";

export type ModelKind = "prop" | "turboprop" | "narrowbody" | "widebody" | "super" | "heli";
export const MODEL_KINDS: ModelKind[] = ["prop", "turboprop", "narrowbody", "widebody", "super", "heli"];

/** Floats per vertex: position (3), normal (3), contour direction (3), tone (1). */
export const VERTEX_FLOATS = 10;
/** Triangle budget per model (traffic draws up to 200 instances). */
export const MESH_TRI_BUDGET = 800;

export type V3 = [number, number, number];

/** Tone of the open intakes and the blades (fraction of the body colour towards the dark shade). */
const TONE_INTAKE = 0.25;
const TONE_BLADE = 0.55;

/** A finished, closed part: oriented triangles (outward winding) over indexed vertices. */
export interface MeshPart {
  name: string;
  pos: V3[];
  tone: number[];
  /** Vertex indices, three per triangle, counter-clockwise seen from outside. */
  tris: number[];
  smooth: boolean;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
};

/** A ring of points, or a single point (pole of a loft). */
type Ring = V3[];

/** Part under construction: a sequence of rings joined by bands, fans and caps. */
class Builder {
  pos: V3[] = [];
  tone: number[] = [];
  tris: number[] = [];
  readonly name: string;
  readonly smooth: boolean;
  constructor(name: string, smooth = true) {
    this.name = name;
    this.smooth = smooth;
  }

  private verts(r: Ring, tone: number): number[] {
    return r.map((p) => {
      this.pos.push(p);
      this.tone.push(tone);
      return this.pos.length - 1;
    });
  }

  /**
   * Loft through `rings` (all rings the same point count; a 1-point ring is a pole). Open ring
   * ends get a flat cap (own vertices: a hard edge). A ring listed twice makes a hard edge.
   */
  loft(rings: Ring[], tones: number | number[] = 1) {
    const idx = rings.map((r, i) => this.verts(r, Array.isArray(tones) ? tones[i] : tones));
    const first = idx[0];
    const last = idx[idx.length - 1];
    if (first.length > 1) this.fanStart(this.verts([centroid(rings[0])], toneAt(tones, 0))[0], this.verts(rings[0], toneAt(tones, 0)));
    for (let i = 0; i + 1 < idx.length; i++) {
      const [a, b] = [idx[i], idx[i + 1]];
      if (a.length === 1) this.fanStart(a[0], b);
      else if (b.length === 1) this.fanEnd(b[0], a);
      else this.band(a, b);
    }
    const n = rings.length - 1;
    if (last.length > 1) this.fanEnd(this.verts([centroid(rings[n])], toneAt(tones, n))[0], this.verts(rings[n], toneAt(tones, n)));
  }

  private band(a: number[], b: number[]) {
    const n = a.length;
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      this.tris.push(a[k], a[k1], b[k1], a[k], b[k1], b[k]);
    }
  }
  private fanStart(p: number, a: number[]) {
    for (let k = 0; k < a.length; k++) this.tris.push(p, a[(k + 1) % a.length], a[k]);
  }
  private fanEnd(p: number, a: number[]) {
    for (let k = 0; k < a.length; k++) this.tris.push(p, a[k], a[(k + 1) % a.length]);
  }

  /** Drops degenerate triangles and turns the winding outward (positive enclosed volume). */
  finish(): MeshPart {
    const P = this.pos;
    const tris: number[] = [];
    let vol = 0;
    for (let i = 0; i < this.tris.length; i += 3) {
      const [a, b, c] = [this.tris[i], this.tris[i + 1], this.tris[i + 2]];
      const cr = cross(sub(P[b], P[a]), sub(P[c], P[a]));
      if (Math.hypot(cr[0], cr[1], cr[2]) < 1e-10) continue;
      tris.push(a, b, c);
      vol += dot(P[a], cross(P[b], P[c]));
    }
    if (vol < 0) for (let i = 0; i < tris.length; i += 3) [tris[i + 1], tris[i + 2]] = [tris[i + 2], tris[i + 1]];
    return { name: this.name, pos: P, tone: this.tone, tris, smooth: this.smooth };
  }
}

const toneAt = (t: number | number[], i: number) => (Array.isArray(t) ? t[i] : t);
const centroid = (r: Ring): V3 => mul(r.reduce(add, [0, 0, 0] as V3), 1 / r.length);

/** Mirrors a part to the left side (x → −x); `finish` fixes the winding. */
function mirrored(p: MeshPart): MeshPart {
  const b = new Builder(p.name + "-l", p.smooth);
  b.pos = p.pos.map(([x, y, z]) => [-x, y, z] as V3);
  b.tone = [...p.tone];
  b.tris = [...p.tris];
  return b.finish();
}

/** Ellipse in the x-z plane at `y`: half width w, half height h, centre (cx, cz). */
function ellipse(y: number, cx: number, cz: number, w: number, h: number, seg: number): Ring {
  if (w < 1e-6 && h < 1e-6) return [[cx, y, cz]];
  // starts at the top so the ring is mirror-symmetric in x for an even segment count
  return Array.from({ length: seg }, (_, i) => {
    const a = Math.PI / 2 + (i / seg) * 2 * Math.PI;
    return [cx + w * Math.cos(a), y, cz + h * Math.sin(a)] as V3;
  });
}

interface FuselageSpec {
  /** Nose tip y. */
  nose: number;
  /** Tail end y. */
  tail: number;
  /** Half width, half height and centre height of the cylindrical part. */
  w: number;
  h: number;
  z: number;
  /** Length of the rounded nose and the tail cone. */
  noseLen: number;
  tailLen: number;
  /** Size of the tail end relative to the cylinder (0..1). */
  tailEnd: number;
  /** Nose centre lowered by this fraction of h (airliner noses sit low). */
  noseDrop?: number;
  /** Segments around. */
  seg?: number;
}

/** Fuselage loft: rounded nose (pole), cylinder, tail cone with its top line kept and the bottom drawn up. */
function fuselage(s: FuselageSpec): MeshPart {
  const seg = s.seg ?? 10;
  const rings: Ring[] = [[[0, s.nose, s.z - (s.noseDrop ?? 0.2) * s.h]]];
  for (const t of [0.1, 0.32, 0.62, 1]) {
    // elliptical nose profile, slightly pointed: radius ~ (1 − (1 − t)²)^0.6
    const f = Math.pow(1 - (1 - t) ** 2, 0.6);
    const drop = (s.noseDrop ?? 0.2) * s.h * (1 - t) ** 2;
    rings.push(ellipse(s.nose - s.noseLen * t, 0, s.z - drop, s.w * f, s.h * f, seg));
  }
  const tailStart = s.tail + s.tailLen;
  rings.push(ellipse(tailStart, 0, s.z, s.w, s.h, seg));
  for (const u of [0.4, 0.75, 1]) {
    const g = 1 - (1 - s.tailEnd) * Math.pow(u, 1.25);
    // top line nearly straight, the bottom sweeps up
    const z = s.z + s.h * (1 - g) * 0.85;
    rings.push(ellipse(tailStart - s.tailLen * u, 0, z, s.w * (0.35 + 0.65 * g) * g ** 0.3, s.h * g, seg));
  }
  const b = new Builder("fuselage");
  b.loft(rings);
  return b.finish();
}

/** Symmetric profile (chord fraction, thickness fraction) from the trailing edge over the top to the leading edge and back; the trailing edge appears twice (hard edge). */
const PROFILE: Array<[number, number]> = [
  [1, 0],
  [0.55, 0.7],
  [0.22, 1],
  [0.05, 0.62],
  [0, 0],
  [0.05, -0.62],
  [0.22, -1],
  [0.55, -0.7],
  [1, 0],
];

interface Station {
  /** Span coordinate (x for horizontal surfaces, z for the fin). */
  s: number;
  /** Leading and trailing edge y. */
  le: number;
  te: number;
  /** Offset across the span plane (z for horizontal surfaces, x for the fin). */
  o: number;
  /** Half thickness. */
  t: number;
}

/**
 * Lifting surface from root to tip: stations interpolated at `at` (span fractions), with the
 * outer stations shrunk (chord, thickness) into a rounded tip.
 */
function surface(name: string, root: Station, tip: Station, vertical: boolean, at: Array<[number, number]>, tone = 1): MeshPart {
  const rings: Ring[] = at.map(([f, k]) => {
    const l = (a: number, b: number) => a + (b - a) * f;
    let le = l(root.le, tip.le);
    let te = l(root.te, tip.te);
    const c = le - te;
    le -= (1 - k) * c * 0.4;
    te += (1 - k) * c * 0.6;
    const s = l(root.s, tip.s);
    const o = l(root.o, tip.o);
    const t = l(root.t, tip.t) * (0.35 + 0.65 * k);
    return PROFILE.map(([u, v]) => {
      const y = le + (te - le) * u;
      const off = o + v * t;
      return (vertical ? [off, y, s] : [s, y, off]) as V3;
    });
  });
  const b = new Builder(name);
  b.loft(rings, tone);
  return b.finish();
}

/** Main wing: root, outer panel, rounded tip. */
const WING_AT: Array<[number, number]> = [
  [0, 1],
  [0.86, 1],
  [0.96, 0.82],
  [1, 0.45],
];
/** Tail surfaces: root, rounded tip. */
const TAIL_AT: Array<[number, number]> = [
  [0, 1],
  [0.84, 1],
  [1, 0.5],
];

/** Body of revolution along y at (x, z): profile [y, radius, tone], radius 0 = pole. */
function revolve(name: string, x: number, z: number, profile: Array<[number, number, number]>, seg = 8, hard: number[] = []): MeshPart {
  const rings: Ring[] = [];
  const tones: number[] = [];
  profile.forEach(([y, r, tone], i) => {
    const ring = ellipse(y, x, z, r, r, seg);
    rings.push(ring);
    tones.push(tone);
    if (hard.includes(i)) {
      rings.push(ring);
      tones.push(tone);
    }
  });
  const b = new Builder(name);
  b.loft(rings, tones);
  return b.finish();
}

/** Jet nacelle from y0 (intake) to y1 (exhaust), radius r: open dark intake, rounded lip, exhaust cone. */
function jetNacelle(x: number, z: number, y0: number, y1: number, r: number): MeshPart {
  const L = y0 - y1;
  const d = TONE_INTAKE;
  return revolve(
    "nacelle",
    x,
    z,
    [
      [y0 - 0.3 * L, 0, d],
      [y0 - 0.3 * L, 0.6 * r, d],
      [y0, 0.8 * r, d],
      [y0, 0.8 * r, 1],
      [y0 - 0.05 * L, 0.97 * r, 1],
      [y0 - 0.55 * L, r, 1],
      [y1, 0.62 * r, 1],
      [y1 - 0.12 * L, 0, 0.6],
    ],
    8,
    [1],
  );
}

/** Turboprop nacelle: spinner at the front, body tapering behind the wing. */
function propNacelle(x: number, z: number, y0: number, y1: number, r: number): MeshPart {
  const L = y0 - y1;
  return revolve("nacelle", x, z, [
    [y0 + 0.1 * L, 0, 1],
    [y0 + 0.03 * L, 0.5 * r, 1],
    [y0 - 0.04 * L, 0.88 * r, 1],
    [y0 - 0.2 * L, r, 1],
    [y0 - 0.7 * L, 0.92 * r, 1],
    [y1, 0.4 * r, 1],
    [y1 - 0.06 * L, 0, 1],
  ]);
}

/** Thin flat-shaded beam from a to b: width w (half, along u), thickness t (half), tapered to `taper` at b. */
function beam(name: string, a: V3, b: V3, u: V3, w: number, t: number, taper = 1, tone = TONE_BLADE): MeshPart {
  const dir = norm(sub(b, a));
  const uu = norm(sub(u, mul(dir, dot(u, dir))));
  const v = norm(cross(dir, uu));
  const ring = (c: V3, k: number): Ring =>
    [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ].map(([i, j]) => add(c, add(mul(uu, i * w * k), mul(v, j * t * k))));
  const bl = new Builder(name, false);
  bl.loft([ring(a, 1), ring(b, taper)], tone);
  return bl.finish();
}

/** Propeller: `n` blades in the x-z plane around (x, y, z), radius r. */
function propeller(x: number, y: number, z: number, r: number, n: number, phaseDeg: number): MeshPart[] {
  return Array.from({ length: n }, (_, i) => {
    const a = ((phaseDeg + (i * 360) / n) * Math.PI) / 180;
    const d: V3 = [Math.cos(a), 0, Math.sin(a)];
    const c: V3 = [x, y, z];
    // blade face along the flight direction: reads as a bar from above, mirror-symmetric
    return beam("blade", add(c, mul(d, r * 0.12)), add(c, mul(d, r)), [0, 1, 0], r * 0.09, r * 0.02, 0.6);
  });
}

/** Builds the parts of one class; right-side parts are mirrored to the left. */
function build(kind: ModelKind): MeshPart[] {
  const parts: MeshPart[] = [];
  const both = (...ps: MeshPart[]) => {
    for (const p of ps) parts.push(p, mirrored(p));
  };
  /** Swept low wing of the airliners. */
  const jetWing = (span: number, root: [number, number], tip: [number, number], z: number, t: number) =>
    surface("wing", { s: 0.03, le: root[0], te: root[1], o: z, t }, { s: span, le: tip[0], te: tip[1], o: z + 0.022, t: t * 0.55 }, false, WING_AT);
  const stab = (rootX: number, root: [number, number], tipX: number, tip: [number, number], z: number, t: number) =>
    surface("stabiliser", { s: rootX, le: root[0], te: root[1], o: z, t }, { s: tipX, le: tip[0], te: tip[1], o: z + 0.006, t: t * 0.7 }, false, TAIL_AT);
  const fin = (root: [number, number, number], tip: [number, number, number], t: number) =>
    surface("fin", { s: root[0], le: root[1], te: root[2], o: 0, t }, { s: tip[0], le: tip[1], te: tip[2], o: 0, t: t * 0.65 }, true, TAIL_AT);

  switch (kind) {
    // single piston, high wing (C172): straight wing on top with struts, small tail, propeller at the nose
    case "prop": {
      parts.push(fuselage({ nose: 0.47, tail: -0.5, w: 0.06, h: 0.07, z: 0.005, noseLen: 0.16, tailLen: 0.5, tailEnd: 0.2, noseDrop: 0.1 }));
      parts.push(revolve("spinner", 0, -0.002, [[0.505, 0, 1], [0.485, 0.02, 1], [0.462, 0.028, 1]]));
      parts.push(...propeller(0, 0.475, -0.002, 0.115, 2, 0));
      both(surface("wing", { s: 0.03, le: 0.2, te: 0.05, o: 0.082, t: 0.009 }, { s: 0.5, le: 0.18, te: 0.06, o: 0.09, t: 0.006 }, false, WING_AT));
      both(beam("strut", [0.05, 0.13, -0.04], [0.24, 0.13, 0.074], [0, 1, 0], 0.008, 0.003, 1, 1));
      both(stab(0.01, [-0.36, -0.47], 0.17, [-0.38, -0.46], 0.03, 0.006));
      parts.push(fin([0.03, -0.3, -0.49], [0.2, -0.42, -0.5], 0.009));
      break;
    }
    // regional turboprop (ATR 72, Dash 8): high straight wing, two nacelles with propellers, T-tail
    case "turboprop": {
      parts.push(fuselage({ nose: 0.5, tail: -0.5, w: 0.048, h: 0.05, z: 0, noseLen: 0.14, tailLen: 0.22, tailEnd: 0.22, noseDrop: 0.25 }));
      both(surface("wing", { s: 0.03, le: 0.06, te: -0.08, o: 0.052, t: 0.009 }, { s: 0.5, le: 0.0, te: -0.06, o: 0.058, t: 0.005 }, false, WING_AT));
      both(propNacelle(0.16, 0.038, 0.13, -0.09, 0.028));
      both(...propeller(0.16, 0.148, 0.038, 0.075, 4, 45));
      parts.push(fin([0.03, -0.28, -0.47], [0.24, -0.42, -0.51], 0.011));
      both(stab(0.0, [-0.42, -0.51], 0.17, [-0.45, -0.5], 0.238, 0.006));
      break;
    }
    // narrow-body twin jet (A320, B738): swept low wing, two pods, conventional tail
    case "narrowbody": {
      parts.push(fuselage({ nose: 0.5, tail: -0.5, w: 0.055, h: 0.055, z: 0, noseLen: 0.16, tailLen: 0.22, tailEnd: 0.18 }));
      both(jetWing(0.5, [0.08, -0.15], [-0.2, -0.29], -0.026, 0.013));
      both(jetNacelle(0.18, -0.056, 0.12, -0.04, 0.026));
      both(stab(0.01, [-0.35, -0.46], 0.2, [-0.45, -0.5], 0.032, 0.007));
      parts.push(fin([0.03, -0.3, -0.47], [0.26, -0.43, -0.52], 0.012));
      break;
    }
    // wide-body twin (A350, B77W): fatter fuselage, longer wing, big pods
    case "widebody": {
      parts.push(fuselage({ nose: 0.5, tail: -0.5, w: 0.07, h: 0.07, z: 0, noseLen: 0.16, tailLen: 0.23, tailEnd: 0.16 }));
      both(jetWing(0.5, [0.1, -0.16], [-0.24, -0.31], -0.032, 0.016));
      both(jetNacelle(0.19, -0.078, 0.15, -0.04, 0.038));
      both(stab(0.01, [-0.34, -0.46], 0.21, [-0.45, -0.5], 0.038, 0.008));
      parts.push(fin([0.04, -0.29, -0.47], [0.27, -0.43, -0.52], 0.014));
      break;
    }
    // A380: very wide wing (span > length), tall double-deck fuselage, four engines
    case "super": {
      parts.push(fuselage({ nose: 0.5, tail: -0.5, w: 0.075, h: 0.09, z: 0.012, noseLen: 0.15, tailLen: 0.24, tailEnd: 0.16, noseDrop: 0.3 }));
      both(jetWing(0.55, [0.12, -0.2], [-0.26, -0.34], -0.042, 0.018));
      both(jetNacelle(0.17, -0.08, 0.13, -0.04, 0.034));
      both(jetNacelle(0.32, -0.068, 0.03, -0.13, 0.03));
      both(stab(0.01, [-0.33, -0.46], 0.23, [-0.45, -0.5], 0.048, 0.008));
      parts.push(fin([0.06, -0.28, -0.47], [0.31, -0.42, -0.52], 0.015));
      break;
    }
    // helicopter: drop-shaped cabin, tail boom with fin and stabiliser, two-blade rotor, skids
    case "heli": {
      const cabin = new Builder("cabin");
      const st: Array<[number, number, number, number]> = [
        // y, half width, half height, centre z
        [0.36, 0, 0, -0.025],
        [0.34, 0.05, 0.045, -0.022],
        [0.3, 0.08, 0.075, -0.015],
        [0.22, 0.1, 0.095, -0.005],
        [0.12, 0.105, 0.1, 0],
        [0.0, 0.09, 0.088, 0.008],
        [-0.08, 0.06, 0.065, 0.02],
        [-0.13, 0.035, 0.04, 0.03],
      ];
      cabin.loft(st.map(([y, w, h, z]) => ellipse(y, 0, z, w, h, 10)));
      parts.push(cabin.finish());
      parts.push(
        revolveAlong("boom", [
          [-0.08, 0.035, 0.035],
          [-0.3, 0.045, 0.024],
          [-0.47, 0.055, 0.015],
        ]),
      );
      parts.push(fin([0.03, -0.43, -0.5], [0.16, -0.46, -0.52], 0.008));
      both(stab(0.0, [-0.36, -0.42], 0.1, [-0.37, -0.42], 0.05, 0.005));
      parts.push(revolveZ("mast", 0, 0.02, [[0.08, 0.014], [0.135, 0.01]]));
      // rotor: two crossed blades (an opaque disc would hide the helicopter)
      parts.push(beam("rotor", [0, -0.45, 0.13], [0, 0.49, 0.13], [1, 0, 0], 0.016, 0.003, 1, 0.8));
      parts.push(beam("rotor", [-0.47, 0.02, 0.132], [0.47, 0.02, 0.132], [0, 1, 0], 0.016, 0.003, 1, 0.8));
      both(revolve("skid", 0.075, -0.096, [[0.245, 0, 1], [0.23, 0.008, 1], [-0.11, 0.008, 1], [-0.12, 0, 1]], 6));
      both(beam("strut", [0.075, 0.13, -0.096], [0.05, 0.13, -0.06], [0, 1, 0], 0.006, 0.004, 1, 0.8));
      both(beam("strut", [0.075, -0.04, -0.096], [0.045, -0.04, -0.055], [0, 1, 0], 0.006, 0.004, 1, 0.8));
      break;
    }
  }
  return parts;
}

/** Tube along y with a raised end: profile [y, centre z, radius], closed by caps. */
function revolveAlong(name: string, profile: Array<[number, number, number]>): MeshPart {
  const b = new Builder(name);
  b.loft(profile.map(([y, z, r]) => ellipse(y, 0, z, r, r, 8)));
  return b.finish();
}

/** Vertical cylinder (mast) at (x, y): profile [z, radius], closed by caps. */
function revolveZ(name: string, x: number, y: number, profile: Array<[number, number]>): MeshPart {
  const b = new Builder(name);
  b.loft(
    profile.map(([z, r]) =>
      Array.from({ length: 6 }, (_, i) => {
        const a = (i / 6) * 2 * Math.PI;
        return [x + r * Math.cos(a), y + r * Math.sin(a), z] as V3;
      }),
    ),
  );
  return b.finish();
}

const partCache = new Map<ModelKind, MeshPart[]>();

/** The closed parts of a class (built once, cached; read-only use). */
export function meshParts(kind: ModelKind): readonly MeshPart[] {
  let p = partCache.get(kind);
  if (!p) {
    p = build(kind);
    partCache.set(kind, p);
  }
  return p;
}

const key = (p: V3) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)},${Math.round(p[2] * 1e5)}`;

/** Interleaved vertex data of one part: smooth or face normals, contour direction per position. */
function emit(part: MeshPart, out: number[]) {
  const { pos, tris } = part;
  const faceN: V3[] = [];
  const vn: V3[] = pos.map(() => [0, 0, 0]);
  const on = new Map<string, V3>();
  for (let i = 0; i < tris.length; i += 3) {
    const [a, b, c] = [pos[tris[i]], pos[tris[i + 1]], pos[tris[i + 2]]];
    // area-weighted face normal
    const n = cross(sub(b, a), sub(c, a));
    faceN.push(norm(n));
    for (let k = 0; k < 3; k++) {
      const v = tris[i + k];
      vn[v] = add(vn[v], n);
      const kk = key(pos[v]);
      on.set(kk, add(on.get(kk) ?? [0, 0, 0], n));
    }
  }
  for (let i = 0; i < tris.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = tris[i + k];
      const p = pos[v];
      const n = part.smooth ? norm(vn[v]) : faceN[i / 3];
      const o = norm(on.get(key(p))!);
      out.push(p[0], p[1], p[2], n[0], n[1], n[2], o[0], o[1], o[2], part.tone[v]);
    }
  }
}

const cache = new Map<ModelKind, Float32Array>();

/** Interleaved [pos(3), normal(3), contour(3), tone(1)] triangles of a class (built once, cached). */
export function meshFor(kind: ModelKind): Float32Array {
  let m = cache.get(kind);
  if (!m) {
    const out: number[] = [];
    for (const p of meshParts(kind)) emit(p, out);
    m = new Float32Array(out);
    cache.set(kind, m);
  }
  return m;
}

/** Triangle count of a class. */
export function triangleCount(kind: ModelKind): number {
  return meshFor(kind).length / (VERTEX_FLOATS * 3);
}

const HELI = /^(R22|R44|R66|EC[0-9]|H160|H60|AS[0-9]|B06|B407|B412|B429|B505|S76|S92|A109|A119|A139|A169|A189|AW|UH|NH90|MI[0-9]|KA[0-9])/;
const TURBOPROP = new Set(["AT43", "AT45", "AT72", "AT75", "AT76", "DH8A", "DH8B", "DH8C", "DH8D", "SF34", "SB20", "F50", "C130", "C30J", "AN24", "AN26", "AN12", "DHC6", "BE20", "B350", "A400", "DC3", "DC6", "C408"]);

/**
 * Model class of an aircraft: helicopters and turboprops by designator / title, then the
 * wake class as in 2D (Light → prop, Medium → narrow-body, Heavy → wide-body, Super → A380).
 */
export function modelKind(icaoType?: string | null, title?: string | null, weightKg?: number | null): ModelKind {
  const code = (icaoType ?? "").trim().toUpperCase();
  const t = (title ?? "").toUpperCase();
  if ((code && HELI.test(code)) || /HELI|ROBINSON|CABRI|H135|H145|H160|EC135|EC145|BELL ?(206|407|412|429|505)|BLACK ?HAWK|UH-?60|AIRBUS H/.test(t)) return "heli";
  if (TURBOPROP.has(code) || (!code && /ATR|DASH ?8|Q400|SAAB 340|FOKKER 50|KING AIR|TWIN OTTER|C-?130|HERCULES/.test(t))) return "turboprop";
  return kindOfWake(wakeCategory(code, title, weightKg));
}

export function kindOfWake(cat: WakeCategory): ModelKind {
  return cat === "light" ? "prop" : cat === "heavy" ? "widebody" : cat === "super" ? "super" : "narrowbody";
}

/** On-screen size factor: the 2D symbol's wake factor, so 2D and 3D agree. */
export function modelSize(cat: WakeCategory): number {
  return WAKE_SIZE[cat];
}
