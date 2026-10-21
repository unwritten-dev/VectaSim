import { afterEach, describe, expect, it, vi } from "vitest";
import { CATCH_UP_MS, CameraGuard, FOLLOW_EVENT, FOLLOW_GLIDE_MAX_MS, FollowGlide, GLIDE_EVENT, MAX_CENTER_LAT, anchorCenter, followCameraUpdate, isMultiTouch, stepTowards, type FollowAnchor } from "./followCamera";

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
    // N-3: the result stays in the camera centre's world copy (no jump by 360° to −179.5)
    expect(stepTowards({ lon: 179.5, lat: 0, elev: 0 }, { lon: -179.5, lat: 0, elev: 0 }, 1).lon).toBeCloseTo(180.5, 9);
  });

  it("N-3: a camera left beyond ±180 by an ease follows a wrapped target without a world-copy jump", () => {
    // MapLibre's easeTo over the date line left the centre at 180.4; the aircraft reports −179.5
    let cam = { lon: 180.4, lat: -15, elev: 0 };
    for (let i = 0; i < 5; i++) {
      const next = stepTowards(cam, { lon: -179.5 + i * 0.01, lat: -15, elev: 0 }, 0.5);
      expect(Math.abs(next.lon - cam.lon)).toBeLessThan(1);
      cam = next;
    }
    expect(cam.lon).toBeGreaterThan(180);
  });

  it("N-1: the latitude never leaves ±MAX_CENTER_LAT", () => {
    expect(stepTowards({ lon: 0, lat: 85, elev: 0 }, { lon: 0, lat: 89.9, elev: 0 }, 1).lat).toBe(MAX_CENTER_LAT);
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

  it("N-1: a pole-near shift scaled up by a strong zoom-out stays a valid latitude (LngLat threw beyond ±90)", () => {
    // measured at zoom 12 beside the card near the pole, zoomed out to 2 (factor 1024)
    const a: FollowAnchor = { lon: 20, lat: 84, shift: { dLon: 0.01, dLat: -0.02, atZoom: 12 } };
    const c = anchorCenter(a, 2);
    expect(Math.abs(c.lat)).toBeLessThanOrEqual(MAX_CENTER_LAT);
    expect(Number.isFinite(c.lon)).toBe(true);
    // the extrapolation is meaningless that far out: the aircraft is centred instead
    expect(anchorCenter({ lon: 20, lat: 10, shift: { dLon: 0.1, dLat: 0.1, atZoom: 12 } }, 2)).toEqual({ lon: 20, lat: 10 });
    // an aircraft itself beyond Web Mercator's limit (polar route)
    expect(anchorCenter({ lon: 0, lat: 89.5 }, 5).lat).toBe(MAX_CENTER_LAT);
    // the hook builds LngLat from it inside the gesture frame: never out of range
    const lngLat = (lon: number, lat: number) => {
      if (lat > 90 || lat < -90) throw new Error("Invalid LngLat latitude value");
      return { lng: lon, lat } as never;
    };
    const update = followCameraUpdate({ userMoving: () => true }, () => a, lngLat);
    for (let z = 12; z >= 0; z -= 0.5) expect(() => update({ center: { lng: 20, lat: 80 } as never, zoom: z, roll: 0, pitch: 0, bearing: 0, elevation: 0 })).not.toThrow();
  });

  it("N-3: in the world copy of the camera centre", () => {
    expect(anchorCenter({ lon: -179.5, lat: 0 }, 5, 180.4).lon).toBeCloseTo(180.5, 9);
    expect(anchorCenter({ lon: 179.5, lat: 0 }, 5, -180.2).lon).toBeCloseTo(-180.5, 9);
    expect(anchorCenter({ lon: 8, lat: 0 }, 5, 368).lon).toBeCloseTo(368, 9);
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

  it("N-3: the held centre is in the frame's world copy (after an ease over the date line)", () => {
    const update = followCameraUpdate({ userMoving: () => true }, () => ({ lon: -179.6, lat: -10 }), lngLat);
    const out = update(next(180.3, -10, 8)) as { center: { lng: number } };
    expect(out.center.lng).toBeCloseTo(180.4, 9);
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

describe("FollowGlide (own follow camera between two samples)", () => {
  it("glides linearly over the sample gap and then stays on the target", () => {
    const g = new FollowGlide();
    expect(g.at(0)).toBeNull();
    expect(g.done(0)).toBe(true);
    g.set({ lon: 8, lat: 50, elev: 0 }, { lon: 8.01, lat: 50.01, elev: 100 }, 1000, 100);
    expect(g.at(1050)).toEqual({ lon: expect.closeTo(8.005, 9), lat: expect.closeTo(50.005, 9), elev: expect.closeTo(50, 9) });
    expect(g.done(1050)).toBe(false);
    expect(g.at(1200)).toEqual({ lon: 8.01, lat: 50.01, elev: 100 });
    expect(g.done(1100)).toBe(true);
  });
  it("never longer than FOLLOW_GLIDE_MAX_MS; a zero gap jumps; the short way across ±180", () => {
    const g = new FollowGlide();
    g.set({ lon: 179.9, lat: 0, elev: 0 }, { lon: -179.9, lat: 0, elev: 0 }, 0, 5000);
    expect(g.done(FOLLOW_GLIDE_MAX_MS)).toBe(true);
    expect(Math.abs(g.at(FOLLOW_GLIDE_MAX_MS / 2)!.lon)).toBeCloseTo(180, 6);
    g.set({ lon: 1, lat: 1, elev: 0 }, { lon: 2, lat: 2, elev: 0 }, 0, 0);
    expect(g.at(0)).toEqual({ lon: 2, lat: 2, elev: 0 });
    g.clear();
    expect(g.at(0)).toBeNull();
  });
  it("N-3: the target is taken in the camera's world copy, also at the end of the glide", () => {
    const g = new FollowGlide();
    g.set({ lon: 180.3, lat: 0, elev: 0 }, { lon: -179.5, lat: 0, elev: 0 }, 0, 100);
    expect(g.at(50)!.lon).toBeCloseTo(180.4, 9);
    expect(g.at(1000)!.lon).toBeCloseTo(180.5, 9);
  });
});
