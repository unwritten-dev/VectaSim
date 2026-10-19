import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { NNBSP, fmt, fmtDate, fmtNum } from "../i18n/number";
import { useT, type TFunction } from "../i18n";
import { usePrefs } from "../prefs";
import ErrorNotice from "../ErrorNotice";
import EmptyState from "../ui/EmptyState";
import { BAND_LABEL, BAND_SHAPE, BAND_VAR, VS_BANDS, vsBandOf } from "./facts";
import { BandSwatch, ShapeMark } from "./BandMark";
import { niceDistanceStep, sideLabel, stripeCount } from "./geometry";
import { openDebrief } from "./debriefStore";
import { usePointNav } from "./pointNav";
import type { Band, RunwayFact } from "./types";
import {
  aircraftKey,
  applyFilter,
  clamp,
  dispersionStats,
  distanceText,
  ellipseInput,
  ellipsePoints,
  filterOptions,
  lateralOf,
  lateralText,
  linear,
  sigmaEllipse,
  type DispersionFilter,
} from "./dispersionStats";
import "./dispersion.css";

/** Normalised runway: every landing is drawn on the same 3000 m strip. */
const RWY_LEN_M = 3000;
/** Touchdown zone of that strip: from the threshold to 900 m (ICAO/FAA; landing.rs). */
const TDZ_START_M = 0;
const TDZ_END_M = 900;
/** Aiming-point marking of a 3000 m runway (ICAO Annex 14 Tab. 5-2: ≥ 2400 m → 400 m). */
const AIM_M = 400;
/** Shown before the threshold (short landings). */
const X_MIN_M = -150;
/** Lateral axis, strongly exaggerated. */
const Y_HALF_M = 15;
/** Stripes as on a 45 m runway. */
const STRIPE_WIDTH_M = 45;

const PAD_L = 52;
const PAD_R = 14;
const TOP = 22;
const BAND_H = 150;
const PLOT_H = TOP + BAND_H + 30;
const SPARK_H = 64;
const BANDS: Band[] = ["smooth", "normal", "firm", "hard"];
/** "sanft < 150", "normal < 300", … in BANDS order; read at render time (VS_BANDS follows the language). */
const bandRanges = (): string[] => VS_BANDS.replace(/ fpm$/, "").split(" · ");

interface RunwayFactsResult {
  facts: RunwayFact[];
  skipped: number;
}

function factLine(t: TFunction, f: RunwayFact): string {
  const ac = [f.aircraftIcaoType || f.aircraftTitle, f.registration].filter(Boolean).join(" ");
  return [
    `${f.airportIcao} ${f.runwayIdent}`,
    ac,
    fmtDate(f.timestampMs),
    fmt(f.landingRateFpm, 0, "fpm"),
    t("dispersion.pastThreshold", { distance: distanceText(f) }),
    lateralText(f),
    f.inTouchdownZone ? t("dispersion.inTdz") : t("dispersion.outTdz"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * "Streubild": touchdown points of the last landings on a normalised runway seen from
 * above (landing direction left → right, right of the centreline is down), coloured by
 * landing-rate band, with the 1σ ellipse, three key numbers and a landing-rate sparkline.
 * A click on a landing opens its debrief.
 */
export default function Dispersion({ limit = 20 }: { limit?: number }) {
  const t = useT();
  const { showDemo } = usePrefs();
  const [data, setData] = useState<RunwayFactsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<DispersionFilter>({ aircraft: null, airport: null });
  const [hover, setHover] = useState<string | null>(null);
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(720);
  const clipId = useId().replace(/:/g, "");

  // more than `limit`, so a filter still finds up to `limit` landings of its kind
  const fetchLimit = Math.min(200, Math.max(limit, limit * 5));
  const refresh = useCallback(async () => {
    try {
      const r = await invoke<RunwayFactsResult>("landing_facts_recent", { limit: fetchLimit, includeDemo: showDemo });
      setData(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [fetchLimit, showDemo]);

  useEffect(() => {
    refresh();
    const un = listen("logbook:changed", refresh);
    return () => {
      un.then((u) => u());
    };
  }, [refresh]);

  useEffect(() => {
    if (!wrap) return;
    const measure = () => setWidth(Math.max(320, Math.floor(wrap.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [wrap]);

  const all = useMemo(() => data?.facts ?? [], [data]);
  const aircraftOpts = useMemo(() => filterOptions(all, aircraftKey), [all]);
  const airportOpts = useMemo(() => filterOptions(all, (f) => f.airportIcao), [all]);
  // a filter value that vanished from the data (flight deleted) falls back to "Alle"
  const active = useMemo<DispersionFilter>(
    () => ({
      aircraft: filter.aircraft && aircraftOpts.some((o) => o.key === filter.aircraft) ? filter.aircraft : null,
      airport: filter.airport && airportOpts.some((o) => o.key === filter.airport) ? filter.airport : null,
    }),
    [filter, aircraftOpts, airportOpts],
  );
  const facts = useMemo(() => applyFilter(all, active, limit), [all, active, limit]);
  const stats = useMemo(() => dispersionStats(facts), [facts]);
  const ellipsePts = useMemo(() => ellipseInput(facts), [facts]);
  const ellipse = useMemo(() => sigmaEllipse(ellipsePts), [ellipsePts]);
  const unmeasured = facts.length - stats.lateralCount;
  const nav = usePointNav(facts.length);

  const keyOf = (f: RunwayFact) => `${f.flightId}#${f.touchdownIndex}`;
  const newest = facts[0] ?? null;
  const hovered = facts.find((f) => keyOf(f) === hover) ?? null;
  const open = (f: RunwayFact) => openDebrief(f.flightId, f.touchdownIndex);

  if (error && !data) {
    return (
      <section className="dp">
        <ErrorNotice error={error} context="logbook" onRetry={refresh} />
      </section>
    );
  }
  if (!data) {
    return (
      <section className="dp">
        <div className="detail">{t("dispersion.loading")}</div>
      </section>
    );
  }
  if (all.length === 0) {
    return (
      <section className="dp">
        <EmptyState
          title={t("dispersion.emptyTitle")}
          text={
            <>
              {t("dispersion.emptyText")}
              {data.skipped > 0 && ` ${t("dispersion.skipped", { count: data.skipped })}`}
            </>
          }
        />
      </section>
    );
  }

  // ---- layout (1 viewBox unit = 1 px of the measured width) ----
  const W = width;
  const X = linear(X_MIN_M, RWY_LEN_M, PAD_L, W - PAD_R);
  const Y = linear(-Y_HALF_M, Y_HALF_M, TOP, TOP + BAND_H);
  const xScale = (W - PAD_L - PAD_R) / (RWY_LEN_M - X_MIN_M);
  const step = niceDistanceStep(xScale, 64);
  const ticks: number[] = [];
  for (let d = 0; d <= RWY_LEN_M + 1e-6; d += step) ticks.push(d);
  const stripes = stripeCount(STRIPE_WIDTH_M);
  const stripeGap = BAND_H / (stripes + 1);
  // a landing without measurable lateral offset sits on the centreline, drawn hollow
  const ptOf = (f: RunwayFact) => {
    const lat = lateralOf(f);
    const outX = f.touchdownDistanceM < X_MIN_M || f.touchdownDistanceM > RWY_LEN_M;
    const outY = lat != null && Math.abs(lat) > Y_HALF_M;
    return {
      x: X(clamp(f.touchdownDistanceM, X_MIN_M, RWY_LEN_M)),
      y: Y(clamp(lat ?? 0, -Y_HALF_M, Y_HALF_M)),
      out: outX || outY,
      noLateral: lat == null,
    };
  };
  const ellipsePath = ellipse && ellipsePts.length >= 3 ? ellipsePoints(ellipse, 64).map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ") + " Z" : null;

  // sparkline: chronological (oldest left), |fpm| upwards
  const chrono = [...facts].reverse();
  const maxFpm = Math.max(600, ...chrono.map((f) => Math.abs(f.landingRateFpm)));
  const SX = linear(0, Math.max(chrono.length - 1, 1), PAD_L, W - PAD_R);
  const SY = linear(0, maxFpm, SPARK_H - 8, 8);
  const sparkPath = chrono.map((f, i) => `${i ? "L" : "M"}${SX(i).toFixed(1)},${SY(Math.abs(f.landingRateFpm)).toFixed(1)}`).join(" ");

  const lateral = !stats.lateralCount
    ? t("dispersion.lateralNone")
    : unmeasured
      ? t("dispersion.lateralMeanPartial", { value: fmt(stats.meanAbsOffsetM, 0, "m"), n: stats.lateralCount, count: stats.count })
      : t("dispersion.lateralMean", { value: fmt(stats.meanAbsOffsetM, 0, "m") });
  const summary = t("dispersion.summary", { inTdz: stats.inTdz, count: stats.count, mean: fmt(stats.meanDistM, 0, "m"), sd: fmtNum(stats.sdDistM, 0), lateral });
  const ranges = bandRanges();

  return (
    <section className="dp" aria-label={t("dispersion.aria")}>
      {error && <ErrorNotice error={error} context="logbook" onRetry={refresh} compact />}
      {(aircraftOpts.length > 1 || airportOpts.length > 1) && (
        <div className="chips dp-chips" role="group" aria-label={t("dispersion.filter.label")}>
          <button
            className={`chip${!active.aircraft && !active.airport ? " active" : ""}`}
            aria-pressed={!active.aircraft && !active.airport}
            onClick={() => setFilter({ aircraft: null, airport: null })}
          >
            {t("dispersion.filter.all")}
          </button>
          {aircraftOpts.length > 1 && <span className="chip-sep" aria-hidden="true" />}
          {aircraftOpts.length > 1 &&
            aircraftOpts.map((o) => (
              <button
                key={`ac-${o.key}`}
                className={`chip${active.aircraft === o.key ? " active" : ""}`}
                aria-pressed={active.aircraft === o.key}
                title={t("dispersion.filter.only", { key: o.key, count: o.count })}
                onClick={() => setFilter((f) => ({ ...f, aircraft: f.aircraft === o.key ? null : o.key }))}
              >
                {o.key}
              </button>
            ))}
          {airportOpts.length > 1 && <span className="chip-sep" aria-hidden="true" />}
          {airportOpts.length > 1 &&
            airportOpts.map((o) => (
              <button
                key={`ap-${o.key}`}
                className={`chip${active.airport === o.key ? " active" : ""}`}
                aria-pressed={active.airport === o.key}
                title={t("dispersion.filter.only", { key: o.key, count: o.count })}
                onClick={() => setFilter((f) => ({ ...f, airport: f.airport === o.key ? null : o.key }))}
              >
                {o.key}
              </button>
            ))}
        </div>
      )}

      <div className="dp-body">
        <div ref={setWrap} className="dp-chart">
          {/* a group, not an img: an img hides its points from screen readers. The drawing is
              aria-hidden, the points are a list (one tab stop, arrows move, Enter opens). */}
          <svg viewBox={`0 0 ${W} ${PLOT_H}`} width="100%" height={PLOT_H} role="group" aria-label={t("dispersion.chartAria", { summary })}>
            <g aria-hidden="true">
            <defs>
              <clipPath id={clipId}>
                <rect x={PAD_L} y={TOP} width={W - PAD_L - PAD_R} height={BAND_H} />
              </clipPath>
            </defs>
            {/* runway (normalised) and the area before the threshold */}
            <rect x={X(0)} y={TOP} width={X(RWY_LEN_M) - X(0)} height={BAND_H} className="dp-runway" />
            <line x1={X(X_MIN_M)} x2={X(0)} y1={Y(0)} y2={Y(0)} className="dp-ext-centre" />
            <rect x={X(TDZ_START_M)} y={TOP} width={X(TDZ_END_M) - X(TDZ_START_M)} height={BAND_H} className="dp-tdz" />
            {/* aiming-point marking (two bars beside the centreline) */}
            {[-1, 1].map((s) => (
              <rect key={s} x={X(AIM_M)} y={s < 0 ? Y(-7) : Y(3)} width={Math.max(3, 45 * xScale)} height={Y(7) - Y(3)} className="dp-marking" />
            ))}
            {Array.from({ length: stripes }, (_, i) => (
              <rect key={i} x={X(6)} y={TOP + stripeGap * (i + 1) - 1.5} width={Math.max(4, 30 * xScale)} height={3} className="dp-marking" />
            ))}
            {[-10, -5, 5, 10].map((m) => (
              <line key={m} x1={X(0)} x2={X(RWY_LEN_M)} y1={Y(m)} y2={Y(m)} className="dp-grid" />
            ))}
            <line x1={X(0)} x2={X(RWY_LEN_M)} y1={Y(0)} y2={Y(0)} className="dp-centre" />
            {/* lateral axis labels: left of the centreline is up */}
            {[-10, 0, 10].map((m) => (
              <text key={m} x={PAD_L - 6} y={Y(m) + 4} textAnchor="end" className="dp-label">
                {m === 0 ? "CL" : `${Math.abs(m)}${NNBSP}m ${m < 0 ? "L" : "R"}`}
              </text>
            ))}
            <text x={X(TDZ_END_M) - 4} y={TOP - 7} textAnchor="end" className="dp-tdz-label">
              {t("dispersion.table.tdz")}
            </text>
            <text x={X(0)} y={TOP - 7} textAnchor="start" className="dp-label">
              {t("dispersion.threshold")}
            </text>
            {/* distance ticks from the threshold */}
            {ticks.map((d) => (
              <g key={d}>
                <line x1={X(d)} x2={X(d)} y1={TOP + BAND_H} y2={TOP + BAND_H + 5} className="dp-tick" />
                <text x={X(d)} y={TOP + BAND_H + 18} textAnchor={d === 0 ? "start" : "middle"} className="dp-label">
                  {d === 0 ? "0" : fmt(d, 0, "m")}
                </text>
              </g>
            ))}

            <g clipPath={`url(#${clipId})`}>
              {ellipsePath && <path d={ellipsePath} className="dp-ellipse" />}
              {ellipse && ellipsePts.length >= 2 && (
                <g className="dp-mean" transform={`translate(${X(ellipse.cx)},${Y(ellipse.cy)})`}>
                  <line x1={-6} x2={6} y1={0} y2={0} />
                  <line x1={0} x2={0} y1={-6} y2={6} />
                </g>
              )}
            </g>
            </g>

            {/* oldest first so the newest is drawn on top */}
            <g role="list" aria-label={t("dispersion.listAria")}>
            {chrono.map((f, i) => {
              const p = ptOf(f);
              const k = keyOf(f);
              const isNewest = f === newest;
              const isHover = k === hover;
              const band = vsBandOf(f.landingRateFpm);
              const color = BAND_VAR[band];
              return (
                <g key={k} role="listitem">
                  <g
                    className={`dp-pt${isNewest ? " newest" : ""}${isHover ? " hover" : ""}${p.out ? " out" : ""}${p.noLateral ? " no-lateral" : ""}`}
                    role="button"
                    aria-label={t(isNewest ? "dispersion.pointAriaNewest" : "dispersion.pointAria", { line: factLine(t, f), band: BAND_LABEL[band] })}
                    onClick={() => open(f)}
                    onMouseEnter={() => setHover(k)}
                    onMouseLeave={() => setHover((h) => (h === k ? null : h))}
                    {...nav.props(i, () => open(f), () => setHover(k))}
                    onBlur={() => setHover((h) => (h === k ? null : h))}
                  >
                    <title>{factLine(t, f)}</title>
                    {/* invisible 24 px hit area around the small mark */}
                    <circle cx={p.x} cy={p.y} r={12} className="dp-hit" />
                    {(isNewest || isHover) && <circle cx={p.x} cy={p.y} r={isNewest ? 10 : 9} className="dp-ring" />}
                    <ShapeMark shape={BAND_SHAPE[band]} x={p.x} y={p.y} r={isNewest ? 6.5 : 5} style={{ fill: p.out || p.noLateral ? "none" : color, stroke: p.out || p.noLateral ? color : undefined }} className="dp-dot" />
                  </g>
                </g>
              );
            })}
            </g>
          </svg>

          {/* the same landings as above (and in the table below): for the mouse only */}
          <svg viewBox={`0 0 ${W} ${SPARK_H}`} width="100%" height={SPARK_H} className="dp-spark" role="img" aria-label={t("dispersion.sparkAria")}>
            {[150, 300, 600].filter((v) => v <= maxFpm).map((v) => (
              <g key={v}>
                <line x1={PAD_L} x2={W - PAD_R} y1={SY(v)} y2={SY(v)} className="dp-grid" />
                <text x={PAD_L - 6} y={SY(v) + 4} textAnchor="end" className="dp-label">
                  {v}
                </text>
              </g>
            ))}
            {chrono.length > 1 && <path d={sparkPath} className="dp-spark-line" />}
            {chrono.map((f, i) => {
              const k = keyOf(f);
              const isNewest = f === newest;
              const band = vsBandOf(f.landingRateFpm);
              return (
                <g
                  key={k}
                  className={`dp-pt${isNewest ? " newest" : ""}${k === hover ? " hover" : ""}`}
                  onClick={() => open(f)}
                  onMouseEnter={() => setHover(k)}
                  onMouseLeave={() => setHover((h) => (h === k ? null : h))}
                >
                  <title>{factLine(t, f)}</title>
                  <circle cx={SX(i)} cy={SY(Math.abs(f.landingRateFpm))} r={12} className="dp-hit" />
                  {(isNewest || k === hover) && <circle cx={SX(i)} cy={SY(Math.abs(f.landingRateFpm))} r={7} className="dp-ring" />}
                  <ShapeMark shape={BAND_SHAPE[band]} x={SX(i)} y={SY(Math.abs(f.landingRateFpm))} r={isNewest ? 4.5 : 3.6} style={{ fill: BAND_VAR[band] }} className="dp-dot" />
                </g>
              );
            })}
          </svg>
          {/* no live region: it changes on every mouse hover */}
          <div className="dp-hover detail">
            {hovered ? factLine(t, hovered) : newest ? t("dispersion.newest", { line: factLine(t, newest) }) : " "}
          </div>
        </div>

        <div className="dp-stats" aria-label={summary}>
          <div className="tile">
            <div className="tile-label">{t("dispersion.tile.tdz")}</div>
            <div className="tile-value num">
              {stats.inTdz}/{stats.count}
            </div>
            <div className="detail" title={t("dispersion.tile.tdzTitle", { end: fmt(TDZ_END_M, 0, "m") })}>
              {t("dispersion.tile.tdzDetail", { rate: stats.tdzRate != null ? `${fmtNum(stats.tdzRate * 100, 0)}${NNBSP}%` : "–", end: fmt(TDZ_END_M, 0, "m") })}
            </div>
          </div>
          <div className="tile">
            <div className="tile-label">{t("dispersion.tile.distance")}</div>
            <div className="tile-value num">
              {fmt(stats.meanDistM, 0, "m")}
              <span className="dp-sd"> ± {fmtNum(stats.sdDistM, 0)}</span>
            </div>
            <div className="detail">{t("dispersion.tile.distanceDetail")}</div>
          </div>
          <div className="tile">
            <div className="tile-label">{t("dispersion.tile.lateral")}</div>
            <div className="tile-value num">{stats.lateralCount ? fmt(stats.meanAbsOffsetM, 0, "m") : "–"}</div>
            <div className="detail">
              {stats.lateralCount ? t("dispersion.tile.tendency", { side: stats.meanOffsetM != null ? sideLabel(stats.meanOffsetM) : "–" }) : t("dispersion.tile.lateralNone")}
              {stats.lateralCount > 0 && unmeasured > 0 && ` · ${t("dispersion.tile.fromOf", { n: stats.lateralCount, count: stats.count })}`}
            </div>
          </div>
        </div>
      </div>

      <div className="dp-legend">
        <span className="dp-legend-title">{t("dispersion.legend.rate")}</span>
        {BANDS.map((b, i) => (
          <span key={b}>
            <BandSwatch shape={BAND_SHAPE[b]} color={BAND_VAR[b]} />
            {ranges[i] ?? BAND_LABEL[b]}
          </span>
        ))}
        <span className="dp-legend-sep" aria-hidden="true" />
        <span>
          <i className="dp-swatch ring" aria-hidden="true" />
          {t("dispersion.legend.newest")}
        </span>
        <span>
          <i className="dp-swatch ellipse" aria-hidden="true" />
          {t("dispersion.legend.ellipse")}
        </span>
        {unmeasured > 0 && (
          <span title={t("dispersion.legend.noLateralTitle")}>
            <i className="dp-swatch no-lateral" aria-hidden="true" />
            {t("dispersion.noLateral")}
          </span>
        )}
        <span>{t("dispersion.legend.tdzAim", { aim: fmt(AIM_M, 0, "m") })}</span>
        <span className="dp-note">
          {t("dispersion.legend.note", { landings: t("count.landings", { count: facts.length }), length: fmt(RWY_LEN_M, 0, "m"), half: fmt(Y_HALF_M, 0, "m") })}
          {data.skipped > 0 && ` · ${t("dispersion.skipped", { count: data.skipped })}`}
        </span>
      </div>
      {facts.length === 0 && <div className="detail">{t("dispersion.filter.none")}</div>}
      {facts.length > 0 && (
        <details className="dp-table">
          <summary>{t("dispersion.table.asTable", { count: facts.length })}</summary>
          <div className="dp-table-scroll">
            <table className="data-table">
              <caption className="sr-only">{t("dispersion.table.caption")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("dispersion.table.date")}</th>
                  <th scope="col">{t("dispersion.table.airportRunway")}</th>
                  <th scope="col">{t("dispersion.table.aircraft")}</th>
                  <th scope="col" className="num-col">
                    {t("dispersion.table.landingRate")}
                  </th>
                  <th scope="col">{t("dispersion.table.band")}</th>
                  <th scope="col" className="num-col">
                    {t("dispersion.table.touchdownPoint")}
                  </th>
                  <th scope="col">{t("dispersion.table.centreline")}</th>
                  <th scope="col">{t("dispersion.table.tdz")}</th>
                  <th scope="col">
                    <span className="sr-only">{t("dispersion.table.action")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {facts.map((f) => {
                  const band = vsBandOf(f.landingRateFpm);
                  return (
                    <tr key={keyOf(f)}>
                      <td className="num">{fmtDate(f.timestampMs)}</td>
                      <td className="num">
                        {f.airportIcao} {f.runwayIdent}
                      </td>
                      <td>{[f.aircraftIcaoType || f.aircraftTitle, f.registration].filter(Boolean).join(" ") || "–"}</td>
                      <td className="num num-col">{fmt(f.landingRateFpm, 0, "fpm")}</td>
                      <td>
                        <BandSwatch shape={BAND_SHAPE[band]} color={BAND_VAR[band]} /> {BAND_LABEL[band]}
                      </td>
                      <td className="num num-col">{distanceText(f)}</td>
                      <td>{lateralText(f)}</td>
                      <td>{f.inTouchdownZone ? t("dispersion.table.yes") : t("dispersion.table.no")}</td>
                      <td>
                        <button className="btn-sm" onClick={() => open(f)}>
                          {t("dispersion.table.debrief")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
