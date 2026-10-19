import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import { followLanguage, loadBasemapStyle } from "./basemap";
import "maplibre-gl/dist/maplibre-gl.css";
import "./maplibreWorker";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AircraftInfo, Airport, FlightEvent, Metar, NavFix, OnlineSummary, OnlineView, Pilot, TrackSample } from "../types";
import { WAKE_SIZE, icaoFromAtcModel, iconSizeExpr, wakeCategory } from "./aircraftIcons";
import {
  addAirportLayers,
  addRouteLayers,
  addCurtainLayers,
  firstSymbolLayer,
  addTrackLayers,
  applyProjection,
  setCurtainVisible,
  setPitched,
  airportsGeoJson,
  loadPlaneIcon,
  pointFeature,
  routeGeoJson,
  useGlobe,
  withProjection,
} from "./common";
import { ChunkedTrack, curtainGeoJson } from "./trackChunks";
import {
  addOnlineLayers,
  atcGeoJson,
  geoJsonKey,
  metarsGeoJson,
  onPilotClick,
  pilotsGeoJson,
  routeLineGeoJson,
  selectedGeoJson,
  setGroupVisible,
  type OnlineLayerGroup,
} from "./online";
import TrafficCard from "./TrafficCard";
import { useTrafficSelection } from "./trafficHooks";
import { SELECT_TRAFFIC_EVENT, greatCircle, sameTraffic, type SelectTrafficDetail, type TrafficRef } from "./trafficInfo";
import { addAirportDiagramLayers } from "./airportDiagram";
import AirportReadout from "./AirportReadout";
import { COLOR, getMapTheme } from "../theme";
import TrafficToggle from "./TrafficToggle";
import GlobeToggle, { useMapZoom } from "./GlobeToggle";
import { useTelemetry } from "../telemetryStore";
import { useT } from "../i18n";

const TRACK_POINT_INTERVAL_MS = 1000;
const AIRPORT_LIMIT = 600;
/** METAR badges appear from this zoom; below it there are too many airports to be useful. */
const METAR_MIN_ZOOM = 7;
const METAR_MAX_STATIONS = 40;
const LAYER_STORAGE_KEY = "vectasim.mapLayers";
/** Track sources: closed 10-min blocks (diff-updated rarely) and the open block (per sample). */
const TRACK_HISTORY = "track-history";
const TRACK_LIVE = "track-live";
/** 3D view: the track as wall + ribbon at the flown altitude (rebuilt at most this often). */
const TRACK_3D = "track-3d";
const VIEW3D_STORAGE_KEY = "vectasim.map3d";
const CURTAIN_MIN_INTERVAL_MS = 5_000;
/** Follow mode re-centres only when the aircraft moved at least this far on screen. */
const FOLLOW_MIN_PX = 1;
/** Fired by the shell when a kept-mounted, CSS-hidden map becomes visible again. */
export const MAP_VISIBLE_EVENT = "vectasim:map-visible";

type LayerState = Record<OnlineLayerGroup, boolean>;

/** Free map area around the traffic card and the HUD bar (px from each edge), plus a margin. */
export interface MapInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
const INSET_MARGIN = 24;

/**
 * What covers the map: the traffic card on the right (`.traffic-card`) and the HUD at the bottom
 * (`.hud` of the live view), measured from the DOM so every window size and theme fits.
 */
export function measureInsets(wrap: HTMLElement | null): MapInsets {
  const base: MapInsets = { top: 80, right: INSET_MARGIN, bottom: INSET_MARGIN, left: INSET_MARGIN };
  if (!wrap) return base;
  const box = wrap.getBoundingClientRect();
  const card = wrap.querySelector<HTMLElement>(".traffic-card")?.getBoundingClientRect();
  if (card && card.width > 0) base.right = Math.max(base.right, box.right - card.left + INSET_MARGIN);
  const hud = (wrap.closest(".live-map-area") ?? wrap.parentElement)?.querySelector<HTMLElement>(".hud")?.getBoundingClientRect();
  if (hud && hud.height > 0) base.bottom = Math.max(base.bottom, box.bottom - hud.top + INSET_MARGIN);
  // never more than the map is wide/high (tiny windows): keep at least a third free
  base.right = Math.min(base.right, box.width * 0.66);
  base.bottom = Math.min(base.bottom, box.height * 0.5);
  return base;
}

/** Camera `offset` that puts a centred target into the middle of the free area instead of the canvas. */
export function insetOffset(i: MapInsets): [number, number] {
  return [(i.left - i.right) / 2, (i.top - i.bottom) / 2];
}

/** Is a screen point inside the free area (not under the card, the HUD or the toolbar)? */
export function pointFree(p: { x: number; y: number }, i: MapInsets, w: number, h: number): boolean {
  return p.x >= i.left && p.x <= w - i.right && p.y >= i.top && p.y <= h - i.bottom;
}

function load3d(): boolean {
  try {
    return localStorage.getItem(VIEW3D_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function loadLayerState(): LayerState {
  const fallback: LayerState = { traffic: true, atc: true, weather: true };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(LAYER_STORAGE_KEY) ?? "{}") };
  } catch {
    return fallback;
  }
}

/** Viewport as a lon/lat box in [-180, 180], the form the backend's antimeridian-aware queries expect. */
function viewBbox(map: maplibregl.Map) {
  const b = map.getBounds();
  let minLon = b.getWest();
  let maxLon = b.getEast();
  if (maxLon - minLon >= 360) {
    minLon = -180;
    maxLon = 180;
  } else {
    const wrap = (l: number) => ((((l + 180) % 360) + 360) % 360) - 180;
    minLon = wrap(minLon);
    maxLon = wrap(maxLon);
  }
  return { minLon, minLat: Math.max(-90, b.getSouth()), maxLon, maxLat: Math.min(90, b.getNorth()) };
}

interface Props {
  /** Identity of the own aircraft – decides silhouette and size (wake class). */
  aircraft?: AircraftInfo | null;
  /** Planned route (OFP navlog), drawn dashed under the flown track. */
  route?: NavFix[] | null;
  /** Receives the online traffic/ATC currently in view (for the Online panel). */
  onOnlineView?: (view: OnlineView | null, center: { lat: number; lon: number }) => void;
  /**
   * Some online feed on (settings `online_vatsim` / `online_ivao`). The "Verkehr" toggle (TrafficToggle) switches the
   * feeds themselves (online_set_networks), so map toggle and setting can never disagree.
   */
  trafficOn?: boolean;
  /** Rendered top left above the map controls (recording status pill). */
  overlay?: ReactNode;
  /**
   * Basemap tiles or style could not be loaded (offline, blocked): `true` once MapLibre reports a
   * load error, `false` again when tiles arrive. Recording does not depend on the map.
   */
  onOffline?: (offline: boolean) => void;
}

/** MapLibre `error` events that mean "basemap not reachable" (tile, style, glyph or sprite fetch). */
export function isMapLoadError(e: { error?: { message?: string; status?: number } | null; sourceId?: string; tile?: unknown }): boolean {
  if (e.tile || e.sourceId) return true;
  const msg = e.error?.message ?? "";
  return e.error?.status != null || /fetch|ajaxerror|network|failed to load|load failed|status/i.test(msg);
}

/** Open block on every call; with `full` also the history (seed, reset, theme change). */
function drawTrack(map: maplibregl.Map, track: ChunkedTrack, full: boolean) {
  if (full) (map.getSource(TRACK_HISTORY) as maplibregl.GeoJSONSource | undefined)?.setData(track.historyGeoJson());
  (map.getSource(TRACK_LIVE) as maplibregl.GeoJSONSource | undefined)?.setData(track.liveGeoJson());
}

function drawCurtain(map: maplibregl.Map, track: ChunkedTrack) {
  (map.getSource(TRACK_3D) as maplibregl.GeoJSONSource | undefined)?.setData(curtainGeoJson(track.points));
}

/**
 * Live map: basemap, airports in view, the current flight's track (seeded from the
 * recorder's in-memory samples, then appended at 1 Hz) and the own aircraft.
 */
export default function LiveMap({ aircraft, route, onOnlineView, trafficOn = false, overlay, onOffline }: Props) {
  const t = useT();
  // every sample (marker, track append, follow): only the map re-renders with it
  const telemetry = useTelemetry();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  const trackRef = useRef(new ChunkedTrack());
  const followRef = useRef(true);
  const [follow, setFollowState] = useState(true);
  const [view3d, setView3dState] = useState(load3d);
  const view3dRef = useRef(view3d);
  /** Globe or flat Mercator: one choice for every map (projection.ts), default globe. */
  const [globe] = useGlobe();
  const globeRef = useRef(globe);
  globeRef.current = globe;
  const curtainAtRef = useRef(0);
  const [routeReady, setRouteReady] = useState(false);
  const zoom = useMapZoom(mapRef, routeReady);
  const [layers, setLayers] = useState<LayerState>(loadLayerState);
  const layersRef = useRef(layers);
  const trafficOnRef = useRef(trafficOn);
  trafficOnRef.current = trafficOn;
  /** Traffic and ATC need the feed; the stored layer choice only applies while it runs. */
  const groupVisible = (g: OnlineLayerGroup, state: LayerState = layersRef.current) => (g === "weather" ? state.weather : trafficOnRef.current && state[g]);
  const onOnlineViewRef = useRef(onOnlineView);
  onOnlineViewRef.current = onOnlineView;
  const onOfflineRef = useRef(onOffline);
  onOfflineRef.current = onOffline;
  const airportsRef = useRef<Map<string, Airport>>(new Map());
  const ownCatRef = useRef<ReturnType<typeof wakeCategory>>("medium");
  const routeRef = useRef(route);
  routeRef.current = route;
  const telemetryRef = useRef(telemetry);
  telemetryRef.current = telemetry;
  // ---- selected online aircraft (TrafficCard) ----------------------------------------
  const [trafficRef, setTrafficRef] = useState<TrafficRef | null>(null);
  const [trafficSeed, setTrafficSeed] = useState<Pilot | null>(null);
  const [followTraffic, setFollowTrafficState] = useState(false);
  const followTrafficRef = useRef(false);
  const [routeShown, setRouteShown] = useState(false);
  /** Ring position and route line as last drawn, re-drawn after a theme change. */
  const selectedPosRef = useRef<{ lon: number; lat: number } | null>(null);
  const trafficRouteRef = useRef<Array<[number, number]> | null>(null);
  const setFollowTraffic = (v: boolean) => {
    followTrafficRef.current = v;
    setFollowTrafficState(v);
  };
  /**
   * "Folgen" (own aircraft) as it was before a traffic card took the camera; null = nothing to
   * restore. Closing the card brings it back; the user's own camera choice
   * (Folgen button, dragging the map) clears it.
   */
  const ownFollowBeforeRef = useRef<boolean | null>(null);
  const setFollow = (v: boolean) => {
    followRef.current = v;
    setFollowState(v);
    ownFollowBeforeRef.current = null;
    // following the own aircraft ends following the traffic (one camera target at a time)
    if (v) setFollowTraffic(false);
  };
  /** The traffic card takes the camera: stop following the own aircraft, remember that it was on. */
  const suspendOwnFollow = useCallback(() => {
    if (ownFollowBeforeRef.current === null) ownFollowBeforeRef.current = followRef.current;
    followRef.current = false;
    setFollowState(false);
  }, []);
  const closeTraffic = useCallback(() => {
    setTrafficRef(null);
    setTrafficSeed(null);
    followTrafficRef.current = false;
    setFollowTrafficState(false);
    setRouteShown(false);
    const restore = ownFollowBeforeRef.current;
    ownFollowBeforeRef.current = null;
    if (restore) {
      followRef.current = true;
      setFollowState(true);
      const t = telemetryRef.current;
      const map = mapRef.current;
      if (map && t && Number.isFinite(t.latitude) && Number.isFinite(t.longitude) && map.getCanvas().clientWidth > 0)
        map.easeTo({ center: [t.longitude, t.latitude], duration: 500 });
    }
  }, []);
  const selectTraffic = (ref: TrafficRef, seed: Pilot | null) => {
    if (ownFollowBeforeRef.current === null) ownFollowBeforeRef.current = followRef.current;
    if (!sameTraffic(ref, trafficRef)) {
      setRouteShown(false);
      setFollowTraffic(false);
    }
    setTrafficSeed(seed);
    setTrafficRef({ network: ref.network, cid: ref.cid });
  };
  const selectTrafficRef = useRef(selectTraffic);
  selectTrafficRef.current = selectTraffic;
  const sel = useTrafficSelection(trafficRef, trafficSeed, closeTraffic);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** Selection key, and the key whose aircraft was already moved into view once. */
  const selKeyRef = useRef<string | null>(null);
  selKeyRef.current = trafficRef ? `${trafficRef.network}:${trafficRef.cid}` : null;
  const revealedRef = useRef<string | null>(null);

  // ---- map setup -------------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const setupMap = (container: HTMLDivElement, style: StyleSpecification | string): (() => void) => {
      const map = new maplibregl.Map({
        container,
        style: withProjection(style, globeRef.current, COLOR.bg),
        center: [8.57, 50.03],
        zoom: 9,
        attributionControl: { compact: true },
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "top-right");
      map.addControl(new maplibregl.ScaleControl({ unit: "nautical" }), "bottom-left");
      mapRef.current = map;

      // Online traffic/ATC: re-filtered from the backend's cached VATSIM snapshot on every
      // move and every poll (online:summary); debounced so a fling pans into one request.
      let onlineTimer: number | undefined;
      // last data sent per source: a pan that keeps the same pilots in view (or a poll without
      // changes) does not re-tile the layer; cleared after a theme change (sources are new)
      const sentKeys = new Map<string, string>();
      const setIfChanged = (id: string, data: GeoJSON.FeatureCollection) => {
        const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
        if (!src) return;
        const key = geoJsonKey(data);
        if (sentKeys.get(id) === key) return;
        sentKeys.set(id, key);
        src.setData(data);
      };
      const refreshOnline = () => {
        window.clearTimeout(onlineTimer);
        onlineTimer = window.setTimeout(() => {
          const c = map.getCenter();
          invoke<OnlineView>("online_snapshot_in_bbox", { ...viewBbox(map), limit: 1500 })
            .then((v) => {
              setIfChanged("vatsim-pilots", pilotsGeoJson(v.pilots));
              setIfChanged("vatsim-atc", atcGeoJson(v.controllers));
              onOnlineViewRef.current?.(v.summary.enabled ? v : null, { lat: c.lat, lon: c.lng });
            })
            // filters the cached snapshot locally; feed errors surface via online:summary.lastError
            .catch(() => {});
        }, 250);
      };

      // METARs only for the biggest airports in view (<= 40), only when zoomed in and the
      // layer is on; the backend caches each station for 10 min, so re-asking is cheap.
      let metarTimer: number | undefined;
      const refreshMetars = () => {
        window.clearTimeout(metarTimer);
        if (map.getZoom() < METAR_MIN_ZOOM || !layersRef.current.weather) {
          setIfChanged("metars", { type: "FeatureCollection", features: [] });
          return;
        }
        metarTimer = window.setTimeout(() => {
          const zoom = map.getZoom();
          const candidates = [...airportsRef.current.values()]
            .filter((a) => a.kind === "large" || a.kind === "medium" || (zoom >= 9 && a.kind === "small"))
            .filter((a) => /^[A-Z]{4}$/.test(a.ident))
            .slice(0, METAR_MAX_STATIONS);
          if (!candidates.length) return;
          invoke<Metar[]>("metars", { icaos: candidates.map((a) => a.ident) })
            .then((list) => setIfChanged("metars", metarsGeoJson(list, airportsRef.current)))
            // map badges are best effort; the flight bar shows METAR errors for the relevant station
            .catch(() => {});
        }, 600);
      };

      const refreshAirports = () => {
        const b = map.getBounds();
        invoke<Airport[]>("airports_in_bbox", {
          minLon: b.getWest(),
          minLat: b.getSouth(),
          maxLon: b.getEast(),
          maxLat: b.getNorth(),
          limit: AIRPORT_LIMIT,
        })
          .then((list) => {
            const src = map.getSource("airports") as maplibregl.GeoJSONSource | undefined;
            src?.setData(airportsGeoJson(list));
            airportsRef.current = new Map(list.map((a) => [a.ident, a]));
            refreshMetars();
          })
          // embedded airport DB; on failure the previous dots simply stay
          .catch(() => {});
      };

      // Our layers on top of the basemap. Runs on the first load and again after a theme
      // change (setStyle drops every source, layer and image); colours come from theme.ts.
      let diagramOff: (() => void) | undefined;
      const addOwnLayers = async () => {
        diagramOff?.();
        diagramOff = addAirportDiagramLayers(map);
        addAirportLayers(map);
        addRouteLayers(map, "route");
        addTrackLayers(map, [TRACK_HISTORY, TRACK_LIVE]);
        addCurtainLayers(map, TRACK_3D, firstSymbolLayer(map));
        setCurtainVisible(map, TRACK_3D, view3dRef.current);
        await addOnlineLayers(map);
        for (const g of Object.keys(layersRef.current) as OnlineLayerGroup[]) setGroupVisible(map, g, groupVisible(g));
        await loadPlaneIcon(map);
        map.addSource("aircraft", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        // halo + ring so the own aircraft stands out from the traffic; on light themes the yellow
        // disc alone vanishes on paper, so the ring is drawn in the dark aircraft edge colour
        const lightMap = getMapTheme().scheme === "light";
        map.addLayer({
          id: "aircraft-halo",
          type: "circle",
          source: "aircraft",
          paint: {
            "circle-radius": ["*", ["coalesce", ["get", "sizeFactor"], 1.3], 16],
            "circle-color": COLOR.ownAircraft,
            "circle-opacity": lightMap ? 0.3 : 0.14,
            "circle-blur": lightMap ? 0.2 : 0.6,
          },
        });
        map.addLayer({
          id: "aircraft-ring",
          type: "circle",
          source: "aircraft",
          paint: {
            "circle-radius": ["*", ["coalesce", ["get", "sizeFactor"], 1.3], 14],
            "circle-color": "rgba(0,0,0,0)",
            "circle-stroke-color": lightMap ? COLOR.aircraftEdge : COLOR.ownAircraft,
            "circle-stroke-width": 2,
            "circle-stroke-opacity": lightMap ? 0.8 : 0.85,
            "circle-pitch-alignment": "map",
          },
        });
        map.addLayer({
          id: "aircraft",
          type: "symbol",
          source: "aircraft",
          layout: {
            "icon-image": ["concat", "ac-own-", ["coalesce", ["get", "cat"], "medium"]],
            "icon-size": iconSizeExpr(1.3),
            "icon-rotate": ["get", "heading"],
            "icon-rotation-alignment": "map",
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
        });
      };

      map.on("load", async () => {
        // style URL fallback (offline) carries no projection: set it here
        applyProjection(map, globeRef.current);
        await addOwnLayers();
        readyRef.current = true;
        // a remembered 3D view starts tilted, not flat until the next toggle
        if (view3dRef.current) setPitched(map, true, 0);
        setRouteReady(true);
        refreshAirports();
        refreshOnline();
        // seed the track with what the recorder already has for the active flight
        // (whole list over IPC once per mount; points that arrive meanwhile are kept by seed())
        invoke<TrackSample[]>("get_live_track")
          .then((samples) => {
            if (mapRef.current !== map) return;
            trackRef.current.seed(samples.map((s) => ({ lon: s.longitude, lat: s.latitude, altFt: s.altitudeMslFt, tMs: s.tMs })));
            drawTrack(map, trackRef.current, true);
            if (view3dRef.current) drawCurtain(map, trackRef.current);
          })
          // no live track yet (no active flight): the track starts empty and fills at 1 Hz
          .catch(() => {});
      });
      // theme change: new basemap tint, our layers re-added in the new colours, data restored
      let themeSeq = 0;
      const onTheme = () => {
        const mySeq = ++themeSeq;
        void loadBasemapStyle().then((style) => {
          if (mySeq !== themeSeq || mapRef.current !== map) return;
          readyRef.current = false;
          map.once("style.load", async () => {
            await addOwnLayers();
            if (mySeq !== themeSeq) return;
            readyRef.current = true;
            const src = (id: string) => map.getSource(id) as maplibregl.GeoJSONSource | undefined;
            sentKeys.clear();
            drawTrack(map, trackRef.current, true);
            if (view3dRef.current) drawCurtain(map, trackRef.current);
            src("airports")?.setData(airportsGeoJson([...airportsRef.current.values()]));
            src("route")?.setData(routeGeoJson(routeRef.current ?? []));
            src("traffic-selected")?.setData(selectedGeoJson(selectedPosRef.current));
            src("traffic-route")?.setData(routeLineGeoJson(trafficRouteRef.current));
            const t = telemetryRef.current;
            if (t)
              src("aircraft")?.setData({
                type: "FeatureCollection",
                features: [pointFeature(t.longitude, t.latitude, { heading: t.headingTrueDeg, cat: ownCatRef.current, sizeFactor: WAKE_SIZE[ownCatRef.current] })],
              });
            refreshOnline();
            refreshMetars();
          });
          map.setStyle(withProjection(style, globeRef.current, COLOR.bg), { diff: false });
        });
      };
      window.addEventListener("theme:changed", onTheme);
      // basemap names follow the UI language (map/basemap.ts)
      const offLang = followLanguage(map);

      // offline hint: a failed tile/style fetch sets it, the next tile that arrives clears it
      let offline = false;
      const setOffline = (v: boolean) => {
        if (v === offline) return;
        offline = v;
        onOfflineRef.current?.(v);
      };
      map.on("error", (e) => {
        if (isMapLoadError(e as unknown as Parameters<typeof isMapLoadError>[0])) setOffline(true);
      });
      map.on("data", (e) => {
        if (offline && e.dataType === "source" && (e as unknown as { tile?: unknown }).tile) setOffline(false);
      });
      const onBrowserOffline = () => setOffline(true);
      window.addEventListener("offline", onBrowserOffline);

      map.on("moveend", refreshAirports);
      map.on("moveend", refreshOnline);
      // dragging takes the camera: neither the own aircraft nor a selected one is followed
      map.on("dragstart", () => {
        followRef.current = false;
        setFollowState(false);
        ownFollowBeforeRef.current = null;
        followTrafficRef.current = false;
        setFollowTrafficState(false);
      });
      // a click on an online aircraft opens its card (online.ts → onPilotClick)
      onPilotClick(map, (c) => selectTrafficRef.current({ network: c.network, cid: c.cid }, null));

      // A kept-mounted map hidden via CSS has a 0x0 canvas; when shown again MapLibre needs
      // resize(). ResizeObserver covers most cases; the window resize and the shell's
      // "map visible" event cover the rest (e.g. visibility toggled without a size change).
      const resize = () => {
        if (container.clientWidth === 0 || container.clientHeight === 0) return;
        map.resize();
        const t = telemetryRef.current;
        if (followRef.current && t && Number.isFinite(t.latitude) && Number.isFinite(t.longitude)) map.jumpTo({ center: [t.longitude, t.latitude] });
      };
      const ro = new ResizeObserver(resize);
      ro.observe(container);
      window.addEventListener("resize", resize);
      window.addEventListener(MAP_VISIBLE_EVENT, resize);

      const unlisten = listen<FlightEvent>("sim:flight-event", (e) => {
        if (e.payload.kind === "flightStarted") {
          trackRef.current.reset();
          drawTrack(map, trackRef.current, true);
          drawCurtain(map, trackRef.current);
        }
      });

      const unlistenOnline = listen<OnlineSummary>("online:summary", refreshOnline);
      const onLayersChanged = () => refreshMetars();
      window.addEventListener("vectasim:layers", onLayersChanged);

      return () => {
        ro.disconnect();
        window.removeEventListener("resize", resize);
        window.removeEventListener(MAP_VISIBLE_EVENT, resize);
        window.clearTimeout(onlineTimer);
        window.clearTimeout(metarTimer);
        window.removeEventListener("vectasim:layers", onLayersChanged);
        window.removeEventListener("theme:changed", onTheme);
        offLang();
        window.removeEventListener("offline", onBrowserOffline);
        diagramOff?.();
        unlisten.then((u) => u());
        unlistenOnline.then((u) => u());
        map.remove();
        mapRef.current = null;
        readyRef.current = false;
      };
    };
    let disposed = false;
    let teardown: (() => void) | undefined;
    // patched basemap (map/basemap.ts); resolves at once from the in-memory copy after the first map
    void loadBasemapStyle().then((style) => {
      if (disposed || !containerRef.current || mapRef.current) return;
      teardown = setupMap(containerRef.current, style);
    });
    return () => {
      disposed = true;
      teardown?.();
    };
  }, []);

  // globe switched (here, in the track map or the Länder view): only the projection changes,
  // sources, layers, camera and the telemetry path stay as they are
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) applyProjection(map, globe);
  }, [globe, routeReady]);

  // ---- planned route -----------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !routeReady) return;
    (map.getSource("route") as maplibregl.GeoJSONSource | undefined)?.setData(routeGeoJson(route ?? []));
  }, [route, routeReady]);

  // ---- telemetry updates -------------------------------------------------------------
  const ownCat = wakeCategory(icaoFromAtcModel(aircraft?.atcModel), aircraft?.title, telemetry?.totalWeightKg);
  ownCatRef.current = ownCat;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (!telemetry) {
      // provider gone or switched (demo ended): no aircraft, no stale track
      const empty = { type: "FeatureCollection" as const, features: [] };
      (map.getSource("aircraft") as maplibregl.GeoJSONSource | undefined)?.setData(empty);
      if (trackRef.current.points.length) {
        trackRef.current.reset();
        drawTrack(map, trackRef.current, true);
        drawCurtain(map, trackRef.current);
      }
      return;
    }
    const { latitude: lat, longitude: lon } = telemetry;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    (map.getSource("aircraft") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: [pointFeature(lon, lat, { heading: telemetry.headingTrueDeg, cat: ownCat, sizeFactor: WAKE_SIZE[ownCat] })],
    });

    const track = trackRef.current;
    if (telemetry.timestampMs - track.lastMs >= TRACK_POINT_INTERVAL_MS) {
      const closedChunk = track.push({ lon, lat, altFt: telemetry.altitudeMslFt, tMs: telemetry.timestampMs });
      // a closed 10-min block moves to the history source as a diff (no full re-send)
      if (closedChunk?.length) (map.getSource(TRACK_HISTORY) as maplibregl.GeoJSONSource | undefined)?.updateData({ add: closedChunk });
      if (track.points.length >= 2) drawTrack(map, track, false);
      // the 3D curtain is one polygon set for the whole track: rebuilt every few seconds, not per sample
      if (view3dRef.current && telemetry.timestampMs - curtainAtRef.current >= CURTAIN_MIN_INTERVAL_MS) {
        curtainAtRef.current = telemetry.timestampMs;
        drawCurtain(map, track);
      }
    }

    // hidden (CSS display:none) or not moved by a pixel: no camera animation
    if (followRef.current && map.getCanvas().clientWidth > 0) {
      const target = map.project([lon, lat]);
      const here = map.project(map.getCenter());
      if (Math.hypot(target.x - here.x, target.y - here.y) >= FOLLOW_MIN_PX) map.easeTo({ center: [lon, lat], duration: 150, easing: (t) => t });
    }
  }, [telemetry, ownCat]);

  // ---- selected traffic: ring, follow, route ------------------------------------------
  const selLon = sel?.pilot?.longitude;
  const selLat = sel?.pilot?.latitude;
  useEffect(() => {
    const map = mapRef.current;
    const pos = selLon != null && selLat != null ? { lon: selLon, lat: selLat } : null;
    selectedPosRef.current = pos;
    if (!map || !readyRef.current) return;
    (map.getSource("traffic-selected") as maplibregl.GeoJSONSource | undefined)?.setData(selectedGeoJson(pos));
    if (!selKeyRef.current) revealedRef.current = null;
    if (!pos || map.getCanvas().clientWidth === 0) return;
    const insets = measureInsets(wrapRef.current);
    if (followTrafficRef.current) {
      map.easeTo({ center: [pos.lon, pos.lat], offset: insetOffset(insets), duration: 600 });
      return;
    }
    // first position of a newly selected aircraft: move it out from under the card / HUD
    const key = selKeyRef.current;
    if (key && revealedRef.current !== key) {
      revealedRef.current = key;
      const canvas = map.getCanvas();
      if (!pointFree(map.project([pos.lon, pos.lat]), insets, canvas.clientWidth, canvas.clientHeight))
        map.easeTo({ center: [pos.lon, pos.lat], offset: insetOffset(insets), duration: 500 });
    }
  }, [selLon, selLat, routeReady]);

  const dep = sel?.pilot?.departure ?? "";
  const arr = sel?.pilot?.arrival ?? "";
  useEffect(() => {
    let alive = true;
    const draw = (points: Array<[number, number]> | null) => {
      trafficRouteRef.current = points;
      const map = mapRef.current;
      if (map && readyRef.current) (map.getSource("traffic-route") as maplibregl.GeoJSONSource | undefined)?.setData(routeLineGeoJson(points));
    };
    if (!routeShown || !dep || !arr) {
      draw(null);
      return;
    }
    const get = (ident: string) => invoke<{ airport: Airport } | null>("get_airport", { ident }).then((d) => d?.airport ?? null);
    Promise.all([get(dep), get(arr)])
      .then(([a, b]) => {
        if (!alive) return;
        const points = a && b ? greatCircle({ lat: a.latitude, lon: a.longitude }, { lat: b.latitude, lon: b.longitude }) : null;
        draw(points);
        const map = mapRef.current;
        if (map && points) {
          // both ends in view (unwrapped longitudes keep an antimeridian route in one box)
          const bounds = points.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(points[0], points[0]));
          suspendOwnFollow();
          followTrafficRef.current = false;
          setFollowTrafficState(false);
          // centre and zoom of the flat fit; a pitched (3D) camera keeps its angle on a short route,
          // a long one is looked at from above – tilted at globe zoom the line lies on the horizon
          // padding = the free area beside the traffic card and above the HUD bar
          const insets = measureInsets(wrapRef.current);
          const cam = map.cameraForBounds(bounds, { padding: { top: insets.top, bottom: insets.bottom, left: Math.max(insets.left, 60), right: insets.right }, maxZoom: 9, bearing: 0 });
          if (cam?.center && cam.zoom != null)
            map.easeTo({ center: cam.center, zoom: cam.zoom, ...(cam.zoom < 5 ? { pitch: 0 } : {}), duration: 600 });
        }
      })
      // unknown airport: no line, the card still says the route in words
      .catch(() => alive && draw(null));
    return () => {
      alive = false;
    };
  }, [routeShown, dep, arr, routeReady, suspendOwnFollow]);

  // the Dispatch panel's online list selects an aircraft: centre it and open its card
  useEffect(() => {
    const onSelect = (e: Event) => {
      const p = (e as CustomEvent<SelectTrafficDetail>).detail?.pilot;
      if (!p) return;
      selectTrafficRef.current({ network: p.network ?? "vatsim", cid: p.cid }, p);
      const map = mapRef.current;
      if (!map) return;
      suspendOwnFollow();
      // the card opens in the same frame: centre the aircraft in the free area beside it
      revealedRef.current = `${p.network ?? "vatsim"}:${p.cid}`;
      requestAnimationFrame(() =>
        map.easeTo({ center: [p.longitude, p.latitude], zoom: Math.max(map.getZoom(), 7), offset: insetOffset(measureInsets(wrapRef.current)), duration: 500 }),
      );
    };
    window.addEventListener(SELECT_TRAFFIC_EVENT, onSelect);
    return () => window.removeEventListener(SELECT_TRAFFIC_EVENT, onSelect);
  }, [suspendOwnFollow]);

  // traffic switched off: the card has nothing to show any more
  useEffect(() => {
    if (!trafficOn) closeTraffic();
  }, [trafficOn, closeTraffic]);

  const toggleFollowTraffic = () => {
    const next = !followTrafficRef.current;
    if (next) suspendOwnFollow();
    setFollowTraffic(next);
    const map = mapRef.current;
    const p = sel?.pilot;
    if (next && map && p)
      map.easeTo({ center: [p.longitude, p.latitude], zoom: Math.max(map.getZoom(), 7), offset: insetOffset(measureInsets(wrapRef.current)), duration: 500 });
  };

  const toggleLayer = (g: OnlineLayerGroup) => {
    const next = { ...layersRef.current, [g]: !layersRef.current[g] };
    layersRef.current = next;
    setLayers(next);
    try {
      localStorage.setItem(LAYER_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable: the toggle still works for this session */
    }
    const map = mapRef.current;
    if (map && readyRef.current) setGroupVisible(map, g, groupVisible(g, next));
    if (g === "weather") window.dispatchEvent(new Event("vectasim:layers"));
  };

  // feed switched (map toggle or elsewhere): show/hide traffic and ATC with it
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    setGroupVisible(map, "traffic", groupVisible("traffic"));
    setGroupVisible(map, "atc", groupVisible("atc"));
  }, [trafficOn, routeReady]);

  const toggle3d = () => {
    const next = !view3dRef.current;
    view3dRef.current = next;
    setView3dState(next);
    try {
      localStorage.setItem(VIEW3D_STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* storage unavailable: the view still switches for this session */
    }
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    setCurtainVisible(map, TRACK_3D, next);
    if (next) {
      curtainAtRef.current = telemetryRef.current?.timestampMs ?? 0;
      drawCurtain(map, trackRef.current);
    }
    setPitched(map, next);
  };

  const center = () => {
    const map = mapRef.current;
    if (!map || !telemetry) return;
    setFollow(true);
    map.easeTo({ center: [telemetry.longitude, telemetry.latitude], zoom: Math.max(map.getZoom(), 9), duration: 400 });
  };

  return (
    <div className="map-wrap" ref={wrapRef}>
      <div ref={containerRef} className="map" />
      <div className="map-topleft">
      {overlay}
      <div className="map-toolbar">
        <button className="toggle" onClick={() => setFollow(!follow)} title={t("map.toolbar.followTitle")} aria-pressed={follow}>
          {t("map.toolbar.follow")}
        </button>
        <button className="map-toolbar-icon" onClick={center} title={t("map.toolbar.center")} aria-label={t("map.toolbar.center")} disabled={!telemetry}>
          {/* SVG crosshair like the other map controls (the ⌖ glyph fell back to a substitute font) */}
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="8" cy="8" r="4.5" />
            <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
            <path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15" />
          </svg>
        </button>
        <button
          className="toggle"
          onClick={toggle3d}
          aria-pressed={view3d}
          title={view3d ? t("map.toolbar.flatten") : t("map.toolbar.tilt")}
        >
          3D
        </button>
        <GlobeToggle zoom={zoom} />
        <div className="map-toggle-group" role="group" aria-label={t("map.toolbar.layers")}>
          {/* Verkehr + VATSIM / IVAO / beide; turning traffic on also re-shows a hidden traffic layer */}
          <TrafficToggle on={trafficOn} onEnable={() => !layersRef.current.traffic && toggleLayer("traffic")} />
          <button
            className="toggle"
            onClick={() => toggleLayer("atc")}
            disabled={!trafficOn}
            aria-pressed={trafficOn && layers.atc}
            title={trafficOn ? t("map.toolbar.atcTitle") : t("map.toolbar.atcNeedsTraffic")}
          >
            ATC
          </button>
          <button className="toggle" onClick={() => toggleLayer("weather")} aria-pressed={layers.weather} title={t("map.toolbar.weatherTitle", { zoom: METAR_MIN_ZOOM })}>
            {t("map.toolbar.weather")}
          </button>
        </div>
      </div>
      </div>
      <AirportReadout mapRef={mapRef} ready={routeReady} />
      {trafficRef && sel && (
        <TrafficCard
          sel={sel}
          own={telemetry && Number.isFinite(telemetry.latitude) ? { lat: telemetry.latitude, lon: telemetry.longitude } : null}
          following={followTraffic}
          routeShown={routeShown}
          onFollow={toggleFollowTraffic}
          onRoute={() => setRouteShown(!routeShown)}
          onClose={closeTraffic}
        />
      )}
    </div>
  );
}
