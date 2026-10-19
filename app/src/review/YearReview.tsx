import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Airport, FlightRow } from "../types";
import type { ApproachFactsResult } from "../landing/approachTypes";
import type { RunwayFact } from "../landing/types";
import { countryName, type Country, type VisitedCountries } from "../countries/countries";
import { readCardTheme } from "../landing/LandingCard";
import { usePrefs } from "../prefs";
import { useStoredState } from "../live/hooks";
import { effectiveArr, effectiveDep } from "../logbookFilter";
import { useLanguage, useT, type TFunction } from "../i18n";
import ErrorNotice from "../ErrorNotice";
import EmptyState from "../ui/EmptyState";
import ReviewCard, { cardHasData, visibleCards } from "./ReviewCards";
import { copyReviewCard, saveAllReviewCards, saveReviewCard, saveReviewStack, type CardSource } from "./exportReview";
import { FACTS_WINDOW, buildReview, demoLeftOut, flightTimeMs, inPeriod, periodLabel, periodOf, periodTitle, reviewFlights, yearsWithFlights, type LonLat, type PeriodMode, type YearReview as Review } from "./stats";
import { cardTitle, formatLabel, type CardFormat } from "./text";
import "./review.css";

interface RunwayFactsResult {
  facts: RunwayFact[];
  skipped: number;
}

interface Data {
  flights: FlightRow[];
  landings: RunwayFact[];
  approaches: ApproachFactsResult["facts"];
  visited: VisitedCountries;
}

interface StaticData {
  countries: Country[];
  outlines: GeoJSON.FeatureCollection;
}

/** Country list and outlines (same commands as the Länder view), loaded once per app run. */
let staticData: Promise<StaticData> | null = null;
function loadStatic(): Promise<StaticData> {
  staticData ??= Promise.all([invoke<Country[]>("countries_list"), invoke<ArrayBuffer>("countries_geojson")])
    .then(([countries, raw]) => ({ countries, outlines: JSON.parse(new TextDecoder().decode(raw)) as GeoJSON.FeatureCollection }))
    .catch((e) => {
      staticData = null;
      throw e;
    });
  return staticData;
}

/** Airport positions looked up for flights without recorded coordinates (imports); null = unknown. */
const coordCache = new Map<string, LonLat | null>();

async function lookupCoords(idents: string[]): Promise<void> {
  const todo = idents.filter((i) => !coordCache.has(i)).slice(0, 300);
  await Promise.all(
    todo.map((ident) =>
      invoke<{ airport: Airport } | null>("get_airport", { ident })
        .then((r) => coordCache.set(ident, r ? [r.airport.longitude, r.airport.latitude] : null))
        .catch(() => coordCache.set(ident, null)),
    ),
  );
}

const MODES: PeriodMode[] = ["year", "last12"];
const FORMATS: CardFormat[] = ["portrait", "landscape"];

/**
 * Logbook section „Jahr“: the year in review („Dein Jahr 2026“) as seven story cards (an
 * eighth, „Mit Sternchen“, when flights had pause, time acceleration or slew) –
 * each one saved or copied as PNG, all at once into a folder, or as one tall stack.
 * Aggregated here from the existing commands (stats.ts); imported flights count for hours,
 * routes and countries, not for landings and approaches; demo flights as everywhere.
 */
/**
 * Hint lines below the headline: what the imported flights count for, that landings and
 * approaches need a recorded flight, and when they only come from the newest 200 facts.
 */
export function reviewNotes(review: Review, t: TFunction): string[] {
  const out: string[] = [];
  const recorded = review.flights - review.imported;
  if (review.imported > 0) out.push(t("review.view.imported", { count: review.imported }));
  if (recorded === 0 && review.imported > 0) out.push(t("review.view.firstRecorded"));
  const l = review.landings.partial;
  const a = review.approaches.partial;
  if (l || a) out.push(t(l && a ? "review.view.partialBoth" : l ? "review.view.partialLandings" : "review.view.partialApproaches", { n: FACTS_WINDOW }));
  return out;
}

export default function YearReview() {
  const t = useT();
  const lang = useLanguage();
  const prefs = usePrefs();
  const { showDemo, timeLocal, privacyMode, cardHideReg, theme } = prefs;
  const [data, setData] = useState<Data | null>(null);
  const [stat, setStat] = useState<StaticData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [coordsRev, setCoordsRev] = useState(0);
  const [storedMode, setMode] = useStoredState<string>("vectasim.review.mode", "year");
  const [storedFormat, setFormat] = useStoredState<string>("vectasim.review.format", "portrait");
  const [year, setYear] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const mode: PeriodMode = storedMode === "last12" ? "last12" : "year";
  const format: CardFormat = storedFormat === "landscape" ? "landscape" : "portrait";

  useEffect(() => {
    let alive = true;
    loadStatic().then(
      (s) => alive && setStat(s),
      () => {
        /* maps fall back to lines only */
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [flights, landings, approaches, visited] = await Promise.all([
        invoke<FlightRow[]>("list_flights", { limit: 100000 }),
        invoke<RunwayFactsResult>("landing_facts_recent", { limit: FACTS_WINDOW, includeDemo: showDemo }).then((r) => r.facts),
        invoke<ApproachFactsResult>("approach_facts_recent", { limit: FACTS_WINDOW, includeDemo: showDemo })
          .then((r) => r.facts)
          .catch(() => []),
        invoke<VisitedCountries>("visited_countries", { includeDemo: showDemo }),
      ]);
      setData({ flights, landings, approaches, visited });
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

  const years = useMemo(() => (data ? yearsWithFlights(data.flights, showDemo, timeLocal) : []), [data, showDemo, timeLocal]);
  const shownYear = year != null && years.includes(year) ? year : (years[0] ?? new Date().getFullYear());
  const period = useMemo(() => periodOf(mode, shownYear, Date.now(), timeLocal), [mode, shownYear, timeLocal]);

  // airports of the period without recorded coordinates: arrivals from visited_countries, the rest looked up
  useEffect(() => {
    if (!data) return;
    for (const a of data.visited.airports) if (!coordCache.has(a.ident)) coordCache.set(a.ident, [a.longitude, a.latitude]);
    const missing = new Set<string>();
    for (const f of reviewFlights(data.flights, showDemo)) {
      if (!inPeriod(flightTimeMs(f), period)) continue;
      const dep = effectiveDep(f)?.trim().toUpperCase();
      const arr = effectiveArr(f)?.trim().toUpperCase();
      if (dep && !coordCache.has(dep)) missing.add(dep);
      if (arr && !coordCache.has(arr)) missing.add(arr);
    }
    if (!missing.size) return;
    let alive = true;
    void lookupCoords([...missing]).then(() => alive && setCoordsRev((n) => n + 1));
    return () => {
      alive = false;
    };
  }, [data, period, showDemo]);

  const review = useMemo(() => {
    if (!data) return null;
    const coords = new Map<string, LonLat>();
    for (const [k, v] of coordCache) if (v) coords.set(k, v);
    void coordsRev;
    return buildReview({ flights: data.flights, landings: data.landings, approaches: data.approaches, visits: data.visited.countries, coords, showDemo }, period);
  }, [data, period, showDemo, coordsRev]);

  const countryNames = useMemo(() => new Map((stat?.countries ?? []).map((c) => [c.iso2, countryName(c, lang)])), [stat, lang]);
  const src: CardSource | null = useMemo(() => (review ? { review, outlines: stat?.outlines ?? null, countryNames } : null), [review, stat, countryNames]);
  // concrete colours of the active theme (re-read when it changes)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const colors = useMemo(() => readCardTheme(), [theme]);
  const hideReg = privacyMode || cardHideReg;
  const demoOut = data ? demoLeftOut(data.flights, showDemo) : 0;
  const notes = review ? reviewNotes(review, t) : [];

  const run = async (job: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await job();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="logbook review-view">
      {error && <ErrorNotice error={error} context="logbook" onRetry={refresh} />}
      <div className="review-bar">
        {mode === "year" &&
          (years.length > 1 ? (
            <div className="chips" role="group" aria-label={t("review.view.yearGroup")}>
              {years.map((y) => (
                <button key={y} className={`chip${y === shownYear ? " active" : ""}`} aria-pressed={y === shownYear} onClick={() => setYear(y)}>
                  {y}
                </button>
              ))}
            </div>
          ) : (
            // a single year is no choice: plain text instead of a lone chip
            <span className="review-year num">{shownYear}</span>
          ))}
        <div className="review-group">
          <span className="review-group-label" id="review-period-label">
            {t("review.view.periodGroup")}
          </span>
          <div className="segmented" role="group" aria-labelledby="review-period-label">
            {MODES.map((m) => (
              <button key={m} className={mode === m ? "active" : ""} aria-pressed={mode === m} onClick={() => setMode(m)}>
                {t(`review.mode.${m}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="review-group">
          <span className="review-group-label" id="review-format-label">
            {t("review.view.formatGroup")}
          </span>
          <div className="segmented" role="group" aria-labelledby="review-format-label">
            {FORMATS.map((f) => (
              <button key={f} className={format === f ? "active" : ""} aria-pressed={format === f} onClick={() => setFormat(f)}>
                {formatLabel(f, lang)}
              </button>
            ))}
          </div>
        </div>
        <div className="review-actions">
          <button className="btn btn-sm" disabled={!src || busy || !review?.flights} onClick={() => src && run(() => saveAllReviewCards(format, src))} title={t("review.view.saveAllHint", { format: formatLabel(format, lang) })}>
            {t("review.view.saveAll")}
          </button>
          <button className="btn btn-sm" disabled={!src || busy || !review?.flights} onClick={() => src && run(() => saveReviewStack(src))} title={t("review.view.saveStackHint")}>
            {t("review.view.saveStack")}
          </button>
        </div>
      </div>

      {review && (
        <div className="review-note">
          <p className="detail">
            <strong>{periodTitle(period, lang)}</strong>
            {mode === "last12" && <> · {periodLabel(period, lang)}</>} · {t("count.flights", { count: review.flights })}
            {demoOut > 0 && <> · {t("review.view.demoOut", { count: demoOut })}</>}
            {hideReg && <> · {t("review.view.masked")}</>}
          </p>
          {notes.length > 0 && (
            <ul className="detail review-hints">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!data && !error && <p className="detail">{t("review.view.loading")}</p>}
      {review && review.flights === 0 && (
        <EmptyState title={mode === "year" ? t("review.view.emptyYear", { year: String(shownYear) }) : t("review.view.emptyLast12")} text={t("review.view.emptyText")} />
      )}

      {src && review && review.flights > 0 && (
        <div className={`review-grid review-${format}`}>
          {visibleCards(review).map((id) => {
            const has = cardHasData(id, review);
            const title = cardTitle(id, lang);
            const why = has ? undefined : t("review.view.noDataHint");
            return (
              <figure key={id} className={`review-card${has ? "" : " review-card-empty"}`}>
                <div className="review-card-img">
                  <ReviewCard id={id} format={format} review={review} colors={colors} hideReg={hideReg} outlines={src.outlines} countryNames={countryNames} idPrefix="pv" />
                </div>
                <figcaption>
                  <span className="review-card-title">{title}</span>
                  {!has && <span className="detail">{t("review.view.noData")}</span>}
                  <div className="spacer" />
                  <button className="btn btn-sm" disabled={busy || !has} title={why} aria-label={t("review.view.saveCard", { card: title })} onClick={() => run(() => saveReviewCard(id, format, src))}>
                    {t("review.view.save")}
                  </button>
                  <button className="btn btn-sm" disabled={busy || !has} title={why} aria-label={t("review.view.copyCard", { card: title })} onClick={() => run(() => copyReviewCard(id, format, src))}>
                    {t("review.view.copy")}
                  </button>
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
    </section>
  );
}
