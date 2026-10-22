import { describe, expect, it, vi } from "vitest";

// every invoke stays pending until the test resolves it, in any order
type Pending = { cmd: string; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const pending: Pending[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => new Promise((resolve, reject) => pending.push({ cmd, resolve, reject }))),
}));
const handlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return () => handlers.delete(name);
  }),
}));

const { subscribeHistoryFacts, historyFactsSnapshot } = await import("./HistoryPanel");

const take = (cmd: string): Pending[] => {
  const out = pending.filter((p) => p.cmd === cmd);
  out.forEach((p) => pending.splice(pending.indexOf(p), 1));
  return out;
};
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const metricsRow = (flightId: string) => ({ flightId });

describe("history facts store", () => {
  it("each list applies only the answer to its newest request (flight end: three events within ms)", async () => {
    const un = subscribeHistoryFacts(() => {});
    await flush();
    // the first subscriber loads all three
    take("landing_facts_recent").forEach((p) => p.resolve({ facts: [] }));
    take("approach_facts_recent").forEach((p) => p.resolve({ facts: [] }));
    take("flight_metrics_recent").forEach((p) => p.resolve({ facts: [] }));
    await flush();

    // flight end: logbook:changed (metrics row not written yet), then flight:metrics
    handlers.get("logbook:changed")!({ payload: null });
    handlers.get("flight:metrics")!({ payload: "f-new" });
    const [first, second] = take("flight_metrics_recent");
    expect(first && second).toBeTruthy();
    second.resolve({ facts: [metricsRow("f-new"), metricsRow("f-old")] });
    await flush();
    expect(historyFactsSnapshot().metrics?.map((m) => m.flightId)).toEqual(["f-new", "f-old"]);
    // the older request answers last, without the new row: ignored
    first.resolve({ facts: [metricsRow("f-old")] });
    await flush();
    expect(historyFactsSnapshot().metrics?.map((m) => m.flightId)).toEqual(["f-new", "f-old"]);

    // the same guard for the approaches and the landings: logbook:changed above asked for both
    const [aOld] = take("approach_facts_recent");
    const [lOld] = take("landing_facts_recent");
    handlers.get("approach:facts")!({ payload: "f-new" });
    const [aNew] = take("approach_facts_recent");
    aNew.resolve({ facts: [{ flightId: "f-new" }] });
    aOld.resolve({ facts: [] });
    await flush();
    expect(historyFactsSnapshot().approaches).toEqual([{ flightId: "f-new" }]);

    handlers.get("logbook:changed")!({ payload: null });
    const [lNew] = take("landing_facts_recent");
    lNew.resolve({ facts: [] });
    // a stale failure must not set the error either
    lOld.reject("database is locked");
    await flush();
    expect(historyFactsSnapshot().error).toBeNull();
    take("approach_facts_recent").forEach((p) => p.resolve({ facts: [] }));
    take("flight_metrics_recent").forEach((p) => p.resolve({ facts: [] }));
    await flush();
    un();
  });
});
