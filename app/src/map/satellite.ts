// Map style "Karte" (OpenFreeMap vector basemap, basemap.ts) or "Satellit" (EOxCloudless
// Sentinel-2 imagery, 2017 edition). One per-viewer choice for the live map and the track
// map; the Länder view stays on the vector map. Like the globe (projection.ts) the choice
// lives in localStorage and every mounted map follows it at once.
//
// Satellite mode does not swap the style: it adds one raster layer right above the
// background and hides the vector basemap's fills and lines, keeping its place and water
// names and the country borders (re-coloured for the imagery). Our own layers (track,
// airports, diagrams, traffic, weather) stay on top untouched. A theme change brings a new
// style; `followSatellite` re-applies the mode on every `style.load`.
//
// Licence: the 2017 edition of Sentinel-2 cloudless is CC BY 4.0 (the later editions are
// CC BY-NC-SA); see THIRD-PARTY-NOTICES.md. Tiles are only requested while "Satellit" is on.

import { useSyncExternalStore } from "react";
import { getMapTheme } from "../theme";

export type MapStyleMode = "map" | "satellite";

export const MAP_STYLE_STORAGE_KEY = "vectasim.mapStyle";
/** Fired on window when the choice changes, so every mounted map follows. */
export const MAP_STYLE_EVENT = "vectasim:mapstyle";

export const SATELLITE_SOURCE = "vectasim-satellite";
export const SATELLITE_LAYER = "vectasim-satellite";
/** EOX WMTS, Web-Mercator tile matrix "g" (row = y, col = x). */
export const SATELLITE_TILES = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2017_3857/default/g/{z}/{y}/{x}.jpg";
/** Sentinel-2 has 10 m pixels, about zoom 14; closer in MapLibre overscales instead of asking for blurry tiles. */
export const SATELLITE_MAX_ZOOM = 14;
export const SATELLITE_ATTRIBUTION =
  '<a href="https://cloudless.eox.at" target="_blank" rel="noopener">EOxCloudless</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2017, CC BY 4.0)';

/** Sources of the vector basemap (OpenFreeMap) and of our graticule: everything the imagery replaces. */
const BASEMAP_SOURCES = new Set(["openmaptiles", "ne2_shaded", "vectasim-graticule"]);

// ---- choice -------------------------------------------------------------------------

/** Stored choice; anything but an explicit "satellite" (also no storage at all) means the map. */
export function loadMapStyle(): MapStyleMode {
  try {
    return localStorage.getItem(MAP_STYLE_STORAGE_KEY) === "satellite" ? "satellite" : "map";
  } catch {
    return "map";
  }
}

export function saveMapStyle(mode: MapStyleMode) {
  try {
    localStorage.setItem(MAP_STYLE_STORAGE_KEY, mode);
  } catch {
    /* storage unavailable: the choice still applies for this session */
  }
  current = mode;
  window.dispatchEvent(new CustomEvent<MapStyleMode>(MAP_STYLE_EVENT, { detail: mode }));
}

let current: MapStyleMode | null = null;
function snapshot(): MapStyleMode {
  if (current == null) current = loadMapStyle();
  return current;
}
function subscribe(cb: () => void): () => void {
  window.addEventListener(MAP_STYLE_EVENT, cb);
  return () => window.removeEventListener(MAP_STYLE_EVENT, cb);
}

/** The shared map style choice and its setter (re-renders every user on change). */
export function useMapStyle(): [MapStyleMode, (mode: MapStyleMode) => void] {
  return [useSyncExternalStore(subscribe, snapshot), saveMapStyle];
}

// ---- style patch ----------------------------------------------------------------------

type StyleLayer = { id: string; type: string; source?: string; "source-layer"?: string };

/** A layer of the vector basemap (or the background under it). */
export function isBasemapLayer(l: StyleLayer): boolean {
  return l.type === "background" || (l.source != null && BASEMAP_SOURCES.has(l.source));
}

/** Basemap layers that stay visible over the imagery: place and water names, country borders. */
export function keptOverImagery(l: StyleLayer): "label" | "border" | null {
  if (!isBasemapLayer(l)) return null;
  if (l.type === "symbol" && (l["source-layer"] === "place" || l["source-layer"] === "water_name")) return "label";
  if (l.type === "line" && l.id.startsWith("boundary_country")) return "border";
  return null;
}

/** Where the imagery goes: right above the background, under every other layer. */
export function satelliteBeforeId(layers: StyleLayer[]): string | undefined {
  return layers.find((l) => l.type !== "background" && l.id !== SATELLITE_LAYER)?.id;
}

/** Paint for the kept layers over the imagery: light names with a dark halo, light borders. */
function imageryPaint(kind: "label" | "border"): Record<string, unknown> {
  return kind === "label"
    ? { "text-color": "#f2f5f8", "text-halo-color": "rgba(6, 10, 14, 0.85)", "text-halo-width": 1.4 }
    : { "line-color": "rgba(242, 245, 248, 0.55)" };
}

/** The part of maplibregl.Map this needs (keeps the helper testable without WebGL). */
export interface SatelliteTarget {
  getStyle(): { layers?: StyleLayer[] } | undefined;
  getSource(id: string): unknown;
  addSource(id: string, source: object): unknown;
  removeSource(id: string): unknown;
  getLayer(id: string): unknown;
  addLayer(layer: object, beforeId?: string): unknown;
  removeLayer(id: string): unknown;
  getLayoutProperty(id: string, name: string): unknown;
  setLayoutProperty(id: string, name: string, value: unknown): unknown;
  getPaintProperty(id: string, name: string): unknown;
  setPaintProperty(id: string, name: string, value: unknown): unknown;
}

interface Saved {
  visibility: unknown;
  paint: Record<string, unknown>;
}
/** Per map: what the vector style had before the imagery changed it (restored when switching back). */
const savedByMap = new WeakMap<object, Map<string, Saved>>();

/**
 * Switches a running map between the vector map and the imagery. Idempotent; the vector
 * state is remembered per layer and restored exactly (theme colours included).
 */
export function applySatellite(map: SatelliteTarget, on: boolean) {
  const layers = map.getStyle()?.layers ?? [];
  let saved = savedByMap.get(map);
  if (on) {
    if (!map.getSource(SATELLITE_SOURCE))
      map.addSource(SATELLITE_SOURCE, {
        type: "raster",
        tiles: [SATELLITE_TILES],
        tileSize: 256,
        maxzoom: SATELLITE_MAX_ZOOM,
        attribution: SATELLITE_ATTRIBUTION,
      });
    if (!map.getLayer(SATELLITE_LAYER)) {
      const dark = getMapTheme().scheme !== "light";
      map.addLayer(
        {
          id: SATELLITE_LAYER,
          type: "raster",
          source: SATELLITE_SOURCE,
          // a touch darker on the dark themes, so the yellow track and the overlays stand out
          paint: { "raster-brightness-max": dark ? 0.82 : 1, "raster-fade-duration": 150 },
        },
        satelliteBeforeId(layers),
      );
    }
    if (!saved) {
      saved = new Map();
      savedByMap.set(map, saved);
    }
    for (const l of layers) {
      if (!isBasemapLayer(l) || l.type === "background" || saved.has(l.id)) continue;
      const kept = keptOverImagery(l);
      const paint = kept ? imageryPaint(kept) : {};
      saved.set(l.id, {
        visibility: map.getLayoutProperty(l.id, "visibility"),
        paint: Object.fromEntries(Object.keys(paint).map((k) => [k, map.getPaintProperty(l.id, k)])),
      });
      if (kept) for (const [k, v] of Object.entries(paint)) map.setPaintProperty(l.id, k, v);
      else map.setLayoutProperty(l.id, "visibility", "none");
    }
    return;
  }
  if (map.getLayer(SATELLITE_LAYER)) map.removeLayer(SATELLITE_LAYER);
  if (map.getSource(SATELLITE_SOURCE)) map.removeSource(SATELLITE_SOURCE);
  if (!saved) return;
  for (const [id, s] of saved) {
    if (!map.getLayer(id)) continue;
    map.setLayoutProperty(id, "visibility", s.visibility ?? "visible");
    for (const [k, v] of Object.entries(s.paint)) map.setPaintProperty(id, k, v);
  }
  savedByMap.delete(map);
}

/** The events this needs from maplibregl.Map. */
export interface SatelliteEvents extends SatelliteTarget {
  on(type: "style.load", cb: () => void): unknown;
  off(type: "style.load", cb: () => void): unknown;
}

/**
 * Keeps a map on the shared map style: applies it on every (re)loaded style (first load,
 * theme change) and whenever the choice changes. Returns the unsubscribe.
 */
export function followSatellite(map: SatelliteEvents): () => void {
  const apply = () => {
    try {
      applySatellite(map, snapshot() === "satellite");
    } catch {
      /* style still loading: the coming style.load applies it */
    }
  };
  const onStyle = () => {
    // a new style has new layers: nothing of the previous one is to be restored
    savedByMap.delete(map);
    apply();
  };
  map.on("style.load", onStyle);
  window.addEventListener(MAP_STYLE_EVENT, apply);
  apply();
  return () => {
    map.off("style.load", onStyle);
    window.removeEventListener(MAP_STYLE_EVENT, apply);
  };
}
