import { useMemo } from "react";
import { niceStep, ticks, useWidth } from "./chartUtils";
import { useThemeId } from "../themes";
import { NNBSP, fmt, fmtNum, fmtSigned } from "../i18n/number";
import { useT } from "../i18n";
import { PROFILE } from "../theme";
import { M_PER_FT, M_PER_NM, referenceHeightFt } from "./geometry";
import { sampleAt, timeAtValue, useReplayCursor, useReplayStore } from "./replayStore";
import type { ApproachAnalysis } from "./approachTypes";
import ApproachProfile from "./ApproachProfile";
import type { ApproachPoint, LandingAnalysis } from "./types";

/**
 * Approach profile: height above touchdown over the distance to the threshold, with the
 * reference glidepath and its tolerance band, IAS and V/S on two right axes, markers at
 * the 1000/500 ft gates, the threshold and the touchdown; hover readout per sample.
 */

const HEIGHT = 280;
const M = { top: 26, right: 96, bottom: 30, left: 52 };

/**
 * The debrief's approach profile: with an approach analysis the long profile with range
 * switch (ApproachProfile.tsx), otherwise the landing's final-only profile.
 */
export default function ApproachChart({ analysis, approach }: { analysis?: LandingAnalysis | null; approach?: ApproachAnalysis | null }) {
  if (approach && approach.samples.length >= 2) return <ApproachProfile a={approach} />;
  if (analysis) return <LandingProfile analysis={analysis} />;
  return <NoProfile />;
}

function NoProfile() {
  const t = useT();
  return <div className="ac empty detail">{t("approach.common.tooFewTrackPoints")}.</div>;
}

function LandingProfile({ analysis: a }: { analysis: LandingAnalysis }) {
  useThemeId(); // colours come from the active theme
  const t = useT();
  const [setWrap, width] = useWidth();
  const store = useReplayStore();

  const samples = a.samples;
  const withRunway = a.distanceRef === "threshold";
  const model = useMemo(() => {
    if (samples.length < 2) return null;
    let dMax = -Infinity;
    let dMin = Infinity;
    let hMax = 0;
    let iasMin = Infinity;
    let iasMax = 0;
    let vsMin = 0;
    let vsMax = 0;
    for (const s of samples) {
      dMax = Math.max(dMax, s.distM);
      dMin = Math.min(dMin, s.distM);
      hMax = Math.max(hMax, s.hatFt);
      if (!s.onGround) {
        iasMin = Math.min(iasMin, s.iasKt);
        iasMax = Math.max(iasMax, s.iasKt);
        vsMin = Math.min(vsMin, s.vsFpm);
        vsMax = Math.max(vsMax, s.vsFpm);
      }
    }
    if (!Number.isFinite(iasMin)) iasMin = 0;
    const hHi = Math.max(1100, hMax * 1.05);
    const iasLo = Math.max(0, Math.floor((iasMin - 15) / 10) * 10);
    const iasHi = Math.ceil((iasMax + 15) / 10) * 10;
    const vsStep = niceStep(Math.max(1500, -vsMin), 3);
    const vsLo = -Math.ceil(Math.max(1500, -vsMin * 1.1) / vsStep) * vsStep;
    const vsHi = Math.max(500, Math.ceil(vsMax / vsStep) * vsStep);
    return { dMax, dMin, hHi, iasLo, iasHi, vsLo, vsHi };
  }, [samples]);

  if (!model) return <div ref={setWrap} className="ac empty detail">{t("approach.common.tooFewTrackPoints")}.</div>;

  const { dMax, dMin, hHi, iasLo, iasHi, vsLo, vsHi } = model;
  const plotW = width - M.left - M.right;
  const plotH = HEIGHT - M.top - M.bottom;
  const x = (d: number) => M.left + ((dMax - d) / Math.max(1, dMax - dMin)) * plotW;
  const yH = (h: number) => M.top + plotH - (Math.max(0, h) / hHi) * plotH;
  const yIas = (v: number) => M.top + plotH - ((v - iasLo) / Math.max(1, iasHi - iasLo)) * plotH;
  const yVs = (v: number) => M.top + plotH - ((v - vsLo) / (vsHi - vsLo)) * plotH;
  const line = (f: (i: number) => [number, number], n: number) =>
    Array.from({ length: n }, (_, i) => f(i))
      .map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`)
      .join("");
  const air = samples.filter((s) => !s.onGround);
  const altPath = line((i) => [x(samples[i].distM), yH(samples[i].hatFt)], samples.length);
  const iasPath = line((i) => [x(air[i].distM), yIas(air[i].iasKt)], air.length);
  const vsPath = line((i) => [x(air[i].distM), yVs(air[i].vsFpm)], air.length);

  // reference glidepath with tolerance band (runway only)
  const gp = a.config.glidepathDeg;
  const tol = a.config.glidepathToleranceDeg;
  const tch = a.config.tchFt;
  const gpipM = (tch * M_PER_FT) / Math.tan((gp * Math.PI) / 180);
  let refPath = "";
  let bandPath = "";
  if (withRunway) {
    const from = dMax;
    const to = Math.max(dMin, -gpipM);
    const n = 40;
    const ds = Array.from({ length: n + 1 }, (_, i) => from + ((to - from) * i) / n);
    refPath = ds.map((d, i) => `${i ? "L" : "M"}${x(d).toFixed(1)},${yH(referenceHeightFt(d, gp, tch)).toFixed(1)}`).join("");
    const upper = ds.map((d) => `${x(d).toFixed(1)},${yH(referenceHeightFt(d, gp + tol, tch, gp)).toFixed(1)}`);
    const lower = ds.map((d) => `${x(d).toFixed(1)},${yH(referenceHeightFt(d, gp - tol, tch, gp)).toFixed(1)}`).reverse();
    bandPath = `M${upper.join("L")}L${lower.join("L")}Z`;
  }

  const hTicks = ticks(0, hHi, 5);
  const nmSpan = (dMax - dMin) / M_PER_NM;
  const nmStep = nmSpan > 6 ? 1 : nmSpan > 2.5 ? 0.5 : 0.25;
  const dTicks: number[] = [];
  for (let v = Math.floor(dMin / M_PER_NM / nmStep) * nmStep; v <= dMax / M_PER_NM + 1e-9; v += nmStep) {
    if (v * M_PER_NM >= dMin - 1 && v * M_PER_NM <= dMax + 1) dTicks.push(Math.round(v * 100) / 100);
  }
  const iasTicks = ticks(iasLo, iasHi, 4);
  const vsTicks = ticks(vsLo, vsHi, 4);

  const tdDist = withRunway ? -(a.touchdownPoint?.distanceM ?? 0) : 0;
  const gates = a.gates.filter((g) => g.sample).map((g) => ({ ft: g.gateFt, d: g.sample!.distM, h: g.sample!.hatFt }));
  const timeAt = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const d = dMax - ((e.clientX - rect.left) / rect.width) * (dMax - dMin);
    return timeAtValue(samples, (s) => s.distM, d);
  };

  return (
    <div ref={setWrap} className="ac">
      <div className="profile-legend">
        <span style={{ color: PROFILE.alt }}>━ {t("approach.common.heightAboveTouchdown")}</span>
        {withRunway && (
          <span className="ac-ref">
            ┅ {t("approach.chart.refBand", { deg: fmt(gp, 0, "°"), tol: fmt(tol, 1, "°"), tch: fmt(tch, 0, "ft") })}
          </span>
        )}
        <span style={{ color: PROFILE.gs }}>━ IAS (kt)</span>
        <span style={{ color: PROFILE.vs }}>━ V/S (fpm)</span>
      </div>
      <svg width={width} height={HEIGHT} role="img" aria-label={t("approach.chart.ariaLabel")}>
        <defs>
          <clipPath id="ac-clip">
            <rect x={M.left} y={M.top - 2} width={plotW} height={plotH + 4} />
          </clipPath>
        </defs>
        {hTicks.map((h) => (
          <g key={`h${h}`}>
            <line x1={M.left} x2={M.left + plotW} y1={yH(h)} y2={yH(h)} className="pc-grid" />
            <text x={M.left - 6} y={yH(h) + 4} textAnchor="end" className="pc-tick">
              {fmtNum(h)}
            </text>
          </g>
        ))}
        {iasTicks.map((v) => (
          <text key={`i${v}`} x={M.left + plotW + 6} y={yIas(v) + 4} className="pc-tick" fill={PROFILE.gs}>
            {fmtNum(v)}
          </text>
        ))}
        {vsTicks.map((v) => (
          <text key={`v${v}`} x={width - 4} y={yVs(v) + 4} textAnchor="end" className="pc-tick" fill={PROFILE.vs}>
            {fmtSigned(v, 0)}
          </text>
        ))}
        {dTicks.map((nm) => (
          <g key={`d${nm}`}>
            <line x1={x(nm * M_PER_NM)} x2={x(nm * M_PER_NM)} y1={M.top + plotH} y2={M.top + plotH + 4} className="pc-axis" />
            <text x={x(nm * M_PER_NM)} y={HEIGHT - 12} textAnchor="middle" className="pc-tick">
              {fmtNum(nm, nmStep < 0.5 ? 2 : nmStep < 1 ? 1 : 0)}
            </text>
          </g>
        ))}
        <text x={M.left + plotW} y={HEIGHT - 1} textAnchor="end" className="pc-tick">
          {withRunway ? t("approach.chart.axisThreshold") : t("approach.chart.axisTouchdown")}
        </text>
        <line x1={M.left} x2={M.left + plotW} y1={M.top + plotH} y2={M.top + plotH} className="pc-axis" />

        <g clipPath="url(#ac-clip)">
          {withRunway && <path d={bandPath} className="ac-band" />}
          {withRunway && <path d={refPath} className="ac-refline" />}
          <path d={vsPath} fill="none" stroke={PROFILE.vs} strokeWidth={1.2} opacity={0.85} />
          <path d={iasPath} fill="none" stroke={PROFILE.gs} strokeWidth={1.2} opacity={0.9} />
          <path d={altPath} fill="none" stroke={PROFILE.alt} strokeWidth={2} />
        </g>

        {/* threshold */}
        {withRunway && (
          <g>
            <line x1={x(0)} x2={x(0)} y1={M.top} y2={M.top + plotH} className="ac-marker" />
            <text x={x(0) + 4} y={M.top + 10} className="pc-phase-label">
              {t("approach.common.threshold")}
            </text>
          </g>
        )}
        {/* gates */}
        {gates.map((g) => (
          <g key={g.ft}>
            <line x1={x(g.d)} x2={x(g.d)} y1={M.top} y2={M.top + plotH} className="ac-gate" />
            <circle cx={x(g.d)} cy={yH(g.h)} r={3.5} fill={PROFILE.alt} />
            <text x={x(g.d) + 4} y={M.top - 6} className="pc-phase-label">
              {fmtNum(g.ft)}
              {NNBSP}ft
            </text>
          </g>
        ))}
        {/* touchdown */}
        <g>
          <line x1={x(tdDist)} x2={x(tdDist)} y1={M.top} y2={M.top + plotH} stroke={PROFILE.touchdown} strokeWidth={1} opacity={0.8} />
          <path d={`M${x(tdDist) - 5},${M.top + plotH - 9}L${x(tdDist) + 5},${M.top + plotH - 9}L${x(tdDist)},${M.top + plotH - 1}Z`} fill={PROFILE.touchdown} />
          <text x={x(tdDist) + 4} y={M.top + 22} className="pc-td-label">
            {t("approach.common.touchdown")}
          </text>
        </g>

        <LandingCursor samples={samples} withRunway={withRunway} scales={{ x, yH, yIas, yVs, plotW, plotH }} />
        <rect
          x={M.left}
          y={M.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          className="replay-hit"
          onMouseMove={(e) => store.hover(timeAt(e))}
          onMouseLeave={() => store.hover(null)}
          onClick={(e) => {
            store.pause();
            store.setCursor(timeAt(e));
          }}
        />
      </svg>
    </div>
  );
}

type Scales = { x: (d: number) => number; yH: (h: number) => number; yIas: (v: number) => number; yVs: (v: number) => number; plotW: number; plotH: number };

/** The shared cursor: vertical line plus the values at that time (own component: cheap playback frames). */
function LandingCursor({ samples, withRunway, scales }: { samples: ApproachPoint[]; withRunway: boolean; scales: Scales }) {
  const t = useT();
  const tMs = useReplayCursor();
  const hs = sampleAt(samples, tMs);
  if (!hs) return null;
  const { x, yH, yIas, yVs, plotW, plotH } = scales;
  const tipX = x(hs.distM);
  const tipLeft = tipX > M.left + plotW - 170;
  const tipRows: Array<[string, string]> = [
    [PROFILE.alt, t("approach.chart.tipHeight", { height: fmt(hs.hatFt, 0, "ft") })],
    [PROFILE.gs, `IAS ${fmt(hs.iasKt, 0, "kt")} · GS ${fmt(hs.groundSpeedKt, 0, "kt")}`],
    [PROFILE.vs, `V/S ${fmtSigned(Math.round(hs.vsFpm), 0, "fpm")}`],
    ...(hs.glidepathDevDeg != null ? [["var(--text-muted)", t("approach.chart.tipGlidepath", { deg: fmt(hs.glidepathDeg, 2, "°"), dev: fmtSigned(hs.glidepathDevDeg, 2, "°") })] as [string, string]] : []),
    ...(hs.onGround ? [["var(--text-muted)", t("approach.common.onGround")] as [string, string]] : []),
  ];
  return (
    <g pointerEvents="none" aria-hidden="true" className="replay-cursor">
      <line x1={tipX} x2={tipX} y1={M.top} y2={M.top + plotH} className="pc-cross" />
      <circle cx={tipX} cy={yH(hs.hatFt)} r={3.5} fill={PROFILE.alt} />
      {!hs.onGround && <circle cx={tipX} cy={yIas(hs.iasKt)} r={3} fill={PROFILE.gs} />}
      {!hs.onGround && <circle cx={tipX} cy={yVs(hs.vsFpm)} r={3} fill={PROFILE.vs} />}
      <g transform={`translate(${tipLeft ? tipX - 208 : tipX + 8},${M.top + 4})`}>
        <rect width={200} height={22 + tipRows.length * 14} rx={6} className="pc-tip" />
        <text x={8} y={16} className="pc-tip-head">
          {t(
            hs.distM >= 0
              ? withRunway
                ? "approach.chart.beforeThreshold"
                : "approach.chart.beforeTouchdown"
              : withRunway
                ? "approach.chart.pastThreshold"
                : "approach.chart.afterTouchdown",
            { dist: fmt(Math.abs(hs.distM) / M_PER_NM, 2, "nm") },
          )}
        </text>
        {tipRows.map(([c, row], i) => (
          <text key={i} x={8} y={31 + i * 14} className="pc-tip-text" fill={c}>
            {row}
          </text>
        ))}
      </g>
    </g>
  );
}
