import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NNBSP } from "../format";
import ApproachSection from "./ApproachSection";
import StabilisedTable from "./StabilisedTable";
import { selectApproach } from "./LandingDebrief";
import mockJson from "./fixtures/approach-mock.json";
import type { ApproachAnalysis } from "./approachTypes";

const mock = mockJson as unknown as ApproachAnalysis;
const N = (s: string) => s.split(NNBSP).join(" ");
const html = (a: ApproachAnalysis) => N(renderToStaticMarkup(<ApproachSection status={{ kind: "ok", approach: a }} />));

describe("ApproachSection", () => {
  it("renders key sentence, band, the three hero values and the compact facts", () => {
    const h = html(mock);
    expect(h).toContain("Auf der Grundlinie ab 5,0 nm, stabil ab 1 500 ft. Bei FAF 16 kt schneller als die geflogene Referenz.");
    expect(h).toContain("RWY 25C");
    expect(h).toContain(">stabil<");
    expect(h).toContain("var(--aband-stable)");
    // heroes with provenance chips
    expect(h).toContain("Stabil ab");
    expect(h).toContain("1 500");
    expect(h).toContain("Gleitpfad (RMS)");
    expect(h).toContain("0,08");
    expect(h).toContain("3°-Annahme");
    expect(h).toContain("Grundlinie (RMS)");
    expect(h).toContain("0,05");
    expect(h).toContain("max. +0,1 Dots · bei 500 ft 2 m rechts · Schwelle 2 m rechts");
    expect(h).toContain("auf der Grundlinie · ohne Überschießen eingedreht · keine S-Kurven");
    expect(h).toContain("Speed (MAD)");
    expect(h).toContain("geflogene Referenz ≈ 128 kt – misst die Stabilität, nicht den Absolutwert");
    expect(h).toContain(">GEM.<");
    expect(h).toContain(">ABGEL.<");
    expect(h).toContain("FAF ✓ · 1000 ✓ · 500 ✓");
    // established, configuration, no exceedance
    expect(h).toContain("5,0 nm · 1 652 ft");
    expect(h).toContain("Fahrwerk aus 1 904 ft");
    expect(h).toContain("Klappen 3→4 1 505 ft");
    expect(h).toContain("Keine Überschreitung zwischen 1 000 und 50 ft");
    expect(h).not.toContain("Tiefster Punkt");
  });

  it("lists exceedances with level, heights, duration and peak", () => {
    const a: ApproachAnalysis = {
      ...mock,
      band: "unstableBelow500",
      exceedances: [
        { kind: "verticalSpeed", level: "s2", startTMs: 0, endTMs: 6000, durationS: 6, startHatFt: 420, endHatFt: 340, peak: -1450, limit: -1200, below500: true },
      ],
    };
    const h = html(a);
    expect(h).toContain("instabil unter 500 ft");
    expect(h).toContain("var(--aband-unstable)");
    expect(h).toContain("Sinkrate");
    expect(h).toContain("S2");
    expect(h).toContain("zwischen 420 und 340 ft");
    expect(h).toContain("−1 450 fpm (−1 200 fpm)");
  });

  it("go-around: positive sentence and the lowest point", () => {
    const a: ApproachAnalysis = {
      ...mock,
      outcome: { kind: "goAround" },
      elevationSource: "database",
      goAround: { detectedBy: "both", lowestTMs: 0, lowestHatFt: 284, lowestMslFt: 648, lowestTrackDistM: 1500, lowestXM: -1500, climbTMs: 1, phaseTMs: 2, climbFt: 620, maxPitchDeg: 15, minIasKt: 126 },
    };
    const h = html(a);
    expect(h).toContain("Durchstarten bei 284 ft nach stabilem Anflug – richtige Entscheidung.");
    expect(h).toContain(">Durchstarten<");
    expect(h).toContain("Tiefster Punkt");
    expect(h).toContain("284 ft über Platzhöhe (648 ft MSL) · 0,8 nm vor der Schwelle");
    expect(h).toContain("+620 ft in 60 s");
  });

  it("lateral hero without a value when the runway was derived from the track", () => {
    const a: ApproachAnalysis = { ...mock, runway: { ...mock.runway!, source: "derived" }, lateral: { ...mock.lateral!, measurable: false, lateralBand: null } };
    const h = html(a);
    expect(h).toContain("Grundlinie (RMS)");
    expect(h).toContain("Piste aus Rollspur – nicht bewertbar");
    expect(h).not.toContain("0,05");
  });

  it("shows a reason when the approach cannot be assessed", () => {
    const h = N(renderToStaticMarkup(<ApproachSection status={{ kind: "error", reason: "kein Track gespeichert" }} />));
    expect(h).toContain("Anflug nicht auswertbar");
    expect(h).toContain("kein Track gespeichert");
  });
});

describe("StabilisedTable (approach gates)", () => {
  it("shows five gates, limits per cell, unmeasurable reasons and the time outside", () => {
    const h = N(renderToStaticMarkup(<StabilisedTable approach={mock} />));
    for (const g of ["10 nm", "FAF", "1 000 ft", "500 ft", "50 ft"]) expect(h).toContain(g);
    expect(h).toContain("nur Werte");
    expect(h).toContain("5 nm zuerst");
    expect(h).toContain("bei 10 nm nicht eingedreht");
    expect(h).toContain("≤ 250 kt IAS");
    expect(h).toContain("Kurs (Lokalizer)");
    expect(h).toContain("±1 Dot zum 3°-Pfad");
    expect(h).toContain("Stufe 4 (Landeklappen)");
    expect(h).toContain("+16 kt (144 kt)");
    expect(h).toContain("Zeit außerhalb Toleranz");
    expect(h).not.toContain("✗");
  });
  it("marks a gate that was never reached", () => {
    const a: ApproachAnalysis = { ...mock, gates: mock.gates.map((g) => (g.kind === "ft50" ? { ...g, reached: false, sample: null } : g)) };
    expect(N(renderToStaticMarkup(<StabilisedTable approach={a} />))).toContain("nicht erreicht");
  });
});

describe("selectApproach", () => {
  const ga: ApproachAnalysis = { ...mock, index: 0, outcome: { kind: "goAround" } };
  const landed: ApproachAnalysis = { ...mock, index: 1, outcome: { kind: "landed", touchdownIndex: 0 } };
  it("prefers the pick, then the shown touchdown, then the last", () => {
    expect(selectApproach([ga, landed], 0, 0, true)?.index).toBe(0);
    expect(selectApproach([ga, landed], null, 0, true)?.index).toBe(1);
    expect(selectApproach([landed, ga], null, 3, true)?.index).toBe(0);
    expect(selectApproach([ga], null, null, true)?.index).toBe(0);
  });
  it("waits for the landing analysis without a pick", () => {
    expect(selectApproach([ga, landed], null, null, false)).toBeNull();
    expect(selectApproach([], null, 0, true)).toBeNull();
  });
});
