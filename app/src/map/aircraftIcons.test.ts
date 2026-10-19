import { describe, expect, it } from "vitest";
import { ensureContrast, icaoFromAtcModel, trafficColorsOf, wakeCategory } from "./aircraftIcons";
import { OWN_AIRCRAFT, THEMES, contrastRatio } from "../themes";

describe("wakeCategory", () => {
  it("classifies by ICAO designator first", () => {
    expect(wakeCategory("A388")).toBe("super");
    expect(wakeCategory("B77W")).toBe("heavy");
    expect(wakeCategory("A20N")).toBe("medium");
    expect(wakeCategory("C172")).toBe("light");
    expect(wakeCategory("pa28")).toBe("light");
  });

  it("follows ICAO MTOM classes for light turboprops/jets, C-130, UH-60 (ICAO Doc 8643 wake categories)", () => {
    for (const c of ["TBM9", "PC12", "C208", "DHC6", "DHC2", "BE20", "B350", "E50P", "C525", "C25A", "C25B", "PRM1"]) expect(wakeCategory(c), c).toBe("light");
    expect(wakeCategory("C130")).toBe("medium");
    expect(wakeCategory("C30J")).toBe("medium");
    expect(wakeCategory("H60")).toBe("medium");
    expect(wakeCategory("B738")).toBe("medium");
  });

  it("title keywords: Concorde heavy, light turboprops light, Hercules medium", () => {
    expect(wakeCategory(null, "Aerospatiale/BAC Concorde")).toBe("heavy");
    expect(wakeCategory(null, "Daher TBM 930")).toBe("light");
    expect(wakeCategory(null, "Pilatus PC-12 NGX")).toBe("light");
    expect(wakeCategory(null, "Cessna 208B Grand Caravan EX")).toBe("light");
    expect(wakeCategory(null, "Beechcraft King Air 350i")).toBe("light");
    expect(wakeCategory(null, "Cirrus Vision Jet SF50")).toBe("light");
    expect(wakeCategory(null, "Lockheed C-130 Hercules")).toBe("medium");
    expect(wakeCategory(null, "Embraer Phenom 300")).toBe("medium");
  });

  it("falls back to title keywords", () => {
    expect(wakeCategory("", "Airbus A380-800 Lufthansa")).toBe("super");
    expect(wakeCategory(undefined, "Boeing 747-8i")).toBe("heavy");
    expect(wakeCategory(null, "Mock Airlines A320neo")).toBe("medium");
    expect(wakeCategory(null, "Cessna Skyhawk G1000")).toBe("light");
  });

  it("uses weight when nothing else is known", () => {
    expect(wakeCategory("", "", 1_100)).toBe("light");
    expect(wakeCategory("", "", 62_000)).toBe("medium");
    expect(wakeCategory("", "", 250_000)).toBe("heavy");
    expect(wakeCategory("", "", null)).toBe("medium");
  });

  it("parses MSFS ATC MODEL tokens", () => {
    expect(icaoFromAtcModel("TT:ATCCOM.AC_MODEL_A20N.0.text")).toBe("A20N");
    expect(icaoFromAtcModel("$$:B738")).toBe("B738");
    expect(icaoFromAtcModel("A320neo")).toBe("");
    expect(icaoFromAtcModel(null)).toBe("");
    expect(wakeCategory(icaoFromAtcModel("TT:ATCCOM.AC_MODEL_B748.0.text"))).toBe("heavy");
  });
});

describe("trafficColorsOf", () => {
  it("light themes: labels >= 4.5:1 and symbols >= 3:1 on the land colour", () => {
    for (const t of THEMES.filter((x) => x.scheme === "light")) {
      const c = trafficColorsOf(t);
      expect(contrastRatio(c.label, t.map.land), t.id).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.ivaoLabel, t.map.land), t.id).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.fill, t.map.land), t.id).toBeGreaterThanOrEqual(3);
      // still distinct from the own aircraft yellow
      expect(c.fill.toLowerCase()).not.toBe(OWN_AIRCRAFT);
    }
  });

  it("dark themes: readable on the land colour, and dark-theme tokens that pass stay unchanged", () => {
    for (const t of THEMES.filter((x) => x.scheme === "dark")) {
      const c = trafficColorsOf(t);
      expect(contrastRatio(c.label, t.map.land), t.id).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.fill, t.map.land), t.id).toBeGreaterThanOrEqual(3);
      if (contrastRatio(t.colors.traffic, t.map.land) >= 4.5) expect(c.fill).toBe(t.colors.traffic);
    }
  });

  it("traffic is a cool blue-grey in every theme, far from the own aircraft yellow (UX 1.4)", () => {
    const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    for (const t of THEMES) {
      const [r, g, b] = rgb(t.colors.traffic);
      // blue channel on top: never yellow/amber; red not above green: never purple/magenta
      expect(b, t.id).toBeGreaterThan(r);
      expect(b, t.id).toBeGreaterThanOrEqual(g);
      expect(r, t.id).toBeLessThanOrEqual(g);
      const [, , fb] = rgb(trafficColorsOf(t).fill);
      expect(fb, t.id).toBeGreaterThan(rgb(trafficColorsOf(t).fill)[0]);
    }
  });

  it("ensureContrast returns the colour unchanged when it already passes", () => {
    expect(ensureContrast("#000000", "#ffffff", "#000000", 4.5)).toBe("#000000");
  });
});
