// Wording for the landing debrief: labels, limits and the "Hinweise" list derived from
// the measured facts. Pure (see facts.test.ts). The tone stays factual: we say what was
// measured and which limit it is compared with, never "good" or "bad".
//
// Terms (ICAO Annex 14 / EASA wording): "Aufsetzzone" (TDZ, from the threshold), "Zielpunkt"
// (aiming point marking inside it), "Mittellinie" (the runway centreline on the ground),
// "verlängerte Mittellinie" (extended centreline, the approach), "Piste" (the RWY
// abbreviation stays), unit "g" for the load factor. "Kurs" (as in the ILS pair Gleitpfad/Kurs) is the name of the
// lateral key figure in the approach section. Thresholds come from the Rust analysis
// (`a.config`), the bands below mirror crates/vectasim-core/src/landing.rs (module doc there).
//
// i18n: every text comes from i18n/{de,en}/landing.json → "facts.*"
// in the active language (t from ../i18n), numbers from ../i18n/number. The label tables keep
// their names and types but resolve on every access (getters), the few plain strings
// (VS_BANDS, G_BANDS, …) are live bindings refreshed on a language change.

import { getLanguage, subscribeLanguage, t } from "../i18n";
import { DASH, NNBSP, fmt, fmtClock, fmtNum, fmtSigned } from "../i18n/number";
import { sideLabel } from "./geometry";
import type {
  ApproachAnalysis,
  ApproachBand,
  ApproachCriterion,
  ApproachCriterionKind,
  ApproachGate,
  EnergyBand,
  Exceedance,
  GateKind,
  LateralBand,
  WindStats,
} from "./approachTypes";
import {
  isDerivedSource,
  type Band,
  type CheckStatus,
  type CriterionKind,
  type GateCheck,
  type LandingAnalysis,
  type LandingDebriefData,
  type RunwayGeometrySource,
  type RunwayMatch,
  type SpeedReferenceSource,
  type TouchdownPoint,
  type WindComponents,
} from "./types";

/** A label table that answers in the active language on every access (same shape as a plain Record). */
function labels<K extends string>(keys: readonly K[], text: (k: K) => string): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const k of keys) Object.defineProperty(out, k, { get: () => text(k), enumerable: true });
  return out;
}

const BANDS: readonly Band[] = ["smooth", "normal", "firm", "hard"];

export const BAND_LABEL: Record<Band, string> = labels(BANDS, (b) => t(`band.${b}`));

/** CSS custom property per band: the band scale of the theme (themes.ts ThemeColors.band), never accent/ok/warn. */
export const BAND_VAR: Record<Band, string> = {
  smooth: "var(--band-soft)",
  normal: "var(--band-normal)",
  firm: "var(--band-firm)",
  hard: "var(--band-hard)",
};

/** Marker shapes in plots and legends, so a band never depends on colour alone. */
export type BandShape = "circle" | "square" | "diamond" | "triangle";

/** sanft ● · normal ■ · fest ◆ · hart ▲ (Streubild, Sparkline, legend). */
export const BAND_SHAPE: Record<Band, BandShape> = {
  smooth: "circle",
  normal: "square",
  firm: "diamond",
  hard: "triangle",
};

/** Start of the "hart" g band (g_band in landing.rs). */
export const G_HARD = 2;
/** Landing-rate band limits in fpm (vs_band in landing.rs). */
export const VS_BAND_LIMITS = { smooth: 150, normal: 300, firm: 600 } as const;
/** g band limits (g_band in landing.rs). */
export const G_BAND_LIMITS = { smooth: 1.25, normal: 1.5, firm: G_HARD } as const;

/** de "sanft < 150 · normal < 300 · fest < 600 · hart ≥ 600 fpm" (live binding, follows the language). */
export let VS_BANDS = "";
/** de "sanft < 1,25 · normal < 1,5 · fest < 2,0 · hart ≥ 2,0 g" (live binding). */
export let G_BANDS = "";
/** Why "hart" starts at 2.0 g (Methodik; live binding). */
export let G_BAND_REASON = "";
/** Why a derived runway has no centreline offset (live binding). */
export let LATERAL_REASON = "";
/** Accuracy of the database runway coordinates (OurAirports: often 4 decimals ≈ ±5 m; live binding). */
export let RUNWAY_ACCURACY_NOTE = "";

function refreshStrings() {
  VS_BANDS = t("band.vsScale", { smooth: VS_BAND_LIMITS.smooth, normal: VS_BAND_LIMITS.normal, firm: VS_BAND_LIMITS.firm });
  G_BANDS = t("facts.gScale", { smooth: fmtNum(G_BAND_LIMITS.smooth, 2), normal: fmtNum(G_BAND_LIMITS.normal, 1), firm: fmtNum(G_BAND_LIMITS.firm, 1) });
  G_BAND_REASON = t("facts.gBandReason", {
    hard: fmt(G_HARD, 1, "g"),
    vsHard: fmt(VS_BAND_LIMITS.firm, 0, "fpm"),
    fps: fmt(10, 0, "ft/s"),
    old: fmt(1.75, 2, "g"),
    a320: fmt(2.6, 1, "g"),
    b737: fmt(2.1, 1, "g"),
  });
  LATERAL_REASON = t("facts.lateralReason");
  RUNWAY_ACCURACY_NOTE = t("facts.runwayAccuracy", { decimals: 4, accuracy: fmt(5, 0, "m") });
}
refreshStrings();
subscribeLanguage(refreshStrings);

/** Where the reference speed of the landing's speed criteria comes from (mirrors SpeedReferenceSource in landing.rs). */
export const SPEED_REF_LABEL: Record<SpeedReferenceSource, string> = labels(["user", "flown", "design", "unavailable"], (k) =>
  k === "design" ? t("facts.speedRef.design", { factor: fmtNum(1.3, 1) }) : t(`facts.speedRef.${k}`),
);

const CRITERION_KINDS: readonly ApproachCriterionKind[] = [
  "gear",
  "flaps",
  "verticalSpeed",
  "speed",
  "glidepath",
  "bank",
  "localizer",
  "altitudeDeviation",
  "speedLimit",
  "energy",
  "flapChange",
  "landingFlaps",
  "thrust",
  "spoilers",
];

export const CRITERION_LABEL: Record<ApproachCriterionKind, string> = labels(CRITERION_KINDS, (k) => t(`facts.criterion.${k}`));

export const CRITERION_ORDER: CriterionKind[] = ["gear", "flaps", "verticalSpeed", "speed", "glidepath", "bank"];
/** Row order of the approach gate table. */
export const APPROACH_CRITERION_ORDER: ApproachCriterionKind[] = [
  "gear",
  "flaps",
  "landingFlaps",
  "verticalSpeed",
  "speed",
  "speedLimit",
  "altitudeDeviation",
  "glidepath",
  "localizer",
  "energy",
  "bank",
  "thrust",
  "spoilers",
];

/** Short name of a criterion inside a sentence ("Abweichungen bei Speed"). */
export const CRITERION_SHORT: Record<ApproachCriterionKind, string> = labels(CRITERION_KINDS, (k) => t(`facts.criterionShort.${k}`));

/**
 * Units differ between the landing gates (glidepath in °) and the approach gates
 * (glidepath/localizer in dots); both compare the speed with a reference speed.
 */
export type CriterionContext = "landing" | "approach";

/** "1", "0,5" – dots without a needless ",0". */
const dotsNum = (n: number | null | undefined) => fmtNum(n, n != null && Number.isInteger(n) ? 0 : 1);
/** Glidepath tolerance in degrees: "0,35", "0,7". */
export const degNum = (n: number | null | undefined) => fmtNum(n, n != null && Math.abs(n * 10 - Math.round(n * 10)) > 1e-9 ? 2 : 1);
/** The plural unit "Dots" / "dots". */
const dotsUnit = () => t("facts.unit.dots");

export const STATUS_ICON: Record<CheckStatus, string> = { pass: "✓", fail: "✗", unavailable: "–" };

/** "3°-Pfad" helper: the path angle as shown in "zum 3°-Pfad". */
const pathAngle = (deg: number | null | undefined) => fmt(deg ?? 3, 0, "°");

/** Limit text for the table ("|V/S| ≤ 1 000 fpm"). */
export function limitText(c: ApproachCriterion, ctx: CriterionContext = "landing"): string {
  switch (c.kind) {
    case "gear":
      return t("facts.limit.gearDown");
    case "flaps":
      if (c.reference != null) return t("facts.limit.flapsLanding", { stage: fmtNum(c.reference) });
      return ctx === "approach" ? t("facts.limit.flapsMin", { stage: fmtNum(c.limitMin ?? 1) }) : t("facts.limit.flapsAny");
    case "verticalSpeed":
      return `|V/S| ≤ ${fmt(c.limitMax, 0, "fpm")}`;
    case "speed":
      return t("facts.limit.speed", { min: fmtSigned(c.limitMin, 0), max: fmtSigned(c.limitMax, 0) });
    case "glidepath":
      return ctx === "approach"
        ? t("facts.limit.glidepathApproach", { dots: dotsNum(c.limitMax), angle: pathAngle(c.reference) })
        : t("facts.limit.glidepathLanding", { ref: fmt(c.reference, 1, "°"), tol: degNum(c.limitMax) });
    case "localizer":
      return t("facts.limit.localizer", { dots: dotsNum(c.limitMax) });
    case "bank":
      return `≤ ${fmt(c.limitMax, 0, "°")}`;
    case "altitudeDeviation":
      return t("facts.limit.altitude", { limit: fmt(c.limitMax, 0, "ft"), angle: pathAngle(c.reference) });
    case "speedLimit":
      return `≤ ${fmt(c.limitMax, 0, "kt")} IAS`;
    case "energy":
      return t("facts.limit.energy", { limit: fmtSigned(c.limitMax, 0, "ft") });
    case "flapChange":
      return t("facts.limit.flapChange");
    case "landingFlaps":
      return t("facts.limit.flapsLanding", { stage: fmtNum(c.reference ?? c.limitMin) });
    case "thrust":
      return `N1 ≥ ${fmt(c.limitMin, 0, "%")}`;
    case "spoilers":
      return t("facts.limit.spoilers", { limit: fmt(c.limitMax, 0, "%") });
  }
}

/** Measured value as text ("−740 fpm", "+0,2°", "ausgefahren"). */
export function measuredText(c: ApproachCriterion, ctx: CriterionContext = "landing"): string {
  if (c.measured == null) {
    if (c.kind === "glidepath" && ctx === "landing") return t("facts.value.naNoRunway");
    if (c.kind === "speed" && ctx === "landing") return t("facts.value.naNoReference");
    return t("facts.value.na");
  }
  return valueText(c.kind, c.measured, ctx, c.reference);
}

/** A value of a criterion's kind in its unit (also used for exceedance peaks). */
export function valueText(kind: ApproachCriterionKind, v: number, ctx: CriterionContext = "approach", reference?: number | null): string {
  switch (kind) {
    case "gear":
      return v >= 95 ? t("facts.value.gearDown") : v <= 5 ? t("facts.value.gearUp") : `${fmtNum(v)}${NNBSP}%`;
    case "flaps":
    case "landingFlaps":
      return v > 0 ? t("facts.value.flapsStage", { stage: fmtNum(v) }) : t("facts.value.flapsUp");
    case "verticalSpeed":
      return fmtSigned(Math.round(v), 0, "fpm");
    case "speed":
      return reference != null ? `${fmtSigned(v, 0, "kt")} (${fmt(reference + v, 0, "kt")})` : fmtSigned(v, 0, "kt");
    case "glidepath":
      return ctx === "approach" ? fmtSigned(v, 1, dotsUnit()) : fmtSigned(v, 1, "°");
    case "localizer":
      return fmtSigned(v, 1, dotsUnit());
    case "bank":
      return fmt(Math.abs(v), 0, "°");
    case "altitudeDeviation":
    case "energy":
      return fmtSigned(Math.round(v), 0, "ft");
    case "speedLimit":
      return fmt(v, 0, "kt");
    case "flapChange":
      return v >= 0.5 ? t("facts.value.flapChanged") : t("facts.value.flapNone");
    case "thrust":
      return `${fmt(v, 0, "%")} N1`;
    case "spoilers":
      return v <= 0.5 ? t("facts.value.spoilersIn") : t("facts.value.spoilersOut", { pct: fmt(v, 0, "%") });
  }
}

export type HintTone = "ok" | "warn" | "info";
export interface Hint {
  tone: HintTone;
  text: string;
}

const gateName = (g: GateCheck) => fmt(g.gateFt, 0, "ft");

/** "bei 1 000 ft" / "at 1,000 ft" – the `at` phrase of criterionHint. */
export function atGate(gate: string): string {
  return t("facts.at", { gate });
}

/** One sentence per failed gate criterion; `at` is "bei 1 000 ft" / "bei FAF" (see atGate). */
export function criterionHint(at: string, c: ApproachCriterion, ctx: CriterionContext = "landing"): string | null {
  if (c.status !== "fail" || c.measured == null) return null;
  const m = c.measured;
  switch (c.kind) {
    case "gear":
      return t("facts.criterionHint.gear", { at, value: `${fmtNum(m)}${NNBSP}%` });
    case "flaps":
      if (c.reference != null && m > 0) return t("facts.criterionHint.flapsStage", { at, measured: fmtNum(m), ref: fmtNum(c.reference) });
      return t("facts.criterionHint.flapsUp", { at });
    case "verticalSpeed":
      return t("facts.criterionHint.verticalSpeed", { at, value: fmt(Math.abs(m), 0, "fpm"), limit: fmt(c.limitMax, 0, "fpm") });
    case "speed":
      return t("facts.criterionHint.speed", { at, value: fmtSigned(m, 0, "kt"), ref: fmt(c.reference, 0, "kt"), min: fmtSigned(c.limitMin, 0), max: fmtSigned(c.limitMax, 0) });
    case "glidepath": {
      if (ctx === "approach") {
        return t(m > 0 ? "facts.criterionHint.glidepathAbove" : "facts.criterionHint.glidepathBelow", { at, value: fmtSigned(m, 1, dotsUnit()), angle: pathAngle(c.reference), tol: dotsNum(c.limitMax) });
      }
      // one dot is the limit; beyond two dots (full scale) it is an S2 deviation
      const text = t(m > 0 ? "facts.criterionHint.glidepathLandingAbove" : "facts.criterionHint.glidepathLandingBelow", {
        at,
        value: fmtSigned(m, 2, "°"),
        angle: fmt(c.reference, 0, "°"),
        tol: degNum(c.limitMax),
      });
      return c.limitMax != null && Math.abs(m) > 2 * c.limitMax ? t("facts.criterionHint.fullScale", { text }) : text;
    }
    case "localizer":
      return t(m > 0 ? "facts.criterionHint.localizerRight" : "facts.criterionHint.localizerLeft", { at, value: fmt(Math.abs(m), 1, dotsUnit()), tol: dotsNum(c.limitMax) });
    case "bank":
      return t("facts.criterionHint.bank", { at, value: fmt(m, 0, "°"), limit: fmt(c.limitMax, 0, "°") });
    case "altitudeDeviation":
      return t(m > 0 ? "facts.criterionHint.altitudeAbove" : "facts.criterionHint.altitudeBelow", { at, value: fmt(Math.abs(m), 0, "ft"), angle: pathAngle(c.reference), tol: fmt(c.limitMax, 0, "ft") });
    case "speedLimit":
      return t("facts.criterionHint.speedLimit", { at, value: fmt(m, 0, "kt"), limit: fmt(c.limitMax, 0, "kt") });
    case "energy":
      return t("facts.criterionHint.energy", { at, value: fmtSigned(m, 0, "ft"), limit: fmtSigned(c.limitMax, 0, "ft") });
    case "flapChange":
      return t("facts.criterionHint.flapChange", { at });
    case "landingFlaps":
      if (m > 0) return t("facts.criterionHint.flapsStage", { at, measured: fmtNum(m), ref: fmtNum(c.reference ?? c.limitMin) });
      return t("facts.criterionHint.flapsUpLanding", { at, ref: fmtNum(c.reference ?? c.limitMin) });
    case "thrust":
      return t("facts.criterionHint.thrust", { at, value: fmt(m, 0, "%"), limit: fmt(c.limitMin, 0, "%") });
    case "spoilers":
      return t("facts.criterionHint.spoilers", { at, value: fmt(m, 0, "%") });
  }
}

/** In English a phrase that continues a sentence starts lower-case ("…, crosswind 5 kt"); German nouns keep their capital. */
function midSentence(s: string): string {
  return getLanguage() === "en" && s ? s[0].toLowerCase() + s.slice(1) : s;
}

/** "Gegenwind 8 kt" / "Rückenwind 3 kt". */
function headwindText(headwindKt: number): string {
  return headwindKt >= 0 ? t("facts.wind.head", { kt: fmt(headwindKt, 0, "kt") }) : t("facts.wind.tail", { kt: fmt(-headwindKt, 0, "kt") });
}

/** "kein Seitenwind" / "Seitenwind 5 kt von links". */
function crosswindText(crosswindKt: number): string {
  if (Math.abs(crosswindKt) < 0.5) return t("facts.wind.noCross");
  return t(crosswindKt > 0 ? "facts.wind.crossRight" : "facts.wind.crossLeft", { kt: fmt(Math.abs(crosswindKt), 0, "kt") });
}

/** Plain-language observations, each with the numbers it is based on. */
export function buildHints(d: LandingDebriefData, approach?: ApproachAnalysis | null): Hint[] {
  const a: LandingAnalysis = d.analysis;
  const td = a.touchdown;
  // approach hints first; its gates replace the landing's 1000/500 ft checks
  const out: Hint[] = approach ? approachHints(approach) : [];
  const tp = a.touchdownPoint;
  const rwy = a.runway;

  if (td.touchAndGo) out.push({ tone: "info", text: t("facts.hint.touchAndGo") });

  const metarAge = metarAgeNote(d);
  if (metarAge) out.push({ tone: "warn", text: t("facts.hint.metarAge", { note: metarAge }) });

  if (tp && rwy) {
    const dist = touchdownDistanceText(tp);
    const zone = t("facts.hint.zoneDetail", { zone: zoneText(tp, rwy), aim: fmt(tp.aimingPointM, 0, "m") });
    // the zone starts at the threshold: only a touchdown before it is "short"
    if (tp.distanceM < 0) out.push({ tone: "warn", text: t("facts.hint.short", { dist: touchdownDistanceText(tp, -tp.distanceM), zone }) });
    else if (tp.distanceM <= tp.tdzEndM) out.push({ tone: "ok", text: t("facts.hint.inZone", { dist, zone }) });
    else if (rwy.lengthEstimated) out.push({ tone: "warn", text: t("facts.hint.long", { dist, zone }) });
    else out.push({ tone: "warn", text: t("facts.hint.longRest", { dist, zone, rest: fmt(tp.remainingM, 0, "m") }) });
    if (isDerivedRunway(rwy)) {
      const u = fmt(tp.distanceUncertaintyM ?? rwy.alongUncertaintyM ?? 50, 0, "m");
      out.push({ tone: "info", text: t(rwy.lengthEstimated ? "facts.hint.derivedRunwayNoLength" : "facts.hint.derivedRunway", { u }) });
    }

    const widthM = rwy.widthM ?? null;
    const side = sideOfCentreline(tp.lateralM);
    if (!lateralMeasurable(tp)) {
      out.push({ tone: "info", text: t("facts.hint.lateralUnmeasurable", { reason: LATERAL_REASON }) });
    } else if (!rwy.onRunway && (widthM == null || Math.abs(tp.lateralM) > widthM / 2)) {
      out.push({ tone: "warn", text: t("facts.hint.offRunway", { side, width: widthText(widthM), ident: rwy.ident }) });
    } else if (widthM == null) {
      out.push({ tone: "info", text: t("facts.hint.widthUnknown", { side }) });
    } else {
      out.push({ tone: Math.abs(tp.lateralM) > widthM / 4 ? "warn" : "ok", text: t("facts.hint.width", { side, width: fmt(widthM, 0, "m") }) });
    }
  } else {
    out.push({ tone: "info", text: t("facts.hint.noRunway") });
  }

  if (a.threshold) {
    out.push({
      tone: "info",
      text: t("facts.hint.threshold", {
        height: fmt(a.threshold.heightFt, 0, "ft"),
        tch: fmt(a.config.tchFt, 0, "ft"),
        ias: fmt(a.threshold.iasKt, 0, "kt"),
        airborne: fmt(a.threshold.airborneS, 0, "s"),
      }),
    });
  }

  // stabilised approach (landing gates; covered by the approach analysis when present)
  const gatesHere = approach ? [] : a.gates;
  if (!approach && gatesHere.some((g) => g.reached)) {
    const ref = a.referenceSpeedKt;
    const from = fmtNum(a.config.vappFromFt);
    const to = fmt(a.config.vappToFt, 0, "ft");
    if (a.referenceSpeedSource === "flown") {
      out.push({ tone: "info", text: t("facts.hint.refFlown", { from, to, ref: fmt(ref, 0, "kt") }) });
    } else if (a.referenceSpeedSource === "design") {
      out.push({ tone: "info", text: t("facts.hint.refDesign", { ref: fmt(ref, 0, "kt"), factor: fmtNum(a.config.vs0Factor, 1), vs0: fmt(a.vs0Kt, 0, "kt"), from, to }) });
    } else if (a.referenceSpeedSource === "unavailable") {
      out.push({ tone: "info", text: t("facts.hint.refUnavailable") });
    }
    if (a.referencePlausible === false && a.vs0Kt != null) {
      out.push({
        tone: "warn",
        text: t("facts.hint.refImplausible", { ref: fmt(ref, 0, "kt"), min: fmtNum(a.config.vappMinVs0, 1), max: fmtNum(a.config.vappMaxVs0, 1), vs0: fmt(a.vs0Kt, 0, "kt") }),
      });
    }
  }
  const reached = gatesHere.filter((g) => g.reached);
  for (const g of gatesHere) {
    if (!g.reached) out.push({ tone: "info", text: t("facts.hint.gateNotReached", { gate: gateName(g) }) });
  }
  const fails = reached.flatMap((g) => g.criteria.map((c) => criterionHint(atGate(gateName(g)), c)).filter((s): s is string => !!s));
  for (const f of fails) out.push({ tone: "warn", text: f });
  if (reached.length > 0 && fails.length === 0) {
    const unavailable = reached.some((g) => g.criteria.some((c) => c.status === "unavailable"));
    out.push({ tone: "ok", text: t(unavailable ? "facts.hint.gatesOkMeasurable" : "facts.hint.gatesOk", { gates: listAnd(reached.map(gateName)) }) });
  }

  // touchdown values
  if (td.landingRateSource === "measured") {
    out.push({ tone: "info", text: t("facts.hint.rateMeasured", { rate: fmt(td.landingRateFpm, 0, "fpm") }) });
  } else if (Math.abs(td.landingRateFpm - td.vsFpmMeasured) >= 50) {
    out.push({ tone: "info", text: t("facts.hint.rateDiff", { rate: fmt(td.landingRateFpm, 0, "fpm"), vs: fmt(td.vsFpmMeasured, 0, "fpm") }) });
  }
  if (td.bounces > 0) {
    out.push({ tone: "warn", text: t("facts.hint.bounces", { count: td.bounces, hardest: fmt(td.vsFpmHardest, 0, "fpm"), gap: fmt(0.3, 1, "s") }) });
  }

  if (a.flare) {
    out.push({
      tone: "info",
      text: t("facts.hint.flare", {
        from: fmt(a.flare.startHatFt, 0, "ft"),
        vs1: fmt(Math.abs(a.flare.approachVsFpm), 0, "fpm"),
        vs2: fmt(Math.abs(a.flare.finalVsFpm), 0, "fpm"),
        dur: fmt(a.flare.durationS, 0, "s"),
      }),
    });
  } else if (a.samples.length > 0 && !td.touchAndGo) {
    out.push({ tone: "info", text: t("facts.hint.noFlare", { pct: `${fmtNum(a.config.flareVsFraction * 100)}${NNBSP}%` }) });
  }

  // wind
  const w = a.wind;
  if (w && w.headwindKt != null && w.crosswindKt != null) {
    const ref = w.relativeToRunway ? `RWY ${rwy?.ident ?? ""}`.trim() : t("facts.hint.windHeading");
    const parts = [headwindText(w.headwindKt), midSentence(crosswindText(w.crosswindKt))];
    if (w.gustCrosswindKt != null) parts.push(t("facts.hint.windGustCross", { kt: fmt(Math.abs(w.gustCrosswindKt), 0, "kt") }));
    const worst = worstCrosswindText(w);
    if (worst) parts.push(t("facts.hint.windWorstWithin", { worst }));
    const metar = windText(w.directionDeg, w.speedKt, w.gustKt, w.variableFromDeg, w.variableToDeg);
    out.push({ tone: w.headwindKt < -0.5 ? "warn" : "info", text: t("facts.hint.wind", { parts: parts.join(", "), metar, ref }) });
  } else if (w) {
    const worst = worstCrosswindText(w, true);
    const kt = fmt(w.speedKt, 0, "kt");
    const text = w.gustKt ? t("facts.hint.windVariableGust", { kt, gust: fmt(w.gustKt, 0, "kt") }) : t("facts.hint.windVariable", { kt });
    out.push({ tone: "info", text: worst ? t("facts.hint.windWorstCase", { text, worst }) : text });
  }

  if (a.rollout) {
    const rest = a.rollout.remainingM;
    const vars = { end: fmt(a.config.rolloutEndKt, 0, "kt"), dist: fmt(a.rollout.distanceM, 0, "m"), dur: fmt(a.rollout.durationS, 0, "s") };
    out.push({
      tone: rest != null && rest < 0 ? "warn" : "info",
      text:
        rest == null
          ? t("facts.hint.rollout", vars)
          : rest >= 0
            ? t("facts.hint.rolloutRest", { ...vars, rest: fmt(rest, 0, "m") })
            : t("facts.hint.rolloutOverrun", { ...vars, over: fmt(-rest, 0, "m") }),
    });
  }
  return out;
}

/** "Piste 45 m breit" helper: "45 m" or "Breite unbekannt". */
export function widthText(widthM: number | null | undefined): string {
  return widthM != null && widthM > 0 ? fmt(widthM, 0, "m") : t("facts.widthUnknown");
}

/** "0–467 m": the touchdown zone, from the threshold. */
export function zoneRange(tp: { tdzStartM: number; tdzEndM: number }): string {
  return `${fmtNum(tp.tdzStartM)}–${fmt(tp.tdzEndM, 0, "m")}`;
}

/** The zone as said in the debrief: without a declared length it is the fixed 0–900 m, an assumption. */
export function zoneText(tp: { tdzStartM: number; tdzEndM: number }, rwy: Pick<RunwayMatch, "lengthEstimated"> | null | undefined): string {
  return rwy?.lengthEstimated ? t("facts.zoneAssumed", { range: zoneRange(tp) }) : zoneRange(tp);
}

// ---- runway geometry source (R2) --------------------------------------------------------

/** Source of a matched runway; old payloads without `source` are database runways. */
export function runwaySourceOf(rwy: Pick<RunwayMatch, "source"> | null | undefined): RunwayGeometrySource {
  return rwy?.source ?? "database";
}

export const isDerivedRunway = (rwy: Pick<RunwayMatch, "source"> | null | undefined): boolean => isDerivedSource(runwaySourceOf(rwy));

/** False only when the backend says so (derived runway); older payloads are measurable. */
export const lateralMeasurable = (tp: Pick<TouchdownPoint, "lateralMeasurable">): boolean => tp.lateralMeasurable !== false;

/** "412 m" or, with a derived threshold, "412 ± 50 m" (`value` overrides the shown distance). */
export function touchdownDistanceText(tp: Pick<TouchdownPoint, "distanceM" | "distanceUncertaintyM">, value: number = tp.distanceM): string {
  const u = tp.distanceUncertaintyM;
  return u != null && u > 0 ? `${fmtNum(value, 0)} ± ${fmt(u, 0, "m")}` : fmt(value, 0, "m");
}

/** "Mittellinie" text of a touchdown: the side, or "nicht messbar" with a derived runway. */
export function lateralText(tp: Pick<TouchdownPoint, "lateralM" | "lateralMeasurable">): string {
  return lateralMeasurable(tp) ? sideLabel(tp.lateralM) : t("facts.notMeasurable");
}

/** "3 m rechts der Mittellinie" / "auf der Mittellinie" (de); "3 m right of the centreline" (en). Whole metres like sideLabel. */
export function sideOfCentreline(lateralM: number): string {
  const a = Math.abs(lateralM);
  if (a < 0.5) return t("landing.side.onCentreline");
  return t(lateralM > 0 ? "landing.side.rightOfCentreline" : "landing.side.leftOfCentreline", { m: fmt(a, 0, "m") });
}

/** The line under the runway name: where its geometry comes from. */
export function runwaySourceNote(rwy: Pick<RunwayMatch, "source" | "derivedFromLandings">): string {
  const landings = t("count.landings", { count: rwy.derivedFromLandings ?? 1 });
  const source = runwaySourceOf(rwy);
  switch (source) {
    case "database":
    case "user":
      return t(`facts.runwaySource.${source}`);
    case "derived":
    case "databaseDerived":
      return t(`facts.runwaySource.${source}`, { landings });
  }
}

/** Short label of a source (runway editor). */
export const RUNWAY_SOURCE_SHORT: Record<RunwayGeometrySource, string> = labels(["database", "derived", "databaseDerived", "user"], (k) =>
  t(`facts.runwaySourceShort.${k === "databaseDerived" ? "derived" : k}`),
);

/** "240°/12G22 kt", "VRB/3 kt", with a variability range "240°/12 kt (210–280°)". */
export function windText(dir: number | null | undefined, speed: number, gust?: number | null, varFrom?: number | null, varTo?: number | null): string {
  const d = dir == null ? "VRB" : `${String(Math.round(dir)).padStart(3, "0")}°`;
  const range = varFrom != null && varTo != null ? ` (${fmtNum(varFrom)}–${fmtNum(varTo)}°)` : "";
  return `${d}/${fmtNum(speed)}${gust ? `G${fmtNum(gust)}` : ""}${NNBSP}kt${range}`;
}

/**
 * Worst crosswind of a variable wind: "bis 9 kt von rechts" (dddVddd range), "bis 3 kt
 * von beliebiger Seite" (VRB), with gusts ", in Böen bis 15 kt"; null without variability.
 * `long`: "bis zu 9 kt …" (after "Seitenwind" in the variable-wind hint).
 */
export function worstCrosswindText(w: WindComponents, long = false): string | null {
  if (w.maxCrosswindKt == null) return null;
  const side = w.maxCrosswindFromRight == null ? t("facts.wind.sideAny") : w.maxCrosswindFromRight ? t("facts.wind.sideRight") : t("facts.wind.sideLeft");
  const text = t(long ? "facts.wind.worstLong" : "facts.wind.worst", { kt: fmt(w.maxCrosswindKt, 0, "kt"), side });
  return w.maxGustCrosswindKt != null ? t("facts.wind.worstGust", { text, kt: fmt(w.maxGustCrosswindKt, 0, "kt") }) : text;
}

/** Head/crosswind as a compact line for the header: "Gegenwind 8 kt · Seitenwind 5 kt von links, Böen 9 kt · bis 9 kt von rechts". */
export function windComponentsText(a: LandingAnalysis): string {
  const w = a.wind;
  if (!w) return DASH;
  const worst = worstCrosswindText(w);
  if (w.headwindKt == null || w.crosswindKt == null) return worst ? t("facts.wind.crossOnly", { worst }) : DASH;
  let xw = crosswindText(w.crosswindKt);
  if (w.gustCrosswindKt != null && Math.abs(w.gustCrosswindKt) >= 0.5) xw = t("facts.wind.gusts", { text: xw, kt: fmt(Math.abs(w.gustCrosswindKt), 0, "kt") });
  return [headwindText(w.headwindKt), xw, worst].filter(Boolean).join(" · ");
}

/** Minutes between the METAR observation and the touchdown above which the debrief warns. */
export const METAR_MAX_AGE_MIN = 60;

/**
 * "METAR von 13:20z (älter als 1 h)" when the report was observed more than 60 min before
 * the touchdown, "METAR von 16:50z (über 1 h nach der Landung)" when after; else null.
 */
export function metarAgeNote(d: Pick<LandingDebriefData, "metarObservedMs" | "analysis">): string | null {
  const obs = d.metarObservedMs;
  if (obs == null) return null;
  const minutes = (d.analysis.touchdown.timestampMs - obs) / 60000;
  if (Math.abs(minutes) <= METAR_MAX_AGE_MIN) return null;
  const vars = { at: fmtClock(obs, { local: false }), age: fmt(METAR_MAX_AGE_MIN / 60, 0, "h") };
  return minutes > 0 ? t("facts.metarOld", vars) : t("facts.metarAfter", vars);
}

// ---- key sentence ----------------------------------------------------------------------

/** Band of a landing rate (mirrors vs_band in crates/vectasim-core/src/landing.rs). */
export function vsBandOf(fpm: number): Band {
  const v = Math.abs(fpm);
  return v < VS_BAND_LIMITS.smooth ? "smooth" : v < VS_BAND_LIMITS.normal ? "normal" : v < VS_BAND_LIMITS.firm ? "firm" : "hard";
}

/** Where on the runway, as a phrase ("in der Aufsetzzone"); the zone starts at the threshold. */
export function zonePhrase(a: LandingAnalysis): string | null {
  const tp = a.touchdownPoint;
  if (!tp || !a.runway) return null;
  if (tp.distanceM < 0) return t("facts.key.beforeThreshold");
  if (tp.distanceM <= tp.tdzEndM) return t("facts.key.inZone");
  return t("facts.key.beyondZone");
}

/**
 * The one sentence the debrief opens with: band of the landing rate, where on the
 * runway, offset from the centreline, bounces. "Normale Landung in der Aufsetzzone,
 * 2 m links der Mittellinie, ohne Bounce." The head is one key per band (the German
 * adjective is inflected), the clauses are a comma list in both languages.
 */
export function keySentence(d: LandingDebriefData): string {
  const a = d.analysis;
  const td = a.touchdown;
  const head = td.touchAndGo ? t(`facts.key.headTouchAndGo.${a.vsBand}`) : t(`facts.key.head.${a.vsBand}`);
  const parts: string[] = [];
  const zone = zonePhrase(a);
  if (zone && a.touchdownPoint) {
    parts.push(zone);
    if (lateralMeasurable(a.touchdownPoint)) parts.push(sideOfCentreline(a.touchdownPoint.lateralM));
  } else {
    parts.push(t("facts.key.noRunway"));
  }
  parts.push(td.bounces === 0 ? t("facts.key.noBounce") : t("facts.key.bounces", { count: td.bounces }));
  return t("facts.key.sentence", { head, clauses: parts.join(", ") });
}

// ---- provenance (source chips, Messprotokoll) ------------------------------------------

export type SourceKind = "sim" | "measured" | "derived";
const SOURCE_KINDS: readonly SourceKind[] = ["sim", "measured", "derived"];
/** Chip text: SIM / GEM. / ABGEL. (en SIM / MEAS. / DERIV.). */
export const SOURCE_LABEL: Record<SourceKind, string> = labels(SOURCE_KINDS, (k) => t(`facts.source.label.${k}`));
/** Plain-language name of a source: chip tooltip and popover title (Sim-Wert / gemessen aus dem Track / abgeleitet aus Geometrie). */
export const SOURCE_NAME: Record<SourceKind, string> = labels(SOURCE_KINDS, (k) => t(`facts.source.name.${k}`));

export interface Provenance {
  kind: SourceKind;
  detail: string;
  /** Sim and measured value disagree by more than 50 fpm. */
  warn?: boolean;
}

/** Median sample rate of a sample list (Hz), from the tMs gaps; null below 2 samples. */
export function sampleRateHz(samples: Array<{ tMs: number }>): number | null {
  const gaps: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const g = samples[i].tMs - samples[i - 1].tMs;
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return null;
  gaps.sort((x, y) => x - y);
  return 1000 / gaps[Math.floor(gaps.length / 2)];
}

/** Sentences of a detail text, joined with a space (each key is a whole sentence). */
const sentences = (...s: Array<string | false | null | undefined>) => s.filter(Boolean).join(" ");

/** Source chip text for the three hero values. */
export function provenance(d: LandingDebriefData): { rate: Provenance; point: Provenance; g: Provenance } {
  const a = d.analysis;
  const td = a.touchdown;
  const diff = td.vsFpmSim ? Math.abs(td.vsFpmSim - td.vsFpmMeasured) : 0;
  const rate: Provenance =
    td.landingRateSource === "sim"
      ? {
          kind: "sim",
          warn: diff > 50,
          detail: sentences(
            t("facts.prov.rateSim", { rate: fmt(td.landingRateFpm, 0, "fpm"), measured: fmt(td.vsFpmMeasured, 0, "fpm") }),
            td.bounces > 0 && t("facts.prov.rateHardest", { hardest: fmt(td.vsFpmHardest, 0, "fpm") }),
            diff > 50 && t("facts.prov.rateDiff", { diff: fmt(diff, 0, "fpm") }),
          ),
        }
      : { kind: "measured", detail: t("facts.prov.rateMeasured", { rate: fmt(td.landingRateFpm, 0, "fpm") }) };
  const disp = d.thresholdDisplacedM;
  const tp = a.touchdownPoint;
  const source = runwaySourceOf(a.runway);
  const ident = a.runway?.ident ?? "";
  const point: Provenance = tp
    ? {
        kind: "derived",
        detail: isDerivedSource(source)
          ? sentences(
              t("facts.prov.pointDerived", { ident, dist: touchdownDistanceText(tp), u: fmt(tp.distanceUncertaintyM ?? 50, 0, "m") }),
              a.runway?.lengthEstimated && t("facts.prov.lengthUnknown"),
            )
          : sentences(
              t("facts.prov.pointDb", { ident, source: source === "user" ? t("facts.prov.byYou") : "OurAirports", dist: fmt(tp.distanceM, 0, "m"), side: sideLabel(tp.lateralM) }),
              disp != null && disp > 0 && source !== "user" && t("facts.prov.displaced", { m: fmt(disp, 0, "m") }),
              source !== "user" && RUNWAY_ACCURACY_NOTE,
            ),
      }
    : { kind: "derived", detail: t("facts.prov.noRunway") };
  const g: Provenance = { kind: "measured", detail: t("facts.prov.g", { max: fmt(5, 0, "g") }) };
  return { rate, point, g };
}

// ---- VectaSim-Index ----------------------------------------------------------------------
// A small summary number, never the headline: the weighted share of points from the same
// bands and checks the debrief shows. The Methodik section prints the formula from these
// constants (indexFormulaLines), so text and calculation cannot drift apart.

/** "Normal" earns as much as "sanft": a firm touchdown without floating is what Boeing/Airbus ask for (13 I1). */
export const INDEX_BAND_POINTS: Record<Band, number> = { smooth: 1, normal: 1, firm: 0.4, hard: 0 };
/** Zone points: in the zone 1 · from its end to the middle of the runway 0.3 · beyond or before the threshold 0. */
export const INDEX_ZONE_POINTS = { inZone: 1, toMidpoint: 0.3, beyond: 0, beforeThreshold: 0 };

export type IndexKey = "rate" | "g" | "bounces" | "zone" | "centreline" | "stable";
export const INDEX_WEIGHTS: Record<IndexKey, number> = { rate: 30, g: 15, bounces: 15, zone: 15, centreline: 10, stable: 15 };
export const INDEX_LABEL: Record<IndexKey, string> = labels(["rate", "g", "bounces", "zone", "centreline", "stable"], (k) => t(`facts.index.label.${k}`));

export interface IndexPart {
  key: IndexKey;
  weight: number;
  /** 0…1; null = not measurable (no runway, width unknown, no gate reached). */
  points: number | null;
}

export interface LandingIndex {
  /** 0…100, rounded; null when a part is not measurable – then the index is not comparable. */
  value: number | null;
  parts: IndexPart[];
  /** Why the index is not shown ("ohne Piste", "Breite unbekannt", "ohne Gate"); null when complete. */
  incomplete: string | null;
}

/** Points per part; indexFormulaLines states the same rules in words. */
/** Index points of "stabil ab": from 1000 ft 1.0, linear down to 0 at 500 ft; never stable 0. */
export function stableFromPoints(stableFromFt: number | null): number {
  if (stableFromFt == null) return 0;
  return Math.max(0, Math.min(1, (stableFromFt - INDEX_STABLE_LOW_FT) / (INDEX_STABLE_HIGH_FT - INDEX_STABLE_LOW_FT)));
}
export const INDEX_STABLE_HIGH_FT = 1000;
export const INDEX_STABLE_LOW_FT = 500;

/** Share of the measurable criteria passed at the 1000/500 ft gates; null = none measurable. */
export function gateShare(criteria: Array<{ status: CheckStatus }>): number | null {
  const evaluated = criteria.filter((c) => c.status !== "unavailable");
  return evaluated.length ? evaluated.filter((c) => c.status === "pass").length / evaluated.length : null;
}

/**
 * The "Stabilisierter Anflug" part: with an approach analysis half "stabil ab", half the gate
 * share at 1000/500 ft (only "stabil ab" when no gate criterion is measurable); without one
 * the landing's own gate share.
 */
export function stablePoints(a: LandingAnalysis, approach?: ApproachAnalysis | null): number | null {
  if (approach && approach.band != null) {
    const sf = stableFromPoints(approach.stability.stableFromFt);
    const share = gateShare(approach.gates.filter((g) => g.reached && (g.kind === "ft1000" || g.kind === "ft500")).flatMap((g) => g.criteria));
    return share == null ? sf : 0.5 * sf + 0.5 * share;
  }
  return gateShare(a.gates.filter((g) => g.reached).flatMap((g) => g.criteria));
}

export function indexParts(a: LandingAnalysis, approach?: ApproachAnalysis | null): IndexPart[] {
  const td = a.touchdown;
  const tp = a.touchdownPoint;
  const rwy = a.runway;
  const part = (key: IndexKey, points: number | null): IndexPart => ({ key, weight: INDEX_WEIGHTS[key], points });

  let zone: number | null = null;
  let centre: number | null = null;
  if (tp && rwy) {
    const z = INDEX_ZONE_POINTS;
    zone = tp.distanceM < 0 ? z.beforeThreshold : tp.distanceM <= tp.tdzEndM ? z.inZone : tp.distanceM <= rwy.lengthM / 2 ? z.toMidpoint : z.beyond;
    const off = Math.abs(tp.lateralM);
    const w = rwy.widthM;
    centre = !lateralMeasurable(tp) || w == null || w <= 0 ? null : off <= w / 4 ? 1 : off <= w / 2 ? 0.5 : 0;
  }
  const stable = stablePoints(a, approach);

  return [
    part("rate", INDEX_BAND_POINTS[a.vsBand]),
    part("g", INDEX_BAND_POINTS[a.gBand]),
    part("bounces", td.bounces === 0 ? 1 : td.bounces === 1 ? 0.4 : 0),
    part("zone", zone),
    part("centreline", centre),
    part("stable", stable),
  ];
}

/**
 * The index only exists when every part is measurable: leaving parts out would make a
 * 90 without runway look as good as a 90 with one (13 I4).
 */
export function landingIndex(a: LandingAnalysis, approach?: ApproachAnalysis | null): LandingIndex {
  const parts = indexParts(a, approach);
  const missing = parts.filter((p) => p.points == null).map((p) => p.key);
  if (missing.length) {
    const why = !a.runway || !a.touchdownPoint
      ? t("facts.index.noRunway")
      : missing.includes("centreline")
        ? lateralMeasurable(a.touchdownPoint)
          ? t("facts.index.widthUnknown")
          : t("facts.index.lateralUnmeasurable")
        : t("facts.index.noGate");
    return { value: null, parts, incomplete: why };
  }
  const total = parts.reduce((s, p) => s + p.weight, 0);
  const got = parts.reduce((s, p) => s + p.weight * (p.points ?? 0), 0);
  return { value: Math.round((100 * got) / total), parts, incomplete: null };
}

/** "87 / 100" or "nicht vergleichbar (ohne Piste)". */
export function indexText(i: LandingIndex): string {
  return i.value != null ? `${i.value}${NNBSP}/${NNBSP}100` : t("facts.index.notComparable", { why: i.incomplete ?? "" });
}

/** The formula in words, for the Methodik section. */
export function indexFormulaLines(): string[] {
  const bp = INDEX_BAND_POINTS;
  const z = INDEX_ZONE_POINTS;
  const p = (n: number) => fmtNum(n, 1);
  const bands = BANDS.map((b) => t("facts.index.bandPoints", { band: t(`band.${b}`), points: p(bp[b]) })).join(" · ");
  const w = INDEX_WEIGHTS;
  return [
    t("facts.index.formula.total"),
    t("facts.index.formula.rate", { wRate: w.rate, wG: w.g, bands }),
    t("facts.index.formula.bounces", { w: w.bounces, p0: p(1), p1: p(0.4), p2: p(0) }),
    t("facts.index.formula.zone", { w: w.zone, inZone: p(z.inZone), toMid: p(z.toMidpoint), beyond: p(z.beyond), before: p(z.beforeThreshold) }),
    t("facts.index.formula.centreline", { w: w.centreline, p1: p(1), p2: p(0.5), p3: p(0) }),
    t("facts.index.formula.stable", {
      w: w.stable,
      high: fmt(INDEX_STABLE_HIGH_FT, 0, "ft"),
      low: fmt(INDEX_STABLE_LOW_FT, 0, "ft"),
      one: p(1),
      zero: p(0),
      gate1: fmtNum(INDEX_STABLE_HIGH_FT),
      gate2: fmt(INDEX_STABLE_LOW_FT, 0, "ft"),
    }),
  ];
}

// ---- approach (approach_analysis) -----------------------------------------------------
// Same tone as the landing: facts with the limit they are compared with. `null` in the
// analysis means "not measurable" and is said so, never counted as a failure.

export const APPROACH_BAND_LABEL: Record<ApproachBand, string> = labels(["stable", "deviations", "unstable", "unstableBelow500"], (k) =>
  k === "unstableBelow500" ? t("facts.approachBand.unstableBelow500", { ft: fmt(500, 0, "ft") }) : t(`facts.approachBand.${k}`),
);

/** CSS custom property per approach band: the band scale (stabil = sanft, Abweichungen = fest, instabil = hart). */
export const APPROACH_BAND_VAR: Record<ApproachBand, string> = {
  stable: "var(--aband-stable)",
  deviations: "var(--aband-dev)",
  unstable: "var(--aband-unstable)",
  unstableBelow500: "var(--aband-unstable)",
};

/** Same shapes as the landing bands of the same meaning: stabil ●, Abweichungen ◆, instabil ▲. */
export const APPROACH_BAND_SHAPE: Record<ApproachBand, BandShape> = {
  stable: "circle",
  deviations: "diamond",
  unstable: "triangle",
  unstableBelow500: "triangle",
};

/** Gate names; the numbers follow the language ("1 000 ft" / "1,000 ft"). */
export const GATE_LABEL: Record<GateKind, string> = labels(["tenNm", "faf", "ft1000", "ft500", "ft50"], (k) => {
  switch (k) {
    case "tenNm":
      return fmt(10, 0, "nm");
    case "faf":
      return "FAF";
    case "ft1000":
      return fmt(1000, 0, "ft");
    case "ft500":
      return fmt(500, 0, "ft");
    case "ft50":
      return fmt(50, 0, "ft");
  }
});

/** "Speed", "Speed und Sinkrate", "Speed, Sinkrate und Gleitpfad" (en "… and …"). */
export function listAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return t("facts.and", { rest: items.slice(0, -1).join(", "), last: items[items.length - 1] });
}

const distinctKinds = (ex: Exceedance[]): ApproachCriterionKind[] => [...new Set(ex.map((e) => e.kind))];

/** Heights in sentences: rounded to 10 ft below 1000 ft, to 50 ft above. */
function hatRounded(h: number): number {
  const step = Math.abs(h) < 1000 ? 10 : 50;
  return Math.round(h / step) * step;
}
const hatText = (h: number) => fmt(hatRounded(h), 0, "ft");

/** Why a gate criterion has no value ("bei 10 nm nicht eingedreht"). */
export function unavailableReason(a: ApproachAnalysis, g: ApproachGate, c: ApproachCriterion): string {
  if (!g.reached) return t("facts.unavailable.gateNotReached");
  const notEstablished = !a.established || (g.sample != null && a.established.tMs > g.sample.tMs);
  switch (c.kind) {
    case "altitudeDeviation":
    case "energy":
      if (!a.runway) return t("facts.unavailable.noRunway");
      if (c.kind === "energy" && a.reference.vappKt == null) return t("facts.unavailable.noRefSpeed");
      if (notEstablished) return t("facts.unavailable.notEstablished", { gate: GATE_LABEL[g.kind] });
      return t("facts.unavailable.notOnFinal");
    case "speed":
      return t("facts.unavailable.noRefSpeed");
    case "glidepath":
    case "localizer":
      if (!a.runway) return t("facts.unavailable.noRunway");
      return notEstablished ? t("facts.unavailable.notEstablished", { gate: GATE_LABEL[g.kind] }) : t("facts.unavailable.notOnFinal");
    default:
      return t("facts.unavailable.noData");
  }
}

/** Height range of an exceedance: "bei 380 ft" / "zwischen 1 000 und 760 ft". */
export function exceedanceRange(e: Exceedance): string {
  const hi = Math.max(e.startHatFt, e.endHatFt);
  const lo = Math.min(e.startHatFt, e.endHatFt);
  if (hi - lo < 50) return t("facts.exceedance.at", { h: hatText((hi + lo) / 2) });
  return t("facts.exceedance.between", { hi: fmtNum(hatRounded(hi)), lo: hatText(lo) });
}

/** "Sinkrate −1 450 fpm für 6 s bei 380 ft". */
export function exceedancePhrase(e: Exceedance, a?: ApproachAnalysis): string {
  const range = exceedanceRange(e);
  if (e.kind === "flapChange") return t("facts.exceedance.flapChange", { range });
  const vars = { name: CRITERION_SHORT[e.kind], peak: valueText(e.kind, e.peak, "approach"), dur: fmt(e.durationS, 0, "s"), range };
  return e.kind === "speed" && a?.reference.vappKt != null ? t("facts.exceedance.phraseRef", vars) : t("facts.exceedance.phrase", vars);
}

/** The one exceedance a sentence names: highest level, then below 500 ft, then the lowest. */
export function mainExceedance(a: ApproachAnalysis): Exceedance | null {
  if (!a.exceedances.length) return null;
  return [...a.exceedances].sort(
    (x, y) =>
      (y.level === "s2" ? 1 : 0) - (x.level === "s2" ? 1 : 0) ||
      (y.below500 ? 1 : 0) - (x.below500 ? 1 : 0) ||
      Math.min(x.startHatFt, x.endHatFt) - Math.min(y.startHatFt, y.endHatFt),
  )[0];
}

const gateOf = (a: ApproachAnalysis, k: GateKind) => a.gates.find((g) => g.kind === k) ?? null;

/** "die geflogene Referenz" / "die Referenz (132 kt)". */
function refPhrase(a: ApproachAnalysis): string {
  return a.reference.vappSource === "flown" ? t("facts.ref.flown") : t("facts.ref.value", { kt: fmt(a.reference.vappKt, 0, "kt") });
}

/** Notable speed (≥ 10 kt) or height (≥ 100 ft) offset at the FAF as a sentence, else null. */
function fafNote(a: ApproachAnalysis): string | null {
  const s = gateOf(a, "faf")?.sample;
  if (!s) return null;
  if (s.iasDevKt != null && a.reference.vappKt != null && Math.abs(s.iasDevKt) >= SPEED_HIGH_INFO_KT) {
    return t(s.iasDevKt > 0 ? "facts.faf.faster" : "facts.faf.slower", { kt: fmt(Math.abs(s.iasDevKt), 0, "kt"), ref: refPhrase(a) });
  }
  if (s.altDevFt != null && Math.abs(s.altDevFt) >= 100) {
    return `${t(s.altDevFt > 0 ? "facts.faf.above" : "facts.faf.below", { ft: fmt(Math.abs(s.altDevFt), 0, "ft"), angle: fmt(a.reference.glidepathDeg, 0, "°") })}.`;
  }
  return null;
}

// ---- lateral guidance (extended centreline) ----------------------------------------------
// Bands are a VectaSim convention (crates/vectasim-core/src/approach.rs, `lat_band_*`): FSF
// ALAR only uses ±1 dot as the gate limit.

export const LATERAL_BAND_LABEL: Record<LateralBand, string> = labels(["onCentreline", "slight", "marked"], (k) => t(`facts.lateralBand.${k}`));

type LateralWhy = "noRunway" | "derived" | "fewSamples";

function lateralWhy(a: ApproachAnalysis): LateralWhy | null {
  if (!a.runway) return "noRunway";
  if (isDerivedRunway(a.runway) || a.lateral?.measurable === false) return "derived";
  if (!a.lateral || a.lateral.lateralBand == null) return "fewSamples";
  return null;
}

/** Why the lateral guidance has no band: no runway, a runway derived from the own track, too few samples; null = assessed. */
export function lateralUnmeasurableReason(a: ApproachAnalysis): string | null {
  const why = lateralWhy(a);
  return why ? t(`facts.lateral.${why}`) : null;
}

/** Largest |localizer deviation| below 500 ft (down to the band window bottom), from the profile; null without values. */
export function maxLocBelow500(a: ApproachAnalysis): number | null {
  let best: number | null = null;
  for (const p of a.samples) {
    if (p.onGround || p.locDots == null || p.hatFt >= 500 || p.hatFt < a.config.windowBottomFt) continue;
    if (best == null || Math.abs(p.locDots) > Math.abs(best)) best = p.locDots;
  }
  return best;
}

/** Hero sub-line: "max. +0,4 Dots · bei 500 ft 12 m rechts · Schwelle 3 m links". */
export function lateralSubLine(a: ApproachAnalysis): string {
  const why = lateralWhy(a);
  const l = a.lateral;
  if (!l || (why && why !== "fewSamples")) return why ? t(`facts.lateral.${why}`) : t("facts.notMeasurable");
  const parts: string[] = [];
  if (l.locMaxDots != null) parts.push(t("facts.lateral.max", { dots: fmtSigned(l.locMaxDots, 1) }));
  if (l.latAt500M != null) parts.push(t("facts.lateral.atGate", { gate: fmt(500, 0, "ft"), side: sideLabel(l.latAt500M) }));
  if (l.latAtThresholdM != null) parts.push(t("facts.lateral.threshold", { side: sideLabel(l.latAtThresholdM) }));
  return parts.join(" · ") || t("facts.lateral.fewSamples");
}

/** "Kurs" line of the facts block: band, intercept overshoot, S-turns. */
export function lateralFactText(a: ApproachAnalysis): string {
  const why = lateralUnmeasurableReason(a);
  const l = a.lateral;
  if (!l || l.lateralBand == null || why) return why ?? t("facts.notMeasurable");
  const parts = [LATERAL_BAND_LABEL[l.lateralBand]];
  parts.push(
    l.interceptOvershootM != null
      ? t("facts.lateral.overshoot", { m: fmt(Math.abs(l.interceptOvershootM), 0, "m"), dots: fmtNum(Math.abs(l.interceptOvershootDots ?? 0), 1) })
      : t("facts.lateral.noOvershoot"),
  );
  if (l.lateralReversals != null) parts.push(l.lateralReversals === 0 ? t("facts.lateral.noSTurns") : t("facts.lateral.reversals", { count: l.lateralReversals }));
  return parts.join(" · ");
}

/** Key-sentence clause when the lateral band is not "on the centreline": "bei 500 ft 40 m rechts der verlängerten Mittellinie". */
function lateralClause(a: ApproachAnalysis): string | null {
  const l = a.lateral;
  if (!l || l.lateralBand == null || l.lateralBand === "onCentreline" || lateralUnmeasurableReason(a)) return null;
  if (l.latAt500M != null && Math.abs(l.latAt500M) >= 0.5) {
    return t(l.latAt500M > 0 ? "facts.lateral.clauseRight" : "facts.lateral.clauseLeft", { gate: fmt(500, 0, "ft"), m: fmt(Math.abs(l.latAt500M), 0, "m") });
  }
  const band = LATERAL_BAND_LABEL[l.lateralBand];
  return l.locMaxDots != null ? t("facts.lateral.clauseBandMax", { band, max: fmtSigned(l.locMaxDots, 1) }) : t("facts.lateral.clauseBand", { band });
}

/** Lateral observations: intercept overshoot, S-turns, offset below 500 ft, over the threshold, not assessable. */
export function lateralHints(a: ApproachAnalysis): Hint[] {
  const out: Hint[] = [];
  if (!a.runway) return out; // the "Keine Piste zugeordnet" hint already names it
  const l = a.lateral;
  if (isDerivedRunway(a.runway) || l?.measurable === false) {
    out.push({ tone: "info", text: t("facts.lateralHint.derived") });
    return out;
  }
  if (!l) return out;
  const od = l.interceptOvershootDots;
  if (l.interceptOvershootM != null && od != null && Math.abs(od) > 0.5) {
    out.push({
      tone: "warn",
      text: t(l.interceptOvershootM > 0 ? "facts.lateralHint.overshootRight" : "facts.lateralHint.overshootLeft", { m: fmt(Math.abs(l.interceptOvershootM), 0, "m"), dots: fmtNum(Math.abs(od), 1) }),
    });
  }
  const rev = l.lateralReversals;
  // two or more side changes are a learning point, not just a note
  if (rev != null && rev >= 2) {
    out.push({
      tone: "warn",
      text: t("facts.lateralHint.sTurns", {
        count: rev,
        top: fmtNum(a.config.windowTopFt),
        floor: fmt(a.config.latReversalFloorFt ?? 100, 0, "ft"),
        dots: fmtNum(a.config.latReversalDots ?? 0.3, 1),
      }),
    });
  }
  const low = maxLocBelow500(a);
  if (low != null && Math.abs(low) > 0.5) {
    out.push({ tone: "warn", text: t(low > 0 ? "facts.lateralHint.lowRight" : "facts.lateralHint.lowLeft", { gate: fmt(500, 0, "ft"), dots: fmtNum(Math.abs(low), 1), limit: fmtNum(0.5, 1) }) });
  }
  const thr = l.latAtThresholdM;
  if (thr != null && a.outcome.kind !== "goAround" && Math.abs(thr) > 10) {
    const w = a.runway.widthM;
    const warn = w != null && w > 0 && Math.abs(thr) > w / 4;
    const side = sideOfCentreline(thr);
    out.push({ tone: warn ? "warn" : "info", text: warn ? t("facts.lateralHint.thresholdWide", { side, width: fmt(w, 0, "m") }) : t("facts.lateralHint.threshold", { side }) });
  }
  if (l.lateralBand === "onCentreline" && out.length === 0) {
    out.push({
      tone: "ok",
      text: t("facts.lateralHint.held", { top: fmtNum(a.config.windowTopFt), bottom: fmt(a.config.windowBottomFt, 0, "ft"), rms: fmtNum(a.stability.locRmsDots ?? 0, 2) }),
    });
  }
  return out;
}

/**
 * The sentence the approach section opens with. Landing: where the aircraft was established,
 * from where it stayed stable, then the main exceedance or a notable FAF offset –
 * "Auf dem Kurs ab 5,0 nm, stabil ab 1 500 ft. Bei FAF 16 kt schneller als
 * die geflogene Referenz." Go-around: "Durchstarten bei 284 ft nach stabilem Anflug – richtige Entscheidung."
 */
export function approachKeySentence(a: ApproachAnalysis): string {
  const kinds = distinctKinds(a.exceedances);
  const kindList = () => listAnd(kinds.map((k) => CRITERION_SHORT[k]));
  if (a.outcome.kind === "goAround") {
    let lead = a.goAround ? t("facts.approachKey.goAroundAt", { h: fmt(a.goAround.lowestHatFt, 0, "ft") }) : t("facts.approachKey.goAround");
    if (kinds.length) lead = t("facts.approachKey.afterDeviations", { lead, kinds: kindList() });
    else if (a.band) lead = t("facts.approachKey.afterStable", { lead });
    return t("facts.approachKey.rightDecision", { lead });
  }
  const first: string[] = [];
  if (!a.runway) first.push(t("facts.approachKey.noRunway"));
  else if (a.established) first.push(t("facts.approachKey.established", { dist: fmt(a.established.distNm, 1, "nm") }));
  else first.push(t("facts.approachKey.notEstablished"));
  const sf = a.stability.stableFromFt;
  if (a.band != null) first.push(sf != null ? t("facts.approachKey.stableFrom", { ft: fmt(sf, 0, "ft") }) : t("facts.approachKey.neverStable", { ft: fmt(50, 0, "ft") }));
  const lat = lateralClause(a);
  if (lat) first.push(lat);
  const out = [t("facts.approachKey.sentence", { clauses: first.join(", ") })];
  const main = mainExceedance(a);
  if (main) {
    const ft = fmt(500, 0, "ft");
    const lead =
      a.band === "unstableBelow500"
        ? t("facts.approachKey.unstableBelow500", { ft })
        : a.band === "unstable"
          ? t("facts.approachKey.unstableAbove500", { ft, kinds: kindList() })
          : t("facts.approachKey.deviationAbove500", { ft });
    out.push(t("facts.approachKey.lead", { lead, phrase: exceedancePhrase(main, a) }));
  } else {
    const faf = fafNote(a);
    if (faf) out.push(faf);
  }
  if (a.outcome.kind === "touchAndGo") out.push(t("facts.approachKey.touchAndGo"));
  return out.join(" ");
}

/** Label of an approach in the picker: "Anflug 1 – Durchstarten bei 284 ft". */
export function approachLabel(a: ApproachAnalysis): string {
  const n = t("facts.approachLabel.n", { n: a.index + 1 });
  switch (a.outcome.kind) {
    case "goAround":
      return a.goAround ? t("facts.approachLabel.goAroundAt", { n, h: fmt(a.goAround.lowestHatFt, 0, "ft") }) : t("facts.approachLabel.goAround", { n });
    case "touchAndGo":
      return t("facts.approachLabel.touchAndGo", { n });
    case "landed":
      return t("facts.approachLabel.landed", { n });
  }
}

/** The reference path as shown everywhere: "3,0° (ILS)" from the sim, "3°-Annahme" otherwise. */
export function glidepathLabel(ref: Pick<ApproachAnalysis["reference"], "glidepathDeg" | "glidepathSource">): string {
  return ref.glidepathSource === "ils" ? `${fmt(ref.glidepathDeg, 1, "°")} (ILS)` : t("facts.glidepathAssumed", { angle: fmt(ref.glidepathDeg, 0, "°") });
}

/** Source label of the reference speed: "eingetragen", "geflogener Median", "Annahme (VS0×1,3)". */
export function vappSourceLabel(a: ApproachAnalysis): string {
  const s = a.reference.vappSource;
  return s === "design" ? t("facts.vappSource.design", { factor: fmtNum(a.config.vappVs0Factor ?? 1.3, 1) }) : t(`facts.vappSource.${s}`);
}

/** Gate result for the card / summaries: ✓ all measurable passed, ✗ one failed, – not reached. */
export function gateMark(g: ApproachGate | null): string {
  if (!g || !g.reached) return "–";
  return g.criteria.some((c) => c.status === "fail") ? "✗" : "✓";
}

/** One line for the landing card: "3°-Annahme · stabil ab 1 500 ft · 1000 ✓ 500 ✓". */
export function approachCardLine(a: ApproachAnalysis): string {
  const ref = a.reference;
  const parts = [glidepathLabel(ref)];
  if (a.band != null) parts.push(a.stability.stableFromFt != null ? t("facts.approachKey.stableFrom", { ft: fmt(a.stability.stableFromFt, 0, "ft") }) : t("facts.neverStable"));
  parts.push(`1000 ${gateMark(gateOf(a, "ft1000"))} 500 ${gateMark(gateOf(a, "ft500"))}`);
  return parts.join(" · ");
}

/** Why the sim's ILS was not taken (protocol / provenance) as a sentence; "" when not applicable. */
function ilsFallbackNote(a: ApproachAnalysis, which: "gs" | "loc"): string {
  const i = a.ils;
  if (!i) return "";
  const share = which === "gs" ? i.gsShare : i.locShare;
  const rejected = which === "gs" ? i.gsRejected : i.locRejected;
  if (rejected) return t("facts.ils.rejected", { name: t(`facts.ils.${which}`) });
  if (share != null && share > 0) {
    return t(which === "gs" ? "facts.ils.shareGs" : "facts.ils.shareLoc", { pct: `${fmtNum(share * 100)}${NNBSP}%`, min: `${fmtNum((a.config.ilsMinShare ?? 0.6) * 100)}${NNBSP}%` });
  }
  return "";
}

/** Provenance of the four approach hero values. */
export function approachProvenance(a: ApproachAnalysis): { stable: Provenance; glidepath: Provenance; lateral: Provenance; speed: Provenance } {
  const st = a.stability;
  const ref = a.reference;
  const c = a.config;
  const top = fmtNum(c.windowTopFt);
  const bottom = fmt(c.windowBottomFt, 0, "ft");
  const simLateral = ref.localizerSource === "ils" && a.runway && !isDerivedRunway(a.runway) && a.lateral?.measurable !== false;
  return {
    stable: {
      kind: "measured",
      detail: t("facts.approachProv.stable", { max: fmt(c.stableFromMaxFt, 0, "ft"), round: fmtNum(c.stableRoundFt), bottom, samples: st.windowSamples, top }),
    },
    glidepath:
      ref.glidepathSource === "ils"
        ? {
            kind: "sim",
            detail: t("facts.approachProv.gsIls", {
              angle: fmt(ref.glidepathDeg, 1, "°"),
              share: `${fmtNum((a.ils?.gsShare ?? 0) * 100)}${NNBSP}%`,
              top,
              floor: fmt(c.gsFloorFt, 0, "ft"),
              diff: fmtNum(a.ils?.gsDiffDots ?? 0, 2),
              dot: fmtNum(c.gsDotDeg, 2),
            }),
          }
        : {
            kind: "derived",
            detail: sentences(
              t("facts.approachProv.gsGeo", { angle: fmt(ref.glidepathDeg, 0, "°"), tch: fmt(ref.tchFt, 0, "ft"), dot: fmtNum(c.gsDotDeg, 2), top, floor: fmt(c.gsFloorFt, 0, "ft") }),
              ilsFallbackNote(a, "gs"),
            ),
          },
    lateral: {
      kind: simLateral ? "sim" : "derived",
      detail: simLateral
        ? t("facts.approachProv.locIls", {
            full: fmtNum(c.locFullScaleDots ?? 2),
            share: `${fmtNum((a.ils?.locShare ?? 0) * 100)}${NNBSP}%`,
            top,
            bottom,
            diff: fmtNum(a.ils?.locDiffDots ?? 0, 2),
          })
        : !a.runway
          ? t("facts.approachProv.locNoRunway")
          : isDerivedRunway(a.runway) || a.lateral?.measurable === false
            ? t("facts.approachProv.locDerived", { reason: LATERAL_REASON })
            : sentences(
                t("facts.approachProv.locGeo", {
                  antenna: fmt(c.locAntennaBeyondEndM, 0, "m"),
                  dotM: fmt(c.locDotMAtThreshold, 0, "m"),
                  top,
                  bottom,
                  onRms: fmtNum(c.latBandOnRmsDots ?? 0.3, 1),
                  onMax: fmtNum(c.latBandOnMaxDots ?? 0.5, 1),
                  slightRms: fmtNum(c.latBandSlightRmsDots ?? 0.6, 1),
                  slightMax: fmtNum(c.latBandSlightMaxDots ?? 1, 1),
                }),
                ilsFallbackNote(a, "loc"),
              ),
    },
    speed: {
      kind: "measured",
      detail:
        ref.vappSource === "flown"
          ? t("facts.approachProv.speedFlown", { from: fmtNum(c.vappFromFt), to: fmt(c.vappToFt, 0, "ft"), ref: fmt(ref.vappKt, 0, "kt") })
          : ref.vappSource === "user"
            ? t("facts.approachProv.speedUser", { ref: fmt(ref.vappKt, 0, "kt"), flown: fmt(ref.flownVappKt, 0, "kt") })
            : ref.vappSource === "design"
              ? t("facts.approachProv.speedDesign", {
                  factor: fmtNum(c.vappVs0Factor ?? 1.3, 1),
                  vs0: fmt(ref.vs0Kt, 0, "kt"),
                  ref: fmt(ref.vappKt, 0, "kt"),
                  from: fmtNum(c.vappFromFt),
                  to: fmt(c.vappToFt, 0, "ft"),
                })
              : t("facts.approachProv.speedNone"),
    },
  };
}

/** Speed above the reference at the FAF or 1000 ft from which a hint names it (info) … */
export const SPEED_HIGH_INFO_KT = 10;
/** … and from which it is a warning. */
export const SPEED_HIGH_WARN_KT = 15;
/** Landing flaps set below this height (but above the configuration gate) are a warning: just in time is late. */
export const LATE_FLAPS_FT = 1200;

/** "Am FAF 12 kt über der Referenz (132 kt) – Speed früher reduzieren" at the FAF and the 1000 ft gate; skipped where the gate check already failed on speed. */
function speedHighHints(a: ApproachAnalysis): Hint[] {
  const ref = a.reference.vappKt;
  if (ref == null) return [];
  const out: Hint[] = [];
  for (const kind of ["faf", "ft1000"] as const) {
    const g = gateOf(a, kind);
    const dev = g?.reached ? g.sample?.iasDevKt : null;
    if (!g || dev == null || dev < SPEED_HIGH_INFO_KT) continue;
    if (g.criteria.some((c) => c.kind === "speed" && c.status === "fail")) continue;
    out.push({
      tone: dev >= SPEED_HIGH_WARN_KT ? "warn" : "info",
      text: t("facts.approachHint.speedHigh", {
        at: kind === "faf" ? t("facts.approachHint.speedHighAt") : t("facts.approachHint.speedHighAtGate", { gate: GATE_LABEL[kind] }),
        kt: fmt(dev, 0, "kt"),
        ref: fmt(ref, 0, "kt"),
      }),
    });
  }
  return out;
}

/** Approach observations, each with its numbers; they come before the landing hints. */
export function approachHints(a: ApproachAnalysis): Hint[] {
  const out: Hint[] = [];
  const ref = a.reference;
  const cfgFt = a.config.configGateFt;

  if (a.outcome.kind === "goAround" && a.goAround) {
    const g = a.goAround;
    out.push({
      tone: "info",
      text: t("facts.approachHint.goAround", {
        low: fmt(g.lowestHatFt, 0, "ft"),
        base: a.elevationSource === "database" ? t("facts.approachHint.baseField") : t("facts.approachHint.baseGround"),
        climb: fmtSigned(g.climbFt, 0, "ft"),
        window: fmt(a.config.gaWindowS, 0, "s"),
        ias: fmt(g.minIasKt, 0, "kt"),
      }),
    });
  }

  if (a.runway) {
    if (a.established) {
      out.push({ tone: "info", text: t("facts.approachHint.established", { dist: fmt(a.established.distNm, 1, "nm"), ft: fmt(a.established.hatFt, 0, "ft"), ident: a.runway.ident }) });
    } else {
      out.push({ tone: "warn", text: t("facts.approachHint.notEstablished") });
    }
  } else {
    out.push({ tone: "info", text: t("facts.approachHint.noRunway") });
  }
  out.push(...lateralHints(a));

  const from = fmtNum(a.config.vappFromFt);
  const to = fmt(a.config.vappToFt, 0, "ft");
  if (ref.vappSource === "flown") {
    out.push({ tone: "info", text: t("facts.approachHint.refFlown", { from, to, ref: fmt(ref.vappKt, 0, "kt") }) });
  } else if (ref.vappSource === "design") {
    out.push({ tone: "info", text: t("facts.approachHint.refDesign", { ref: fmt(ref.vappKt, 0, "kt"), factor: fmtNum(a.config.vappVs0Factor ?? 1.3, 1), vs0: fmt(ref.vs0Kt, 0, "kt") }) });
  } else if (ref.vappSource === "unavailable") {
    out.push({ tone: "info", text: t("facts.approachHint.refUnavailable") });
  }
  out.push(...speedHighHints(a));
  out.push(...ilsHints(a));
  out.push(...windHints(a));
  const auto = automationText(a);
  if (auto) out.push({ tone: "info", text: auto });
  if (ref.vappPlausible === false && ref.vs0Kt != null) {
    out.push({
      tone: "warn",
      text: t("facts.hint.refImplausible", { ref: fmt(ref.vappKt, 0, "kt"), min: fmtNum(a.config.vappMinVs0, 1), max: fmtNum(a.config.vappMaxVs0, 1), vs0: fmt(ref.vs0Kt, 0, "kt") }),
    });
  }

  // configuration
  const gate = fmt(cfgFt, 0, "ft");
  const gear = [...a.configEvents].reverse().find((e) => e.kind === "gearDown");
  if (gear) {
    const ft = fmt(gear.hatFt, 0, "ft");
    out.push(gear.hatFt < cfgFt ? { tone: "warn", text: t("facts.approachHint.gearLate", { ft, gate }) } : { tone: "info", text: t("facts.approachHint.gear", { ft }) });
  }
  const flapEvents = a.configEvents.filter((e) => e.kind === "flaps");
  const landingFlaps = ref.landingFlapsIndex != null ? [...flapEvents].reverse().find((e) => e.flapsTo === ref.landingFlapsIndex) : flapEvents[flapEvents.length - 1];
  if (landingFlaps) {
    const flaps = landingFlaps.flapsTo != null ? t("facts.approachHint.flapsStage", { stage: fmtNum(landingFlaps.flapsTo) }) : t("facts.approachHint.flapsPlain");
    const ft = fmt(landingFlaps.hatFt, 0, "ft");
    const early = Math.max(LATE_FLAPS_FT, cfgFt);
    out.push(
      landingFlaps.hatFt < cfgFt
        ? { tone: "warn", text: t("facts.approachHint.flapsLate", { flaps, ft, gate }) }
        : landingFlaps.hatFt < early
          ? { tone: "warn", text: t("facts.approachHint.flapsJustInTime", { flaps, ft, gate, early: fmt(early, 0, "ft") }) }
          : { tone: "info", text: t("facts.approachHint.flaps", { flaps, ft }) },
    );
  }

  // gates
  for (const g of a.gates) {
    if (g.kind === "ft50") continue;
    if (!g.reached) {
      if (g.kind === "tenNm" || a.outcome.kind === "goAround") out.push({ tone: "info", text: t("facts.approachHint.gateNotFlown", { gate: GATE_LABEL[g.kind] }) });
      continue;
    }
    const at = atGate(GATE_LABEL[g.kind]);
    for (const c of g.criteria) {
      const h = criterionHint(at, c, "approach");
      if (h) out.push({ tone: "warn", text: h });
    }
    // a height offset at the FAF worth naming even inside the tolerance
    const alt = g.criteria.find((c) => c.kind === "altitudeDeviation");
    if (g.kind === "faf" && alt?.status === "pass" && alt.measured != null && Math.abs(alt.measured) >= 100) {
      out.push({ tone: "info", text: t(alt.measured > 0 ? "facts.faf.above" : "facts.faf.below", { ft: fmt(Math.abs(alt.measured), 0, "ft"), angle: fmt(ref.glidepathDeg, 0, "°") }) });
    }
  }

  // exceedances 1000 → 50 ft
  for (const e of a.exceedances) {
    const limit = e.kind === "flapChange" ? t("facts.exceedance.limitFlaps", { ft: gate }) : t("facts.exceedance.limit", { value: valueText(e.kind, e.limit, "approach") });
    out.push({ tone: "warn", text: t(e.level === "s2" ? "facts.exceedance.hintS2" : "facts.exceedance.hint", { phrase: exceedancePhrase(e, a), limit }) });
  }
  if (a.band != null && a.exceedances.length === 0) {
    const bottom = a.outcome.kind === "goAround" ? t("facts.approachHint.toGoAround") : t("facts.approachHint.toBottom", { ft: fmt(a.config.windowBottomFt, 0, "ft") });
    out.push({ tone: "ok", text: t("facts.approachHint.allMet", { top: fmt(a.config.windowTopFt, 0, "ft"), bottom }) });
  }

  const eb = a.energy?.band;
  if (eb === "high" || eb === "low") {
    const v = eb === "high" ? a.energy?.bandMaxFt : a.energy?.bandMinFt;
    out.push({
      tone: "warn",
      text: t(eb === "high" ? "facts.approachHint.energyHigh" : "facts.approachHint.energyLow", {
        from: fmt(10, 0, "nm"),
        to: fmt(1000, 0, "ft"),
        value: fmtSigned(v, 0, "ft"),
        limit: eb === "high" ? fmtSigned(a.config.energyBandHighFt ?? 500, 0, "ft") : fmtSigned(-(a.config.energyBandLowFt ?? 300), 0, "ft"),
      }),
    });
  }
  const e10 = a.energy?.atTenNm;
  if (e10 && Math.abs(e10.totalFt) >= 300) {
    out.push({
      tone: "info",
      text: t(e10.totalFt > 0 ? "facts.approachHint.energyAt10Above" : "facts.approachHint.energyAt10Below", {
        at: fmt(10, 0, "nm"),
        total: fmtSigned(e10.totalFt, 0, "ft"),
        height: fmtSigned(e10.heightFt, 0, "ft"),
        speed: fmtSigned(e10.speedFt, 0, "ft"),
      }),
    });
  }
  return out;
}

// ---- track v2: sim ILS, sim wind, automation, energy band ---------------------------------

export const ENERGY_BAND_LABEL: Record<EnergyBand, string> = labels(["good", "high", "low"], (k) => t(`facts.energyBand.${k}`));

/** ILS observations: the sim's ILS differs from the geometry, or was rejected. */
export function ilsHints(a: ApproachAnalysis): Hint[] {
  const i = a.ils;
  if (!i || !a.runway) return [];
  const out: Hint[] = [];
  const rejected = [i.gsRejected ? t("facts.criterion.glidepath") : null, i.locRejected ? "Localizer" : null].filter((x): x is string => !!x);
  if (rejected.length) {
    out.push({ tone: "warn", text: t("facts.ils.hintRejected", { ident: a.runway.ident, which: listAnd(rejected) }) });
  } else if (i.mismatch) {
    const parts = [
      i.gsDiffDots != null ? t("facts.ils.hintGs", { dots: fmtNum(i.gsDiffDots, 1) }) : null,
      i.locDiffDots != null ? t("facts.ils.hintLoc", { dots: fmtNum(i.locDiffDots, 1) }) : null,
    ].filter(Boolean);
    out.push({ tone: "warn", text: t("facts.ils.hintMismatch", { parts: parts.join(", ") }) });
  }
  return out;
}

/** "Gegenwind 8 kt · Seitenwind 3 kt von links" from the sim's wind in the final; null without. */
export function simWindComponentsText(w: WindStats | null | undefined): string | null {
  if (!w || w.headwindKt == null || w.crosswindKt == null) return null;
  return `${headwindText(w.headwindKt)} · ${crosswindText(w.crosswindKt)}`;
}

/** "250°/8 kt" of the sim's wind (median speed, mean direction), with the gust spread; null without. */
export function simWindText(w: WindStats | null | undefined): string | null {
  if (!w || w.speedKt == null) return null;
  const dir = w.dirTrueDeg == null ? "VRB" : `${String(Math.round(w.dirTrueDeg)).padStart(3, "0")}°`;
  const wind = `${dir}/${fmtNum(w.speedKt)}${NNBSP}kt`;
  return w.gustSpreadKt != null && w.gustSpreadKt >= 3 ? t("facts.wind.spread", { wind, kt: fmt(w.gustSpreadKt, 0, "kt") }) : wind;
}

/** "250°/8 kt" of a direction and speed (wind shear, protocol). */
const dirKt = (dir: number | null | undefined, kt: number | null | undefined) => `${fmtNum(dir)}°/${fmt(kt, 0, "kt")}`;

/** Wind hints (sim wind 1000 → 50 ft): tailwind, crosswind, shear – thresholds in the config (VectaSim convention). */
export function windHints(a: ApproachAnalysis): Hint[] {
  const w = a.wind;
  if (!w) return [];
  const c = a.config;
  const out: Hint[] = [];
  const tail = c.windTailwindKt ?? 5;
  const cross = c.windCrosswindKt ?? 15;
  const shear = c.windShearKt ?? 15;
  if (w.headwindKt != null && -w.headwindKt > tail) {
    out.push({ tone: "warn", text: t("facts.windHint.tail", { kt: fmt(-w.headwindKt, 0, "kt"), top: fmtNum(c.windowTopFt), bottom: fmt(c.windowBottomFt, 0, "ft"), limit: fmt(tail, 0, "kt") }) });
  }
  if (w.crosswindKt != null && Math.abs(w.crosswindKt) > cross) {
    out.push({ tone: "warn", text: t(w.crosswindKt > 0 ? "facts.windHint.crossRight" : "facts.windHint.crossLeft", { kt: fmt(Math.abs(w.crosswindKt), 0, "kt"), limit: fmt(cross, 0, "kt") }) });
  }
  if (w.shearKt != null && w.shearKt > shear) {
    const hc = w.headwindChangeKt;
    const vars = { top: fmt(c.windowTopFt, 0, "ft"), kt: fmt(w.shearKt, 0, "kt"), from: dirKt(w.topDirTrueDeg, w.topKt), to: dirKt(w.bottomDirTrueDeg, w.bottomKt) };
    const key = hc != null && Math.abs(hc) >= 5 ? (hc > 0 ? "facts.windHint.shearMore" : "facts.windHint.shearLess") : "facts.windHint.shear";
    out.push({ tone: "warn", text: t(key, { ...vars, change: fmt(Math.abs(hc ?? 0), 0, "kt") }) });
  }
  return out;
}

/** "Autopilot bis 320 ft, danach manuell · A/THR bis 30 ft" (informative); null without automation data. */
export function automationText(a: ApproachAnalysis): string | null {
  const au = a.automation;
  if (!au) return null;
  const parts: string[] = [];
  if (au.autopilotAtEnd) parts.push(a.outcome.kind === "goAround" ? t("facts.automation.apToGoAround") : t("facts.automation.apToTouchdown"));
  else if (au.autopilotOffHatFt != null) parts.push(t("facts.automation.apOff", { ft: hatText(au.autopilotOffHatFt) }));
  else if (au.autopilotUsed === false) parts.push(t("facts.automation.manual"));
  if (au.autothrustAtEnd) parts.push(t("facts.automation.athrEnd"));
  else if (au.autothrustOffHatFt != null) parts.push(t("facts.automation.athrOff", { ft: hatText(au.autothrustOffHatFt) }));
  else if (au.autothrustUsed === false) parts.push(t("facts.automation.thrustManual"));
  if (au.approachMode) parts.push(t("facts.automation.apprMode"));
  return parts.length ? parts.join(" · ") : null;
}

/** Messprotokoll line "ILS": both sources side by side. */
export function ilsProtocolText(a: ApproachAnalysis): string | null {
  const i = a.ils;
  if (!i) return null;
  const pct = (v: number | null) => (v == null ? "–" : `${fmtNum(v * 100)}${NNBSP}%`);
  const used = (u: boolean, rej: boolean) => (u ? t("facts.ils.simUsed") : rej ? t("facts.ils.simRejected") : t("facts.ils.geoUsed"));
  const gs = t("facts.ils.protocolGs", {
    sim: fmtNum(i.gsRmsSimDots, 2),
    geo: fmtNum(i.gsRmsGeoDots, 2),
    diff: fmtNum(i.gsDiffDots, 2),
    share: pct(i.gsShare),
    angle: i.gsAngleDeg != null ? `, ${fmt(i.gsAngleDeg, 1, "°")}` : "",
    used: used(i.gsUsed, i.gsRejected),
  });
  const loc = t("facts.ils.protocolLoc", { sim: fmtNum(i.locRmsSimDots, 2), geo: fmtNum(i.locRmsGeoDots, 2), diff: fmtNum(i.locDiffDots, 2), share: pct(i.locShare), used: used(i.locUsed, i.locRejected) });
  return `${gs} · ${loc}`;
}

/** Messprotokoll line "Sim-Wind" of the final. */
export function windProtocolText(a: ApproachAnalysis): string | null {
  const w = a.wind;
  if (!w) return null;
  const parts = [simWindText(w), simWindComponentsText(w)];
  if (w.topKt != null && w.bottomKt != null) {
    parts.push(t("facts.windHint.protocolChange", { top: fmt(a.config.windowTopFt, 0, "ft"), from: dirKt(w.topDirTrueDeg, w.topKt), to: dirKt(w.bottomDirTrueDeg, w.bottomKt), kt: fmt(w.shearKt, 0, "kt") }));
  }
  return t("facts.windHint.protocol", { parts: parts.filter(Boolean).join(" · "), samples: w.samples, top: fmtNum(a.config.windowTopFt), bottom: fmt(a.config.windowBottomFt, 0, "ft") });
}

/** "Energie 10 nm → 1000 ft" fact line: band and extremes; null without. */
export function energyBandText(a: ApproachAnalysis): string | null {
  const e = a.energy;
  if (!e || !e.band) return null;
  return t("facts.energyBand.text", {
    band: ENERGY_BAND_LABEL[e.band],
    min: fmtSigned(e.bandMinFt, 0),
    max: fmtSigned(e.bandMaxFt, 0, "ft"),
    low: fmtSigned(-(a.config.energyBandLowFt ?? 300), 0),
    high: fmtSigned(a.config.energyBandHighFt ?? 500, 0, "ft"),
    tas: e.tasSource === "recorded" ? t("facts.energyBand.tasRecorded") : t("facts.energyBand.tasIsa"),
  });
}

/**
 * Messprotokoll line for what a track-v2 flight recorded in the final approach (TAS, the
 * sim's wind at the aircraft, the ILS on NAV 1). Facts only; null for older flights.
 */
export function recordedProtocolText(r: LandingDebriefData["recorded"]): string | null {
  if (!r) return null;
  const parts: string[] = [];
  if (r.tasKt != null) parts.push(`TAS ${fmt(r.tasKt, 0, "kt")}`);
  if (r.windKt != null) parts.push(t("facts.recorded.wind", { dir: fmt(r.windDirTrueDeg, 0, "°"), kt: fmt(r.windKt, 0, "kt") }));
  if (!r.navFlagsRecorded) parts.push(t("facts.recorded.noNavFlags"));
  else if (!r.hasLocalizer && !r.hasGlideSlope) parts.push(t("facts.recorded.noIls"));
  else {
    const comp = [r.hasLocalizer ? "LOC" : null, r.hasGlideSlope ? (r.glideSlopeValid ? t("facts.recorded.gsReceived") : t("facts.recorded.gsNotReceived")) : null].filter(Boolean).join(" + ");
    const extra = [r.ilsGsAngleDeg != null ? t("facts.recorded.gsAngle", { angle: fmt(r.ilsGsAngleDeg, 2, "°") }) : null, r.ilsCourseDeg != null ? t("facts.recorded.course", { course: fmt(r.ilsCourseDeg, 0, "°") }) : null];
    parts.push([`ILS ${comp}`, ...extra].filter(Boolean).join(" · "));
  }
  return parts.length ? t("facts.recorded.text", { parts: parts.join(" · ") }) : null;
}
