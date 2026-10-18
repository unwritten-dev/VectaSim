// MapLibre layers for online traffic (VATSIM pilots), ATC at airports and METAR badges.
//
// All three are plain GeoJSON sources refreshed from cached backend snapshots, so
// panning only re-filters data in Rust; nothing here talks to the network directly.

import * as maplibregl from "maplibre-gl";
import type { Airport, Controller, Facility, LocatedController, Metar, Pilot } from "../types";
import { fmt, fmtAltitude, fmtMetarLine, fmtWind } from "../format";
import { CATEGORY_COLOR, COLOR, FACILITY_COLOR, TRAFFIC } from "../theme";
import { pointFeature } from "./common";
import { WAKE_LABEL, WAKE_SIZE, iconSizeByZoom, loadAircraftIcons, wakeCategory } from "./aircraftIcons";

export type OnlineLayerGroup = "traffic" | "atc" | "weather";

export const LAYER_GROUPS: Record<OnlineLayerGroup, string[]> = {
  traffic: ["vatsim-pilots", "vatsim-pilots-label"],
  atc: ["vatsim-atc-dot", "vatsim-atc-label"],
  weather: ["metar-ring"],
};

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };


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

/** Layers are inserted below `before` (the own-aircraft layer) so the user's plane stays on top. */
export async function addOnlineLayers(map: maplibregl.Map, before?: string) {
  await loadAircraftIcons(map);

  map.addSource("metars", { type: "geojson", data: EMPTY });
  map.addLayer(
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

  map.addSource("vatsim-atc", { type: "geojson", data: EMPTY });
  map.addLayer(
    {
      id: "vatsim-atc-dot",
      type: "circle",
      source: "vatsim-atc",
      paint: {
        "circle-radius": 5,
        "circle-color": ["get", "color"],
        "circle-stroke-color": COLOR.halo,
        "circle-stroke-width": 1.5,
        "circle-translate": [0, -12],
      },
    },
    before,
  );
  map.addLayer(
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

  map.addSource("vatsim-pilots", { type: "geojson", data: EMPTY });
  map.addLayer(
    {
      id: "vatsim-pilots",
      type: "symbol",
      source: "vatsim-pilots",
      layout: {
        "icon-image": ["concat", "ac-traffic-", ["coalesce", ["get", "cat"], "medium"]],
        "icon-size": iconSizeByZoom([
          [3, 0.6],
          [8, 1.0],
          [12, 1.25],
        ]),
        "icon-rotate": ["get", "heading"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    },
    before,
  );
  map.addLayer(
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
      paint: { "text-color": TRAFFIC, "text-halo-color": COLOR.halo, "text-halo-width": 1.2 },
    },
    before,
  );

  attachPopups(map);
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
      }),
    ),
  };
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
        stations: JSON.stringify(list.map((c) => ({ callsign: c.callsign, frequency: c.frequency, facility: c.facility, atisCode: c.atisCode }))),
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

/** Layer-bound handlers survive setStyle (theme change), so they are attached once per map. */
const withPopups = new WeakSet<maplibregl.Map>();

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

  hover("vatsim-pilots", (p) => {
    const route = p.dep || p.arr ? `<div>${esc(p.dep || "?")} → ${esc(p.arr || "?")}</div>` : "<div class='muted'>kein Flugplan</div>";
    return `<strong>${esc(p.callsign)}</strong> <span class="muted">${esc(p.type || "")}</span>
      <div>${esc(fmtAltitude(Number(p.alt)))} · GS ${esc(fmt(Number(p.gs), 0, "kt"))}</div>${route}`;
  });

  hover("vatsim-atc-dot", (p) => {
    let stations: Array<Pick<Controller, "callsign" | "frequency" | "facility" | "atisCode">> = [];
    try {
      // stored as a JSON string; MapLibre 6 keeps nested values as objects, so accept both
      stations = Array.isArray(p.stations) ? p.stations : JSON.parse(String(p.stations));
    } catch {
      /* malformed property: show the airport only */
    }
    return `<strong>${esc(p.airport)}</strong>${stations.map((s) => `<div>${esc(fmtController(s))}</div>`).join("")}`;
  });

  hover("metar-ring", (p) => `<strong>${esc(p.station)}</strong> <span class="muted">${esc(p.category)}</span>
    <div>${esc(p.line)}</div><div class="muted raw">${esc(p.raw)}</div>`);
}
