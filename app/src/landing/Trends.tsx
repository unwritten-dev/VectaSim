import { useMemo, useState } from "react";
import { DASH, NNBSP, fmt, fmtDate, fmtNum, fmtSigned } from "../format";
import { usePrefs } from "../prefs";
import EmptyState from "../ui/EmptyState";
import ErrorNotice from "../ErrorNotice";
import { openDebrief } from "./debriefStore";
import { linear } from "./dispersionStats";
import { ticks, useWidth } from "./chartUtils";
import { useHistoryFacts } from "./HistoryPanel";
import { approachFor, demoFilter, monthCompare, trendSeries, typeKey, type Bucket, type HistLanding, type PeriodStats, type TrendPoint } from "./history";
import type { ApproachFact } from "./approachTypes";
import "./dispersion.css";
import "./trends.css";

const LIMITS = [20, 50, 200] as const;
type Limit = (typeof LIMITS)[number];

const BUCKET_LABEL: Record<Bucket, string> = {
  flight: "je Landung",
  week: "je Woche",
  month: "je Monat",
};
const BUCKETS: Bucket[] = ["flight", "week", "month"];

const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

/** "Okt 2026", "KW 42", or the landing's date. */
function pointLabel(p: TrendPoint, bucket: Bucket): string {
  if (bucket === "month") {
    const [y, m] = p.key.split("-");
    return `${MONTHS[Number(m) - 1]} ${y}`;
  }
  if (bucket === "week") return `KW ${p.key.slice(6)} ${p.key.slice(0, 4)}`;
  return fmtDate(p.tMs);
}

function options(xs: string[]): Array<{ key: string; count: number }> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

interface ChartDef {
  id: "rate" | "distance" | "stableFrom" | "lateral" | "tdz";
  title: string;
  unit: string;
  /** Value → display number (TDZ 0..1 → %). */
  scale: (v: number) => number;
  /** Fixed lower / upper bound of the y axis. */
  floor: number;
  ceil?: number;
  /** Reference lines (band limits). */
  refs?: number[];
  note: string;
  /** Decimals of values / axis labels (default 0). */
  digits?: number;
}

const CHARTS: ChartDef[] = [
  { id: "rate", title: "Landerate", unit: "fpm", scale: (v) => v, floor: 0, refs: [150, 300, 600], note: "Betrag, kleiner ist weicher" },
  { id: "distance", title: "Aufsetzdistanz", unit: "m", scale: (v) => v, floor: 0, note: "hinter der Schwelle" },
  { id: "stableFrom", title: "Stabil ab", unit: "ft", scale: (v) => v, floor: 0, refs: [500, 1000], note: "aus der Anflugbewertung; nie stabil zählt nicht" },
  { id: "lateral", title: "Grundlinie (RMS)", unit: "Dots", scale: (v) => v, floor: 0, refs: [0.3, 0.6], digits: 2, note: "Lokalizer-RMS 1000 → 50 ft, nur mit bekannter Mittellinie" },
  { id: "tdz", title: "Aufsetzzone", unit: "%", scale: (v) => v * 100, floor: 0, ceil: 100, note: "Anteil in der Aufsetzzone" },
];

const CH_H = 120;
const PAD_L = 44;
const PAD_R = 10;
const PAD_T = 10;
const PAD_B = 20;

function TrendChart({ def, points, bucket, width }: { def: ChartDef; points: TrendPoint[]; bucket: Bucket; width: number }) {
  const vals = points.filter((p) => p.value != null);
  const last = [...points].reverse().find((p) => p.rolling != null);
  const first = points.find((p) => p.rolling != null);
  const fmtV = (v: number | null | undefined) => (v == null ? DASH : fmt(def.scale(v), def.digits ?? 0, def.unit));
  const label = `${def.title} ${BUCKET_LABEL[bucket]}: ${vals.length} Werte${first && last && first !== last ? `, gleitender Median von ${fmtV(first.rolling)} auf ${fmtV(last.rolling)}` : last ? `, ${fmtV(last.rolling)}` : ""} – Werte in der Tabelle unten`;
  if (vals.length === 0) {
    return (
      <figure className="tr-chart">
        <figcaption className="tr-chart-head">
          <span className="tr-chart-title">{def.title}</span>
          <span className="detail">keine Werte</span>
        </figcaption>
      </figure>
    );
  }
  const ys = points.flatMap((p) => [p.value, p.rolling, p.q1, p.q3]).filter((v): v is number => v != null).map(def.scale);
  const maxRaw = Math.max(...ys, ...(def.refs ?? []).filter((r) => r <= Math.max(...ys) * 1.4));
  const yMax = def.ceil ?? Math.max(maxRaw * 1.08, 1);
  const yMin = def.floor;
  const n = points.length;
  const X = linear(0, Math.max(n - 1, 1), PAD_L + (n === 1 ? (width - PAD_L - PAD_R) / 2 : 0), width - PAD_R);
  const Y = linear(yMin, yMax, CH_H - PAD_B, PAD_T);
  const yTicks = ticks(yMin, yMax, 3);
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
  return (
    <figure className="tr-chart">
      <figcaption className="tr-chart-head">
        <span className="tr-chart-title">{def.title}</span>
        <span className="tr-chart-now num">{last ? fmtV(last.rolling) : DASH}</span>
        <span className="detail">{def.note}</span>
      </figcaption>
      <svg viewBox={`0 0 ${width} ${CH_H}`} width="100%" height={CH_H} role="img" aria-label={label}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={width - PAD_R} y1={Y(t)} y2={Y(t)} className="tr-grid" />
            <text x={PAD_L - 6} y={Y(t) + 4} textAnchor="end" className="tr-label">
              {fmtNum(t, def.digits ? 1 : 0)}
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
              <title>{`${pointLabel(p, bucket)}: ${fmtV(p.value)}${bucket !== "flight" ? ` (n = ${p.n})` : ""}`}</title>
            </circle>
          ) : null,
        )}
        {vals.length > 1 && <path d={path((p) => p.rolling)} className="tr-line" />}
        {n > 0 && (
          <>
            <text x={X(0)} y={CH_H - 4} textAnchor={n === 1 ? "middle" : "start"} className="tr-label">
              {pointLabel(points[0], bucket)}
            </text>
            {n > 1 && (
              <text x={X(n - 1)} y={CH_H - 4} textAnchor="end" className="tr-label">
                {pointLabel(points[n - 1], bucket)}
              </text>
            )}
          </>
        )}
      </svg>
    </figure>
  );
}

interface MonthTileDef {
  label: string;
  get: (s: PeriodStats) => number | null;
  unit: string;
  scale: number;
  /** Which direction is the improvement, for the wording of Δ. */
  lowerBetter: boolean | null;
}

const MONTH_TILES: MonthTileDef[] = [
  { label: "Landerate (Median, Betrag)", get: (s) => s.rate, unit: "fpm", scale: 1, lowerBetter: true },
  { label: "Aufsetzdistanz (Median)", get: (s) => s.distance, unit: "m", scale: 1, lowerBetter: null },
  { label: "Stabil ab (Median)", get: (s) => s.stableFrom, unit: "ft", scale: 1, lowerBetter: false },
  { label: "Aufsetzzone", get: (s) => s.tdzRate, unit: "%", scale: 100, lowerBetter: false },
];

function MonthTiles({ m }: { m: ReturnType<typeof monthCompare> }) {
  const monthName = (key: string) => {
    const [y, mm] = key.split("-");
    return `${MONTHS[Number(mm) - 1]} ${y}`;
  };
  return (
    <div className="tr-month" role="group" aria-label={`Dieser Monat (${monthName(m.current.key)}) gegen den Vormonat (${monthName(m.previous.key)})`}>
      <div className="tr-month-head detail">
        Dieser Monat vs. Vormonat · {m.current.n} gegen {m.previous.n} Landung{m.previous.n === 1 ? "" : "en"}
      </div>
      <div className="tr-month-tiles">
        {MONTH_TILES.map((t) => {
          const cur = t.get(m.current);
          const prev = t.get(m.previous);
          const d = cur != null && prev != null ? (cur - prev) * t.scale : null;
          const word = d == null || Math.round(d) === 0 || t.lowerBetter == null ? null : d < 0 === t.lowerBetter ? "besser" : "schwächer";
          return (
            <div key={t.label} className="hist-tile">
              <div className="tile-label">{t.label}</div>
              <div className="hist-tile-value num">{cur != null ? fmt(cur * t.scale, 0, t.unit) : DASH}</div>
              <div className="detail num">
                Vormonat {prev != null ? fmt(prev * t.scale, 0, t.unit) : DASH}
                {d != null && (
                  <>
                    {" "}
                    · Δ {fmtSigned(d, 0, t.unit === "%" ? "Pp." : t.unit)}
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
 * Logbook → Landungen → "Verlauf": landing rate, touchdown distance, "stabil ab" and the TDZ
 * quota over time (per landing, week or month) with a moving median, filters type / airport /
 * period, this month vs the previous one, and the values as a table.
 */
export default function Trends() {
  const { showDemo } = usePrefs();
  const { landings, approaches, error } = useHistoryFacts();
  const [type, setType] = useState<string | null>(null);
  const [airport, setAirport] = useState<string | null>(null);
  const [limit, setLimit] = useState<Limit>(50);
  const [bucket, setBucket] = useState<Bucket>("flight");
  const [setWrap, width] = useWidth(720);

  const allL = useMemo(() => demoFilter(landings ?? [], null, showDemo), [landings, showDemo]);
  const allA = useMemo(() => demoFilter(approaches ?? [], null, showDemo), [approaches, showDemo]);
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
  const facts = useMemo(() => filteredL.slice(0, limit), [filteredL, limit]);
  // approaches of the same period as the landings shown
  const aFacts = useMemo(() => {
    const oldest = facts.length ? facts[facts.length - 1].timestampMs : Infinity;
    return filteredA.filter((a) => a.endedMs >= oldest - 3_600_000).slice(0, limit);
  }, [filteredA, facts, limit]);
  const win = limit === 20 ? 5 : 10;
  const series = useMemo(() => trendSeries(facts, bucket, { approaches: aFacts, window: bucket === "flight" ? win : 3 }), [facts, aFacts, bucket, win]);
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
        <div className="detail">Verlauf wird berechnet …</div>
      </section>
    );
  }
  if (allL.length === 0) {
    return (
      <section className="tr">
        <EmptyState
          title="Noch kein Verlauf"
          text={
            landings.length > 0
              ? `Bisher nur Demo-Landungen (${landings.length}) – sie zählen hier nicht mit (Einstellungen → Anzeige → Demo-Flüge einbeziehen).`
              : "Sobald du Flüge mit Landung auf einer bekannten Piste abschließt, zeigt der Verlauf, wie sich Landerate, Aufsetzpunkt und Anflug entwickeln."
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

  return (
    <section className="tr" aria-label="Verlauf deiner Landungen">
      <div className="chips tr-chips" role="group" aria-label="Filter">
        {chip("all", !activeType && !activeAirport, "Alle", () => {
          setType(null);
          setAirport(null);
        })}
        {typeOpts.length > 1 && <span className="chip-sep" aria-hidden="true" />}
        {typeOpts.length > 1 && typeOpts.map((o) => chip(`t-${o.key}`, activeType === o.key, o.key, () => setType(activeType === o.key ? null : o.key), `Nur ${o.key} (${o.count})`))}
        {airportOpts.length > 1 && <span className="chip-sep" aria-hidden="true" />}
        {airportOpts.length > 1 &&
          airportOpts.map((o) => chip(`a-${o.key}`, activeAirport === o.key, o.key, () => setAirport(activeAirport === o.key ? null : o.key), `Nur ${o.key} (${o.count})`))}
      </div>
      <div className="tr-toolbar">
        <div className="chips" role="group" aria-label="Zeitraum">
          {LIMITS.map((n) => chip(`l${n}`, limit === n, `letzte ${n}`, () => setLimit(n)))}
        </div>
        <div className="chips" role="group" aria-label="Zusammenfassen">
          {BUCKETS.map((b) => chip(b, bucket === b, BUCKET_LABEL[b], () => setBucket(b)))}
        </div>
      </div>

      <MonthTiles m={month} />

      {facts.length === 0 ? (
        <div className="detail">Für diesen Filter gibt es keine Landungen.</div>
      ) : (
        <>
          <div ref={setWrap} className="tr-charts">
            {CHARTS.map((def) => (
              <TrendChart key={def.id} def={def} points={series[def.id]} bucket={bucket} width={Math.max(320, Math.floor(width / (width >= 760 ? 2 : 1)) - 8)} />
            ))}
          </div>
          <div className="dp-legend tr-legend">
            <span>
              <i className="tr-swatch dot" aria-hidden="true" />
              {bucket === "flight" ? "einzelne Landung" : `Median ${BUCKET_LABEL[bucket]}`}
            </span>
            <span>
              <i className="tr-swatch line" aria-hidden="true" />
              gleitender Median ({bucket === "flight" ? win : 3} {bucket === "flight" ? "Landungen" : "Zeiträume"})
            </span>
            {bucket !== "flight" && (
              <span>
                <i className="tr-swatch iqr" aria-hidden="true" />
                mittlere Hälfte (Quartile)
              </span>
            )}
            <span className="dp-note">
              {facts.length} Landung{facts.length === 1 ? "" : "en"} · {aFacts.filter((a) => a.band != null).length} bewertete Anflüge · Zeiten in UTC
            </span>
          </div>
          <TrendTable facts={facts} approaches={aFacts} bucket={bucket} series={series} />
        </>
      )}
    </section>
  );
}

function TrendTable({ facts, approaches, bucket, series }: { facts: HistLanding[]; approaches: ApproachFact[]; bucket: Bucket; series: ReturnType<typeof trendSeries> }) {
  if (bucket === "flight") {
    return (
      <details className="dp-table">
        <summary>Als Tabelle ({facts.length})</summary>
        <div className="dp-table-scroll">
          <table className="data-table">
            <caption className="sr-only">Verlauf der Landungen, neueste zuerst</caption>
            <thead>
              <tr>
                <th scope="col">Datum</th>
                <th scope="col">Platz · Piste</th>
                <th scope="col">Flugzeug</th>
                <th scope="col" className="num-col">
                  Landerate
                </th>
                <th scope="col" className="num-col">
                  Aufsetzpunkt
                </th>
                <th scope="col" className="num-col">
                  Mittellinie
                </th>
                <th scope="col">Aufsetzzone</th>
                <th scope="col" className="num-col">
                  Stabil ab
                </th>
                <th scope="col">
                  <span className="sr-only">Aktion</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {facts.map((f) => {
                const a = approachFor(approaches, f.flightId, f.touchdownIndex);
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
                    <td>{f.inTouchdownZone ? "ja" : "nein"}</td>
                    <td className="num num-col">{a?.stableFromFt != null ? fmt(a.stableFromFt, 0, "ft") : a?.band ? "nie stabil" : DASH}</td>
                    <td>
                      <button className="btn-sm" onClick={() => openDebrief(f.flightId, f.touchdownIndex)}>
                        Auswertung
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
  const keys = [...new Set([...series.rate.map((p) => p.key), ...series.stableFrom.map((p) => p.key), ...series.lateral.map((p) => p.key)])].sort().reverse();
  const rate = byKey(series.rate);
  return (
    <details className="dp-table">
      <summary>Als Tabelle ({keys.length})</summary>
      <div className="dp-table-scroll">
        <table className="data-table">
          <caption className="sr-only">Verlauf {BUCKET_LABEL[bucket]}, Mediane, neueste zuerst</caption>
          <thead>
            <tr>
              <th scope="col">Zeitraum</th>
              <th scope="col" className="num-col">
                Landungen
              </th>
              <th scope="col" className="num-col">
                Landerate
              </th>
              <th scope="col" className="num-col">
                Aufsetzpunkt
              </th>
              <th scope="col" className="num-col">
                Mittellinie
              </th>
              <th scope="col" className="num-col">
                Aufsetzzone
              </th>
              <th scope="col" className="num-col">
                Stabil ab
              </th>
              <th scope="col" className="num-col">
                Grundlinie
              </th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const p = rate.get(k) ?? stab.get(k) ?? lat.get(k)!;
              const t = tdz.get(k)?.value;
              return (
                <tr key={k}>
                  <td className="num">{pointLabel(p, bucket)}</td>
                  <td className="num num-col">{rate.get(k)?.n ?? 0}</td>
                  <td className="num num-col">{fmt(rate.get(k)?.value, 0, "fpm")}</td>
                  <td className="num num-col">{fmt(dist.get(k)?.value, 0, "m")}</td>
                  <td className="num num-col">{fmt(cl.get(k)?.value, 0, "m")}</td>
                  <td className="num num-col">{t != null ? `${fmtNum(t * 100, 0)}${NNBSP}%` : DASH}</td>
                  <td className="num num-col">{fmt(stab.get(k)?.value, 0, "ft")}</td>
                  <td className="num num-col">{fmt(lat.get(k)?.value, 2, "Dots")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
