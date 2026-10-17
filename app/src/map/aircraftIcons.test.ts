import { describe, expect, it } from "vitest";
import { icaoFromAtcModel, wakeCategory } from "./aircraftIcons";

describe("wakeCategory", () => {
  it("classifies by ICAO designator first", () => {
    expect(wakeCategory("A388")).toBe("super");
    expect(wakeCategory("B77W")).toBe("heavy");
    expect(wakeCategory("A20N")).toBe("medium");
    expect(wakeCategory("C172")).toBe("light");
    expect(wakeCategory("pa28")).toBe("light");
  });

  it("falls back to title keywords", () => {
    expect(wakeCategory("", "Airbus A380-800 Lufthansa")).toBe("super");
    expect(wakeCategory(undefined, "Boeing 747-8i")).toBe("heavy");
    expect(wakeCategory(null, "Mock Airlines A320neo")).toBe("medium");
    expect(wakeCategory(null, "Cessna Skyhawk G1000")).toBe("light");
  });

  it("uses weight when nothing else is known", () => {
    expect(wakeCategory("", "", 1_100)).toBe("light");
    expect(wakeCategory("", "", 62_000)).toBe("medium");
    expect(wakeCategory("", "", 250_000)).toBe("heavy");
    expect(wakeCategory("", "", null)).toBe("medium");
  });

  it("parses MSFS ATC MODEL tokens", () => {
    expect(icaoFromAtcModel("TT:ATCCOM.AC_MODEL_A20N.0.text")).toBe("A20N");
    expect(icaoFromAtcModel("$$:B738")).toBe("B738");
    expect(icaoFromAtcModel("A320neo")).toBe("");
    expect(icaoFromAtcModel(null)).toBe("");
    expect(wakeCategory(icaoFromAtcModel("TT:ATCCOM.AC_MODEL_B748.0.text"))).toBe("heavy");
  });
});
