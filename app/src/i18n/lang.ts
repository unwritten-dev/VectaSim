// Active UI language. Pure module without React or Tauri imports, so
// prefs.ts, format code and plain functions can use it without import cycles.
//
// The setting `language` ("de" | "en" | "system", default "system") lives in the backend
// settings table like every other pref; prefs.ts calls setLanguageSetting on every publish.
// "system" follows the Windows display language (WebView2 reports it as navigator.language);
// anything that is neither German nor English falls back to German.

/** Languages with a resource file (de/*.json is the reference, en/*.json the translation). */
export const LANGUAGES = ["de", "en"] as const;
export type Language = (typeof LANGUAGES)[number];
/** What the user picks in Einstellungen; "system" = follow Windows. */
export type LanguageSetting = Language | "system";

export const DEFAULT_LANGUAGE_SETTING: LanguageSetting = "system";
/** Used when the system language is neither de nor en, and for missing keys. */
export const FALLBACK_LANGUAGE: Language = "de";

/** BCP 47 tag per language, for Intl.PluralRules and friends. */
export const LOCALE: Record<Language, string> = { de: "de-DE", en: "en-GB" };

export function isLanguage(v: unknown): v is Language {
  return typeof v === "string" && (LANGUAGES as readonly string[]).includes(v);
}

export function isLanguageSetting(v: unknown): v is LanguageSetting {
  return v === "system" || isLanguage(v);
}

/** "de-AT" → "de", "en-US" → "en", "fr-FR" → null. */
export function languageOfTag(tag: string | null | undefined): Language | null {
  const base = (tag ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return isLanguage(base) ? base : null;
}

/** The language "system" stands for: the first supported entry of the preferred list, else de. */
export function systemLanguage(preferred: readonly string[] = navigatorLanguages()): Language {
  for (const tag of preferred) {
    const l = languageOfTag(tag);
    if (l) return l;
  }
  return FALLBACK_LANGUAGE;
}

/** Setting → concrete language. */
export function resolveLanguage(setting: LanguageSetting, preferred?: readonly string[]): Language {
  return setting === "system" ? systemLanguage(preferred) : setting;
}

function navigatorLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  // only the first entry: navigator.languages also lists the browser's extra languages,
  // which in WebView2 can be "en-US" on a German Windows
  return navigator.language ? [navigator.language] : [];
}

// ---- store ---------------------------------------------------------------------------
// Last choice also in localStorage (like the theme), so the first paint after a restart is
// already in the right language before the backend settings arrive.

const CACHE_KEY = "vectasim.language";

function cachedSetting(): LanguageSetting {
  try {
    const v = localStorage.getItem(CACHE_KEY);
    return isLanguageSetting(v) ? v : DEFAULT_LANGUAGE_SETTING;
  } catch {
    return DEFAULT_LANGUAGE_SETTING;
  }
}

let setting: LanguageSetting = cachedSetting();
let language: Language = resolveLanguage(setting);
const listeners = new Set<() => void>();

/** The active language. */
export function getLanguage(): Language {
  return language;
}

/** The stored setting (may be "system"). */
export function getLanguageSetting(): LanguageSetting {
  return setting;
}

/** Applies a setting (prefs.ts on every publish; tests). Notifies subscribers only on a change. */
export function setLanguageSetting(next: LanguageSetting, preferred?: readonly string[]) {
  const before = language;
  setting = next;
  language = resolveLanguage(next, preferred);
  try {
    localStorage.setItem(CACHE_KEY, next);
  } catch {
    /* storage unavailable: the backend setting still holds it */
  }
  if (typeof document !== "undefined") document.documentElement.lang = language;
  if (language !== before) listeners.forEach((l) => l());
}

export function subscribeLanguage(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
