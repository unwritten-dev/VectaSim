import { NNBSP } from "../format";
import { describe, expect, it } from "vitest";
import { INDEX_WEIGHTS, buildHints, indexFormulaLines, keySentence, landingIndex, limitText, measuredText, provenance, sampleRateHz, windComponentsText } from "./facts";
import type { Criterion, LandingAnalysis, LandingDebriefData } from "./types";

const config = {
  tdzStartM: 300,
  tdzEndM: 900,
  tdzFirstThird: true,
  glidepathDeg: 3,
  tchFt: 50,
  glidepathToleranceDeg: 0.7,
  maxVsFpm: 1000,
  speedBelowKt: 5,
  speedAboveKt: 20,
  maxBankDeg: 15,
  matchLateralM: 1852,
  matchHeadingDeg: 30,
  rolloutEndKt: 30,
  approachStartFt: 1000,
  approachFallbackM: 5556,
  flareVsFraction: 0.7,
};

const crit = (kind: Criterion["kind"], status: Criterion["status"], measured: number | null, limitMin: number | null, limitMax: number | null, reference: number | null = null): Criterion => ({
  kind,
  status,
  measured,
  limitMin,
  limitMax,
  reference,
});

function data(over: Partial<LandingAnalysis> = {}): LandingDebriefData {
  const analysis: LandingAnalysis = {
    touchdownIndex: 0,
    touchdown: {
      timestampMs: 1,
      vsFpmMeasured: -180,
      vsFpmSim: -112,
      vsFpmHardest: -180,
      peakG: 1.2,
      pitchDeg: 3,
      bankDeg: 0,
      groundSpeedKt: 130,
      headingTrueDeg: 264,
      latitude: 0,
      longitude: 0,
      bounces: 0,
      touchAndGo: false,
      landingRateFpm: -112,
      landingRateSource: "sim",
    },
    vsBand: "smooth",
    vsMeasuredBand: "normal",
    vsHardestBand: "normal",
    gBand: "smooth",
    runway: {
      airport: "EDFE",
      ident: "26",
      oppositeIdent: "08",
      headingTrueDeg: 264,
      lengthM: 1400,
      widthM: 25,
      surface: "ASP",
      thresholdLat: 0,
      thresholdLon: 0,
      endLat: 0,
      endLon: 0,
      headingDiffDeg: 2,
      onRunway: true,
    },
    touchdownPoint: { distanceM: 420, distanceFt: 1378, lateralM: 3, tdzStartM: 155, tdzEndM: 467, inTdz: true, remainingM: 980 },
    threshold: { tMs: 0, heightFt: 46, iasKt: 128, airborneS: 6 },
    approach: {},
    flare: { startHatFt: 24, startTMs: 0, durationS: 5, approachVsFpm: -740, finalVsFpm: -180 },
    rollout: { distanceM: 820, durationS: 21, endLat: 0, endLon: 0, remainingM: 160 },
    wind: { directionDeg: 220, speedKt: 15, gustKt: null, referenceHeadingDeg: 264, relativeToRunway: true, headwindKt: 10.8, crosswindKt: -10.4 },
    gates: [
      {
        gateFt: 1000,
        reached: true,
        criteria: [crit("gear", "pass", 100, 95, null), crit("verticalSpeed", "pass", -750, -1000, 1000)],
      },
      {
        gateFt: 500,
        reached: true,
        criteria: [crit("gear", "pass", 100, 95, null), crit("verticalSpeed", "pass", -760, -1000, 1000)],
      },
    ],
    bouncePoints: [],
    distanceRef: "threshold",
    samples: [],
    config,
    ...over,
  };
  return { flight: {} as LandingDebriefData["flight"], touchdownCount: 1, analysis, metarAtLanding: false };
}

/** Tests use plain spaces; the UI uses narrow no-break spaces between number and unit. */
const N = (s: string) => s.split(NNBSP).join(" ");
const texts = (d: LandingDebriefData) => buildHints(d).map((h) => N(h.text));

describe("buildHints", () => {
  it("states the touchdown zone, centreline, threshold, stable gates, flare, wind and rollout", () => {
    const t = texts(data());
    expect(t).toContain("Aufsetzen 420 m hinter der Schwelle – innerhalb der Touchdown-Zone (155–467 m)");
    expect(t).toContain("Aufsetzpunkt 3,0 m rechts der Mittellinie (Runway 25 m breit)");
    expect(t.some((s) => s.startsWith("Schwelle in 46 ft überflogen"))).toBe(true);
    expect(t).toContain("Bei 1 000 ft und 500 ft alle Kriterien erfüllt");
    expect(t.some((s) => s.startsWith("Abfangen ab 24 ft"))).toBe(true);
    expect(t.some((s) => s.startsWith("Gegenwind 11 kt, Seitenwind 10 kt von links"))).toBe(true);
    expect(t).toContain("Rollout bis 30 kt: 820 m in 21 s, 160 m Runway übrig");
    // sim headline vs measured differ by ≥ 50 fpm → explained
    expect(t.some((s) => s.includes("Landerate −112 fpm (Sim-Wert)"))).toBe(true);
  });

  it("names each failed criterion with value and limit", () => {
    const d = data({
      gates: [
        { gateFt: 1000, reached: true, criteria: [crit("verticalSpeed", "pass", -900, -1000, 1000)] },
        {
          gateFt: 500,
          reached: true,
          criteria: [crit("verticalSpeed", "fail", -1150, -1000, 1000), crit("glidepath", "fail", 1.2, -0.7, 0.7, 3), crit("gear", "fail", 0, 95, null)],
        },
      ],
    });
    const t = texts(d);
    expect(t).toContain("Sinkrate bei 500 ft 1 150 fpm – über dem Limit von 1 000 fpm");
    expect(t).toContain("Gleitpfad bei 500 ft +1,2° über dem 3°-Pfad – Toleranz ±0,7°");
    expect(t).toContain("Fahrwerk bei 500 ft nicht ausgefahren (0 %)");
    expect(t.some((s) => s.includes("alle Kriterien erfüllt"))).toBe(false);
  });

  it("handles a landing without runway, with bounces and a measured fallback", () => {
    const base = data().analysis;
    const t = texts(
      data({
        runway: null,
        touchdownPoint: null,
        threshold: null,
        wind: null,
        touchdown: { ...base.touchdown, bounces: 2, vsFpmHardest: -420, vsFpmSim: 0, landingRateFpm: -420, landingRateSource: "measured" },
      }),
    );
    expect(t[0]).toMatch(/^Keine Runway zugeordnet/);
    expect(t.some((s) => s.startsWith("Der Sim hat für diese Landung keinen Touchdown-Wert geliefert"))).toBe(true);
    expect(t.some((s) => s.startsWith("2 Bounces nach dem ersten Aufsetzen – härtester Kontakt −420 fpm"))).toBe(true);
  });

  it("reports a touchdown beside the runway and past the zone", () => {
    const base = data().analysis;
    const t = texts(
      data({
        runway: { ...base.runway!, onRunway: false },
        touchdownPoint: { ...base.touchdownPoint!, distanceM: 600, lateralM: -440, inTdz: false, remainingM: 800 },
      }),
    );
    expect(t.some((s) => s.startsWith("Aufsetzen 600 m hinter der Schwelle – nach der Touchdown-Zone"))).toBe(true);
    expect(t.some((s) => s.startsWith("Aufsetzpunkt 440 m links der Mittellinie – außerhalb der Runway-Breite (25 m)"))).toBe(true);
  });

  it("never uses judgemental words", () => {
    const all = texts(data()).join(" ").toLowerCase();
    for (const w of ["gut", "schlecht", "perfekt", "super", "score", "note"]) expect(all.split(/\W+/)).not.toContain(w);
  });
});

describe("criterion text", () => {
  it("formats limits and measured values", () => {
    expect(N(limitText(crit("verticalSpeed", "pass", -700, -1000, 1000)))).toBe("|V/S| ≤ 1 000 fpm");
    expect(N(limitText(crit("glidepath", "pass", 0.1, -0.7, 0.7, 3)))).toBe("3,0° ±0,7°");
    expect(N(measuredText(crit("speed", "pass", 4, -5, 20, 132)))).toBe("+4 kt (136 kt)");
    expect(N(measuredText(crit("glidepath", "unavailable", null, -0.7, 0.7, 3)))).toBe("ohne Runway n. v.");
    expect(N(measuredText(crit("flaps", "fail", 0, 1, null)))).toBe("eingefahren");
  });

  it("wind components line", () => {
    expect(N(windComponentsText(data().analysis))).toBe("Gegenwind 11 kt · Seitenwind 10 kt von links");
  });
});

describe("keySentence", () => {
  it("opens with band, zone, centreline and bounces", () => {
    expect(N(keySentence(data()))).toBe("Sanfte Landung in der Touchdown-Zone, 3,0 m rechts der Mittellinie, ohne Bounce.");
  });
  it("covers missing runway, bounces and touch-and-go", () => {
    const base = data().analysis;
    const d = data({ runway: null, touchdownPoint: null, vsBand: "firm", touchdown: { ...base.touchdown, bounces: 2, touchAndGo: true } });
    expect(N(keySentence(d))).toBe("Touch-and-go mit fester Landerate ohne zugeordnete Runway, mit 2 Bounces.");
  });
});

describe("VectaSim-Index", () => {
  it("is 100 for an all-best landing", () => {
    const base = data().analysis;
    const a = { ...base, vsBand: "smooth" as const, gBand: "smooth" as const, touchdownPoint: { ...base.touchdownPoint!, distanceM: 400, lateralM: 1 } };
    expect(landingIndex(a).value).toBe(100);
  });

  it("weights the parts as printed in the formula", () => {
    const base = data().analysis;
    // rate normal (0.8 × 30), G firm (0.4 × 15), 1 bounce (0.4 × 15), zone past TDZ (0.4 × 15),
    // centreline 10 m on a 25 m runway (0.5 × 10), stable 3 of 4 criteria (0.75 × 15)
    const a = {
      ...base,
      vsBand: "normal" as const,
      gBand: "firm" as const,
      touchdown: { ...base.touchdown, bounces: 1 },
      touchdownPoint: { ...base.touchdownPoint!, distanceM: 600, lateralM: -10 },
      gates: [
        { gateFt: 1000, reached: true, criteria: [crit("gear", "pass", 100, 95, null), crit("verticalSpeed", "fail", -1200, -1000, 1000)] },
        { gateFt: 500, reached: true, criteria: [crit("gear", "pass", 100, 95, null), crit("bank", "pass", 3, null, 15), crit("glidepath", "unavailable", null, -0.7, 0.7, 3)] },
      ],
    };
    const expected = Math.round((100 * (0.8 * 30 + 0.4 * 15 + 0.4 * 15 + 0.4 * 15 + 0.5 * 10 + 0.75 * 15)) / 100);
    expect(landingIndex(a).value).toBe(expected);
    expect(expected).toBe(58);
  });

  it("drops unmeasurable parts with their weight", () => {
    const base = data().analysis;
    const a = { ...base, runway: null, touchdownPoint: null, gates: [], vsBand: "hard" as const, gBand: "smooth" as const };
    // rate 0 × 30, G 1 × 15, bounces 1 × 15 → 30 / 60
    expect(landingIndex(a).value).toBe(50);
    expect(landingIndex(a).parts.filter((p) => p.points == null).map((p) => p.key)).toEqual(["zone", "centreline", "stable"]);
  });

  it("prints a formula that names every weight", () => {
    const text = indexFormulaLines().join(" ");
    for (const [k, w] of Object.entries(INDEX_WEIGHTS)) expect(text, k).toContain(`Gewicht ${w}`);
    expect(Object.values(INDEX_WEIGHTS).reduce((s, w) => s + w, 0)).toBe(100);
  });
});

describe("provenance", () => {
  it("marks a sim/measured gap over 50 fpm", () => {
    const base = data().analysis;
    const p = provenance(data({ touchdown: { ...base.touchdown, vsFpmSim: -112, vsFpmMeasured: -180 } }));
    expect(p.rate.kind).toBe("sim");
    expect(p.rate.warn).toBe(true);
    expect(p.point.kind).toBe("derived");
    expect(p.g.kind).toBe("measured");
  });
  it("sample rate from the gaps", () => {
    expect(sampleRateHz([{ tMs: 0 }, { tMs: 1000 }, { tMs: 2000 }, { tMs: 3100 }])).toBe(1);
    expect(sampleRateHz([{ tMs: 0 }])).toBeNull();
  });
});
