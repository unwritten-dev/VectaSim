// Local-time cases need a fixed zone; Node re-reads TZ when it is assigned.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = "Europe/Berlin";

import { afterEach, describe, expect, it } from "vitest";
import * as legacy from "../format";
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

// Every input of format.test.ts: with lang "de" the i18n helpers must return exactly what
// format.ts returns today, so the migration can switch imports without visible change.
describe("golden: de output equals format.ts", () => {
  const nums: Array<[number | null | undefined, number?]> = [[61959], [1000], [999], [1234567], [1.25, 2], [-1800], [-0.2], [-0], [null], [undefined], [Number.NaN], [-1.5, 1], [0.005, 2], [-0.004, 2]];
  it("fmtNum", () => {
    for (const [v, d] of nums) expect(n.fmtNum(v, d, "de")).toBe(legacy.fmtNum(v, d));
  });
  it("fmt with units", () => {
    const cases: Array<[number | null, number, string]> = [[61959, 0, "kg"], [412, 0, " kt"], [112, 0, "°"], [4, 0, "×"], [null, 0, "kg"], [Number.NaN, 0, ""], [-1.5, 1, ""], [3.5, 1, "′"]];
    for (const [v, d, u] of cases) expect(n.fmt(v, d, u, "de")).toBe(legacy.fmt(v, d, u));
  });
  it("fmtSigned", () => {
    for (const v of [4260, -112, 0, -0.2, 0.4, 1234.5, null]) expect(n.fmtSigned(v, 0, "fpm", "de")).toBe(legacy.fmtSigned(v, 0, "fpm"));
    expect(n.fmtSigned(-0.25, 1, "g", "de")).toBe(legacy.fmtSigned(-0.25, 1, "g"));
  });
  it("fmtAltitude", () => {
    for (const v of [35000, 12000, 5000, 4500, 1500, null]) expect(n.fmtAltitude(v, undefined, "de")).toBe(legacy.fmtAltitude(v));
    expect(n.fmtAltitude(12000, 18000, "de")).toBe(legacy.fmtAltitude(12000, 18000));
  });
  it("fmtCoord", () => {
    expect(n.fmtCoord(50.0333, 8.5706, 3, "de")).toBe(legacy.fmtCoord(50.0333, 8.5706));
    expect(n.fmtCoord(-33.9, -151.2, 1, "de")).toBe(legacy.fmtCoord(-33.9, -151.2, 1));
    expect(n.fmtCoord(null, 1, 3, "de")).toBe(legacy.fmtCoord(null, 1));
  });
  it("fmtDuration", () => {
    const ms = [0, 43 * S, 59 * S + 999, 5 * MIN + 3 * S, 7 * MIN + 43 * S, 59 * MIN + 59 * S, 60 * MIN, 65 * MIN + 30 * S, 26 * H + 30 * MIN, 1234 * H + 5 * MIN, -5, null, undefined];
    for (const v of ms) {
      expect(n.fmtDuration(v, {}, "de")).toBe(legacy.fmtDuration(v));
      expect(n.fmtDuration(v, { seconds: false }, "de")).toBe(legacy.fmtDuration(v, { seconds: false }));
    }
  });
  it("fmtDeltaMin", () => {
    const pairs: Array<[number | null, number]> = [[85 * MIN, 78 * MIN], [66 * MIN, 78 * MIN], [78 * MIN + 20 * S, 78 * MIN], [2 * H + 5 * MIN, H], [null, H]];
    for (const [a, p] of pairs) expect(n.fmtDeltaMin(a, p, "de")).toBe(legacy.fmtDeltaMin(a, p));
  });
  it("weights in kg and lb", () => {
    for (const unit of ["kg", "lb"] as const) {
      setWeightUnit(unit);
      for (const v of [61959, 61959.4, 1000, 78000, null]) {
        expect(n.fmtWeight(v, undefined, "de")).toBe(legacy.fmtWeight(v));
        expect(n.fmtWeightNum(v, undefined, "de")).toBe(legacy.fmtWeightNum(v));
      }
      for (const [a, p] of [[4200, 5434], [5500, 5400], [5400.2, 5400], [5400.1, 5400]]) expect(n.fmtDeltaKg(a, p, undefined, "de")).toBe(legacy.fmtDeltaKg(a, p));
    }
  });
  it("dates in UTC and local time", () => {
    const ms = Date.UTC(2026, 9, 17, 14, 30, 22);
    const late = Date.UTC(2026, 9, 17, 23, 15, 0);
    for (const v of [ms, late, 0, null]) {
      expect(n.fmtDate(v, { lang: "de" })).toBe(legacy.fmtDate(v));
      expect(n.fmtDate(v, { lang: "de", local: true })).toBe(legacy.fmtDate(v, { local: true }));
      expect(n.fmtDateTime(v, { lang: "de" })).toBe(legacy.fmtDateTime(v));
    }
    setTimeLocal(true);
    expect(n.fmtDateTime(late, { lang: "de" })).toBe(legacy.fmtDateTime(late));
  });
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
