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
import type { TrackPoint } from "./common";

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
/** A new fix blends in from the drawn position over this time (smoothstep, blendWeight). */
export const FIX_BLEND_MS = 1500;
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

/** Grid cell of the field index, degrees (15 nm = 0.25° of latitude). */
const CELL_DEG = 0.25;
const LON_CELLS = 360 / CELL_DEG;

/**
 * The height reference's airports indexed by a 0.25° grid: up to 1500 pilots each looking for
 * the nearest of up to 2000 fields was a linear scan per pilot (3 million distance checks per
 * refresh); the grid looks only at the cells within `maxNm` (a handful of fields).
 */
export class FieldIndex {
  private readonly cells = new Map<number, FieldRef[]>();

  constructor(readonly fields: readonly FieldRef[]) {
    for (const f of fields) {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lon)) continue;
      const k = FieldIndex.key(Math.floor(f.lat / CELL_DEG), FieldIndex.lonCell(f.lon));
      const list = this.cells.get(k);
      if (list) list.push(f);
      else this.cells.set(k, [f]);
    }
  }

  private static lonCell(lon: number): number {
    return ((Math.floor(lon / CELL_DEG) % LON_CELLS) + LON_CELLS) % LON_CELLS;
  }

  private static key(latCell: number, lonCell: number): number {
    return (latCell + 1000) * LON_CELLS + lonCell;
  }

  /** The fields that can lie within `maxNm` of the point (a superset; the caller measures). */
  *candidates(lat: number, lon: number, maxNm: number): Iterable<FieldRef> {
    const dLat = maxNm / NM_PER_DEG;
    const cos = Math.cos(Math.min(89.9, Math.abs(lat) + dLat) * D2R);
    const dLonDeg = cos > 1e-6 ? dLat / cos : 360;
    const span = Math.ceil(dLonDeg / CELL_DEG);
    // near the poles the radius spans (almost) every longitude: all fields, no grid
    if (2 * span + 1 >= LON_CELLS) {
      yield* this.fields;
      return;
    }
    const lat0 = Math.floor((lat - dLat) / CELL_DEG);
    const lat1 = Math.floor((lat + dLat) / CELL_DEG);
    const lonC = FieldIndex.lonCell(lon);
    for (let la = lat0; la <= lat1; la++)
      for (let d = -span; d <= span; d++) {
        const list = this.cells.get(FieldIndex.key(la, (((lonC + d) % LON_CELLS) + LON_CELLS) % LON_CELLS));
        if (list) yield* list;
      }
  }
}

/** Fields as a list (small sets, tests) or indexed (the 3D traffic's height reference). */
export type FieldSet = readonly FieldRef[] | FieldIndex;

/** Nearest field within `maxNm`, or null. */
export function nearestField(lat: number, lon: number, fields: FieldSet, maxNm = FIELD_RADIUS_NM): { field: FieldRef; nm: number } | null {
  const dLat = maxNm / NM_PER_DEG;
  let best: { field: FieldRef; nm: number } | null = null;
  const list = fields instanceof FieldIndex ? fields.candidates(lat, lon, maxNm) : fields;
  for (const f of list) {
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
  fields: FieldSet,
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
export function fixOf(p: Pilot, fields: FieldSet, tMs: number): TrafficFix {
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

/**
 * Share of a correction still applied `dtMs` after it started: 1 → 0 over FIX_BLEND_MS along a
 * smoothstep, so the correction starts and ends with zero speed – the aircraft neither jerks when
 * a fix arrives nor when the blend ends (a linear fade did both: a kink in speed at each end).
 */
export function blendWeight(dtMs: number): number {
  const t = Math.min(1, Math.max(0, dtMs / FIX_BLEND_MS));
  return 1 - t * t * (3 - 2 * t);
}

interface Track {
  fix: TrafficFix;
  /** Drawn pose minus the new fix when the correction started; decays to 0 over FIX_BLEND_MS. */
  off: TrafficPose | null;
  /** Start of the correction (ms, performance.now clock). */
  offT: number;
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
        const fix = { ...f, tMs: old.fix.tMs };
        if (fix.hFt === old.fix.hFt) {
          next.set(f.key, { fix, off: old.off, offT: old.offT });
          continue;
        }
        // a new height reference: glide to the new height instead of jumping
        const drawn = this.pose(old, nowMs);
        const [lat, lon] = deadReckon(fix.lat, fix.lon, fix.headingDeg, fix.gsKt, (nowMs - fix.tMs) / 1000);
        next.set(f.key, { fix, off: { lat: drawn.lat - lat, lon: dLon(lon, drawn.lon), headingDeg: dLon(fix.headingDeg, drawn.headingDeg), hFt: drawn.hFt - fix.hFt }, offT: nowMs });
        continue;
      }
      let off: TrafficPose | null = null;
      if (old) {
        const drawn = this.pose(old, nowMs);
        const jump = Math.abs(drawn.lat - f.lat) + Math.abs(dLon(f.lon, drawn.lon)) > JUMP_DEG;
        if (!jump) off = { lat: drawn.lat - f.lat, lon: dLon(f.lon, drawn.lon), headingDeg: dLon(f.headingDeg, drawn.headingDeg), hFt: drawn.hFt - f.hFt };
      }
      next.set(f.key, { fix: { ...f, tMs: nowMs }, off, offT: nowMs });
    }
    this.tracks = next;
  }

  private pose(t: Track, nowMs: number): TrafficPose {
    const f = t.fix;
    const [lat, lon] = deadReckon(f.lat, f.lon, f.headingDeg, f.gsKt, (nowMs - f.tMs) / 1000);
    const k = t.off ? blendWeight(nowMs - t.offT) : 0;
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
      if ((t.fix.gsKt > 1 && age < DR_MAX_S * 1000) || (t.off && nowMs - t.offT < FIX_BLEND_MS)) return true;
    }
    return false;
  }
}

/** One fix of an aircraft's flown track as the backend keeps it (`traffic_track`, vectasim_online::history). */
export interface TrafficHistoryFix {
  tMs: number;
  latitude: number;
  longitude: number;
  altitudeFt: number;
  groundSpeedKt: number;
  onGround?: boolean;
}

/**
 * Curtain points of a flown track: heights on the traffic models' scale (trafficHeightFt with the
 * airports around the view), so the curtain's top edge meets the model.
 */
export function historyPoints(fixes: readonly TrafficHistoryFix[], fields: FieldSet): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (const f of fixes) {
    if (!Number.isFinite(f.latitude) || !Number.isFinite(f.longitude)) continue;
    out.push({ lon: f.longitude, lat: f.latitude, altFt: f.altitudeFt, hFt: trafficHeightFt(f, fields) });
  }
  return out;
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
 * buildInstances without the allocations, for the per-frame render: one growing buffer per shape
 * class, kept from frame to frame (`reset` empties them, `push` appends one instance), uploaded with
 * bufferSubData. The layout is buildInstances'.
 */
export class InstanceBuffers {
  private data = new Map<ModelKind, Float32Array>();
  private n = new Map<ModelKind, number>();

  /** Empties every class (keeps the memory). */
  reset() {
    for (const k of this.n.keys()) this.n.set(k, 0);
  }

  push(kind: ModelKind, x: number, y: number, altM: number, headingDeg: number, size: number, selected: boolean) {
    const n = this.n.get(kind) ?? 0;
    let buf = this.data.get(kind);
    if (!buf || (n + 1) * INSTANCE_FLOATS > buf.length) {
      const grown = new Float32Array(Math.max(16, (n + 1) * 2) * INSTANCE_FLOATS);
      if (buf) grown.set(buf.subarray(0, n * INSTANCE_FLOATS));
      this.data.set(kind, grown);
      buf = grown;
    }
    const o = n * INSTANCE_FLOATS;
    buf[o] = x;
    buf[o + 1] = y;
    buf[o + 2] = altM;
    buf[o + 3] = (headingDeg * Math.PI) / 180;
    buf[o + 4] = size;
    buf[o + 5] = selected ? 1 : 0;
    this.n.set(kind, n + 1);
  }

  /** Instances of a class since the last reset. */
  count(kind: ModelKind): number {
    return this.n.get(kind) ?? 0;
  }

  /** The class's buffer (its first count × INSTANCE_FLOATS floats are valid). */
  array(kind: ModelKind): Float32Array | undefined {
    return this.data.get(kind);
  }
}

/** Web Mercator x (0..1, plus whole worlds beyond ±180) of a longitude. */
export function mercatorX(lon: number): number {
  return (lon + 180) / 360;
}

/** Web Mercator y (0 north .. 1 south) of a latitude, clamped to ±85.0511°. */
export function mercatorY(lat: number): number {
  const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * D2R);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

/**
 * Largest tile coordinate the globe shader takes for a normal vertex: beyond ±32767 MapLibre's
 * projectToSphere snaps it to a pole (the curtain uses the same limit, curtainLayer.pickTile).
 */
export const TILE_COORD_LIMIT = 30_000;

/**
 * Reference tile for the traffic models: the tile under the map centre (`cx`, `cy` Mercator) at
 * the map's zoom, one level coarser at a time until every instance (`pts`, Mercator, already in
 * the world copy nearest the centre) lies within TILE_COORD_LIMIT tile units of it.
 */
export function trafficRefTile(cx: number, cy: number, zoom: number, pts: ReadonlyArray<readonly [number, number]>): { tx: number; ty: number; tz: number; wrap: number } {
  const xy = new Float64Array(pts.length * 2);
  pts.forEach(([x, y], i) => {
    xy[2 * i] = x;
    xy[2 * i + 1] = y;
  });
  return trafficRefTileFlat(cx, cy, zoom, xy, pts.length);
}

/**
 * trafficRefTile over `count` points stored flat (x0, y0, x1, y1, …): the per-frame form, no pair
 * arrays. `wrap` is the world copy of the centre (a camera beyond ±180°, following across the date
 * line, is not wrapped back): the tile is picked inside that copy, as curtainLayer.pickTile does,
 * instead of being clamped to the last tile column (which then coarsened the zoom for nothing).
 * Tile-local x of a point: ((x − wrap)·2^tz − tx)·8192.
 */
export function trafficRefTileFlat(cx: number, cy: number, zoom: number, xy: ArrayLike<number>, count: number): { tx: number; ty: number; tz: number; wrap: number } {
  const wrap = Number.isFinite(cx) ? Math.floor(cx) : 0;
  const fx = cx - wrap;
  let z = Math.max(0, Math.min(18, Math.floor(zoom)));
  for (;;) {
    const n = 2 ** z;
    const tx = Math.min(n - 1, Math.max(0, Math.floor(fx * n)));
    const ty = Math.min(n - 1, Math.max(0, Math.floor(cy * n)));
    let reach = 0;
    for (let i = 0; i < count; i++) reach = Math.max(reach, Math.abs((xy[2 * i] - wrap) * n - tx), Math.abs(xy[2 * i + 1] * n - ty));
    if (z === 0 || !(reach * 8192 > TILE_COORD_LIMIT)) return { tx, ty, tz: z, wrap };
    z--;
  }
}

/**
 * Tile-local coordinates (extent 8192) of a position relative to tile (tx, ty) at zoom `z`;
 * `wrap` shifts by whole worlds (the copy nearest the map centre).
 */
export function tileUnits(lon: number, lat: number, tx: number, ty: number, z: number, wrap = 0): [number, number] {
  const n = 2 ** z;
  return [((mercatorX(lon) + wrap) * n - tx) * 8192, (mercatorY(lat) * n - ty) * 8192];
}
