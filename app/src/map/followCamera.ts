// The live map's follow cameras (own aircraft, selected traffic) without fighting the user.
//
// Every MapLibre `easeTo` / `jumpTo` first calls `stop()`, which resets all gesture handlers: a
// follow update per telemetry sample (10 Hz) cut a right-drag (rotate / pitch) after ≤ 100 ms and
// clipped the zoom animation of the +/− buttons and of the 3D toggle. So:
// - a follow move carries FOLLOW_EVENT in its event data; any other camera move (a gesture, a
//   button, our own reveal / fit eases) marks the camera as taken until its `moveend`;
// - while it is taken – or a button / finger is down on the map (a gesture may be starting; the
//   handlers report active only after a few px, a reset before that kills the drag) – no
//   follow update is sent; afterwards the camera catches up smoothly (CATCH_UP_MS).
//
// Zooming while following (wheel, +/− buttons, double-click, pinch, keyboard) is not a reason
// to lose the aircraft: MapLibre zooms around the mouse pointer / the click / the pinch centre,
// so the aircraft slid off-centre for the whole zoom and the follow camera yanked the view back
// afterwards – the zoom felt locked. Now the follow camera also holds the aircraft *during* such a
// move, without sending a camera command: MapLibre's `transformCameraUpdate` hook
// (followCameraUpdate) replaces the centre – and in 3D the centre height – of every frame of a
// user move with the follow anchor, while zoom, bearing and pitch stay what the user does. Our
// own glides (centre button, follow a traffic aircraft) carry GLIDE_EVENT and are not held: they
// fly to the aircraft themselves.

import type * as maplibregl from "maplibre-gl";

/** Event-data flag of the follow camera's own moves. */
export const FOLLOW_EVENT = { vectasimFollow: true } as const;
/** Event-data flag of our own programmatic glides onto a followed aircraft: follow waits, the anchor does not hold them. */
export const GLIDE_EVENT = { vectasimGlide: true } as const;
/** After a foreign move the camera glides back onto the aircraft for about this long (if it is off at all). */
export const CATCH_UP_MS = 400;

type MapLike = Pick<maplibregl.Map, "on" | "off" | "isMoving"> & {
  getCanvasContainer?(): HTMLElement;
  dragPan?: { isActive(): boolean };
  dragRotate?: { isActive(): boolean };
  scrollZoom?: { isActive(): boolean };
  touchZoomRotate?: { isActive(): boolean };
  touchPitch?: { isActive(): boolean };
  keyboard?: { isActive(): boolean };
  boxZoom?: { isActive(): boolean };
};

const HANDLERS = ["dragPan", "dragRotate", "scrollZoom", "touchZoomRotate", "touchPitch", "keyboard", "boxZoom"] as const;

/** Is the camera the user's (or another animation's) right now? Follow updates wait while it is. */
export class CameraGuard {
  private taken = false;
  /** The move that took the camera is one of our glides (GLIDE_EVENT). */
  private glide = false;
  /** A mouse button / finger is down on the map: a gesture may be starting (handlers only report active after a few px). */
  private pressed = false;
  private readonly onDown = () => {
    this.pressed = true;
  };
  private readonly onUp = () => {
    if (!this.pressed) return;
    this.pressed = false;
    this.releasedAt = performance.now();
  };
  /** When the camera was last released (performance.now clock); drives the catch-up. */
  releasedAt = -Infinity;
  private readonly onStart = (e: { vectasimFollow?: boolean; vectasimGlide?: boolean }) => {
    if (e?.vectasimFollow) return;
    this.taken = true;
    this.glide = !!e?.vectasimGlide;
  };
  private readonly onEnd = (e: { vectasimFollow?: boolean }) => {
    if (!e?.vectasimFollow && this.taken) {
      this.taken = false;
      this.releasedAt = performance.now();
    }
  };

  /** `win`: where the button is released (the window; a stand-in in tests). */
  constructor(
    private readonly map: MapLike,
    private readonly win: EventTarget | null = typeof window !== "undefined" ? window : null,
  ) {
    map.on("movestart", this.onStart as never);
    map.on("moveend", this.onEnd as never);
    map.getCanvasContainer?.().addEventListener("pointerdown", this.onDown);
    this.win?.addEventListener("pointerup", this.onUp);
    this.win?.addEventListener("pointercancel", this.onUp);
    this.win?.addEventListener("blur", this.onUp);
  }

  dispose() {
    this.map.off("movestart", this.onStart as never);
    this.map.off("moveend", this.onEnd as never);
    this.map.getCanvasContainer?.().removeEventListener("pointerdown", this.onDown);
    this.win?.removeEventListener("pointerup", this.onUp);
    this.win?.removeEventListener("pointercancel", this.onUp);
    this.win?.removeEventListener("blur", this.onUp);
  }

  /** A button / finger is down on the map or a gesture handler runs. */
  private gesture(): boolean {
    if (this.pressed) return true;
    for (const h of HANDLERS) if (this.map[h]?.isActive?.()) return true;
    return false;
  }

  /** True while a gesture or a foreign camera animation runs. */
  busy(): boolean {
    const m = this.map;
    if (this.gesture()) return true;
    // a foreign move that never reported its end (should not happen): free once nothing moves
    if (this.taken && !m.isMoving()) {
      this.taken = false;
      this.releasedAt = performance.now();
    }
    return this.taken;
  }

  /**
   * The user moves the camera (a gesture, the +/− buttons, double-click, keyboard, the 3D toggle):
   * follow holds the aircraft in place on every frame (followCameraUpdate). Not during our own
   * glides (GLIDE_EVENT) nor the follow camera's own moves.
   */
  userMoving(): boolean {
    if (this.gesture()) return true;
    return this.busy() && !this.glide;
  }

  /** 0..1: how far a follow update moves towards its target (1 = all the way, 0 just after a gesture). */
  catchUp(nowMs = performance.now()): number {
    const t = (nowMs - this.releasedAt) / CATCH_UP_MS;
    return t >= 1 ? 1 : Math.max(0.08, t * t);
  }
}

/** Two or more fingers on the map: a pinch (MapLibre's touch pan reports it as a drag too) – zooming, not taking the camera. */
export function isMultiTouch(e: Event | undefined | null): boolean {
  return !!e && "touches" in e && ((e as TouchEvent).touches?.length ?? 0) > 1;
}

/** Longitude difference b − a in −180..180. */
const dLon = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;

/**
 * One step of a per-frame follow: the camera centre from `cur` towards `target` by `k`
 * (CameraGuard.catchUp; 1 = locked on). Longitudes the short way round.
 */
export function stepTowards(cur: { lon: number; lat: number; elev: number }, target: { lon: number; lat: number; elev: number }, k: number) {
  let lon = cur.lon + dLon(cur.lon, target.lon) * k;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return { lon, lat: cur.lat + (target.lat - cur.lat) * k, elev: cur.elev + (target.elev - cur.elev) * k };
}

/**
 * Where follow holds the camera: the followed aircraft (`lon`/`lat`; `elev` = the camera centre's
 * height in metres in 3D, absent = leave the height alone) and, when the aircraft is shown off the
 * canvas centre (beside the traffic card), the ground vector from the canvas centre to that spot,
 * measured at zoom `atZoom` (it scales with 2^−zoom while bearing and pitch stay).
 */
export interface FollowAnchor {
  lon: number;
  lat: number;
  elev?: number;
  shift?: { dLon: number; dLat: number; atZoom: number };
}

/** The camera centre that keeps the anchor's aircraft in its place at `zoom`. */
export function anchorCenter(a: FollowAnchor, zoom: number): { lon: number; lat: number } {
  if (!a.shift) return { lon: a.lon, lat: a.lat };
  const k = 2 ** (a.shift.atZoom - zoom);
  let lon = a.lon - a.shift.dLon * k;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return { lon, lat: a.lat - a.shift.dLat * k };
}

type CameraNext = Parameters<maplibregl.CameraUpdateTransformFunction>[0];
type CameraChange = ReturnType<maplibregl.CameraUpdateTransformFunction>;

/**
 * MapLibre `transformCameraUpdate` for the live map: while the user moves the camera of a followed
 * aircraft, each frame keeps the aircraft centred (and in 3D the camera looking at its height);
 * zoom, bearing and pitch are the user's. Outside user moves – and without a followed aircraft –
 * nothing is changed. `lngLat` builds MapLibre's LngLat (injected: no MapLibre import in tests).
 */
export function followCameraUpdate(
  guard: Pick<CameraGuard, "userMoving">,
  anchor: () => FollowAnchor | null,
  lngLat: (lon: number, lat: number) => maplibregl.LngLat,
): (next: CameraNext) => CameraChange {
  return (next) => {
    const a = anchor();
    if (!a || !guard.userMoving()) return {};
    const c = anchorCenter(a, next.zoom);
    if (![c.lon, c.lat].every(Number.isFinite)) return {};
    return a.elev != null && Number.isFinite(a.elev) ? { center: lngLat(c.lon, c.lat), elevation: a.elev } : { center: lngLat(c.lon, c.lat) };
  };
}
