import { describe, expect, it } from "vitest";
import type { RoutePoint, RouteResolution } from "../types";
import { routeSourcesText, trafficRouteCoords, trafficRouteDraw, trafficRouteGeoJson } from "./trafficRoute";

const pt = (ident: string, lat: number, lon: number, extra: Partial<RoutePoint> = {}): RoutePoint => ({
  ident,
  lat,
  lon,
  source: "xplane",
  resolved: true,
  gapBefore: false,
  ...extra,
});

const res = (points: RoutePoint[], enroute = points.length - 2): RouteResolution => ({
  points,
  unresolved: [],
  total: points.length,
  resolvedCount: points.length,
  enroute,
  airwaysExpanded: 0,
  sources: ["xplane", "airport"],
});

describe("trafficRouteDraw", () => {
  it("draws solid legs through the waypoints and a dashed bridge over a gap", () => {
    const d = trafficRouteDraw(
      res([pt("EDDF", 50.03, 8.57, { source: "airport" }), pt("ANEKI", 49.72, 8.47), pt("DIBIR", 49.2, 9.9), pt("NATOR", 48.6, 11.0, { gapBefore: true }), pt("EDDM", 48.35, 11.79, { source: "airport" })]),
    )!;
    expect(d.legs.map((l) => l.bridge)).toEqual([false, true, false]);
    // the first two solid legs are one line: EDDF → ANEKI → DIBIR
    expect(d.legs[0].coords[0]).toEqual([8.57, 50.03]);
    const end = d.legs[0].coords[d.legs[0].coords.length - 1];
    expect(end[0]).toBeCloseTo(9.9, 9);
    expect(end[1]).toBeCloseTo(49.2, 9);
    expect(d.fixes.map((f) => f.ident)).toEqual(["ANEKI", "DIBIR", "NATOR"]);
    const gj = trafficRouteGeoJson(d);
    expect(gj.features.filter((f) => f.geometry.type === "LineString").map((f) => f.properties?.kind)).toEqual(["leg", "bridge", "leg"]);
    expect(gj.features.filter((f) => f.geometry.type === "Point")).toHaveLength(3);
  });

  it("falls back to the dashed great circle when only the airports resolved", () => {
    const d = trafficRouteDraw(res([pt("EDDF", 50.03, 8.57), pt("KJFK", 40.64, -73.78)], 0))!;
    expect(d.legs).toHaveLength(1);
    expect(d.legs[0].bridge).toBe(true);
    expect(d.legs[0].coords.length).toBeGreaterThan(30);
    expect(d.fixes).toEqual([]);
    expect(trafficRouteDraw(res([pt("EDDF", 50, 8)], 0))).toBeNull();
    expect(trafficRouteGeoJson(null).features).toEqual([]);
  });

  it("keeps a route across the antimeridian in one piece", () => {
    const d = trafficRouteDraw(res([pt("RJAA", 35.76, 140.39), pt("CORDS", 45, 175), pt("CRDS2", 50, -170), pt("KSEA", 47.45, -122.31)]))!;
    const lons = trafficRouteCoords(d).map((c) => c[0]);
    for (let i = 1; i < lons.length; i++) expect(Math.abs(lons[i] - lons[i - 1])).toBeLessThan(20);
    expect(lons[lons.length - 1]).toBeCloseTo(-122.31 + 360, 5);
  });

  it("names the navigation sources, not airports or coordinates", () => {
    expect(routeSourcesText(["msfs", "xplane", "airport", "coord"])).toBe("MSFS, X-Plane");
    expect(routeSourcesText(["navaids"])).toBe("OurAirports");
    expect(routeSourcesText(["airport"])).toBe("");
  });
});
