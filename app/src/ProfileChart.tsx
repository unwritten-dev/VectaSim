import { useEffect, useMemo, useState } from "react";
import { useThemeId } from "./themes";
import type { PhaseEventRow, TouchdownReport, TrackSample } from "./types";
import { PHASE_LABEL } from "./format";
import { fmt, fmtClock, fmtNum, fmtSigned } from "./i18n/number";
import { useT } from "./i18n";
import { COLOR, PROFILE } from "./theme";
import { trackEventDetail, trackEventLabel, type TrackEvent, type TrackEventTone } from "./trackEvents";
import { useTrackEventFilter } from "./map/TrackMarkersMenu";
import { minMaxBucketIndices } from "./map/downsample";
import { sampleAt, useReplayCursor, useReplayStore } from "./landing/replayStore";
import { rateText } from "./landing/rated";

/**
 * Altitude / speed profile of a recorded flight, plain SVG.
 * Altitude MSL is the filled area on the left axis; ground speed and V/S are
 * thin lines on two right axes. Phase changes and touchdowns are vertical
 * markers. The crosshair is the shared replay cursor (landing/replayStore.ts): hovering
 * previews a time, a click pins it, and the track map beside it shows the same moment.
 */

const HEIGHT = 240;
const M = { top: 34, right: 92, bottom: 26, left: 52 };

interface Props {
  samples: TrackSample[];
  phases: PhaseEventRow[];
  touchdowns: TouchdownReport[];
  /** Flight-path markers (trackEvents.ts) as ticks along the top edge, filtered like the map. */
  events?: TrackEvent[];
}

const toneColor = (tone: TrackEventTone) =>
  tone === "accent" ? COLOR.accent : tone === "ok" ? COLOR.ok : tone === "warn" ? COLOR.warn : tone === "err" ? COLOR.err : COLOR.textMuted;

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

export default function ProfileChart({ samples, phases, touchdowns, events = [] }: Props) {
  useThemeId(); // colours come from the active theme
  // callback ref: the wrapper element changes between the empty and the chart state
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  const store = useReplayStore();
  const t = useT();
  const filter = useTrackEventFilter();

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

  // Min/max per pixel column for all three series: keeps spikes (touchdown V/S) that a fixed
  // stride would skip, and bounds the path size by the chart width instead of the flight length.
  // Memoised so hovering (state change per mouse move) does not rescan a 10-h track.
  const pts = useMemo(() => {
    const idx = minMaxBucketIndices(samples.length, Math.max(1, plotW), (i) => samples[i].tMs, [
      (i) => samples[i].altitudeMslFt,
      (i) => samples[i].groundSpeedKt,
      (i) => samples[i].verticalSpeedFpm,
    ]);
    return idx.map((i) => samples[i]);
  }, [samples, plotW]);

  if (!model) {
    return (
      <div ref={setWrap} className="profile-chart empty detail">
        {t("logbook.profile.empty")}
      </div>
    );
  }

  const { t0, t1, altLo, altHi, altTicks, gsHi, gsTicks, vsHi, vsTicks } = model;
  const x = (t: number) => M.left + ((t - t0) / Math.max(1, t1 - t0)) * plotW;
  const yAlt = (a: number) => M.top + plotH - ((a - altLo) / (altHi - altLo)) * plotH;
  const yGs = (g: number) => M.top + plotH - (g / gsHi) * plotH;
  const yVs = (v: number) => M.top + plotH / 2 - (v / vsHi) * (plotH / 2);

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

  const timeAt = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return t0 + Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * (t1 - t0);
  };

  return (
    <div ref={setWrap} className="profile-chart">
      <div className="profile-legend">
        <span className="tile-label">{t("logbook.profile.title")}</span>
        <span style={{ color: PROFILE.alt }}>■ {t("logbook.profile.alt")}</span>
        <span style={{ color: PROFILE.gs }}>━ {t("logbook.profile.gs")}</span>
        <span style={{ color: PROFILE.vs }}>━ {t("logbook.profile.vs")}</span>
        {tdMarks.length > 0 && <span style={{ color: PROFILE.touchdown }}>▼ {t("logbook.profile.touchdown")}</span>}
      </div>
      <svg width={width} height={HEIGHT} role="img" aria-label={t("logbook.profile.ariaLabel")}>
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
                {rateText(t)}
              </text>
            </g>
          );
        })}

        {/* shared cursor */}
        <ProfileCursor samples={samples} phases={phases} x={x} yAlt={yAlt} yGs={yGs} yVs={yVs} plotW={plotW} plotH={plotH} />

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

        {/* flight-path markers: ticks (runs as bars) along the top edge; click = cursor there */}
        <g className="pc-events">
          {events
            .filter((e) => e.kind !== "touchdown" && filter[e.group] && e.tMs >= t0 && e.tMs <= t1)
            .map((e) => {
              const ex = x(e.tMs);
              const c = toneColor(e.tone);
              return (
                <g
                  key={e.id}
                  className="pc-event"
                  onClick={() => {
                    store.pause();
                    store.setCursor(e.tMs);
                  }}
                  onMouseEnter={() => store.hover(e.tMs)}
                  onMouseLeave={() => store.hover(null)}
                >
                  <title>{[trackEventLabel(e), ...trackEventDetail(e)].join("\n")}</title>
                  {e.endTMs != null && <rect x={ex} y={M.top + 1} width={Math.max(2, x(Math.min(e.endTMs, t1)) - ex)} height={3} fill={c} />}
                  <line x1={ex} x2={ex} y1={M.top} y2={M.top + 9} stroke={c} strokeWidth={2} />
                  <rect x={ex - 5} y={M.top} width={10} height={12} fill="transparent" />
                </g>
              );
            })}
        </g>
      </svg>
    </div>
  );
}

interface CursorProps {
  samples: TrackSample[];
  phases: PhaseEventRow[];
  x: (t: number) => number;
  yAlt: (a: number) => number;
  yGs: (g: number) => number;
  yVs: (v: number) => number;
  plotW: number;
  plotH: number;
}

/** Crosshair with the values at the cursor time (own component: a cursor move re-renders only this). */
function ProfileCursor({ samples, phases, x, yAlt, yGs, yVs, plotW, plotH }: CursorProps) {
  const tMs = useReplayCursor();
  const t = useT();
  const s = sampleAt(samples, tMs);
  if (!s) return null;
  const phase = [...phases].reverse().find((p) => p.timestampMs <= s.tMs);
  const tipX = x(s.tMs);
  const tipLeft = tipX > M.left + plotW - 150;
  return (
    <g pointerEvents="none" aria-hidden="true" className="replay-cursor">
      <line x1={tipX} x2={tipX} y1={M.top} y2={M.top + plotH} className="pc-cross" />
      <circle cx={tipX} cy={yAlt(s.altitudeMslFt)} r={3.5} fill={PROFILE.alt} />
      <circle cx={tipX} cy={yGs(s.groundSpeedKt)} r={3} fill={PROFILE.gs} />
      <circle cx={tipX} cy={yVs(s.verticalSpeedFpm)} r={3} fill={PROFILE.vs} />
      <g transform={`translate(${tipLeft ? tipX - 144 : tipX + 8},${M.top + 4})`}>
        <rect width={136} height={phase ? 78 : 64} rx={6} className="pc-tip" />
        <text x={8} y={16} className="pc-tip-head">
          {clock(s.tMs, true)}
        </text>
        {phase && (
          <text x={8} y={30} className="pc-tip-text">
            {PHASE_LABEL[phase.to]}
          </text>
        )}
        <g transform={`translate(0,${phase ? 14 : 0})`}>
          <text x={8} y={32} className="pc-tip-text" fill={PROFILE.alt}>
            {t("logbook.profile.tipAlt", { alt: fmt(s.altitudeMslFt, 0, "ft") })}
          </text>
          <text x={8} y={46} className="pc-tip-text" fill={PROFILE.gs}>
            GS {fmt(s.groundSpeedKt, 0, "kt")}
          </text>
          <text x={8} y={60} className="pc-tip-text" fill={PROFILE.vs}>
            V/S {fmtSigned(Math.round(s.verticalSpeedFpm), 0, "fpm")}
          </text>
        </g>
      </g>
    </g>
  );
}
