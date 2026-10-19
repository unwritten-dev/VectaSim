import { renderToStaticMarkup } from "react-dom/server";
import { NNBSP } from "../format";
import { beforeEach, describe, expect, it } from "vitest";
import { setLanguageSetting } from "../i18n";
import LandingCard, { CARD_H, CARD_W, themeCardColors } from "./LandingCard";
import { autoCardFileName, cardFileName } from "./exportCard";
import mockJson from "./fixtures/approach-mock.json";
import type { ApproachAnalysis } from "./approachTypes";
import type { ApproachPoint, LandingAnalysis, LandingDebriefData } from "./types";

// Defaults of LandingConfig in landing.rs (glidepath ±0.35° = 1 dot since the phase-2 fix).
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

/** 3° approach from 2 nm, touchdown 420 m past the threshold, rollout to 1240 m. */
function samples(): ApproachPoint[] {
  const out: ApproachPoint[] = [];
  const tan3 = Math.tan((3 * Math.PI) / 180);
  for (let d = 3700, t = 0; d >= -1240; d -= 60, t += 1000) {
    const ground = d <= -420;
    const hat = ground ? 0 : Math.max(0, ((d + 290) * tan3) / 0.3048);
    out.push({
      tMs: t,
      latitude: 0,
      longitude: 0,
      hatFt: hat,
      iasKt: ground ? 60 : 70,
      groundSpeedKt: 65,
      vsFpm: ground ? 0 : -380,
      bankDeg: 0,
      pitchDeg: 2,
      onGround: ground,
      flapsIndex: 2,
      gearPct: 100,
      xM: -d,
      yM: ground ? 3 : 1,
      distM: d,
    });
  }
  return out;
}

function data(over: Partial<LandingAnalysis> = {}, rest: Partial<LandingDebriefData> = {}): LandingDebriefData {
  const analysis: LandingAnalysis = {
    touchdownIndex: 0,
    touchdown: {
      timestampMs: Date.UTC(2026, 9, 17, 14, 32, 10),
      vsFpmMeasured: -180,
      vsFpmSim: -112,
      vsFpmHardest: -180,
      peakG: 1.2,
      pitchDeg: 3,
      bankDeg: 0,
      groundSpeedKt: 65,
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
    referenceSpeedKt: 70,
    referenceSpeedSource: "flown",
    flownReferenceKt: 70,
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
    // 1400 m runway: zone from the threshold to the first third (467 m), aiming point 300 m
    touchdownPoint: { distanceM: 420, distanceFt: 1378, lateralM: 3, tdzStartM: 0, tdzEndM: 467, aimingPointM: 300, inTdz: true, remainingM: 980 },
    threshold: { tMs: 0, heightFt: 46, iasKt: 68, airborneS: 6 },
    approach: {},
    flare: { startHatFt: 24, startTMs: 0, durationS: 5, approachVsFpm: -740, finalVsFpm: -180 },
    rollout: { distanceM: 820, durationS: 21, endLat: 0, endLon: 0, remainingM: 160 },
    wind: { directionDeg: 220, speedKt: 15, gustKt: null, referenceHeadingDeg: 264, relativeToRunway: true, headwindKt: 10.8, crosswindKt: -10.4 },
    gates: [],
    bouncePoints: [],
    distanceRef: "threshold",
    samples: samples(),
    config,
    ...over,
  };
  const flight = {
    aircraft: { title: "Cessna Skyhawk G1000", atcModel: "C172", atcType: "C172", atcId: "D-EABC", atcAirline: "", atcFlightNumber: "" },
    simName: "MSFS 2024",
    provider: "simconnect",
  } as unknown as LandingDebriefData["flight"];
  return { flight, touchdownCount: 1, analysis, metarAtLanding: true, ...rest };
}

beforeEach(() => setLanguageSetting("de"));

describe("cardFileName", () => {
  it("suggests VectaSim_<ICAO>_<RWY>_<UTC date>.png", () => {
    expect(cardFileName(data())).toBe("VectaSim_EDFE_26_2026-10-17.png");
  });
  it("uses the UTC date and strips characters that do not belong in a file name", () => {
    const d = data({ touchdown: { ...data().analysis.touchdown, timestampMs: Date.UTC(2026, 9, 17, 23, 59) } });
    d.analysis.runway = { ...d.analysis.runway!, ident: "09L/R" };
    expect(cardFileName(d)).toBe("VectaSim_EDFE_09LR_2026-10-17.png");
  });
  it("leaves out the runway when none was matched", () => {
    const d = data({ runway: null, touchdownPoint: null, distanceRef: "touchdown" }, { airport: { ident: "EDDF" } as LandingDebriefData["airport"] });
    expect(cardFileName(d)).toBe("VectaSim_EDDF_2026-10-17.png");
  });
});

describe("autoCardFileName", () => {
  it("names the automatic save VectaSim_<ICAO>_<RWY>_<yyyy-MM-dd_HHmm>.png (UTC)", () => {
    const d = data({ touchdown: { ...data().analysis.touchdown, timestampMs: Date.UTC(2026, 9, 17, 23, 5, 59) } });
    expect(autoCardFileName(d)).toBe("VectaSim_EDFE_26_2026-10-17_2305.png");
  });
  it("falls back to the airport, then to „Landung“ and to now without a touchdown time", () => {
    const d = data({ runway: null, touchdownPoint: null, distanceRef: "touchdown", touchdown: { ...data().analysis.touchdown, timestampMs: 0 } });
    expect(autoCardFileName(d, Date.UTC(2026, 0, 2, 3, 4))).toBe("VectaSim_Landung_2026-01-02_0304.png");
    d.airport = { ident: "EDDF" } as LandingDebriefData["airport"];
    expect(autoCardFileName(d, Date.UTC(2026, 0, 2, 3, 4))).toBe("VectaSim_EDDF_2026-01-02_0304.png");
  });
});

describe("LandingCard", () => {
  const colors = themeCardColors();

  it("renders a fixed 1200×675 SVG with concrete colours only", () => {
    const html = renderToStaticMarkup(<LandingCard data={data()} colors={colors} />);
    expect(html.startsWith("<svg")).toBe(true);
    expect(html).toContain(`width="${CARD_W}"`);
    expect(html).toContain(`height="${CARD_H}"`);
    expect(html).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(html).not.toContain("var(--");
    expect(html).toContain(colors.bg);
  });

  it("shows head, the four key numbers, runway and profile", () => {
    const html = renderToStaticMarkup(<LandingCard data={data()} colors={colors} />).split(NNBSP).join(" ");
    expect(html).toContain("EDFE");
    expect(html).toContain("RWY 26");
    expect(html).toContain("17.10.2026 14:32z");
    expect(html).toContain("D-EABC");
    expect(html).toContain("MSFS 2024");
    expect(html).toContain("−112");
    expect(html).toContain("1,20");
    expect(html).toContain("420");
    expect(html).toContain("m R");
    expect(html).toContain("PISTE 26 VON OBEN");
    expect(html).toContain(">Mittellinie<");
    expect(html).toContain("Aufsetzzone 0–467 m · Zielpunkt 300 m");
    expect(html).not.toContain("Touchdown-Zone");
    expect(html).not.toContain("Centerline");
    expect(html).toContain("3°-Referenz ±0,35° (1 Dot)");
    expect(html).toContain("> g<");
    expect(html).toContain("Gegenwind 11 kt");
    expect(html).toContain("<title>VectaSim</title>");
    expect(html).not.toContain("VECTASIM");
    expect(html).toContain(colors.bandSoft); // band mark from the band scale, not ok/accent
  });

  it("renders without runway and without samples", () => {
    const d = data({ runway: null, touchdownPoint: null, distanceRef: "touchdown", samples: [], wind: null, threshold: null });
    const html = renderToStaticMarkup(<LandingCard data={d} colors={colors} />);
    expect(html).toContain("Keine Piste zugeordnet");
    expect(html).not.toContain("var(--");
  });

  it("says when the width is unknown and when the METAR is older than 1 h", () => {
    const base = data();
    const d = data(
      { runway: { ...base.analysis.runway!, widthM: null } },
      { metar: { station: "EDFE", raw: "", time: "171250Z", cavok: false, category: "VFR", source: "logbook" }, metarObservedMs: Date.UTC(2026, 9, 17, 12, 50) },
    );
    const html = renderToStaticMarkup(<LandingCard data={d} colors={colors} />).split(NNBSP).join(" ");
    expect(html).toContain("Breite unbekannt");
    expect(html).not.toContain("0 m breit");
    expect(html).toContain("von 12:50z (älter als 1 h)");
  });

  it("masks the registration with hideReg (Streamer-Modus / ohne Kennzeichen)", () => {
    const shown = renderToStaticMarkup(<LandingCard data={data()} colors={colors} />);
    expect(shown).toContain("D-EABC");
    const hidden = renderToStaticMarkup(<LandingCard data={data()} colors={colors} hideReg />);
    expect(hidden).not.toContain("D-EABC");
    expect(hidden).toContain("D-••••");
  });

  it("adds the approach line under the profile when an analysis is given", () => {
    const approach = mockJson as unknown as ApproachAnalysis;
    const html = renderToStaticMarkup(<LandingCard data={data()} colors={colors} approach={approach} />).split(NNBSP).join(" ");
    expect(html).toContain("3,0° (ILS) · stabil ab 1 500 ft · 1000 ✓ 500 ✓");
    expect(html).not.toContain("var(--");
    const without = renderToStaticMarkup(<LandingCard data={data()} colors={colors} />);
    expect(without).not.toContain("Annahme");
    expect(without).not.toContain("(ILS)");
  });
});

describe("LandingCard in English (UI language)", () => {
  beforeEach(() => setLanguageSetting("en"));
  const colors = themeCardColors();
  it("draws the card texts and numbers in English", () => {
    const approach = mockJson as unknown as ApproachAnalysis;
    const html = renderToStaticMarkup(<LandingCard data={data()} colors={colors} approach={approach} />).split(NNBSP).join(" ");
    for (const s of ["Landing rate", "Peak g", "From threshold", "Centreline", "APPROACH · LAST 1 NM", "Touchdown zone", "aiming point", "stable from 1,500 ft"]) expect(html).toContain(s);
    expect(html).toMatch(/Smooth landing in the touchdown zone/);
    expect(html).not.toMatch(/Landerate|Mittellinie|Aufsetzzone|Schwelle|Abfangen|stabil ab/);
    expect(html.replace(/<[^>]*>/g, " ")).not.toMatch(/\d,\d{1,2}(?!\d)/); // no decimal comma in the texts
  });
});
