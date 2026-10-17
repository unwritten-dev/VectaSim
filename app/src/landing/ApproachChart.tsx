import { useEffect, useMemo, useState } from "react";
import { useThemeId } from "../themes";
import { NNBSP, fmt, fmtNum, fmtSigned } from "../format";
import { PROFILE } from "../theme";
import { M_PER_FT, M_PER_NM, nearestByDist, referenceHeightFt } from "./geometry";
import type { LandingAnalysis } from "./types";

/**
 * Approach profile: height above touchdown over the distance to the threshold, with the
 * reference glidepath and its tolerance band, IAS and V/S on two right axes, markers at
 * the 1000/500 ft gates, the threshold and the touchdown; hover readout per sample.
 */

const HEIGHT = 280;
const M = { top: 26, right: 96, bottom: 30, left: 52 };

function niceStep(range: number, count: number): number {
  if (range <= 0) return 1;
  const raw = range / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
}

function ticks(min: number, max: number, count: number): number[] {
  const step = niceStep(max - min, count);
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

export default function ApproachChart({ analysis: a }: { analysis: LandingAnalysis }) {
  useThemeId(); // colours come from the active theme
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!wrap) return;
    const measure = () => setWidth(Math.max(360, Math.floor(wrap.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [wrap]);

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

  if (!model) return <div ref={setWrap} className="ac empty detail">Zu wenige Trackpunkte für ein Anflugprofil.</div>;

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
  const hs = hover != null ? samples[hover] : null;
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const d = dMax - ((e.clientX - rect.left) / rect.width) * (dMax - dMin);
    setHover(nearestByDist(samples, d));
  };
  const tipX = hs ? x(hs.distM) : 0;
  const tipLeft = tipX > M.left + plotW - 170;
  const tipRows = hs
    ? [
        [PROFILE.alt, `Höhe ${fmt(hs.hatFt, 0, "ft")} über Aufsetzpunkt`],
        [PROFILE.gs, `IAS ${fmt(hs.iasKt, 0, "kt")} · GS ${fmt(hs.groundSpeedKt, 0, "kt")}`],
        [PROFILE.vs, `V/S ${fmtSigned(Math.round(hs.vsFpm), 0, "fpm")}`],
        ...(hs.glidepathDevDeg != null ? [["var(--text-muted)", `Gleitpfad ${fmt(hs.glidepathDeg, 2, "°")} (${fmtSigned(hs.glidepathDevDeg, 2, "°")})`]] : []),
        ...(hs.onGround ? [["var(--text-muted)", "am Boden"]] : []),
      ]
    : [];

  return (
    <div ref={setWrap} className="ac">
      <div className="profile-legend">
        <span style={{ color: PROFILE.alt }}>━ Höhe über Aufsetzpunkt (ft)</span>
        {withRunway && (
          <span className="ac-ref">
            ┅ {fmt(gp, 0, "°")}-Referenz ±{fmtNum(tol, 1)}° (Schwelle {fmt(tch, 0, "ft")})
          </span>
        )}
        <span style={{ color: PROFILE.gs }}>━ IAS (kt)</span>
        <span style={{ color: PROFILE.vs }}>━ V/S (fpm)</span>
      </div>
      <svg width={width} height={HEIGHT} role="img" aria-label="Anflugprofil: Höhe über Distanz zur Schwelle mit Gleitpfad-Referenz, IAS und Sinkrate">
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
          {withRunway ? "Distanz zur Schwelle (nm)" : "Distanz zum Aufsetzpunkt entlang der Bahn (nm)"}
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
              Schwelle
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
            Aufsetzen
          </text>
        </g>

        {hs && (
          <g pointerEvents="none">
            <line x1={tipX} x2={tipX} y1={M.top} y2={M.top + plotH} className="pc-cross" />
            <circle cx={tipX} cy={yH(hs.hatFt)} r={3.5} fill={PROFILE.alt} />
            {!hs.onGround && <circle cx={tipX} cy={yIas(hs.iasKt)} r={3} fill={PROFILE.gs} />}
            {!hs.onGround && <circle cx={tipX} cy={yVs(hs.vsFpm)} r={3} fill={PROFILE.vs} />}
            <g transform={`translate(${tipLeft ? tipX - 208 : tipX + 8},${M.top + 4})`}>
              <rect width={200} height={22 + tipRows.length * 14} rx={6} className="pc-tip" />
              <text x={8} y={16} className="pc-tip-head">
                {fmt(Math.abs(hs.distM) / M_PER_NM, 2, "nm")} {hs.distM >= 0 ? (withRunway ? "vor der Schwelle" : "vor dem Aufsetzen") : withRunway ? "hinter der Schwelle" : "nach dem Aufsetzen"}
              </text>
              {tipRows.map(([c, t], i) => (
                <text key={i} x={8} y={31 + i * 14} className="pc-tip-text" fill={c}>
                  {t}
                </text>
              ))}
            </g>
          </g>
        )}
        <rect x={M.left} y={M.top} width={plotW} height={plotH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
    </div>
  );
}
