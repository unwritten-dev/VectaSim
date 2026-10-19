import { describe, expect, it } from "vitest";
import { yAxis } from "./Trends";

describe("yAxis (Verlauf)", () => {
  it("a single point sits below the top tick", () => {
    const a = yAxis(180, 0, undefined);
    expect(a.max).toBeGreaterThanOrEqual(180);
    expect(a.ticks[a.ticks.length - 1]).toBe(a.max);
    expect(a.ticks[0]).toBe(0);
    expect(a.digits).toBe(0);
  });

  it("band limits close to the data are included, far ones not", () => {
    expect(yAxis(280, 0, undefined, [150, 300, 600]).max).toBeGreaterThanOrEqual(300);
    expect(yAxis(100, 0, undefined, [150, 300, 600]).max).toBeLessThan(300);
    // a band limit just above the data is the top, without extra headroom
    expect(yAxis(215, 0, undefined, [150, 300, 600]).max).toBe(300);
  });

  it("small values get decimals from the step, a fixed ceiling stays", () => {
    const a = yAxis(0.28, 0, undefined, [0.3, 0.6]);
    expect(a.max).toBeGreaterThanOrEqual(0.3);
    expect(a.digits).toBe(1);
    expect(yAxis(0.12, 0, undefined).digits).toBe(2);
    expect(yAxis(40, 0, 100).max).toBe(100);
    expect(yAxis(0, 0, undefined).max).toBeGreaterThan(0);
  });
});
