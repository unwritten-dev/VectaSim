import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import "./countries.css";
import CountryMap from "./CountryMap";
import CountryList from "./CountryList";
import ErrorNotice from "../ErrorNotice";
import EmptyState from "../ui/EmptyState";
import { showToast } from "../ui/Toast";
import { userMessage } from "../errors";
import { navigate } from "../airframes/navigation";
import { usePrefs } from "../prefs";
import { isDemoRow } from "../totals";
import { COLOR } from "../theme";
import { fmt, fmtDate } from "../format";
import type { FlightRow } from "../types";
import {
  CONTINENTS,
  NO_FILTER,
  buildRows,
  continentLabel,
  continentProgress,
  exportFileName,
  filterRows,
  landingsLabel,
  progressLabel,
  progressOf,
  visitSummary,
  type ContinentCode,
  type Country,
  type RowFilter,
  type VisitFilter,
  type VisitedCountries,
} from "./countries.ts";

interface StaticData {
  countries: Country[];
  outlines: GeoJSON.FeatureCollection;
}

/** List and outlines never change while the app runs: loaded once, shared by every mount. */
let staticData: Promise<StaticData> | null = null;
function loadStatic(): Promise<StaticData> {
  staticData ??= Promise.all([invoke<Country[]>("countries_list"), invoke<ArrayBuffer>("countries_geojson")])
    .then(([countries, raw]) => ({ countries, outlines: JSON.parse(new TextDecoder().decode(raw)) as GeoJSON.FeatureCollection }))
    .catch((e) => {
      staticData = null; // next mount tries again
      throw e;
    });
  return staticData;
}

const VISIT_FILTERS: Array<{ id: VisitFilter; label: string }> = [
  { id: "all", label: "Alle" },
  { id: "visited", label: "Besucht" },
  { id: "open", label: "Offen" },
];

const PINS_KEY = "vectasim.countries.pins";
function readPins(): boolean {
  try {
    return localStorage.getItem(PINS_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Shown flights of one country at most; the rest is in the logbook. */
const MAX_FLIGHTS = 50;

/**
 * "Länder": world map with the countries landed in (arrival airport of completed flights,
 * demo only with "Demo-Flüge einbeziehen") and the full list with progress, continent filter
 * and search; a country lists its flights, each one opens in the logbook.
 */
export default function Countries() {
  const { showDemo } = usePrefs();
  const [stat, setStat] = useState<StaticData | null>(null);
  const [data, setData] = useState<VisitedCountries | null>(null);
  const [flights, setFlights] = useState<Map<string, FlightRow>>(new Map());
  const [demoSkipped, setDemoSkipped] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RowFilter>(NO_FILTER);
  const [selected, setSelected] = useState<string | null>(null);
  const [showPins, setShowPins] = useState(readPins);
  const [exporting, setExporting] = useState(false);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    let alive = true;
    loadStatic().then(
      (s) => alive && setStat(s),
      (e) => alive && setError(String(e)),
    );
    return () => {
      alive = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [visited, rows] = await Promise.all([
        invoke<VisitedCountries>("visited_countries", { includeDemo: showDemo }),
        invoke<FlightRow[]>("list_flights", { limit: 100000 }),
      ]);
      setData(visited);
      setFlights(new Map(rows.map((f) => [f.id, f])));
      setDemoSkipped(showDemo ? 0 : rows.filter((f) => isDemoRow(f) && f.state === "completed" && f.arrIcao).length);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [showDemo]);

  useEffect(() => {
    void refresh();
    const un = listen("logbook:changed", () => void refresh());
    return () => {
      un.then((u) => u());
    };
  }, [refresh]);

  const countryMap = useMemo(() => new Map((stat?.countries ?? []).map((c) => [c.iso2, c])), [stat]);
  const visitMap = useMemo(() => new Map((data?.countries ?? []).map((v) => [v.iso2, v])), [data]);
  const rows = useMemo(() => buildRows(stat?.countries ?? [], data?.countries ?? []), [stat, data]);
  const shown = useMemo(() => filterRows(rows, filter), [rows, filter]);
  const progress = useMemo(() => progressOf(rows), [rows]);
  const perContinent = useMemo(() => continentProgress(rows), [rows]);
  const summary = useMemo(() => visitSummary(data?.countries ?? []), [data]);
  const scope = filter.continent ? perContinent.get(filter.continent) : null;

  const togglePins = (on: boolean) => {
    setShowPins(on);
    try {
      localStorage.setItem(PINS_KEY, on ? "1" : "0");
    } catch {
      /* per-viewer convenience only */
    }
  };

  const exportPng = async () => {
    const map = mapRef.current;
    if (!map) return;
    setExporting(true);
    try {
      const path = await save({ defaultPath: exportFileName(), filters: [{ name: "PNG-Bild", extensions: ["png"] }] });
      if (!path) return;
      const blob = await renderMapPng(map, `${progressLabel(progress)} Länder besucht · ${landingsLabel(summary.landings)}`);
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      await invoke("save_image", { path, bytes });
      showToast({ tone: "ok", title: "Länderkarte gespeichert", body: path, durationMs: 3000 });
    } catch (e) {
      const m = userMessage(e, "export");
      showToast({ id: "countries-export", tone: "err", title: `Länderkarte nicht gespeichert: ${m.title}`, body: `${m.hint}${m.detail ? ` (${m.detail.slice(0, 160)})` : ""}` });
    } finally {
      setExporting(false);
    }
  };

  const sel = selected ? countryMap.get(selected) : null;
  const selVisit = selected ? visitMap.get(selected) : undefined;
  const empty = data != null && data.countries.length === 0;

  return (
    <section className="countries-view">
      <div className="countries-map-col">
        <CountryMap
          outlines={stat?.outlines ?? null}
          countries={countryMap}
          visits={visitMap}
          airports={data?.airports ?? []}
          showPins={showPins}
          selected={selected}
          onSelect={setSelected}
          mapRef={mapRef}
        />
        <div className="country-legend" aria-hidden="true">
          <span>
            <i className="swatch swatch-visited" /> Besucht (Landung)
          </span>
          <span>
            <i className="swatch swatch-open" /> Noch nicht besucht
          </span>
          {showPins && (
            <span>
              <i className="swatch swatch-pin" /> Ankunftsflughafen
            </span>
          )}
        </div>
        {empty && (
          <div className="countries-empty">
            <EmptyState
              title="Noch kein Land durch eine Landung besucht"
              text={
                <>
                  Deine erste Landung färbt die Karte. Es zählt nur der Ankunftsflughafen abgeschlossener Flüge.
                  {demoSkipped > 0 && (
                    <>
                      <br />
                      {demoSkipped} Demo-Landung{demoSkipped === 1 ? "" : "en"} nicht mitgezählt (Einstellungen → Anzeige → Demo-Flüge einbeziehen).
                    </>
                  )}
                </>
              }
            />
          </div>
        )}
      </div>

      <aside className="countries-panel" aria-label="Länderliste">
        {error && <ErrorNotice error={error} context="logbook" onRetry={refresh} />}
        <div className="countries-progress">
          <div className="countries-progress-head">
            <span className="countries-count num">{stat && data ? progressLabel(scope ?? progress) : "–"}</span>
            <span className="detail">{scope ? `Länder in ${continentLabel(filter.continent!)}` : "Länder besucht"}</span>
            <div className="spacer" />
            <button className="btn-sm" onClick={exportPng} disabled={exporting || !stat} title="Karte als PNG speichern">
              Als Bild speichern
            </button>
          </div>
          <div
            className="countries-bar"
            role="progressbar"
            aria-label="Besuchte Länder"
            aria-valuemin={0}
            aria-valuemax={(scope ?? progress).total}
            aria-valuenow={(scope ?? progress).visited}
            aria-valuetext={`${(scope ?? progress).visited} von ${(scope ?? progress).total} Ländern besucht`}
          >
            <div className="countries-bar-fill" style={{ width: `${(scope ?? progress).percent}%` }} />
          </div>
          <div className="detail">
            {summary.landings > 0
              ? `${landingsLabel(summary.landings)} · zuletzt ${countryMap.get(summary.lastIso ?? "")?.nameDe ?? summary.lastIso} am ${fmtDate(summary.lastMs)}`
              : "Gezählt wird jede Landung am Ankunftsflughafen eines abgeschlossenen Flugs."}
            {demoSkipped > 0 && !empty && ` · ${demoSkipped} Demo-Landung${demoSkipped === 1 ? "" : "en"} nicht mitgezählt`}
          </div>
        </div>

        <div className="chips" role="group" aria-label="Kontinent">
          <button className={`chip${filter.continent == null ? " active" : ""}`} aria-pressed={filter.continent == null} onClick={() => setFilter({ ...filter, continent: null })}>
            Alle
          </button>
          {CONTINENTS.map(({ code, label }) => {
            const p = perContinent.get(code);
            return (
              <button
                key={code}
                className={`chip${filter.continent === code ? " active" : ""}`}
                aria-pressed={filter.continent === code}
                onClick={() => setFilter({ ...filter, continent: filter.continent === code ? null : (code as ContinentCode) })}
              >
                {label} <span className="num detail">{p ? progressLabel(p) : ""}</span>
              </button>
            );
          })}
        </div>

        <div className="countries-toolbar">
          <input
            type="search"
            className="countries-search"
            placeholder="Land suchen (Name oder ISO-Code)"
            aria-label="Land suchen"
            value={filter.query}
            onChange={(e) => setFilter({ ...filter, query: e.target.value })}
          />
          <div className="chips" role="group" aria-label="Besucht oder offen">
            {VISIT_FILTERS.map((v) => (
              <button key={v.id} className={`chip${filter.visit === v.id ? " active" : ""}`} aria-pressed={filter.visit === v.id} onClick={() => setFilter({ ...filter, visit: v.id })}>
                {v.label}
              </button>
            ))}
          </div>
          <label className="countries-pins">
            <input type="checkbox" checked={showPins} onChange={(e) => togglePins(e.target.checked)} /> Flughäfen
          </label>
        </div>

        {sel && (
          <div className="country-detail" aria-live="polite">
            <div className="country-detail-head">
              <strong>{sel.nameDe}</strong>
              <span className="detail">
                {sel.nameEn} · {continentLabel(sel.continent)}
              </span>
              <div className="spacer" />
              <button className="btn-sm btn-ghost" onClick={() => setSelected(null)} aria-label="Auswahl aufheben">
                ×
              </button>
            </div>
            {selVisit ? (
              <>
                <div className="country-yes">
                  ✓ {landingsLabel(selVisit.landings)} · erste {fmtDate(selVisit.firstMs)} · letzte {fmtDate(selVisit.lastMs)}
                </div>
                <div className="detail">
                  Flughäfen:{" "}
                  {selVisit.airports
                    .map((icao) => {
                      const a = data?.airports.find((x) => x.ident === icao);
                      return a ? `${icao} (${fmt(a.landings)}×)` : icao;
                    })
                    .join(", ")}
                </div>
                <ul className="country-flights">
                  {selVisit.flightIds.slice(0, MAX_FLIGHTS).map((id) => {
                    const f = flights.get(id);
                    return (
                      <li key={id}>
                        <button className="btn-ghost country-flight" onClick={() => navigate({ kind: "flight", id })} title="Im Logbuch öffnen">
                          <span className="num">{fmtDate(f?.landingMs ?? f?.onBlockMs ?? f?.createdMs)}</span>
                          <span className="mono">
                            {f?.depIcao ?? "?"} → {f?.arrIcao ?? "?"}
                          </span>
                          <span className="detail">{f?.aircraft.atcModel || f?.aircraft.atcType || ""}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {selVisit.flightIds.length > MAX_FLIGHTS && <div className="detail">… und {selVisit.flightIds.length - MAX_FLIGHTS} weitere im Logbuch</div>}
              </>
            ) : (
              <div className="detail">– Noch keine Landung in diesem Land.</div>
            )}
          </div>
        )}

        <div className="countries-list-wrap">
          {stat ? <CountryList rows={shown} selected={selected} onSelect={setSelected} /> : !error && <div className="detail">Länder werden geladen …</div>}
        </div>
      </aside>
    </section>
  );
}

/**
 * The map canvas (preserveDrawingBuffer) with a footer: title, progress, date and the map
 * credits. Device pixels, so the export is as sharp as the screen.
 */
async function renderMapPng(map: maplibregl.Map, line: string): Promise<Blob> {
  await new Promise<void>((resolve) => {
    map.once("render", () => resolve());
    map.triggerRepaint();
  });
  const src = map.getCanvas();
  const scale = src.width / Math.max(1, src.clientWidth || src.width);
  const footer = Math.round(44 * scale);
  const canvas = document.createElement("canvas");
  canvas.width = src.width;
  canvas.height = src.height + footer;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas nicht verfügbar");
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0);
  const font = getComputedStyle(document.body).fontFamily || "sans-serif";
  const pad = Math.round(14 * scale);
  const mid = src.height + footer / 2;
  ctx.textBaseline = "middle";
  ctx.fillStyle = COLOR.text;
  ctx.font = `600 ${Math.round(15 * scale)}px ${font}`;
  ctx.fillText("VectaSim · Länder", pad, mid);
  const titleW = ctx.measureText("VectaSim · Länder").width;
  ctx.fillStyle = COLOR.accent;
  ctx.font = `500 ${Math.round(14 * scale)}px ${font}`;
  ctx.fillText(line, pad * 2 + titleW, mid);
  ctx.fillStyle = COLOR.textMuted;
  ctx.font = `${Math.round(11 * scale)}px ${font}`;
  ctx.textAlign = "right";
  ctx.fillText(`${fmtDate(Date.now())} · © OpenStreetMap · OpenFreeMap · Natural Earth`, canvas.width - pad, mid);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG konnte nicht erzeugt werden"))), "image/png"));
}
