// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { DEFAULT_THEME, THEMES, activeTheme, applyTheme, contrastRatio, hexRgb, themeById, themeVars, type ThemeRoot } from "./themes";
import { getMapTheme } from "./theme";
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
