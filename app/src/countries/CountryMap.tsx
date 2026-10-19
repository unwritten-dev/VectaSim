import { useEffect, useRef, useState, type RefObject } from "react";
import * as maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "../map/maplibreWorker";
import { followLanguage, loadBasemapStyle } from "../map/basemap";
import { applyProjection, useGlobe, withProjection } from "../map/common";
import { COLOR } from "../theme";
import { t as tGlobal, useLanguage, useT } from "../i18n";
import { fmtDate } from "../i18n/number";
import { countryName, geometryBounds, globeZoomFor, landingsLabel, type Country, type CountryVisit, type VisitedAirport } from "./countries.ts";

interface Props {
  outlines: GeoJSON.FeatureCollection | null;
  countries: Map<string, Country>;
  visits: Map<string, CountryVisit>;
  airports: VisitedAirport[];
  showPins: boolean;
  selected: string | null;
  onSelect: (iso2: string | null) => void;
  /** Filled with the map instance (PNG export reads its canvas). */
  mapRef: RefObject<maplibregl.Map | null>;
}

interface Hover {
  iso2: string;
  x: number;
  y: number;
}

const SRC = "countries";
const PINS = "visited-airports";
/** Start view; the globe needs a closer zoom than the flat map to fill the column. */
const START_CENTER: [number, number] = [12, 28];
const START_ZOOM_GLOBE = 1.9;
const START_ZOOM_FLAT = 1.4;
/** Inhabited world for the flat map (Antarctica left out, like the start view). */
const WORLD_BOUNDS: [[number, number], [number, number]] = [
  [-170, -56],
  [180, 75],
];

/** Below the first label layer of the basemap, so place names stay on top of the fills. */
function firstSymbolLayer(map: maplibregl.Map): string | undefined {
  return map.getStyle().layers.find((l) => l.type === "symbol")?.id;
}

function addOwnLayers(map: maplibregl.Map, outlines: GeoJSON.FeatureCollection) {
  const before = firstSymbolLayer(map);
  map.addSource(SRC, { type: "geojson", data: outlines, promoteId: "iso2", attribution: tGlobal("countries.map.attribution") });
  type Expr = maplibregl.ExpressionSpecification;
  const visited: Expr = ["boolean", ["feature-state", "visited"], false];
  const hover: Expr = ["boolean", ["feature-state", "hover"], false];
  const selected: Expr = ["boolean", ["feature-state", "selected"], false];
  map.addLayer(
    {
      id: "countries-fill",
      type: "fill",
      source: SRC,
      paint: {
        "fill-color": COLOR.accent,
        // visited in accent alpha, hovered brighter, not visited only a faint hover hint
        "fill-opacity": ["case", ["all", visited, ["any", hover, selected]], 0.62, visited, 0.38, ["any", hover, selected], 0.1, 0],
      },
    },
    before,
  );
  map.addLayer(
    {
      id: "countries-line",
      type: "line",
      source: SRC,
      paint: {
        "line-color": ["case", visited, COLOR.accent, COLOR.textMuted],
        "line-opacity": ["case", visited, 0.8, 0.35],
        "line-width": ["case", visited, 0.9, 0.5],
      },
    },
    before,
  );
  map.addLayer(
    {
      id: "countries-selected",
      type: "line",
      source: SRC,
      paint: {
        "line-color": COLOR.text,
        "line-width": 2,
        "line-opacity": ["case", selected, 1, 0],
      },
    },
    before,
  );
  map.addSource(PINS, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "visited-airports-dot",
    type: "circle",
    source: PINS,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 2.5, 6, 4.5],
      "circle-color": COLOR.text,
      "circle-stroke-color": COLOR.halo,
      "circle-stroke-width": 1.2,
    },
  });
  map.addLayer({
    id: "visited-airports-label",
    type: "symbol",
    source: PINS,
    minzoom: 4,
    layout: {
      "text-field": ["get", "ident"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-offset": [0, 0.9],
      "text-anchor": "top",
    },
    paint: { "text-color": COLOR.text, "text-halo-color": COLOR.halo, "text-halo-width": 1.2 },
  });
}

/**
 * World map of the "Länder" view: country outlines (Natural Earth 1:110m) over the themed
 * basemap, visited countries in accent alpha, hover tooltip, click selects; visited arrival
 * airports as pins (small states have no outline at this scale). Zoom 1–6.
 */
export default function CountryMap({ outlines, countries, visits, airports, showPins, selected, onSelect, mapRef }: Props) {
  const t = useT();
  const lang = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(false);
  const hoverRef = useRef<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  /** Globe (default) or flat world map: the same choice as the live and track maps. */
  const [globe] = useGlobe();
  const globeRef = useRef(globe);
  globeRef.current = globe;

  // latest props for the map callbacks (registered once)
  const propsRef = useRef({ outlines, visits, airports, showPins, selected, onSelect });
  propsRef.current = { outlines, visits, airports, showPins, selected, onSelect };

  const sync = () => {
    const map = mapRef.current;
    const p = propsRef.current;
    if (!map || !readyRef.current || !p.outlines) return;
    if (!map.getSource(SRC)) addOwnLayers(map, p.outlines);
    for (const f of p.outlines.features) {
      const iso = f.properties?.iso2 as string | undefined;
      if (!iso) continue;
      map.setFeatureState({ source: SRC, id: iso }, { visited: p.visits.has(iso), selected: iso === p.selected });
    }
    const pins: GeoJSON.Feature[] = p.showPins
      ? p.airports.map((a) => ({ type: "Feature", properties: { ident: a.ident, iso2: a.iso2 }, geometry: { type: "Point", coordinates: [a.longitude, a.latitude] } }))
      : [];
    (map.getSource(PINS) as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: pins });
  };
  const syncRef = useRef(sync);
  syncRef.current = sync;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const setHoverState = (map: maplibregl.Map, iso: string | null) => {
      if (hoverRef.current === iso) return;
      if (hoverRef.current && map.getSource(SRC)) map.setFeatureState({ source: SRC, id: hoverRef.current }, { hover: false });
      hoverRef.current = iso;
      if (iso && map.getSource(SRC)) map.setFeatureState({ source: SRC, id: iso }, { hover: true });
    };
    const setupMap = (container: HTMLDivElement, style: StyleSpecification | string): (() => void) => {
      const map = new maplibregl.Map({
        container,
        style: withProjection(style, globeRef.current, COLOR.bg),
        center: START_CENTER,
        // the globe shows one hemisphere: a bit closer, so it fills the column like the flat map
        zoom: globeRef.current ? globeZoomFor(container.clientWidth, container.clientHeight) : START_ZOOM_FLAT,
        minZoom: 1,
        maxZoom: 6,
        dragRotate: false,
        pitchWithRotate: false,
        attributionControl: { compact: true },
        // only this map: the PNG export reads the canvas after rendering
        canvasContextAttributes: { preserveDrawingBuffer: true },
      });
      map.touchZoomRotate.disableRotation();
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      mapRef.current = map;
      map.on("load", () => {
        applyProjection(map, globeRef.current);
        readyRef.current = true;
        syncRef.current();
      });
      map.on("mousemove", (e) => {
        if (!map.getLayer("countries-fill")) return;
        const f = map.queryRenderedFeatures(e.point, { layers: ["countries-fill"] })[0];
        const iso = (f?.properties?.iso2 as string | undefined) ?? null;
        setHoverState(map, iso);
        map.getCanvas().style.cursor = iso ? "pointer" : "";
        setHover(iso ? { iso2: iso, x: e.point.x, y: e.point.y } : null);
      });
      map.on("mouseout", () => {
        setHoverState(map, null);
        setHover(null);
      });
      map.on("click", (e) => {
        if (!map.getLayer("countries-fill")) return;
        const f = map.queryRenderedFeatures(e.point, { layers: ["countries-fill"] })[0];
        const iso = (f?.properties?.iso2 as string | undefined) ?? null;
        const { selected: cur, onSelect: select } = propsRef.current;
        select(iso && iso !== cur ? iso : null);
      });
      let themeSeq = 0;
      const onTheme = () => {
        const mySeq = ++themeSeq;
        void loadBasemapStyle().then((next) => {
          if (mySeq !== themeSeq || mapRef.current !== map) return;
          readyRef.current = false;
          hoverRef.current = null;
          map.once("style.load", () => {
            readyRef.current = true;
            syncRef.current();
          });
          map.setStyle(withProjection(next, globeRef.current, COLOR.bg), { diff: false });
        });
      };
      window.addEventListener("theme:changed", onTheme);
      // basemap names follow the UI language (map/basemap.ts)
      const offLang = followLanguage(map);
      const ro = new ResizeObserver(() => map.resize());
      ro.observe(container);
      return () => {
        window.removeEventListener("theme:changed", onTheme);
        offLang();
        ro.disconnect();
        map.remove();
        mapRef.current = null;
        readyRef.current = false;
      };
    };
    let disposed = false;
    let teardown: (() => void) | undefined;
    void loadBasemapStyle().then((style) => {
      if (disposed || !containerRef.current || mapRef.current) return;
      teardown = setupMap(containerRef.current, style);
    });
    return () => {
      disposed = true;
      teardown?.();
    };
  }, [mapRef]);

  useEffect(() => syncRef.current(), [outlines, visits, airports, showPins, selected]);

  // globe switched (here or on another map): the start zooms differ per projection, so the camera
  // follows – flat → globe back to the first-load view, globe → flat the whole world fitted
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    applyProjection(map, globe);
    const canvas = map.getCanvas();
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
      // hidden (another view is open): no animation, just the start view of the new projection
      map.jumpTo({ center: START_CENTER, zoom: globe ? START_ZOOM_GLOBE : START_ZOOM_FLAT });
    } else if (globe) {
      map.easeTo({ center: START_CENTER, zoom: globeZoomFor(canvas.clientWidth, canvas.clientHeight), duration: 500 });
    } else {
      map.fitBounds(WORLD_BOUNDS, { padding: 12, duration: 500 });
    }
  }, [globe, mapRef]);

  // a selection from the list brings the country into view
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selected || !outlines) return;
    const f = outlines.features.find((x) => x.properties?.iso2 === selected);
    let b = geometryBounds(f?.geometry);
    if (!b) {
      // no outline at 1:110m (small states): the visited airports there
      const pts = airports.filter((a) => a.iso2 === selected);
      if (pts.length) {
        const xs = pts.map((a) => a.longitude);
        const ys = pts.map((a) => a.latitude);
        b = [
          [Math.min(...xs) - 1, Math.min(...ys) - 1],
          [Math.max(...xs) + 1, Math.max(...ys) + 1],
        ];
      }
    }
    // countries across the antimeridian (Russia, Fiji, USA with Alaska) span the world: no zoom then
    if (b && b[1][0] - b[0][0] < 180) map.fitBounds(b, { padding: 60, maxZoom: 5, duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on a new selection
  }, [selected]);

  const hc = hover ? countries.get(hover.iso2) : null;
  const hv = hover ? visits.get(hover.iso2) : null;
  return (
    <div className="country-map-wrap">
      <div ref={containerRef} className="map country-map" aria-hidden="true" />
      {hover && hc && (
        <div className="country-tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }} role="presentation">
          <strong>{countryName(hc, lang)}</strong>
          <span className={hv ? "country-yes" : "detail"}>{hv ? t("countries.tooltip.visited", { landings: landingsLabel(hv.landings, lang), date: fmtDate(hv.lastMs, { lang }) }) : t("countries.tooltip.open")}</span>
        </div>
      )}
    </div>
  );
}
