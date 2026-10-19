// Approach assessment stage 2 (track v2): sim ILS, sim wind, thrust / spoilers / landing flaps,
// Vapp cascade, energy band, automation – hints, source labels and the approach card.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLanguageSetting } from "../i18n";
import { NNBSP } from "../format";
import mockJson from "./fixtures/approach-mock.json";
import type { ApproachAnalysis, ApproachCriterion, IlsStats, WindStats } from "./approachTypes";
import {
  approachHints,
  approachProvenance,
  automationText,
  criterionHint,
  energyBandText,
  glidepathLabel,
  ilsHints,
  ilsProtocolText,
  limitText,
  measuredText,
  simWindComponentsText,
  simWindText,
  vappSourceLabel,
  windHints,
  windProtocolText,
} from "./facts";
import ApproachSection from "./ApproachSection";
import ApproachCard, { windLine } from "./ApproachCard";
import { themeCardColors } from "./LandingCard";
import { approachCardFileName, autoApproachCardFileName } from "./exportApproachCard";
import { parseLandingFlaps } from "../airframes/airframe";

const mock = mockJson as unknown as ApproachAnalysis;
const N = (s: string) => s.split(NNBSP).join(" ");
const copy = (over: Partial<ApproachAnalysis> = {}): ApproachAnalysis => ({ ...(JSON.parse(JSON.stringify(mock)) as ApproachAnalysis), ...over });
const texts = (a: ApproachAnalysis) => approachHints(a).map((h) => N(h.text));
const wind = (over: Partial<WindStats>): WindStats => ({ ...mock.wind!, ...over });
const ils = (over: Partial<IlsStats>): IlsStats => ({ ...mock.ils!, ...over });
const v1 = () =>
  copy({ reference: { ...mock.reference, glidepathSource: "assumed", localizerSource: "geometric", vs0Kt: null, vappPlausible: null }, ils: null, wind: null, automation: null });

// the expectations are German; jsdom reports en-US
beforeEach(() => setLanguageSetting("de"));
afterEach(() => setLanguageSetting("de"));

describe("sim ILS as the reference", () => {
  it("labels the reference path with its source", () => {
    expect(N(glidepathLabel(mock.reference))).toBe("3,0° (ILS)");
    expect(N(glidepathLabel({ glidepathDeg: 3, glidepathSource: "assumed" }))).toBe("3°-Annahme");
    expect(N(glidepathLabel({ glidepathDeg: 3.2, glidepathSource: "ils" }))).toBe("3,2° (ILS)");
  });
  it("chips: SIM with the ILS, ABGEL. with the geometry, and why the sim's ILS was not taken", () => {
    const p = approachProvenance(mock);
    expect(p.glidepath.kind).toBe("sim");
    expect(N(p.glidepath.detail)).toContain("NAV GLIDE SLOPE ERROR");
    expect(N(p.glidepath.detail)).toContain("3,0°");
    expect(p.lateral.kind).toBe("sim");
    expect(N(p.lateral.detail)).toContain("NAV CDI");
    const geo = approachProvenance(v1());
    expect([geo.glidepath.kind, geo.lateral.kind]).toEqual(["derived", "derived"]);
    const rejected = copy({ reference: { ...mock.reference, glidepathSource: "assumed" }, ils: ils({ gsUsed: false, gsRejected: true, mismatch: true, gsDiffDots: 4 }) });
    expect(N(approachProvenance(rejected).glidepath.detail)).toContain("passt nicht zu dieser Piste");
    const weak = copy({ reference: { ...mock.reference, glidepathSource: "assumed" }, ils: ils({ gsUsed: false, gsShare: 0.4 }) });
    expect(N(approachProvenance(weak).glidepath.detail)).toContain("nur über 40 % der Samples empfangen (mindestens 60 % nötig)");
  });
  it("hints when sim ILS and geometry disagree, and when the ILS belongs to another runway", () => {
    expect(ilsHints(mock)).toEqual([]);
    const off = copy({ ils: ils({ mismatch: true, gsDiffDots: 0.7, locDiffDots: 0.1 }) });
    expect(ilsHints(off).map((h) => [h.tone, N(h.text)])).toEqual([["warn", "Sim-ILS und Geometrie weichen ab (Pistenkoordinaten prüfen) – Median Gleitpfad 0,7 Dots, Kurs 0,1 Dots"]]);
    expect(texts(off)).toContain("Sim-ILS und Geometrie weichen ab (Pistenkoordinaten prüfen) – Median Gleitpfad 0,7 Dots, Kurs 0,1 Dots");
    const foreign = copy({ ils: ils({ gsUsed: false, locUsed: false, gsRejected: true, locRejected: true, mismatch: true }) });
    expect(N(ilsHints(foreign)[0].text)).toBe("ILS des Simulators passt nicht zu RWY 25C (Gleitpfad und Localizer) – anderes ILS gerastet? Bewertet wurde geometrisch");
    expect(ilsHints(v1())).toEqual([]);
  });
  it("shows both sources in the protocol", () => {
    const t = N(ilsProtocolText(mock)!);
    expect(t).toContain("Gleitpfad: Sim RMS 0,12 / Geometrie 0,12 Dots");
    expect(t).toContain("empfangen 100 %, 3,0° – Sim verwendet");
    expect(t).toContain("Localizer: Sim RMS");
    expect(ilsProtocolText(v1())).toBeNull();
  });
});

describe("sim wind in the final", () => {
  it("formats the wind and its components next to the METAR", () => {
    expect(N(simWindText(mock.wind)!)).toBe("250°/8 kt");
    expect(N(simWindComponentsText(mock.wind)!)).toBe("Gegenwind 8 kt · kein Seitenwind");
    expect(N(simWindText(wind({ gustSpreadKt: 6, speedKt: 14 }))!)).toBe("250°/14 kt (Spanne 6 kt)");
    expect(N(simWindComponentsText(wind({ headwindKt: -6, crosswindKt: -9 }))!)).toBe("Rückenwind 6 kt · Seitenwind 9 kt von links");
    expect(simWindText(null)).toBeNull();
    expect(N(windProtocolText(mock)!)).toContain("AMBIENT WIND am Flugzeug");
  });
  it("hints at tailwind > 5 kt, crosswind > 15 kt and shear > 15 kt only", () => {
    expect(windHints(mock)).toEqual([]);
    const bad = copy({ wind: wind({ headwindKt: -7, crosswindKt: 17, shearKt: 22, headwindChangeKt: 18, topDirTrueDeg: 70, topKt: 12, bottomDirTrueDeg: 250, bottomKt: 9 }) });
    const t = windHints(bad).map((h) => N(h.text));
    expect(t).toEqual([
      "Rückenwind 7 kt im Endanflug (Sim-Wind, Median 1 000 → 50 ft) – über 5 kt",
      "Seitenwind 17 kt von rechts im Endanflug (Sim-Wind) – über 15 kt",
      "Windscherung: Wind ändert sich zwischen 1 000 ft und der Schwelle um 22 kt (70°/12 kt → 250°/9 kt), Gegenwind nimmt um 18 kt zu",
    ]);
    // exactly at the limits: no hint
    expect(windHints(copy({ wind: wind({ headwindKt: -5, crosswindKt: -15, shearKt: 15 }) }))).toEqual([]);
  });
});

describe("thrust, spoilers and landing flaps", () => {
  const c = (kind: ApproachCriterion["kind"], status: ApproachCriterion["status"], measured: number | null, limitMin: number | null, limitMax: number | null, reference: number | null = null): ApproachCriterion => ({
    kind,
    status,
    measured,
    limitMin,
    limitMax,
    reference,
  });
  it("names limits, values and failures", () => {
    expect(N(limitText(c("thrust", "pass", 44, 40, null), "approach"))).toBe("N1 ≥ 40 %");
    expect(N(limitText(c("spoilers", "pass", 0, null, 2), "approach"))).toBe("≤ 2 % ausgefahren");
    expect(N(limitText(c("landingFlaps", "pass", 3, 3, null, 3), "approach"))).toBe("Stufe 3 (Landeklappen)");
    expect(N(measuredText(c("thrust", "pass", 43.6, 40, null), "approach"))).toBe("44 % N1");
    expect(N(measuredText(c("spoilers", "pass", 0, null, 2), "approach"))).toBe("eingefahren");
    expect(N(measuredText(c("spoilers", "fail", 30, null, 2), "approach"))).toBe("30 % ausgefahren");
    expect(N(measuredText(c("thrust", "unavailable", null, 40, null), "approach"))).toBe("n. v.");
    expect(N(criterionHint("bei 500 ft", c("thrust", "fail", 25, 40, null), "approach")!)).toBe("Schub bei 500 ft 25 % N1 – unter 40 % (Leerlauf statt Anflugschub)");
    expect(N(criterionHint("bei 1 000 ft", c("spoilers", "fail", 30, null, 2), "approach")!)).toBe("Spoiler bei 1 000 ft 30 % ausgefahren – im Endanflug eingefahren erwartet");
    expect(N(criterionHint("bei 1 000 ft", c("landingFlaps", "fail", 3, 4, null, 4), "approach")!)).toBe("Klappen bei 1 000 ft auf Stufe 3 – Landeklappen (Stufe 4) erwartet");
    expect(criterionHint("bei 1 000 ft", c("thrust", "unavailable", null, 40, null), "approach")).toBeNull();
  });
  it("the mock's gates carry them, a v1 track does not", () => {
    const g = mock.gates.find((x) => x.kind === "ft1000")!;
    expect(g.criteria.map((x) => x.kind)).toEqual(["gear", "landingFlaps", "verticalSpeed", "speed", "glidepath", "localizer", "bank", "thrust", "spoilers"]);
    const h = N(renderToStaticMarkup(<ApproachSection status={{ kind: "ok", approach: mock }} />));
    expect(h).toContain("Landeklappen Stufe 4");
  });
  it("parses the landing flaps field of the fleet", () => {
    expect(parseLandingFlaps("")).toBeNull();
    expect(parseLandingFlaps(" 3 ")).toBe(3);
    expect(parseLandingFlaps("0")).toBe(0);
    expect(parseLandingFlaps("11")).toBeUndefined();
    expect(parseLandingFlaps("2,5")).toBeUndefined();
    expect(parseLandingFlaps("-1")).toBeUndefined();
  });
});

describe("Vapp cascade, energy band, automation", () => {
  it("names the reference speed source, the VS0 assumption included", () => {
    expect(vappSourceLabel(mock)).toBe("geflogener Median");
    const design = copy({ reference: { ...mock.reference, vappSource: "design", vappKt: 135.2, vs0Kt: 104, vappPlausible: null } });
    expect(N(vappSourceLabel(design))).toBe("Annahme (VS0×1,3)");
    expect(texts(design)).toContain("Referenz-Speed 135 kt ist eine Annahme: 1,3 × VS0 (104 kt) – keine eingetragene Vapp, kein geflogener Wert");
    expect(N(approachProvenance(design).speed.detail)).toContain("Annahme: 1,3 × VS0 (104 kt");
    expect(N(renderToStaticMarkup(<ApproachSection status={{ kind: "ok", approach: design }} />))).toContain("Annahme (VS0×1,3)");
  });
  it("energy band as a fact line and a hint when high or low", () => {
    expect(N(energyBandText(mock)!)).toBe("im Profil · +51 … +260 ft (Grenzen −300/+500 ft) · TAS vom Sim");
    const high = copy({ energy: { ...mock.energy!, band: "high", bandMaxFt: 640 } });
    expect(texts(high)).toContain("Energie zwischen 10 nm und 1 000 ft zu hoch: bis +640 ft zum Profil (Schwelle +500 ft)");
    expect(texts(mock).some((t) => t.startsWith("Energie zwischen"))).toBe(false);
    expect(energyBandText(copy({ energy: { ...mock.energy!, band: null } }))).toBeNull();
  });
  it("automation is information only", () => {
    expect(N(automationText(mock)!)).toBe("Autopilot bis 800 ft, danach manuell · A/THR bis 30 ft · APPR-Modus");
    expect(texts(mock)).toContain("Autopilot bis 800 ft, danach manuell · A/THR bis 30 ft · APPR-Modus");
    const auto = copy({ automation: { ...mock.automation!, autopilotOffHatFt: null, autopilotAtEnd: true } });
    expect(N(automationText(auto)!)).toContain("Autopilot bis zum Aufsetzen (Autoland)");
    const manual = copy({ automation: { autopilotOffHatFt: null, autothrustOffHatFt: null, autopilotUsed: false, autothrustUsed: false } });
    expect(N(automationText(manual)!)).toBe("Anflug manuell geflogen (Autopilot aus) · Schub manuell");
    expect(automationText(v1())).toBeNull();
    // never a warning
    expect(approachHints(mock).filter((h) => h.text.includes("Autopilot")).every((h) => h.tone === "info")).toBe(true);
  });
  it("the section shows sim wind, energy band, automation and the card buttons", () => {
    const h = N(renderToStaticMarkup(<ApproachSection status={{ kind: "ok", approach: mock }} />));
    expect(h).toContain("Sim-Wind im Endanflug");
    expect(h).toContain("250°/8 kt · Gegenwind 8 kt · kein Seitenwind");
    expect(h).toContain("Energie 10 nm → 1 000 ft");
    expect(h).toContain("Automatik");
    expect(h).toContain("Kurs ILS (Sim)");
    expect(h).toContain("Anflugkarte speichern");
    expect(h).toContain("Anflugkarte kopieren");
    const old = N(renderToStaticMarkup(<ApproachSection status={{ kind: "ok", approach: v1() }} />));
    expect(old).not.toContain("Sim-Wind");
    expect(old).not.toContain("Automatik");
    expect(old).toContain("Kurs geometrisch");
  });
});

describe("ApproachCard", () => {
  const colors = themeCardColors();
  const flight = {
    aircraft: { title: "A320neo Lufthansa D-AINA", atcModel: "A20N", atcType: "A20N", atcId: "D-AINA", atcAirline: "Lufthansa", atcFlightNumber: "" },
    airframeReg: "D-AINA",
    callsign: "DLH4AB",
    simName: "MSFS 2024",
    provider: "simconnect",
  } as unknown as Parameters<typeof ApproachCard>[0]["flight"];

  it("renders a fixed 1200×675 SVG with concrete colours and the approach's texts", () => {
    const html = N(renderToStaticMarkup(<ApproachCard approach={mock} colors={colors} flight={flight} />));
    expect(html.startsWith("<svg")).toBe(true);
    expect(html).toContain('width="1200"');
    expect(html).toContain('height="675"');
    expect(html).not.toContain("var(--");
    expect(html).toContain("EDDF");
    expect(html).toContain("RWY 25C");
    expect(html).toContain("Auf dem Kurs ab 5,0 nm, stabil ab 1 500 ft.");
    expect(html).toContain(">stabil<");
    expect(html).toContain("GATES");
    for (const g of ["FAF", "1 000 ft", "500 ft"]) expect(html).toContain(g);
    expect(html).toContain("✓");
    expect(html).toContain("3,0° (ILS)");
    expect(html).toContain("HÖHE ZUM PFAD");
    expect(html).toContain("SPEED ZUR REFERENZ");
    expect(html).toContain(">KURS<");
    expect(html).toContain("Localizer (Sim)");
    expect(html).toContain("Sim-Wind 250°/8 kt · Gegenwind 8 kt · kein Seitenwind · Energie im Profil");
    expect(html).toContain(">SIM<");
    expect(html).toContain("D-AINA");
    expect(html).toContain("MSFS 2024");
    expect(html).toContain("<title>VectaSim</title>");
    expect(html).not.toContain("NaN");
  });
  it("en: texts and numbers in the UI language (English card)", () => {
    setLanguageSetting("en");
    const html = N(renderToStaticMarkup(<ApproachCard approach={mock} colors={colors} flight={flight} />));
    expect(html).toContain("HEIGHT TO PATH");
    expect(html).toContain("SPEED TO REFERENCE");
    expect(html).toContain(">LATERAL<");
    expect(html).toContain("Stable from");
    expect(html).toContain("Glide path (RMS)");
    expect(html).toContain("Lateral (RMS)");
    expect(html).toContain("Localiser (sim)");
    expect(html).toContain("1,500");
    expect(html).toContain("0.08");
    expect(html).toContain("Sim wind ");
    expect(html).toContain('aria-label="Approach card EDDF RWY 25C"');
    expect(html).not.toContain("HÖHE ZUM PFAD");
    expect(html).not.toContain("0,08");
    expect(html).not.toContain("NaN");
    // an explicit language wins over the UI language
    const de = N(renderToStaticMarkup(<ApproachCard approach={mock} colors={colors} flight={flight} lang="de" />));
    expect(de).toContain("HÖHE ZUM PFAD");
    expect(de).toContain("0,08");
    const a = copy({ endTMs: Date.UTC(2026, 9, 18, 14, 3, 20) });
    expect(approachCardFileName(a)).toBe("VectaSim_Approach_EDDF_25C_2026-10-18.png");
  });
  it("masks the registration in the Streamer-Modus", () => {
    const html = renderToStaticMarkup(<ApproachCard approach={mock} colors={colors} flight={flight} hideReg />);
    expect(html).not.toContain("D-AINA");
    expect(html).toContain("D-••••");
  });
  it("falls back for v1 tracks, go-arounds and approaches without runway", () => {
    const old = N(renderToStaticMarkup(<ApproachCard approach={v1()} colors={colors} />));
    expect(old).toContain("3°-Annahme");
    expect(old).toContain("Wind: nicht aufgezeichnet");
    expect(N(windLine(v1()))).toBe("Wind: nicht aufgezeichnet · Energie im Profil");
    const ga = copy({ outcome: { kind: "goAround" }, goAround: { detectedBy: "both", lowestTMs: mock.endTMs, lowestHatFt: 290, lowestMslFt: 654, lowestTrackDistM: 1700, lowestXM: -1700, climbTMs: null, phaseTMs: null, climbFt: 600, maxPitchDeg: 14, minIasKt: 128 } });
    expect(N(renderToStaticMarkup(<ApproachCard approach={ga} colors={colors} />))).toContain("Anflug · Durchstarten");
    const none = N(renderToStaticMarkup(<ApproachCard approach={copy({ runway: null, samples: [] })} colors={colors} />));
    expect(none).toContain("Zu wenige Trackpunkte für ein Anflugprofil");
    expect(none).not.toContain("var(--");
  });
  it("file names: VectaSim_Anflug_<ICAO>_<RWY>_<UTC date>[_HHmm].png, GA marked", () => {
    const a = copy({ endTMs: Date.UTC(2026, 9, 18, 14, 3, 20) });
    expect(approachCardFileName(a)).toBe("VectaSim_Anflug_EDDF_25C_2026-10-18.png");
    expect(autoApproachCardFileName(a)).toBe("VectaSim_Anflug_EDDF_25C_2026-10-18_1403.png");
    const ga = copy({ outcome: { kind: "goAround" }, runway: null, endTMs: Date.UTC(2026, 0, 2, 3, 4) });
    expect(approachCardFileName(ga)).toBe("VectaSim_Anflug_GA_2026-01-02.png");
  });
});
