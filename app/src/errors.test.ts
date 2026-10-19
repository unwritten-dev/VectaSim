import { beforeEach, describe, expect, it } from "vitest";
import { dllMissingText, isDllMissing, networkContext, triedDllPaths, userMessage } from "./errors";
import { computeTotals, countedFlights, demoLeftOut } from "./totals";
import type { FlightRow } from "./types";
import { setLanguageSetting } from "./i18n";

beforeEach(() => setLanguageSetting("de"));

describe("userMessage", () => {
  it("SimConnect.dll missing", () => {
    const m = userMessage("SimConnect.dll not found or unloadable (tried: a, b); last error: x");
    expect(m.title).toBe("SimConnect fehlt noch.");
    expect(m.hint).toContain("Einstellungen → Simulator mit einem Klick herunterladen");
    expect(m.hint).toContain("Datei wählen");
    expect(m.hint).not.toMatch(/SDK-Installer|Entwicklermodus/);
    expect(m.hint).not.toMatch(/MSFS installiert/);
    expect(m.detail).toMatch(/SimConnect\.dll/);
  });
  it("DLL texts and searched paths", () => {
    const raw =
      "SimConnect.dll not found or unloadable (tried: D:\\SDK\\SimConnect.dll, C:\\Program Files\\VectaSim\\SimConnect.dll, SimConnect.dll); last error: LoadLibraryExW failed";
    expect(isDllMissing(raw)).toBe(true);
    expect(isDllMissing("sim not reachable; retry in 8s")).toBe(false);
    expect(triedDllPaths(raw)).toEqual(["D:\\SDK\\SimConnect.dll", "C:\\Program Files\\VectaSim\\SimConnect.dll", "SimConnect.dll"]);
    expect(triedDllPaths("unknown provider 'xplane'")).toEqual([]);
    expect(dllMissingText()).toBe("SimConnect fehlt noch – unter Einstellungen → Simulator mit einem Klick herunterladen");
  });
  it("sim not reachable is a waiting state with retry time", () => {
    const m = userMessage("sim not reachable (SimConnect_Open hr=0x80004005); retry in 8s", "sim");
    expect(m.title).toBe("Warte auf Simulator …");
    expect(m.hint).toContain("8 s");
  });
  it("unknown provider", () => {
    expect(userMessage("unknown provider 'xplane'").title).toBe("Unbekannter Simulator.");
  });
  it("SimBrief unknown user", () => {
    const m = userMessage("could not parse OFP: fetch status: Error: Unknown UserID", "simbrief", { user: "12345" });
    expect(m.title).toBe("Kein Flugplan für „12345“ gefunden.");
    expect(m.hint).toMatch(/simbrief\.com/);
  });
  it("SimBrief HTTP 400", () => {
    expect(userMessage("SimBrief rejected the request (HTTP 400): ...", "simbrief").title).toMatch(/Kein Flugplan/);
  });
  it("network errors per service", () => {
    const raw = "network: error sending request for url (https://www.simbrief.com/api/xml.fetcher.php)";
    expect(userMessage(raw, "simbrief").title).toBe("SimBrief ist nicht erreichbar.");
    const v = userMessage("network: error sending request for url (https://data.vatsim.net/v3/vatsim-data.json)", "vatsim");
    expect(v.title).toBe("VATSIM ist nicht erreichbar.");
    expect(v.hint).toMatch(/Tracking läuft lokal weiter/);
    expect(userMessage("network: operation timed out", "metar").title).toBe("Wetterdienst ist nicht erreichbar.");
    const i = userMessage("IVAO: network: error sending request for url (https://api.ivao.aero/v2/tracker/whazzup)", "ivao");
    expect(i.title).toBe("IVAO ist nicht erreichbar.");
    expect(i.hint).toMatch(/IVAO-Verkehr ist pausiert/);
    expect(userMessage("IVAO: rate limit reached, try again shortly", "ivao").title).toBe("IVAO: zu viele Anfragen.");
  });
  it("IVAO-prefixed errors are IVAO even with the vatsim fallback", () => {
    expect(networkContext("IVAO: HTTP 503")).toBe("ivao");
    expect(networkContext("VATSIM: HTTP 503", "ivao")).toBe("vatsim");
    expect(networkContext("network: timed out", "ivao")).toBe("ivao");
    expect(networkContext("network: timed out")).toBe("vatsim");
    expect(userMessage("IVAO: network: error sending request", "vatsim").title).toBe("IVAO ist nicht erreichbar.");
    expect(userMessage("IVAO: HTTP 503", "vatsim").title).toBe("IVAO antwortet mit einem Fehler (HTTP 503).");
    expect(userMessage("network: error sending request", "vatsim").title).toBe("VATSIM ist nicht erreichbar.");
    expect(userMessage("network: error sending request", "ivao").hint).not.toMatch(/VATSIM/);
  });
  it("unknown errors keep the raw text as detail", () => {
    const m = userMessage(new Error("boom"));
    expect(m.title).toBe("Unerwarteter Fehler.");
    expect(m.detail).toBe("boom");
  });
});

describe("userMessage in English", () => {
  it("translates title and hint, keeps the raw detail", () => {
    setLanguageSetting("en");
    const m = userMessage("sim not reachable; retry in 8s", "sim");
    expect(m.title).toBe("Waiting for simulator …");
    expect(m.hint).toBe("Start the simulator – VectaSim connects automatically (next attempt in 8 s).");
    expect(userMessage("network: timed out", "metar").title).toBe("Weather service is not reachable.");
    expect(userMessage("IVAO: HTTP 503", "vatsim").title).toBe("IVAO responded with an error (HTTP 503).");
    expect(userMessage(new Error("boom")).detail).toBe("boom");
    expect(dllMissingText()).toMatch(/Settings → Simulator/);
  });
});

describe("totals without demo flights", () => {
  const row = (p: Partial<FlightRow>): FlightRow =>
    ({
      id: Math.random().toString(),
      state: "completed",
      phase: "shutdown",
      createdMs: 1,
      updatedMs: 1,
      maxAltMslFt: 0,
      distanceNm: 0,
      aircraft: { title: "", atcModel: "", atcType: "", atcId: "", atcAirline: "", atcFlightNumber: "" },
      hasOfp: false,
      integrity: {} as FlightRow["integrity"],
      // flown (a touchdown): counts in statistics (flightStats.ts)
      landingCount: 1,
      ...p,
    }) as FlightRow;
  const flights = [
    row({ provider: "simconnect", offBlockMs: 0, onBlockMs: 3_600_000, distanceNm: 300, landingVsFpm: -100 }),
    row({ provider: "mock", offBlockMs: 0, onBlockMs: 600_000, distanceNm: 10, landingVsFpm: -500 }),
    row({ provider: "simconnect", state: "interrupted", distanceNm: 50, landingVsFpm: -200 }),
  ];
  it("excludes mock flights unless asked", () => {
    const t = computeTotals(countedFlights(flights, false));
    expect(t.flights).toBe(2);
    expect(t.completed).toBe(1);
    expect(t.blockTimeMs).toBe(3_600_000);
    expect(t.distanceNm).toBe(350);
    expect(t.avgLandingVsFpm).toBe(-150);
    expect(computeTotals(countedFlights(flights, true)).flights).toBe(3);
  });
  it("leaves discarded ground sessions and taxi-only rows out of the totals", () => {
    const more = [
      ...flights,
      row({ provider: "simconnect", state: "discarded", offBlockMs: 0, onBlockMs: 900_000, landingCount: 0 }),
      row({ provider: "simconnect", state: "completed", offBlockMs: 0, onBlockMs: 600_000, distanceNm: 2, landingCount: 0 }),
    ];
    const t = computeTotals(countedFlights(more, false));
    expect(t.flights).toBe(2);
    expect(t.blockTimeMs).toBe(3_600_000);
    expect(t.distanceNm).toBe(350);
    expect(demoLeftOut(more, false)).toBe(1);
    expect(demoLeftOut([row({ provider: "mock", state: "discarded", landingCount: 0 })], false)).toBe(0);
  });
});
