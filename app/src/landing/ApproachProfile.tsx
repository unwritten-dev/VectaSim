import { useMemo, useState } from "react";
import { useThemeId } from "../themes";
import { NNBSP, fmt, fmtNum, fmtSigned } from "../format";
import { PROFILE } from "../theme";
import { M_PER_NM, drawWidthM } from "./geometry";
import { niceStep, ticks, useWidth } from "./chartUtils";
import { sampleAt, timeAtValue, useReplayCursor, useReplayStore } from "./replayStore";
import type { ApproachAnalysis, ApproachProfilePoint, MarkerKind } from "./approachTypes";

/**
 * Long approach profile from approach_analysis: height above touchdown (HAT) over the flown
 * distance to go, the reference path as a ±1-dot height band, IAS with the reference-speed
 * line and V/S on two right axes, markers (TOD, 10 nm, FAF, established, gates, threshold,
 * touchdown/go-around), configuration events, a hover readout – and below it a narrow,
 * strongly exaggerated lateral strip (y over the runway axis) with the ±1-dot localizer band.
 */

export type ProfileRange = "final" | "tenNm" | "tod";
export const RANGE_LABEL: Record<ProfileRange, string> = { final: "Final (1000 ft)", tenNm: "10 nm", tod: "ab TOD" };
const RANGES: ProfileRange[] = ["final", "tenNm", "tod"];

const HEIGHT = 300;
const M = { top: 40, right: 96, bottom: 30, left: 56 };
const LAT_H = 104;
const LAT_M = { top: 14, bottom: 22 };

const MARKER_LABEL: Record<MarkerKind, string> = {
  tod: "TOD",
  tenNm: `10${NNBSP}nm`,
  faf: "FAF",
  gate1000: "1000",
  gate500: "500",
  gate50: "50",
  threshold: "Schwelle",
  touchdown: "Aufsetzen",
  goAround: "Durchstarten",
};
const GATE_MARKERS = new Set<MarkerKind>(["gate1000", "gate500", "gate50", "tenNm", "faf"]);

/** Domain of a range in trackDistM: [far, near] (far > near). */
export function rangeDomain(a: ApproachAnalysis, range: ProfileRange): [number, number] {
  const s = a.samples;
  const first = s[0].trackDistM;
  const last = s[s.length - 1].trackDistM;
  const mk = (k: MarkerKind) => a.markers.find((m) => m.kind === k);
  let far: number;
  if (range === "final") {
    const g = mk("gate1000");
    far = g ? g.trackDistM * 1.2 + 300 : 3 * M_PER_NM;
  } else if (range === "tenNm") {
    far = 10.5 * M_PER_NM;
  } else {
    const t = mk("tod");
    far = t ? t.trackDistM + 0.5 * M_PER_NM : first;
  }
  far = Math.min(first, far);
  const near = Math.min(last, far - 200);
  return [far, near];
}

const pathFrom = (pts: Array<[number, number]>) => pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");

export default function ApproachProfile({ a }: { a: ApproachAnalysis }) {
  useThemeId(); // colours come from the active theme
  const [setWrap, width] = useWidth();
  const hasGate1000 = a.markers.some((m) => m.kind === "gate1000");
  const [range, setRange] = useState<ProfileRange>(hasGate1000 ? "final" : "tenNm");
  const store = useReplayStore();

  const model = useMemo(() => {
    const [far, near] = rangeDomain(a, range);
    const vis = a.samples.filter((s) => s.trackDistM <= far + 1 && s.trackDistM >= near - 1);
    if (vis.length < 2) return null;
    let hMax = 0;
    let iasMin = Infinity;
    let iasMax = 0;
    let vsMin = 0;
    let vsMax = 0;
    for (const s of vis) {
      hMax = Math.max(hMax, s.hatFt);
      if (!s.onGround) {
        iasMin = Math.min(iasMin, s.iasKt);
        iasMax = Math.max(iasMax, s.iasKt);
        vsMin = Math.min(vsMin, s.vsFpm);
        vsMax = Math.max(vsMax, s.vsFpm);
      }
    }
    const vapp = a.reference.vappKt;
    if (vapp != null) {
      iasMin = Math.min(iasMin, vapp);
      iasMax = Math.max(iasMax, vapp);
    }
    if (!Number.isFinite(iasMin)) iasMin = 0;
    const hHi = Math.max(range === "final" ? 1100 : 500, hMax * 1.06);
    const iasLo = Math.max(0, Math.floor((iasMin - 15) / 10) * 10);
    const iasHi = Math.ceil((iasMax + 15) / 10) * 10;
    const vsStep = niceStep(Math.max(1500, -vsMin), 3);
    const vsLo = -Math.ceil(Math.max(1500, -vsMin * 1.1) / vsStep) * vsStep;
    const vsHi = Math.max(500, Math.ceil(vsMax / vsStep) * vsStep);
    return { far, near, vis, hHi, iasLo, iasHi, vsLo, vsHi };
  }, [a, range]);

  const switcher = (
    <div className="ac-toolbar">
      <div className="segmented" role="radiogroup" aria-label="Bereich des Anflugprofils">
        {RANGES.map((r) => (
          <button
            key={r}
            role="radio"
            aria-checked={range === r}
            className={range === r ? "active" : ""}
            onClick={() => setRange(r)}
            title={r === "tod" && !a.markers.some((m) => m.kind === "tod") ? "Kein TOD im Track – ganzer aufgezeichneter Anflug" : undefined}
          >
            {RANGE_LABEL[r]}
          </button>
        ))}
      </div>
    </div>
  );

  if (!model) {
    return (
      <div ref={setWrap} className="ac">
        {switcher}
        <p className="detail ac-note">Zu wenige Trackpunkte in diesem Bereich.</p>
      </div>
    );
  }

  const { far, near, vis, hHi, iasLo, iasHi, vsLo, vsHi } = model;
  const plotW = width - M.left - M.right;
  const plotH = HEIGHT - M.top - M.bottom;
  const span = Math.max(1, far - near);
  const x = (d: number) => M.left + ((far - d) / span) * plotW;
  const yH = (h: number) => M.top + plotH - (Math.max(0, h) / hHi) * plotH;
  const yIas = (v: number) => M.top + plotH - ((v - iasLo) / Math.max(1, iasHi - iasLo)) * plotH;
  const yVs = (v: number) => M.top + plotH - ((v - vsLo) / (vsHi - vsLo)) * plotH;

  const air = vis.filter((s) => !s.onGround);
  const altPath = pathFrom(vis.map((s) => [x(s.trackDistM), yH(s.hatFt)]));
  const iasPath = pathFrom(air.map((s) => [x(s.trackDistM), yIas(s.iasKt)]));
  const vsPath = pathFrom(air.map((s) => [x(s.trackDistM), yVs(s.vsFpm)]));

  // reference path ±1 dot as a height band (refHat is proportional to the distance from the aiming point)
  const ref = a.reference;
  const rad = Math.PI / 180;
  const tg = Math.tan(ref.glidepathDeg * rad);
  const ku = Math.tan((ref.glidepathDeg + a.config.gsDotDeg) * rad) / tg;
  const kl = Math.tan((ref.glidepathDeg - a.config.gsDotDeg) * rad) / tg;
  const refPts = vis.filter((s) => s.refHatFt != null && !s.onGround);
  const refPath = refPts.length > 1 ? pathFrom(refPts.map((s) => [x(s.trackDistM), yH(s.refHatFt!)])) : "";
  const bandPath =
    refPts.length > 1
      ? `${pathFrom(refPts.map((s) => [x(s.trackDistM), yH(s.refHatFt! * ku)]))}L${[...refPts]
          .reverse()
          .map((s) => `${x(s.trackDistM).toFixed(1)},${yH(s.refHatFt! * kl).toFixed(1)}`)
          .join("L")}Z`
      : "";

  // markers incl. "established", labels staggered when they crowd
  type Mk = { key: string; label: string; d: number; h: number; gate: boolean; td: boolean };
  const marks: Mk[] = a.markers
    .filter((m) => m.trackDistM <= far + 1 && m.trackDistM >= near - 1)
    .map((m, i) => ({ key: `${m.kind}${i}`, label: MARKER_LABEL[m.kind], d: m.trackDistM, h: m.hatFt, gate: GATE_MARKERS.has(m.kind), td: m.kind === "touchdown" || m.kind === "goAround" }));
  if (a.established && a.established.trackDistM <= far && a.established.trackDistM >= near) {
    marks.push({ key: "est", label: "eingedreht", d: a.established.trackDistM, h: a.established.hatFt, gate: false, td: false });
  }
  marks.sort((p, q) => q.d - p.d);
  const rows: number[] = [];
  marks.forEach((m, i) => {
    const prev = i > 0 ? marks[i - 1] : null;
    rows.push(prev && x(m.d) - x(prev.d) < 56 ? (rows[i - 1] + 1) % 3 : 0);
  });

  const cfgEvents = a.configEvents.filter((e) => e.trackDistM <= far && e.trackDistM >= near);

  const hTicks = ticks(0, hHi, 5);
  const nmSpan = span / M_PER_NM;
  const nmStep = nmSpan > 12 ? 2 : nmSpan > 6 ? 1 : nmSpan > 2.5 ? 0.5 : 0.25;
  const dTicks: number[] = [];
  for (let v = Math.ceil(near / M_PER_NM / nmStep) * nmStep; v <= far / M_PER_NM + 1e-9; v += nmStep) dTicks.push(Math.round(v * 100) / 100);
  const iasTicks = ticks(iasLo, iasHi, 4);
  const vsTicks = ticks(vsLo, vsHi, 4);
  const axisLabel =
    a.trackDistRef === "threshold"
      ? "Flugweg bis zur Schwelle (nm)"
      : a.trackDistRef === "touchdown"
        ? "Flugweg bis zum Aufsetzpunkt (nm)"
        : "Flugweg bis zum tiefsten Punkt (nm)";

  const timeAt = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const d = far - ((e.clientX - rect.left) / rect.width) * span;
    return timeAtValue(vis, (s) => s.trackDistM, d);
  };
  const scales = { x, yH, yIas, yVs, plotW, plotH };

  const vapp = ref.vappKt;
  return (
    <div ref={setWrap} className="ac">
      {switcher}
      <div className="profile-legend">
        <span style={{ color: PROFILE.alt }}>━ Höhe über Aufsetzpunkt (ft)</span>
        {bandPath && (
          <span className="ac-ref">
            ┅ {fmt(ref.glidepathDeg, 0, "°")}-Pfad{ref.glidepathSource === "assumed" ? " (Annahme)" : ""} ±1{NNBSP}Dot
          </span>
        )}
        <span style={{ color: PROFILE.gs }}>━ IAS (kt){vapp != null ? ` · ┅ Referenz ${fmt(vapp, 0, "kt")}${ref.vappSource === "flown" ? " (geflogen)" : ""}` : ""}</span>
        <span style={{ color: PROFILE.vs }}>━ V/S (fpm)</span>
      </div>
      <svg width={width} height={HEIGHT} role="img" aria-label={`Anflugprofil (${RANGE_LABEL[range]}): Höhe, IAS und Sinkrate über dem Flugweg`}>
        <defs>
          <clipPath id="ap-clip">
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
          {axisLabel}
        </text>
        <line x1={M.left} x2={M.left + plotW} y1={M.top + plotH} y2={M.top + plotH} className="pc-axis" />

        <g clipPath="url(#ap-clip)">
          {bandPath && <path d={bandPath} className="ac-band" />}
          {refPath && <path d={refPath} className="ac-refline" />}
          {vapp != null && <line x1={M.left} x2={M.left + plotW} y1={yIas(vapp)} y2={yIas(vapp)} stroke={PROFILE.gs} strokeDasharray="5 4" strokeWidth={1} opacity={0.7} />}
          <path d={vsPath} fill="none" stroke={PROFILE.vs} strokeWidth={1.2} opacity={0.85} />
          <path d={iasPath} fill="none" stroke={PROFILE.gs} strokeWidth={1.2} opacity={0.9} />
          <path d={altPath} fill="none" stroke={PROFILE.alt} strokeWidth={2} />
          {cfgEvents.map((e, i) => (
            <g key={`c${i}`}>
              <path d={`M${x(e.trackDistM) - 4},${M.top + plotH}L${x(e.trackDistM) + 4},${M.top + plotH}L${x(e.trackDistM)},${M.top + plotH - 7}Z`} className="ac-cfg" />
              <text x={x(e.trackDistM)} y={M.top + plotH - 10} textAnchor="middle" className="pc-phase-label">
                {e.kind === "flaps" ? `K${fmtNum(e.flapsTo)}` : e.kind === "gearDown" ? "FW↓" : "FW↑"}
              </text>
            </g>
          ))}
        </g>

        {marks.map((m, i) => (
          <g key={m.key}>
            <line
              x1={x(m.d)}
              x2={x(m.d)}
              y1={M.top}
              y2={M.top + plotH}
              className={m.gate ? "ac-gate" : "ac-marker"}
              stroke={m.td ? PROFILE.touchdown : undefined}
            />
            {m.gate && <circle cx={x(m.d)} cy={yH(m.h)} r={3.5} fill={PROFILE.alt} />}
            <text x={x(m.d) + 3} y={M.top - 28 + rows[i] * 11} className={m.td ? "pc-td-label" : "pc-phase-label"}>
              {m.label}
            </text>
          </g>
        ))}

        <ProfileCursor a={a} vis={vis} scales={scales} />
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
      {a.runway && a.trackDistRef === "threshold" && <LateralStrip a={a} far={far} near={near} width={width} />}
    </div>
  );
}

/** Lateral offset (y) over the distance before the threshold (−x), strongly exaggerated. */
function LateralStrip({ a, far, near, width }: { a: ApproachAnalysis; far: number; near: number; width: number }) {
  const rwy = a.runway!;
  const plotW = width - M.left - M.right;
  const plotH = LAT_H - LAT_M.top - LAT_M.bottom;
  const span = Math.max(1, far - near);
  const x = (d: number) => M.left + ((far - d) / span) * plotW;
  const pts = a.samples.filter((s) => s.xM != null && s.yM != null && -s.xM! <= far + 1 && -s.xM! >= near - 1);
  const finalPts = pts.filter((s) => s.onFinal);
  const maxY = finalPts.reduce((m, s) => Math.max(m, Math.abs(s.yM!)), 0);
  const cap = Math.max(60, Math.min(500, Math.ceil((maxY * 1.3) / 10) * 10));
  const cy = LAT_M.top + plotH / 2;
  // + = right of the centreline, drawn below it (top view, flying left to right)
  const y = (m: number) => cy + (m / cap) * (plotH / 2);
  const dotAt = (d: number) => a.config.locDotMAtThreshold * ((d + rwy.lengthM + a.config.locAntennaBeyondEndM) / (rwy.lengthM + a.config.locAntennaBeyondEndM));
  const n = 32;
  const bandTo = Math.max(near, -rwy.lengthM);
  const ds = Array.from({ length: n + 1 }, (_, i) => far + ((bandTo - far) * i) / n);
  const band = `${pathFrom(ds.map((d) => [x(d), y(-dotAt(d))]))}L${[...ds]
    .reverse()
    .map((d) => `${x(d).toFixed(1)},${y(dotAt(d)).toFixed(1)}`)
    .join("L")}Z`;
  const air = pts.filter((s) => !s.onGround);
  const ground = pts.filter((s) => s.onGround);
  const exaggeration = span / plotW / ((2 * cap) / plotH);
  const step = niceStep(cap, 1);
  const rx0 = x(Math.min(far, 0));
  const rx1 = x(Math.max(near, -rwy.lengthM));
  const half = Math.max(1.5, (drawWidthM(rwy.widthM) / 2 / cap) * (plotH / 2));

  return (
    <svg width={width} height={LAT_H} className="ac-lateral" role="img" aria-label="Querablage zur verlängerten Mittellinie über der Distanz zur Schwelle, stark überhöht">
      <defs>
        <clipPath id="ap-lat-clip">
          <rect x={M.left} y={LAT_M.top} width={plotW} height={plotH} />
        </clipPath>
      </defs>
      <rect x={M.left} y={LAT_M.top} width={plotW} height={plotH} className="ac-lat-bg" />
      <g clipPath="url(#ap-lat-clip)">
        <path d={band} className="ac-band" />
        {rx1 > rx0 && <rect x={rx0} y={cy - half} width={rx1 - rx0} height={half * 2} className="ac-lat-runway" />}
        <line x1={M.left} x2={M.left + plotW} y1={cy} y2={cy} className="ac-refline" />
        {air.length > 1 && <path d={pathFrom(air.map((s) => [x(-s.xM!), y(s.yM!)]))} fill="none" stroke={PROFILE.alt} strokeWidth={1.8} />}
        {ground.length > 1 && <path d={pathFrom(ground.map((s) => [x(-s.xM!), y(s.yM!)]))} fill="none" stroke={PROFILE.touchdown} strokeWidth={1.5} strokeDasharray="4 3" />}
        <LateralCursor pts={pts} x={x} y={y} top={LAT_M.top} bottom={LAT_M.top + plotH} />
      </g>
      {[-step, 0, step].map((v) => (
        <text key={v} x={M.left - 6} y={y(v) + 4} textAnchor="end" className="pc-tick">
          {v === 0 ? "0" : `${fmtNum(Math.abs(v))}${v < 0 ? " L" : " R"}`}
        </text>
      ))}
      <text x={M.left} y={LAT_H - 6} className="pc-tick">
        Querablage (m) zur verlängerten Mittellinie RWY {rwy.ident} · ┅ ±1{NNBSP}Dot Kurs · Querachse ×{fmtNum(exaggeration, exaggeration < 10 ? 1 : 0)}
      </text>
    </svg>
  );
}

type Scales = { x: (d: number) => number; yH: (h: number) => number; yIas: (v: number) => number; yVs: (v: number) => number; plotW: number; plotH: number };

const gearText = (g: number) => (g >= 95 ? "aus" : g <= 5 ? "ein" : `${fmtNum(g)}${NNBSP}%`);

/**
 * The shared cursor in the profile: vertical line with the values at that time (interpolated
 * between the 1 Hz samples). Its own component, so a playback frame re-renders only this.
 */
function ProfileCursor({ a, vis, scales }: { a: ApproachAnalysis; vis: ApproachProfilePoint[]; scales: Scales }) {
  const tMs = useReplayCursor();
  const hs = sampleAt(vis, tMs);
  if (!hs) return null;
  const { x, yH, yIas, yVs, plotW, plotH } = scales;
  const tipX = x(hs.trackDistM);
  const tipW = 236;
  const tipLeft = tipX > M.left + plotW - tipW - 10;
  const tipRows: Array<[string, string]> = [
    [PROFILE.alt, `Höhe ${fmt(hs.hatFt, 0, "ft")}${hs.altDevFt != null ? ` (${fmtSigned(Math.round(hs.altDevFt), 0, "ft")} zum Pfad)` : ""}`],
    [PROFILE.gs, `IAS ${fmt(hs.iasKt, 0, "kt")}${hs.iasDevKt != null ? ` (${fmtSigned(hs.iasDevKt, 0, "kt")})` : ""} · GS ${fmt(hs.groundSpeedKt, 0, "kt")}`],
    [PROFILE.vs, `V/S ${fmtSigned(Math.round(hs.vsFpm), 0, "fpm")}`],
    ...(hs.gsDots != null || hs.locDots != null
      ? [["var(--text-muted)", `Gleitpfad ${fmtSigned(hs.gsDots, 1)} · Kurs ${fmtSigned(hs.locDots, 1)}${NNBSP}Dots`] as [string, string]]
      : []),
    ["var(--text-muted)", `Klappen ${fmtNum(Math.round(hs.flapsIndex))} · Fahrwerk ${gearText(hs.gearPct)}${hs.onGround ? " · am Boden" : ""}`],
  ];
  return (
    <g pointerEvents="none" aria-hidden="true" className="replay-cursor">
      <line x1={tipX} x2={tipX} y1={M.top} y2={M.top + plotH} className="pc-cross" />
      <circle cx={tipX} cy={yH(hs.hatFt)} r={3.5} fill={PROFILE.alt} />
      {!hs.onGround && <circle cx={tipX} cy={yIas(hs.iasKt)} r={3} fill={PROFILE.gs} />}
      {!hs.onGround && <circle cx={tipX} cy={yVs(hs.vsFpm)} r={3} fill={PROFILE.vs} />}
      <g transform={`translate(${tipLeft ? tipX - tipW - 8 : tipX + 8},${M.top + 4})`}>
        <rect width={tipW} height={22 + tipRows.length * 14} rx={6} className="pc-tip" />
        <text x={8} y={16} className="pc-tip-head">
          {fmt(Math.abs(hs.trackDistM) / M_PER_NM, 2, "nm")} {hs.trackDistM >= 0 ? "vor" : "nach"}{" "}
          {a.trackDistRef === "threshold" ? "der Schwelle" : a.trackDistRef === "touchdown" ? "dem Aufsetzpunkt" : "dem tiefsten Punkt"}
        </text>
        {tipRows.map(([c, t], i) => (
          <text key={i} x={8} y={31 + i * 14} className="pc-tip-text" fill={c}>
            {t}
          </text>
        ))}
      </g>
    </g>
  );
}

/** Cursor in the lateral strip: point on the track and a vertical helper line. */
function LateralCursor({ pts, x, y, top, bottom }: { pts: ApproachProfilePoint[]; x: (d: number) => number; y: (m: number) => number; top: number; bottom: number }) {
  const tMs = useReplayCursor();
  const p = sampleAt(pts, tMs);
  if (!p || p.xM == null || p.yM == null) return null;
  const cx = x(-p.xM);
  return (
    <g pointerEvents="none" aria-hidden="true" className="replay-cursor">
      <line x1={cx} x2={cx} y1={top} y2={bottom} className="pc-cross" />
      <circle cx={cx} cy={y(p.yM)} r={3.5} fill={PROFILE.alt} />
    </g>
  );
}
