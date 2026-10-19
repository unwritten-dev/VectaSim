// Landing debrief in both languages (W6 of the i18n migration): the German reference and the
// English translation of the whole body, methodology and measurement log included (the
// collapsible panels are rendered open), statically (no effects run).
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => new Promise(() => {}) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
// the prefs store's useSyncExternalStore has no server snapshot: read the defaults directly
vi.mock("../prefs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../prefs")>();
  return {
    ...orig,
    usePrefs: () => orig.getPrefs(),
    usePrivacy: () => ({ on: false, mask: (v: string | null | undefined) => v ?? "", title: (text: string | null | undefined) => text ?? "" }),
  };
});
// methodology and measurement log sit in collapsed panels: render them open
vi.mock("../ui/Panel", () => ({
  default: ({ title, children }: { title: ReactNode; children?: ReactNode }) => (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  ),
  Chevron: () => null,
}));
// child components with their own texts (and own tests) are out of scope here: stub them
vi.mock("./ApproachChart", () => ({ default: () => null }));
vi.mock("./RunwayDiagram", () => ({ default: () => null }));
vi.mock("./RunwayEditor", () => ({ default: () => null }));
vi.mock("./StabilisedTable", () => ({ default: () => null }));
vi.mock("./HistoryPanel", () => ({ default: () => null }));
vi.mock("./ReplayBar", () => ({ default: () => null, ReplayValues: () => null }));
vi.mock("../map/TrackMap", () => ({ default: () => null }));
vi.mock("./ApproachSection", async (importOriginal) => ({ ...(await importOriginal<typeof import("./ApproachSection")>()), default: () => null }));

import { I18nProvider, setLanguageSetting, type Language } from "../i18n";
import { NNBSP } from "../i18n/number";
import { DebriefBody } from "./LandingDebrief";
import mockJson from "./fixtures/approach-mock.json";
import type { ApproachAnalysis } from "./approachTypes";
import type { ApproachPoint, LandingAnalysis, LandingDebriefData } from "./types";

afterEach(() => setLanguageSetting("de"));

const mock = mockJson as unknown as ApproachAnalysis;

// Defaults of LandingConfig in landing.rs (as in LandingCard.test.tsx).
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

function data(): LandingDebriefData {
  const analysis = {
    touchdownIndex: 0,
    touchdown: {
      timestampMs: Date.UTC(2026, 9, 17, 14, 32, 10),
      vsFpmMeasured: -180,
      vsFpmSim: -112,
      vsFpmHardest: -180,
      peakG: 1.25,
      pitchDeg: 3,
      bankDeg: 0,
      groundSpeedKt: 65,
      headingTrueDeg: 264,
      latitude: 0,
      longitude: 0,
      bounces: 1,
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
    touchdownPoint: { distanceM: 420, distanceFt: 1378, lateralM: 3, tdzStartM: 0, tdzEndM: 467, aimingPointM: 300, inTdz: true, remainingM: 980 },
    threshold: { tMs: 0, heightFt: 46, iasKt: 68, airborneS: 6 },
    approach: { iasMinKt: 66, iasMaxKt: 74, bankMaxBelow500Deg: 2.5, glidepathDevMaxAboveDeg: 0.12, glidepathDevMaxBelowDeg: -0.08, startReason: "altitude" },
    flare: { startHatFt: 24, startTMs: 0, durationS: 5, approachVsFpm: -740, finalVsFpm: -180 },
    rollout: { distanceM: 820, durationS: 21, endLat: 0, endLon: 0, remainingM: 160 },
    wind: { directionDeg: 220, speedKt: 15, gustKt: null, referenceHeadingDeg: 264, relativeToRunway: true, headwindKt: 10.8, crosswindKt: -10.4 },
    gates: [],
    bouncePoints: [],
    distanceRef: "threshold",
    samples: samples(),
    config,
  } as unknown as LandingAnalysis;
  const flight = {
    id: "f1",
    aircraft: { title: "Cessna Skyhawk G1000", atcModel: "C172", atcType: "C172", atcId: "D-EABC", atcAirline: "", atcFlightNumber: "" },
    simName: "MSFS 2024",
    provider: "simconnect",
    integrity: { slewDetected: false, timeAccelerationDetected: true, maxSimRate: 4, crashed: false, fuelIncreasedAirborne: false, pauseCount: 2 },
  } as unknown as LandingDebriefData["flight"];
  return {
    flight,
    touchdownCount: 1,
    analysis,
    metarAtLanding: true,
    metar: { station: "EDFE", time: "141420Z", wind: { directionDeg: 220, speedKt: 15, gustKt: null, variable: false } },
  } as unknown as LandingDebriefData;
}

const render = (lang: Language, withApproach: boolean) => {
  // numbers (i18n/number) and facts.ts follow the global language: set it, not only the provider
  setLanguageSetting(lang);
  const approach = withApproach ? ({ kind: "ok", approach: mock } as const) : ({ kind: "error", reason: "–" } as const);
  return renderToStaticMarkup(
    <I18nProvider lang={lang}>
      <DebriefBody d={data()} approach={approach} titleId="t" onRunwayChanged={() => {}} />
    </I18nProvider>,
  )
    .split(NNBSP)
    .join(" ");
};

/** German words of the debrief's own texts that must not show up in English. */
const GERMAN = [
  "Landerate",
  "Aufsetzpunkt",
  "Mittellinie",
  "Methodik",
  "Messprotokoll",
  "Abfangen",
  "Schwelle",
  "Gleitpfad",
  "Piste",
  "Querneigung",
  "Sinkrate",
  "Fahrwerk",
  "Bänder",
  "Durchstarten",
  "Lokalizer",
  "Zeitraffer",
  "Windstill",
  "nicht messbar",
  "Diese Landung",
];

describe("LandingDebrief i18n", () => {
  for (const withApproach of [false, true]) {
    const which = withApproach ? "with approach analysis" : "without approach analysis";

    it(`German reference (${which})`, () => {
      const h = render("de", withApproach);
      expect(h).toContain("Landerate");
      expect(h).toContain("Methodik");
      expect(h).toContain("Messprotokoll");
      expect(h).toContain("Abfangen &amp; Rollout");
      expect(h).toContain("3 m rechts der Mittellinie");
      expect(h).toContain("Spitze 0,5 s nach dem Kontakt");
      expect(h).toContain("Zeitraffer (max. 4×)");
      expect(h).toContain("2× Pause");
      expect(h).toContain("1 Bounce");
      expect(h).not.toContain("debrief.");
      if (withApproach) {
        expect(h).toContain("Kurs (Localizer-Ersatz)");
        expect(h).not.toContain("Lokalizer");
      } else expect(h).toContain("Gleitpfad ±0,35° = 1 Dot");
    });

    it(`English (${which})`, () => {
      const h = render("en", withApproach);
      expect(h).not.toContain("debrief.");
      expect(h).toContain("Landing rate");
      expect(h).toContain("Methodology");
      expect(h).toContain("Measurement log");
      expect(h).toContain("Flare &amp; rollout");
      expect(h).toContain("3 m right of the centreline");
      expect(h).toContain("Peak 0.5 s after contact");
      expect(h).toContain("Time acceleration (max. 4×)");
      expect(h).toContain("2 pauses");
      expect(h).toContain("1 bounce");
      // decimal point, never a decimal comma in numbers
      expect(h).toContain("1.25");
      expect(h).not.toMatch(/\d,\d\d?\s?(°|s|g|nm|dots?)\b/);
      if (withApproach) {
        expect(h).toContain("localiser substitute");
        expect(h).toContain("Stability and 3-second rule");
      } else expect(h).toContain("glide path ±0.35° = 1 dot");
      for (const w of GERMAN) expect(h, w).not.toContain(w);
    });
  }
});
