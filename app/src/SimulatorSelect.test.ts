import { beforeEach, describe, expect, it } from "vitest";
import { SIM_MODES, endpointLabel, foldXplane, hostError, parsePort } from "./SimulatorSelect";
import { setLanguageSetting } from "./i18n";

beforeEach(() => setLanguageSetting("de"));

describe("SimulatorSelect helpers", () => {
  it("offers automatic, MSFS and X-Plane 12", () => {
    expect(SIM_MODES.map((m) => m.value)).toEqual(["auto", "simconnect", "xplane"]);
    expect(SIM_MODES[0].label).toBe("Automatisch (MSFS zuerst, dann X-Plane)");
  });
  it("validates host and port like the backend", () => {
    expect(hostError("localhost")).toBeNull();
    expect(hostError(" 127.0.0.1 ")).toBeNull();
    expect(hostError("")).toBe("Host fehlt");
    expect(hostError("a b")).not.toBeNull();
    expect(hostError("http://x")).not.toBeNull();
    expect(parsePort("8086")).toBe(8086);
    expect(parsePort(" 8088 ")).toBe(8088);
    expect(parsePort("0")).toBeNull();
    // same limits as the overlay port: 1024–65535
    expect(parsePort("80")).toBeNull();
    expect(parsePort("1023")).toBeNull();
    expect(parsePort("1024")).toBe(1024);
    expect(parsePort("65535")).toBe(65535);
    expect(parsePort("65536")).toBeNull();
    expect(parsePort("80x")).toBeNull();
    expect(endpointLabel("localhost", 8086)).toBe("X-Plane Web API localhost:8086");
  });
});

describe("foldXplane (UX 4.9)", () => {
  it("folds the X-Plane address only for Automatisch without an X-Plane connection", () => {
    expect(foldXplane("auto", false, false, false)).toBe(true);
    expect(foldXplane("auto", true, false, false)).toBe(false);
    expect(foldXplane("xplane", false, false, false)).toBe(false);
    // an invalid or non-default address stays visible
    expect(foldXplane("auto", false, true, false)).toBe(false);
    expect(foldXplane("auto", false, false, true)).toBe(false);
  });
});
