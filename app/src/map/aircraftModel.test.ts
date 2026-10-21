import { describe, expect, it } from "vitest";
import { AircraftModelLayer, GROUND_UNIT_M, MESH_FLOOR, applyMat3, groundLiftM, lerpPose, metersPerPixel, modelRotation, poseChangeVisible, verticalScaleM, VERTEX_FLOATS, type ModelPose } from "./aircraftModel";
import { MESH_RADIUS } from "./trafficModel";
import { altToCurtainM } from "./trackChunks";
import { MESH_TRI_BUDGET, MODEL_KINDS, kindOfWake, meshFor, meshParts, modelKind, modelSize, triangleCount } from "./aircraftMeshes";
import { WAKE_SIZE, wakeCategory } from "./aircraftIcons";

const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe("modelRotation", () => {
  it("heading turns the nose clockwise from north", () => {
    close(applyMat3(modelRotation(0, 0, 0), [0, 1, 0]), [0, 1, 0]);
    close(applyMat3(modelRotation(90, 0, 0), [0, 1, 0]), [1, 0, 0]);
    close(applyMat3(modelRotation(180, 0, 0), [0, 1, 0]), [0, -1, 0]);
    // right wing at heading 90 points south
    close(applyMat3(modelRotation(90, 0, 0), [1, 0, 0]), [0, -1, 0]);
  });
  it("pitch up lifts the nose, right bank lowers the right wing", () => {
    expect(applyMat3(modelRotation(0, 10, 0), [0, 1, 0])[2]).toBeCloseTo(Math.sin(Math.PI / 18), 6);
    expect(applyMat3(modelRotation(0, 0, 20), [1, 0, 0])[2]).toBeCloseTo(-Math.sin(Math.PI / 9), 6);
    // bank is about the (pitched, headed) longitudinal axis: the nose stays where heading/pitch put it
    const nose = applyMat3(modelRotation(45, 5, 30), [0, 1, 0]);
    close(nose, applyMat3(modelRotation(45, 5, 0), [0, 1, 0]));
  });
  it("is orthonormal", () => {
    const m = modelRotation(123, -7, 41);
    for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Array<[number, number, number]>) expect(Math.hypot(...applyMat3(m, v))).toBeCloseTo(1, 6);
  });
});

describe("scale helpers", () => {
  it("metres per pixel like MapLibre (512 px tiles)", () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(40_075_016.686 / 512, 3);
    expect(metersPerPixel(60, 10)).toBeCloseTo(metersPerPixel(0, 10) / 2, 6);
  });
  it("vertical scale follows the screen size, flattened so the model never dips into the ground", () => {
    expect(verticalScaleM(100, 10_000)).toBe(100);
    expect(verticalScaleM(50_000, 3000)).toBe(5000 + GROUND_UNIT_M);
    // lowest mesh point (−MESH_FLOOR units) above the ground, the reference lifted by groundLiftM
    for (const px of [5, 17, 40, 140, 1100, 50_000])
      for (const h of [0, 1, 30, 300, 3000, 12_000]) {
        const vs = verticalScaleM(px, h);
        expect(vs).toBeLessThanOrEqual(px); // u_vratio <= 1: the contour push-back covers the inflation
        expect(h + groundLiftM(px) - MESH_FLOOR * vs).toBeGreaterThanOrEqual(0);
      }
  });
  it("a grounded model keeps its height in globe view at every zoom (float32 elevation steps)", () => {
    // MapLibre's globe lifts by spherePos * (1 + ele / R) in float32: heights resolve in steps of R · 2⁻²³;
    // flattened to ~0.2 m there (zoom ≤ 12) the model collapsed into slivers, the contour over the body
    const step = 6_371_008.8 * 2 ** -23;
    const zs = meshFor("narrowbody").filter((_, i) => i % VERTEX_FLOATS === 2);
    const height = Math.max(...zs) - Math.min(...zs);
    // globe rendering up to zoom 12 (MapLibre blends into Mercator from 10 to 12)
    for (let zoom = 6; zoom <= 12; zoom++) {
      const vs = verticalScaleM(46 * metersPerPixel(50, zoom), altToCurtainM(0));
      expect(height * vs).toBeGreaterThan(10 * step);
    }
  });
});

describe("mesh bounds the shaders rely on", () => {
  it("every vertex within MESH_RADIUS (traffic depth push) and above −MESH_FLOOR; unit contour directions", () => {
    for (const k of MODEL_KINDS) {
      const d = meshFor(k);
      for (let i = 0; i < d.length; i += VERTEX_FLOATS) {
        expect(Math.hypot(d[i], d[i + 1], d[i + 2])).toBeLessThanOrEqual(MESH_RADIUS);
        expect(d[i + 2]).toBeGreaterThanOrEqual(-MESH_FLOOR);
        expect(Math.hypot(d[i + 6], d[i + 7], d[i + 8])).toBeCloseTo(1, 5);
      }
    }
  });
});

describe("lerpPose", () => {
  const a: ModelPose = { lon: 179.9, lat: 10, headingDeg: 350, pitchDeg: 0, bankDeg: 0, altFt: 1000, size: 1.3, kind: "narrowbody" };
  const b: ModelPose = { ...a, lon: -179.9, headingDeg: 10, altFt: 2000 };
  it("heading and longitude the short way round", () => {
    const m = lerpPose(a, b, 0.5);
    expect(((m.headingDeg % 360) + 360) % 360).toBeCloseTo(0, 6);
    expect(Math.abs(m.lon)).toBeCloseTo(180, 6);
    expect(m.altFt).toBe(1500);
  });
});

describe("aircraft meshes", () => {
  const tri = (m: Float32Array, v: number) => [0, 1, 2].map((k) => [m[v + k * VERTEX_FLOATS], m[v + k * VERTEX_FLOATS + 1], m[v + k * VERTEX_FLOATS + 2]]);
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  for (const kind of MODEL_KINDS) {
    it(`${kind}: valid triangles within the budget, unit normals agreeing with the winding, inside the model box`, () => {
      const m = meshFor(kind);
      expect(m.length % (VERTEX_FLOATS * 3)).toBe(0);
      const count = triangleCount(kind);
      expect(count).toBeGreaterThan(300);
      expect(count).toBeLessThanOrEqual(MESH_TRI_BUDGET);
      for (let v = 0; v < m.length; v += VERTEX_FLOATS * 3) {
        const p = tri(m, v);
        const face = cross(sub(p[1], p[0]), sub(p[2], p[0]));
        for (let k = 0; k < 3; k++) {
          const o = v + k * VERTEX_FLOATS;
          const n = [m[o + 3], m[o + 4], m[o + 5]];
          const c = [m[o + 6], m[o + 7], m[o + 8]];
          expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 5);
          expect(Math.hypot(c[0], c[1], c[2])).toBeCloseTo(1, 5);
          // smooth normals stay on the outer side of their face (back-face culling, lighting)
          expect(dot(face, n)).toBeGreaterThan(0);
          expect(m[o + 9]).toBeGreaterThan(0);
          expect(m[o + 9]).toBeLessThanOrEqual(1);
        }
        for (const q of p) for (const x of q) expect(Math.abs(x)).toBeLessThanOrEqual(0.56);
      }
    });

    it(`${kind}: every part is a closed hull with outward winding`, () => {
      for (const part of meshParts(kind)) {
        const key = (i: number) => part.pos[i].map((x) => Math.round(x * 1e5)).join(",");
        // each directed edge (by position) is matched by exactly one opposite edge
        const edges = new Map<string, number>();
        let vol = 0;
        for (let i = 0; i < part.tris.length; i += 3) {
          const t = [part.tris[i], part.tris[i + 1], part.tris[i + 2]];
          for (let k = 0; k < 3; k++) {
            const e = `${key(t[k])}|${key(t[(k + 1) % 3])}`;
            edges.set(e, (edges.get(e) ?? 0) + 1);
          }
          const [a, b, c] = t.map((j) => part.pos[j]);
          vol += dot(a, cross(b, c)) / 6;
        }
        for (const [e, n] of edges) {
          const [a, b] = e.split("|");
          expect(n, `${kind}/${part.name} edge ${e}`).toBe(1);
          expect(edges.get(`${b}|${a}`), `${kind}/${part.name} edge ${e} open`).toBe(1);
        }
        expect(vol, `${kind}/${part.name} volume`).toBeGreaterThan(0);
      }
    });
  }

  it("is mirror-symmetric left/right", () => {
    for (const kind of MODEL_KINDS) {
      const m = meshFor(kind);
      const pts = new Set<string>();
      const k = (x: number, y: number, z: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
      for (let v = 0; v < m.length; v += VERTEX_FLOATS) pts.add(k(m[v], m[v + 1], m[v + 2]));
      for (let v = 0; v < m.length; v += VERTEX_FLOATS) expect(pts.has(k(-m[v], m[v + 1], m[v + 2])), kind).toBe(true);
    }
  });

  it("keeps the proportions: super widest, helicopter rotor wider than its fuselage, nose at +0.5", () => {
    const ext = (kind: (typeof MODEL_KINDS)[number]) => {
      const m = meshFor(kind);
      let x = 0;
      let y = -1;
      let z = 0;
      for (let v = 0; v < m.length; v += VERTEX_FLOATS) {
        x = Math.max(x, m[v]);
        y = Math.max(y, m[v + 1]);
        z = Math.min(z, m[v + 2]);
      }
      return { x, y, z };
    };
    expect(ext("super").x).toBeGreaterThan(ext("widebody").x);
    expect(ext("heli").x).toBeGreaterThan(0.4);
    for (const kind of MODEL_KINDS) {
      if (kind !== "heli") expect(ext(kind).y).toBeGreaterThan(0.48);
      // the lowest point stays above the floor the traffic layer lifts the models by
      expect(ext(kind).z).toBeGreaterThanOrEqual(-0.12);
    }
  });
});

describe("modelKind", () => {
  it("follows the 2D wake class for jets", () => {
    expect(modelKind("A20N")).toBe("narrowbody");
    expect(modelKind("B738")).toBe("narrowbody");
    expect(modelKind("A359")).toBe("widebody");
    expect(modelKind("B77W")).toBe("widebody");
    expect(modelKind("A388")).toBe("super");
    expect(modelKind("C172")).toBe("prop");
    expect(modelKind(null, null, null)).toBe("narrowbody");
    for (const c of ["A20N", "B77W", "A388", "C172", "E190", "B744"]) expect(modelKind(c)).toBe(kindOfWake(wakeCategory(c)));
  });
  it("refines by engine type: turboprops and helicopters", () => {
    expect(modelKind("AT76")).toBe("turboprop");
    expect(modelKind("DH8D")).toBe("turboprop");
    expect(modelKind(null, "ATR 72-600")).toBe("turboprop");
    expect(modelKind("EC35")).toBe("heli");
    expect(modelKind("R44")).toBe("heli");
    expect(modelKind(null, "Airbus H135")).toBe("heli");
    expect(modelKind(null, "Bell 407")).toBe("heli");
    // single-engine turboprops keep the single-prop shape
    expect(modelKind("TBM9")).toBe("prop");
    // business jets are not helicopters
    expect(modelKind("H25B")).toBe("narrowbody");
  });
  it("same size factor as the 2D symbol", () => {
    for (const c of ["light", "medium", "heavy", "super"] as const) expect(modelSize(c)).toBe(WAKE_SIZE[c]);
  });
});

describe("invisible pose changes (no blend, no frame)", () => {
  const base: ModelPose = { lon: 8, lat: 50, headingDeg: 90, pitchDeg: 2, bankDeg: 0, altFt: 35_000, size: 1, kind: "narrowbody" };
  it("a 10 Hz cruise step zoomed out is below half a pixel; zoomed in it shows", () => {
    // 450 kt for 0.1 s ≈ 23 m east
    const next = { ...base, lon: base.lon + 23 / (111_320 * Math.cos((50 * Math.PI) / 180)) };
    expect(poseChangeVisible(base, next, metersPerPixel(50, 7))).toBe(false);
    expect(poseChangeVisible(base, next, metersPerPixel(50, 14))).toBe(true);
  });
  it("attitude, height, shape and size count; across ±180 the short way", () => {
    const mpp = metersPerPixel(50, 6);
    expect(poseChangeVisible(base, { ...base, headingDeg: 90.6 }, mpp)).toBe(true);
    expect(poseChangeVisible(base, { ...base, bankDeg: 0.2 }, mpp)).toBe(false);
    expect(poseChangeVisible(base, { ...base, altFt: base.altFt + 3000 }, mpp)).toBe(true);
    expect(poseChangeVisible(base, { ...base, kind: "widebody" }, mpp)).toBe(true);
    expect(poseChangeVisible({ ...base, lon: 179.9999 }, { ...base, lon: -179.9999 }, mpp)).toBe(false);
    expect(poseChangeVisible(null, base, mpp)).toBe(true);
  });
  it("the layer takes an invisible step without asking for a frame", () => {
    let repaints = 0;
    const layer = new AircraftModelLayer("m", { body: "#ffd54a", dark: "#000000" });
    const map = { getZoom: () => 6, triggerRepaint: () => repaints++ };
    layer.onAdd(map as never, { createBuffer: () => ({}), bindBuffer() {}, bufferData() {}, ARRAY_BUFFER: 1, STATIC_DRAW: 1 } as never);
    layer.setEnabled(true);
    layer.setPose(base, 0);
    // what the last frame showed (render needs GL; the field is what render sets)
    (layer as unknown as { drawn: ModelPose }).drawn = base;
    const before = repaints;
    layer.setPose({ ...base, lon: base.lon + 0.0001 }, 100);
    expect(repaints).toBe(before);
    layer.setPose({ ...base, lon: base.lon + 0.5 }, 200);
    expect(repaints).toBe(before + 1);
  });
});
