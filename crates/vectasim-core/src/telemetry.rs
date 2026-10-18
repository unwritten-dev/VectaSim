use serde::{Deserialize, Serialize};

/// One snapshot of the user aircraft. Units are fixed here regardless of sim:
/// feet, knots, fpm, degrees, kg. Each provider converts its sim's native units
/// into these.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Telemetry {
    /// Wall-clock time the sample was received (ms since Unix epoch).
    pub timestamp_ms: u64,
    /// Sim zulu time, seconds since midnight.
    pub sim_zulu_time_s: f64,

    pub latitude: f64,
    pub longitude: f64,
    pub altitude_msl_ft: f64,
    pub altitude_agl_ft: f64,

    pub ias_kt: f64,
    pub tas_kt: f64,
    pub ground_speed_kt: f64,
    pub vertical_speed_fpm: f64,

    pub heading_mag_deg: f64,
    pub heading_true_deg: f64,
    pub pitch_deg: f64,
    pub bank_deg: f64,
    pub g_force: f64,

    pub on_ground: bool,
    /// Sim-reported normal velocity at the last touchdown, fpm (raw sign of the sim;
    /// MSFS reports positive-down). 0 until the first touchdown of the session.
    pub touchdown_vs_fpm: f64,

    pub gear_pct: f64,
    pub flaps_index: i32,
    pub num_engines: u8,
    pub engines_running: u8,
    pub fuel_total_kg: f64,
    pub total_weight_kg: f64,
    pub parking_brake: bool,

    pub sim_rate: f64,
    pub paused: bool,
    pub slew: bool,
    pub lights: Lights,
    pub transponder_code: u32,
}

impl Telemetry {
    /// Sim rate other than 1× (time acceleration or slow motion). 0 means "not reported"
    /// and counts as real time. The phase engine and the touchdown detector both skip such
    /// samples, so neither a cruise nor a landing can be faked by fast-forwarding.
    pub fn time_accelerated(&self) -> bool {
        self.sim_rate != 0.0 && (self.sim_rate - 1.0).abs() > 0.01
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Lights {
    pub beacon: bool,
    pub nav: bool,
    pub strobe: bool,
    pub landing: bool,
    pub taxi: bool,
}

/// Static aircraft identity; re-read when the sim loads a different aircraft.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AircraftInfo {
    pub title: String,
    pub atc_model: String,
    pub atc_type: String,
    pub atc_id: String,
    pub atc_airline: String,
    pub atc_flight_number: String,
}

pub const LBS_TO_KG: f64 = 0.453_592_37;
