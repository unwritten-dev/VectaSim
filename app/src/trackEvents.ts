// Markers along a recorded flight path: configuration changes (gear, flaps), the take-off
// rotation, touchdowns and the stable-approach findings of the approach assessment (1000 /
// 500 ft gates, exceedance runs, "stable from", go-around). Pure: track samples (1 Hz) and
// the already fetched `approach_analysis` in, a time-ordered list of events out
// (trackEvents.test.ts). The logbook track map draws them as icons / stretches with a filter
// (map/TrackMap.tsx), the profile chart as ticks (ProfileChart.tsx).
//
// Rotation rate: on a take-off roll (≥ ROLL_MIN_S on the ground before a lift-off that stays
// airborne ≥ AIRBORNE_MIN_S), rotation start is the earliest sample of the uninterrupted
// pitch-up run that ends at the lift-off (each 1 s step > ROT_CONT_DEG_S, the first one
// > ROT_START_DEG_S, GS > ROT_MIN_GS_KT, on the ground). Lift-off = first airborne sample.
// rate = (pitch at lift-off − pitch at rotation start) / time between them, °/s; peak = the
// steepest 1 s step in that run. Airliners rotate at about 2–3 °/s; the normal band is
// ROTATION_SLOW_DEG_S … ROTATION_FAST_DEG_S, below it the marker says "slow" (long roll, late
// lift-off), above it "fast" (tail-strike margin shrinks) – both in the warn tone.

import C from "./trackEvents.constants.json";
import { t } from "./i18n";
import { NNBSP, fmt, fmtClock, fmtNum } from "./i18n/number";
import type { TouchdownReport, TrackSample } from "./types";
import type { ApproachAnalysis, ApproachCriterionKind, ApproachGate, Exceedance, GateKind, Severity } from "./landing/approachTypes";
import { haversineNm } from "./format";
import { CRITERION_SHORT, exceedancePhrase, valueText } from "./landing/facts";
import { sampleAt } from "./landing/replayStore";
import { rateText } from "./landing/rated";

/** Filter groups (menu entries). */
export type TrackEventGroup = "gear" | "flaps" | "rotation" | "gates" | "criteria" | "touchdowns";
export const TRACK_EVENT_GROUPS: readonly TrackEventGroup[] = ["gear", "flaps", "rotation", "gates", "criteria", "touchdowns"];

export type TrackEventKind = "gearDown" | "gearUp" | "flaps" | "rotation" | "gate" | "exceedance" | "stableFrom" | "goAround" | "touchdown";

/** Colour role: neutral / accent = configuration, ok / warn / err = assessment. */
export type TrackEventTone = "neutral" | "accent" | "ok" | "warn" | "err";

/** Rotation-rate classification. */
export type RotationBand = "slow" | "normal" | "fast";

export interface RotationInfo {
  /** Rotation start (first sample of the pitch-up run), epoch ms. */
  startTMs: number;
  /** Mean pitch rate rotation start → lift-off, °/s. */
  rateDegS: number;
  /** Steepest 1 s step, °/s. */
  peakDegS: number;
  /** s from rotation start to lift-off. */
  durationS: number;
  pitchStartDeg: number;
  pitchLiftoffDeg: number;
  /** slow: rate < ROTATION_SLOW_DEG_S; fast: rate > ROTATION_FAST_DEG_S. */
  band: RotationBand;
}

export interface TrackEvent {
  /** Stable id (map feature id, React key). */
  id: string;
  group: TrackEventGroup;
  kind: TrackEventKind;
  tone: TrackEventTone;
  tMs: number;
  /** Runs (exceedances): end of the run, epoch ms. */
  endTMs?: number;
  latitude: number;
  longitude: number;
  /** At the event: height above ground (ft) and IAS (kt) from the track. */
  aglFt: number;
  iasKt: number;
  // kind-specific payload
  flapsFrom?: number;
  flapsTo?: number;
  /** Lift-off; null = lift-off without a measurable rotation (no pitch-up run on the roll). */
  rotation?: RotationInfo | null;
  gate?: { kind: GateKind; stable: boolean | null; failed: ApproachCriterionKind[]; hatFt: number };
  exceedance?: Exceedance;
  approach?: ApproachAnalysis;
  stableFromFt?: number;
  touchdown?: TouchdownReport;
}

// Thresholds: trackEvents.constants.json, shared with the backend's per-flight metrics
// (crates/vectasim-store/src/metrics.rs reads the same file), so both sides agree.
/** Gear counts as down above this %, up below it (with the debounce). */
export const GEAR_THRESHOLD_PCT: number = C.gearThresholdPct;
/** A gear / flap state must hold this long before it counts (s). */
export const CONFIG_HOLD_S: number = C.configHoldS;
export const ROT_START_DEG_S: number = C.rotStartDegS;
export const ROT_CONT_DEG_S: number = C.rotContDegS;
export const ROT_MIN_GS_KT: number = C.rotMinGsKt;
export const ROLL_MIN_S: number = C.rollMinS;
export const AIRBORNE_MIN_S: number = C.airborneMinS;
/** Normal rotation-rate band, °/s (typical 2–3 °/s). */
export const ROTATION_SLOW_DEG_S: number = C.rotationSlowDegS;
export const ROTATION_FAST_DEG_S: number = C.rotationFastDegS;

export function rotationBand(rateDegS: number): RotationBand {
  return rateDegS < ROTATION_SLOW_DEG_S ? "slow" : rateDegS > ROTATION_FAST_DEG_S ? "fast" : "normal";
}

const at = (s: TrackSample) => ({ tMs: s.tMs, latitude: s.latitude, longitude: s.longitude, aglFt: s.onGround ? 0 : s.altitudeAglFt, iasKt: s.iasKt });

/**
 * Transitions of a discrete state with a hold-time debounce: a new value counts once it held
 * ≥ holdS (or to the end of the track); the event time is its first sample. Shorter blips
 * are ignored (from stays the last counted value).
 */
function debouncedChanges<V>(samples: readonly TrackSample[], value: (s: TrackSample) => V, holdS: number): Array<{ i: number; from: V; to: V }> {
  const out: Array<{ i: number; from: V; to: V }> = [];
  if (!samples.length) return out;
  let cur = value(samples[0]);
  let i = 1;
  while (i < samples.length) {
    const v = value(samples[i]);
    if (v === cur) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < samples.length && value(samples[j + 1]) === v) j++;
    const held = (samples[j].tMs - samples[i].tMs) / 1000 + 1;
    if (held >= holdS || j === samples.length - 1) {
      out.push({ i, from: cur, to: v });
      cur = v;
    }
    i = j + 1;
  }
  return out;
}

/**
 * Sample index of the landing gear extension: the last "gear down" after the gear was retracted
 * (in flight, or already up when the recording started in the air); -1 when the gear never moved
 * (fixed gear, no retraction) or was not extended again. The track map colours the path from here on.
 */
export function landingGearDownIndex(samples: readonly TrackSample[]): number {
  let up = samples.length > 0 && samples[0].gearPct < GEAR_THRESHOLD_PCT;
  let idx = -1;
  for (const { i, to } of debouncedChanges(samples, (s) => s.gearPct >= GEAR_THRESHOLD_PCT, CONFIG_HOLD_S)) {
    if (!to) up = true;
    else if (up) idx = i;
  }
  return idx;
}

export function gearEvents(samples: readonly TrackSample[]): TrackEvent[] {
  return debouncedChanges(samples, (s) => s.gearPct >= GEAR_THRESHOLD_PCT, CONFIG_HOLD_S).map(({ i, to }) => {
    const kind = to ? "gearDown" : "gearUp";
    return { id: `${kind}-${samples[i].tMs}`, group: "gear", kind, tone: "neutral", ...at(samples[i]) };
  });
}

export function flapEvents(samples: readonly TrackSample[]): TrackEvent[] {
  return debouncedChanges(samples, (s) => Math.round(s.flapsIndex), CONFIG_HOLD_S).map(({ i, from, to }) => ({
    id: `flaps-${samples[i].tMs}`,
    group: "flaps",
    kind: "flaps",
    tone: "neutral",
    flapsFrom: from,
    flapsTo: to,
    ...at(samples[i]),
  }));
}

/** Rotation of the take-off roll that ends at lift-off index `lo` (first airborne sample); null = no pitch-up run. */
export function rotationAt(samples: readonly TrackSample[], lo: number): RotationInfo | null {
  const rate = (k: number) => (samples[k + 1].pitchDeg - samples[k].pitchDeg) / Math.max(0.001, (samples[k + 1].tMs - samples[k].tMs) / 1000);
  const ok = (k: number) => samples[k].onGround && samples[k].groundSpeedKt > ROT_MIN_GS_KT;
  let r = lo;
  while (r - 1 >= 0 && ok(r - 1) && rate(r - 1) > ROT_CONT_DEG_S) r--;
  // the run starts where the nose clearly comes up
  while (r < lo && rate(r) <= ROT_START_DEG_S) r++;
  if (r >= lo) return null;
  let peak = 0;
  for (let k = r; k < lo; k++) peak = Math.max(peak, rate(k));
  const durationS = (samples[lo].tMs - samples[r].tMs) / 1000;
  const rateDegS = (samples[lo].pitchDeg - samples[r].pitchDeg) / durationS;
  return {
    startTMs: samples[r].tMs,
    rateDegS,
    peakDegS: peak,
    durationS,
    pitchStartDeg: samples[r].pitchDeg,
    pitchLiftoffDeg: samples[lo].pitchDeg,
    band: rotationBand(rateDegS),
  };
}

/** Lift-offs after a take-off roll (no event for a track that starts airborne, nor for a bounce). */
export function rotationEvents(samples: readonly TrackSample[]): TrackEvent[] {
  const out: TrackEvent[] = [];
  let groundSince: number | null = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.onGround) {
      groundSince ??= s.tMs;
      continue;
    }
    if (groundSince == null) continue; // airborne start, or still in the air
    const rollS = (s.tMs - groundSince) / 1000;
    groundSince = null;
    if (rollS < ROLL_MIN_S) continue; // a bounce
    // stays in the air
    let j = i;
    while (j + 1 < samples.length && !samples[j + 1].onGround) j++;
    if ((samples[j].tMs - s.tMs) / 1000 < AIRBORNE_MIN_S) continue;
    if (samples[i - 1].groundSpeedKt <= ROT_MIN_GS_KT) continue;
    const rotation = rotationAt(samples, i);
    const tone = rotation && rotation.band !== "normal" ? "warn" : "neutral";
    out.push({ id: `rotation-${s.tMs}`, group: "rotation", kind: "rotation", tone, rotation, ...at(s) });
  }
  return out;
}

/** Track position at a time, with the AGL / IAS there (null outside the track). */
function placeAt(samples: readonly TrackSample[], tMs: number) {
  const s = sampleAt(samples, tMs);
  return s ? { tMs, latitude: s.latitude, longitude: s.longitude, aglFt: s.onGround ? 0 : s.altitudeAglFt, iasKt: s.iasKt } : null;
}

/** Time the approach last descended through `hatFt` (from its profile), else null. */
function lastDescentThrough(a: ApproachAnalysis, hatFt: number): number | null {
  const pts = a.samples.filter((p) => !p.onGround && p.tMs <= a.endTMs);
  for (let i = pts.length - 1; i > 0; i--) {
    const p = pts[i - 1];
    const q = pts[i];
    if (p.hatFt >= hatFt && q.hatFt < hatFt) {
      const f = (p.hatFt - hatFt) / Math.max(1e-6, p.hatFt - q.hatFt);
      return p.tMs + (q.tMs - p.tMs) * f;
    }
  }
  return null;
}

/**
 * Verdict of a stable-approach gate: false = a criterion failed, true = measured and none
 * failed, null = not reached or nothing measurable. Same rule as the backend metrics.
 */
export function gateVerdict(g: Pick<ApproachGate, "reached" | "criteria">): boolean | null {
  if (!g.reached) return null;
  if (g.criteria.some((c) => c.status === "fail")) return false;
  return g.criteria.some((c) => c.status !== "unavailable") ? true : null;
}

export function approachEvents(samples: readonly TrackSample[], approaches: readonly ApproachAnalysis[]): TrackEvent[] {
  const out: TrackEvent[] = [];
  for (const a of approaches) {
    for (const g of a.gates) {
      if ((g.kind !== "ft1000" && g.kind !== "ft500") || !g.reached || !g.sample) continue;
      const p = placeAt(samples, g.sample.tMs);
      if (!p) continue;
      const failed = g.criteria.filter((c) => c.status === "fail").map((c) => c.kind);
      const stable = gateVerdict(g);
      out.push({
        id: `gate-${a.index}-${g.kind}`,
        group: "gates",
        kind: "gate",
        tone: stable === false ? "err" : stable ? "ok" : "neutral",
        gate: { kind: g.kind, stable, failed, hatFt: g.sample.hatFt },
        approach: a,
        ...p,
        iasKt: g.sample.iasKt,
      });
    }
    a.exceedances.forEach((e, k) => {
      const p = placeAt(samples, e.startTMs);
      if (!p) return;
      out.push({
        id: `exc-${a.index}-${k}`,
        group: "criteria",
        kind: "exceedance",
        tone: e.level === "s2" ? "err" : "warn",
        endTMs: e.endTMs > e.startTMs ? e.endTMs : undefined,
        exceedance: e,
        approach: a,
        ...p,
      });
    });
    const sf = a.stability.stableFromFt;
    if (sf != null) {
      const tMs = lastDescentThrough(a, sf);
      const p = tMs != null ? placeAt(samples, tMs) : null;
      if (p) out.push({ id: `stable-${a.index}`, group: "gates", kind: "stableFrom", tone: "ok", stableFromFt: sf, approach: a, ...p });
    }
    if (a.goAround) {
      const p = placeAt(samples, a.goAround.lowestTMs);
      if (p) out.push({ id: `ga-${a.index}`, group: "gates", kind: "goAround", tone: "warn", approach: a, ...p });
    }
  }
  return out;
}

export function touchdownEvents(samples: readonly TrackSample[], touchdowns: readonly TouchdownReport[]): TrackEvent[] {
  return touchdowns.map((td, i) => {
    const s = sampleAt(samples, td.timestampMs);
    return {
      id: `td-${i}`,
      group: "touchdowns",
      kind: "touchdown",
      tone: "neutral",
      tMs: td.timestampMs,
      latitude: td.latitude,
      longitude: td.longitude,
      aglFt: 0,
      iasKt: s?.iasKt ?? td.groundSpeedKt,
      touchdown: td,
    };
  });
}

/** Every marker of a flight, time order. */
export function trackEvents(samples: readonly TrackSample[], approaches: readonly ApproachAnalysis[] = [], touchdowns: readonly TouchdownReport[] = []): TrackEvent[] {
  return [...gearEvents(samples), ...flapEvents(samples), ...rotationEvents(samples), ...approachEvents(samples, approaches), ...touchdownEvents(samples, touchdowns)].sort(
    (x, y) => x.tMs - y.tMs,
  );
}

// ---- per-flight metrics ------------------------------------------------------------------
//
// The figures the debrief and the trends compare across flights, derived from the same
// markers. The backend computes the same at flight end and for older flights
// (crates/vectasim-store/src/metrics.rs) and stores them; the shared test vectors in
// fixtures/track-metrics-vectors.json keep both in step.
//
// - rotation: the first lift-off after a take-off roll (null when it had no pitch-up run);
// - landing = the last full-stop touchdown (else the last touchdown); its final air segment
//   starts at the last lift-off at least AIRBORNE_MIN_S before it (else the track start);
// - gear down: the last gear-down marker in that segment, AGL and great-circle distance to the
//   threshold of the landing approach's runway (null without runway);
// - landing flaps: the last flap marker in that segment that ends extended (flapsTo > 0);
// - stable approach: the approach that ended in the landing touchdown (else the last landed
//   one): its exceedances (null when it never got below 1000 ft) and the 1000 / 500 ft gate
//   verdicts (gateVerdict).

export interface FlightMetrics {
  rotationRateDegS: number | null;
  rotationPeakDegS: number | null;
  rotationDurationS: number | null;
  gearDownAglFt: number | null;
  gearDownDistNm: number | null;
  landingFlapsAglFt: number | null;
  exceedances: number | null;
  stable1000: boolean | null;
  stable500: boolean | null;
  /** Runway of the landing approach. */
  airportIcao: string | null;
  runwayIdent: string | null;
}

/** Index of the flight's landing: the last full stop, else the last touchdown; null without. */
export function landingTouchdownIndex(touchdowns: ReadonlyArray<Pick<TouchdownReport, "touchAndGo">>): number | null {
  for (let i = touchdowns.length - 1; i >= 0; i--) if (!touchdowns[i].touchAndGo) return i;
  return touchdowns.length ? touchdowns.length - 1 : null;
}

/** Start of the air segment that ends in the touchdown at `tdMs` (epoch ms), -Infinity when the track starts airborne. */
function finalSegmentStart(samples: readonly TrackSample[], tdMs: number): number {
  for (let i = samples.length - 1; i > 0; i--) {
    const s = samples[i];
    if (s.tMs > tdMs - AIRBORNE_MIN_S * 1000) continue;
    if (!s.onGround && samples[i - 1].onGround) return s.tMs;
  }
  return -Infinity;
}

export function flightMetrics(
  samples: readonly TrackSample[],
  approaches: ReadonlyArray<Pick<ApproachAnalysis, "outcome" | "runway" | "gates" | "exceedances" | "band">>,
  touchdowns: ReadonlyArray<Pick<TouchdownReport, "timestampMs" | "touchAndGo">>,
): FlightMetrics {
  const rot = rotationEvents(samples)[0]?.rotation ?? null;
  const k = landingTouchdownIndex(touchdowns);
  const a =
    k == null
      ? null
      : (approaches.find((x) => x.outcome.kind !== "goAround" && x.outcome.touchdownIndex === k) ?? [...approaches].reverse().find((x) => x.outcome.kind === "landed") ?? null);
  let gear: TrackEvent | null = null;
  let flaps: TrackEvent | null = null;
  if (k != null) {
    const tdMs = touchdowns[k].timestampMs;
    const from = finalSegmentStart(samples, tdMs);
    const inSeg = (e: TrackEvent) => e.tMs >= from && e.tMs <= tdMs;
    gear = gearEvents(samples).filter((e) => e.kind === "gearDown" && inSeg(e)).pop() ?? null;
    flaps = flapEvents(samples).filter((e) => (e.flapsTo ?? 0) > 0 && inSeg(e)).pop() ?? null;
  }
  const rw = a?.runway ?? null;
  const gate = (kind: GateKind) => {
    const g = a?.gates.find((x) => x.kind === kind);
    return g ? gateVerdict(g) : null;
  };
  return {
    rotationRateDegS: rot?.rateDegS ?? null,
    rotationPeakDegS: rot?.peakDegS ?? null,
    rotationDurationS: rot?.durationS ?? null,
    gearDownAglFt: gear?.aglFt ?? null,
    gearDownDistNm: gear && rw ? haversineNm(gear.latitude, gear.longitude, rw.thresholdLat, rw.thresholdLon) : null,
    landingFlapsAglFt: flaps?.aglFt ?? null,
    exceedances: a && a.band != null ? a.exceedances.length : null,
    stable1000: gate("ft1000"),
    stable500: gate("ft500"),
    airportIcao: rw?.airport ?? null,
    runwayIdent: rw?.ident ?? null,
  };
}

// ---- filter (per viewer, localStorage) ---------------------------------------------------

export type TrackEventFilter = Record<TrackEventGroup, boolean>;
export const DEFAULT_FILTER: TrackEventFilter = { gear: true, flaps: true, rotation: true, gates: true, criteria: true, touchdowns: true };
const FILTER_KEY = "vectasim.trackMarkers";

export function parseFilter(raw: string | null): TrackEventFilter {
  const out = { ...DEFAULT_FILTER };
  if (!raw) return out;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    for (const g of TRACK_EVENT_GROUPS) if (typeof v[g] === "boolean") out[g] = v[g];
  } catch {
    // keep the defaults
  }
  return out;
}

let filter: TrackEventFilter = (() => {
  try {
    return parseFilter(localStorage.getItem(FILTER_KEY));
  } catch {
    return { ...DEFAULT_FILTER };
  }
})();
const listeners = new Set<() => void>();
export function getTrackEventFilter(): TrackEventFilter {
  return filter;
}
export function setTrackEventFilter(next: TrackEventFilter) {
  filter = next;
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(next));
  } catch {
    // private window: only for this session
  }
  for (const l of listeners) l();
}
export function subscribeTrackEventFilter(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// ---- wording -----------------------------------------------------------------------------

const GATE_SHORT: Partial<Record<GateKind, string>> = { ft1000: "1000 ft", ft500: "500 ft" };
/** Pitch rate as the markers write it: "2.6 °/s" ("–" without value). */
export const fmtDegS = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? fmt(v) : `${fmtNum(v, 1)}${NNBSP}°/s`);
const degS = fmtDegS;

/** Short label on the map / profile chart. */
export function trackEventLabel(e: TrackEvent): string {
  switch (e.kind) {
    case "gearDown":
      return t("map.markers.label.gearDown");
    case "gearUp":
      return t("map.markers.label.gearUp");
    case "flaps":
      return t("map.markers.label.flaps", { from: String(e.flapsFrom ?? 0), to: String(e.flapsTo ?? 0) });
    case "rotation":
      if (!e.rotation) return t("map.markers.label.liftoff");
      if (e.rotation.band === "normal") return t("map.markers.label.rotation", { rate: degS(e.rotation.rateDegS) });
      return t("map.markers.label.rotationBand", { rate: degS(e.rotation.rateDegS), band: t(e.rotation.band === "slow" ? "map.markers.label.slow" : "map.markers.label.fast") });
    case "gate": {
      const gate = GATE_SHORT[e.gate!.kind] ?? e.gate!.kind;
      const s = e.gate!.stable;
      return t(s ? "map.markers.label.gateStable" : s === false ? "map.markers.label.gateUnstable" : "map.markers.label.gateUnmeasured", { gate });
    }
    case "exceedance": {
      const x = e.exceedance!;
      return x.kind === "flapChange" ? CRITERION_SHORT.flapChange : `${CRITERION_SHORT[x.kind]} ${valueText(x.kind, x.peak, "approach")}`;
    }
    case "stableFrom":
      return t("map.markers.label.stableFrom", { height: fmt(e.stableFromFt, 0, "ft") });
    case "goAround":
      return t("map.markers.label.goAround");
    case "touchdown":
      return e.touchdown?.touchAndGo ? t("logbook.detail.touchAndGo") : t("logbook.detail.touchdown");
  }
}

/** Tooltip lines below the label: time and AGL / IAS, then the kind's details. */
export function trackEventDetail(e: TrackEvent): string[] {
  const lines = [t("map.markers.detail.at", { time: fmtClock(e.tMs, { seconds: true }), agl: fmt(Math.round(e.aglFt), 0, "ft"), ias: fmt(e.iasKt, 0, "kt") })];
  if (e.kind === "rotation") {
    lines.push(
      e.rotation
        ? t("map.markers.detail.rotation", { rate: degS(e.rotation.rateDegS), peak: degS(e.rotation.peakDegS), dur: fmt(e.rotation.durationS, 0, "s"), from: fmt(e.rotation.pitchStartDeg, 1, "°"), to: fmt(e.rotation.pitchLiftoffDeg, 1, "°") })
        : t("map.markers.detail.noRotation"),
    );
    lines.push(t("map.markers.detail.rotationTypical"));
  } else if (e.kind === "gate" && e.gate) {
    if (e.gate.failed.length) lines.push(t("map.markers.detail.gateFailed", { list: e.gate.failed.map((k) => CRITERION_SHORT[k]).join(", ") }));
    else if (e.gate.stable) lines.push(t("map.markers.detail.gateOk"));
  } else if (e.kind === "exceedance" && e.exceedance) {
    lines.push(exceedancePhrase(e.exceedance, e.approach));
    lines.push(t(levelKey(e.exceedance.level)));
  } else if (e.kind === "stableFrom") {
    lines.push(t("map.markers.detail.stableFrom"));
  } else if (e.kind === "touchdown" && e.touchdown) {
    lines.push(t("map.markers.detail.touchdown", { rate: rateText(e.touchdown), g: fmt(e.touchdown.peakG, 2, "g") }));
  }
  return lines;
}

const levelKey = (l: Severity) => (l === "s2" ? "map.markers.detail.levelS2" : "map.markers.detail.levelS1");
