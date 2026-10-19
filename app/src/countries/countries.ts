// "Länder" view: types of the backend commands (countries.rs) and the pure list logic –
// rows per country, continent filter, search, progress. Tests: countries.test.ts.
// Country names come from the backend list in German and English (countries.csv →
// nameDe/nameEn); the shown one follows the UI language (countryName).

import { LOCALE, getLanguage, tIn, type Language } from "../i18n";

export type ContinentCode = "AF" | "AN" | "AS" | "EU" | "NA" | "OC" | "SA";

/** `countries_list`: ISO 3166-1 (249 codes) plus Kosovo, sorted by code. */
export interface Country {
  iso2: string;
  continent: ContinentCode;
  nameDe: string;
  nameEn: string;
}

/** One country landed in (`visited_countries`). */
export interface CountryVisit {
  iso2: string;
  /** Flights that arrived in this country. */
  landings: number;
  firstMs: number;
  lastMs: number;
  airports: string[];
  /** Newest first. */
  flightIds: string[];
}

export interface VisitedAirport {
  ident: string;
  name: string;
  latitude: number;
  longitude: number;
  iso2: string;
  landings: number;
}

export interface VisitedCountries {
  countries: CountryVisit[];
  airports: VisitedAirport[];
  total: number;
}

/** Chip order of the continent filter. */
export const CONTINENTS: Array<{ code: ContinentCode }> = [{ code: "EU" }, { code: "AS" }, { code: "AF" }, { code: "NA" }, { code: "SA" }, { code: "OC" }, { code: "AN" }];

const isContinent = (c: string): c is ContinentCode => CONTINENTS.some((x) => x.code === c);

/** "Europa" / "Europe"; unknown codes as they are. */
export const continentLabel = (c: string, lang: Language = getLanguage()): string => (isContinent(c) ? tIn(lang, `countries.continent.${c}`) : c);

/** The country's name in the UI language (English falls back to German when the list has none). */
export const countryName = (c: Pick<Country, "nameDe" | "nameEn">, lang: Language = getLanguage()): string => (lang === "en" ? c.nameEn || c.nameDe : c.nameDe);

/** The name in the other language (secondary line, search hint). */
export const otherCountryName = (c: Pick<Country, "nameDe" | "nameEn">, lang: Language = getLanguage()): string => (lang === "en" ? c.nameDe : c.nameEn);

export interface CountryRow {
  country: Country;
  /** null = not landed in yet. */
  visit: CountryVisit | null;
}

/** One row per listed country, sorted by the name in `lang` (German by default); visits for unknown codes are dropped. */
export function buildRows(countries: Country[], visits: CountryVisit[], lang: Language = "de"): CountryRow[] {
  const byIso = new Map(visits.map((v) => [v.iso2, v]));
  return countries
    .map((country) => ({ country, visit: byIso.get(country.iso2) ?? null }))
    .sort((a, b) => countryName(a.country, lang).localeCompare(countryName(b.country, lang), LOCALE[lang]));
}

export type VisitFilter = "all" | "visited" | "open";

export interface RowFilter {
  /** null = every continent. */
  continent: ContinentCode | null;
  visit: VisitFilter;
  query: string;
}

export const NO_FILTER: RowFilter = { continent: null, visit: "all", query: "" };

/** Lower case without diacritics: "Österreich" ~ "osterreich", "Curaçao" ~ "curacao". */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export function matchesQuery(c: Country, query: string): boolean {
  const q = fold(query);
  if (!q) return true;
  if (q.length === 2 && c.iso2.toLowerCase() === q) return true;
  return fold(c.nameDe).includes(q) || fold(c.nameEn).includes(q);
}

export function filterRows(rows: CountryRow[], f: RowFilter): CountryRow[] {
  return rows.filter(
    (r) =>
      (f.continent == null || r.country.continent === f.continent) &&
      (f.visit === "all" || (f.visit === "visited") === (r.visit != null)) &&
      matchesQuery(r.country, f.query),
  );
}

export interface Progress {
  visited: number;
  total: number;
  /** 0…100, one decimal. */
  percent: number;
}

export function progressOf(rows: CountryRow[]): Progress {
  const visited = rows.filter((r) => r.visit).length;
  const total = rows.length;
  return { visited, total, percent: total ? Math.round((visited / total) * 1000) / 10 : 0 };
}

/** Progress per continent (chips "Europa 12 / 51"). */
export function continentProgress(rows: CountryRow[]): Map<ContinentCode, Progress> {
  const out = new Map<ContinentCode, Progress>();
  for (const { code } of CONTINENTS) out.set(code, progressOf(rows.filter((r) => r.country.continent === code)));
  return out;
}

/** "47 / 250" */
export const progressLabel = (p: Progress): string => `${p.visited} / ${p.total}`;

/** Landings in total and the most recent visit across all countries. */
export function visitSummary(visits: CountryVisit[]): { landings: number; lastMs: number | null; lastIso: string | null } {
  let landings = 0;
  let lastMs: number | null = null;
  let lastIso: string | null = null;
  for (const v of visits) {
    landings += v.landings;
    if (lastMs == null || v.lastMs > lastMs) {
      lastMs = v.lastMs;
      lastIso = v.iso2;
    }
  }
  return { landings, lastMs, lastIso };
}

/** "VectaSim_Laender_2026-10-18.png" / "VectaSim_Countries_2026-10-18.png" (local date). */
export function exportFileName(now: Date = new Date(), lang: Language = getLanguage()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `VectaSim_${tIn(lang, "countries.export.fileStem")}_${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.png`;
}

/** "1 Landung" / "3 Landungen" ("1 landing" / "3 landings"). */
export const landingsLabel = (n: number, lang: Language = getLanguage()): string => tIn(lang, "count.landings", { count: n });

/** Bounding box [[w, s], [e, n]] of a (Multi)Polygon; null for anything else. */
export function geometryBounds(g: GeoJSON.Geometry | null | undefined): [[number, number], [number, number]] | null {
  if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) return null;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const p of polys)
    for (const [x, y] of p[0] ?? []) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    }
  return Number.isFinite(w) ? [[w, s], [e, n]] : null;
}

/**
 * Globe zoom at which the sphere fills ~90 % of the smaller side of the map (MapLibre draws
 * the globe ≈ 512·2^z/π px wide), so it neither floats small in black nor gets cropped.
 */
export function globeZoomFor(width: number, height: number): number {
  const side = Math.min(width, height);
  if (!(side > 0)) return 1.9;
  return Math.min(3, Math.max(1, Math.log2((0.9 * side * Math.PI) / 512)));
}
