// Wording for the landing debrief: labels, limits and the "Hinweise" list derived from
// the measured facts. Pure (see facts.test.ts). The tone stays factual: we say what was
// measured and which limit it is compared with, never "good" or "bad".

import { DASH, NNBSP, fmt, fmtNum, fmtSigned } from "../format";
import { sideLabel } from "./geometry";
import type { Band, CheckStatus, Criterion, CriterionKind, GateCheck, LandingAnalysis, LandingDebriefData } from "./types";

export const BAND_LABEL: Record<Band, string> = {
  smooth: "sanft",
  normal: "normal",
  firm: "fest",
  hard: "hart",
};

/** CSS custom property per band (tokens only). */
export const BAND_VAR: Record<Band, string> = {
  smooth: "var(--ok)",
  normal: "var(--accent)",
  firm: "var(--warn)",
  hard: "var(--err)",
};

export const VS_BANDS = "sanft < 150 · normal < 300 · fest < 600 · hart ≥ 600 fpm";
export const G_BANDS = "sanft < 1,25 · normal < 1,5 · fest < 1,75 · hart ≥ 1,75 G";

export const CRITERION_LABEL: Record<CriterionKind, string> = {
  gear: "Fahrwerk ausgefahren",
  flaps: "Klappen gesetzt",
  verticalSpeed: "Sinkrate",
  speed: "Geschwindigkeit",
  glidepath: "Gleitpfad",
  bank: "Querneigung",
};

export const CRITERION_ORDER: CriterionKind[] = ["gear", "flaps", "verticalSpeed", "speed", "glidepath", "bank"];

export const STATUS_ICON: Record<CheckStatus, string> = { pass: "✓", fail: "✗", unavailable: "–" };

/** Limit text for the table ("|V/S| ≤ 1 000 fpm"). */
export function limitText(c: Criterion): string {
  switch (c.kind) {
    case "gear":
      return "unten";
    case "flaps":
      return "Stufe > 0";
    case "verticalSpeed":
      return `|V/S| ≤ ${fmt(c.limitMax, 0, "fpm")}`;
    case "speed":
      return `${fmtSigned(c.limitMin, 0)}/${fmtSigned(c.limitMax, 0)}${NNBSP}kt zu IAS@500${NNBSP}ft`;
    case "glidepath":
      return `${fmt(c.reference, 1, "°")} ±${fmtNum(c.limitMax, 1)}°`;
    case "bank":
      return `≤ ${fmt(c.limitMax, 0, "°")}`;
  }
}

/** Measured value as text ("−740 fpm", "+0,2°", "ausgefahren"). */
export function measuredText(c: Criterion): string {
  if (c.measured == null) return c.kind === "glidepath" ? "ohne Runway n. v." : "n. v.";
  switch (c.kind) {
    case "gear":
      return c.measured >= 95 ? "ausgefahren" : c.measured <= 5 ? "eingefahren" : `${fmtNum(c.measured)}${NNBSP}%`;
    case "flaps":
      return c.measured > 0 ? `Stufe ${fmtNum(c.measured)}` : "eingefahren";
    case "verticalSpeed":
      return fmtSigned(Math.round(c.measured), 0, "fpm");
    case "speed":
      return `${fmtSigned(c.measured, 0, "kt")} (${fmt((c.reference ?? 0) + c.measured, 0, "kt")})`;
    case "glidepath":
      return fmtSigned(c.measured, 1, "°");
    case "bank":
      return fmt(c.measured, 0, "°");
  }
}

export type HintTone = "ok" | "warn" | "info";
export interface Hint {
  tone: HintTone;
  text: string;
}

const gateName = (g: GateCheck) => `${fmtNum(g.gateFt)}${NNBSP}ft`;

/** One sentence per failed stabilised-approach criterion. */
function criterionHint(g: GateCheck, c: Criterion): string | null {
  if (c.status !== "fail" || c.measured == null) return null;
  const at = `bei ${gateName(g)}`;
  switch (c.kind) {
    case "gear":
      return `Fahrwerk ${at} nicht ausgefahren (${fmtNum(c.measured)}${NNBSP}%)`;
    case "flaps":
      return `Klappen ${at} eingefahren`;
    case "verticalSpeed":
      return `Sinkrate ${at} ${fmt(Math.abs(c.measured), 0, "fpm")} – über dem Limit von ${fmt(c.limitMax, 0, "fpm")}`;
    case "speed":
      return `Geschwindigkeit ${at} ${fmtSigned(c.measured, 0, "kt")} gegenüber der IAS bei 500${NNBSP}ft (${fmt(c.reference, 0, "kt")}) – Fenster ${fmtSigned(c.limitMin, 0)}/${fmtSigned(c.limitMax, 0)}${NNBSP}kt`;
    case "glidepath":
      return `Gleitpfad ${at} ${fmtSigned(c.measured, 1, "°")} ${c.measured > 0 ? "über" : "unter"} dem ${fmt(c.reference, 0, "°")}-Pfad – Toleranz ±${fmtNum(c.limitMax, 1)}°`;
    case "bank":
      return `Querneigung ${at} ${fmt(c.measured, 0, "°")} – über ${fmt(c.limitMax, 0, "°")}`;
  }
}

/** Plain-German observations, each with the numbers it is based on. */
export function buildHints(d: LandingDebriefData): Hint[] {
  const a: LandingAnalysis = d.analysis;
  const td = a.touchdown;
  const out: Hint[] = [];
  const tp = a.touchdownPoint;
  const rwy = a.runway;

  if (td.touchAndGo) out.push({ tone: "info", text: "Touch-and-go: nach dem Aufsetzen wieder durchgestartet – kein Rollout" });

  if (tp && rwy) {
    const dist = fmt(tp.distanceM, 0, "m");
    const zone = `${fmtNum(tp.tdzStartM)}–${fmt(tp.tdzEndM, 0, "m")}`;
    if (tp.distanceM < 0) out.push({ tone: "warn", text: `Aufsetzen ${fmt(-tp.distanceM, 0, "m")} vor der Schwelle` });
    else if (tp.distanceM < tp.tdzStartM) out.push({ tone: "warn", text: `Aufsetzen ${dist} hinter der Schwelle – vor der Touchdown-Zone (${zone})` });
    else if (tp.distanceM <= tp.tdzEndM) out.push({ tone: "ok", text: `Aufsetzen ${dist} hinter der Schwelle – innerhalb der Touchdown-Zone (${zone})` });
    else out.push({ tone: "warn", text: `Aufsetzen ${dist} hinter der Schwelle – nach der Touchdown-Zone (${zone}), ${fmt(tp.remainingM, 0, "m")} Runway übrig` });

    const halfW = rwy.widthM / 2;
    if (!rwy.onRunway && Math.abs(tp.lateralM) > halfW) {
      out.push({
        tone: "warn",
        text: `Aufsetzpunkt ${sideLabel(tp.lateralM)} der Mittellinie – außerhalb der Runway-Breite (${fmt(rwy.widthM, 0, "m")}); RWY ${rwy.ident} ist die nächstgelegene passende Runway`,
      });
    } else {
      out.push({ tone: Math.abs(tp.lateralM) > halfW / 2 ? "warn" : "ok", text: `Aufsetzpunkt ${sideLabel(tp.lateralM)} der Mittellinie (Runway ${fmt(rwy.widthM, 0, "m")} breit)` });
    }
  } else {
    out.push({ tone: "info", text: "Keine Runway zugeordnet – Aufsetzpunkt, Mittellinie und Gleitpfad lassen sich nicht bestimmen" });
  }

  if (a.threshold) {
    out.push({
      tone: "info",
      text: `Schwelle in ${fmt(a.threshold.heightFt, 0, "ft")} überflogen (Referenz ${fmt(a.config.tchFt, 0, "ft")}), ${fmt(a.threshold.iasKt, 0, "kt")} IAS, ${fmt(a.threshold.airborneS, 0, "s")} bis zum Aufsetzen`,
    });
  }

  // stabilised approach
  const reached = a.gates.filter((g) => g.reached);
  for (const g of a.gates) {
    if (!g.reached) out.push({ tone: "info", text: `Anflug lag nie über ${gateName(g)} – Prüfung bei ${gateName(g)} entfällt` });
  }
  const fails = reached.flatMap((g) => g.criteria.map((c) => criterionHint(g, c)).filter((s): s is string => !!s));
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
      text: `${td.bounces} ${td.bounces === 1 ? "Bounce" : "Bounces"} nach dem ersten Aufsetzen – härtester Kontakt ${fmt(td.vsFpmHardest, 0, "fpm")}, Landerate ist der härteste Kontakt dieses Ereignisses`,
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
    out.push({ tone: w.headwindKt < -0.5 ? "warn" : "info", text: `${parts.join(", ")} (METAR ${windText(w.directionDeg, w.speedKt, w.gustKt)}, bezogen auf ${ref})` });
  } else if (w) {
    out.push({ tone: "info", text: `Wind variabel ${fmt(w.speedKt, 0, "kt")} – keine Komponenten berechenbar` });
  }

  if (a.rollout) {
    const rest = a.rollout.remainingM;
    out.push({
      tone: rest != null && rest < 0 ? "warn" : "info",
      text:
        `Rollout bis ${fmt(a.config.rolloutEndKt, 0, "kt")}: ${fmt(a.rollout.distanceM, 0, "m")} in ${fmt(a.rollout.durationS, 0, "s")}` +
        (rest == null ? "" : rest >= 0 ? `, ${fmt(rest, 0, "m")} Runway übrig` : ` – endete ${fmt(-rest, 0, "m")} hinter dem Runway-Ende`),
    });
  }
  return out;
}

export function windText(dir: number | null | undefined, speed: number, gust?: number | null): string {
  const d = dir == null ? "VRB" : `${String(Math.round(dir)).padStart(3, "0")}°`;
  return `${d}/${fmtNum(speed)}${gust ? `G${fmtNum(gust)}` : ""}${NNBSP}kt`;
}

/** Head/crosswind as a compact line for the header: "Gegenwind 8 kt · Seitenwind 5 kt von links". */
export function windComponentsText(a: LandingAnalysis): string {
  const w = a.wind;
  if (!w || w.headwindKt == null || w.crosswindKt == null) return DASH;
  const head = w.headwindKt >= 0 ? `Gegenwind ${fmt(w.headwindKt, 0, "kt")}` : `Rückenwind ${fmt(-w.headwindKt, 0, "kt")}`;
  const xw = Math.abs(w.crosswindKt) < 0.5 ? "kein Seitenwind" : `Seitenwind ${fmt(Math.abs(w.crosswindKt), 0, "kt")} von ${w.crosswindKt > 0 ? "rechts" : "links"}`;
  return `${head} · ${xw}`;
}

// ---- key sentence ----------------------------------------------------------------------

/** Band of a landing rate (mirrors vs_band in crates/vectasim-core/src/landing.rs). */
export function vsBandOf(fpm: number): Band {
  const v = Math.abs(fpm);
  return v < 150 ? "smooth" : v < 300 ? "normal" : v < 600 ? "firm" : "hard";
}

const BAND_ADJ: Record<Band, string> = { smooth: "Sanfte", normal: "Normale", firm: "Feste", hard: "Harte" };
const BAND_ADJ_DAT: Record<Band, string> = { smooth: "sanfter", normal: "normaler", firm: "fester", hard: "harter" };

/** Where on the runway, as a phrase ("in der Touchdown-Zone"). */
export function zonePhrase(a: LandingAnalysis): string | null {
  const tp = a.touchdownPoint;
  if (!tp || !a.runway) return null;
  if (tp.distanceM < 0) return "vor der Schwelle";
  if (tp.distanceM < tp.tdzStartM) return "vor der Touchdown-Zone";
  if (tp.distanceM <= tp.tdzEndM) return "in der Touchdown-Zone";
  return "nach der Touchdown-Zone";
}

/**
 * The one sentence the debrief opens with: band of the landing rate, where on the
 * runway, offset from the centreline, bounces. "Normale Landung in der Touchdown-Zone,
 * 1,8 m links der Mittellinie, ohne Bounce."
 */
export function keySentence(d: LandingDebriefData): string {
  const a = d.analysis;
  const td = a.touchdown;
  const head = td.touchAndGo ? `Touch-and-go mit ${BAND_ADJ_DAT[a.vsBand]} Landerate` : `${BAND_ADJ[a.vsBand]} Landung`;
  const parts: string[] = [];
  const zone = zonePhrase(a);
  if (zone && a.touchdownPoint) {
    parts.push(zone);
    const side = sideLabel(a.touchdownPoint.lateralM);
    parts.push(side.startsWith("auf der") ? side : `${side} der Mittellinie`);
  } else {
    parts.push("ohne zugeordnete Runway");
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
          detail: `Der Sim lieferte keinen Touchdown-Wert. ${fmt(td.landingRateFpm, 0, "fpm")} ist die Vertikalgeschwindigkeit des letzten Samples in der Luft (Telemetrie rund 20 Hz).`,
        };
  const point: Provenance = a.touchdownPoint
    ? {
        kind: "derived",
        detail: `Aus der Position beim ersten Bodenkontakt und den Schwellen-Koordinaten von RWY ${a.runway?.ident ?? ""} (OurAirports) berechnet: ${fmt(a.touchdownPoint.distanceM, 0, "m")} hinter der Schwelle, ${sideLabel(a.touchdownPoint.lateralM)}.`,
      }
    : { kind: "derived", detail: "Keine Runway zugeordnet – der Aufsetzpunkt lässt sich nicht auf eine Schwelle beziehen." };
  const g: Provenance = {
    kind: "measured",
    detail: "Höchster Lastfaktor (G FORCE) in der halben Sekunde nach dem Kontakt, aus dem Telemetriestrom. Unplausible Werte (über 5 G, negativ) werden verworfen.",
  };
  return { rate, point, g };
}

// ---- VectaSim-Index ----------------------------------------------------------------------
// A small summary number, never the headline: the weighted share of points from the same
// bands and checks the debrief shows. The Methodik section prints the formula from these
// constants (indexFormulaLines), so text and calculation cannot drift apart.

export const INDEX_BAND_POINTS: Record<Band, number> = { smooth: 1, normal: 0.8, firm: 0.4, hard: 0 };

export type IndexKey = "rate" | "g" | "bounces" | "zone" | "centreline" | "stable";
export const INDEX_WEIGHTS: Record<IndexKey, number> = { rate: 30, g: 15, bounces: 15, zone: 15, centreline: 10, stable: 15 };
export const INDEX_LABEL: Record<IndexKey, string> = {
  rate: "Landerate",
  g: "G-Last",
  bounces: "Bounces",
  zone: "Aufsetzpunkt",
  centreline: "Mittellinie",
  stable: "Stabilisierter Anflug",
};

export interface IndexPart {
  key: IndexKey;
  weight: number;
  /** 0…1; null = not measurable (no runway, no gate reached) – then left out with its weight. */
  points: number | null;
}

export interface LandingIndex {
  /** 0…100, rounded. */
  value: number;
  parts: IndexPart[];
}

/** Points per part; indexFormulaLines states the same rules in words. */
export function indexParts(a: LandingAnalysis): IndexPart[] {
  const td = a.touchdown;
  const tp = a.touchdownPoint;
  const rwy = a.runway;
  const part = (key: IndexKey, points: number | null): IndexPart => ({ key, weight: INDEX_WEIGHTS[key], points });

  let zone: number | null = null;
  let centre: number | null = null;
  if (tp && rwy) {
    zone = tp.distanceM < 0 ? 0 : tp.distanceM >= tp.tdzStartM && tp.distanceM <= tp.tdzEndM ? 1 : 0.4;
    const off = Math.abs(tp.lateralM);
    centre = off <= rwy.widthM / 4 ? 1 : off <= rwy.widthM / 2 ? 0.5 : 0;
  }
  const evaluated = a.gates.filter((g) => g.reached).flatMap((g) => g.criteria.filter((c) => c.status !== "unavailable"));
  const stable = evaluated.length ? evaluated.filter((c) => c.status === "pass").length / evaluated.length : null;

  return [
    part("rate", INDEX_BAND_POINTS[a.vsBand]),
    part("g", INDEX_BAND_POINTS[a.gBand]),
    part("bounces", td.bounces === 0 ? 1 : td.bounces === 1 ? 0.4 : 0),
    part("zone", zone),
    part("centreline", centre),
    part("stable", stable),
  ];
}

export function landingIndex(a: LandingAnalysis): LandingIndex {
  const parts = indexParts(a);
  const used = parts.filter((p) => p.points != null);
  const total = used.reduce((s, p) => s + p.weight, 0);
  const got = used.reduce((s, p) => s + p.weight * (p.points ?? 0), 0);
  return { value: total ? Math.round((100 * got) / total) : 0, parts };
}

/** The formula in words, for the Methodik section. */
export function indexFormulaLines(): string[] {
  const bp = INDEX_BAND_POINTS;
  const bands = `sanft ${fmtNum(bp.smooth, 1)} · normal ${fmtNum(bp.normal, 1)} · fest ${fmtNum(bp.firm, 1)} · hart ${fmtNum(bp.hard, 1)}`;
  const w = INDEX_WEIGHTS;
  return [
    "VectaSim-Index = 100 × Σ(Gewicht × Punkte) ÷ Σ Gewichte, gerundet. Nicht messbare Teile (ohne Runway, ohne erreichtes Gate) fallen samt Gewicht heraus.",
    `Landerate (Gewicht ${w.rate}) und G-Last (Gewicht ${w.g}): Punkte nach Band – ${bands}.`,
    `Bounces (Gewicht ${w.bounces}): keiner 1,0 · einer 0,4 · zwei oder mehr 0,0.`,
    `Aufsetzpunkt (Gewicht ${w.zone}): in der Touchdown-Zone 1,0 · auf der Runway davor oder dahinter 0,4 · vor der Schwelle 0,0.`,
    `Mittellinie (Gewicht ${w.centreline}): Abweichung bis ein Viertel der Runway-Breite 1,0 · bis zur halben Breite 0,5 · darüber 0,0.`,
    `Stabilisierter Anflug (Gewicht ${w.stable}): Anteil der erfüllten messbaren Kriterien bei 1000 und 500${NNBSP}ft.`,
  ];
}
