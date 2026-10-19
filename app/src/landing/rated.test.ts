import { describe, expect, it } from "vitest";
import { isRated, ratedFpm, rateText } from "./rated";

describe("unrated touchdowns", () => {
  it("isRated: only the unrated source is not rated", () => {
    expect(isRated({ landingRateSource: "sim" })).toBe(true);
    expect(isRated({ landingRateSource: "measured" })).toBe(true);
    // rows from before the source existed count as rated
    expect(isRated({})).toBe(true);
    expect(isRated({ landingRateSource: null })).toBe(true);
    expect(isRated({ landingRateSource: "unrated" })).toBe(false);
  });
  it("rateText shows 'unrated' instead of 0 fpm", () => {
    expect(rateText({ landingRateSource: "unrated", landingRateFpm: 0 }, "en")).toBe("unrated");
    expect(rateText({ landingRateSource: "unrated", landingRateFpm: -3 }, "de")).toBe("nicht bewertbar");
    expect(rateText({ landingRateSource: "sim", landingRateFpm: -142 }, "en")).toMatch(/142\sfpm$/);
    expect(rateText({ landingRateSource: "measured", landingRateFpm: 0 }, "en")).toMatch(/^0\sfpm$/);
  });
  it("ratedFpm leaves unrated touchdowns out of averages", () => {
    expect(ratedFpm({ landingRateSource: "unrated", landingRateFpm: 0 })).toBeNull();
    expect(ratedFpm({ landingRateSource: "measured", landingRateFpm: -210 })).toBe(-210);
  });
});
