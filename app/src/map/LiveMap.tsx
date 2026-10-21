import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import { followLanguage, loadBasemapStyle } from "./basemap";
import "maplibre-gl/dist/maplibre-gl.css";
import "./maplibreWorker";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AircraftInfo, Airport, FlightEvent, Metar, NavFix, OnlineSummary, OnlineView, Pilot, RouteResolution, TrackSample } from "../types";
import { WAKE_SIZE, icaoFromAtcModel, trafficColors, wakeCategory } from "./aircraftIcons";
import { Traffic3D } from "./trafficModel";
import type { TrafficHistoryFix, ViewBox } from "./traffic3d";
import { CameraGuard, FOLLOW_EVENT, FollowGlide, GLIDE_EVENT, anchorCenter, followCameraUpdate, isMultiTouch, stepTowards, type FollowAnchor, type GlidePoint } from "./followCamera";
import { FRAME_SLACK_MS, capRenders, followFrameMs, frameAfter, watchWindow, windowAway } from "./frameCap";
import { OWN_LAYERS, PULSE_MIN, addOwnAircraftLayers, haloOpacity, keepOwnOnTop, ownAircraftGeoJson, ownSymbolChanged, prefersReducedMotion, pulseOpacity } from "./ownAircraft";
import { AircraftModelLayer, metersPerPixel } from "./aircraftModel";
import { modelKind, type ModelKind } from "./aircraftMeshes";
import {
  addAirportLayers,
  addRouteLayers,
  addCurtainLayers,
  drawCurtainTrack,
  firstSymbolLayer,
  addTrackLayers,
  applyProjection,
  setCurtainVisible,
  setPitched,
  airportsGeoJson,
  loadPlaneIcon,
  routeGeoJson,
  useGlobe,
  withProjection,
  type TrackPoint,
} from "./common";
import { ChunkedTrack, altToCurtainM } from "./trackChunks";
import {
  addOnlineLayers,
  atcGeoJson,
  geoJsonKey,
  metarsGeoJson,
  onPilotClick,
  pilotsGeoJson,
  selectedGeoJson,
  setGroupVisible,
  type OnlineLayerGroup,
} from "./online";
import TrafficCard, { type TrafficRouteState } from "./TrafficCard";
import { trafficRouteCoords, trafficRouteDraw, trafficRouteGeoJson, type TrafficRouteDraw } from "./trafficRoute";
import { useTrafficSelection } from "./trafficHooks";
import { MOVE_REFRESH, boundedDebounce } from "./debounce";
import { SELECT_TRAFFIC_EVENT, greatCircle, sameTraffic, type SelectTrafficDetail, type TrafficRef } from "./trafficInfo";
import { addAirportDiagramLayers } from "./airportDiagram";
import AirportReadout from "./AirportReadout";
import { COLOR, getMapTheme } from "../theme";
import TrafficToggle from "./TrafficToggle";
import GlobeToggle, { useMapZoom } from "./GlobeToggle";
import MapStyleToggle from "./MapStyleToggle";
import WeatherToggle, { WeatherLegend } from "./WeatherToggle";
import { followSatellite } from "./satellite";
import { attachWeather, getWeatherState } from "./weatherOverlay";
import { useTelemetry } from "../telemetryStore";
import { useT } from "../i18n";
import { queryBox, unwrapLon, viewBbox } from "./geo";
import { sequence } from "./sequence";
import { replaceCustomLayer } from "./styleOnce";
import { attachStyleLifecycle } from "./styleLifecycle";
import MapUnavailable from "./MapUnavailable";
import { useHintIds } from "./hint";

const TRACK_POINT_INTERVAL_MS = 1000;
const AIRPORT_LIMIT = 600;
/** METAR badges appear from this zoom; below it there are too many airports to be useful. */
const METAR_MIN_ZOOM = 7;
const METAR_MAX_STATIONS = 40;
const LAYER_STORAGE_KEY = "vectasim.mapLayers";
/** Track sources: closed 10-min blocks (diff-updated rarely) and the open block (per sample). */
const TRACK_HISTORY = "track-history";
const TRACK_LIVE = "track-live";
/** 3D view: the track as wall + band at the flown height (custom layer, map/curtainLayer.ts). */
const TRACK_3D = "track-3d";
const VIEW3D_STORAGE_KEY = "vectasim.map3d";
/** The own aircraft's 3D model (custom layer) and the stack kept above every other layer. */
const MODEL_LAYER = "aircraft-model";
const OWN_STACK = [...OWN_LAYERS, MODEL_LAYER];
/** Follow mode moves the camera only when the aircraft moved at least this far on screen… */
const FOLLOW_MIN_PX = 0.5;
/** …or when its height (3D view) changed by this much. */
const FOLLOW_MIN_ELEVATION_M = 2;
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

/** The part of a MapLibre map revealTraffic needs (a fake in the tests). */
export type RevealMap = Pick<maplibregl.Map, "project" | "easeTo"> & { getCanvas(): { clientWidth: number; clientHeight: number } };

/**
 * First position of a newly selected aircraft (a click on the map): when it lies under the
 * traffic card, the HUD or the toolbar, the camera eases it into the free area. That move takes
 * the camera, so - as with a selection from the online list - the own aircraft is not followed any
 * more (`suspendOwnFollow`, back when the card closes), and the ease is one of our glides
 * (GLIDE_EVENT): as a plain move, the follow hook (followCameraUpdate) put the own aircraft back
 * into the centre on every frame of it and the selected one stayed hidden. Returns whether the
 * camera moves.
 */
export function revealTraffic(map: RevealMap, pos: { lon: number; lat: number }, insets: MapInsets, suspendOwnFollow: () => void): boolean {
  const canvas = map.getCanvas();
  if (pointFree(map.project([pos.lon, pos.lat]), insets, canvas.clientWidth, canvas.clientHeight)) return false;
  suspendOwnFollow();
  map.easeTo({ center: [pos.lon, pos.lat], offset: insetOffset(insets), duration: 500 }, GLIDE_EVENT);
  return true;
}

/**
 * The ground vector from the canvas centre to the screen point `off` px away (the free area's
 * centre), at the current zoom: a follow anchor's shift (followCamera.ts anchorCenter).
 */
function groundShift(map: maplibregl.Map, [ox, oy]: [number, number]): FollowAnchor["shift"] {
  if (!ox && !oy) return undefined;
  const canvas = map.getCanvas();
  const cx = canvas.clientWidth / 2;
  const cy = canvas.clientHeight / 2;
  const a = map.unproject([cx, cy]);
  const b = map.unproject([cx + ox, cy + oy]);
  const shift = { dLon: b.lng - a.lng, dLat: b.lat - a.lat, atZoom: map.getZoom() };
  return Number.isFinite(shift.dLon) && Number.isFinite(shift.dLat) ? shift : undefined;
}

/** Would moving the camera centre to `to` show (≥ FOLLOW_MIN_PX on screen or FOLLOW_MIN_ELEVATION_M of centre height)? */
export function cameraMoveVisible(map: Pick<maplibregl.Map, "getCenterElevation" | "getCenter" | "project">, to: GlidePoint): boolean {
  if (Math.abs(map.getCenterElevation() - to.elev) >= FOLLOW_MIN_ELEVATION_M) return true;
  const a = map.project(map.getCenter());
  const b = map.project([to.lon, to.lat]);
  return Math.hypot(b.x - a.x, b.y - a.y) >= FOLLOW_MIN_PX;
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

/** Airports of a (possibly unwrapped) box: the height reference of the 3D traffic (trafficModel.ts). */
function airportsAround(b: ViewBox): Promise<Airport[]> {
  return invoke<Airport[]>("airports_in_bbox", { ...queryBox(b), limit: 2000 });
}

interface Props {
  /** Identity of the own aircraft – decides silhouette and size (wake class). */
  aircraft?: AircraftInfo | null;
  /** Planned route (OFP navlog), drawn dashed under the flown track. */
  route?: NavFix[] | null;
  /** Receives the online traffic/ATC currently in view (for the Online panel). */
  onOnlineView?: (view: OnlineView | null, center: { lat: number; lon: number }) => void;
  /**
   * The map shows online traffic: some network enabled (settings `online_vatsim` / `online_ivao`) and shown
   * (`OnlineSummary.shown`, the "Verkehr" toggle – TrafficToggle, online_set_shown). Hidden, the feeds keep polling in
   * the background (track history for the curtain); the map then neither queries nor draws traffic or ATC.
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

/** The curtain up to the track's points (incremental: only new points are processed). */
function drawCurtain(map: maplibregl.Map, track: ChunkedTrack) {
  drawCurtainTrack(map, TRACK_3D, track.points);
}

/** The curtain plus the stretch from the last point to the aircraft (`now`), per sample: no gap between wall and model. */
function drawCurtainHead(map: maplibregl.Map, track: ChunkedTrack, now: TrackPoint | null) {
  drawCurtainTrack(map, TRACK_3D, track.points, now);
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
  const [routeReady, setRouteReady] = useState(false);
  /** The map could not be created (no WebGL2): MapUnavailable instead of a blank area. */
  const [mapFailed, setMapFailed] = useState(false);
  const zoom = useMapZoom(mapRef, routeReady);
  const [layers, setLayers] = useState<LayerState>(loadLayerState);
  const layersRef = useRef(layers);
  const trafficOnRef = useRef(trafficOn);
  trafficOnRef.current = trafficOn;
  /** The map effect's (debounced) online refresh, for the show/hide effect below. */
  const refreshOnlineRef = useRef<() => void>(() => {});
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
  const trafficRouteRef = useRef<TrafficRouteDraw | null>(null);
  /** What the card says under its route button (resolving, n of m resolved, great circle). */
  const [trafficRoute, setTrafficRoute] = useState<TrafficRouteState | null>(null);
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
        map.easeTo({ center: [t.longitude, t.latitude], duration: 500 }, GLIDE_EVENT);
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

  // ---- own aircraft: 2D symbol + halo, 3D model (map/ownAircraft.ts, map/aircraftModel.ts) ----
  const modelRef = useRef<AircraftModelLayer | null>(null);
  const ownKindRef = useRef<ModelKind>("narrowbody");
  // ---- online traffic as 3D models (pitched view, zoom >= 8; map/trafficModel.ts) ----
  const traffic3dRef = useRef<Traffic3D | null>(null);
  const syncTraffic3d = () => traffic3dRef.current?.update(view3dRef.current, groupVisible("traffic"));
  const syncTraffic3dRef = useRef(syncTraffic3d);
  syncTraffic3dRef.current = syncTraffic3d;
  const guardRef = useRef<CameraGuard | null>(null);
  /** Free-area offset of the followed aircraft (card, HUD), measured at most twice a second. */
  const followInsetRef = useRef<{ at: number; off: [number, number] }>({ at: -Infinity, off: [0, 0] });
  /** Latest own position for the follow anchor; `elev3d` = the camera height that looks at the aircraft in 3D. */
  const ownAnchorRef = useRef<{ lon: number; lat: number; elev3d: number } | null>(null);
  /** Where "Folgen" holds a selected aircraft (its position, shifted into the free area beside the card). */
  const trafficAnchorRef = useRef<FollowAnchor | null>(null);
  /**
   * What the follow camera holds while the user zooms / rotates (followCameraUpdate): the own
   * aircraft (2D: centre height 0, like the follow moves), else a followed traffic aircraft.
   */
  const followAnchor = (): FollowAnchor | null => {
    if (followRef.current) {
      const o = ownAnchorRef.current;
      return o ? { lon: o.lon, lat: o.lat, elev: view3dRef.current ? o.elev3d : 0 } : null;
    }
    return followTrafficRef.current ? trafficAnchorRef.current : null;
  };
  const followAnchorRef = useRef(followAnchor);
  followAnchorRef.current = followAnchor;
  /**
   * "Folgen" for a selected aircraft drawn as a 3D model: every animation frame (Traffic3D's
   * selected loop) the camera centre moves onto the model's drawn pose at its height – the same
   * pose the model is drawn at, so it stands still on screen instead of drifting away and being
   * caught up by a 600 ms ease every 15 s. No camera command while the user has the camera
   * (followCameraUpdate holds the aircraft in place during a zoom or rotation, from the anchor
   * set here); afterwards it glides on (CameraGuard.catchUp).
   */
  const followTrafficFrame = (now: number) => {
    const map = mapRef.current;
    const guard = guardRef.current;
    if (!map || !guard || !followTrafficRef.current) return;
    const pose = traffic3dRef.current?.selectedPose(now);
    if (!pose) return;
    const ins = followInsetRef.current;
    if (now - ins.at > 500) followInsetRef.current = { at: now, off: insetOffset(measureInsets(wrapRef.current)) };
    // the anchor follows the pose on every frame, also while the user zooms (followCameraUpdate holds it then)
    const anchor: FollowAnchor = { lon: pose.lon, lat: pose.lat, elev: altToCurtainM(pose.hFt), shift: groundShift(map, followInsetRef.current.off) };
    trafficAnchorRef.current = anchor;
    if (guard.busy()) return;
    const c = map.getCenter();
    // in the camera centre's world copy (an ease over the date line leaves it beyond ±180)
    const target = { ...anchorCenter(anchor, map.getZoom(), c.lng), elev: anchor.elev ?? 0 };
    if (![target.lon, target.lat].every(Number.isFinite)) return;
    const next = stepTowards({ lon: c.lng, lat: c.lat, elev: map.getCenterElevation() }, target, guard.catchUp(now));
    // not half a pixel: no camera move, no frame (frameCap.ts)
    if (cameraMoveVisible(map, next)) map.jumpTo({ center: [next.lon, next.lat], elevation: next.elev }, FOLLOW_EVENT);
  };
  const followTrafficFrameRef = useRef(followTrafficFrame);
  followTrafficFrameRef.current = followTrafficFrame;
  /**
   * Own-aircraft follow: per sample a glide from the camera towards the aircraft (FollowGlide),
   * stepped with jumpTo at the follow frame rate (30 fps, 15 fps without window focus) and only
   * when the step shows – a 150 ms easeTo per sample rendered at the display's full rate.
   */
  const glideRef = useRef(new FollowGlide());
  /** Cancels the scheduled glide step (undefined: no step scheduled). */
  const glideCancelRef = useRef<(() => void) | undefined>(undefined);
  const glideStepAtRef = useRef(-Infinity);
  const lastSampleAtRef = useRef(0);
  /** The next glide step on the first frame `delayMs` from now - asleep in between, not woken at the display rate. */
  const scheduleGlide = (delayMs: number) => {
    glideCancelRef.current = frameAfter(delayMs, (t) => followStepRef.current(t));
  };
  const followStep = (now: number) => {
    glideCancelRef.current = undefined;
    const map = mapRef.current;
    const glide = glideRef.current;
    // minimised (requestAnimationFrame keeps running in WebView2): no camera steps; the first
    // sample after it glides from where the camera stopped
    if (!map || !followRef.current || windowAway()) {
      glide.clear();
      return;
    }
    const frameMs = followFrameMs();
    const wait = glideStepAtRef.current + frameMs - FRAME_SLACK_MS - now;
    if (wait > 0) {
      scheduleGlide(wait);
      return;
    }
    const target = glide.at(now);
    // never while the user rotates / pitches / zooms (every camera command resets the gesture handlers)
    if (target && !guardRef.current?.busy() && map.getCanvas().clientWidth > 0) {
      // in the camera centre's world copy: no jump by a whole world after an ease over the date line
      const to = { ...target, lon: unwrapLon(target.lon, map.getCenter().lng) };
      if (cameraMoveVisible(map, to)) {
        glideStepAtRef.current = now;
        map.jumpTo({ center: [to.lon, to.lat], elevation: to.elev }, FOLLOW_EVENT);
      }
    }
    if (!glide.done(now)) scheduleGlide(frameMs);
  };
  const followStepRef = useRef(followStep);
  followStepRef.current = followStep;
  useEffect(
    () => () => {
      glideCancelRef.current?.();
      glideCancelRef.current = undefined;
    },
    [],
  );
  /** The symbol data last sent to the "aircraft" source (null: send the next one in any case). */
  const ownSentRef = useRef<GeoJSON.FeatureCollection | null>(null);
  /** Symbol data and model pose from the latest sample (each sample, theme change, 3D toggle). */
  const drawOwn = () => {
    const map = mapRef.current;
    if (!map) return;
    const t = telemetryRef.current;
    const model = modelRef.current;
    const modelOn = !!model && !model.failed;
    const pose =
      t && Number.isFinite(t.latitude) && Number.isFinite(t.longitude)
        ? {
            lon: t.longitude,
            lat: t.latitude,
            headingDeg: t.headingTrueDeg,
            // height above the map's ground, like the curtain (MSL would float a parked aircraft at the field elevation)
            altFt: trackRef.current.heightFor({ altFt: t.altitudeMslFt, aglFt: t.altitudeAglFt, onGround: t.onGround }),
            cat: ownCatRef.current,
          }
        : null;
    // only a change that shows is sent: every setData re-tiles the source and renders a frame
    const data = ownAircraftGeoJson(pose, view3dRef.current, modelOn);
    const src = map.getSource("aircraft") as maplibregl.GeoJSONSource | undefined;
    if (src && ownSymbolChanged(ownSentRef.current, data, metersPerPixel(pose?.lat ?? 0, map.getZoom()))) {
      src.setData(data);
      ownSentRef.current = data;
    }
    model?.setPose(t && pose ? { ...pose, pitchDeg: t.pitchDeg, bankDeg: t.bankDeg, size: WAKE_SIZE[pose.cat], kind: ownKindRef.current } : null);
  };
  const drawOwnRef = useRef(drawOwn);
  drawOwnRef.current = drawOwn;
  /**
   * A slow breath of the halo while the camera does not follow the aircraft (it may be anywhere
   * on screen then); still when following, in 3D (the model replaces the halo) or with
   * prefers-reduced-motion. ~15 paint updates per second, only while it runs.
   */
  const pulseRef = useRef<() => void>(() => {});
  const hasTelemetry = telemetry != null;
  useEffect(() => {
    let timer: number | undefined;
    const stop = () => {
      window.clearInterval(timer);
      timer = undefined;
      const map = mapRef.current;
      if (map?.getLayer(OWN_LAYERS[0])) map.setPaintProperty(OWN_LAYERS[0], "icon-opacity", haloOpacity(PULSE_MIN));
    };
    const update = () => {
      const run = !follow && !view3d && routeReady && hasTelemetry && !prefersReducedMotion();
      if (!run) return stop();
      if (timer !== undefined) return;
      timer = window.setInterval(() => {
        const map = mapRef.current;
        if (!map || !readyRef.current || windowAway() || map.getCanvas().clientWidth === 0) return;
        if (map.getLayer(OWN_LAYERS[0])) map.setPaintProperty(OWN_LAYERS[0], "icon-opacity", haloOpacity(pulseOpacity(performance.now())));
      }, 66);
    };
    pulseRef.current = update;
    update();
    return stop;
  }, [follow, view3d, routeReady, hasTelemetry]);

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
        // the 3D follow camera looks at the aircraft's height (no terrain: otherwise clamped to 0)
        centerClampedToGround: false,
        // no 300 ms label fade: with moving traffic and the follow camera the placement changes
        // several times a second, and every fade kept MapLibre rendering at the display's full
        // rate (measured in 3D follow: ~52 → ~27 frames/s from this alone; frameCap.ts)
        fadeDuration: 0,
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "top-right");
      map.addControl(new maplibregl.ScaleControl({ unit: "nautical" }), "bottom-left");
      mapRef.current = map;
      // the selected aircraft's flown track for its curtain (backend history of the feed)
      const traffic3d = new Traffic3D(airportsAround, (network, cid) => invoke<TrafficHistoryFix[]>("traffic_track", { network, cid }));
      traffic3dRef.current = traffic3d;
      // follow cameras wait while the user (or another animation) has the camera (map/followCamera.ts)
      const guard = new CameraGuard(map);
      guardRef.current = guard;
      // every frame outside gestures and camera animations at the follow frame rate, none while
      // minimised; the window's focus and minimised state from Tauri (frameCap.ts)
      const renderCap = capRenders(map, () => guard.busy() || map.isMoving());
      const unwatchWindow = watchWindow();
      // zooming / rotating while following: every frame keeps the followed aircraft in place,
      // zoom, bearing and pitch stay the user's (no snap back after the zoom)
      map.setTransformCameraUpdate(followCameraUpdate(guard, () => followAnchorRef.current(), (lon, lat) => new maplibregl.LngLat(lon, lat)));
      traffic3d.onSelectedFrame = (now) => followTrafficFrameRef.current(now);

      // Online traffic/ATC: re-filtered from the backend's cached VATSIM snapshot on every
      // move and every poll (online:summary); debounced so a fling pans into one request, but at
      // most 1 s late: the 3D follow camera ends a move several times a second while airborne,
      // a plain debounce never fired then (cold start with 3D on: no traffic, ATC, METAR rings).
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
      // a failing refresh is logged once per path (the map shows nothing else about it)
      const warned = new Set<string>();
      const warnOnce = (what: string) => (e: unknown) => {
        if (warned.has(what)) return;
        warned.add(what);
        console.warn(`live map: ${what} failed`, e);
      };
      const refreshOnline = boundedDebounce(
        () => {
          // an online:summary before the first style load: no sources yet, the load handler asks again
          if (!readyRef.current) return;
          const c = map.getCenter();
          // traffic hidden: the feeds poll on in the background (online:summary keeps coming), the
          // map asks for nothing and drops what it drew; showing it again refreshes at once
          if (!trafficOnRef.current) {
            setIfChanged("vatsim-pilots", pilotsGeoJson([]));
            traffic3d.setPilots([]);
            setIfChanged("vatsim-atc", atcGeoJson([]));
            onOnlineViewRef.current?.(null, { lat: c.lat, lon: c.lng });
            return;
          }
          invoke<OnlineView>("online_snapshot_in_bbox", { ...viewBbox(map), limit: 1500 })
            .then((v) => {
              setIfChanged("vatsim-pilots", pilotsGeoJson(v.pilots));
              traffic3d.setPilots(v.pilots);
              setIfChanged("vatsim-atc", atcGeoJson(v.controllers));
              onOnlineViewRef.current?.(v.summary.enabled ? v : null, { lat: c.lat, lon: c.lng });
            })
            // filters the cached snapshot locally; feed errors surface via online:summary.lastError
            .catch(warnOnce("online refresh"));
        },
        ...MOVE_REFRESH.online,
      );
      refreshOnlineRef.current = refreshOnline;

      // METARs only for the biggest airports in view (<= 40), only when zoomed in and the
      // layer is on; the backend caches each station for 10 min, so re-asking is cheap.
      // Debounced like the online refresh, at most 1.5 s late (the follow camera moves on).
      const queryMetars = boundedDebounce(
        () => {
          const zoom = map.getZoom();
          const candidates = [...airportsRef.current.values()]
            .filter((a) => a.kind === "large" || a.kind === "medium" || (zoom >= 9 && a.kind === "small"))
            .filter((a) => /^[A-Z]{4}$/.test(a.ident))
            .slice(0, METAR_MAX_STATIONS);
          if (!candidates.length) return;
          invoke<Metar[]>("metars", { icaos: candidates.map((a) => a.ident) })
            .then((list) => setIfChanged("metars", metarsGeoJson(list, airportsRef.current)))
            // map badges are best effort; the flight bar shows METAR errors for the relevant station
            .catch(warnOnce("METAR refresh"));
        },
        ...MOVE_REFRESH.metars,
      );
      const refreshMetars = () => {
        if (map.getZoom() < METAR_MIN_ZOOM || !layersRef.current.weather || !getWeatherState().prefs.metar) {
          queryMetars.cancel();
          setIfChanged("metars", { type: "FeatureCollection", features: [] });
          return;
        }
        queryMetars();
      };

      // only the latest lookup's answer is drawn: an older one arriving late would put dots (and
      // METAR candidates) of a previous view on the map
      const beginAirports = sequence();
      const refreshAirports = () => {
        const isLatest = beginAirports();
        // wrapped box: a view across ±180 (west 170, east 190) finds the airports on both sides
        invoke<Airport[]>("airports_in_bbox", { ...viewBbox(map), limit: AIRPORT_LIMIT })
          .then((list) => {
            if (!isLatest() || mapRef.current !== map) return;
            // the same airports as last time (following: 2 lookups a second): no re-tiling, no frame
            const key = list.map((a) => a.ident).join(",");
            if (key !== sentKeys.get("airports")) {
              sentKeys.set("airports", key);
              (map.getSource("airports") as maplibregl.GeoJSONSource | undefined)?.setData(airportsGeoJson(list));
            }
            airportsRef.current = new Map(list.map((a) => [a.ident, a]));
            refreshMetars();
          })
          // embedded airport DB; on failure the previous dots simply stay
          .catch(warnOnce("airport refresh"));
      };
      // on moveend: the 3D follow camera ends a move several times a second while airborne
      const refreshAirportsSoon = boundedDebounce(refreshAirports, ...MOVE_REFRESH.airports);

      // Our layers on top of the basemap. Runs on every style load: the first one, a theme
      // change (setStyle drops every source, layer and image) and a WebGL context restore;
      // colours come from theme.ts. Idempotent (styleOnce.ts) and abandoned as soon as a newer
      // style load started (`isCurrent`), so two loads in quick succession cannot collide.
      let diagramOff: (() => void) | undefined;
      const addOwnLayers = async (isCurrent: () => boolean): Promise<boolean> => {
        diagramOff?.();
        diagramOff = addAirportDiagramLayers(map);
        addAirportLayers(map);
        addRouteLayers(map, "route");
        addTrackLayers(map, [TRACK_HISTORY, TRACK_LIVE]);
        addCurtainLayers(map, TRACK_3D, firstSymbolLayer(map));
        setCurtainVisible(map, TRACK_3D, view3dRef.current);
        if (!(await addOnlineLayers(map, undefined, isCurrent))) return false;
        for (const g of Object.keys(layersRef.current) as OnlineLayerGroup[]) setGroupVisible(map, g, groupVisible(g));
        // traffic models below the flat traffic symbols, so callsigns and click targets stay above them
        traffic3d.attach(map, { body: trafficColors().fill, accent: COLOR.accent, dark: COLOR.aircraftEdge, light: getMapTheme().scheme === "light" }, TRACK_3D);
        syncTraffic3dRef.current();
        await loadPlaneIcon(map);
        if (!isCurrent()) return false;
        // own aircraft last, so it starts above traffic and labels (keepOwnOnTop keeps it there):
        // halo + bold-edged symbol in 2D, the low-poly model at the curtain's height in 3D
        addOwnAircraftLayers(map, "aircraft");
        const model = new AircraftModelLayer(MODEL_LAYER, { body: COLOR.ownAircraft, dark: COLOR.aircraftEdge, light: getMapTheme().scheme === "light" });
        // shaders refused: the flat symbol stays, raised to the curtain height instead
        model.onFail = () => drawOwnRef.current();
        replaceCustomLayer(map, model);
        modelRef.current = model;
        model.setEnabled(view3dRef.current);
        drawOwnRef.current();
        pulseRef.current();
        return true;
      };
      // anything added later (weather overlay, diagram, traffic) goes below the own aircraft
      map.on("styledata", () => {
        if (map.getLayer(MODEL_LAYER)) keepOwnOnTop(map, OWN_STACK);
      });

      /** Data drawn into the (new) sources from what the refs hold: after every style load. */
      const restoreData = () => {
        const src = (id: string) => map.getSource(id) as maplibregl.GeoJSONSource | undefined;
        sentKeys.clear();
        // a new style has a new, empty "aircraft" source
        ownSentRef.current = null;
        drawTrack(map, trackRef.current, true);
        if (view3dRef.current) drawCurtain(map, trackRef.current);
        src("airports")?.setData(airportsGeoJson([...airportsRef.current.values()]));
        src("route")?.setData(routeGeoJson(routeRef.current ?? []));
        src("traffic-selected")?.setData(selectedGeoJson(selectedPosRef.current));
        src("traffic-route")?.setData(trafficRouteGeoJson(trafficRouteRef.current));
        drawOwnRef.current();
        refreshOnline();
        refreshMetars();
      };
      /** First complete style load: what the old `load` handler did once. */
      const firstReady = () => {
        // a remembered 3D view starts tilted, not flat until the next toggle
        if (view3dRef.current) setPitched(map, true, 0);
        setRouteReady(true);
        refreshAirports();
        // seed the track with what the recorder already has for the active flight
        // (whole list over IPC once per mount; points that arrive meanwhile are kept by seed())
        invoke<TrackSample[]>("get_live_track")
          .then((samples) => {
            if (mapRef.current !== map) return;
            trackRef.current.seed(
              samples.map((s) => ({ lon: s.longitude, lat: s.latitude, altFt: s.altitudeMslFt, aglFt: s.altitudeAglFt, onGround: s.onGround, tMs: s.tMs })),
            );
            drawTrack(map, trackRef.current, true);
            if (view3dRef.current) drawCurtain(map, trackRef.current);
          })
          // no live track yet (no active flight): the track starts empty and fills at 1 Hz
          .catch(() => {});
      };
      // One handler for every style load, serialised by a generation counter: a theme change
      // before the first load (or two in a row) used to run the layer setup twice on one style
      // ("Source already exists"), and the aborted first-load path never set routeReady. A theme
      // change and a WebGL context restore load a fresh basemap the same way (styleLifecycle.ts).
      const lifecycle = attachStyleLifecycle(map, {
        setup: (isCurrent) => {
          // style URL fallback (offline) carries no projection: set it here
          applyProjection(map, globeRef.current);
          return addOwnLayers(isCurrent);
        },
        ready: (first) => {
          readyRef.current = true;
          restoreData();
          if (first) firstReady();
        },
        unready: () => {
          readyRef.current = false;
        },
        // the model is gone: the flat symbol must not stay hidden for it (`m: 1`, ownAircraft.ts)
        dropped: () => {
          modelRef.current = null;
        },
        loadStyle: () => loadBasemapStyle().then((style) => withProjection(style, globeRef.current, COLOR.bg)),
        alive: () => mapRef.current === map,
        onError: (e) => console.warn("live map: style setup failed", e),
      });
      const reloadStyle = lifecycle.reload;
      window.addEventListener("theme:changed", reloadStyle);
      // basemap names follow the UI language (map/basemap.ts)
      const offLang = followLanguage(map);
      // Karte / Satellit and the radar / cloud overlay (map/satellite.ts, map/weatherOverlay.ts)
      const offSat = followSatellite(map);
      const offWeather = attachWeather(map);

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

      map.on("moveend", refreshAirportsSoon);
      map.on("moveend", refreshOnline);
      // zoom threshold and the picked <= 200 follow the camera (the follow cameras end a move up to
      // every frame: a few re-picks per second are plenty)
      const syncTraffic3dSoon = boundedDebounce(() => syncTraffic3dRef.current(), ...MOVE_REFRESH.traffic3d);
      map.on("moveend", syncTraffic3dSoon);
      // dragging takes the camera: neither the own aircraft nor a selected one is followed;
      // a two-finger pinch (which pans too) only zooms
      map.on("dragstart", (e: { originalEvent?: Event }) => {
        if (isMultiTouch(e.originalEvent)) return;
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
        if (followRef.current && t && Number.isFinite(t.latitude) && Number.isFinite(t.longitude))
          map.jumpTo({ center: [unwrapLon(t.longitude, map.getCenter().lng), t.latitude] });
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

      const unlistenOnline = listen<OnlineSummary>("online:summary", () => refreshOnline());
      const onLayersChanged = () => refreshMetars();
      window.addEventListener("vectasim:layers", onLayersChanged);

      return () => {
        ro.disconnect();
        window.removeEventListener("resize", resize);
        window.removeEventListener(MAP_VISIBLE_EVENT, resize);
        refreshOnline.cancel();
        refreshOnlineRef.current = () => {};
        queryMetars.cancel();
        refreshAirportsSoon.cancel();
        syncTraffic3dSoon.cancel();
        unwatchWindow();
        renderCap.dispose();
        lifecycle.dispose();
        guard.dispose();
        guardRef.current = null;
        window.removeEventListener("vectasim:layers", onLayersChanged);
        window.removeEventListener("theme:changed", reloadStyle);
        offLang();
        offSat();
        offWeather();
        window.removeEventListener("offline", onBrowserOffline);
        diagramOff?.();
        traffic3d.dispose();
        traffic3dRef.current = null;
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
    void loadBasemapStyle()
      .then((style) => {
        if (disposed || !containerRef.current || mapRef.current) return;
        teardown = setupMap(containerRef.current, style);
      })
      // no WebGL2 (or the GPU process refused a context): a hint instead of a blank area
      .catch((e) => {
        console.error("live map: could not create the map", e);
        if (!disposed) setMapFailed(true);
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
  const ownIcao = icaoFromAtcModel(aircraft?.atcModel);
  const ownCat = wakeCategory(ownIcao, aircraft?.title, telemetry?.totalWeightKg);
  ownCatRef.current = ownCat;
  // 3D model shape: like the 2D silhouette by wake class, refined to prop / turboprop / helicopter
  const ownKind = modelKind(ownIcao, aircraft?.title, telemetry?.totalWeightKg);
  ownKindRef.current = ownKind;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (!telemetry) {
      // provider gone or switched (demo ended): no aircraft, no stale track
      drawOwn();
      if (trackRef.current.points.length) {
        trackRef.current.reset();
        drawTrack(map, trackRef.current, true);
        drawCurtain(map, trackRef.current);
      }
      return;
    }
    const { latitude: lat, longitude: lon } = telemetry;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    drawOwn();

    const track = trackRef.current;
    if (telemetry.timestampMs - track.lastMs >= TRACK_POINT_INTERVAL_MS) {
      const sample = { altFt: telemetry.altitudeMslFt, aglFt: telemetry.altitudeAglFt, onGround: telemetry.onGround };
      const closedChunk = track.push({ lon, lat, ...sample, hFt: track.heightFor(sample), tMs: telemetry.timestampMs });
      // a closed 10-min block moves to the history source as a diff (no full re-send)
      if (closedChunk?.length) (map.getSource(TRACK_HISTORY) as maplibregl.GeoJSONSource | undefined)?.updateData({ add: closedChunk });
      if (track.points.length >= 2) drawTrack(map, track, false);
    }
    // 3D: the wall reaches the aircraft; heights above the map's ground (no terrain), 0 when on the ground
    if (view3dRef.current) drawCurtainHead(map, track, { lon, lat, altFt: telemetry.altitudeMslFt, hFt: track.heightFor({ altFt: telemetry.altitudeMslFt, aglFt: telemetry.altitudeAglFt, onGround: telemetry.onGround }) });

    // 3D: the camera looks at the aircraft in the air (its model height), not at the ground below it –
    // zoomed in at cruise level the model would otherwise sit far above the screen
    const elev3d = altToCurtainM(trackRef.current.heightFor({ altFt: telemetry.altitudeMslFt, aglFt: telemetry.altitudeAglFt, onGround: telemetry.onGround }));
    ownAnchorRef.current = { lon, lat, elev3d };
    // hidden (CSS display:none) or not moved by half a pixel: no camera move (followStep)
    const now = performance.now();
    const gap = now - lastSampleAtRef.current;
    lastSampleAtRef.current = now;
    if (followRef.current && !windowAway() && map.getCanvas().clientWidth > 0) {
      const to = { lon, lat, elev: view3dRef.current ? elev3d : 0 };
      if (cameraMoveVisible(map, to)) {
        const c = map.getCenter();
        // over the time since the previous sample (a long gap or the first sample: at once)
        glideRef.current.set({ lon: c.lng, lat: c.lat, elev: map.getCenterElevation() }, to, now, gap > 0 && gap < 2000 ? gap : 0);
        if (glideCancelRef.current === undefined) scheduleGlide(0);
      }
    }
  }, [telemetry, ownCat, ownKind]);

  // While following, wheel and pinch zoom around the canvas centre (where the aircraft is) instead
  // of the pointer: the camera state MapLibre's handlers accumulate then matches what follow shows
  // (followCameraUpdate), so a drag right after a zoom starts from what is on screen.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !routeReady) return;
    const around = follow || followTraffic ? ({ around: "center" } as const) : undefined;
    if (map.scrollZoom.isEnabled()) {
      map.scrollZoom.disable();
      map.scrollZoom.enable(around);
    }
    if (map.touchZoomRotate.isEnabled()) map.touchZoomRotate.enable(around);
  }, [follow, followTraffic, routeReady]);

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
      // 3D model: followed every frame at its drawn pose (followTrafficFrame); 2D: the symbol
      // jumps with each feed update, the camera glides after it
      if (!traffic3dRef.current?.selectedPose()) {
        trafficAnchorRef.current = { lon: pos.lon, lat: pos.lat, shift: groundShift(map, insetOffset(insets)) };
        if (!guardRef.current?.busy()) map.easeTo({ center: [pos.lon, pos.lat], offset: insetOffset(insets), duration: 600 }, FOLLOW_EVENT);
      }
      return;
    }
    // first position of a newly selected aircraft: move it out from under the card / HUD
    const key = selKeyRef.current;
    if (key && revealedRef.current !== key) {
      revealedRef.current = key;
      revealTraffic(map, pos, insets, suspendOwnFollow);
    }
  }, [selLon, selLat, routeReady, suspendOwnFollow]);

  // the selected aircraft: accent colour and always among the 3D models
  const selKey = trafficRef ? `${trafficRef.network}:${trafficRef.cid}` : null;
  useEffect(() => {
    traffic3dRef.current?.setSelected(selKey);
  }, [selKey, routeReady]);

  const dep = sel?.pilot?.departure ?? "";
  const arr = sel?.pilot?.arrival ?? "";
  const filedRoute = sel?.pilot?.route ?? "";
  useEffect(() => {
    let alive = true;
    const draw = (d: TrafficRouteDraw | null) => {
      trafficRouteRef.current = d;
      const map = mapRef.current;
      if (map && readyRef.current) (map.getSource("traffic-route") as maplibregl.GeoJSONSource | undefined)?.setData(trafficRouteGeoJson(d));
    };
    if (!routeShown || !dep || !arr) {
      draw(null);
      setTrafficRoute(null);
      return;
    }
    setTrafficRoute({ status: "resolving" });
    // the filed route through the waypoints the backend could place (MSFS, X-Plane, navaids);
    // if that fails, the great circle between the two airports as before
    const greatCircleOnly = () => {
      const get = (ident: string) => invoke<{ airport: Airport } | null>("get_airport", { ident }).then((d) => d?.airport ?? null);
      return Promise.all([get(dep), get(arr)]).then(([a, b]): TrafficRouteDraw | null =>
        a && b ? { legs: [{ coords: greatCircle({ lat: a.latitude, lon: a.longitude }, { lat: b.latitude, lon: b.longitude }), bridge: true }], fixes: [] } : null,
      );
    };
    invoke<RouteResolution>("traffic_route_resolve", { dep, arr, route: filedRoute })
      .then((res) => {
        if (alive) setTrafficRoute({ status: "done", res });
        return trafficRouteDraw(res);
      })
      .catch(() => {
        if (alive) setTrafficRoute({ status: "failed" });
        return greatCircleOnly();
      })
      .then((d) => {
        if (!alive) return;
        draw(d);
        const points = trafficRouteCoords(d);
        const map = mapRef.current;
        if (map && points.length >= 2) {
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
  }, [routeShown, dep, arr, filedRoute, routeReady, suspendOwnFollow]);

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
      // our glide (GLIDE_EVENT), like the reveal of a click on the map (revealTraffic)
      requestAnimationFrame(() =>
        map.easeTo(
          { center: [p.longitude, p.latitude], zoom: Math.max(map.getZoom(), 7), offset: insetOffset(measureInsets(wrapRef.current)), duration: 500 },
          GLIDE_EVENT,
        ),
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
    if (next && map && p) {
      const off = insetOffset(measureInsets(wrapRef.current));
      trafficAnchorRef.current = { lon: p.longitude, lat: p.latitude, shift: groundShift(map, off) };
      map.easeTo({ center: [p.longitude, p.latitude], zoom: Math.max(map.getZoom(), 7), offset: off, duration: 500 }, GLIDE_EVENT);
    }
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
    if (g === "traffic") syncTraffic3d();
    if (g === "weather") window.dispatchEvent(new Event("vectasim:layers"));
  };

  // traffic shown / hidden (map toggle, or the network switched in the settings): traffic and ATC with it
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    setGroupVisible(map, "traffic", groupVisible("traffic"));
    setGroupVisible(map, "atc", groupVisible("atc"));
    syncTraffic3dRef.current();
    refreshOnlineRef.current();
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
    if (next) drawCurtain(map, trackRef.current);
    modelRef.current?.setEnabled(next);
    drawOwn();
    setPitched(map, next);
    syncTraffic3d();
  };

  const center = () => {
    const map = mapRef.current;
    if (!map || !telemetry) return;
    setFollow(true);
    map.easeTo({ center: [telemetry.longitude, telemetry.latitude], zoom: Math.max(map.getZoom(), 9), duration: 400 }, GLIDE_EVENT);
  };

  // toolbar explanations for keyboard and screen-reader users (hint.tsx); `title` stays for the mouse
  const hints = useHintIds();
  const followHint = hints("follow", t("map.toolbar.followTitle"));
  const view3dHint = hints("3d", view3d ? t("map.toolbar.flatten") : t("map.toolbar.tilt"));
  const atcHint = hints("atc", trafficOn ? t("map.toolbar.atcTitle") : t("map.toolbar.atcNeedsTraffic"));
  return (
    <div className="map-wrap" ref={wrapRef}>
      <div ref={containerRef} className="map" />
      {mapFailed && <MapUnavailable />}
      <div className="map-topleft">
      {overlay}
      <div className="map-toolbar">
        <button className="toggle" onClick={() => setFollow(!follow)} title={t("map.toolbar.followTitle")} aria-pressed={follow} aria-describedby={followHint.describedBy}>
          {t("map.toolbar.follow")}
        </button>
        {followHint.node}
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
          aria-describedby={view3dHint.describedBy}
        >
          3D
        </button>
        {view3dHint.node}
        <GlobeToggle zoom={zoom} />
        <MapStyleToggle />
        <div className="map-toggle-group" role="group" aria-label={t("map.toolbar.layers")}>
          {/* Verkehr + VATSIM / IVAO / beide; turning traffic on also re-shows a hidden traffic layer */}
          <TrafficToggle on={trafficOn} onEnable={() => !layersRef.current.traffic && toggleLayer("traffic")} />
          {/* aria-disabled instead of disabled: stays focusable, so keyboard users reach the reason (needs traffic) */}
          <button
            className="toggle"
            onClick={() => trafficOn && toggleLayer("atc")}
            aria-disabled={!trafficOn}
            aria-pressed={trafficOn && layers.atc}
            title={trafficOn ? t("map.toolbar.atcTitle") : t("map.toolbar.atcNeedsTraffic")}
            aria-describedby={atcHint.describedBy}
          >
            ATC
          </button>
          {atcHint.node}
          {/* Wetter + METAR / Radar / Wolken (WeatherToggle.tsx) */}
          <WeatherToggle on={layers.weather} onToggle={() => toggleLayer("weather")} metarZoom={METAR_MIN_ZOOM} />
        </div>
      </div>
      {/* in the same column as the pill and the toolbar: below them, never over them, also when the toolbar wraps */}
      <AirportReadout mapRef={mapRef} ready={routeReady} />
      </div>
      <WeatherLegend zoom={zoom} metarZoom={METAR_MIN_ZOOM} />
      {trafficRef && sel && (
        <TrafficCard
          sel={sel}
          own={telemetry && Number.isFinite(telemetry.latitude) ? { lat: telemetry.latitude, lon: telemetry.longitude } : null}
          following={followTraffic}
          routeShown={routeShown}
          route={routeShown ? trafficRoute : null}
          onFollow={toggleFollowTraffic}
          onRoute={() => setRouteShown(!routeShown)}
          onClose={closeTraffic}
        />
      )}
    </div>
  );
}
