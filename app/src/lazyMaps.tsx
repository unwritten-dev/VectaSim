// The two MapLibre maps outside the countries view, loaded on first use: MapLibre
// (~800 kB) and the map modules leave the start chunk and load once a map is actually shown –
// the live map right after start, the track map with the first flight detail or debrief.
// While the chunk loads, the fallback keeps the map's box (same classes) and, for the live map,
// the overlay (status pill), so nothing jumps when the map arrives.

import { Suspense, lazy, type ComponentProps } from "react";
import type LiveMapComponent from "./map/LiveMap";
import type TrackMapComponent from "./map/TrackMap";

const LiveMapImpl = lazy(() => import("./map/LiveMap"));
const TrackMapImpl = lazy(() => import("./map/TrackMap"));

export function LiveMap(props: ComponentProps<typeof LiveMapComponent>) {
  return (
    <Suspense
      fallback={
        <div className="map-wrap">
          <div className="map" />
          {props.overlay}
        </div>
      }
    >
      <LiveMapImpl {...props} />
    </Suspense>
  );
}

export function TrackMap(props: ComponentProps<typeof TrackMapComponent>) {
  return (
    <Suspense
      fallback={
        <div className="track-map-wrap">
          <div className="map track-map" />
        </div>
      }
    >
      <TrackMapImpl {...props} />
    </Suspense>
  );
}
