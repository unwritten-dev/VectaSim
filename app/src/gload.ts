// G-load over the whole flight (crates/vectasim-core/src/gload.rs): the line in the flight
// detail, the debrief hint and the Messprotokoll row. The landing's own peak g is judged
// separately (landing/facts.ts → G_BAND_LIMITS); this is everything in the air around it.

import { PHASE_LABEL } from "./format";
import { t } from "./i18n";
import { fmt } from "./i18n/number";
import type { GLoadPoint, GLoadStats } from "./types";

// Hint thresholds – a VectaSim convention, not a regulation. Reference: the limit load
// factors of a transport aircraft (CS/FAR 25.337: +2.5 g, −1 g in the clean configuration).
// A normal airline flight stays within roughly 0.7–1.3 g; beyond 1.6 g / below 0.4 g is a
// noticeable manoeuvre or strong turbulence (info), beyond 2.0 g or below 0 g approaches
// the structural limits (warning).
/** Info hint above this, g. */
export const G_FLIGHT_INFO_HIGH = 1.6;
/** Info hint below this, g. */
export const G_FLIGHT_INFO_LOW = 0.4;
/** Warning above this, g. */
export const G_FLIGHT_WARN_HIGH = 2.0;
/** Warning below this (negative g), g. */
export const G_FLIGHT_WARN_LOW = 0;

// Recording rules (mirrors crates/vectasim-core/src/gload.rs, for the explanations)
const SMOOTHING_S = 0.3;
const TOUCHDOWN_WINDOW_S = 3;
const HIGH_G = 1.5;
const LOW_G = 0.5;
const EXCURSION_MIN_S = 0.5;

export type GLoadTone = "warn" | "info";

/** "1,42 g" / "1.42 g". */
export function fmtG(g: number | null | undefined): string {
  return fmt(g, 2, "g");
}

/** Altitude of an extreme, to the nearest 100 ft: "3 200 ft". */
function altText(p: GLoadPoint): string {
  return fmt(Math.round(p.altitudeMslFt / 100) * 100, 0, "ft");
}

const phaseText = (p: GLoadPoint) => PHASE_LABEL[p.phase] ?? p.phase;

/** Something was measured (max and min). */
export function hasGLoad(g: GLoadStats | null | undefined): g is GLoadStats & { max: GLoadPoint; min: GLoadPoint } {
  return !!g && !!g.max && !!g.min;
}

/** "max 1,42 g (Climb, 3 200 ft) · min 0,71 g (Descent)"; "nicht gemessen" without values. */
export function gLoadSummary(g: GLoadStats | null | undefined): string {
  if (!hasGLoad(g)) return t("gload.notMeasured");
  return t("gload.summary", { max: fmtG(g.max.g), maxPhase: phaseText(g.max), maxAlt: altText(g.max), min: fmtG(g.min.g), minPhase: phaseText(g.min) });
}

/** "Über 1,5 g: 2 ×, unter 0,5 g: 0 × (je mindestens 0,5 s am Stück)". */
export function gLoadCounts(g: GLoadStats): string {
  return t("gload.counts", { high: fmt(HIGH_G, 1, "g"), highCount: g.highCount, low: fmt(LOW_G, 1, "g"), lowCount: g.lowCount, min: fmt(EXCURSION_MIN_S, 1, "s") });
}

/** Tooltip of the flight-detail line: how it is measured, the excursions and the source. */
export function gLoadTitle(g: GLoadStats | null | undefined): string {
  if (!hasGLoad(g)) return t("gload.notMeasuredTitle");
  return [
    t("gload.title", { window: fmt(TOUCHDOWN_WINDOW_S, 0, "s"), smoothing: fmt(SMOOTHING_S, 1, "s") }),
    gLoadCounts(g),
    g.source === "track" ? t("gload.sourceTrack") : t("gload.sourceLive"),
  ].join("\n");
}

/** Value of the debrief's Messprotokoll row; null when not measured (no row). */
export function gLoadProtocol(g: GLoadStats | null | undefined): string | null {
  if (!hasGLoad(g)) return null;
  const source = g.source === "track" ? t("gload.protocol.sourceTrack") : t("gload.protocol.sourceLive", { smoothing: fmt(SMOOTHING_S, 1, "s") });
  return t("gload.protocol.value", { summary: gLoadSummary(g), counts: gLoadCounts(g), source });
}

/** Debrief hints, only when something stands out (thresholds above); high and low on their own. */
export function gLoadHints(g: GLoadStats | null | undefined): Array<{ tone: GLoadTone; text: string }> {
  if (!hasGLoad(g)) return [];
  const out: Array<{ tone: GLoadTone; text: string }> = [];
  const source = g.source === "track" ? t("gload.hint.track") : "";
  const vars = (p: GLoadPoint) => ({ g: fmtG(p.g), phase: phaseText(p), alt: altText(p), source });
  if (g.max.g > G_FLIGHT_WARN_HIGH) out.push({ tone: "warn", text: t("gload.hint.highWarn", vars(g.max)) });
  else if (g.max.g > G_FLIGHT_INFO_HIGH) out.push({ tone: "info", text: t("gload.hint.high", vars(g.max)) });
  if (g.min.g < G_FLIGHT_WARN_LOW) out.push({ tone: "warn", text: t("gload.hint.lowWarn", vars(g.min)) });
  else if (g.min.g < G_FLIGHT_INFO_LOW) out.push({ tone: "info", text: t("gload.hint.low", vars(g.min)) });
  return out;
}

/** Live side panel: "1,23 g" while airborne values exist, else null (no row). */
export function liveMaxG(g: GLoadStats | null | undefined): string | null {
  return g?.max ? fmtG(g.max.g) : null;
}

/** Tooltip of the live row. */
export function liveMaxGTitle(): string {
  return t("gload.live.title", { smoothing: fmt(SMOOTHING_S, 1, "s"), window: fmt(TOUCHDOWN_WINDOW_S, 0, "s") });
}
