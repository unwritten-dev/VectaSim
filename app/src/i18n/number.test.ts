// Local-time cases need a fixed zone; Node re-reads TZ when it is assigned.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = "Europe/Berlin";

import { afterEach, describe, expect, it } from "vitest";
import { MINUS, NNBSP, setTimeLocal, setWeightUnit } from "../format";
import { setLanguageSetting } from "./lang";
import * as n from "./number";

/** Write expectations with plain spaces / "-"; compare against the typographic output (de). */
const de = (s: string) => s.replace(/ /g, NNBSP).replace(/-/g, MINUS);
/** en: only the unit gap is a narrow space; the minus stays a hyphen-minus. */
const en = (s: string) => s.replace(/ /g, NNBSP);
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;

afterEach(() => {
  setTimeLocal(false);
  setWeightUnit("kg");
  setLanguageSetting("de");
});

// The full German reference set (thousands, durations, deltas, dates, weights) lives in
// format.test.ts and runs against this module; the parity tests against the removed German
// copies in format.ts are gone with them.
describe("de output", () => {
  it("the reference strings themselves", () => {
    expect(n.fmt(1500, 0, "ft", "de")).toBe(de("1 500 ft"));
    expect(n.fmtSigned(-155, 0, "fpm", "de")).toBe(de("-155 fpm"));
    expect(n.fmtNum(1.25, 2, "de")).toBe("1,25");
  });
});

describe("en output", () => {
  it("comma grouping, decimal point, hyphen-minus", () => {
    expect(n.fmtNum(61959, 0, "en")).toBe("61,959");
    expect(n.fmtNum(1234567, 0, "en")).toBe("1,234,567");
    expect(n.fmtNum(999, 0, "en")).toBe("999");
    expect(n.fmtNum(1.25, 2, "en")).toBe("1.25");
    expect(n.fmtNum(-1800, 0, "en")).toBe("-1,800");
    expect(n.fmtNum(-0.2, 0, "en")).toBe("0");
    expect(n.fmtNum(null, 0, "en")).toBe("–");
  });
  it("units keep the narrow gap, ° stays glued", () => {
    expect(n.fmt(1500, 0, "ft", "en")).toBe(en("1,500 ft"));
    expect(n.fmt(112, 0, "°", "en")).toBe("112°");
    expect(n.fmtSigned(-155, 0, "fpm", "en")).toBe(en("-155 fpm"));
    expect(n.fmtSigned(4260, 0, "fpm", "en")).toBe(en("+4,260 fpm"));
    expect(n.fmtSigned(0, 0, "fpm", "en")).toBe(en("±0 fpm"));
    expect(n.fmtAltitude(4500, undefined, "en")).toBe(en("4,500 ft"));
    expect(n.fmtAltitude(35000, undefined, "en")).toBe("FL350");
    expect(n.fmtCoord(50.0333, 8.5706, 3, "en")).toBe("50.033° N 8.571° E");
  });
  it("durations and deltas", () => {
    expect(n.fmtDuration(1234 * H + 5 * MIN, {}, "en")).toBe(en("1,234 h 05 min"));
    expect(n.fmtDuration(7 * MIN + 43 * S, {}, "en")).toBe(en("7 min 43 s"));
    expect(n.fmtDeltaMin(66 * MIN, 78 * MIN, "en")).toBe(en("-12 min"));
    expect(n.fmtDeltaKg(4200, 5434, "kg", "en")).toBe(en("-1,234 kg"));
    expect(n.fmtWeight(1000, "lb", "en")).toBe(en("2,205 lb"));
  });
  it("dates as day month year, clock unchanged; UTC/local switch still applies", () => {
    const ms = Date.UTC(2026, 9, 17, 14, 30, 22);
    const late = Date.UTC(2026, 9, 17, 23, 15, 0);
    expect(n.fmtDate(ms, { lang: "en" })).toBe("17 Oct 2026");
    expect(n.fmtDate(Date.UTC(2026, 0, 5), { lang: "en" })).toBe("5 Jan 2026");
    expect(n.fmtDate(late, { lang: "en", local: true })).toBe("18 Oct 2026");
    expect(n.fmtDateTime(ms, { lang: "en" })).toBe("17 Oct 2026 14:30z");
    setTimeLocal(true);
    expect(n.fmtDateTime(ms, { lang: "en" })).toBe("17 Oct 2026 16:30");
  });
});

describe("default language", () => {
  it("follows the active language setting", () => {
    setLanguageSetting("en");
    expect(n.fmt(1500, 0, "ft")).toBe(en("1,500 ft"));
    expect(n.fmtDate(Date.UTC(2026, 9, 17))).toBe("17 Oct 2026");
    setLanguageSetting("de");
    expect(n.fmt(1500, 0, "ft")).toBe(de("1 500 ft"));
    expect(n.fmtDate(Date.UTC(2026, 9, 17))).toBe("17.10.2026");
  });
});
