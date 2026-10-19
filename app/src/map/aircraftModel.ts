// Minimal low-poly 3D model of the own aircraft for the pitched (3D) map view.
//
// A MapLibre custom layer with its own tiny WebGL2 meshes (no three.js; one per shape class in
// aircraftMeshes.ts: prop, turboprop, narrow-body, wide-body, A380, helicopter – rounded low-poly
// lofts, at most 800 triangles each), smooth-shaded yellow (Lambert + ambient per pixel, a dark
// shadow side and a subtly darkened rim) with a dark contour (inverted hull), oriented by true
// heading, pitch and bank.
// It sits at the 3D curtain's height (trackChunks.altToCurtainM) and is sized in screen pixels,
// not metres, so it stays visible at every zoom; below it a dark ground shadow (the same mesh
// flattened onto the map) and a plumb line to the ground.
//
// Projection: vertices go through MapLibre's own `projectTileFor3D` (shaderData prelude) with
// tile-local coordinates of a tile around the aircraft (getProjectionData), so Mercator, globe
// and the globe→Mercator transition all work, and the float precision stays high when zoomed
// in. Rendering only on demand: a new pose (10 Hz telemetry) starts a short interpolation that
// asks for repaints until it has caught up; nothing animates while the aircraft stands still.

import * as maplibregl from "maplibre-gl";
import { altToCurtainM } from "./trackChunks";
import { VERTEX_FLOATS, meshFor, type ModelKind } from "./aircraftMeshes";

type V3 = [number, number, number];

export { VERTEX_FLOATS };
const EXTENT = 8192;
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
/** Longest side of the model on screen, css px, × wake factor (medium ≈ 60 px; a pitched view foreshortens it to about the 2D symbol). */
export const MODEL_PX = 46;
/** Contour width in css px. */
const OUTLINE_PX = 1.3;

/**
 * Body → local east/north/up rotation (column-major mat3 for GLSL): bank (right wing down
 * positive) about the longitudinal axis, then pitch (nose up positive), then the true heading
 * (clockwise from north).
 */
export function modelRotation(headingDeg: number, pitchDeg: number, bankDeg: number): Float32Array {
  const r = Math.PI / 180;
  const [ch, sh] = [Math.cos(headingDeg * r), Math.sin(headingDeg * r)];
  const [cp, sp] = [Math.cos(pitchDeg * r), Math.sin(pitchDeg * r)];
  const [cb, sb] = [Math.cos(bankDeg * r), Math.sin(bankDeg * r)];
  // row-major products: H · P · B
  const B = [cb, 0, sb, 0, 1, 0, -sb, 0, cb];
  const P = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
  const H = [ch, sh, 0, -sh, ch, 0, 0, 0, 1];
  const mul = (a: number[], b: number[]) => {
    const o = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
    return o;
  };
  const m = mul(H, mul(P, B));
  // to column-major
  return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}

/** Applies a column-major mat3 to a vector (tests, CPU-side checks). */
export function applyMat3(m: Float32Array, v: V3): V3 {
  return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
}

/** Ground metres per css pixel at `lat` and `zoom` (512 px tiles, as MapLibre). */
export function metersPerPixel(lat: number, zoom: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
}

/** Lowest mesh point below the model reference, units (pods of the wide-bodies: 0.116). */
export const MESH_FLOOR = 0.12;
/**
 * Vertical metres per model unit of an aircraft on the ground (× wake size): keeps a parked
 * model a body, not a decal. Also a floor against the globe view's float32 precision: MapLibre
 * lifts a point by `spherePos * (1 + elevation / R)`, which resolves heights only in steps of
 * about R · 2⁻²³ ≈ 0.76 m – a model flattened to a few decimetres there collapsed into
 * interleaved slivers (contour over body, parts missing).
 */
export const GROUND_UNIT_M = 40;

/**
 * Vertical metres per model unit: the screen-sized scale `pxScaleM`, flattened at low zoom and
 * low height where a pixel-sized model would be kilometres tall and dip into the ground, but
 * never below `groundM` (GROUND_UNIT_M × size). Lifted by groundLiftM, the lowest mesh point
 * (−MESH_FLOOR units, wing tips with bank up to ±0.5) stays above the ground: it lies at
 * 0.8 × heightM.
 */
export function verticalScaleM(pxScaleM: number, heightM: number, groundM = GROUND_UNIT_M): number {
  const g = Math.min(pxScaleM, groundM);
  return Math.max(0, Math.min(pxScaleM, Math.max(0, heightM) / (MESH_FLOOR * 5) + g));
}

/** Lift of the model reference above its height (m): the ground floor of verticalScaleM times the mesh floor. */
export function groundLiftM(pxScaleM: number, groundM = GROUND_UNIT_M): number {
  return MESH_FLOOR * Math.max(0, Math.min(pxScaleM, groundM));
}

export interface ModelPose {
  lon: number;
  lat: number;
  headingDeg: number;
  pitchDeg: number;
  bankDeg: number;
  /** Height above the map's ground (ft, trackChunks.groundHeightFt), not MSL. */
  altFt: number;
  /** Size factor of the wake class (aircraftIcons.WAKE_SIZE). */
  size: number;
  /** Shape class (aircraftMeshes.modelKind). */
  kind: ModelKind;
}

/** Shortest-way blend of two angles in degrees. */
function lerpAngle(a: number, b: number, f: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * f;
}

/** Pose between `a` and `b` (f in 0..1); heading the short way round, longitude across ±180. */
export function lerpPose(a: ModelPose, b: ModelPose, f: number): ModelPose {
  const l = (x: number, y: number) => x + (y - x) * f;
  return {
    lon: lerpAngle(a.lon, b.lon, f),
    lat: l(a.lat, b.lat),
    headingDeg: lerpAngle(a.headingDeg, b.headingDeg, f),
    pitchDeg: l(a.pitchDeg, b.pitchDeg),
    bankDeg: l(a.bankDeg, b.bankDeg),
    altFt: l(a.altFt, b.altFt),
    size: b.size,
    kind: b.kind,
  };
}

/** Pitch/bank clamp: the model is a symbol, a wild sim value must not turn it into a needle. */
const clampAttitude = (v: number, max: number) => (Number.isFinite(v) ? Math.max(-max, Math.min(max, v)) : 0);

/**
 * Unit vector from the model towards the camera in local east/north/up (MapLibre bearing:
 * clockwise from north, pitch 0 = straight down): for the rim shading.
 */
export function viewVector(bearingDeg: number, pitchDeg: number): V3 {
  const b = (bearingDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  return [-Math.sin(b) * Math.sin(p), -Math.cos(b) * Math.sin(p), Math.cos(p)];
}

/**
 * Lighting of the models (shared with trafficModel.ts): Lambert from the upper left plus an
 * ambient floor, mixed towards the theme's dark shade, and a rim (surfaces seen edge-on) darkened
 * a little – more on the light themes, so the silhouette reads as an ink edge on paper / light
 * grey; on the dark themes the ambient floor is higher, so the shadow side does not sink into
 * the map. `tone` < 1 darkens intakes and blades.
 */
export const LIGHT_GLSL = `
const vec3 LIGHT_DIR = vec3(-0.37, 0.46, 0.81);
vec3 shadeModel(vec3 base, vec3 dark, vec3 n, vec3 view, float tone, float lightScheme) {
  n = normalize(n);
  float l = max(dot(n, LIGHT_DIR), 0.0);
  // ambient floor plus a little sky light from above, so the shadow side keeps its colour
  float ambient = mix(0.52, 0.46, lightScheme) + 0.1 * n.z;
  float k = clamp(ambient + 0.56 * l, 0.0, 1.0);
  vec3 c = mix(dark, base, k);
  float rim = 1.0 - abs(dot(n, view));
  c = mix(c, dark, mix(0.28, 0.55, lightScheme) * rim * rim * rim);
  return mix(dark, c, tone);
}`;

/** Plumb line vertices in the mesh layout: ground (z 0) to the aircraft (z 1), no contour offset, full tone. */
export function plumbLine(): Float32Array {
  const v = (z: number) => [0, 0, z, 0, 0, 1, 0, 0, 0, 1];
  return new Float32Array([...v(0), ...v(1)]);
}

/** "#rrggbb" → linear-ish RGB 0..1 for the shader. */
function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

const VERT = (prelude: string, define: string) => `#version 300 es
${prelude}
${define}
in vec3 a_pos;
in vec3 a_normal;
in vec3 a_outline;
in float a_tone;
uniform mat3 u_rot;
uniform vec2 u_origin;      // aircraft position, tile units
uniform float u_tile_per_unit;
uniform float u_m_per_unit;
uniform float u_alt;        // metres
uniform float u_lift;       // metres, the model reference above u_alt (groundLiftM)
uniform float u_outline;    // model units, 0 = no contour offset
uniform float u_mode;       // 0 model, 1 ground shadow, 2 plumb line
uniform vec3 u_view;        // towards the camera (east, north, up)
uniform float u_vratio;     // vertical / horizontal metres per model unit (flattened at low zoom)
out vec3 v_normal;
out float v_tone;
out float v_depth;
out float v_clip;
void main() {
  // contour: inflated along the normal averaged over every face at that position (closed hull)
  vec3 p = a_pos + a_outline * u_outline;
  vec3 w = u_rot * p;
  v_normal = u_rot * a_normal;
  v_tone = a_tone;
  // model-local depth towards the camera (orthographic, in model units): see FRAG. The contour
  // hull is pushed back by its own inflation (|a_outline| = 1, u_vratio <= 1), so no hull fragment
  // lies nearer than the body point it was inflated from: where the averaged contour direction
  // turns against the face (open intakes, thin edges: nacelle hulls poked through the wing) it
  // painted dark patches over the body, worst on the grounded model.
  v_depth = dot(vec3(w.xy, w.z * u_vratio), u_view) - u_outline;
#ifdef GLOBE
  // projectTileFor3D keeps the depth (and the model writes its own): behind the globe's horizon
  // the whole aircraft, its shadow and plumb line are hidden, judged at its reference point
  v_clip = u_projection_transition > 0.2
    ? dot(projectToSphere(u_origin, u_origin) * (1.0 + u_alt / GLOBE_RADIUS), u_projection_clipping_plane.xyz) + u_projection_clipping_plane.w
    : 1.0;
#else
  v_clip = 1.0;
#endif
  if (u_mode > 1.5) {
    gl_Position = projectTileFor3D(u_origin, a_pos.z * u_alt);
    return;
  }
  vec2 xy = u_origin + vec2(w.x, -w.y) * u_tile_per_unit;
  float ele = u_mode > 0.5 ? 0.5 : u_alt + u_lift + w.z * u_m_per_unit;
  gl_Position = projectTileFor3D(xy, ele);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 v_normal;
in float v_tone;
in float v_depth;
in float v_clip;
uniform vec3 u_color;
uniform vec3 u_dark;
uniform vec3 u_view;
uniform float u_light_scheme;
uniform float u_alpha;
uniform float u_shade;     // 1 = lit model, 0 = flat colour
uniform float u_far;       // 1 = depth reset pass: writes the far plane (colour masked off)
uniform float u_mode;
out vec4 fragColor;
${LIGHT_GLSL}
void main() {
  if (v_clip < 0.0) discard;
  vec3 c = u_shade > 0.5 ? shadeModel(u_color, u_dark, v_normal, u_view, v_tone, u_light_scheme) : u_color;
  fragColor = vec4(c * u_alpha, u_alpha);
  // The model is only ~60 px but metres to kilometres away: its parts (and the contour hull
  // behind them) lie closer together than the depth buffer resolves there, so they z-fought and
  // the model flickered. After the footprint reset it is drawn with its own depth: the model-local
  // distance to the camera spread over most of the depth range (always in front of the reset 1.0).
  gl_FragDepth = u_far > 0.5 ? 1.0 : (u_mode < 0.5 ? 0.5 - 0.4 * clamp(v_depth, -1.0, 1.0) : gl_FragCoord.z);
}`;

interface Program {
  prog: WebGLProgram;
  loc: Record<string, WebGLUniformLocation | null>;
  attr: { pos: number; normal: number; outline: number; tone: number };
}

const UNIFORMS = [
  "u_rot",
  "u_origin",
  "u_tile_per_unit",
  "u_m_per_unit",
  "u_alt",
  "u_lift",
  "u_outline",
  "u_mode",
  "u_color",
  "u_dark",
  "u_view",
  "u_light_scheme",
  "u_alpha",
  "u_shade",
  "u_far",
  "u_vratio",
  "u_projection_matrix",
  "u_projection_fallback_matrix",
  "u_projection_tile_mercator_coords",
  "u_projection_clipping_plane",
  "u_projection_transition",
] as const;

export interface ModelColors {
  /** Body colour (#ffd54a). */
  body: string;
  /** Shadow side, contour, ground shadow, plumb line. */
  dark: string;
  /** Light map theme: stronger rim, lower ambient floor. */
  light?: boolean;
}

/** Duration of the blend towards a new pose; the telemetry runs at ~10 Hz. */
const BLEND_MAX_MS = 250;

/**
 * The custom layer. `setPose` with each sample, `setEnabled` with the 3D toggle; `failed`
 * turns true when WebGL refuses the shaders (the caller then shows the raised flat symbol).
 */
export class AircraftModelLayer implements maplibregl.CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  failed = false;
  /** Called once when the shaders fail (the caller falls back to the flat symbol). */
  onFail?: () => void;
  private map: maplibregl.Map | null = null;
  private programs = new Map<string, Program>();
  private vbos = new Map<ModelKind, { buf: WebGLBuffer; count: number }>();
  private lineVbo: WebGLBuffer | null = null;
  private enabled = false;
  private from: ModelPose | null = null;
  private to: ModelPose | null = null;
  private startMs = 0;
  private blendMs = 0;
  private lastArrival = 0;
  private colors: { body: [number, number, number]; dark: [number, number, number] };
  private lightScheme: number;

  constructor(id: string, colors: ModelColors) {
    this.id = id;
    this.colors = { body: rgb(colors.body), dark: rgb(colors.dark) };
    this.lightScheme = colors.light ? 1 : 0;
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    this.map?.triggerRepaint();
  }

  /** New target pose; null removes the aircraft. Blends from the pose currently drawn. */
  setPose(p: ModelPose | null, nowMs = performance.now()) {
    if (!p) {
      this.from = this.to = null;
      this.map?.triggerRepaint();
      return;
    }
    const current = this.poseAt(nowMs);
    const gap = this.lastArrival ? nowMs - this.lastArrival : 0;
    this.lastArrival = nowMs;
    // a jump (first pose, teleport, long gap) is not animated
    const far = current ? Math.abs(current.lat - p.lat) + Math.abs(lerpAngle(current.lon, p.lon, 1) - current.lon) > 0.05 : true;
    this.from = current && !far && gap > 0 && gap < 2000 ? current : p;
    this.to = p;
    this.startMs = nowMs;
    this.blendMs = Math.min(BLEND_MAX_MS, gap);
    if (this.enabled) this.map?.triggerRepaint();
  }

  private poseAt(nowMs: number): ModelPose | null {
    if (!this.to) return null;
    if (!this.from || this.blendMs <= 0) return this.to;
    const f = Math.min(1, (nowMs - this.startMs) / this.blendMs);
    return f >= 1 ? this.to : lerpPose(this.from, this.to, f);
  }

  onAdd(map: maplibregl.Map, gl: WebGL2RenderingContext | WebGLRenderingContext) {
    this.map = map;
    // plumb line: ground (z 0) to the aircraft (z 1), scaled by u_alt in the shader
    this.lineVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, plumbLine(), gl.STATIC_DRAW);
  }

  onRemove(_map: maplibregl.Map, gl: WebGL2RenderingContext | WebGLRenderingContext) {
    for (const v of this.vbos.values()) gl.deleteBuffer(v.buf);
    this.vbos.clear();
    if (this.lineVbo) gl.deleteBuffer(this.lineVbo);
    for (const p of this.programs.values()) gl.deleteProgram(p.prog);
    this.programs.clear();
    this.map = null;
  }

  private program(gl: WebGL2RenderingContext, shader: maplibregl.CustomRenderMethodInput["shaderData"]): Program | null {
    const cached = this.programs.get(shader.variantName);
    if (cached) return cached;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn("aircraft model shader:", gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT(shader.vertexShaderPrelude, shader.define));
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return null;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("aircraft model program:", gl.getProgramInfoLog(prog));
      return null;
    }
    const loc: Program["loc"] = {};
    for (const u of UNIFORMS) loc[u] = gl.getUniformLocation(prog, u);
    const p: Program = {
      prog,
      loc,
      attr: {
        pos: gl.getAttribLocation(prog, "a_pos"),
        normal: gl.getAttribLocation(prog, "a_normal"),
        outline: gl.getAttribLocation(prog, "a_outline"),
        tone: gl.getAttribLocation(prog, "a_tone"),
      },
    };
    this.programs.set(shader.variantName, p);
    return p;
  }

  /** Vertex buffer of a class, uploaded on first use. */
  private mesh(gl: WebGL2RenderingContext, kind: ModelKind): { buf: WebGLBuffer; count: number } {
    let v = this.vbos.get(kind);
    if (!v) {
      const data = meshFor(kind);
      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      v = { buf, count: data.length / VERTEX_FLOATS };
      this.vbos.set(kind, v);
    }
    return v;
  }

  private bind(gl: WebGL2RenderingContext, p: Program, buf: WebGLBuffer | null) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const stride = VERTEX_FLOATS * 4;
    const set = (loc: number, offset: number, size = 3) => {
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    };
    set(p.attr.pos, 0);
    set(p.attr.normal, 12);
    set(p.attr.outline, 24);
    set(p.attr.tone, 36, 1);
  }

  render(glAny: WebGL2RenderingContext | WebGLRenderingContext, args: maplibregl.CustomRenderMethodInput) {
    const map = this.map;
    const gl = glAny as WebGL2RenderingContext;
    if (!map || !this.enabled || this.failed || !this.lineVbo) return;
    const now = performance.now();
    const pose = this.poseAt(now);
    if (!pose) return;
    if (this.to && pose !== this.to) map.triggerRepaint();
    const p = this.program(gl, args.shaderData);
    if (!p) {
      this.failed = true;
      this.onFail?.();
      return;
    }
    const { buf, count } = this.mesh(gl, pose.kind);

    // tile around the aircraft (precision), in the world copy nearest the map centre
    const zoom = map.getZoom();
    const tz = Math.max(0, Math.min(18, Math.floor(zoom)));
    const n = 2 ** tz;
    const merc = maplibregl.MercatorCoordinate.fromLngLat([pose.lon, pose.lat]);
    const centreX = maplibregl.MercatorCoordinate.fromLngLat(map.getCenter()).x;
    const wrap = Math.round(centreX - merc.x);
    const tx = Math.min(n - 1, Math.max(0, Math.floor(merc.x * n)));
    const ty = Math.min(n - 1, Math.max(0, Math.floor(merc.y * n)));
    const origin: [number, number] = [(merc.x * n - tx) * EXTENT, (merc.y * n - ty) * EXTENT];
    const data = args.getProjectionData({ tileID: { canonical: { x: tx, y: ty, z: tz }, wrap }, applyGlobeMatrix: true });

    const px = MODEL_PX * pose.size;
    const worldPx = 512 * 2 ** zoom;
    const tilePerUnit = (px / worldPx) * n * EXTENT;
    const heightM = altToCurtainM(pose.altFt);
    const pxScaleM = px * metersPerPixel(pose.lat, zoom);
    const groundM = GROUND_UNIT_M * pose.size;
    const mPerUnit = verticalScaleM(pxScaleM, heightM, groundM);
    const outline = OUTLINE_PX / px;
    const rot = modelRotation(pose.headingDeg, clampAttitude(pose.pitchDeg, 30), clampAttitude(pose.bankDeg, 60));

    gl.useProgram(p.prog);
    const L = p.loc;
    gl.uniformMatrix4fv(L.u_projection_matrix, false, data.mainMatrix as Float32Array);
    if (L.u_projection_fallback_matrix) gl.uniformMatrix4fv(L.u_projection_fallback_matrix, false, data.fallbackMatrix as Float32Array);
    if (L.u_projection_tile_mercator_coords) gl.uniform4f(L.u_projection_tile_mercator_coords, ...(data.tileMercatorCoords as [number, number, number, number]));
    if (L.u_projection_clipping_plane) gl.uniform4f(L.u_projection_clipping_plane, ...(data.clippingPlane as [number, number, number, number]));
    if (L.u_projection_transition) gl.uniform1f(L.u_projection_transition, data.projectionTransition);
    gl.uniformMatrix3fv(L.u_rot, false, rot);
    gl.uniform2f(L.u_origin, origin[0], origin[1]);
    gl.uniform1f(L.u_tile_per_unit, tilePerUnit);
    gl.uniform1f(L.u_m_per_unit, mPerUnit);
    gl.uniform1f(L.u_alt, heightM);
    gl.uniform1f(L.u_lift, groundLiftM(pxScaleM, groundM));
    gl.uniform3f(L.u_color, ...this.colors.body);
    gl.uniform3f(L.u_dark, ...this.colors.dark);
    gl.uniform3f(L.u_view, ...viewVector(map.getBearing(), map.getPitch()));
    gl.uniform1f(L.u_light_scheme, this.lightScheme);
    gl.uniform1f(L.u_far, 0);
    gl.uniform1f(L.u_vratio, mPerUnit / Math.max(1e-9, pxScaleM));

    // every GL state this layer relies on is set here, nothing is assumed from the previous layer;
    // own buffers on the default vertex array (never a VAO MapLibre or another custom layer left bound)
    gl.bindVertexArray(null);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);
    gl.frontFace(gl.CCW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // 1. ground shadow (flattened mesh) and 2. plumb line: no depth, translucent
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    this.bind(gl, p, buf);
    gl.uniform1f(L.u_mode, 1);
    gl.uniform1f(L.u_outline, 0);
    gl.uniform1f(L.u_shade, 0);
    gl.uniform3f(L.u_color, ...this.colors.dark);
    gl.uniform1f(L.u_alpha, 0.32);
    gl.drawArrays(gl.TRIANGLES, 0, count);
    this.bind(gl, p, this.lineVbo);
    gl.uniform1f(L.u_mode, 2);
    gl.uniform1f(L.u_alpha, 0.7);
    gl.drawArrays(gl.LINES, 0, 2);

    // 3. depth reset under the model's footprint: the inflated hull writes the far plane, so
    // neither traffic models nor the curtain (whose head ends at the aircraft, one sample ahead of
    // the interpolated model) can hide parts of it – it is always on top and does not flicker
    // against them. Unlike a depth clear, the rest of the depth buffer stays intact.
    this.bind(gl, p, buf);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.ALWAYS);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(false, false, false, false);
    gl.uniform1f(L.u_mode, 0);
    gl.uniform1f(L.u_alpha, 1);
    gl.uniform1f(L.u_outline, outline);
    gl.uniform1f(L.u_far, 1);
    gl.drawArrays(gl.TRIANGLES, 0, count);
    gl.uniform1f(L.u_far, 0);
    gl.colorMask(true, true, true, true);

    // 4. contour (inverted hull: back faces of a slightly inflated mesh) and 5. the lit model
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);
    gl.uniform1f(L.u_outline, outline);
    gl.drawArrays(gl.TRIANGLES, 0, count);
    gl.cullFace(gl.BACK);
    gl.uniform1f(L.u_outline, 0);
    gl.uniform1f(L.u_shade, 1);
    gl.uniform3f(L.u_color, ...this.colors.body);
    gl.drawArrays(gl.TRIANGLES, 0, count);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
  }
}
