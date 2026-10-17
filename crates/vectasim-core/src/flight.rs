//! `FlightSession` wires the phase engine and touchdown detector together and
//! keeps a running `FlightSummary` (times, positions, distance, fuel, integrity
//! flags). No persistence yet – that is the recorder's job later.

use crate::phase::{FlightPhase, PhaseEngine, PhaseTransition, SkipReason};
use crate::touchdown::{TouchdownDetector, TouchdownReport};
use crate::Telemetry;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlightState {
    #[default]
    Idle,
    Active,
    Completed,
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
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightSummary {
    pub state: FlightState,
    pub phase: FlightPhase,
    pub off_block_ms: Option<u64>,
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
    PhaseChanged(PhaseTransition),
    Touchdown(TouchdownReport),
    FlightEnded { timestamp_ms: u64 },
}

#[derive(Debug, Default)]
pub struct FlightSession {
    engine: PhaseEngine,
    detector: TouchdownDetector,
    summary: FlightSummary,
    last_pos: Option<(u64, GeoPoint)>,
    last_fuel_kg: Option<f64>,
    pause_started_ms: Option<u64>,
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

    pub fn mark_crashed(&mut self) {
        self.summary.integrity.crashed = true;
    }

    /// Feed one sample at any rate; returns the events it produced (usually none).
    pub fn update(&mut self, t: &Telemetry) -> Vec<FlightEvent> {
        let mut events = Vec::new();

        if let Some(report) = self.detector.update(t) {
            if !report.touch_and_go {
                self.summary.landing_rate_fpm = Some(report.landing_rate_fpm);
            }
            self.summary.touchdowns.push(report.clone());
            events.push(FlightEvent::Touchdown(report));
        }

        let transition = self.engine.update(t);
        self.note_integrity(t);

        if let Some(tr) = transition {
            // Order matters for consumers: FlightStarted → PhaseChanged → FlightEnded,
            // so a recorder sees the Shutdown transition while the flight is still open.
            let (started, ended) = self.apply_transition(&tr);
            if let Some(e) = started {
                events.push(e);
            }
            events.push(FlightEvent::PhaseChanged(tr));
            if let Some(e) = ended {
                events.push(e);
            }
        }
        self.summary.phase = self.engine.phase();

        if self.summary.state == FlightState::Active && self.engine.last_skip().is_none() {
            self.accumulate(t);
        }
        events
    }

    /// Applies a phase transition to the summary; returns the flight start/end events it implies.
    fn apply_transition(&mut self, tr: &PhaseTransition) -> (Option<FlightEvent>, Option<FlightEvent>) {
        use FlightPhase::*;
        let t = &tr.telemetry;
        let mut started = None;
        let mut ended = None;
        let leaving_blocks = matches!(tr.from, Preflight | Shutdown) && !matches!(tr.to, Preflight | Shutdown);
        if leaving_blocks {
            self.start_flight(t);
            started = Some(FlightEvent::FlightStarted { timestamp_ms: tr.timestamp_ms });
        }
        match tr.to {
            Climb if self.summary.takeoff_ms.is_none() => {
                // Takeoff phase begins on the roll; "takeoff time" is lift-off, i.e. entering Climb.
                self.summary.takeoff_ms = Some(tr.timestamp_ms);
            }
            Landing => {
                self.summary.landing_ms = Some(tr.timestamp_ms);
                self.summary.arrival = Some(GeoPoint { latitude: t.latitude, longitude: t.longitude });
            }
            Shutdown => {
                self.summary.on_block_ms = Some(tr.timestamp_ms);
                self.summary.fuel_end_kg = Some(t.fuel_total_kg);
                if self.summary.state == FlightState::Active {
                    self.summary.state = FlightState::Completed;
                    ended = Some(FlightEvent::FlightEnded { timestamp_ms: tr.timestamp_ms });
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
    }

    fn accumulate(&mut self, t: &Telemetry) {
        let s = &mut self.summary;
        s.max_altitude_msl_ft = s.max_altitude_msl_ft.max(t.altitude_msl_ft);
        let here = GeoPoint { latitude: t.latitude, longitude: t.longitude };
        // integrate distance at ≤ 1 Hz to keep jitter out of the sum
        match self.last_pos {
            Some((ts, _)) if t.timestamp_ms.saturating_sub(ts) < 1_000 => {}
            Some((_, p)) => {
                s.distance_nm += haversine_nm(p, here);
                self.last_pos = Some((t.timestamp_ms, here));
            }
            None => self.last_pos = Some((t.timestamp_ms, here)),
        }
        if let Some(prev) = self.last_fuel_kg
            && !t.on_ground && t.fuel_total_kg > prev + 1.0 {
                s.integrity.fuel_increased_airborne = true;
            }
        self.last_fuel_kg = Some(t.fuel_total_kg);
    }

    fn note_integrity(&mut self, t: &Telemetry) {
        let i = &mut self.summary.integrity;
        i.max_sim_rate = i.max_sim_rate.max(t.sim_rate);
        match self.engine.last_skip() {
            Some(SkipReason::Paused) => {
                if self.pause_started_ms.is_none() {
                    self.pause_started_ms = Some(t.timestamp_ms);
                    i.pause_count += 1;
                }
            }
            Some(SkipReason::Slew) => i.slew_detected = true,
            Some(SkipReason::TimeAcceleration) => i.time_acceleration_detected = true,
            _ => {
                if let Some(start) = self.pause_started_ms.take() {
                    i.paused_ms += t.timestamp_ms.saturating_sub(start);
                }
            }
        }
    }
}

pub fn haversine_nm(a: GeoPoint, b: GeoPoint) -> f64 {
    const R_NM: f64 = 3_440.065;
    let (lat1, lat2) = (a.latitude.to_radians(), b.latitude.to_radians());
    let dlat = lat2 - lat1;
    let dlon = (b.longitude - a.longitude).to_radians();
    let h = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * R_NM * h.sqrt().asin()
}
