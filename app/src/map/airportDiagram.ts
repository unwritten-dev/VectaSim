// Airport diagram for zoomed-in maps: aprons, runways, taxiways with refs and
// gates from the basemap's OpenMapTiles `aeroway` layer, plus runway designators (and a
// runway fallback for fields OSM doesn't cover) from the embedded OurAirports runways.

import * as maplibregl from "maplibre-gl";
import { invoke } from "@tauri-apps/api/core";
import type { Airport, Runway } from "../types";
import { COLOR, DIAGRAM } from "../theme";
import { boundedDebounce } from "./debounce";
import { addLayerOnce, addSourceOnce } from "./styleOnce";
import { queryBox, unwrapLon } from "./geo";

/** Zoom from which the diagram takes over from the airport dots in common.ts. */
export const DIAGRAM_FROM_ZOOM = 13;

const FONT = ["Noto Sans Regular"];
const FONT_BOLD = ["Noto Sans Bold"];
// theme colours, re-read every time the layers are (re-)added (theme change → setStyle)
let HALO = COLOR.halo;
let TAXIWAY = DIAGRAM.taxiway;
let RUNWAY = DIAGRAM.runway;
let RUNWAY_EDGE = DIAGRAM.runwayEdge;

const THR_SOURCE = "apd-rwy";
const OURAIRPORTS_FROM_ZOOM = 11;
const FT_TO_M = 0.3048;

/** Metres → screen pixels at zoom 10 for a given latitude (feeds an exponential-2 zoom ramp). */
function pxAtZ10(meters: number, lat: number): number {
  return meters / ((156543.03 * Math.cos((lat * Math.PI) / 180)) / 1024);
}

/** Line width that tracks a real-world width (pixels at z10 doubling per zoom level). */
function realWidth(z10px: number | maplibregl.ExpressionSpecification, min = 0.5): maplibregl.ExpressionSpecification {
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    10,
    ["max", min, z10px],
    22,
    ["*", z10px, 4096],
  ] as unknown as maplibregl.ExpressionSpecification;
}

const isLine: maplibregl.ExpressionSpecification = ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];
const isPolygon: maplibregl.ExpressionSpecification = ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false];
const isPoint: maplibregl.ExpressionSpecification = ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false];
/** OSM gate refs like "B14;B60" or "C16/C16A + C16B": keep the part before the first ";" or " ". */
const cut = (e: maplibregl.ExpressionSpecification, sep: string): maplibregl.ExpressionSpecification => [
  "case",
  [">", ["index-of", sep, e], 0],
  ["slice", e, 0, ["index-of", sep, e]],
  e,
];
const gateRef = cut(cut(["to-string", ["get", "ref"]], ";"), " ");
const cls = (...c: string[]): maplibregl.ExpressionSpecification => ["match", ["get", "class"], c, true, false];

/** The basemap source whose vector layers include `aeroway` (OpenMapTiles), found at runtime. */
export function findAerowaySource(map: maplibregl.Map): string | null {
  const sources = map.getStyle().sources;
  const layers = map.getStyle().layers;
  for (const l of layers) {
    if ("source-layer" in l && l["source-layer"] === "aeroway" && typeof l.source === "string") return l.source;
  }
  for (const [id, s] of Object.entries(sources)) {
    const vl = (s as { vector_layers?: Array<{ id: string }> }).vector_layers;
    if (s.type === "vector" && (!vl || vl.some((v) => v.id === "aeroway"))) return id;
  }
  return null;
}

/**
 * Adds the diagram layers above the basemap (call in `load`, before the app's own layers so
 * the track/aircraft stay on top). Returns a cleanup that detaches the map listeners.
 */
export function addAirportDiagramLayers(map: maplibregl.Map): () => void {
  HALO = COLOR.halo;
  TAXIWAY = DIAGRAM.taxiway;
  RUNWAY = DIAGRAM.runway;
  RUNWAY_EDGE = DIAGRAM.runwayEdge;
  const src = findAerowaySource(map);
  if (src) addOsmLayers(map, src);
  addOurAirportsLayers(map);

  const cache = new Map<string, Runway[]>();
  let seq = 0;
  // airports whose runways are on the source now: panning within one airport sends nothing
  let shownKey = "";
  const refresh = () => {
    if (map.getZoom() < OURAIRPORTS_FROM_ZOOM) return;
    const mySeq = ++seq;
    // pad the view: zoomed in on a runway end, the airport's reference point is often off-screen
    const b = map.getBounds();
    const c = map.getCenter();
    const padLat = 0.06;
    const padLon = padLat / Math.max(0.2, Math.cos((c.lat * Math.PI) / 180));
    // the centre in the bounds' world copy (getBounds may run past ±180), then wrapped for the
    // backend: a view across the antimeridian finds the runways on both sides
    const lng = unwrapLon(c.lng, (b.getWest() + b.getEast()) / 2);
    invoke<Airport[]>("airports_in_bbox", {
      ...queryBox({
        west: Math.min(b.getWest(), lng - padLon),
        south: Math.min(b.getSouth(), c.lat - padLat),
        east: Math.max(b.getEast(), lng + padLon),
        north: Math.max(b.getNorth(), c.lat + padLat),
      }),
      limit: 60,
    })
      .then(async (list) => {
        const idents = list.filter((a) => a.kind === "large" || a.kind === "medium" || a.kind === "small").map((a) => a.ident);
        await Promise.all(
          idents
            .filter((id) => !cache.has(id))
            .map((id) =>
              invoke<{ runways: Runway[] } | null>("get_airport", { ident: id })
                .then((d) => cache.set(id, d?.runways ?? []))
                .catch(() => cache.set(id, [])),
            ),
        );
        if (mySeq !== seq) return;
        const key = [...idents].sort().join(",");
        if (key === shownKey) return;
        shownKey = key;
        const runways = idents.flatMap((id) => cache.get(id) ?? []);
        (map.getSource(THR_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(runwaysGeoJson(runways));
      })
      // runway overlay is decoration on top of the OSM diagram; keep the last state on failure
      .catch(() => {});
  };
  // the follow camera ends a move up to every frame: at most a few lookups per second
  const soon = boundedDebounce(refresh, 150, 500);
  map.on("moveend", soon);
  refresh();
  return () => {
    soon.cancel();
    map.off("moveend", soon);
  };
}

function addOsmLayers(map: maplibregl.Map, source: string) {
  const base = { source, "source-layer": "aeroway" } as const;

  // soft airport ground for the aerodrome polygon
  addLayerOnce(map, {
    ...base,
    id: "apd-aerodrome",
    type: "fill",
    minzoom: 11,
    filter: ["all", isPolygon, cls("aerodrome")],
    paint: { "fill-color": DIAGRAM.aerodrome, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0, 13, 0.55] },
  });
  addLayerOnce(map, {
    ...base,
    id: "apd-apron",
    type: "fill",
    minzoom: 12,
    filter: ["all", isPolygon, cls("apron")],
    paint: { "fill-color": DIAGRAM.apron, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0.3, 14, 0.8] },
  });
  addLayerOnce(map, {
    ...base,
    id: "apd-apron-outline",
    type: "line",
    minzoom: 14,
    filter: ["all", isPolygon, cls("apron")],
    paint: { "line-color": DIAGRAM.apronOutline, "line-width": 0.8 },
  });
  // runway/taxiway polygons where mapped as areas
  addLayerOnce(map, {
    ...base,
    id: "apd-pavement-area",
    type: "fill",
    minzoom: 12,
    filter: ["all", isPolygon, cls("runway", "taxiway", "helipad")],
    paint: { "fill-color": ["match", ["get", "class"], "runway", RUNWAY, DIAGRAM.pavement] },
  });

  // taxiways: dark pavement at real width (~23 m) + yellow centreline
  addLayerOnce(map, {
    ...base,
    id: "apd-taxiway-pavement",
    type: "line",
    minzoom: 12,
    filter: ["all", isLine, cls("taxiway")],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": DIAGRAM.pavement, "line-width": realWidth(pxAtZ10(23, 50), 0.3) },
  });
  addLayerOnce(map, {
    ...base,
    id: "apd-taxiway",
    type: "line",
    minzoom: 12,
    filter: ["all", isLine, cls("taxiway")],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": TAXIWAY,
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.6, 15, 1.2, 18, 2.2],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0.5, 14, 0.95],
    },
  });

  // runways: grey at real width (~45 m) with a lighter edge and a dashed white centreline
  addLayerOnce(map, {
    ...base,
    id: "apd-runway-edge",
    type: "line",
    minzoom: 11,
    filter: ["all", isLine, cls("runway")],
    paint: { "line-color": RUNWAY_EDGE, "line-width": realWidth(pxAtZ10(45, 50) + 0.8, 1.6) },
  });
  addLayerOnce(map, {
    ...base,
    id: "apd-runway",
    type: "line",
    minzoom: 11,
    filter: ["all", isLine, cls("runway")],
    paint: { "line-color": RUNWAY, "line-width": realWidth(pxAtZ10(45, 50), 1) },
  });
  addLayerOnce(map, {
    ...base,
    id: "apd-runway-centreline",
    type: "line",
    minzoom: 14,
    filter: ["all", isLine, cls("runway")],
    paint: {
      "line-color": DIAGRAM.centreline,
      "line-opacity": 0.8,
      "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.6, 18, 1.5],
      "line-dasharray": [6, 5],
    },
  });

  // gates / stands
  addLayerOnce(map, {
    ...base,
    id: "apd-gate",
    type: "circle",
    minzoom: 15,
    filter: ["all", isPoint, cls("gate")],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, 2, 18, 3.5],
      "circle-color": DIAGRAM.gate,
      "circle-stroke-color": HALO,
      "circle-stroke-width": 1,
    },
  });

  // labels
  addLayerOnce(map, {
    ...base,
    id: "apd-taxiway-label",
    type: "symbol",
    minzoom: 13.5,
    filter: ["all", isLine, cls("taxiway"), ["has", "ref"]],
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 220,
      "text-field": ["get", "ref"],
      "text-font": FONT_BOLD,
      "text-size": ["interpolate", ["linear"], ["zoom"], 13.5, 11, 17, 14],
      "text-max-angle": 30,
      "text-padding": 4,
    },
    paint: { "text-color": TAXIWAY, "text-halo-color": HALO, "text-halo-width": 1.5 },
  });
  addLayerOnce(map, {
    ...base,
    id: "apd-runway-label",
    type: "symbol",
    minzoom: 14,
    filter: ["all", isLine, cls("runway"), ["has", "ref"]],
    layout: {
      "symbol-placement": "line-center",
      "text-field": ["get", "ref"],
      "text-font": FONT,
      "text-size": 11,
      "text-offset": [0, -1],
    },
    paint: { "text-color": DIAGRAM.runwayLabel, "text-halo-color": HALO, "text-halo-width": 1.5 },
  });
  addLayerOnce(map, {
    ...base,
    id: "apd-gate-label",
    type: "symbol",
    minzoom: 15,
    filter: ["all", isPoint, cls("gate"), ["has", "ref"]],
    layout: {
      "text-field": gateRef,
      "text-font": FONT,
      "text-size": ["interpolate", ["linear"], ["zoom"], 15, 9, 18, 12],
      "text-offset": [0, 0.8],
      "text-anchor": "top",
      "text-padding": 1,
    },
    paint: { "text-color": DIAGRAM.gateLabel, "text-halo-color": HALO, "text-halo-width": 1.2 },
  });
}

function addOurAirportsLayers(map: maplibregl.Map) {
  addSourceOnce(map, THR_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  // runway fallback from OurAirports thresholds, drawn under the OSM runway so OSM wins where present
  const below = map.getLayer("apd-runway-edge") ? "apd-runway-edge" : undefined;
  addLayerOnce(map,
    {
      id: "apd-oa-runway",
      type: "line",
      source: THR_SOURCE,
      minzoom: 11,
      filter: isLine,
      paint: { "line-color": ["case", ["get", "grass"], DIAGRAM.grassRunway, RUNWAY], "line-width": realWidth(["get", "w10"], 1) },
    },
    below,
  );
  addLayerOnce(map, {
    id: "apd-oa-designator",
    type: "symbol",
    source: THR_SOURCE,
    minzoom: 12,
    filter: isPoint,
    layout: {
      "text-field": ["get", "ident"],
      "text-font": FONT_BOLD,
      "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 16, 14],
      "text-rotate": ["get", "rotate"],
      "text-rotation-alignment": "map",
      "text-pitch-alignment": "map",
      "text-allow-overlap": true,
      "text-ignore-placement": false,
    },
    paint: { "text-color": DIAGRAM.designator, "text-halo-color": HALO, "text-halo-width": 1.5 },
  });
}

/** Offset a point by a distance (m) along a true bearing — fine for a few hundred metres. */
function offset(lat: number, lon: number, bearingDeg: number, meters: number): [number, number] {
  const b = (bearingDeg * Math.PI) / 180;
  const dLat = (meters * Math.cos(b)) / 111_320;
  const dLon = (meters * Math.sin(b)) / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lon + dLon, lat + dLat];
}

function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Designator points just behind each threshold (rotated to read on approach) and a runway
 * line between the thresholds as a fallback where OSM has no runway.
 */
export function runwaysGeoJson(runways: Runway[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const r of runways) {
    const { leLatitude: la, leLongitude: lo, heLatitude: ha, heLongitude: ho } = r;
    if (!finite(la) || !finite(lo) || !finite(ha) || !finite(ho)) continue;
    if (la === ha && lo === ho) continue;
    const leHdg = finite(r.leHeadingDeg) ? r.leHeadingDeg : bearing(la, lo, ha, ho);
    const heHdg = finite(r.heHeadingDeg) ? r.heHeadingDeg : (leHdg + 180) % 360;
    const widthM = finite(r.widthFt) && r.widthFt > 0 ? r.widthFt * FT_TO_M : 30;
    features.push({
      type: "Feature",
      properties: { w10: pxAtZ10(widthM, la), grass: /^(GRS|GRASS|TURF|GRE|GRV|DIRT|SAND)/i.test(r.surface ?? "") },
      geometry: { type: "LineString", coordinates: [[lo, la], [ho, ha]] },
    });
    // ~120 m inside the threshold, like the painted numbers
    if (r.leIdent) features.push(designator(r.leIdent, offset(la, lo, leHdg, 120), leHdg));
    if (r.heIdent) features.push(designator(r.heIdent, offset(ha, ho, heHdg, 120), heHdg));
  }
  return { type: "FeatureCollection", features };
}

function designator(ident: string, at: [number, number], hdg: number): GeoJSON.Feature {
  return { type: "Feature", properties: { ident, rotate: hdg }, geometry: { type: "Point", coordinates: at } };
}
