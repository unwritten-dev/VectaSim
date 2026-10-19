// Logbook flight strip in both languages: the screen-reader label (stripLabel) and the
// rendered strip (badges, tooltips).

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import FlightStrip, { stripLabel } from "./FlightStrip";
import { I18nProvider, setLanguageSetting } from "./i18n";
import type { FlightRow } from "./types";

afterEach(() => setLanguageSetting("system"));

const integrity = { pausedMs: 0, pauseCount: 0, slewDetected: false, timeAccelerationDetected: false, maxSimRate: 1, crashed: false, fuelIncreasedAirborne: false };

function row(over: Partial<FlightRow> = {}): FlightRow {
  return {
    id: "x",
    state: "completed",
    phase: "shutdown",
    createdMs: Date.UTC(2026, 9, 17, 14, 30),
    updatedMs: 0,
    offBlockMs: Date.UTC(2026, 9, 17, 14, 30),
    onBlockMs: Date.UTC(2026, 9, 17, 16, 35),
    maxAltMslFt: 0,
    distanceNm: 0,
    aircraft: { title: "PMDG 737-800", atcModel: "B738", atcType: "Boeing", atcId: "D-ABCD", atcAirline: "Condor", atcFlightNumber: "1234" },
    provider: "simconnect",
    depIcao: "EDDF",
    arrIcao: "LEPA",
    callsign: "CFG1234",
    hasOfp: false,
    integrity,
    landingVsFpm: -650,
    landingCount: 1,
    rating: 4,
    ...over,
  };
}

const NARROW = new RegExp(`[${String.fromCharCode(0x202f, 0xa0)}]`, "g");
const plain = (s: string) => s.replace(NARROW, " ").split(String.fromCharCode(0x2212)).join("-");

describe("stripLabel", () => {
  it("reads the strip in German", () => {
    setLanguageSetting("de");
    const label = plain(stripLabel(row(), { band: "stable", stableFromFt: 1500, goArounds: 1, runwayIdent: "24" }, []));
    expect(label).toBe(
      "CFG1234, B738, EDDF nach LEPA 24, 17.10.2026, Block 2 h 05 min, Landung -650 fpm, harte Landung, stabil ab 1 500 ft, 1× durchgestartet, Bewertung 4 von 5 Sternen",
    );
  });

  it("reads the strip in English", () => {
    setLanguageSetting("en");
    const label = plain(stripLabel(row({ state: "interrupted" }), { band: "stable", stableFromFt: 1500, goArounds: 2 }, []));
    expect(label).toBe(
      "CFG1234, B738, EDDF to LEPA, 17 Oct 2026, block 2 h 05 min, landing -650 fpm, hard landing, stable from 1,500 ft, 2 go-arounds, incomplete, rated 4 of 5 stars",
    );
    expect(plain(stripLabel(row({ landingVsFpm: null, arrIcao: null, state: "active" }), null, []))).toContain("EDDF to destination open");
  });
});

describe("FlightStrip", () => {
  const render = (lang: "de" | "en", f: FlightRow) =>
    renderToStaticMarkup(
      <I18nProvider lang={lang}>
        <FlightStrip flight={f} selected={false} tabIndex={0} onSelect={() => {}} onDebrief={() => {}} />
      </I18nProvider>,
    );

  it("shows the state badge and the debrief hint in the pinned language", () => {
    setLanguageSetting("de");
    expect(render("de", row({ state: "interrupted" }))).toContain(">unterbrochen<");
    expect(render("de", row())).toContain("Landeauswertung öffnen (Eingabetaste)");
    const en = render("en", row({ state: "interrupted", provider: "mock" }));
    expect(en).toContain(">interrupted<");
    expect(en).toContain("Open the landing debrief (Enter)");
    expect(en).toContain(">Demo<");
    // the screen-reader label follows the pinned language too
    expect(en).toContain("EDDF to LEPA");
  });
});
