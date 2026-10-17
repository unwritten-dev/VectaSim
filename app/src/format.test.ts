// Local-time cases need a fixed zone; Node re-reads TZ when it is assigned.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = "Europe/Berlin";

import { afterEach, describe, expect, it } from "vitest";
import {
  MINUS,
  NNBSP,
  deltaMinutes,
  fmt,
  fmtAltitude,
  fmtClock,
  fmtCoord,
  fmtDate,
  fmtDateTime,
  fmtDeltaKg,
  fmtDeltaMin,
  fmtDuration,
  fmtNum,
  fmtSigned,
  setTimeLocal,
} from "./format";

/** Write expectations with plain spaces / "-"; compare against the typographic output. */
const t = (s: string) => s.replace(/ /g, NNBSP).replace(/-/g, MINUS);
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;

afterEach(() => setTimeLocal(false));

describe("fmtDuration", () => {
  it("never renders m:ss", () => {
    expect(fmtDuration(7 * MIN + 43 * S)).toBe(t("7 min 43 s"));
    expect(fmtDuration(7 * MIN + 43 * S)).not.toMatch(/^\d+:\d\d$/);
  });
  it("seconds only below a minute", () => {
    expect(fmtDuration(0)).toBe(t("0 s"));
    expect(fmtDuration(43 * S)).toBe(t("43 s"));
    expect(fmtDuration(59 * S + 999)).toBe(t("59 s"));
  });
  it("pads seconds under an hour", () => {
    expect(fmtDuration(5 * MIN + 3 * S)).toBe(t("5 min 03 s"));
  });
  it("switches to h + min exactly at 60 min", () => {
    expect(fmtDuration(59 * MIN + 59 * S)).toBe(t("59 min 59 s"));
    expect(fmtDuration(59 * MIN + 59 * S + 999)).toBe(t("59 min 59 s"));
    expect(fmtDuration(60 * MIN)).toBe(t("1 h 00 min"));
    expect(fmtDuration(65 * MIN + 30 * S)).toBe(t("1 h 05 min"));
  });
  it("keeps counting hours beyond 24 h (no days)", () => {
    expect(fmtDuration(26 * H + 30 * MIN)).toBe(t("26 h 30 min"));
    expect(fmtDuration(1234 * H + 5 * MIN)).toBe(t("1 234 h 05 min"));
  });
  it("can drop seconds for totals", () => {
    expect(fmtDuration(7 * MIN + 43 * S, { seconds: false })).toBe(t("7 min"));
    expect(fmtDuration(2 * H + 7 * MIN, { seconds: false })).toBe(t("2 h 07 min"));
  });
  it("placeholders for missing or negative values", () => {
    expect(fmtDuration(null)).toBe("–");
    expect(fmtDuration(undefined)).toBe("–");
    expect(fmtDuration(-5)).toBe("–");
  });
});

describe("numbers", () => {
  it("groups thousands with a narrow no-break space", () => {
    expect(fmtNum(61959)).toBe(t("61 959"));
    expect(fmtNum(1000)).toBe(t("1 000"));
    expect(fmtNum(999)).toBe("999");
    expect(fmtNum(1234567)).toBe(t("1 234 567"));
  });
  it("uses a decimal comma and a real minus sign", () => {
    expect(fmtNum(1.25, 2)).toBe("1,25");
    expect(fmtNum(-1800)).toBe(t("-1 800"));
    expect(fmtNum(-1800)).toContain("−");
    expect(fmtNum(-1800)).not.toContain("-");
  });
  it("drops the sign of values that round to zero", () => {
    expect(fmtNum(-0.2)).toBe("0");
    expect(fmtNum(-0)).toBe("0");
  });
  it("puts a narrow space before units, none before ° and ×", () => {
    expect(fmt(61959, 0, "kg")).toBe(t("61 959 kg"));
    expect(fmt(412, 0, " kt")).toBe(t("412 kt"));
    expect(fmt(112, 0, "°")).toBe("112°");
    expect(fmt(4, 0, "×")).toBe("4×");
    expect(fmt(null, 0, "kg")).toBe("–");
    expect(fmt(Number.NaN)).toBe("–");
  });
  it("fmtSigned always shows the sign", () => {
    expect(fmtSigned(4260, 0, "fpm")).toBe(t("+4 260 fpm"));
    expect(fmtSigned(-112, 0, "fpm")).toBe(t("-112 fpm"));
    expect(fmtSigned(0, 0, "fpm")).toBe(t("±0 fpm"));
  });
  it("altitude as FL from 18 000 ft", () => {
    expect(fmtAltitude(35000)).toBe("FL350");
    expect(fmtAltitude(4500)).toBe(t("4 500 ft"));
  });
  it("coordinates with hemisphere", () => {
    expect(fmtCoord(50.0333, 8.5706)).toBe("50,033° N 8,571° E");
    expect(fmtCoord(-33.9, -151.2, 1)).toBe("33,9° S 151,2° W");
  });
});

describe("deltas", () => {
  it("minutes with real minus and ±0", () => {
    expect(fmtDeltaMin(85 * MIN, 78 * MIN)).toBe(t("+7 min"));
    expect(fmtDeltaMin(66 * MIN, 78 * MIN)).toBe(t("-12 min"));
    expect(fmtDeltaMin(78 * MIN + 20 * S, 78 * MIN)).toBe(t("±0 min"));
    expect(fmtDeltaMin(2 * H + 5 * MIN, H)).toBe(t("+1 h 05 min"));
    expect(fmtDeltaMin(null, H)).toBe("–");
  });
  it("deltaMinutes for thresholds", () => {
    expect(deltaMinutes(95 * MIN, 80 * MIN)).toBe(15);
    expect(deltaMinutes(undefined, 80 * MIN)).toBeNull();
  });
  it("kilograms with thousands", () => {
    expect(fmtDeltaKg(4200, 5434)).toBe(t("-1 234 kg"));
    expect(fmtDeltaKg(5500, 5400)).toBe(t("+100 kg"));
    expect(fmtDeltaKg(5400.2, 5400)).toBe(t("±0 kg"));
  });
});

describe("clock and date", () => {
  // 2026-10-17 14:30:22 UTC = 16:30:22 CEST (Europe/Berlin, UTC+2)
  const ms = Date.UTC(2026, 9, 17, 14, 30, 22);
  // 2026-10-17 23:15 UTC = 2026-10-18 01:15 local
  const late = Date.UTC(2026, 9, 17, 23, 15, 0);

  it("defaults to UTC with z, 24 h, no seconds", () => {
    expect(fmtClock(ms)).toBe("14:30z");
    expect(fmtClock(ms, { seconds: true })).toBe("14:30:22z");
    expect(fmtClock(Date.UTC(2026, 9, 17, 2, 5))).toBe("02:05z");
  });
  it("switches to local time via the preference", () => {
    setTimeLocal(true);
    expect(fmtClock(ms)).toBe("16:30");
    expect(fmtClock(ms, { seconds: true })).toBe("16:30:22");
  });
  it("an explicit option overrides the preference", () => {
    setTimeLocal(true);
    expect(fmtClock(ms, { local: false })).toBe("14:30z");
  });
  it("one date format, following the same time base", () => {
    expect(fmtDate(ms)).toBe("17.10.2026");
    expect(fmtDate(late)).toBe("17.10.2026");
    expect(fmtDate(late, { local: true })).toBe("18.10.2026");
    expect(fmtDateTime(ms)).toBe("17.10.2026 14:30z");
  });
  it("never 12-hour output", () => {
    expect(fmtClock(Date.UTC(2026, 9, 17, 13, 51, 12))).toBe("13:51z");
    expect(fmtClock(Date.UTC(2026, 9, 17, 13, 51, 12))).not.toMatch(/AM|PM/);
  });
  it("placeholders", () => {
    expect(fmtClock(null)).toBe("–");
    expect(fmtClock(0)).toBe("–");
    expect(fmtDate(undefined)).toBe("–");
  });
});
