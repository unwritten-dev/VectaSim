// Chunked, altitude-banded track geometry for the live map (and the logbook map).
//
// The old approach pushed one LineString per second and re-sent the whole collection on
// every sample (36 000 features after 10 h, O(n) per second). Here the track is split into
// blocks of CHUNK_POINTS points: closed blocks go to a "history" source once (diff-added via
// GeoJSONSource.updateData), only the open block is re-sent per sample. Inside a block,
// consecutive segments in the same altitude band are merged into one LineString, so a block
// becomes a handful of features instead of 600 (cruise: one).

import type { TrackPoint } from "./common";

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
 * Altitude-banded runs of `points[from..to]` (inclusive). Each segment's altitude is the mean
 * of its ends, as before; consecutive segments in the same band share one LineString whose
 * `alt` is the band centre. Feature ids are `idBase + run index` (unique per chunk when
 * `idBase` is chunk × CHUNK_POINTS — a block never has more runs than points).
 */
export function bandedRuns(points: TrackPoint[], from = 0, to = points.length - 1, idBase?: number, bandFt = ALT_BAND_FT): GeoJSON.Feature[] {
  const out: GeoJSON.Feature[] = [];
  let coords: number[][] | null = null;
  let curBand = 0;
  const flush = () => {
    if (!coords) return;
    const f: GeoJSON.Feature = {
      type: "Feature",
      properties: { alt: (curBand + 0.5) * bandFt },
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
    if (coords && bd === curBand) {
      coords.push([b.lon, b.lat]);
    } else {
      flush();
      curBand = bd;
      // a new run starts at the previous run's last point: no gap in the line
      coords = [
        [a.lon, a.lat],
        [b.lon, b.lat],
      ];
    }
  }
  flush();
  return out;
}

/** Feet → metres. */
const M_PER_FT = 0.3048;
/** Half-width of the 3D ribbon in metres: its face, not its top, is what the eye sees. */
const CURTAIN_HALF_W_M = 3;

/**
 * 3D "curtain" of the track for a pitched map: one thin polygon per altitude-banded run,
 * extruded from the ground to the run's altitude (`hM`) – the wall – with a solid ribbon of
 * `ribbonM` metres at the top (fill-extrusion base/height, map/common.ts). Each polygon
 * is the run's line offset ±CURTAIN_HALF_W_M along the local normal, so the wall stays thin
 * from above and the 2D line keeps drawing the ground trace.
 */
export function curtainRuns(points: TrackPoint[], bandFt = ALT_BAND_FT): GeoJSON.Feature[] {
  const out: GeoJSON.Feature[] = [];
  let run: TrackPoint[] | null = null;
  let curBand = 0;
  const flush = () => {
    if (!run || run.length < 2) {
      run = null;
      return;
    }
    const altFt = (curBand + 0.5) * bandFt;
    const hM = Math.max(1, altFt * M_PER_FT);
    const left: number[][] = [];
    const right: number[][] = [];
    for (let i = 0; i < run.length; i++) {
      const p = run[i];
      const a = run[Math.max(0, i - 1)];
      const b = run[Math.min(run.length - 1, i + 1)];
      const cosLat = Math.max(0.05, Math.cos((p.lat * Math.PI) / 180));
      // direction in local metres, then its left normal back to degrees
      const dx = (b.lon - a.lon) * cosLat;
      const dy = b.lat - a.lat;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * CURTAIN_HALF_W_M;
      const ny = (dx / len) * CURTAIN_HALF_W_M;
      const dLon = nx / (111_320 * cosLat);
      const dLat = ny / 111_320;
      left.push([p.lon + dLon, p.lat + dLat]);
      right.push([p.lon - dLon, p.lat - dLat]);
    }
    const ring = [...left, ...right.reverse(), left[0]];
    out.push({
      type: "Feature",
      properties: { alt: altFt, hM, ribbonM: Math.max(25, hM * 0.025) },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
    run = null;
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const bd = band((a.altFt + b.altFt) / 2, bandFt);
    if (run && bd === curBand) {
      run.push(b);
    } else {
      flush();
      curBand = bd;
      run = [a, b];
    }
  }
  flush();
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
  }

  /**
   * Replace the content with a seed (the recorder's samples). Points that were appended while
   * the seed request was in flight and are newer than the seed's last sample are kept, so a
   * slow IPC round trip neither loses nor duplicates points.
   */
  seed(seed: TimedPoint[]) {
    const seedLast = seed.length ? seed[seed.length - 1].tMs : -Infinity;
    const tail = this.points.filter((p) => p.tMs > seedLast);
    this.points = [...seed, ...tail];
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
    return bandedRuns(this.points, k * this.chunk, (k + 1) * this.chunk, k * this.chunk);
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
