// MapLibre layers for online traffic (VATSIM and IVAO pilots), ATC at airports and METAR badges.
//
// All three are plain GeoJSON sources refreshed from cached backend snapshots, so
// panning only re-filters data in Rust; nothing here talks to the network directly.
// Both networks share one source per layer (ids still say "vatsim-" for history); every
// feature carries `network`, which picks the IVAO symbol (accent outline) and label colour.

import * as maplibregl from "maplibre-gl";
import type { Airport, Controller, Facility, LocatedController, Metar, Network, Pilot } from "../types";
import { fmtMetarLine, fmtWind } from "../i18n/number";
import { CATEGORY_COLOR, COLOR, FACILITY_COLOR } from "../theme";
import { pointFeature } from "./common";
import { addLayerOnce, addSourceOnce } from "./styleOnce";
import { WAKE_LABEL, WAKE_SIZE, iconSizeByZoom, loadAircraftIcons, trafficColors, wakeCategory } from "./aircraftIcons";

export type OnlineLayerGroup = "traffic" | "atc" | "weather";

export const LAYER_GROUPS: Record<OnlineLayerGroup, string[]> = {
  traffic: ["vatsim-pilots", "vatsim-pilots-label", "traffic-3d-sym", "traffic-3d-sel-sym", "traffic-selected", "traffic-route-casing", "traffic-route-line"],
  atc: ["vatsim-atc-dot", "vatsim-atc-label"],
  weather: ["metar-ring"],
};

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export const NETWORK_LABEL: Record<Network, string> = { vatsim: "VATSIM", ivao: "IVAO" };


/** Network data is user-supplied text; never put it into popup HTML unescaped. */
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const FACILITY_ORDER: Facility[] = ["del", "gnd", "twr", "app", "atis", "ctr", "fss"];
export const FACILITY_LABEL: Record<Facility, string> = {
  del: "DEL",
  gnd: "GND",
  twr: "TWR",
  app: "APP",
  atis: "ATIS",
  ctr: "CTR",
  fss: "FSS",
};

/** Traffic symbol opacity: 0.65 up to zoom 7, full from zoom 9 (the own aircraft stays opaque). */
export const TRAFFIC_OPACITY_BY_ZOOM: maplibregl.ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 7, 0.65, 9, 1];

/**
 * Layers are inserted below `before` (the own-aircraft layer) so the user's plane stays on top.
 * `isCurrent`: false once the style was replaced while the icons loaded – then nothing is added
 * (the newer style load adds its own); the result says whether the layers were added.
 */
export async function addOnlineLayers(map: maplibregl.Map, before?: string, isCurrent: () => boolean = () => true): Promise<boolean> {
  await loadAircraftIcons(map);
  if (!isCurrent()) return false;
  const labels = trafficColors();

  addSourceOnce(map, "metars", { type: "geojson", data: EMPTY });
  addLayerOnce(map,
    {
      id: "metar-ring",
      type: "circle",
      source: "metars",
      minzoom: 7,
      paint: {
        "circle-radius": 8,
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": ["get", "color"],
        "circle-stroke-width": 2.5,
        "circle-stroke-opacity": 0.9,
      },
    },
    before,
  );

  addSourceOnce(map, "vatsim-atc", { type: "geojson", data: EMPTY });
  addLayerOnce(map,
    {
      id: "vatsim-atc-dot",
      type: "circle",
      source: "vatsim-atc",
      paint: {
        "circle-radius": 5,
        "circle-color": ["get", "color"],
        // IVAO (or both networks) at this airport: accent ring, like the IVAO aircraft outline
        "circle-stroke-color": ["match", ["get", "net"], "vatsim", COLOR.halo, COLOR.accent],
        "circle-stroke-width": ["match", ["get", "net"], "vatsim", 1.5, 2],
        "circle-translate": [0, -12],
      },
    },
    before,
  );
  addLayerOnce(map,
    {
      id: "vatsim-atc-label",
      type: "symbol",
      source: "vatsim-atc",
      minzoom: 5,
      layout: {
        "text-field": ["get", "letters"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 10,
        "text-offset": [0, -2.1],
        "text-anchor": "bottom",
        "text-allow-overlap": false,
      },
      paint: { "text-color": ["get", "color"], "text-halo-color": COLOR.halo, "text-halo-width": 1.2 },
    },
    before,
  );

  addSourceOnce(map, "vatsim-pilots", { type: "geojson", data: EMPTY });
  addLayerOnce(map,
    {
      id: "vatsim-pilots",
      type: "symbol",
      source: "vatsim-pilots",
      layout: {
        "icon-image": ["concat", ["match", ["get", "network"], "ivao", "ac-ivao-", "ac-traffic-"], ["coalesce", ["get", "cat"], "medium"]],
        // a step smaller than the own aircraft (iconSizeExpr(1.3), LiveMap) at every zoom, so the
        // own plane stays the biggest symbol at a busy hub
        "icon-size": iconSizeByZoom([
          [3, 0.55],
          [8, 0.85],
          [12, 1.05],
        ]),
        "icon-rotate": ["get", "heading"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      // zoomed out (a hub is a cluster of symbols) the traffic steps back so the own aircraft pops out
      paint: { "icon-opacity": TRAFFIC_OPACITY_BY_ZOOM },
    },
    before,
  );
  addLayerOnce(map,
    {
      id: "vatsim-pilots-label",
      type: "symbol",
      source: "vatsim-pilots",
      minzoom: 6,
      layout: {
        "text-field": ["get", "callsign"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 10,
        "text-offset": [0, 1.2],
        "text-anchor": "top",
        "text-optional": true,
      },
      // light themes: darker label colours (>= 4.5:1 on the land colour, aircraftIcons.trafficColors)
      paint: {
        "text-color": ["match", ["get", "network"], "ivao", labels.ivaoLabel, labels.label],
        "text-halo-color": COLOR.halo,
        "text-halo-width": 1.4,
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.8, 9, 1],
      },
    },
    before,
  );
  // 3D view from zoom 8: callsign and click target of the aircraft drawn as models
  // (trafficModel.ts), raised to the model's height; the icon itself is invisible
  addSourceOnce(map, "traffic-3d", { type: "geojson", data: EMPTY });
  addLayerOnce(map,
    {
      id: "traffic-3d-sym",
      type: "symbol",
      source: "traffic-3d",
      layout: {
        "icon-image": ["concat", "ac-traffic-", ["coalesce", ["get", "cat"], "medium"]],
        "icon-size": ["*", ["coalesce", ["get", "sizeFactor"], 1.3], 0.9],
        "icon-rotate": ["get", "heading"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "symbol-height-offset": ["coalesce", ["get", "hM"], 0],
        "text-field": ["get", "callsign"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 10,
        "text-offset": [0, -1.5],
        "text-anchor": "bottom",
        "text-optional": true,
      },
      paint: {
        "icon-opacity": 0,
        "text-color": ["match", ["get", "network"], "ivao", labels.ivaoLabel, labels.label],
        "text-halo-color": COLOR.halo,
        "text-halo-width": 1.4,
      },
    },
    before,
  );
  // the selected aircraft's callsign and click target in 3D: its own one-feature source, fed
  // ~10× a second so the label stays on the moving model (the source above changes once a second;
  // re-sending 200 labels that often restarted their placement and made them flicker)
  addSourceOnce(map, "traffic-3d-sel", { type: "geojson", data: EMPTY });
  addLayerOnce(map,
    {
      id: "traffic-3d-sel-sym",
      type: "symbol",
      source: "traffic-3d-sel",
      layout: {
        "icon-image": ["concat", "ac-traffic-", ["coalesce", ["get", "cat"], "medium"]],
        "icon-size": ["*", ["coalesce", ["get", "sizeFactor"], 1.3], 0.9],
        "icon-rotate": ["get", "heading"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "symbol-height-offset": ["coalesce", ["get", "hM"], 0],
        "text-field": ["get", "callsign"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 10,
        "text-offset": [0, -1.5],
        "text-anchor": "bottom",
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "icon-opacity": 0,
        "text-color": COLOR.accent,
        "text-halo-color": COLOR.halo,
        "text-halo-width": 1.4,
      },
    },
    before,
  );
  // the selected aircraft's planned great circle (TrafficCard "Route zeigen"): above the traffic
  // symbols, so a busy hub does not hide it, with a halo so it reads over the aircraft
  addSourceOnce(map, "traffic-route", { type: "geojson", data: EMPTY });
  addLayerOnce(map,
    {
      id: "traffic-route-casing",
      type: "line",
      source: "traffic-route",
      layout: { "line-cap": "round" },
      paint: { "line-color": COLOR.halo, "line-width": 4.5, "line-opacity": 0.7 },
    },
    before,
  );
  addLayerOnce(map,
    {
      id: "traffic-route-line",
      type: "line",
      source: "traffic-route",
      layout: { "line-cap": "round" },
      paint: { "line-color": COLOR.accent, "line-width": 2, "line-opacity": 0.9, "line-dasharray": [2, 2] },
    },
    before,
  );
  // outline ring around the selected aircraft (TrafficCard); above the traffic, below the own plane
  addSourceOnce(map, "traffic-selected", { type: "geojson", data: EMPTY });
  addLayerOnce(map,
    {
      id: "traffic-selected",
      type: "circle",
      source: "traffic-selected",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 11, 8, 17, 12, 21],
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": COLOR.accent,
        "circle-stroke-width": 2.5,
        "circle-pitch-alignment": "map",
      },
    },
    before,
  );

  attachPopups(map);
  return true;
}

export function setGroupVisible(map: maplibregl.Map, group: OnlineLayerGroup, visible: boolean) {
  for (const id of LAYER_GROUPS[group]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }
}

/**
 * Cheap content key for a FeatureCollection (length + FNV-1a over its JSON). Lets callers skip
 * `setData` – and the worker's re-tiling – when a poll or a pan yields the same features.
 */
export function geoJsonKey(fc: GeoJSON.FeatureCollection): string {
  const json = JSON.stringify(fc.features);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${fc.features.length}:${json.length}:${(h >>> 0).toString(36)}`;
}

export function pilotsGeoJson(pilots: Pilot[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: pilots.map((p) =>
      pointFeature(p.longitude, p.latitude, {
        network: p.network ?? "vatsim",
        // network:cid – the 3D view filters the aircraft drawn as models out of the 2D layers
        key: `${p.network ?? "vatsim"}:${p.cid}`,
        cid: p.cid,
        callsign: p.callsign,
        cat: wakeCategory(p.aircraftShort),
        catLabel: WAKE_LABEL[wakeCategory(p.aircraftShort)],
        sizeFactor: WAKE_SIZE[wakeCategory(p.aircraftShort)],
        heading: p.headingDeg,
        alt: p.altitudeFt,
        gs: p.groundSpeedKt,
        type: p.aircraftShort,
        dep: p.departure,
        arr: p.arrival,
        ground: p.onGround === true,
      }),
    ),
  };
}

/** Which networks staff these stations: "vatsim", "ivao" or "both". */
export function networksOf(list: Array<Pick<Controller, "network">>): Network | "both" {
  const nets = new Set(list.map((c) => c.network ?? "vatsim"));
  return nets.size > 1 ? "both" : ([...nets][0] ?? "vatsim");
}

/** One feature per airport; the dot takes the colour of its highest-ranking position. */
export function atcGeoJson(controllers: LocatedController[]): GeoJSON.FeatureCollection {
  const byAirport = new Map<string, LocatedController[]>();
  for (const c of controllers) {
    const list = byAirport.get(c.airport) ?? [];
    list.push(c);
    byAirport.set(c.airport, list);
  }
  const features: GeoJSON.Feature[] = [];
  for (const [airport, list] of byAirport) {
    list.sort((a, b) => FACILITY_ORDER.indexOf(a.facility) - FACILITY_ORDER.indexOf(b.facility));
    const facilities = [...new Set(list.map((c) => c.facility))];
    const top = (["app", "twr", "gnd", "del", "atis"] as Facility[]).find((f) => facilities.includes(f)) ?? "atis";
    features.push(
      pointFeature(list[0].longitude, list[0].latitude, {
        airport,
        letters: facilities.map((f) => (f === "atis" ? "A" : FACILITY_LABEL[f][0])).join(" "),
        color: (FACILITY_COLOR as Partial<Record<Facility, string>>)[top] ?? COLOR.textMuted,
        net: networksOf(list),
        stations: JSON.stringify(
          list.map((c) => ({ network: c.network ?? "vatsim", callsign: c.callsign, frequency: c.frequency, facility: c.facility, atisCode: c.atisCode })),
        ),
      }),
    );
  }
  return { type: "FeatureCollection", features };
}

export function metarsGeoJson(metars: Metar[], airports: Map<string, Airport>): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const m of metars) {
    const a = airports.get(m.station);
    if (!a) continue;
    features.push(
      pointFeature(a.longitude, a.latitude, {
        station: m.station,
        category: m.category,
        color: CATEGORY_COLOR[m.category],
        wind: fmtWind(m.wind),
        line: fmtMetarLine(m),
        raw: m.raw,
      }),
    );
  }
  return { type: "FeatureCollection", features };
}

export function fmtController(c: Pick<Controller, "callsign" | "frequency" | "facility" | "atisCode">): string {
  return `${c.callsign}${c.atisCode ? ` (${c.atisCode})` : ""} ${c.frequency}`;
}

/** What a click on a traffic aircraft reports (feature properties of `vatsim-pilots`). */
export interface PilotClick {
  network: Network;
  cid: number;
  lon: number;
  lat: number;
}

/** Layer-bound handlers survive setStyle (theme change), so they are attached once per map. */
const withPopups = new WeakSet<maplibregl.Map>();
const pilotClick = new WeakMap<maplibregl.Map, (c: PilotClick) => void>();

/** Where a click on an online aircraft goes (LiveMap opens the traffic card). */
export function onPilotClick(map: maplibregl.Map, handler: (c: PilotClick) => void) {
  pilotClick.set(map, handler);
}

/** Ring source data for the selected aircraft (empty when none). */
export function selectedGeoJson(pos: { lon: number; lat: number } | null): GeoJSON.FeatureCollection {
  return pos ? { type: "FeatureCollection", features: [pointFeature(pos.lon, pos.lat)] } : EMPTY;
}

/** Route source data: one dashed line (great circle points as [lon, lat]). */
export function routeLineGeoJson(points: Array<[number, number]> | null): GeoJSON.FeatureCollection {
  if (!points || points.length < 2) return EMPTY;
  return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: points } }] };
}

function attachPopups(map: maplibregl.Map) {
  if (withPopups.has(map)) return;
  withPopups.add(map);
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "online-popup", offset: 12 });
  const hover = (layer: string, html: (p: Record<string, unknown>) => string) => {
    map.on("mouseenter", layer, (e) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      map.getCanvas().style.cursor = "pointer";
      popup
        .setLngLat(f.geometry.coordinates as [number, number])
        .setHTML(html(f.properties ?? {}))
        .addTo(map);
    });
    map.on("mouseleave", layer, () => {
      map.getCanvas().style.cursor = "";
      popup.remove();
    });
  };

  // aircraft: no popup – a click opens the traffic card (TrafficCard via onPilotClick);
  // in 3D the invisible symbol at the model's height is the click target
  for (const layer of ["vatsim-pilots", "traffic-3d-sym", "traffic-3d-sel-sym"]) {
    map.on("mouseenter", layer, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layer, () => {
      map.getCanvas().style.cursor = "";
    });
    map.on("click", layer, (e) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      const p = f.properties ?? {};
      const cid = Number(p.cid);
      if (!Number.isFinite(cid)) return;
      const [lon, lat] = f.geometry.coordinates as [number, number];
      pilotClick.get(map)?.({ network: p.network === "ivao" ? "ivao" : "vatsim", cid, lon, lat });
    });
  }

  hover("vatsim-atc-dot", (p) => {
    let stations: Array<Pick<Controller, "network" | "callsign" | "frequency" | "facility" | "atisCode">> = [];
    try {
      // stored as a JSON string; MapLibre 6 keeps nested values as objects, so accept both
      stations = Array.isArray(p.stations) ? p.stations : JSON.parse(String(p.stations));
    } catch {
      /* malformed property: show the airport only */
    }
    const station = (s: (typeof stations)[number]) =>
      `<div>${esc(fmtController(s))} <span class="muted">${esc(NETWORK_LABEL[s.network] ?? NETWORK_LABEL.vatsim)}</span></div>`;
    return `<strong>${esc(p.airport)}</strong>${stations.map(station).join("")}`;
  });

  hover("metar-ring", (p) => `<strong>${esc(p.station)}</strong> <span class="muted">${esc(p.category)}</span>
    <div>${esc(p.line)}</div><div class="muted raw">${esc(p.raw)}</div>`);
}
