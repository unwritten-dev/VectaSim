// Shared MapLibre helpers: basemap style, aircraft icon, track → GeoJSON, airport layers.

import * as maplibregl from "maplibre-gl";
import type { Airport, NavFix, TrackSample } from "../types";
import { DIAGRAM_FROM_ZOOM } from "./airportDiagram";
import { AIRPORT_DOT, COLOR, TRACK_RAMP } from "../theme";
import { loadAircraftIcons } from "./aircraftIcons";
import { curtainGeoJson, withGroundHeights } from "./trackChunks";
import { CurtainLayer } from "./curtainLayer";
import { addLayerOnce, addSourceOnce, replaceCustomLayer } from "./styleOnce";
import { lerpHeading, lowerBoundT, sampleAt, trackBearingAt } from "../landing/replayStore";

/** OpenFreeMap: free vector tiles, no API key. OSM attribution is mandatory and left enabled. */
export { BASEMAP_URL as BASEMAP_STYLE } from "./basemap";
/** Globe / Mercator choice shared by every map (map/projection.ts). */
export { applyProjection, loadGlobe, projectionFor, saveGlobe, useGlobe, withProjection } from "./projection";

export interface TrackPoint {
  lon: number;
  lat: number;
  /** Altitude MSL: colours the track. */
  altFt: number;
  /**
   * Height above the map's ground for the 3D view (the map has no terrain, its ground is 0 m):
   * 0 on the ground, see trackChunks.withGroundHeights. Absent = altFt.
   */
  hFt?: number;
  /** Height above ground from the sim and its on-ground flag (input of withGroundHeights). */
  aglFt?: number;
  onGround?: boolean;
  /** Fixed colour (hex) instead of the altitude ramp: the approach from the landing gear extension on. */
  color?: string;
}

/**
 * Track points of the samples; from index `tintFrom` on (the landing gear extension) they carry
 * `tint` instead of the altitude colour.
 */
export function samplesToPoints(samples: TrackSample[], tintFrom = -1, tint?: string): TrackPoint[] {
  return samples.map((s, i) => ({
    lon: s.longitude,
    lat: s.latitude,
    altFt: s.altitudeMslFt,
    aglFt: s.altitudeAglFt,
    onGround: s.onGround,
    ...(tint && tintFrom >= 0 && i >= tintFrom ? { color: tint } : {}),
  }));
}

/**
 * Track points of a recorded flight (tinted from `tintFrom(samples)` on) and their 3D heights,
 * cached by the samples and the tint colour: a redraw of the same flight (marker data arriving
 * late, a language change, the 3D switch) hands the curtain the same array, so it is not rebuilt.
 */
export function flightPointsCache(tintFrom: (samples: TrackSample[]) => number) {
  let last: { samples: TrackSample[]; tint: string; points: TrackPoint[]; ground?: TrackPoint[] } | null = null;
  return (samples: TrackSample[], tint: string) => {
    if (!last || last.samples !== samples || last.tint !== tint) last = { samples, tint, points: samplesToPoints(samples, tintFrom(samples), tint) };
    const l = last;
    return { points: l.points, ground: () => (l.ground ??= withGroundHeights(l.points)) };
  };
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

/** Altitude colour expression (ft MSL) from the active theme's single-hue ramp; a feature's own `color` wins. */
export function trackColorExpr(): maplibregl.ExpressionSpecification {
  const ramp = ["interpolate", ["linear"], ["coalesce", ["get", "alt"], 0], ...TRACK_RAMP.flat()];
  return ["case", ["has", "color"], ["to-color", ["get", "color"]], ramp] as unknown as maplibregl.ExpressionSpecification;
}

/**
 * Track source(s) plus casing and altitude-coloured line. With several sources (live map:
 * history + open block) all casings go below all lines, so the joint between them is seamless.
 */
export function addTrackLayers(map: maplibregl.Map, sourceIds: string | string[], before?: string) {
  const ids = Array.isArray(sourceIds) ? sourceIds : [sourceIds];
  for (const id of ids) addSourceOnce(map, id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  for (const id of ids)
    addLayerOnce(
      map,
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
    addLayerOnce(
      map,
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

interface CurtainEntry {
  id: string;
  layer: CurtainLayer;
  /** The shaders failed: the extrusion pair `${id}-fallback-*` draws instead. */
  fallback: boolean;
  visible: boolean;
  timer?: number;
  latest?: { points: readonly TrackPoint[]; head: TrackPoint | null };
}
/** Curtain layers per map and id. */
const curtains = new WeakMap<maplibregl.Map, Map<string, CurtainEntry>>();

/**
 * 3D track: a translucent wall from the ground to the flown height with a band in altitude
 * colour along its top edge – one WebGL custom layer (map/curtainLayer.ts), smooth and
 * stepless. Hidden until the 3D view is switched on; fed with drawCurtainTrack. Inserted
 * below the first symbol layer when `before` is given, so airport and place labels stay
 * readable. Should the shaders not compile, the old fill-extrusion pair takes over (unless
 * `fallback: false`). `ramp`: altitude colours (default: the own track's TRACK_RAMP).
 */
export function addCurtainLayers(
  map: maplibregl.Map,
  id: string,
  before?: string,
  opts: { ramp?: ReadonlyArray<readonly [number, string]>; fallback?: boolean } = {},
) {
  const layer = new CurtainLayer(id, opts.ramp ?? TRACK_RAMP);
  let byId = curtains.get(map);
  if (!byId) {
    curtains.set(map, (byId = new Map()));
    // the fallback's rebuild timer must not outlive the map (getSource on a removed map throws)
    const all = byId;
    map.once("remove", () => {
      for (const e of all.values()) window.clearTimeout(e.timer);
      all.clear();
    });
  }
  // re-added (theme change, context restore, a second style load): the old entry's timer goes
  const old = byId.get(id);
  if (old) window.clearTimeout(old.timer);
  const entry: CurtainEntry = { id, layer, fallback: false, visible: false };
  byId.set(id, entry);
  layer.onFail = () =>
    // not inside the render call: add the extrusion pair on the next frame (the own track only;
    // without shaders a traffic curtain simply stays away)
    requestAnimationFrame(() => {
      if (opts.fallback === false) return;
      if (curtains.get(map)?.get(id) !== entry || map.getSource(`${id}-fallback`)) return;
      const below = before && map.getLayer(before) ? before : undefined;
      addExtrudedCurtain(map, `${id}-fallback`, below);
      entry.fallback = true;
      setCurtainVisible(map, id, entry.visible);
      feedFallback(map, entry);
    });
  replaceCustomLayer(map, layer, before);
}

/**
 * WebGL context lost: MapLibre drops the style's custom layers without `onRemove`, so mark this
 * map's curtain instances removed by hand – drawCurtainTrack stops syncing them until the style
 * load after the restore adds fresh ones (audit 3 H-1).
 */
export function markCurtainsLost(map: maplibregl.Map) {
  for (const e of curtains.get(map)?.values() ?? []) e.layer.removed = true;
}

/**
 * The track (and the aircraft's position now as its head: null clears, undefined keeps it) for the
 * curtain `id`. Nothing while its layer is removed (between removeCustomLayers and the next style
 * load): the per-frame callers (the selected traffic's loop) kept syncing an orphaned instance.
 */
export function drawCurtainTrack(map: maplibregl.Map, id: string, points: readonly TrackPoint[], head?: TrackPoint | null) {
  const entry = curtains.get(map)?.get(id);
  if (!entry || entry.layer.removed) return;
  entry.layer.sync(points, head);
  entry.latest = { points, head: head === undefined ? (entry.latest?.head ?? null) : head };
  // the extrusion has no incremental path: at most one rebuild per second
  if (entry.fallback)
    entry.timer ??= window.setTimeout(() => {
      entry.timer = undefined;
      feedFallback(map, entry);
    }, 1000);
}

function feedFallback(map: maplibregl.Map, entry: CurtainEntry) {
  const l = entry.latest;
  const pts = l ? (l.head ? [...l.points, l.head] : [...l.points]) : [];
  (map.getSource(`${entry.id}-fallback`) as maplibregl.GeoJSONSource | undefined)?.setData(curtainGeoJson(pts));
}

/** Fallback curtain (no WebGL custom layer): two fill-extrusion layers over trackChunks.curtainGeoJson. */
function addExtrudedCurtain(map: maplibregl.Map, sourceId: string, before?: string) {
  addSourceOnce(map, sourceId, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  addLayerOnce(
    map,
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
  addLayerOnce(
    map,
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

export function setCurtainVisible(map: maplibregl.Map, id: string, on: boolean) {
  const entry = curtains.get(map)?.get(id);
  if (!entry) return;
  entry.visible = on;
  entry.layer.setEnabled(on);
  for (const l of [`${id}-fallback-wall`, `${id}-fallback-ribbon`]) if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", on ? "visible" : "none");
}

/**
 * Tilt the camera for the 3D view or lay it flat again (bearing kept); flat, the camera looks
 * at the ground again (the live map's 3D follow raises its centre to the aircraft's height).
 */
export function setPitched(map: maplibregl.Map, on: boolean, duration = 500) {
  map.easeTo({ pitch: on ? PITCH_3D : 0, duration, ...(on ? {} : { elevation: 0 }) });
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
  addSourceOnce(map, sourceId, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const classes: Array<{ kind: string; minzoom: number; color: string; radius: number; labelFrom: number }> = [
    { kind: "large", minzoom: 3, color: AIRPORT_DOT.large, radius: 4, labelFrom: 5 },
    { kind: "medium", minzoom: 7, color: AIRPORT_DOT.medium, radius: 3, labelFrom: 7.5 },
    { kind: "small", minzoom: 9, color: AIRPORT_DOT.small, radius: 2.5, labelFrom: 9.5 },
    { kind: "seaplane_base", minzoom: 9, color: AIRPORT_DOT.seaplane, radius: 2.5, labelFrom: 10 },
  ];
  for (const c of classes) {
    addLayerOnce(map, {
      id: `${sourceId}-${c.kind}-dot`,
      type: "circle",
      source: sourceId,
      minzoom: c.minzoom,
      maxzoom: DIAGRAM_FROM_ZOOM, // the airport diagram takes over from here
      filter: ["==", ["get", "kind"], c.kind],
      paint: { "circle-radius": c.radius, "circle-color": c.color, "circle-stroke-color": COLOR.halo, "circle-stroke-width": 1 },
    });
    addLayerOnce(map, {
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
  addSourceOnce(map, sourceId, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  addLayerOnce(map, {
    id: `${sourceId}-line`,
    type: "line",
    source: sourceId,
    filter: ["==", ["geometry-type"], "LineString"],
    paint: { "line-color": COLOR.route, "line-width": 2, "line-dasharray": [2, 2], "line-opacity": 0.9 },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  addLayerOnce(map, {
    id: `${sourceId}-fix`,
    type: "circle",
    source: sourceId,
    filter: ["==", ["geometry-type"], "Point"],
    minzoom: 5,
    paint: { "circle-radius": 3, "circle-color": COLOR.route, "circle-stroke-color": COLOR.halo, "circle-stroke-width": 1 },
  });
  addLayerOnce(map, {
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
export interface TrackPose {
  lon: number;
  lat: number;
  headingDeg: number | null;
  /** Altitude (ft MSL), pitch and bank of the interpolated sample (3D cursor). */
  altFt: number;
  /** Height above ground (sim AGL) and on-ground flag of the nearer sample. */
  aglFt: number;
  onGround: boolean;
  pitchDeg: number;
  bankDeg: number;
}

export function trackPoseAt(samples: TrackSample[], tMs: number | null): TrackPose | null {
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
  return { lon: s.longitude, lat: s.latitude, headingDeg, altFt: s.altitudeMslFt, aglFt: s.altitudeAglFt, onGround: !!s.onGround, pitchDeg: s.pitchDeg ?? 0, bankDeg: s.bankDeg ?? 0 };
}

const heightCache = new WeakMap<readonly TrackSample[], number[]>();

/** 3D heights above the map's ground of a recorded track (trackChunks.withGroundHeights), cached per array. */
export function trackHeightsFt(samples: readonly TrackSample[]): number[] {
  let h = heightCache.get(samples);
  if (!h) {
    h = withGroundHeights(samplesToPoints(samples as TrackSample[])).map((p) => p.hFt ?? p.altFt);
    heightCache.set(samples, h);
  }
  return h;
}

/** 3D height at `tMs` (replay cursor), interpolated between the samples; null outside the track. */
export function trackHeightAt(samples: readonly TrackSample[], tMs: number | null): number | null {
  if (tMs == null || !samples.length || tMs < samples[0].tMs || tMs > samples[samples.length - 1].tMs) return null;
  const h = trackHeightsFt(samples);
  const i = lowerBoundT(samples as TrackSample[], tMs);
  if (i <= 0) return h[0];
  const a = samples[i - 1];
  const b = samples[i];
  const span = b.tMs - a.tMs;
  const f = span > 0 ? Math.min(1, Math.max(0, (tMs - a.tMs) / span)) : 1;
  return h[i - 1] + (h[i] - h[i - 1]) * f;
}
