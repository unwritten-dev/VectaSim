import { describe, expect, it, vi } from "vitest";

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
const pending: Pending[] = [];
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise((resolve, reject) => pending.push({ resolve, reject }))) }));
const handlers = new Map<string, () => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: () => void) => {
    handlers.set(name, cb);
    return () => handlers.delete(name);
  }),
}));

const store = await import("./approachProfiles");
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const result = (ids: string[]) => ({ keys: [], profiles: ids.map((id) => ({ id, name: id.toUpperCase(), builtin: false, overrides: {}, effective: [] })) });

describe("approach profile list state", () => {
  it("loading, error with retry, an event during a load is not lost", async () => {
    // the hooks subscribe through useSyncExternalStore; drive the same store via the reload export
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    let seen: ReturnType<typeof store.useApproachProfilesState> | null = null;
    const Probe = () => {
      seen = store.useApproachProfilesState();
      return null;
    };
    renderToStaticMarkup(React.createElement(Probe));
    expect(seen).toEqual({ status: "loading", list: null });
    // without the list a custom id is shown as is, not as "deleted"
    expect(store.profileName("my-va", null)).toBe("my-va");

    store.reloadApproachProfiles();
    expect(pending).toHaveLength(1);
    pending.shift()!.reject("backend busy");
    await flush();
    renderToStaticMarkup(React.createElement(Probe));
    expect(seen).toEqual({ status: "error", list: null });

    // retry: loading again, then ok
    store.reloadApproachProfiles();
    renderToStaticMarkup(React.createElement(Probe));
    expect(seen!.status).toBe("loading");
    // an import elsewhere while this load runs: remembered, loaded once more afterwards
    store.reloadApproachProfiles();
    expect(pending).toHaveLength(1);
    pending.shift()!.resolve(result(["old"]));
    await flush();
    expect(pending).toHaveLength(1);
    pending.shift()!.resolve(result(["old", "new"]));
    await flush();
    renderToStaticMarkup(React.createElement(Probe));
    expect(seen!.status).toBe("ok");
    expect(seen!.list?.profiles.map((p) => p.id)).toEqual(["old", "new"]);
    expect(store.profileName("gone", seen!.list)).toBe("profile “gone” (deleted)");
  });
});
