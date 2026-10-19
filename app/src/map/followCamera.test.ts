import { afterEach, describe, expect, it, vi } from "vitest";
import { CATCH_UP_MS, CameraGuard, FOLLOW_EVENT, GLIDE_EVENT, anchorCenter, followCameraUpdate, isMultiTouch, stepTowards, type FollowAnchor } from "./followCamera";

/** Just enough of a MapLibre map: events, isMoving, the gesture handlers and the canvas container. */
function fakeMap() {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const container = new EventTarget();
  const handler = () => ({ active: false, isActive() {
    return this.active;
  } });
  const map = {
    moving: false,
    dragRotate: handler(),
    scrollZoom: handler(),
    on(type: string, fn: (e: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      return map;
    },
    off(type: string, fn: (e: unknown) => void) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
      return map;
    },
    fire(type: string, data: Record<string, unknown> = {}) {
      for (const fn of listeners.get(type) ?? []) fn({ type, ...data });
    },
    isMoving() {
      return map.moving;
    },
    getCanvasContainer: () => container as unknown as HTMLElement,
    container,
    count: (type: string) => listeners.get(type)?.length ?? 0,
  };
  return map;
}

describe("CameraGuard", () => {
  const win = new EventTarget();
  afterEach(() => vi.useRealTimers());

  it("the follow camera's own moves do not take the camera", () => {
    const map = fakeMap();
    const g = new CameraGuard(map as never, win);
    map.moving = true;
    map.fire("movestart", { ...FOLLOW_EVENT });
    expect(g.busy()).toBe(false);
    map.fire("moveend", { ...FOLLOW_EVENT });
    expect(g.busy()).toBe(false);
  });

  it("a gesture or a foreign animation holds every follow update until it ends", () => {
    const map = fakeMap();
    const g = new CameraGuard(map as never, win);
    // right-drag rotate: the handler reports the gesture, MapLibre fires movestart with the DOM event
    map.moving = true;
    map.dragRotate.active = true;
    map.fire("movestart", { originalEvent: {} });
    expect(g.busy()).toBe(true);
    // a follow update arriving now (10 Hz telemetry) must be dropped – it would reset the drag
    const sent: string[] = [];
    const followSample = () => {
      if (!g.busy()) sent.push("easeTo");
    };
    for (let i = 0; i < 5; i++) followSample();
    expect(sent).toEqual([]);
    map.dragRotate.active = false;
    map.moving = false;
    map.fire("moveend", { originalEvent: {} });
    expect(g.busy()).toBe(false);
    followSample();
    expect(sent).toEqual(["easeTo"]);
    // the +/− button's zoom animation (an easeTo without our flag) is not clipped either
    map.moving = true;
    map.fire("movestart");
    expect(g.busy()).toBe(true);
    map.fire("moveend");
    expect(g.busy()).toBe(false);
  });

  it("a pressed mouse button counts before the handler reports the drag (click tolerance)", () => {
    const map = fakeMap();
    const g = new CameraGuard(map as never, win);
    map.container.dispatchEvent(new Event("pointerdown"));
    expect(g.busy()).toBe(true);
    win.dispatchEvent(new Event("pointerup"));
    expect(g.busy()).toBe(false);
  });

  it("frees itself when a foreign move never reported its end", () => {
    const map = fakeMap();
    const g = new CameraGuard(map as never, win);
    map.moving = true;
    map.fire("movestart");
    expect(g.busy()).toBe(true);
    map.moving = false;
    expect(g.busy()).toBe(false);
  });

  it("catches up gradually after a release, locked on afterwards", () => {
    vi.useFakeTimers();
    const map = fakeMap();
    const g = new CameraGuard(map as never, win);
    expect(g.catchUp()).toBe(1);
    map.fire("movestart");
    map.fire("moveend");
    const t0 = g.releasedAt;
    expect(g.catchUp(t0)).toBeLessThan(0.1);
    expect(g.catchUp(t0 + CATCH_UP_MS / 2)).toBeGreaterThan(0.2);
    expect(g.catchUp(t0 + CATCH_UP_MS)).toBe(1);
  });

  it("dispose removes its listeners", () => {
    const map = fakeMap();
    const g = new CameraGuard(map as never, win);
    expect(map.count("movestart")).toBe(1);
    g.dispose();
    expect(map.count("movestart")).toBe(0);
    expect(map.count("moveend")).toBe(0);
  });
});

describe("stepTowards", () => {
  it("moves by the share k, longitudes the short way round", () => {
    expect(stepTowards({ lon: 8, lat: 50, elev: 0 }, { lon: 9, lat: 51, elev: 1000 }, 1)).toEqual({ lon: 9, lat: 51, elev: 1000 });
    const half = stepTowards({ lon: 179, lat: 0, elev: 0 }, { lon: -179, lat: 0, elev: 0 }, 0.5);
    expect(Math.abs(half.lon)).toBeCloseTo(180, 9);
    expect(stepTowards({ lon: 179.5, lat: 0, elev: 0 }, { lon: -179.5, lat: 0, elev: 0 }, 1).lon).toBeCloseTo(-179.5, 9);
  });
});

describe("CameraGuard.userMoving", () => {
  const win = new EventTarget();

  it("a zoom by the user (wheel, +/− button, double-click) is the user's; follow moves and our glides are not", () => {
    const map = fakeMap();
    const g = new CameraGuard(map as never, win);
    expect(g.userMoving()).toBe(false);
    // the follow camera's own sample move
    map.moving = true;
    map.fire("movestart", { ...FOLLOW_EVENT });
    expect(g.userMoving()).toBe(false);
    map.fire("moveend", { ...FOLLOW_EVENT });
    // wheel: the scroll handler reports active before its first frame
    map.scrollZoom.active = true;
    expect(g.userMoving()).toBe(true);
    map.fire("movestart", { originalEvent: {} });
    map.scrollZoom.active = false;
    expect(g.userMoving()).toBe(true);
    map.fire("moveend", { originalEvent: {} });
    expect(g.userMoving()).toBe(false);
    // the +/− button's easeTo (no flag)
    map.fire("movestart");
    expect(g.userMoving()).toBe(true);
    map.fire("moveend");
    // our glide onto the aircraft (centre button): follow waits, but the glide is not held
    map.fire("movestart", { ...GLIDE_EVENT });
    expect(g.busy()).toBe(true);
    expect(g.userMoving()).toBe(false);
    // … unless the user zooms into it
    map.scrollZoom.active = true;
    expect(g.userMoving()).toBe(true);
    map.scrollZoom.active = false;
    map.fire("moveend", { ...GLIDE_EVENT });
    map.moving = false;
    expect(g.userMoving()).toBe(false);
  });
});

describe("anchorCenter", () => {
  it("is the aircraft without a shift; a shift (free area beside the card) scales with 2^−zoom", () => {
    expect(anchorCenter({ lon: 8.5, lat: 50 }, 12)).toEqual({ lon: 8.5, lat: 50 });
    const a: FollowAnchor = { lon: 8.5, lat: 50, shift: { dLon: 0.2, dLat: -0.04, atZoom: 9 } };
    expect(anchorCenter(a, 9)).toEqual({ lon: 8.3, lat: 50.04 });
    const z10 = anchorCenter(a, 10);
    expect(z10.lon).toBeCloseTo(8.4, 12);
    expect(z10.lat).toBeCloseTo(50.02, 12);
    const z8 = anchorCenter(a, 8);
    expect(z8.lon).toBeCloseTo(8.1, 12);
    // across the antimeridian
    expect(anchorCenter({ lon: -179.9, lat: 0, shift: { dLon: 0.2, dLat: 0, atZoom: 5 } }, 5).lon).toBeCloseTo(179.9, 9);
  });
});

describe("followCameraUpdate", () => {
  const lngLat = (lon: number, lat: number) => ({ lng: lon, lat }) as never;
  const next = (lon: number, lat: number, zoom: number) => ({ center: { lng: lon, lat } as never, zoom, roll: 0, pitch: 58, bearing: 30, elevation: 0 });

  it("changes nothing outside a user move or without a followed aircraft", () => {
    const anchor: FollowAnchor = { lon: 8.6, lat: 50.05, elev: 600 };
    expect(followCameraUpdate({ userMoving: () => false }, () => anchor, lngLat)(next(8, 50, 9))).toEqual({});
    expect(followCameraUpdate({ userMoving: () => true }, () => null, lngLat)(next(8, 50, 9))).toEqual({});
  });

  it("wheel zoom towards the pointer while following: every frame keeps the aircraft centred at its height, zoom stays the user's", () => {
    const anchor: FollowAnchor = { lon: 8.6, lat: 50.05, elev: 600 };
    const update = followCameraUpdate({ userMoving: () => true }, () => anchor, lngLat);
    // MapLibre zooms around the pointer: the requested centre drifts towards it frame by frame
    for (let i = 0; i <= 10; i++) {
      const out = update(next(8.6 - i * 0.01, 50.05 + i * 0.008, 9 + i * 0.05));
      expect(out.center).toEqual({ lng: 8.6, lat: 50.05 });
      expect(out.elevation).toBe(600);
      // zoom, bearing, pitch, roll: untouched (the user's)
      expect(out.zoom).toBeUndefined();
      expect(out.bearing).toBeUndefined();
      expect(out.pitch).toBeUndefined();
      expect(out.roll).toBeUndefined();
    }
  });

  it("a followed traffic aircraft stays in the free area at every zoom; a 2D anchor leaves the height alone", () => {
    const anchor: FollowAnchor = { lon: 8.6, lat: 50.05, shift: { dLon: 0.1, dLat: 0, atZoom: 10 } };
    const update = followCameraUpdate({ userMoving: () => true }, () => anchor, lngLat);
    const at10 = update(next(8.0, 50, 10));
    expect(at10.center).toEqual({ lng: 8.5, lat: 50.05 });
    expect(at10.elevation).toBeUndefined();
    const at11 = update(next(8.0, 50, 11)) as { center: { lng: number } };
    expect(at11.center.lng).toBeCloseTo(8.55, 12);
  });

  it("the anchor is read on every frame (the aircraft moves on during a long zoom)", () => {
    let anchor: FollowAnchor = { lon: 8.6, lat: 50.05 };
    const update = followCameraUpdate({ userMoving: () => true }, () => anchor, lngLat);
    expect(update(next(0, 0, 9)).center).toEqual({ lng: 8.6, lat: 50.05 });
    anchor = { lon: 8.61, lat: 50.06 };
    expect(update(next(0, 0, 9.1)).center).toEqual({ lng: 8.61, lat: 50.06 });
  });
});

describe("isMultiTouch", () => {
  it("a two-finger pinch does not count as a drag that ends follow; one finger or the mouse does", () => {
    expect(isMultiTouch({ touches: { length: 2 } } as unknown as Event)).toBe(true);
    expect(isMultiTouch({ touches: { length: 1 } } as unknown as Event)).toBe(false);
    expect(isMultiTouch({ button: 0 } as unknown as Event)).toBe(false);
    expect(isMultiTouch(undefined)).toBe(false);
  });
});
