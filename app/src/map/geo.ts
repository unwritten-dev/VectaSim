// Longitude helpers for the antimeridian: the backend's bbox queries take [-180, 180] boxes
// (min > max = across ±180), MapLibre draws and fits unwrapped longitudes (> 180 or < -180) fine.

/** Longitude into [-180, 180). */
export function wrapLon(lon: number): number {
  // in range: unchanged (the modulo round trip would add float noise)
  if (lon >= -180 && lon < 180) return lon;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** `lon` shifted by whole turns to lie within 180° of `ref` (continuous line across ±180). */
export function unwrapLon(lon: number, ref: number): number {
  return lon + 360 * Math.round((ref - lon) / 360);
}

/** An unwrapped box (west may be < -180, east > 180), as MapLibre's getBounds returns it. */
export interface LonLatBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Query box for the backend: longitudes wrapped into [-180, 180] (min > max across the antimeridian), the whole world when wider than a turn. */
export function queryBox(b: LonLatBox): { minLon: number; minLat: number; maxLon: number; maxLat: number } {
  const all = b.east - b.west >= 360;
  return {
    minLon: all ? -180 : wrapLon(b.west),
    minLat: Math.max(-90, b.south),
    maxLon: all ? 180 : wrapLon(b.east),
    maxLat: Math.min(90, b.north),
  };
}

/** The part of maplibregl.LngLatBounds queryBox needs. */
interface BoundsLike {
  getWest(): number;
  getEast(): number;
  getSouth(): number;
  getNorth(): number;
}

/** Viewport (map.getBounds()) as a backend query box. */
export function viewBbox(map: { getBounds(): BoundsLike }) {
  const b = map.getBounds();
  return queryBox({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() });
}

/**
 * [lon, lat] points with every longitude unwrapped against its predecessor: a track across ±180
 * stays one continuous sequence (e.g. 179.9 → 180.1 instead of → -179.9).
 */
export function unwrapPath(coords: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let prev: number | null = null;
  for (const [lon, lat] of coords) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const x: number = prev == null ? lon : unwrapLon(lon, prev);
    prev = x;
    out.push([x, lat]);
  }
  return out;
}

/**
 * Smallest longitude interval holding every given longitude (any order): [west, east] with
 * east − west ≤ 360, east possibly > 180 when the interval crosses the antimeridian. Null for none.
 */
export function lonExtent(lons: readonly number[]): [number, number] | null {
  const xs = lons.filter(Number.isFinite).map(wrapLon).sort((a, b) => a - b);
  if (!xs.length) return null;
  // the widest gap between neighbours (including the one across ±180) is what the interval leaves out
  let gap = xs[0] + 360 - xs[xs.length - 1];
  let start = 0;
  for (let i = 1; i < xs.length; i++) {
    const g = xs[i] - xs[i - 1];
    if (g > gap) {
      gap = g;
      start = i;
    }
  }
  if (start === 0) return [xs[0], xs[xs.length - 1]];
  return [xs[start], xs[start - 1] + 360];
}

/**
 * Bounding box of [lon, lat] points for fitBounds: the shortest longitude interval (across the
 * antimeridian when that is shorter), as [[west, south], [east, north]]. Null for no points.
 */
export function pointsBounds(coords: ReadonlyArray<readonly [number, number]>): [[number, number], [number, number]] | null {
  const pts = coords.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const ext = lonExtent(pts.map((c) => c[0]));
  if (!ext) return null;
  let south = Infinity;
  let north = -Infinity;
  for (const c of pts) {
    south = Math.min(south, c[1]);
    north = Math.max(north, c[1]);
  }
  return [
    [ext[0], south],
    [ext[1], north],
  ];
}
