import { useEffect, useRef, useState, type ReactNode } from "react";
import maplibregl, { type StyleSpecification } from "maplibre-gl";
import { loadBasemapStyle } from "./basemap";
import "maplibre-gl/dist/maplibre-gl.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AircraftInfo, Airport, FlightEvent, Metar, NavFix, OnlineSummary, OnlineView, Telemetry, TrackSample } from "../types";
import { WAKE_SIZE, icaoFromAtcModel, iconSizeExpr, wakeCategory } from "./aircraftIcons";
import {
  addAirportLayers,
  addRouteLayers,
  addTrackLayers,
  airportsGeoJson,
  loadPlaneIcon,
  pointFeature,
  routeGeoJson,
  samplesToPoints,
  segmentFeature,
  segmentsGeoJson,
  type TrackPoint,
} from "./common";
import { addOnlineLayers, atcGeoJson, metarsGeoJson, pilotsGeoJson, setGroupVisible, type OnlineLayerGroup } from "./online";
import { addAirportDiagramLayers } from "./airportDiagram";
import AirportReadout from "./AirportReadout";
import { COLOR } from "../theme";

const TRACK_POINT_INTERVAL_MS = 1000;
const AIRPORT_LIMIT = 600;
/** METAR badges appear from this zoom; below it there are too many airports to be useful. */
const METAR_MIN_ZOOM = 7;
const METAR_MAX_STATIONS = 40;
const LAYER_STORAGE_KEY = "vectasim.mapLayers";

type LayerState = Record<OnlineLayerGroup, boolean>;

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
  telemetry: Telemetry | null;
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
}

/**
 * Live map: basemap, airports in view, the current flight's track (seeded from the
 * recorder's in-memory samples, then appended at 1 Hz) and the own aircraft.
 */
export default function LiveMap({ telemetry, aircraft, route, onOnlineView, trafficOn = false, overlay }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  const pointsRef = useRef<TrackPoint[]>([]);
  const segmentsRef = useRef<GeoJSON.FeatureCollection>({ type: "FeatureCollection", features: [] });
  const lastPointMsRef = useRef(0);
  const followRef = useRef(true);
  const [follow, setFollowState] = useState(true);
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
      map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
      map.addControl(new maplibregl.ScaleControl({ unit: "nautical" }), "bottom-left");
      mapRef.current = map;

      // Online traffic/ATC: re-filtered from the backend's cached VATSIM snapshot on every
      // move and every poll (online:summary); debounced so a fling pans into one request.
      let onlineTimer: number | undefined;
      const refreshOnline = () => {
        window.clearTimeout(onlineTimer);
        onlineTimer = window.setTimeout(() => {
          const c = map.getCenter();
          invoke<OnlineView>("online_snapshot_in_bbox", { ...viewBbox(map), limit: 1500 })
            .then((v) => {
              (map.getSource("vatsim-pilots") as maplibregl.GeoJSONSource | undefined)?.setData(pilotsGeoJson(v.pilots));
              (map.getSource("vatsim-atc") as maplibregl.GeoJSONSource | undefined)?.setData(atcGeoJson(v.controllers));
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
        const src = () => map.getSource("metars") as maplibregl.GeoJSONSource | undefined;
        if (map.getZoom() < METAR_MIN_ZOOM || !layersRef.current.weather) {
          src()?.setData({ type: "FeatureCollection", features: [] });
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
            .then((list) => src()?.setData(metarsGeoJson(list, airportsRef.current)))
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
        addTrackLayers(map, "track");
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
        invoke<TrackSample[]>("get_live_track")
          .then((samples) => {
            pointsRef.current = samplesToPoints(samples);
            segmentsRef.current = segmentsGeoJson(pointsRef.current);
            lastPointMsRef.current = samples.length ? samples[samples.length - 1].tMs : 0;
            (map.getSource("track") as maplibregl.GeoJSONSource).setData(segmentsRef.current);
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
            src("track")?.setData(segmentsRef.current);
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

      map.on("moveend", refreshAirports);
      map.on("moveend", refreshOnline);
      map.on("dragstart", () => setFollow(false));

      const ro = new ResizeObserver(() => map.resize());
      ro.observe(container);

      const unlisten = listen<FlightEvent>("sim:flight-event", (e) => {
        if (e.payload.kind === "flightStarted") {
          pointsRef.current = [];
          segmentsRef.current = { type: "FeatureCollection", features: [] };
          lastPointMsRef.current = 0;
          (map.getSource("track") as maplibregl.GeoJSONSource | undefined)?.setData(segmentsRef.current);
        }
      });

      const unlistenOnline = listen<OnlineSummary>("online:summary", refreshOnline);
      const onLayersChanged = () => refreshMetars();
      window.addEventListener("vectasim:layers", onLayersChanged);

      return () => {
        ro.disconnect();
        window.clearTimeout(onlineTimer);
        window.clearTimeout(metarTimer);
        window.removeEventListener("vectasim:layers", onLayersChanged);
        window.removeEventListener("theme:changed", onTheme);
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
    if (!map || !readyRef.current || !telemetry) return;
    const { latitude: lat, longitude: lon } = telemetry;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    (map.getSource("aircraft") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: [pointFeature(lon, lat, { heading: telemetry.headingTrueDeg, cat: ownCat, sizeFactor: WAKE_SIZE[ownCat] })],
    });

    if (telemetry.timestampMs - lastPointMsRef.current >= TRACK_POINT_INTERVAL_MS) {
      lastPointMsRef.current = telemetry.timestampMs;
      const pt: TrackPoint = { lon, lat, altFt: telemetry.altitudeMslFt };
      const prev = pointsRef.current[pointsRef.current.length - 1];
      pointsRef.current.push(pt);
      if (prev) {
        segmentsRef.current.features.push(segmentFeature(prev, pt));
        (map.getSource("track") as maplibregl.GeoJSONSource | undefined)?.setData(segmentsRef.current);
      }
    }

    if (followRef.current) {
      map.easeTo({ center: [lon, lat], duration: 150, easing: (t) => t });
    }
  }, [telemetry]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trafficOn, routeReady]);

  const toggleTraffic = () => {
    const enable = !trafficOn;
    setTrafficBusy(true);
    // turning traffic on also shows the layers the user may have hidden before
    if (enable && !layersRef.current.traffic) toggleLayer("traffic");
    invoke("online_set_enabled", { network: "vatsim", enabled: enable })
      // the feed status (online:summary) carries errors; the button simply stays as it was
      .catch(() => {})
      .finally(() => setTrafficBusy(false));
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
      <div className="map-controls">
        <button className={follow ? "active" : ""} onClick={() => setFollow(!follow)} title="Karte folgt dem Flugzeug" aria-pressed={follow}>
          Folgen
        </button>
        <button onClick={center} title="Auf Flugzeug zentrieren" aria-label="Auf Flugzeug zentrieren" disabled={!telemetry}>
          <span aria-hidden="true">⌖</span>
        </button>
        <div className="map-toggle-group" role="group" aria-label="Kartenebenen">
          <button
            className={trafficOn ? "active" : ""}
            onClick={toggleTraffic}
            disabled={trafficBusy}
            aria-pressed={trafficOn}
            title={trafficOn ? "VATSIM-Verkehr aus – es werden keine Daten mehr abgerufen" : "VATSIM-Verkehr und Lotsen anzeigen (ruft den öffentlichen VATSIM-Feed ab)"}
          >
            Verkehr
          </button>
          <button
            className={trafficOn && layers.atc ? "active" : ""}
            onClick={() => toggleLayer("atc")}
            disabled={!trafficOn}
            aria-pressed={trafficOn && layers.atc}
            title={trafficOn ? "Lotsen an Flughäfen" : "Erst „Verkehr“ einschalten"}
          >
            ATC
          </button>
          <button className={layers.weather ? "active" : ""} onClick={() => toggleLayer("weather")} aria-pressed={layers.weather} title={`METAR-Kategorie ab Zoom ${METAR_MIN_ZOOM}`}>
            Wetter
          </button>
        </div>
      </div>
      </div>
      <AirportReadout mapRef={mapRef} ready={routeReady} />
    </div>
  );
}
