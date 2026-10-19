// Six switchable visual directions. One source: applyTheme() writes every token as a
// CSS variable on <html> (App.css :root keeps the Signal defaults and structure)
// and publishes the map colours for MapLibre/SVG via getMapTheme() (theme.ts).
//
// Product rules for every theme: own aircraft yellow #ffd54a (light themes with an ink
// outline), no purple / violet / magenta / indigo anywhere (product rule).

import { useSyncExternalStore } from "react";
import { t } from "./i18n";

export type ThemeId = "nachtcockpit" | "graphit-amber" | "papierkarte" | "phosphor" | "arktis-studio" | "signal";
/** Default direction; App.css :root carries the same tokens for the first paint. */
export const DEFAULT_THEME: ThemeId = "signal";

export interface ThemeColors {
  bg: string;
  sidebar: string;
  surface1: string;
  surface2: string;
  surface3: string;
  hairline: string;
  hairlineStrong: string;
  /** Opaque line colour (tables, controls); ink on Papierkarte. */
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentHover: string;
  accentSoft: string;
  onAccent: string;
  ok: string;
  warn: string;
  err: string;
  /** Demo flight / neutral hints. */
  info: string;
  /** Planned OFP route (dashed). */
  route: string;
  /** Overlay background over the map (glass when the theme has glass, opaque otherwise). */
  glass: string;
  /**
   * Other (VATSIM/IVAO) traffic: a muted blue-grey per theme, the cool opposite of the own
   * aircraft yellow, so the own plane is found at a busy hub. Never purple.
   * aircraftIcons.trafficColorsOf() lifts it to 3:1 / 4.5:1 on the map land colour.
   */
  traffic: string;
  /** Outline of the own aircraft: dark halo on dark themes, ink on light ones. */
  aircraftEdge: string;
  /**
   * Landing-rate bands (sanft/normal/fest/hart), an ordered scale of their own – never
   * borrowed from accent/ok/warn. Dark themes: turquoise · pale lime · amber · red-orange;
   * light themes: teal · navy ink · amber-brown · deep red. Each pair differs by ≥ 20 L* or
   * by the blue–yellow axis that deuteranopes/protanopes keep (checked in themes.test.ts);
   * the scatter plots add a shape per band on top (facts.ts BAND_SHAPE).
   * Approach bands reuse them: stabil = soft, Abweichungen = firm, instabil = hard.
   */
  band: { soft: string; normal: string; firm: string; hard: string };
}

export interface ThemeMapTint {
  land: string;
  water: string;
  /** null = no fill (Phosphor draws outlines only). */
  park: string | null;
  motorway: string;
  major: string;
  minor: string;
  label: string;
  labelStrong: string;
  rwy: string;
  /** Aprons / aerodrome areas of the basemap. */
  apron: string;
  apt: string;
  aptSmall: string;
  /** Taxiway centrelines of the airport diagram (zoom ≥ 13). */
  taxiway: string;
  /** Optional graticule (1° grid) over the land. */
  grid?: string;
  boundary: string;
}

export interface ThemeShape {
  rXs: number;
  rSm: number;
  rMd: number;
  rLg: number;
  /** Translucent blurred overlays over the map (HUD, toolbar, toast). */
  glass: boolean;
  /** Group lines: alpha hairlines, or opaque 1-px rules. */
  lines: "hairline" | "rule";
  /** Floating shadow under popovers/overlays. */
  shadow: boolean;
  /** Small labels in caps (kickers, HUD labels). */
  caps: boolean;
  /** Letter spacing of caps labels (em). */
  capsSpacing: number;
}

export interface ThemeDef {
  id: ThemeId;
  name: string;
  mood: string;
  scheme: "dark" | "light";
  colors: ThemeColors;
  /** Altitude ramp of the flown track: [ft MSL, colour]. */
  ramp: Array<[number, string]>;
  map: ThemeMapTint;
  shape: ThemeShape;
  fonts: { sans: string; num: string; label: string };
}

export const OWN_AIRCRAFT = "#ffd54a";

export const THEMES: ThemeDef[] = [
  {
    id: "nachtcockpit",
    name: "Nachtcockpit",
    mood: "Gedimmtes Cockpit bei Nacht: bläuliche Neutraltöne, ein ruhiges Cyan, Haarlinien statt Kästen.",
    scheme: "dark",
    colors: {
      bg: "#0a0d11",
      sidebar: "#0a0d11",
      surface1: "#0f1318",
      surface2: "#151a21",
      surface3: "#1b212a",
      hairline: "rgba(200, 220, 255, 0.07)",
      hairlineStrong: "rgba(200, 220, 255, 0.12)",
      border: "#1f262f",
      borderStrong: "#2a323d",
      text: "#e7ebf0",
      textMuted: "#939eac",
      textFaint: "#5a6472",
      accent: "#5ab8f0",
      accentHover: "#7cc8f5",
      accentSoft: "rgba(90, 184, 240, 0.14)",
      onAccent: "#06121b",
      ok: "#3ccf91",
      warn: "#f2a93b",
      err: "#f0585e",
      info: "#3fb8af",
      route: "#aab6c4",
      glass: "rgba(14, 18, 24, 0.72)",
      traffic: "#7f98b2",
      aircraftEdge: "#0a0d11",
      band: { soft: "#4fd2dc", normal: "#d6f58a", firm: "#e8922a", hard: "#cc3a26" },
    },
    ramp: [
      [0, "#3f8fc0"],
      [5000, "#55aee0"],
      [15000, "#5ab8f0"],
      [30000, "#9ad4f7"],
      [40000, "#dff2ff"],
    ],
    map: {
      land: "#0b0f14",
      water: "#0d1822",
      park: "#0e1513",
      motorway: "#262d37",
      major: "#1c222a",
      minor: "#141920",
      label: "#56606d",
      labelStrong: "#7d8896",
      rwy: "#4a5563",
      apron: "#121820",
      apt: "#c3ccd7",
      aptSmall: "#8994a3",
      taxiway: "#b89a4a",
      boundary: "#3a4452",
    },
    shape: { rXs: 4, rSm: 6, rMd: 10, rLg: 12, glass: true, lines: "hairline", shadow: true, caps: true, capsSpacing: 0.06 },
    fonts: { sans: '"Inter Variable"', num: '"Geist Mono Variable"', label: "Inter Variable + Geist Mono" },
  },
  {
    id: "graphit-amber",
    name: "Graphit & Amber",
    mood: "Warmes Overhead-Panel bei Nacht: Graphit wie lackiertes Blech, Beschriftung in Amber, Werte in Warmweiß.",
    scheme: "dark",
    colors: {
      bg: "#110f0d",
      sidebar: "#0d0b0a",
      surface1: "#171513",
      surface2: "#1f1c19",
      surface3: "#282420",
      hairline: "rgba(255, 225, 190, 0.08)",
      hairlineStrong: "rgba(255, 225, 190, 0.15)",
      border: "#2c2723",
      borderStrong: "#3a342e",
      text: "#efe7dc",
      textMuted: "#a89d8f",
      textFaint: "#6c635a",
      accent: "#f0a04b",
      accentHover: "#f5b56e",
      accentSoft: "rgba(240, 160, 75, 0.14)",
      onAccent: "#1a0f04",
      ok: "#9bc76a",
      // red-orange, so the warning never reads as the amber accent (ΔE00 ≥ 20, themes.test.ts)
      warn: "#ff571a",
      err: "#ed5e6d",
      info: "#c9b48a",
      route: "#7fc4d4",
      glass: "rgba(23, 21, 19, 0.95)",
      traffic: "#8ea2b6",
      aircraftEdge: "#0d0b0a",
      band: { soft: "#4fd2dc", normal: "#d6f58a", firm: "#f08a2c", hard: "#cc3a26" },
    },
    ramp: [
      [0, "#b07a3a"],
      [5000, "#cf9a4e"],
      [15000, "#e2bb7a"],
      [30000, "#d9cdbf"],
      [40000, "#fff6ea"],
    ],
    map: {
      land: "#0f0d0c",
      water: "#14171a",
      park: "#13140f",
      motorway: "#2a2520",
      major: "#201c18",
      minor: "#181512",
      label: "#62584e",
      labelStrong: "#8c8073",
      rwy: "#5a5047",
      apron: "#191613",
      apt: "#d6cbbd",
      aptSmall: "#8f8478",
      taxiway: "#8f8478",
      boundary: "#3e3730",
    },
    shape: { rXs: 2, rSm: 3, rMd: 3, rLg: 4, glass: false, lines: "rule", shadow: true, caps: true, capsSpacing: 0.1 },
    fonts: { sans: '"IBM Plex Sans Condensed"', num: '"IBM Plex Mono"', label: "IBM Plex Sans Condensed + Plex Mono" },
  },
  {
    id: "papierkarte",
    name: "Papierkarte",
    mood: "Anflugkarte auf dem Kniebrett: cremefarbenes Papier, schwarze Tusche, Kartenblau – für Tageslicht.",
    scheme: "light",
    colors: {
      bg: "#efe9db",
      sidebar: "#e7e0cf",
      surface1: "#f8f4ea",
      surface2: "#ece5d4",
      surface3: "#e1d8c3",
      hairline: "rgba(40, 34, 20, 0.16)",
      hairlineStrong: "rgba(40, 34, 20, 0.32)",
      border: "#1c2128",
      borderStrong: "#1c2128",
      text: "#1c2128",
      textMuted: "#545a61",
      textFaint: "#8b8a82",
      accent: "#1d63a6",
      accentHover: "#164f86",
      accentSoft: "rgba(29, 99, 166, 0.12)",
      onAccent: "#ffffff",
      ok: "#226b3d",
      warn: "#9a5200",
      err: "#a82c25",
      info: "#6a5b39",
      route: "#1c2128",
      glass: "rgba(248, 244, 234, 0.97)",
      traffic: "#5c7891",
      aircraftEdge: "#1c2128",
      band: { soft: "#0b8188", normal: "#1f3d63", firm: "#b56500", hard: "#851812" },
    },
    ramp: [
      [0, "#4a87bb"],
      [5000, "#3576b4"],
      [15000, "#1d63a6"],
      [30000, "#16477a"],
      [40000, "#0c2a4a"],
    ],
    map: {
      land: "#f1ebdc",
      water: "#c9dce6",
      park: "#dfe5cc",
      motorway: "#d8cba8",
      major: "#d9ceb3",
      minor: "#e4dbc6",
      label: "#6b6a62",
      labelStrong: "#2e3238",
      rwy: "#2e3238",
      apron: "#e2dac6",
      apt: "#1c2128",
      aptSmall: "#545a61",
      taxiway: "#8b8a82",
      grid: "rgba(29, 99, 166, 0.22)",
      boundary: "#8b8a82",
    },
    shape: { rXs: 1, rSm: 2, rMd: 2, rLg: 2, glass: false, lines: "rule", shadow: false, caps: true, capsSpacing: 0.08 },
    fonts: { sans: '"Atkinson Hyperlegible Next Variable"', num: '"Atkinson Hyperlegible Mono Variable"', label: "Atkinson Hyperlegible Next + Mono" },
  },
  {
    id: "phosphor",
    name: "Phosphor",
    mood: "Monochromes Instrument: grüner Phosphor auf Schwarz, Hierarchie nur über Helligkeit, Gelb als einzige zweite Farbe.",
    scheme: "dark",
    colors: {
      bg: "#040706",
      sidebar: "#040706",
      surface1: "#07100c",
      surface2: "#0b1711",
      surface3: "#102018",
      hairline: "rgba(110, 240, 160, 0.12)",
      hairlineStrong: "rgba(110, 240, 160, 0.24)",
      border: "#1a3325",
      borderStrong: "#2a5039",
      text: "#b4f5cc",
      textMuted: "#6fb88c",
      textFaint: "#3a7053",
      accent: "#6af2a0",
      accentHover: "#93f0b8",
      accentSoft: "rgba(106, 242, 160, 0.12)",
      onAccent: "#031208",
      ok: "#b8f06a",
      warn: "#f2a93b",
      err: "#ff5c4d",
      info: "#6fb88c",
      route: "#6fb88c",
      glass: "rgba(4, 7, 6, 0.93)",
      traffic: "#7ea4b6",
      aircraftEdge: "#040706",
      band: { soft: "#4fd2dc", normal: "#d6f58a", firm: "#e8922a", hard: "#cc3a26" },
    },
    ramp: [
      [0, "#3b9a68"],
      [5000, "#49b87c"],
      [15000, "#4cc57f"],
      [30000, "#93f0b8"],
      [40000, "#e2ffee"],
    ],
    map: {
      land: "#040706",
      water: "#06140e",
      park: null,
      motorway: "#1e4030",
      major: "#163322",
      minor: "#0d2117",
      label: "#3a7053",
      labelStrong: "#5aa07a",
      rwy: "#5aa07a",
      apron: "#0a1a12",
      apt: "#8fe0b0",
      aptSmall: "#3f7c5c",
      taxiway: "#3f7c5c",
      grid: "rgba(110, 240, 160, 0.07)",
      boundary: "#1e4030",
    },
    shape: { rXs: 0, rSm: 0, rMd: 0, rLg: 0, glass: false, lines: "rule", shadow: false, caps: true, capsSpacing: 0.12 },
    fonts: { sans: '"B612"', num: '"B612 Mono"', label: "B612 + B612 Mono" },
  },
  {
    id: "arktis-studio",
    name: "Arktis Studio",
    mood: "Kühles Studiolicht: helles Grau, weiße Blätter, tiefes Petrolblau und große, ruhige Typografie.",
    scheme: "light",
    colors: {
      bg: "#e9edf1",
      sidebar: "#e9edf1",
      surface1: "#ffffff",
      surface2: "#f3f5f8",
      surface3: "#dfe5eb",
      hairline: "rgba(15, 30, 45, 0.10)",
      hairlineStrong: "rgba(15, 30, 45, 0.20)",
      border: "#d3dae1",
      borderStrong: "#b9c3cd",
      text: "#0e1620",
      textMuted: "#4f5d6b",
      textFaint: "#8794a1",
      accent: "#0b4f74",
      accentHover: "#0e6593",
      accentSoft: "rgba(11, 79, 116, 0.10)",
      onAccent: "#ffffff",
      ok: "#17694a",
      warn: "#9a5c00",
      err: "#b02a33",
      info: "#5b6672",
      route: "#0e1620",
      glass: "rgba(255, 255, 255, 0.97)",
      traffic: "#5a7286",
      aircraftEdge: "#0e1620",
      band: { soft: "#0b8188", normal: "#26364f", firm: "#b56500", hard: "#871a10" },
    },
    ramp: [
      [0, "#4a85a8"],
      [5000, "#2f6c92"],
      [15000, "#0b4f74"],
      [30000, "#083850"],
      [40000, "#04202f"],
    ],
    map: {
      land: "#e4e8ec",
      water: "#c6d5e0",
      park: "#d9e2dc",
      motorway: "#ffffff",
      major: "#f6f8fa",
      minor: "#eef1f4",
      label: "#7d8995",
      labelStrong: "#26323e",
      rwy: "#5b6773",
      apron: "#d6dce2",
      apt: "#0e1620",
      aptSmall: "#5b6773",
      taxiway: "#8794a1",
      boundary: "#a7b2bd",
    },
    shape: { rXs: 2, rSm: 4, rMd: 4, rLg: 6, glass: false, lines: "hairline", shadow: false, caps: true, capsSpacing: 0.1 },
    fonts: { sans: '"Inter Tight Variable"', num: '"Inter Tight Variable"', label: "Inter Tight (tabellarische Ziffern)" },
  },
  {
    id: "signal",
    name: "Signal",
    mood: "Reduzierte Telemetrie: unbuntes Graphit, Versal-Mikrolabels und genau ein Signalgrün, wo gerade etwas passiert; der Track in kühlem Cyan.",
    scheme: "dark",
    colors: {
      bg: "#0c0c0d",
      sidebar: "#0c0c0d",
      surface1: "#131314",
      surface2: "#1a1a1c",
      surface3: "#222225",
      hairline: "rgba(255, 255, 255, 0.08)",
      hairlineStrong: "rgba(255, 255, 255, 0.14)",
      border: "#222225",
      borderStrong: "#2e2e31",
      text: "#ececec",
      textMuted: "#9a9a9c",
      textFaint: "#5e5e61",
      accent: "#a6f04a",
      accentHover: "#bdf57a",
      accentSoft: "rgba(166, 240, 74, 0.12)",
      onAccent: "#0c1402",
      ok: "#3ccf91",
      warn: "#f2a93b",
      err: "#ff5a52",
      info: "#9a9a9c",
      route: "#d0d0d2",
      glass: "rgba(12, 12, 13, 0.88)",
      traffic: "#86a0b9",
      aircraftEdge: "#0c0c0d",
      band: { soft: "#4fd2dc", normal: "#d6f58a", firm: "#e8922a", hard: "#cc3a26" },
    },
    ramp: [
      [0, "#3a9ec4"],
      [5000, "#5bc0e6"],
      [15000, "#8fdaf4"],
      [30000, "#c4ecfa"],
      [40000, "#eefaff"],
    ],
    map: {
      land: "#0e0e0f",
      water: "#141618",
      park: "#111312",
      motorway: "#2a2a2c",
      major: "#1d1d1f",
      minor: "#161617",
      label: "#58585b",
      labelStrong: "#8a8a8d",
      rwy: "#6a6a6e",
      apron: "#161618",
      apt: "#d0d0d2",
      aptSmall: "#7a7a7d",
      taxiway: "#8a8a8d",
      boundary: "#3a3a3d",
    },
    shape: { rXs: 1, rSm: 2, rMd: 2, rLg: 3, glass: true, lines: "hairline", shadow: true, caps: true, capsSpacing: 0.14 },
    fonts: { sans: '"Geist Variable"', num: '"Geist Mono Variable"', label: "Geist + Geist Mono" },
  },
];

// Name, mood and the Arktis font note follow the UI language (i18n landing.json → themes.<id>);
// the ids stay the stored setting values.
for (const th of THEMES) {
  Object.defineProperty(th, "name", { get: () => t(`themes.${th.id}.name`), enumerable: true, configurable: true });
  Object.defineProperty(th, "mood", { get: () => t(`themes.${th.id}.mood`), enumerable: true, configurable: true });
  if (th.id === "arktis-studio") Object.defineProperty(th.fonts, "label", { get: () => t("themes.arktis-studio.fonts"), enumerable: true, configurable: true });
}

export function themeById(id: string | null | undefined): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;
}

export function isThemeId(id: string | null | undefined): id is ThemeId {
  return THEMES.some((t) => t.id === id);
}

const SANS_FALLBACK = '"Segoe UI Variable", system-ui, sans-serif';
const NUM_FALLBACK = '"Cascadia Mono", Consolas, monospace';

/** Every CSS custom property a theme sets on <html> (pure; see themes.test.ts). */
export function themeVars(t: ThemeDef): Record<string, string> {
  const c = t.colors;
  const s = t.shape;
  return {
    "--bg": c.bg,
    "--bg-sidebar": c.sidebar,
    "--surface-1": c.surface1,
    "--surface-2": c.surface2,
    "--surface-3": c.surface3,
    "--hairline": s.lines === "rule" ? c.hairlineStrong : c.hairline,
    "--hairline-strong": c.hairlineStrong,
    "--border": c.border,
    "--border-strong": c.borderStrong,
    "--text": c.text,
    "--text-muted": c.textMuted,
    "--text-faint": c.textFaint,
    "--accent": c.accent,
    "--accent-hover": c.accentHover,
    "--accent-soft": c.accentSoft,
    "--on-accent": c.onAccent,
    "--ok": c.ok,
    "--warn": c.warn,
    "--err": c.err,
    "--info": c.info,
    "--band-soft": c.band.soft,
    "--band-normal": c.band.normal,
    "--band-firm": c.band.firm,
    "--band-hard": c.band.hard,
    "--aband-stable": c.band.soft,
    "--aband-dev": c.band.firm,
    "--aband-unstable": c.band.hard,
    "--route": c.route,
    "--own-aircraft": OWN_AIRCRAFT,
    // logo trace: fixed brand cyan per scheme (docs/brand/README.md), not the theme accent
    "--brand-trace": t.scheme === "dark" ? "#5ab8f0" : "#1f86c4",
    "--glass": c.glass,
    "--overlay": c.glass,
    "--glass-blur": s.glass ? "blur(16px) saturate(140%)" : "none",
    "--glass-edge": s.glass ? "inset 0 1px 0 rgba(255, 255, 255, 0.05)" : "0 0 0 0 transparent",
    "--shadow-float": s.shadow ? (t.scheme === "dark" ? "0 12px 32px -8px rgba(0, 0, 0, 0.55)" : "0 8px 24px -8px rgba(20, 30, 40, 0.18)") : "0 0 0 1px var(--hairline-strong)",
    "--r-xs": `${s.rXs}px`,
    "--r-sm": `${s.rSm}px`,
    "--r-md": `${s.rMd}px`,
    "--r-lg": `${s.rLg}px`,
    "--attrib-icon-filter": t.scheme === "dark" ? "invert(0.8)" : "none",
    "--map-icon-filter": t.scheme === "dark" ? "invert(0.86) hue-rotate(180deg)" : "none",
    "--label-case": s.caps ? "uppercase" : "none",
    "--label-ls": `${s.capsSpacing}em`,
    "--font-sans": `${t.fonts.sans}, ${SANS_FALLBACK}`,
    "--font-num": `${t.fonts.num}, ${NUM_FALLBACK}`,
  };
}

/** Fonts beyond the bundled default pair load on demand, the first time a theme is used. */
const FONT_LOADERS: Record<ThemeId, () => Promise<unknown>> = {
  // Geist Variable + Geist Mono Variable (default Signal) are imported in main.tsx
  nachtcockpit: () => import("@fontsource-variable/inter/opsz.css"),
  "graphit-amber": () =>
    Promise.all([
      import("@fontsource/ibm-plex-sans-condensed/400.css"),
      import("@fontsource/ibm-plex-sans-condensed/500.css"),
      import("@fontsource/ibm-plex-sans-condensed/600.css"),
      import("@fontsource/ibm-plex-mono/400.css"),
      import("@fontsource/ibm-plex-mono/500.css"),
    ]),
  papierkarte: () =>
    Promise.all([import("@fontsource-variable/atkinson-hyperlegible-next/index.css"), import("@fontsource-variable/atkinson-hyperlegible-mono/index.css")]),
  phosphor: () =>
    Promise.all([import("@fontsource/b612/400.css"), import("@fontsource/b612/700.css"), import("@fontsource/b612-mono/400.css"), import("@fontsource/b612-mono/700.css")]),
  "arktis-studio": () => import("@fontsource-variable/inter-tight/index.css"),
  signal: () => Promise.resolve(),
};

let active: ThemeDef = themeById(DEFAULT_THEME);
const listeners = new Set<() => void>();

export function activeTheme(): ThemeDef {
  return active;
}

export function subscribeTheme(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Re-renders a component when the theme changes (SVG charts with theme colours). */
export function useThemeId(): ThemeId {
  return useSyncExternalStore(subscribeTheme, () => active.id);
}

/** The part of the DOM applyTheme touches (an object in tests). */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  style: { setProperty(name: string, value: string): void; colorScheme?: string };
}

/**
 * Activates a theme: CSS variables + `data-theme` + `color-scheme` on <html>, lazy font
 * load, then `theme:changed` (window event) and the subscribers (maps, charts).
 */
export function applyTheme(id: string | null | undefined, opts: { root?: ThemeRoot; loadFonts?: boolean } = {}): ThemeDef {
  const t = themeById(id);
  const root = opts.root ?? (typeof document !== "undefined" ? (document.documentElement as unknown as ThemeRoot) : null);
  if (root) {
    for (const [k, v] of Object.entries(themeVars(t))) root.style.setProperty(k, v);
    root.style.colorScheme = t.scheme;
    root.setAttribute("data-theme", t.id);
  }
  if (opts.loadFonts !== false) FONT_LOADERS[t.id]().catch(() => {
    /* font chunk missing: the fallback stack in --font-sans / --font-num renders */
  });
  const changed = t.id !== active.id;
  active = t;
  if (changed) {
    listeners.forEach((l) => l());
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new CustomEvent("theme:changed", { detail: t.id }));
  }
  return t;
}

// ---- contrast (WCAG 2.x), used by the tests and available for checks -------------------

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** "#rrggbb" → [r, g, b]. */
export function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = hexRgb(hex);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(bl);
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Linear mix of two hex colours (t = 0 → a, 1 → b). */
export function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexRgb(a);
  const [r2, g2, b2] = hexRgb(b);
  const m = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${m(r1, r2)}${m(g1, g2)}${m(b1, b2)}`;
}
