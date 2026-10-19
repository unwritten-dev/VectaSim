import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPLAY_SPEEDS, approachRows, connLabels, diagPackageName, eventTone, fmtAge, fmtBytes, fmtConverted, fmtHz, fmtRaw, hasApproachData } from "./rawDiag";
import type { Telemetry, VarDiag } from "./types";
import { NNBSP } from "./format";
import { setLanguageSetting } from "./i18n";

// the expectations below are the German reference texts
beforeAll(() => setLanguageSetting("de"));
afterAll(() => setLanguageSetting("de"));

const v = (p: Partial<VarDiag>): VarDiag => ({ name: "X", active: true, valueUnit: "", ...p });

describe("raw value view", () => {
  it("shows the raw value at full precision and strings quoted", () => {
    expect(fmtRaw(v({ raw: 50.04956095800978 }))).toBe("50.04956095800978");
    expect(fmtRaw(v({ raw: -2.5 }))).toBe("-2.5");
    expect(fmtRaw(v({ raw: null }))).toBe("–");
    expect(fmtRaw(v({ rawText: "TT:ATCCOM.AC_MODEL_A20N.0.text" }))).toBe("„TT:ATCCOM.AC_MODEL_A20N.0.text“");
    expect(fmtRaw(v({ rawText: "" }))).toBe("„“");
  });

  it("formats the converted value by its unit", () => {
    expect(fmtConverted(v({ value: 1, valueUnit: "bool" }))).toBe("ja");
    expect(fmtConverted(v({ value: 0, valueUnit: "bool" }))).toBe("nein");
    expect(fmtConverted(v({ value: 700, valueUnit: "Squawk" }))).toBe("0700");
    expect(fmtConverted(v({ name: "PLANE LATITUDE", value: 50.0451, valueUnit: "°" }))).toBe("50,045100°");
    expect(fmtConverted(v({ name: "PLANE PITCH DEGREES", value: -2.35, valueUnit: "°" }))).toBe("−2,4°");
    expect(fmtConverted(v({ value: -150, valueUnit: "fpm" }))).toBe("−150 fpm");
    expect(fmtConverted(v({ value: null, valueUnit: "kg" }))).toBe("–");
    expect(fmtConverted(v({ valueText: "A320", valueUnit: "Text" }))).toBe("A320");
  });

  it("age and rate", () => {
    expect(fmtAge(null)).toBe("–");
    expect(fmtAge(16)).toBe("16 ms");
    expect(fmtAge(4200)).toBe("4,2 s");
    expect(fmtAge(180_000)).toBe("3 min");
    expect(fmtHz(0)).toBe("–");
    expect(fmtHz(59.94)).toBe("60 Hz");
    expect(fmtHz(1)).toBe("1,0 Hz");
  });

  it("exceptions stand out", () => {
    expect(eventTone({ kind: "exception" })).toBe("err");
    expect(eventTone({ kind: "hr" })).toBe("err");
    expect(eventTone({ kind: "warning" })).toBe("warn");
    expect(eventTone({ kind: "event" })).toBe("info");
  });

  it("sizes", () => {
    expect(fmtBytes(115 * 1024)).toBe("115 KB");
    expect(fmtBytes(4.1 * 1024 * 1024)).toBe("4,1 MB");
  });

  it("diagnostic package name", () => {
    expect(diagPackageName(new Date(2026, 9, 8, 7, 5))).toBe("VectaSim-Diagnose_2026-10-08_0705.zip");
  });
});

describe("approach data (track v2)", () => {
  const base = { tasKt: 132.4 } as Telemetry;
  // the formatters put a narrow no-break space before units
  const rowsOf = (t: Telemetry) => Object.fromEntries(approachRows(t).map(([k, v]) => [k, v.split(NNBSP).join(" ")]));
  it("is absent without the approach definition", () => {
    expect(hasApproachData(base)).toBe(false);
    const rows = rowsOf(base);
    expect(rows["TAS"]).toBe("132 kt");
    expect(rows["ILS (NAV 1)"]).toBe("–");
    expect(rows["Autopilot"]).toBe("AP – · APPR – · G/S – · A/THR –");
  });

  it("lists wind, ILS, automation and configuration", () => {
    const t: Telemetry = {
      ...base,
      windDirTrueDeg: 250,
      windKt: 8,
      navHasLocalizer: true,
      navHasGlideSlope: true,
      navGsFlag: true,
      navGsErrorDeg: -0.12,
      navGsAngleDeg: 3,
      navCdi: 34,
      navRadialErrorDeg: -0.67,
      navLocCourseDeg: 246,
      autopilotMaster: true,
      autopilotApproachHold: true,
      autopilotGlideslopeHold: false,
      autothrottleActive: true,
      n1Pct: 45.5,
      flapPositions: 5,
      designVs0Kt: 104,
    };
    expect(hasApproachData(t)).toBe(true);
    const rows = rowsOf(t);
    expect(rows["Wind am Flugzeug (Sim, wahr)"]).toBe("250° / 8 kt");
    expect(rows["ILS (NAV 1)"]).toBe("LOC ja · GS ja · GS-Flag ja");
    expect(rows["Gleitpfad"]).toBe("Abweichung −0,12° · Winkel 3,00°");
    expect(rows["Localizer"]).toBe("CDI +34 · Ablage −0,67° · Kurs 246°");
    expect(rows["Autopilot"]).toBe("AP ein · APPR ein · G/S aus · A/THR ein");
    expect(rows["Klappenstufen"]).toBe("5 (Landeklappen = Index 4)");
    expect(rows["Design-Speeds"]).toBe("VS0 104 kt · VS1 – · VC –");
  });
});

describe("connection labels", () => {
  it("uses SimConnect terms only for SimConnect", () => {
    expect(connLabels("simconnect")).toEqual({ origin: "SimConnect.dll", sim: "Simulator (RECV_OPEN)", api: "SimConnect-Version", simconnect: true });
    for (const s of ["xplane", "replay", undefined, null, "mock"]) {
      const l = connLabels(s);
      expect(l.simconnect).toBe(false);
      expect(`${l.origin} ${l.sim} ${l.api}`).not.toMatch(/SimConnect|RECV_OPEN/);
    }
    expect(connLabels("xplane").api).toBe("Web-API-Version");
    expect(connLabels("replay").origin).toBe("Datei");
  });
});

describe("in English", () => {
  it("translates labels and values, keeps the units", () => {
    setLanguageSetting("en");
    try {
      expect(fmtConverted(v({ value: 1, valueUnit: "bool" }))).toBe("yes");
      expect(fmtConverted(v({ name: "PLANE PITCH DEGREES", value: -2.35, valueUnit: "°" }))).toBe("-2.4°");
      expect(fmtAge(4200)).toBe("4.2 s");
      expect(connLabels("replay")).toMatchObject({ origin: "File", api: "Interface" });
      expect(REPLAY_SPEEDS.map((s) => s.label)).toEqual(["Real time (1×)", "10×", "60×", "as fast as possible"]);
      const rows = Object.fromEntries(
        approachRows({ tasKt: 132.4, navHasLocalizer: true, navHasGlideSlope: false, flapPositions: 5 } as Telemetry).map(([k, val]) => [k, val.split(NNBSP).join(" ")]),
      );
      expect(rows["ILS (NAV 1)"]).toBe("LOC yes · GS no · GS flag –");
      expect(rows["Flap positions"]).toBe("5 (landing flaps = index 4)");
    } finally {
      setLanguageSetting("de");
    }
  });
});
