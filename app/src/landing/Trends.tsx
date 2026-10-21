import { useMemo, useState } from "react";
import { DASH, NNBSP, fmt, fmtDate, fmtNum, fmtSigned } from "../i18n/number";
import { useT, type TFunction } from "../i18n";
import { usePrefs } from "../prefs";
import EmptyState from "../ui/EmptyState";
import ErrorNotice from "../ErrorNotice";
import { openDebrief } from "./debriefStore";
import { linear } from "./dispersionStats";
import { niceStep, ticks, useWidth } from "./chartUtils";
import { useHistoryFacts } from "./HistoryPanel";
import { approachFor, demoFilter, metricsFor, monthCompare, trendSeries, typeKey, type Bucket, type HistLanding, type PeriodStats, type TrendPoint } from "./history";
import type { ApproachFact } from "./approachTypes";
import type { FlightMetricsFact } from "../types";
import { ROTATION_FAST_DEG_S, ROTATION_SLOW_DEG_S, fmtDegS } from "../trackEvents";
import "./dispersion.css";
import "./trends.css";

const LIMITS = [20, 50, 200] as const;
type Limit = (typeof LIMITS)[number];

const bucketLabel = (t: TFunction, b: Bucket): string => t(`trends.bucket.${b}`);
const BUCKETS: Bucket[] = ["flight", "week", "month"];

/** "Okt 2026" / "Oct 2026" from a month key "2026-10". */
function monthName(t: TFunction, key: string): string {
  const [y, m] = key.split("-");
  return t("trends.monthLabel", { month: t("trends.months").split(" ")[Number(m) - 1] ?? m, year: y });
}

/** "Okt 2026", "KW 42 2026", or the landing's date. */
function pointLabel(t: TFunction, p: TrendPoint, bucket: Bucket): string {
  if (bucket === "month") return monthName(t, p.key);
  if (bucket === "week") return t("trends.weekLabel", { week: p.key.slice(6), year: p.key.slice(0, 4) });
  return fmtDate(p.tMs);
}

function options(xs: string[]): Array<{ key: string; count: number }> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

type ChartId = "rate" | "distance" | "stableFrom" | "lateral" | "tdz" | "rotation" | "gearDown" | "exceedances";

interface ChartDef {
  id: ChartId;
  /** Unit of values and axis ("dots" is translated). */
  unit: string;
  /** Value → display number (TDZ 0..1 → %). */
  scale: (v: number) => number;
  /** Fixed lower / upper bound of the y axis. */
  floor: number;
  ceil?: number;
  /** Reference lines (band limits). */
  refs?: number[];
  /** Decimals of values / axis labels (default 0). */
  digits?: number;
}

/** Height band of the lateral RMS (approach facts: 1000 → 50 ft HAT). */
const LATERAL_FROM_FT = 1000;
const LATERAL_TO_FT = 50;

const CHARTS: ChartDef[] = [
  { id: "rate", unit: "fpm", scale: (v) => v, floor: 0, refs: [150, 300, 600] },
  { id: "distance", unit: "m", scale: (v) => v, floor: 0 },
  { id: "stableFrom", unit: "ft", scale: (v) => v, floor: 0, refs: [500, 1000] },
  { id: "lateral", unit: "dots", scale: (v) => v, floor: 0, refs: [0.3, 0.6], digits: 2 },
  { id: "tdz", unit: "%", scale: (v) => v * 100, floor: 0, ceil: 100 },
  // per-flight metrics (flight_metrics_recent); the rotation band is the track markers' one
  { id: "rotation", unit: "°/s", scale: (v) => v, floor: 0, refs: [ROTATION_SLOW_DEG_S, ROTATION_FAST_DEG_S], digits: 1 },
  { id: "gearDown", unit: "ft", scale: (v) => v, floor: 0 },
  { id: "exceedances", unit: "", scale: (v) => v, floor: 0 },
];

const unitText = (t: TFunction, unit: string) => (unit === "dots" ? t("trends.unitDots") : unit);

function chartTitle(t: TFunction, id: ChartId): string {
  return t(`trends.chart.${id}.title`);
}

function chartNote(t: TFunction, id: ChartId): string {
  if (id === "lateral") return t("trends.chart.lateral.note", { from: String(LATERAL_FROM_FT), to: fmt(LATERAL_TO_FT, 0, "ft") });
  return t(`trends.chart.${id}.note`);
}

const CH_H = 132;
const PAD_L = 44;
const PAD_R = 10;
/** Room above the plot for the unit of the y axis. */
const PAD_T = 22;
const PAD_B = 20;

/**
 * y axis of a trend chart: from the floor up to the next nice tick above the data (and the band
 * limits close to it), so even a single point sits below the top label; decimals follow the step.
 */
export function yAxis(dataMax: number, floor: number, ceil: number | undefined, refs: number[] = []): { max: number; ticks: number[]; digits: number } {
  // headroom above the data; a band limit close above it is shown, without extra headroom
  const top = Math.max(dataMax * 1.05, ...refs.filter((r) => r <= dataMax * 1.4));
  let max: number;
  let ts: number[];
  if (ceil != null) {
    max = ceil;
    ts = ticks(floor, max, 3);
  } else {
    const step = niceStep(Math.max(top - floor, 0), 3);
    const n = Math.max(1, Math.ceil((top - floor) / step - 1e-9));
    max = floor + n * step;
    ts = Array.from({ length: n + 1 }, (_, i) => Math.round((floor + i * step) * 1e6) / 1e6);
  }
  const step = ts.length > 1 ? ts[1] - ts[0] : 1;
  return { max, ticks: ts, digits: Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)) };
}

function TrendChart({ def, points, bucket, width, wide = false }: { def: ChartDef; points: TrendPoint[]; bucket: Bucket; width: number; wide?: boolean }) {
  const t = useT();
  const cls = wide ? "tr-chart tr-chart-wide" : "tr-chart";
  const vals = points.filter((p) => p.value != null);
  const last = [...points].reverse().find((p) => p.rolling != null);
  const first = points.find((p) => p.rolling != null);
  const unit = unitText(t, def.unit);
  const fmtV = (v: number | null | undefined) => (v == null ? DASH : fmt(def.scale(v), def.digits ?? 0, unit));
  const title = chartTitle(t, def.id);
  // the lateral metric is named "Kurs" (de); the tooltip says what it measures
  const hint = def.id === "lateral" ? t("trends.chart.lateral.hint") : undefined;
  const ariaBase = { title, bucket: bucketLabel(t, bucket), count: vals.length };
  const label =
    first && last && first !== last
      ? t("trends.chartAria.trend", { ...ariaBase, from: fmtV(first.rolling), to: fmtV(last.rolling) })
      : last
        ? t("trends.chartAria.single", { ...ariaBase, value: fmtV(last.rolling) })
        : t("trends.chartAria.plain", ariaBase);
  if (vals.length === 0) {
    return (
      <figure className={cls}>
        <figcaption className="tr-chart-head">
          <span className="tr-chart-title" title={hint}>
            {title}
          </span>
          <span className="detail">{t("trends.noValues")}</span>
        </figcaption>
      </figure>
    );
  }
  const ys = points.flatMap((p) => [p.value, p.rolling, p.q1, p.q3]).filter((v): v is number => v != null).map(def.scale);
  const axis = yAxis(Math.max(...ys), def.floor, def.ceil, def.refs);
  const yMax = axis.max;
  const yMin = def.floor;
  const n = points.length;
  const X = linear(0, Math.max(n - 1, 1), PAD_L + (n === 1 ? (width - PAD_L - PAD_R) / 2 : 0), width - PAD_R);
  const Y = linear(yMin, yMax, CH_H - PAD_B, PAD_T);
  const yTicks = axis.ticks;
  const path = (get: (p: TrendPoint) => number | null) => {
    let d = "";
    let pen = false;
    points.forEach((p, i) => {
      const v = get(p);
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(def.scale(v)).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  // IQR band of the buckets (week / month)
  const band = bucket !== "flight" ? points.filter((p) => p.q1 != null && p.q3 != null) : [];
  const bandPath =
    band.length > 1
      ? points
          .map((p, i) => (p.q3 != null ? `${X(i).toFixed(1)},${Y(def.scale(p.q3)).toFixed(1)}` : null))
          .filter(Boolean)
          .map((s, i) => `${i ? "L" : "M"}${s}`)
          .join("") +
        [...points]
          .map((p, i) => ({ p, i }))
          .reverse()
          .filter(({ p }) => p.q1 != null)
          .map(({ p, i }) => `L${X(i).toFixed(1)},${Y(def.scale(p.q1!)).toFixed(1)}`)
          .join("") +
        "Z"
      : null;
  const firstLabel = pointLabel(t, points[0], bucket);
  const lastLabel = pointLabel(t, points[n - 1], bucket);
  const sameEnds = n === 1 || firstLabel === lastLabel;
  return (
    <figure className={cls}>
      <figcaption className="tr-chart-head">
        <span className={`tr-chart-title${hint ? " has-hint" : ""}`} title={hint}>
          {title}
        </span>
        <span className="tr-chart-now num">{last ? fmtV(last.rolling) : DASH}</span>
        <span className="detail">{chartNote(t, def.id)}</span>
      </figcaption>
      <svg viewBox={`0 0 ${width} ${CH_H}`} width="100%" height={CH_H} role="img" aria-label={label}>
        {/* unit of the y axis above the tick labels */}
        <text x={PAD_L - 6} y={11} textAnchor="end" className="tr-label tr-unit">
          {unit}
        </text>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={width - PAD_R} y1={Y(t)} y2={Y(t)} className="tr-grid" />
            <text x={PAD_L - 6} y={Y(t) + 4} textAnchor="end" className="tr-label">
              {fmtNum(t, axis.digits)}
            </text>
          </g>
        ))}
        {(def.refs ?? [])
          .filter((r) => r < yMax)
          .map((r) => (
            <line key={`r${r}`} x1={PAD_L} x2={width - PAD_R} y1={Y(r)} y2={Y(r)} className="tr-ref" />
          ))}
        {bandPath && <path d={bandPath} className="tr-iqr" />}
        {points.map((p, i) =>
          p.value != null ? (
            <circle key={p.key} cx={X(i)} cy={Y(def.scale(p.value))} r={bucket === "flight" ? 2.6 : 3.4} className="tr-dot">
              <title>{`${pointLabel(t, p, bucket)}: ${fmtV(p.value)}${bucket !== "flight" ? ` (n = ${p.n})` : ""}`}</title>
            </circle>
          ) : null,
        )}
        {vals.length > 1 && <path d={path((p) => p.rolling)} className="tr-line" />}
        {n > 0 && (
          <>
            {/* one label when first and last fall on the same day / bucket ("18.10.2026 … 18.10.2026") */}
            {sameEnds ? (
              <text x={(X(0) + X(n - 1)) / 2} y={CH_H - 4} textAnchor="middle" className="tr-label">
                {firstLabel}
              </text>
            ) : (
              <>
                <text x={X(0)} y={CH_H - 4} textAnchor="start" className="tr-label">
                  {firstLabel}
                </text>
                <text x={X(n - 1)} y={CH_H - 4} textAnchor="end" className="tr-label">
                  {lastLabel}
                </text>
              </>
            )}
          </>
        )}
      </svg>
    </figure>
  );
}

interface MonthTileDef {
  id: "rate" | "distance" | "stableFrom" | "tdz";
  get: (s: PeriodStats) => number | null;
  unit: string;
  scale: number;
  /** Which direction is the improvement, for the wording of Δ. */
  lowerBetter: boolean | null;
}

const MONTH_TILES: MonthTileDef[] = [
  { id: "rate", get: (s) => s.rate, unit: "fpm", scale: 1, lowerBetter: true },
  { id: "distance", get: (s) => s.distance, unit: "m", scale: 1, lowerBetter: null },
  { id: "stableFrom", get: (s) => s.stableFrom, unit: "ft", scale: 1, lowerBetter: false },
  { id: "tdz", get: (s) => s.tdzRate, unit: "%", scale: 100, lowerBetter: false },
];

function MonthTiles({ m }: { m: ReturnType<typeof monthCompare> }) {
  const t = useT();
  return (
    <div className="tr-month" role="group" aria-label={t("trends.month.aria", { current: monthName(t, m.current.key), previous: monthName(t, m.previous.key) })}>
      <div className="tr-month-head detail">{t("trends.month.head", { current: fmtNum(m.current.n, 0), count: m.previous.n })}</div>
      <div className="tr-month-tiles">
        {MONTH_TILES.map((tile) => {
          const cur = tile.get(m.current);
          const prev = tile.get(m.previous);
          const d = cur != null && prev != null ? (cur - prev) * tile.scale : null;
          const word = d == null || Math.round(d) === 0 || tile.lowerBetter == null ? null : d < 0 === tile.lowerBetter ? t("trends.month.better") : t("trends.month.worse");
          return (
            <div key={tile.id} className="hist-tile">
              <div className="tile-label">{t(`trends.month.${tile.id}`)}</div>
              <div className="hist-tile-value num">{cur != null ? fmt(cur * tile.scale, 0, tile.unit) : DASH}</div>
              <div className="detail num">
                {t("trends.month.previous", { value: prev != null ? fmt(prev * tile.scale, 0, tile.unit) : DASH })}
                {d != null && (
                  <>
                    {" "}
                    · Δ {fmtSigned(d, 0, tile.unit === "%" ? t("trends.unitPp") : tile.unit)}
                    {word && ` (${word})`}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Logbook → Landungen → "Verlauf": landing rate, touchdown distance, "stabil ab", the TDZ
 * quota, take-off rotation, gear-down height and exceedances over time (per landing, week or month) with a moving median, filters type / airport /
 * period, this month vs the previous one, and the values as a table.
 */
export default function Trends() {
  const t = useT();
  const { showDemo, timeLocal } = usePrefs();
  const { landings, approaches, metrics, error } = useHistoryFacts();
  const [type, setType] = useState<string | null>(null);
  const [airport, setAirport] = useState<string | null>(null);
  const [limit, setLimit] = useState<Limit>(50);
  const [bucket, setBucket] = useState<Bucket>("flight");
  const [setWrap, width] = useWidth(720);
  const twoCols = width >= 760;

  const allL = useMemo(() => demoFilter(landings ?? [], null, showDemo), [landings, showDemo]);
  const allA = useMemo(() => demoFilter(approaches ?? [], null, showDemo), [approaches, showDemo]);
  const allM = useMemo(() => demoFilter(metrics ?? [], null, showDemo), [metrics, showDemo]);
  const typeOpts = useMemo(() => options(allL.map(typeKey)), [allL]);
  const airportOpts = useMemo(() => options(allL.map((f) => f.airportIcao)), [allL]);
  const activeType = type && typeOpts.some((o) => o.key === type) ? type : null;
  const activeAirport = airport && airportOpts.some((o) => o.key === airport) ? airport : null;

  const filteredL = useMemo(
    () => allL.filter((f) => (!activeType || typeKey(f) === activeType) && (!activeAirport || f.airportIcao === activeAirport)),
    [allL, activeType, activeAirport],
  );
  const filteredA = useMemo(
    () => allA.filter((f) => (!activeType || typeKey(f) === activeType) && (!activeAirport || f.airportIcao === activeAirport)),
    [allA, activeType, activeAirport],
  );
  // same type / airport filter (airport of the landing runway)
  const filteredM = useMemo(
    () => allM.filter((f) => (!activeType || typeKey(f) === activeType) && (!activeAirport || f.airportIcao === activeAirport)),
    [allM, activeType, activeAirport],
  );
  const facts = useMemo(() => filteredL.slice(0, limit), [filteredL, limit]);
  // approaches of the same period as the landings shown
  const aFacts = useMemo(() => {
    const oldest = facts.length ? facts[facts.length - 1].timestampMs : Infinity;
    return filteredA.filter((a) => a.endedMs >= oldest - 3_600_000).slice(0, limit);
  }, [filteredA, facts, limit]);
  // flight metrics of the same period as the landings shown
  const mFacts = useMemo(() => {
    const oldest = facts.length ? facts[facts.length - 1].timestampMs : Infinity;
    return filteredM.filter((m) => m.timestampMs >= oldest - 3_600_000).slice(0, limit);
  }, [filteredM, facts, limit]);
  const win = limit === 20 ? 5 : 10;
  const series = useMemo(
    () => trendSeries(facts, bucket, { approaches: aFacts, metrics: mFacts, window: bucket === "flight" ? win : 3 }),
    [facts, aFacts, mFacts, bucket, win],
  );
  const month = useMemo(() => monthCompare(filteredL, filteredA, Date.now()), [filteredL, filteredA]);

  if (error && !landings?.length) {
    return (
      <section className="tr">
        <ErrorNotice error={error} context="logbook" />
      </section>
    );
  }
  if (!landings) {
    return (
      <section className="tr">
        <div className="detail">{t("trends.loading")}</div>
      </section>
    );
  }
  if (allL.length === 0) {
    // only demo landings (or none yet): say what is missing and lead to the debrief, which works for demo flights too
    const lastDemo = landings[0];
    return (
      <section className="tr">
        <EmptyState
          title={t("trends.emptyTitle")}
          text={
            <>
              {landings.length > 0 ? t("trends.demoOnly", { count: landings.length }) : t("trends.emptyText")}
              <br />
              {t("trends.demoHint")}
            </>
          }
          actions={
            lastDemo ? (
              <button className="btn btn-sm" onClick={() => openDebrief(lastDemo.flightId, lastDemo.touchdownIndex)}>
                {t("trends.openLastDebrief")}
              </button>
            ) : undefined
          }
        />
      </section>
    );
  }

  const chip = (key: string, active: boolean, label: string, onClick: () => void, title?: string) => (
    <button key={key} className={`chip${active ? " active" : ""}`} aria-pressed={active} title={title} onClick={onClick}>
      {label}
    </button>
  );

  // „Alle“ alone is no choice: the filter row only appears with a second type or airport
  const hasFilters = typeOpts.length > 1 || airportOpts.length > 1;

  return (
    <section className="tr" aria-label={t("trends.aria")}>
      {hasFilters && (
        <div className="chips tr-chips" role="group" aria-label={t("dispersion.filter.label")}>
          {chip("all", !activeType && !activeAirport, t("dispersion.filter.all"), () => {
            setType(null);
            setAirport(null);
          })}
          {typeOpts.length > 1 && <span className="chip-sep" aria-hidden="true" />}
          {typeOpts.length > 1 && typeOpts.map((o) => chip(`t-${o.key}`, activeType === o.key, o.key, () => setType(activeType === o.key ? null : o.key), t("dispersion.filter.only", { key: o.key, count: o.count })))}
          {airportOpts.length > 1 && <span className="chip-sep" aria-hidden="true" />}
          {airportOpts.length > 1 &&
            airportOpts.map((o) => chip(`a-${o.key}`, activeAirport === o.key, o.key, () => setAirport(activeAirport === o.key ? null : o.key), t("dispersion.filter.only", { key: o.key, count: o.count })))}
        </div>
      )}
      <div className="tr-toolbar">
        <div className="chips" role="group" aria-label={t("trends.period")}>
          {LIMITS.map((n) => chip(`l${n}`, limit === n, t("trends.lastN", { count: n }), () => setLimit(n)))}
        </div>
        <div className="chips" role="group" aria-label={t("trends.groupBy")}>
          {BUCKETS.map((b) => chip(b, bucket === b, bucketLabel(t, b), () => setBucket(b)))}
        </div>
      </div>

      {/* nothing to compare without landings in either month */}
      {(month.current.n > 0 || month.previous.n > 0) && <MonthTiles m={month} />}

      {facts.length === 0 ? (
        <div className="detail">{t("dispersion.filter.none")}</div>
      ) : (
        <>
          {/* two columns from 760 px; an odd last chart (Aufsetzzone) takes the full row instead of standing alone */}
          <div ref={setWrap} className={`tr-charts${twoCols ? " two" : ""}`}>
            {CHARTS.map((def, i) => {
              const wide = twoCols && i === CHARTS.length - 1 && CHARTS.length % 2 === 1;
              return <TrendChart key={def.id} def={def} points={series[def.id]} bucket={bucket} wide={wide} width={Math.max(320, Math.floor(wide ? width : width / (twoCols ? 2 : 1)) - 8)} />;
            })}
          </div>
          <div className="dp-legend tr-legend">
            <span>
              <i className="tr-swatch dot" aria-hidden="true" />
              {bucket === "flight" ? t("trends.legend.single") : t("trends.legend.median", { bucket: bucketLabel(t, bucket) })}
            </span>
            <span>
              <i className="tr-swatch line" aria-hidden="true" />
              {bucket === "flight" ? t("trends.legend.rollingLandings", { count: win }) : t("trends.legend.rollingPeriods", { count: 3 })}
            </span>
            {bucket !== "flight" && (
              <span>
                <i className="tr-swatch iqr" aria-hidden="true" />
                {t("trends.legend.iqr")}
              </span>
            )}
            <span>
              <i className="tr-swatch ref" aria-hidden="true" />
              {t("trends.legend.refs", {
                rate: `${[150, 300, 600].map((v) => fmtNum(v, 0)).join(" / ")}${NNBSP}fpm`,
                stable: `${[500, 1000].map((v) => fmtNum(v, 0)).join(" / ")}${NNBSP}ft`,
                lateral: `${[0.3, 0.6].map((v) => fmtNum(v, 1)).join(" / ")}${NNBSP}${t("trends.unitDots")}`,
                rotation: `${[ROTATION_SLOW_DEG_S, ROTATION_FAST_DEG_S].map((v) => fmtNum(v, 1)).join(" / ")}${NNBSP}°/s`,
              })}
            </span>
            <span className="dp-note">
              {t("trends.legend.note", {
                landings: t("count.landings", { count: facts.length }),
                approaches: `${t("trends.legend.approaches", { count: aFacts.filter((a) => a.band != null).length })} · ${t("trends.legend.flights", { count: mFacts.length })}`,
                times: timeLocal ? t("trends.legend.timesLocal") : t("trends.legend.timesUtc"),
              })}
            </span>
          </div>
          <TrendTable facts={facts} approaches={aFacts} metrics={mFacts} bucket={bucket} series={series} />
        </>
      )}
    </section>
  );
}

function TrendTable({
  facts,
  approaches,
  metrics,
  bucket,
  series,
}: {
  facts: HistLanding[];
  approaches: ApproachFact[];
  metrics: FlightMetricsFact[];
  bucket: Bucket;
  series: ReturnType<typeof trendSeries>;
}) {
  const t = useT();
  if (bucket === "flight") {
    return (
      <details className="dp-table">
        <summary>{t("dispersion.table.asTable", { count: facts.length })}</summary>
        <div className="dp-table-scroll">
          <table className="data-table">
            <caption className="sr-only">{t("trends.table.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("dispersion.table.date")}</th>
                <th scope="col">{t("dispersion.table.airportRunway")}</th>
                <th scope="col">{t("dispersion.table.aircraft")}</th>
                <th scope="col" className="num-col">
                  {t("dispersion.table.landingRate")}
                </th>
                <th scope="col" className="num-col">
                  {t("dispersion.table.touchdownPoint")}
                </th>
                <th scope="col" className="num-col">
                  {t("dispersion.table.centreline")}
                </th>
                <th scope="col">{t("dispersion.table.tdz")}</th>
                <th scope="col" className="num-col">
                  {t("trends.table.stableFrom")}
                </th>
                <th scope="col" className="num-col">
                  {t("trends.table.rotation")}
                </th>
                <th scope="col" className="num-col">
                  {t("trends.table.gearDown")}
                </th>
                <th scope="col" className="num-col" title={t("trends.chart.exceedances.title")}>
                  {t("trends.table.exceedances")}
                </th>
                <th scope="col">
                  <span className="sr-only">{t("dispersion.table.action")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {facts.map((f) => {
                const a = approachFor(approaches, f.flightId, f.touchdownIndex);
                const m = metricsFor(metrics, f.flightId);
                return (
                  <tr key={`${f.flightId}#${f.touchdownIndex}`}>
                    <td className="num">{fmtDate(f.timestampMs)}</td>
                    <td className="num">
                      {f.airportIcao} {f.runwayIdent}
                    </td>
                    <td>{typeKey(f)}</td>
                    <td className="num num-col">{fmt(f.landingRateFpm, 0, "fpm")}</td>
                    <td className="num num-col">{fmt(f.touchdownDistanceM, 0, "m")}</td>
                    <td className="num num-col">{f.centerlineOffsetM != null ? fmt(Math.abs(f.centerlineOffsetM), 0, "m") : DASH}</td>
                    <td>{f.inTouchdownZone ? t("dispersion.table.yes") : t("dispersion.table.no")}</td>
                    <td className="num num-col">{a?.stableFromFt != null ? fmt(a.stableFromFt, 0, "ft") : a?.band ? t("trends.table.neverStable") : DASH}</td>
                    <td className="num num-col">{fmtDegS(m?.rotationRateDegS)}</td>
                    <td className="num num-col">{fmt(m?.gearDownAglFt, 0, "ft")}</td>
                    <td className="num num-col">{fmt(m?.exceedances, 0)}</td>
                    <td>
                      <button className="btn-sm" onClick={() => openDebrief(f.flightId, f.touchdownIndex)}>
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
    );
  }
  const byKey = (pts: TrendPoint[]) => new Map(pts.map((p) => [p.key, p]));
  const dist = byKey(series.distance);
  const cl = byKey(series.centerline);
  const stab = byKey(series.stableFrom);
  const tdz = byKey(series.tdz);
  const lat = byKey(series.lateral);
  const rot = byKey(series.rotation);
  const gear = byKey(series.gearDown);
  const exc = byKey(series.exceedances);
  const keys = [...new Set([...series.rate, ...series.stableFrom, ...series.lateral, ...series.rotation, ...series.gearDown, ...series.exceedances].map((p) => p.key))]
    .sort()
    .reverse();
  const rate = byKey(series.rate);
  return (
    <details className="dp-table">
      <summary>{t("dispersion.table.asTable", { count: keys.length })}</summary>
      <div className="dp-table-scroll">
        <table className="data-table">
          <caption className="sr-only">{t("trends.table.captionBucket", { bucket: bucketLabel(t, bucket) })}</caption>
          <thead>
            <tr>
              <th scope="col">{t("trends.table.period")}</th>
              <th scope="col" className="num-col">
                {t("trends.table.landings")}
              </th>
              <th scope="col" className="num-col">
                {t("dispersion.table.landingRate")}
              </th>
              <th scope="col" className="num-col">
                {t("dispersion.table.touchdownPoint")}
              </th>
              <th scope="col" className="num-col">
                {t("dispersion.table.centreline")}
              </th>
              <th scope="col" className="num-col">
                {t("dispersion.table.tdz")}
              </th>
              <th scope="col" className="num-col">
                {t("trends.table.stableFrom")}
              </th>
              <th scope="col" className="num-col" title={t("trends.chart.lateral.hint")}>
                {t("trends.table.lateral")}
              </th>
              <th scope="col" className="num-col">
                {t("trends.table.rotation")}
              </th>
              <th scope="col" className="num-col">
                {t("trends.table.gearDown")}
              </th>
              <th scope="col" className="num-col" title={t("trends.chart.exceedances.title")}>
                {t("trends.table.exceedances")}
              </th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const p = rate.get(k) ?? stab.get(k) ?? lat.get(k) ?? rot.get(k) ?? gear.get(k) ?? exc.get(k)!;
              const tz = tdz.get(k)?.value;
              return (
                <tr key={k}>
                  <td className="num">{pointLabel(t, p, bucket)}</td>
                  <td className="num num-col">{rate.get(k)?.n ?? 0}</td>
                  <td className="num num-col">{fmt(rate.get(k)?.value, 0, "fpm")}</td>
                  <td className="num num-col">{fmt(dist.get(k)?.value, 0, "m")}</td>
                  <td className="num num-col">{fmt(cl.get(k)?.value, 0, "m")}</td>
                  <td className="num num-col">{tz != null ? `${fmtNum(tz * 100, 0)}${NNBSP}%` : DASH}</td>
                  <td className="num num-col">{fmt(stab.get(k)?.value, 0, "ft")}</td>
                  <td className="num num-col">{fmt(lat.get(k)?.value, 2, t("trends.unitDots"))}</td>
                  <td className="num num-col">{fmtDegS(rot.get(k)?.value)}</td>
                  <td className="num num-col">{fmt(gear.get(k)?.value, 0, "ft")}</td>
                  <td className="num num-col">{fmt(exc.get(k)?.value, 1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
