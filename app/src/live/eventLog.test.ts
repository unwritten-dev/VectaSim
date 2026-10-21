import { beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_LOG_MAX, clearEvents, eventsSummary, getEvents, pushEvent, resetEventLogForTests, subscribeEvents, syncEventProvider } from "./eventLog";

/** sessionStorage of one webview tab: survives a reload of the page, not the app. */
function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

/** The lines App logs for the mock go-around flight up to the second final (newest first in the list). */
const GO_AROUND_FLIGHT = [
  "Flug begonnen (Off-Block)",
  "Phase: Vorbereitung → Rollen",
  "Phase: Rollen → Start",
  "Phase: Start → Steigflug",
  "Phase: Steigflug → Reiseflug",
  "Phase: Reiseflug → Sinkflug",
  "Phase: Sinkflug → Anflug",
  "Phase: Anflug → Endanflug",
  "Phase: Endanflug → Steigflug", // the go-around
  "Phase: Steigflug → Reiseflug",
  "Phase: Reiseflug → Sinkflug",
  "Phase: Sinkflug → Anflug",
  "Phase: Anflug → Endanflug",
];

describe("eventLog", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", fakeStorage());
    resetEventLogForTests();
  });

  it("keeps every line of the running flight across the go-around", () => {
    syncEventProvider("mock");
    GO_AROUND_FLIGHT.forEach((t, i) => pushEvent(t, 1_000 + i));
    // status updates of the same session (phase change, frames) do not touch the list
    syncEventProvider("mock");
    expect(getEvents()).toHaveLength(GO_AROUND_FLIGHT.length);
    expect(getEvents()[0].text).toBe("Phase: Anflug → Endanflug");
    expect(getEvents()[getEvents().length - 1].text).toBe("Flug begonnen (Off-Block)");
  });

  it("survives a remount or reload of the page while the same provider runs", () => {
    syncEventProvider("mock");
    GO_AROUND_FLIGHT.slice(0, 8).forEach((t) => pushEvent(t));
    // Fast Refresh / webview reload: the module state is rebuilt from sessionStorage …
    resetEventLogForTests();
    expect(getEvents()).toHaveLength(8);
    // … and the first status of the new page (same provider) keeps it
    syncEventProvider("mock");
    pushEvent("Phase: Endanflug → Steigflug");
    expect(getEvents()).toHaveLength(9);
    expect(getEvents()[0].text).toBe("Phase: Endanflug → Steigflug");
  });

  it("empties the list when another provider reports in, also after a reload", () => {
    syncEventProvider("mock");
    pushEvent("Flug begonnen (Off-Block)");
    syncEventProvider("simconnect");
    expect(getEvents()).toEqual([]);

    pushEvent("Simulation läuft");
    resetEventLogForTests();
    syncEventProvider("mock");
    expect(getEvents()).toEqual([]);
  });

  it("keeps lines that arrived before the first status of a fresh page", () => {
    pushEvent("Simulator pausiert");
    syncEventProvider("simconnect");
    expect(getEvents().map((l) => l.text)).toEqual(["Simulator pausiert"]);
  });

  it("caps a long session at the newest lines", () => {
    syncEventProvider("mock");
    for (let i = 0; i < EVENT_LOG_MAX + 5; i++) pushEvent(`e${i}`);
    expect(getEvents()).toHaveLength(EVENT_LOG_MAX);
    expect(getEvents()[0].text).toBe(`e${EVENT_LOG_MAX + 4}`);
  });

  it("notifies subscribers and ignores a broken stored copy", () => {
    const seen = vi.fn();
    const un = subscribeEvents(seen);
    pushEvent("a");
    clearEvents();
    expect(seen).toHaveBeenCalledTimes(2);
    un();

    sessionStorage.setItem("vectasim.liveEvents", "{not json");
    resetEventLogForTests();
    expect(getEvents()).toEqual([]);
  });

  it("works without sessionStorage", () => {
    vi.stubGlobal("sessionStorage", undefined);
    resetEventLogForTests();
    pushEvent("Flug begonnen (Off-Block)");
    expect(getEvents()).toHaveLength(1);
  });

  it("the folded summary shows the count and the newest line, not the oldest", () => {
    expect(eventsSummary([])).toBeUndefined();
    resetEventLogForTests();
    pushEvent("Flug begonnen (Off-Block)", 1);
    pushEvent("Phase: Vorbereitung → Rollen", 2);
    pushEvent("Phase: Rollen → Start", 3);
    expect(eventsSummary(getEvents())).toBe("3 · Phase: Rollen → Start");
  });
});
