import { describe, expect, it, vi } from "vitest";
import { attachStyleLifecycle, type StyleLifecycleHooks } from "./styleLifecycle";

/** A map with events, a layer list (custom layers among them) and setStyle. */
function fakeMap() {
  const listeners = new Map<string, Array<() => void>>();
  const map = {
    layers: [] as Array<{ id: string; type: string }>,
    removed: [] as string[],
    styles: [] as unknown[],
    on(type: string, f: () => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), f]);
    },
    off(type: string, f: () => void) {
      listeners.set(type, (listeners.get(type) ?? []).filter((g) => g !== f));
    },
    fire(type: string) {
      for (const f of listeners.get(type) ?? []) f();
    },
    count: (type: string) => listeners.get(type)?.length ?? 0,
    setStyle(style: unknown) {
      map.styles.push(style);
    },
    getLayersOrder: () => map.layers.map((l) => l.id),
    getLayer: (id: string) => map.layers.find((l) => l.id === id),
    removeLayer(id: string) {
      map.removed.push(id);
      map.layers = map.layers.filter((l) => l.id !== id);
    },
  };
  return map;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Hooks that record the flow as LiveMap uses it: ready flag, model ref, setups (each awaiting `gate`). */
function hooks(over: Partial<StyleLifecycleHooks> = {}) {
  const state = { ready: false, model: null as string | null, setups: 0, firsts: [] as boolean[], styleNo: 0 };
  let gate: Promise<void> = Promise.resolve();
  const h: StyleLifecycleHooks = {
    setup: async (isCurrent) => {
      state.setups++;
      await gate;
      if (!isCurrent()) return false;
      state.model = `model-${state.setups}`;
      return true;
    },
    ready: (first) => {
      state.ready = true;
      state.firsts.push(first);
    },
    unready: () => {
      state.ready = false;
    },
    dropped: () => {
      state.model = null;
    },
    loadStyle: () => Promise.resolve(`style-${++state.styleNo}`),
    alive: () => true,
    ...over,
  };
  return {
    h,
    state,
    hold() {
      let open!: () => void;
      gate = new Promise<void>((r) => (open = r));
      return () => open();
    },
  };
}

describe("style life cycle (LiveMap: first load, theme change, WebGL context loss)", () => {
  it("the first style load sets up the layers once and is the first ready", async () => {
    const map = fakeMap();
    const { h, state } = hooks();
    attachStyleLifecycle(map, h);
    map.fire("style.load");
    await flush();
    expect(state).toMatchObject({ ready: true, model: "model-1", setups: 1, firsts: [true] });
  });

  it("context lost → not ready, the model is gone; restored → custom layers freed, a fresh style, the layers again", async () => {
    const map = fakeMap();
    const { h, state } = hooks();
    attachStyleLifecycle(map, h);
    map.fire("style.load");
    await flush();
    map.layers = [
      { id: "background", type: "background" },
      { id: "track-3d", type: "custom" },
      { id: "aircraft-model", type: "custom" },
    ];
    map.fire("webglcontextlost");
    expect(state.ready).toBe(false);
    expect(state.model).toBeNull();
    map.fire("webglcontextrestored");
    await flush();
    // like a theme change: our WebGL layers removed before setStyle, then a new style
    expect(map.removed).toEqual(["track-3d", "aircraft-model"]);
    expect(map.styles).toEqual(["style-1"]);
    map.fire("style.load");
    await flush();
    expect(state).toMatchObject({ ready: true, model: "model-2", setups: 2, firsts: [true, false] });
  });

  it("a setup still awaiting when the context is lost is abandoned (never marks the map ready)", async () => {
    const map = fakeMap();
    const t = hooks();
    attachStyleLifecycle(map, t.h);
    const open = t.hold();
    map.fire("style.load");
    map.fire("webglcontextlost");
    open();
    await flush();
    expect(t.state.ready).toBe(false);
    expect(t.state.model).toBeNull();
    expect(t.state.firsts).toEqual([]);
  });

  it("two theme changes in a row: only the newer style is applied; an older style load is abandoned", async () => {
    const map = fakeMap();
    const t = hooks();
    const lc = attachStyleLifecycle(map, t.h);
    lc.reload();
    lc.reload();
    await flush();
    expect(map.styles).toEqual(["style-2"]);
    const open = t.hold();
    map.fire("style.load");
    map.fire("style.load");
    open();
    await flush();
    expect(t.state.firsts).toEqual([true]);
  });

  it("a torn-down map does nothing; dispose removes the listeners", async () => {
    const map = fakeMap();
    let alive = true;
    const t = hooks({ alive: () => alive });
    const lc = attachStyleLifecycle(map, t.h);
    alive = false;
    map.fire("webglcontextrestored");
    await flush();
    expect(map.styles).toEqual([]);
    lc.dispose();
    expect(map.count("style.load") + map.count("webglcontextlost") + map.count("webglcontextrestored")).toBe(0);
  });

  it("a basemap that cannot be loaded is reported, the old style stays", async () => {
    const map = fakeMap();
    const onError = vi.fn();
    const t = hooks({ loadStyle: () => Promise.reject(new Error("offline")), onError });
    attachStyleLifecycle(map, t.h).reload();
    await flush();
    expect(onError).toHaveBeenCalled();
    expect(map.styles).toEqual([]);
  });
});
