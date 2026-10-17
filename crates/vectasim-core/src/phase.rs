//! Flight-phase state machine.
//!
//! Thresholds (based on common virtual-airline logger rule sets and NTSB phase
//! definitions):
//!
//! | transition              | condition                                              | dwell |
//! |-------------------------|--------------------------------------------------------|-------|
//! | Preflight → Pushback    | 0.5–8 kt, engines off, parking brake released          | 2 s   |
//! | Preflight → TaxiOut     | > 1 kt, engines running                                | 2 s   |
//! | ground → Takeoff        | > 40 kt on ground with engines running, or airborne    | 1 s/0 |
//! | Takeoff → Climb         | airborne and (> 1 500 ft AGL or airborne > 45 s)       | 0     |
//! | Takeoff → TaxiOut       | rejected: back below 40 kt without having flown         | 3 s   |
//! | Climb → Cruise          | \|V/S\| < 300 fpm                                      | 60 s  |
//! | Climb/Cruise → Descent  | V/S < −300 fpm and ≥ 300 ft below max altitude         | 30 s  |
//! | Cruise/Descent → Climb  | V/S > +300 fpm (step climb / go-around)                | 30 s  |
//! | Descent → Approach      | < 4 000 ft AGL                                          | 5 s   |
//! | Approach → Final        | < 1 500 ft AGL                                          | 3 s   |
//! | Approach/Final → Climb  | go-around: V/S > +500 fpm                              | 10 s  |
//! | airborne → Landing      | on ground after having been airborne (> 500 ft or 60 s)| 0     |
//! | Landing → TaxiIn        | < 35 kt                                                | 3 s   |
//! | Landing → Climb         | touch-and-go: airborne again and > 50 ft AGL           | 10 s  |
//! | TaxiIn → Shutdown       | < 1 kt and engines off (5 s) or parking brake (60 s)   |       |
//! | Shutdown → TaxiOut/Pushback | moving again (next leg)                            | 2 s   |
//!
//! "On ground" is the sim flag corroborated like the touchdown detector does it
//! ([`ground_contact_corroborated`]: only believed at ≤ 50 ft AGL, or ≤ 200 kt GS
//! without a usable AGL), so a spurious on-ground sample at altitude can neither
//! fire Landing nor reset the airborne tracking.
//!
//! Dwell = how long the condition must hold continuously before the transition
//! fires. Time-based rather than sample-based so the engine behaves the same at
//! 1 Hz and at 20 Hz. Samples taken while paused, slewing or with sim rate ≠ 1
//! are ignored (reported through `last_skip`) so time acceleration cannot fake
//! a cruise or a landing.

use crate::Telemetry;
use crate::touchdown::ground_contact_corroborated;
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
const FT_AIRBORNE_QUALIFIED: f64 = 500.0;
const MS_AIRBORNE_QUALIFIED: u64 = 60_000;
const MS_TAKEOFF_COMPLETE: u64 = 45_000;
const FPM_LEVEL: f64 = 300.0;
const FPM_GO_AROUND: f64 = 500.0;
const FT_BELOW_MAX_FOR_DESCENT: f64 = 300.0;

#[derive(Debug)]
pub struct PhaseEngine {
    phase: FlightPhase,
    /// Proposed next phase and since when its condition has held.
    candidate: Option<(FlightPhase, u64)>,
    last_ts: Option<u64>,
    airborne_since: Option<u64>,
    /// Set once the aircraft was clearly flying (> 500 ft AGL or > 60 s); gates Landing.
    airborne_qualified: bool,
    max_altitude_msl_ft: f64,
    last_skip: Option<SkipReason>,
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
            airborne_qualified: false,
            max_altitude_msl_ft: f64::MIN,
            last_skip: None,
        }
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

    /// Feed one sample. Returns a transition when the phase changed.
    pub fn update(&mut self, t: &Telemetry) -> Option<PhaseTransition> {
        self.last_skip = None;
        let now = t.timestamp_ms;
        if t.paused {
            self.last_skip = Some(SkipReason::Paused);
        } else if t.slew {
            self.last_skip = Some(SkipReason::Slew);
        } else if t.sim_rate != 0.0 && (t.sim_rate - 1.0).abs() > 0.01 {
            self.last_skip = Some(SkipReason::TimeAcceleration);
        } else if self.last_ts.is_some_and(|last| now < last) {
            self.last_skip = Some(SkipReason::ClockWentBackwards);
        }
        if self.last_skip.is_some() {
            // Hysteresis timers must not accumulate across skipped stretches.
            self.candidate = None;
            self.last_ts = Some(now.max(self.last_ts.unwrap_or(0)));
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
        if now - since < self.dwell_ms(self.phase, desired, t) {
            return None;
        }
        let from = self.phase;
        self.phase = desired;
        self.candidate = None;
        self.on_enter(desired, t);
        Some(PhaseTransition { from, to: desired, timestamp_ms: now, telemetry: t.clone() })
    }

    fn track_airborne(&mut self, t: &Telemetry, now: u64) {
        if ground_contact_corroborated(t) {
            self.airborne_since = None;
        } else {
            let since = *self.airborne_since.get_or_insert(now);
            if t.altitude_agl_ft > FT_AIRBORNE_QUALIFIED || now - since > MS_AIRBORNE_QUALIFIED {
                self.airborne_qualified = true;
            }
            self.max_altitude_msl_ft = self.max_altitude_msl_ft.max(t.altitude_msl_ft);
        }
    }

    fn on_enter(&mut self, phase: FlightPhase, t: &Telemetry) {
        match phase {
            FlightPhase::Takeoff => self.max_altitude_msl_ft = t.altitude_msl_ft,
            FlightPhase::TaxiIn | FlightPhase::Shutdown => self.airborne_qualified = false,
            _ => {}
        }
    }

    fn desired(&self, t: &Telemetry, now: u64) -> FlightPhase {
        use FlightPhase::*;
        let gs = t.ground_speed_kt;
        let engines_on = t.engines_running > 0;
        let on_ground = ground_contact_corroborated(t);
        let airborne = !on_ground;
        let airborne_ms = self.airborne_since.map_or(0, |s| now.saturating_sub(s));

        // Touchdown after a real flight beats everything else.
        if on_ground && self.airborne_qualified && !matches!(self.phase, Landing | TaxiIn | Shutdown) {
            return Landing;
        }

        match self.phase {
            Preflight | Shutdown => {
                if airborne || gs > KT_TAKEOFF && engines_on {
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
                if airborne || gs > KT_TAKEOFF && engines_on {
                    Takeoff
                } else if engines_on && gs > KT_STOPPED {
                    TaxiOut
                } else {
                    Pushback
                }
            }
            TaxiOut => {
                if airborne || gs > KT_TAKEOFF && engines_on {
                    Takeoff
                } else {
                    TaxiOut
                }
            }
            Takeoff => {
                if airborne && (t.altitude_agl_ft > FT_TAKEOFF_COMPLETE || airborne_ms > MS_TAKEOFF_COMPLETE) {
                    Climb
                } else if !airborne && gs < KT_TAKEOFF && !self.airborne_qualified {
                    TaxiOut // rejected takeoff
                } else {
                    Takeoff
                }
            }
            Climb => {
                if t.vertical_speed_fpm.abs() < FPM_LEVEL {
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
                if airborne || gs > KT_TAKEOFF && engines_on {
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
            (_, Takeoff) if !ground_contact_corroborated(t) => 0,
            (_, Takeoff) => 1_000,
            (Takeoff, Climb) => 0,
            (Takeoff, TaxiOut) => 3_000,
            (Climb, Cruise) | (Descent, Cruise) => 60_000,
            (Climb, Descent) | (Cruise, Descent) | (Cruise, Climb) | (Descent, Climb) => 30_000,
            (Descent, Approach) => 5_000,
            (Approach, Final) => 3_000,
            (Approach, Climb) | (Final, Climb) | (Landing, Climb) => 10_000,
            (Landing, TaxiIn) => 3_000,
            (TaxiIn, Shutdown) if t.engines_running == 0 => 5_000,
            (TaxiIn, Shutdown) => 60_000,
            _ => 2_000,
        }
    }
}
