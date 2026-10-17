import { describe, expect, it } from "vitest";
import { bearingDeg, distanceToSegmentNm, etaMs, matchRunway, remainingNm } from "./progress";
import { haversineNm } from "../format";

const EDDF = { latitude: 50.0333, longitude: 8.5706 };
const EDDM = { latitude: 48.3538, longitude: 11.7861 };
const p = (latitude: number, longitude: number) => ({ latitude, longitude });

describe("remainingNm", () => {
  it("is null without position or destination", () => {
    expect(remainingNm(null, EDDM)).toBeNull();
    expect(remainingNm(EDDF, null)).toBeNull();
  });

  it("falls back to great-circle without a route", () => {
    expect(remainingNm(EDDF, EDDM)).toBeCloseTo(haversineNm(EDDF.latitude, EDDF.longitude, EDDM.latitude, EDDM.longitude), 6);
    expect(remainingNm(EDDF, EDDM, [])).toBeCloseTo(remainingNm(EDDF, EDDM)!, 6);
  });

  it("measures along the route from the nearest leg", () => {
    // dog-leg: EDDF → (50.0, 11.0) → EDDM; aircraft halfway along the first leg
    const wp = p(50.0, 11.0);
    const route = [EDDF, wp, EDDM];
    const pos = p(50.0167, 9.785);
    const expected = haversineNm(pos.latitude, pos.longitude, wp.latitude, wp.longitude) + haversineNm(wp.latitude, wp.longitude, EDDM.latitude, EDDM.longitude);
    expect(remainingNm(pos, EDDM, route)).toBeCloseTo(expected, 3);
    // longer than direct
    expect(remainingNm(pos, EDDM, route)!).toBeGreaterThan(remainingNm(pos, EDDM)!);
  });

  it("appends the destination when the navlog stops short of it", () => {
    const wp = p(50.0, 11.0);
    const pos = p(50.0, 10.0);
    const withDest = remainingNm(pos, EDDM, [EDDF, wp, EDDM]);
    const withoutDest = remainingNm(pos, EDDM, [EDDF, wp]);
    expect(withoutDest).toBeCloseTo(withDest!, 6);
  });

  it("uses great-circle when far off the route", () => {
    const pos = p(53.6, 10.0); // near Hamburg, > 30 nm from every leg
    expect(remainingNm(pos, EDDM, [EDDF, p(50.0, 11.0), EDDM])).toBeCloseTo(remainingNm(pos, EDDM)!, 6);
  });

  it("is about zero at the destination", () => {
    expect(remainingNm(EDDM, EDDM, [EDDF, EDDM])).toBeLessThan(0.01);
  });
});

describe("etaMs", () => {
  it("divides distance by ground speed", () => {
    expect(etaMs(1_000_000, 240, 480)).toBe(1_000_000 + 30 * 60_000);
  });
  it("is null when slow or unknown", () => {
    expect(etaMs(0, 100, 20)).toBeNull();
    expect(etaMs(0, null, 400)).toBeNull();
    expect(etaMs(0, 100, null)).toBeNull();
  });
});

describe("geometry helpers", () => {
  it("projects onto a segment", () => {
    const r = distanceToSegmentNm(p(0.1, 0.5), p(0, 0), p(0, 1));
    expect(r.t).toBeCloseTo(0.5, 3);
    expect(r.nm).toBeCloseTo(6, 1);
  });
  it("computes bearings", () => {
    expect(bearingDeg(p(0, 0), p(0, 1))).toBeCloseTo(90, 3);
    expect(bearingDeg(p(0, 0), p(1, 0))).toBeCloseTo(0, 3);
    expect(bearingDeg(p(0, 1), p(0, 0))).toBeCloseTo(270, 3);
  });
});

describe("matchRunway", () => {
  // EDDF 07C/25C (approximate thresholds)
  const rwy = { leIdent: "07C", heIdent: "25C", leLatitude: 50.0326, leLongitude: 8.5347, heLatitude: 50.0451, heLongitude: 8.5869 };
  const north = { leIdent: "18", heIdent: "36", leLatitude: 50.0345, leLongitude: 8.5263, heLatitude: 49.9951, heLongitude: 8.5263 };
  const mid = { latitude: 50.0388, longitude: 8.5608 };

  it("picks the end matching the heading", () => {
    expect(matchRunway({ ...mid, headingTrueDeg: 249 }, [rwy, north])).toBe("25C");
    expect(matchRunway({ ...mid, headingTrueDeg: 69 }, [rwy, north])).toBe("07C");
  });
  it("is null off the runway or crosswise", () => {
    expect(matchRunway({ latitude: 50.06, longitude: 8.56, headingTrueDeg: 249 }, [rwy])).toBeNull();
    expect(matchRunway({ ...mid, headingTrueDeg: 160 }, [rwy])).toBeNull();
    expect(matchRunway({ ...mid, headingTrueDeg: 249 }, [{ leIdent: "x", heIdent: "y" }])).toBeNull();
  });
});
