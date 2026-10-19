// Map projection: globe (default) or flat Mercator, one per-viewer choice for every map
// (live map, track map, Länder). MapLibre itself blends the globe into Mercator when zooming
// in (around zoom 12), so a close-up looks the same either way; fill-extrusion (3D curtain),
// fitBounds/easeTo and symbol rotation all work in both projections (MapLibre ≥ 5).

import { useSyncExternalStore } from "react";
import type { ProjectionSpecification, SkySpecification, StyleSpecification } from "maplibre-gl";

export type MapProjection = "globe" | "mercator";

export const GLOBE_STORAGE_KEY = "vectasim.mapGlobe";
/** Fired on window when the choice changes, so every mounted map follows. */
export const GLOBE_EVENT = "vectasim:globe";

/**
 * From this zoom on the globe looks as flat as the Mercator map (MapLibre blends it fully into
 * Mercator around zoom 12, but the curvature is no longer visible from about zoom 6); the
 * Globus button says so instead of looking broken (GlobeToggle.tsx).
 */
export const GLOBE_FLAT_FROM_ZOOM = 6;

export function projectionFor(globe: boolean): MapProjection {
  return globe ? "globe" : "mercator";
}

/** Stored choice; anything but an explicit "0" (also no storage at all) means globe. */
export function loadGlobe(): boolean {
  try {
    return localStorage.getItem(GLOBE_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveGlobe(on: boolean) {
  try {
    localStorage.setItem(GLOBE_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable: the choice still applies for this session */
  }
  current = on;
  window.dispatchEvent(new CustomEvent<boolean>(GLOBE_EVENT, { detail: on }));
}

let current: boolean | null = null;
function snapshot(): boolean {
  if (current == null) current = loadGlobe();
  return current;
}
function subscribe(cb: () => void): () => void {
  window.addEventListener(GLOBE_EVENT, cb);
  return () => window.removeEventListener(GLOBE_EVENT, cb);
}

/** The shared globe choice and its setter (re-renders every user on change). */
export function useGlobe(): [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(subscribe, snapshot), saveGlobe];
}

/**
 * Sky for the globe: a thin atmosphere rim (MapLibre's own, blue) that sets the dark globe
 * off from the equally dark page, faded out by zoom 6; sky and horizon in the page
 * background, so a pitched close-up (3D) shows no light-blue default sky above the horizon.
 * Only drawn by MapLibre in the globe projection; harmless in Mercator.
 */
export function globeSky(bg: string): SkySpecification {
  return {
    "sky-color": bg,
    "horizon-color": bg,
    "fog-color": bg,
    "sky-horizon-blend": 0,
    "horizon-fog-blend": 0,
    "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.7, 4, 0.7, 6, 0],
  };
}

/**
 * The basemap style with the projection set in the style itself: `new Map({ style })` and the
 * theme change's `setStyle()` would otherwise fall back to Mercator. With `bg` (theme page
 * colour) also the globe sky, unless the style brings its own. A style URL (offline fallback)
 * is passed through; `applyProjection` after load covers it.
 */
export function withProjection(style: StyleSpecification | string, globe: boolean, bg?: string): StyleSpecification | string {
  if (typeof style === "string") return style;
  const sky = style.sky ?? (bg ? globeSky(bg) : undefined);
  return { ...style, projection: { type: projectionFor(globe) }, ...(sky ? { sky } : {}) };
}

/** The part of maplibregl.Map this needs (keeps the helper testable without WebGL). */
export interface ProjectionTarget {
  getProjection(): ProjectionSpecification | undefined;
  setProjection(p: ProjectionSpecification): unknown;
}

/** Switch the map's projection; no-op when it already matches. Returns whether it changed. */
export function applyProjection(map: ProjectionTarget, globe: boolean): boolean {
  const want = projectionFor(globe);
  const have = map.getProjection()?.type ?? "mercator";
  if (have === want) return false;
  map.setProjection({ type: want });
  return true;
}
