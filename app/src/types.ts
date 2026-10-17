// Mirrors the serde shapes in crates/vectasim-core (camelCase).

export interface Lights {
  beacon: boolean;
  nav: boolean;
  strobe: boolean;
  landing: boolean;
  taxi: boolean;
}

export interface Telemetry {
  timestampMs: number;
  simZuluTimeS: number;
  latitude: number;
  longitude: number;
  altitudeMslFt: number;
  altitudeAglFt: number;
  iasKt: number;
  tasKt: number;
  groundSpeedKt: number;
  verticalSpeedFpm: number;
  headingMagDeg: number;
  headingTrueDeg: number;
  pitchDeg: number;
  bankDeg: number;
  gForce: number;
  onGround: boolean;
  touchdownVsFpm: number;
  gearPct: number;
  flapsIndex: number;
  numEngines: number;
  enginesRunning: number;
  fuelTotalKg: number;
  totalWeightKg: number;
  parkingBrake: boolean;
  simRate: number;
  paused: boolean;
  slew: boolean;
  lights: Lights;
  transponderCode: number;
}

export interface AircraftInfo {
  title: string;
  atcModel: string;
  atcType: string;
  atcId: string;
  atcAirline: string;
  atcFlightNumber: string;
}

export type SimEvent =
  | { kind: "paused"; paused: boolean }
  | { kind: "simRunning"; running: boolean }
  | { kind: "crashed" }
  | { kind: "aircraftLoaded"; path: string }
  | { kind: "flightLoaded"; path: string };

export type FlightPhase =
  | "preflight"
  | "pushback"
  | "taxiOut"
  | "takeoff"
  | "climb"
  | "cruise"
  | "descent"
  | "approach"
  | "final"
  | "landing"
  | "taxiIn"
  | "shutdown";

export interface TouchdownReport {
  timestampMs: number;
  vsFpmMeasured: number;
  vsFpmSim: number;
  vsFpmHardest: number;
  peakG: number;
  pitchDeg: number;
  bankDeg: number;
  groundSpeedKt: number;
  headingTrueDeg: number;
  latitude: number;
  longitude: number;
  bounces: number;
  touchAndGo: boolean;
  /** Headline landing rate of the event: worst contact, sim value preferred (touchdown.rs). */
  landingRateFpm: number;
  landingRateSource: "sim" | "measured";
}

export interface IntegrityFlags {
  pausedMs: number;
  pauseCount: number;
  slewDetected: boolean;
  timeAccelerationDetected: boolean;
  maxSimRate: number;
  crashed: boolean;
  fuelIncreasedAirborne: boolean;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface FlightSummary {
  state: "idle" | "active" | "completed";
  phase: FlightPhase;
  offBlockMs?: number | null;
  takeoffMs?: number | null;
  landingMs?: number | null;
  onBlockMs?: number | null;
  departure?: GeoPoint | null;
  arrival?: GeoPoint | null;
  maxAltitudeMslFt: number;
  distanceNm: number;
  fuelStartKg?: number | null;
  fuelEndKg?: number | null;
  touchdowns: TouchdownReport[];
  /** Headline rate of the last full-stop touchdown (touch-and-goes excluded). */
  landingRateFpm?: number | null;
  integrity: IntegrityFlags;
}

export interface PhaseTransition {
  from: FlightPhase;
  to: FlightPhase;
  timestampMs: number;
  telemetry: Telemetry;
}

export type FlightEvent =
  | { kind: "flightStarted"; timestampMs: number }
  | ({ kind: "phaseChanged" } & PhaseTransition)
  | ({ kind: "touchdown" } & TouchdownReport)
  | { kind: "flightEnded"; timestampMs: number };

export interface StatusSnapshot {
  provider: string;
  state: "idle" | "connecting" | "connected" | "disconnected" | "error";
  detail: string;
  simName?: string | null;
  simVersion?: string | null;
  aircraft?: AircraftInfo | null;
  lastTelemetry?: Telemetry | null;
  flight?: FlightSummary | null;
  frames: number;
}

export interface Stats {
  frames: number;
  rateHz: number;
}

// ---- logbook (crates/vectasim-store) ----

export interface TrackSample {
  tMs: number;
  latitude: number;
  longitude: number;
  altitudeMslFt: number;
  altitudeAglFt: number;
  groundSpeedKt: number;
  iasKt: number;
  verticalSpeedFpm: number;
  headingTrueDeg: number;
  pitchDeg: number;
  bankDeg: number;
  gForce: number;
  onGround: boolean;
  flapsIndex: number;
  gearPct: number;
  fuelTotalKg: number;
}

export interface FlightRow {
  id: string;
  state: "active" | "completed" | "interrupted" | string;
  phase: FlightPhase;
  createdMs: number;
  updatedMs: number;
  offBlockMs?: number | null;
  takeoffMs?: number | null;
  landingMs?: number | null;
  onBlockMs?: number | null;
  depLat?: number | null;
  depLon?: number | null;
  arrLat?: number | null;
  arrLon?: number | null;
  maxAltMslFt: number;
  distanceNm: number;
  fuelStartKg?: number | null;
  fuelEndKg?: number | null;
  aircraft: AircraftInfo;
  provider?: string | null;
  simName?: string | null;
  depIcao?: string | null;
  arrIcao?: string | null;
  callsign?: string | null;
  plannedDep?: string | null;
  plannedArr?: string | null;
  plannedBlockS?: number | null;
  plannedFuelRampKg?: number | null;
  plannedFuelLandingKg?: number | null;
  hasOfp: boolean;
  integrity: IntegrityFlags;
  landingVsFpm?: number | null;
  landingCount: number;
  /** Raw METAR captured at off-block / at the landing (ms = when captured). */
  depMetar?: string | null;
  depMetarMs?: number | null;
  arrMetar?: string | null;
  arrMetarMs?: number | null;
  /** Registration of the airframe the flight is booked onto. */
  airframeReg?: string | null;
}

export interface PhaseEventRow {
  from: FlightPhase;
  to: FlightPhase;
  timestampMs: number;
}

export interface FlightDetail {
  flight: FlightRow;
  touchdowns: TouchdownReport[];
  phases: PhaseEventRow[];
  hasTrack: boolean;
  ofpJson?: string | null;
}

export interface Totals {
  flights: number;
  completed: number;
  blockTimeMs: number;
  flightTimeMs: number;
  distanceNm: number;
  landings: number;
  avgLandingVsFpm?: number | null;
}

// ---- airports (crates/vectasim-data) ----

export interface Airport {
  ident: string;
  kind: "large" | "medium" | "small" | "seaplane_base" | string;
  name: string;
  latitude: number;
  longitude: number;
  elevationFt?: number | null;
  country: string;
  municipality: string;
  iata: string;
}

export interface NearestAirport {
  airport: Airport;
  distanceNm: number;
}

export interface Runway {
  airport: string;
  lengthFt?: number | null;
  widthFt?: number | null;
  surface: string;
  leIdent: string;
  leLatitude?: number | null;
  leLongitude?: number | null;
  leHeadingDeg?: number | null;
  heIdent: string;
  heLatitude?: number | null;
  heLongitude?: number | null;
  heHeadingDeg?: number | null;
}

// ---- dispatch / SimBrief (crates/vectasim-simbrief) ----

export interface NavFix {
  ident: string;
  name: string;
  kind: string;
  latitude: number;
  longitude: number;
  altitudeFt: number;
  viaAirway: string;
  isSidStar: boolean;
  stage: string;
  distanceNm: number;
  timeTotalS: number;
  fuelRemainingKg: number;
}

export interface Ofp {
  requestId: string;
  generatedAtS: number;
  airac: string;
  sourceUnits: string;
  airlineIcao: string;
  flightNumber: string;
  callsign: string;
  originIcao: string;
  originName: string;
  originRunway: string;
  destinationIcao: string;
  destinationName: string;
  destinationRunway: string;
  alternateIcao: string;
  alternateName: string;
  aircraftIcao: string;
  aircraftName: string;
  registration: string;
  route: string;
  cruiseAltitudeFt: number;
  routeDistanceNm: number;
  greatCircleDistanceNm: number;
  costIndex: string;
  passengers: number;
  times: {
    schedOutS: number;
    schedOffS: number;
    schedOnS: number;
    schedInS: number;
    estOutS: number;
    estOffS: number;
    estOnS: number;
    estInS: number;
    blockS: number;
    enrouteS: number;
    taxiOutS: number;
    taxiInS: number;
    enduranceS: number;
  };
  fuel: {
    taxiKg: number;
    tripKg: number;
    contingencyKg: number;
    alternateKg: number;
    reserveKg: number;
    extraKg: number;
    minTakeoffKg: number;
    planTakeoffKg: number;
    planRampKg: number;
    planLandingKg: number;
  };
  weights: {
    oewKg: number;
    payloadKg: number;
    cargoKg: number;
    paxCount: number;
    estZfwKg: number;
    maxZfwKg: number;
    estTowKg: number;
    maxTowKg: number;
    estLdwKg: number;
    maxLdwKg: number;
    estRampKg: number;
  };
  navlog: NavFix[];
}

// ---- online networks & weather (crates/vectasim-online, app/src-tauri/src/online.rs) ----

export interface Pilot {
  cid: number;
  callsign: string;
  latitude: number;
  longitude: number;
  altitudeFt: number;
  groundSpeedKt: number;
  headingDeg: number;
  transponder: string;
  aircraftShort: string;
  departure: string;
  arrival: string;
  route: string;
  flightRules: string;
}

export type Facility = "fss" | "del" | "gnd" | "twr" | "app" | "ctr" | "atis";

export interface Controller {
  cid: number;
  callsign: string;
  frequency: string;
  facility: Facility;
  visualRangeNm: number;
  textAtis: string[];
  atisCode?: string | null;
}

export interface LocatedController extends Controller {
  airport: string;
  latitude: number;
  longitude: number;
}

export interface OnlineSummary {
  network: "vatsim";
  enabled: boolean;
  pilots: number;
  controllers: number;
  atis: number;
  prefiles: number;
  updateTimestamp?: string | null;
  fetchedMs?: number | null;
  lastError?: string | null;
  consecutiveErrors: number;
  nextPollS: number;
}

export interface OnlineView {
  pilots: Pilot[];
  pilotsTruncated: boolean;
  controllers: LocatedController[];
  enroute: Controller[];
  summary: OnlineSummary;
}

export type FlightCategory = "VFR" | "MVFR" | "IFR" | "LIFR" | "UNKNOWN";

export interface Wind {
  directionDeg?: number | null;
  speedKt: number;
  gustKt?: number | null;
  variableFromDeg?: number | null;
  variableToDeg?: number | null;
}

export interface Metar {
  station: string;
  raw: string;
  time?: string | null;
  wind?: Wind | null;
  visibilityM?: number | null;
  cavok: boolean;
  ceilingFt?: number | null;
  qnhHpa?: number | null;
  altimeterInhg?: number | null;
  temperatureC?: number | null;
  dewpointC?: number | null;
  category: FlightCategory;
  source: string;
}

/** One aircraft by registration (store `airframes`). */
export interface Airframe {
  registration: string;
  icaoType?: string | null;
  title?: string | null;
  airline?: string | null;
  customName?: string | null;
  notes?: string | null;
  imageUrl?: string | null;
  imageThumbUrl?: string | null;
  /** Photographer (Planespotters) or "Eigenes Bild". */
  imageCredit?: string | null;
  imageLink?: string | null;
  /** planespotters | user | none (looked up, nothing found) */
  imageSource?: string | null;
  imageFetchedMs?: number | null;
  createdMs: number;
  updatedMs: number;
}

/** Airframe with logbook aggregates (list_airframes). */
export interface AirframeRow extends Airframe {
  flights: number;
  totalFlights: number;
  blockTimeMs: number;
  flightTimeMs: number;
  distanceNm: number;
  landings: number;
  avgLandingVsFpm?: number | null;
  lastFlownMs?: number | null;
}

export interface AirframeEdit {
  registration: string;
  icaoType?: string | null;
  title?: string | null;
  airline?: string | null;
  customName?: string | null;
  notes?: string | null;
}
