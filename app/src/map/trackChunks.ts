// Chunked, altitude-banded track geometry for the live map (and the logbook map).
//
// The old approach pushed one LineString per second and re-sent the whole collection on
// every sample (36 000 features after 10 h, O(n) per second). Here the track is split into
// blocks of CHUNK_POINTS points: closed blocks go to a "history" source once (diff-added via
// GeoJSONSource.updateData), only the open block is re-sent per sample. Inside a block,
// consecutive segments in the same altitude band are merged into one LineString, so a block
// becomes a handful of features instead of 600 (cruise: one).

import type { TrackPoint } from "./common";
import { unwrapLon } from "./geo";
import { distanceBearing } from "./trafficInfo";

/** Position jump allowance, as the recorder's teleport rule (vectasim-core flight.rs): GS·Δt·rate·3 + 1 nm. */
export const TELEPORT_GS_FACTOR = 3;
export const TELEPORT_MARGIN_NM = 1;

/**
 * True when `next` is further from `prev` than the aircraft could have flown in between
 * (a flight loaded elsewhere, a slew, a teleport): the live track must not draw a line
 * across. Time acceleration widens the allowance; NaN never counts as a jump.
 */
export function positionJumped(prev: { lon: number; lat: number; tMs: number }, next: { lon: number; lat: number; tMs: number }, gsKt: number, simRate = 1): boolean {
  const dtS = Math.max(0.05, (next.tMs - prev.tMs) / 1000);
  const gs = Math.max(0, Number.isFinite(gsKt) ? gsKt : 0);
  const rate = Math.max(1, Number.isFinite(simRate) ? simRate : 1);
  const allowed = (gs * dtS * rate) / 3600 * TELEPORT_GS_FACTOR + TELEPORT_MARGIN_NM;
  return distanceBearing(prev, next).nm > allowed;
}

/** Upper bound of the time acceleration a seed pair may imply (MSFS goes up to 128×). */
const SEED_MAX_RATE = 128;

/**
 * Index of the first seed sample after the last position jump (0: none). The recorder's samples
 * carry no sim rate, so each pair is judged with the rate its neighbouring pairs imply (distance
 * over GS·Δt): steady time acceleration widens the allowance on both sides of a pair, while a
 * one-off teleport stands out against normal neighbours.
 */
export function seedStartAfterJump(seed: ReadonlyArray<{ lon: number; lat: number; tMs: number; gsKt: number }>): number {
  const implied = (i: number): number => {
    // pair (i-1, i)
    if (i < 1 || i >= seed.length) return 1;
    const a = seed[i - 1];
    const b = seed[i];
    const gs = Math.max(a.gsKt, b.gsKt);
    const dtS = (b.tMs - a.tMs) / 1000;
    if (!(gs > 30) || !(dtS > 0)) return 1;
    const r = distanceBearing(a, b).nm / ((gs * dtS) / 3600);
    return Number.isFinite(r) ? Math.min(SEED_MAX_RATE, Math.max(1, r)) : 1;
  };
  for (let i = seed.length - 1; i >= 1; i--) {
    const a = seed[i - 1];
    const b = seed[i];
    const rate = Math.max(implied(i - 1), implied(i + 1));
    if (positionJumped(a, b, Math.max(a.gsKt, b.gsKt), rate)) return i;
  }
  return 0;
}

/** 600 points = 10 min at 1 Hz. */
export const CHUNK_POINTS = 600;
/** Altitude band for merging; finer than any visible step of the colour ramp. */
export const ALT_BAND_FT = 200;

export interface TimedPoint extends TrackPoint {
  tMs: number;
}

function band(altFt: number, bandFt: number): number {
  return Math.floor((Number.isFinite(altFt) ? altFt : 0) / bandFt);
}

/**
 * Where the segment a → b crosses the antimeridian: null when it does not (|Δlon| ≤ 180), else
 * the latitude at the crossing and the side `a` is on (+180 or -180).
 */
export function antimeridianCrossing(a: { lon: number; lat: number }, b: { lon: number; lat: number }): { lat: number; side: 180 | -180 } | null {
  if (!(Math.abs(b.lon - a.lon) > 180)) return null;
  const side = a.lon > 0 ? 180 : -180;
  // b on the same side's continuation (e.g. -179.9 → 180.1 when a is on +180)
  const bx = b.lon + (side === 180 ? 360 : -360);
  const t = bx === a.lon ? 0 : (side - a.lon) / (bx - a.lon);
  return { lat: a.lat + (b.lat - a.lat) * Math.min(1, Math.max(0, t)), side };
}

/**
 * Altitude-banded runs of `points[from..to]` (inclusive). Each segment's altitude is the mean
 * of its ends, as before; consecutive segments in the same band share one LineString whose
 * `alt` is the band centre. A segment across the antimeridian (Pacific flights) splits its run at
 * ±180 – one LineString ends on one side, the next starts on the other – instead of drawing a
 * line around the whole world. Feature ids are `idBase + run index` (unique per chunk when
 * `idBase` is chunk × 2 × CHUNK_POINTS — a block never has more runs than points plus crossings).
 */
export function bandedRuns(points: TrackPoint[], from = 0, to = points.length - 1, idBase?: number, bandFt = ALT_BAND_FT): GeoJSON.Feature[] {
  const out: GeoJSON.Feature[] = [];
  let coords: number[][] | null = null;
  let curBand = 0;
  let curColor: string | undefined;
  const flush = () => {
    if (!coords) return;
    const f: GeoJSON.Feature = {
      type: "Feature",
      properties: { alt: (curBand + 0.5) * bandFt, ...(curColor ? { color: curColor } : {}) },
      geometry: { type: "LineString", coordinates: coords },
    };
    if (idBase !== undefined) f.id = idBase + out.length;
    out.push(f);
    coords = null;
  };
  for (let i = Math.max(1, from + 1); i <= to && i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const bd = band((a.altFt + b.altFt) / 2, bandFt);
    // a fixed colour (gear down for landing) starts with the segment that leaves the tinted point
    const color = a.color;
    if (!coords || bd !== curBand || color !== curColor) {
      flush();
      curBand = bd;
      curColor = color;
      // a new run starts at the previous run's last point: no gap in the line
      coords = [[a.lon, a.lat]];
    }
    const x = antimeridianCrossing(a, b);
    if (x) {
      coords.push([x.side, x.lat]);
      flush();
      coords = [[-x.side, x.lat]];
    }
    coords.push([b.lon, b.lat]);
  }
  flush();
  return out;
}

/** Feet → metres. */
const M_PER_FT = 0.3048;

/**
 * Height in metres at which the 3D view draws a height above ground (ft): the curtain's top and
 * the own aircraft share this one scale (no exaggeration), so the aircraft sits on the curtain.
 */
export function altToCurtainM(heightFt: number): number {
  return Math.max(1, (Number.isFinite(heightFt) ? heightFt : 0) * M_PER_FT);
}

/** Below this AGL the 3D height is the sim's AGL; above AGL_BLEND_HI_FT it is MSL − reference. */
export const AGL_BLEND_LO_FT = 1500;
export const AGL_BLEND_HI_FT = 3000;

/**
 * Height above the map's ground (ft) for the 3D view. The map has no terrain, so drawing MSL
 * made a parked aircraft at EDDF (364 ft) float 111 m above the runway. Rules:
 * on the ground → 0; low (AGL ≤ 1500 ft) → the sim's AGL, so take-off and landing meet the
 * ground at every field elevation; high (AGL ≥ 3000 ft) → MSL − `refFt` (a field elevation),
 * so the cruise curtain stays level instead of copying the terrain below; linear in between.
 */
export function groundHeightFt(altFt: number, aglFt: number | undefined, onGround: boolean | undefined, refFt: number): number {
  if (onGround) return 0;
  const msl = Number.isFinite(altFt) ? altFt : 0;
  const fromRef = msl - (Number.isFinite(refFt) ? refFt : 0);
  if (aglFt == null || !Number.isFinite(aglFt)) return Math.max(0, fromRef);
  const w = Math.min(1, Math.max(0, (aglFt - AGL_BLEND_LO_FT) / (AGL_BLEND_HI_FT - AGL_BLEND_LO_FT)));
  return Math.max(0, aglFt + (fromRef - aglFt) * w);
}

/** Ground elevation under a sample (MSL − AGL), NaN when unknown. */
export function terrainFt(p: { altFt: number; aglFt?: number }): number {
  return p.aglFt != null && Number.isFinite(p.aglFt) && Number.isFinite(p.altFt) ? p.altFt - p.aglFt : NaN;
}

/**
 * Fills `hFt` of every point (groundHeightFt). The reference elevation runs linearly from the
 * departure (ground under the first sample) to the arrival (under the last); `live` keeps the
 * departure elevation, as the arrival is not known yet. Points without AGL keep MSL − reference.
 */
export function withGroundHeights<T extends TrackPoint>(points: T[], live = false): Array<T & { hFt: number }> {
  if (!points.length) return [];
  const first = points.find((p) => Number.isFinite(terrainFt(p)));
  const last = [...points].reverse().find((p) => Number.isFinite(terrainFt(p)));
  const start = first ? terrainFt(first) : 0;
  const end = live || !last ? start : terrainFt(last);
  const n = points.length;
  return points.map((p, i) => ({ ...p, hFt: groundHeightFt(p.altFt, p.aglFt, p.onGround, n > 1 ? start + ((end - start) * i) / (n - 1) : start) }));
}

/** 3D height of a point: hFt when set, else the altitude. */
const heightOf = (p: TrackPoint) => (p.hFt != null && Number.isFinite(p.hFt) ? p.hFt : Number.isFinite(p.altFt) ? p.altFt : 0);
/** Half-width of the 3D ribbon in metres: its face, not its top, is what the eye sees. */
const CURTAIN_HALF_W_M = 3;

/**
 * Fallback 3D "curtain" (map/curtainLayer.ts draws the smooth one; this pair of fill-extrusion
 * layers only when its shaders fail): one thin rectangle per consecutive pair of
 * points, extruded from the ground to the pair's mean altitude (`hM`) – the wall – with a
 * solid ribbon of `ribbonM` metres at the top (fill-extrusion base/height, map/common.ts).
 * Per pair, not per altitude band: fill-extrusion has one height per feature, so a band
 * would step at its edges; neighbouring rectangles share their end points, the height
 * changes by one sample's climb only, and each polygon is convex (no self-intersections).
 */
export function curtainRuns(points: TrackPoint[]): GeoJSON.Feature[] {
  const out: GeoJSON.Feature[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    // across the antimeridian: b on a's side (lon beyond ±180), a 6 m wide rectangle, not one around the world
    const b = { ...points[i], lon: unwrapLon(points[i].lon, a.lon) };
    const altA = Number.isFinite(a.altFt) ? a.altFt : 0;
    const altB = Number.isFinite(b.altFt) ? b.altFt : 0;
    // colour by altitude MSL (as the 2D line), height above the map's ground (withGroundHeights)
    const altFt = (altA + altB) / 2;
    const hM = altToCurtainM((heightOf(a) + heightOf(b)) / 2);
    const cosLat = Math.max(0.05, Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)));
    // segment direction in local metres, then its left normal back to degrees
    const dx = (b.lon - a.lon) * cosLat;
    const dy = b.lat - a.lat;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const dLon = ((-dy / len) * CURTAIN_HALF_W_M) / (111_320 * cosLat);
    const dLat = ((dx / len) * CURTAIN_HALF_W_M) / 111_320;
    const ring = [
      [a.lon + dLon, a.lat + dLat],
      [b.lon + dLon, b.lat + dLat],
      [b.lon - dLon, b.lat - dLat],
      [a.lon - dLon, a.lat - dLat],
      [a.lon + dLon, a.lat + dLat],
    ];
    out.push({
      type: "Feature",
      // a fixed colour (gear down) from the tinted point on, as bandedRuns (trackColorExpr)
      properties: { alt: altFt, hM, ribbonM: Math.max(15, hM * 0.02), ...(a.color ? { color: a.color } : {}) },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  }
  return out;
}

/** Whole track as a curtain, thinned to `maxPoints` so a long flight stays a few thousand vertices. */
export function curtainGeoJson(points: TrackPoint[], maxPoints = 4000): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: curtainRuns(thinPoints(points, maxPoints)) };
}

/** Whole track as banded runs (logbook map). */
export function bandedTrackGeoJson(points: TrackPoint[]): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: bandedRuns(points) };
}

/**
 * Even thinning for a quick first draw: at most `max` points, first and last kept.
 * Not shape-preserving like Douglas-Peucker, but O(n) and good enough for a placeholder.
 */
export function thinPoints<T>(points: T[], max: number): T[] {
  if (points.length <= max || max < 2) return points;
  const step = (points.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/**
 * Live track state. Points are appended at ~1 Hz; every CHUNK_POINTS points the open block
 * is closed. Chunk k covers points [k·C, (k+1)·C] (the boundary point is shared).
 */
export class ChunkedTrack {
  points: TimedPoint[] = [];
  /** Number of closed chunks. */
  closed = 0;
  /** Departure field elevation (ground under the first point with AGL), reference for hFt. */
  groundRefFt = NaN;
  private readonly chunk: number;

  constructor(chunk = CHUNK_POINTS) {
    this.chunk = chunk;
  }

  get lastMs(): number {
    return this.points.length ? this.points[this.points.length - 1].tMs : 0;
  }

  reset() {
    this.points = [];
    this.closed = 0;
    this.groundRefFt = NaN;
  }

  /**
   * 3D height of a live point (groundHeightFt against the departure elevation); the first
   * point with AGL fixes that elevation.
   */
  heightFor(p: { altFt: number; aglFt?: number; onGround?: boolean }): number {
    if (!Number.isFinite(this.groundRefFt) && Number.isFinite(terrainFt(p))) this.groundRefFt = terrainFt(p);
    return groundHeightFt(p.altFt, p.aglFt, p.onGround, Number.isFinite(this.groundRefFt) ? this.groundRefFt : 0);
  }

  /**
   * Replace the content with a seed (the recorder's samples). Points that were appended while
   * the seed request was in flight and are newer than the seed's last sample are kept, so a
   * slow IPC round trip neither loses nor duplicates points.
   */
  seed(seed: TimedPoint[]) {
    const seedLast = seed.length ? seed[seed.length - 1].tMs : -Infinity;
    const tail = this.points.filter((p) => p.tMs > seedLast);
    // heights against the seed's departure elevation (the live points used the same rule)
    const first = seed.find((p) => Number.isFinite(terrainFt(p)));
    if (first) this.groundRefFt = terrainFt(first);
    this.points = [...withGroundHeights(seed, true), ...tail];
    this.closed = Math.max(0, Math.floor((this.points.length - 1) / this.chunk));
  }

  /**
   * Append one point. Returns the features of a chunk that this point closed (to be added to
   * the history source), or null.
   */
  push(p: TimedPoint): GeoJSON.Feature[] | null {
    this.points.push(p);
    const end = (this.closed + 1) * this.chunk;
    if (this.points.length - 1 >= end) {
      const feats = this.chunkFeatures(this.closed);
      this.closed++;
      return feats;
    }
    return null;
  }

  chunkFeatures(k: number): GeoJSON.Feature[] {
    // ids leave room for the extra runs of antimeridian splits (bandedRuns)
    return bandedRuns(this.points, k * this.chunk, (k + 1) * this.chunk, 2 * k * this.chunk);
  }

  /** All closed chunks (seed / theme change / remount). */
  historyGeoJson(): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];
    for (let k = 0; k < this.closed; k++) features.push(...this.chunkFeatures(k));
    return { type: "FeatureCollection", features };
  }

  /** The open block (≤ CHUNK_POINTS points), re-sent on every sample. */
  liveGeoJson(): GeoJSON.FeatureCollection {
    return { type: "FeatureCollection", features: bandedRuns(this.points, this.closed * this.chunk) };
  }
}
