import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NNBSP } from "../format";
import { setLanguageSetting } from "../i18n";
import { monthName, monthShort, periodLabel, periodOf, periodTitle } from "./stats";
import { approachesWord, cardTitle, earthText, formatLabel, goAroundsWord, hoursNum, hoursText, reviewFileName, stackFileName } from "./text";
import { fitView, greatCircle, projector, WORLD } from "./geo";
import { wrapText } from "./ReviewCards";

const now = Date.parse("2026-10-18T12:00:00Z");

// texts are pinned to German; the English cases pass the language explicitly
beforeEach(() => setLanguageSetting("de"));
afterEach(() => setLanguageSetting("de"));

describe("file names", () => {
  it("calendar year and last 12 months", () => {
    expect(reviewFileName("overview", "portrait", periodOf("year", 2026, now, false))).toBe("VectaSim_Jahr_2026_1-Ueberblick_hoch.png");
    expect(reviewFileName("countries", "landscape", periodOf("last12", 0, now, false))).toBe("VectaSim_12Monate_2025-11_2026-10_7-Laender_quer.png");
    expect(stackFileName(periodOf("year", 2025, now, false))).toBe("VectaSim_Jahr_2025_Stapel.png");
  });

  it("follow the language: English names", () => {
    expect(reviewFileName("overview", "portrait", periodOf("year", 2026, now, false), "en")).toBe("VectaSim_Year_2026_1-Overview_portrait.png");
    expect(reviewFileName("countries", "landscape", periodOf("last12", 0, now, false), "en")).toBe("VectaSim_12Months_2025-11_2026-10_7-Countries_landscape.png");
    expect(stackFileName(periodOf("year", 2025, now, false), "en")).toBe("VectaSim_Year_2025_Stack.png");
    setLanguageSetting("en");
    expect(stackFileName(periodOf("year", 2025, now, false))).toBe("VectaSim_Year_2025_Stack.png");
  });
});

describe("number phrases", () => {
  it("hours", () => {
    expect(hoursNum(0)).toBe("0");
    expect(hoursNum(12.46 * 3_600_000)).toBe("12,5");
    expect(hoursNum(1234.4 * 3_600_000)).toBe(`1${NNBSP}234`);
    expect(hoursText(65 * 60_000)).toBe(`1${NNBSP}h${NNBSP}05${NNBSP}min`);
    expect(hoursText(40 * 60_000)).toBe(`40${NNBSP}min`);
    expect(hoursText(150.2 * 3_600_000)).toBe(`150${NNBSP}h`);
  });

  it("earth laps", () => {
    expect(earthText(0)).toBe("noch keine Erdumrundung");
    expect(earthText(0.123)).toBe(`12${NNBSP}% einer Erdumrundung`);
    expect(earthText(1.01)).toBe("einmal um die Erde");
    expect(earthText(1.84)).toBe("1,8-mal um die Erde");
    expect(earthText(12.4)).toBe("12-mal um die Erde");
  });

  it("English phrases", () => {
    expect(hoursNum(12.46 * 3_600_000, "en")).toBe("12.5");
    expect(hoursNum(1234.4 * 3_600_000, "en")).toBe("1,234");
    expect(earthText(0, "en")).toBe("not around the Earth yet");
    expect(earthText(0.123, "en")).toBe("12% of the way around the Earth");
    expect(earthText(1.01, "en")).toBe("once around the Earth");
    expect(earthText(1.84, "en")).toBe("1.8 times around the Earth");
    expect(goAroundsWord(0, "en")).toBe("no go-arounds");
    expect(goAroundsWord(1, "en")).toBe("1 go-around");
    expect(approachesWord(3, "en")).toBe("3 approaches");
    expect(cardTitle("landings", "en")).toBe("Your landings");
    expect(cardTitle("landings", "de")).toBe("Deine Landungen");
    expect(formatLabel("portrait", "en")).toBe("Portrait");
  });

  it("months and period titles via Intl in both languages", () => {
    expect([0, 2, 5, 8, 9, 11].map((m) => monthShort(m, "de"))).toEqual(["Jan", "Mär", "Jun", "Sep", "Okt", "Dez"]);
    expect([0, 2, 4, 8, 9, 11].map((m) => monthShort(m, "en"))).toEqual(["Jan", "Mar", "May", "Sep", "Oct", "Dec"]);
    expect(monthName(2, "de")).toBe("März");
    expect(monthName(4, "en")).toBe("May");
    const y = periodOf("year", 2026, now, false);
    const l12 = periodOf("last12", 0, now, false);
    expect(periodTitle(y, "de")).toBe("Dein Jahr 2026");
    expect(periodTitle(y, "en")).toBe("Your year 2026");
    expect(periodTitle(l12, "en")).toBe("Your last 12 months");
    expect(periodLabel(l12, "en")).toBe("Nov 2025 – Oct 2026");
  });

  it("go-arounds", () => {
    expect(goAroundsWord(0)).toBe("kein Durchstarten");
    expect(goAroundsWord(1)).toBe("1 Durchstarten");
    expect(goAroundsWord(3)).toBe("3 Durchstarts");
  });

  it("wraps words into lines", () => {
    expect(wrapText("Frankreich, Spanien, Portugal, Italien", 20, 3)).toEqual(["Frankreich, Spanien,", "Portugal, Italien"]);
    expect(wrapText("a b c d e f", 3, 2)).toEqual(["a b", "c…"]);
  });
});

describe("map geometry", () => {
  it("great circle stays continuous across the antimeridian", () => {
    const pts = greatCircle([170, -40], [-170, -40], 10);
    for (let i = 1; i < pts.length; i++) expect(Math.abs(pts[i][0] - pts[i - 1][0])).toBeLessThan(10);
    expect(pts[pts.length - 1][0]).toBeCloseTo(190);
  });

  it("fits a view around the points, the world for a global spread", () => {
    const v = fitView([
      [8.6, 50],
      [-0.5, 51.5],
    ]);
    expect(v.e - v.w).toBeGreaterThanOrEqual(24);
    expect(fitView([[-120, 30], [140, 35]])).toEqual(WORLD);
    const { px } = projector(v, { x: 0, y: 0, w: 400, h: 200 });
    const [x, y] = px([(v.w + v.e) / 2, (v.s + v.n) / 2]);
    expect(x).toBeCloseTo(200);
    expect(y).toBeCloseTo(100);
  });
});
