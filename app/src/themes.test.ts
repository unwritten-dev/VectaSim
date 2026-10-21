// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { DEFAULT_THEME, THEMES, activeTheme, applyTheme, contrastRatio, hexRgb, themeById, themeVars, type ThemeRoot } from "./themes";
import { getMapTheme, mapThemeOf } from "./theme";
import { getPrefs, loadPrefs, parsePrefs, setPref } from "./prefs";

function fakeRoot() {
  const vars = new Map<string, string>();
  const attrs = new Map<string, string>();
  const root: ThemeRoot & { vars: Map<string, string>; attrs: Map<string, string> } = {
    vars,
    attrs,
    setAttribute: (n, v) => void attrs.set(n, v),
    style: { setProperty: (n, v) => void vars.set(n, v), colorScheme: undefined },
  };
  return root;
}

/** Every "#rrggbb" in a theme (colours, ramp, map tint). */
function hexesOf(t: (typeof THEMES)[number]): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)) out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(t.colors);
  walk(t.ramp);
  walk(t.map);
  return out;
}

function hueSat(hex: string): [number, number] {
  const [r, g, b] = hexRgb(hex).map((x) => x / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return [0, 0];
  const s = d / (1 - Math.abs(max + min - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h < 0 ? h + 360 : h, s];
}

// ---- colour science for the band checks (sRGB → CIELAB D65, CIEDE2000, CVD simulation) ----

const toLinear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const toGamma = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** Machado, Oliveira & Fernandes 2009, severity 1.0 (dichromacy), applied in linear RGB. */
const CVD = {
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
};
type Vision = "normal" | keyof typeof CVD;

function rgbOf(hex: string, vision: Vision): [number, number, number] {
  const lin = hexRgb(hex).map(toLinear) as [number, number, number];
  if (vision === "normal") return lin;
  const m = CVD[vision];
  return m.map((row) => toLinear(toGamma(Math.min(1, Math.max(0, row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]))))) as [number, number, number];
}

function labOf(hex: string, vision: Vision = "normal"): [number, number, number] {
  const [r, g, b] = rgbOf(hex, vision);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000 colour difference. */
function deltaE(p: [number, number, number], q: [number, number, number]): number {
  const rad = Math.PI / 180;
  const [L1, a1, b1] = p;
  const [L2, a2, b2] = q;
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G);
  const a2p = a2 * (1 + G);
  const C1 = Math.hypot(a1p, b1);
  const C2 = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const h1 = hue(b1, a1p);
  const h2 = hue(b2, a2p);
  let dh = C1 * C2 === 0 ? 0 : h2 - h1;
  if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh * rad) / 2);
  const Lb = (L1 + L2) / 2;
  const Cb = (C1 + C2) / 2;
  let hb = h1 + h2;
  if (C1 * C2 !== 0) hb = Math.abs(h1 - h2) > 180 ? (hb < 360 ? (hb + 360) / 2 : (hb - 360) / 2) : hb / 2;
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const RC = 2 * Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7));
  const RT = -Math.sin(2 * 30 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad) * RC;
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const SC = 1 + 0.045 * Cb;
  const SH = 1 + 0.015 * Cb * T;
  const dL = (L2 - L1) / SL;
  const dC = (C2 - C1) / SC;
  const dHs = dH / SH;
  return Math.sqrt(dL ** 2 + dC ** 2 + dHs ** 2 + RT * dC * dHs);
}

/** Smallest CIEDE2000 difference of two colours for normal vision, deuteranopia and protanopia. */
const cvdDeltaE = (a: string, b: string) => Math.min(...(["normal", "deutan", "protan"] as const).map((v) => deltaE(labOf(a, v), labOf(b, v))));
const deltaL = (a: string, b: string) => Math.abs(labOf(a)[0] - labOf(b)[0]);

const BAND_KEYS = ["soft", "normal", "firm", "hard"] as const;

describe("landing-rate bands (4.7)", () => {
  it("every band reads on the canvas, the sheet and the runway fill (≥ 3:1)", () => {
    for (const t of THEMES)
      for (const k of BAND_KEYS)
        for (const bg of [t.colors.bg, t.colors.surface1, t.colors.surface3])
          expect(contrastRatio(t.colors.band[k], bg), `${t.id} ${k} on ${bg}`).toBeGreaterThanOrEqual(3);
  });

  it("bands differ pairwise: ≥ 3:1 or ΔL* ≥ 20, otherwise ΔE00 ≥ 25 – also for deuteranopia/protanopia", () => {
    // Four bands cannot all be 20 L* apart on a light canvas (3:1 leaves only L* ≈ 20–55),
    // so a pair may instead differ in hue – but only along the blue–yellow axis that red–green
    // colour-blind eyes keep: ΔE00 is taken as the minimum over normal, deutan and protan vision.
    for (const t of THEMES)
      for (let i = 0; i < BAND_KEYS.length; i++)
        for (let j = i + 1; j < BAND_KEYS.length; j++) {
          const a = t.colors.band[BAND_KEYS[i]];
          const b = t.colors.band[BAND_KEYS[j]];
          const id = `${t.id} ${BAND_KEYS[i]}/${BAND_KEYS[j]}`;
          const de = cvdDeltaE(a, b);
          expect(de, `${id} ΔE00 (worst vision)`).toBeGreaterThanOrEqual(15);
          expect(contrastRatio(a, b) >= 3 || deltaL(a, b) >= 20 || de >= 25, `${id}: contrast ${contrastRatio(a, b).toFixed(2)}, ΔL ${deltaL(a, b).toFixed(0)}, ΔE ${de.toFixed(0)}`).toBe(true);
        }
  });

  it("bands are tokens of their own (CSS variables) and the approach bands reuse them", () => {
    for (const t of THEMES) {
      const v = themeVars(t);
      expect(v["--band-soft"]).toBe(t.colors.band.soft);
      expect(v["--band-hard"]).toBe(t.colors.band.hard);
      expect(v["--aband-stable"]).toBe(t.colors.band.soft);
      expect(v["--aband-dev"]).toBe(t.colors.band.firm);
      expect(v["--aband-unstable"]).toBe(t.colors.band.hard);
    }
  });

  it("no band looks like the own aircraft", () => {
    for (const t of THEMES) for (const k of BAND_KEYS) expect(deltaE(labOf(t.colors.band[k]), labOf("#ffd54a")), `${t.id} ${k}`).toBeGreaterThanOrEqual(12);
  });
});

describe("semantic colours and track ramp (4.8)", () => {
  it("ok is its own colour, never the accent", () => {
    for (const t of THEMES) expect(deltaE(labOf(t.colors.ok), labOf(t.colors.accent)), t.id).toBeGreaterThanOrEqual(10);
  });

  it("warn/ok/info/err reach 4.5:1 on canvas, sheet and surface-2 in every theme", () => {
    for (const t of THEMES) {
      const grounds = [t.colors.bg, t.colors.surface1, t.colors.surface2];
      for (const k of ["warn", "ok", "info", "err"] as const)
        for (const bg of grounds) expect(contrastRatio(t.colors[k], bg), `${t.id} ${k} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the accent never doubles as the warning colour", () => {
    for (const t of THEMES) expect(deltaE(labOf(t.colors.warn), labOf(t.colors.accent)), t.id).toBeGreaterThanOrEqual(20);
  });

  it("warning and error stay apart (ΔE00 ≥ 15)", () => {
    for (const t of THEMES) expect(deltaE(labOf(t.colors.warn), labOf(t.colors.err)), t.id).toBeGreaterThanOrEqual(15);
  });

  it("the lowest step of the altitude ramp stands out from the basemap (≥ 3:1)", () => {
    for (const t of THEMES) expect(contrastRatio(t.ramp[0][1], t.map.land), t.id).toBeGreaterThanOrEqual(3);
  });

  it("the lowest ramp step also reads against its own casing (halo, map/common.ts)", () => {
    for (const t of THEMES) expect(contrastRatio(t.ramp[0][1], mapThemeOf(t).color.halo), t.id).toBeGreaterThanOrEqual(3);
  });

  it("the ramp is the colour the map paints with (theme.ts → TRACK_RAMP)", () => {
    for (const t of THEMES) expect(mapThemeOf(t).trackRamp).toEqual(t.ramp);
  });

  it("muted text (HUD labels) reaches 4.5:1 on the glass base colour", () => {
    for (const t of THEMES) expect(contrastRatio(t.colors.textMuted, t.colors.bg), t.id).toBeGreaterThanOrEqual(4.5);
  });
});

describe("information colours (M4: --text-faint never carries information)", () => {
  /** Text tokens that carry information, and the grounds they sit on (sheet, tile, nested tile). */
  const INFO_TEXT = ["text", "textMuted"] as const;

  it("every text token used for information reaches 4.5:1 on canvas, surface-1 and surface-2", () => {
    for (const t of THEMES)
      for (const k of INFO_TEXT)
        for (const bg of [t.colors.bg, t.colors.surface1, t.colors.surface2])
          expect(contrastRatio(t.colors[k], bg), `${t.id} ${k} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it("control states drawn in muted text (unselected rating stars) reach 3:1 on surface-3", () => {
    for (const t of THEMES) expect(contrastRatio(t.colors.textMuted, t.colors.surface3), t.id).toBeGreaterThanOrEqual(3);
  });

  it("--text-faint is below the text threshold – so it must stay decoration", () => {
    // documents why the CSS scan below exists: faint text would fail WCAG 1.4.3 in some theme
    expect(THEMES.some((t) => contrastRatio(t.colors.textFaint, t.colors.surface2) < 4.5)).toBe(true);
  });

  it("the CSS uses --text-faint as a text/fill colour only for decoration", () => {
    // `color:`/`fill:` with --text-faint, per selector; everything else (strokes, borders,
    // underlines) is decoration by construction. Disabled controls are exempt (WCAG 1.4.3).
    const DECORATION = new Set([".rwy-glyph-stripe", ".af-silhouette", 'button:not([class*="maplibregl"]):disabled']);
    const files = ["App.css", "flows.css", "a11y.css", "landing/trends.css", "landing/landing.css", "landing/dispersion.css", "landing/approachDispersion.css"];
    const offenders: string[] = [];
    for (const f of files) {
      const css = (readFileSync(new URL(`./${f}`, import.meta.url), "utf8") as string).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g) as IterableIterator<RegExpMatchArray>) {
        if (!/(^|[;\s])(color|fill)\s*:\s*var\(--text-faint/.test(m[2])) continue;
        const selectors = m[1].split(",").map((x) => x.trim());
        if (!selectors.some((x) => DECORATION.has(x))) offenders.push(`${f}: ${m[1].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
    // the three spots that used faint text for information read in muted text now
    const trends = readFileSync(new URL("./landing/trends.css", import.meta.url), "utf8");
    expect(trends).toMatch(/\.hist-n \{\s*color: var\(--text-muted\)/);
    expect(trends).toMatch(/\.tr-unit \{\s*fill: var\(--text-muted\)/);
    const flows = readFileSync(new URL("./flows.css", import.meta.url), "utf8");
    expect(flows).toMatch(/\.notes-editor button\.star \{[^}]*color: var\(--text-muted\)/);
  });
});

describe("themes", () => {
  it("has the six directions, Signal as default", () => {
    expect(THEMES.map((t) => t.id)).toEqual(["nachtcockpit", "graphit-amber", "papierkarte", "phosphor", "arktis-studio", "signal"]);
    expect(DEFAULT_THEME).toBe("signal");
    expect(themeById("nope").id).toBe("signal");
    expect(themeById(undefined).id).toBe("signal");
    expect(themeById("papierkarte").scheme).toBe("light");
    expect(themeById("arktis-studio").scheme).toBe("light");
  });

  it("text on surface-1 reaches at least 4.5:1 in every theme", () => {
    for (const t of THEMES) expect(contrastRatio(t.colors.text, t.colors.surface1), t.id).toBeGreaterThanOrEqual(4.5);
  });

  it("muted text stays readable (≥ 4.5:1 on surface-1) in every theme", () => {
    for (const t of THEMES) expect(contrastRatio(t.colors.textMuted, t.colors.surface1), t.id).toBeGreaterThanOrEqual(4.5);
  });

  it("uses no purple / violet / magenta anywhere (product rule)", () => {
    for (const t of THEMES)
      for (const hex of hexesOf(t)) {
        const [h, s] = hueSat(hex);
        const violet = h >= 250 && h <= 335 && s > 0.25;
        expect(violet, `${t.id}: ${hex} (hue ${Math.round(h)}°)`).toBe(false);
      }
  });

  it("keeps the own aircraft yellow in every theme", () => {
    for (const t of THEMES) {
      expect(themeVars(t)["--own-aircraft"]).toBe("#ffd54a");
    }
  });
});

describe("first paint", () => {
  it("App.css :root carries exactly the Signal tokens (default theme before JS runs)", () => {
    const css: string = readFileSync(new URL("./App.css", import.meta.url), "utf8");
    const root = css.slice(css.indexOf(":root {"), css.indexOf("\n}", css.indexOf(":root {")));
    const declared = new Map<string, string>();
    for (const m of root.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) declared.set(m[1], m[2].trim());
    for (const [k, v] of Object.entries(themeVars(themeById(DEFAULT_THEME)))) expect(declared.get(k), k).toBe(v);
  });
});

describe("applyTheme", () => {
  it("writes the CSS variables, data-theme and color-scheme", () => {
    const root = fakeRoot();
    applyTheme("signal", { root, loadFonts: false });
    expect(root.attrs.get("data-theme")).toBe("signal");
    expect(root.style.colorScheme).toBe("dark");
    expect(root.vars.get("--accent")).toBe("#a6f04a");
    expect(root.vars.get("--bg")).toBe("#0c0c0d");
    expect(root.vars.get("--font-num")).toMatch(/^"Geist Mono Variable"/);
    expect(activeTheme().id).toBe("signal");

    applyTheme("papierkarte", { root, loadFonts: false });
    expect(root.style.colorScheme).toBe("light");
    expect(root.vars.get("--surface-1")).toBe("#f8f4ea");
    expect(root.vars.get("--glass-blur")).toBe("none");
    expect(root.vars.get("--r-lg")).toBe("2px");
  });

  it("updates the map colours (theme.ts) with the theme", () => {
    applyTheme("papierkarte", { root: fakeRoot(), loadFonts: false });
    expect(getMapTheme().scheme).toBe("light");
    expect(getMapTheme().color.aircraftEdge).toBe("#1c2128");
    expect(getMapTheme().trackRamp[2][1]).toBe("#1d63a6");
    applyTheme("nachtcockpit", { root: fakeRoot(), loadFonts: false });
    expect(getMapTheme().color.accent).toBe("#5ab8f0");
  });
});

describe("theme preference", () => {
  beforeEach(() => invokeMock.mockReset());

  it("parses the stored theme and falls back to Signal", () => {
    expect(parsePrefs([["theme", "phosphor"]]).theme).toBe("phosphor");
    expect(parsePrefs([["theme", "unknown-theme"]]).theme).toBe("signal");
    expect(parsePrefs([]).theme).toBe("signal");
    expect(parsePrefs([["theme", "nachtcockpit"]]).theme).toBe("nachtcockpit");
  });

  it("persists a theme change in the backend settings and applies it", async () => {
    invokeMock.mockResolvedValue(undefined);
    await setPref("theme", "graphit-amber");
    expect(invokeMock).toHaveBeenCalledWith("set_setting", { key: "theme", value: "graphit-amber" });
    expect(getPrefs().theme).toBe("graphit-amber");
    expect(activeTheme().id).toBe("graphit-amber");
  });

  it("reverts when the backend cannot store it", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await setPref("theme", "signal");
    invokeMock.mockRejectedValueOnce(new Error("database is locked"));
    await expect(setPref("theme", "phosphor")).rejects.toThrow();
    expect(getPrefs().theme).toBe("signal");
    expect(activeTheme().id).toBe("signal");
  });

  it("loads the stored theme on start", async () => {
    invokeMock.mockResolvedValueOnce([["theme", "arktis-studio"]]);
    await loadPrefs();
    expect(activeTheme().id).toBe("arktis-studio");
  });
});
