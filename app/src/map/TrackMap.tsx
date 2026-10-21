import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import { followLanguage, loadBasemapStyle } from "./basemap";
import "maplibre-gl/dist/maplibre-gl.css";
import "./maplibreWorker";
import "./trackView.css";
import type { AircraftInfo, TouchdownReport, TrackSample } from "../types";
import {
  addCurtainLayers,
  addTrackLayers,
  drawCurtainTrack,
  applyProjection,
  firstSymbolLayer,
  pointFeature,
  samplesToPoints,
  setCurtainVisible,
  setPitched,
  trackHeightAt,
  trackPoseAt,
  useGlobe,
  withProjection,
} from "./common";
import { useReplayStore } from "../landing/replayStore";
import { bandedTrackGeoJson, thinPoints, withGroundHeights } from "./trackChunks";
import { addAirportDiagramLayers } from "./airportDiagram";
import { COLOR, TRACK_MARKER, getMapTheme } from "../theme";
import { useT } from "../i18n";
import GlobeToggle from "./GlobeToggle";
import { AircraftModelLayer, type ModelPose } from "./aircraftModel";
import { modelKind } from "./aircraftMeshes";
import { WAKE_SIZE, icaoFromAtcModel, wakeCategory } from "./aircraftIcons";
import MapStyleToggle from "./MapStyleToggle";
import { followSatellite } from "./satellite";
import { altToCurtainM } from "./trackChunks";
import { pointsBounds } from "./geo";
import { addLayerOnce, addSourceOnce, removeCustomLayers, replaceCustomLayer } from "./styleOnce";
import MapUnavailable from "./MapUnavailable";
import { useHintIds } from "./hint";
import { landingGearDownIndex, touchdownEvents, trackEventDetail, trackEventLabel, type TrackEvent } from "../trackEvents";
import { EVENTS_LAYER, EVENTS_SOURCE, RUNS_LAYER, addTrackEventLayers, applyTrackEventFilter, trackEventsGeoJson } from "./trackEventLayers";
import TrackMarkersMenu, { useTrackEventFilter } from "./TrackMarkersMenu";

/** First draw of a long track: this many points at most; the full line follows once idle. */
const QUICK_POINTS = 1500;

interface Props {
  samples: TrackSample[];
  touchdowns: TouchdownReport[];
  departure?: { latitude: number; longitude: number } | null;
  arrival?: { latitude: number; longitude: number } | null;
  /** Flown aircraft: picks the 3D model's shape and size (generic narrow-body without it). */
  aircraft?: AircraftInfo | null;
  /**
   * Flight-path markers (trackEvents.ts) with the "Markers" filter menu; without it only the
   * touchdowns are marked (landing debrief) and the menu stays away.
   */
  events?: TrackEvent[];
  /** Full-screen button (logbook flight detail only): shown when given. */
  onFullscreen?: () => void;
  fullscreen?: boolean;
}

/** Tooltip of a marker: label, then the detail lines (text only, no HTML from data). */
function eventPopupNode(e: TrackEvent, clickHint: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "track-event-tip";
  const head = document.createElement("div");
  head.className = "track-event-tip-head";
  head.textContent = trackEventLabel(e);
  el.appendChild(head);
  for (const line of [...trackEventDetail(e), clickHint]) {
    const d = document.createElement("div");
    d.textContent = line;
    el.appendChild(d);
  }
  return el;
}

/** Pixel radius around the track within which a click picks the nearest moment. */
const PICK_PX = 16;
/** Follow mode re-centres only when the aircraft moved at least this far on screen. */
const FOLLOW_MIN_PX = 1;
/** Switching follow on zooms in to at least this level (a whole long-haul track is useless to follow). */
const FOLLOW_MIN_ZOOM = 11;

/** The cursor marker: an arrow pointing along the heading (rotated by MapLibre with the map). */
function cursorElement(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "track-cursor";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML =
    '<svg width="22" height="22" viewBox="-11 -11 22 22"><circle r="9" class="track-cursor-ring"/><path d="M0,-7 L5,5 L0,2.5 L-5,5 Z" class="track-cursor-arrow"/></svg>';
  return el;
}

/**
 * Static map of a recorded flight: altitude-coloured track, departure/arrival and touchdown
 * points, and the shared replay cursor (landing/replayStore.ts) as an arrow on the track;
 * a click near the track sets the cursor to that moment.
 */
export default function TrackMap({ samples, touchdowns, departure, arrival, aircraft, events, onFullscreen, fullscreen = false }: Props) {
  const t = useT();
  const store = useReplayStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<maplibregl.Marker | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  /** Identity of the last fitted track: the preview → full swap must not re-fit a zoomed map. */
  const fittedRef = useRef("");
  /** 3D view: pitched camera, the track as wall + ribbon at the flown altitude. */
  const [view3d, setView3d] = useState(false);
  /** The map could not be created (no WebGL2): MapUnavailable instead of a blank area. */
  const [mapFailed, setMapFailed] = useState(false);
  const view3dRef = useRef(false);
  /** Globe or flat Mercator, shared with the live map and the Länder view. */
  const [globe] = useGlobe();
  const globeRef = useRef(globe);
  globeRef.current = globe;
  /** 3D view: the low-poly aircraft at the cursor (or the track's end) at the curtain's height. */
  const modelRef = useRef<AircraftModelLayer | null>(null);
  /** Follow: the camera stays on the replay aircraft (cursor); dragging the map ends it. */
  const [follow, setFollowState] = useState(false);
  const followRef = useRef(false);
  const easeUntilRef = useRef(0);
  const setFollowFlag = (v: boolean) => {
    followRef.current = v;
    setFollowState(v);
  };
  const icao = icaoFromAtcModel(aircraft?.atcModel);
  const cat = wakeCategory(icao, aircraft?.title);
  const kind = modelKind(icao, aircraft?.title);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const setupMap = (container: HTMLDivElement, style: StyleSpecification | string): (() => void) => {
      const map = new maplibregl.Map({
        container,
        style: withProjection(style, globeRef.current, COLOR.bg),
        center: [8.57, 50.03],
        zoom: 6,
        attributionControl: { compact: true },
        interactive: true,
      });
      mapRef.current = map;
      // our layers; again after a theme change (setStyle drops them) and a WebGL context restore
      // (custom layers are not restored); idempotent, so a second style load cannot collide
      let diagramOff: (() => void) | undefined;
      const addOwnLayers = () => {
        diagramOff?.();
        diagramOff = addAirportDiagramLayers(map);
        addTrackLayers(map, "track");
        addCurtainLayers(map, "track-3d", firstSymbolLayer(map));
        setCurtainVisible(map, "track-3d", view3dRef.current);
        addSourceOnce(map, "markers", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        addLayerOnce(map, {
          id: "markers",
          type: "circle",
          source: "markers",
          paint: {
            // departure / arrival: neutral rings; touchdown: filled yellow dot
            "circle-radius": ["match", ["get", "kind"], "touchdown", 4.5, 5.5],
            "circle-color": ["match", ["get", "kind"], "touchdown", TRACK_MARKER.touchdown, COLOR.halo],
            "circle-stroke-color": ["match", ["get", "kind"], "dep", TRACK_MARKER.dep, "arr", TRACK_MARKER.arr, COLOR.halo],
            "circle-stroke-width": ["match", ["get", "kind"], "touchdown", 1.5, 2],
          },
        });
        addTrackEventLayers(map);
        applyTrackEventFilter(map, filterRef.current);
        const model = new AircraftModelLayer("aircraft-model", { body: COLOR.ownAircraft, dark: COLOR.aircraftEdge, light: getMapTheme().scheme === "light" });
        replaceCustomLayer(map, model);
        modelRef.current = model;
        model.setEnabled(view3dRef.current);
      };
      map.on("click", (e) => clickRef.current(e));
      // marker tooltips (hover); the click is handled in onClick (cursor to the marker's time)
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: "track-event-popup", maxWidth: "280px" });
      let hoverId: string | null = null;
      const onHover = (e: maplibregl.MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id as string | undefined;
        const ev = id ? eventsRef.current.find((x) => x.id === id) : undefined;
        if (!ev) return;
        map.getCanvas().style.cursor = "pointer";
        if (hoverId !== id) {
          hoverId = id ?? null;
          popup.setDOMContent(eventPopupNode(ev, tRef.current("map.markers.detail.click")));
        }
        popup.setLngLat(e.lngLat).addTo(map);
      };
      const onLeave = () => {
        hoverId = null;
        map.getCanvas().style.cursor = "";
        popup.remove();
      };
      for (const l of [EVENTS_LAYER, RUNS_LAYER]) {
        map.on("mousemove", l, onHover);
        map.on("mouseleave", l, onLeave);
      }
      // dragging takes the camera (only a user's drag carries an originalEvent)
      map.on("dragstart", (e) => {
        if (e.originalEvent && followRef.current) setFollowFlag(false);
      });
      // one handler for every style load (first load, theme change, context restore)
      map.on("style.load", () => {
        applyProjection(map, globeRef.current);
        addOwnLayers();
        readyRef.current = true;
        // latest props: samples may have arrived while the style was loading; a new style's
        // sources start empty, so the track is drawn again (the fit is kept: same track id)
        drawRef.current();
      });
      let themeSeq = 0;
      const reloadStyle = () => {
        const mySeq = ++themeSeq;
        void loadBasemapStyle().then((next) => {
          if (mySeq !== themeSeq || mapRef.current !== map) return;
          readyRef.current = false;
          // free the curtain's and the model's GL resources now (setStyle drops them without onRemove)
          removeCustomLayers(map);
          modelRef.current = null;
          map.setStyle(withProjection(next, globeRef.current, COLOR.bg), { diff: false });
        });
      };
      window.addEventListener("theme:changed", reloadStyle);
      // WebGL context lost: MapLibre drops the custom layers (curtain, model); on restore a fresh
      // style load re-adds everything, like a theme change
      map.on("webglcontextlost", () => {
        readyRef.current = false;
      });
      map.on("webglcontextrestored", reloadStyle);
      // basemap names follow the UI language (map/basemap.ts)
      const offLang = followLanguage(map);
      // Karte / Satellit (map/satellite.ts), re-applied after every theme change
      const offSat = followSatellite(map);
      const ro = new ResizeObserver(() => map.resize());
      ro.observe(container);
      return () => {
        window.removeEventListener("theme:changed", reloadStyle);
        offLang();
        offSat();
        diagramOff?.();
        ro.disconnect();
        cursorRef.current?.remove();
        cursorRef.current = null;
        map.remove();
        mapRef.current = null;
        readyRef.current = false;
      };
    };
    let disposed = false;
    let teardown: (() => void) | undefined;
    // patched basemap (map/basemap.ts); resolves at once from the in-memory copy after the first map
    void loadBasemapStyle()
      .then((style) => {
        if (disposed || !containerRef.current || mapRef.current) return;
        teardown = setupMap(containerRef.current, style);
      })
      // no WebGL2: a hint instead of a blank area
      .catch((e) => {
        console.error("track map: could not create the map", e);
        if (!disposed) setMapFailed(true);
      });
    return () => {
      disposed = true;
      teardown?.();
    };
  }, []);

  const draw = () => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    placeRef.current();
    // from the landing gear extension on, the path is green (2D line and 3D curtain alike)
    const points = samplesToPoints(samples, landingGearDownIndex(samples), COLOR.ok);
    const trackSrc = () => map.getSource("track") as maplibregl.GeoJSONSource | undefined;
    // 3D curtain: built once per track (thinned, smoothed; map/curtainLayer.ts)
    drawCurtainTrack(map, "track-3d", view3dRef.current ? withGroundHeights(points) : [], null);
    // Altitude-banded runs (a few hundred features instead of one per sample). Long tracks are
    // first drawn thinned so the map appears at once; the full resolution follows when the
    // map is idle (after the fit below) – it only matters when zoomed in.
    if (points.length > QUICK_POINTS) {
      trackSrc()?.setData(bandedTrackGeoJson(thinPoints(points, QUICK_POINTS)));
      const mySamples = samples;
      map.once("idle", () => {
        if (mapRef.current === map && samplesRef.current === mySamples) trackSrc()?.setData(bandedTrackGeoJson(points));
      });
    } else {
      trackSrc()?.setData(bandedTrackGeoJson(points));
    }
    const markers: GeoJSON.Feature[] = [];
    if (departure) markers.push(pointFeature(departure.longitude, departure.latitude, { kind: "dep" }));
    if (arrival) markers.push(pointFeature(arrival.longitude, arrival.latitude, { kind: "arr" }));
    (map.getSource("markers") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: markers });
    // touchdowns are markers of their own (filter group "touchdowns"), drawn by the event layer
    (map.getSource(EVENTS_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(trackEventsGeoJson(eventsRef.current, samples));
    for (const td of touchdowns) markers.push(pointFeature(td.longitude, td.latitude, { kind: "touchdown" }));

    const id = samples.length ? `${samples[0].tMs}` : `${departure?.latitude},${departure?.longitude},${arrival?.latitude},${arrival?.longitude}`;
    if (id === fittedRef.current) return;
    fittedRef.current = id;
    // another flight: start with the whole track, not following
    if (followRef.current) setFollowFlag(false);
    const coords = points.map((p) => [p.lon, p.lat] as [number, number]);
    for (const m of markers) coords.push((m.geometry as GeoJSON.Point).coordinates as [number, number]);
    // shortest longitude interval: a Pacific flight fits across ±180 (east > 180), not the whole world
    const bounds = coords.length >= 2 ? pointsBounds(coords) : null;
    if (bounds) {
      map.fitBounds(bounds, { padding: 30, maxZoom: 12, duration: 0 });
    } else if (coords.length >= 1) {
      map.jumpTo({ center: coords[0], zoom: 10 });
    }
  };

  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) applyProjection(map, globe);
  }, [globe]);

  const samplesRef = useRef(samples);
  samplesRef.current = samples;
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const shownEvents = useMemo(() => events ?? touchdownEvents(samples, touchdowns), [events, samples, touchdowns]);
  const eventsRef = useRef(shownEvents);
  eventsRef.current = shownEvents;
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(draw, [samples, touchdowns, departure, arrival, shownEvents, t]);
  // the shared "Markers" filter (also the profile chart's); without the menu every group shows
  const storedFilter = useTrackEventFilter();
  const filter = useMemo(() => (events ? storedFilter : { ...storedFilter, touchdowns: true }), [events, storedFilter]);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) applyTrackEventFilter(map, filter);
  }, [filter]);

  // shared cursor → marker; outside the subscription no React render per playback frame
  const placeCursor = () => {
    const map = mapRef.current;
    if (!map) return;
    const list = samplesRef.current;
    const tMs = store.get().tMs;
    if (view3dRef.current) {
      // 3D: no flat arrow on the ground – the model at the cursor, else at the end of the track
      cursorRef.current?.remove();
      cursorRef.current = null;
      const at = tMs ?? (list.length ? list[list.length - 1].tMs : null);
      const p = trackPoseAt(list, at);
      // height above the map's ground, on the curtain's scale (0 on the ground)
      const pose: ModelPose | null = p
        ? { lon: p.lon, lat: p.lat, headingDeg: p.headingDeg ?? 0, pitchDeg: p.pitchDeg, bankDeg: p.bankDeg, altFt: trackHeightAt(list, at) ?? 0, size: WAKE_SIZE[cat], kind }
        : null;
      modelRef.current?.setPose(pose);
      if (pose) followCamera(pose.lon, pose.lat, altToCurtainM(pose.altFt));
      return;
    }
    modelRef.current?.setPose(null);
    const pose = trackPoseAt(list, tMs);
    if (!pose) {
      cursorRef.current?.remove();
      cursorRef.current = null;
      return;
    }
    if (!cursorRef.current) {
      cursorRef.current = new maplibregl.Marker({ element: cursorElement(), rotationAlignment: "map", pitchAlignment: "map" }).setLngLat([pose.lon, pose.lat]).addTo(map);
    }
    cursorRef.current.setLngLat([pose.lon, pose.lat]).setRotation(pose.headingDeg ?? 0);
    cursorRef.current.getElement().classList.toggle("no-heading", pose.headingDeg == null);
    followCamera(pose.lon, pose.lat, 0);
  };
  /** Follow: keep the aircraft centred (3D: looking at its height, not at the ground below). */
  const followCamera = (lon: number, lat: number, elevation: number, animate = false) => {
    const map = mapRef.current;
    if (!map || !followRef.current || map.getCanvas().clientWidth === 0) return;
    if (animate) {
      map.easeTo({ center: [lon, lat], elevation, zoom: Math.max(map.getZoom(), FOLLOW_MIN_ZOOM), duration: 600 });
      easeUntilRef.current = performance.now() + 650;
      return;
    }
    // let the switch-on animation finish (a jump would cut it off)
    if (performance.now() < easeUntilRef.current) return;
    const target = map.project([lon, lat]);
    const here = map.project(map.getCenter());
    if (Math.hypot(target.x - here.x, target.y - here.y) >= FOLLOW_MIN_PX || Math.abs(map.getCenterElevation() - elevation) >= 2) map.jumpTo({ center: [lon, lat], elevation });
  };
  const toggleFollow = () => {
    const next = !followRef.current;
    setFollowFlag(next);
    if (!next) return;
    const list = samplesRef.current;
    if (list.length === 0) return;
    // nothing to follow without a cursor: start at the beginning of the flight (3D shows the end)
    if (store.get().tMs == null && !view3dRef.current) store.setCursor(list[0].tMs);
    const at = store.get().tMs ?? list[list.length - 1].tMs;
    const p = trackPoseAt(list, at);
    if (p) followCamera(p.lon, p.lat, view3dRef.current ? altToCurtainM(trackHeightAt(list, at) ?? 0) : 0, true);
  };
  const placeRef = useRef(placeCursor);
  placeRef.current = placeCursor;
  useEffect(() => {
    placeRef.current();
    return store.subscribe(() => placeRef.current());
  }, [store, samples, cat, kind]);

  // click near the track → the nearest sample's time (pinned, playback paused)
  const onClick = (e: maplibregl.MapMouseEvent) => {
    const map = mapRef.current;
    const list = samplesRef.current;
    if (!map || list.length === 0) return;
    // a marker: the replay cursor to its moment
    const layers = [EVENTS_LAYER, RUNS_LAYER].filter((l) => map.getLayer(l));
    const hit = layers.length ? map.queryRenderedFeatures(e.point, { layers })[0] : undefined;
    const hitT = hit?.properties?.tMs as number | undefined;
    if (hitT != null) {
      store.pause();
      store.setCursor(Math.min(list[list.length - 1].tMs, Math.max(list[0].tMs, hitT)));
      return;
    }
    let best = -1;
    let bestD = PICK_PX * PICK_PX;
    for (let i = 0; i < list.length; i++) {
      const p = map.project([list[i].longitude, list[i].latitude]);
      const d = (p.x - e.point.x) ** 2 + (p.y - e.point.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) {
      // without a transport bar (logbook) a click away from the track clears the pinned cursor
      if (!store.get().range) store.setCursor(null);
      return;
    }
    store.pause();
    store.setCursor(list[best].tMs);
  };
  const clickRef = useRef(onClick);
  clickRef.current = onClick;

  const toggle3d = () => {
    const next = !view3dRef.current;
    view3dRef.current = next;
    setView3d(next);
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    setCurtainVisible(map, "track-3d", next);
    drawCurtainTrack(map, "track-3d", next ? withGroundHeights(samplesToPoints(samplesRef.current)) : [], null);
    modelRef.current?.setEnabled(next);
    placeRef.current();
    setPitched(map, next);
  };

  // toolbar explanations for keyboard and screen-reader users (hint.tsx)
  const hints = useHintIds();
  const followHint = hints("follow", t("map.toolbar.followTitle"));
  const view3dHint = hints("3d", view3d ? t("map.toolbar.flatten") : t("map.toolbar.tilt"));
  const fullscreenHint = hints("fullscreen", fullscreen ? t("map.toolbar.fullscreenExitTitle") : t("map.toolbar.fullscreenTitle"));
  return (
    <div className="track-map-wrap">
      <div ref={containerRef} className="map track-map" />
      {mapFailed && <MapUnavailable />}
      <div className="map-toolbar track-map-toolbar">
        <button className="toggle" onClick={toggleFollow} aria-pressed={follow} title={t("map.toolbar.followTitle")} aria-describedby={followHint.describedBy}>
          {t("map.toolbar.follow")}
        </button>
        {followHint.node}
        <button
          className="toggle"
          onClick={toggle3d}
          aria-pressed={view3d}
          title={view3d ? t("map.toolbar.flatten") : t("map.toolbar.tilt")}
          aria-describedby={view3dHint.describedBy}
        >
          3D
        </button>
        {view3dHint.node}
        <GlobeToggle />
        <MapStyleToggle />
        {events && <TrackMarkersMenu />}
        {onFullscreen && (
          <>
            <button
              className="toggle track-fullscreen-btn"
              onClick={onFullscreen}
              aria-pressed={fullscreen}
              aria-label={fullscreen ? t("map.toolbar.fullscreenExit") : t("map.toolbar.fullscreen")}
              title={fullscreen ? t("map.toolbar.fullscreenExitTitle") : t("map.toolbar.fullscreenTitle")}
              aria-describedby={fullscreenHint.describedBy}
              data-track-fullscreen=""
            >
              <span aria-hidden="true">⛶</span>
            </button>
            {fullscreenHint.node}
          </>
        )}
      </div>
    </div>
  );
}
