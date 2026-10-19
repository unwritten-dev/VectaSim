import { describe, expect, it } from "vitest";
import { sequence } from "./sequence";

describe("sequence", () => {
  it("only the latest request's answer is applied, whatever order they arrive in", async () => {
    const begin = sequence();
    const shown: string[] = [];
    const lookup = (name: string, delayMs: number) => {
      const isLatest = begin();
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          if (isLatest()) shown.push(name);
          resolve();
        }, delayMs),
      );
    };
    // the older lookup answers last: it must not overwrite the newer one
    await Promise.all([lookup("old view", 30), lookup("new view", 5)]);
    expect(shown).toEqual(["new view"]);
  });

  it("a single request is the latest", () => {
    const isLatest = sequence()();
    expect(isLatest()).toBe(true);
  });
});
