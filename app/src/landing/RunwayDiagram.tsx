import { useEffect, useMemo, useState } from "react";
import { NNBSP, fmt, fmtNum } from "../i18n/number";
import { useT } from "../i18n";
import { BAND_VAR, isDerivedRunway, lateralMeasurable, touchdownDistanceText, zoneText } from "./facts";
import { cardExaggeration, designatorPx, showDesignator } from "./LandingCard";
import { TRACK_BEFORE_M, drawWidthM, pathOf, runwayLayout, sideLabel, type XY } from "./geometry";
import { sampleAt, timeAtValue, useReplayCursor, useReplayStore } from "./replayStore";
import type { ApproachPoint, LandingAnalysis } from "./types";

/**
 * Top-down runway with the landing direction left → right: runway to scale along its
 * axis (lateral axis stretched when the runway would be too thin to read), threshold
 * stripes, centreline, touchdown zone (from the threshold) with the aiming-point
 * marking, the last nm of ground track, touchdown and bounce points and the end of the
 * rollout. An unknown width is drawn as 30 m and said so in the legend. The lateral
 * exaggeration is the landing card's (cardExaggeration), so both pictures match.
 */
export default function RunwayDiagram({ analysis: a }: { analysis: LandingAnalysis }) {
  const t = useT();
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

  const store = useReplayStore();
  const rwy = a.runway!;
  const tp = a.touchdownPoint!;
  /** Samples in the runway frame (for the shared cursor). */
  const framed = useMemo(() => a.samples.filter((s) => s.xM != null && s.yM != null), [a.samples]);
  const exaggeration = useMemo(() => cardExaggeration(a) ?? undefined, [a]);
  const model = useMemo(() => {
    const pts: Array<XY & { ground: boolean }> = a.samples
      .filter((s) => s.xM != null && s.yM != null)
      .map((s) => ({ x: s.xM!, y: s.yM!, ground: s.onGround }));
    const td = { x: tp.distanceM, y: tp.lateralM };
    const layout = runwayLayout({ lengthM: rwy.lengthM, widthM: drawWidthM(rwy.widthM), points: pts, touchdown: td, widthPx: width, exaggeration });
    const visible = pts.filter((p) => p.x >= layout.xMin);
    // airborne part up to the touchdown, ground part from it
    const firstGround = visible.findIndex((p) => p.ground);
    const air = firstGround >= 0 ? [...visible.slice(0, firstGround), td] : visible;
    const ground = firstGround >= 0 ? [td, ...visible.slice(firstGround)] : [];
    return { layout, air, ground, td };
  }, [a.samples, rwy.lengthM, rwy.widthM, tp.distanceM, tp.lateralM, width, exaggeration]);

  const { layout: L, air, ground, td } = model;
  const P = L.toSvg;
  const W = Math.max(drawWidthM(rwy.widthM), 10);
  const [rx0, ry0] = P({ x: 0, y: -W / 2 });
  const [rx1, ry1] = P({ x: rwy.lengthM, y: W / 2 });
  const [tdzX0] = P({ x: tp.tdzStartM, y: 0 });
  const [tdzX1] = P({ x: tp.tdzEndM, y: 0 });
  const [aimX] = P({ x: tp.aimingPointM, y: 0 });
  const aimLen = Math.max(3, 45 * L.xScale);
  const [tdx, tdy] = P(td);
  const [, cy] = P({ x: 0, y: 0 });
  const rwyH = ry1 - ry0;
  const stripeLen = Math.max(4, 30 * L.xScale);
  const stripeW = Math.max(1.2, ((W - 6) / (L.stripes.length + 1)) * 0.5 * L.yScale);
  const tdColor = BAND_VAR[a.vsBand];
  const rolloutEnd = a.rollout && a.samples.length > 0 ? a.samples[a.samples.length - 1] : null;
  const rolloutXY = rolloutEnd?.xM != null && rolloutEnd.yM != null ? P({ x: rolloutEnd.xM, y: rolloutEnd.yM }) : null;
  const before = Math.round(Math.min(-L.xMin, TRACK_BEFORE_M));
  const designatorSize = designatorPx(rwyH);
  // designators sit right after the threshold stripes, rotated like the painted marking
  // (read from the approach), and are drawn over the track with a halo – never under it
  const desX0 = rx0 + stripeLen + 6 + designatorSize * 0.5;
  const desX1 = rx1 - stripeLen - 6 - designatorSize * 0.5;
  const exaggerated = L.exaggeration > 1.05;
  // label beside the point when it is off the runway, below the distance marks when on it
  const offRunway = tdy < ry0 - 6 || tdy > ry1 + 6;
  const tdLabelRight = tdx < width - 190;
  const tdLabelX = offRunway ? tdx + (tdLabelRight ? 12 : -12) : tdx;
  const tdLabelY = offRunway ? tdy + 4 : Math.min(L.heightPx - 4, ry1 + 34);
  const tdLabelAnchor = offRunway ? (tdLabelRight ? "start" : "end") : "middle";
  // pointer → runway x → the time the track passed it
  const timeAt = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / Math.max(1, rect.width)) * width;
    const xm = (px - P({ x: 0, y: 0 })[0]) / L.xScale;
    return timeAtValue(framed, (s) => s.xM, xm);
  };

  return (
    <div ref={setWrap} className="rd">
      <svg
        width={width}
        height={L.heightPx}
        className="replay-hit"
        onMouseMove={(e) => store.hover(timeAt(e))}
        onMouseLeave={() => store.hover(null)}
        onClick={(e) => {
          store.pause();
          store.setCursor(timeAt(e));
        }}
        role="img"
        aria-label={t("runwayDiagram.aria", { ident: rwy.ident, distance: touchdownDistanceText(tp), lateral: lateralMeasurable(tp) ? sideLabel(tp.lateralM) : t("runwayDiagram.lateralNone") })}>
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
            {t("runwayDiagram.tdzLabel", { zone: zoneText(tp, rwy) })}
          </text>
          {/* aiming-point marking: two bars beside the centreline (named in the legend, labels below are taken) */}
          <g className="rd-aim">
            <title>{t("runwayDiagram.aimTitle", { aim: fmt(tp.aimingPointM, 0, "m") })}</title>
            {[-1, 1].map((s) => (
              <rect key={s} x={aimX} y={s < 0 ? cy - rwyH * 0.36 : cy + rwyH * 0.22} width={aimLen} height={rwyH * 0.14} className="rd-marking" />
            ))}
          </g>
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
          {lateralMeasurable(tp) && Math.abs(tp.lateralM) >= 0.5 && <line x1={tdx} x2={tdx} y1={cy} y2={tdy} className="rd-offset" />}

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
          {/* designators (only when the runway is drawn large enough to hold them) */}
          {showDesignator(rx1 - rx0, rwyH) && (
            <g className="rd-designators" style={{ fontSize: designatorSize }}>
              <text x={desX0} y={cy} transform={`rotate(90 ${desX0} ${cy})`} textAnchor="middle" dominantBaseline="central" className="rd-designator">
                {rwy.ident}
              </text>
              <text x={desX1} y={cy} transform={`rotate(-90 ${desX1} ${cy})`} textAnchor="middle" dominantBaseline="central" className="rd-designator">
                {rwy.oppositeIdent}
              </text>
            </g>
          )}
          {/* touchdown */}
          <circle cx={tdx} cy={tdy} r={7} fill={tdColor} className="rd-td" />
          <text x={tdLabelX} y={tdLabelY} textAnchor={tdLabelAnchor} className="rd-td-label">
            {touchdownDistanceText(tp)}
            {lateralMeasurable(tp) ? ` · ${sideLabel(tp.lateralM)}` : ""}
          </text>
          <RunwayCursor samples={framed} xMin={L.xMin} toSvg={P} height={L.heightPx} />
        </g>
      </svg>
      <div className="rd-legend">
        <span>
          <i className="lg-line lg-air" /> {t("runwayDiagram.legend.air", { distance: fmt(before, 0, "m") })}
        </span>
        <span>
          <i className="lg-line lg-ground" /> {t("runwayDiagram.legend.ground")}
        </span>
        <span>
          <i className="lg-dot" style={{ background: tdColor }} /> {t("runwayDiagram.legend.touchdown")}
        </span>
        {a.bouncePoints.length > 0 && (
          <span>
            <i className="lg-dot lg-bounce" /> {t("runwayDiagram.legend.bounce")}
          </span>
        )}
        {rolloutXY && (
          <span>
            <i className="lg-square" /> {t("runwayDiagram.legend.rollout", { speed: fmt(a.config.rolloutEndKt, 0, "kt") })}
          </span>
        )}
        <span>
          <i className="lg-box" /> {t("runwayDiagram.legend.tdz")}
        </span>
        <span>
          <i className="lg-aim" /> {t("runwayDiagram.legend.aim", { aim: fmt(tp.aimingPointM, 0, "m") })}
        </span>
        {rwy.widthM == null && <span>{t("runwayDiagram.legend.widthUnknown", { width: fmt(drawWidthM(null), 0, "m") })}</span>}
        {isDerivedRunway(rwy) && (
          <span title={t("runwayDiagram.legend.derivedTitle")}>
            {t(rwy.lengthEstimated ? "runwayDiagram.legend.derivedNoEnd" : "runwayDiagram.legend.derived", {
              uncertainty: fmt(tp.distanceUncertaintyM ?? rwy.alongUncertaintyM ?? 50, 0, "m"),
            })}
          </span>
        )}
        <span className="rd-scale">
          {exaggerated
            ? t("runwayDiagram.legend.scaleExaggerated", { factor: fmtNum(L.exaggeration, L.exaggeration < 10 ? 1 : 0) })
            : t("runwayDiagram.legend.scaleTrue")}
        </span>
      </div>
    </div>
  );
}

/** The shared cursor on the runway: the aircraft's point on the track and a helper line across. */
function RunwayCursor({ samples, xMin, toSvg, height }: { samples: ApproachPoint[]; xMin: number; toSvg: (p: XY) => [number, number]; height: number }) {
  const tMs = useReplayCursor();
  const p = sampleAt(samples, tMs);
  if (!p || p.xM == null || p.yM == null || p.xM < xMin) return null;
  const [cx, cy] = toSvg({ x: p.xM, y: p.yM });
  return (
    <g pointerEvents="none" aria-hidden="true" className="replay-cursor">
      <line x1={cx} x2={cx} y1={0} y2={height} className="pc-cross" />
      <circle cx={cx} cy={cy} r={5} className="rd-cursor" />
    </g>
  );
}
