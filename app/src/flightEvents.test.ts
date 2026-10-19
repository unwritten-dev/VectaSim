import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeFlightEvent, discardedToast, isFlightEndedLine, noteDiscarded, resetFlightEventsForTests, wasDiscarded } from "./flightEvents";
import { getEvents, pushEvent, replaceEvent, resetEventLogForTests, syncEventProvider } from "./live/eventLog";
import { setLanguageSetting } from "./i18n";
import type { FlightEvent, TouchdownReport } from "./types";

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

const td = (p: Partial<TouchdownReport>): TouchdownReport => ({
  timestampMs: 1,
  vsFpmMeasured: -2,
  vsFpmSim: 0,
  vsFpmHardest: -2,
  peakG: 1.01,
  pitchDeg: 0,
  bankDeg: 0,
  groundSpeedKt: 0,
  headingTrueDeg: 0,
  latitude: 0,
  longitude: 0,
  bounces: 0,
  touchAndGo: false,
  landingRateFpm: 0,
  landingRateSource: "unrated",
  ...p,
});

const ENDED: FlightEvent = { kind: "flightEnded", timestampMs: 5_000, interrupted: false };
const DISCARDED: FlightEvent = { kind: "flightDiscarded", timestampMs: 5_000, offBlockMs: 1_000, shutDown: true };

describe("flightDiscarded", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", fakeStorage());
    resetEventLogForTests();
    resetFlightEventsForTests();
    setLanguageSetting("en");
  });

  afterEach(() => setLanguageSetting("en"));

  it("has its own event-log line and toast text", () => {
    expect(describeFlightEvent(DISCARDED)).toBe("Ground session discarded (no take-off, in the trash)");
    expect(discardedToast(15_000)).toMatchObject({ id: "flight-discarded", title: "Ground session discarded · no take-off, no flight – it is in the trash", durationMs: 15_000 });
    setLanguageSetting("de");
    expect(discardedToast(1).title).toBe("Bodensitzung verworfen · ohne Start kein Flug – liegt im Papierkorb");
  });

  it("marks its flightEnded (same timestamp) as discarded, not saved", () => {
    expect(wasDiscarded(ENDED.timestampMs)).toBe(false);
    noteDiscarded(DISCARDED.timestampMs);
    expect(wasDiscarded(ENDED.timestampMs)).toBe(true);
    expect(wasDiscarded(6_000)).toBe(false);
    // bounded: old end times fall out
    for (let i = 0; i < 20; i++) noteDiscarded(10_000 + i);
    expect(wasDiscarded(5_000)).toBe(false);
    expect(wasDiscarded(10_019)).toBe(true);
  });

  it("replaces the 'Flight saved' line of its flightEnded in the event log", () => {
    syncEventProvider("mock");
    pushEvent(describeFlightEvent({ kind: "flightStarted", timestampMs: 1 })!, 1);
    pushEvent(describeFlightEvent(ENDED)!, 2);
    expect(isFlightEndedLine(getEvents()[0].text)).toBe(true);
    expect(replaceEvent(isFlightEndedLine, describeFlightEvent(DISCARDED)!)).toBe(true);
    expect(getEvents().map((l) => l.text)).toEqual(["Ground session discarded (no take-off, in the trash)", "Flight started (off-block)"]);
    expect(getEvents()[0].ms).toBe(2);
    // nothing to replace: the caller pushes the line instead
    expect(replaceEvent(isFlightEndedLine, "x")).toBe(false);
  });

  it("an unrated touchdown is logged as unrated, never 0 fpm", () => {
    const line = describeFlightEvent({ kind: "touchdown", ...td({}) });
    expect(line).toContain("unrated");
    expect(line).not.toMatch(/\b0\sfpm/);
    expect(describeFlightEvent({ kind: "touchdown", ...td({ landingRateFpm: -150, landingRateSource: "sim" }) })).toMatch(/150\sfpm/);
  });
});
