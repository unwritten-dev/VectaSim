//! Flight-phase state machine.
//!
//! Thresholds (based on common virtual-airline logger rule sets and NTSB phase
//! definitions):
//!
//! | transition              | condition                                              | dwell |
//! |-------------------------|--------------------------------------------------------|-------|
//! | Preflight → airborne    | start in the air (see below)                           | 0     |
//! | Preflight → Pushback    | 0.5–8 kt, engines off, parking brake released          | 2 s   |
//! | Preflight → TaxiOut     | > 1 kt, engines running                                | 2 s   |
//! | ground → Takeoff        | > 40 kt with engines running or airborne, or airborne above 50 ft AGL | 1 s |
//! | Takeoff → Climb         | airborne and (> 1 500 ft AGL or airborne > 45 s)       | 0     |
//! | Takeoff → TaxiOut/TaxiIn| rejected: back below 40 kt without having flown (back to where it came from) | 3 s |
//! | TaxiOut → Shutdown      | < 1 kt and all engines off (back on the stand)          | 30 s  |
//! | Climb → Cruise          | \|V/S\| < 300 fpm (not below 4 000 ft AGL in a circuit) | 60 s  |
//! | Climb/Cruise → Descent  | V/S < −300 fpm and ≥ 300 ft below max altitude         | 30 s  |
//! | Cruise/Descent → Climb  | V/S > +300 fpm (step climb / go-around)                | 30 s  |
//! | Descent → Approach      | < 4 000 ft AGL                                          | 5 s   |
//! | Approach → Final        | < 1 500 ft AGL                                          | 3 s   |
//! | Approach/Final → Climb  | go-around: V/S > +500 fpm                              | 10 s  |
//! | airborne → Landing      | on ground after having been airborne (> 500 ft or 60 s)| 0     |
//! | Landing → TaxiIn        | < 35 kt                                                | 3 s   |
//! | Landing → Climb         | touch-and-go: airborne again and > 50 ft AGL           | 10 s  |
//! | TaxiIn → Shutdown       | < 1 kt and all engines off                              | 5 s   |
//! | TaxiIn → Shutdown       | < 1 kt, parking brake set, engines still running        | 10 min|
//! | Shutdown → TaxiOut/Pushback | moving again (next leg)                            | 2 s   |
//!
//! "On ground" is the sim flag corroborated like the touchdown detector does it
//! ([`ground_contact_corroborated`]: only believed at ≤ 50 ft AGL, or ≤ 200 kt GS
//! without a usable AGL), so a spurious on-ground sample at altitude can neither
//! fire Landing nor reset the airborne tracking.
//!
//! Lift-off from a ground phase (Preflight, Pushback, TaxiOut, TaxiIn, Shutdown): a single
//! uncorroborated "not on ground" sample is no take-off. `SIM ON GROUND` flickers on grass,
//! over a bump or with one gear leg, and X-Plane's flag can drop for a frame or two at 10 Hz;
//! up to 0.5.0 such a sample fired Takeoff at once, fell back to TaxiOut as a rejected
//! take-off three seconds later and left a flight that could never reach Shutdown (or started
//! a ghost flight on the stand). Takeoff now needs a take-off roll (> 40 kt, engines running
//! or airborne) or real air under the wheels (> 50 ft AGL), held for 1 s. A genuine take-off
//! is in Takeoff during the roll, before the wheels leave the ground, so its timing does not
//! change; the lift-off time comes from the first airborne sample either way. Paused, slewed
//! and time-accelerated samples (MSFS pause, slew, active pause) drop the candidate like any
//! other dwell; the ESC menu's sim stop resets the context.
//!
//! Circuits: a go-around or touch-and-go (Approach/Final/Landing → Climb) starts a circuit.
//! The highest altitude for the "descending" test is taken from there instead of from the
//! whole flight, and level flight below 4 000 ft AGL stays Climb instead of becoming Cruise
//! (the downwind is no cruise) until the descent to the next approach.
//!
//! Dwell = how long the condition must hold continuously before the transition
//! fires. Time-based rather than sample-based so the engine behaves the same at
//! 1 Hz and at 20 Hz. Samples taken while paused, slewing or with sim rate ≠ 1
//! ([`Telemetry::time_accelerated`]) are ignored (reported through `last_skip`) so time
//! acceleration cannot fake a cruise or a landing; the touchdown detector skips the same
//! samples.
//!
//! Time base: dwells run on a [`MonoClock`] fed with the wall-clock sample time. A backward
//! step of the system clock counts as Δt = 0 instead of stopping the engine until the
//! clock has caught up again; transition timestamps stay wall-clock.
//!
//! Block-on follows EASA ORO.FTL.105 ("parked and all engines stopped"): a stop with the
//! parking brake set and the engines running (waiting for the stand or the marshaller)
//! does not end the flight; only after 10 min in that state is it taken as on-block.
//!
//! Lift-off time: [`PhaseEngine::airborne_since`] is the first corroborated airborne
//! sample of the current airborne stretch; the flight's take-off time is read from it
//! when Takeoff → Climb fires (Climb itself comes up to 45 s later). It is kept apart from
//! the air-time counter: a pause in those 45 s is cut out of the counter, not out of the
//! lift-off time.
//!
//! Start in the air (connected mid-flight, or a flight loaded in the air): when the very
//! first corroborated sample after [`PhaseEngine::new`] / [`PhaseEngine::restart`] is
//! airborne (no ground contact seen yet) and really flying – above 100 ft AGL or faster than
//! 40 kt; an aircraft spawned at the gate can report "not on ground" at 1 ft and 0 kt while
//! it settles, and that stays Preflight –, Preflight goes straight to the phase the sample
//! shows – Climb (V/S > +300 fpm), level → Cruise, descending → Descent, below 4 000 ft AGL
//! Approach, below 1 500 ft AGL Final – instead of Takeoff → Climb. No take-off is seen, so
//! [`PhaseEngine::started_airborne`] is set and the flight gets no take-off time; the air
//! time requalifies like after a reset in the air ([`MS_REQUALIFY_AFTER_RESET`]). Once the
//! engine has seen the ground, an airborne sample in Preflight is a take-off as before.
//!
//! Context resets ([`PhaseEngine::reset_context`]): after a reconnect, teleport or reload
//! the hysteresis, the airborne tracking and its `airborne_qualified` latch start from
//! scratch while the phase is kept. A reset in an airborne phase requalifies after
//! [`MS_REQUALIFY_AFTER_RESET`] (10 s) of continuous air time or > 500 ft AGL; otherwise
//! the normal 60 s apply. Pauses without telemetry are cut out of the timers with
//! [`PhaseEngine::shift_time`]. When the session finds the position continuous across a
//! reset in the air, it reopens the Landing gate at once ([`PhaseEngine::restore_qualified`]).

use crate::Telemetry;
use crate::clock::MonoClock;
use crate::touchdown::{MS_REQUALIFY_AFTER_RESET, ground_contact_corroborated};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlightPhase {
    #[default]
    Preflight,
    Pushback,
    TaxiOut,
    Takeoff,
    Climb,
    Cruise,
    Descent,
    Approach,
    Final,
    Landing,
    TaxiIn,
    Shutdown,
}

impl FlightPhase {
    pub fn is_airborne_phase(self) -> bool {
        matches!(self, Self::Climb | Self::Cruise | Self::Descent | Self::Approach | Self::Final)
    }

    pub fn is_ground_phase(self) -> bool {
        !self.is_airborne_phase() && self != Self::Takeoff && self != Self::Landing
    }
}

/// Why a sample was not evaluated.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    Paused,
    Slew,
    TimeAcceleration,
    /// Not produced any more: a backward clock step counts as Δt = 0 (see [`MonoClock`]).
    /// Kept so stored diagnostics still deserialize.
    ClockWentBackwards,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseTransition {
    pub from: FlightPhase,
    pub to: FlightPhase,
    pub timestamp_ms: u64,
    pub telemetry: Telemetry,
}

const KT_STOPPED: f64 = 1.0;
const KT_PUSHBACK_MAX: f64 = 8.0;
const KT_TAKEOFF: f64 = 40.0;
const KT_ROLLOUT_DONE: f64 = 35.0;
const FT_TAKEOFF_COMPLETE: f64 = 1_500.0;
const FT_APPROACH: f64 = 4_000.0;
const FT_FINAL: f64 = 1_500.0;
const FT_TOUCH_AND_GO: f64 = 50.0;
/// Airborne above this AGL is a lift-off from a ground phase, whatever the ground speed.
const FT_LIFT_OFF: f64 = 50.0;
/// A take-off roll or lift-off must hold this long before Takeoff fires.
const MS_LIFT_OFF_CONFIRM: u64 = 1_000;
/// Start in the air: only when the first sample is above this AGL (or faster than 40 kt).
const FT_AIRBORNE_START: f64 = 100.0;
/// TaxiOut → Shutdown: stopped with all engines off this long.
const MS_TAXI_OUT_SHUTDOWN: u64 = 30_000;
const FT_AIRBORNE_QUALIFIED: f64 = 500.0;
const MS_AIRBORNE_QUALIFIED: u64 = 60_000;
const MS_TAKEOFF_COMPLETE: u64 = 45_000;
const FPM_LEVEL: f64 = 300.0;
const FPM_GO_AROUND: f64 = 500.0;
const FT_BELOW_MAX_FOR_DESCENT: f64 = 300.0;
const MS_SHUTDOWN_ENGINES_OFF: u64 = 5_000;
/// Parked with the parking brake set but engines still running: on-block only after this long.
const MS_SHUTDOWN_BRAKE_ENGINES_ON: u64 = 600_000;

#[derive(Debug)]
pub struct PhaseEngine {
    phase: FlightPhase,
    /// Proposed next phase and since when its condition has held.
    candidate: Option<(FlightPhase, u64)>,
    last_ts: Option<u64>,
    /// Start of the current airborne stretch for the air-time counter (shifted by pauses).
    airborne_since: Option<u64>,
    /// First airborne sample of the current stretch (the lift-off), never shifted.
    lift_off: Option<u64>,
    /// Ground phase a rejected take-off returns to (TaxiIn when it came from there).
    takeoff_from: FlightPhase,
    /// Flying a circuit after a go-around or touch-and-go (see the module doc).
    circuit: bool,
    /// Set once the aircraft was clearly flying (> 500 ft AGL or > 60 s); gates Landing.
    airborne_qualified: bool,
    max_altitude_msl_ft: f64,
    last_skip: Option<SkipReason>,
    /// Air time that qualifies a flight (shorter right after a reset in the air).
    qualify_ms: u64,
    /// Dwell the current candidate needs (diagnostics only).
    candidate_dwell_ms: u64,
    /// Wall clock → monotonic time; all timestamps above are on its scale.
    clock: MonoClock,
    /// A corroborated ground sample was seen since `new` / `restart`.
    seen_ground: bool,
    /// The current flight began in the air (see the module doc).
    started_airborne: bool,
}

impl Default for PhaseEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl PhaseEngine {
    pub fn new() -> Self {
        Self {
            phase: FlightPhase::Preflight,
            candidate: None,
            last_ts: None,
            airborne_since: None,
            lift_off: None,
            takeoff_from: FlightPhase::TaxiOut,
            circuit: false,
            airborne_qualified: false,
            max_altitude_msl_ft: f64::MIN,
            last_skip: None,
            qualify_ms: MS_AIRBORNE_QUALIFIED,
            candidate_dwell_ms: 0,
            clock: MonoClock::new(),
            seen_ground: false,
            started_airborne: false,
        }
    }

    /// Back to Preflight with nothing remembered (a new flight was loaded).
    pub fn restart(&mut self) {
        *self = Self::new();
    }

    /// Forget everything that depends on continuity of the data stream (dwell timers,
    /// airborne tracking, the Landing gate) but keep the phase. `resume_airborne`:
    /// the reset happened in the air, so a short stretch of air time requalifies.
    pub fn reset_context(&mut self, resume_airborne: bool) {
        self.candidate = None;
        self.last_ts = None;
        self.airborne_since = None;
        self.lift_off = None;
        self.airborne_qualified = false;
        self.last_skip = None;
        self.qualify_ms = if resume_airborne { MS_REQUALIFY_AFTER_RESET } else { MS_AIRBORNE_QUALIFIED };
    }

    /// The session found the position continuous across a context reset in the air (see
    /// [`crate::flight`]): the flight goes on, so the Landing gate is open again at once.
    pub fn restore_qualified(&mut self) {
        self.airborne_qualified = true;
        self.qualify_ms = MS_AIRBORNE_QUALIFIED;
    }

    /// Cut a pause of `ms` out of the timers (dwell and air time do not run while paused).
    /// The lift-off time stays where it was.
    pub fn shift_time(&mut self, ms: u64) {
        if let Some(s) = self.airborne_since.as_mut() {
            *s = s.saturating_add(ms);
        }
        if let Some((_, since)) = self.candidate.as_mut() {
            *since = since.saturating_add(ms);
        }
    }

    /// Time of the first airborne sample of the current airborne stretch (lift-off).
    pub fn airborne_since(&self) -> Option<u64> {
        self.lift_off.map(|m| self.clock.to_wall(m))
    }

    /// Backward steps of the wall clock this engine has absorbed.
    pub fn clock_jumps(&self) -> u32 {
        self.clock.jumps()
    }

    pub fn phase(&self) -> FlightPhase {
        self.phase
    }

    /// Reason the most recent sample was skipped, if it was.
    pub fn last_skip(&self) -> Option<SkipReason> {
        self.last_skip
    }

    pub fn airborne_qualified(&self) -> bool {
        self.airborne_qualified
    }

    /// The flight in progress began in the air: Preflight went straight to an airborne
    /// phase (see the module doc). Cleared when the engine is back on the blocks.
    pub fn started_airborne(&self) -> bool {
        self.started_airborne
    }

    /// Proposed next phase: (phase, since, dwell it needs, time still missing), as of the
    /// last evaluated sample.
    pub fn candidate(&self) -> Option<(FlightPhase, u64, u64, u64)> {
        self.candidate.map(|(p, since)| {
            let held = self.last_ts.unwrap_or(since).saturating_sub(since);
            (p, self.clock.to_wall(since), self.candidate_dwell_ms, self.candidate_dwell_ms.saturating_sub(held))
        })
    }

    /// Feed one sample. Returns a transition when the phase changed.
    pub fn update(&mut self, t: &Telemetry) -> Option<PhaseTransition> {
        self.last_skip = None;
        let now = self.clock.advance(t.timestamp_ms);
        if t.paused {
            self.last_skip = Some(SkipReason::Paused);
        } else if t.slew {
            self.last_skip = Some(SkipReason::Slew);
        } else if t.time_accelerated() {
            self.last_skip = Some(SkipReason::TimeAcceleration);
        }
        if self.last_skip.is_some() {
            // Hysteresis timers must not accumulate across skipped stretches.
            self.candidate = None;
            self.last_ts = Some(now);
            return None;
        }
        self.last_ts = Some(now);

        self.track_airborne(t, now);

        let desired = self.desired(t, now);
        if desired == self.phase {
            self.candidate = None;
            return None;
        }
        let since = match self.candidate {
            Some((p, since)) if p == desired => since,
            _ => {
                self.candidate = Some((desired, now));
                now
            }
        };
        self.candidate_dwell_ms = self.dwell_ms(self.phase, desired, t);
        if now.saturating_sub(since) < self.candidate_dwell_ms {
            return None;
        }
        let from = self.phase;
        self.phase = desired;
        self.candidate = None;
        self.on_enter(from, desired, t);
        Some(PhaseTransition { from, to: desired, timestamp_ms: t.timestamp_ms, telemetry: t.clone() })
    }

    fn track_airborne(&mut self, t: &Telemetry, now: u64) {
        if ground_contact_corroborated(t) {
            self.airborne_since = None;
            self.lift_off = None;
            self.seen_ground = true;
        } else {
            self.lift_off.get_or_insert(now);
            let since = *self.airborne_since.get_or_insert(now);
            if t.altitude_agl_ft > FT_AIRBORNE_QUALIFIED || now.saturating_sub(since) > self.qualify_ms {
                self.airborne_qualified = true;
                self.qualify_ms = MS_AIRBORNE_QUALIFIED;
            }
            self.max_altitude_msl_ft = self.max_altitude_msl_ft.max(t.altitude_msl_ft);
        }
    }

    fn on_enter(&mut self, from: FlightPhase, phase: FlightPhase, t: &Telemetry) {
        if from == FlightPhase::Preflight && phase.is_airborne_phase() {
            // start in the air: no take-off seen, a short stretch of air time qualifies
            self.started_airborne = true;
            if !self.airborne_qualified {
                self.qualify_ms = MS_REQUALIFY_AFTER_RESET;
            }
        }
        match phase {
            FlightPhase::Takeoff => {
                self.max_altitude_msl_ft = t.altitude_msl_ft;
                self.started_airborne = false;
                self.circuit = false;
                self.takeoff_from = if from == FlightPhase::TaxiIn { FlightPhase::TaxiIn } else { FlightPhase::TaxiOut };
            }
            FlightPhase::Climb if matches!(from, FlightPhase::Approach | FlightPhase::Final | FlightPhase::Landing) => {
                // go-around / touch-and-go: a circuit; "descending" is judged from here on
                self.circuit = true;
                self.max_altitude_msl_ft = t.altitude_msl_ft;
            }
            FlightPhase::TaxiIn | FlightPhase::Shutdown => {
                self.airborne_qualified = false;
                self.qualify_ms = MS_AIRBORNE_QUALIFIED;
                self.circuit = false;
            }
            _ => {}
        }
        if matches!(phase, FlightPhase::Shutdown | FlightPhase::Preflight) {
            self.started_airborne = false;
        }
    }

    /// Start in the air (see the module doc): the airborne phase the first sample shows.
    fn airborne_start_phase(t: &Telemetry) -> FlightPhase {
        use FlightPhase::*;
        let (vs, agl) = (t.vertical_speed_fpm, t.altitude_agl_ft);
        if vs > FPM_LEVEL {
            Climb
        } else if vs >= -FPM_LEVEL {
            Cruise
        } else if agl < FT_FINAL {
            Final
        } else if agl < FT_APPROACH {
            Approach
        } else {
            Descent
        }
    }

    fn desired(&self, t: &Telemetry, now: u64) -> FlightPhase {
        use FlightPhase::*;
        let gs = t.ground_speed_kt;
        let engines_on = t.engines_running > 0;
        let on_ground = ground_contact_corroborated(t);
        let airborne = !on_ground;
        let airborne_ms = self.airborne_since.map_or(0, |s| now.saturating_sub(s));

        // Touchdown after a real flight beats everything else. Not in Preflight: nothing has
        // flown there yet, the latch can only come from a long "not on ground" stretch at the gate.
        if on_ground && self.airborne_qualified && !matches!(self.phase, Preflight | Landing | TaxiIn | Shutdown) {
            return Landing;
        }
        // From a ground phase: a take-off roll, or real air under the wheels (see the module doc).
        let taking_off = gs > KT_TAKEOFF && (engines_on || airborne) || airborne && t.altitude_agl_ft > FT_LIFT_OFF;

        match self.phase {
            Preflight if airborne && !self.seen_ground && (t.altitude_agl_ft > FT_AIRBORNE_START || gs > KT_TAKEOFF) => {
                Self::airborne_start_phase(t)
            }
            Preflight | Shutdown => {
                if taking_off {
                    Takeoff
                } else if engines_on && gs > KT_STOPPED {
                    TaxiOut
                } else if !engines_on && !t.parking_brake && gs > 0.5 && gs <= KT_PUSHBACK_MAX {
                    Pushback
                } else {
                    self.phase
                }
            }
            Pushback => {
                if taking_off {
                    Takeoff
                } else if engines_on && gs > KT_STOPPED {
                    TaxiOut
                } else {
                    Pushback
                }
            }
            TaxiOut => {
                if taking_off {
                    Takeoff
                } else if gs < KT_STOPPED && !engines_on {
                    // back on the stand with the engines off (never flew, or phases went astray):
                    // the flight can still close. Not on the parking brake alone with engines
                    // running – holding short with the brake set can take half an hour on events.
                    Shutdown
                } else {
                    TaxiOut
                }
            }
            Takeoff => {
                if airborne && (t.altitude_agl_ft > FT_TAKEOFF_COMPLETE || airborne_ms > MS_TAKEOFF_COMPLETE) {
                    Climb
                } else if !airborne && gs < KT_TAKEOFF && !self.airborne_qualified {
                    self.takeoff_from // rejected takeoff: taxiing out again (or in)
                } else {
                    Takeoff
                }
            }
            Climb => {
                // the downwind of a circuit is no cruise
                let circuit_level = self.circuit && t.altitude_agl_ft < FT_APPROACH;
                if t.vertical_speed_fpm.abs() < FPM_LEVEL && !circuit_level {
                    Cruise
                } else if self.descending(t) {
                    Descent
                } else {
                    Climb
                }
            }
            Cruise => {
                if t.vertical_speed_fpm > FPM_LEVEL {
                    Climb
                } else if self.descending(t) {
                    Descent
                } else {
                    Cruise
                }
            }
            Descent => {
                if t.altitude_agl_ft < FT_APPROACH {
                    Approach
                } else if t.vertical_speed_fpm > FPM_LEVEL {
                    Climb
                } else if t.vertical_speed_fpm.abs() < FPM_LEVEL {
                    Cruise
                } else {
                    Descent
                }
            }
            Approach => {
                if t.vertical_speed_fpm > FPM_GO_AROUND {
                    Climb
                } else if t.altitude_agl_ft < FT_FINAL {
                    Final
                } else {
                    Approach
                }
            }
            Final => {
                if t.vertical_speed_fpm > FPM_GO_AROUND {
                    Climb
                } else {
                    Final
                }
            }
            Landing => {
                if airborne && t.altitude_agl_ft > FT_TOUCH_AND_GO {
                    Climb
                } else if !airborne && gs < KT_ROLLOUT_DONE {
                    TaxiIn
                } else {
                    Landing
                }
            }
            TaxiIn => {
                if taking_off {
                    Takeoff
                } else if gs < KT_STOPPED && (!engines_on || t.parking_brake) {
                    Shutdown
                } else {
                    TaxiIn
                }
            }
        }
    }

    fn descending(&self, t: &Telemetry) -> bool {
        t.vertical_speed_fpm < -FPM_LEVEL && t.altitude_msl_ft <= self.max_altitude_msl_ft - FT_BELOW_MAX_FOR_DESCENT
    }

    fn dwell_ms(&self, from: FlightPhase, to: FlightPhase, t: &Telemetry) -> u64 {
        use FlightPhase::*;
        match (from, to) {
            (_, Landing) => 0,
            (Preflight, to) if to.is_airborne_phase() => 0,
            (_, Takeoff) => MS_LIFT_OFF_CONFIRM,
            (Takeoff, Climb) => 0,
            (Takeoff, TaxiOut) | (Takeoff, TaxiIn) => 3_000,
            (TaxiOut, Shutdown) => MS_TAXI_OUT_SHUTDOWN,
            (Climb, Cruise) | (Descent, Cruise) => 60_000,
            (Climb, Descent) | (Cruise, Descent) | (Cruise, Climb) | (Descent, Climb) => 30_000,
            (Descent, Approach) => 5_000,
            (Approach, Final) => 3_000,
            (Approach, Climb) | (Final, Climb) | (Landing, Climb) => 10_000,
            (Landing, TaxiIn) => 3_000,
            (TaxiIn, Shutdown) if t.engines_running == 0 => MS_SHUTDOWN_ENGINES_OFF,
            (TaxiIn, Shutdown) => MS_SHUTDOWN_BRAKE_ENGINES_ON,
            _ => 2_000,
        }
    }
}
