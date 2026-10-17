import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Controller, LocatedController, OnlineSummary, OnlineView } from "./types";
import { fmt, fmtAltitude, haversineNm } from "./format";
import { FACILITY_LABEL } from "./map/online";
import { userMessage } from "./errors";
import ErrorNotice from "./ErrorNotice";

const MAX_TRAFFIC = 8;

interface Props {
  summary: OnlineSummary | null;
  view: OnlineView | null;
  /** Own aircraft if known, else the map centre: what "nearby" is measured from. */
  origin: { lat: number; lon: number } | null;
}

function groupByAirport(list: LocatedController[]): Array<[string, LocatedController[]]> {
  const m = new Map<string, LocatedController[]>();
  for (const c of list) m.set(c.airport, [...(m.get(c.airport) ?? []), c]);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function stationText(c: Controller) {
  return `${FACILITY_LABEL[c.facility]}${c.atisCode ? ` ${c.atisCode}` : ""} ${c.frequency}`;
}

/** Small side panel: nearest VATSIM traffic and ATC in view, with frequencies. */
export default function OnlinePanel({ summary, view, origin }: Props) {
  const [error, setError] = useState<string | null>(null);
  if (!summary?.enabled) {
    return (
      <section className="online-panel">
        <div className="tile-label">Online · VATSIM</div>
        <div className="detail">VATSIM-Verkehr ist aus.</div>
        {error && <ErrorNotice error={error} context="settings" compact onDismiss={() => setError(null)} />}
        <button
          onClick={() => {
            setError(null);
            invoke("online_set_enabled", { network: "vatsim", enabled: true }).catch((e) => setError(String(e)));
          }}
        >
          VATSIM aktivieren
        </button>
      </section>
    );
  }

  const traffic = origin
    ? (view?.pilots ?? [])
        .map((p) => ({ p, d: haversineNm(origin.lat, origin.lon, p.latitude, p.longitude) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_TRAFFIC)
    : [];
  const airports = groupByAirport(view?.controllers ?? []);
  const enroute = view?.enroute ?? [];

  return (
    <section className="online-panel">
      <div className="tile-label">
        Online · VATSIM
        <span className="detail">
          {" "}
          {fmt(summary.pilots)} Piloten · {fmt(summary.controllers)} Lotsen
        </span>
      </div>
      {summary.lastError && (
        <div className="warn-text small" title={summary.lastError}>
          <span className="warn-icon" aria-hidden="true">
            !
          </span>
          {userMessage(summary.lastError, "vatsim").title} Nächster Versuch in {summary.nextPollS} s.
        </div>
      )}

      <div className="online-cols">
        <div>
          <div className="online-head">Verkehr in der Nähe</div>
          {traffic.length === 0 && <div className="detail">{summary.fetchedMs ? "Kein Verkehr im Kartenausschnitt" : "Lädt …"}</div>}
          <ul className="online-list">
            {traffic.map(({ p, d }) => (
              <li key={p.cid} title={p.route}>
                <strong>{p.callsign}</strong>
                <span>{p.aircraftShort || "–"}</span>
                <span>{fmtAltitude(p.altitudeFt)}</span>
                <span className="detail">
                  {p.departure || p.arrival ? `${p.departure || "?"}→${p.arrival || "?"}` : ""} {fmt(d, 0, "nm")}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <div className="online-head">ATC im Ausschnitt</div>
          {airports.length === 0 && enroute.length === 0 && <div className="detail">Keine Lotsen im Ausschnitt</div>}
          <ul className="online-list">
            {airports.map(([icao, list]) => (
              <li key={icao}>
                <strong>{icao}</strong>
                <span className="detail">{list.map(stationText).join(" · ")}</span>
              </li>
            ))}
            {enroute.map((c) => (
              <li key={c.callsign} title={c.textAtis.join("\n")}>
                <strong>{c.callsign}</strong>
                <span className="detail">{c.frequency}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
