import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Airport, FlightRow } from "./types";
import { fmt } from "./i18n/number";
import { useT } from "./i18n";
import ErrorNotice from "./ErrorNotice";
import { usePrefs } from "./prefs";
import { demoLeftOut } from "./totals";
import { visitedAirportCounts } from "./activitiesData";
import { latestOnly } from "./latest";
import { lookupAirports } from "./airportLookup";

interface Visited {
  icao: string;
  name: string;
  country: string;
  departures: number;
  arrivals: number;
}

/** "Where have I been": visited airports and countries from the logbook. */
export default function Activities() {
  const [visited, setVisited] = useState<Visited[] | null>(null);
  const [countries, setCountries] = useState<string[]>([]);
  const [demoHidden, setDemoHidden] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { showDemo } = usePrefs();
  const t = useT();
  const [latest] = useState(latestOnly);

  const refresh = useCallback(async () => {
    const isLatest = latest();
    let all: FlightRow[];
    try {
      all = await invoke<FlightRow[]>("list_flights", { limit: 100000 });
      if (!isLatest()) return;
      setError(null);
    } catch (e) {
      if (isLatest()) setError(String(e));
      return;
    }
    // statistics rule (flightStats.ts): no discarded ground sessions, no taxi-only rows
    setDemoHidden(demoLeftOut(all, showDemo));
    const counts = visitedAirportCounts(all, showDemo);
    // local airport DB, each ICAO asked once per session (airportLookup.ts); an unknown ICAO
    // just shows without name/country
    const entries = [...counts.entries()];
    const details = await lookupAirports(
      entries.map(([icao]) => icao),
      (ident) => invoke<{ airport: Airport } | null>("get_airport", { ident }),
    );
    if (!isLatest()) return;
    const countrySet = new Set<string>();
    const rows: Visited[] = entries.map(([icao, c]) => {
      const a = details.get(icao);
      if (a?.country) countrySet.add(a.country);
      return { icao, name: a?.name ?? "", country: a?.country ?? "", ...c };
    });
    rows.sort((a, b) => b.departures + b.arrivals - (a.departures + a.arrivals));
    setVisited(rows);
    setCountries([...countrySet].sort());
  }, [showDemo, latest]);

  useEffect(() => {
    refresh();
    const un = listen("logbook:changed", refresh);
    return () => {
      un.then((u) => u());
    };
  }, [refresh]);

  return (
    <section className="logbook">
      {error && <ErrorNotice error={error} context="logbook" onRetry={refresh} />}
      <div className="totals totals-compact">
        <div className="tile">
          <div className="tile-label">{t("logbook.activities.airports")}</div>
          <div className="tile-value num">{visited ? fmt(visited.length) : "–"}</div>
        </div>
        <div className="tile">
          <div className="tile-label">{t("logbook.activities.countries")}</div>
          <div className="tile-value num">{visited ? fmt(countries.length) : "–"}</div>
          <div className="detail">{countries.join(" · ")}</div>
        </div>
      </div>
      <table className="flights">
        <thead>
          <tr>
            <th>{t("logbook.activities.colIcao")}</th>
            <th>{t("logbook.activities.colName")}</th>
            <th>{t("logbook.activities.colCountry")}</th>
            <th className="num right">{t("logbook.activities.colDepartures")}</th>
            <th className="num right">{t("logbook.activities.colArrivals")}</th>
          </tr>
        </thead>
        <tbody>
          {visited === null && !error && (
            <tr className="empty-row">
              <td colSpan={5} className="detail">
                {t("logbook.activities.loading")}
              </td>
            </tr>
          )}
          {visited?.length === 0 && (
            <tr className="empty-row">
              <td colSpan={5} className="detail">
                {t("logbook.activities.empty")}
              </td>
            </tr>
          )}
          {visited?.map((v) => (
            <tr key={v.icao} className="static">
              <td>{v.icao}</td>
              <td>{v.name || "–"}</td>
              <td>{v.country || "–"}</td>
              <td className="num right">{fmt(v.departures)}</td>
              <td className="num right">{fmt(v.arrivals)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {demoHidden > 0 && (
        <div className="detail">
          {t("logbook.activities.demoHidden", { count: demoHidden })}
        </div>
      )}
    </section>
  );
}
