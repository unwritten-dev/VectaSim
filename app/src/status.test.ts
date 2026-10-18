import { describe, expect, it } from "vitest";
import { DEMO_LABEL, WAITING_SHORT, WAITING_TEXT, isRealSimError, isSimMissing, recordingStatus } from "./status";
import type { FlightSummary, StatusSnapshot } from "./types";

const snap = (s: Partial<StatusSnapshot>): StatusSnapshot => ({ provider: "simconnect", state: "idle", detail: "", frames: 0, ...s }) as StatusSnapshot;
const flight = (state: FlightSummary["state"], offBlockMs = Date.UTC(2026, 9, 17, 13, 57)): FlightSummary =>
  ({ state, offBlockMs, touchdowns: [] }) as unknown as FlightSummary;

describe("recordingStatus", () => {
  it("waits for the simulator without a connection and without a flight", () => {
    for (const s of [snap({ state: "idle" }), snap({ state: "connecting" }), snap({ state: "disconnected", detail: "sim not reachable; retry in 8s" }), null]) {
      const r = recordingStatus(s, null);
      expect(r.kind).toBe("waiting");
      expect(r.label).toBe("Warte auf Simulator");
      expect(r.text).toBe("Warte auf MSFS – Aufzeichnung startet beim Losrollen");
      expect(r.text).toBe(WAITING_TEXT);
      expect(r.error).toBe(false);
    }
  });

  it("a missing SimConnect.dll is a hint in the waiting state, not a red error", () => {
    const s = snap({ state: "error", detail: "SimConnect.dll not found or unloadable (tried: a)" });
    const r = recordingStatus(s, null);
    expect(r.kind).toBe("waiting");
    expect(r.error).toBe(false);
    expect(r.hint).toBe("SimConnect fehlt noch – unter Einstellungen → Simulator mit einem Klick herunterladen.");
    expect(r.hint).not.toMatch(/nicht installiert/);
    expect(isSimMissing(s.detail)).toBe(true);
    expect(isRealSimError(s)).toBe(false);
  });

  it("any other provider error is a real error", () => {
    const s = snap({ state: "error", detail: "unknown provider 'xplane'" });
    expect(recordingStatus(s, null).error).toBe(true);
    expect(isRealSimError(s)).toBe(true);
  });

  it("connected without an active flight is ready", () => {
    const r = recordingStatus(snap({ state: "connected", simName: "MSFS", simVersion: "12.1" }), flight("idle"));
    expect(r.kind).toBe("ready");
    expect(r.text).toBe("Bereit · Aufzeichnung startet beim Losrollen");
    expect(r.hint).toContain("MSFS 12.1");
    // a completed flight is not a running recording either
    expect(recordingStatus(snap({ state: "connected" }), flight("completed")).kind).toBe("ready");
  });

  it("connected with an active flight is recording since off-block", () => {
    const r = recordingStatus(snap({ state: "connected" }), flight("active"));
    expect(r.kind).toBe("recording");
    expect(r.text).toBe("Aufzeichnung läuft · seit 13:57z");
  });

  it("an active flight without a connection is suspended, not lost", () => {
    for (const state of ["disconnected", "connecting", "error"] as const) {
      const r = recordingStatus(snap({ state, detail: "simulator quit" }), flight("active"));
      expect(r.kind).toBe("suspended");
      expect(r.label).toBe("Unterbrochen, wird fortgesetzt");
      expect(r.hint).toMatch(/gesichert/);
    }
  });

  it("the mock provider is the demo flight", () => {
    expect(recordingStatus(snap({ provider: "mock", state: "connected" }), null).kind).toBe("demo");
    expect(recordingStatus(snap({ provider: "mock", state: "connected" }), flight("active")).label).toBe("Demo-Flug");
  });

  it("the waiting hint does not contradict itself", () => {
    for (const detail of ["", "sim not reachable; retry in 8s", "simulator quit"]) {
      const r = recordingStatus(snap({ state: "disconnected", detail }), null);
      expect(r.hint).not.toMatch(/nichts starten/);
      expect(r.hint).not.toMatch(/^Starte MSFS/);
    }
    expect(recordingStatus(snap({ state: "idle" }), null).hint).toMatch(/von selbst/);
  });

  it("one demo name, a short pill text for the Bereit card", () => {
    expect(DEMO_LABEL).toBe("Demo-Flug");
    expect(WAITING_SHORT).toBe("Warte auf MSFS");
    expect(recordingStatus(snap({ provider: "mock", state: "connected" }), null).hint).toMatch(/Demo-Flug beenden/);
  });

  it("never uses the old connection labels", () => {
    const states = ["idle", "connecting", "connected", "disconnected", "error"] as const;
    const all = states.flatMap((st) => [recordingStatus(snap({ state: st }), null), recordingStatus(snap({ state: st }), flight("active"))]);
    for (const r of all) expect(`${r.label} ${r.text}`).not.toMatch(/Getrennt|Verbinde|Fehler|Kein aktiver Flug/);
  });
});
