import { useEffect, useRef } from "react";
import maplibregl, { type StyleSpecification } from "maplibre-gl";
import { loadBasemapStyle } from "./basemap";
import "maplibre-gl/dist/maplibre-gl.css";
import type { TouchdownReport, TrackSample } from "../types";
import { addTrackLayers, pointFeature, samplesToPoints, segmentsGeoJson } from "./common";
import { addAirportDiagramLayers } from "./airportDiagram";
import { COLOR, TRACK_MARKER } from "../theme";

interface Props {
  samples: TrackSample[];
  touchdowns: TouchdownReport[];
  departure?: { latitude: number; longitude: number } | null;
  arrival?: { latitude: number; longitude: number } | null;
}

/** Static map of a recorded flight: altitude-coloured track, departure/arrival and touchdown points. */
export default function TrackMap({ samples, touchdowns, departure, arrival }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const draw = () => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const points = samplesToPoints(samples);
    (map.getSource("track") as maplibregl.GeoJSONSource | undefined)?.setData(segmentsGeoJson(points));
    const markers: GeoJSON.Feature[] = [];
    if (departure) markers.push(pointFeature(departure.longitude, departure.latitude, { kind: "dep" }));
    if (arrival) markers.push(pointFeature(arrival.longitude, arrival.latitude, { kind: "arr" }));
    for (const t of touchdowns) markers.push(pointFeature(t.longitude, t.latitude, { kind: "touchdown" }));
    (map.getSource("markers") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: markers });

    const coords = points.map((p) => [p.lon, p.lat] as [number, number]);
    for (const m of markers) coords.push((m.geometry as GeoJSON.Point).coordinates as [number, number]);
    if (coords.length >= 2) {
      const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      map.fitBounds(bounds, { padding: 30, maxZoom: 12, duration: 0 });
    } else if (coords.length === 1) {
      map.jumpTo({ center: coords[0], zoom: 10 });
    }
  };

  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(draw, [samples, touchdowns, departure, arrival]);

  return <div ref={containerRef} className="map track-map" />;
}
