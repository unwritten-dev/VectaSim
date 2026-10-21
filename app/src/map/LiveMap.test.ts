import { describe, expect, it, vi } from "vitest";

vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url", () => ({ default: "worker.js" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { cameraMoveVisible, insetOffset, isMapLoadError, measureInsets, pointFree, revealTraffic } = await import("./LiveMap");
const { CameraGuard, followCameraUpdate } = await import("./followCamera");

describe("isMapLoadError (offline hint)", () => {
  it("tile, source, HTTP status and fetch failures count; other errors do not", () => {
    expect(isMapLoadError({ tile: {} })).toBe(true);
    expect(isMapLoadError({ sourceId: "openmaptiles" })).toBe(true);
    expect(isMapLoadError({ error: { status: 404 } })).toBe(true);
    expect(isMapLoadError({ error: { message: "Failed to fetch" } })).toBe(true);
    expect(isMapLoadError({ error: { message: "AJAXError: Not Found" } })).toBe(true);
    expect(isMapLoadError({ error: { message: "Layer 'x' does not exist" } })).toBe(false);
    expect(isMapLoadError({ error: null })).toBe(false);
  });
});

/** An element whose getBoundingClientRect is `r`; `kids` answer querySelector by class. */
function el(r: { left: number; top: number; width: number; height: number }, kids: Record<string, unknown> = {}, parent?: unknown) {
  const rect = { ...r, right: r.left + r.width, bottom: r.top + r.height };
  return {
    getBoundingClientRect: () => rect,
    querySelector: (sel: string) => kids[sel] ?? null,
    closest: () => parent ?? null,
    parentElement: parent ?? null,
  };
}

describe("free map area (traffic card, HUD)", () => {
  it("without card and HUD: the default margins (toolbar on top)", () => {
    const wrap = el({ left: 0, top: 0, width: 1200, height: 800 });
    expect(measureInsets(wrap as never)).toEqual({ top: 80, right: 24, bottom: 24, left: 24 });
    expect(measureInsets(null)).toEqual({ top: 80, right: 24, bottom: 24, left: 24 });
  });

  it("the card on the right and the HUD at the bottom push the free area in", () => {
    const card = el({ left: 860, top: 60, width: 320, height: 500 });
    const hud = el({ left: 0, top: 700, width: 1200, height: 100 });
    const area = el({ left: 0, top: 0, width: 1200, height: 800 }, { ".hud": hud });
    const wrap = el({ left: 0, top: 0, width: 1200, height: 800 }, { ".traffic-card": card }, area);
    const i = measureInsets(wrap as never);
    expect(i.right).toBe(1200 - 860 + 24);
    expect(i.bottom).toBe(800 - 700 + 24);
    // centred target → middle of the free area: left of the card, above the HUD
    expect(insetOffset(i)).toEqual([(24 - i.right) / 2, (80 - i.bottom) / 2]);
  });

  it("a tiny window keeps a third of the width and half the height free", () => {
    const card = el({ left: 10, top: 0, width: 300, height: 300 });
    const wrap = el({ left: 0, top: 0, width: 320, height: 200 }, { ".traffic-card": card });
    const i = measureInsets(wrap as never);
    expect(i.right).toBeCloseTo(320 * 0.66, 6);
    expect(i.bottom).toBeLessThanOrEqual(100);
  });

  it("pointFree: inside the free area only", () => {
    const i = { top: 80, right: 344, bottom: 124, left: 24 };
    expect(pointFree({ x: 400, y: 300 }, i, 1200, 800)).toBe(true);
    expect(pointFree({ x: 1000, y: 300 }, i, 1200, 800)).toBe(false); // under the card
    expect(pointFree({ x: 400, y: 750 }, i, 1200, 800)).toBe(false); // under the HUD
    expect(pointFree({ x: 400, y: 40 }, i, 1200, 800)).toBe(false); // under the toolbar
  });
});

describe("follow camera: only moves that show (N5)", () => {
  /** A flat map: 1 px per 0.001° in both axes around the centre. */
  const map = (elev = 0) => ({
    getCenterElevation: () => elev,
    getCenter: () => ({ lng: 8, lat: 50 }),
    project: (ll: [number, number] | { lng: number; lat: number }) => {
      const [lon, lat] = Array.isArray(ll) ? ll : [ll.lng, ll.lat];
      return { x: (lon - 8) * 1000, y: (50 - lat) * 1000 };
    },
  });
  it("below half a pixel and 2 m of centre height nothing is sent", () => {
    expect(cameraMoveVisible(map() as never, { lon: 8.0004, lat: 50, elev: 0 })).toBe(false);
    expect(cameraMoveVisible(map() as never, { lon: 8.0006, lat: 50, elev: 0 })).toBe(true);
    expect(cameraMoveVisible(map(100) as never, { lon: 8, lat: 50, elev: 101 })).toBe(false);
    expect(cameraMoveVisible(map(100) as never, { lon: 8, lat: 50, elev: 103 })).toBe(true);
  });
});

describe("N-2: a click on a traffic aircraft under the card while the own aircraft is followed", () => {
  const insets = { top: 80, right: 344, bottom: 124, left: 24 };

  /** A map whose camera emits movestart for every ease (MapLibre does), 1200×800, the clicked aircraft at (1000, 300): under the card. */
  function fakeMap() {
    const listeners = new Map<string, Array<(e: unknown) => void>>();
    const eases: Array<{ opts: unknown; data: unknown }> = [];
    const map = {
      moving: false,
      on(type: string, fn: (e: unknown) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
      off() {},
      isMoving: () => map.moving,
      getCanvas: () => ({ clientWidth: 1200, clientHeight: 800 }),
      project: () => ({ x: 1000, y: 300 }),
      easeTo(opts: unknown, data?: Record<string, unknown>) {
        eases.push({ opts, data });
        map.moving = true;
        for (const fn of listeners.get("movestart") ?? []) fn({ type: "movestart", ...data });
      },
      eases,
    };
    return map;
  }

  it("the reveal suspends own follow first and is a glide: the follow hook leaves its frames alone", () => {
    const map = fakeMap();
    const guard = new CameraGuard(map as never, null);
    let following = true;
    const own = { lon: 8, lat: 50 };
    const hook = followCameraUpdate(guard, () => (following ? own : null), (lon, lat) => ({ lng: lon, lat }) as never);
    const order: string[] = [];
    const moved = revealTraffic(map as never, { lon: 9, lat: 50 }, insets, () => {
      order.push("suspend");
      following = false;
    });
    expect(moved).toBe(true);
    expect(order).toEqual(["suspend"]);
    expect(map.eases).toHaveLength(1);
    expect(map.eases[0].data).toMatchObject({ vectasimGlide: true });
    // every frame of the ease: no centre forced back onto the own aircraft
    expect(hook({ center: { lng: 8.5, lat: 50 } as never, zoom: 9, roll: 0, pitch: 0, bearing: 0, elevation: 0 })).toEqual({});
    // even if follow were still on, a glide is not held (the list selection's path)
    following = true;
    expect(guard.userMoving()).toBe(false);
    expect(hook({ center: { lng: 8.5, lat: 50 } as never, zoom: 9, roll: 0, pitch: 0, bearing: 0, elevation: 0 })).toEqual({});
  });

  it("an aircraft already in the free area: no camera move, own follow stays on", () => {
    const map = { ...fakeMap(), project: () => ({ x: 400, y: 300 }) };
    const suspend = vi.fn();
    expect(revealTraffic(map as never, { lon: 9, lat: 50 }, insets, suspend)).toBe(false);
    expect(suspend).not.toHaveBeenCalled();
    expect(map.eases).toHaveLength(0);
  });
});
