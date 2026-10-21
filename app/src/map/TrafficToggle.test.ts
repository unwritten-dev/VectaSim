import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn((_cmd: string, _args?: unknown) => Promise.resolve({}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const { currentChoice, networksOfChoice, setTrafficShown, toggledNetworks } = await import("./TrafficToggle");
const { networkTitle } = await import("../OnlinePanel");

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
  it("follows what the map shows, not which networks are enabled", () => {
    // both enabled, only IVAO shown on the map
    expect(currentChoice({ network: "both", shown: "ivao" }, "vatsim")).toBe("ivao");
    // enabled but hidden: the remembered choice
    expect(currentChoice({ network: "vatsim", shown: "off" }, "both")).toBe("both");
  });
  it("names the networks in the online panel", () => {
    expect(networkTitle({ network: "both" })).toBe("VATSIM + IVAO");
    expect(networkTitle({ network: "ivao" })).toBe("IVAO");
    expect(networkTitle({ network: "off" })).toBe("VATSIM · IVAO");
  });
});

describe("traffic toggle: show / hide", () => {
  beforeEach(() => invoke.mockClear());
  it("hiding only hides: online_set_shown with no networks, never online_set_networks", async () => {
    expect(toggledNetworks(true, "both")).toEqual([]);
    await setTrafficShown(toggledNetworks(true, "vatsim"));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("online_set_shown", { networks: [] });
    expect(invoke.mock.calls.some(([cmd]) => cmd === "online_set_networks" || cmd === "online_set_enabled")).toBe(false);
  });
  it("showing asks for the chosen networks", async () => {
    expect(toggledNetworks(false, "ivao")).toEqual(["ivao"]);
    await setTrafficShown(toggledNetworks(false, "both"));
    expect(invoke).toHaveBeenCalledWith("online_set_shown", { networks: ["vatsim", "ivao"] });
    expect(invoke.mock.calls.every(([cmd]) => cmd === "online_set_shown")).toBe(true);
  });
});
