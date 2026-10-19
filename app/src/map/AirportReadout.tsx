import { useEffect, useState, type RefObject } from "react";
import type * as maplibregl from "maplibre-gl";
import { invoke } from "@tauri-apps/api/core";
import type { Airport, NearestAirport, Runway } from "../types";
import { DIAGRAM_FROM_ZOOM } from "./airportDiagram";
import { fmt } from "../i18n/number";
import { useT } from "../i18n";

interface Info {
  airport: Airport;
  runways: Runway[];
}

const hdg = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? `${String(Math.round(v) % 360).padStart(3, "0")}°` : "–");

/** "Flugplatz" box over the map at zoom ≥ 13: nearest airport to the map centre and its runways. */
export default function AirportReadout({ mapRef, ready }: { mapRef: RefObject<maplibregl.Map | null>; ready: boolean }) {
  const t = useT();
  const [info, setInfo] = useState<Info | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let current: string | null = null;
    let seq = 0;
    const update = () => {
      if (map.getZoom() < DIAGRAM_FROM_ZOOM) {
        current = null;
        setInfo(null);
        return;
      }
      const c = map.getCenter();
      const mySeq = ++seq;
      invoke<NearestAirport | null>("nearest_airport", { lat: c.lat, lon: c.lng, maxNm: 5 })
        .then(async (n) => {
          if (mySeq !== seq) return;
          if (!n) {
            current = null;
            setInfo(null);
            return;
          }
          if (n.airport.ident === current) return;
          const d = await invoke<{ airport: Airport; runways: Runway[] } | null>("get_airport", { ident: n.airport.ident });
          if (mySeq !== seq) return;
          current = n.airport.ident;
          setInfo({ airport: n.airport, runways: d?.runways ?? [] });
        })
        // embedded airport DB; without a result the readout just stays hidden
        .catch(() => {});
    };
    map.on("moveend", update);
    update();
    return () => {
      map.off("moveend", update);
    };
  }, [mapRef, ready]);

  if (!info) return null;
  const { airport, runways } = info;
  return (
    <div className="airport-readout">
      <div className="airport-readout-head">
        <span className="airport-readout-label">{t("map.airport.label")}</span>
        <b>{airport.ident}</b>
        {airport.iata && <span className="muted"> / {airport.iata}</span>}
      </div>
      <div className="airport-readout-name">{airport.name}</div>
      {runways.length > 0 && (
        <table>
          <tbody>
            {runways.map((r) => (
              <tr key={`${r.leIdent}/${r.heIdent}`}>
                <td>
                  {r.leIdent}/{r.heIdent}
                </td>
                <td>
                  {hdg(r.leHeadingDeg)}/{hdg(r.heHeadingDeg)}
                </td>
                <td className="muted">{r.lengthFt ? fmt(Math.round(r.lengthFt * 0.3048), 0, "m") : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
