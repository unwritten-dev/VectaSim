import { useEffect, useMemo, useState } from "react";
import { useThemeId } from "./themes";
import type { PhaseEventRow, TouchdownReport, TrackSample } from "./types";
import { PHASE_LABEL, fmt, fmtClock, fmtNum, fmtSigned } from "./format";
import { PROFILE } from "./theme";

/**
 * Altitude / speed profile of a recorded flight (feature spec B2), plain SVG.
 * Altitude MSL is the filled area on the left axis; ground speed and V/S are
 * thin lines on two right axes. Phase changes and touchdowns are vertical
 * markers; hovering shows a crosshair with the values at that moment.
 */

const HEIGHT = 240;
const M = { top: 34, right: 92, bottom: 26, left: 52 };

interface Props {
  samples: TrackSample[];
  phases: PhaseEventRow[];
  touchdowns: TouchdownReport[];
}

/** 1/2/5 × 10^n step giving about `count` ticks over `range`. */
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

const TIME_STEPS_MIN = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 240];

function clock(ms: number, seconds = false): string {
  return fmtClock(ms, { seconds });
}

function kfmt(v: number): string {
  if (Math.abs(v) < 1000) return fmtNum(Math.round(v));
  const k = Math.round(v / 100) / 10;
  return `${fmtNum(k, Number.isInteger(k) ? 0 : 1)}k`;
}

/** First index with tMs >= t. */
function lowerBound(samples: TrackSample[], t: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].tMs < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export default function ProfileChart({ samples, phases, touchdowns }: Props) {
  useThemeId(); // colours come from the active theme
  // callback ref: the wrapper element changes between the empty and the chart state
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!wrap) return;
    const measure = () => setWidth(Math.max(320, Math.floor(wrap.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [wrap]);

  const plotW = width - M.left - M.right;
  const plotH = HEIGHT - M.top - M.bottom;

  const model = useMemo(() => {
    if (samples.length < 2) return null;
    const t0 = samples[0].tMs;
    const t1 = samples[samples.length - 1].tMs;
    let altMax = 0;
    let altMin = Infinity;
    let gsMax = 0;
    let vsAbs = 0;
    for (const s of samples) {
      altMax = Math.max(altMax, s.altitudeMslFt);
      altMin = Math.min(altMin, s.altitudeMslFt);
      gsMax = Math.max(gsMax, s.groundSpeedKt);
      vsAbs = Math.max(vsAbs, Math.abs(s.verticalSpeedFpm));
    }
    const altLo = Math.min(0, Math.floor(altMin / 1000) * 1000);
    const altHi = Math.max(altMax * 1.05, altLo + 1000);
    const altTicks = ticks(altLo, altHi, 4);
    const gsHi = Math.max(gsMax * 1.05, 50);
    const gsTicks = ticks(0, gsHi, 4);
    const vsStep = niceStep(Math.max(vsAbs, 500), 2);
    const vsHi = Math.ceil(Math.max(vsAbs, 500) / vsStep) * vsStep;
    const vsTicks = ticks(-vsHi, vsHi, 4);
    return { t0, t1, altLo, altHi, altTicks, gsHi, gsTicks, vsHi, vsTicks };
  }, [samples]);

  if (!model) {
    return (
      <div ref={setWrap} className="profile-chart empty detail">
        Kein Profil – zu wenige Trackpunkte.
      </div>
    );
  }

  const { t0, t1, altLo, altHi, altTicks, gsHi, gsTicks, vsHi, vsTicks } = model;
  const x = (t: number) => M.left + ((t - t0) / Math.max(1, t1 - t0)) * plotW;
  const yAlt = (a: number) => M.top + plotH - ((a - altLo) / (altHi - altLo)) * plotH;
  const yGs = (g: number) => M.top + plotH - (g / gsHi) * plotH;
  const yVs = (v: number) => M.top + plotH / 2 - (v / vsHi) * (plotH / 2);

  // ~2 points per pixel is plenty for the lines
  const stride = Math.max(1, Math.floor(samples.length / (plotW * 2)));
  const pts: TrackSample[] = [];
  for (let i = 0; i < samples.length; i += stride) pts.push(samples[i]);
  if (pts[pts.length - 1] !== samples[samples.length - 1]) pts.push(samples[samples.length - 1]);

  const line = (y: (s: TrackSample) => number) =>
    pts.map((s, i) => `${i ? "L" : "M"}${x(s.tMs).toFixed(1)},${y(s).toFixed(1)}`).join("");
  const altLine = line((s) => yAlt(s.altitudeMslFt));
  const altArea = `${altLine}L${x(t1).toFixed(1)},${yAlt(altLo).toFixed(1)}L${x(t0).toFixed(1)},${yAlt(altLo).toFixed(1)}Z`;
  const gsLine = line((s) => yGs(s.groundSpeedKt));
  const vsLine = line((s) => yVs(s.verticalSpeedFpm));

  // time ticks on whole minutes
  const spanMin = (t1 - t0) / 60000;
  const stepMin = TIME_STEPS_MIN.find((s) => spanMin / s <= Math.max(2, plotW / 90)) ?? 480;
  const stepMs = stepMin * 60000;
  const timeTicks: number[] = [];
  for (let t = Math.ceil(t0 / stepMs) * stepMs; t <= t1; t += stepMs) timeTicks.push(t);

  // phase labels in two rows so neighbours do not collide
  const phaseMarks = phases
    .filter((p) => p.timestampMs >= t0 && p.timestampMs <= t1)
    .map((p) => ({ x: x(p.timestampMs), label: PHASE_LABEL[p.to] ?? p.to }));
  const lastInRow = [-Infinity, -Infinity];
  const placed = phaseMarks.map((p) => {
    const w = p.label.length * 6 + 6;
    const row = p.x - lastInRow[0] >= w ? 0 : p.x - lastInRow[1] >= w ? 1 : 0;
    lastInRow[row] = p.x;
    return { ...p, row };
  });

  const tdMarks = touchdowns.filter((t) => t.timestampMs >= t0 - 5000 && t.timestampMs <= t1 + 5000);

  const hoverSample = hover !== null ? samples[hover] : null;
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - rect.left) / rect.width) * (t1 - t0);
    let i = lowerBound(samples, t);
    if (i > 0 && (i >= samples.length || t - samples[i - 1].tMs < samples[i].tMs - t)) i -= 1;
    setHover(Math.min(i, samples.length - 1));
  };
  const hoverPhase = hoverSample
    ? [...phases].reverse().find((p) => p.timestampMs <= hoverSample.tMs)
    : undefined;

  const tipX = hoverSample ? x(hoverSample.tMs) : 0;
  const tipLeft = tipX > M.left + plotW - 150;

  return (
    <div ref={setWrap} className="profile-chart">
      <div className="profile-legend">
        <span className="tile-label">Profil</span>
        <span style={{ color: PROFILE.alt }}>■ Höhe MSL (ft)</span>
        <span style={{ color: PROFILE.gs }}>━ Groundspeed (kt)</span>
        <span style={{ color: PROFILE.vs }}>━ V/S (fpm)</span>
        {tdMarks.length > 0 && <span style={{ color: PROFILE.touchdown }}>▼ Aufsetzen</span>}
      </div>
      <svg width={width} height={HEIGHT} role="img" aria-label="Höhen- und Geschwindigkeitsprofil">
        <defs>
          <linearGradient id="alt-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PROFILE.alt} stopOpacity={0.45} />
            <stop offset="100%" stopColor={PROFILE.alt} stopOpacity={0.04} />
          </linearGradient>
          <clipPath id="plot-clip">
            <rect x={M.left} y={M.top} width={plotW} height={plotH} />
          </clipPath>
        </defs>

        {/* grid + left axis (altitude) */}
        {altTicks.map((a) => (
          <g key={`a${a}`}>
            <line x1={M.left} x2={M.left + plotW} y1={yAlt(a)} y2={yAlt(a)} className="pc-grid" />
            <text x={M.left - 6} y={yAlt(a) + 4} textAnchor="end" className="pc-tick">
              {kfmt(a)}
            </text>
          </g>
        ))}
        {/* right axes: GS inner, V/S outer */}
        {gsTicks.map((g) => (
          <text key={`g${g}`} x={M.left + plotW + 6} y={yGs(g) + 4} className="pc-tick" fill={PROFILE.gs}>
            {g}
          </text>
        ))}
        {vsTicks.map((v) => (
          <text key={`v${v}`} x={width - 4} y={yVs(v) + 4} textAnchor="end" className="pc-tick" fill={PROFILE.vs}>
            {v > 0 ? "+" : ""}
            {kfmt(v)}
          </text>
        ))}
        <line x1={M.left} x2={M.left + plotW} y1={yVs(0)} y2={yVs(0)} className="pc-zero" />

        {/* time axis */}
        {timeTicks.map((t) => (
          <g key={`t${t}`}>
            <line x1={x(t)} x2={x(t)} y1={M.top + plotH} y2={M.top + plotH + 4} className="pc-axis" />
            <text x={x(t)} y={HEIGHT - 8} textAnchor="middle" className="pc-tick">
              {clock(t)}
            </text>
          </g>
        ))}
        <line x1={M.left} x2={M.left + plotW} y1={M.top + plotH} y2={M.top + plotH} className="pc-axis" />

        <g clipPath="url(#plot-clip)">
          <path d={altArea} fill="url(#alt-fill)" />
          <path d={altLine} fill="none" stroke={PROFILE.alt} strokeWidth={1.5} />
          <path d={gsLine} fill="none" stroke={PROFILE.gs} strokeWidth={1} opacity={0.9} />
          <path d={vsLine} fill="none" stroke={PROFILE.vs} strokeWidth={1} opacity={0.75} />
        </g>

        {/* phase markers */}
        {placed.map((p, i) => (
          <g key={`p${i}`}>
            <line x1={p.x} x2={p.x} y1={M.top - 4 - p.row * 12} y2={M.top + plotH} className="pc-phase" />
            <text x={p.x + 3} y={M.top - 6 - p.row * 12} className="pc-phase-label">
              {p.label}
            </text>
          </g>
        ))}

        {/* touchdowns */}
        {tdMarks.map((t, i) => {
          const tx = Math.min(Math.max(x(t.timestampMs), M.left), M.left + plotW);
          return (
            <g key={`td${i}`}>
              <line x1={tx} x2={tx} y1={M.top} y2={M.top + plotH} stroke={PROFILE.touchdown} strokeWidth={1} opacity={0.8} />
              <path d={`M${tx - 5},${M.top + plotH - 9}L${tx + 5},${M.top + plotH - 9}L${tx},${M.top + plotH - 1}Z`} fill={PROFILE.touchdown} />
              <text x={tx - 4} y={M.top + plotH - 13} textAnchor="end" className="pc-td-label">
                {fmt(t.landingRateFpm, 0, "fpm")}
              </text>
            </g>
          );
        })}

        {/* hover crosshair */}
        {hoverSample && (
          <g pointerEvents="none">
            <line x1={tipX} x2={tipX} y1={M.top} y2={M.top + plotH} className="pc-cross" />
            <circle cx={tipX} cy={yAlt(hoverSample.altitudeMslFt)} r={3.5} fill={PROFILE.alt} />
            <circle cx={tipX} cy={yGs(hoverSample.groundSpeedKt)} r={3} fill={PROFILE.gs} />
            <circle cx={tipX} cy={yVs(hoverSample.verticalSpeedFpm)} r={3} fill={PROFILE.vs} />
            <g transform={`translate(${tipLeft ? tipX - 144 : tipX + 8},${M.top + 4})`}>
              <rect width={136} height={hoverPhase ? 78 : 64} rx={6} className="pc-tip" />
              <text x={8} y={16} className="pc-tip-head">
                {clock(hoverSample.tMs, true)}
              </text>
              {hoverPhase && (
                <text x={8} y={30} className="pc-tip-text">
                  {PHASE_LABEL[hoverPhase.to]}
                </text>
              )}
              <g transform={`translate(0,${hoverPhase ? 14 : 0})`}>
                <text x={8} y={32} className="pc-tip-text" fill={PROFILE.alt}>
                  Höhe {fmt(hoverSample.altitudeMslFt, 0, "ft")}
                </text>
                <text x={8} y={46} className="pc-tip-text" fill={PROFILE.gs}>
                  GS {fmt(hoverSample.groundSpeedKt, 0, "kt")}
                </text>
                <text x={8} y={60} className="pc-tip-text" fill={PROFILE.vs}>
                  V/S {fmtSigned(Math.round(hoverSample.verticalSpeedFpm), 0, "fpm")}
                </text>
              </g>
            </g>
          </g>
        )}

        <rect
          x={M.left}
          y={M.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>
    </div>
  );
}
