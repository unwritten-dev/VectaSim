// Remaining distance / ETA to the destination and runway matching for the landing
// notice. Pure (no Tauri calls) so it can be unit-tested, see progress.test.ts.

import { haversineNm } from "../format";

export interface LatLon {
  latitude: number;
  longitude: number;
}

/** Farther than this from every leg of the planned route, we measure great-circle instead. */
export const OFF_ROUTE_NM = 30;
/** Below this ground speed an ETA is meaningless (parked, taxiing). */
export const ETA_MIN_GS_KT = 50;

const dist = (a: LatLon, b: LatLon) => haversineNm(a.latitude, a.longitude, b.latitude, b.longitude);

/**
 * Distance from `p` to the segment a→b in nm, plus the position along it (0 = a, 1 = b).
 * Flat-earth projection around `p`: accurate enough for legs of a few hundred nm.
 */
export function distanceToSegmentNm(p: LatLon, a: LatLon, b: LatLon): { nm: number; t: number } {
  const k = Math.cos((p.latitude * Math.PI) / 180);
  const ax = (a.longitude - p.longitude) * k;
  const ay = a.latitude - p.latitude;
  const bx = (b.longitude - p.longitude) * k;
  const by = b.latitude - p.latitude;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { nm: Math.sqrt(cx * cx + cy * cy) * 60, t };
}

/**
 * Remaining distance to the destination in nm. With a planned route (OFP navlog) it is
 * measured along the route from the nearest leg on; without one, or when the aircraft is
 * far off the route, it is the great-circle distance.
 */
export function remainingNm(pos: LatLon | null | undefined, dest: LatLon | null | undefined, route?: LatLon[] | null): number | null {
  if (!pos || !dest) return null;
  const direct = dist(pos, dest);
  const fixes = (route ?? []).filter((f) => Number.isFinite(f.latitude) && Number.isFinite(f.longitude));
  // make sure the route ends at the destination
  if (fixes.length && dist(fixes[fixes.length - 1], dest) > 1) fixes.push(dest);
  if (fixes.length < 2) return direct;

  let best = -1;
  let bestNm = Infinity;
  for (let i = 0; i < fixes.length - 1; i++) {
    const { nm } = distanceToSegmentNm(pos, fixes[i], fixes[i + 1]);
    // prefer later legs on ties (routes that double back near the airport)
    if (nm <= bestNm) {
      bestNm = nm;
      best = i;
    }
  }
  if (best < 0 || bestNm > OFF_ROUTE_NM) return direct;
  let total = dist(pos, fixes[best + 1]);
  for (let i = best + 1; i < fixes.length - 1; i++) total += dist(fixes[i], fixes[i + 1]);
  return Math.max(total, direct);
}

/** Estimated arrival (epoch ms) from the current ground speed, or null when too slow. */
export function etaMs(nowMs: number, remaining: number | null, gsKt: number | null | undefined): number | null {
  if (remaining == null || gsKt == null || !Number.isFinite(gsKt) || gsKt < ETA_MIN_GS_KT) return null;
  return nowMs + (remaining / gsKt) * 3600_000;
}

// ---- runway of a touchdown -----------------------------------------------------------

export interface RunwayEnds {
  leIdent: string;
  heIdent: string;
  leLatitude?: number | null;
  leLongitude?: number | null;
  heLatitude?: number | null;
  heLongitude?: number | null;
  lengthFt?: number | null;
}

/** Initial true bearing a → b in degrees. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const r = Math.PI / 180;
  const y = Math.sin((b.longitude - a.longitude) * r) * Math.cos(b.latitude * r);
  const x = Math.cos(a.latitude * r) * Math.sin(b.latitude * r) - Math.sin(a.latitude * r) * Math.cos(b.latitude * r) * Math.cos((b.longitude - a.longitude) * r);
  return ((Math.atan2(y, x) / r) % 360 + 360) % 360;
}

const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** Max distance of the touchdown point from the runway centreline. */
export const RUNWAY_LATERAL_NM = 0.1;
/** Max difference between aircraft heading and runway direction. */
export const RUNWAY_HEADING_DEG = 30;

/**
 * The runway end the aircraft landed on ("25C"), from touchdown position and true heading,
 * or null when the point is not on any runway of the list.
 */
export function matchRunway(td: LatLon & { headingTrueDeg: number }, runways: RunwayEnds[]): string | null {
  let best: { ident: string; nm: number } | null = null;
  for (const r of runways) {
    if (r.leLatitude == null || r.leLongitude == null || r.heLatitude == null || r.heLongitude == null) continue;
    const le = { latitude: r.leLatitude, longitude: r.leLongitude };
    const he = { latitude: r.heLatitude, longitude: r.heLongitude };
    const { nm, t } = distanceToSegmentNm(td, le, he);
    if (nm > RUNWAY_LATERAL_NM || t <= 0 || t >= 1) continue;
    const brg = bearingDeg(le, he);
    const ident = angleDiff(td.headingTrueDeg, brg) <= RUNWAY_HEADING_DEG ? r.leIdent : angleDiff(td.headingTrueDeg, brg + 180) <= RUNWAY_HEADING_DEG ? r.heIdent : null;
    if (ident && (!best || nm < best.nm)) best = { ident, nm };
  }
  return best?.ident ?? null;
}
