// The translation core: key lookup, fallback, plural and placeholders. Pure (no React), so it
// is tested directly and shared by useT() and the plain t().
//
// Resources are nested JSON objects; a key is the dotted path ("nav.map"). A leaf is either a
// string or a plural object { "one": "…", "other": "…" } (Intl.PluralRules categories, `other`
// is required) selected by the `count` variable. Placeholders are `{name}`: numbers are
// formatted for the language (fmtNum, 0 digits – pass decimals and units pre-formatted as a
// string), strings are inserted as they are. A missing variable stays visible as `{name}`.
// Lookup order: active language → de (reference) → the key itself.

import de from "./de";
import { FALLBACK_LANGUAGE, LOCALE, type Language } from "./lang";
import { fmtNum } from "./number";

export type Messages = typeof de;

const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];
export type PluralForms = { other: string } & Partial<Record<Exclude<PluralCategory, "other">, string>>;

/** Dotted paths to every string or plural leaf. */
type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : T[K] extends { other: string } ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
/** Dotted paths to the plural leaves only (they need `count`). */
type PluralLeaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? never : T[K] extends { other: string } ? `${P}${K}` : PluralLeaves<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Every valid key, derived from the German resources (de/*.json): a typo or a removed key is a tsc error. */
export type TKey = Leaves<Messages>;
export type PluralKey = PluralLeaves<Messages>;
export type Vars = Record<string, string | number>;
export type PluralVars = Vars & { count: number };
/** `t("count.flights", { count: 3 })` requires count; `t("nav.map")` takes optional vars. */
export type TArgs<K extends TKey> = K extends PluralKey ? [vars: PluralVars] : [vars?: Vars];
export type TFunction = <K extends TKey>(key: K, ...args: TArgs<K>) => string;

type Node = string | PluralForms | { [k: string]: Node };
export type Resources = Record<Language, Node>;

export function isPluralForms(n: unknown): n is PluralForms {
  if (!n || typeof n !== "object") return false;
  const keys = Object.keys(n);
  return typeof (n as { other?: unknown }).other === "string" && keys.every((k) => (PLURAL_CATEGORIES as readonly string[]).includes(k));
}

function lookup(tree: Node | undefined, key: string): string | PluralForms | undefined {
  let node: Node | undefined = tree;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object" || isPluralForms(node)) return undefined;
    node = (node as Record<string, Node>)[part];
  }
  return typeof node === "string" || isPluralForms(node) ? node : undefined;
}

const pluralRules = new Map<Language, Intl.PluralRules>();
function pluralCategory(lang: Language, count: number): PluralCategory {
  let rules = pluralRules.get(lang);
  if (!rules) {
    rules = new Intl.PluralRules(LOCALE[lang]);
    pluralRules.set(lang, rules);
  }
  return rules.select(count) as PluralCategory;
}

function interpolate(text: string, vars: Vars | undefined, lang: Language): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars[name];
    if (v === undefined) return whole;
    return typeof v === "number" ? fmtNum(v, 0, lang) : v;
  });
}

/** Missing keys are reported once per key and language in development. */
const reported = new Set<string>();
function reportMissing(lang: Language, key: string) {
  const id = `${lang}:${key}`;
  if (reported.has(id)) return;
  reported.add(id);
  if (import.meta.env?.DEV) console.warn(`[i18n] missing key "${key}" for ${lang}`);
}

export function translate(resources: Resources, lang: Language, key: string, vars?: Vars): string {
  let entry = lookup(resources[lang], key);
  let used = lang;
  if (entry === undefined && lang !== FALLBACK_LANGUAGE) {
    reportMissing(lang, key);
    entry = lookup(resources[FALLBACK_LANGUAGE], key);
    used = FALLBACK_LANGUAGE;
  }
  if (entry === undefined) {
    reportMissing(FALLBACK_LANGUAGE, key);
    return key;
  }
  if (typeof entry === "string") return interpolate(entry, vars, used);
  const count = typeof vars?.count === "number" ? vars.count : Number.NaN;
  const form = Number.isFinite(count) ? (entry[pluralCategory(used, count)] ?? entry.other) : entry.other;
  return interpolate(form, vars, used);
}
