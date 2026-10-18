// Mirrors crates/vectasim-core/src/approach.rs, crates/vectasim-store/src/store.rs
// (ApproachFactRow) and app/src-tauri/src/approach.rs (camelCase serde).
//
// Commands:
//   invoke<ApproachAnalysis[]>("approach_analysis", { flightId })
//   invoke<ApproachFactsResult>("approach_facts_recent", { limit?, includeDemo? })
// Event: "approach:facts" (payload: flight id) once a completed flight's facts are cached.
//
// Conventions (all values):
// - Heights are HAT = height above the touchdown/threshold elevation (see `elevationSource`), ft.
// - V/S in fpm, negative = descending. Speeds in kt (IAS unless named otherwise).
// - Runway frame: xM along the runway from the threshold (negative = before it), yM right of
//   the centreline (positive = right, in landing direction), metres.
// - Glidepath/localizer "dots": positive = above / right of the path. 1 GS dot = 0.35°,
//   1 LOC dot = 52 m at the threshold seen from a virtual antenna 300 m beyond the runway end.
// - Deviations: measured − reference (altitude: + = high; speed: IAS − Vapp, + = fast;
//   energy: + = too much energy).
// - `null` = not measurable (no runway, no reference speed, gate not reached) – never "failed".
// - Source of the numbers: all from the 1 Hz track ("gemessen"), path/localizer/energy/TAS
//   are geometric or derived ("abgeleitet"), the 3° path is an assumption, the reference speed
//   is the flown median unless the pilot set one (`reference.vappSource`).

import type { CheckStatus, Criterion, CriterionKind, RunwayGeometrySource, RunwayMatch } from "./types";

/** Criterion kinds; the approach adds five to the landing's. */
export type ApproachCriterionKind =
  | CriterionKind
  /** Localizer proxy, dots (signed, + = right). */
  | "localizer"
  /** Height vs the reference path, ft (+ = high). */
  | "altitudeDeviation"
  /** IAS against a fixed upper limit (250 kt at 10 nm), kt. */
  | "speedLimit"
  /** Energy excess over the reference profile, ft (+ = too much). */
  | "energy"
  /** Flap handle changed below 1000 ft (event; measured 1 = change). */
  | "flapChange";

/**
 * A gate criterion, same shape as the landing's `Criterion`. Units of `measured`:
 * gear % down; flaps handle index; verticalSpeed fpm (signed); speed kt IAS − Vapp;
 * glidepath / localizer dots (signed); bank |°|; altitudeDeviation ft; speedLimit kt IAS;
 * energy ft. `reference`: Vapp (speed, energy), path angle ° (glidepath, altitudeDeviation),
 * landing flap index (flaps) – else null.
 */
export type ApproachCriterion = Omit<Criterion, "kind"> & { kind: ApproachCriterionKind };
export type { CheckStatus };

/** How the approach ended. */
export type ApproachOutcome =
  | { kind: "landed"; touchdownIndex: number }
  | { kind: "touchAndGo"; touchdownIndex: number }
  | { kind: "goAround" };

/**
 * EASA/D4S band over 1000 → 50 ft: stable = no S1 criterion; deviations = 1–2 criteria above
 * 500 ft, none below; unstable = ≥ 3 above 500 ft; unstableBelow500 = ≥ 1 below 500 ft.
 * A go-around is not a band (see `outcome`).
 */
export type ApproachBand = "stable" | "deviations" | "unstable" | "unstableBelow500";

/** HAT = 0 at: the first on-ground sample (measured) / database elevation (go-around) / ground under the lowest point. */
export type ElevationSource = "touchdown" | "database" | "terrain";
/** What trackDistM = 0 is: the runway threshold, the touchdown point (no runway) or the go-around's lowest point (no runway). */
export type TrackDistRef = "threshold" | "touchdown" | "lowestPoint";
/** user = pilot value; flown = median IAS 500 → 100 ft of this approach (judges consistency, not the absolute speed); unavailable = speed not measurable. */
export type VappSource = "user" | "flown" | "unavailable";
export type GlidepathSource = "assumed";
/** aircraftPositions = last handle position; touchdown = flap index at the touchdown; unknown = gate checks "≥ 1". */
export type LandingFlapsSource = "aircraftPositions" | "touchdown" | "unknown";
export type MarkerKind = "tod" | "tenNm" | "faf" | "gate1000" | "gate500" | "gate50" | "threshold" | "touchdown" | "goAround";
/** phase = phase-engine event sharpened in the track; track = from the track alone. */
export type MarkerSource = "phase" | "track";
export type GateKind = "tenNm" | "faf" | "ft1000" | "ft500" | "ft50";
/** distance = 5 nm before the threshold came first; height = 1500 ft HAT came first. */
export type FafReason = "distance" | "height";
export type Severity = "s1" | "s2";
/** tasKt in the profile: recorded (track v2) or derived from IAS + altitude (ISA). */
export type TasSource = "recorded" | "derived";
/** both = track pattern confirmed by the phase engine. */
export type GoAroundSource = "track" | "phase" | "both";
export type ConfigEventKind = "gearDown" | "gearUp" | "flaps";

export interface ApproachReference {
  /** Reference path angle, ° (3°, assumed – no procedure data). */
  glidepathDeg: number;
  glidepathSource: GlidepathSource;
  /** Threshold crossing height of the reference path, ft. */
  tchFt: number;
  /** Reference speed of the speed criteria, KIAS; null = speed not measurable. */
  vappKt: number | null;
  vappSource: VappSource;
  /** Median IAS 500 → 100 ft HAT (always shown, also when a user value is the reference), KIAS. */
  flownVappKt: number | null;
  /** DESIGN SPEED VS0, KIAS (track v2 only; null today). */
  vs0Kt: number | null;
  /** Vapp within 1.1–1.6 × VS0; null without VS0. */
  vappPlausible: boolean | null;
  /** Landing flap handle index the 1000/500 ft flaps check expects; null = only "≥ 1". */
  landingFlapsIndex: number | null;
  landingFlapsSource: LandingFlapsSource;
}

/** First point from which the aircraft stayed on the extended centreline (track ≤ 10°, |y| ≤ max(150 m, 3 % of |x|)). */
export interface EstablishedPoint {
  tMs: number;
  /** ft HAT. */
  hatFt: number;
  /** Distance to the threshold along the runway axis, nm. */
  distNm: number;
  /** Flown distance to the threshold, m. */
  trackDistM: number;
}

export interface Marker {
  kind: MarkerKind;
  source: MarkerSource;
  tMs: number;
  /** ft HAT. */
  hatFt: number;
  /** m, see TrackDistRef. */
  trackDistM: number;
  /** Runway frame x, m; null without runway. */
  xM: number | null;
  /** KIAS. */
  iasKt: number;
}

/** Values interpolated where a gate was passed (the last time on the way down). */
export interface ApproachGateSample {
  tMs: number;
  /** ft HAT (= the gate height for the ft gates). */
  hatFt: number;
  /** m flown to go. */
  trackDistM: number;
  /** Runway frame, m (null without runway). */
  xM: number | null;
  /** m, + = right of the centreline. */
  yM: number | null;
  iasKt: number;
  /** kt, see EnergyStats.tasSource. */
  tasKt: number;
  groundSpeedKt: number;
  /** fpm, negative = descending. */
  vsFpm: number;
  /** °, + = right wing down. */
  bankDeg: number;
  pitchDeg: number;
  /** Configuration once through the gate. */
  flapsIndex: number;
  /** % down. */
  gearPct: number;
  /** ° vs the 3° path, + = high (only on final, ≥ 0.25 nm before the aiming point). */
  glidepathDevDeg: number | null;
  /** Dots, + = high. */
  gsDots: number | null;
  /** Dots, + = right. */
  locDots: number | null;
  /** ft vs the reference path, + = high. */
  altDevFt: number | null;
  /** kt, IAS − Vapp. */
  iasDevKt: number | null;
  /** ft, + = too much energy. */
  energyDevFt: number | null;
}

/** Same role as the landing's `GateCheck`, keyed by `kind` instead of `gateFt`. */
export interface ApproachGate {
  kind: GateKind;
  /** False: the approach never passed this gate (criteria empty). */
  reached: boolean;
  /** FAF only. */
  fafReason: FafReason | null;
  sample: ApproachGateSample | null;
  /**
   * tenNm: altitudeDeviation (±500 ft, only when established on final), speedLimit (≤ 250 kt),
   * energy (≤ +1000 ft, only when established); faf: gear, flaps (≥ 1), altitudeDeviation
   * (±300 ft), speed (−5/+40 kt); ft1000/ft500: gear (≥ 95 %), flaps (landing flaps), verticalSpeed
   * (±1000 fpm), speed (−5/+20 kt), glidepath (±1 dot), localizer (±1 dot), bank (≤ 15°);
   * ft50: none (values only).
   */
  criteria: ApproachCriterion[];
}

/** A continuous S1 violation lasting at least its minimum duration (EASA/D4S). */
export interface Exceedance {
  kind: ApproachCriterionKind;
  /** s2 when the S2 limit was also exceeded for its duration within this run. */
  level: Severity;
  startTMs: number;
  endTMs: number;
  /** s (whole 1 Hz samples; 0 for flapChange events). */
  durationS: number;
  startHatFt: number;
  endHatFt: number;
  /** Worst measured value, unit as in ApproachCriterion.measured (signed). */
  peak: number;
  /** The S1 limit crossed (same unit). */
  limit: number;
  /** Counts below 500 ft (one such makes the band unstableBelow500). */
  below500: boolean;
}

export interface TimeOutside {
  kind: ApproachCriterionKind;
  /** s in qualifying S1 runs. */
  seconds: number;
}

/** Over the band window 1000 → 50 ft (glidepath to 200 ft). Statistics need ≥ 5 samples, else null. */
export interface StabilityStats {
  /** Highest HAT (≤ 1500 ft, rounded down to 50 ft) from which down to 50 ft no S1 criterion was violated; null = never stable / not measurable. */
  stableFromFt: number | null;
  windowSamples: number;
  /** RMS of the height deviation from the path, ft. */
  gpRmsFt: number | null;
  gpRmsDots: number | null;
  /** Largest deviation above (> 0) / below (< 0), dots. */
  gpMaxAboveDots: number | null;
  gpMaxBelowDots: number | null;
  /** RMS of y, m. */
  latRmsM: number | null;
  /** Largest |y| with sign, m (+ = right). */
  latMaxM: number | null;
  locRmsDots: number | null;
  /** IAS − Vapp: median, median absolute deviation, 95th percentile of |dev|, min, max – kt. */
  iasMedianDevKt: number | null;
  iasMadKt: number | null;
  iasP95AbsDevKt: number | null;
  iasMinDevKt: number | null;
  iasMaxDevKt: number | null;
  /** Share 0–1 of samples outside −5/+10 kt. */
  iasOutsideShare: number | null;
  /** Standard deviation of V/S, fpm. */
  vsSdFpm: number | null;
  /** Most negative V/S, fpm. */
  vsMinFpm: number | null;
  /** Share 0–1 of samples with |V/S| > 1000 fpm. */
  vsOver1000Share: number | null;
  /** |°|. */
  bankMaxDeg: number | null;
  bankRmsDeg: number | null;
  /** Only criteria with time outside > 0. */
  timeOutside: TimeOutside[];
}

/** Energy height vs the reference (path at Vapp), ft: total = height part + speed part. */
export interface EnergyPoint {
  totalFt: number;
  /** = altitude deviation, ft. */
  heightFt: number;
  /** (TAS² − Vapp_TAS²) / 2g, ft. */
  speedFt: number;
}

/** Only with a runway and a reference speed. */
export interface EnergyStats {
  tasSource: TasSource;
  atTenNm: EnergyPoint | null;
  atFaf: EnergyPoint | null;
  at1000: EnergyPoint | null;
  /** Largest excess from 10 nm to the end, ft, and where (ft HAT). */
  maxExcessFt: number | null;
  maxExcessHatFt: number | null;
}

export interface GoAround {
  detectedBy: GoAroundSource;
  /** Lowest point ("decision point"). */
  lowestTMs: number;
  lowestHatFt: number;
  lowestMslFt: number;
  lowestTrackDistM: number;
  lowestXM: number | null;
  /** First sample after the lowest point climbing > 500 fpm. */
  climbTMs: number | null;
  /** Phase-engine Approach/Final → Climb (fires after a 10 s dwell). */
  phaseTMs: number | null;
  /** ft gained within 60 s. */
  climbFt: number;
  /** Documentation only, within 30 s after the lowest point. */
  maxPitchDeg: number;
  minIasKt: number;
}

/** Track v2 only – always null today. */
export interface AutomationStats {
  autopilotOffHatFt: number | null;
  autothrustOffHatFt: number | null;
}

/** Configuration changes during the approach (for a configuration strip). */
export interface ConfigEvent {
  /** gearDown = reached 95 %; gearUp = below 5 %; flaps = handle index changed. */
  kind: ConfigEventKind;
  tMs: number;
  hatFt: number;
  trackDistM: number;
  iasKt: number;
  flapsFrom: number | null;
  flapsTo: number | null;
}

/** Profile point; thinned to 1 Hz below 3000 ft HAT, one per 5 s above. */
export interface ApproachProfilePoint {
  tMs: number;
  latitude: number;
  longitude: number;
  /** ft HAT. */
  hatFt: number;
  altitudeMslFt: number;
  /** Flown m to go (monotonic; negative past the reference). */
  trackDistM: number;
  xM: number | null;
  yM: number | null;
  iasKt: number;
  tasKt: number;
  groundSpeedKt: number;
  vsFpm: number;
  bankDeg: number;
  pitchDeg: number;
  flapsIndex: number;
  gearPct: number;
  onGround: boolean;
  /** On the extended centreline (after "established", or inside the ±30° final cone). Path/localizer values only where true. */
  onFinal: boolean;
  /** Angle from the aiming point, °. */
  glidepathDeg: number | null;
  glidepathDevDeg: number | null;
  gsDots: number | null;
  /** Angle from the virtual localizer antenna, ° (+ = right). */
  locAngleDeg: number | null;
  locDots: number | null;
  /** Height of the reference path here, ft HAT (on final from x, before it from trackDistM). */
  refHatFt: number | null;
  altDevFt: number | null;
  iasDevKt: number | null;
  energyDevFt: number | null;
  /** Track v2 (wind at the aircraft): + = headwind / from the right. Null today. */
  headwindKt: number | null;
  crosswindKt: number | null;
}

/** Thresholds used (ApproachConfig::default in Rust). */
export interface ApproachConfig {
  glidepathDeg: number;
  tchFt: number;
  gsDotDeg: number;
  gsS1Dots: number;
  gsS2Dots: number;
  gsDurationS: number;
  gsFloorFt: number;
  locDotMAtThreshold: number;
  locAntennaBeyondEndM: number;
  locS1Dots: number;
  locS2Dots: number;
  locDurationS: number;
  speedS1AboveKt: number;
  speedS1BelowKt: number;
  speedS2AboveKt: number;
  speedS2BelowKt: number;
  speedDurationS: number;
  vsS1Fpm: number;
  vsS1DurationS: number;
  vsS2Fpm: number;
  vsS2DurationS: number;
  bankS1Deg: number;
  bankS2Deg: number;
  bankDurationS: number;
  gearDownPct: number;
  configGateFt: number;
  momentaryS: number;
  windowTopFt: number;
  windowBottomFt: number;
  stableFromMaxFt: number;
  stableRoundFt: number;
  gateMaxVsFpm: number;
  gateSpeedBelowKt: number;
  gateSpeedAboveKt: number;
  gateDots: number;
  gateMaxBankDeg: number;
  tenNmAltToleranceFt: number;
  tenNmMaxIasKt: number;
  tenNmMaxEnergyFt: number;
  fafDistNm: number;
  fafHatFt: number;
  fafAltToleranceFt: number;
  fafSpeedAboveKt: number;
  fafSpeedBelowKt: number;
  vappFromFt: number;
  vappToFt: number;
  vappMinVs0: number;
  vappMaxVs0: number;
  statsSpeedBelowKt: number;
  statsSpeedAboveKt: number;
  gaMaxAglFt: number;
  gaMinClimbFt: number;
  gaWindowS: number;
  gaMinDescentFt: number;
  gaLookbackS: number;
  gaPhaseMinClimbFt: number;
  gaExcludeS: number;
  matchLateralM: number;
  matchHeadingDeg: number;
  matchPathM: number;
  matchMaxAglFt: number;
  matchMaxDistM: number;
  establishedTrackDeg: number;
  establishedMinM: number;
  establishedRatio: number;
  assessFromNm: number;
  assessFromFt: number;
  profileDenseBelowFt: number;
  profileSparseS: number;
  profileAfterTouchdownS: number;
  minStatSamples: number;
}

/** One approach of a flight (result of `approach_analysis`, time order). */
export interface ApproachAnalysis {
  /** 0-based within the flight. */
  index: number;
  outcome: ApproachOutcome;
  /** Matched runway (touchdown point, or for a go-around the best-aligned end over the last 3 nm); null = none. `onRunway` is false for go-arounds. */
  runway: RunwayMatch | null;
  /** HAT = 0 at this MSL, ft. */
  elevationFt: number;
  elevationSource: ElevationSource;
  trackDistRef: TrackDistRef;
  reference: ApproachReference;
  established: EstablishedPoint | null;
  /** Time order. */
  markers: Marker[];
  /** Always five, in order tenNm, faf, ft1000, ft500, ft50. */
  gates: ApproachGate[];
  /** Band window 1000 → 50 ft, time order. */
  exceedances: Exceedance[];
  /** null: never below 1000 ft. */
  band: ApproachBand | null;
  stability: StabilityStats;
  energy: EnergyStats | null;
  goAround: GoAround | null;
  automation: AutomationStats | null;
  configEvents: ConfigEvent[];
  /** First profile point / start of the assessment (15 nm, 5000 ft) / touchdown or lowest point, epoch ms. */
  startTMs: number;
  assessedFromTMs: number;
  endTMs: number;
  samples: ApproachProfilePoint[];
  config: ApproachConfig;
}

/** One cached approach (row of `approach_facts` + flight metadata), result of `approach_facts_recent`. */
export interface ApproachFact {
  flightId: string;
  approachIndex: number;
  /** Cache version (APPROACH_FACTS_VERSION). */
  version: number;
  computedMs: number;
  outcome: "landed" | "touch_and_go" | "go_around";
  touchdownIndex: number | null;
  airportIcao: string | null;
  runwayIdent: string | null;
  /** Touchdown / lowest point of the go-around, epoch ms. */
  endedMs: number;
  establishedNm: number | null;
  establishedHatFt: number | null;
  /** ft; null = never stable / not measurable. */
  stableFromFt: number | null;
  vappKt: number | null;
  vappSource: VappSource | null;
  gpDeg: number | null;
  gpSource: GlidepathSource | null;
  /** 10 nm gate: height vs path (ft, only when established), absolute IAS (kt), energy excess (ft). */
  g10AltDevFt: number | null;
  g10IasKt: number | null;
  g10EnergyDevFt: number | null;
  /** FAF: height vs path (ft), IAS − Vapp (kt). */
  gfafAltDevFt: number | null;
  gfafIasDevKt: number | null;
  /** 1000 / 500 ft: height vs path (ft), IAS − Vapp (kt), lateral y (m, + = right), V/S (fpm), no failed criterion (null = not reached). */
  g1000AltDevFt: number | null;
  g1000IasDevKt: number | null;
  g1000LatDevM: number | null;
  g1000VsFpm: number | null;
  g1000Pass: boolean | null;
  g500AltDevFt: number | null;
  g500IasDevKt: number | null;
  g500LatDevM: number | null;
  g500VsFpm: number | null;
  g500Pass: boolean | null;
  gpRmsFt: number | null;
  latRmsM: number | null;
  iasMadKt: number | null;
  vsSdFpm: number | null;
  /** Go-around only, ft HAT. */
  gaLowestHatFt: number | null;
  /** Raw JSON of the detail (the fields below are parsed from it). */
  detailJson: string | null;
  band: ApproachBand | null;
  elevationSource: ElevationSource | null;
  /** Distinct criteria exceeded 1000 → 50 ft. */
  exceeded: ApproachCriterionKind[];
  exceedancesBelow500: number;
  vappPlausible: boolean | null;
  /** Height over the threshold, ft (landings with a runway). */
  thresholdHeightFt: number | null;
  goAroundDetectedBy: GoAroundSource | null;
  /** Where the runway geometry comes from (null: no runway, or cached before v3). */
  runwaySource?: RunwayGeometrySource | null;
  aircraftIcaoType: string | null;
  aircraftTitle: string | null;
  registration: string | null;
  provider: string | null;
}

export interface ApproachFactsResult {
  /** Newest first (within a flight the later approach first). */
  facts: ApproachFact[];
  /** Completed flights without any assessable approach (no track / no touchdown or go-around). */
  skipped: number;
}
