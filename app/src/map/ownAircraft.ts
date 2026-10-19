// The own aircraft on the live map: layers, data and the helpers that keep it the most visible
// thing on the map (size, halo, layer order, a gentle pulse while it is not followed).
//
// 2D: yellow silhouette ~30 % larger than the traffic, a thick dark edge (aircraftIcons.ts) and a
// soft yellow halo image with a crisp ring underneath. 3D: the low-poly model (aircraftModel.ts)
// at the curtain's height replaces both; if WebGL refuses the model, the flat symbol is raised
// to that height instead (`symbol-height-offset`, MapLibre ≥ 6.x).

import type * as maplibregl from "maplibre-gl";
import { OWN_AIRCRAFT, type ThemeDef } from "../themes";
import { pointFeature } from "./common";
import { iconSizeExpr, type WakeCategory, WAKE_SIZE } from "./aircraftIcons";
import { altToCurtainM } from "./trackChunks";

/** Own-aircraft layers, bottom to top; always the topmost layers of the map. */
export const OWN_LAYERS = ["aircraft-halo", "aircraft"] as const;
/** Base icon size of the own symbol (× wake factor): traffic peaks at 1.05, so ~30 % above the old 1.3. */
export const OWN_ICON_SIZE = 1.7;
/** Halo image size (× wake factor): the 64 px image then spans ~80 px around a medium jet. */
export const OWN_HALO_SIZE = 0.95;
/** One breath of the "not followed" pulse. */
export const PULSE_PERIOD_MS = 2400;
/** Halo opacity range of the pulse (and its resting value). */
export const PULSE_MIN = 0.55;
export const PULSE_MAX = 1;

export interface OwnPose {
  lon: number;
  lat: number;
  headingDeg: number;
  /** Height above the map's ground (ft, trackChunks.groundHeightFt), not MSL. */
  altFt: number;
  cat: WakeCategory;
}

/**
 * Source data of the own aircraft: one point with heading, class and size factor. `hM` is the
 * curtain height in the 3D view (0 in 2D) for the raised-symbol fallback; `m` = 1 hides the flat
 * symbol while the 3D model draws the aircraft.
 */
export function ownAircraftGeoJson(p: OwnPose | null, view3d: boolean, model = false): GeoJSON.FeatureCollection {
  if (!p || !Number.isFinite(p.lon) || !Number.isFinite(p.lat)) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [pointFeature(p.lon, p.lat, { heading: p.headingDeg, cat: p.cat, sizeFactor: WAKE_SIZE[p.cat], hM: view3d ? altToCurtainM(p.altFt) : 0, m: view3d && model ? 1 : 0 })],
  };
}

/**
 * Which own layers have to be moved to the top so that they are the last layers, in the
 * `own` order. Empty when they already are (so a `styledata` handler cannot loop).
 */
export function ownLayerMoves(order: readonly string[], own: readonly string[]): string[] {
  const present = own.filter((id) => order.includes(id));
  const tail = order.slice(order.length - present.length);
  return tail.every((id, i) => id === present[i]) ? [] : present;
}

/** Moves the own layers above everything added later (weather overlay, diagram, traffic, labels). */
export function keepOwnOnTop(map: maplibregl.Map, own: readonly string[] = OWN_LAYERS): void {
  const order = map.getLayersOrder();
  for (const id of ownLayerMoves(order, own)) map.moveLayer(id);
}

/** Halo opacity at time `tMs` of the pulse: a smooth breath between PULSE_MIN and PULSE_MAX. */
export function pulseOpacity(tMs: number, periodMs = PULSE_PERIOD_MS): number {
  const phase = (((tMs % periodMs) + periodMs) % periodMs) / periodMs;
  const s = 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI);
  return PULSE_MIN + (PULSE_MAX - PULSE_MIN) * s;
}

/** True when the user asked the system for less motion (no pulse then). */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export interface OwnHaloColors {
  /** Crisp ring around the aircraft. */
  ring: string;
  /** Thin casing that separates the ring from the basemap. */
  casing: string;
  /** Opacity of the soft yellow glow in the halo centre. */
  glow: number;
}

/**
 * Halo colours of a theme: on dark maps a yellow ring with a dark casing, on light maps
 * (Papierkarte, Arktis Studio – yellow alone vanishes on paper) a dark ink ring with a
 * yellow casing and a stronger glow. The ring clears 3:1 against the land colour in every theme.
 */
export function ownHaloColorsOf(t: ThemeDef): OwnHaloColors {
  const light = t.scheme === "light";
  return light
    ? { ring: t.colors.aircraftEdge, casing: OWN_AIRCRAFT, glow: 0.7 }
    : { ring: OWN_AIRCRAFT, casing: t.colors.aircraftEdge, glow: 0.5 };
}

/** Halo image (128 viewBox → 64 css px): radial yellow glow plus a ring with casing. */
export function haloSvg(c: OwnHaloColors): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs><radialGradient id="g" cx="64" cy="64" r="63" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="${OWN_AIRCRAFT}" stop-opacity="${c.glow}"/>
    <stop offset="0.55" stop-color="${OWN_AIRCRAFT}" stop-opacity="${(c.glow * 0.45).toFixed(3)}"/>
    <stop offset="1" stop-color="${OWN_AIRCRAFT}" stop-opacity="0"/>
  </radialGradient></defs>
  <circle cx="64" cy="64" r="63" fill="url(#g)"/>
  <circle cx="64" cy="64" r="44" fill="none" stroke="${c.casing}" stroke-width="7" stroke-opacity="0.9"/>
  <circle cx="64" cy="64" r="44" fill="none" stroke="${c.ring}" stroke-width="3.5"/>
</svg>`;
}

/** Halo opacity expression: `k` while the flat symbol shows, 0 when the 3D model draws the aircraft. */
export function haloOpacity(k: number): maplibregl.ExpressionSpecification {
  return ["case", ["==", ["get", "m"], 1], 0, k];
}

/**
 * Source + halo + symbol of the own aircraft, added last so they start on top (keepOwnOnTop
 * keeps them there). Icons must be loaded (aircraftIcons.loadAircraftIcons).
 */
export function addOwnAircraftLayers(map: maplibregl.Map, sourceId = "aircraft"): void {
  map.addSource(sourceId, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const common: maplibregl.SymbolLayerSpecification["layout"] = {
    "icon-rotation-alignment": "map",
    "icon-pitch-alignment": "map",
    "icon-allow-overlap": true,
    "icon-ignore-placement": true,
    // 3D fallback without the model: the flat symbol at the curtain's height (0 in 2D)
    "symbol-height-offset": ["coalesce", ["get", "hM"], 0],
  };
  map.addLayer({
    id: OWN_LAYERS[0],
    type: "symbol",
    source: sourceId,
    layout: { ...common, "icon-image": "ac-own-halo", "icon-size": iconSizeExpr(OWN_HALO_SIZE) },
    paint: { "icon-opacity": haloOpacity(PULSE_MIN) },
  });
  map.addLayer({
    id: OWN_LAYERS[1],
    type: "symbol",
    source: sourceId,
    layout: {
      ...common,
      "icon-image": ["concat", "ac-own-", ["coalesce", ["get", "cat"], "medium"]],
      "icon-size": iconSizeExpr(OWN_ICON_SIZE),
      "icon-rotate": ["get", "heading"],
    },
    paint: { "icon-opacity": haloOpacity(1) },
  });
}
