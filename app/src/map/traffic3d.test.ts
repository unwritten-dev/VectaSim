import { describe, expect, it } from "vitest";
import type { Airport, Pilot } from "../types";
import {
  TILE_COORD_LIMIT,
  trafficRefTile,
  DR_MAX_S,
  FIX_BLEND_MS,
  INSTANCE_FLOATS,
  TRAFFIC3D_MAX,
  TrafficTracks,
  blendWeight,
  buildInstances,
  deadReckon,
  distNm,
  FieldIndex,
  fieldsOf,
  fixOf,
  historyPoints,
  inView,
  nearestField,
  pickTraffic,
  pilotKey,
  tileUnits,
  traffic3dActive,
  trafficHeightFt,
  type FieldRef,
  type TrafficFix,
  InstanceBuffers,
  trafficRefTileFlat,
} from "./traffic3d";

const EDDF: FieldRef = { lat: 50.0333, lon: 8.5706, elevFt: 364 };
const pilot = (o: Partial<Pilot> = {}): Pilot => ({
  network: "vatsim",
  cid: 1,
  callsign: "DLH1",
  latitude: EDDF.lat,
  longitude: EDDF.lon,
  altitudeFt: 364,
  groundSpeedKt: 0,
  headingDeg: 70,
  transponder: "2000",
  aircraftShort: "A320",
  departure: "EDDF",
  arrival: "EGLL",
  route: "",
  flightRules: "I",
  ...o,
});
/** A point `nm` east of EDDF. */
const east = (nm: number) => EDDF.lon + nm / (60 * Math.cos((EDDF.lat * Math.PI) / 180));

describe("traffic3dActive", () => {
  it("only in the 3D view, from zoom 8, with the traffic layer shown", () => {
    expect(traffic3dActive(false, 12, true)).toBe(false);
    expect(traffic3dActive(true, 7.99, true)).toBe(false);
    expect(traffic3dActive(true, 8, true)).toBe(true);
    expect(traffic3dActive(true, 12, false)).toBe(false);
    expect(traffic3dActive(true, NaN, true)).toBe(false);
  });
  it("stays on a little below the threshold once active (no toggling at zoom 8)", () => {
    expect(traffic3dActive(true, 7.85, true, true)).toBe(true);
    expect(traffic3dActive(true, 7.85, true, false)).toBe(false);
    expect(traffic3dActive(true, 7.6, true, true)).toBe(false);
  });
});

describe("height above the map's ground", () => {
  const fields = [EDDF];
  it("is 0 on the ground: IVAO onGround, or slow close to the field elevation", () => {
    expect(trafficHeightFt(pilot({ onGround: true, altitudeFt: 900, groundSpeedKt: 140 }), fields)).toBe(0);
    expect(trafficHeightFt(pilot({ altitudeFt: 380, groundSpeedKt: 12 }), fields)).toBe(0);
    // slow but well above the field (helicopter, slow climb): flying
    expect(trafficHeightFt(pilot({ altitudeFt: 1364, groundSpeedKt: 30 }), fields)).toBe(1000);
  });
  it("near a field: MSL minus its elevation, faded out between 10 and 15 nm", () => {
    expect(trafficHeightFt(pilot({ longitude: east(5), altitudeFt: 2364, groundSpeedKt: 160 }), fields)).toBeCloseTo(2000, 0);
    expect(trafficHeightFt(pilot({ longitude: east(12.5), altitudeFt: 3000, groundSpeedKt: 200 }), fields)).toBeCloseTo(3000 - 364 * 0.5, 0);
    expect(trafficHeightFt(pilot({ longitude: east(20), altitudeFt: 3000, groundSpeedKt: 200 }), fields)).toBe(3000);
  });
  it("cruise far from any field: MSL − 0; never below 0", () => {
    expect(trafficHeightFt(pilot({ latitude: 45, longitude: -30, altitudeFt: 36000, groundSpeedKt: 480 }), fields)).toBe(36000);
    expect(trafficHeightFt(pilot({ altitudeFt: 200, groundSpeedKt: 150 }), fields)).toBe(0);
  });
  it("uses the nearest field within 15 nm", () => {
    const other: FieldRef = { lat: EDDF.lat, lon: east(8), elevFt: 1000 };
    expect(nearestField(EDDF.lat, east(6), [EDDF, other])?.field).toBe(other);
    expect(nearestField(EDDF.lat, east(16), [EDDF])).toBeNull();
  });
  it("fields need an elevation and are no heliports", () => {
    const a = (kind: string, elevationFt: number | null): Airport => ({ ident: "X", kind, name: "", latitude: 1, longitude: 2, elevationFt, country: "", municipality: "", iata: "" });
    expect(fieldsOf([a("large", 364), a("heliport", 10), a("small", null)])).toEqual([{ lat: 1, lon: 2, elevFt: 364 }]);
  });
});

describe("dead reckoning", () => {
  it("advances along the heading by ground speed", () => {
    const [lat, lon] = deadReckon(50, 8, 0, 360, 10); // 1 nm north
    expect(lat).toBeCloseTo(50 + 1 / 60, 6);
    expect(lon).toBeCloseTo(8, 9);
    const [, lon2] = deadReckon(60, 8, 90, 360, 10); // 1 nm east at 60° N = 2/60°
    expect(lon2).toBeCloseTo(8 + 2 / 60, 4);
  });
  it("stops after 20 s and stands still at 0 kt", () => {
    expect(deadReckon(50, 8, 0, 360, 60)).toEqual(deadReckon(50, 8, 0, 360, DR_MAX_S));
    expect(deadReckon(50, 8, 0, 0, 10)).toEqual([50, 8]);
    expect(deadReckon(50, 8, 0, 300, -5)).toEqual([50, 8]);
  });
  it("crosses the antimeridian", () => {
    expect(deadReckon(0, 179.99, 90, 3600, 20)[1]).toBeLessThan(-179);
  });
});

describe("TrafficTracks", () => {
  const fix = (o: Partial<TrafficFix> = {}): TrafficFix => ({ ...fixOf(pilot({ groundSpeedKt: 360, headingDeg: 0, altitudeFt: 5000 }), [], 0), ...o });
  it("an unchanged report keeps its fix time (a pan must not reset dead reckoning)", () => {
    const t = new TrafficTracks();
    t.update([fix()], 1000);
    t.update([fix()], 6000);
    expect(t.get(fix().key)?.tMs).toBe(1000);
    // 10 s after the fix: 1 nm north
    expect(t.poseAt(fix().key, 11_000)!.lat).toBeCloseTo(EDDF.lat + 1 / 60, 6);
  });
  it("a new fix blends in from the drawn position, then follows its own dead reckoning", () => {
    const t = new TrafficTracks();
    const k = fix().key;
    t.update([fix()], 0);
    const drawn = t.poseAt(k, 15_000)!; // 1.5 nm north by reckoning
    // the feed says it is only 1.2 nm north
    t.update([fix({ lat: EDDF.lat + 1.2 / 60 })], 15_000);
    expect(t.poseAt(k, 15_000)!.lat).toBeCloseTo(drawn.lat, 9);
    const after = t.poseAt(k, 15_000 + FIX_BLEND_MS)!;
    expect(after.lat).toBeCloseTo(EDDF.lat + 1.2 / 60 + (360 * FIX_BLEND_MS) / 3_600_000 / 60, 6);
  });
  it("a teleport is not blended; vanished aircraft are dropped", () => {
    const t = new TrafficTracks();
    const k = fix().key;
    t.update([fix()], 0);
    t.update([fix({ lat: 10 })], 5000);
    expect(t.poseAt(k, 5000)!.lat).toBe(10);
    t.update([], 6000);
    expect(t.size).toBe(0);
  });
  it("moves while reckoning or blending, still when parked", () => {
    const t = new TrafficTracks();
    t.update([fix({ gsKt: 0 })], 0);
    expect(t.moving(100)).toBe(false);
    t.update([fix({ gsKt: 200 })], 0);
    expect(t.moving(5000)).toBe(true);
    expect(t.moving(DR_MAX_S * 1000 + 1)).toBe(false);
  });
});

describe("pickTraffic", () => {
  const view = { west: 8, south: 49.5, east: 9, north: 50.5 };
  const centre = { lat: 50, lon: 8.5 };
  it("takes the aircraft in view nearest the centre, at most 200", () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ key: `vatsim:${i}`, lat: 50 + (i % 20) * 0.02, lon: 8.5 + Math.floor(i / 20) * 0.02 }));
    const keys = pickTraffic(items, view, centre);
    expect(keys).toHaveLength(TRAFFIC3D_MAX);
    expect(keys[0]).toBe("vatsim:0");
    const far = items.map((it) => ({ ...it, d: distNm(50, 8.5, it.lat, it.lon) })).sort((a, b) => b.d - a.d)[0];
    expect(keys).not.toContain(far.key);
  });
  it("skips aircraft outside the view and its margin, keeps the selected one", () => {
    const items = [
      { key: "a", lat: 50, lon: 8.5 },
      { key: "edge", lat: 50, lon: 9.1 }, // inside the 15 % margin
      { key: "out", lat: 50, lon: 9.5 },
      { key: "sel", lat: 52, lon: 8.5 },
    ];
    expect(pickTraffic(items, view, centre)).toEqual(["a", "edge"]);
    expect(pickTraffic(items, view, centre, 1, "sel")).toEqual(["sel"]);
    expect(pickTraffic(items, view, centre, 200, "sel")).toEqual(["a", "edge", "sel"]);
  });
  it("keeps aircraft already drawn as models at the boundary while the centre moves", () => {
    const items = [
      { key: "a", lat: 50, lon: 8.5 },
      { key: "b", lat: 50.1, lon: 8.5 },
      { key: "c", lat: 50.11, lon: 8.5 },
    ];
    expect(pickTraffic(items, view, centre, 2)).toEqual(["a", "b"]);
    // centre moved a little north: c is now nearer than b, but b stays (hysteresis)
    const moved = { lat: 50.06, lon: 8.5 };
    expect(pickTraffic(items, view, moved, 2)).toContain("c");
    expect(pickTraffic(items, view, moved, 2, null, new Set(["a", "b"]))).toEqual(expect.arrayContaining(["a", "b"]));
  });
  it("handles unwrapped view longitudes across the antimeridian", () => {
    expect(inView(0, -179.5, { west: 179, south: -1, east: 181, north: 1 })).toBe(true);
    expect(inView(0, 170, { west: 179, south: -1, east: 181, north: 1 })).toBe(false);
  });
});

describe("instance buffers", () => {
  it("one buffer per shape class, six floats per aircraft", () => {
    const m = buildInstances([
      { kind: "narrowbody", x: 1, y: 2, altM: 300, headingDeg: 90, size: 1.3, selected: false },
      { kind: "prop", x: 3, y: 4, altM: 1, headingDeg: 180, size: 1, selected: true },
      { kind: "narrowbody", x: 5, y: 6, altM: 0, headingDeg: 0, size: 1.3, selected: false },
    ]);
    expect([...m.keys()].sort()).toEqual(["narrowbody", "prop"]);
    const nb = m.get("narrowbody")!;
    expect(nb).toHaveLength(2 * INSTANCE_FLOATS);
    expect([...nb.slice(0, 6)].map((v) => +v.toFixed(4))).toEqual([1, 2, 300, +(Math.PI / 2).toFixed(4), 1.3, 0]);
    expect(nb[6]).toBe(5);
    expect([...m.get("prop")!].map((v) => +v.toFixed(4))).toEqual([3, 4, 1, +Math.PI.toFixed(4), 1, 1]);
  });
  it("H-3: the reused per-frame buffers hold the same data as buildInstances, without new arrays per frame", () => {
    const items = [
      { kind: "narrowbody" as const, x: 1, y: 2, altM: 300, headingDeg: 90, size: 1.3, selected: false },
      { kind: "prop" as const, x: 3, y: 4, altM: 1, headingDeg: 180, size: 1, selected: true },
      { kind: "narrowbody" as const, x: 5, y: 6, altM: 0, headingDeg: 0, size: 1.3, selected: false },
    ];
    const ref = buildInstances(items);
    const b = new InstanceBuffers();
    const fill = () => {
      b.reset();
      for (const it of items) b.push(it.kind, it.x, it.y, it.altM, it.headingDeg, it.size, it.selected);
    };
    fill();
    for (const [k, data] of ref) expect([...b.array(k)!.subarray(0, b.count(k) * INSTANCE_FLOATS)]).toEqual([...data]);
    // the next frame writes into the same arrays
    const before = b.array("narrowbody");
    fill();
    expect(b.array("narrowbody")).toBe(before);
    expect(b.count("narrowbody")).toBe(2);
    // growing keeps what was written
    b.reset();
    for (let i = 0; i < 200; i++) b.push("widebody", i, 0, 0, 0, 1, false);
    expect(b.count("widebody")).toBe(200);
    expect(b.array("widebody")![199 * INSTANCE_FLOATS]).toBe(199);
    expect(b.count("prop")).toBe(0);
  });
  it("trafficRefTileFlat is trafficRefTile over flat coordinates", () => {
    const pts: Array<[number, number]> = [[0.51, 0.32], [0.53, 0.33], [0.9, 0.1]];
    const flat = new Float64Array(pts.flat());
    expect(trafficRefTileFlat(0.52, 0.32, 9, flat, 3)).toEqual(trafficRefTile(0.52, 0.32, 9, pts));
    expect(trafficRefTileFlat(0.52, 0.32, 9, flat, 2)).toEqual(trafficRefTile(0.52, 0.32, 9, pts.slice(0, 2)));
  });
  it("tile units: the tile centre is 4096 / 4096, world copies shift by whole tiles", () => {
    // zoom 1, tile (1, 0): lon 90, lat ≈ 66.51 is its centre
    const [x, y] = tileUnits(90, 66.51326, 1, 0, 1);
    expect(x).toBeCloseTo(4096, 3);
    expect(y).toBeCloseTo(4096, 0);
    expect(tileUnits(90, 66.51326, 1, 0, 1, 1)[0]).toBeCloseTo(4096 + 2 * 8192, 3);
  });
  it("fix keys and classes follow the 2D symbol", () => {
    const f = fixOf(pilot({ network: "ivao", cid: 7, aircraftShort: "B77W" }), [], 5);
    expect(f.key).toBe(pilotKey({ network: "ivao", cid: 7 }));
    expect(f.kind).toBe("widebody");
    expect(f.cat).toBe("heavy");
    expect(f.tMs).toBe(5);
  });
});

describe("blended correction of a new fix", () => {
  const fix = (o: Partial<TrafficFix> = {}): TrafficFix => ({ ...fixOf(pilot({ groundSpeedKt: 450, headingDeg: 0, altitudeFt: 30000 }), [], 0), ...o });
  it("smoothstep: full at the start, gone at FIX_BLEND_MS, flat at both ends", () => {
    expect(blendWeight(0)).toBe(1);
    expect(blendWeight(FIX_BLEND_MS)).toBe(0);
    expect(blendWeight(FIX_BLEND_MS / 2)).toBeCloseTo(0.5, 9);
    expect(blendWeight(-5)).toBe(1);
    // slope at the ends ≈ 0 (no kink in speed when the fix arrives or the blend ends)
    expect(1 - blendWeight(16)).toBeLessThan(0.001);
    expect(blendWeight(FIX_BLEND_MS - 16)).toBeLessThan(0.001);
  });
  it("frame by frame across a feed update: no jump, the correction spread over the blend", () => {
    // the feed corrects the reckoned position by 0.3 nm (a turn the reckoning did not know of)
    const t = new TrafficTracks();
    const k = fix().key;
    t.update([fix()], 0);
    const steps: number[] = [];
    let prev = t.poseAt(k, 14_000)!;
    for (let ms = 14_000 + 1000 / 60; ms < 18_000; ms += 1000 / 60) {
      if (ms >= 15_000 && ms - 1000 / 60 < 15_000) {
        const drawn = t.poseAt(k, 15_000)!;
        t.update([fix({ lat: drawn.lat - 0.3 / 60 })], 15_000);
      }
      const p = t.poseAt(k, ms)!;
      steps.push(distNm(prev.lat, prev.lon, p.lat, p.lon));
      prev = p;
    }
    const nominal = (450 / 3600) * (1 / 60); // nm per frame at 450 kt
    // a snap would move 0.3 nm in one frame (~144 frames' worth); blended the worst frame
    // moves 0.3 nm × max smoothstep slope (1.5 / 90 frames) against the flight direction
    const worst = Math.max(...steps.map((s) => Math.abs(s - nominal)));
    expect(worst).toBeLessThan(0.3 * (1.5 / ((FIX_BLEND_MS / 1000) * 60)) + 1e-6);
    expect(worst).toBeLessThan(0.006);
  });
  it("a new height reference glides instead of jumping", () => {
    const t = new TrafficTracks();
    const k = fix().key;
    t.update([fix({ hFt: 30000 })], 0);
    t.update([fix({ hFt: 29000 })], 5000); // same report, airports loaded: 1000 ft lower
    expect(t.poseAt(k, 5000)!.hFt).toBeCloseTo(30000, 6);
    expect(t.poseAt(k, 5000 + FIX_BLEND_MS / 2)!.hFt).toBeCloseTo(29500, 6);
    expect(t.poseAt(k, 5000 + FIX_BLEND_MS)!.hFt).toBe(29000);
    // dead reckoning kept its timing: 7 s after the fix, not 2 s
    expect(t.poseAt(k, 7000)!.lat).toBeCloseTo(EDDF.lat + (450 * 7) / 3600 / 60, 4);
  });
});

describe("historyPoints", () => {
  it("curtain points on the models' height scale, invalid fixes skipped", () => {
    const pts = historyPoints(
      [
        { tMs: 0, latitude: EDDF.lat, longitude: EDDF.lon, altitudeFt: 380, groundSpeedKt: 10 },
        { tMs: 15_000, latitude: EDDF.lat, longitude: east(5), altitudeFt: 2364, groundSpeedKt: 160 },
        { tMs: 30_000, latitude: NaN, longitude: 8, altitudeFt: 3000, groundSpeedKt: 160 },
      ],
      [EDDF],
    );
    expect(pts).toHaveLength(2);
    expect(pts[0]).toMatchObject({ lon: EDDF.lon, lat: EDDF.lat, altFt: 380, hFt: 0 });
    expect(pts[1].hFt).toBeCloseTo(2000, 0);
  });
});
describe("trafficRefTile (globe: no vertex beyond the shader's tile-coordinate range)", () => {
  const merc = (lon: number, lat: number): [number, number] => {
    const s = Math.sin((lat * Math.PI) / 180);
    return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
  };
  it("keeps the map's zoom while every instance is close", () => {
    const [cx, cy] = merc(8.57, 50.03);
    expect(trafficRefTile(cx, cy, 9.4, [merc(8.6, 50.1), merc(8.5, 49.9)]).tz).toBe(9);
  });

  it("coarsens the tile when a picked aircraft lies far up the tilted view (zoom 8, 550 km north)", () => {
    const [cx, cy] = merc(8.57, 50.03);
    const far = merc(8.57, 55);
    const t = trafficRefTile(cx, cy, 8.2, [merc(8.6, 50.1), far]);
    expect(t.tz).toBeLessThan(8);
    const n = 2 ** t.tz;
    for (const [x, y] of [far, merc(8.6, 50.1)]) {
      expect(Math.abs((x * n - t.tx) * 8192)).toBeLessThanOrEqual(TILE_COORD_LIMIT);
      expect(Math.abs((y * n - t.ty) * 8192)).toBeLessThanOrEqual(TILE_COORD_LIMIT);
    }
  });

  it("H-9: a centre beyond 180° (following across the date line) keeps the zoom in its world copy", () => {
    const [cx0, cy] = merc(-175, 0);
    const cx = cx0 + 1; // 185°
    const t = trafficRefTile(cx, cy, 9.4, [
      [cx + 0.0001, cy],
      [cx - 0.0001, cy],
    ]);
    expect(t.tz).toBe(9);
    expect(t.wrap).toBe(1);
    const n = 2 ** t.tz;
    expect(Math.abs(((cx - t.wrap) * n - t.tx) * 8192)).toBeLessThan(8192);
  });

  it("falls back to zoom 0 at worst", () => {
    expect(trafficRefTile(0.5, 0.5, 12, [[0.01, 0.02], [0.99, 0.98]]).tz).toBeLessThanOrEqual(2);
  });
});

describe("field index (grid instead of a linear scan per pilot)", () => {
  // deterministic pseudo-random fields and probes
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const fields: FieldRef[] = Array.from({ length: 2000 }, () => ({ lat: -89 + rnd() * 178, lon: -180 + rnd() * 360, elevFt: Math.round(rnd() * 5000) }));
  // a dense cluster (Europe) so many probes have a field within 15 nm
  for (let i = 0; i < 500; i++) fields.push({ lat: 48 + rnd() * 4, lon: 6 + rnd() * 6, elevFt: 300 });
  const index = new FieldIndex(fields);

  it("finds the same nearest field as the linear scan everywhere (incl. ±180 and the poles)", () => {
    const probes: Array<[number, number]> = [
      [50, 8],
      [49.9, 7.1],
      [0, 179.95],
      [0, -179.95],
      [89.95, 10],
      [-89.9, -120],
    ];
    for (let i = 0; i < 3000; i++) probes.push(i % 3 ? [48 + rnd() * 4, 6 + rnd() * 6] : [-89 + rnd() * 178, -180 + rnd() * 360]);
    for (const [lat, lon] of probes) expect(nearestField(lat, lon, index)?.field).toBe(nearestField(lat, lon, fields)?.field);
  });

  it("a field just across the antimeridian is found from the other side", () => {
    const f: FieldRef = { lat: 10, lon: 179.98, elevFt: 100 };
    expect(nearestField(10, -179.98, new FieldIndex([f]))?.field).toBe(f);
  });

  it("1500 pilots against 2500 fields: far fewer distance checks than the scan", () => {
    const pilots = Array.from({ length: 1500 }, () => [48 + rnd() * 4, 6 + rnd() * 6] as const);
    const t0 = performance.now();
    for (const [lat, lon] of pilots) nearestField(lat, lon, fields);
    const linear = performance.now() - t0;
    const t1 = performance.now();
    for (const [lat, lon] of pilots) nearestField(lat, lon, index);
    const grid = performance.now() - t1;
    // timing is informative only (CI machines vary); the candidate count is the real check
    let candidates = 0;
    for (const [lat, lon] of pilots) for (const _ of index.candidates(lat, lon, 15)) candidates++;
    expect(candidates / pilots.length).toBeLessThan(60);
    expect(Number.isFinite(linear) && Number.isFinite(grid)).toBe(true);
  });
});
