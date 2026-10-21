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
  // approach data (track v2, SimConnect APPROACH 1 Hz / DESIGN once); absent = not delivered
  windDirTrueDeg?: number;
  windKt?: number;
  navHasLocalizer?: boolean;
  navHasGlideSlope?: boolean;
  navGsFlag?: boolean;
  /** Only while the station has a glideslope. */
  navGsErrorDeg?: number;
  navGsAngleDeg?: number;
  /** Raw needle ±127, only while the station has a localizer. */
  navCdi?: number;
  navRadialErrorDeg?: number;
  navLocCourseDeg?: number;
  autopilotMaster?: boolean;
  autopilotApproachHold?: boolean;
  autopilotGlideslopeHold?: boolean;
  autothrottleActive?: boolean;
  n1Pct?: number;
  throttleLeverPct?: number;
  spoilersHandlePct?: number;
  spoilersArmed?: boolean;
  spoilersPct?: number;
  alphaDeg?: number;
  flapPositions?: number;
  designVs0Kt?: number;
  designVs1Kt?: number;
  designVcKt?: number;
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
  /** `unrated`: slewed / fast-forwarded down, no airborne sample – `landingRateFpm` is no landing rate. */
  landingRateSource: LandingRateSource;
}

/** Where a touchdown's headline rate comes from (touchdown.rs LandingRateSource). */
export type LandingRateSource = "sim" | "measured" | "unrated";

export interface IntegrityFlags {
  pausedMs: number;
  pauseCount: number;
  slewDetected: boolean;
  timeAccelerationDetected: boolean;
  maxSimRate: number;
  crashed: boolean;
  fuelIncreasedAirborne: boolean;
  /** Position jump (flight reload, teleport, slew) – distance is not integrated over it. */
  teleportDetected?: boolean;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/**
 * State of a flight (core flight.rs FlightState). `discarded`: a ground session that never took
 * off (no take-off, no touchdown) – kept in the Papierkorb, never counted in statistics.
 */
export type FlightState = "idle" | "active" | "completed" | "interrupted" | "discarded";

export interface FlightSummary {
  state: FlightState;
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
  /** G-load in the air outside the touchdowns (the last 3 s are held back). */
  gLoad?: GLoadStats | null;
}

/** `vectasim_core::gload::GLoadPoint`: one extreme (0.3 s moving average). */
export interface GLoadPoint {
  g: number;
  timestampMs: number;
  phase: FlightPhase;
  altitudeMslFt: number;
}

/** `vectasim_core::gload::GLoadStats`: g-load over the whole flight, touchdowns excluded. */
export interface GLoadStats {
  max?: GLoadPoint | null;
  min?: GLoadPoint | null;
  /** Excursions above 1.5 g / below 0.5 g of at least 0.5 s. */
  highCount: number;
  lowCount: number;
  /** live: recorded; track: derived afterwards from the 1 Hz track. */
  source: "live" | "track";
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
  | { kind: "flightEnded"; timestampMs: number; interrupted?: boolean }
  /**
   * The `flightEnded` with the same `timestampMs` ended a ground session (core flight.rs
   * FlightDiscardedEvent): it never took off, is stored as `discarded` in the Papierkorb and
   * does not count. `shutDown`: it reached Shutdown rather than being cut off.
   */
  | { kind: "flightDiscarded"; timestampMs: number; offBlockMs: number | null; shutDown: boolean }
  /**
   * Decided outcome of an earlier `touchdown` (core flight.rs TouchdownOutcomeEvent): after the
   * rollout (< 30 kt), the climb-out, a 120 s timeout, or `unknown` when the stream broke off.
   * `index` is the touchdown's index in `FlightSummary.touchdowns`, `touchdownMs` its first contact.
   */
  | { kind: "touchdownOutcome"; index: number; outcome: "fullStop" | "touchAndGo" | "unknown"; timestampMs: number; touchdownMs: number };

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
  // track v2 (absent in older tracks)
  tasKt?: number;
  headingMagDeg?: number;
  windDirTrueDeg?: number;
  windKt?: number;
  gsErrorDeg?: number;
  locCdi?: number;
  locErrorDeg?: number;
  ilsGsAngleDeg?: number;
  ilsCourseDeg?: number;
  navFlags?: number;
  n1Pct?: number;
  spoilersPct?: number;
  spoilersHandlePct?: number;
  alphaDeg?: number;
  flapPositions?: number;
  designVs0Kt?: number;
  designVs1Kt?: number;
}

export interface FlightRow {
  id: string;
  state: Exclude<FlightState, "idle"> | (string & {});
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
  /** G-load over the flight (schema v16); null/absent = not measured. */
  gLoad?: GLoadStats | null;
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
  /** Displaced threshold per end, ft from that end (OurAirports). */
  leDisplacedThresholdFt?: number | null;
  heDisplacedThresholdFt?: number | null;
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

/** Online network of a pilot, controller or feed. */
export type Network = "vatsim" | "ivao";

export interface Pilot {
  network: Network;
  /** VATSIM CID or IVAO VID – unique only together with `network`. */
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
  /** IVAO only. */
  onGround?: boolean;
  /** Real name, VATSIM only and only from `online_pilot` (the map's bulk query drops it). */
  name?: string;
  /** Session start, ISO 8601 UTC (VATSIM `logon_time`, IVAO `createdAt`). */
  logonTime?: string;
  /** Filed cruise level as written: "36000" (VATSIM), "F340" / "A045" / "VFR" (IVAO). */
  plannedAltitude?: string;
  /** Flight-plan remarks ("PBN/A1B1 REG/DAINA"), only from `online_pilot`. */
  remarks?: string;
  /** Model in words when the feed has it (IVAO "A320neo"). */
  aircraftModel?: string;
}

/** `traffic_photo`: Planespotters photo of an online-traffic aircraft (session cache, not the logbook). */
export interface TrafficPhoto {
  registration: string;
  status: "found" | "none" | "off" | "error";
  url: string | null;
  thumbUrl: string | null;
  photographer: string | null;
  link: string | null;
}

export type Facility = "fss" | "del" | "gnd" | "twr" | "app" | "ctr" | "atis";

export interface Controller {
  network: Network;
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

/** One network's feed (app/src-tauri/src/online.rs NetworkStatus). */
export interface NetworkStatus {
  network: Network;
  /** "VATSIM" / "IVAO". */
  label: string;
  enabled: boolean;
  pilots: number;
  controllers: number;
  atis: number;
  prefiles: number;
  updateTimestamp?: string | null;
  fetchedMs?: number | null;
  /** URL of the last download. */
  source?: string | null;
  /** Seconds since the last successful download. */
  ageS?: number | null;
  lastError?: string | null;
  consecutiveErrors: number;
  nextPollS: number;
}

/** Totals over the enabled networks (shape of the former VATSIM-only status) plus `networks`. */
export interface OnlineSummary {
  network: "off" | Network | "both";
  enabled: boolean;
  pilots: number;
  controllers: number;
  atis: number;
  prefiles: number;
  updateTimestamp?: string | null;
  fetchedMs?: number | null;
  /** First error among the enabled networks, prefixed with its name ("IVAO: …"). */
  lastError?: string | null;
  consecutiveErrors: number;
  nextPollS: number;
  /** Optional for summaries from older builds / tests. */
  networks?: NetworkStatus[];
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
  /** Pilot's approach speed for this airframe, KIAS; the approach and landing assessment use it as reference. */
  vappKt?: number | null;
  /** Pilot's landing flap handle index (e.g. 3 = CONF 3 on an A320); null = the last handle position. */
  landingFlaps?: number | null;
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
  /** Vapp in kt; 0 clears it, omitted leaves it unchanged. */
  vappKt?: number | null;
  /** Landing flap handle index 0…10; −1 clears it, omitted leaves it unchanged. */
  landingFlaps?: number | null;
}

/** One evaluated landing for the dispersion view (landing_facts_recent, app/src-tauri/src/landing.rs). */
export interface LandingFact {
  flightId: string;
  /** Index within the flight's touchdowns, as openDebrief / landing_analysis take it. */
  touchdownIndex: number;
  timestampMs: number;
  airportIcao: string;
  runwayIdent: string;
  aircraftIcaoType?: string | null;
  aircraftTitle?: string | null;
  registration?: string | null;
  /** Headline landing rate, fpm, negative = descending. */
  landingRateFpm: number;
  landingRateSource: LandingRateSource;
  peakG: number;
  bounces: number;
  /** Metres along the runway from the threshold (negative = before it). */
  touchdownDistanceM: number;
  /** Metres from the centreline in landing direction: negative = left, positive = right. */
  centerlineOffsetM: number;
  inTouchdownZone: boolean;
  provider?: string | null;
}

export interface LandingFactsResult {
  /** Newest first. */
  facts: LandingFact[];
  /** Landings left out because no runway matched. */
  skipped: number;
}

// ---- Diagnostics → Live raw data (`diagnostics_snapshot`, event `diag:raw`) ----

export interface VarDiag {
  name: string;
  unit?: string | null;
  /** false once the sim rejected the SimVar (dropped from its definition). */
  active: boolean;
  /** FLOAT64 as received (null = NaN / never received). */
  raw?: number | null;
  rawText?: string | null;
  /** Value VectaSim uses after conversion, in `valueUnit`. */
  value?: number | null;
  valueText?: string | null;
  valueUnit: string;
}

export interface DefDiag {
  /** FAST / SLOW / STATIC */
  label: string;
  req: number;
  period: string;
  vars: VarDiag[];
  updates: number;
  lastWallMs?: number | null;
  ageMs?: number | null;
  rateHz: number;
}

export interface DiagEvent {
  wallMs: number;
  /** event | filename | exception | open | quit | hr | systemState | end | warning */
  kind: string;
  name: string;
  dataHex?: string | null;
  detail: string;
}

export interface HrDiag {
  wallMs: number;
  call: string;
  hr: string;
}

export interface ConnDiag {
  dll?: string | null;
  simName?: string | null;
  simVersion?: string | null;
  simconnectVersion?: string | null;
  sessions: number;
  reconnects: number;
  connectedWallMs?: number | null;
  simState?: number | null;
  lastHresults: HrDiag[];
}

export interface RawDiag {
  source: string;
  defs: DefDiag[];
  events: DiagEvent[];
  eventsTotal: number;
  connection: ConnDiag;
}

export interface CandidateDebug {
  phase: FlightPhase;
  sinceMs: number;
  dwellMs: number;
  remainingMs: number;
}

export interface DetectorDebug {
  /** ground | airborne | settling */
  state: string;
  airborneSinceMs?: number | null;
  qualified: boolean;
  qualifyMs: number;
  groundSamples: number;
  confirmed: boolean;
  bounces: number;
  airborneNow: boolean;
  staleSim?: number | null;
  lastAirSim: number;
}

export interface FlightDebug {
  phase: FlightPhase;
  state: string;
  candidate?: CandidateDebug | null;
  airborneQualified: boolean;
  /** Wall-clock jumps backwards that the monotonic clock absorbed (see core clock.rs). */
  clockJumps?: number;
  airborneSinceMs?: number | null;
  lastSkip?: string | null;
  detector: DetectorDebug;
  simStopped: boolean;
  eventPaused: boolean;
  resumedAirborne: boolean;
  pauseStartedMs?: number | null;
  lastSampleMs?: number | null;
  touchdowns: number;
  /** Index of the touchdown whose outcome (full stop / touch-and-go) is still open. */
  pendingTouchdown?: number | null;
}

export interface DumpStatus {
  enabled: boolean;
  file?: string | null;
  fileBytes: number;
  ringSeconds: number;
  ringBytes: number;
  ringLines: number;
  lastError?: string | null;
}

export interface DiagSnapshot {
  atMs: number;
  provider: string;
  state: string;
  raw?: RawDiag | null;
  engine?: FlightDebug | null;
  dump: DumpStatus;
}

export interface DumpInfo {
  enabled: boolean;
  /** Debug-Modus on: the dump runs whatever `enabled` says. */
  debugMode?: boolean;
  dir: string;
  status: DumpStatus;
}

export interface ReplaySettings {
  path?: string | null;
  /** 0 = as fast as possible */
  speed: number;
  repeat: boolean;
}

/** `get_log_level`: the setting, a `RUST_LOG` override and whether the Debug-Modus raises it. */
export interface LogLevelInfo {
  level: string;
  envOverride?: string | null;
  debugMode?: boolean;
}

/** `get_debug_mode` / `set_debug_mode` (Settings → Diagnostics → Debug mode). */
export interface DebugModeInfo {
  on: boolean;
  log: LogLevelInfo;
  dump: DumpInfo;
}

/** `create_diag_package`: the ZIP written. */
export interface DiagPackageInfo {
  path: string;
  bytes: number;
  files: string[];
}

/** A flight in the Papierkorb (`list_deleted_flights`). */
export interface DeletedFlight {
  flight: FlightRow;
  deletedMs: number;
}

/** One backup file (`get_backup_info`, `create_backup`). */
export interface BackupEntry {
  path: string;
  fileName: string;
  kind: "regular" | "preMigration" | "preUpdate" | "preRestore" | "preWipe" | "preImport" | string;
  /** Schema version before the migration (pre-migration copies). */
  schemaFrom?: number | null;
  /** From the file name, epoch ms. */
  createdMs: number;
  bytes: number;
}

/** Settings → Data (`get_backup_info`, `set_backup_dir`). */
export interface BackupInfo {
  dbPath: string;
  dbBytes: number;
  /** Sync service / network share the database lies on (risky for SQLite/WAL). */
  dbSync?: string | null;
  dir: string;
  defaultDir: string;
  isDefault: boolean;
  /** Sync service the backup folder lies on (fine: off-site copy). */
  dirSync?: string | null;
  lastBackupMs?: number | null;
  /** Newest first. */
  backups: BackupEntry[];
  trashCount: number;
  trashDays: number;
  flightActive: boolean;
}

/** `delete_all_data`. */
export interface WipeResult {
  flights: number;
  backup: string;
}

/** `manifest.json` of a `.vectasim` file (`read_bundle_manifest`, `export_bundle`). */
export interface BundleManifest {
  format: number;
  app: string;
  appVersion: string;
  schemaVersion: number;
  createdMs: number;
  createdUtc: string;
  flights: number;
  /** Of `flights`, how many were in the Papierkorb. */
  flightsDeleted: number;
  tracks: number;
  airframes: number;
  images: number;
  trackEncoding: string;
}

/** `export_bundle`. */
export interface BundleExportReport {
  path: string;
  bytes: number;
  manifest: BundleManifest;
  warnings: string[];
}

/** `import_bundle`. */
export interface BundleImportReport {
  flightsInBundle: number;
  flightsAdded: number;
  /** Same id, or same route within 15 min of off-block. */
  flightsSkippedDuplicate: number;
  airframesAdded: number;
  /** Existing airframes that got empty fields or a picture. */
  airframesUpdated: number;
  imagesAdded: number;
  warnings: string[];
  /** Copy of the logbook made before „Ersetzen“. */
  backup?: string | null;
}

/** `flight_summary_counts`: logbook size and when it last changed. */
export interface FlightCounts {
  flights: number;
  deleted: number;
  lastUpdatedMs?: number | null;
  lastDeletedMs?: number | null;
}

// ---- after a crash: resume / merge (R3) ---------------------------------------------------
// Own block, additive only.

/** Time without recording inside a resumed / merged flight, ms (absent = 0). */
export interface IntegrityFlags {
  gapMs?: number;
}

/** `flight:resumable`: an interrupted flight the current position continues. */
export interface ResumeCandidate {
  flightId: string;
  dep?: string | null;
  /** Planned destination (OFP), if any. */
  arr?: string | null;
  callsign?: string | null;
  offBlockMs?: number | null;
  /** Time of the last recorded sample. */
  lastMs: number;
  /** From the last recorded position to the current one. */
  distanceNm: number;
  altDiffFt: number;
}

/** `list_merge_candidates`: an interrupted flight and the flight that seems to continue it. */
export interface MergeCandidate {
  first: FlightRow;
  second: FlightRow;
  gapMs: number;
  distanceNm: number;
}

/** `merge_flights`. */
export interface MergeReport {
  flightId: string;
  /** Now in the Papierkorb. */
  removedId: string;
  gapMs: number;
  distanceNm: number;
  sampleCount: number;
}

// ---- Streamer-Modus / Landekarte automatisch speichern (privacy.rs) --------------------

/** `get_card_dir` / `set_card_dir`: folder for automatically saved landing cards. */
export interface CardDirInfo {
  /** The folder in use. */
  dir: string;
  /** Bilder\VectaSim. */
  defaultDir: string;
  isDefault: boolean;
}

// ---- Notizen & Tags (schema v14, notes.rs) -----------------------------------------------

/** What the pilot added to a flight (merged into `FlightRow` above). */
export interface FlightRow {
  /** Own notes, plain text with line breaks (at most 2000 characters). */
  notes?: string | null;
  /** Own tags, normalised by the backend (trimmed, no case-insensitive duplicates, ≤ 20 × 30). */
  tags?: string[];
  /** Corrections shown instead of the recorded values (which stay as they are). */
  userCallsign?: string | null;
  userDepIcao?: string | null;
  userArrIcao?: string | null;
  userAircraftTitle?: string | null;
  userRegistration?: string | null;
  /** Personal rating of the flight 1–5 (not of the landing). */
  rating?: number | null;
}

/**
 * `update_flight_user(id, edit)`: every field left out stays as it is; `""` clears a text,
 * `[]` the tags, `0` the rating. A corrected registration re-books the flight onto that
 * airframe, clearing it books the flight back onto the recorded one.
 */
export interface FlightUserEdit {
  notes?: string;
  tags?: string[];
  callsign?: string;
  depIcao?: string;
  arrIcao?: string;
  aircraftTitle?: string;
  registration?: string;
  rating?: number;
}

/** `list_tags()`: a tag of the logbook with the number of flights carrying it (most used first). */
export interface TagCount {
  tag: string;
  count: number;
}

// ---- Integrationen (Discord, Benachrichtigungen, Tray) ----------------------------------

/** `discord_status()`: state of the Discord Rich Presence link. */
export interface DiscordStatus {
  /** off | no_app_id | not_running | connected */
  state: "off" | "no_app_id" | "not_running" | "connected" | "";
  /** "details · state" as Discord shows it, while connected. */
  showing?: string | null;
}

/** Kinds accepted by `notify(kind, title, body)`. */
export type NotifyKind = "landing" | "saved" | "connection" | "update" | "test";

/** `notify` / `notify_test`: whether a Windows notification was shown (not when the window is focused or the kind is off). */
export interface NotifyResult {
  shown: boolean;
}

// ---- CSV-Import (andere Logbücher) ------------------------------------------------------

/** Column layouts the CSV import recognises (`provider = "import:<preset>"`). */
export type CsvPreset = "vectasim" | "volanta_import" | "simtoolkitpro" | "generic";
export type CsvEncoding = "utf8" | "utf8_bom" | "utf16le" | "utf16be" | "latin1";
/** Flight fields a CSV column can be mapped onto. */
export type CsvField =
  | "date"
  | "off_block"
  | "takeoff"
  | "landing"
  | "on_block"
  | "dep_icao"
  | "arr_icao"
  | "callsign"
  | "flight_number"
  | "airline"
  | "aircraft_title"
  | "aircraft_icao"
  | "registration"
  | "distance_nm"
  | "max_alt_ft"
  | "fuel_start"
  | "fuel_end"
  | "fuel_used"
  | "block_min"
  | "air_min"
  | "landing_rate_fpm"
  | "notes"
  | "tags"
  | "rating";
export type CsvDateFormat = "auto" | "iso" | "dmy" | "mdy" | "epoch_s" | "epoch_ms";

/** From `fromMs` (UTC) on, local time is UTC + `offsetMin`. */
export interface CsvOffsetSpan {
  fromMs: number;
  offsetMin: number;
}

/** How the file is read and which column (0-based) fills which field. */
export interface CsvColumnMapping {
  preset: CsvPreset;
  delimiter?: string | null;
  hasHeader?: boolean | null;
  encoding?: CsvEncoding | null;
  columns: Partial<Record<CsvField, number>>;
  dateFormat: CsvDateFormat;
  /** Times without zone: UTC + this, unless `localOffsets` is set. */
  utcOffsetMin: number;
  localOffsets: CsvOffsetSpan[];
  weightUnit: "kg" | "lb";
  durationUnit: "minutes" | "hours";
}

/** `csv_sniff(path)`. */
export interface CsvProfile {
  delimiter: string;
  hasHeader: boolean;
  encoding: CsvEncoding;
  columns: string[];
  sampleRows: string[][];
  detectedPreset: CsvPreset;
  rowCount: number;
  suggested: CsvColumnMapping;
}

export interface CsvImportOptions {
  dedupe: boolean;
  sourceTag: string;
}

/** One row as `csv_preview` would import it. */
export interface CsvParsedFlight {
  line: number;
  depIcao?: string | null;
  arrIcao?: string | null;
  offBlockMs?: number | null;
  takeoffMs?: number | null;
  landingMs?: number | null;
  onBlockMs?: number | null;
  callsign?: string | null;
  flightNumber?: string | null;
  airline?: string | null;
  aircraftTitle?: string | null;
  aircraftIcao?: string | null;
  registration?: string | null;
  distanceNm?: number | null;
  distanceEstimated: boolean;
  maxAltFt?: number | null;
  fuelStartKg?: number | null;
  fuelEndKg?: number | null;
  fuelUsedKg?: number | null;
  blockMin?: number | null;
  airMin?: number | null;
  landingRateFpm?: number | null;
  notes?: string | null;
  tags: string[];
  rating?: number | null;
  warnings: string[];
  /** Why the row is not imported. */
  error?: string | null;
  duplicate: boolean;
}

/** `csv_preview`: first 20 rows, counts over the whole file. */
export interface CsvPreview {
  rows: CsvParsedFlight[];
  totalRows: number;
  valid: number;
  invalid: number;
  duplicates: number;
}

/** `csv_import`. */
export interface CsvImportReport {
  rows: number;
  added: number;
  skippedDuplicate: number;
  skippedInvalid: number;
  airframesAdded: number;
  warnings: string[];
}

// ---- SimConnect download (backend `simconnect_dl.rs`)

/** `simconnect_download_info` / `download_simconnect`. */
export interface SimConnectDownloadInfo {
  /** The downloaded DLL exists and matches the pinned hash. */
  installed: boolean;
  path: string | null;
  sdkVersion: string;
  downloadBytes: number;
  sourceUrl: string;
  eulaUrl: string;
  /** Set by `download_simconnect`: the SimConnect provider was restarted to pick the DLL up. */
  restarted: boolean;
}

/** Event `simconnect-download`. */
export interface SimConnectDownloadProgress {
  phase: "download" | "verify" | "extract" | "done";
  received: number;
  total: number;
}
