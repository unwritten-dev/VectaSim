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

    // ---- approach data (track v2, SimConnect `DEF_APPROACH` 1 Hz / `DEF_DESIGN` once) ----
    // `None` = not delivered (variable unknown to the sim, provider without it, old dump).
    // Skipped in JSON when absent so the 10 Hz IPC stream stays small.
    /// `AMBIENT WIND DIRECTION`: true direction the wind blows from at the aircraft, °.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wind_dir_true_deg: Option<f64>,
    /// `AMBIENT WIND VELOCITY`, kt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wind_kt: Option<f64>,
    /// `NAV HAS LOCALIZER:1` / `NAV HAS GLIDE SLOPE:1`: the tuned NAV 1 station has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nav_has_localizer: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nav_has_glide_slope: Option<bool>,
    /// `NAV GS FLAG:1` as delivered (meaning "glideslope received/valid" – to be confirmed on the sim PC).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nav_gs_flag: Option<bool>,
    /// `NAV GLIDE SLOPE ERROR:1`, ° – only while `nav_has_glide_slope` is true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nav_gs_error_deg: Option<f64>,
    /// `NAV RAW GLIDE SLOPE:1`: published glideslope angle, ° – only with a glideslope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nav_gs_angle_deg: Option<f64>,
    /// `NAV CDI:1`, raw needle −127…+127 – only while `nav_has_localizer` is true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nav_cdi: Option<f64>,
    /// `NAV RADIAL ERROR:1`, ° – only with a localizer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nav_radial_error_deg: Option<f64>,
    /// `NAV LOCALIZER:1`: localizer course, ° – only with a localizer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nav_loc_course_deg: Option<f64>,
    /// `AUTOPILOT MASTER`, `AUTOPILOT APPROACH HOLD`, `AUTOPILOT GLIDESLOPE HOLD` (default
    /// autopilot; most airliner add-ons do not fill them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autopilot_master: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autopilot_approach_hold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autopilot_glideslope_hold: Option<bool>,
    /// `AUTOPILOT MANAGED THROTTLE ACTIVE` or `AUTOPILOT THROTTLE ARM` (there is no
    /// `AUTOTHROTTLE ACTIVE` SimVar).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autothrottle_active: Option<bool>,
    /// Mean of `TURB ENG N1:1..2` over the reported engines, %.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub n1_pct: Option<f64>,
    /// `GENERAL ENG THROTTLE LEVER POSITION:1`, %.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub throttle_lever_pct: Option<f64>,
    /// `SPOILERS HANDLE POSITION`, % (0–100).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spoilers_handle_pct: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spoilers_armed: Option<bool>,
    /// `SPOILERS LEFT POSITION`: deployed surface, % (physical, more reliable than the handle).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spoilers_pct: Option<f64>,
    /// `INCIDENCE ALPHA`, °.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpha_deg: Option<f64>,
    /// `FLAPS NUM HANDLE POSITIONS` (the last index, n − 1, is the landing flap setting).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flap_positions: Option<i32>,
    /// `DESIGN SPEED VS0` / `VS1` / `VC` (aircraft.cfg constants, weight-independent), kt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design_vs0_kt: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design_vs1_kt: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design_vc_kt: Option<f64>,
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
