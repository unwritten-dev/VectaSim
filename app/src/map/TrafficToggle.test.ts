import { describe, expect, it } from "vitest";
import { currentChoice, networksOfChoice } from "./TrafficToggle";
import { networkTitle } from "../OnlinePanel";

describe("traffic network choice", () => {
  it("shows what runs, else the remembered choice, else VATSIM", () => {
    expect(currentChoice({ network: "ivao" }, "vatsim")).toBe("ivao");
    expect(currentChoice({ network: "both" }, null)).toBe("both");
    expect(currentChoice({ network: "off" }, "ivao")).toBe("ivao");
    expect(currentChoice(null, "both")).toBe("both");
    expect(currentChoice(null, null)).toBe("vatsim");
    expect(currentChoice(null, "garbage")).toBe("vatsim");
  });
  it("maps a choice to the networks to switch on", () => {
    expect(networksOfChoice("vatsim")).toEqual(["vatsim"]);
    expect(networksOfChoice("ivao")).toEqual(["ivao"]);
    expect(networksOfChoice("both")).toEqual(["vatsim", "ivao"]);
  });
  it("names the networks in the online panel", () => {
    expect(networkTitle({ network: "both" })).toBe("VATSIM + IVAO");
    expect(networkTitle({ network: "ivao" })).toBe("IVAO");
    expect(networkTitle({ network: "off" })).toBe("VATSIM · IVAO");
  });
});
