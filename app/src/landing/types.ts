// Mirrors crates/vectasim-core/src/landing.rs and app/src-tauri/src/landing.rs (camelCase serde).

import type { Airport, FlightRow, LandingFact, Metar, Runway, TouchdownReport } from "../types";

export type Band = "smooth" | "normal" | "firm" | "hard";
export type CheckStatus = "pass" | "fail" | "unavailable";
export type CriterionKind = "gear" | "flaps" | "verticalSpeed" | "speed" | "glidepath" | "bank";
/** Where the landing's reference speed comes from (landing.rs SpeedReferenceSource). */
export type SpeedReferenceSource = "user" | "flown" | "design" | "unavailable";

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
  /** null = unknown (no width in the database). */
  widthM: number | null;
  surface: string;
  thresholdLat: number;
  thresholdLon: number;
  endLat: number;
  endLon: number;
  headingDiffDeg: number;
  onRunway: boolean;
  /** Where the geometry comes from (flattened `RunwayGeometry`); missing in old payloads = database. */
  source?: RunwayGeometrySource;
  /** ± m of the threshold along the axis (derived geometry); null = database/user. */
  alongUncertaintyM?: number | null;
  /** ± m of the axis across (derived geometry); null = database/user. */
  crossUncertaintyM?: number | null;
  /** No declared length: `lengthM` is only a lower bound (threshold → end of the rollout). */
  lengthEstimated?: boolean;
  /** Landings a derived geometry is averaged from. */
  derivedFromLandings?: number | null;
}

/**
 * Origin of a runway's geometry (vectasim_core::landing::RunwayGeometrySource):
 * OurAirports coordinates, estimated from the own ground roll (designator from the course,
 * or confirmed by a database runway without coordinates), or set by the pilot.
 */
export type RunwayGeometrySource = "database" | "derived" | "databaseDerived" | "user";

/** Axis and threshold estimated from the own track: the centreline offset says nothing. */
export const isDerivedSource = (s: RunwayGeometrySource | null | undefined): boolean => s === "derived" || s === "databaseDerived";

export interface TouchdownPoint {
  distanceM: number;
  distanceFt: number;
  /** Positive = right of the centreline. */
  lateralM: number;
  /** The touchdown zone begins at the threshold: always 0. */
  tdzStartM: number;
  tdzEndM: number;
  /** Aiming-point marking (ICAO Annex 14 Tab. 5-2: 150/250/300/400 m by runway length). */
  aimingPointM: number;
  inTdz: boolean;
  remainingM: number;
  /** False with a derived runway: its axis is the own rollout, `lateralM` ≈ 0 by construction. */
  lateralMeasurable?: boolean;
  /** ± m of `distanceM` (derived threshold); null = database/user coordinates. */
  distanceUncertaintyM?: number | null;
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
  variableFromDeg?: number | null;
  variableToDeg?: number | null;
  /** Worst crosswind over the dddVddd range (or the whole speed for VRB), magnitude. */
  maxCrosswindKt?: number | null;
  maxGustCrosswindKt?: number | null;
  /** true = from the right; null = either side (VRB). */
  maxCrosswindFromRight?: boolean | null;
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
  tdzEndM: number;
  tdzFirstThird: boolean;
  glidepathDeg: number;
  tchFt: number;
  /** One dot (gate criterion). */
  glidepathToleranceDeg: number;
  /** Two dots, full scale (S2 note). */
  glidepathFullScaleDeg: number;
  maxVsFpm: number;
  speedBelowKt: number;
  speedAboveKt: number;
  vappFromFt: number;
  vappToFt: number;
  vs0Factor: number;
  vappMinVs0: number;
  vappMaxVs0: number;
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
  /** Reference of the gate speed criteria, KIAS; null = not measurable. */
  referenceSpeedKt?: number | null;
  referenceSpeedSource: SpeedReferenceSource;
  flownReferenceKt?: number | null;
  vs0Kt?: number | null;
  referencePlausible?: boolean | null;
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
  /** Observation time of the METAR (its DDHHMMZ group nearest to the touchdown). */
  metarObservedMs?: number | null;
  /** Threshold displacement of the matched runway end (database), m. */
  thresholdDisplacedM?: number | null;
  /** Sim values of the final approach a track-v2 flight recorded; null for older flights. */
  recorded?: RecordedApproachData | null;
}

/** `vectasim_store::RecordedApproachData`: last recorded values in the 3 min before the touchdown. */
export interface RecordedApproachData {
  tasKt: number | null;
  windDirTrueDeg: number | null;
  windKt: number | null;
  /** ILS/automation bits were recorded at all. */
  navFlagsRecorded: boolean;
  /** Seen in any sample of the window. */
  hasLocalizer: boolean;
  hasGlideSlope: boolean;
  glideSlopeValid: boolean;
  autopilotSeen: boolean;
  ilsGsAngleDeg: number | null;
  ilsCourseDeg: number | null;
  flapPositions: number | null;
  designVs0Kt: number | null;
}

// ---- runways remembered per airport (user_runways, crates/vectasim-store/src/store.rs) ----

/** Who a remembered runway comes from: derived from the own landings, or set by the pilot. */
export type UserRunwaySource = "derived" | "user";

/** A row of `user_runways`: landing direction `ident` with its threshold and the far end along the axis. */
export interface UserRunway {
  airportIcao: string;
  ident: string;
  latThr: number;
  lonThr: number;
  latEnd: number;
  lonEnd: number;
  widthM: number | null;
  elevationFt: number | null;
  source: UserRunwaySource;
  /** The far end is only a lower bound (derived without a declared length). */
  lengthEstimated: boolean;
  createdMs: number;
  updatedMs: number;
  /** Landings averaged into a derived runway (0 for one the pilot entered). */
  uses: number;
}

/** What `save_user_runway` takes; `previousIdent` renames an existing row. */
export interface UserRunwayEdit {
  airportIcao: string;
  ident: string;
  latThr: number;
  lonThr: number;
  latEnd: number;
  lonEnd: number;
  widthM?: number | null;
  elevationFt?: number | null;
  lengthEstimated?: boolean;
  previousIdent?: string | null;
}

/**
 * A `landing_facts_recent` row as the backend sends it since R2: the centreline offset is
 * null when the runway was derived from the own track. `LandingFact` (../types) still
 * declares it as a number; every LandingFact fits this type.
 */
export type RunwayFact = Omit<LandingFact, "centerlineOffsetM"> & {
  /** null = not measurable (runway derived from the own ground roll). */
  centerlineOffsetM: number | null;
  /** ± m of `touchdownDistanceM` (derived threshold); null = database/user geometry. */
  touchdownDistanceUncertaintyM?: number | null;
  runwaySource?: RunwayGeometrySource | null;
};
