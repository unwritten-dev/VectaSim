import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISCARD_SETTLE_MS, onFlightDiscarded, onFlightEnded, rowEndedAt, type FlightDiscard, type FlightEnd, type FlightEndDeps } from "./flightEndFlow";
import { describeFlightEvent, resetFlightEventsForTests } from "./flightEvents";
import { getEvents, pushEvent, replaceEvent, resetEventLogForTests, syncEventProvider } from "./live/eventLog";
import { setLanguageSetting } from "./i18n";
import type { FlightRow } from "./types";

function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
}

const END_MS = 50_000;
const ENDED: FlightEnd = { kind: "flightEnded", timestampMs: END_MS, interrupted: false };
const DISCARDED: FlightDiscard = { kind: "flightDiscarded", timestampMs: END_MS, offBlockMs: 1_000, shutDown: true };

const row = (over: Partial<FlightRow>): FlightRow =>
  ({ id: "f-new", state: "completed", depIcao: "EDDF", arrIcao: "EDDM", offBlockMs: 10_000, onBlockMs: END_MS, landingVsFpm: -140, createdMs: 0, updatedMs: END_MS, ...over }) as FlightRow;

/** Deps with a controllable list_flights answer and a manual settle timer. */
function deps(latest: () => Promise<FlightRow | undefined>) {
  let release: () => void = () => {};
  const d = {
    latestFlight: vi.fn(latest),
    wait: vi.fn((ms: number) => {
      expect(ms).toBe(DISCARD_SETTLE_MS);
      return new Promise<void>((r) => (release = r));
    }),
    pushEvent: (line: string) => pushEvent(line),
    replaceEvent: (m: (t: string) => boolean, line: string) => replaceEvent(m, line),
    requestAttention: vi.fn(),
    setAfterFlight: vi.fn(),
    autoSaveCard: vi.fn(),
    showToast: vi.fn(),
    dismissToast: vi.fn(),
    savedToast: vi.fn(() => ({ id: "flight-saved", title: "saved" })),
    toastMs: 15_000,
  } satisfies FlightEndDeps;
  return { d, settle: () => release() };
}

const lines = () => getEvents().map((l) => l.text);

describe("flight end: flightEnded / flightDiscarded in either order", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", fakeStorage());
    resetEventLogForTests();
    resetFlightEventsForTests();
    syncEventProvider("mock");
    setLanguageSetting("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a normal end: line, then after the settle the card, autosave, attention and the saved toast", async () => {
    const { d, settle } = deps(async () => row({}));
    const run = onFlightEnded(ENDED, describeFlightEvent(ENDED), d);
    expect(lines()).toEqual([describeFlightEvent(ENDED)]);
    expect(d.dismissToast).toHaveBeenCalledWith("conn");
    await Promise.resolve();
    // nothing visible before the discard check settled
    expect(d.requestAttention).not.toHaveBeenCalled();
    settle();
    await run;
    expect(d.requestAttention).toHaveBeenCalledTimes(1);
    expect(d.setAfterFlight).toHaveBeenCalledWith(expect.objectContaining({ flightId: "f-new", onBlockMs: END_MS }));
    expect(d.autoSaveCard).toHaveBeenCalledWith("f-new");
    expect(d.dismissToast).toHaveBeenCalledWith("landing");
    expect(d.showToast).toHaveBeenCalledWith(expect.objectContaining({ id: "flight-saved" }));
  });

  it("flightEnded, list_flights answers, then flightDiscarded: no attention, no card, no autosave", async () => {
    // the discarded session is in the trash: rows[0] is an older flight
    const { d, settle } = deps(async () => row({ id: "f-old", onBlockMs: 1_000 }));
    const run = onFlightEnded(ENDED, describeFlightEvent(ENDED), d);
    await Promise.resolve();
    await Promise.resolve();
    onFlightDiscarded(DISCARDED, describeFlightEvent(DISCARDED), d);
    settle();
    await run;
    expect(d.requestAttention).not.toHaveBeenCalled();
    expect(d.autoSaveCard).not.toHaveBeenCalled();
    expect(d.setAfterFlight).toHaveBeenCalledTimes(1);
    expect(d.setAfterFlight).toHaveBeenCalledWith(null);
    expect(d.showToast).toHaveBeenCalledTimes(1);
    expect(d.showToast).toHaveBeenCalledWith(expect.objectContaining({ id: "flight-discarded" }));
    expect(lines()).toEqual([describeFlightEvent(DISCARDED)]);
  });

  it("flightDiscarded before flightEnded: the saved line is never written", async () => {
    const { d } = deps(async () => row({}));
    onFlightDiscarded(DISCARDED, describeFlightEvent(DISCARDED), d);
    await onFlightEnded(ENDED, describeFlightEvent(ENDED), d);
    expect(lines()).toEqual([describeFlightEvent(DISCARDED)]);
    expect(d.latestFlight).not.toHaveBeenCalled();
    expect(d.requestAttention).not.toHaveBeenCalled();
    expect(d.dismissToast).toHaveBeenCalledWith("conn");
  });

  it("an older newest row (not this end) brings no card even without a discard", async () => {
    const { d, settle } = deps(async () => row({ id: "f-old", onBlockMs: 1_000 }));
    const run = onFlightEnded(ENDED, describeFlightEvent(ENDED), d);
    settle();
    await run;
    expect(d.requestAttention).toHaveBeenCalledTimes(1);
    expect(d.setAfterFlight).not.toHaveBeenCalled();
    expect(d.autoSaveCard).not.toHaveBeenCalled();
  });

  it("an unrated landing is not autosaved; a logbook error leaves only the line", async () => {
    const a = deps(async () => row({ landingVsFpm: null }));
    const r1 = onFlightEnded(ENDED, "x", a.d);
    a.settle();
    await r1;
    expect(a.d.setAfterFlight).toHaveBeenCalled();
    expect(a.d.autoSaveCard).not.toHaveBeenCalled();

    const b = deps(() => Promise.reject(new Error("locked")));
    const r2 = onFlightEnded({ ...ENDED, timestampMs: 60_000 }, "y", b.d);
    b.settle();
    await r2;
    expect(b.d.requestAttention).not.toHaveBeenCalled();
  });

  it("rowEndedAt matches the on-block time of this end only", () => {
    expect(rowEndedAt(row({}), END_MS)).toBe(true);
    expect(rowEndedAt(row({ onBlockMs: END_MS + 500 }), END_MS)).toBe(true);
    expect(rowEndedAt(row({ onBlockMs: 1_000 }), END_MS)).toBe(false);
    expect(rowEndedAt(row({ onBlockMs: null }), END_MS)).toBe(false);
    expect(rowEndedAt(undefined, END_MS)).toBe(false);
  });
});
