import { NNBSP } from "../format";
import { describe, expect, it } from "vitest";
import {
  APPROACH_BAND_LABEL,
  APPROACH_BAND_SHAPE,
  APPROACH_BAND_VAR,
  BAND_SHAPE,
  BAND_VAR,
  INDEX_WEIGHTS,
  approachCardLine,
  approachHints,
  approachKeySentence,
  approachLabel,
  buildHints,
  criterionHint,
  indexFormulaLines,
  indexText,
  keySentence,
  landingIndex,
  lateralFactText,
  lateralHints,
  lateralSubLine,
  approachProvenance,
  limitText,
  measuredText,
  metarAgeNote,
  provenance,
  runwaySourceNote,
  sampleRateHz,
  stableFromPoints,
  stablePoints,
  touchdownDistanceText,
  unavailableReason,
  windComponentsText,
  worstCrosswindText,
} from "./facts";
import mockJson from "./fixtures/approach-mock.json";
import type { ApproachAnalysis, ApproachCriterion, Exceedance } from "./approachTypes";
import type { Criterion, LandingAnalysis, LandingDebriefData } from "./types";

// Defaults of LandingConfig in landing.rs after the phase-2 fixes: zone from the threshold,
// glidepath ±0.35° (1 dot), reference speed from the flown median 500 → 100 ft.
const config = {
  tdzEndM: 900,
  tdzFirstThird: true,
  glidepathDeg: 3,
  tchFt: 50,
  glidepathToleranceDeg: 0.35,
  glidepathFullScaleDeg: 0.7,
  maxVsFpm: 1000,
  speedBelowKt: 5,
  speedAboveKt: 20,
  vappFromFt: 500,
  vappToFt: 100,
  vs0Factor: 1.3,
  vappMinVs0: 1.1,
  vappMaxVs0: 1.6,
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
    referenceSpeedKt: 128,
    referenceSpeedSource: "flown",
    flownReferenceKt: 128,
    vs0Kt: null,
    referencePlausible: null,
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
    // 1400 m runway: zone 0 … first third (467 m), aiming point 300 m (Annex 14 Tab. 5-2)
    touchdownPoint: { distanceM: 420, distanceFt: 1378, lateralM: 3, tdzStartM: 0, tdzEndM: 467, aimingPointM: 300, inTdz: true, remainingM: 980 },
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
    expect(t).toContain("Aufsetzen 420 m hinter der Schwelle – in der Aufsetzzone (0–467 m, Zielpunkt 300 m)");
    expect(t).toContain("Aufsetzpunkt 3 m rechts der Mittellinie (Piste 25 m breit)");
    expect(t.some((s) => s.startsWith("Schwelle in 46 ft überflogen"))).toBe(true);
    expect(t).toContain("Bei 1 000 ft und 500 ft alle Kriterien erfüllt");
    // the source of the reference speed is named
    expect(t).toContain("Referenz-Speed ist der Median der geflogenen IAS 500 → 100 ft (128 kt) – misst die Konstanz, nicht den Absolutwert");
    expect(t.some((s) => s.startsWith("Abfangen ab 24 ft"))).toBe(true);
    expect(t.some((s) => s.startsWith("Gegenwind 11 kt, Seitenwind 10 kt von links"))).toBe(true);
    expect(t).toContain("Rollout bis 30 kt: 820 m in 21 s, 160 m Piste übrig");
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
          criteria: [
            crit("verticalSpeed", "fail", -1150, -1000, 1000),
            crit("glidepath", "fail", 1.2, -0.35, 0.35, 3),
            crit("gear", "fail", 0, 95, null),
            crit("speed", "fail", 24, -5, 20, 128),
          ],
        },
      ],
    });
    const t = texts(d);
    expect(t).toContain("Sinkrate bei 500 ft 1 150 fpm – über dem Limit von 1 000 fpm");
    // beyond two dots (0.7°) the deviation is named as S2
    expect(t).toContain("Gleitpfad bei 500 ft +1,20° über dem 3°-Pfad – Toleranz ±0,35° (1 Dot), mehr als 2 Dots (Vollausschlag, Stufe S2)");
    expect(t).toContain("Fahrwerk bei 500 ft nicht ausgefahren (0 %)");
    expect(t).toContain("Geschwindigkeit bei 500 ft +24 kt gegenüber der Referenz (128 kt) – Fenster −5/+20 kt");
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
    expect(t[0]).toMatch(/^Keine Piste zugeordnet/);
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
    expect(t.some((s) => s.startsWith("Aufsetzen 600 m hinter der Schwelle – nach der Aufsetzzone (0–467 m"))).toBe(true);
    expect(t.some((s) => s.startsWith("Aufsetzpunkt 440 m links der Mittellinie – außerhalb der Piste (25 m)"))).toBe(true);
  });

  it("a touchdown before the aiming point is in the zone; only before the threshold is short", () => {
    const base = data().analysis;
    const at = (distanceM: number) => texts(data({ touchdownPoint: { ...base.touchdownPoint!, distanceM } }));
    expect(at(200)).toContain("Aufsetzen 200 m hinter der Schwelle – in der Aufsetzzone (0–467 m, Zielpunkt 300 m)");
    expect(at(-30)).toContain("Aufsetzen 30 m vor der Schwelle – vor der Aufsetzzone (0–467 m, Zielpunkt 300 m)");
    expect(N(keySentence(data({ touchdownPoint: { ...base.touchdownPoint!, distanceM: 200 } })))).toMatch(/^Sanfte Landung in der Aufsetzzone/);
  });

  it("says 'Breite unbekannt' instead of 0 m", () => {
    const base = data().analysis;
    const t = texts(data({ runway: { ...base.runway!, widthM: null } }));
    expect(t).toContain("Aufsetzpunkt 3 m rechts der Mittellinie (Breite der Piste unbekannt)");
    expect(t.join(" ")).not.toContain("0 m breit");
  });

  it("flags a METAR observed more than 1 h before the landing", () => {
    const d = data();
    d.analysis.touchdown = { ...d.analysis.touchdown, timestampMs: Date.UTC(2026, 9, 17, 14, 32) };
    expect(metarAgeNote({ ...d, metarObservedMs: Date.UTC(2026, 9, 17, 14, 20) })).toBeNull();
    expect(N(metarAgeNote({ ...d, metarObservedMs: Date.UTC(2026, 9, 17, 13, 20) })!)).toBe("METAR von 13:20z (älter als 1 h)");
    expect(N(metarAgeNote({ ...d, metarObservedMs: Date.UTC(2026, 9, 17, 16, 50) })!)).toBe("METAR von 16:50z (über 1 h nach der Landung)");
    const t = buildHints({ ...d, metarObservedMs: Date.UTC(2026, 9, 17, 13, 20) }).map((h) => N(h.text));
    expect(t).toContain("METAR von 13:20z (älter als 1 h) – der Wind darin passt evtl. nicht zur Landung");
  });

  it("shows the worst crosswind of a variable wind and the gusts", () => {
    const base = data().analysis;
    // 240° varying 210–300° on runway 264: worst at 210° → 15 × sin 54° = 12 kt, from the left
    const w = { ...base.wind!, directionDeg: 240, speedKt: 15, gustKt: 25, variableFromDeg: 210, variableToDeg: 300, headwindKt: 13.7, crosswindKt: -6.1, gustCrosswindKt: -10.2, maxCrosswindKt: 12.1, maxGustCrosswindKt: 20.2, maxCrosswindFromRight: false };
    expect(N(worstCrosswindText(w)!)).toBe("bis 12 kt von links, in Böen bis 20 kt");
    expect(N(windComponentsText({ ...base, wind: w }))).toBe("Gegenwind 14 kt · Seitenwind 6 kt von links, Böen 10 kt · bis 12 kt von links, in Böen bis 20 kt");
    const t = texts(data({ wind: w }));
    expect(t.some((s) => s.includes("bis 12 kt von links, in Böen bis 20 kt innerhalb der Windrichtungs-Spanne") && s.includes("METAR 240°/15G25 kt (210–300°)"))).toBe(true);
    // VRB: either side, no components
    const vrb = { ...base.wind!, directionDeg: null, speedKt: 4, gustKt: null, headwindKt: null, crosswindKt: null, maxCrosswindKt: 4, maxGustCrosswindKt: null, maxCrosswindFromRight: null };
    expect(texts(data({ wind: vrb }))).toContain("Wind variabel 4 kt – keine Gegen-/Seitenwind-Komponenten; ungünstigster Fall: Seitenwind bis zu 4 kt von beliebiger Seite");
  });

  it("never uses judgemental words", () => {
    const all = texts(data()).join(" ").toLowerCase();
    for (const w of ["gut", "schlecht", "perfekt", "super", "score", "note"]) expect(all.split(/\W+/)).not.toContain(w);
  });
});

describe("criterion text", () => {
  it("formats limits and measured values", () => {
    expect(N(limitText(crit("verticalSpeed", "pass", -700, -1000, 1000)))).toBe("|V/S| ≤ 1 000 fpm");
    expect(N(limitText(crit("glidepath", "pass", 0.1, -0.35, 0.35, 3)))).toBe("3,0° ±0,35° (1 Dot)");
    expect(N(limitText(crit("speed", "pass", 4, -5, 20, 132)))).toBe("−5/+20 kt zur Referenz");
    expect(N(measuredText(crit("speed", "pass", 4, -5, 20, 132)))).toBe("+4 kt (136 kt)");
    expect(N(measuredText(crit("speed", "unavailable", null, -5, 20, null)))).toBe("ohne Referenz n. v.");
    expect(N(measuredText(crit("glidepath", "unavailable", null, -0.35, 0.35, 3)))).toBe("ohne Piste n. v.");
    expect(N(measuredText(crit("flaps", "fail", 0, 1, null)))).toBe("eingefahren");
  });

  it("wind components line", () => {
    expect(N(windComponentsText(data().analysis))).toBe("Gegenwind 11 kt · Seitenwind 10 kt von links");
  });
});

describe("keySentence", () => {
  it("opens with band, zone, centreline and bounces", () => {
    expect(N(keySentence(data()))).toBe("Sanfte Landung in der Aufsetzzone, 3 m rechts der Mittellinie, ohne Bounce.");
  });
  it("covers missing runway, bounces and touch-and-go", () => {
    const base = data().analysis;
    const d = data({ runway: null, touchdownPoint: null, vsBand: "firm", touchdown: { ...base.touchdown, bounces: 2, touchAndGo: true } });
    expect(N(keySentence(d))).toBe("Touch-and-go mit fester Landerate ohne zugeordnete Piste, mit 2 Bounces.");
  });
});

describe("VectaSim-Index", () => {
  it("is 100 for an all-best landing", () => {
    const base = data().analysis;
    const a = { ...base, vsBand: "smooth" as const, gBand: "smooth" as const, touchdownPoint: { ...base.touchdownPoint!, distanceM: 400, lateralM: 1 } };
    expect(landingIndex(a).value).toBe(100);
  });

  it("rewards normal as much as smooth", () => {
    const base = data().analysis;
    const a = { ...base, touchdownPoint: { ...base.touchdownPoint!, distanceM: 400, lateralM: 1 } };
    expect(landingIndex({ ...a, vsBand: "normal" as const, gBand: "normal" as const }).value).toBe(100);
    expect(landingIndex({ ...a, vsBand: "smooth" as const }).value).toBe(landingIndex({ ...a, vsBand: "normal" as const }).value);
  });

  it("weights the parts as printed in the formula", () => {
    const base = data().analysis;
    // rate normal (1.0 × 30 – was 0.8 before normal = smooth), g firm (0.4 × 15), 1 bounce (0.4 × 15),
    // zone 600 m: past the zone (467 m) but before the middle of the 1400 m runway (0.3 × 15 – was 0.4),
    // centreline 10 m on a 25 m runway (0.5 × 10), stable 3 of 4 criteria (0.75 × 15)
    const a = {
      ...base,
      vsBand: "normal" as const,
      gBand: "firm" as const,
      touchdown: { ...base.touchdown, bounces: 1 },
      touchdownPoint: { ...base.touchdownPoint!, distanceM: 600, lateralM: -10 },
      gates: [
        { gateFt: 1000, reached: true, criteria: [crit("gear", "pass", 100, 95, null), crit("verticalSpeed", "fail", -1200, -1000, 1000)] },
        { gateFt: 500, reached: true, criteria: [crit("gear", "pass", 100, 95, null), crit("bank", "pass", 3, null, 15), crit("glidepath", "unavailable", null, -0.35, 0.35, 3)] },
      ],
    };
    const expected = Math.round((100 * (1.0 * 30 + 0.4 * 15 + 0.4 * 15 + 0.3 * 15 + 0.5 * 10 + 0.75 * 15)) / 100);
    expect(landingIndex(a).value).toBe(expected);
    expect(expected).toBe(63);
    // beyond the middle of the runway the zone part is 0
    expect(landingIndex({ ...a, touchdownPoint: { ...a.touchdownPoint, distanceM: 800 } }).parts.find((p) => p.key === "zone")!.points).toBe(0);
  });

  it("is not comparable when a part is not measurable", () => {
    const base = data().analysis;
    const a = { ...base, runway: null, touchdownPoint: null, gates: [], vsBand: "hard" as const, gBand: "smooth" as const };
    const i = landingIndex(a);
    expect(i.value).toBeNull();
    expect(i.parts.filter((p) => p.points == null).map((p) => p.key)).toEqual(["zone", "centreline", "stable"]);
    expect(N(indexText(i))).toBe("nicht vergleichbar (ohne Piste)");
    const noWidth = landingIndex({ ...base, runway: { ...base.runway!, widthM: null } });
    expect(noWidth.value).toBeNull();
    expect(indexText(noWidth)).toBe("nicht vergleichbar (Breite unbekannt)");
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

// ---- approach (fixture: mock EDDF 25C, stable, stable from 1500 ft, flown Vapp 128 kt) ----

const mock = mockJson as unknown as ApproachAnalysis;
/** Deep copy with overrides (the fixture stays untouched). */
const approach = (over: Partial<ApproachAnalysis> = {}): ApproachAnalysis => ({ ...(JSON.parse(JSON.stringify(mock)) as ApproachAnalysis), ...over });
const ex = (over: Partial<Exceedance>): Exceedance => ({
  kind: "speed",
  level: "s1",
  startTMs: 0,
  endTMs: 12000,
  durationS: 12,
  startHatFt: 1000,
  endHatFt: 760,
  peak: 31,
  limit: 20,
  below500: false,
  ...over,
});
const goAround = (over: Partial<ApproachAnalysis> = {}) =>
  approach({
    outcome: { kind: "goAround" },
    goAround: { detectedBy: "both", lowestTMs: 0, lowestHatFt: 284, lowestMslFt: 648, lowestTrackDistM: 1500, lowestXM: -1500, climbTMs: 1, phaseTMs: 2, climbFt: 620, maxPitchDeg: 15, minIasKt: 126 },
    ...over,
  });

describe("approachKeySentence", () => {
  it("stable: established, stable from, FAF offset against the flown reference", () => {
    expect(N(approachKeySentence(mock))).toBe("Auf der Grundlinie ab 5,0 nm, stabil ab 1 500 ft. Bei FAF 16 kt schneller als die geflogene Referenz.");
  });
  it("deviations: names the one main exceedance with value, duration and heights", () => {
    const a = approach({ band: "deviations", exceedances: [ex({})], stability: { ...mock.stability, stableFromFt: 750 } });
    expect(N(approachKeySentence(a))).toBe("Auf der Grundlinie ab 5,0 nm, stabil ab 750 ft. Abweichung über 500 ft: Speed +31 kt zur Referenz für 12 s zwischen 1 000 und 760 ft.");
  });
  it("unstable below 500 ft picks the S2 exceedance", () => {
    const a = approach({
      band: "unstableBelow500",
      exceedances: [ex({}), ex({ kind: "verticalSpeed", level: "s2", peak: -1450, limit: -1200, durationS: 6, startHatFt: 390, endHatFt: 370, below500: true })],
      stability: { ...mock.stability, stableFromFt: null },
    });
    expect(N(approachKeySentence(a))).toBe("Auf der Grundlinie ab 5,0 nm, bis 50 ft nie durchgehend stabil. Instabil unter 500 ft: Sinkrate −1 450 fpm für 6 s bei 380 ft.");
  });
  it("go-around: positive and factual, after a stable or a deviating approach", () => {
    expect(N(approachKeySentence(goAround()))).toBe("Durchstarten bei 284 ft nach stabilem Anflug – richtige Entscheidung.");
    expect(N(approachKeySentence(goAround({ band: "deviations", exceedances: [ex({})] })))).toBe("Durchstarten bei 284 ft nach Abweichungen bei Speed – richtige Entscheidung.");
    expect(N(approachLabel(goAround()))).toBe("Anflug 1 – Durchstarten bei 284 ft");
    expect(N(approachLabel(approach({ index: 1 })))).toBe("Anflug 2 – Landung");
  });
});

describe("approach bands and gates", () => {
  it("maps the four bands to labels and tokens", () => {
    expect(APPROACH_BAND_LABEL).toEqual({ stable: "stabil", deviations: "mit Abweichungen", unstable: "instabil", unstableBelow500: "instabil unter 500 ft" });
    expect(APPROACH_BAND_VAR).toEqual({ stable: "var(--aband-stable)", deviations: "var(--aband-dev)", unstable: "var(--aband-unstable)", unstableBelow500: "var(--aband-unstable)" });
    // the shapes follow the landing band of the same meaning
    expect(APPROACH_BAND_SHAPE).toEqual({ stable: BAND_SHAPE.smooth, deviations: BAND_SHAPE.firm, unstable: BAND_SHAPE.hard, unstableBelow500: BAND_SHAPE.hard });
  });
  it("landing bands use their own tokens and four different shapes", () => {
    expect(BAND_VAR).toEqual({ smooth: "var(--band-soft)", normal: "var(--band-normal)", firm: "var(--band-firm)", hard: "var(--band-hard)" });
    expect(new Set(Object.values(BAND_SHAPE)).size).toBe(4);
  });
  it("card line: assumption, stable from, gate marks", () => {
    expect(N(approachCardLine(mock))).toBe("3°-Annahme · stabil ab 1 500 ft · 1000 ✓ 500 ✓");
    const a = approach();
    a.gates[3].criteria[3] = { ...a.gates[3].criteria[3], status: "fail" };
    expect(N(approachCardLine(a))).toBe("3°-Annahme · stabil ab 1 500 ft · 1000 ✓ 500 ✗");
  });
  it("says why a value is not measurable", () => {
    const ten = mock.gates[0];
    const alt = ten.criteria.find((c) => c.kind === "altitudeDeviation")!;
    expect(alt.status).toBe("unavailable");
    expect(N(unavailableReason(mock, ten, alt))).toBe("bei 10 nm nicht eingedreht");
    expect(N(unavailableReason(approach({ runway: null }), ten, alt))).toBe("ohne Piste");
  });
  it("formats the approach criterion kinds", () => {
    const c = (kind: ApproachCriterion["kind"], measured: number | null, limitMin: number | null, limitMax: number | null, reference: number | null = null): ApproachCriterion => ({
      kind,
      status: "pass",
      measured,
      limitMin,
      limitMax,
      reference,
    });
    expect(N(limitText(c("altitudeDeviation", 40, -300, 300, 3), "approach"))).toBe("±300 ft zum 3°-Pfad");
    expect(N(limitText(c("speedLimit", 180, null, 250), "approach"))).toBe("≤ 250 kt IAS");
    expect(N(limitText(c("energy", 200, null, 1000, 128), "approach"))).toBe("≤ +1 000 ft über Profil");
    expect(N(limitText(c("localizer", 0.1, -1, 1), "approach"))).toBe("±1 Dot");
    expect(N(limitText(c("glidepath", 0.1, -1, 1, 3), "approach"))).toBe("±1 Dot zum 3°-Pfad");
    expect(N(limitText(c("flaps", 4, 4, null, 4), "approach"))).toBe("Stufe 4 (Landeklappen)");
    expect(N(limitText(c("speed", 3, -5, 40, 128), "approach"))).toBe("−5/+40 kt zur Referenz");
    expect(N(measuredText(c("glidepath", 0.24, -1, 1, 3), "approach"))).toBe("+0,2 Dots");
    expect(N(measuredText(c("altitudeDeviation", -134, -300, 300, 3), "approach"))).toBe("−134 ft");
    expect(N(measuredText(c("flapChange", 1, null, 0.5), "approach"))).toBe("geändert");
    expect(N(criterionHint("bei FAF", { ...c("altitudeDeviation", -334, -300, 300, 3), status: "fail" }, "approach")!)).toBe(
      "Höhe bei FAF 334 ft unter dem 3°-Pfad – Toleranz ±300 ft",
    );
  });
});

describe("approach hints", () => {
  it("states established point, reference, configuration and the uninterrupted window", () => {
    const t = approachHints(mock).map((h) => N(h.text));
    expect(t).toContain("Auf dem Endanflug ab 5,0 nm / 1 652 ft eingedreht (RWY 25C)");
    expect(t.some((s) => s.startsWith("Referenz-Speed ist der Median der geflogenen IAS 500 → 100 ft (128 kt)"))).toBe(true);
    expect(t).toContain("Landeklappen (Stufe 4) bei 1 505 ft gesetzt");
    expect(t).toContain("Ab 1 000 ft bis 50 ft alle messbaren Kriterien ununterbrochen erfüllt");
    expect(approachHints(mock).every((h) => h.tone !== "warn")).toBe(true);
  });
  it("names late configuration, FAF offsets and exceedances", () => {
    const a = approach({ band: "deviations", exceedances: [ex({})] });
    a.configEvents = a.configEvents.map((e) => (e.flapsTo === 4 ? { ...e, hatFt: 820 } : e));
    a.gates[1].criteria = a.gates[1].criteria.map((c) => (c.kind === "altitudeDeviation" ? { ...c, measured: -134 } : c));
    const t = approachHints(a).map((h) => N(h.text));
    expect(t).toContain("Landeklappen (Stufe 4) erst bei 820 ft gesetzt – Landekonfiguration bis 1 000 ft erwartet");
    expect(t).toContain("Bei FAF 134 ft unter dem 3°-Pfad");
    expect(t).toContain("Speed +31 kt zur Referenz für 12 s zwischen 1 000 und 760 ft – Grenze +20 kt");
  });
  it("puts approach hints first and replaces the landing gate checks", () => {
    const t = buildHints(data(), mock).map((h) => N(h.text));
    expect(t[0]).toMatch(/^Auf dem Endanflug ab 5,0 nm/);
    expect(t).not.toContain("Bei 1 000 ft und 500 ft alle Kriterien erfüllt");
    expect(t.some((s) => s.startsWith("Aufsetzen 420 m hinter der Schwelle"))).toBe(true);
  });
  it("never uses judgemental words in a stable approach", () => {
    const all = approachHints(mock).map((h) => h.text).join(" ").toLowerCase();
    for (const w of ["gut", "schlecht", "perfekt", "super", "score", "note"]) expect(all.split(/\W+/)).not.toContain(w);
  });
});

describe("VectaSim-Index with an approach analysis", () => {
  it("scores stable-from linearly between 500 and 1000 ft", () => {
    expect(stableFromPoints(null)).toBe(0);
    expect(stableFromPoints(1500)).toBe(1);
    expect(stableFromPoints(1000)).toBe(1);
    expect(stableFromPoints(750)).toBe(0.5);
    expect(stableFromPoints(400)).toBe(0);
  });
  it("uses half stable-from, half the 1000/500 ft gate share", () => {
    const base = data().analysis;
    expect(landingIndex(base, mock).value).toBe(100);
    const a = approach({ stability: { ...mock.stability, stableFromFt: 750 } });
    a.gates[3].criteria[3] = { ...a.gates[3].criteria[3], status: "fail" };
    const stable = 0.5 * 0.5 + 0.5 * (13 / 14);
    expect(stablePoints(base, a)).toBeCloseTo(stable, 6);
    // all other parts at full points (85 of 100), stable 0.714 × 15
    expect(landingIndex(base, a).value).toBe(Math.round(85 + 15 * stable));
    expect(landingIndex(base, a).value).toBe(96);
  });
  it("falls back to the landing gates without an approach (or one that never got below 1000 ft)", () => {
    const base = data().analysis;
    expect(stablePoints(base, null)).toBe(1);
    expect(stablePoints(base, approach({ band: null }))).toBe(1);
  });
  it("prints the stable-from rule in the formula", () => {
    const text = N(indexFormulaLines().join(" "));
    expect(text).toContain("„stabil ab“");
    expect(text).toContain("ab 1 000 ft 1,0, bis 500 ft linear auf 0,0");
  });
});

describe("runway derived from the ground roll (R2)", () => {
  const base = data().analysis;
  const derived = data({
    runway: { ...base.runway!, source: "derived", alongUncertaintyM: 50, crossUncertaintyM: 5, lengthEstimated: true, derivedFromLandings: 3 },
    touchdownPoint: { ...base.touchdownPoint!, lateralM: 0.2, lateralMeasurable: false, distanceUncertaintyM: 50, tdzEndM: 900 },
    rollout: { ...base.rollout!, remainingM: null },
  });

  it("says where the runway comes from", () => {
    expect(runwaySourceNote(base.runway!)).toBe("Piste aus OurAirports");
    expect(runwaySourceNote(derived.analysis.runway!)).toBe("Piste aus deiner Rollspur abgeleitet (3 Landungen)");
    expect(runwaySourceNote({ source: "derived", derivedFromLandings: 1 })).toBe("Piste aus deiner Rollspur abgeleitet (1 Landung)");
    expect(runwaySourceNote({ source: "user", derivedFromLandings: null })).toBe("Piste von dir festgelegt");
  });

  it("gives the distance with its uncertainty and no centreline offset", () => {
    expect(N(touchdownDistanceText(derived.analysis.touchdownPoint!))).toBe("420 ± 50 m");
    expect(N(touchdownDistanceText(base.touchdownPoint!))).toBe("420 m");
    const t = buildHints(derived).map((h) => N(h.text)).join("\n");
    expect(t).toContain("Aufsetzen 420 ± 50 m hinter der Schwelle – in der Aufsetzzone (angenommen (0–900 m)");
    expect(t).toContain("Querablage nicht messbar");
    expect(t).not.toContain("Piste übrig");
    expect(t).not.toContain("der Mittellinie (Piste");
    expect(N(keySentence(derived))).toBe("Sanfte Landung in der Aufsetzzone, ohne Bounce.");
    expect(provenance(derived).point.detail).toContain("±50");
  });

  it("leaves the centreline out of the index", () => {
    const i = landingIndex(derived.analysis);
    expect(i.value).toBeNull();
    expect(i.parts.find((p) => p.key === "centreline")!.points).toBeNull();
    expect(indexText(i)).toBe("nicht vergleichbar (Querablage nicht messbar)");
  });
});

// ---- lateral guidance (extended centreline) ------------------------------------------------

describe("lateral guidance", () => {
  const lat = (over: Partial<NonNullable<ApproachAnalysis["lateral"]>>, a: Partial<ApproachAnalysis> = {}): ApproachAnalysis => {
    const b = approach(a);
    b.lateral = { ...b.lateral!, ...over };
    return b;
  };
  const hints = (a: ApproachAnalysis) => lateralHints(a).map((h) => [h.tone, N(h.text)]);

  it("on the centreline: facts line, sub-line and an ok hint, sentence unchanged", () => {
    expect(N(lateralFactText(mock))).toBe("auf der Grundlinie · ohne Überschießen eingedreht · keine S-Kurven");
    expect(N(lateralSubLine(mock))).toBe("max. +0,1 Dots · bei 500 ft 2 m rechts · Schwelle 2 m rechts");
    expect(hints(mock)).toEqual([["ok", "Grundlinie 1 000 → 50 ft gehalten (RMS 0,05 Dots)"]]);
    expect(N(approachKeySentence(mock))).not.toContain("rechts der Grundlinie");
  });

  it("names the offset at 500 ft in the key sentence when not on the centreline", () => {
    const a = lat({ lateralBand: "slight", latAt500M: 40, locMaxDots: 0.8 });
    expect(N(approachKeySentence(a))).toBe("Auf der Grundlinie ab 5,0 nm, stabil ab 1 500 ft, bei 500 ft 40 m rechts der Grundlinie. Bei FAF 16 kt schneller als die geflogene Referenz.");
    const b = lat({ lateralBand: "marked", latAt500M: null, locMaxDots: -1.4 });
    expect(N(approachKeySentence(b))).toContain("stabil ab 1 500 ft, deutliche Abweichung von der Grundlinie (max. −1,4 Dots).");
  });

  it("warns about an intercept overshoot above 0.5 dot only", () => {
    expect(hints(lat({ interceptOvershootM: -150, interceptOvershootDots: -0.8 }))).toContainEqual(["warn", "Beim Eindrehen 150 m (0,8 Dots) über die Grundlinie nach links hinausgeschossen"]);
    expect(hints(lat({ interceptOvershootM: 60, interceptOvershootDots: 0.4 })).some(([t]) => t === "warn")).toBe(false);
    expect(N(lateralFactText(lat({ interceptOvershootM: 60, interceptOvershootDots: 0.4 })))).toContain("beim Eindrehen 60 m (0,4 Dots) übergeschossen");
  });

  it("S-turns: info from 2, warn from 3 side changes", () => {
    expect(hints(lat({ lateralReversals: 1 })).length).toBe(1); // only the ok line
    expect(hints(lat({ lateralReversals: 2 }))).toContainEqual(["info", "2 Seitenwechsel um die Grundlinie zwischen 1 000 und 100 ft (S-Kurven, Ablage über 0,3 Dots)"]);
    expect(hints(lat({ lateralReversals: 3 }))[0][0]).toBe("warn");
    expect(N(lateralFactText(lat({ lateralReversals: 3 })))).toContain("3 Seitenwechsel (S-Kurven)");
  });

  it("warns about more than 0.5 dot below 500 ft (from the profile)", () => {
    const a = approach();
    const i = a.samples.findIndex((p) => !p.onGround && p.locDots != null && p.hatFt < 500 && p.hatFt >= 50);
    expect(i).toBeGreaterThanOrEqual(0);
    a.samples[i] = { ...a.samples[i], locDots: -0.7 };
    expect(hints(a)).toContainEqual(["warn", "Unter 500 ft bis 0,7 Dots links der Grundlinie – über 0,5 Dots"]);
  });

  it("over the threshold: info above 10 m, warn above a quarter of the runway width", () => {
    expect(hints(lat({ latAtThresholdM: 11 }))).toContainEqual(["info", "Über der Schwelle 11 m rechts der Mittellinie"]);
    expect(hints(lat({ latAtThresholdM: -15 }))).toContainEqual(["warn", "Über der Schwelle 15 m links der Mittellinie – mehr als ein Viertel der Pistenbreite (45 m)"]);
    const noWidth = lat({ latAtThresholdM: -15 }, { runway: { ...mock.runway!, widthM: null } });
    expect(hints(noWidth)).toContainEqual(["info", "Über der Schwelle 15 m links der Mittellinie"]);
    expect(hints(lat({ latAtThresholdM: 30 }, { outcome: { kind: "goAround" } })).some(([, t]) => t.startsWith("Über der Schwelle"))).toBe(false);
  });

  it("derived runway or no runway: not assessable, said so", () => {
    const derived = lat({ measurable: false, lateralBand: null }, { runway: { ...mock.runway!, source: "derived" } });
    expect(hints(derived)).toEqual([["info", "Piste aus deiner Rollspur abgeleitet – Querablage zur Grundlinie nicht bewertbar"]]);
    expect(N(lateralFactText(derived))).toBe("Piste aus Rollspur – nicht bewertbar");
    expect(N(lateralSubLine(derived))).toBe("Piste aus Rollspur – nicht bewertbar");
    expect(approachProvenance(derived).lateral.detail).toContain("nicht bewertbar");
    expect(N(approachKeySentence(lat({ lateralBand: null, latAt500M: 40 }, { runway: { ...mock.runway!, source: "derived" } })))).not.toContain("Grundlinie.");
    const none = approach({ runway: null, lateral: { ...mock.lateral!, measurable: false, lateralBand: null } });
    expect(lateralHints(none)).toEqual([]);
    expect(N(lateralFactText(none))).toBe("ohne Piste nicht messbar");
    expect(approachProvenance(none).lateral.detail).toMatch(/^Keine Piste zugeordnet/);
    expect(approachProvenance(mock).lateral).toMatchObject({ kind: "derived" });
    expect(approachProvenance(mock).lateral.detail).toContain("VectaSim-Konvention");
  });
});
