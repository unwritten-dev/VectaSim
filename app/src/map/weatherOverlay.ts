// Live weather overlay on the live map: precipitation radar and clouds (satellite infrared),
// under the track, the airports and the aircraft, over the basemap (vector or imagery).
//
// Sources (no API key; see THIRD-PARTY-NOTICES.md):
// - Radar: RainViewer public API – the newest frame from weather-maps.json, tiles up to
//   zoom 7 (the free limit; closer in MapLibre overscales). Free for personal use, credited
//   in the map attribution.
// - Clouds: EUMETSAT EUMETView WMS, IR 10.8 µm: the geostationary ring (worldwide, 3-hourly)
//   with Meteosat 0° and Indian Ocean on top (hourly). Free and unrestricted (CC BY 4.0).
//   The grey IR image is turned into white (dark themes) or slate (light themes) clouds whose
//   opacity follows the brightness – cold, high cloud tops opaque, warm ground transparent.
//
// Both refresh every 10 minutes while shown; nothing is fetched while they are off. Failed
// tiles come back empty (never as map errors, which would raise the "offline" hint), and
// the legend says what is missing.

import { useSyncExternalStore } from "react";
import * as maplibregl from "maplibre-gl";
import { getMapTheme } from "../theme";

export type WeatherKind = "radar" | "clouds";
export interface WeatherPrefs {
  /** METAR rings at the airports (LiveMap, online.ts). */
  metar: boolean;
  radar: boolean;
  clouds: boolean;
}

export const WEATHER_STORAGE_KEY = "vectasim.weatherLayers";
/** Fired on window when the sub-choice (METAR / Radar / Wolken) or the frames change. */
export const WEATHER_EVENT = "vectasim:weather";
export const WEATHER_REFRESH_MS = 10 * 60_000;
export const WEATHER_OPACITY = 0.6;
/** Clouds carry their own alpha (brightness); a little more, so they still read over the imagery. */
export const CLOUDS_OPACITY = 0.75;

export const RADAR_INDEX_URL = "https://api.rainviewer.com/public/weather-maps.json";
/** RainViewer serves radar tiles up to zoom 7 only. */
export const RADAR_MAX_ZOOM = 7;
/** Colour scheme 2 ("Universal Blue", the one left in the free API), smoothed, snow shown. */
const RADAR_COLOR = 2;
const RADAR_OPTIONS = "1_1";
export const RADAR_ATTRIBUTION = '<a href="https://www.rainviewer.com/api.html" target="_blank" rel="noopener">RainViewer</a>';

export const CLOUDS_WMS = "https://view.eumetsat.int/geoserver/wms";
/** Bottom to top: worldwide ring, then the hourly Meteosat discs over Africa/Europe and the Indian Ocean. */
export const CLOUDS_LAYERS = ["mumi:worldcloudmap_ir108", "msg_iodc:ir108", "msg_fes:ir108"];
/** The small per-layer capabilities (≈ 7 kB) that name the newest Meteosat 0° image. */
export const CLOUDS_TIME_URL = "https://view.eumetsat.int/geoserver/msg_fes/ir108/ows?service=WMS&version=1.3.0&request=GetCapabilities";
/** SEVIRI pixels are 3–5 km: zoom 6 is plenty, closer in MapLibre overscales. */
export const CLOUDS_MAX_ZOOM = 6;
export const CLOUDS_ATTRIBUTION = '<a href="https://view.eumetsat.int" target="_blank" rel="noopener">Contains modified EUMETSAT Meteosat data</a>';

/** MapLibre protocols: the handlers fetch the https URL behind them (radar as is, clouds recoloured). */
export const RADAR_PROTOCOL = "vectasim-radar";
export const CLOUDS_PROTOCOL = "vectasim-clouds";

const SOURCE: Record<WeatherKind, string> = { radar: "vectasim-wx-radar", clouds: "vectasim-wx-clouds" };

// ---- preferences ------------------------------------------------------------------------

export const DEFAULT_WEATHER: WeatherPrefs = { metar: true, radar: false, clouds: false };

export function loadWeatherPrefs(): WeatherPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(WEATHER_STORAGE_KEY) ?? "{}") as Partial<Record<keyof WeatherPrefs, unknown>>;
    const pick = (k: keyof WeatherPrefs) => (typeof raw[k] === "boolean" ? (raw[k] as boolean) : DEFAULT_WEATHER[k]);
    return { metar: pick("metar"), radar: pick("radar"), clouds: pick("clouds") };
  } catch {
    return { ...DEFAULT_WEATHER };
  }
}

export function saveWeatherPrefs(next: WeatherPrefs) {
  try {
    localStorage.setItem(WEATHER_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the choice still applies for this session */
  }
  state = { ...state, prefs: next };
  emit();
}

// ---- shared state (prefs, the "Wetter" master switch, newest frames) ----------------------

export interface Frame {
  /** Unix seconds of the image. */
  time: number;
  /** Tile URL template ({z}/{x}/{y} or {bbox-epsg-3857}), with the https scheme. */
  url: string;
}
export interface WeatherState {
  prefs: WeatherPrefs;
  /** "Wetter" in the toolbar (LiveMap's layer choice), mirrored by WeatherToggle. */
  master: boolean;
  frames: Record<WeatherKind, Frame | null>;
  /** The last refresh of this kind failed (shown in the legend). */
  failed: Record<WeatherKind, boolean>;
}

let state: WeatherState = {
  prefs: loadWeatherPrefs(),
  master: true,
  frames: { radar: null, clouds: null },
  failed: { radar: false, clouds: false },
};

function emit() {
  window.dispatchEvent(new Event(WEATHER_EVENT));
}

export function getWeatherState(): WeatherState {
  return state;
}

export function setWeatherMaster(on: boolean) {
  if (state.master === on) return;
  state = { ...state, master: on };
  emit();
}

function setFrame(kind: WeatherKind, frame: Frame | null, failed: boolean) {
  const old = state.frames[kind];
  if (old?.url === frame?.url && old?.time === frame?.time && state.failed[kind] === failed) return;
  state = { ...state, frames: { ...state.frames, [kind]: frame }, failed: { ...state.failed, [kind]: failed } };
  emit();
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(WEATHER_EVENT, cb);
  return () => window.removeEventListener(WEATHER_EVENT, cb);
}

/** Prefs, master switch and frames (re-renders on every change). */
export function useWeatherState(): WeatherState {
  return useSyncExternalStore(subscribe, getWeatherState, getWeatherState);
}

/** Is this overlay to be shown (and fetched)? */
export function weatherWanted(s: Pick<WeatherState, "prefs" | "master">, kind: WeatherKind): boolean {
  return s.master && s.prefs[kind];
}

// ---- URLs and parsing (pure) ------------------------------------------------------------

interface RainViewerIndex {
  host?: string;
  radar?: { past?: Array<{ time?: number; path?: string }> };
}

/** Newest radar frame of RainViewer's weather-maps.json, as a tile URL template; null if none. */
export function latestRadarFrame(index: RainViewerIndex | null | undefined): Frame | null {
  const host = index?.host;
  const past = (index?.radar?.past ?? []).filter((f) => typeof f.time === "number" && typeof f.path === "string" && f.path.startsWith("/"));
  if (!host || !/^https:\/\/[a-z0-9.-]+$/i.test(host) || !past.length) return null;
  const last = past.reduce((a, b) => ((b.time as number) > (a.time as number) ? b : a));
  return { time: last.time as number, url: radarTileUrl(host, last.path as string) };
}

export function radarTileUrl(host: string, path: string): string {
  return `${host}${path}/256/{z}/{x}/{y}/${RADAR_COLOR}/${RADAR_OPTIONS}.png`;
}

/** The default (newest) time of a WMS layer's capabilities, as Unix seconds; null if absent. */
export function wmsDefaultTime(capabilitiesXml: string): number | null {
  const m = /<Dimension[^>]*name="time"[^>]*default="([^"]+)"/i.exec(capabilitiesXml) ?? /<Dimension[^>]*default="([^"]+)"[^>]*name="time"/i.exec(capabilitiesXml);
  if (!m) return null;
  const ms = Date.parse(m[1]);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** WMS GetMap template for the cloud layers at a time (Unix seconds; null = the server's newest). */
export function cloudsTileUrl(time: number | null): string {
  const q = new URLSearchParams({
    service: "WMS",
    version: "1.3.0",
    request: "GetMap",
    layers: CLOUDS_LAYERS.join(","),
    styles: "",
    format: "image/png",
    transparent: "true",
    crs: "EPSG:3857",
    width: "256",
    height: "256",
  });
  if (time != null) q.set("time", new Date(time * 1000).toISOString().replace(".000Z", "Z"));
  // the bbox placeholder must stay unescaped for MapLibre
  return `${CLOUDS_WMS}?${q.toString()}&bbox={bbox-epsg-3857}`;
}

/** "13:40z" (UTC) for the legend. */
export function zuluLabel(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}z`;
}

/** The tile URL MapLibre gets: the https URL behind our protocol (clouds also carry the colour scheme). */
export function protocolUrl(kind: WeatherKind, httpsUrl: string, scheme: "dark" | "light" = "dark"): string {
  const rest = httpsUrl.replace(/^https:\/\//, "");
  return kind === "radar" ? `${RADAR_PROTOCOL}://${rest}` : `${CLOUDS_PROTOCOL}://${scheme}/${rest}`;
}

/** Back from a protocol URL to the https URL (and, for clouds, the colour scheme). */
export function fromProtocolUrl(url: string): { https: string; scheme: "dark" | "light" } {
  const rest = url.slice(url.indexOf("://") + 3);
  if (url.startsWith(`${CLOUDS_PROTOCOL}://`)) {
    const slash = rest.indexOf("/");
    const scheme = rest.slice(0, slash) === "light" ? "light" : "dark";
    return { https: `https://${rest.slice(slash + 1)}`, scheme };
  }
  return { https: `https://${rest}`, scheme: "dark" };
}

/**
 * Cloud opacity (0–255) for an IR grey value: warm ground and low cloud (dark) transparent,
 * cold high cloud tops (bright) opaque, a smooth ramp in between.
 */
export function cloudAlpha(grey: number, lo = 105, hi = 205): number {
  if (grey <= lo) return 0;
  if (grey >= hi) return 255;
  const x = (grey - lo) / (hi - lo);
  return Math.round(x * x * (3 - 2 * x) * 255);
}

/** Cloud colour per map scheme: white on the dark maps, slate on paper. */
export const CLOUD_RGB: Record<"dark" | "light", [number, number, number]> = { dark: [238, 242, 246], light: [84, 98, 116] };

/** Recolours an RGBA IR image in place into clouds (pure on the pixel array). */
export function irToClouds(px: Uint8ClampedArray, scheme: "dark" | "light") {
  const [r, g, b] = CLOUD_RGB[scheme];
  for (let i = 0; i < px.length; i += 4) {
    const grey = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const a = (px[i + 3] * cloudAlpha(grey)) / 255;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  }
}

// ---- tile protocols -----------------------------------------------------------------------

let emptyTile: Promise<ImageBitmap> | null = null;
/** A transparent tile: a missing radar/cloud tile is "no data", not a map error. */
function empty(): Promise<ImageBitmap> {
  emptyTile ??= createImageBitmap(new ImageData(1, 1));
  return emptyTile;
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

async function loadTile(url: string, abort: AbortController): Promise<{ data: ImageBitmap }> {
  const { https, scheme } = fromProtocolUrl(url);
  try {
    const r = await fetch(https, { signal: abort.signal });
    if (!r.ok) return { data: await empty() };
    const bitmap = await createImageBitmap(await r.blob());
    if (!url.startsWith(`${CLOUDS_PROTOCOL}://`)) return { data: bitmap };
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return { data: bitmap };
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    irToClouds(img.data, scheme);
    return { data: await createImageBitmap(img) };
  } catch (e) {
    if (isAbort(e)) throw e;
    // blocked, rate-limited, offline, undecodable: an empty tile, the legend shows the state
    return { data: await empty() };
  }
}

let protocolsAdded = false;
function addProtocols() {
  if (protocolsAdded) return;
  protocolsAdded = true;
  maplibregl.addProtocol(RADAR_PROTOCOL, (p, abort) => loadTile(p.url, abort));
  maplibregl.addProtocol(CLOUDS_PROTOCOL, (p, abort) => loadTile(p.url, abort));
}

// ---- frames -------------------------------------------------------------------------------

async function fetchRadarFrame(): Promise<Frame | null> {
  const r = await fetch(RADAR_INDEX_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return latestRadarFrame((await r.json()) as RainViewerIndex);
}

async function fetchCloudsFrame(): Promise<Frame> {
  const r = await fetch(CLOUDS_TIME_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const time = wmsDefaultTime(await r.text());
  if (time == null) throw new Error("no time");
  return { time, url: cloudsTileUrl(time) };
}

const FETCH: Record<WeatherKind, () => Promise<Frame | null>> = { radar: fetchRadarFrame, clouds: fetchCloudsFrame };

// ---- layers on a map ------------------------------------------------------------------------

type StyleLayer = { id: string; type: string; source?: string };
const BASEMAP_SOURCES = new Set(["openmaptiles", "ne2_shaded", "vectasim-graticule", "vectasim-satellite"]);
const isWeatherLayer = (l: StyleLayer) => l.id === SOURCE.radar || l.id === SOURCE.clouds;

/**
 * Where a weather layer goes: above every basemap fill and line (vector or imagery), under
 * the basemap's place names and under all our own layers (track, airports, aircraft).
 * Custom WebGL layers (curtain, 3D models) are not in getStyle().layers and do not count, nor
 * does the curtain's fill-extrusion fallback (inserted low). Clouds go under the radar.
 */
export function weatherBeforeId(layers: StyleLayer[], kind: WeatherKind): string | undefined {
  if (kind === "clouds" && layers.some((l) => l.id === SOURCE.radar)) return SOURCE.radar;
  const isBase = (l: StyleLayer) => l.type === "background" || (l.source != null && BASEMAP_SOURCES.has(l.source));
  let lastBase = -1;
  layers.forEach((l, i) => {
    if (isBase(l) && l.type !== "symbol") lastBase = i;
  });
  const firstOwn = layers.findIndex((l) => !isBase(l) && !isWeatherLayer(l) && l.type !== "fill-extrusion");
  let at = firstOwn < 0 ? lastBase + 1 : Math.min(firstOwn, lastBase + 1);
  while (at < layers.length && isWeatherLayer(layers[at])) at++;
  return layers[at]?.id;
}

/** Shows, refreshes and removes radar and clouds on one map. Returns the teardown. */
export function attachWeather(map: maplibregl.Map): () => void {
  addProtocols();
  let timer: number | undefined;
  let disposed = false;
  const inflight: Record<WeatherKind, boolean> = { radar: false, clouds: false };
  const scheme = () => (getMapTheme().scheme === "light" ? "light" : "dark");
  /** The URL each source was built with (a new frame or theme rebuilds it). */
  const shown: Record<WeatherKind, string | null> = { radar: null, clouds: null };

  const remove = (kind: WeatherKind) => {
    const id = SOURCE[kind];
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
    shown[kind] = null;
  };

  const show = (kind: WeatherKind, frame: Frame) => {
    const id = SOURCE[kind];
    const url = protocolUrl(kind, frame.url, scheme());
    const src = map.getSource(id) as maplibregl.RasterTileSource | undefined;
    if (src && map.getLayer(id)) {
      if (shown[kind] !== url) src.setTiles([url]);
      shown[kind] = url;
      return;
    }
    remove(kind);
    map.addSource(id, {
      type: "raster",
      tiles: [url],
      tileSize: 256,
      maxzoom: kind === "radar" ? RADAR_MAX_ZOOM : CLOUDS_MAX_ZOOM,
      attribution: kind === "radar" ? RADAR_ATTRIBUTION : CLOUDS_ATTRIBUTION,
    });
    map.addLayer(
      { id, type: "raster", source: id, paint: { "raster-opacity": kind === "radar" ? WEATHER_OPACITY : CLOUDS_OPACITY, "raster-fade-duration": 0 } },
      weatherBeforeId(map.getStyle().layers ?? [], kind),
    );
    shown[kind] = url;
  };

  const refresh = (kind: WeatherKind) => {
    if (inflight[kind]) return;
    inflight[kind] = true;
    FETCH[kind]()
      .then((f) => setFrame(kind, f ?? state.frames[kind], f == null))
      // keep the last frame; the legend marks it as not refreshed
      .catch(() => setFrame(kind, state.frames[kind], true))
      .finally(() => {
        inflight[kind] = false;
      });
  };

  /** Brings the map in line with the shared state (no fetch for anything that is off). */
  const sync = () => {
    if (disposed) return;
    try {
      for (const kind of ["clouds", "radar"] as WeatherKind[]) {
        const frame = state.frames[kind];
        if (!weatherWanted(state, kind)) remove(kind);
        else if (frame) show(kind, frame);
        else refresh(kind);
      }
    } catch {
      /* style still loading: style.load syncs again */
    }
    const any = weatherWanted(state, "radar") || weatherWanted(state, "clouds");
    if (any && timer == null)
      timer = window.setInterval(() => {
        for (const kind of ["clouds", "radar"] as WeatherKind[]) if (weatherWanted(state, kind)) refresh(kind);
      }, WEATHER_REFRESH_MS);
    else if (!any && timer != null) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };

  const onState = () => sync();
  const onStyle = () => {
    shown.radar = null;
    shown.clouds = null;
    sync();
  };
  window.addEventListener(WEATHER_EVENT, onState);
  map.on("style.load", onStyle);
  // a frame from an earlier mount that is long out of date is fetched anew
  const now = Date.now() / 1000;
  for (const kind of ["clouds", "radar"] as WeatherKind[]) {
    const f = state.frames[kind];
    if (weatherWanted(state, kind) && f && now - f.time > (WEATHER_REFRESH_MS / 1000) * 3) refresh(kind);
  }
  sync();
  return () => {
    disposed = true;
    window.removeEventListener(WEATHER_EVENT, onState);
    map.off("style.load", onStyle);
    if (timer != null) window.clearInterval(timer);
  };
}
