// Landing card ("Landekarte"): the shareable summary of one landing as a fixed 1200×675 (16:9) SVG,
// rasterised to PNG by exportCard.ts. Pure: it needs only LandingDebriefData and a colour
// set, so it renders the same in the app, in renderToStaticMarkup (tests) and as a
// serialised SVG image.
//
// Colours: a serialised SVG drawn as an <img> knows nothing of the page's CSS variables,
// so every colour is a concrete value from `CardTheme` (readCardTheme() resolves the
// active theme's variables via getComputedStyle). No `var(--…)` anywhere in this file.
//
// Fonts: an SVG loaded as an image is sandboxed and cannot see the page's @font-face web
// fonts. exportCard.ts therefore passes `fontCss`: @font-face rules of the active theme's
// sans + num faces (latin subset, WOFF2 as data: URLs, fetched once from the bundled
// Fontsource files and cached; cardFonts.ts). Without it (tests, a failed fetch)
// `font-family` falls back to the system stack of themes.ts ("Segoe UI Variable",
// system-ui / "Cascadia Mono", Consolas); the layout leaves enough slack for those metrics.
//
// Brand: the footer carries the real lockup (mark + "VectaSim" outlines, ui/Logo.tsx), the
// runway geometry shares its lateral exaggeration with the debrief (cardExaggeration).

import { maskRegistration, maskTitle } from "../format";
import { useT, type TFunction } from "../i18n";
import { NNBSP, fmt, fmtDateTime, fmtNum, fmtWind } from "../i18n/number";
import { activeTheme, themeVars } from "../themes";
import { LogoLockup, lockupWidth } from "../ui/Logo";
import { providerLabel } from "../status";
import {
  BAND_LABEL,
  BAND_SHAPE,
  SOURCE_LABEL,
  approachCardLine,
  degNum,
  isDerivedRunway,
  keySentence,
  lateralMeasurable,
  metarAgeNote,
  provenance,
  runwaySourceOf,
  touchdownDistanceText,
  windComponentsText,
  zonePhrase,
  zoneText,
  type SourceKind,
} from "./facts";
import { M_PER_FT, M_PER_NM, drawWidthM, pathOf, referenceHeightFt, runwayLayout, sideLabel, type XY } from "./geometry";
import type { ApproachAnalysis } from "./approachTypes";
import type { Band, LandingAnalysis, LandingDebriefData } from "./types";
import { ShapeMark } from "./BandMark";
import { isRated } from "./rated";

export const CARD_W = 1200;
export const CARD_H = 675;

export interface CardTheme {
  bg: string;
  surface1: string;
  surface2: string;
  surface3: string;
  border: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  ok: string;
  warn: string;
  err: string;
  ownAircraft: string;
  bandSoft: string;
  bandNormal: string;
  bandFirm: string;
  bandHard: string;
  /** Logo trace (fixed brand cyan per scheme). */
  brandTrace: string;
  fontSans: string;
  fontNum: string;
  /** Letter spacing of caps labels ("0.14em"). */
  labelLs: string;
  /** Corner radius of panels ("3px"). */
  radius: string;
  /** Not a CSS variable: light/dark decides the logo's ink ring. */
  scheme: "dark" | "light";
}

type CssKey = Exclude<keyof CardTheme, "scheme">;

const VAR_OF: Record<CssKey, string> = {
  bg: "--bg",
  surface1: "--surface-1",
  surface2: "--surface-2",
  surface3: "--surface-3",
  border: "--border",
  text: "--text",
  textMuted: "--text-muted",
  textFaint: "--text-faint",
  accent: "--accent",
  ok: "--ok",
  warn: "--warn",
  err: "--err",
  ownAircraft: "--own-aircraft",
  bandSoft: "--band-soft",
  bandNormal: "--band-normal",
  bandFirm: "--band-firm",
  bandHard: "--band-hard",
  brandTrace: "--brand-trace",
  fontSans: "--font-sans",
  fontNum: "--font-num",
  labelLs: "--label-ls",
  radius: "--r-lg",
};

/** Colours/fonts of the active theme from its definition (no DOM needed). */
export function themeCardColors(): CardTheme {
  const t = activeTheme();
  const v = themeVars(t);
  const out = { scheme: t.scheme } as CardTheme;
  for (const k of Object.keys(VAR_OF) as CssKey[]) out[k] = v[VAR_OF[k]];
  return out;
}

/** The CSS variables as they are applied on <html> right now, as concrete values. */
export function readCardTheme(): CardTheme {
  const base = themeCardColors();
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return base;
  const cs = getComputedStyle(document.documentElement);
  for (const k of Object.keys(VAR_OF) as CssKey[]) {
    const val = cs.getPropertyValue(VAR_OF[k]).trim();
    // a value that still references another variable cannot be used inside the image
    if (val && !val.includes("var(")) base[k] = val;
  }
  return base;
}

const bandColor = (t: CardTheme, b: Band) => ({ smooth: t.bandSoft, normal: t.bandNormal, firm: t.bandFirm, hard: t.bandHard })[b];
const px = (v: string, fallback: number) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Legend separator, as in the app's legends. */
const SEP = "  ·  ";
/** Runway designator size (shared with RunwayDiagram): the rotated text must fit across the runway. */
export const designatorPx = (rwyH: number) => Math.min(18, Math.max(10, (rwyH - 8) / 1.9));
export const showDesignator = (rwyLenPx: number, rwyH: number) => rwyLenPx > 120 && rwyH >= 24;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---- layout constants ----------------------------------------------------------------
const PAD = 48;
const INNER = CARD_W - 2 * PAD;
const TILE_Y = 156;
const TILE_H = 118;
const RWY_Y = 292;
const RWY_H = 202;
const PROF_Y = 508;
const PROF_H = 112;
const FOOT_Y = 654;
/** Lockup height (wordmark ≥ 20 px, docs/brand/README.md). */
const LOCKUP_H = 24;

/** With an approach line the runway panel and the profile move up by this much. */
const APPROACH_LINE_H = 20;

interface Props {
  data: LandingDebriefData;
  colors: CardTheme;
  /** The landing's approach (approach_analysis): one summary line under the profile. Go-arounds get no card. */
  approach?: ApproachAnalysis | null;
  /** @font-face rules with embedded WOFF2 (cardFonts.ts); omitted → system fonts. */
  fontCss?: string | null;
  /** Streamer-Modus / „ohne Kennzeichen“: registration as "D-••••". */
  hideReg?: boolean;
}

/** Lateral exaggeration of the card's runway drawing; the debrief (RunwayDiagram) uses the same. */
export function cardExaggeration(a: LandingAnalysis): number | null {
  if (!a.runway || !a.touchdownPoint) return null;
  return runwayTopLayout(a, RWY_H).exaggeration;
}

function runwayTopLayout(a: LandingAnalysis, panelH: number) {
  const rwy = a.runway!;
  const tp = a.touchdownPoint!;
  const pts: Array<XY & { ground: boolean }> = a.samples.filter((s) => s.xM != null && s.yM != null).map((s) => ({ x: s.xM!, y: s.yM!, ground: s.onGround }));
  const tdXY = { x: tp.distanceM, y: tp.lateralM };
  const innerH = panelH - 30;
  const L = runwayLayout({ lengthM: rwy.lengthM, widthM: drawWidthM(rwy.widthM), points: pts, touchdown: tdXY, widthPx: INNER, minHeightPx: innerH, maxHeightPx: innerH });
  return Object.assign(L, { pts, tdXY });
}

export default function LandingCard({ data: d, colors: t, approach, fontCss, hideReg = false }: Props) {
  // `t` is the card theme here; texts follow the UI language (exportCard renders without a provider pin)
  const tr = useT();
  const line = approach && approach.outcome.kind !== "goAround" ? approachCardLine(approach) : null;
  const rwyH = line ? RWY_H - APPROACH_LINE_H : RWY_H;
  const profY = line ? PROF_Y - APPROACH_LINE_H : PROF_Y;
  const a = d.analysis;
  const td = a.touchdown;
  const rwy = a.runway;
  const tp = a.touchdownPoint;
  const f = d.flight;
  const src = provenance(d);
  const icao = rwy?.airport ?? d.airport?.ident ?? null;

  const aircraft = f?.aircraft;
  const rawType = aircraft?.title || aircraft?.atcType || tr("landingCard.unknownAircraft");
  const rawReg = f?.airframeReg || aircraft?.atcId || null;
  const reg = rawReg && hideReg ? maskRegistration(rawReg) : rawReg;
  // the sim title often carries livery and registration ("A320neo Lufthansa D-AINA")
  const type = hideReg ? maskTitle(rawType, { registration: rawReg, airline: aircraft?.atcAirline, callsign: f?.callsign }, true) : rawType;
  const sim = f?.simName || (f?.provider ? providerLabel(f.provider) : null);
  const meta = [clip(type, 36), reg, sim].filter(Boolean).join(" · ");

  const sans = { fontFamily: t.fontSans };
  const num = { fontFamily: t.fontNum };
  const measurable = tp ? lateralMeasurable(tp) : false;
  const lateral = tp && measurable ? Math.abs(tp.lateralM) : null;
  const zone = zonePhrase(a);
  const uncertainty = tp?.distanceUncertaintyM ?? null;
  const derived = isDerivedRunway(rwy);

  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={CARD_W} height={CARD_H} viewBox={`0 0 ${CARD_W} ${CARD_H}`} role="img" aria-label={tr("landingCard.aria", { where: `${icao ?? ""} ${rwy ? `RWY ${rwy.ident}` : ""}`.trim() }).trim()}>
      {fontCss && (
        <defs>
          <style>{fontCss}</style>
        </defs>
      )}
      <rect x={0} y={0} width={CARD_W} height={CARD_H} fill={t.bg} />
      <rect x={0} y={0} width={CARD_W} height={4} fill={t.accent} />

      {/* head */}
      <text x={PAD} y={92} fill={t.text} fontSize={40} fontWeight={650} style={sans}>
        {icao ?? tr("landingCard.landing")}
        {rwy && (
          <tspan fill={t.text} fontWeight={550}>
            {"  "}RWY {rwy.ident}
          </tspan>
        )}
      </text>
      <text x={PAD} y={128} fill={t.textMuted} fontSize={18} style={sans}>
        {clip([d.airport?.name, keySentence(d)].filter(Boolean).join(" · "), 110)}
      </text>
      <text x={CARD_W - PAD} y={70} textAnchor="end" fill={t.text} fontSize={20} style={num}>
        {fmtDateTime(td.timestampMs, { local: false })}
      </text>
      <text x={CARD_W - PAD} y={98} textAnchor="end" fill={t.textMuted} fontSize={17} style={sans}>
        {meta}
      </text>

      {/* four key numbers */}
      <Tile
        i={0}
        t={t}
        label={tr("landingCard.rate")}
        // unrated (slewed / fast-forwarded down): no number, no band – "nicht bewertbar" below
        value={isRated(td) ? fmt(td.landingRateFpm, 0) : "–"}
        unit="fpm"
        source={src.rate.kind}
        band={isRated(td) ? a.vsBand : undefined}
        sub={isRated(td) ? `${BAND_LABEL[a.vsBand]} · ${td.landingRateSource === "sim" ? tr("landingCard.simValue") : tr("landingCard.measured")}` : tr("band.unrated")}
      />
      <Tile i={1} t={t} label={tr("landingCard.gPeak")} value={fmt(td.peakG, 2)} unit="g" source={src.g.kind} band={a.gBand} sub={`${BAND_LABEL[a.gBand]} · ${td.bounces ? tr("count.bounces", { count: td.bounces }) : tr("facts.key.noBounce")}`} />
      <Tile
        i={2}
        t={t}
        label={tr("landingCard.fromThreshold")}
        value={tp ? fmt(tp.distanceM, 0) : "–"}
        unit={uncertainty != null && uncertainty > 0 ? `± ${fmtNum(uncertainty, 0)}${NNBSP}m` : "m"}
        source="derived"
        sub={zone ? (derived ? tr("landingCard.derivedSuffix", { zone }) : zone) : tr("landingCard.noRunway")}
        subColor={tp ? (tp.inTdz ? t.ok : t.warn) : undefined}
      />
      <Tile
        i={3}
        t={t}
        label={tr("landingCard.centreline")}
        value={lateral == null ? "–" : fmtNum(lateral, 0)}
        unit={lateral == null ? undefined : lateral < 0.5 ? "m" : `m ${tp!.lateralM > 0 ? tr("landingCard.right") : tr("landingCard.left")}`}
        source="derived"
        sub={
          tp && !measurable
            ? tr("landingCard.notMeasurable")
            : tp
              ? rwy
                ? rwy.widthM != null
                  ? tr("landingCard.width", { side: sideLabel(tp.lateralM), width: fmt(rwy.widthM, 0, "m") })
                  : tr("landingCard.widthUnknown", { side: sideLabel(tp.lateralM) })
                : sideLabel(tp.lateralM)
              : "–"
        }
      />

      {/* runway from above */}
      <rect x={PAD} y={RWY_Y} width={INNER} height={rwyH} rx={px(t.radius, 3)} fill={t.surface1} stroke={t.border} />
      <text x={PAD + 16} y={RWY_Y + 24} fill={t.textMuted} fontSize={13} fontWeight={550} letterSpacing={t.labelLs} style={sans}>
        {rwy
          ? tr(derived ? "landingCard.runwayTopDerived" : runwaySourceOf(rwy) === "user" ? "landingCard.runwayTopUser" : "landingCard.runwayTop", { ident: rwy.ident })
          : tr("landingCard.touchdownPoint")}
      </text>
      {rwy && tp ? (
        <RunwayTop d={d} t={t} tr={tr} panelH={rwyH} />
      ) : (
        <text x={CARD_W / 2} y={RWY_Y + rwyH / 2 + 6} textAnchor="middle" fill={t.textMuted} fontSize={18} style={sans}>
          {tr("landingCard.noRunwayPanel")}
        </text>
      )}

      {/* approach profile, last nm */}
      <rect x={PAD} y={profY} width={INNER} height={PROF_H} rx={px(t.radius, 3)} fill={t.surface1} stroke={t.border} />
      <MiniProfile d={d} t={t} tr={tr} profY={profY} />
      {line && (
        <text x={PAD + 16} y={profY + PROF_H + 15} fill={t.textMuted} fontSize={14} style={num}>
          <tspan fill={t.textMuted} fontWeight={550} letterSpacing={t.labelLs} style={sans}>
            {tr("landingCard.approach")}
            {"  "}
          </tspan>
          {line}
        </text>
      )}

      {/* footer */}
      <line x1={PAD} x2={CARD_W - PAD} y1={FOOT_Y - 24} y2={FOOT_Y - 24} stroke={t.border} />
      <text x={PAD} y={FOOT_Y} fill={t.textMuted} fontSize={16} style={sans}>
        {windLine(d, tr)}
      </text>
      {/* brand lockup (docs/brand/README.md): mark + "VectaSim" outlines, baseline on the footer line */}
      <g>
        <title>VectaSim</title>
        <LogoLockup x={CARD_W - PAD - lockupWidth(LOCKUP_H)} y={FOOT_Y - LOCKUP_H * (54 / 64)} height={LOCKUP_H} text={t.text} muted={t.textMuted} scheme={t.scheme} id="card-logo-mask" />
      </g>
    </svg>
  );
}

function windLine(d: LandingDebriefData, tr: TFunction): string {
  const w = d.analysis.wind;
  const metar = d.metar;
  if (!metar && !w) return d.metarNote ? tr("landingCard.windNote", { note: d.metarNote }) : tr("landingCard.windNoMetar");
  const head = metar ? `METAR ${metar.station}${metar.time ? ` ${metar.time}` : ""}` : tr("landingCard.wind");
  const parts = [head];
  if (metar?.wind) parts.push(fmtWind(metar.wind));
  if (w && w.headwindKt != null) parts.push(w.relativeToRunway ? windComponentsText(d.analysis) : tr("landingCard.toHeading", { text: windComponentsText(d.analysis) }));
  if (metar && !d.metarAtLanding) parts.push(tr("landingCard.currentWeather"));
  const age = metarAgeNote(d);
  if (age) parts.push(age.replace(/^METAR /, ""));
  return parts.join(" · ");
}

function Tile({
  i,
  t,
  label,
  value,
  unit,
  source,
  band,
  sub,
  subColor,
}: {
  i: number;
  t: CardTheme;
  label: string;
  value: string;
  unit?: string;
  source: SourceKind;
  band?: Band;
  sub: string;
  subColor?: string;
}) {
  const gap = 16;
  const w = (INNER - 3 * gap) / 4;
  const x = PAD + i * (w + gap);
  const chip = SOURCE_LABEL[source];
  const chipW = 14 + chip.length * 8;
  return (
    <g>
      {/* hairline group like the debrief: one rule on top, a divider before every tile but the first */}
      <line x1={x} x2={x + w} y1={TILE_Y} y2={TILE_Y} stroke={t.border} />
      {i > 0 && <line x1={x - gap / 2} x2={x - gap / 2} y1={TILE_Y + 12} y2={TILE_Y + TILE_H - 6} stroke={t.border} />}
      <text x={x} y={TILE_Y + 30} fill={t.textMuted} fontSize={15} style={{ fontFamily: t.fontSans }}>
        {label}
      </text>
      <rect x={x + w - chipW} y={TILE_Y + 15} width={chipW} height={19} rx={Math.min(4, px(t.radius, 3))} fill="none" stroke={t.textMuted} strokeOpacity={0.6} />
      <text x={x + w - chipW / 2} y={TILE_Y + 29} textAnchor="middle" fill={t.textMuted} fontSize={11} fontWeight={550} style={{ fontFamily: t.fontNum }}>
        {chip}
      </text>
      <text x={x} y={TILE_Y + 80} fill={t.text} fontSize={42} fontWeight={550} style={{ fontFamily: t.fontNum }}>
        {value}
        {unit && value !== "–" && (
          <tspan fill={t.textMuted} fontSize={18} fontWeight={450} style={{ fontFamily: t.fontSans }}>
            {NNBSP}
            {unit}
          </tspan>
        )}
      </text>
      {band && <ShapeMark shape={BAND_SHAPE[band]} x={x + 5} y={TILE_Y + 104} r={5} style={{ fill: bandColor(t, band) }} />}
      <text x={x + (band ? 17 : 0)} y={TILE_Y + 109} fill={subColor ?? t.textMuted} fontSize={14} style={{ fontFamily: t.fontSans }}>
        {clip(sub, band ? 31 : 33)}
      </text>
    </g>
  );
}

/** Runway top view: same geometry as RunwayDiagram (runwayLayout/pathOf), fixed size. */
function RunwayTop({ d, t, tr, panelH }: { d: LandingDebriefData; t: CardTheme; tr: TFunction; panelH: number }) {
  const a = d.analysis;
  const rwy = a.runway!;
  const tp = a.touchdownPoint!;
  const L = runwayTopLayout(a, panelH);
  const { pts, tdXY } = L;
  const visible = pts.filter((p) => p.x >= L.xMin);
  const firstGround = visible.findIndex((p) => p.ground);
  const air = firstGround >= 0 ? [...visible.slice(0, firstGround), tdXY] : visible;
  const ground = firstGround >= 0 ? [tdXY, ...visible.slice(firstGround)] : [];

  const P = L.toSvg;
  const W = Math.max(drawWidthM(rwy.widthM), 10);
  const [rx0, ry0] = P({ x: 0, y: -W / 2 });
  const [rx1, ry1] = P({ x: rwy.lengthM, y: W / 2 });
  const [tdzX0] = P({ x: tp.tdzStartM, y: 0 });
  const [tdzX1] = P({ x: tp.tdzEndM, y: 0 });
  const [aimX] = P({ x: tp.aimingPointM, y: 0 });
  const [tdx, tdy] = P(tdXY);
  const cy = L.cy;
  const rwyH = ry1 - ry0;
  const stripeLen = Math.max(4, 30 * L.xScale);
  const stripeW = Math.max(1.2, ((W - 6) / (L.stripes.length + 1)) * 0.5 * L.yScale);
  const rolloutEnd = a.rollout && a.samples.length > 0 ? a.samples[a.samples.length - 1] : null;
  const rolloutXY = rolloutEnd?.xM != null && rolloutEnd.yM != null ? P({ x: rolloutEnd.xM, y: rolloutEnd.yM }) : null;
  const designatorSize = designatorPx(rwyH);
  const desX = rx0 + stripeLen + 6 + designatorSize * 0.5;
  const sans = { fontFamily: t.fontSans };
  const numF = { fontFamily: t.fontNum };
  const offRunway = tdy < ry0 - 6 || tdy > ry1 + 6;
  const tdLabelRight = tdx < INNER - 200;
  const labelX = offRunway ? tdx + (tdLabelRight ? 12 : -12) : tdx;
  const labelY = offRunway ? tdy + 5 : Math.min(L.heightPx - 2, ry1 + 40);
  const anchor = offRunway ? (tdLabelRight ? "start" : "end") : "middle";
  const tdColor = isRated(a.touchdown) ? bandColor(t, a.vsBand) : t.textMuted;

  return (
    <g transform={`translate(${PAD},${RWY_Y + 26})`}>
      <defs>
        <clipPath id="card-rwy-clip">
          <rect x={0} y={0} width={INNER} height={L.heightPx} />
        </clipPath>
      </defs>
      <g clipPath="url(#card-rwy-clip)">
        <line x1={P({ x: L.xMin, y: 0 })[0]} x2={rx0} y1={cy} y2={cy} stroke={t.textFaint} strokeDasharray="3 5" />
        <rect x={rx0} y={ry0} width={rx1 - rx0} height={rwyH} fill={t.surface3} stroke={t.textFaint} />
        <rect x={tdzX0} y={ry0 - 3} width={Math.max(1, tdzX1 - tdzX0)} height={rwyH + 6} fill={t.ok} fillOpacity={0.1} stroke={t.ok} strokeOpacity={0.4} />
        <text x={(tdzX0 + tdzX1) / 2} y={ry0 - 9} textAnchor="middle" fill={t.ok} fontSize={13} style={sans}>
          {tr("landingCard.zone", { zone: zoneText(tp, rwy), aim: fmt(tp.aimingPointM, 0, "m") })}
        </text>
        {[cy - rwyH * 0.36, cy + rwyH * 0.22].map((y) => (
          <rect key={y} x={aimX} y={y} width={Math.max(3, 45 * L.xScale)} height={rwyH * 0.14} fill={t.text} fillOpacity={0.85} />
        ))}
        {L.stripes.map((y) => {
          const [, sy] = P({ x: 0, y });
          const [ex] = P({ x: rwy.lengthM, y: 0 });
          return (
            <g key={y}>
              <rect x={rx0 + 2} y={sy - stripeW / 2} width={stripeLen} height={stripeW} fill={t.text} fillOpacity={0.85} />
              <rect x={ex - 2 - stripeLen} y={sy - stripeW / 2} width={stripeLen} height={stripeW} fill={t.text} fillOpacity={0.85} />
            </g>
          );
        })}
        <line x1={rx0 + stripeLen + 30} x2={rx1 - stripeLen - 30} y1={cy} y2={cy} stroke={t.text} strokeWidth={1.5} strokeDasharray="12 9" strokeOpacity={0.8} />
        {/* designator: rotated like the painted marking (read from the approach), drawn later over the track with a halo */}
        {L.ticks.map((dist) => {
          const [x] = P({ x: dist, y: 0 });
          return (
            <g key={dist}>
              <line x1={x} x2={x} y1={ry1 + 2} y2={ry1 + 7} stroke={t.textMuted} />
              <text x={x} y={ry1 + 20} textAnchor="middle" fill={t.textMuted} fontSize={12} style={numF}>
                {fmt(dist, 0, "m")}
              </text>
            </g>
          );
        })}
        <text x={rx0} y={ry1 + 20} textAnchor="middle" fill={t.textMuted} fontSize={12} style={numF}>
          0
        </text>
        {air.length > 1 && <path d={pathOf(air, P)} fill="none" stroke={t.accent} strokeWidth={2.5} strokeLinejoin="round" />}
        {ground.length > 1 && <path d={pathOf(ground, P)} fill="none" stroke={t.ownAircraft} strokeWidth={2.5} strokeDasharray="6 4" />}
        {lateralMeasurable(tp) && Math.abs(tp.lateralM) >= 0.5 && <line x1={tdx} x2={tdx} y1={cy} y2={tdy} stroke={t.text} strokeDasharray="2 2" />}
        {a.bouncePoints.map((b, i) => {
          if (b.xM == null || b.yM == null) return null;
          const [bx, by] = P({ x: b.xM, y: b.yM });
          return <circle key={i} cx={bx} cy={by} r={4.5} fill={t.warn} stroke={t.bg} strokeWidth={1.5} />;
        })}
        {rolloutXY && <rect x={rolloutXY[0] - 4.5} y={rolloutXY[1] - 4.5} width={9} height={9} fill={t.textMuted} stroke={t.bg} strokeWidth={1.5} />}
        {showDesignator(rx1 - rx0, rwyH) && (
          <text
            x={desX}
            y={cy}
            transform={`rotate(90 ${desX} ${cy})`}
            textAnchor="middle"
            dominantBaseline="central"
            fill={t.text}
            fontSize={designatorSize}
            fontWeight={650}
            stroke={t.surface3}
            strokeWidth={4}
            strokeLinejoin="round"
            paintOrder="stroke"
            style={numF}
          >
            {rwy.ident}
          </text>
        )}
        <circle cx={tdx} cy={tdy} r={8} fill={tdColor} stroke={t.bg} strokeWidth={2} />
        <text x={labelX} y={labelY} textAnchor={anchor} fill={t.text} fontSize={14} fontWeight={600} stroke={t.surface1} strokeWidth={4} paintOrder="stroke" style={numF}>
          {touchdownDistanceText(tp)}
          {lateralMeasurable(tp) ? ` · ${sideLabel(tp.lateralM)}` : ""}
        </text>
      </g>
      {/* legend, top right of the panel */}
      <g transform={`translate(${INNER - 16},-2)`} fontSize={12} style={sans}>
        <text x={0} y={0} textAnchor="end" fill={t.textMuted}>
          <tspan fill={t.accent}>━</tspan> {tr("landingCard.inAir")}
          {SEP}
          <tspan fill={t.ownAircraft}>┅</tspan> {tr("landingCard.onGround")}
          {a.rollout ? `${SEP}■ GS < ${fmtNum(a.config.rolloutEndKt)}${NNBSP}kt` : ""}
          {L.exaggeration > 1.05 ? `${SEP}${tr("landingCard.exaggerated", { factor: fmtNum(L.exaggeration, L.exaggeration < 10 ? 1 : 0) })}` : ""}
        </text>
      </g>
    </g>
  );
}

/** Height over the last nm against the reference glidepath (3° by default). */
function MiniProfile({ d, t, tr, profY: PROF_Y }: { d: LandingDebriefData; t: CardTheme; tr: TFunction; profY: number }) {
  const a = d.analysis;
  const sans = { fontFamily: t.fontSans };
  const numF = { fontFamily: t.fontNum };
  const withRunway = a.distanceRef === "threshold";
  const tdDist = withRunway ? -(a.touchdownPoint?.distanceM ?? 0) : 0;
  const dMax = M_PER_NM;
  const dMin = Math.min(tdDist, 0) - 40;
  const gp = a.config.glidepathDeg;
  const tol = a.config.glidepathToleranceDeg;
  const tch = a.config.tchFt;
  const pts = a.samples.filter((s) => !s.onGround && s.distM <= dMax + 1 && s.distM >= dMin);

  const x0 = PAD + 210;
  const x1 = CARD_W - PAD - 20;
  const y0 = PROF_Y + 16;
  const y1 = PROF_Y + PROF_H - 18;
  const refTop = withRunway ? referenceHeightFt(dMax, gp + tol, tch, gp) : 0;
  const hHi = Math.max(150, refTop * 1.08, ...pts.map((s) => s.hatFt * 1.2));
  const x = (dist: number) => x0 + ((dMax - dist) / (dMax - dMin)) * (x1 - x0);
  const y = (h: number) => y1 - (Math.max(0, h) / hHi) * (y1 - y0);

  const head = (
    <g style={sans}>
      <text x={PAD + 16} y={PROF_Y + 30} fill={t.textMuted} fontSize={13} fontWeight={550} letterSpacing={t.labelLs}>
        {tr("landingCard.profileTitle", { nm: `1${NNBSP}NM` })}
      </text>
      {withRunway && (
        <text x={PAD + 16} y={PROF_Y + 54} fill={t.text} fontSize={14}>
          <tspan fill={t.textMuted}>┅</tspan> {tr("landingCard.reference", { angle: `${fmtNum(gp, 0)}°`, tol: degNum(tol) })}
        </text>
      )}
      {a.threshold && (
        <text x={PAD + 16} y={PROF_Y + 76} fill={t.text} fontSize={14} style={numF}>
          {tr("landingCard.threshold", { height: fmt(a.threshold.heightFt, 0, "ft"), ias: fmt(a.threshold.iasKt, 0, "kt") })}
        </text>
      )}
      {a.flare && (
        <text x={PAD + 16} y={PROF_Y + 98} fill={t.textMuted} fontSize={14} style={numF}>
          {tr("landingCard.flare", { ft: fmt(a.flare.startHatFt, 0, "ft") })}
        </text>
      )}
    </g>
  );
  if (pts.length < 2) {
    return (
      <g>
        {head}
        <text x={(x0 + x1) / 2} y={PROF_Y + PROF_H / 2 + 5} textAnchor="middle" fill={t.textMuted} fontSize={15} style={sans}>
          {tr("landingCard.tooFewPoints")}
        </text>
      </g>
    );
  }

  let ref = "";
  let band = "";
  if (withRunway) {
    const gpipM = (tch * M_PER_FT) / Math.tan((gp * Math.PI) / 180);
    const to = Math.max(dMin, -gpipM);
    const n = 24;
    const ds = Array.from({ length: n + 1 }, (_, i) => dMax + ((to - dMax) * i) / n);
    ref = ds.map((v, i) => `${i ? "L" : "M"}${x(v).toFixed(1)},${y(referenceHeightFt(v, gp, tch)).toFixed(1)}`).join("");
    const up = ds.map((v) => `${x(v).toFixed(1)},${y(referenceHeightFt(v, gp + tol, tch, gp)).toFixed(1)}`);
    const lo = ds.map((v) => `${x(v).toFixed(1)},${y(referenceHeightFt(v, gp - tol, tch, gp)).toFixed(1)}`).reverse();
    band = `M${up.join("L")}L${lo.join("L")}Z`;
  }
  const line = [...pts.map((s) => [x(s.distM), y(s.hatFt)]), [x(tdDist), y(0)]].map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");

  return (
    <g>
      {head}
      <defs>
        <clipPath id="card-prof-clip">
          <rect x={x0} y={y0 - 4} width={x1 - x0} height={y1 - y0 + 6} />
        </clipPath>
      </defs>
      <line x1={x0} x2={x1} y1={y1} y2={y1} stroke={t.textFaint} />
      <g clipPath="url(#card-prof-clip)">
        {band && <path d={band} fill={t.text} fillOpacity={0.07} />}
        {ref && <path d={ref} fill="none" stroke={t.text} strokeOpacity={0.7} strokeDasharray="6 4" />}
        <path d={line} fill="none" stroke={t.accent} strokeWidth={2.5} strokeLinejoin="round" />
      </g>
      {[1, 0.5].map((nm) => (
        <text key={nm} x={x(nm * M_PER_NM)} y={y1 + 14} textAnchor={nm === 1 ? "start" : "middle"} fill={t.textMuted} fontSize={12} style={numF}>
          {fmtNum(nm, nm === 1 ? 0 : 1)}
          {NNBSP}nm
        </text>
      ))}
      {withRunway && (
        <g>
          <line x1={x(0)} x2={x(0)} y1={y0} y2={y1} stroke={t.textMuted} />
          <text x={x(0) - 4} y={y1 + 14} textAnchor="end" fill={t.textMuted} fontSize={12} style={sans}>
            {tr("landingCard.thresholdShort")}
          </text>
        </g>
      )}
      <path d={`M${x(tdDist) - 5},${y1 - 9}L${x(tdDist) + 5},${y1 - 9}L${x(tdDist)},${y1 - 1}Z`} fill={isRated(a.touchdown) ? bandColor(t, a.vsBand) : t.textMuted} />
      {/* the touchdown sits at the right edge: label it above the plot, left of the mark */}
      <text x={x(tdDist) - 8} y={y0 + 6} textAnchor="end" fill={t.text} fontSize={12} stroke={t.surface1} strokeWidth={3} paintOrder="stroke" style={sans}>
        {tr("landingCard.touchdown")}
      </text>
      <line x1={x(tdDist)} x2={x(tdDist)} y1={y0} y2={y1 - 9} stroke={t.textFaint} strokeDasharray="2 3" />
      <text x={x0 + 4} y={y0 + 6} fill={t.textMuted} fontSize={12} stroke={t.surface1} strokeWidth={3} paintOrder="stroke" style={numF}>
        {fmtNum(Math.round(hHi / 50) * 50)}
        {NNBSP}ft
      </text>
    </g>
  );
}
