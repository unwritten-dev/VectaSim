import { describe, expect, it } from "vitest";
import { userMessage } from "./errors";
import { computeTotals, countedFlights } from "./totals";
import type { FlightRow } from "./types";

describe("userMessage", () => {
  it("SimConnect.dll missing", () => {
    const m = userMessage("SimConnect.dll not found or unloadable (tried: a, b); last error: x");
    expect(m.title).toBe("SimConnect wurde nicht gefunden.");
    expect(m.hint).toMatch(/MSFS installiert/);
    expect(m.detail).toMatch(/SimConnect\.dll/);
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
  });
  it("unknown errors keep the raw text as detail", () => {
    const m = userMessage(new Error("boom"));
    expect(m.title).toBe("Unerwarteter Fehler.");
    expect(m.detail).toBe("boom");
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
      landingCount: 0,
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
});
