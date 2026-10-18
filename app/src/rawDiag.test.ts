import { describe, expect, it } from "vitest";
import { diagPackageName, eventTone, fmtAge, fmtBytes, fmtConverted, fmtHz, fmtRaw } from "./rawDiag";
import type { VarDiag } from "./types";

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
