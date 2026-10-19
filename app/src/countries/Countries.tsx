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
import GlobeToggle from "../map/GlobeToggle";
import { isDemoRow } from "../totals";
import { countsInStats } from "../flightStats";
import { COLOR } from "../theme";
import { useLanguage, useT, type Language, type TFunction } from "../i18n";
import { fmt, fmtDate } from "../i18n/number";
import type { FlightRow } from "../types";
import {
  CONTINENTS,
  NO_FILTER,
  buildRows,
  continentLabel,
  continentProgress,
  countryName,
  exportFileName,
  filterRows,
  landingsLabel,
  otherCountryName,
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

const VISIT_FILTERS: VisitFilter[] = ["all", "visited", "open"];

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
  const t = useT();
  const lang = useLanguage();
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
      setDemoSkipped(showDemo ? 0 : rows.filter((f) => isDemoRow(f) && countsInStats(f) && f.state === "completed" && f.arrIcao).length);
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
  const rows = useMemo(() => buildRows(stat?.countries ?? [], data?.countries ?? [], lang), [stat, data, lang]);
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
      const path = await save({ defaultPath: exportFileName(new Date(), lang), filters: [{ name: t("countries.export.pngFilter"), extensions: ["png"] }] });
      if (!path) return;
      const blob = await renderMapPng(map, t("countries.export.line", { progress: progressLabel(progress), landings: landingsLabel(summary.landings, lang) }), t, lang);
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      await invoke("save_image", { path, bytes });
      showToast({ tone: "ok", title: t("countries.export.saved"), body: path, durationMs: 3000 });
    } catch (e) {
      const m = userMessage(e, "export");
      showToast({ id: "countries-export", tone: "err", title: t("countries.export.failed", { reason: m.title }), body: `${m.hint}${m.detail ? ` (${m.detail.slice(0, 160)})` : ""}` });
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
            <i className="swatch swatch-visited" /> {t("countries.legend.visited")}
          </span>
          <span>
            <i className="swatch swatch-open" /> {t("countries.legend.open")}
          </span>
          {showPins && (
            <span>
              <i className="swatch swatch-pin" /> {t("countries.legend.pin")}
            </span>
          )}
        </div>
        {empty && (
          <div className="countries-empty">
            <EmptyState
              title={t("countries.empty.title")}
              text={
                <>
                  {t("countries.empty.text")}
                  {demoSkipped > 0 && (
                    <>
                      <br />
                      {t("countries.empty.demoSkipped", { count: demoSkipped })}
                    </>
                  )}
                </>
              }
            />
          </div>
        )}
      </div>

      <aside className="countries-panel" aria-label={t("countries.panel")}>
        {error && <ErrorNotice error={error} context="logbook" onRetry={refresh} />}
        <div className="countries-progress">
          <div className="countries-progress-head">
            <span className="countries-count num">{stat && data ? progressLabel(scope ?? progress) : "–"}</span>
            <span className="detail">{scope ? t("countries.inContinent", { continent: continentLabel(filter.continent!, lang) }) : t("countries.visitedCount")}</span>
            <div className="spacer" />
            <button className="btn-sm" onClick={exportPng} disabled={exporting || !stat} title={t("countries.saveImageHint")}>
              {t("countries.saveImage")}
            </button>
          </div>
          <div
            className="countries-bar"
            role="progressbar"
            aria-label={t("countries.progressLabel")}
            aria-valuemin={0}
            aria-valuemax={(scope ?? progress).total}
            aria-valuenow={(scope ?? progress).visited}
            aria-valuetext={t("countries.progressText", { visited: (scope ?? progress).visited, total: (scope ?? progress).total })}
          >
            <div className="countries-bar-fill" style={{ width: `${(scope ?? progress).percent}%` }} />
          </div>
          <div className="detail">
            {summary.landings > 0
              ? t("countries.summary", { landings: landingsLabel(summary.landings, lang), country: lastName(countryMap.get(summary.lastIso ?? ""), summary.lastIso, lang), date: fmtDate(summary.lastMs, { lang }) })
              : t("countries.summaryNone")}
            {demoSkipped > 0 && !empty && ` · ${t("countries.demoSkipped", { count: demoSkipped })}`}
          </div>
        </div>

        <div className="chips" role="group" aria-label={t("countries.continentGroup")}>
          <button className={`chip${filter.continent == null ? " active" : ""}`} aria-pressed={filter.continent == null} onClick={() => setFilter({ ...filter, continent: null })}>
            {t("countries.filter.all")}
          </button>
          {CONTINENTS.map(({ code }) => {
            const p = perContinent.get(code);
            return (
              <button
                key={code}
                className={`chip${filter.continent === code ? " active" : ""}`}
                aria-pressed={filter.continent === code}
                onClick={() => setFilter({ ...filter, continent: filter.continent === code ? null : (code as ContinentCode) })}
              >
                {continentLabel(code, lang)} <span className="num detail">{p ? progressLabel(p) : ""}</span>
              </button>
            );
          })}
        </div>

        <div className="countries-toolbar">
          <input
            type="search"
            className="countries-search"
            placeholder={t("countries.searchPlaceholder")}
            aria-label={t("countries.searchLabel")}
            value={filter.query}
            onChange={(e) => setFilter({ ...filter, query: e.target.value })}
          />
          <div className="chips" role="group" aria-label={t("countries.visitGroup")}>
            {VISIT_FILTERS.map((v) => (
              <button key={v} className={`chip${filter.visit === v ? " active" : ""}`} aria-pressed={filter.visit === v} onClick={() => setFilter({ ...filter, visit: v })}>
                {t(`countries.filter.${v}`)}
              </button>
            ))}
          </div>
          <label className="countries-pins">
            <input type="checkbox" checked={showPins} onChange={(e) => togglePins(e.target.checked)} /> {t("countries.airports")}
          </label>
          {/* the same Globus button as on the maps */}
          <GlobeToggle className="chip" />
        </div>

        {sel && (
          <div className="country-detail" aria-live="polite">
            <div className="country-detail-head">
              <strong>{countryName(sel, lang)}</strong>
              <span className="detail">
                {otherCountryName(sel, lang)} · {continentLabel(sel.continent, lang)}
              </span>
              <div className="spacer" />
              <button className="btn-sm btn-ghost" onClick={() => setSelected(null)} aria-label={t("countries.clearSelection")}>
                ×
              </button>
            </div>
            {selVisit ? (
              <>
                <div className="country-yes">
                  {t("countries.visitLine", { landings: landingsLabel(selVisit.landings, lang), first: fmtDate(selVisit.firstMs, { lang }), last: fmtDate(selVisit.lastMs, { lang }) })}
                </div>
                <div className="detail">
                  {t("countries.airportsLine", {
                    list: selVisit.airports
                      .map((icao) => {
                        const a = data?.airports.find((x) => x.ident === icao);
                        return a ? `${icao} (${fmt(a.landings, 0, "", lang)}×)` : icao;
                      })
                      .join(", "),
                  })}
                </div>
                <ul className="country-flights">
                  {selVisit.flightIds.slice(0, MAX_FLIGHTS).map((id) => {
                    const f = flights.get(id);
                    return (
                      <li key={id}>
                        <button className="btn-ghost country-flight" onClick={() => navigate({ kind: "flight", id })} title={t("countries.openInLogbook")}>
                          <span className="num">{fmtDate(f?.landingMs ?? f?.onBlockMs ?? f?.createdMs, { lang })}</span>
                          <span className="mono">
                            {f?.depIcao ?? "?"} → {f?.arrIcao ?? "?"}
                          </span>
                          <span className="detail">{f?.aircraft.atcModel || f?.aircraft.atcType || ""}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {selVisit.flightIds.length > MAX_FLIGHTS && <div className="detail">{t("countries.moreFlights", { n: selVisit.flightIds.length - MAX_FLIGHTS })}</div>}
              </>
            ) : (
              <div className="detail">{t("countries.notVisited")}</div>
            )}
          </div>
        )}

        <div className="countries-list-wrap">
          {stat ? <CountryList rows={shown} selected={selected} onSelect={setSelected} /> : !error && <div className="detail">{t("countries.loading")}</div>}
        </div>
      </aside>
    </section>
  );
}

/** Name of the most recently visited country, or its code when the list does not know it. */
function lastName(c: Country | undefined, iso: string | null, lang: Language): string {
  return c ? countryName(c, lang) : (iso ?? "");
}

/**
 * The map canvas (preserveDrawingBuffer) with a footer: title, progress, date and the map
 * credits. Device pixels, so the export is as sharp as the screen.
 */
async function renderMapPng(map: maplibregl.Map, line: string, t: TFunction, lang: Language): Promise<Blob> {
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
  if (!ctx) throw new Error(t("countries.export.noCanvas"));
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0);
  const font = getComputedStyle(document.body).fontFamily || "sans-serif";
  const pad = Math.round(14 * scale);
  const mid = src.height + footer / 2;
  ctx.textBaseline = "middle";
  ctx.fillStyle = COLOR.text;
  ctx.font = `600 ${Math.round(15 * scale)}px ${font}`;
  const title = t("countries.export.title");
  ctx.fillText(title, pad, mid);
  const titleW = ctx.measureText(title).width;
  ctx.fillStyle = COLOR.accent;
  ctx.font = `500 ${Math.round(14 * scale)}px ${font}`;
  ctx.fillText(line, pad * 2 + titleW, mid);
  ctx.fillStyle = COLOR.textMuted;
  ctx.font = `${Math.round(11 * scale)}px ${font}`;
  ctx.textAlign = "right";
  ctx.fillText(`${fmtDate(Date.now(), { lang })} · © OpenStreetMap · OpenFreeMap · Natural Earth`, canvas.width - pad, mid);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t("countries.export.noPng")))), "image/png"));
}
