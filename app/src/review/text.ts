// Jahresrückblick: card list, file names and the number phrases of the cards. Pure (text.test.ts).

import { getLanguage, tIn, type Language } from "../i18n";
import { NNBSP, fmtNum } from "../i18n/number";
import type { Period } from "./stats";

export type CardId = "overview" | "routes" | "fleet" | "landings" | "approaches" | "months" | "countries" | "flags";
export type CardFormat = "portrait" | "landscape";

/**
 * The cards in order; title and file-name part per language (review.cards.*, review.file.*).
 * „Mit Sternchen“ (flags) is the optional eighth card: only shown when the period has flights
 * with pause, time acceleration, slew or a position jump (ReviewCards.tsx `visibleCards`).
 */
export const CARDS: Array<{ id: CardId; optional?: boolean }> = [
  { id: "overview" },
  { id: "routes" },
  { id: "fleet" },
  { id: "landings" },
  { id: "approaches" },
  { id: "months" },
  { id: "countries" },
  { id: "flags", optional: true },
];

/** „Deine Landungen“ / "Your landings". */
export const cardTitle = (id: CardId, lang: Language = getLanguage()): string => tIn(lang, `review.cards.${id}`);

/** 1080×1920 (Story, 9:16) and 1200×675 (16:9, like the landing card). */
export const FORMAT_SIZE: Record<CardFormat, { w: number; h: number }> = {
  portrait: { w: 1080, h: 1920 },
  landscape: { w: 1200, h: 675 },
};

/** PNG pixels per SVG unit: the story format is already full size, the landscape card is doubled like the landing card. */
export const FORMAT_SCALE: Record<CardFormat, number> = { portrait: 1, landscape: 2 };

/** „Hochformat“ / "Portrait". */
export const formatLabel = (f: CardFormat, lang: Language = getLanguage()): string => tIn(lang, `review.format.${f}`);

const p2 = (n: number) => String(n).padStart(2, "0");

/** "Jahr_2026" / "12Monate_2025-11_2026-10" (en "Year_2026" / "12Months_…"). */
export function periodSlug(p: Period, lang: Language = getLanguage()): string {
  if (p.mode === "year") return `${tIn(lang, "review.file.year")}_${p.year}`;
  const a = p.months[0];
  const b = p.months[p.months.length - 1];
  return `${tIn(lang, "review.file.last12")}_${a.year}-${p2(a.month + 1)}_${b.year}-${p2(b.month + 1)}`;
}

/** "VectaSim_Jahr_2026_1-Ueberblick_hoch.png" / "VectaSim_Year_2026_1-Overview_portrait.png". */
export function reviewFileName(id: CardId, format: CardFormat, p: Period, lang: Language = getLanguage()): string {
  const i = CARDS.findIndex((c) => c.id === id);
  return `VectaSim_${periodSlug(p, lang)}_${i + 1}-${tIn(lang, `review.file.${id}`)}_${tIn(lang, `review.file.${format}`)}.png`;
}

/** "VectaSim_Jahr_2026_Stapel.png" / "VectaSim_Year_2026_Stack.png": every portrait card in one tall image. */
export const stackFileName = (p: Period, lang: Language = getLanguage()): string => `VectaSim_${periodSlug(p, lang)}_${tIn(lang, "review.file.stack")}.png`;

/** Hours as the big number: "1 234" from 100 h, else "12,5"; "0" without time. */
export function hoursNum(ms: number, lang: Language = getLanguage()): string {
  const h = ms / 3_600_000;
  if (h <= 0) return "0";
  return h >= 100 ? fmtNum(Math.round(h), 0, lang) : fmtNum(h, 1, lang);
}

/** "12 h 05 min" style, but rounded to whole hours from 100 h ("123 h"). */
export function hoursText(ms: number, lang: Language = getLanguage()): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h >= 100) return `${fmtNum(Math.round(ms / 3_600_000), 0, lang)}${NNBSP}h`;
  if (h === 0) return `${m}${NNBSP}min`;
  return `${h}${NNBSP}h${NNBSP}${p2(m)}${NNBSP}min`;
}

/** "1,8-mal um die Erde", "einmal um die Erde", "12 % einer Erdumrundung" ("1.8 times around the Earth"). */
export function earthText(laps: number, lang: Language = getLanguage()): string {
  if (!(laps > 0)) return tIn(lang, "review.earth.none");
  if (laps < 0.995) return tIn(lang, "review.earth.share", { percent: fmtNum(Math.max(1, Math.round(laps * 100)), 0, lang) });
  if (laps < 1.05) return tIn(lang, "review.earth.once");
  return tIn(lang, "review.earth.laps", { laps: fmtNum(laps, laps < 10 ? 1 : 0, lang) });
}

/** "1 Flug" / "3 Flüge". */
export const flightsLabel = (n: number, lang: Language = getLanguage()): string => tIn(lang, "count.flights", { count: n });
/** "1 Landung" / "3 Landungen". */
export const landingsWord = (n: number, lang: Language = getLanguage()): string => tIn(lang, "count.landings", { count: n });
/** "1 Anflug" / "3 Anflüge". */
export const approachesWord = (n: number, lang: Language = getLanguage()): string => tIn(lang, "review.count.approaches", { count: n });
/** "kein Durchstarten" / "1 Durchstarten" / "3 Durchstarts". */
export const goAroundsWord = (n: number, lang: Language = getLanguage()): string => (n === 0 ? tIn(lang, "review.count.noGoArounds") : tIn(lang, "review.count.goArounds", { count: n }));

/** 0.784 → "78". */
export const percentNum = (rate: number | null, lang: Language = getLanguage()): string => (rate == null ? "–" : fmtNum(Math.round(rate * 100), 0, lang));

/** Cut a text to `n` characters with an ellipsis. */
export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(1, n - 1)).trimEnd()}…` : s);
