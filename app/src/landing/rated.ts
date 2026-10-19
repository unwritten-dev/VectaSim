// Unrated touchdowns (core touchdown.rs LandingRateSource::Unrated): slewed or fast-forwarded
// down to the ground, no airborne sample before the contact and no sim value. Their
// `landingRateFpm` is the V/S of that moment (≈ 0) – no landing rate: never shown as "0 fpm",
// never a "perfect" landing in bands, rankings, trends or averages.

import { getLanguage, tIn, type Language } from "../i18n";
import { fmt } from "../i18n/number";
import type { LandingRateSource } from "../types";

type RateSourced = { landingRateSource?: LandingRateSource | string | null };

/** The touchdown has a landing rate that may be shown and counted. */
export const isRated = (td: RateSourced): boolean => td.landingRateSource !== "unrated";

/** "−142 fpm", or "nicht bewertbar" / "unrated" for an unrated touchdown. */
export function rateText(td: RateSourced & { landingRateFpm: number }, lang: Language = getLanguage()): string {
  return isRated(td) ? fmt(td.landingRateFpm, 0, "fpm", lang) : tIn(lang, "band.unrated");
}

/** The rate for averages, ranges and charts: null for an unrated touchdown. */
export const ratedFpm = (td: RateSourced & { landingRateFpm: number }): number | null => (isRated(td) ? td.landingRateFpm : null);
