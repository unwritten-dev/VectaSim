import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { NNBSP, fmt, fmtDate, fmtNum, fmtSigned } from "../i18n/number";
import { useT, type TFunction } from "../i18n";
import { usePrefs } from "../prefs";
import ErrorNotice from "../ErrorNotice";
import EmptyState from "../ui/EmptyState";
import { openDebrief } from "./debriefStore";
import { usePointNav } from "./pointNav";
import { sideLabel } from "./geometry";
import type { ApproachFact, ApproachFactsResult } from "./approachTypes";
import { clamp, ellipsePoints, linear, sigmaEllipse } from "./dispersionStats";
import {
  APPROACH_BANDS,
  APPROACH_BAND_LABEL,
  GATE_LABEL,
  GATE_TOLERANCE,
  SCATTER_GATES,
  applyApproachFilter,
  approachAircraftKey,
  approachFilterOptions,
  approachKey,
  approachSummary,
  bandVar,
  gateHits,
  gatePoint,
  isGoAround,
  derivedLateralCount,
  lateralAt,
  niceHalfRange,
  shapeOf,
  type ApproachFilter,
  type ScatterGate,
} from "./approachStats";
import { BandSwatch, ShapeMark } from "./BandMark";
import { approachBandLabel, type BandShape } from "./facts";
import "./dispersion.css";
import "./approachDispersion.css";

/** Lateral strip: normalised ±60 m around the extended centreline. */
const LAT_HALF_M = 60;
const PAD_L = 52;
const PAD_R = 14;
const PANEL_GAP = 12;
const P_PAD_L = 36;
const P_PAD_R = 6;
const P_TOP = 8;
const P_PLOT_H = 124;
const P_BOTTOM = 18;
const LAT_ROW_H = 30;
const LAT_TOP = 6;
const SPARK_H = 72;

function outcomeText(t: TFunction, f: ApproachFact): string {
  if (isGoAround(f) && f.gaLowestHatFt != null) return t("approach.dispersion.goAroundAt", { height: fmt(f.gaLowestHatFt, 0, "ft") });
  switch (f.outcome) {
    case "landed":
      return t("approach.dispersion.outcomeLanded");
    case "touch_and_go":
      return t("approach.dispersion.outcomeTouchAndGo");
    case "go_around":
      return t("approach.dispersion.outcomeGoAround");
  }
}

function stableText(t: TFunction, f: ApproachFact): string | null {
  if (f.stableFromFt != null) return t("approach.dispersion.stableFrom", { height: fmt(f.stableFromFt, 0, "ft") });
  return f.band ? t("approach.dispersion.neverStable") : null;
}

const placeOf = (t: TFunction, f: ApproachFact) => [f.airportIcao, f.runwayIdent].filter(Boolean).join(" ") || t("approach.dispersion.noRunway");

function factLine(t: TFunction, f: ApproachFact): string {
  const ac = [approachAircraftKey(f), f.registration].filter(Boolean).join(" ");
  return [placeOf(t, f), ac, fmtDate(f.endedMs), outcomeText(t, f), f.band ? approachBandLabel(f.band, f.hardGateFt) : null, stableText(t, f)].filter(Boolean).join(" · ");
}

/**
 * Band shape (stabil ● · Abweichungen ◆ · instabil ▲) in the band colour; a go-around
 * adds a short stem upwards ("went up again"), so outcome and band never share a channel.
 */
function Mark({ x, y, r, ga, shape, fill, stroke }: { x: number; y: number; r: number; ga: boolean; shape: BandShape; fill: string; stroke?: string }) {
  return (
    <>
      {ga && <line x1={x} x2={x} y1={y - r * 1.3} y2={y - r * 3.1} className="ad-ga-stem" style={{ stroke: stroke ?? fill }} />}
      <ShapeMark shape={shape} x={x} y={y} r={r} style={{ fill, stroke }} className="dp-dot" />
    </>
  );
}

/**
 * "Anflüge": how the last approaches passed their gates – four small scatter panels
 * (10 NM, FAF, 1000 ft, 500 ft; x = IAS − Vapp, y = height vs the path) on one common
 * scale, so the eye sees whether the dispersion closes in towards the runway; the lateral
 * offset at 1000/500 ft; a "stabil ab" sparkline and four key numbers. A click opens the
 * flight's debrief.
 */
export default function ApproachDispersion({ limit = 20 }: { limit?: number }) {
  const t = useT();
  const { showDemo } = usePrefs();
  const [data, setData] = useState<ApproachFactsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ApproachFilter>({ aircraft: null, airport: null });
  const [hover, setHover] = useState<string | null>(null);
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(720);

  const fetchLimit = Math.min(200, Math.max(limit, limit * 5));
  const refresh = useCallback(async () => {
    try {
      const r = await invoke<ApproachFactsResult>("approach_facts_recent", { limit: fetchLimit, includeDemo: showDemo });
      setData(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [fetchLimit, showDemo]);

  useEffect(() => {
    refresh();
    const un = listen("logbook:changed", refresh);
    const unApproach = listen("approach:facts", refresh);
    return () => {
      un.then((u) => u());
      unApproach.then((u) => u());
    };
  }, [refresh]);

  useEffect(() => {
    if (!wrap) return;
    const measure = () => setWidth(Math.max(300, Math.floor(wrap.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [wrap]);

  const all = useMemo(() => data?.facts ?? [], [data]);
  const aircraftOpts = useMemo(() => approachFilterOptions(all, approachAircraftKey), [all]);
  const airportOpts = useMemo(() => approachFilterOptions(all, (f) => f.airportIcao), [all]);
  const active = useMemo<ApproachFilter>(
    () => ({
      aircraft: filter.aircraft && aircraftOpts.some((o) => o.key === filter.aircraft) ? filter.aircraft : null,
      airport: filter.airport && airportOpts.some((o) => o.key === filter.airport) ? filter.airport : null,
    }),
    [filter, aircraftOpts, airportOpts],
  );
  const facts = useMemo(() => applyApproachFilter(all, active, limit), [all, active, limit]);
  const summary = useMemo(() => approachSummary(facts), [facts]);
  const nav = usePointNav(facts.length);

  const newest = facts[0] ?? null;
  const hovered = facts.find((f) => approachKey(f) === hover) ?? null;
  const open = (f: ApproachFact) => openDebrief(f.flightId, null, f.approachIndex);
  const hoverProps = (f: ApproachFact) => {
    const k = approachKey(f);
    return {
      onClick: () => open(f),
      onMouseEnter: () => setHover(k),
      onMouseLeave: () => setHover((h) => (h === k ? null : h)),
    };
  };

  if (error && !data) {
    return (
      <section className="dp ad">
        <ErrorNotice error={error} context="logbook" onRetry={refresh} />
      </section>
    );
  }
  if (!data) {
    return (
      <section className="dp ad">
        <div className="detail">{t("approach.dispersion.loading")}</div>
      </section>
    );
  }
  if (all.length === 0) {
    return (
      <section className="dp ad">
        <EmptyState
          title={t("approach.dispersion.emptyTitle")}
          text={
            <>
              {t("approach.dispersion.emptyText")}
              {data.skipped > 0 && ` ${t("approach.dispersion.skipped", { count: data.skipped })}`}
            </>
          }
        />
      </section>
    );
  }

  // chronological (oldest first): the newest is drawn on top
  const chrono = [...facts].reverse();

  // ---- gate panels: one common scale for all four ----
  const cols = width >= 640 ? 4 : 2;
  const pw = Math.floor((width - (cols - 1) * PANEL_GAP) / cols);
  const ph = P_TOP + P_PLOT_H + P_BOTTOM;
  const allPts = SCATTER_GATES.flatMap((g) => facts.map((f) => gatePoint(f, g)).filter((p) => p != null));
  const xHalf = niceHalfRange(
    allPts.map((p) => p.iasDevKt),
    25,
    5,
    60,
  );
  const yHalf = niceHalfRange(
    allPts.map((p) => p.altDevFt),
    150,
    50,
    1000,
  );

  const panel = (gate: ScatterGate) => {
    const PX = linear(-xHalf, xHalf, P_PAD_L, pw - P_PAD_R);
    const PY = linear(-yHalf, yHalf, P_TOP + P_PLOT_H, P_TOP);
    const tol = GATE_TOLERANCE[gate];
    const tx0 = PX(clamp(tol.iasLoKt ?? -xHalf, -xHalf, xHalf));
    const tx1 = PX(clamp(tol.iasHiKt ?? xHalf, -xHalf, xHalf));
    const ty0 = PY(clamp(tol.altHiFt, -yHalf, yHalf));
    const ty1 = PY(clamp(tol.altLoFt, -yHalf, yHalf));
    const pts = chrono.map((f) => ({ f, p: gatePoint(f, gate) })).filter((x) => x.p != null);
    const ell = pts.length >= 3 ? sigmaEllipse(pts.map(({ p }) => ({ x: p!.iasDevKt, y: p!.altDevFt }))) : null;
    const ellPath = ell ? ellipsePoints(ell, 48).map((q, i) => `${i ? "L" : "M"}${PX(q.x).toFixed(1)},${PY(q.y).toFixed(1)}`).join(" ") + " Z" : null;
    const hits = gateHits(facts, gate);
    const clipId = `ad-clip-${gate}`;
    const tolAlt = `${fmtSigned(tol.altLoFt, 0)}/${fmtSigned(tol.altHiFt, 0, "ft")}`;
    const tolText =
      tol.iasLoKt != null
        ? t("approach.dispersion.toleranceIas", { alt: tolAlt, ias: `${fmtSigned(tol.iasLoKt, 0)}/${fmtSigned(tol.iasHiKt, 0, "kt")}` })
        : t("approach.dispersion.tolerance", { alt: tolAlt });
    return (
      <figure key={gate} className="ad-panel">
        <figcaption className="ad-panel-head">
          <strong>{GATE_LABEL[gate]}</strong>
          <span className="detail num" title={tolText}>
            {hits.total ? t("approach.dispersion.inBox", { inside: hits.inside, total: hits.total }) : t("approach.dispersion.noValues")}
          </span>
        </figcaption>
        <svg viewBox={`0 0 ${pw} ${ph}`} width={pw} height={ph} role="img" aria-label={t("approach.dispersion.panelAria", { gate: GATE_LABEL[gate], inside: hits.inside, total: hits.total, tolerance: tolText })}>
          <defs>
            <clipPath id={clipId}>
              <rect x={P_PAD_L} y={P_TOP} width={pw - P_PAD_L - P_PAD_R} height={P_PLOT_H} />
            </clipPath>
          </defs>
          <rect x={P_PAD_L} y={P_TOP} width={pw - P_PAD_L - P_PAD_R} height={P_PLOT_H} className="ad-plot" />
          <rect x={tx0} y={ty0} width={Math.max(0, tx1 - tx0)} height={Math.max(0, ty1 - ty0)} className="ad-tol" />
          <line x1={P_PAD_L} x2={pw - P_PAD_R} y1={PY(0)} y2={PY(0)} className="ad-zero" />
          <line x1={PX(0)} x2={PX(0)} y1={P_TOP} y2={P_TOP + P_PLOT_H} className="ad-zero" />
          {[yHalf, 0, -yHalf].map((v) => (
            <text key={v} x={P_PAD_L - 4} y={PY(v) + (v === yHalf ? 8 : v === -yHalf ? 0 : 3.5)} textAnchor="end" className="dp-label">
              {v === 0 ? "0" : fmtSigned(v, 0)}
            </text>
          ))}
          {[-xHalf, 0, xHalf].map((v) => (
            <text key={v} x={PX(v)} y={P_TOP + P_PLOT_H + 13} textAnchor={v < 0 ? "start" : v > 0 ? "end" : "middle"} className="dp-label">
              {v === 0 ? "0 kt" : fmtSigned(v, 0)}
            </text>
          ))}
          <g clipPath={`url(#${clipId})`}>
            {ellPath && <path d={ellPath} className="dp-ellipse" />}
            {ell && (
              <g className="dp-mean" transform={`translate(${PX(ell.cx)},${PY(ell.cy)})`}>
                <line x1={-5} x2={5} y1={0} y2={0} />
                <line x1={0} x2={0} y1={-5} y2={5} />
              </g>
            )}
          </g>
          {pts.map(({ f, p }) => {
            const k = approachKey(f);
            const out = Math.abs(p!.iasDevKt) > xHalf || Math.abs(p!.altDevFt) > yHalf;
            const x = PX(clamp(p!.iasDevKt, -xHalf, xHalf));
            const y = PY(clamp(p!.altDevFt, -yHalf, yHalf));
            const isNewest = f === newest;
            const isHover = k === hover;
            const color = bandVar(f.band);
            return (
              <g key={k} className={`dp-pt${isNewest ? " newest" : ""}${isHover ? " hover" : ""}${out ? " out" : ""}`} {...hoverProps(f)}>
                <title>{t("approach.dispersion.pointTitle", { gate: GATE_LABEL[gate], alt: fmtSigned(p!.altDevFt, 0, "ft"), ias: fmtSigned(p!.iasDevKt, 0, "kt"), fact: factLine(t, f) })}</title>
                {(isNewest || isHover) && <circle cx={x} cy={y} r={isNewest ? 8.5 : 7.5} className="dp-ring" />}
                <Mark x={x} y={y} r={isNewest ? 4.5 : 3.6} ga={isGoAround(f)} shape={shapeOf(f.band)} fill={out ? "none" : color} stroke={out ? color : undefined} />
              </g>
            );
          })}
        </svg>
      </figure>
    );
  };

  // ---- lateral strip ----
  const noLateral = derivedLateralCount(facts);
  const W = width;
  const LX = linear(-LAT_HALF_M, LAT_HALF_M, PAD_L, W - PAD_R);
  const latRows: Array<{ gate: "ft1000" | "ft500"; label: string }> = [
    { gate: "ft1000", label: "1000 ft" },
    { gate: "ft500", label: "500 ft" },
  ];
  const latH = LAT_TOP + latRows.length * LAT_ROW_H + 22;

  // ---- sparkline "stabil ab" ----
  const maxStable = Math.max(1500, ...chrono.map((f) => f.stableFromFt ?? 0));
  const SX = linear(0, Math.max(chrono.length - 1, 1), PAD_L, W - PAD_R);
  const SY = linear(0, maxStable, SPARK_H - 10, 8);
  let sparkPath = "";
  let pen = false;
  chrono.forEach((f, i) => {
    if (f.stableFromFt == null) {
      pen = false;
      return;
    }
    sparkPath += `${pen ? "L" : "M"}${SX(i).toFixed(1)},${SY(f.stableFromFt).toFixed(1)} `;
    pen = true;
  });

  const sumText = t("approach.dispersion.summary", {
    stable: fmt(summary.meanStableFromFt, 0, "ft"),
    g1000: `${summary.gate1000.passed}/${summary.gate1000.total}`,
    g500: `${summary.gate500.passed}/${summary.gate500.total}`,
    lat: fmt(summary.meanAbsLat500M, 0, "m"),
    goArounds: summary.goArounds,
  });

  const chip = (key: string, label: ReactNode, pressed: boolean, onClick: () => void, title?: string) => (
    <button key={key} className={`chip${pressed ? " active" : ""}`} aria-pressed={pressed} title={title} onClick={onClick}>
      {label}
    </button>
  );

  return (
    <section className="dp ad" aria-label={t("approach.dispersion.sectionAria")}>
      {error && <ErrorNotice error={error} context="logbook" onRetry={refresh} compact />}
      {(aircraftOpts.length > 1 || airportOpts.length > 1) && (
        <div className="chips dp-chips" role="group" aria-label={t("approach.dispersion.filterAria")}>
          {chip("all", t("approach.dispersion.all"), !active.aircraft && !active.airport, () => setFilter({ aircraft: null, airport: null }))}
          {aircraftOpts.length > 1 && <span className="chip-sep" aria-hidden="true" />}
          {aircraftOpts.length > 1 &&
            aircraftOpts.map((o) =>
              chip(`ac-${o.key}`, o.key, active.aircraft === o.key, () => setFilter((f) => ({ ...f, aircraft: f.aircraft === o.key ? null : o.key })), t("approach.dispersion.only", { key: o.key, count: o.count })),
            )}
          {airportOpts.length > 1 && <span className="chip-sep" aria-hidden="true" />}
          {airportOpts.length > 1 &&
            airportOpts.map((o) =>
              chip(`ap-${o.key}`, o.key, active.airport === o.key, () => setFilter((f) => ({ ...f, airport: f.airport === o.key ? null : o.key })), t("approach.dispersion.only", { key: o.key, count: o.count })),
            )}
        </div>
      )}

      <div className="dp-body">
        <div ref={setWrap} className="dp-chart ad-chart">
          <div className="ad-axes detail">
            <span>{t("approach.dispersion.axisHeight")}</span>
            <span>{t("approach.dispersion.axisSpeed")}</span>
          </div>
          <div className="ad-panels" style={{ gridTemplateColumns: `repeat(${cols}, ${pw}px)`, columnGap: PANEL_GAP }}>
            {SCATTER_GATES.map(panel)}
          </div>

          <div className="ad-section-label detail">
            {t("approach.dispersion.lateralLabel")}
            {noLateral > 0 && ` · ${t("approach.dispersion.lateralMissing", { count: noLateral })}`}
          </div>
          <svg viewBox={`0 0 ${W} ${latH}`} width="100%" height={latH} role="img" aria-label={t("approach.dispersion.lateralAria")}>
            {latRows.map((row, ri) => {
              const y0 = LAT_TOP + ri * LAT_ROW_H;
              const cy = y0 + LAT_ROW_H / 2;
              return (
                <g key={row.gate}>
                  <rect x={LX(-LAT_HALF_M)} y={y0 + 3} width={LX(LAT_HALF_M) - LX(-LAT_HALF_M)} height={LAT_ROW_H - 6} className="dp-runway" />
                  {[-45, -30, -15, 15, 30, 45].map((m) => (
                    <line key={m} x1={LX(m)} x2={LX(m)} y1={y0 + 3} y2={y0 + LAT_ROW_H - 3} className="dp-grid" />
                  ))}
                  <line x1={LX(0)} x2={LX(0)} y1={y0 + 3} y2={y0 + LAT_ROW_H - 3} className="dp-centre" />
                  <text x={PAD_L - 6} y={cy + 4} textAnchor="end" className="dp-label">
                    {row.label}
                  </text>
                  {chrono.map((f) => {
                    const v = lateralAt(f, row.gate);
                    if (v == null) return null;
                    const k = approachKey(f);
                    const out = Math.abs(v) > LAT_HALF_M;
                    const x = LX(clamp(v, -LAT_HALF_M, LAT_HALF_M));
                    const isNewest = f === newest;
                    const isHover = k === hover;
                    const color = bandVar(f.band);
                    return (
                      <g key={k} className={`dp-pt${isNewest ? " newest" : ""}${isHover ? " hover" : ""}${out ? " out" : ""}`} {...hoverProps(f)}>
                        <title>{`${row.label}: ${sideLabel(v)} – ${factLine(t, f)}`}</title>
                        {(isNewest || isHover) && <circle cx={x} cy={cy} r={isNewest ? 8.5 : 7.5} className="dp-ring" />}
                        <Mark x={x} y={cy} r={isNewest ? 4.5 : 3.6} ga={isGoAround(f)} shape={shapeOf(f.band)} fill={out ? "none" : color} stroke={out ? color : undefined} />
                      </g>
                    );
                  })}
                </g>
              );
            })}
            {[-LAT_HALF_M, -30, 0, 30, LAT_HALF_M].map((m) => (
              <text key={m} x={LX(m)} y={latH - 6} textAnchor={m === -LAT_HALF_M ? "start" : m === LAT_HALF_M ? "end" : "middle"} className="dp-label">
                {m === 0 ? "CL" : `${Math.abs(m)}${NNBSP}m ${m < 0 ? "L" : "R"}`}
              </text>
            ))}
          </svg>

          <div className="ad-section-label detail">{t("approach.dispersion.sparkLabel")}</div>
          {/* the drawing is aria-hidden; the points are a list with one tab stop (arrows move, Enter opens) */}
          <svg viewBox={`0 0 ${W} ${SPARK_H}`} width="100%" height={SPARK_H} className="dp-spark" role="group" aria-label={t("approach.dispersion.sparkAria")}>
            <g aria-hidden="true">
            {[500, 1000].map((v) => (
              <g key={v}>
                <line x1={PAD_L} x2={W - PAD_R} y1={SY(v)} y2={SY(v)} className="dp-grid" />
                <text x={PAD_L - 6} y={SY(v) + 4} textAnchor="end" className="dp-label">
                  {fmtNum(v)}
                </text>
              </g>
            ))}
            <line x1={PAD_L} x2={W - PAD_R} y1={SY(0)} y2={SY(0)} className="ad-zero" />
            <text x={PAD_L - 6} y={SY(0) + 4} textAnchor="end" className="dp-label">
              {t("approach.common.never")}
            </text>
            {sparkPath && <path d={sparkPath} className="dp-spark-line" />}
            </g>
            <g role="list" aria-label={t("approach.dispersion.listAria")}>
            {chrono.map((f, i) => {
              const k = approachKey(f);
              const isNewest = f === newest;
              const never = f.stableFromFt == null;
              const y = SY(f.stableFromFt ?? 0);
              const color = bandVar(f.band);
              return (
                <g key={k} role="listitem">
                  <g
                    className={`dp-pt${isNewest ? " newest" : ""}${k === hover ? " hover" : ""}`}
                    role="button"
                    aria-label={t(isNewest ? "approach.dispersion.newestPointAria" : "approach.dispersion.pointAria", { fact: factLine(t, f) })}
                    {...nav.props(i, () => open(f), () => setHover(k))}
                    onBlur={() => setHover((h) => (h === k ? null : h))}
                    {...hoverProps(f)}
                  >
                    <title>{factLine(t, f)}</title>
                    {(isNewest || k === hover) && <circle cx={SX(i)} cy={y} r={7.5} className="dp-ring" />}
                    <Mark x={SX(i)} y={y} r={isNewest ? 4.5 : 3.6} ga={isGoAround(f)} shape={shapeOf(f.band)} fill={never ? "none" : color} stroke={never ? color : undefined} />
                  </g>
                </g>
              );
            })}
            </g>
          </svg>
          {/* no live region: it changes on every mouse hover */}
          <div className="dp-hover detail">
            {hovered ? factLine(t, hovered) : newest ? t("approach.dispersion.newest", { fact: factLine(t, newest) }) : " "}
          </div>
        </div>

        <div className="dp-stats" aria-label={sumText}>
          <div className="tile">
            <div className="tile-label">{t("approach.dispersion.tileStable")}</div>
            <div className="tile-value num">
              <span className="dp-sd">Ø </span>
              {fmt(summary.meanStableFromFt, 0, "ft")}
            </div>
            <div className="detail">
              {t("approach.dispersion.fromApproaches", { count: summary.stableN })}
              {summary.neverStable > 0 && ` · ${t("approach.dispersion.neverStableCount", { count: summary.neverStable })}`}
            </div>
          </div>
          <div className="tile">
            <div className="tile-label">{t("approach.dispersion.tileGate1000")}</div>
            <div className="tile-value num">
              {summary.gate1000.passed}/{summary.gate1000.total}
            </div>
            <div className="detail">{t("approach.dispersion.allCriteriaMet")}</div>
          </div>
          <div className="tile">
            <div className="tile-label">{t("approach.dispersion.tileGate500")}</div>
            <div className="tile-value num">
              {summary.gate500.passed}/{summary.gate500.total}
            </div>
            <div className="detail">{t("approach.dispersion.allCriteriaMet")}</div>
          </div>
          <div className="tile">
            <div className="tile-label">{t("approach.dispersion.tileLateral500")}</div>
            <div className="tile-value num">
              <span className="dp-sd">{t("approach.dispersion.meanAbsOffset")}</span>
              {fmt(summary.meanAbsLat500M, 0, "m")}
            </div>
            <div className="detail">
              {t("approach.dispersion.fromApproachesKnownCentreline", { count: summary.lat500N })}
            </div>
          </div>
          <div className="tile">
            <div className="tile-label">{t("approach.dispersion.tileGoArounds")}</div>
            <div className="tile-value num">{summary.goArounds}</div>
            <div className="detail">
              {t("approach.dispersion.ofApproaches", { count: summary.count })}
            </div>
          </div>
        </div>
      </div>

      <div className="dp-legend">
        {APPROACH_BANDS.map((b) => (
          <span key={b}>
            <BandSwatch shape={shapeOf(b)} color={bandVar(b)} />
            {APPROACH_BAND_LABEL[b]}
          </span>
        ))}
        <span className="dp-legend-sep" aria-hidden="true" />
        <span>
          <svg className="band-swatch ad-swatch-ga" width={12} height={14} viewBox="0 0 12 14" aria-hidden="true" focusable="false">
            <line x1={6} x2={6} y1={1} y2={6} />
            <circle cx={6} cy={10} r={3.2} />
          </svg>
          {t("approach.dispersion.legendGoAround")}
        </span>
        <span>
          <i className="dp-swatch ring" aria-hidden="true" />
          {t("approach.dispersion.legendNewest")}
        </span>
        <span>
          <i className="dp-swatch ellipse" aria-hidden="true" />
          {t("approach.dispersion.legendSpread")}
        </span>
        <span>
          <i className="ad-swatch-tol" aria-hidden="true" />
          {t("approach.dispersion.legendTolerance")}
        </span>
        <span className="dp-note">
          {t("approach.dispersion.note", { count: facts.length })}
          {data.skipped > 0 && ` · ${t("approach.dispersion.skipped", { count: data.skipped })}`}
        </span>
      </div>
      {facts.length === 0 && <div className="detail">{t("approach.dispersion.noneForFilter")}</div>}
      {facts.length > 0 && (
        <details className="dp-table">
          <summary>{t("approach.dispersion.tableSummary", { count: facts.length })}</summary>
          <div className="dp-table-scroll">
            <table className="data-table">
              <caption className="sr-only">{t("approach.dispersion.tableCaption")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("approach.dispersion.colDate")}</th>
                  <th scope="col">{t("approach.dispersion.colPlace")}</th>
                  <th scope="col">{t("approach.dispersion.colResult")}</th>
                  <th scope="col">{t("approach.dispersion.colBand")}</th>
                  <th scope="col">{t("approach.dispersion.colStable")}</th>
                  {SCATTER_GATES.map((g) => (
                    <th key={g} scope="col">
                      {GATE_LABEL[g]}
                    </th>
                  ))}
                  <th scope="col">
                    <span className="sr-only">{t("approach.dispersion.colAction")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {facts.map((f) => (
                  <tr key={approachKey(f)}>
                    <td className="num">{fmtDate(f.endedMs)}</td>
                    <td className="num">{placeOf(t, f)}</td>
                    <td>{outcomeText(t, f)}</td>
                    <td>
                      {f.band ? (
                        <>
                          <BandSwatch shape={shapeOf(f.band)} color={bandVar(f.band)} /> {approachBandLabel(f.band, f.hardGateFt)}
                        </>
                      ) : (
                        "–"
                      )}
                    </td>
                    <td className="num">{f.stableFromFt != null ? fmt(f.stableFromFt, 0, "ft") : f.band ? t("approach.common.never") : "–"}</td>
                    {SCATTER_GATES.map((g) => {
                      const p = gatePoint(f, g);
                      return (
                        <td key={g} className="num">
                          {p ? `${fmtSigned(p.altDevFt, 0, "ft")} · ${fmtSigned(p.iasDevKt, 0, "kt")}` : "–"}
                        </td>
                      );
                    })}
                    <td>
                      <button className="btn-sm" onClick={() => open(f)}>
                        {t("approach.dispersion.open")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="detail">{t("approach.dispersion.tableNote")}</p>
        </details>
      )}
    </section>
  );
}
