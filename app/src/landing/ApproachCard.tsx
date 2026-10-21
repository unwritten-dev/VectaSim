// Approach card ("Anflugkarte"): the shareable summary of one approach as a fixed 1200×675
// (16:9) SVG, rasterised to PNG by exportApproachCard.ts – the sibling of LandingCard.tsx with
// the same rules: pure (ApproachAnalysis + flight + colours), concrete colours only (no
// `var(--…)`, see LandingCard), embedded fonts via `fontCss`, the real brand lockup.
//
// Content: key sentence, band, the three gates (FAF / 1000 / 500 ft with ✓ ✗ –), four key
// numbers with their source chip, a mini profile (height to the reference path and speed to
// the reference over the final), the centreline strip (localizer dots), the wind (the sim's
// in the final when recorded) and the wordmark. Texts and numbers in `lang` (default: the UI
// language); the facts.ts sentences follow the active language.

import { maskRegistration, maskTitle } from "../format";
import { NNBSP, fmt as fmtL, fmtDateTime, fmtNum as fmtNumL, fmtSigned as fmtSignedL } from "../i18n/number";
import { getLanguage, tIn, type Language, type TArgs, type TKey } from "../i18n";
import { LogoLockup, lockupWidth } from "../ui/Logo";
import { providerLabel } from "../status";
import type { FlightRow } from "../types";
import { ShapeMark } from "./BandMark";
import {
  approachBandLabel,
  APPROACH_BAND_SHAPE,
  ENERGY_BAND_LABEL,
  GATE_LABEL,
  SOURCE_LABEL,
  approachKeySentence,
  approachProvenance,
  glidepathLabel,
  isDerivedRunway,
  lateralUnmeasurableReason,
  simWindComponentsText,
  simWindText,
  vappSourceLabel,
  type SourceKind,
} from "./facts";
import { CARD_H, CARD_W, type CardTheme } from "./LandingCard";
import { M_PER_NM } from "./geometry";
import type { ApproachAnalysis, ApproachBand, ApproachGate, ApproachProfilePoint, GateKind } from "./approachTypes";

export { CARD_H as APPROACH_CARD_H, CARD_W as APPROACH_CARD_W };

const PAD = 48;
const INNER = CARD_W - 2 * PAD;
const TILE_Y = 186;
const TILE_H = 104;
const PROF_Y = 306;
const PROF_H = 176;
const LAT_Y = 494;
const LAT_H = 104;
const FOOT_Y = 654;
const LOCKUP_H = 24;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const px = (v: string, fallback: number) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Band colour from the landing band scale: stabil = sanft, Abweichungen = fest, instabil = hart. */
const bandColor = (t: CardTheme, b: ApproachBand) => ({ stable: t.bandSoft, deviations: t.bandFirm, unstable: t.bandHard, unstableBelow500: t.bandHard })[b];

export interface ApproachCardProps {
  approach: ApproachAnalysis;
  colors: CardTheme;
  /** The flight (aircraft, registration, sim) – optional. */
  flight?: Pick<FlightRow, "aircraft" | "airframeReg" | "callsign" | "simName" | "provider"> | null;
  /** @font-face rules with embedded WOFF2 (cardFonts.ts); omitted → system fonts. */
  fontCss?: string | null;
  /** Streamer-Modus / „ohne Kennzeichen“: registration as "D-••••". */
  hideReg?: boolean;
  /** Language of the card's texts and numbers; omitted → the UI language. */
  lang?: Language;
}

/** Text and number helpers bound to one language (the card renders outside any provider). */
function texts(lang: Language) {
  return {
    tr: <K extends TKey>(key: K, ...args: TArgs<K>) => tIn(lang, key, ...args),
    fmt: (n: number | null | undefined, digits = 0, unit = "") => fmtL(n, digits, unit, lang),
    fmtNum: (n: number | null | undefined, digits = 0) => fmtNumL(n, digits, lang),
    fmtSigned: (n: number | null | undefined, digits = 0, unit = "") => fmtSignedL(n, digits, unit, lang),
  };
}
type Texts = ReturnType<typeof texts>;

/** Distance to the threshold along the final, m (the runway axis on the final, else flown). */
function distOf(p: ApproachProfilePoint): number {
  return p.onFinal && p.xM != null && p.xM < 0 ? -p.xM : p.trackDistM;
}

function gateMarkOf(g: ApproachGate | null): { mark: string; ok: boolean | null } {
  if (!g || !g.reached) return { mark: "–", ok: null };
  const fail = g.criteria.some((c) => c.status === "fail");
  return { mark: fail ? "✗" : "✓", ok: !fail };
}

export default function ApproachCard({ approach: a, colors: t, flight, fontCss, hideReg = false, lang = getLanguage() }: ApproachCardProps) {
  const tx = texts(lang);
  const { tr, fmt, fmtNum, fmtSigned } = tx;
  const sans = { fontFamily: t.fontSans };
  const num = { fontFamily: t.fontNum };
  const rwy = a.runway;
  const isGa = a.outcome.kind === "goAround";
  const st = a.stability;
  const src = approachProvenance(a);

  const aircraft = flight?.aircraft;
  const rawType = aircraft?.title || aircraft?.atcType || "";
  const rawReg = flight?.airframeReg || aircraft?.atcId || null;
  const reg = rawReg && hideReg ? maskRegistration(rawReg) : rawReg;
  const type = hideReg ? maskTitle(rawType, { registration: rawReg, airline: aircraft?.atcAirline, callsign: flight?.callsign }, true) : rawType;
  const sim = flight?.simName || (flight?.provider ? providerLabel(flight.provider) : null);
  const meta = [type ? clip(type, 36) : null, reg, sim].filter(Boolean).join(" · ");
  const when = isGa ? (a.goAround?.lowestTMs ?? a.endTMs) : a.endTMs;

  const gateOf = (k: GateKind) => a.gates.find((g) => g.kind === k) ?? null;
  const sf = st.stableFromFt;
  const latWhy = lateralUnmeasurableReason(a);
  // same rule as the debrief: "too few samples" still shows what there is
  const latShown = !!rwy && !isDerivedRunway(rwy) && a.lateral?.measurable !== false;
  const dots = tr("approach.common.dots");
  const never = tr("approach.common.never");

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={CARD_W}
      height={CARD_H}
      viewBox={`0 0 ${CARD_W} ${CARD_H}`}
      role="img"
      aria-label={tr("approach.card.ariaLabel", { runway: rwy ? `${rwy.airport} RWY ${rwy.ident}` : "" }).trim()}
    >
      {fontCss && (
        <defs>
          <style>{fontCss}</style>
        </defs>
      )}
      <rect x={0} y={0} width={CARD_W} height={CARD_H} fill={t.bg} />
      <rect x={0} y={0} width={CARD_W} height={4} fill={t.accent} />

      {/* head */}
      <text x={PAD} y={84} fill={t.text} fontSize={40} fontWeight={650} style={sans}>
        {rwy ? rwy.airport : tr("approach.card.approach")}
        {rwy && (
          <tspan fill={t.text} fontWeight={550}>
            {"  "}RWY {rwy.ident}
          </tspan>
        )}
        <tspan fill={t.textMuted} fontSize={22} fontWeight={450}>
          {"  "}
          {isGa ? tr("approach.card.approachGoAround") : tr("approach.card.approach")}
        </tspan>
      </text>
      <text x={PAD} y={120} fill={t.textMuted} fontSize={18} style={sans}>
        {clip(approachKeySentence(a), 112)}
      </text>
      <text x={CARD_W - PAD} y={62} textAnchor="end" fill={t.text} fontSize={20} style={num}>
        {fmtDateTime(when, { local: false, lang })}
      </text>
      {meta && (
        <text x={CARD_W - PAD} y={90} textAnchor="end" fill={t.textMuted} fontSize={17} style={sans}>
          {meta}
        </text>
      )}

      {/* band and gates */}
      <g>
        {a.band ? (
          <>
            <ShapeMark shape={APPROACH_BAND_SHAPE[a.band]} x={PAD + 7} y={153} r={7} style={{ fill: bandColor(t, a.band) }} />
            <text x={PAD + 22} y={159} fill={t.text} fontSize={20} fontWeight={600} style={sans}>
              {approachBandLabel(a.band, a.config.hardGateFt)}
            </text>
          </>
        ) : (
          <text x={PAD} y={159} fill={t.textMuted} fontSize={18} style={sans}>
            {tr("approach.common.noBand", { height: fmt(1000, 0, "ft") })}
          </text>
        )}
        <text x={PAD + 250} y={159} fill={t.textMuted} fontSize={14} fontWeight={550} letterSpacing={t.labelLs} style={sans}>
          {tr("approach.card.gates")}
        </text>
        {(["faf", "ft1000", "ft500"] as GateKind[]).map((k, i) => {
          const g = gateMarkOf(gateOf(k));
          const x = PAD + 320 + i * 130;
          return (
            <text key={k} x={x} y={159} fill={t.text} fontSize={18} style={num}>
              {GATE_LABEL[k]}{" "}
              <tspan fill={g.ok == null ? t.textMuted : g.ok ? t.ok : t.err} fontWeight={700}>
                {g.mark}
              </tspan>
            </text>
          );
        })}
        <text x={CARD_W - PAD} y={159} textAnchor="end" fill={t.textMuted} fontSize={16} style={sans}>
          {tr("approach.card.referenceLine", { glidepath: glidepathLabel(a.reference), vapp: fmt(a.reference.vappKt, 0, "kt"), source: vappSourceLabel(a) })}
        </text>
      </g>

      {/* four key numbers */}
      <Tile
        i={0}
        t={t}
        label={tr("approach.section.hero.stableLabel")}
        value={sf != null ? fmt(sf, 0) : a.band == null ? "–" : never}
        unit={sf != null ? "ft" : undefined}
        source={src.stable.kind}
        sub={isGa ? tr("approach.card.untilGoAround") : tr("approach.card.until", { height: fmt(a.config.windowBottomFt, 0, "ft") })}
        never={never}
      />
      <Tile
        i={1}
        t={t}
        label={tr("approach.section.hero.glidepathLabel")}
        value={st.gpRmsDots != null ? fmtNum(st.gpRmsDots, 2) : st.gpRmsFt != null ? fmt(st.gpRmsFt, 0) : "–"}
        unit={st.gpRmsDots != null ? dots : st.gpRmsFt != null ? "ft" : undefined}
        source={src.glidepath.kind}
        sub={a.reference.glidepathSource === "ils" ? tr("approach.card.glidepathIls") : rwy ? tr("approach.card.glidepathAssumed") : tr("approach.common.noRunwayNotMeasurable")}
        never={never}
      />
      <Tile
        i={2}
        t={t}
        label={tr("approach.section.hero.lateralLabel")}
        value={latShown && st.locRmsDots != null ? fmtNum(st.locRmsDots, 2) : "–"}
        unit={latShown && st.locRmsDots != null ? dots : undefined}
        source={src.lateral.kind}
        sub={
          latShown
            ? a.reference.localizerSource === "ils"
              ? tr("approach.card.localizerSim")
              : tr("approach.common.geometric")
            : (latWhy ?? tr("approach.common.notMeasurable"))
        }
        never={never}
      />
      <Tile
        i={3}
        t={t}
        label={tr("approach.section.hero.speedLabel")}
        value={st.iasMadKt != null ? fmtNum(st.iasMadKt, 1) : "–"}
        unit="kt"
        source={src.speed.kind}
        sub={st.iasMedianDevKt != null ? tr("approach.card.speedMedian", { median: fmtSigned(st.iasMedianDevKt, 0, "kt") }) : tr("approach.card.noReference")}
        never={never}
      />

      {/* profile: height to the path, speed to the reference */}
      <rect x={PAD} y={PROF_Y} width={INNER} height={PROF_H} rx={px(t.radius, 3)} fill={t.surface1} stroke={t.border} />
      <Profile a={a} t={t} tx={tx} />

      {/* centreline strip */}
      <rect x={PAD} y={LAT_Y} width={INNER} height={LAT_H} rx={px(t.radius, 3)} fill={t.surface1} stroke={t.border} />
      <LateralStrip a={a} t={t} tx={tx} shown={latShown} why={latWhy} />

      {/* footer */}
      <line x1={PAD} x2={CARD_W - PAD} y1={FOOT_Y - 24} y2={FOOT_Y - 24} stroke={t.border} />
      <text x={PAD} y={FOOT_Y} fill={t.textMuted} fontSize={16} style={sans}>
        {clip(windLine(a, lang), 96)}
      </text>
      <g>
        <title>VectaSim</title>
        <LogoLockup x={CARD_W - PAD - lockupWidth(LOCKUP_H)} y={FOOT_Y - LOCKUP_H * (54 / 64)} height={LOCKUP_H} text={t.text} muted={t.textMuted} scheme={t.scheme} id="apr-card-logo-mask" />
      </g>
    </svg>
  );
}

/** "Sim-Wind 250°/8 kt · Gegenwind 8 kt · kein Seitenwind · Energie im Profil" – or why there is none. */
export function windLine(a: ApproachAnalysis, lang: Language = getLanguage()): string {
  const parts: string[] = [];
  const w = a.wind;
  const text = simWindText(w);
  if (text) {
    parts.push(tIn(lang, "approach.card.simWind", { wind: text }));
    const comp = simWindComponentsText(w);
    if (comp) parts.push(comp);
  } else {
    parts.push(tIn(lang, "approach.card.windNotRecorded"));
  }
  const eb = a.energy?.band;
  if (eb) parts.push(tIn(lang, "approach.card.energy", { band: ENERGY_BAND_LABEL[eb] }));
  return parts.join(" · ");
}

function Tile({ i, t, label, value, unit, source, sub, never }: { i: number; t: CardTheme; label: string; value: string; unit?: string; source: SourceKind; sub: string; never: string }) {
  const gap = 16;
  const w = (INNER - 3 * gap) / 4;
  const x = PAD + i * (w + gap);
  const chip = SOURCE_LABEL[source];
  const chipW = 14 + chip.length * 8;
  return (
    <g>
      <line x1={x} x2={x + w} y1={TILE_Y} y2={TILE_Y} stroke={t.border} />
      {i > 0 && <line x1={x - gap / 2} x2={x - gap / 2} y1={TILE_Y + 12} y2={TILE_Y + TILE_H - 6} stroke={t.border} />}
      <text x={x} y={TILE_Y + 28} fill={t.textMuted} fontSize={15} style={{ fontFamily: t.fontSans }}>
        {label}
      </text>
      <rect x={x + w - chipW} y={TILE_Y + 13} width={chipW} height={19} rx={Math.min(4, px(t.radius, 3))} fill="none" stroke={t.textMuted} strokeOpacity={0.6} />
      <text x={x + w - chipW / 2} y={TILE_Y + 27} textAnchor="middle" fill={t.textMuted} fontSize={11} fontWeight={550} style={{ fontFamily: t.fontNum }}>
        {chip}
      </text>
      <text x={x} y={TILE_Y + 72} fill={t.text} fontSize={38} fontWeight={550} style={{ fontFamily: t.fontNum }}>
        {value}
        {unit && value !== "–" && value !== never && (
          <tspan fill={t.textMuted} fontSize={17} fontWeight={450} style={{ fontFamily: t.fontSans }}>
            {NNBSP}
            {unit}
          </tspan>
        )}
      </text>
      <text x={x} y={TILE_Y + 96} fill={t.textMuted} fontSize={14} style={{ fontFamily: t.fontSans }}>
        {clip(sub, 34)}
      </text>
    </g>
  );
}

/** Points of the final shown on the card: airborne, from `dMax` nm to the end. */
function finalPoints(a: ApproachAnalysis, dMaxM: number): Array<ApproachProfilePoint & { d: number }> {
  return a.samples
    .filter((p) => !p.onGround && p.tMs <= a.endTMs)
    .map((p) => ({ ...p, d: distOf(p) }))
    .filter((p) => p.d <= dMaxM && p.d >= -500);
}

/** Range of the plots: from the established point (+1 nm), 4–10 nm. */
function plotRangeM(a: ApproachAnalysis): number {
  const est = a.established?.distNm;
  const nm = est != null ? Math.min(10, Math.max(4, Math.ceil(est + 1))) : 6;
  return nm * M_PER_NM;
}

const pathOf = (xy: Array<[number, number]>) => xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");

function Profile({ a, t, tx }: { a: ApproachAnalysis; t: CardTheme; tx: Texts }) {
  const { tr, fmt, fmtNum, fmtSigned } = tx;
  const sans = { fontFamily: t.fontSans };
  const numF = { fontFamily: t.fontNum };
  const dMax = plotRangeM(a);
  const pts = finalPoints(a, dMax);
  const half = (INNER - 48) / 2;
  const lx0 = PAD + 16;
  const lx1 = lx0 + half;
  const rx0 = lx1 + 32;
  const rx1 = CARD_W - PAD - 16;
  const y0 = PROF_Y + 54;
  const y1 = PROF_Y + PROF_H - 24;
  const dMin = Math.min(0, ...pts.map((p) => p.d));
  const xs = (x0: number, x1: number) => (d: number) => x0 + ((dMax - d) / (dMax - dMin)) * (x1 - x0);
  const xl = xs(lx0, lx1);
  const xr = xs(rx0, rx1);

  // height: flown HAT against the reference path (refHatFt)
  const hHi = Math.max(300, ...pts.map((p) => Math.max(p.hatFt, p.refHatFt ?? 0)));
  const yh = (h: number) => y1 - (Math.max(0, Math.min(h, hHi)) / hHi) * (y1 - y0);
  const flown = pathOf(pts.map((p) => [xl(p.d), yh(p.hatFt)]));
  const refPts = pts.filter((p) => p.refHatFt != null);
  const ref = refPts.length > 1 ? pathOf(refPts.map((p) => [xl(p.d), yh(p.refHatFt!)])) : "";

  // speed: IAS − reference within the window −5/+20 kt
  const c = a.config;
  const sLo = -15;
  const sHi = 30;
  const ys = (v: number) => y1 - ((Math.max(sLo, Math.min(sHi, v)) - sLo) / (sHi - sLo)) * (y1 - y0);
  const spd = pts.filter((p) => p.iasDevKt != null);
  const speed = spd.length > 1 ? pathOf(spd.map((p) => [xr(p.d), ys(p.iasDevKt!)])) : "";
  const nmTicks = [dMax / M_PER_NM, Math.round(dMax / M_PER_NM / 2), 0];
  const endLabel = a.runway ? tr("approach.common.threshold") : tr("approach.common.end");

  return (
    <g>
      <text x={lx0} y={PROF_Y + 26} fill={t.textMuted} fontSize={13} fontWeight={550} letterSpacing={t.labelLs} style={sans}>
        {tr("approach.card.heightToPath", { glidepath: glidepathLabel(a.reference).toUpperCase() })}
      </text>
      <text x={rx0} y={PROF_Y + 26} fill={t.textMuted} fontSize={13} fontWeight={550} letterSpacing={t.labelLs} style={sans}>
        {tr("approach.card.speedToReference", { window: `${fmtSigned(-c.gateSpeedBelowKt, 0)}/${fmtSigned(c.gateSpeedAboveKt, 0)}` })}
      </text>
      <line x1={lx0} x2={lx1} y1={y1} y2={y1} stroke={t.textFaint} />
      <line x1={rx0} x2={rx1} y1={y1} y2={y1} stroke={t.textFaint} />
      {pts.length < 2 ? (
        <text x={CARD_W / 2} y={PROF_Y + PROF_H / 2 + 8} textAnchor="middle" fill={t.textMuted} fontSize={15} style={sans}>
          {tr("approach.common.tooFewTrackPoints")}
        </text>
      ) : (
        <>
          {ref && <path d={ref} fill="none" stroke={t.text} strokeOpacity={0.7} strokeDasharray="6 4" />}
          <path d={flown} fill="none" stroke={t.accent} strokeWidth={2.5} strokeLinejoin="round" />
          {/* speed window */}
          <rect x={rx0} y={ys(c.gateSpeedAboveKt)} width={rx1 - rx0} height={ys(-c.gateSpeedBelowKt) - ys(c.gateSpeedAboveKt)} fill={t.ok} fillOpacity={0.1} />
          <line x1={rx0} x2={rx1} y1={ys(0)} y2={ys(0)} stroke={t.text} strokeOpacity={0.6} strokeDasharray="6 4" />
          {speed ? (
            <path d={speed} fill="none" stroke={t.warn} strokeWidth={2.5} strokeLinejoin="round" />
          ) : (
            <text x={(rx0 + rx1) / 2} y={(y0 + y1) / 2} textAnchor="middle" fill={t.textMuted} fontSize={14} style={sans}>
              {tr("approach.card.noReferenceSpeed")}
            </text>
          )}
          {/* gate ticks on the height plot */}
          {a.markers
            .filter((m) => m.kind === "faf" || m.kind === "gate1000" || m.kind === "gate500")
            .map((m) => {
              const d = m.xM != null && m.xM < 0 ? -m.xM : m.trackDistM;
              if (d > dMax || d < dMin) return null;
              const lbl = m.kind === "faf" ? "FAF" : m.kind === "gate1000" ? "1000" : "500";
              return (
                <g key={m.kind}>
                  <line x1={xl(d)} x2={xl(d)} y1={y0 - 4} y2={y1} stroke={t.textFaint} strokeDasharray="2 3" />
                  <text x={xl(d)} y={y0 - 8} textAnchor="middle" fill={t.textMuted} fontSize={11} style={numF}>
                    {lbl}
                  </text>
                </g>
              );
            })}
          {/* scale top right: the flown line starts top left */}
          <text x={lx1 - 4} y={y0 + 12} textAnchor="end" fill={t.textMuted} fontSize={12} stroke={t.surface1} strokeWidth={3} paintOrder="stroke" style={numF}>
            {fmtNum(Math.round(hHi / 50) * 50)}
            {NNBSP}ft
          </text>
          <text x={rx0 + 4} y={ys(c.gateSpeedAboveKt) - 4} fill={t.textMuted} fontSize={12} style={numF}>
            {fmtSigned(c.gateSpeedAboveKt, 0, "kt")}
          </text>
        </>
      )}
      {nmTicks.map((nm, i) => (
        <g key={i}>
          <text x={xl(nm * M_PER_NM)} y={y1 + 16} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} fill={t.textMuted} fontSize={12} style={numF}>
            {nm === 0 ? endLabel : fmt(nm, 0, "nm")}
          </text>
          <text x={xr(nm * M_PER_NM)} y={y1 + 16} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} fill={t.textMuted} fontSize={12} style={numF}>
            {nm === 0 ? endLabel : fmt(nm, 0, "nm")}
          </text>
        </g>
      ))}
    </g>
  );
}

function LateralStrip({ a, t, tx, shown, why }: { a: ApproachAnalysis; t: CardTheme; tx: Texts; shown: boolean; why: string | null }) {
  const { tr, fmtSigned } = tx;
  const sans = { fontFamily: t.fontSans };
  const numF = { fontFamily: t.fontNum };
  const dMax = plotRangeM(a);
  const pts = finalPoints(a, dMax).filter((p) => p.locDots != null);
  const x0 = PAD + 190;
  const x1 = CARD_W - PAD - 16;
  const yc = LAT_Y + LAT_H / 2 + 6;
  const span = 2.5;
  const hh = LAT_H / 2 - 16;
  const dMin = Math.min(0, ...pts.map((p) => p.d));
  const x = (d: number) => x0 + ((dMax - d) / (dMax - dMin)) * (x1 - x0);
  const y = (v: number) => yc - (Math.max(-span, Math.min(span, v)) / span) * hh;
  const l = a.lateral;
  return (
    <g>
      <text x={PAD + 16} y={LAT_Y + 26} fill={t.textMuted} fontSize={13} fontWeight={550} letterSpacing={t.labelLs} style={sans}>
        {tr("approach.card.lateralTitle")}
      </text>
      <text x={PAD + 16} y={LAT_Y + 50} fill={t.text} fontSize={14} style={sans}>
        {a.reference.localizerSource === "ils" ? tr("approach.card.lateralLocalizerSim") : tr("approach.common.geometric")}
      </text>
      {l?.lateralBand && shown && (
        <text x={PAD + 16} y={LAT_Y + 72} fill={t.textMuted} fontSize={14} style={numF}>
          {tr("approach.card.lateralMax", { value: fmtSigned(l.locMaxDots, 1) })}
        </text>
      )}
      {!shown || pts.length < 2 ? (
        <text x={(x0 + x1) / 2} y={yc + 5} textAnchor="middle" fill={t.textMuted} fontSize={15} style={sans}>
          {why ?? tr("approach.card.lateralNotMeasurable")}
        </text>
      ) : (
        <>
          <rect x={x0} y={y(1)} width={x1 - x0} height={y(-1) - y(1)} fill={t.ok} fillOpacity={0.1} />
          <line x1={x0} x2={x1} y1={yc} y2={yc} stroke={t.text} strokeOpacity={0.6} strokeDasharray="6 4" />
          <path d={pathOf(pts.map((p) => [x(p.d), y(p.locDots!)]))} fill="none" stroke={t.accent} strokeWidth={2.5} strokeLinejoin="round" />
          <text x={x0 + 4} y={y(1) - 4} fill={t.textMuted} fontSize={11} style={numF}>
            {tr("approach.card.lateralBand")}
          </text>
        </>
      )}
    </g>
  );
}
