// Display preferences stored in the backend `settings` table (get_settings / set_setting),
// shared app-wide through a tiny external store so every view re-renders on change.

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isWeightUnit, maskTitle, privacy, setPrivacyMode, setTimeLocal, setWeightUnit, type KnownSecrets, type PrivacyKind, type WeightUnit } from "./format";
import { showToast } from "./ui/Toast";
import { DEFAULT_THEME, applyTheme, isThemeId, type ThemeId } from "./themes";
import { DEFAULT_LANGUAGE_SETTING, getLanguageSetting, isLanguageSetting, setLanguageSetting, type LanguageSetting } from "./i18n/lang";

export interface Prefs {
  /** `time_local` = "1": clock times in local time instead of UTC ("z"). */
  timeLocal: boolean;
  /** `show_demo` = "1": include demo (mock) flights in totals, fleet and activities. */
  showDemo: boolean;
  /** `airframe_photos` ≠ "0": load aircraft photos from Planespotters.net (default on). */
  airframePhotos: boolean;
  /** `theme`: visual direction (themes.ts), default Signal. */
  theme: ThemeId;
  /** `simbrief_auto` ≠ "0": fetch the latest OFP at start and on connect (default on). */
  simbriefAuto: boolean;
  /** `weight_unit`: weights and fuel in "kg" (default) or "lb". */
  weightUnit: WeightUnit;
  /** `privacy_mode` = "1": Streamer-Modus – registrations, callsigns, airlines, SimBrief ID and user paths masked (display only). */
  privacyMode: boolean;
  /** `card_autosave` = "1": save the landing card PNG automatically after every landing (folder: `card_dir`, see get_card_dir). */
  cardAutosave: boolean;
  /** `card_hide_reg` = "1": landing card PNG without registration even outside the Streamer-Modus. */
  cardHideReg: boolean;
  /** `discord_presence` = "1": Discord Rich Presence (Einstellungen → Integrationen, default off). */
  discordPresence: boolean;
  /** `notifications` ≠ "0": Windows notifications while the window is not focused (default on). */
  notifications: boolean;
  /** `notify_landing` ≠ "0": … after a touchdown. */
  notifyLanding: boolean;
  /** `sim_text_landing` ≠ "0": the landing line inside MSFS after a touchdown (SimConnect_Text, default on). */
  simTextLanding: boolean;
  /** `notify_saved` ≠ "0": … when a flight was saved. */
  notifySaved: boolean;
  /** `notify_connection` ≠ "0": … when the sim link is lost / back during a flight. */
  notifyConnection: boolean;
  /** `notify_update` ≠ "0": … when an update is available. */
  notifyUpdate: boolean;
  /** `tray_minimize` ≠ "0": tray icon, minimising hides the window into the tray (default on; switch with `set_tray_enabled`). */
  trayMinimize: boolean;
  /** `tray_close` ≠ "0": with the tray icon, the close button hides the window there instead of quitting (default on). */
  trayClose: boolean;
  /** `language`: UI language "de" | "en" | "system" (default: follow Windows, else de; i18n/lang.ts). */
  language: LanguageSetting;
}

const KEYS: Record<keyof Prefs, string> = {
  timeLocal: "time_local",
  showDemo: "show_demo",
  airframePhotos: "airframe_photos",
  theme: "theme",
  simbriefAuto: "simbrief_auto",
  weightUnit: "weight_unit",
  privacyMode: "privacy_mode",
  cardAutosave: "card_autosave",
  cardHideReg: "card_hide_reg",
  discordPresence: "discord_presence",
  notifications: "notifications",
  notifyLanding: "notify_landing",
  simTextLanding: "sim_text_landing",
  notifySaved: "notify_saved",
  notifyConnection: "notify_connection",
  notifyUpdate: "notify_update",
  trayMinimize: "tray_minimize",
  trayClose: "tray_close",
  language: "language",
};
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

let prefs: Prefs = { timeLocal: false, showDemo: false, airframePhotos: true, theme: DEFAULT_THEME, simbriefAuto: true, weightUnit: "kg", privacyMode: false, cardAutosave: false, cardHideReg: false,
  discordPresence: false, notifications: true, notifyLanding: true, simTextLanding: true, notifySaved: true, notifyConnection: true, notifyUpdate: true, trayMinimize: true, trayClose: true,
  language: getLanguageSetting() };
let loaded = false;
const listeners = new Set<() => void>();

function publish(next: Prefs) {
  const themeChanged = next.theme !== prefs.theme;
  prefs = next;
  setTimeLocal(next.timeLocal);
  setWeightUnit(next.weightUnit);
  setPrivacyMode(next.privacyMode);
  if (next.language !== getLanguageSetting()) setLanguageSetting(next.language);
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
  const weight = value(KEYS.weightUnit);
  const language = value(KEYS.language);
  return {
    timeLocal: get(KEYS.timeLocal),
    showDemo: get(KEYS.showDemo),
    airframePhotos: value(KEYS.airframePhotos) !== "0",
    theme: isThemeId(theme) ? theme : DEFAULT_THEME,
    simbriefAuto: value(KEYS.simbriefAuto) !== "0",
    weightUnit: isWeightUnit(weight) ? weight : "kg",
    privacyMode: get(KEYS.privacyMode),
    cardAutosave: get(KEYS.cardAutosave),
    cardHideReg: get(KEYS.cardHideReg),
    discordPresence: get(KEYS.discordPresence),
    notifications: value(KEYS.notifications) !== "0",
    notifyLanding: value(KEYS.notifyLanding) !== "0",
    simTextLanding: value(KEYS.simTextLanding) !== "0",
    notifySaved: value(KEYS.notifySaved) !== "0",
    notifyConnection: value(KEYS.notifyConnection) !== "0",
    notifyUpdate: value(KEYS.notifyUpdate) !== "0",
    trayMinimize: value(KEYS.trayMinimize) !== "0",
    trayClose: value(KEYS.trayClose) !== "0",
    language: isLanguageSetting(language) ? language : DEFAULT_LANGUAGE_SETTING,
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

// ---- Streamer-Modus ---------------------------------------------------------------------

export interface Privacy {
  /** Streamer-Modus on. */
  on: boolean;
  /** One value as the UI shows it (format.ts → privacy). */
  mask: (value: string | null | undefined, kind: PrivacyKind) => string;
  /** A free text (aircraft title) with the known registration/airline/callsign masked (format.ts → maskTitle). */
  title: (text: string | null | undefined, known: KnownSecrets) => string;
}

/** The maskers bound to the current Streamer-Modus; re-renders the caller when it changes. */
export function usePrivacy(): Privacy {
  const { privacyMode: on } = usePrefs();
  return useMemo(
    () => ({
      on,
      mask: (value, kind) => privacy(value, kind, on),
      title: (text, known) => maskTitle(text, known, on),
    }),
    [on],
  );
}

/** Toggles the Streamer-Modus and says so in a short toast (Strg+Umschalt+P, Einstellungen). */
export async function togglePrivacyMode(on: boolean = !prefs.privacyMode): Promise<void> {
  try {
    await setPref("privacyMode", on);
    showToast({
      id: "privacy-mode",
      tone: "info",
      title: on ? "Streamer-Modus an" : "Streamer-Modus aus",
      body: on ? "Kennzeichen, Rufzeichen, Airline, SimBrief-ID und Benutzerpfade sind ausgeblendet." : "Alle Angaben werden wieder vollständig angezeigt.",
      durationMs: 3000,
    });
  } catch (e) {
    showToast({ id: "privacy-mode", tone: "warn", title: "Streamer-Modus nicht umgeschaltet", body: String(e), durationMs: 5000 });
  }
}

/** True for Strg+Umschalt+P (not AltGr, not with Alt/Meta). */
export function isPrivacyShortcut(e: Pick<KeyboardEvent, "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "code" | "key">): boolean {
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.code === "KeyP" || e.key.toLowerCase() === "p");
}

/** Global Strg+Umschalt+P; mounted once by an always-present component (ui/StatusButton). */
export function usePrivacyShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPrivacyShortcut(e) || e.repeat) return;
      e.preventDefault();
      void togglePrivacyMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

// ---- in-app zoom (Ctrl+Plus/Minus/0, Einstellungen → Anzeige) ---------------------------
// A per-machine convenience like the window geometry, so localStorage rather than the
// backend settings table: the factor is applied before the stored prefs arrive.

/** Steps of Ctrl+Plus/Minus; 1 = 100 %. */
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;
const ZOOM_KEY = "vectasim.zoom";
let zoom = 1;
const zoomListeners = new Set<() => void>();

function nearestStep(f: number): number {
  return ZOOM_STEPS.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a), 1 as number);
}

async function applyZoom(f: number) {
  try {
    await getCurrentWebview().setZoom(f);
  } catch {
    // browser preview without Tauri (or no permission): the browser's own zoom still works
  }
}

/** Restores the stored zoom factor (App start). */
export function initZoom() {
  try {
    const raw = Number(localStorage.getItem(ZOOM_KEY));
    zoom = raw > 0 ? nearestStep(raw) : 1;
  } catch {
    zoom = 1;
  }
  if (zoom !== 1) void applyZoom(zoom);
  zoomListeners.forEach((l) => l());
}

export function getZoom(): number {
  return zoom;
}

/** Sets the zoom to the nearest step and remembers it. */
export function setZoom(f: number) {
  zoom = nearestStep(f);
  void applyZoom(zoom);
  try {
    localStorage.setItem(ZOOM_KEY, String(zoom));
  } catch {
    /* storage unavailable: the zoom still holds for this session */
  }
  zoomListeners.forEach((l) => l());
}

/** One step bigger (+1) or smaller (−1). */
export function stepZoom(dir: 1 | -1) {
  const i = ZOOM_STEPS.indexOf(zoom as (typeof ZOOM_STEPS)[number]);
  const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (i < 0 ? 2 : i) + dir))];
  setZoom(next);
}

const subscribeZoom = (l: () => void) => {
  zoomListeners.add(l);
  return () => zoomListeners.delete(l);
};

export function useZoom(): number {
  return useSyncExternalStore(subscribeZoom, getZoom);
}
