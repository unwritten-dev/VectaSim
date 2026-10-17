// Mirrors crates/vectasim-core/src/landing.rs and app/src-tauri/src/landing.rs (camelCase serde).

import type { Airport, FlightRow, Metar, Runway, TouchdownReport } from "../types";

export type Band = "smooth" | "normal" | "firm" | "hard";
export type CheckStatus = "pass" | "fail" | "unavailable";
export type CriterionKind = "gear" | "flaps" | "verticalSpeed" | "speed" | "glidepath" | "bank";

export interface ApproachPoint {
  tMs: number;
  latitude: number;
  longitude: number;
  hatFt: number;
  iasKt: number;
  groundSpeedKt: number;
  vsFpm: number;
  bankDeg: number;
  pitchDeg: number;
  onGround: boolean;
  flapsIndex: number;
  gearPct: number;
  xM?: number | null;
  yM?: number | null;
  /** To the threshold (or touchdown point without runway); negative past it. */
  distM: number;
  glidepathDeg?: number | null;
  glidepathDevDeg?: number | null;
}

export interface RunwayMatch {
  airport: string;
  ident: string;
  oppositeIdent: string;
  headingTrueDeg: number;
  lengthM: number;
  widthM: number;
  surface: string;
  thresholdLat: number;
  thresholdLon: number;
  endLat: number;
  endLon: number;
  headingDiffDeg: number;
  onRunway: boolean;
}

export interface TouchdownPoint {
  distanceM: number;
  distanceFt: number;
  /** Positive = right of the centreline. */
  lateralM: number;
  tdzStartM: number;
  tdzEndM: number;
  inTdz: boolean;
  remainingM: number;
}

export interface ThresholdCrossing {
  tMs: number;
  heightFt: number;
  iasKt: number;
  airborneS: number;
}

export interface GateSample {
  tMs: number;
  hatFt: number;
  distM: number;
  iasKt: number;
  vsFpm: number;
  bankDeg: number;
  flapsIndex: number;
  gearPct: number;
  glidepathDevDeg?: number | null;
}

export interface ApproachStats {
  startReason?: "altitude" | "distance" | "trackStart" | null;
  startHatFt?: number | null;
  startDistM?: number | null;
  durationS?: number | null;
  iasMinKt?: number | null;
  iasMaxKt?: number | null;
  iasAt500Kt?: number | null;
  iasAt50Kt?: number | null;
  iasAtTouchdownKt?: number | null;
  vsMin1000Fpm?: number | null;
  vsMax1000Fpm?: number | null;
  vsMin500Fpm?: number | null;
  vsMax500Fpm?: number | null;
  bankMaxBelow500Deg?: number | null;
  glidepathDevAt1000Deg?: number | null;
  glidepathDevAt500Deg?: number | null;
  glidepathDevMaxAboveDeg?: number | null;
  glidepathDevMaxBelowDeg?: number | null;
}

export interface Flare {
  startHatFt: number;
  startTMs: number;
  durationS: number;
  approachVsFpm: number;
  finalVsFpm: number;
}

export interface Rollout {
  distanceM: number;
  durationS: number;
  endLat: number;
  endLon: number;
  remainingM?: number | null;
}

export interface WindComponents {
  directionDeg?: number | null;
  speedKt: number;
  gustKt?: number | null;
  referenceHeadingDeg: number;
  relativeToRunway: boolean;
  headwindKt?: number | null;
  /** Positive = from the right. */
  crosswindKt?: number | null;
  gustHeadwindKt?: number | null;
  gustCrosswindKt?: number | null;
}

export interface Criterion {
  kind: CriterionKind;
  status: CheckStatus;
  measured?: number | null;
  limitMin?: number | null;
  limitMax?: number | null;
  reference?: number | null;
}

export interface GateCheck {
  gateFt: number;
  reached: boolean;
  sample?: GateSample | null;
  criteria: Criterion[];
}

export interface GroundPoint {
  tMs: number;
  latitude: number;
  longitude: number;
  xM?: number | null;
  yM?: number | null;
}

export interface LandingConfig {
  tdzStartM: number;
  tdzEndM: number;
  tdzFirstThird: boolean;
  glidepathDeg: number;
  tchFt: number;
  glidepathToleranceDeg: number;
  maxVsFpm: number;
  speedBelowKt: number;
  speedAboveKt: number;
  maxBankDeg: number;
  matchLateralM: number;
  matchHeadingDeg: number;
  rolloutEndKt: number;
  approachStartFt: number;
  approachFallbackM: number;
  flareVsFraction: number;
}

export interface LandingAnalysis {
  touchdownIndex: number;
  touchdown: TouchdownReport;
  /** Band of the headline landing rate (touchdown.landingRateFpm). */
  vsBand: Band;
  vsMeasuredBand: Band;
  vsHardestBand: Band;
  gBand: Band;
  runway?: RunwayMatch | null;
  touchdownPoint?: TouchdownPoint | null;
  touchdownElevationFt?: number | null;
  threshold?: ThresholdCrossing | null;
  approach: ApproachStats;
  flare?: Flare | null;
  rollout?: Rollout | null;
  wind?: WindComponents | null;
  gates: GateCheck[];
  bouncePoints: GroundPoint[];
  distanceRef: "threshold" | "touchdown";
  samples: ApproachPoint[];
  config: LandingConfig;
}

export interface LandingDebriefData {
  flight: FlightRow;
  touchdownCount: number;
  analysis: LandingAnalysis;
  airport?: Airport | null;
  runwayData?: Runway | null;
  metar?: Metar | null;
  /** True: the METAR stored at the landing; false: the current one. */
  metarAtLanding: boolean;
  metarNote?: string | null;
}
