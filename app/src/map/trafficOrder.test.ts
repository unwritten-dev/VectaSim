import { describe, expect, it } from "vitest";
import { stableNearest, type Ranked } from "./trafficOrder";

const r = (key: string, d: number): Ranked<string> => ({ key, item: key, d });

describe("stableNearest", () => {
  it("sorts by distance on a resort or without a previous order", () => {
    expect(stableNearest([], [r("b", 2), r("a", 1)], 8, false).map((x) => x.key)).toEqual(["a", "b"]);
    expect(stableNearest(["b", "a"], [r("b", 2), r("a", 1)], 8, true).map((x) => x.key)).toEqual(["a", "b"]);
  });

  it("keeps the shown order while frozen, even when distances change", () => {
    expect(stableNearest(["a", "b", "c"], [r("a", 5), r("b", 1), r("c", 3)], 8, false).map((x) => x.key)).toEqual(["a", "b", "c"]);
  });

  it("drops aircraft that left and appends newcomers at the end, nearest first", () => {
    const out = stableNearest(["a", "b", "c"], [r("a", 1), r("c", 3), r("e", 0.5), r("d", 2)], 4, false);
    expect(out.map((x) => x.key)).toEqual(["a", "c", "e", "d"]);
  });

  it("respects the maximum", () => {
    expect(stableNearest(["a", "b"], [r("a", 1), r("b", 2), r("c", 0)], 2, false).map((x) => x.key)).toEqual(["a", "b"]);
  });
});
