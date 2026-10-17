// Display preferences stored in the backend `settings` table (get_settings / set_setting),
// shared app-wide through a tiny external store so every view re-renders on change.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { setTimeLocal } from "./format";
import { DEFAULT_THEME, applyTheme, isThemeId, type ThemeId } from "./themes";

export interface Prefs {
  /** `time_local` = "1": clock times in local time instead of UTC ("z"). */
  timeLocal: boolean;
  /** `show_demo` = "1": include demo (mock) flights in totals, fleet and activities. */
  showDemo: boolean;
  /** `airframe_photos` ≠ "0": load aircraft photos from Planespotters.net (default on). */
  airframePhotos: boolean;
  /** `theme`: visual direction (themes.ts), default Signal. */
  theme: ThemeId;
}

const KEYS: Record<keyof Prefs, string> = { timeLocal: "time_local", showDemo: "show_demo", airframePhotos: "airframe_photos", theme: "theme" };
/** Last theme also in localStorage, so the first paint after a restart is already right. */
const THEME_CACHE_KEY = "vectasim.theme";

function cachedTheme(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_CACHE_KEY);
    return isThemeId(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

let prefs: Prefs = { timeLocal: false, showDemo: false, airframePhotos: true, theme: DEFAULT_THEME };
let loaded = false;
const listeners = new Set<() => void>();

function publish(next: Prefs) {
  const themeChanged = next.theme !== prefs.theme;
  prefs = next;
  setTimeLocal(next.timeLocal);
  if (themeChanged) {
    applyTheme(next.theme);
    try {
      localStorage.setItem(THEME_CACHE_KEY, next.theme);
    } catch {
      /* storage unavailable: the backend setting still holds it */
    }
  }
  listeners.forEach((l) => l());
}

/** Applies the cached theme before anything renders (main.tsx). */
export function initTheme() {
  const t = cachedTheme();
  prefs = { ...prefs, theme: t };
  applyTheme(t);
}

function serialize<K extends keyof Prefs>(value: Prefs[K]): string {
  return typeof value === "boolean" ? (value ? "1" : "0") : String(value);
}

export function parsePrefs(rows: [string, string][]): Prefs {
  const value = (k: string) => rows.find(([key]) => key === k)?.[1];
  const get = (k: string) => value(k) === "1";
  const theme = value(KEYS.theme);
  return {
    timeLocal: get(KEYS.timeLocal),
    showDemo: get(KEYS.showDemo),
    airframePhotos: value(KEYS.airframePhotos) !== "0",
    theme: isThemeId(theme) ? theme : DEFAULT_THEME,
  };
}

export function loadPrefs(): Promise<void> {
  return invoke<[string, string][]>("get_settings").then((rows) => {
    loaded = true;
    publish(parsePrefs(rows));
  });
}

/** Optimistic update; reverts and rethrows if the backend could not store it. */
export async function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<void> {
  const before = prefs;
  publish({ ...prefs, [key]: value });
  try {
    await invoke("set_setting", { key: KEYS[key], value: serialize(value) });
  } catch (e) {
    publish(before);
    throw e;
  }
}

export function getPrefs(): Prefs {
  return prefs;
}

export function prefsLoaded(): boolean {
  return loaded;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getPrefs);
}
