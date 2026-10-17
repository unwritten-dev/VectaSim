// Shared MapLibre helpers: basemap style, aircraft icon, track → GeoJSON, airport layers.

import maplibregl from "maplibre-gl";
import type { Airport, NavFix, TrackSample } from "../types";
import { DIAGRAM_FROM_ZOOM } from "./airportDiagram";
import { AIRPORT_DOT, COLOR, TRACK_RAMP } from "../theme";
import { loadAircraftIcons } from "./aircraftIcons";

/** OpenFreeMap: free vector tiles, no API key. OSM attribution is mandatory and left enabled. */
export { BASEMAP_URL as BASEMAP_STYLE } from "./basemap";

export interface TrackPoint {
  lon: number;
  lat: number;
  altFt: number;
}

export function samplesToPoints(samples: TrackSample[]): TrackPoint[] {
  return samples.map((s) => ({ lon: s.longitude, lat: s.latitude, altFt: s.altitudeMslFt }));
}

/**
 * One short LineString per consecutive pair, carrying the altitude, so the line can be
 * coloured by altitude with a plain data-driven `line-color` (no line-gradient/lineMetrics).
 */
export function segmentsGeoJson(points: TrackPoint[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let i = 1; i < points.length; i++) {
    features.push(segmentFeature(points[i - 1], points[i]));
  }
  return { type: "FeatureCollection", features };
}

export function segmentFeature(a: TrackPoint, b: TrackPoint): GeoJSON.Feature {
  return {
    type: "Feature",
    properties: { alt: (a.altFt + b.altFt) / 2 },
    geometry: {
      type: "LineString",
      coordinates: [
        [a.lon, a.lat],
        [b.lon, b.lat],
      ],
    },
  };
}

/** Altitude colour expression (ft MSL) from the active theme's single-hue ramp. */
export function trackColorExpr(): maplibregl.ExpressionSpecification {
  return ["interpolate", ["linear"], ["coalesce", ["get", "alt"], 0], ...TRACK_RAMP.flat()] as unknown as maplibregl.ExpressionSpecification;
}

export function addTrackLayers(map: maplibregl.Map, sourceId: string, before?: string) {
  map.addSource(sourceId, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer(
    {
      id: `${sourceId}-casing`,
      type: "line",
      source: sourceId,
      paint: { "line-color": COLOR.halo, "line-width": 4.5, "line-opacity": 0.7 },
      layout: { "line-cap": "round", "line-join": "round" },
    },
    before,
  );
  map.addLayer(
    {
      id: `${sourceId}-line`,
      type: "line",
      source: sourceId,
      paint: { "line-color": trackColorExpr(), "line-width": 2.5 },
      layout: { "line-cap": "round", "line-join": "round" },
    },
    before,
  );
}

/** Kept for callers that only need "some plane": loads the whole categorised set. */
export function loadPlaneIcon(map: maplibregl.Map): Promise<void> {
  return loadAircraftIcons(map);
}

export function airportsGeoJson(airports: Airport[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: airports.map((a) => ({
      type: "Feature",
      properties: { ident: a.ident, name: a.name, kind: a.kind, iata: a.iata },
      geometry: { type: "Point", coordinates: [a.longitude, a.latitude] },
    })),
  };
}

/** Three layers so each airport class gets its own minzoom (large everywhere, medium ≥7, small ≥9). */
export function addAirportLayers(map: maplibregl.Map, sourceId = "airports") {
  map.addSource(sourceId, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const classes: Array<{ kind: string; minzoom: number; color: string; radius: number; labelFrom: number }> = [
    { kind: "large", minzoom: 3, color: AIRPORT_DOT.large, radius: 4, labelFrom: 5 },
    { kind: "medium", minzoom: 7, color: AIRPORT_DOT.medium, radius: 3, labelFrom: 7.5 },
    { kind: "small", minzoom: 9, color: AIRPORT_DOT.small, radius: 2.5, labelFrom: 9.5 },
    { kind: "seaplane_base", minzoom: 9, color: AIRPORT_DOT.seaplane, radius: 2.5, labelFrom: 10 },
  ];
  for (const c of classes) {
    map.addLayer({
      id: `${sourceId}-${c.kind}-dot`,
      type: "circle",
      source: sourceId,
      minzoom: c.minzoom,
      maxzoom: DIAGRAM_FROM_ZOOM, // the airport diagram takes over from here
      filter: ["==", ["get", "kind"], c.kind],
      paint: { "circle-radius": c.radius, "circle-color": c.color, "circle-stroke-color": COLOR.halo, "circle-stroke-width": 1 },
    });
    map.addLayer({
      id: `${sourceId}-${c.kind}-label`,
      type: "symbol",
      source: sourceId,
      minzoom: c.labelFrom,
      maxzoom: DIAGRAM_FROM_ZOOM,
      filter: ["==", ["get", "kind"], c.kind],
      layout: {
        "text-field": ["get", "ident"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 11,
        "text-offset": [0, 0.9],
        "text-anchor": "top",
        "text-allow-overlap": false,
      },
      paint: { "text-color": c.color, "text-halo-color": COLOR.halo, "text-halo-width": 1.2 },
    });
  }
}

export function pointFeature(lon: number, lat: number, props: Record<string, unknown> = {}): GeoJSON.Feature {
  return { type: "Feature", properties: props, geometry: { type: "Point", coordinates: [lon, lat] } };
}

/** Planned route from the OFP navlog: a dashed line plus fix points with labels. */
export function addRouteLayers(map: maplibregl.Map, sourceId = "route") {
  map.addSource(sourceId, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: `${sourceId}-line`,
    type: "line",
    source: sourceId,
    filter: ["==", ["geometry-type"], "LineString"],
    paint: { "line-color": COLOR.route, "line-width": 2, "line-dasharray": [2, 2], "line-opacity": 0.9 },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  map.addLayer({
    id: `${sourceId}-fix`,
    type: "circle",
    source: sourceId,
    filter: ["==", ["geometry-type"], "Point"],
    minzoom: 5,
    paint: { "circle-radius": 3, "circle-color": COLOR.route, "circle-stroke-color": COLOR.halo, "circle-stroke-width": 1 },
  });
  map.addLayer({
    id: `${sourceId}-label`,
    type: "symbol",
    source: sourceId,
    filter: ["==", ["geometry-type"], "Point"],
    minzoom: 7,
    layout: {
      "text-field": ["get", "ident"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 10,
      "text-offset": [0, -0.9],
      "text-anchor": "bottom",
    },
    paint: { "text-color": COLOR.route, "text-halo-color": COLOR.halo, "text-halo-width": 1.2 },
  });
}

export function routeGeoJson(fixes: NavFix[]): GeoJSON.FeatureCollection {
  const pts = fixes.filter((f) => Number.isFinite(f.latitude) && Number.isFinite(f.longitude) && (f.latitude !== 0 || f.longitude !== 0));
  const features: GeoJSON.Feature[] = pts.map((f) => pointFeature(f.longitude, f.latitude, { ident: f.ident, alt: f.altitudeFt }));
  if (pts.length >= 2) {
    features.push({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: pts.map((f) => [f.longitude, f.latitude]) },
    });
  }
  return { type: "FeatureCollection", features };
}
