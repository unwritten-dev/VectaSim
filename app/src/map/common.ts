// Shared MapLibre helpers: basemap style, aircraft icon, track → GeoJSON, airport layers.

import * as maplibregl from "maplibre-gl";
import type { Airport, NavFix, TrackSample } from "../types";
import { DIAGRAM_FROM_ZOOM } from "./airportDiagram";
import { AIRPORT_DOT, COLOR, TRACK_RAMP } from "../theme";
import { loadAircraftIcons } from "./aircraftIcons";
import { lerpHeading, lowerBoundT, sampleAt, trackBearingAt } from "../landing/replayStore";

/** OpenFreeMap: free vector tiles, no API key. OSM attribution is mandatory and left enabled. */
export { BASEMAP_URL as BASEMAP_STYLE } from "./basemap";
/** Globe / Mercator choice shared by every map (map/projection.ts). */
export { applyProjection, loadGlobe, projectionFor, saveGlobe, useGlobe, withProjection } from "./projection";

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

/**
 * Track source(s) plus casing and altitude-coloured line. With several sources (live map:
 * history + open block) all casings go below all lines, so the joint between them is seamless.
 */
export function addTrackLayers(map: maplibregl.Map, sourceIds: string | string[], before?: string) {
  const ids = Array.isArray(sourceIds) ? sourceIds : [sourceIds];
  for (const id of ids) map.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  for (const id of ids)
    map.addLayer(
      {
        id: `${id}-casing`,
        type: "line",
        source: id,
        paint: { "line-color": COLOR.halo, "line-width": 6.5, "line-opacity": 0.85 },
        layout: { "line-cap": "round", "line-join": "round" },
      },
      before,
    );
  for (const id of ids)
    map.addLayer(
      {
        id: `${id}-line`,
        type: "line",
        source: id,
        paint: { "line-color": trackColorExpr(), "line-width": 3.5 },
        layout: { "line-cap": "round", "line-join": "round" },
      },
      before,
    );
}

/** Default camera pitch of the 3D view (degrees). */
export const PITCH_3D = 58;

/**
 * 3D track: a translucent wall from the ground to the flown altitude and a solid ribbon at
 * the top (two fill-extrusion layers over one polygon source, geometry from
 * trackChunks.curtainGeoJson). Hidden until the 3D view is switched on. Inserted below the
 * first symbol layer when `before` is given, so airport and place labels stay readable.
 */
export function addCurtainLayers(map: maplibregl.Map, sourceId: string, before?: string) {
  map.addSource(sourceId, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer(
    {
      id: `${sourceId}-wall`,
      type: "fill-extrusion",
      source: sourceId,
      layout: { visibility: "none" },
      paint: {
        "fill-extrusion-color": trackColorExpr(),
        "fill-extrusion-base": 0,
        "fill-extrusion-height": ["get", "hM"],
        "fill-extrusion-opacity": 0.14,
      },
    },
    before,
  );
  map.addLayer(
    {
      id: `${sourceId}-ribbon`,
      type: "fill-extrusion",
      source: sourceId,
      layout: { visibility: "none" },
      paint: {
        "fill-extrusion-color": trackColorExpr(),
        "fill-extrusion-base": ["-", ["get", "hM"], ["get", "ribbonM"]],
        "fill-extrusion-height": ["get", "hM"],
        "fill-extrusion-opacity": 0.95,
        // flat colour: the ribbon reads as the line at altitude, not as a shaded box
        "fill-extrusion-vertical-gradient": false,
      },
    },
    before,
  );
}

/** Id of the first symbol layer of the current style (labels), to insert 3D layers below it. */
export function firstSymbolLayer(map: maplibregl.Map): string | undefined {
  return map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
}

export function setCurtainVisible(map: maplibregl.Map, sourceId: string, on: boolean) {
  for (const l of [`${sourceId}-wall`, `${sourceId}-ribbon`]) if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", on ? "visible" : "none");
}

/** Tilt the camera for the 3D view or lay it flat again (bearing kept). */
export function setPitched(map: maplibregl.Map, on: boolean, duration = 500) {
  map.easeTo({ pitch: on ? PITCH_3D : 0, duration });
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

/**
 * Position and heading of a recorded track at `tMs` (the shared replay cursor), interpolated
 * between the samples; heading circularly, from the positions when the samples carry none
 * (headingTrueDeg 0 on both sides, e.g. the debrief's rebuilt samples). Null outside the track.
 */
export function trackPoseAt(samples: TrackSample[], tMs: number | null): { lon: number; lat: number; headingDeg: number | null } | null {
  const s = sampleAt(samples, tMs);
  if (!s || tMs == null) return null;
  const i = Math.min(samples.length - 1, Math.max(1, lowerBoundT(samples, tMs)));
  const a = samples[i - 1];
  const b = samples[i];
  let headingDeg: number | null;
  if (a.headingTrueDeg === 0 && b.headingTrueDeg === 0) headingDeg = trackBearingAt(samples, tMs);
  else {
    const span = b.tMs - a.tMs;
    headingDeg = lerpHeading(a.headingTrueDeg, b.headingTrueDeg, span > 0 ? Math.min(1, Math.max(0, (tMs - a.tMs) / span)) : 0);
  }
  return { lon: s.longitude, lat: s.latitude, headingDeg };
}
