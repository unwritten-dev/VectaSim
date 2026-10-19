import { describe, expect, it } from "vitest";
import { latestOnly } from "./latest";

describe("latestOnly", () => {
  it("only the most recently started request is current", () => {
    const start = latestOnly();
    const first = start();
    expect(first()).toBe(true);
    const second = start();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
  it("separate guards do not interfere", () => {
    const a = latestOnly();
    const b = latestOnly();
    const fromA = a();
    b();
    expect(fromA()).toBe(true);
  });
});
