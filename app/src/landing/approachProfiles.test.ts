import { afterEach, describe, expect, it } from "vitest";
import { NNBSP } from "../format";
import { setLanguageSetting } from "../i18n";
import { hardGateOf, profileDiffLines, profileName, profileOf, profileTooltip, profileValueText, type ApproachProfilesResult } from "./approachProfiles";
import { approachBandLabel, approachBandLegendLabel } from "./facts";

const NN = new RegExp(NNBSP, "g");
const list: ApproachProfilesResult = {
  keys: [],
  profiles: [
    { id: "generic", name: "Generic (FSF/EASA)", overrides: {}, builtin: true, effective: [] },
    {
      id: "ga_piston",
      name: "GA piston",
      overrides: { hardGateFt: 300 },
      sources: { hardGateFt: "AFH9" },
      builtin: true,
      effective: [{ key: "hardGateFt", value: 300, generic: 500 }],
    },
    {
      id: "my-va",
      name: "My VA SOP",
      basedOn: "airbus",
      overrides: { thrustCheck: false },
      builtin: false,
      effective: [
        { key: "gateSpeedAboveKt", value: 10, generic: 20 },
        { key: "thrustCheck", value: false, generic: true },
      ],
    },
  ],
};

afterEach(() => setLanguageSetting("en"));

describe("approach profiles", () => {
  it("names built-ins by language, custom ones by their own name", () => {
    setLanguageSetting("en");
    expect(profileName("airbus", null)).toBe("Airbus-style profile");
    expect(profileName(null, null)).toBe("Generic profile (FSF/EASA)");
    expect(profileName("my-va", list)).toBe("My VA SOP");
    expect(profileName("gone", list)).toBe("profile “gone” (deleted)");
    setLanguageSetting("de");
    expect(profileName("airbus", null)).toBe("Profil nach Airbus-Art");
    expect(profileOf({ profileId: null })).toBe("generic");
  });

  it("values with units and the differences as lines", () => {
    setLanguageSetting("en");
    expect(profileValueText("hardGateFt", 300).replace(NN, " ")).toBe("300 ft");
    expect(profileValueText("gateSpeedAboveKt", 10).replace(NN, " ")).toBe("10 kt");
    expect(profileValueText("thrustCheck", false)).toBe("off");
    expect(profileDiffLines(list.profiles[2]).map((l) => l.replace(NN, " "))).toEqual(["Gate speed above Vapp: 10 kt (generic 20 kt)", "Thrust check: off (generic on)"]);
    const tip = profileTooltip("my-va", list).replace(NN, " ");
    expect(tip.split("\n")[0]).toBe("Based on the Airbus-style profile");
    expect(tip).toContain("· Thrust check: off (generic on)");
    expect(profileTooltip("generic", list)).toBe("Same thresholds as the generic profile (FSF/EASA).");
  });

  it("band label with the profile's hard gate", () => {
    setLanguageSetting("en");
    expect(approachBandLabel("unstableBelow500", 300).replace(NN, " ")).toBe("unstable below 300 ft");
    expect(approachBandLabel("unstableBelow500", null).replace(NN, " ")).toBe("unstable below 500 ft");
    expect(approachBandLabel("stable", 300)).toBe("stable");
    expect(hardGateOf({})).toBe(500);
    // the dispersion legend over approaches of several profiles
    expect(approachBandLegendLabel("unstableBelow500", [300, 300]).replace(NN, " ")).toBe("unstable below 300 ft");
    expect(approachBandLegendLabel("unstableBelow500", [500, 300, null]).replace(NN, " ")).toBe("unstable below 300 / 500 ft");
    expect(approachBandLegendLabel("unstableBelow500", []).replace(NN, " ")).toBe("unstable below 500 ft");
    expect(approachBandLegendLabel("deviations", [300])).toBe("with deviations");
  });
});
