// Online traffic as instanced 3D models in the pitched map view (rules: traffic3d.ts).
//
// One MapLibre custom layer with the low-poly meshes of the own aircraft (aircraftMeshes.ts):
// per shape class one mesh, one instance buffer and one `drawElementsInstanced`-style call
// (`drawArraysInstanced`, the meshes are plain triangle lists), so 200 aircraft cost six draw
// calls (plus six for shadow and plumb line from zoom 11). Instance attributes: tile-local
// position, height, heading, size factor and highlight (the selected aircraft in the accent
// colour). Smooth-shaded traffic blue-grey with a shadow side and a darkened rim (the own model's
// lighting, aircraftModel.LIGHT_GLSL), no contour; screen-sized like the own model but a step
// smaller, the own model stays on top (aircraftModel.ts resets the depth under its footprint).
//
// Labels and the click target stay MapLibre symbols (online.ts `traffic-3d-sym`) at the model's
// height via `symbol-height-offset`, fed at 1 Hz with the dead-reckoned positions; the 2D symbols
// of the aircraft drawn in 3D are filtered out meanwhile. Repaints are throttled to 5 Hz while
// anything moves; nothing is redrawn while the traffic stands still and the camera does not move.

import * as maplibregl from "maplibre-gl";
import type { Airport, Pilot } from "../types";
import { meshFor, MODEL_KINDS, type ModelKind } from "./aircraftMeshes";
import { GROUND_UNIT_M, LIGHT_GLSL, MESH_FLOOR, MODEL_PX, VERTEX_FLOATS, metersPerPixel, plumbLine, viewVector } from "./aircraftModel";
import { altToCurtainM } from "./trackChunks";
import {
  FIELD_RADIUS_NM,
  INSTANCE_FLOATS,
  TRAFFIC3D_DETAIL_ZOOM,
  TrafficTracks,
  buildInstances,
  fieldsOf,
  fixOf,
  pickTraffic,
  tileUnits,
  traffic3dActive,
  type FieldRef,
  type InstanceInput,
  type ViewBox,
} from "./traffic3d";
import { pointFeature } from "./common";

/** Traffic models relative to the own model's size (the 2D traffic symbol peaks at ~0.62 × own). */
export const TRAFFIC_MODEL_SCALE = 0.62;
/** The selected aircraft a little bigger. */
export const SELECTED_SCALE = 1.18;
/** Window-depth span per model unit of a traffic model's own parts (depth-buffer resolution ≈ 6e-8). */
const MODEL_DEPTH_SPAN = 2e-4;
/** Largest vertex distance from the model reference, units (A380: 0.63); bounds |v_local|. */
export const MESH_RADIUS = 0.65;
/** Re-read MapLibre's 3D depth range this often. */
const DEPTH_RANGE_REFRESH_MS = 2000;
const EXTENT = 8192;
/** Ground shadow and plumb line only below this height (≈ 10 000 ft). */
const DETAIL_MAX_M = 3048;
/** Repaint tick while anything moves; labels follow every LABEL_EVERY ticks. */
const TICK_MS = 200;
const LABEL_EVERY = 5;

/** Custom layer, symbol layer and source ids. */
export const TRAFFIC_MODEL_LAYER = "traffic-models";
export const TRAFFIC_3D_SOURCE = "traffic-3d";
export const TRAFFIC_3D_SYMBOLS = "traffic-3d-sym";
/** 2D layers that hide the aircraft drawn as models. */
const FLAT_LAYERS = ["vatsim-pilots", "vatsim-pilots-label"];

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

const VERT = (prelude: string, define: string) => `#version 300 es
${prelude}
${define}
in vec3 a_pos;
in vec3 a_normal;
in float a_tone;
in vec4 i_a;               // x, y (tile units), height (m), heading (rad)
in vec2 i_b;               // size factor, highlight
uniform float u_tile_per_unit;
uniform float u_m_per_unit;
uniform float u_ground_m;
uniform float u_mode;      // 0 model, 1 ground shadow, 2 plumb line
uniform vec3 u_view;       // towards the camera (east, north, up)
out vec3 v_normal;
out float v_tone;
out float v_hi;
out float v_local;
void main() {
  float s = i_b.x;
  float c = cos(i_a.w);
  float n = sin(i_a.w);
  vec3 w = vec3(c * a_pos.x + n * a_pos.y, -n * a_pos.x + c * a_pos.y, a_pos.z);
  vec3 nr = vec3(c * a_normal.x + n * a_normal.y, -n * a_normal.x + c * a_normal.y, a_normal.z);
  v_normal = nr;
  v_tone = a_tone;
  v_hi = i_b.y;
  float h = i_a.z;
  // shadow and plumb line only below DETAIL_MAX_M: a line from cruise level crosses the whole view
  if (u_mode > 0.5 && h > ${DETAIL_MAX_M.toFixed(1)}) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  if (u_mode > 1.5) {
    gl_Position = projectTileFor3D(i_a.xy, a_pos.z * h);
    return;
  }
  vec2 xy = i_a.xy + vec2(w.x, -w.y) * u_tile_per_unit * s;
  // screen-sized, flattened near the ground so it never dips below it; lifted by its floor there
  // (the CPU twin and the reasons: aircraftModel.verticalScaleM / groundLiftM)
  float px = u_m_per_unit * s;
  float g = min(px, u_ground_m * s);
  float vs = min(px, h / ${(MESH_FLOOR * 5).toFixed(2)} + g);
  float lift = ${MESH_FLOOR.toFixed(2)} * g;
  float ele = u_mode > 0.5 ? 0.5 : h + w.z * vs + lift;
  gl_Position = projectTileFor3D(xy, ele);
  // model-local distance to the camera: orders the model's own parts (see FRAG)
  v_local = dot(vec3(w.xy, w.z * vs / px), u_view);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 v_normal;
in float v_tone;
in float v_hi;
in float v_local;
uniform vec2 u_depth_range;
uniform float u_mode;
uniform vec3 u_color;
uniform vec3 u_accent;
uniform vec3 u_dark;
uniform vec3 u_view;
uniform float u_light_scheme;
uniform float u_alpha;
uniform float u_shade;
out vec4 fragColor;
${LIGHT_GLSL}
void main() {
  vec3 base = mix(u_color, u_accent, v_hi);
  vec3 c = u_shade > 0.5 ? shadeModel(base, u_dark, v_normal, u_view, v_tone, u_light_scheme) : base;
  fragColor = vec4(c * u_alpha, u_alpha);
  // A model is a few dozen pixels but kilometres away: its parts lie closer together than the
  // depth buffer resolves there and z-fought (flicker). Depth = the fragment's own depth, pulled
  // towards the camera by the model-local distance from its far side, scaled to a sliver of the
  // range: both terms grow along every view ray, so the parts keep their order (now resolved),
  // and no fragment lies behind its true position. The reference point's depth alone (as before)
  // put the half of the model nearer the camera behind the globe's ground depth (MapLibre writes
  // it in globe view) wherever that ground is nearer than the reference point: wings and tails
  // of low aircraft went missing.
  gl_FragDepth = u_mode < 0.5 ? clamp(gl_FragCoord.z - ${MODEL_DEPTH_SPAN.toExponential()} * (v_local + ${MESH_RADIUS.toFixed(2)}), u_depth_range.x, u_depth_range.y) : gl_FragCoord.z;
}`;

const UNIFORMS = [
  "u_tile_per_unit",
  "u_m_per_unit",
  "u_ground_m",
  "u_mode",
  "u_color",
  "u_accent",
  "u_dark",
  "u_view",
  "u_light_scheme",
  "u_depth_range",
  "u_alpha",
  "u_shade",
  "u_projection_matrix",
  "u_projection_fallback_matrix",
  "u_projection_tile_mercator_coords",
  "u_projection_clipping_plane",
  "u_projection_transition",
] as const;

interface Program {
  prog: WebGLProgram;
  loc: Record<string, WebGLUniformLocation | null>;
  attr: { pos: number; normal: number; tone: number; a: number; b: number };
}

interface KindGl {
  mesh: WebGLBuffer;
  count: number;
  inst: WebGLBuffer;
  /** VAOs per program variant (attribute locations may differ between Mercator and globe). */
  vao: Map<string, { model: WebGLVertexArrayObject; line: WebGLVertexArrayObject }>;
}

export interface TrafficModelColors {
  /** Traffic fill (aircraftIcons.trafficColors().fill). */
  body: string;
  /** Selected aircraft. */
  accent: string;
  /** Shadow side, ground shadow, plumb line. */
  dark: string;
  /** Light map theme: stronger rim, lower ambient floor (aircraftModel.LIGHT_GLSL). */
  light?: boolean;
}

/** What the layer draws this frame (Traffic3D.frame). */
export interface TrafficFrame {
  items: Array<{ lon: number; lat: number; hFt: number; headingDeg: number; size: number; kind: ModelKind; selected: boolean }>;
}

/** Draw-call / CPU-time counters for the performance check (dev tools). */
export interface TrafficPerf {
  frames: number;
  ms: number;
  instances: number;
  drawCalls: number;
}

export class TrafficModelLayer implements maplibregl.CustomLayerInterface {
  readonly id = TRAFFIC_MODEL_LAYER;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  failed = false;
  onFail?: () => void;
  private map: maplibregl.Map | null = null;
  private programs = new Map<string, Program>();
  private kinds = new Map<ModelKind, KindGl>();
  private lineVbo: WebGLBuffer | null = null;
  private colors: Record<"body" | "accent" | "dark", [number, number, number]>;
  private lightScheme: number;
  private depthRange: [number, number] = [0, 1];
  private depthRangeAt = -Infinity;
  readonly perf: TrafficPerf = { frames: 0, ms: 0, instances: 0, drawCalls: 0 };

  constructor(
    colors: TrafficModelColors,
    private frame: () => TrafficFrame | null,
  ) {
    this.colors = { body: rgb(colors.body), accent: rgb(colors.accent), dark: rgb(colors.dark) };
    this.lightScheme = colors.light ? 1 : 0;
  }

  onAdd(map: maplibregl.Map, gl: WebGL2RenderingContext | WebGLRenderingContext) {
    this.map = map;
    this.lineVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    // in the mesh layout: ground (z 0) to the aircraft (z 1)
    gl.bufferData(gl.ARRAY_BUFFER, plumbLine(), gl.STATIC_DRAW);
  }

  onRemove(_map: maplibregl.Map, glAny: WebGL2RenderingContext | WebGLRenderingContext) {
    const gl = glAny as WebGL2RenderingContext;
    for (const k of this.kinds.values()) {
      gl.deleteBuffer(k.mesh);
      gl.deleteBuffer(k.inst);
      for (const v of k.vao.values()) {
        gl.deleteVertexArray(v.model);
        gl.deleteVertexArray(v.line);
      }
    }
    this.kinds.clear();
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
        console.warn("traffic model shader:", gl.getShaderInfoLog(s));
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
      console.warn("traffic model program:", gl.getProgramInfoLog(prog));
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
        tone: gl.getAttribLocation(prog, "a_tone"),
        a: gl.getAttribLocation(prog, "i_a"),
        b: gl.getAttribLocation(prog, "i_b"),
      },
    };
    this.programs.set(shader.variantName, p);
    return p;
  }

  private kind(gl: WebGL2RenderingContext, kind: ModelKind): KindGl {
    let k = this.kinds.get(kind);
    if (!k) {
      const data = meshFor(kind);
      const mesh = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      k = { mesh, count: data.length / VERTEX_FLOATS, inst: gl.createBuffer()!, vao: new Map() };
      this.kinds.set(kind, k);
    }
    return k;
  }

  /** VAO: per-vertex mesh attributes plus per-instance attributes (divisor 1). */
  private vaos(gl: WebGL2RenderingContext, p: Program, variant: string, k: KindGl) {
    let v = k.vao.get(variant);
    if (v) return v;
    const make = (buf: WebGLBuffer) => {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const stride = VERTEX_FLOATS * 4;
      if (p.attr.pos >= 0) {
        gl.enableVertexAttribArray(p.attr.pos);
        gl.vertexAttribPointer(p.attr.pos, 3, gl.FLOAT, false, stride, 0);
      }
      if (p.attr.normal >= 0) {
        gl.enableVertexAttribArray(p.attr.normal);
        gl.vertexAttribPointer(p.attr.normal, 3, gl.FLOAT, false, stride, 12);
      }
      if (p.attr.tone >= 0) {
        gl.enableVertexAttribArray(p.attr.tone);
        gl.vertexAttribPointer(p.attr.tone, 1, gl.FLOAT, false, stride, 36);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, k.inst);
      const istride = INSTANCE_FLOATS * 4;
      if (p.attr.a >= 0) {
        gl.enableVertexAttribArray(p.attr.a);
        gl.vertexAttribPointer(p.attr.a, 4, gl.FLOAT, false, istride, 0);
        gl.vertexAttribDivisor(p.attr.a, 1);
      }
      if (p.attr.b >= 0) {
        gl.enableVertexAttribArray(p.attr.b);
        gl.vertexAttribPointer(p.attr.b, 2, gl.FLOAT, false, istride, 16);
        gl.vertexAttribDivisor(p.attr.b, 1);
      }
      gl.bindVertexArray(null);
      return vao;
    };
    v = { model: make(k.mesh), line: make(this.lineVbo!) };
    k.vao.set(variant, v);
    return v;
  }

  render(glAny: WebGL2RenderingContext | WebGLRenderingContext, args: maplibregl.CustomRenderMethodInput) {
    const map = this.map;
    const gl = glAny as WebGL2RenderingContext;
    if (!map || this.failed || !this.lineVbo || typeof gl.drawArraysInstanced !== "function") return;
    const frame = this.frame();
    if (!frame || !frame.items.length) return;
    const t0 = performance.now();
    const p = this.program(gl, args.shaderData);
    if (!p) {
      this.failed = true;
      this.onFail?.();
      return;
    }

    // one reference tile around the map centre; every instance in the world copy nearest to it
    const zoom = map.getZoom();
    const tz = Math.max(0, Math.min(18, Math.floor(zoom)));
    const n = 2 ** tz;
    const c = map.getCenter();
    const cm = maplibregl.MercatorCoordinate.fromLngLat(c);
    const tx = Math.min(n - 1, Math.max(0, Math.floor(cm.x * n)));
    const ty = Math.min(n - 1, Math.max(0, Math.floor(cm.y * n)));
    const inputs: InstanceInput[] = frame.items.map((it) => {
      const mx = (it.lon + 180) / 360;
      const [x, y] = tileUnits(it.lon, it.lat, tx, ty, tz, Math.round(cm.x - mx));
      return { kind: it.kind, x, y, altM: altToCurtainM(it.hFt), headingDeg: it.headingDeg, size: it.size, selected: it.selected };
    });
    const instances = buildInstances(inputs);
    const data = args.getProjectionData({ tileID: { canonical: { x: tx, y: ty, z: tz }, wrap: 0 }, applyGlobeMatrix: true });

    const px = MODEL_PX * TRAFFIC_MODEL_SCALE;
    const tilePerUnit = (px / (512 * 2 ** zoom)) * n * EXTENT;
    const mPerUnit = px * metersPerPixel(c.lat, zoom);

    gl.useProgram(p.prog);
    const L = p.loc;
    gl.uniformMatrix4fv(L.u_projection_matrix, false, data.mainMatrix as Float32Array);
    if (L.u_projection_fallback_matrix) gl.uniformMatrix4fv(L.u_projection_fallback_matrix, false, data.fallbackMatrix as Float32Array);
    if (L.u_projection_tile_mercator_coords) gl.uniform4f(L.u_projection_tile_mercator_coords, ...(data.tileMercatorCoords as [number, number, number, number]));
    if (L.u_projection_clipping_plane) gl.uniform4f(L.u_projection_clipping_plane, ...(data.clippingPlane as [number, number, number, number]));
    if (L.u_projection_transition) gl.uniform1f(L.u_projection_transition, data.projectionTransition);
    gl.uniform1f(L.u_tile_per_unit, tilePerUnit);
    gl.uniform1f(L.u_m_per_unit, mPerUnit);
    gl.uniform1f(L.u_ground_m, GROUND_UNIT_M);
    gl.uniform3f(L.u_dark, ...this.colors.dark);
    gl.uniform3f(L.u_view, ...viewVector(map.getBearing(), map.getPitch()));
    gl.uniform1f(L.u_light_scheme, this.lightScheme);
    // MapLibre's depth range for 3D layers (changes only with the style's layer count); the query
    // is a synchronous round trip to the GPU process (~2 ms), so it is refreshed only now and then
    if (t0 - this.depthRangeAt > DEPTH_RANGE_REFRESH_MS) {
      const r = gl.getParameter(gl.DEPTH_RANGE) as Float32Array;
      this.depthRange = [r[0], r[1]];
      this.depthRangeAt = t0;
    }
    gl.uniform2f(L.u_depth_range, this.depthRange[0], this.depthRange[1]);
    // set every state this layer relies on; nothing is assumed from the previous layer
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);
    gl.frontFace(gl.CCW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const detail = zoom >= TRAFFIC3D_DETAIL_ZOOM;
    let calls = 0;
    const kinds: Array<{ k: KindGl; v: { model: WebGLVertexArrayObject; line: WebGLVertexArrayObject }; count: number }> = [];
    for (const kind of MODEL_KINDS) {
      const buf = instances.get(kind);
      if (!buf) continue;
      const k = this.kind(gl, kind);
      gl.bindBuffer(gl.ARRAY_BUFFER, k.inst);
      gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);
      kinds.push({ k, v: this.vaos(gl, p, args.shaderData.variantName, k), count: buf.length / INSTANCE_FLOATS });
    }

    // 1. ground shadow + plumb line (zoomed in only): translucent, no depth
    if (detail) {
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.depthMask(false);
      gl.uniform1f(L.u_shade, 0);
      for (const { k, v, count } of kinds) {
        gl.bindVertexArray(v.model);
        gl.uniform1f(L.u_mode, 1);
        gl.uniform1f(L.u_alpha, 0.25);
        gl.uniform3f(L.u_color, ...this.colors.dark);
        gl.uniform3f(L.u_accent, ...this.colors.dark);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, k.count, count);
        // plumb line in the traffic colour: a dark line vanishes on the dark basemaps
        gl.bindVertexArray(v.line);
        gl.uniform1f(L.u_mode, 2);
        gl.uniform1f(L.u_alpha, 0.5);
        gl.uniform3f(L.u_color, ...this.colors.body);
        gl.uniform3f(L.u_accent, ...this.colors.accent);
        gl.drawArraysInstanced(gl.LINES, 0, 2, count);
        calls += 2;
      }
    }

    // 2. the lit models, depth-tested against each other and the curtain
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.uniform1f(L.u_mode, 0);
    gl.uniform1f(L.u_alpha, 1);
    gl.uniform1f(L.u_shade, 1);
    gl.uniform3f(L.u_color, ...this.colors.body);
    gl.uniform3f(L.u_accent, ...this.colors.accent);
    for (const { k, v, count } of kinds) {
      gl.bindVertexArray(v.model);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, k.count, count);
      calls++;
    }
    gl.bindVertexArray(null);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);

    this.perf.frames++;
    this.perf.ms += performance.now() - t0;
    this.perf.instances = inputs.length;
    this.perf.drawCalls = calls;
  }
}

/** Box widened by `nm` on every side (degrees; longitude scaled by latitude). */
function widen(b: ViewBox, nm: number): ViewBox {
  const dLat = nm / 60;
  const lat = Math.max(Math.abs(b.south), Math.abs(b.north));
  const dLon = nm / (60 * Math.max(0.1, Math.cos((Math.min(85, lat) * Math.PI) / 180)));
  return { west: b.west - dLon, south: b.south - dLat, east: b.east + dLon, north: b.north + dLat };
}

const contains = (outer: ViewBox, inner: ViewBox) => inner.west >= outer.west && inner.east <= outer.east && inner.south >= outer.south && inner.north <= outer.north;

function boxOf(map: maplibregl.Map): ViewBox {
  const b = map.getBounds();
  return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
}

/**
 * Owner of the 3D traffic: keeps the feed's aircraft (dead-reckoned), the airport elevations
 * around the view, the picked ≤ 200, the custom layer, the 3D label source and the filter that
 * hides the drawn aircraft from the 2D layers. `attach` after every style load (theme change).
 */
export class Traffic3D {
  readonly tracks = new TrafficTracks();
  /** Keys drawn as models (empty while inactive). */
  picked: string[] = [];
  active = false;
  /** Off switch for the performance comparison (and a later setting); default on. */
  enabled = true;
  private pilots: Pilot[] = [];
  private fields: FieldRef[] = [];
  private fieldBox: ViewBox | null = null;
  private fieldSeq = 0;
  private selected: string | null = null;
  private view3d = false;
  private shown = false;
  private map: maplibregl.Map | null = null;
  layer: TrafficModelLayer | null = null;
  private timer: number | undefined;
  private ticks = 0;
  private filterKey = "";

  constructor(private fetchAirports: (box: ViewBox) => Promise<Airport[]>) {}

  /** Adds the custom layer below the flat traffic symbols (labels and hit targets stay above it). */
  attach(map: maplibregl.Map, colors: TrafficModelColors) {
    this.map = map;
    this.filterKey = "";
    const layer = new TrafficModelLayer(colors, () => this.frame());
    layer.onFail = () => {
      this.active = false;
      this.applyLayers();
    };
    map.addLayer(layer, map.getLayer(FLAT_LAYERS[0]) ? FLAT_LAYERS[0] : undefined);
    this.layer = layer;
    this.applyLayers();
    if (this.timer === undefined) this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  dispose() {
    window.clearInterval(this.timer);
    this.timer = undefined;
    this.map = null;
    this.layer = null;
  }

  /** New feed data (a poll or the re-filter after a pan). */
  setPilots(pilots: Pilot[], nowMs = performance.now()) {
    this.pilots = pilots;
    this.tracks.update(
      pilots.map((p) => fixOf(p, this.fields, nowMs)),
      nowMs,
    );
    this.refresh(true);
  }

  /** The aircraft with the traffic card open (accent colour, always among the models). */
  setSelected(key: string | null) {
    if (key === this.selected) return;
    this.selected = key;
    this.refresh();
    this.map?.triggerRepaint();
  }

  /** 3D toggle, traffic layer shown, zoom / pan: recomputes whether and which models show. */
  update(view3d: boolean, trafficShown: boolean) {
    this.view3d = view3d;
    this.shown = trafficShown;
    this.refresh();
  }

  /** `labels`: new positions (feed data) – the label source is rebuilt even if the picked set stays. */
  private refresh(labels = false) {
    const map = this.map;
    if (!map) return;
    const was = this.active;
    this.active = this.enabled && !this.layer?.failed && traffic3dActive(this.view3d, map.getZoom(), this.shown, was);
    if (this.active) {
      const view = boxOf(map);
      this.loadFields(view);
      const c = map.getCenter();
      this.picked = pickTraffic(this.tracks.fixes(), view, { lat: c.lat, lon: c.lng }, undefined, this.selected, new Set(this.picked));
    } else {
      this.picked = [];
    }
    this.applyLayers(labels);
    if (was !== this.active || this.active) map.triggerRepaint();
  }

  /** Airport elevations for the height reference: the view plus 15 nm, re-asked only when the view leaves the fetched box. */
  private loadFields(view: ViewBox) {
    const need = widen(view, FIELD_RADIUS_NM);
    if (this.fieldBox && contains(this.fieldBox, need)) return;
    const box = widen(view, FIELD_RADIUS_NM * 3);
    this.fieldBox = box;
    const seq = ++this.fieldSeq;
    this.fetchAirports(box)
      .then((list) => {
        if (seq !== this.fieldSeq) return;
        this.fields = fieldsOf(list);
        // recompute the heights of the current fixes (unchanged reports keep their timing)
        this.setPilots(this.pilots);
      })
      // embedded airport DB; without it the heights stay MSL − 0
      .catch(() => {
        if (seq === this.fieldSeq) this.fieldBox = null;
      });
  }

  /**
   * 2D filter, label source, selection ring – only touched when the picked set changes (as a set:
   * the distance order changes with every pan of the following camera), the labels also on new
   * feed data. Re-sending them on every move restarted the symbol placement and made the
   * callsigns flicker.
   */
  private applyLayers(labels = true) {
    const map = this.map;
    if (!map) return;
    const key = this.active ? [...this.picked].sort().join(",") : "";
    const changed = key !== this.filterKey;
    if (changed) {
      this.filterKey = key;
      const filter: maplibregl.FilterSpecification | null = this.active && this.picked.length ? ["!", ["in", ["get", "key"], ["literal", this.picked]]] : null;
      for (const id of FLAT_LAYERS) if (map.getLayer(id)) map.setFilter(id, filter);
    }
    if (map.getLayer("traffic-selected")) {
      // the ring lies on the ground; the model itself turns accent while drawn in 3D
      const ringHidden = this.active && !!this.selected && this.picked.includes(this.selected);
      map.setPaintProperty("traffic-selected", "circle-stroke-opacity", ringHidden ? 0 : 1);
    }
    if (changed || labels) this.drawLabels();
  }

  /** Callsign labels and click targets at the models' dead-reckoned positions and heights. */
  private drawLabels(nowMs = performance.now()) {
    const src = this.map?.getSource(TRAFFIC_3D_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    const features: GeoJSON.Feature[] = [];
    if (this.active) {
      for (const k of this.picked) {
        const f = this.tracks.get(k);
        const pose = this.tracks.poseAt(k, nowMs);
        if (!f || !pose) continue;
        features.push(
          pointFeature(pose.lon, pose.lat, {
            key: f.key,
            network: f.network,
            cid: f.cid,
            callsign: f.callsign,
            cat: f.cat,
            sizeFactor: f.size,
            heading: pose.headingDeg,
            hM: altToCurtainM(pose.hFt),
          }),
        );
      }
    }
    src.setData({ type: "FeatureCollection", features });
  }

  /** What the layer draws now. */
  frame(nowMs = performance.now()): TrafficFrame | null {
    if (!this.active) return null;
    const items: TrafficFrame["items"] = [];
    for (const k of this.picked) {
      const f = this.tracks.get(k);
      const pose = this.tracks.poseAt(k, nowMs);
      if (!f || !pose) continue;
      const sel = k === this.selected;
      items.push({ lon: pose.lon, lat: pose.lat, hFt: pose.hFt, headingDeg: pose.headingDeg, size: f.size * (sel ? SELECTED_SCALE : 1), kind: f.kind, selected: sel });
    }
    return { items };
  }

  /** 5 Hz while anything drawn moves: repaint; every second the labels follow. */
  private tick() {
    const map = this.map;
    if (!map || !this.active || document.hidden || map.getCanvas().clientWidth === 0) return;
    const now = performance.now();
    if (!this.tracks.moving(now, this.picked)) return;
    map.triggerRepaint();
    if (++this.ticks % LABEL_EVERY === 0) this.drawLabels(now);
  }
}
