import { useEffect, useRef, useState, type ReactNode } from "react";
import * as maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import { loadBasemapStyle } from "./basemap";
import "maplibre-gl/dist/maplibre-gl.css";
import "./maplibreWorker";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AircraftInfo, Airport, FlightEvent, Metar, NavFix, OnlineSummary, OnlineView, TrackSample } from "../types";
import { WAKE_SIZE, icaoFromAtcModel, iconSizeExpr, wakeCategory } from "./aircraftIcons";
import {
  addAirportLayers,
  addRouteLayers,
  addCurtainLayers,
  addTrackLayers,
  setCurtainVisible,
  setPitched,
  airportsGeoJson,
  loadPlaneIcon,
  pointFeature,
  routeGeoJson,
} from "./common";
import { ChunkedTrack, curtainGeoJson } from "./trackChunks";
import { addOnlineLayers, atcGeoJson, geoJsonKey, metarsGeoJson, pilotsGeoJson, setGroupVisible, type OnlineLayerGroup } from "./online";
import { addAirportDiagramLayers } from "./airportDiagram";
import AirportReadout from "./AirportReadout";
import { COLOR } from "../theme";
import { userMessage } from "../errors";
import { showToast } from "../ui/Toast";
import { useTelemetry } from "../telemetryStore";

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
   * VATSIM feed on (setting `vatsim_enabled`). The "Verkehr" toggle switches the feed
   * itself (online_set_enabled), so map toggle and setting can never disagree.
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
  const curtainAtRef = useRef(0);
  const [routeReady, setRouteReady] = useState(false);
  const [layers, setLayers] = useState<LayerState>(loadLayerState);
  const layersRef = useRef(layers);
  const trafficOnRef = useRef(trafficOn);
  trafficOnRef.current = trafficOn;
  const [trafficBusy, setTrafficBusy] = useState(false);
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
  const setFollow = (v: boolean) => {
    followRef.current = v;
    setFollowState(v);
  };

  // ---- map setup -------------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const setupMap = (container: HTMLDivElement, style: StyleSpecification | string): (() => void) => {
      const map = new maplibregl.Map({
        container,
        style,
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
        addCurtainLayers(map, TRACK_3D);
        setCurtainVisible(map, TRACK_3D, view3dRef.current);
        await addOnlineLayers(map);
        for (const g of Object.keys(layersRef.current) as OnlineLayerGroup[]) setGroupVisible(map, g, groupVisible(g));
        await loadPlaneIcon(map);
        map.addSource("aircraft", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        // soft halo so the own aircraft stands out from (equally yellow) traffic
        map.addLayer({
          id: "aircraft-halo",
          type: "circle",
          source: "aircraft",
          paint: {
            "circle-radius": ["*", ["coalesce", ["get", "sizeFactor"], 1.3], 16],
            "circle-color": COLOR.ownAircraft,
            "circle-opacity": 0.14,
            "circle-blur": 0.6,
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
        await addOwnLayers();
        readyRef.current = true;
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
            const t = telemetryRef.current;
            if (t)
              src("aircraft")?.setData({
                type: "FeatureCollection",
                features: [pointFeature(t.longitude, t.latitude, { heading: t.headingTrueDeg, cat: ownCatRef.current, sizeFactor: WAKE_SIZE[ownCatRef.current] })],
              });
            refreshOnline();
            refreshMetars();
          });
          map.setStyle(style, { diff: false });
        });
      };
      window.addEventListener("theme:changed", onTheme);

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
      map.on("dragstart", () => setFollow(false));

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

  const toggleTraffic = () => {
    const enable = !trafficOn;
    setTrafficBusy(true);
    // turning traffic on also shows the layers the user may have hidden before
    if (enable && !layersRef.current.traffic) toggleLayer("traffic");
    invoke("online_set_enabled", { network: "vatsim", enabled: enable })
      // the button stays as it was; say why instead of failing silently
      .catch((e) => {
        const m = userMessage(e, "vatsim");
        showToast({ id: "traffic-toggle", tone: "warn", title: enable ? "Verkehr nicht eingeschaltet" : "Verkehr nicht ausgeschaltet", body: `${m.title} ${m.hint}`, durationMs: 8000 });
      })
      .finally(() => setTrafficBusy(false));
  };

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
    <div className="map-wrap">
      <div ref={containerRef} className="map" />
      <div className="map-topleft">
      {overlay}
      <div className="map-toolbar">
        <button className="toggle" onClick={() => setFollow(!follow)} title="Karte folgt dem Flugzeug" aria-pressed={follow}>
          Folgen
        </button>
        <button className="map-toolbar-icon" onClick={center} title="Auf Flugzeug zentrieren" aria-label="Auf Flugzeug zentrieren" disabled={!telemetry}>
          <span aria-hidden="true">⌖</span>
        </button>
        <button
          className="toggle"
          onClick={toggle3d}
          aria-pressed={view3d}
          title={view3d ? "Karte wieder flach legen" : "Karte neigen und das Höhenprofil des Tracks zeigen – drehen und neigen auch mit rechter Maustaste oder Strg + Ziehen"}
        >
          3D
        </button>
        <div className="map-toggle-group" role="group" aria-label="Kartenebenen">
          <button
            className="toggle"
            onClick={toggleTraffic}
            disabled={trafficBusy}
            aria-pressed={trafficOn}
            title={trafficOn ? "VATSIM-Verkehr aus – es werden keine Daten mehr abgerufen" : "VATSIM-Verkehr und Lotsen anzeigen (ruft den öffentlichen VATSIM-Feed ab)"}
          >
            Verkehr
          </button>
          <button
            className="toggle"
            onClick={() => toggleLayer("atc")}
            disabled={!trafficOn}
            aria-pressed={trafficOn && layers.atc}
            title={trafficOn ? "Lotsen an Flughäfen" : "Erst „Verkehr“ einschalten"}
          >
            ATC
          </button>
          <button className="toggle" onClick={() => toggleLayer("weather")} aria-pressed={layers.weather} title={`METAR-Kategorie ab Zoom ${METAR_MIN_ZOOM}`}>
            Wetter
          </button>
        </div>
      </div>
      </div>
      <AirportReadout mapRef={mapRef} ready={routeReady} />
    </div>
  );
}
