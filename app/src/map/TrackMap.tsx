import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import { loadBasemapStyle } from "./basemap";
import "maplibre-gl/dist/maplibre-gl.css";
import "./maplibreWorker";
import type { TouchdownReport, TrackSample } from "../types";
import { addCurtainLayers, addTrackLayers, firstSymbolLayer, pointFeature, samplesToPoints, setCurtainVisible, setPitched, trackPoseAt } from "./common";
import { useReplayStore } from "../landing/replayStore";
import { bandedTrackGeoJson, curtainGeoJson, thinPoints } from "./trackChunks";
import { addAirportDiagramLayers } from "./airportDiagram";
import { COLOR, TRACK_MARKER } from "../theme";

/** First draw of a long track: this many points at most; the full line follows once idle. */
const QUICK_POINTS = 1500;

interface Props {
  samples: TrackSample[];
  touchdowns: TouchdownReport[];
  departure?: { latitude: number; longitude: number } | null;
  arrival?: { latitude: number; longitude: number } | null;
}

/** Pixel radius around the track within which a click picks the nearest moment. */
const PICK_PX = 16;

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
export default function TrackMap({ samples, touchdowns, departure, arrival }: Props) {
  const store = useReplayStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<maplibregl.Marker | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  /** Identity of the last fitted track: the preview → full swap must not re-fit a zoomed map. */
  const fittedRef = useRef("");
  /** 3D view: pitched camera, the track as wall + ribbon at the flown altitude. */
  const [view3d, setView3d] = useState(false);
  const view3dRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const setupMap = (container: HTMLDivElement, style: StyleSpecification | string): (() => void) => {
      const map = new maplibregl.Map({
        container,
        style,
        center: [8.57, 50.03],
        zoom: 6,
        attributionControl: { compact: true },
        interactive: true,
      });
      mapRef.current = map;
      // our layers; again after a theme change (setStyle drops them)
      let diagramOff: (() => void) | undefined;
      const addOwnLayers = () => {
        diagramOff?.();
        diagramOff = addAirportDiagramLayers(map);
        addTrackLayers(map, "track");
        addCurtainLayers(map, "track-3d", firstSymbolLayer(map));
        setCurtainVisible(map, "track-3d", view3dRef.current);
        map.addSource("markers", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
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
      };
      map.on("click", (e) => clickRef.current(e));
      map.on("load", () => {
        addOwnLayers();
        readyRef.current = true;
        // latest props: samples may have arrived while the style was loading
        drawRef.current();
      });
      let themeSeq = 0;
      const onTheme = () => {
        const mySeq = ++themeSeq;
        void loadBasemapStyle().then((next) => {
          if (mySeq !== themeSeq || mapRef.current !== map) return;
          readyRef.current = false;
          map.once("style.load", () => {
            addOwnLayers();
            readyRef.current = true;
            drawRef.current();
          });
          map.setStyle(next, { diff: false });
        });
      };
      window.addEventListener("theme:changed", onTheme);
      const ro = new ResizeObserver(() => map.resize());
      ro.observe(container);
      return () => {
        window.removeEventListener("theme:changed", onTheme);
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
    void loadBasemapStyle().then((style) => {
      if (disposed || !containerRef.current || mapRef.current) return;
      teardown = setupMap(containerRef.current, style);
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
    const points = samplesToPoints(samples);
    const trackSrc = () => map.getSource("track") as maplibregl.GeoJSONSource | undefined;
    (map.getSource("track-3d") as maplibregl.GeoJSONSource | undefined)?.setData(view3dRef.current ? curtainGeoJson(points) : { type: "FeatureCollection", features: [] });
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
    for (const t of touchdowns) markers.push(pointFeature(t.longitude, t.latitude, { kind: "touchdown" }));
    (map.getSource("markers") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: markers });

    const id = samples.length ? `${samples[0].tMs}` : `${departure?.latitude},${departure?.longitude},${arrival?.latitude},${arrival?.longitude}`;
    if (id === fittedRef.current) return;
    fittedRef.current = id;
    const coords = points.map((p) => [p.lon, p.lat] as [number, number]);
    for (const m of markers) coords.push((m.geometry as GeoJSON.Point).coordinates as [number, number]);
    if (coords.length >= 2) {
      const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      map.fitBounds(bounds, { padding: 30, maxZoom: 12, duration: 0 });
    } else if (coords.length === 1) {
      map.jumpTo({ center: coords[0], zoom: 10 });
    }
  };

  const samplesRef = useRef(samples);
  samplesRef.current = samples;
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(draw, [samples, touchdowns, departure, arrival]);

  // shared cursor → marker; outside the subscription no React render per playback frame
  const placeCursor = () => {
    const map = mapRef.current;
    if (!map) return;
    const pose = trackPoseAt(samplesRef.current, store.get().tMs);
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
  };
  const placeRef = useRef(placeCursor);
  placeRef.current = placeCursor;
  useEffect(() => {
    placeRef.current();
    return store.subscribe(() => placeRef.current());
  }, [store, samples]);

  // click near the track → the nearest sample's time (pinned, playback paused)
  const onClick = (e: maplibregl.MapMouseEvent) => {
    const map = mapRef.current;
    const list = samplesRef.current;
    if (!map || list.length === 0) return;
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
    (map.getSource("track-3d") as maplibregl.GeoJSONSource | undefined)?.setData(next ? curtainGeoJson(samplesToPoints(samplesRef.current)) : { type: "FeatureCollection", features: [] });
    setPitched(map, next);
  };

  return (
    <div className="track-map-wrap">
      <div ref={containerRef} className="map track-map" />
      <div className="map-toolbar track-map-toolbar">
        <button
          className="toggle"
          onClick={toggle3d}
          aria-pressed={view3d}
          title={view3d ? "Karte wieder flach legen" : "Karte neigen und das Höhenprofil des Tracks zeigen – drehen und neigen auch mit rechter Maustaste oder Strg + Ziehen"}
        >
          3D
        </button>
      </div>
    </div>
  );
}
