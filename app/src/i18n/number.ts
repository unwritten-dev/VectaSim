// Language-aware number, unit, duration and date formatting.
//
// Drop-in for the numeric helpers of format.ts: same names, same parameters, plus an optional
// trailing `lang` (default: the active language, lang.ts). With lang "de" every function
// returns exactly what format.ts returns today (golden tests in number.test.ts), so the
// migration can swap `from "./format"` for `from "./i18n/number"` file by file.
//
//              de                    en
//   grouping   narrow NBSP "1 500"   comma "1,500"
//   decimal    comma "1,25"          point "1.25"
//   minus      U+2212 "−155"         hyphen-minus "-155"
//   unit gap   narrow NBSP "412 kt"  narrow NBSP "412 kt" (same; °, ×, ′, ″ stay glued)
//   date       "17.10.2026"          "17 Oct 2026" (day-month-year, no US/UK ambiguity)
//   clock      "14:30z" / "16:30"    same (24 h, UTC with "z" or local, time_local setting)
//   durations  "1 h 05 min"          same (SI-style unit symbols)
// Flight levels ("FL350"), ICAO/METAR tokens and the placeholder "–" are language-neutral.
// Hand-rolled rather than Intl.NumberFormat: ICU's de-DE groups with "." (not the narrow
// space this app uses) and rounds/signs zero differently between ICU versions.

import { DASH, MINUS, NNBSP, TRANSITION_ALTITUDE_FT, fmtClock, fmtPressure, getWeightUnit, isTimeLocal, weightIn, type WeightUnit } from "../format";
import type { Metar, Wind } from "../types";
import { getLanguage, type Language } from "./lang";

export { DASH, MINUS, NNBSP, fmtClock };

interface Separators {
  group: string;
  decimal: string;
  minus: string;
}

export const SEPARATORS: Record<Language, Separators> = {
  de: { group: NNBSP, decimal: ",", minus: MINUS },
  en: { group: ",", decimal: ".", minus: "-" },
};

const isNum = (n: number | undefined | null): n is number => typeof n === "number" && Number.isFinite(n);

/** de "61 959", "1,25", "−1 800"; en "61,959", "1.25", "-1,800". */
export function fmtNum(n: number | undefined | null, digits = 0, lang: Language = getLanguage()): string {
  if (!isNum(n)) return DASH;
  const sep = SEPARATORS[lang];
  const fixed = Math.abs(n).toFixed(digits);
  // -0 and values that round to zero lose their sign
  const negative = n < 0 && Number(fixed) !== 0;
  const [int, frac] = fixed.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, sep.group);
  return `${negative ? sep.minus : ""}${grouped}${frac ? `${sep.decimal}${frac}` : ""}`;
}

/** Units glued to the number without a gap. */
const TIGHT_UNITS = new Set(["°", "×", "′", "″"]);

function withUnit(value: string, unit: string): string {
  const u = unit.trim();
  if (!u) return value;
  return TIGHT_UNITS.has(u[0]) ? `${value}${u}` : `${value}${NNBSP}${u}`;
}

/** Number with optional unit: de "61 959 kg", en "61,959 kg". */
export function fmt(n: number | undefined | null, digits = 0, unit = "", lang: Language = getLanguage()): string {
  if (!isNum(n)) return DASH;
  return withUnit(fmtNum(n, digits, lang), unit);
}

/** Always signed: de "+4 260 fpm", "−112 fpm", "±0 fpm"; en "+4,260 fpm", "-112 fpm". */
export function fmtSigned(n: number | undefined | null, digits = 0, unit = "", lang: Language = getLanguage()): string {
  if (!isNum(n)) return DASH;
  const body = fmtNum(Math.abs(n), digits, lang);
  const zero = Number(Math.abs(n).toFixed(digits)) === 0;
  return withUnit(`${zero ? "±" : n > 0 ? "+" : SEPARATORS[lang].minus}${body}`, unit);
}

// ---- durations -----------------------------------------------------------------------

/** "43 s", "7 min 43 s", "1 h 05 min", de "1 234 h 05 min" / en "1,234 h 05 min". */
export function fmtDuration(ms: number | undefined | null, opts: { seconds?: boolean } = {}, lang: Language = getLanguage()): string {
  if (!isNum(ms) || ms < 0) return DASH;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${fmtNum(h, 0, lang)}${NNBSP}h${NNBSP}${String(m).padStart(2, "0")}${NNBSP}min`;
  if (opts.seconds === false) return `${m}${NNBSP}min`;
  if (m > 0) return `${m}${NNBSP}min${NNBSP}${String(s).padStart(2, "0")}${NNBSP}s`;
  return `${s}${NNBSP}s`;
}

/** Signed minutes delta (actual minus planned): "+7 min", de "−12 min" / en "-12 min", "±0 min". */
export function fmtDeltaMin(actualMs: number | null | undefined, plannedMs: number | null | undefined, lang: Language = getLanguage()): string {
  if (!isNum(actualMs) || !isNum(plannedMs)) return DASH;
  const d = Math.round((actualMs - plannedMs) / 60000);
  const sign = d > 0 ? "+" : d < 0 ? SEPARATORS[lang].minus : "±";
  const a = Math.abs(d);
  const body = a >= 60 ? `${Math.floor(a / 60)}${NNBSP}h${NNBSP}${String(a % 60).padStart(2, "0")}${NNBSP}min` : `${a}${NNBSP}min`;
  return `${sign}${body}`;
}

// ---- weights (unit from the weight_unit setting, see format.ts) ----------------------

export function fmtWeightNum(kg: number | undefined | null, unit: WeightUnit = getWeightUnit(), lang: Language = getLanguage()): string {
  return fmtNum(weightIn(kg, unit), 0, lang);
}

export function fmtWeight(kg: number | undefined | null, unit: WeightUnit = getWeightUnit(), lang: Language = getLanguage()): string {
  return fmt(weightIn(kg, unit), 0, unit, lang);
}

export function fmtDeltaKg(actual: number | null | undefined, planned: number | null | undefined, unit: WeightUnit = getWeightUnit(), lang: Language = getLanguage()): string {
  if (!isNum(actual) || !isNum(planned)) return DASH;
  return fmtSigned(Math.round(weightIn(actual - planned, unit) ?? 0), 0, unit, lang);
}

// ---- date (clock times are language-neutral: fmtClock from format.ts) -----------------

const p2 = (n: number) => String(n).padStart(2, "0");
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** de "17.10.2026", en "17 Oct 2026"; UTC or local time like fmtClock (`time_local` setting). */
export function fmtDate(ms: number | undefined | null, opts: { local?: boolean; lang?: Language } = {}): string {
  if (!isNum(ms) || ms <= 0) return DASH;
  const local = opts.local ?? isTimeLocal();
  const lang = opts.lang ?? getLanguage();
  const d = new Date(ms);
  const day = local ? d.getDate() : d.getUTCDate();
  const month = local ? d.getMonth() : d.getUTCMonth();
  const year = local ? d.getFullYear() : d.getUTCFullYear();
  return lang === "en" ? `${day} ${MONTHS_EN[month]} ${year}` : `${p2(day)}.${p2(month + 1)}.${year}`;
}

/** de "17.10.2026 14:30z", en "17 Oct 2026 14:30z". */
export function fmtDateTime(ms: number | undefined | null, opts: { local?: boolean; lang?: Language } = {}): string {
  if (!isNum(ms) || ms <= 0) return DASH;
  return `${fmtDate(ms, opts)} ${fmtClock(ms, { local: opts.local })}`;
}

// ---- geo -----------------------------------------------------------------------------

/** de "50,033° N 8,570° E", en "50.033° N 8.570° E" (hemisphere letters are ICAO, not translated). */
export function fmtCoord(lat: number | null | undefined, lon: number | null | undefined, digits = 3, lang: Language = getLanguage()): string {
  if (!isNum(lat) || !isNum(lon)) return DASH;
  return `${fmtNum(Math.abs(lat), digits, lang)}° ${lat >= 0 ? "N" : "S"} ${fmtNum(Math.abs(lon), digits, lang)}° ${lon >= 0 ? "E" : "W"}`;
}

/** "FL350" above the transition altitude, else de "4 500 ft" / en "4,500 ft". */
export function fmtAltitude(ft: number | null | undefined, transitionAltitudeFt = TRANSITION_ALTITUDE_FT, lang: Language = getLanguage()): string {
  if (!isNum(ft)) return DASH;
  return ft > transitionAltitudeFt ? `FL${String(Math.round(ft / 100)).padStart(3, "0")}` : fmt(Math.round(ft), 0, "ft", lang);
}

// ---- weather (format.ts keeps the German-only originals for not yet migrated callers) ----
// The few weather words live here (like MONTHS_EN) instead of the JSON resources: number.ts
// sits below translate.ts in the import graph and must not import it.

const WEATHER_WORDS: Record<Language, { calm: string; wind: string; visibility: string; ceiling: string }> = {
  de: { calm: "Windstill", wind: "Wind", visibility: "Sicht", ceiling: "Wolkenbasis" },
  en: { calm: "Calm", wind: "Wind", visibility: "Vis", ceiling: "Ceiling" },
};

/** "270° 12G20 kt (240–300°)", "VRB 3 kt", de "Windstill" / en "Calm", "Wind –". */
export function fmtWind(w: Wind | null | undefined, lang: Language = getLanguage()): string {
  const words = WEATHER_WORDS[lang];
  if (!w) return `${words.wind} ${DASH}`;
  if (w.speedKt === 0) return words.calm;
  const dir = w.directionDeg == null ? "VRB" : `${String(w.directionDeg).padStart(3, "0")}°`;
  const gust = w.gustKt ? `G${w.gustKt}` : "";
  const variable = w.variableFromDeg != null && w.variableToDeg != null ? ` (${w.variableFromDeg}–${w.variableToDeg}°)` : "";
  return `${dir} ${w.speedKt}${gust}${NNBSP}kt${variable}`;
}

/** "CAVOK", "≥ 10 km", "6 km", de "800 m"; no value: de "Sicht –" / en "Vis –". */
export function fmtVisibility(m: Metar, lang: Language = getLanguage()): string {
  if (m.cavok) return "CAVOK";
  const v = m.visibilityM;
  if (v == null) return `${WEATHER_WORDS[lang].visibility} ${DASH}`;
  if (v >= 10000) return `≥${NNBSP}10${NNBSP}km`;
  if (v >= 5000) return fmt(v / 1000, 0, "km", lang);
  return fmt(v, 0, "m", lang);
}

/** One-line METAR summary: wind · visibility · QNH · temp/dew · ceiling. */
export function fmtMetarLine(m: Metar, lang: Language = getLanguage()): string {
  const parts = [fmtWind(m.wind, lang), fmtVisibility(m, lang), fmtPressure(m)];
  if (m.temperatureC != null) parts.push(`${fmtNum(m.temperatureC, 0, lang)}/${m.dewpointC != null ? fmtNum(m.dewpointC, 0, lang) : DASH}${NNBSP}°C`);
  if (m.ceilingFt != null) parts.push(`${WEATHER_WORDS[lang].ceiling} ${fmt(m.ceilingFt, 0, "ft", lang)}`);
  return parts.join(" · ");
}
