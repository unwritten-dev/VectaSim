//! `FlightSession` wires the phase engine and touchdown detector together and
//! keeps a running `FlightSummary` (times, positions, distance, fuel, integrity
//! flags). Persistence is the recorder's job.
//!
//! Discontinuities of the data stream (the session's "position context"):
//!
//! | trigger                                   | effect                                                        |
//! |-------------------------------------------|---------------------------------------------------------------|
//! | [`SimEvent::FlightLoaded`]                | open flight ends as interrupted, engine back to Preflight, reset |
//! | [`SimEvent::AircraftLoaded`]              | context reset only                                            |
//! | [`SimEvent::SimRunning`] `false`          | samples ignored until `true`, then context reset              |
//! | [`SimEvent::Paused`]                      | samples count as paused until unpaused, even without telemetry |
//! | reconnect (caller: [`FlightSession::reset_position_context`]) | context reset, flight stays open           |
//! | teleport (see below)                      | context reset, `teleport_detected`, no distance over the jump |
//! | provider stopped (caller: [`FlightSession::interrupt`]) | open flight ends as interrupted                  |
//!
//! A context reset drops the phase engine's dwell timers and airborne latch, the touchdown
//! detector's ring buffer and `qualified` latch, the distance/fuel reference points; the
//! phase and an open flight are kept. The first ground contact after a reset is therefore
//! never a landing. If the reset happened in an airborne phase and the aircraft is on the
//! ground before it requalified (10 s of air time or > 500 ft AGL), the position cannot be
//! continued (sim restarted at a gate, reload on the runway): the flight ends as interrupted.
//!
//! Continuity across a reset in the air (reconnect, `AircraftLoaded`, `SimRunning`
//! false → true): the first sample after the reset is compared with the last one before it.
//! If it is where the aircraft could have got to in the meantime – no position jump by the
//! teleport rule below, and AGL and MSL altitude within twice what the last V/S (at least
//! 1 000 fpm) covers in the gap, plus 100 ft – the stream only had a hole: phase engine and
//! touchdown detector are requalified at once ([`PhaseEngine::restore_qualified`]) and the
//! next ground contact is a landing. Why: up to 0.5.0 every such reset demanded 10 s of fresh
//! air time, so a SimConnect hiccup or the MSFS ESC menu on short final (below ~120 ft at
//! 700 fpm) ended the flight as interrupted, lost its landing and started a ghost flight from
//! the rollout.
//!
//! The comparison is bounded, because its tolerances grow with the gap (after 10 min on the
//! approach they were ±20 000 ft and 71 nm, so a sim restarted at the destination gate passed
//! and the flight was "completed" with a landing at the reconnect time):
//! - only holes up to [`RESUME_MAX_GAP_MS`] (60 s) are compared with the gap's tolerances;
//! - a longer one only counts as a hole when the sim clock stood still across it (ESC menu,
//!   pause) and the aircraft is still where it was (the tolerances of a zero gap: 1 nm, 100 ft);
//! - never when the last sample before the reset was airborne and the first one after it is
//!   on the ground below [`RESUME_PARKED_KT`] (5 kt): parked is a restart, whatever the gap
//!   (the session has no airport data; a landing aircraft is never at 5 kt the moment it
//!   touches down).
//!
//! Otherwise the old rule applies: requalify on 10 s of air time, and a ground contact before
//! that ends the flight as interrupted (the app then offers to resume it). A teleport detected
//! between two samples never takes the continuity path. A hole the stream was away for (sim
//! clock running, longer than 5 s) goes into `integrity.gap_ms`; it is not flown time the
//! recording saw (the flight time itself is still take-off to landing). The rate of a landing
//! right after the hole comes from the samples after it or the sim's own value; after a hole of
//! at most 10 s (or a frozen sim) the V/S of the last sample before it is the measured
//! fallback ([`TouchdownDetector::restore_qualified`]); else the touchdown is unrated (see
//! [`crate::touchdown`]).
//!
//! A reset in the Takeoff phase counts as a reset in the air when the last sample before it
//! was airborne (initial climb before Climb): same continuity check, same interruption on a
//! ground contact elsewhere, and the take-off time stays the lift-off before the reset.
//!
//! Ground sessions are no flights ([`FlightState::Discarded`]): a recording that ends without
//! the aircraft ever having flown – airborne qualified (> 500 ft AGL, 60 s, or 5 s above 50 ft),
//! a confirmed lift-off out of the Takeoff phase ([`PhaseEngine::lifted_off`]: a hop out of the
//! take-off roll that stayed below 50 ft for 10 s; it lands with take-off and landing time), a
//! take-off time, a touchdown or a start in the air that moved (see below) – is discarded instead
//! of `Completed` / `Interrupted`. Only out of the Takeoff phase: a hover below 50 ft that never
//! got there (Takeoff needs > 40 kt or > 50 ft AGL, e.g. a helicopter at 20 ft over the pad)
//! stays a ground session.
//! That covers taxiing around and shutting down again, a provider stop on the ground, and the
//! "scenery test": a flight loaded at airport A (taxied a bit, so it started), then a new flight
//! loaded at airport B. Up to 0.5.0 that was stitched into one flight A → B. Now the A part ends
//! as discarded and the recording starts over at B (ground → Preflight, air → the start-in-
//! the-air phase without a take-off), when
//! - [`SimEvent::FlightLoaded`] arrives (always a new flight, see above), or
//! - the position jumps by the teleport rule below, or
//! - the first sample after another context reset ([`SimEvent::AircraftLoaded`],
//!   [`SimEvent::SimRunning`] false → true, reconnect) is not where the aircraft was (the
//!   continuity check below). These events alone do not discard: the MSFS ESC menu and an
//!   aircraft change in place leave the position as it was, and the taxi goes on.
//!
//! Without an open flight (idle, or after a completed one) the same jumps restart the phase
//! engine, so an aircraft loaded in the air at B starts in the air instead of "taking off"
//! from the ground phase it had at A. A flight that has flown keeps today's rules: a jump in
//! the air sets `teleport_detected`, `FlightLoaded` interrupts it.
//!
//! Discarding emits the usual [`FlightEvent::FlightEnded`] (`interrupted: true` for an abort,
//! `false` at Shutdown, so a consumer that does not know discards keeps it as before), the
//! summary's state is [`FlightState::Discarded`], and a [`FlightDiscardedEvent`] with the same
//! `timestamp_ms` goes out through [`FlightSession::take_discarded_flights`] – take it after
//! every call that can end a flight. The recorder should act on that event (the summary may
//! already be the next flight's when the new one starts in the same sample).
//!
//! Start in the air (the first sample after connecting or after [`SimEvent::FlightLoaded`]
//! is airborne, see [`crate::phase`]): a legitimate flight, recorded from that point on. It
//! starts like any other ([`FlightEvent::FlightStarted`]); `off_block_ms` and `departure` are
//! the start of the recording (block time from there; the recorder resolves the departure
//! airport within its usual radius, else none), `takeoff_ms` stays empty (no lift-off seen,
//! so no flight time), and the touchdown detector requalifies after a short stretch of air
//! time like after a reset in the air. No teleport flag – nothing jumped. Such a flight counts
//! as flown once it has moved like an aircraft for [`MS_AIRBORNE_START_MOVING`] (3 s at more than
//! 30 kt GS or 100 fpm V/S; or with a touchdown), not on the first sample: being high up is no
//! proof (its air time and height qualify the Landing gate, not "flown"). A start in the air
//! that never moved before the next `FlightLoaded` is discarded like a ground session.
//!
//! Placeholder positions ([`Telemetry::placeholder_position`], within 0.01° of 0° N / 0° E):
//! MSFS reports one for several seconds while it loads a flight. Such samples are ignored
//! completely – no phase, no flight, no distance, and they are no reference for the teleport
//! and continuity checks either.
//!
//! A push held on the parking brake ([`PhaseEngine::push_held`]: Pushback → Preflight, engines
//! not started yet) keeps the flight open: the next "leaving the blocks" continues it with its
//! original off-block instead of starting a new one. A push given up (15 min more parked like
//! that, Preflight → Shutdown) ends it as a ground session.
//!
//! Thresholds:
//! - teleport: position jump between two samples > `GS·Δt·rate·3 + 1 nm` (GS = the larger of
//!   both samples, rate = the larger sim rate of both, at least 1: at 16× time acceleration the
//!   aircraft covers 16 times the distance per wall-clock second), or altitude change > 5 000 ft/s;
//! - pause without telemetry: a gap Δt > 5 s between two samples during which the sim
//!   clock advanced by less than a quarter of Δt counts as a pause of Δt (dwell timers and
//!   air time are shifted by it, `pause_count`/`paused_ms` are updated).
//!
//! Time base ([`crate::clock`]): the summary and every event carry wall-clock timestamps
//! (`Telemetry::timestamp_ms`), but gaps, pauses and the distance integration run on a
//! monotonic clock, like the phase engine's dwells and the touchdown detector's windows. A
//! backward step of the system clock is a `clock_jump` (logged, counted in the debug state)
//! and counts as Δt = 0. Time acceleration is handled alike in both components: samples with
//! a sim rate ≠ 1 are skipped by the phase engine *and* the touchdown detector (and set
//! `time_acceleration_detected`); a landing made in fast-forward shows up in both at the
//! first real-time ground sample (see [`crate::touchdown`]).
//!
//! Touchdowns and their outcome (decided after the rollout): [`FlightEvent::Touchdown`] comes as soon
//! as the detector has the landing rate (end of the bounce window), so toast and recorder get
//! it right away. Whether it was a full stop or a touch-and-go is decided later (rollout
//! below 30 kt, climb-out, 120 s timeout, or `Unknown` after a reset) and handed out as a
//! [`TouchdownOutcomeEvent`] through [`FlightSession::take_touchdown_outcomes`] – a separate
//! queue rather than a new `FlightEvent` variant, so consumers matching `FlightEvent`
//! exhaustively keep compiling. Every touchdown gets exactly one outcome event.
//!
//! | summary field                 | set when                                                     |
//! |-------------------------------|--------------------------------------------------------------|
//! | `touchdowns[i]`               | at the report; `touch_and_go` corrected in place by the outcome |
//! | `landing_rate_fpm`            | outcome `FullStop` or `Unknown` (never provisional); `None` when that touchdown is unrated (slewed / fast-forwarded down, see [`crate::touchdown`]) |
//! | `landing_ms`                  | outcome `FullStop` (= the touchdown's first contact); fallback: Landing → TaxiIn without a pending touchdown (detector had none, or `Unknown`) takes the Landing transition time |
//! | `arrival`                     | Landing transition (as before; a later landing overwrites it) |
//!
//! `landing_ms` and `landing_rate_fpm` are only ever set to final values, never set
//! provisionally and taken back on a touch-and-go: the live UI and the recorder see the
//! previous value (or none) for the 10–30 s of the rollout instead of a value that flickers.

use crate::clock::MonoClock;
use crate::gload::{GLoadStats, GLoadTracker, GSample};
use crate::phase::{FlightPhase, PhaseEngine, PhaseTransition, SkipReason};
use crate::touchdown::{DetectorDebug, TouchdownDetector, TouchdownOutcome, TouchdownReport, ground_contact_corroborated};
use crate::{SimEvent, Telemetry, now_ms};
use serde::{Deserialize, Serialize};

/// Position jump allowance: this many times the distance GS·Δt would cover …
const TELEPORT_GS_FACTOR: f64 = 3.0;
/// … plus this margin, nm.
const TELEPORT_MARGIN_NM: f64 = 1.0;
/// Altitude change faster than this between two samples is a reposition, ft/s.
const TELEPORT_FT_PER_S: f64 = 5_000.0;
/// Samples further apart than this are checked for a pause the provider did not report.
const GAP_PAUSE_MS: u64 = 5_000;
/// A gap is a pause when the sim clock advanced by less than this share of it.
const GAP_SIM_CLOCK_SHARE: f64 = 0.25;
/// Continuity across a reset: altitude may change by this factor times what the last V/S …
const RESUME_ALT_FACTOR: f64 = 2.0;
/// … (at least this, fpm) covers in the gap …
const RESUME_MIN_FPM: f64 = 1_000.0;
/// … plus this margin, ft.
const RESUME_ALT_MARGIN_FT: f64 = 100.0;
/// Continuity across a reset is only judged with the gap's tolerances for holes up to this
/// long, ms; a longer hole must be a frozen sim at the same spot (see the module doc).
pub const RESUME_MAX_GAP_MS: u64 = 60_000;
/// First sample after a reset in the air on the ground below this GS: parked, a restart.
pub const RESUME_PARKED_KT: f64 = 5.0;
/// After a continuous hole up to this long (or a frozen sim) the V/S before it may rate a
/// landing right after it, ms.
const RESUME_VS_MAX_GAP_MS: u64 = 10_000;
/// A flight started in the air counts as flown after moving this long, ms …
pub const MS_AIRBORNE_START_MOVING: u64 = 3_000;
/// … faster than this GS, kt …
const KT_AIRBORNE_START_MOVING: f64 = 30.0;
/// … or climbing/descending faster than this, fpm.
const FPM_AIRBORNE_START_MOVING: f64 = 100.0;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlightState {
    #[default]
    Idle,
    Active,
    Completed,
    /// Ended without a shutdown: new flight loaded, position lost, provider stopped.
    Interrupted,
    /// Ended without ever having flown (a ground session, see the module doc): not a flight.
    Discarded,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoPoint {
    pub latitude: f64,
    pub longitude: f64,
}

/// Things a VA or the pilot would want to know before trusting the flight.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityFlags {
    pub paused_ms: u64,
    pub pause_count: u32,
    pub slew_detected: bool,
    pub time_acceleration_detected: bool,
    pub max_sim_rate: f64,
    pub crashed: bool,
    /// Fuel quantity went up mid-flight (refuel in the air / sim fuel menu).
    pub fuel_increased_airborne: bool,
    /// The position jumped during the flight (teleport, slew across a distance, reload).
    #[serde(default)]
    pub teleport_detected: bool,
    /// Time without recording inside the flight (app or sim crashed, the flight was resumed
    /// or merged afterwards), ms in total. Not serialised while 0.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub gap_ms: u64,
}

fn is_zero(v: &u64) -> bool {
    *v == 0
}

impl IntegrityFlags {
    /// Flags of two stretches of one flight (resume / merge): pauses add up, flags are or'ed,
    /// the highest sim rate wins.
    pub fn merged(&self, other: &IntegrityFlags) -> IntegrityFlags {
        IntegrityFlags {
            paused_ms: self.paused_ms + other.paused_ms,
            pause_count: self.pause_count + other.pause_count,
            slew_detected: self.slew_detected || other.slew_detected,
            time_acceleration_detected: self.time_acceleration_detected || other.time_acceleration_detected,
            max_sim_rate: self.max_sim_rate.max(other.max_sim_rate),
            crashed: self.crashed || other.crashed,
            fuel_increased_airborne: self.fuel_increased_airborne || other.fuel_increased_airborne,
            teleport_detected: self.teleport_detected || other.teleport_detected,
            gap_ms: self.gap_ms + other.gap_ms,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightSummary {
    pub state: FlightState,
    pub phase: FlightPhase,
    pub off_block_ms: Option<u64>,
    /// Lift-off: the first airborne sample after the take-off roll.
    pub takeoff_ms: Option<u64>,
    pub landing_ms: Option<u64>,
    pub on_block_ms: Option<u64>,
    pub departure: Option<GeoPoint>,
    pub arrival: Option<GeoPoint>,
    pub max_altitude_msl_ft: f64,
    pub distance_nm: f64,
    pub fuel_start_kg: Option<f64>,
    pub fuel_end_kg: Option<f64>,
    pub touchdowns: Vec<TouchdownReport>,
    /// The flight's landing rate: headline rate of the last full-stop touchdown
    /// (touch-and-goes never count, and no flight-wide peak).
    pub landing_rate_fpm: Option<f64>,
    pub integrity: IntegrityFlags,
    /// G-load in the air outside the touchdown windows (see [`crate::gload`]); the last
    /// 3 s are held back until it is clear no touchdown follows.
    #[serde(default)]
    pub g_load: GLoadStats,
}

impl FlightSummary {
    pub fn block_time_ms(&self) -> Option<u64> {
        Some(self.on_block_ms?.saturating_sub(self.off_block_ms?))
    }

    pub fn flight_time_ms(&self) -> Option<u64> {
        Some(self.landing_ms?.saturating_sub(self.takeoff_ms?))
    }

    pub fn fuel_used_kg(&self) -> Option<f64> {
        Some(self.fuel_start_kg? - self.fuel_end_kg?)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FlightEvent {
    FlightStarted { timestamp_ms: u64 },
    /// Boxed: the transition carries a full Telemetry sample (~440 B with the track-v2
    /// options), the other variants are a few words.
    PhaseChanged(Box<PhaseTransition>),
    Touchdown(TouchdownReport),
    /// `interrupted`: the flight did not reach Shutdown (state `Interrupted`).
    FlightEnded { timestamp_ms: u64, interrupted: bool },
}

/// The decided outcome of a touchdown reported earlier (see the module doc). Serialises
/// like a flight event (`kind: "touchdownOutcome"`), so it can go out on the same channel.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename = "touchdownOutcome", rename_all = "camelCase")]
pub struct TouchdownOutcomeEvent {
    /// Index of the touchdown in [`FlightSummary::touchdowns`].
    pub index: usize,
    /// `FullStop`, `TouchAndGo` or `Unknown` (never `Pending`).
    pub outcome: TouchdownOutcome,
    /// Wall-clock time of the decision.
    pub timestamp_ms: u64,
    /// The touchdown's own `timestamp_ms` (first contact), to find its stored row.
    pub touchdown_ms: u64,
}

/// A recording ended as a ground session (see the module doc): the [`FlightEvent::FlightEnded`]
/// with the same `timestamp_ms` ended a [`FlightState::Discarded`] flight. Serialises like a
/// flight event (`kind: "flightDiscarded"`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename = "flightDiscarded", rename_all = "camelCase")]
pub struct FlightDiscardedEvent {
    /// Time of the `FlightEnded` it belongs to.
    pub timestamp_ms: u64,
    /// The discarded flight's off-block (its start), to find its stored row.
    pub off_block_ms: Option<u64>,
    /// It reached Shutdown (`FlightEnded { interrupted: false }`), rather than being cut off.
    pub shut_down: bool,
}

/// Undrained outcome events kept at most (a caller that never drains loses the oldest).
const MAX_QUEUED_OUTCOMES: usize = 32;

/// The previous sample, as far as discontinuity checks need it.
#[derive(Clone, Copy, Debug)]
struct SampleRef {
    /// Monotonic time (the session's [`MonoClock`]).
    ts: u64,
    /// Wall-clock time of the sample, for timestamps handed out.
    wall_ts: u64,
    pos: GeoPoint,
    alt_msl_ft: f64,
    alt_agl_ft: f64,
    vs_fpm: f64,
    gs_kt: f64,
    sim_time_s: f64,
    sim_rate: f64,
    /// Corroborated ground contact ([`ground_contact_corroborated`]).
    on_ground: bool,
}

impl SampleRef {
    fn of(t: &Telemetry, mono_ms: u64) -> Self {
        Self {
            ts: mono_ms,
            wall_ts: t.timestamp_ms,
            pos: GeoPoint { latitude: t.latitude, longitude: t.longitude },
            alt_msl_ft: t.altitude_msl_ft,
            alt_agl_ft: t.altitude_agl_ft,
            vs_fpm: t.vertical_speed_fpm,
            gs_kt: t.ground_speed_kt,
            sim_time_s: t.sim_zulu_time_s,
            sim_rate: t.sim_rate,
            on_ground: ground_contact_corroborated(t),
        }
    }
}

/// See [`FlightSession::debug_state`].
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightDebug {
    pub phase: FlightPhase,
    pub state: FlightState,
    pub candidate: Option<CandidateDebug>,
    pub airborne_qualified: bool,
    pub airborne_since_ms: Option<u64>,
    pub last_skip: Option<SkipReason>,
    pub detector: DetectorDebug,
    /// Main menu: samples ignored.
    pub sim_stopped: bool,
    /// The sim reported a pause.
    pub event_paused: bool,
    /// Context reset in the air, not yet requalified.
    pub resumed_airborne: bool,
    pub pause_started_ms: Option<u64>,
    pub last_sample_ms: Option<u64>,
    pub touchdowns: usize,
    /// Index of the touchdown whose outcome is still pending.
    pub pending_touchdown: Option<usize>,
    /// Backward steps of the system clock absorbed so far (`clock_jump` in the log).
    pub clock_jumps: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateDebug {
    pub phase: FlightPhase,
    pub since_ms: u64,
    pub dwell_ms: u64,
    pub remaining_ms: u64,
}

#[derive(Debug, Default)]
pub struct FlightSession {
    engine: PhaseEngine,
    detector: TouchdownDetector,
    summary: FlightSummary,
    last_pos: Option<(u64, GeoPoint)>,
    last_fuel_kg: Option<f64>,
    pause_started_ms: Option<u64>,
    last_sample: Option<SampleRef>,
    /// The sim said "paused": samples count as paused even if their flag says otherwise.
    event_paused: bool,
    /// The sim is not running a flight (main menu): samples are ignored.
    sim_stopped: bool,
    /// A context reset happened in the air with an open flight and the aircraft has not
    /// requalified yet: ground contact now cannot be told apart from a reposition.
    resumed_airborne: bool,
    /// Last sample before a reset in the air (reconnect, reload), to check the first sample
    /// after it for continuity (see the module doc).
    pre_reset: Option<SampleRef>,
    /// Wall clock → monotonic time for gaps, pauses and the distance integration;
    /// `last_sample.ts`, `pause_started_ms` and `last_pos` are on its scale.
    clock: MonoClock,
    /// A flight was resumed ([`FlightSession::resume_from`]) while the engine stood in
    /// Preflight/Shutdown: the next "leaving the blocks" continues it instead of starting one.
    resume_pending: bool,
    /// Index into `summary.touchdowns` of the touchdown waiting for its outcome.
    pending_touchdown: Option<usize>,
    /// Decided outcomes not yet taken by the caller.
    outcomes: Vec<TouchdownOutcomeEvent>,
    /// Discarded ground sessions not yet taken by the caller.
    discarded: Vec<FlightDiscardedEvent>,
    /// The open flight has flown (see the module doc); without it, it ends as discarded.
    flown: bool,
    /// Time of the last Landing transition while no full stop has set `landing_ms` for it yet.
    landing_phase_ms: Option<u64>,
    /// G-load of the samples this session evaluated for the open flight ...
    gload: GLoadTracker,
    /// ... on top of what a resumed flight brought along (`summary.g_load` = both merged).
    gload_base: GLoadStats,
    /// Start in the air: since when the aircraft moves like one (see the module doc).
    airborne_start_moving_since: Option<u64>,
    /// Start in the air: it moved long enough to count as flown.
    airborne_start_moved: bool,
    /// The last sample was a placeholder position (logged once per stretch).
    in_placeholder: bool,
}

impl FlightSession {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn summary(&self) -> &FlightSummary {
        &self.summary
    }

    pub fn phase(&self) -> FlightPhase {
        self.engine.phase()
    }

    pub fn has_open_flight(&self) -> bool {
        self.summary.state == FlightState::Active
    }

    /// Outcomes decided since the last call, oldest first (see the module doc). Take them
    /// after [`FlightSession::update`], [`FlightSession::on_sim_event`],
    /// [`FlightSession::reset_position_context`] and [`FlightSession::interrupt`]; the
    /// touchdown each one refers to was handed out as [`FlightEvent::Touchdown`] before.
    pub fn take_touchdown_outcomes(&mut self) -> Vec<TouchdownOutcomeEvent> {
        std::mem::take(&mut self.outcomes)
    }

    /// Flights ended as discarded since the last call (see the module doc), oldest first. Take
    /// them after the same calls as [`FlightSession::take_touchdown_outcomes`].
    pub fn take_discarded_flights(&mut self) -> Vec<FlightDiscardedEvent> {
        std::mem::take(&mut self.discarded)
    }

    /// Index into [`FlightSummary::touchdowns`] of the touchdown still waiting for its
    /// outcome: the UI says "Aufgesetzt" rather than "Gelandet" while this is set.
    pub fn pending_touchdown(&self) -> Option<usize> {
        self.pending_touchdown
    }

    /// Engine internals for Settings → Diagnostics (read-only, cheap).
    pub fn debug_state(&self) -> FlightDebug {
        FlightDebug {
            phase: self.engine.phase(),
            state: self.summary.state,
            candidate: self.engine.candidate().map(|(phase, since_ms, dwell_ms, remaining_ms)| CandidateDebug {
                phase,
                since_ms,
                dwell_ms,
                remaining_ms,
            }),
            airborne_qualified: self.engine.airborne_qualified(),
            airborne_since_ms: self.engine.airborne_since(),
            last_skip: self.engine.last_skip(),
            detector: self.detector.debug(),
            sim_stopped: self.sim_stopped,
            event_paused: self.event_paused,
            resumed_airborne: self.resumed_airborne,
            pause_started_ms: self.pause_started_ms.map(|m| self.clock.to_wall(m)),
            last_sample_ms: self.last_sample.map(|s| s.wall_ts),
            touchdowns: self.summary.touchdowns.len(),
            pending_touchdown: self.pending_touchdown,
            clock_jumps: self.clock.jumps(),
        }
    }

    /// What [`FlightSession::resume_from`] would make of the summary, without changing anything.
    pub fn preview_resume(&self, previous: &FlightSummary, gap_ms: u64) -> FlightSummary {
        resumed_summary(previous, &self.summary, self.engine.phase(), gap_ms)
    }

    /// Continue an interrupted flight (app or sim crashed, see the app's `resume_flight`):
    /// the summary takes the times, departure, distance, fuel, touchdowns and integrity of
    /// `previous` and becomes active again; `gap_ms` (time without recording) is added to
    /// `integrity.gap_ms`. A flight this session started meanwhile (the aircraft was already
    /// moving) is folded in: its distance and touchdowns add up, its landing / arrival win.
    /// The phase stays what the engine determined from the current telemetry. If the engine
    /// is still in Preflight/Shutdown, its next block-off continues this flight.
    pub fn resume_from(&mut self, previous: &FlightSummary, gap_ms: u64) {
        // the current flight's touchdowns follow the previous ones (or are dropped)
        let folded_in = self.summary.state == FlightState::Active;
        self.pending_touchdown = self.pending_touchdown.filter(|_| folded_in).map(|i| i + previous.touchdowns.len());
        self.summary = resumed_summary(previous, &self.summary, self.engine.phase(), gap_ms);
        // the tracker keeps the folded-in flight's g-load; a dropped flight's goes with it
        if !folded_in {
            self.gload = GLoadTracker::default();
        }
        self.gload_base = previous.g_load;
        // a resumed flight is never discarded as a ground session
        self.flown = true;
        self.resume_pending = matches!(self.engine.phase(), FlightPhase::Preflight | FlightPhase::Shutdown);
    }

    pub fn mark_crashed(&mut self) {
        self.summary.integrity.crashed = true;
    }

    /// Discrete sim event; returns the flight events it implies (see module doc).
    pub fn on_sim_event(&mut self, e: &SimEvent) -> Vec<FlightEvent> {
        match e {
            SimEvent::Paused { paused } => {
                self.event_paused = *paused;
                if *paused
                    && self.pause_started_ms.is_none()
                    && let Some(last) = self.last_sample
                {
                    self.pause_started_ms = Some(last.ts);
                    self.summary.integrity.pause_count += 1;
                }
                Vec::new()
            }
            SimEvent::SimRunning { running: false } => {
                self.sim_stopped = true;
                Vec::new()
            }
            SimEvent::SimRunning { running: true } => {
                if std::mem::take(&mut self.sim_stopped) { self.reset_position_context() } else { Vec::new() }
            }
            SimEvent::Crashed => {
                self.mark_crashed();
                Vec::new()
            }
            SimEvent::AircraftLoaded { .. } => self.reset_position_context(),
            SimEvent::FlightLoaded { .. } => {
                // a newly loaded flight is a new flight
                let ts = self.last_sample.map_or_else(now_ms, |s| s.wall_ts);
                let mut events = self.interrupt(ts);
                events.extend(self.reset_position_context());
                events
            }
        }
    }

    /// The data stream is not continuous any more (reconnect, reload): forget positions,
    /// V/S history, dwell timers and the airborne latches, keep the phase and the open
    /// flight. Returns a confirmed touchdown that was still settling, if any.
    pub fn reset_position_context(&mut self) -> Vec<FlightEvent> {
        // several resets in a row (reconnect, then AircraftLoaded) compare with the last real sample
        let before = self.last_sample.take().or(self.pre_reset);
        let events = self.reset_context(before.is_some_and(|b| !b.on_ground));
        self.pre_reset = before;
        events
    }

    /// End an open flight as interrupted (provider stopped, new flight loaded, position
    /// lost) and start over in Preflight. No-op without an open flight, apart from the restart.
    pub fn interrupt(&mut self, timestamp_ms: u64) -> Vec<FlightEvent> {
        let mut events = Vec::new();
        if let Some(r) = self.detector.reset(false) {
            self.push_touchdown(r, &mut events);
        }
        // before the flight ends, so its summary carries the outcome
        self.apply_outcome();
        if self.summary.state == FlightState::Active {
            self.gload.flush();
            self.summary.g_load = self.gload_base.merged(self.gload.stats());
        }
        self.engine.restart();
        self.landing_phase_ms = None;
        self.last_pos = None;
        self.last_fuel_kg = None;
        self.resumed_airborne = false;
        self.pre_reset = None;
        self.resume_pending = false;
        if self.summary.state == FlightState::Active {
            self.summary.state = if self.flown { FlightState::Interrupted } else { FlightState::Discarded };
            events.push(FlightEvent::FlightEnded { timestamp_ms, interrupted: true });
            self.note_discarded(timestamp_ms, false);
        }
        events
    }

    /// Queue the discard of the flight that just ended, if it never flew.
    fn note_discarded(&mut self, timestamp_ms: u64, shut_down: bool) {
        if self.summary.state == FlightState::Discarded {
            log::info!("ground session ended without having flown: discarded, not a flight");
            if self.discarded.len() >= MAX_QUEUED_OUTCOMES {
                self.discarded.remove(0);
            }
            self.discarded.push(FlightDiscardedEvent { timestamp_ms, off_block_ms: self.summary.off_block_ms, shut_down });
        }
    }

    /// Latch "this flight has flown" (see the module doc).
    fn note_flown(&mut self) {
        // a start in the air is high up from its first sample: only movement shows it flies
        let flew = if self.engine.started_airborne() {
            self.airborne_start_moved
        } else {
            self.engine.airborne_qualified() || self.engine.lifted_off()
        };
        if self.summary.state == FlightState::Active && (flew || self.summary.takeoff_ms.is_some() || !self.summary.touchdowns.is_empty()) {
            self.flown = true;
        }
    }

    /// Start in the air: latch `airborne_start_moved` after
    /// [`MS_AIRBORNE_START_MOVING`] of movement (see the module doc). Skipped samples (pause,
    /// slew, time acceleration) start the stretch over.
    fn track_airborne_start(&mut self, t: &Telemetry, now: u64) {
        if self.summary.state != FlightState::Active || !self.engine.started_airborne() || self.airborne_start_moved {
            return;
        }
        // NaN compares false: no movement
        let moving = self.engine.last_skip().is_none()
            && !ground_contact_corroborated(t)
            && (t.ground_speed_kt > KT_AIRBORNE_START_MOVING || t.vertical_speed_fpm.abs() > FPM_AIRBORNE_START_MOVING);
        if !moving {
            self.airborne_start_moving_since = None;
        } else if now.saturating_sub(*self.airborne_start_moving_since.get_or_insert(now)) >= MS_AIRBORNE_START_MOVING {
            self.airborne_start_moved = true;
        }
    }

    /// The position jumped (teleport, or not continuous across a reset). An open flight that
    /// never flew ends as discarded, and without a flight the phase engine starts over, so
    /// the recording begins fresh at the new place. Returns whether it did either.
    fn jumped_before_flying(&mut self, end_ms: u64, events: &mut Vec<FlightEvent>) -> bool {
        if self.summary.state == FlightState::Active {
            if self.flown {
                return false;
            }
            log::info!("position jump before the flight ever flew: discarded, recording starts over here");
            events.extend(self.interrupt(end_ms));
        } else {
            self.engine.restart();
        }
        true
    }

    /// Feed one sample at any rate; returns the events it produced (usually none).
    pub fn update(&mut self, t: &Telemetry) -> Vec<FlightEvent> {
        let mut events = Vec::new();
        if self.sim_stopped {
            return events;
        }
        // a sim's placeholder while it loads: not the aircraft, nothing to evaluate (module doc)
        let placeholder = t.placeholder_position();
        if placeholder != std::mem::replace(&mut self.in_placeholder, placeholder) && placeholder {
            log::info!("placeholder position (0° N / 0° E): samples ignored until a real position comes");
        }
        if placeholder {
            return events;
        }
        let forced;
        let t = if self.event_paused && !t.paused {
            forced = Telemetry { paused: true, ..t.clone() };
            &forced
        } else {
            t
        };

        let jumps = self.clock.jumps();
        let now = self.clock.advance(t.timestamp_ms);
        if self.clock.jumps() > jumps {
            log::warn!(
                "clock_jump: system clock went back {} ms; timers continue with Δt = 0, timestamps stay wall-clock",
                self.clock.last_jump_ms()
            );
        }

        if let Some(before) = self.pre_reset.take() {
            if !continues_after_reset(before, t, now) {
                // somewhere else after the reset: a ground session ends, an idle engine restarts
                if self.jumped_before_flying(before.wall_ts, &mut events) {
                    events.extend(self.reset_context(!before.on_ground));
                }
            } else if self.resumed_airborne && !t.slew {
                // only a hole in the stream: the flight goes on, a landing now is a landing
                let gap_ms = now.saturating_sub(before.ts);
                let frozen = sim_clock_stood_still(before, t, gap_ms as f64 / 1000.0);
                log::info!("position continuous across the context reset ({} s): flight requalified", gap_ms / 1000);
                self.engine.restore_qualified();
                // the V/S before a short hole still describes the aircraft (see the module doc)
                let short = gap_ms <= RESUME_VS_MAX_GAP_MS || frozen;
                self.detector.restore_qualified(short.then_some(before.vs_fpm));
                self.resumed_airborne = false;
                if !frozen && gap_ms > GAP_PAUSE_MS && self.summary.state == FlightState::Active {
                    // the stream was away while the sim flew on: time without recording
                    self.summary.integrity.gap_ms += gap_ms;
                }
            }
        }
        self.check_discontinuity(t, now, &mut events);
        if !t.paused
            && let Some(start) = self.pause_started_ms.take()
        {
            let d = now.saturating_sub(start);
            self.summary.integrity.paused_ms += d;
            self.engine.shift_time(d);
            self.detector.shift_time(d);
        }
        if self.resumed_airborne && !t.paused && !t.slew && ground_contact_corroborated(t) {
            events.extend(self.interrupt(t.timestamp_ms));
        }

        if let Some(report) = self.detector.update(t) {
            self.push_touchdown(report, &mut events);
        }
        self.apply_outcome();

        let transition = self.engine.update(t);
        if self.engine.airborne_qualified() {
            self.resumed_airborne = false;
        }
        self.track_airborne_start(t, now);
        self.note_flown();
        self.note_integrity(t, now);

        if let Some(tr) = transition {
            // Order matters for consumers: FlightStarted → PhaseChanged → FlightEnded,
            // so a recorder sees the Shutdown transition while the flight is still open.
            let (started, ended) = self.apply_transition(&tr);
            if let Some(e) = started {
                events.push(e);
            }
            events.push(FlightEvent::PhaseChanged(Box::new(tr)));
            if let Some(e) = ended {
                events.push(e);
            }
            self.note_flown();
        }
        // an interrupted (or discarded) flight keeps the phase it ended in
        if !matches!(self.summary.state, FlightState::Interrupted | FlightState::Discarded) {
            self.summary.phase = self.engine.phase();
        }

        if self.summary.state == FlightState::Active {
            self.gload.update(GSample {
                mono_ms: now,
                wall_ms: t.timestamp_ms,
                g: t.g_force,
                // the corroborated contact, like everywhere else: a stray "on ground" at
                // altitude must not drop a real g peak as the landing's
                on_ground: ground_contact_corroborated(t),
                excluded: self.engine.last_skip().is_some(),
                phase: self.engine.phase(),
                altitude_msl_ft: t.altitude_msl_ft,
            });
            self.summary.g_load = self.gload_base.merged(self.gload.stats());
        }
        if self.summary.state == FlightState::Active && self.engine.last_skip().is_none() {
            self.accumulate(t, now);
        }
        self.last_sample = Some(SampleRef::of(t, now));
        events
    }

    /// A new report: into the summary and out as an event right away; the flight's landing
    /// rate and time wait for its outcome ([`FlightSession::apply_outcome`]).
    fn push_touchdown(&mut self, report: TouchdownReport, events: &mut Vec<FlightEvent>) {
        self.summary.touchdowns.push(report.clone());
        self.pending_touchdown = Some(self.summary.touchdowns.len() - 1);
        events.push(FlightEvent::Touchdown(report));
    }

    /// Settle the pending touchdown with the outcome the detector decided, if any.
    fn apply_outcome(&mut self) {
        let Some((outcome, timestamp_ms)) = self.detector.take_outcome() else { return };
        // no pending touchdown: its flight was dropped (resume) – nothing to settle
        let Some(index) = self.pending_touchdown.take() else { return };
        let Some(td) = self.summary.touchdowns.get_mut(index) else { return };
        td.touch_and_go = outcome == TouchdownOutcome::TouchAndGo;
        // an unrated touchdown (slewed / fast-forwarded down) is recorded, but has no rate to count
        let rate = td.landing_rate_source.is_rated().then_some(td.landing_rate_fpm);
        let touchdown_ms = td.timestamp_ms;
        match outcome {
            TouchdownOutcome::FullStop => {
                self.summary.landing_rate_fpm = rate;
                self.summary.landing_ms = Some(touchdown_ms);
                self.landing_phase_ms = None;
            }
            TouchdownOutcome::Unknown => {
                // stored as "not a touch-and-go", so it counts like one for the flight too
                self.summary.landing_rate_fpm = rate;
                // already taxiing: the Landing → TaxiIn fallback has passed (it was pending)
                if matches!(self.engine.phase(), FlightPhase::TaxiIn | FlightPhase::Shutdown) {
                    self.summary.landing_ms = Some(self.landing_phase_ms.take().unwrap_or(touchdown_ms));
                }
            }
            TouchdownOutcome::TouchAndGo | TouchdownOutcome::Pending => {}
        }
        if self.outcomes.len() >= MAX_QUEUED_OUTCOMES {
            self.outcomes.remove(0);
        }
        self.outcomes.push(TouchdownOutcomeEvent { index, outcome, timestamp_ms, touchdown_ms });
    }

    /// Context reset without touching `last_sample` (a teleport keeps the new position as reference).
    /// `was_airborne`: the last sample before the reset was in the air (makes a reset in the
    /// Takeoff phase one in the air, see the module doc).
    fn reset_context(&mut self, was_airborne: bool) -> Vec<FlightEvent> {
        let mut events = Vec::new();
        let phase = self.engine.phase();
        let resume = self.summary.state == FlightState::Active
            && (phase.is_airborne_phase() || phase == FlightPhase::Takeoff && was_airborne);
        if let Some(r) = self.detector.reset(resume) {
            self.push_touchdown(r, &mut events);
        }
        self.apply_outcome();
        self.engine.reset_context(resume);
        self.gload.reset_context();
        self.last_pos = None;
        self.last_fuel_kg = None;
        self.resumed_airborne = resume;
        // a jump (or a reset on the ground) has nothing to continue from
        self.pre_reset = None;
        events
    }

    /// Pause without telemetry and teleport, judged against the previous sample.
    fn check_discontinuity(&mut self, t: &Telemetry, now: u64, events: &mut Vec<FlightEvent>) {
        let Some(prev) = self.last_sample else { return };
        let dt_ms = now.saturating_sub(prev.ts);
        let dt_s = dt_ms as f64 / 1000.0;
        if !t.paused && self.pause_started_ms.is_none() && dt_ms > GAP_PAUSE_MS && sim_clock_stood_still(prev, t, dt_s) {
            let i = &mut self.summary.integrity;
            i.pause_count += 1;
            i.paused_ms += dt_ms;
            self.engine.shift_time(dt_ms);
            self.detector.shift_time(dt_ms);
        }
        if is_teleport(prev, t, dt_s) {
            log::info!("position jump detected ({dt_s:.1} s between samples): position context reset");
            if !self.jumped_before_flying(prev.wall_ts, events) && self.summary.state == FlightState::Active {
                self.summary.integrity.teleport_detected = true;
            }
            events.extend(self.reset_context(!prev.on_ground));
        }
    }

    /// Applies a phase transition to the summary; returns the flight start/end events it implies.
    fn apply_transition(&mut self, tr: &PhaseTransition) -> (Option<FlightEvent>, Option<FlightEvent>) {
        use FlightPhase::*;
        let t = &tr.telemetry;
        let mut started = None;
        let mut ended = None;
        let leaving_blocks = matches!(tr.from, Preflight | Shutdown) && !matches!(tr.to, Preflight | Shutdown);
        if leaving_blocks {
            // a resumed flight rolls on: no new flight
            let resumed = std::mem::take(&mut self.resume_pending) && self.summary.state == FlightState::Active;
            if !resumed {
                self.start_flight(t);
                started = Some(FlightEvent::FlightStarted { timestamp_ms: tr.timestamp_ms });
            }
        }
        if tr.from == Pushback && tr.to == Preflight && self.summary.state == FlightState::Active {
            // a push held on the brake before the engine start: the flight goes on, and the next
            // off-block continues it with the push's off-block (see the module doc)
            log::info!("push held on the parking brake: the flight stays open until the engines start");
            self.resume_pending = true;
        }
        match tr.to {
            // a flight that started in the air has no lift-off to take the time from
            Climb if self.summary.takeoff_ms.is_none() && !self.engine.started_airborne() => {
                // Climb comes up to 45 s after lift-off; the take-off time is the lift-off itself
                // (kept across a reset in the initial climb)
                let lift_off = self.engine.takeoff_lift_off().or(self.engine.airborne_since());
                self.summary.takeoff_ms = Some(lift_off.unwrap_or(tr.timestamp_ms));
            }
            Landing => {
                if tr.from == Takeoff && self.summary.takeoff_ms.is_none() && !self.engine.started_airborne() {
                    // a hop that never reached Climb: its lift-off is the take-off time
                    self.summary.takeoff_ms = self.engine.takeoff_lift_off();
                }
                // landing_ms waits for the full stop (see the module doc)
                self.landing_phase_ms = Some(tr.timestamp_ms);
                self.summary.arrival = Some(GeoPoint { latitude: t.latitude, longitude: t.longitude });
            }
            TaxiIn if tr.from == Landing => {
                // rolled out without a touchdown to settle it (detector had no report, or
                // its outcome is unknown): the Landing transition is the landing time
                if self.pending_touchdown.is_none()
                    && let Some(ts) = self.landing_phase_ms.take()
                {
                    self.summary.landing_ms = Some(ts);
                }
            }
            Climb if tr.from == Landing => self.landing_phase_ms = None,
            Shutdown => {
                self.summary.on_block_ms = Some(tr.timestamp_ms);
                self.summary.fuel_end_kg = Some(t.fuel_total_kg);
                if self.summary.state == FlightState::Active {
                    // a held push given up: nothing left to continue
                    self.resume_pending = false;
                    // taxied around and shut down without flying: a ground session, no flight
                    self.summary.state = if self.flown { FlightState::Completed } else { FlightState::Discarded };
                    ended = Some(FlightEvent::FlightEnded { timestamp_ms: tr.timestamp_ms, interrupted: false });
                    self.note_discarded(tr.timestamp_ms, true);
                }
            }
            _ => {}
        }
        (started, ended)
    }

    fn start_flight(&mut self, t: &Telemetry) {
        self.summary = FlightSummary {
            state: FlightState::Active,
            phase: self.engine.phase(),
            off_block_ms: Some(t.timestamp_ms),
            departure: Some(GeoPoint { latitude: t.latitude, longitude: t.longitude }),
            max_altitude_msl_ft: t.altitude_msl_ft,
            fuel_start_kg: Some(t.fuel_total_kg),
            ..Default::default()
        };
        self.last_pos = None;
        self.last_fuel_kg = None;
        self.resumed_airborne = false;
        self.flown = false;
        self.airborne_start_moving_since = None;
        self.airborne_start_moved = false;
        // the previous flight's touchdowns are gone with its summary
        self.pending_touchdown = None;
        self.landing_phase_ms = None;
        self.gload = GLoadTracker::default();
        self.gload_base = GLoadStats::default();
        if self.engine.started_airborne() {
            // started in the air: requalify after a short stretch, like after a reset in the air
            // (nothing is settling yet, so there is no report to keep)
            let _ = self.detector.reset(true);
        }
    }

    fn accumulate(&mut self, t: &Telemetry, now: u64) {
        let s = &mut self.summary;
        s.max_altitude_msl_ft = s.max_altitude_msl_ft.max(t.altitude_msl_ft);
        let here = GeoPoint { latitude: t.latitude, longitude: t.longitude };
        // integrate distance at ≤ 1 Hz to keep jitter out of the sum
        match self.last_pos {
            Some((ts, _)) if now.saturating_sub(ts) < 1_000 => {}
            Some((_, p)) => {
                s.distance_nm += haversine_nm(p, here);
                self.last_pos = Some((now, here));
            }
            None => self.last_pos = Some((now, here)),
        }
        if let Some(prev) = self.last_fuel_kg
            && !t.on_ground
            && t.fuel_total_kg > prev + 1.0
        {
            s.integrity.fuel_increased_airborne = true;
        }
        self.last_fuel_kg = Some(t.fuel_total_kg);
    }

    fn note_integrity(&mut self, t: &Telemetry, now: u64) {
        let i = &mut self.summary.integrity;
        i.max_sim_rate = i.max_sim_rate.max(t.sim_rate);
        match self.engine.last_skip() {
            Some(SkipReason::Paused) => {
                if self.pause_started_ms.is_none() {
                    self.pause_started_ms = Some(now);
                    i.pause_count += 1;
                }
            }
            Some(SkipReason::Slew) => {
                i.slew_detected = true;
                // slewed distance is not flown distance
                self.last_pos = None;
            }
            Some(SkipReason::TimeAcceleration) => i.time_acceleration_detected = true,
            _ => {}
        }
    }
}

/// `previous` continued (see [`FlightSession::resume_from`]); `current` is the session's
/// summary, folded in when it is an open flight.
fn resumed_summary(previous: &FlightSummary, current: &FlightSummary, phase: FlightPhase, gap_ms: u64) -> FlightSummary {
    let mut s = FlightSummary { state: FlightState::Active, phase, on_block_ms: None, fuel_end_kg: None, ..previous.clone() };
    if current.state == FlightState::Active {
        s.takeoff_ms = previous.takeoff_ms.or(current.takeoff_ms);
        s.landing_ms = current.landing_ms.or(previous.landing_ms);
        s.arrival = current.arrival.or(previous.arrival);
        s.departure = previous.departure.or(current.departure);
        s.off_block_ms = previous.off_block_ms.or(current.off_block_ms);
        s.max_altitude_msl_ft = previous.max_altitude_msl_ft.max(current.max_altitude_msl_ft);
        s.distance_nm = previous.distance_nm + current.distance_nm;
        s.fuel_start_kg = previous.fuel_start_kg.or(current.fuel_start_kg);
        s.touchdowns.extend(current.touchdowns.iter().cloned());
        s.landing_rate_fpm = current.landing_rate_fpm.or(previous.landing_rate_fpm);
        s.integrity = previous.integrity.merged(&current.integrity);
        s.g_load = previous.g_load.merged(&current.g_load);
    }
    s.integrity.gap_ms += gap_ms;
    s
}

/// The sim clock (zulu seconds, wraps at midnight) advanced by much less than the wall clock.
/// Unknown (both 0) counts as running, so a provider without a sim clock never infers pauses.
fn sim_clock_stood_still(prev: SampleRef, t: &Telemetry, dt_s: f64) -> bool {
    if prev.sim_time_s == 0.0 && t.sim_zulu_time_s == 0.0 || !t.sim_zulu_time_s.is_finite() || !prev.sim_time_s.is_finite() {
        return false;
    }
    let advanced = (t.sim_zulu_time_s - prev.sim_time_s).rem_euclid(86_400.0);
    advanced < GAP_SIM_CLOCK_SHARE * dt_s
}

/// The first sample after a reset in the air is where the last one before it could have got
/// to in the gap (see the module doc). NaN altitudes compare false: no continuity.
fn continues_after_reset(before: SampleRef, t: &Telemetry, now: u64) -> bool {
    let parked = t.ground_speed_kt.is_nan() || t.ground_speed_kt < RESUME_PARKED_KT;
    if !before.on_ground && ground_contact_corroborated(t) && parked {
        // in the air before, parked after: the sim was restarted (NaN GS counts as parked)
        return false;
    }
    let gap_ms = now.saturating_sub(before.ts);
    let dt_s = if gap_ms <= RESUME_MAX_GAP_MS {
        gap_ms as f64 / 1000.0
    } else if sim_clock_stood_still(before, t, gap_ms as f64 / 1000.0) {
        // a frozen sim (ESC menu, pause): only the very same spot continues
        0.0
    } else {
        return false;
    };
    let allowed_ft =
        before.vs_fpm.abs().max(RESUME_MIN_FPM) * dt_s / 60.0 * RESUME_ALT_FACTOR + RESUME_ALT_MARGIN_FT;
    let within = |a: f64, b: f64| (a - b).abs() <= allowed_ft;
    let agl_ok = !(before.alt_agl_ft.is_finite() && t.altitude_agl_ft.is_finite())
        || within(before.alt_agl_ft, t.altitude_agl_ft);
    !is_teleport(before, t, dt_s) && within(before.alt_msl_ft, t.altitude_msl_ft) && agl_ok
}

fn is_teleport(prev: SampleRef, t: &Telemetry, dt_s: f64) -> bool {
    let here = GeoPoint { latitude: t.latitude, longitude: t.longitude };
    let dt_s = dt_s.max(0.05);
    let dist = haversine_nm(prev.pos, here);
    let gs = prev.gs_kt.max(t.ground_speed_kt).max(0.0);
    // time acceleration: the sim covers `rate` seconds per wall-clock second (NaN → 1)
    let rate = prev.sim_rate.max(t.sim_rate).max(1.0);
    let allowed = gs * dt_s * rate / 3_600.0 * TELEPORT_GS_FACTOR + TELEPORT_MARGIN_NM;
    let climb = (t.altitude_msl_ft - prev.alt_msl_ft).abs() / dt_s;
    // NaN compares false: garbage samples never count as a jump
    dist > allowed || climb > TELEPORT_FT_PER_S
}

pub fn haversine_nm(a: GeoPoint, b: GeoPoint) -> f64 {
    const R_NM: f64 = 3_440.065;
    let (lat1, lat2) = (a.latitude.to_radians(), b.latitude.to_radians());
    let dlat = lat2 - lat1;
    let dlon = (b.longitude - a.longitude).to_radians();
    let h = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * R_NM * h.sqrt().asin()
}
