// The filed route of a selected online aircraft (TrafficCard "Show route") as map geometry:
// solid legs through the resolved waypoints, dashed great-circle bridges where something in
// between could not be placed, and the waypoints as dots with idents. Resolution happens in the
// backend (traffic_route_resolve, crates/vectasim-route); this module only draws its result.

import type { RouteResolution, RouteSource } from "../types";
import { distanceBearing, greatCircle } from "./trafficInfo";

export interface RouteLeg {
  coords: Array<[number, number]>;
  /** Dashed: a gap bridge or the plain great circle. */
  bridge: boolean;
}

export interface TrafficRouteDraw {
  legs: RouteLeg[];
  fixes: Array<{ lon: number; lat: number; ident: string }>;
}

/** Product names of the navigation sources (not translated); airports and coordinates are not listed. */
export const ROUTE_SOURCE_LABEL: Partial<Record<RouteSource, string>> = { msfs: "MSFS", xplane: "X-Plane", navaids: "OurAirports" };

export function routeSourcesText(sources: RouteSource[]): string {
  return sources
    .map((s) => ROUTE_SOURCE_LABEL[s])
    .filter((s): s is string => !!s)
    .join(", ");
}

/** Points per leg: about one every 50 nm, so long legs follow the great circle. */
function stepsFor(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return Math.max(1, Math.min(64, Math.ceil(distanceBearing(a, b).nm / 50)));
}

/** Longitude of `lon` shifted by whole turns to lie within 180° of `ref`. */
function near(lon: number, ref: number): number {
  let l = lon;
  while (l - ref > 180) l -= 360;
  while (l - ref < -180) l += 360;
  return l;
}

/**
 * Legs and fixes of a resolved route. Longitudes are unwrapped along the route, so a route
 * across the antimeridian stays one line. Null when there are fewer than two points.
 */
export function trafficRouteDraw(res: RouteResolution): TrafficRouteDraw | null {
  const pts = res.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (pts.length < 2) return null;
  // only departure and arrival: today's dashed great circle
  if (res.enroute === 0) {
    const [a, b] = [pts[0], pts[pts.length - 1]];
    return { legs: [{ coords: greatCircle(a, b), bridge: true }], fixes: [] };
  }
  const legs: RouteLeg[] = [];
  const fixes: TrafficRouteDraw["fixes"] = [];
  let prev = { lat: pts[0].lat, lon: pts[0].lon };
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const to = { lat: p.lat, lon: near(p.lon, prev.lon) };
    const coords = greatCircle(prev, to, stepsFor(prev, to));
    const bridge = p.gapBefore;
    const last = legs[legs.length - 1];
    // consecutive solid legs form one line (fewer features, clean joins)
    if (last && !last.bridge && !bridge) last.coords.push(...coords.slice(1));
    else legs.push({ coords, bridge });
    // departure and arrival have their own airport symbols
    if (i < pts.length - 1) fixes.push({ lon: to.lon, lat: to.lat, ident: p.ident });
    prev = to;
  }
  return { legs, fixes };
}

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** Source data of the `traffic-route` layers (online.ts). */
export function trafficRouteGeoJson(draw: TrafficRouteDraw | null): GeoJSON.FeatureCollection {
  if (!draw) return EMPTY;
  const features: GeoJSON.Feature[] = draw.legs
    .filter((l) => l.coords.length >= 2)
    .map((l) => ({ type: "Feature", properties: { kind: l.bridge ? "bridge" : "leg" }, geometry: { type: "LineString", coordinates: l.coords } }));
  for (const f of draw.fixes) features.push({ type: "Feature", properties: { ident: f.ident }, geometry: { type: "Point", coordinates: [f.lon, f.lat] } });
  return { type: "FeatureCollection", features };
}

/** All coordinates of a drawing (camera fit). */
export function trafficRouteCoords(draw: TrafficRouteDraw | null): Array<[number, number]> {
  return draw ? draw.legs.flatMap((l) => l.coords) : [];
}
