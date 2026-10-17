import { useEffect, useMemo, useState } from "react";
import { NNBSP, fmt, fmtNum } from "../format";
import { BAND_VAR } from "./facts";
import { TRACK_BEFORE_M, pathOf, runwayLayout, sideLabel, type XY } from "./geometry";
import type { LandingAnalysis } from "./types";

/**
 * Top-down runway with the landing direction left → right: runway to scale along its
 * axis (lateral axis stretched when the runway would be too thin to read), threshold
 * stripes, centreline, touchdown zone, the last nm of ground track, touchdown and
 * bounce points and the end of the rollout.
 */
export default function RunwayDiagram({ analysis: a }: { analysis: LandingAnalysis }) {
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    if (!wrap) return;
    const measure = () => setWidth(Math.max(360, Math.floor(wrap.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [wrap]);

  const rwy = a.runway!;
  const tp = a.touchdownPoint!;
  const model = useMemo(() => {
    const pts: Array<XY & { ground: boolean }> = a.samples
      .filter((s) => s.xM != null && s.yM != null)
      .map((s) => ({ x: s.xM!, y: s.yM!, ground: s.onGround }));
    const td = { x: tp.distanceM, y: tp.lateralM };
    const layout = runwayLayout({ lengthM: rwy.lengthM, widthM: rwy.widthM, points: pts, touchdown: td, widthPx: width });
    const visible = pts.filter((p) => p.x >= layout.xMin);
    // airborne part up to the touchdown, ground part from it
    const firstGround = visible.findIndex((p) => p.ground);
    const air = firstGround >= 0 ? [...visible.slice(0, firstGround), td] : visible;
    const ground = firstGround >= 0 ? [td, ...visible.slice(firstGround)] : [];
    return { layout, air, ground, td };
  }, [a.samples, rwy.lengthM, rwy.widthM, tp.distanceM, tp.lateralM, width]);

  const { layout: L, air, ground, td } = model;
  const P = L.toSvg;
  const W = Math.max(rwy.widthM, 10);
  const [rx0, ry0] = P({ x: 0, y: -W / 2 });
  const [rx1, ry1] = P({ x: rwy.lengthM, y: W / 2 });
  const [tdzX0] = P({ x: tp.tdzStartM, y: 0 });
  const [tdzX1] = P({ x: tp.tdzEndM, y: 0 });
  const [tdx, tdy] = P(td);
  const [, cy] = P({ x: 0, y: 0 });
  const rwyH = ry1 - ry0;
  const stripeLen = Math.max(4, 30 * L.xScale);
  const stripeW = Math.max(1.2, ((W - 6) / (L.stripes.length + 1)) * 0.5 * L.yScale);
  const tdColor = BAND_VAR[a.vsBand];
  const rolloutEnd = a.rollout && a.samples.length > 0 ? a.samples[a.samples.length - 1] : null;
  const rolloutXY = rolloutEnd?.xM != null && rolloutEnd.yM != null ? P({ x: rolloutEnd.xM, y: rolloutEnd.yM }) : null;
  const before = Math.round(Math.min(-L.xMin, TRACK_BEFORE_M));
  const designatorSize = Math.min(18, Math.max(10, rwyH * 0.45));
  const exaggerated = L.exaggeration > 1.05;
  // label beside the point when it is off the runway, below the distance marks when on it
  const offRunway = tdy < ry0 - 6 || tdy > ry1 + 6;
  const tdLabelRight = tdx < width - 190;
  const tdLabelX = offRunway ? tdx + (tdLabelRight ? 12 : -12) : tdx;
  const tdLabelY = offRunway ? tdy + 4 : Math.min(L.heightPx - 4, ry1 + 34);
  const tdLabelAnchor = offRunway ? (tdLabelRight ? "start" : "end") : "middle";

  return (
    <div ref={setWrap} className="rd">
      <svg width={width} height={L.heightPx} role="img" aria-label={`Runway ${rwy.ident} von oben mit Aufsetzpunkt ${fmt(tp.distanceM, 0, "m")} hinter der Schwelle, ${sideLabel(tp.lateralM)}`}>
        <defs>
          <clipPath id="rd-clip">
            <rect x={0} y={0} width={width} height={L.heightPx} />
          </clipPath>
        </defs>
        <g clipPath="url(#rd-clip)">
          {/* extended centreline before the threshold */}
          <line x1={P({ x: L.xMin, y: 0 })[0]} x2={rx0} y1={cy} y2={cy} className="rd-ext-centre" />

          {/* runway */}
          <rect x={rx0} y={ry0} width={rx1 - rx0} height={rwyH} className="rd-runway" />
          {/* touchdown zone */}
          <rect x={tdzX0} y={ry0 - 3} width={Math.max(1, tdzX1 - tdzX0)} height={rwyH + 6} className="rd-tdz" />
          <text x={(tdzX0 + tdzX1) / 2} y={ry0 - 8} textAnchor="middle" className="rd-label rd-tdz-label">
            Touchdown-Zone {fmtNum(tp.tdzStartM)}–{fmtNum(tp.tdzEndM)}{NNBSP}m
          </text>
          {/* threshold stripes at both ends */}
          {L.stripes.map((y) => {
            const [, sy] = P({ x: 0, y });
            const [ex] = P({ x: rwy.lengthM, y: 0 });
            return (
              <g key={y}>
                <rect x={rx0 + 2} y={sy - stripeW / 2} width={stripeLen} height={stripeW} className="rd-marking" />
                <rect x={ex - 2 - stripeLen} y={sy - stripeW / 2} width={stripeLen} height={stripeW} className="rd-marking" />
              </g>
            );
          })}
          {/* centreline */}
          <line x1={rx0 + stripeLen + 30} x2={rx1 - stripeLen - 30} y1={cy} y2={cy} className="rd-centre" />
          {/* designators (only when the runway is drawn long enough to hold them) */}
          {rx1 - rx0 > 180 && (
          <>
          <text x={rx0 + stripeLen + 8} y={cy + designatorSize * 0.36} className="rd-designator" style={{ fontSize: designatorSize }}>
            {rwy.ident}
          </text>
          <text
            x={rx1 - stripeLen - 8}
            y={cy + designatorSize * 0.36}
            textAnchor="end"
            className="rd-designator"
            style={{ fontSize: designatorSize }}
            transform={`rotate(180 ${rx1 - stripeLen - 8 - designatorSize * 0.6} ${cy})`}
          >
            {rwy.oppositeIdent}
          </text>
          </>
          )}

          {/* distance marks */}
          {L.ticks.map((d) => {
            const [x] = P({ x: d, y: 0 });
            return (
              <g key={d}>
                <line x1={x} x2={x} y1={ry1 + 2} y2={ry1 + 7} className="rd-tick" />
                <text x={x} y={ry1 + 18} textAnchor="middle" className="rd-label">
                  {fmt(d, 0, "m")}
                </text>
              </g>
            );
          })}
          <text x={rx0} y={ry1 + 18} textAnchor="middle" className="rd-label">
            0
          </text>

          {/* ground track */}
          {air.length > 1 && <path d={pathOf(air, P)} className="rd-track-air" />}
          {ground.length > 1 && <path d={pathOf(ground, P)} className="rd-track-ground" />}

          {/* lateral offset callout */}
          {Math.abs(tp.lateralM) >= 0.5 && <line x1={tdx} x2={tdx} y1={cy} y2={tdy} className="rd-offset" />}

          {/* bounces */}
          {a.bouncePoints.map((b, i) =>
            b.xM != null && b.yM != null ? (
              <circle key={i} cx={P({ x: b.xM, y: b.yM })[0]} cy={P({ x: b.xM, y: b.yM })[1]} r={4} className="rd-bounce" />
            ) : null,
          )}
          {/* rollout end */}
          {rolloutXY && (
            <g>
              <rect x={rolloutXY[0] - 4} y={rolloutXY[1] - 4} width={8} height={8} className="rd-rollout" />
              <text x={rolloutXY[0]} y={ry0 - 8} textAnchor="middle" className="rd-label">
                {fmtNum(a.config.rolloutEndKt)}{NNBSP}kt
              </text>
            </g>
          )}
          {/* touchdown */}
          <circle cx={tdx} cy={tdy} r={7} fill={tdColor} className="rd-td" />
          <text x={tdLabelX} y={tdLabelY} textAnchor={tdLabelAnchor} className="rd-td-label">
            {fmt(tp.distanceM, 0, "m")} · {sideLabel(tp.lateralM)}
          </text>
        </g>
      </svg>
      <div className="rd-legend">
        <span>
          <i className="lg-line lg-air" /> Bodenspur in der Luft (letzte {fmt(before, 0, "m")})
        </span>
        <span>
          <i className="lg-line lg-ground" /> am Boden
        </span>
        <span>
          <i className="lg-dot" style={{ background: tdColor }} /> Aufsetzpunkt
        </span>
        {a.bouncePoints.length > 0 && (
          <span>
            <i className="lg-dot lg-bounce" /> Bounce
          </span>
        )}
        {rolloutXY && (
          <span>
            <i className="lg-square" /> GS unter {fmt(a.config.rolloutEndKt, 0, "kt")}
          </span>
        )}
        <span>
          <i className="lg-box" /> Touchdown-Zone
        </span>
        <span className="rd-scale">
          Längsachse maßstäblich{exaggerated ? ` · Querachse ×${fmtNum(L.exaggeration, L.exaggeration < 10 ? 1 : 0)} überhöht` : " · Querachse maßstäblich"}
        </span>
      </div>
    </div>
  );
}
