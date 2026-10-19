import { beforeEach, describe, expect, it } from "vitest";
import { NNBSP } from "./format";
import { G_FLIGHT_INFO_HIGH, G_FLIGHT_INFO_LOW, G_FLIGHT_WARN_HIGH, G_FLIGHT_WARN_LOW, gLoadHints, gLoadProtocol, gLoadSummary, gLoadTitle, liveMaxG } from "./gload";
import { setLanguageSetting } from "./i18n";
import type { GLoadStats } from "./types";

beforeEach(() => setLanguageSetting("de"));

const n = (s: string) => s.split(NNBSP).join(" ");

function stats(max: number, min: number, source: GLoadStats["source"] = "live"): GLoadStats {
  return {
    max: { g: max, timestampMs: 1, phase: "climb", altitudeMslFt: 3_212 },
    min: { g: min, timestampMs: 2, phase: "descent", altitudeMslFt: 18_040 },
    highCount: 2,
    lowCount: 0,
    source,
  };
}

describe("g-load over the flight", () => {
  it("formats the detail line in both languages", () => {
    expect(n(gLoadSummary(stats(1.42, 0.71)))).toBe("max 1,42 g (Climb, 3 200 ft) · min 0,71 g (Descent)");
    expect(gLoadSummary(null)).toBe("nicht gemessen");
    expect(gLoadSummary({ highCount: 0, lowCount: 0, source: "live" })).toBe("nicht gemessen");
    setLanguageSetting("en");
    expect(n(gLoadSummary(stats(1.42, 0.71)))).toBe("max 1.42 g (Climb, 3,200 ft) · min 0.71 g (Descent)");
    expect(gLoadSummary(undefined)).toBe("not measured");
  });

  it("explains the measurement and the source in the tooltip", () => {
    const live = n(gLoadTitle(stats(1.42, 0.71)));
    expect(live).toContain("0,3 s");
    expect(live).toContain("3 s");
    expect(live).toContain("Über 1,5 g: 2 ×, unter 0,5 g: 0 ×");
    expect(live).toContain("live");
    expect(gLoadTitle(stats(1.42, 0.71, "track"))).toContain("aus Track, 1 Hz");
    expect(gLoadTitle(null)).toContain("keine G-Last");
    setLanguageSetting("en");
    expect(gLoadTitle(stats(1.42, 0.71, "track"))).toContain("from the track, 1 Hz");
  });

  it("hints only beyond the thresholds", () => {
    expect([G_FLIGHT_INFO_HIGH, G_FLIGHT_WARN_HIGH, G_FLIGHT_INFO_LOW, G_FLIGHT_WARN_LOW]).toEqual([1.6, 2.0, 0.4, 0]);
    expect(gLoadHints(stats(1.6, 0.4))).toEqual([]);
    expect(gLoadHints(null)).toEqual([]);
    expect(gLoadHints(stats(1.61, 0.9)).map((h) => h.tone)).toEqual(["info"]);
    expect(gLoadHints(stats(2.01, 0.9)).map((h) => h.tone)).toEqual(["warn"]);
    expect(gLoadHints(stats(1.2, 0.39)).map((h) => h.tone)).toEqual(["info"]);
    expect(gLoadHints(stats(1.2, -0.1)).map((h) => h.tone)).toEqual(["warn"]);
    expect(gLoadHints(stats(2.2, -0.2)).map((h) => h.tone)).toEqual(["warn", "warn"]);
    const [high] = gLoadHints(stats(1.8, 0.9, "track"));
    expect(n(high.text)).toContain("bis 1,80 g (Climb, 3 200 ft)");
    expect(high.text).toContain("(aus Track, 1 Hz)");
    setLanguageSetting("en");
    const [low] = gLoadHints(stats(1.2, -0.25));
    expect(n(low.text)).toBe("Negative g-load in flight: -0.25 g (Descent, 18,000 ft) – airliners are only designed for −1 g");
  });

  it("writes the protocol row and the live value", () => {
    expect(n(gLoadProtocol(stats(1.42, 0.71)) ?? "")).toBe(
      "max 1,42 g (Climb, 3 200 ft) · min 0,71 g (Descent) · Über 1,5 g: 2 ×, unter 0,5 g: 0 × (je mindestens 0,5 s am Stück) · live, gleitender Mittelwert 0,3 s",
    );
    expect(gLoadProtocol(null)).toBeNull();
    expect(n(liveMaxG(stats(1.234, 0.9)) ?? "")).toBe("1,23 g");
    expect(liveMaxG({ highCount: 0, lowCount: 0, source: "live" })).toBeNull();
  });
});
