// Map layers of the flight-path markers (../trackEvents.ts) on the logbook track map: one
// symbol layer (icon always, label from LABEL_ZOOM, collision-avoiding with the label dropped
// before the icon) and one line layer for exceedance runs. Icons are small badges drawn on a
// canvas in the active theme's colours (re-added on every style load, like the other layers).
// Colours: configuration (gear, flaps) and a normal rotation neutral, a slow / fast rotation
// warn, assessment ok / warn / err;
// touchdowns keep the existing yellow dot. No purple / violet / magenta.

import type * as maplibregl from "maplibre-gl";
import { COLOR, TRACK_MARKER } from "../theme";
import type { TrackSample } from "../types";
import { trackEventLabel, type TrackEvent, type TrackEventFilter, type TrackEventTone } from "../trackEvents";
import { addLayerOnce, addSourceOnce } from "./styleOnce";
import { unwrapPath } from "./geo";

export const EVENTS_SOURCE = "track-events";
export const EVENTS_LAYER = "track-events";
export const RUNS_LAYER = "track-events-run";
/** Labels from this zoom (icons always). */
export const LABEL_ZOOM = 10;
/** Flap badges drawn up to this index. */
const MAX_FLAPS = 10;
const RATIO = 2;

const toneFill = (tone: TrackEventTone): string =>
  tone === "accent" ? COLOR.accent : tone === "ok" ? COLOR.ok : tone === "warn" ? COLOR.warn : tone === "err" ? COLOR.err : COLOR.text;

/** Black or white glyph, whichever reads better on `hex`. */
function glyphOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.55 ? "#0b1018" : "#ffffff";
}

type Shape = "pill" | "diamond" | "triangle" | "dot";

/** `arrow`: a small drawn triangle after the text (gear up / down; font arrows read as "1"). */
function badge(text: string, fill: string, shape: Shape, arrow?: "up" | "down"): ImageData | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const font = `700 ${10 * RATIO}px system-ui, "Segoe UI", sans-serif`;
  ctx.font = font;
  const aw = arrow ? 7 * RATIO : 0;
  const tw = (text ? ctx.measureText(text).width : 0) + aw;
  const h = (shape === "pill" ? 16 : shape === "dot" ? 12 : 18) * RATIO;
  const w = shape === "pill" ? Math.max(h, Math.ceil(tw + 9 * RATIO)) : h;
  c.width = w;
  c.height = h;
  ctx.font = font;
  const s = 1.5 * RATIO;
  ctx.beginPath();
  if (shape === "pill") {
    const r = h / 2 - s;
    ctx.roundRect(s, s, w - 2 * s, h - 2 * s, r);
  } else if (shape === "diamond") {
    ctx.moveTo(w / 2, s);
    ctx.lineTo(w - s, h / 2);
    ctx.lineTo(w / 2, h - s);
    ctx.lineTo(s, h / 2);
    ctx.closePath();
  } else if (shape === "triangle") {
    ctx.moveTo(w / 2, s);
    ctx.lineTo(w - s, h - s);
    ctx.lineTo(s, h - s);
    ctx.closePath();
  } else {
    ctx.arc(w / 2, h / 2, h / 2 - s, 0, Math.PI * 2);
  }
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = s;
  ctx.strokeStyle = COLOR.halo;
  ctx.stroke();
  if (text) {
    ctx.fillStyle = glyphOn(fill);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, w / 2 - aw / 2, h / 2 + (shape === "triangle" ? 2.5 * RATIO : 0.5 * RATIO));
  }
  if (arrow) {
    const cx = w / 2 + (tw - aw) / 2 + aw / 2;
    const a = 3 * RATIO;
    const dir = arrow === "down" ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(cx - a, h / 2 - dir * a * 0.6);
    ctx.lineTo(cx + a, h / 2 - dir * a * 0.6);
    ctx.lineTo(cx, h / 2 + dir * a * 0.9);
    ctx.closePath();
    ctx.fillStyle = glyphOn(fill);
    ctx.fill();
  }
  return ctx.getImageData(0, 0, w, h);
}

/** Icon id of an event (images below). */
export function iconOf(e: TrackEvent): string {
  switch (e.kind) {
    case "gearDown":
      return "te-gear-down";
    case "gearUp":
      return "te-gear-up";
    case "flaps":
      return `te-flaps-${Math.max(0, Math.min(MAX_FLAPS, e.flapsTo ?? 0))}`;
    case "rotation":
      return e.tone === "warn" ? "te-rotation-warn" : "te-rotation";
    case "gate":
      return e.gate?.stable ? "te-gate-ok" : e.gate?.stable === false ? "te-gate-err" : "te-gate-na";
    case "exceedance":
      return e.tone === "err" ? "te-exc-err" : "te-exc-warn";
    case "stableFrom":
      return "te-stable";
    case "goAround":
      return "te-ga";
    case "touchdown":
      return "te-touchdown";
  }
}

function images(): Array<[string, ImageData | null]> {
  const n = toneFill("neutral");
  const list: Array<[string, ImageData | null]> = [
    ["te-gear-down", badge("G", n, "pill", "down")],
    ["te-gear-up", badge("G", n, "pill", "up")],
    ["te-rotation", badge("R", n, "pill")],
    ["te-rotation-warn", badge("R", toneFill("warn"), "pill")],
    ["te-gate-ok", badge("✓", toneFill("ok"), "diamond")],
    ["te-gate-err", badge("✕", toneFill("err"), "diamond")],
    ["te-gate-na", badge("?", COLOR.textMuted, "diamond")],
    ["te-exc-warn", badge("!", toneFill("warn"), "triangle")],
    ["te-exc-err", badge("!", toneFill("err"), "triangle")],
    ["te-stable", badge("S", toneFill("ok"), "pill")],
    ["te-ga", badge("GA", toneFill("warn"), "pill")],
    ["te-touchdown", badge("", TRACK_MARKER.touchdown, "dot")],
  ];
  for (let f = 0; f <= MAX_FLAPS; f++) list.push([`te-flaps-${f}`, badge(`F${f}`, n, "pill")]);
  return list;
}

/** Label priority (lower = placed first). */
const PRIORITY: Record<TrackEvent["kind"], number> = { exceedance: 0, gate: 1, goAround: 1, stableFrom: 2, rotation: 2, touchdown: 2, gearDown: 3, gearUp: 3, flaps: 4 };

/** Adds (or refreshes after a theme change) the images, the source and both layers. */
export function addTrackEventLayers(map: maplibregl.Map) {
  for (const [id, img] of images()) {
    if (!img) continue;
    if (map.hasImage(id)) map.removeImage(id);
    map.addImage(id, img, { pixelRatio: RATIO });
  }
  addSourceOnce(map, EVENTS_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  addLayerOnce(map, {
    id: RUNS_LAYER,
    type: "line",
    source: EVENTS_SOURCE,
    filter: ["==", ["geometry-type"], "LineString"],
    paint: {
      "line-color": ["match", ["get", "tone"], "err", COLOR.err, COLOR.warn],
      "line-width": 6,
      "line-opacity": 0.9,
    },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  addLayerOnce(map, {
    id: EVENTS_LAYER,
    type: "symbol",
    source: EVENTS_SOURCE,
    filter: ["==", ["geometry-type"], "Point"],
    layout: {
      "icon-image": ["get", "icon"],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "symbol-sort-key": ["get", "prio"],
      "text-field": ["step", ["zoom"], "", LABEL_ZOOM, ["get", "label"]],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-variable-anchor": ["left", "right", "top", "bottom"],
      "text-radial-offset": 1.1,
      "text-justify": "auto",
      "text-optional": true,
      "text-allow-overlap": false,
      "text-max-width": 14,
    },
    paint: { "text-color": COLOR.text, "text-halo-color": COLOR.halo, "text-halo-width": 1.4 },
  });
}

/** Points (and run lines) of the events; `filter` hides whole groups. */
export function trackEventsGeoJson(events: readonly TrackEvent[], samples: readonly TrackSample[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const e of events) {
    const props = { id: e.id, group: e.group, tone: e.tone, tMs: e.tMs };
    if (e.endTMs != null) {
      // unwrapped across ±180 (a run over the antimeridian takes the short way, not around the world)
      const coords = unwrapPath(samples.filter((s) => s.tMs >= e.tMs && s.tMs <= e.endTMs!).map((s) => [s.longitude, s.latitude] as [number, number]));
      if (coords.length >= 2) features.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } });
    }
    features.push({
      type: "Feature",
      properties: { ...props, icon: iconOf(e), label: trackEventLabel(e), prio: PRIORITY[e.kind] },
      geometry: { type: "Point", coordinates: [e.longitude, e.latitude] },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Layer filter expression for the enabled groups. */
export function groupFilter(f: TrackEventFilter, geometry: "Point" | "LineString"): maplibregl.FilterSpecification {
  const on = (Object.keys(f) as Array<keyof TrackEventFilter>).filter((g) => f[g]);
  return ["all", ["==", ["geometry-type"], geometry], ["in", ["get", "group"], ["literal", on]]];
}

export function applyTrackEventFilter(map: maplibregl.Map, f: TrackEventFilter) {
  if (map.getLayer(EVENTS_LAYER)) map.setFilter(EVENTS_LAYER, groupFilter(f, "Point"));
  if (map.getLayer(RUNS_LAYER)) map.setFilter(RUNS_LAYER, groupFilter(f, "LineString"));
}
