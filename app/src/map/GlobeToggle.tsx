// "Globus" on/off: one component for the live map, the track map and the Länder view (UX
// review 4.7/5.3), so the shared choice (projection.ts) looks and reads the same everywhere.
//
// Close in, MapLibre's globe is already as flat as the Mercator map: with the globe on and the
// map zoomed in past GLOBE_FLAT_FROM_ZOOM the button is dimmed and its tooltip says that the
// globe only shows when zooming out – it is still on, not broken.

import { useEffect, useState, type RefObject } from "react";
import type * as maplibregl from "maplibre-gl";
import { useT } from "../i18n";
import { GLOBE_FLAT_FROM_ZOOM, useGlobe } from "./projection";
import { useHint } from "./hint";

/** Current zoom of a map, updated on zoomend; null until the map exists. */
export function useMapZoom(mapRef: RefObject<maplibregl.Map | null>, ready: boolean): number | null {
  const [zoom, setZoom] = useState<number | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const update = () => setZoom(map.getZoom());
    update();
    map.on("zoomend", update);
    return () => {
      map.off("zoomend", update);
    };
  }, [mapRef, ready]);
  return zoom;
}

/** Globe on but zoomed in so far that it looks flat. */
export function globeDormant(globe: boolean, zoom: number | null | undefined): boolean {
  return globe && zoom != null && zoom >= GLOBE_FLAT_FROM_ZOOM;
}

interface Props {
  /** Map zoom, for the "looks flat here" hint; omitted where the map shows the whole world. */
  zoom?: number | null;
  /** Class of the button: "toggle" in the map toolbars (default), "chip" in the Länder filter row. */
  className?: string;
}

export default function GlobeToggle({ zoom, className = "toggle" }: Props) {
  const t = useT();
  const [globe, setGlobe] = useGlobe();
  const dormant = globeDormant(globe, zoom);
  const title = !globe ? t("map.toolbar.globeOn") : dormant ? t("map.toolbar.globeDormant", { zoom: GLOBE_FLAT_FROM_ZOOM }) : t("map.toolbar.globeOff");
  const hint = useHint(title);
  return (
    <>
      <button
        className={`${className} globe-toggle${globe ? " active" : ""}${dormant ? " globe-dormant" : ""}`}
        onClick={() => setGlobe(!globe)}
        aria-pressed={globe}
        title={title}
        aria-describedby={hint.describedBy}
      >
        {t("map.toolbar.globe")}
      </button>
      {hint.node}
    </>
  );
}
