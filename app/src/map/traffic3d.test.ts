import { describe, expect, it } from "vitest";
import type { Airport, Pilot } from "../types";
import {
  DR_MAX_S,
  FIX_BLEND_MS,
  INSTANCE_FLOATS,
  TRAFFIC3D_MAX,
  TrafficTracks,
  buildInstances,
  deadReckon,
  distNm,
  fieldsOf,
  fixOf,
  inView,
  nearestField,
  pickTraffic,
  pilotKey,
  tileUnits,
  traffic3dActive,
  trafficHeightFt,
  type FieldRef,
  type TrafficFix,
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
