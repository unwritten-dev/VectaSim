// i18n entry point: `useT()` in components, `t()` in plain code.
//
//   const t = useT();                       // re-renders when the language changes
//   <span>{t("nav.map")}</span>
//   t("count.flights", { count: n })        // plural via Intl.PluralRules, count required
//   import { t } from "./i18n";             // toasts, errors.ts, stores: current language
//
// Keys are typed from de/*.json (TKey); en/*.json must have the same shape (checked by tsc below
// and by `npm run i18n:check`). The language comes from the `language` setting (lang.ts).
// Flight phases are NOT translated (product decision, format.ts → PHASE_LABEL).

import { createContext, createElement, useCallback, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import de from "./de";
import enJson from "./en";
import { getLanguage, subscribeLanguage, type Language } from "./lang";
import { translate, type Messages, type Resources, type TArgs, type TFunction, type TKey, type Vars } from "./translate";

export * from "./lang";
export type { Messages, PluralKey, TArgs, TFunction, TKey, Vars } from "./translate";

/** English resources typed against the German reference: a missing key or plural form fails tsc. */
const en: Messages = enJson;
export const RESOURCES: Resources = { de, en };

/** Translate in the active language (outside React, or in event handlers). */
export const t: TFunction = (key, ...args) => translate(RESOURCES, getLanguage(), key, args[0] as Vars | undefined);

/** Translate in an explicit language (landing card export, tests). */
export function tIn<K extends TKey>(lang: Language, key: K, ...args: TArgs<K>): string {
  return translate(RESOURCES, lang, key, args[0] as Vars | undefined);
}

/** null = no provider above: follow the global language. */
const LanguageContext = createContext<Language | null>(null);

/**
 * Root provider (main.tsx). Follows the `language` setting and keeps `<html lang>` in sync.
 * `lang` pins a subtree to one language (e.g. a preview of the other language, tests).
 */
export function I18nProvider({ lang, children }: { lang?: Language; children?: ReactNode }) {
  const global = useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
  const active = lang ?? global;
  useEffect(() => {
    if (!lang) document.documentElement.lang = active;
  }, [lang, active]);
  return createElement(LanguageContext.Provider, { value: active }, children);
}

/** The active language for this component (provider pin, else the setting). */
export function useLanguage(): Language {
  const pinned = useContext(LanguageContext);
  const global = useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
  return pinned ?? global;
}

/** `t` bound to the component's language; stable until the language changes. */
export function useT(): TFunction {
  const lang = useLanguage();
  return useCallback<TFunction>((key, ...args) => translate(RESOURCES, lang, key, args[0] as Vars | undefined), [lang]);
}

/** Column-header label for the active time base: "UTC" or "Ortszeit" / "Local time". */
export function timeBaseLabel(local: boolean, lang: Language = getLanguage()): string {
  return translate(RESOURCES, lang, local ? "time.local" : "time.utc");
}
