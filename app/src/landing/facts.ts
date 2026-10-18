// Wording for the landing debrief: labels, limits and the "Hinweise" list derived from
// the measured facts. Pure (see facts.test.ts). The tone stays factual: we say what was
// measured and which limit it is compared with, never "good" or "bad".
//
// Terms (ICAO Annex 14 / EASA wording): "Aufsetzzone" (TDZ, from the threshold), "Zielpunkt"
// (aiming point marking inside it), "Mittellinie", "Piste" (the RWY abbreviation stays),
// unit "g" for the load factor. Thresholds come from the Rust analysis (`a.config`), the
// bands below mirror crates/vectasim-core/src/landing.rs (module doc there: sources).

import { DASH, NNBSP, fmt, fmtClock, fmtNum, fmtSigned } from "../format";
import { sideLabel } from "./geometry";
import type { ApproachAnalysis, ApproachBand, ApproachCriterion, ApproachCriterionKind, ApproachGate, Exceedance, GateKind, LateralBand } from "./approachTypes";
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

export const BAND_LABEL: Record<Band, string> = {
  smooth: "sanft",
  normal: "normal",
  firm: "fest",
  hard: "hart",
};

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

export const VS_BANDS = "sanft < 150 · normal < 300 · fest < 600 · hart ≥ 600 fpm";
export const G_BANDS = "sanft < 1,25 · normal < 1,5 · fest < 2,0 · hart ≥ 2,0 g";
/** Start of the "hart" g band (g_band in landing.rs). */
export const G_HARD = 2;
/** Why "hart" starts at 2.0 g (Methodik). */
export const G_BAND_REASON =
  "„Hart“ ab 2,0 g: Die Landerate wird erst an der Zulassungsgrenze hart (600 fpm = 10 ft/s, CS/FAR 25.473); 1,75 g lag deutlich unter den Inspektionsschwellen der Hersteller (Airbus A320 2,6 g, Boeing 737-600 2,1 g). Typbezogene Grenzen nennt VectaSim nicht.";

/** Where the reference speed of the landing's speed criteria comes from (mirrors SpeedReferenceSource in landing.rs). */
export const SPEED_REF_LABEL: Record<SpeedReferenceSource, string> = {
  user: "Vapp des Piloten",
  flown: "geflogene Referenz – misst Konstanz, nicht Absolutwert",
  design: "1,3 × VS0 (Konstruktionswert des Flugzeugs)",
  unavailable: "keine Referenz",
};

export const CRITERION_LABEL: Record<ApproachCriterionKind, string> = {
  gear: "Fahrwerk ausgefahren",
  flaps: "Klappen gesetzt",
  verticalSpeed: "Sinkrate",
  speed: "Geschwindigkeit",
  glidepath: "Gleitpfad",
  bank: "Querneigung",
  localizer: "Kurs (Lokalizer)",
  altitudeDeviation: "Höhe zum Pfad",
  speedLimit: "IAS-Obergrenze",
  energy: "Energie",
  flapChange: "Klappenänderung",
};

export const CRITERION_ORDER: CriterionKind[] = ["gear", "flaps", "verticalSpeed", "speed", "glidepath", "bank"];
/** Row order of the approach gate table. */
export const APPROACH_CRITERION_ORDER: ApproachCriterionKind[] = [
  "gear",
  "flaps",
  "verticalSpeed",
  "speed",
  "speedLimit",
  "altitudeDeviation",
  "glidepath",
  "localizer",
  "energy",
  "bank",
];

/** Short name of a criterion inside a sentence ("Abweichungen bei Speed"). */
export const CRITERION_SHORT: Record<ApproachCriterionKind, string> = {
  gear: "Fahrwerk",
  flaps: "Klappen",
  verticalSpeed: "Sinkrate",
  speed: "Speed",
  glidepath: "Gleitpfad",
  bank: "Querneigung",
  localizer: "Kurs",
  altitudeDeviation: "Höhe",
  speedLimit: "IAS",
  energy: "Energie",
  flapChange: "Klappenänderung",
};

/**
 * Units differ between the landing gates (glidepath in °) and the approach gates
 * (glidepath/localizer in dots); both compare the speed with a reference speed.
 */
export type CriterionContext = "landing" | "approach";

/** "1", "0,5" – dots without a needless ",0". */
const dotsNum = (n: number | null | undefined) => fmtNum(n, n != null && Number.isInteger(n) ? 0 : 1);
/** Glidepath tolerance in degrees: "0,35", "0,7". */
export const degNum = (n: number | null | undefined) => fmtNum(n, n != null && Math.abs(n * 10 - Math.round(n * 10)) > 1e-9 ? 2 : 1);

export const STATUS_ICON: Record<CheckStatus, string> = { pass: "✓", fail: "✗", unavailable: "–" };

/** Limit text for the table ("|V/S| ≤ 1 000 fpm"). */
export function limitText(c: ApproachCriterion, ctx: CriterionContext = "landing"): string {
  switch (c.kind) {
    case "gear":
      return "unten";
    case "flaps":
      if (c.reference != null) return `Stufe ${fmtNum(c.reference)} (Landeklappen)`;
      return ctx === "approach" ? `Stufe ≥ ${fmtNum(c.limitMin ?? 1)}` : "Stufe > 0";
    case "verticalSpeed":
      return `|V/S| ≤ ${fmt(c.limitMax, 0, "fpm")}`;
    case "speed":
      return `${fmtSigned(c.limitMin, 0)}/${fmtSigned(c.limitMax, 0)}${NNBSP}kt zur Referenz`;
    case "glidepath":
      return ctx === "approach" ? `±${dotsNum(c.limitMax)}${NNBSP}Dot zum ${fmt(c.reference ?? 3, 0, "°")}-Pfad` : `${fmt(c.reference, 1, "°")} ±${degNum(c.limitMax)}° (1${NNBSP}Dot)`;
    case "localizer":
      return `±${dotsNum(c.limitMax)}${NNBSP}Dot`;
    case "bank":
      return `≤ ${fmt(c.limitMax, 0, "°")}`;
    case "altitudeDeviation":
      return `±${fmt(c.limitMax, 0, "ft")} zum ${fmt(c.reference ?? 3, 0, "°")}-Pfad`;
    case "speedLimit":
      return `≤ ${fmt(c.limitMax, 0, "kt")} IAS`;
    case "energy":
      return `≤ ${fmtSigned(c.limitMax, 0, "ft")} über Profil`;
    case "flapChange":
      return "keine Änderung";
  }
}

/** Measured value as text ("−740 fpm", "+0,2°", "ausgefahren"). */
export function measuredText(c: ApproachCriterion, ctx: CriterionContext = "landing"): string {
  if (c.measured == null) {
    if (c.kind === "glidepath" && ctx === "landing") return "ohne Piste n. v.";
    if (c.kind === "speed" && ctx === "landing") return "ohne Referenz n. v.";
    return "n. v.";
  }
  return valueText(c.kind, c.measured, ctx, c.reference);
}

/** A value of a criterion's kind in its unit (also used for exceedance peaks). */
export function valueText(kind: ApproachCriterionKind, v: number, ctx: CriterionContext = "approach", reference?: number | null): string {
  switch (kind) {
    case "gear":
      return v >= 95 ? "ausgefahren" : v <= 5 ? "eingefahren" : `${fmtNum(v)}${NNBSP}%`;
    case "flaps":
      return v > 0 ? `Stufe ${fmtNum(v)}` : "eingefahren";
    case "verticalSpeed":
      return fmtSigned(Math.round(v), 0, "fpm");
    case "speed":
      return reference != null ? `${fmtSigned(v, 0, "kt")} (${fmt(reference + v, 0, "kt")})` : fmtSigned(v, 0, "kt");
    case "glidepath":
      return ctx === "approach" ? fmtSigned(v, 1, "Dots") : fmtSigned(v, 1, "°");
    case "localizer":
      return fmtSigned(v, 1, "Dots");
    case "bank":
      return fmt(Math.abs(v), 0, "°");
    case "altitudeDeviation":
    case "energy":
      return fmtSigned(Math.round(v), 0, "ft");
    case "speedLimit":
      return fmt(v, 0, "kt");
    case "flapChange":
      return v >= 0.5 ? "geändert" : "keine";
  }
}

export type HintTone = "ok" | "warn" | "info";
export interface Hint {
  tone: HintTone;
  text: string;
}

const gateName = (g: GateCheck) => `${fmtNum(g.gateFt)}${NNBSP}ft`;

/** One sentence per failed gate criterion; `at` is "bei 1 000 ft" / "bei FAF". */
export function criterionHint(at: string, c: ApproachCriterion, ctx: CriterionContext = "landing"): string | null {
  if (c.status !== "fail" || c.measured == null) return null;
  switch (c.kind) {
    case "gear":
      return `Fahrwerk ${at} nicht ausgefahren (${fmtNum(c.measured)}${NNBSP}%)`;
    case "flaps":
      if (c.reference != null && c.measured > 0) return `Klappen ${at} auf Stufe ${fmtNum(c.measured)} – Landeklappen (Stufe ${fmtNum(c.reference)}) erwartet`;
      return `Klappen ${at} eingefahren`;
    case "verticalSpeed":
      return `Sinkrate ${at} ${fmt(Math.abs(c.measured), 0, "fpm")} – über dem Limit von ${fmt(c.limitMax, 0, "fpm")}`;
    case "speed":
      return `Geschwindigkeit ${at} ${fmtSigned(c.measured, 0, "kt")} gegenüber der Referenz (${fmt(c.reference, 0, "kt")}) – Fenster ${fmtSigned(c.limitMin, 0)}/${fmtSigned(c.limitMax, 0)}${NNBSP}kt`;
    case "glidepath":
      if (ctx === "approach") {
        return `Gleitpfad ${at} ${fmtSigned(c.measured, 1, "Dots")} ${c.measured > 0 ? "über" : "unter"} dem ${fmt(c.reference ?? 3, 0, "°")}-Pfad – Toleranz ±${dotsNum(c.limitMax)}${NNBSP}Dot`;
      }
      // one dot is the limit; beyond two dots (full scale) it is an S2 deviation
      return (
        `Gleitpfad ${at} ${fmtSigned(c.measured, 2, "°")} ${c.measured > 0 ? "über" : "unter"} dem ${fmt(c.reference, 0, "°")}-Pfad – Toleranz ±${degNum(c.limitMax)}° (1${NNBSP}Dot)` +
        (c.limitMax != null && Math.abs(c.measured) > 2 * c.limitMax ? ", mehr als 2 Dots (Vollausschlag, Stufe S2)" : "")
      );
    case "localizer":
      return `Kurs ${at} ${fmt(Math.abs(c.measured), 1, "Dots")} ${c.measured > 0 ? "rechts" : "links"} der verlängerten Mittellinie – Toleranz ±${dotsNum(c.limitMax)}${NNBSP}Dot`;
    case "bank":
      return `Querneigung ${at} ${fmt(c.measured, 0, "°")} – über ${fmt(c.limitMax, 0, "°")}`;
    case "altitudeDeviation":
      return `Höhe ${at} ${fmt(Math.abs(c.measured), 0, "ft")} ${c.measured > 0 ? "über" : "unter"} dem ${fmt(c.reference ?? 3, 0, "°")}-Pfad – Toleranz ±${fmt(c.limitMax, 0, "ft")}`;
    case "speedLimit":
      return `IAS ${at} ${fmt(c.measured, 0, "kt")} – über ${fmt(c.limitMax, 0, "kt")}`;
    case "energy":
      return `Energie ${at} ${fmtSigned(c.measured, 0, "ft")} über dem Profil – Grenze ${fmtSigned(c.limitMax, 0, "ft")}`;
    case "flapChange":
      return `Klappen ${at} verstellt`;
  }
}

/** Plain-German observations, each with the numbers it is based on. */
export function buildHints(d: LandingDebriefData, approach?: ApproachAnalysis | null): Hint[] {
  const a: LandingAnalysis = d.analysis;
  const td = a.touchdown;
  // approach hints first; its gates replace the landing's 1000/500 ft checks
  const out: Hint[] = approach ? approachHints(approach) : [];
  const tp = a.touchdownPoint;
  const rwy = a.runway;

  if (td.touchAndGo) out.push({ tone: "info", text: "Touch-and-go: nach dem Aufsetzen wieder durchgestartet – kein Rollout" });

  const metarAge = metarAgeNote(d);
  if (metarAge) out.push({ tone: "warn", text: `${metarAge} – der Wind darin passt evtl. nicht zur Landung` });

  if (tp && rwy) {
    const dist = touchdownDistanceText(tp);
    const zone = `${zoneText(tp, rwy)}, Zielpunkt ${fmt(tp.aimingPointM, 0, "m")}`;
    const rest = rwy.lengthEstimated ? "" : `, ${fmt(tp.remainingM, 0, "m")} Piste übrig`;
    // the zone starts at the threshold: only a touchdown before it is "short"
    if (tp.distanceM < 0) out.push({ tone: "warn", text: `Aufsetzen ${touchdownDistanceText(tp, -tp.distanceM)} vor der Schwelle – vor der Aufsetzzone (${zone})` });
    else if (tp.distanceM <= tp.tdzEndM) out.push({ tone: "ok", text: `Aufsetzen ${dist} hinter der Schwelle – in der Aufsetzzone (${zone})` });
    else out.push({ tone: "warn", text: `Aufsetzen ${dist} hinter der Schwelle – nach der Aufsetzzone (${zone})${rest}` });
    if (isDerivedRunway(rwy)) {
      out.push({
        tone: "info",
        text: `Piste aus deiner Rollspur abgeleitet – Schwelle auf ±${fmt(tp.distanceUncertaintyM ?? rwy.alongUncertaintyM ?? 50, 0, "m")} geschätzt${rwy.lengthEstimated ? ", Pistenlänge unbekannt" : ""}; mit „Piste korrigieren …“ kannst du sie genau festlegen`,
      });
    }

    const widthM = rwy.widthM ?? null;
    if (!lateralMeasurable(tp)) {
      out.push({ tone: "info", text: `Querablage nicht messbar: ${LATERAL_REASON}` });
    } else if (!rwy.onRunway && (widthM == null || Math.abs(tp.lateralM) > widthM / 2)) {
      out.push({
        tone: "warn",
        text: `Aufsetzpunkt ${sideLabel(tp.lateralM)} der Mittellinie – außerhalb der Piste (${widthText(widthM)}); RWY ${rwy.ident} ist die nächstgelegene passende Piste`,
      });
    } else if (widthM == null) {
      out.push({ tone: "info", text: `Aufsetzpunkt ${sideLabel(tp.lateralM)} der Mittellinie (Breite der Piste unbekannt)` });
    } else {
      out.push({ tone: Math.abs(tp.lateralM) > widthM / 4 ? "warn" : "ok", text: `Aufsetzpunkt ${sideLabel(tp.lateralM)} der Mittellinie (Piste ${fmt(widthM, 0, "m")} breit)` });
    }
  } else {
    out.push({ tone: "info", text: "Keine Piste zugeordnet – Aufsetzpunkt, Mittellinie und Gleitpfad lassen sich nicht bestimmen" });
  }

  if (a.threshold) {
    out.push({
      tone: "info",
      text: `Schwelle in ${fmt(a.threshold.heightFt, 0, "ft")} überflogen (Referenz ${fmt(a.config.tchFt, 0, "ft")}), ${fmt(a.threshold.iasKt, 0, "kt")} IAS, ${fmt(a.threshold.airborneS, 0, "s")} bis zum Aufsetzen`,
    });
  }

  // stabilised approach (landing gates; covered by the approach analysis when present)
  const gatesHere = approach ? [] : a.gates;
  if (!approach && gatesHere.some((g) => g.reached)) {
    const ref = a.referenceSpeedKt;
    if (a.referenceSpeedSource === "flown") {
      out.push({
        tone: "info",
        text: `Referenz-Speed ist der Median der geflogenen IAS ${fmtNum(a.config.vappFromFt)} → ${fmt(a.config.vappToFt, 0, "ft")} (${fmt(ref, 0, "kt")}) – misst die Konstanz, nicht den Absolutwert`,
      });
    } else if (a.referenceSpeedSource === "design") {
      out.push({ tone: "info", text: `Referenz-Speed ${fmt(ref, 0, "kt")} = ${fmtNum(a.config.vs0Factor, 1)} × VS0 (${fmt(a.vs0Kt, 0, "kt")}) – kein geflogener Wert zwischen ${fmtNum(a.config.vappFromFt)} und ${fmt(a.config.vappToFt, 0, "ft")}` });
    } else if (a.referenceSpeedSource === "unavailable") {
      out.push({ tone: "info", text: "Keine Referenz-Geschwindigkeit messbar – das Speed-Kriterium entfällt" });
    }
    if (a.referencePlausible === false && a.vs0Kt != null) {
      out.push({ tone: "warn", text: `Referenz ${fmt(ref, 0, "kt")} liegt außerhalb von ${fmtNum(a.config.vappMinVs0, 1)}–${fmtNum(a.config.vappMaxVs0, 1)} × VS0 (${fmt(a.vs0Kt, 0, "kt")})` });
    }
  }
  const reached = gatesHere.filter((g) => g.reached);
  for (const g of gatesHere) {
    if (!g.reached) out.push({ tone: "info", text: `Anflug lag nie über ${gateName(g)} – Prüfung bei ${gateName(g)} entfällt` });
  }
  const fails = reached.flatMap((g) => g.criteria.map((c) => criterionHint(`bei ${gateName(g)}`, c)).filter((s): s is string => !!s));
  for (const f of fails) out.push({ tone: "warn", text: f });
  if (reached.length > 0 && fails.length === 0) {
    const unavailable = reached.some((g) => g.criteria.some((c) => c.status === "unavailable"));
    out.push({
      tone: "ok",
      text: `Bei ${reached.map(gateName).join(" und ")} alle ${unavailable ? "messbaren " : ""}Kriterien erfüllt`,
    });
  }

  // touchdown values
  if (td.landingRateSource === "measured") {
    out.push({
      tone: "info",
      text: `Der Sim hat für diese Landung keinen Touchdown-Wert geliefert – Landerate ${fmt(td.landingRateFpm, 0, "fpm")} aus dem letzten V/S-Sample in der Luft`,
    });
  } else if (Math.abs(td.landingRateFpm - td.vsFpmMeasured) >= 50) {
    out.push({
      tone: "info",
      text: `Landerate ${fmt(td.landingRateFpm, 0, "fpm")} (Sim-Wert), letztes V/S-Sample in der Luft ${fmt(td.vsFpmMeasured, 0, "fpm")} – Unterschied siehe Methodik`,
    });
  }
  if (td.bounces > 0) {
    out.push({
      tone: "warn",
      text: `${td.bounces} ${td.bounces === 1 ? "Bounce" : "Bounces"} nach dem ersten Aufsetzen – härtester Kontakt ${fmt(td.vsFpmHardest, 0, "fpm")}, Landerate ist der härteste Kontakt dieses Ereignisses (Bodenkontakte unter 0,3${NNBSP}s Abstand zählen als einer)`,
    });
  }

  if (a.flare) {
    out.push({
      tone: "info",
      text: `Abfangen ab ${fmt(a.flare.startHatFt, 0, "ft")}: Sinkrate von ${fmt(Math.abs(a.flare.approachVsFpm), 0, "fpm")} auf ${fmt(Math.abs(a.flare.finalVsFpm), 0, "fpm")}, ${fmt(a.flare.durationS, 0, "s")} bis zum Aufsetzen`,
    });
  } else if (a.samples.length > 0 && !td.touchAndGo) {
    out.push({ tone: "info", text: `Kein Abfangen erkennbar: die Sinkrate lag bis zum Aufsetzen über ${fmtNum(a.config.flareVsFraction * 100)}${NNBSP}% der Anflug-Sinkrate` });
  }

  // wind
  const w = a.wind;
  if (w && w.headwindKt != null && w.crosswindKt != null) {
    const ref = w.relativeToRunway ? `RWY ${rwy?.ident ?? ""}`.trim() : "Steuerkurs";
    const xw = Math.abs(w.crosswindKt);
    const parts = [
      w.headwindKt >= 0 ? `Gegenwind ${fmt(w.headwindKt, 0, "kt")}` : `Rückenwind ${fmt(-w.headwindKt, 0, "kt")}`,
      xw < 0.5 ? "kein Seitenwind" : `Seitenwind ${fmt(xw, 0, "kt")} von ${w.crosswindKt > 0 ? "rechts" : "links"}`,
    ];
    if (w.gustCrosswindKt != null) parts.push(`in Böen ${fmt(Math.abs(w.gustCrosswindKt), 0, "kt")} quer`);
    const worst = worstCrosswindText(w);
    if (worst) parts.push(`${worst} innerhalb der Windrichtungs-Spanne`);
    out.push({ tone: w.headwindKt < -0.5 ? "warn" : "info", text: `${parts.join(", ")} (METAR ${windText(w.directionDeg, w.speedKt, w.gustKt, w.variableFromDeg, w.variableToDeg)}, bezogen auf ${ref})` });
  } else if (w) {
    const worst = worstCrosswindText(w);
    out.push({ tone: "info", text: `Wind variabel ${fmt(w.speedKt, 0, "kt")}${w.gustKt ? `, Böen ${fmt(w.gustKt, 0, "kt")}` : ""} – keine Gegen-/Seitenwind-Komponenten${worst ? `; ungünstigster Fall: Seitenwind ${worst.replace(/^bis /, "bis zu ")}` : ""}` });
  }

  if (a.rollout) {
    const rest = a.rollout.remainingM;
    out.push({
      tone: rest != null && rest < 0 ? "warn" : "info",
      text:
        `Rollout bis ${fmt(a.config.rolloutEndKt, 0, "kt")}: ${fmt(a.rollout.distanceM, 0, "m")} in ${fmt(a.rollout.durationS, 0, "s")}` +
        (rest == null ? "" : rest >= 0 ? `, ${fmt(rest, 0, "m")} Piste übrig` : ` – endete ${fmt(-rest, 0, "m")} hinter dem Pistenende`),
    });
  }
  return out;
}

/** "Piste 45 m breit" helper: "45 m" or "Breite unbekannt". */
export function widthText(widthM: number | null | undefined): string {
  return widthM != null && widthM > 0 ? fmt(widthM, 0, "m") : "Breite unbekannt";
}

/** "0–467 m": the touchdown zone, from the threshold. */
export function zoneRange(tp: { tdzStartM: number; tdzEndM: number }): string {
  return `${fmtNum(tp.tdzStartM)}–${fmt(tp.tdzEndM, 0, "m")}`;
}

/** The zone as said in the debrief: without a declared length it is the fixed 0–900 m, an assumption. */
export function zoneText(tp: { tdzStartM: number; tdzEndM: number }, rwy: Pick<RunwayMatch, "lengthEstimated"> | null | undefined): string {
  return rwy?.lengthEstimated ? `angenommen (${zoneRange(tp)})` : zoneRange(tp);
}

// ---- runway geometry source (R2) --------------------------------------------------------

/** Why a derived runway has no centreline offset. */
export const LATERAL_REASON = "Die Piste wurde aus deiner Rollspur abgeleitet – ihre Achse ist deine eigene Linie, nicht die echte Mittellinie.";

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
  return lateralMeasurable(tp) ? sideLabel(tp.lateralM) : "nicht messbar";
}

/** The line under the runway name: where its geometry comes from. */
export function runwaySourceNote(rwy: Pick<RunwayMatch, "source" | "derivedFromLandings">): string {
  const n = rwy.derivedFromLandings ?? 1;
  const landings = `${fmtNum(n)} ${n === 1 ? "Landung" : "Landungen"}`;
  switch (runwaySourceOf(rwy)) {
    case "database":
      return "Piste aus OurAirports";
    case "derived":
      return `Piste aus deiner Rollspur abgeleitet (${landings})`;
    case "databaseDerived":
      return `Piste aus deiner Rollspur abgeleitet (${landings}) · Bezeichnung und Länge aus OurAirports`;
    case "user":
      return "Piste von dir festgelegt";
  }
}

/** Short label of a source (runway editor). */
export const RUNWAY_SOURCE_SHORT: Record<RunwayGeometrySource, string> = {
  database: "OurAirports",
  derived: "aus deiner Rollspur abgeleitet",
  databaseDerived: "aus deiner Rollspur abgeleitet",
  user: "von dir festgelegt",
};

/** "240°/12G22 kt", "VRB/3 kt", with a variability range "240°/12 kt (210–280°)". */
export function windText(dir: number | null | undefined, speed: number, gust?: number | null, varFrom?: number | null, varTo?: number | null): string {
  const d = dir == null ? "VRB" : `${String(Math.round(dir)).padStart(3, "0")}°`;
  const range = varFrom != null && varTo != null ? ` (${fmtNum(varFrom)}–${fmtNum(varTo)}°)` : "";
  return `${d}/${fmtNum(speed)}${gust ? `G${fmtNum(gust)}` : ""}${NNBSP}kt${range}`;
}

/**
 * Worst crosswind of a variable wind: "bis 9 kt von rechts" (dddVddd range), "bis 3 kt
 * von beliebiger Seite" (VRB), with gusts ", in Böen bis 15 kt"; null without variability.
 */
export function worstCrosswindText(w: WindComponents): string | null {
  if (w.maxCrosswindKt == null) return null;
  const side = w.maxCrosswindFromRight == null ? "von beliebiger Seite" : w.maxCrosswindFromRight ? "von rechts" : "von links";
  const gust = w.maxGustCrosswindKt != null ? `, in Böen bis ${fmt(w.maxGustCrosswindKt, 0, "kt")}` : "";
  return `bis ${fmt(w.maxCrosswindKt, 0, "kt")} ${side}${gust}`;
}

/** Head/crosswind as a compact line for the header: "Gegenwind 8 kt · Seitenwind 5 kt von links, Böen 9 kt · bis 9 kt von rechts". */
export function windComponentsText(a: LandingAnalysis): string {
  const w = a.wind;
  if (!w) return DASH;
  const worst = worstCrosswindText(w);
  if (w.headwindKt == null || w.crosswindKt == null) return worst ? `Seitenwind ${worst}` : DASH;
  const head = w.headwindKt >= 0 ? `Gegenwind ${fmt(w.headwindKt, 0, "kt")}` : `Rückenwind ${fmt(-w.headwindKt, 0, "kt")}`;
  let xw = Math.abs(w.crosswindKt) < 0.5 ? "kein Seitenwind" : `Seitenwind ${fmt(Math.abs(w.crosswindKt), 0, "kt")} von ${w.crosswindKt > 0 ? "rechts" : "links"}`;
  if (w.gustCrosswindKt != null && Math.abs(w.gustCrosswindKt) >= 0.5) xw += `, Böen ${fmt(Math.abs(w.gustCrosswindKt), 0, "kt")}`;
  return [head, xw, worst].filter(Boolean).join(" · ");
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
  const at = fmtClock(obs, { local: false });
  return minutes > 0 ? `METAR von ${at} (älter als 1${NNBSP}h)` : `METAR von ${at} (über 1${NNBSP}h nach der Landung)`;
}

// ---- key sentence ----------------------------------------------------------------------

/** Band of a landing rate (mirrors vs_band in crates/vectasim-core/src/landing.rs). */
export function vsBandOf(fpm: number): Band {
  const v = Math.abs(fpm);
  return v < 150 ? "smooth" : v < 300 ? "normal" : v < 600 ? "firm" : "hard";
}

const BAND_ADJ: Record<Band, string> = { smooth: "Sanfte", normal: "Normale", firm: "Feste", hard: "Harte" };
const BAND_ADJ_DAT: Record<Band, string> = { smooth: "sanfter", normal: "normaler", firm: "fester", hard: "harter" };

/** Where on the runway, as a phrase ("in der Aufsetzzone"); the zone starts at the threshold. */
export function zonePhrase(a: LandingAnalysis): string | null {
  const tp = a.touchdownPoint;
  if (!tp || !a.runway) return null;
  if (tp.distanceM < 0) return "vor der Schwelle";
  if (tp.distanceM <= tp.tdzEndM) return "in der Aufsetzzone";
  return "nach der Aufsetzzone";
}

/**
 * The one sentence the debrief opens with: band of the landing rate, where on the
 * runway, offset from the centreline, bounces. "Normale Landung in der Aufsetzzone,
 * 2 m links der Mittellinie, ohne Bounce."
 */
export function keySentence(d: LandingDebriefData): string {
  const a = d.analysis;
  const td = a.touchdown;
  const head = td.touchAndGo ? `Touch-and-go mit ${BAND_ADJ_DAT[a.vsBand]} Landerate` : `${BAND_ADJ[a.vsBand]} Landung`;
  const parts: string[] = [];
  const zone = zonePhrase(a);
  if (zone && a.touchdownPoint) {
    parts.push(zone);
    if (lateralMeasurable(a.touchdownPoint)) {
      const side = sideLabel(a.touchdownPoint.lateralM);
      parts.push(side.startsWith("auf der") ? side : `${side} der Mittellinie`);
    }
  } else {
    parts.push("ohne zugeordnete Piste");
  }
  parts.push(td.bounces === 0 ? "ohne Bounce" : `mit ${td.bounces} ${td.bounces === 1 ? "Bounce" : "Bounces"}`);
  const [first, ...rest] = parts;
  return `${head} ${first}${rest.length ? `, ${rest.join(", ")}` : ""}.`;
}

// ---- provenance (source chips, Messprotokoll) ------------------------------------------

export type SourceKind = "sim" | "measured" | "derived";
export const SOURCE_LABEL: Record<SourceKind, string> = { sim: "SIM", measured: "GEM.", derived: "ABGEL." };
export const SOURCE_NAME: Record<SourceKind, string> = { sim: "Wert des Simulators", measured: "von VectaSim gemessen", derived: "von VectaSim abgeleitet" };

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

/** Accuracy of the database runway coordinates (OurAirports: often 4 decimals ≈ ±5 m). */
export const RUNWAY_ACCURACY_NOTE = "Pistenkoordinaten oft nur auf 4 Nachkommastellen (ca. ±5 m) – Abstände daher auf ganze Meter gerundet.";

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
          detail:
            `${fmt(td.landingRateFpm, 0, "fpm")} aus PLANE TOUCHDOWN NORMAL VELOCITY. Unser Messwert: ${fmt(td.vsFpmMeasured, 0, "fpm")} (letztes Sample in der Luft).` +
            (td.bounces ? ` Härtester Kontakt: ${fmt(td.vsFpmHardest, 0, "fpm")}.` : "") +
            (diff > 50 ? ` Sim- und Messwert liegen ${fmt(diff, 0, "fpm")} auseinander – siehe Methodik.` : ""),
        }
      : {
          kind: "measured",
          detail: `Der Sim lieferte keinen Touchdown-Wert. ${fmt(td.landingRateFpm, 0, "fpm")} ist die Vertikalgeschwindigkeit des letzten Samples in der Luft (Telemetriestrom in der Bildrate des Simulators).`,
        };
  const disp = d.thresholdDisplacedM;
  const tp = a.touchdownPoint;
  const source = runwaySourceOf(a.runway);
  const point: Provenance = tp
    ? {
        kind: "derived",
        detail: isDerivedSource(source)
          ? `Aus der Position beim ersten Bodenkontakt und einer aus deiner Rollspur abgeleiteten Schwelle von RWY ${a.runway?.ident ?? ""} berechnet: ${touchdownDistanceText(tp)} hinter der Schwelle. ` +
            `Die Schwelle ist nur auf ±${fmt(tp.distanceUncertaintyM ?? 50, 0, "m")} bekannt (angenommener Zielpunkt, 1 Sample pro Sekunde); die Querablage ist nicht messbar, weil die Achse deine eigene Linie ist.` +
            (a.runway?.lengthEstimated ? " Die Pistenlänge ist unbekannt (nur bis zum Ende deines Rollouts)." : "")
          : `Aus der Position beim ersten Bodenkontakt und den Schwellen-Koordinaten von RWY ${a.runway?.ident ?? ""} (${source === "user" ? "von dir festgelegt" : "OurAirports"}) berechnet: ${fmt(tp.distanceM, 0, "m")} hinter der Schwelle, ${sideLabel(tp.lateralM)}.` +
            (disp != null && disp > 0 && source !== "user" ? ` Die Schwelle ist um ${fmt(disp, 0, "m")} versetzt (DB).` : "") +
            (source === "user" ? "" : ` ${RUNWAY_ACCURACY_NOTE}`),
      }
    : { kind: "derived", detail: "Keine Piste zugeordnet – der Aufsetzpunkt lässt sich nicht auf eine Schwelle beziehen." };
  const g: Provenance = {
    kind: "measured",
    detail: "Höchstes Lastvielfaches (G FORCE) in der halben Sekunde nach dem Kontakt, aus dem Telemetriestrom. Unplausible Werte (über 5 g, negativ) werden verworfen.",
  };
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
export const INDEX_LABEL: Record<IndexKey, string> = {
  rate: "Landerate",
  g: "g-Last",
  bounces: "Bounces",
  zone: "Aufsetzpunkt",
  centreline: "Mittellinie",
  stable: "Stabilisierter Anflug",
};

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
      ? "ohne Piste"
      : missing.includes("centreline")
        ? lateralMeasurable(a.touchdownPoint)
          ? "Breite unbekannt"
          : "Querablage nicht messbar"
        : "ohne erreichtes Gate";
    return { value: null, parts, incomplete: why };
  }
  const total = parts.reduce((s, p) => s + p.weight, 0);
  const got = parts.reduce((s, p) => s + p.weight * (p.points ?? 0), 0);
  return { value: Math.round((100 * got) / total), parts, incomplete: null };
}

/** "87 / 100" or "nicht vergleichbar (ohne Piste)". */
export function indexText(i: LandingIndex): string {
  return i.value != null ? `${i.value}${NNBSP}/${NNBSP}100` : `nicht vergleichbar (${i.incomplete})`;
}

/** The formula in words, for the Methodik section. */
export function indexFormulaLines(): string[] {
  const bp = INDEX_BAND_POINTS;
  const z = INDEX_ZONE_POINTS;
  const bands = `sanft ${fmtNum(bp.smooth, 1)} · normal ${fmtNum(bp.normal, 1)} · fest ${fmtNum(bp.firm, 1)} · hart ${fmtNum(bp.hard, 1)}`;
  const w = INDEX_WEIGHTS;
  return [
    "VectaSim-Index = 100 × Σ(Gewicht × Punkte) ÷ Σ Gewichte, gerundet. Er steht nur da, wenn alle Teile messbar sind; ohne Piste, ohne bekannte Pistenbreite oder ohne erreichtes Gate heißt er „nicht vergleichbar“ – herausgerechnete Teile würden einen Vergleich vortäuschen.",
    `Landerate (Gewicht ${w.rate}) und g-Last (Gewicht ${w.g}): Punkte nach Band – ${bands}. „Normal“ zählt so viel wie „sanft“: Ein festes Aufsetzen ohne Ausschweben ist gewollt.`,
    `Bounces (Gewicht ${w.bounces}): keiner 1,0 · einer 0,4 · zwei oder mehr 0,0.`,
    `Aufsetzpunkt (Gewicht ${w.zone}): in der Aufsetzzone (ab der Schwelle) ${fmtNum(z.inZone, 1)} · danach bis zur Pistenmitte ${fmtNum(z.toMidpoint, 1)} · dahinter ${fmtNum(z.beyond, 1)} · vor der Schwelle ${fmtNum(z.beforeThreshold, 1)}.`,
    `Mittellinie (Gewicht ${w.centreline}): Abweichung bis ein Viertel der Pistenbreite 1,0 · bis zur halben Breite 0,5 · darüber 0,0.`,
    `Stabilisierter Anflug (Gewicht ${w.stable}): zur Hälfte „stabil ab“ (ab ${fmtNum(INDEX_STABLE_HIGH_FT)}${NNBSP}ft 1,0, bis ${fmtNum(INDEX_STABLE_LOW_FT)}${NNBSP}ft linear auf 0,0, darunter oder nie stabil 0,0), zur Hälfte Anteil der erfüllten messbaren Gate-Kriterien bei 1000 und 500${NNBSP}ft. Ohne messbares Gate-Kriterium zählt nur „stabil ab“; ohne Anflugauswertung nur der Gate-Anteil der Landeprüfung.`,
  ];
}

// ---- approach (approach_analysis) -----------------------------------------------------
// Same tone as the landing: facts with the limit they are compared with. `null` in the
// analysis means "not measurable" and is said so, never counted as a failure.

export const APPROACH_BAND_LABEL: Record<ApproachBand, string> = {
  stable: "stabil",
  deviations: "mit Abweichungen",
  unstable: "instabil",
  unstableBelow500: "instabil unter 500 ft",
};

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

export const GATE_LABEL: Record<GateKind, string> = {
  tenNm: `10${NNBSP}nm`,
  faf: "FAF",
  ft1000: `1${NNBSP}000${NNBSP}ft`,
  ft500: `500${NNBSP}ft`,
  ft50: `50${NNBSP}ft`,
};

/** "Speed", "Speed und Sinkrate", "Speed, Sinkrate und Gleitpfad". */
export function listDe(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} und ${items[items.length - 1]}`;
}

const distinctKinds = (ex: Exceedance[]): ApproachCriterionKind[] => [...new Set(ex.map((e) => e.kind))];

/** Heights in sentences: rounded to 10 ft below 1000 ft, to 50 ft above. */
function hatText(h: number): string {
  const step = Math.abs(h) < 1000 ? 10 : 50;
  return fmt(Math.round(h / step) * step, 0, "ft");
}

/** Why a gate criterion has no value ("bei 10 nm nicht eingedreht"). */
export function unavailableReason(a: ApproachAnalysis, g: ApproachGate, c: ApproachCriterion): string {
  if (!g.reached) return "Gate nicht erreicht";
  const notEstablished = !a.established || (g.sample != null && a.established.tMs > g.sample.tMs);
  switch (c.kind) {
    case "altitudeDeviation":
    case "energy":
      if (!a.runway) return "ohne Piste";
      if (c.kind === "energy" && a.reference.vappKt == null) return "ohne Referenz-Speed";
      if (notEstablished) return `bei ${GATE_LABEL[g.kind]} nicht eingedreht`;
      return "nicht auf dem Endanflug";
    case "speed":
      return "ohne Referenz-Speed";
    case "glidepath":
    case "localizer":
      if (!a.runway) return "ohne Piste";
      return notEstablished ? `bei ${GATE_LABEL[g.kind]} nicht eingedreht` : "nicht auf dem Endanflug";
    default:
      return "keine Daten";
  }
}

/** Height range of an exceedance: "bei 380 ft" / "zwischen 1 000 und 760 ft". */
export function exceedanceRange(e: Exceedance): string {
  const hi = Math.max(e.startHatFt, e.endHatFt);
  const lo = Math.min(e.startHatFt, e.endHatFt);
  if (hi - lo < 50) return `bei ${hatText((hi + lo) / 2)}`;
  return `zwischen ${hatText(hi).replace(/\s*ft$/, "")} und ${hatText(lo)}`;
}

/** "Sinkrate −1 450 fpm für 6 s bei 380 ft". */
export function exceedancePhrase(e: Exceedance, a?: ApproachAnalysis): string {
  if (e.kind === "flapChange") return `Klappen ${exceedanceRange(e)} verstellt`;
  const peak = valueText(e.kind, e.peak, "approach");
  const ref = e.kind === "speed" && a?.reference.vappKt != null ? " zur Referenz" : "";
  return `${CRITERION_SHORT[e.kind]} ${peak}${ref} für ${fmt(e.durationS, 0, "s")} ${exceedanceRange(e)}`;
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
  return a.reference.vappSource === "flown" ? "die geflogene Referenz" : `die Referenz (${fmt(a.reference.vappKt, 0, "kt")})`;
}

/** Notable speed (≥ 10 kt) or height (≥ 100 ft) offset at the FAF as a sentence, else null. */
function fafNote(a: ApproachAnalysis): string | null {
  const s = gateOf(a, "faf")?.sample;
  if (!s) return null;
  if (s.iasDevKt != null && a.reference.vappKt != null && Math.abs(s.iasDevKt) >= 10) {
    return `Bei FAF ${fmt(Math.abs(s.iasDevKt), 0, "kt")} ${s.iasDevKt > 0 ? "schneller" : "langsamer"} als ${refPhrase(a)}.`;
  }
  if (s.altDevFt != null && Math.abs(s.altDevFt) >= 100) {
    return `Bei FAF ${fmt(Math.abs(s.altDevFt), 0, "ft")} ${s.altDevFt > 0 ? "über" : "unter"} dem ${fmt(a.reference.glidepathDeg, 0, "°")}-Pfad.`;
  }
  return null;
}

// ---- lateral guidance (extended centreline) ----------------------------------------------
// Bands are a VectaSim convention (crates/vectasim-core/src/approach.rs, `lat_band_*`): FSF
// ALAR only uses ±1 dot as the gate limit.

export const LATERAL_BAND_LABEL: Record<LateralBand, string> = {
  onCentreline: "auf der Grundlinie",
  slight: "leichte Abweichung",
  marked: "deutliche Abweichung",
};

/** Why the lateral guidance has no band: no runway, a runway derived from the own track, too few samples; null = assessed. */
export function lateralUnmeasurableReason(a: ApproachAnalysis): string | null {
  if (!a.runway) return "ohne Piste nicht messbar";
  if (isDerivedRunway(a.runway) || a.lateral?.measurable === false) return "Piste aus Rollspur – nicht bewertbar";
  if (!a.lateral || a.lateral.lateralBand == null) return "zu wenige Samples";
  return null;
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
  const why = lateralUnmeasurableReason(a);
  const l = a.lateral;
  if (!l || (why && why !== "zu wenige Samples")) return why ?? "nicht messbar";
  const parts: string[] = [];
  if (l.locMaxDots != null) parts.push(`max. ${fmtSigned(l.locMaxDots, 1)}${NNBSP}Dots`);
  if (l.latAt500M != null) parts.push(`bei 500${NNBSP}ft ${sideLabel(l.latAt500M)}`);
  if (l.latAtThresholdM != null) parts.push(`Schwelle ${sideLabel(l.latAtThresholdM)}`);
  return parts.join(" · ") || "zu wenige Samples";
}

/** "Grundlinie" line of the facts block: band, intercept overshoot, S-turns. */
export function lateralFactText(a: ApproachAnalysis): string {
  const why = lateralUnmeasurableReason(a);
  const l = a.lateral;
  if (!l || l.lateralBand == null || why) return why ?? "nicht messbar";
  const parts = [LATERAL_BAND_LABEL[l.lateralBand]];
  parts.push(
    l.interceptOvershootM != null
      ? `beim Eindrehen ${fmt(Math.abs(l.interceptOvershootM), 0, "m")} (${fmtNum(Math.abs(l.interceptOvershootDots ?? 0), 1)}${NNBSP}Dots) übergeschossen`
      : "ohne Überschießen eingedreht",
  );
  if (l.lateralReversals != null) parts.push(l.lateralReversals === 0 ? "keine S-Kurven" : `${fmtNum(l.lateralReversals)} Seitenwechsel (S-Kurven)`);
  return parts.join(" · ");
}

/** Key-sentence clause when the lateral band is not "on the centreline": "bei 500 ft 40 m rechts der Grundlinie". */
function lateralClause(a: ApproachAnalysis): string | null {
  const l = a.lateral;
  if (!l || l.lateralBand == null || l.lateralBand === "onCentreline" || lateralUnmeasurableReason(a)) return null;
  if (l.latAt500M != null && Math.abs(l.latAt500M) >= 0.5) return `bei 500${NNBSP}ft ${fmt(Math.abs(l.latAt500M), 0, "m")} ${l.latAt500M > 0 ? "rechts" : "links"} der Grundlinie`;
  return `${LATERAL_BAND_LABEL[l.lateralBand]} von der Grundlinie${l.locMaxDots != null ? ` (max. ${fmtSigned(l.locMaxDots, 1)}${NNBSP}Dots)` : ""}`;
}

/** Lateral observations: intercept overshoot, S-turns, offset below 500 ft, over the threshold, not assessable. */
export function lateralHints(a: ApproachAnalysis): Hint[] {
  const out: Hint[] = [];
  if (!a.runway) return out; // the "Keine Piste zugeordnet" hint already names it
  const l = a.lateral;
  if (isDerivedRunway(a.runway) || l?.measurable === false) {
    out.push({ tone: "info", text: "Piste aus deiner Rollspur abgeleitet – Querablage zur Grundlinie nicht bewertbar" });
    return out;
  }
  if (!l) return out;
  const od = l.interceptOvershootDots;
  if (l.interceptOvershootM != null && od != null && Math.abs(od) > 0.5) {
    out.push({
      tone: "warn",
      text: `Beim Eindrehen ${fmt(Math.abs(l.interceptOvershootM), 0, "m")} (${fmtNum(Math.abs(od), 1)}${NNBSP}Dots) über die Grundlinie nach ${l.interceptOvershootM > 0 ? "rechts" : "links"} hinausgeschossen`,
    });
  }
  const rev = l.lateralReversals;
  if (rev != null && rev >= 2) {
    const dots = fmtNum(a.config.latReversalDots ?? 0.3, 1);
    const floor = fmt(a.config.latReversalFloorFt ?? 100, 0, "ft");
    out.push({
      tone: rev >= 3 ? "warn" : "info",
      text: `${fmtNum(rev)} Seitenwechsel um die Grundlinie zwischen ${fmtNum(a.config.windowTopFt)} und ${floor} (S-Kurven, Ablage über ${dots}${NNBSP}Dots)`,
    });
  }
  const low = maxLocBelow500(a);
  if (low != null && Math.abs(low) > 0.5) {
    out.push({ tone: "warn", text: `Unter 500${NNBSP}ft bis ${fmtNum(Math.abs(low), 1)}${NNBSP}Dots ${low > 0 ? "rechts" : "links"} der Grundlinie – über 0,5${NNBSP}Dots` });
  }
  const thr = l.latAtThresholdM;
  if (thr != null && a.outcome.kind !== "goAround" && Math.abs(thr) > 10) {
    const w = a.runway.widthM;
    const warn = w != null && w > 0 && Math.abs(thr) > w / 4;
    out.push({
      tone: warn ? "warn" : "info",
      text: `Über der Schwelle ${sideLabel(thr)} der Mittellinie${warn ? ` – mehr als ein Viertel der Pistenbreite (${fmt(w, 0, "m")})` : ""}`,
    });
  }
  if (l.lateralBand === "onCentreline" && out.length === 0) {
    out.push({
      tone: "ok",
      text: `Grundlinie ${fmtNum(a.config.windowTopFt)} → ${fmt(a.config.windowBottomFt, 0, "ft")} gehalten (RMS ${fmtNum(a.stability.locRmsDots ?? 0, 2)}${NNBSP}Dots)`,
    });
  }
  return out;
}

/**
 * The sentence the approach section opens with. Landing: where the aircraft was established,
 * from where it stayed stable, then the main exceedance or a notable FAF offset –
 * "Auf der Grundlinie ab 5,0 nm, stabil ab 1 500 ft. Bei FAF 16 kt schneller als die geflogene
 * Referenz." Go-around: "Durchstarten bei 284 ft nach stabilem Anflug – richtige Entscheidung."
 */
export function approachKeySentence(a: ApproachAnalysis): string {
  const kinds = distinctKinds(a.exceedances);
  if (a.outcome.kind === "goAround") {
    const at = a.goAround ? ` bei ${fmt(a.goAround.lowestHatFt, 0, "ft")}` : "";
    const how = kinds.length ? ` nach Abweichungen bei ${listDe(kinds.map((k) => CRITERION_SHORT[k]))}` : a.band ? " nach stabilem Anflug" : "";
    return `Durchstarten${at}${how} – richtige Entscheidung.`;
  }
  const first: string[] = [];
  if (!a.runway) first.push("Ohne zugeordnete Piste – nur Speed, Sinkrate, Querneigung und Konfiguration bewertet");
  else if (a.established) first.push(`Auf der Grundlinie ab ${fmt(a.established.distNm, 1, "nm")}`);
  else first.push("Nicht stabil auf der verlängerten Mittellinie eingedreht");
  const sf = a.stability.stableFromFt;
  if (a.band != null) first.push(sf != null ? `stabil ab ${fmt(sf, 0, "ft")}` : "bis 50 ft nie durchgehend stabil");
  const lat = lateralClause(a);
  if (lat) first.push(lat);
  let out = `${first.join(", ")}.`;
  const main = mainExceedance(a);
  if (main) {
    const lead =
      a.band === "unstableBelow500"
        ? "Instabil unter 500 ft"
        : a.band === "unstable"
          ? `Instabil über 500 ft (${listDe(kinds.map((k) => CRITERION_SHORT[k]))})`
          : "Abweichung über 500 ft";
    out += ` ${lead}: ${exceedancePhrase(main, a)}.`;
  } else {
    const faf = fafNote(a);
    if (faf) out += ` ${faf}`;
  }
  if (a.outcome.kind === "touchAndGo") out += " Touch-and-go.";
  return out;
}

/** Label of an approach in the picker: "Anflug 1 – Durchstarten bei 284 ft". */
export function approachLabel(a: ApproachAnalysis): string {
  const n = `Anflug ${a.index + 1}`;
  switch (a.outcome.kind) {
    case "goAround":
      return `${n} – Durchstarten${a.goAround ? ` bei ${fmt(a.goAround.lowestHatFt, 0, "ft")}` : ""}`;
    case "touchAndGo":
      return `${n} – Touch-and-go`;
    case "landed":
      return `${n} – Landung`;
  }
}

/** Gate result for the card / summaries: ✓ all measurable passed, ✗ one failed, – not reached. */
export function gateMark(g: ApproachGate | null): string {
  if (!g || !g.reached) return "–";
  return g.criteria.some((c) => c.status === "fail") ? "✗" : "✓";
}

/** One line for the landing card: "3°-Annahme · stabil ab 1 500 ft · 1000 ✓ 500 ✓". */
export function approachCardLine(a: ApproachAnalysis): string {
  const ref = a.reference;
  const parts = [ref.glidepathSource === "assumed" ? `${fmt(ref.glidepathDeg, 0, "°")}-Annahme` : `${fmt(ref.glidepathDeg, 1, "°")}-Pfad`];
  if (a.band != null) parts.push(a.stability.stableFromFt != null ? `stabil ab ${fmt(a.stability.stableFromFt, 0, "ft")}` : "nie durchgehend stabil");
  parts.push(`1000 ${gateMark(gateOf(a, "ft1000"))} 500 ${gateMark(gateOf(a, "ft500"))}`);
  return parts.join(" · ");
}

/** Provenance of the four approach hero values. */
export function approachProvenance(a: ApproachAnalysis): { stable: Provenance; glidepath: Provenance; lateral: Provenance; speed: Provenance } {
  const st = a.stability;
  const ref = a.reference;
  const c = a.config;
  return {
    stable: {
      kind: "measured",
      detail: `Höchste Höhe (bis ${fmt(c.stableFromMaxFt, 0, "ft")}, auf ${fmtNum(c.stableRoundFt)}${NNBSP}ft abgerundet), ab der bis ${fmt(c.windowBottomFt, 0, "ft")} kein Kriterium länger als seine Mindestdauer außerhalb der Toleranz lag – aus dem 1-Hz-Track (${fmtNum(st.windowSamples)} Samples im Fenster ${fmtNum(c.windowTopFt)} → ${fmt(c.windowBottomFt, 0, "ft")}).`,
    },
    glidepath: {
      kind: "derived",
      detail: `Höhe gegen einen angenommenen ${fmt(ref.glidepathDeg, 0, "°")}-Pfad über ${fmt(ref.tchFt, 0, "ft")} Schwellenhöhe, aus Position und Schwellen-Koordinaten berechnet (keine Verfahrensdaten). 1 Dot = ${fmtNum(c.gsDotDeg, 2)}°. RMS über ${fmtNum(c.windowTopFt)} → ${fmt(c.gsFloorFt, 0, "ft")}.`,
    },
    lateral: {
      kind: "derived",
      detail: !a.runway
        ? "Keine Piste zugeordnet – die Querablage zur verlängerten Mittellinie ist nicht messbar."
        : isDerivedRunway(a.runway) || a.lateral?.measurable === false
          ? `${LATERAL_REASON} Die Querablage im Anflug ist deshalb nicht bewertbar.`
          : `Querablage zur verlängerten Mittellinie aus Position und Schwellen-Koordinaten. Dots geometrisch: Winkel von einer virtuellen Antenne ${fmt(c.locAntennaBeyondEndM, 0, "m")} hinter dem Pistenende, 1 Dot = ${fmt(c.locDotMAtThreshold, 0, "m")} an der Schwelle. RMS über ${fmtNum(c.windowTopFt)} → ${fmt(c.windowBottomFt, 0, "ft")}. Band nach VectaSim-Konvention: auf der Grundlinie RMS ≤ ${fmtNum(c.latBandOnRmsDots ?? 0.3, 1)} und max. ≤ ${fmtNum(c.latBandOnMaxDots ?? 0.5, 1)}${NNBSP}Dots, leichte Abweichung RMS ≤ ${fmtNum(c.latBandSlightRmsDots ?? 0.6, 1)} und max. ≤ ${fmtNum(c.latBandSlightMaxDots ?? 1, 1)}${NNBSP}Dots (FSF-Gate ±1${NNBSP}Dot), darüber deutlich.`,
    },
    speed: {
      kind: "measured",
      detail:
        ref.vappSource === "flown"
          ? `IAS gegen den Median der eigenen IAS zwischen ${fmtNum(c.vappFromFt)} und ${fmt(c.vappToFt, 0, "ft")} (${fmt(ref.vappKt, 0, "kt")}). Das misst die Konstanz der Geschwindigkeit, nicht ob sie für das Flugzeug richtig war.`
          : ref.vappSource === "user"
            ? `IAS gegen die vom Piloten gesetzte Referenz ${fmt(ref.vappKt, 0, "kt")}; geflogener Median ${fmt(ref.flownVappKt, 0, "kt")}.`
            : "Keine Referenz-Geschwindigkeit messbar – Speed-Kriterien entfallen.",
    },
  };
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
      text: `Durchgestartet: tiefster Punkt ${fmt(g.lowestHatFt, 0, "ft")} über ${a.elevationSource === "database" ? "Platzhöhe" : "Grund"}, danach ${fmtSigned(g.climbFt, 0, "ft")} in ${fmt(a.config.gaWindowS, 0, "s")}, IAS min. ${fmt(g.minIasKt, 0, "kt")}`,
    });
  }

  if (a.runway) {
    if (a.established) {
      out.push({ tone: "info", text: `Auf dem Endanflug ab ${fmt(a.established.distNm, 1, "nm")} / ${fmt(a.established.hatFt, 0, "ft")} eingedreht (RWY ${a.runway.ident})` });
    } else {
      out.push({ tone: "warn", text: "Nicht stabil auf der verlängerten Mittellinie eingedreht – Gleitpfad und Kurs nur dort gewertet, wo der Anflug im Endanflug-Kegel lag" });
    }
  } else {
    out.push({ tone: "info", text: "Keine Piste zugeordnet – Gleitpfad, Kurs, Höhe zum Pfad und Energie entfallen" });
  }
  out.push(...lateralHints(a));

  if (ref.vappSource === "flown") {
    out.push({
      tone: "info",
      text: `Referenz-Speed ist der Median der geflogenen IAS ${fmtNum(a.config.vappFromFt)} → ${fmt(a.config.vappToFt, 0, "ft")} (${fmt(ref.vappKt, 0, "kt")}) – bewertet die Konstanz, nicht die absolute Geschwindigkeit`,
    });
  } else if (ref.vappSource === "unavailable") {
    out.push({ tone: "info", text: "Keine Referenz-Geschwindigkeit messbar – Speed- und Energiekriterien entfallen" });
  }
  if (ref.vappPlausible === false && ref.vs0Kt != null) {
    out.push({ tone: "warn", text: `Referenz ${fmt(ref.vappKt, 0, "kt")} liegt außerhalb von ${fmtNum(a.config.vappMinVs0, 1)}–${fmtNum(a.config.vappMaxVs0, 1)} × VS0 (${fmt(ref.vs0Kt, 0, "kt")})` });
  }

  // configuration
  const gear = [...a.configEvents].reverse().find((e) => e.kind === "gearDown");
  if (gear) {
    out.push(
      gear.hatFt < cfgFt
        ? { tone: "warn", text: `Fahrwerk erst bei ${fmt(gear.hatFt, 0, "ft")} ausgefahren – Landekonfiguration bis ${fmt(cfgFt, 0, "ft")} erwartet` }
        : { tone: "info", text: `Fahrwerk bei ${fmt(gear.hatFt, 0, "ft")} ausgefahren` },
    );
  }
  const flapEvents = a.configEvents.filter((e) => e.kind === "flaps");
  const landingFlaps = ref.landingFlapsIndex != null ? [...flapEvents].reverse().find((e) => e.flapsTo === ref.landingFlapsIndex) : flapEvents[flapEvents.length - 1];
  if (landingFlaps) {
    const stage = landingFlaps.flapsTo != null ? ` (Stufe ${fmtNum(landingFlaps.flapsTo)})` : "";
    out.push(
      landingFlaps.hatFt < cfgFt
        ? { tone: "warn", text: `Landeklappen${stage} erst bei ${fmt(landingFlaps.hatFt, 0, "ft")} gesetzt – Landekonfiguration bis ${fmt(cfgFt, 0, "ft")} erwartet` }
        : { tone: "info", text: `Landeklappen${stage} bei ${fmt(landingFlaps.hatFt, 0, "ft")} gesetzt` },
    );
  }

  // gates
  for (const g of a.gates) {
    if (g.kind === "ft50") continue;
    if (!g.reached) {
      if (g.kind === "tenNm" || a.outcome.kind === "goAround") out.push({ tone: "info", text: `Gate ${GATE_LABEL[g.kind]} nicht durchflogen – Prüfung entfällt` });
      continue;
    }
    const at = `bei ${GATE_LABEL[g.kind]}`;
    for (const c of g.criteria) {
      const h = criterionHint(at, c, "approach");
      if (h) out.push({ tone: "warn", text: h });
    }
    // a height offset at the FAF worth naming even inside the tolerance
    const alt = g.criteria.find((c) => c.kind === "altitudeDeviation");
    if (g.kind === "faf" && alt?.status === "pass" && alt.measured != null && Math.abs(alt.measured) >= 100) {
      out.push({ tone: "info", text: `Bei FAF ${fmt(Math.abs(alt.measured), 0, "ft")} ${alt.measured > 0 ? "über" : "unter"} dem ${fmt(ref.glidepathDeg, 0, "°")}-Pfad` });
    }
  }

  // exceedances 1000 → 50 ft
  for (const e of a.exceedances) {
    const limit = e.kind === "flapChange" ? `Klappenänderung unter ${fmt(cfgFt, 0, "ft")}` : `Grenze ${valueText(e.kind, e.limit, "approach")}`;
    out.push({ tone: "warn", text: `${exceedancePhrase(e, a)} – ${limit}${e.level === "s2" ? " (Stufe S2)" : ""}` });
  }
  if (a.band != null && a.exceedances.length === 0) {
    const bottom = a.outcome.kind === "goAround" ? "bis zum Durchstarten" : `bis ${fmt(a.config.windowBottomFt, 0, "ft")}`;
    out.push({ tone: "ok", text: `Ab ${fmt(a.config.windowTopFt, 0, "ft")} ${bottom} alle messbaren Kriterien ununterbrochen erfüllt` });
  }

  const e10 = a.energy?.atTenNm;
  if (e10 && Math.abs(e10.totalFt) >= 300) {
    out.push({
      tone: "info",
      text: `Energie bei 10${NNBSP}nm ${fmtSigned(e10.totalFt, 0, "ft")} ${e10.totalFt > 0 ? "über" : "unter"} dem Profil (davon ${fmtSigned(e10.heightFt, 0, "ft")} Höhe, ${fmtSigned(e10.speedFt, 0, "ft")} aus der Geschwindigkeit)`,
    });
  }
  return out;
}
