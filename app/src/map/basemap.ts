// OpenFreeMap basemap, re-tinted per theme (colours come from themes.ts). All themes – dark and light –
// start from the same OpenFreeMap "dark" style: its layer ids are known, and the patch
// below sets the colour of every layer we keep, so the light themes (Papierkarte, Arktis
// Studio) come out as paper/light grey without a second style to maintain. Roads are
// dimmed to texture, runways and aprons are visible, rail and road names are hidden.
//
// The raw style JSON is fetched once and kept in memory and in localStorage (per viewer,
// best effort; refreshed in the background on the next start). Offline without a cache
// the raw dark style URL is used unpatched, exactly as before.

import type { LayerSpecification, StyleSpecification } from "maplibre-gl";
import { activeTheme, type ThemeDef } from "../themes";

export const BASEMAP_URL = "https://tiles.openfreemap.org/styles/dark";
const CACHE_KEY = "vectasim.basemap.raw.v1";

type Paint = Record<string, unknown>;
type Layout = Record<string, unknown>;
interface LayerPatch {
  paint?: Paint;
  layout?: Layout;
  minzoom?: number;
  hidden?: boolean;
}

/** Patch table of one theme: exact layer ids, then id prefixes (layer families). */
export function patchTable(t: ThemeDef): { exact: Record<string, LayerPatch>; prefix: Array<[string, LayerPatch]> } {
  const m = t.map;
  const c = t.colors;
  const light = t.scheme === "light";
  // label halo: the land colour, so labels sit on the map like printed text
  const halo = m.land;
  const casing = light ? m.minor : m.major;
  const park: LayerPatch = m.park ? { paint: { "fill-color": m.park, "fill-opacity": light ? 0.8 : 0.6 } } : { hidden: true };
  const exact: Record<string, LayerPatch> = {
    background: { paint: { "background-color": m.land } },
    water: { paint: { "fill-color": m.water } },
    waterway: { paint: { "line-color": m.water } },
    landcover_ice_shelf: { paint: { "fill-color": m.land, "fill-opacity": 0.5 } },
    landcover_glacier: { paint: { "fill-color": m.land } },
    landuse_residential: { paint: { "fill-color": light ? m.minor : m.land, "fill-opacity": light ? 0.5 : 0.4 } },
    landcover_wood: park,
    landuse_park: park,
    building: { paint: { "fill-color": light ? m.minor : m.land, "fill-outline-color": casing }, minzoom: 14 },
    road_area_pier: { paint: { "fill-color": m.land } },
    road_pier: { paint: { "line-color": m.land } },
    highway_motorway_inner: { paint: { "line-color": m.motorway } },
    highway_motorway_casing: { paint: { "line-color": casing } },
    highway_major_casing: { paint: { "line-color": casing } },
    highway_major_inner: { paint: { "line-color": m.major } },
    highway_major_subtle: { paint: { "line-color": m.major } },
    highway_motorway_subtle: { paint: { "line-color": m.major } },
    highway_minor: { paint: { "line-color": m.minor }, minzoom: 12 },
    highway_path: { paint: { "line-color": m.minor }, minzoom: 12 },
    boundary_state: { paint: { "line-color": m.minor } },
    "aeroway-runway": { paint: { "line-color": m.rwy } },
    "aeroway-runway-casing": { paint: { "line-color": light ? m.aptSmall : m.minor } },
    "aeroway-area": { paint: { "fill-color": m.apron } },
    "aeroway-taxiway": { paint: { "line-color": light ? m.motorway : m.minor } },
    water_name: { paint: { "text-color": light ? c.accent : m.label, "text-halo-color": halo, "text-halo-width": light ? 1 : 0 } },
  };
  const small: LayerPatch = { paint: { "text-color": m.label, "text-halo-color": halo }, minzoom: 10 };
  const big: LayerPatch = { paint: { "text-color": m.labelStrong, "text-halo-color": halo }, layout: { "text-letter-spacing": 0.08 } };
  const prefix: Array<[string, LayerPatch]> = [
    ["railway", { hidden: true }],
    ["highway_name_", { hidden: true }],
    ["road_oneway", { hidden: true }],
    ["boundary_country_", { paint: { "line-color": m.boundary, "line-dasharray": [3, 2] } }],
    ["place_village", small],
    ["place_suburb", small],
    ["place_other", small],
    ["place_state", { paint: { "text-color": m.label, "text-halo-color": halo } }],
    ["place_town", big],
    ["place_city", big],
    ["place_country", big],
  ];
  return { exact, prefix };
}

function patchFor(table: ReturnType<typeof patchTable>, id: string): LayerPatch | null {
  if (table.exact[id]) return table.exact[id];
  for (const [prefix, p] of table.prefix) if (id.startsWith(prefix)) return p;
  return null;
}

/** 1° graticule (Papierkarte: map-blue grid; Phosphor: dot-like faint lines). */
export function graticule(stepDeg = 1): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let lon = -180; lon <= 180; lon += stepDeg)
    features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[lon, -85], [lon, 85]] } });
  for (let lat = -80; lat <= 80; lat += stepDeg)
    features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[-180, lat], [180, lat]] } });
  return { type: "FeatureCollection", features };
}

/** Applies a theme's patch table to the raw style (pure; returns a new object, unknown layers untouched). */
export function patchBasemapStyle(style: StyleSpecification, t: ThemeDef = activeTheme()): StyleSpecification {
  const table = patchTable(t);
  const layers: LayerSpecification[] = style.layers.map((layer) => {
    const p = patchFor(table, layer.id);
    if (!p) return layer;
    const next = { ...layer } as LayerSpecification & { paint?: Paint; layout?: Layout; minzoom?: number };
    if (p.paint) next.paint = { ...(layer as { paint?: Paint }).paint, ...p.paint };
    const layout: Layout = { ...(layer as { layout?: Layout }).layout };
    if (p.layout) Object.assign(layout, p.layout);
    if (p.hidden) layout.visibility = "none";
    if (p.layout || p.hidden) next.layout = layout;
    if (p.minzoom != null) next.minzoom = Math.max(p.minzoom, layer.minzoom ?? 0);
    return next as LayerSpecification;
  });
  const sources = { ...style.sources };
  if (t.map.grid) {
    sources["vectasim-graticule"] = { type: "geojson", data: graticule(1) };
    // above land and water, below roads and labels
    const at = layers.findIndex((l) => l.id === "building");
    layers.splice(at < 0 ? layers.length : at, 0, {
      id: "vectasim-graticule",
      type: "line",
      source: "vectasim-graticule",
      paint: { "line-color": t.map.grid, "line-width": 1 },
    } as LayerSpecification);
  }
  return { ...style, sources, layers };
}

let raw: StyleSpecification | null = null;
let inflight: Promise<StyleSpecification | null> | null = null;

function readCache(): StyleSpecification | null {
  try {
    const s = localStorage.getItem(CACHE_KEY);
    return s ? (JSON.parse(s) as StyleSpecification) : null;
  } catch {
    return null;
  }
}

function writeCache(style: StyleSpecification) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(style));
  } catch {
    /* storage full or unavailable: the in-memory copy still serves this session */
  }
}

function fetchRaw(): Promise<StyleSpecification | null> {
  inflight ??= fetch(BASEMAP_URL)
    .then((r) => (r.ok ? (r.json() as Promise<StyleSpecification>) : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((s) => {
      raw = s;
      writeCache(s);
      return s;
    })
    // offline / blocked: callers fall back to the cache or the raw URL
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

let refreshed = false;

/**
 * Style for `new maplibregl.Map({ style })` / `map.setStyle()` in the active theme:
 * memory → localStorage (plus one background refresh per session) → network → the raw
 * URL as the offline fallback.
 */
export async function loadBasemapStyle(t: ThemeDef = activeTheme()): Promise<StyleSpecification | string> {
  if (!raw) {
    raw = readCache();
    if (raw && !refreshed) {
      refreshed = true;
      void fetchRaw();
    }
  }
  if (!raw) {
    refreshed = true;
    await fetchRaw();
  }
  return raw ? patchBasemapStyle(raw, t) : BASEMAP_URL;
}
