// Pure helpers for airframes (one aircraft per registration). Mirrors the store's
// rules in crates/vectasim-store/src/airframe.rs, see airframe.test.ts.

import type { Airframe } from "../types";
import { maskRegistration, maskTitle } from "../format";
import { t } from "../i18n";

const PLACEHOLDER_IDS = new Set(["ASXGS", "ASOBO", "N12345", "NONE", "UNKNOWN", "TEST", "XXXX", "XXXXX", "ABC", "ABCD", "ABCDE"]);

/** Upper case without spaces, or null when it is no plausible registration (same rule as the store). */
export function normalizeRegistration(raw: string | null | undefined): string | null {
  const reg = (raw ?? "").replace(/\s+/g, "").toUpperCase();
  if (reg.length < 3 || reg.length > 8) return null;
  if (!/^[A-Z0-9-]+$/.test(reg)) return null;
  if (reg.startsWith("-") || reg.endsWith("-") || reg.includes("--")) return null;
  if (!/[A-Z]/.test(reg)) return null;
  if (PLACEHOLDER_IDS.has(reg.replace(/-/g, ""))) return null;
  return reg;
}

/** Planespotters cache rules (crates/vectasim-photos): hit 7 days, miss 24 h, picked image forever. */
export const PHOTO_HIT_TTL_MS = 7 * 24 * 3600 * 1000;
export const PHOTO_MISS_TTL_MS = 24 * 3600 * 1000;

/** Whether the UI should ask the backend for a (new) photo of this airframe. */
export function needsPhotoLookup(a: Pick<Airframe, "imageSource" | "imageFetchedMs">, nowMs: number): boolean {
  if (a.imageSource === "user") return false;
  if (a.imageFetchedMs == null) return true;
  const age = nowMs - a.imageFetchedMs;
  if (a.imageSource === "planespotters") return age >= PHOTO_HIT_TTL_MS;
  if (a.imageSource === "none") return age >= PHOTO_MISS_TTL_MS;
  return true;
}

/** Headline name: the user's name, else airline + type, else the sim title, else the registration. */
export function airframeName(a: Pick<Airframe, "registration" | "customName" | "title" | "airline" | "icaoType">): string {
  if (a.customName?.trim()) return a.customName.trim();
  if (a.title?.trim()) return a.title.trim();
  const combo = [a.airline, a.icaoType].filter((s) => s?.trim()).join(" ");
  return combo || a.registration;
}

/** airframeName for display: in the Streamer-Modus (`hide`) without registration and airline. */
export function shownAirframeName(a: Pick<Airframe, "registration" | "customName" | "title" | "airline" | "icaoType">, hide: boolean): string {
  const name = airframeName(a);
  if (!hide) return name;
  if (name === a.registration) return maskRegistration(name);
  return maskTitle(name, { registration: a.registration, airline: a.airline }, true);
}

/** Credit line for the photo; Planespotters requires photographer + source. */
export function photoCredit(a: Pick<Airframe, "imageSource" | "imageCredit">): string | null {
  if (a.imageSource === "planespotters") return a.imageCredit ? `© ${a.imageCredit} · Planespotters.net` : "© Planespotters.net";
  if (a.imageSource === "user") return a.imageCredit || t("logbook.airframe.ownImage");
  return null;
}

/** Search over registration, name, type and airline for the picker / fleet filter. */
export function matchesAirframe(a: Pick<Airframe, "registration" | "customName" | "title" | "airline" | "icaoType">, query: string): boolean {
  const q = query.trim().toUpperCase().replace(/\s+/g, " ");
  if (!q) return true;
  const compact = q.replace(/[\s-]/g, "");
  if (a.registration.replace(/-/g, "").includes(compact)) return true;
  return [a.customName, a.title, a.airline, a.icaoType].some((s) => s && s.toUpperCase().includes(q));
}

/**
 * Picker options: existing airframes matching the query, plus "new registration" when the
 * query is a valid registration that does not exist yet.
 */
export function pickerOptions<T extends Pick<Airframe, "registration" | "customName" | "title" | "airline" | "icaoType">>(
  all: T[],
  query: string,
  limit = 8,
): { matches: T[]; newReg: string | null } {
  const matches = all.filter((a) => matchesAirframe(a, query)).slice(0, limit);
  const reg = normalizeRegistration(query);
  const newReg = reg && !all.some((a) => a.registration === reg) ? reg : null;
  return { matches, newReg };
}

/** Plausible Vapp range (kt); the backend refuses values outside it. */
export const VAPP_MIN_KT = 40;
export const VAPP_MAX_KT = 250;

/** Highest landing flap handle index the backend accepts (`LANDING_FLAPS_MAX`). */
export const LANDING_FLAPS_MAX = 10;

/** Landing flaps field → handle index; null = empty (the last handle position), undefined = not a whole number 0…10. */
export function parseLandingFlaps(raw: string): number | null | undefined {
  const t = raw.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return undefined;
  const v = Number(t);
  return v <= LANDING_FLAPS_MAX ? v : undefined;
}

/** Vapp field → knots; null = empty (use the flown value), undefined = not a plausible number. */
export function parseVapp(raw: string): number | null | undefined {
  const t = raw.trim().replace(",", ".");
  if (!t) return null;
  const v = Number(t);
  if (!Number.isFinite(v) || v < VAPP_MIN_KT || v > VAPP_MAX_KT) return undefined;
  return Math.round(v);
}
