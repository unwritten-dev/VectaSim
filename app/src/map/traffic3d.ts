// Online traffic (VATSIM / IVAO) as 3D models: the pure part – when the models show, which
// aircraft get one, how high above the map's ground they fly, and where they are between two
// feed updates. The WebGL layer that draws them lives in trafficModel.ts.
//
// Rules in short:
// - only in the pitched 3D view and from zoom 8; below and in 2D the flat symbols stay;
// - at most 200 models: the aircraft in view (plus a margin) nearest the map centre, the
//   selected one (traffic card) always included; the rest keeps its 2D symbol;
// - height above the map's ground (the map has no terrain, the feed only gives MSL): on the
//   ground → 0; otherwise MSL − elevation of the nearest airport within 15 nm (faded out
//   between 10 and 15 nm), MSL − 0 further away – the same scale as the own model and curtain;
// - the feed arrives every 15 s; in between the position is dead-reckoned from ground speed and
//   heading (at most 20 s), a new fix blends in from the drawn position instead of jumping.

import type { Airport, Network, Pilot } from "../types";
import { WAKE_SIZE, wakeCategory } from "./aircraftIcons";
import { modelKind, type ModelKind } from "./aircraftMeshes";

/** Models from this zoom (pitched view only). */
export const TRAFFIC3D_MIN_ZOOM = 8;
/** At most this many models. */
export const TRAFFIC3D_MAX = 200;
/** Ground shadow and plumb line of the traffic models only from this zoom (busy otherwise) and below ~10 000 ft (trafficModel.ts). */
export const TRAFFIC3D_DETAIL_ZOOM = 11;
/** Visible area plus this fraction of its width / height on every side. */
export const VIEW_MARGIN = 0.15;
/** Airports within this radius give the height reference… */
export const FIELD_RADIUS_NM = 15;
/** …fully up to this distance, fading to MSL − 0 at FIELD_RADIUS_NM. */
export const FIELD_FULL_NM = 10;
/** Slower than this and close to the field elevation: on the ground. */
export const GROUND_GS_KT = 40;
export const GROUND_NEAR_FT = 250;
/** Dead reckoning runs at most this long past the last fix. */
export const DR_MAX_S = 20;
/** A new fix blends in from the drawn position over this time. */
export const FIX_BLEND_MS = 1200;
/** A fix further than this (degrees) from the drawn position is a jump, not blended. */
const JUMP_DEG = 0.2;

/** Once on, the models stay until this far below TRAFFIC3D_MIN_ZOOM (no 2D/3D toggling at the threshold). */
export const TRAFFIC3D_ZOOM_HYSTERESIS = 0.3;
/** Aircraft already drawn as models compete with their distance × this factor (no swapping at the 200 boundary while the map follows). */
export const PICK_HYSTERESIS = 0.8;

/** Is the 3D traffic drawn? Pitched view, zoomed in, traffic layer shown; `wasActive` lowers the zoom threshold a little. */
export function traffic3dActive(view3d: boolean, zoom: number, trafficShown: boolean, wasActive = false): boolean {
  const min = TRAFFIC3D_MIN_ZOOM - (wasActive ? TRAFFIC3D_ZOOM_HYSTERESIS : 0);
  return view3d && trafficShown && Number.isFinite(zoom) && zoom >= min;
}

/** Unique per aircraft (CID / VID are unique only per network). */
export function pilotKey(p: { network?: Network | null; cid: number }): string {
  return `${p.network ?? "vatsim"}:${p.cid}`;
}

const NM_PER_DEG = 60;
const D2R = Math.PI / 180;

/** Longitude difference b − a in −180..180. */
function dLon(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/** Distance in nm (equirectangular; plenty for ≤ 15 nm and for ranking). */
export function distNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const x = dLon(lon1, lon2) * Math.cos(((lat1 + lat2) / 2) * D2R);
  return Math.hypot(x, lat2 - lat1) * NM_PER_DEG;
}

/** Airport with a known elevation, the height reference of nearby traffic. */
export interface FieldRef {
  lat: number;
  lon: number;
  elevFt: number;
}

/** Airports with an elevation (heliports and closed fields are no reference). */
export function fieldsOf(airports: Iterable<Airport>): FieldRef[] {
  const out: FieldRef[] = [];
  for (const a of airports) {
    if (a.elevationFt == null || !Number.isFinite(a.elevationFt) || a.kind === "heliport" || a.kind === "closed") continue;
    out.push({ lat: a.latitude, lon: a.longitude, elevFt: a.elevationFt });
  }
  return out;
}

/** Nearest field within `maxNm`, or null. */
export function nearestField(lat: number, lon: number, fields: readonly FieldRef[], maxNm = FIELD_RADIUS_NM): { field: FieldRef; nm: number } | null {
  const dLat = maxNm / NM_PER_DEG;
  let best: { field: FieldRef; nm: number } | null = null;
  for (const f of fields) {
    if (Math.abs(f.lat - lat) > dLat) continue;
    const nm = distNm(lat, lon, f.lat, f.lon);
    if (nm <= maxNm && (!best || nm < best.nm)) best = { field: f, nm };
  }
  return best;
}

/**
 * Height above the map's ground (ft) of an online aircraft: 0 on the ground (IVAO `onGround`,
 * or slower than 40 kt within 250 ft of a nearby field's elevation); otherwise MSL minus the
 * elevation of the nearest field within 15 nm (weight 1 up to 10 nm, fading to 0 at 15 nm),
 * never below 0.
 */
export function trafficHeightFt(
  p: Pick<Pilot, "latitude" | "longitude" | "altitudeFt" | "groundSpeedKt" | "onGround">,
  fields: readonly FieldRef[],
): number {
  if (p.onGround) return 0;
  const msl = Number.isFinite(p.altitudeFt) ? p.altitudeFt : 0;
  const near = nearestField(p.latitude, p.longitude, fields);
  if (!near) return Math.max(0, msl);
  const elev = near.field.elevFt;
  if (Number.isFinite(p.groundSpeedKt) && p.groundSpeedKt < GROUND_GS_KT && msl - elev < GROUND_NEAR_FT) return 0;
  const w = Math.min(1, Math.max(0, (FIELD_RADIUS_NM - near.nm) / (FIELD_RADIUS_NM - FIELD_FULL_NM)));
  return Math.max(0, msl - elev * w);
}

/** Position after `dtS` seconds at `gsKt` on `headingDeg` (clamped to 0..DR_MAX_S). */
export function deadReckon(lat: number, lon: number, headingDeg: number, gsKt: number, dtS: number): [number, number] {
  const dt = Math.min(DR_MAX_S, Math.max(0, Number.isFinite(dtS) ? dtS : 0));
  const gs = Number.isFinite(gsKt) && gsKt > 0 ? gsKt : 0;
  if (!dt || !gs || !Number.isFinite(headingDeg)) return [lat, lon];
  const nm = (gs * dt) / 3600;
  const h = headingDeg * D2R;
  const nLat = lat + (nm * Math.cos(h)) / NM_PER_DEG;
  const cos = Math.max(0.01, Math.cos(lat * D2R));
  let nLon = lon + (nm * Math.sin(h)) / (NM_PER_DEG * cos);
  if (nLon > 180) nLon -= 360;
  if (nLon < -180) nLon += 360;
  return [nLat, nLon];
}

/** One aircraft as the feed last reported it, with what the model needs. */
export interface TrafficFix {
  key: string;
  network: Network;
  cid: number;
  callsign: string;
  lat: number;
  lon: number;
  headingDeg: number;
  gsKt: number;
  /** Height above the map's ground, ft (trafficHeightFt). */
  hFt: number;
  kind: ModelKind;
  /** Wake size factor (as the 2D symbol). */
  size: number;
  /** Wake class of the 2D symbol (hit target icon). */
  cat: ReturnType<typeof wakeCategory>;
  /** Arrival of this fix, ms (performance.now clock). */
  tMs: number;
}

export interface TrafficPose {
  lat: number;
  lon: number;
  headingDeg: number;
  hFt: number;
}

/** Fix of a pilot; `tMs` is when it arrived. */
export function fixOf(p: Pilot, fields: readonly FieldRef[], tMs: number): TrafficFix {
  const cat = wakeCategory(p.aircraftShort);
  return {
    key: pilotKey(p),
    network: p.network ?? "vatsim",
    cid: p.cid,
    callsign: p.callsign,
    lat: p.latitude,
    lon: p.longitude,
    headingDeg: Number.isFinite(p.headingDeg) ? p.headingDeg : 0,
    gsKt: p.groundSpeedKt,
    hFt: trafficHeightFt(p, fields),
    kind: modelKind(p.aircraftShort, p.aircraftModel),
    size: WAKE_SIZE[cat],
    cat,
    tMs,
  };
}

const lerpAngle = (a: number, b: number, f: number) => a + dLon(a, b) * f;

interface Track {
  fix: TrafficFix;
  /** Drawn pose minus the new fix at its arrival; decays to 0 over FIX_BLEND_MS. */
  off: TrafficPose | null;
}

/**
 * The aircraft of the latest feed snapshot, dead-reckoned between fixes. `update` with every
 * snapshot (and every re-filter after a pan – an unchanged report keeps its fix time, so it is
 * not reset), `poseAt` per frame.
 */
export class TrafficTracks {
  private tracks = new Map<string, Track>();

  get size(): number {
    return this.tracks.size;
  }

  fixes(): TrafficFix[] {
    return [...this.tracks.values()].map((t) => t.fix);
  }

  get(key: string): TrafficFix | undefined {
    return this.tracks.get(key)?.fix;
  }

  /** Replaces the set; reports that did not change keep their fix time (and their dead reckoning). */
  update(fixes: readonly TrafficFix[], nowMs: number) {
    const next = new Map<string, Track>();
    for (const f of fixes) {
      const old = this.tracks.get(f.key);
      if (old && old.fix.lat === f.lat && old.fix.lon === f.lon && old.fix.headingDeg === f.headingDeg && old.fix.gsKt === f.gsKt) {
        // same report: keep timing and blend, refresh the rest (height reference may have loaded)
        next.set(f.key, { fix: { ...f, tMs: old.fix.tMs }, off: old.off });
        continue;
      }
      let off: TrafficPose | null = null;
      if (old) {
        const drawn = this.pose(old, nowMs);
        const jump = Math.abs(drawn.lat - f.lat) + Math.abs(dLon(f.lon, drawn.lon)) > JUMP_DEG;
        if (!jump) off = { lat: drawn.lat - f.lat, lon: dLon(f.lon, drawn.lon), headingDeg: dLon(f.headingDeg, drawn.headingDeg), hFt: drawn.hFt - f.hFt };
      }
      next.set(f.key, { fix: { ...f, tMs: nowMs }, off });
    }
    this.tracks = next;
  }

  private pose(t: Track, nowMs: number): TrafficPose {
    const f = t.fix;
    const [lat, lon] = deadReckon(f.lat, f.lon, f.headingDeg, f.gsKt, (nowMs - f.tMs) / 1000);
    const k = t.off ? 1 - Math.min(1, Math.max(0, (nowMs - f.tMs) / FIX_BLEND_MS)) : 0;
    if (!t.off || k <= 0) return { lat, lon, headingDeg: f.headingDeg, hFt: f.hFt };
    let l = lon + t.off.lon * k;
    if (l > 180) l -= 360;
    if (l < -180) l += 360;
    return { lat: lat + t.off.lat * k, lon: l, headingDeg: lerpAngle(f.headingDeg, f.headingDeg + t.off.headingDeg, k), hFt: f.hFt + t.off.hFt * k };
  }

  /** Drawn pose of an aircraft at `nowMs`. */
  poseAt(key: string, nowMs: number): TrafficPose | null {
    const t = this.tracks.get(key);
    return t ? this.pose(t, nowMs) : null;
  }

  /** Does anything move (dead reckoning or a blend still running)? Drives the throttled repaint. */
  moving(nowMs: number, keys?: Iterable<string>): boolean {
    const list = keys ? [...keys].map((k) => this.tracks.get(k)).filter((t): t is Track => !!t) : this.tracks.values();
    for (const t of list) {
      const age = nowMs - t.fix.tMs;
      if ((t.fix.gsKt > 1 && age < DR_MAX_S * 1000) || (t.off && age < FIX_BLEND_MS)) return true;
    }
    return false;
  }
}

/** View box as MapLibre reports it (longitudes may run past ±180). */
export interface ViewBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Is a point inside the view box widened by `margin` × its size on each side? */
export function inView(lat: number, lon: number, b: ViewBox, margin = VIEW_MARGIN): boolean {
  const w = b.east - b.west;
  const h = b.north - b.south;
  if (w >= 360) return lat >= b.south - h * margin && lat <= b.north + h * margin;
  const mid = (b.west + b.east) / 2;
  const x = mid + dLon(mid, lon);
  return x >= b.west - w * margin && x <= b.east + w * margin && lat >= b.south - h * margin && lat <= b.north + h * margin;
}

/**
 * Keys of the aircraft that get a model: in view (with margin), nearest to `centre` first, at
 * most `max`; `keep` (the selected aircraft) is always included when it is in the set at all.
 * Aircraft in `prev` (drawn as models so far) rank by PICK_HYSTERESIS × distance, so a moving map
 * centre does not swap aircraft between symbol and model at the boundary on every pan.
 */
export function pickTraffic(
  items: Iterable<{ key: string; lat: number; lon: number }>,
  view: ViewBox,
  centre: { lat: number; lon: number },
  max = TRAFFIC3D_MAX,
  keep?: string | null,
  prev?: ReadonlySet<string>,
): string[] {
  const cand: Array<{ key: string; d: number }> = [];
  let kept: string | null = null;
  for (const it of items) {
    if (keep && it.key === keep) kept = it.key;
    if (!inView(it.lat, it.lon, view)) continue;
    const d = distNm(centre.lat, centre.lon, it.lat, it.lon);
    cand.push({ key: it.key, d: prev?.has(it.key) ? d * PICK_HYSTERESIS : d });
  }
  cand.sort((a, b) => a.d - b.d || (a.key < b.key ? -1 : 1));
  const out = cand.slice(0, max).map((c) => c.key);
  if (kept && !out.includes(kept)) {
    if (out.length >= max) out.pop();
    out.push(kept);
  }
  return out;
}

/** Floats per instance: x, y (tile units), height (m), heading (rad), size factor, highlight. */
export const INSTANCE_FLOATS = 6;

export interface InstanceInput {
  kind: ModelKind;
  /** Tile-local position (trafficModel.tileUnits). */
  x: number;
  y: number;
  /** Height in metres (trackChunks.altToCurtainM). */
  altM: number;
  headingDeg: number;
  size: number;
  selected: boolean;
}

/** Instance data per shape class: one buffer, one instanced draw call each. */
export function buildInstances(items: readonly InstanceInput[]): Map<ModelKind, Float32Array> {
  const count = new Map<ModelKind, number>();
  for (const it of items) count.set(it.kind, (count.get(it.kind) ?? 0) + 1);
  const out = new Map<ModelKind, Float32Array>();
  const fill = new Map<ModelKind, number>();
  for (const [k, n] of count) {
    out.set(k, new Float32Array(n * INSTANCE_FLOATS));
    fill.set(k, 0);
  }
  for (const it of items) {
    const buf = out.get(it.kind)!;
    const i = fill.get(it.kind)!;
    buf.set([it.x, it.y, it.altM, (it.headingDeg * Math.PI) / 180, it.size, it.selected ? 1 : 0], i);
    fill.set(it.kind, i + INSTANCE_FLOATS);
  }
  return out;
}

/**
 * Tile-local coordinates (extent 8192) of a position relative to tile (tx, ty) at zoom `z`;
 * `wrap` shifts by whole worlds (the copy nearest the map centre).
 */
export function tileUnits(lon: number, lat: number, tx: number, ty: number, z: number, wrap = 0): [number, number] {
  const n = 2 ** z;
  const mx = (lon + 180) / 360 + wrap;
  const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * D2R);
  const my = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return [(mx * n - tx) * 8192, (my * n - ty) * 8192];
}
