//! Approach assessment: every approach of a flight, from the top of descent down to
//! the touchdown or the go-around, on the stored 1 Hz track.
//!
//! Pure functions like [`crate::landing`]: facts plus a band/status per value, the
//! source of every reference named, no score. `landing::analyze` keeps its 1000 ft
//! window; this module covers the approach before it and down to the ground.
//!
//! Criteria and thresholds follow the EASA/Data4Safety "unstable approach" guidance
//! (two levels S1/S2, each with a minimum duration; 1–2 criteria above the hard gate =
//! "deviations", ≥ 3 above it = "unstable", ≥ 1 below it = "unstable below the hard
//! gate"; the hard gate is `ApproachConfig::hard_gate_ft`, 500 ft by default). Gate checks
//! use the FSF stabilised-approach values (±1 dot, 1000 fpm, Vref −5/+20); the 15° gate
//! bank limit is not FSF (BN 7.1 has no bank number) but the D4S S1 level / FAA AFH ch. 9.
//! Sources: EASA SIB 2013-03 / Data4Safety / Flight Safety Foundation ALAR briefing notes;
//! the values and their sources per assessment profile: `docs/approach-profiles-sources.md`,
//! the profiles themselves: [`crate::approach_profile`].
//!
//! Reference speed: the D4S speed levels are defined against VREF; VectaSim applies them
//! (and the gate window) to the approach speed Vapp (the pilot's, the flown median or
//! `vapp_vs0_factor` × VS0), which is about VREF + 5 kt. That is a VectaSim convention.
//!
//! Conventions:
//! - Heights are HAT (height above the touchdown/threshold elevation, see
//!   [`ElevationSource`]), ft. V/S negative = descending. Speeds kt.
//! - Runway frame as in `landing`: x along the runway from the threshold (negative =
//!   before it), y right of the centreline (positive = right), metres.
//! - `track_dist_m`: flown path distance still to go to the threshold (with runway) or
//!   to the touchdown point / lowest point (without), metres; monotonic.
//! - Glidepath and localizer deviations in "dots": positive = above / right of the path.
//! - `None` = not measurable (no runway, no reference speed, never reached) – never "failed".
//! - Durations are whole 1 Hz samples: a run of n samples lasts n seconds.

use crate::landing::{
    CheckStatus, Criterion, CriterionKind, EARTH_R_M, LandingConfig, LandingSample, M_PER_FT, M_PER_NM, RunwayEnd, RunwayFrame, RunwayGeometry,
    RunwayMatch, angle_diff_deg, criterion, distance_m, lerp, match_runway, median,
};
use crate::{FlightPhase, TouchdownReport};
use serde::{Deserialize, Serialize};

const G_FT_S2: f64 = 32.174;
const FT_S_PER_KT: f64 = 1.687_81;

/// Bits of [`ApproachSample::nav_flags`] (track v2; always 0 for v1 tracks).
pub mod nav_flags {
    pub const HAS_LOCALIZER: u8 = 1 << 0;
    pub const HAS_GLIDE_SLOPE: u8 = 1 << 1;
    pub const GLIDE_SLOPE_VALID: u8 = 1 << 2;
    pub const AUTOPILOT_MASTER: u8 = 1 << 3;
    pub const APPROACH_HOLD: u8 = 1 << 4;
    pub const GLIDE_SLOPE_HOLD: u8 = 1 << 5;
    pub const AUTOTHRUST: u8 = 1 << 6;
    pub const SPOILERS_ARMED: u8 = 1 << 7;
}

// ---- input ----------------------------------------------------------------------------

/// One 1 Hz track sample: the fields of [`LandingSample`] plus optional values a later
/// track version may record (all `None`/0 for today's v1 tracks).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproachSample {
    pub t_ms: u64,
    pub latitude: f64,
    pub longitude: f64,
    pub altitude_msl_ft: f64,
    pub altitude_agl_ft: f64,
    pub ground_speed_kt: f64,
    pub ias_kt: f64,
    pub vertical_speed_fpm: f64,
    pub heading_true_deg: f64,
    pub pitch_deg: f64,
    pub bank_deg: f64,
    pub g_force: f64,
    pub on_ground: bool,
    pub flaps_index: i32,
    pub gear_pct: f64,
    /// Recorded TAS; None = derive from IAS and altitude (ISA).
    #[serde(default)]
    pub tas_kt: Option<f64>,
    /// Wind at the aircraft (true direction it blows from), kt.
    #[serde(default)]
    pub wind_dir_true_deg: Option<f64>,
    #[serde(default)]
    pub wind_kt: Option<f64>,
    /// ILS deviations, only when valid.
    #[serde(default)]
    pub gs_error_deg: Option<f64>,
    #[serde(default)]
    pub loc_cdi: Option<f64>,
    /// Published glideslope angle of the tuned ILS (`NAV RAW GLIDE SLOPE`), °.
    #[serde(default)]
    pub gs_angle_deg: Option<f64>,
    /// See [`nav_flags`].
    #[serde(default)]
    pub nav_flags: u8,
    /// The sim delivered the ILS/automation state for this sample (track v2): `nav_flags` = 0
    /// then means "all off", not "not recorded".
    #[serde(default)]
    pub nav_recorded: bool,
    #[serde(default)]
    pub n1_pct: Option<f64>,
    #[serde(default)]
    pub spoilers_pct: Option<f64>,
    #[serde(default)]
    pub alpha_deg: Option<f64>,
}

impl From<&LandingSample> for ApproachSample {
    fn from(s: &LandingSample) -> Self {
        Self {
            t_ms: s.t_ms,
            latitude: s.latitude,
            longitude: s.longitude,
            altitude_msl_ft: s.altitude_msl_ft,
            altitude_agl_ft: s.altitude_agl_ft,
            ground_speed_kt: s.ground_speed_kt,
            ias_kt: s.ias_kt,
            vertical_speed_fpm: s.vertical_speed_fpm,
            heading_true_deg: s.heading_true_deg,
            pitch_deg: s.pitch_deg,
            bank_deg: s.bank_deg,
            g_force: s.g_force,
            on_ground: s.on_ground,
            flaps_index: s.flaps_index,
            gear_pct: s.gear_pct,
            ..Default::default()
        }
    }
}

/// A flight-phase transition (table `phase_events`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseMark {
    pub from: FlightPhase,
    pub to: FlightPhase,
    pub t_ms: u64,
}

/// What is known about the aircraft; everything optional.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AircraftRef {
    /// `DESIGN SPEED VS0` (stall speed, landing configuration), KIAS – plausibility only.
    pub vs0_kt: Option<f64>,
    /// `FLAPS NUM HANDLE POSITIONS`; the last index (n − 1) is taken as landing flaps.
    pub flap_positions: Option<i32>,
    /// Pilot's Vapp for this type/airframe, KIAS.
    pub vapp_kt: Option<f64>,
    /// Pilot's landing flap handle index for this airframe (fleet); wins over `flap_positions`.
    #[serde(default)]
    pub landing_flaps_index: Option<i32>,
}

/// Thresholds. Defaults: EASA/D4S levels for the continuous checks, FSF values at the gates
/// (the "generic" assessment profile; the other profiles change a few of them, see
/// [`crate::approach_profile`]).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproachConfig {
    /// Assessment profile these thresholds come from (`generic` = this default).
    #[serde(default = "d_profile_id")]
    pub profile_id: String,
    /// Reference glidepath (assumed; no procedure data) and its threshold crossing height.
    pub glidepath_deg: f64,
    pub tch_ft: f64,
    /// One glideslope dot.
    pub gs_dot_deg: f64,
    pub gs_s1_dots: f64,
    pub gs_s2_dots: f64,
    pub gs_duration_s: f64,
    /// The glidepath is not evaluated below this HAT (deviations grow near the threshold).
    pub gs_floor_ft: f64,
    /// Localizer proxy: one dot = this many metres at the threshold, seen from a virtual
    /// antenna this far beyond the runway end.
    pub loc_dot_m_at_threshold: f64,
    pub loc_antenna_beyond_end_m: f64,
    pub loc_s1_dots: f64,
    pub loc_s2_dots: f64,
    pub loc_duration_s: f64,
    /// Lateral guidance band ([`LateralBand`]) over the band window 1000 → 50 ft, in
    /// localizer dots. FSF ALAR uses ±1 dot only as the gate limit; the finer steps are a
    /// VectaSim convention: "on the centreline" = RMS ≤ `lat_band_on_rms_dots` and
    /// |max| ≤ `lat_band_on_max_dots`; "slight" = RMS ≤ `lat_band_slight_rms_dots` and
    /// |max| ≤ `lat_band_slight_max_dots` (the FSF gate); "marked" beyond.
    #[serde(default = "d_lat_on_rms")]
    pub lat_band_on_rms_dots: f64,
    #[serde(default = "d_lat_on_max")]
    pub lat_band_on_max_dots: f64,
    #[serde(default = "d_lat_slight_rms")]
    pub lat_band_slight_rms_dots: f64,
    #[serde(default = "d_lat_slight_max")]
    pub lat_band_slight_max_dots: f64,
    /// "S-turns": sign changes of the lateral offset between `window_top_ft` and this HAT,
    /// counting only offsets beyond `lat_reversal_dots` (VectaSim convention).
    #[serde(default = "d_lat_reversal_dots")]
    pub lat_reversal_dots: f64,
    #[serde(default = "d_lat_reversal_floor")]
    pub lat_reversal_floor_ft: f64,
    /// Intercept overshoot: the largest offset on the far side within this many seconds
    /// after "established"; the side flown in from is the last offset beyond
    /// `lat_reversal_dots` up to `lat_intercept_lookback_s` before it. Below
    /// `lat_overshoot_min_dots` it counts as a clean intercept (None).
    #[serde(default = "d_lat_intercept_window")]
    pub lat_intercept_window_s: f64,
    #[serde(default = "d_lat_intercept_lookback")]
    pub lat_intercept_lookback_s: f64,
    #[serde(default = "d_lat_overshoot_min")]
    pub lat_overshoot_min_dots: f64,
    /// Speed window around the reference speed, kt (S1/S2 above and below). D4S defines the
    /// levels against VREF; VectaSim applies them to Vapp (≈ VREF + 5 kt), a VectaSim convention.
    pub speed_s1_above_kt: f64,
    pub speed_s1_below_kt: f64,
    pub speed_s2_above_kt: f64,
    pub speed_s2_below_kt: f64,
    pub speed_duration_s: f64,
    /// Sink rate limits (positive numbers, fpm descending) and their durations.
    pub vs_s1_fpm: f64,
    pub vs_s1_duration_s: f64,
    pub vs_s2_fpm: f64,
    pub vs_s2_duration_s: f64,
    pub bank_s1_deg: f64,
    pub bank_s2_deg: f64,
    pub bank_duration_s: f64,
    /// Gear down = at least this %.
    pub gear_down_pct: f64,
    /// Below this HAT the gear must be down and the flaps must not change; gates above it
    /// (the 1000 ft gate with a 500 ft configuration gate) do not check gear and flaps.
    pub config_gate_ft: f64,
    /// Hard gate: one exceedance below this HAT makes the approach "unstable below the hard
    /// gate" (EASA/D4S: 500 ft; FAA AFH ch. 9 for light aircraft in the pattern: 300 ft). The
    /// gate list keeps its fixed 1000/500 ft gates.
    #[serde(default = "d_hard_gate_ft")]
    pub hard_gate_ft: f64,
    /// Excursions shorter than this never count ("momentary excursions").
    pub momentary_s: f64,
    /// Band window: from this HAT down to `window_bottom_ft`.
    pub window_top_ft: f64,
    pub window_bottom_ft: f64,
    /// "Stable from" is searched below this HAT, rounded down to `stable_round_ft`.
    pub stable_from_max_ft: f64,
    pub stable_round_ft: f64,
    /// Gate values: |V/S| (FSF BN 7.1, 1000 fpm), speed window (FSF VREF … VREF + 20 applied to
    /// Vapp as −5/+20), glidepath/localizer dots (FSF ±1 dot) and bank (15°: EASA Data4Safety S1 /
    /// FAA AFH ch. 9 – FSF BN 7.1 gives no bank number).
    pub gate_max_vs_fpm: f64,
    pub gate_speed_below_kt: f64,
    pub gate_speed_above_kt: f64,
    pub gate_dots: f64,
    pub gate_max_bank_deg: f64,
    /// 10 nm gate: height window around the reference path, IAS limit, energy excess limit.
    pub ten_nm_alt_tolerance_ft: f64,
    pub ten_nm_max_ias_kt: f64,
    pub ten_nm_max_energy_ft: f64,
    /// FAF proxy: whichever comes first, this distance to the threshold or this HAT.
    pub faf_dist_nm: f64,
    pub faf_hat_ft: f64,
    pub faf_alt_tolerance_ft: f64,
    pub faf_speed_above_kt: f64,
    pub faf_speed_below_kt: f64,
    /// Flown Vapp: median IAS between these HATs.
    pub vapp_from_ft: f64,
    pub vapp_to_ft: f64,
    /// A Vapp outside these multiples of VS0 is flagged implausible.
    pub vapp_min_vs0: f64,
    pub vapp_max_vs0: f64,
    /// Stability statistics: share of time outside this window around the reference.
    pub stats_speed_below_kt: f64,
    pub stats_speed_above_kt: f64,
    /// Go-around: airborne below this AGL, then at least this climb within the window …
    pub ga_max_agl_ft: f64,
    pub ga_min_climb_ft: f64,
    pub ga_window_s: f64,
    /// … after a descent of at least this much in the `ga_lookback_s` before the lowest point.
    pub ga_min_descent_ft: f64,
    pub ga_lookback_s: f64,
    /// Go-around from the phase engine only: climb from the lowest point at least this.
    pub ga_phase_min_climb_ft: f64,
    /// The last seconds before a go-around's lowest point belong to the manoeuvre (pitch-up,
    /// flap retraction), not to the approach: the continuous checks end this much earlier.
    pub ga_exclude_s: f64,
    /// Runway match (touchdown: like `landing`; go-around: median |y| within this).
    pub match_lateral_m: f64,
    pub match_heading_deg: f64,
    /// Go-around runway match uses the last this-many metres before the lowest point …
    pub match_path_m: f64,
    /// … below this AGL, and the lowest point must be within this of the threshold.
    pub match_max_agl_ft: f64,
    pub match_max_dist_m: f64,
    /// "Established on final": track within this of the runway direction and |y| within
    /// max(`established_min_m`, `established_ratio` × |x|) all the way to the threshold.
    pub established_track_deg: f64,
    pub established_min_m: f64,
    pub established_ratio: f64,
    /// Assessment starts at whichever is later: this track distance or this HAT.
    pub assess_from_nm: f64,
    pub assess_from_ft: f64,
    /// Profile thinning: full rate below this HAT, else one point per `profile_sparse_s`.
    pub profile_dense_below_ft: f64,
    pub profile_sparse_s: f64,
    /// Profile continues this long past the touchdown.
    pub profile_after_touchdown_s: f64,
    /// Statistics need at least this many samples.
    pub min_stat_samples: usize,

    // ---- track v2 (stage 2); serde defaults for configs serialised before ----
    /// The sim's ILS is the reference when it was received over at least this share of the
    /// samples (glideslope: valid 1000 → 200 ft; localizer: present 1000 → 50 ft).
    #[serde(default = "d_ils_min_share")]
    pub ils_min_share: f64,
    /// `NAV CDI` ±127 = this many localizer dots (EFIS scale: full scale = 2 dots ≈ ±105 m at
    /// the threshold, ICAO Annex 10 course sector).
    #[serde(default = "d_loc_full_scale_dots")]
    pub loc_full_scale_dots: f64,
    /// Sim ILS and geometry are compared by the median |difference| over the window: above
    /// this a hint (check the runway coordinates) …
    #[serde(default = "d_ils_mismatch_dots")]
    pub ils_mismatch_dots: f64,
    /// … above these the sim's ILS does not belong to this runway (other ILS tuned) and the
    /// geometry is used (glideslope ±1° to the geometry).
    #[serde(default = "d_ils_reject_gs_deg")]
    pub ils_reject_gs_deg: f64,
    #[serde(default = "d_ils_reject_loc_dots")]
    pub ils_reject_loc_dots: f64,
    /// Wind in the final 1000 → 50 ft (sim wind at the aircraft), hints only (VectaSim
    /// convention): tailwind and crosswind of the median, shear = vector change 1000 ft →
    /// threshold (FSF ALAR BN 5.4 for the concept).
    #[serde(default = "d_wind_tailwind_kt")]
    pub wind_tailwind_kt: f64,
    #[serde(default = "d_wind_crosswind_kt")]
    pub wind_crosswind_kt: f64,
    #[serde(default = "d_wind_shear_kt")]
    pub wind_shear_kt: f64,
    /// Thrust above idle (FSF BN 7.1 "not below the minimum approach power"): N1 at least
    /// this below the configuration gate, for `thrust_duration_s`, down to `thrust_floor_ft`
    /// (the retard before the touchdown does not count). VectaSim convention for the value.
    #[serde(default = "d_thrust_min_n1")]
    pub thrust_min_n1_pct: f64,
    /// The thrust check runs at all (false for turboprops: their gas-generator N1 stays high at
    /// flight idle, so an N1 floor says nothing).
    #[serde(default = "d_thrust_check")]
    pub thrust_check: bool,
    #[serde(default = "d_thrust_duration")]
    pub thrust_duration_s: f64,
    #[serde(default = "d_thrust_floor")]
    pub thrust_floor_ft: f64,
    /// N1 counts as recorded only when it exceeded this somewhere in the approach (piston
    /// aircraft deliver 0 throughout).
    #[serde(default = "d_n1_valid_min")]
    pub n1_valid_min_pct: f64,
    /// Spoilers retracted in the final (FSF BN 7.1): deployed surface at most this, %.
    #[serde(default = "d_spoilers_max")]
    pub spoilers_max_pct: f64,
    /// Energy band 10 nm → 1000 ft (VectaSim convention): "high" when the excess reached
    /// this, "low" when the deficit reached `energy_band_low_ft`.
    #[serde(default = "d_energy_band_high")]
    pub energy_band_high_ft: f64,
    #[serde(default = "d_energy_band_low")]
    pub energy_band_low_ft: f64,
    /// Last step of the Vapp cascade: this × `DESIGN SPEED VS0` (1.3 × VS0 ≈ Vref, CS 25.125).
    #[serde(default = "d_vapp_vs0_factor")]
    pub vapp_vs0_factor: f64,
}

impl Default for ApproachConfig {
    fn default() -> Self {
        Self {
            profile_id: d_profile_id(),
            glidepath_deg: 3.0,
            tch_ft: 50.0,
            gs_dot_deg: 0.35,
            gs_s1_dots: 1.0,
            gs_s2_dots: 2.0,
            gs_duration_s: 5.0,
            gs_floor_ft: 200.0,
            loc_dot_m_at_threshold: 52.0,
            loc_antenna_beyond_end_m: 300.0,
            loc_s1_dots: 1.0,
            loc_s2_dots: 1.5,
            loc_duration_s: 5.0,
            lat_band_on_rms_dots: d_lat_on_rms(),
            lat_band_on_max_dots: d_lat_on_max(),
            lat_band_slight_rms_dots: d_lat_slight_rms(),
            lat_band_slight_max_dots: d_lat_slight_max(),
            lat_reversal_dots: d_lat_reversal_dots(),
            lat_reversal_floor_ft: d_lat_reversal_floor(),
            lat_intercept_window_s: d_lat_intercept_window(),
            lat_intercept_lookback_s: d_lat_intercept_lookback(),
            lat_overshoot_min_dots: d_lat_overshoot_min(),
            speed_s1_above_kt: 20.0,
            speed_s1_below_kt: 5.0,
            speed_s2_above_kt: 35.0,
            speed_s2_below_kt: 10.0,
            speed_duration_s: 3.0,
            vs_s1_fpm: 1200.0,
            vs_s1_duration_s: 5.0,
            vs_s2_fpm: 1500.0,
            vs_s2_duration_s: 3.0,
            bank_s1_deg: 15.0,
            bank_s2_deg: 30.0,
            bank_duration_s: 3.0,
            gear_down_pct: 95.0,
            config_gate_ft: 1000.0,
            hard_gate_ft: d_hard_gate_ft(),
            momentary_s: 3.0,
            window_top_ft: 1000.0,
            window_bottom_ft: 50.0,
            stable_from_max_ft: 1500.0,
            stable_round_ft: 50.0,
            gate_max_vs_fpm: 1000.0,
            gate_speed_below_kt: 5.0,
            gate_speed_above_kt: 20.0,
            gate_dots: 1.0,
            gate_max_bank_deg: 15.0,
            ten_nm_alt_tolerance_ft: 500.0,
            ten_nm_max_ias_kt: 250.0,
            ten_nm_max_energy_ft: 1000.0,
            faf_dist_nm: 5.0,
            faf_hat_ft: 1500.0,
            faf_alt_tolerance_ft: 300.0,
            faf_speed_above_kt: 40.0,
            faf_speed_below_kt: 5.0,
            vapp_from_ft: 500.0,
            vapp_to_ft: 100.0,
            vapp_min_vs0: 1.1,
            vapp_max_vs0: 1.6,
            stats_speed_below_kt: 5.0,
            stats_speed_above_kt: 10.0,
            ga_max_agl_ft: 1500.0,
            ga_min_climb_ft: 400.0,
            ga_window_s: 60.0,
            ga_min_descent_ft: 200.0,
            ga_lookback_s: 120.0,
            ga_phase_min_climb_ft: 200.0,
            ga_exclude_s: 5.0,
            match_lateral_m: M_PER_NM,
            match_heading_deg: 30.0,
            match_path_m: 3.0 * M_PER_NM,
            match_max_agl_ft: 1500.0,
            match_max_dist_m: 5.0 * M_PER_NM,
            established_track_deg: 10.0,
            established_min_m: 150.0,
            established_ratio: 0.03,
            assess_from_nm: 15.0,
            assess_from_ft: 5000.0,
            profile_dense_below_ft: 3000.0,
            profile_sparse_s: 5.0,
            profile_after_touchdown_s: 10.0,
            min_stat_samples: 5,
            ils_min_share: d_ils_min_share(),
            loc_full_scale_dots: d_loc_full_scale_dots(),
            ils_mismatch_dots: d_ils_mismatch_dots(),
            ils_reject_gs_deg: d_ils_reject_gs_deg(),
            ils_reject_loc_dots: d_ils_reject_loc_dots(),
            wind_tailwind_kt: d_wind_tailwind_kt(),
            wind_crosswind_kt: d_wind_crosswind_kt(),
            wind_shear_kt: d_wind_shear_kt(),
            thrust_min_n1_pct: d_thrust_min_n1(),
            thrust_check: d_thrust_check(),
            thrust_duration_s: d_thrust_duration(),
            thrust_floor_ft: d_thrust_floor(),
            n1_valid_min_pct: d_n1_valid_min(),
            spoilers_max_pct: d_spoilers_max(),
            energy_band_high_ft: d_energy_band_high(),
            energy_band_low_ft: d_energy_band_low(),
            vapp_vs0_factor: d_vapp_vs0_factor(),
        }
    }
}

fn d_profile_id() -> String {
    crate::approach_profile::GENERIC.to_string()
}
fn d_hard_gate_ft() -> f64 {
    500.0
}
fn d_thrust_check() -> bool {
    true
}
fn d_ils_min_share() -> f64 {
    0.6
}
fn d_loc_full_scale_dots() -> f64 {
    2.0
}
fn d_ils_mismatch_dots() -> f64 {
    0.5
}
fn d_ils_reject_gs_deg() -> f64 {
    1.0
}
fn d_ils_reject_loc_dots() -> f64 {
    1.5
}
fn d_wind_tailwind_kt() -> f64 {
    5.0
}
fn d_wind_crosswind_kt() -> f64 {
    15.0
}
fn d_wind_shear_kt() -> f64 {
    15.0
}
fn d_thrust_min_n1() -> f64 {
    40.0
}
fn d_thrust_duration() -> f64 {
    5.0
}
fn d_thrust_floor() -> f64 {
    50.0
}
fn d_n1_valid_min() -> f64 {
    10.0
}
fn d_spoilers_max() -> f64 {
    2.0
}
fn d_energy_band_high() -> f64 {
    500.0
}
fn d_energy_band_low() -> f64 {
    300.0
}
fn d_vapp_vs0_factor() -> f64 {
    1.3
}

// serde defaults of the lateral thresholds (configs serialised before they existed)
fn d_lat_on_rms() -> f64 {
    0.3
}
fn d_lat_on_max() -> f64 {
    0.5
}
fn d_lat_slight_rms() -> f64 {
    0.6
}
fn d_lat_slight_max() -> f64 {
    1.0
}
fn d_lat_reversal_dots() -> f64 {
    0.3
}
fn d_lat_reversal_floor() -> f64 {
    100.0
}
fn d_lat_intercept_window() -> f64 {
    20.0
}
fn d_lat_intercept_lookback() -> f64 {
    60.0
}
fn d_lat_overshoot_min() -> f64 {
    0.1
}

// ---- output ---------------------------------------------------------------------------

/// How the approach ended. JSON: `{"kind": "landed", "touchdownIndex": 0}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ApproachOutcome {
    Landed { touchdown_index: usize },
    TouchAndGo { touchdown_index: usize },
    GoAround,
}

impl ApproachOutcome {
    /// Storage name (`approach_facts.outcome`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Landed { .. } => "landed",
            Self::TouchAndGo { .. } => "touch_and_go",
            Self::GoAround => "go_around",
        }
    }

    pub fn touchdown_index(self) -> Option<usize> {
        match self {
            Self::Landed { touchdown_index } | Self::TouchAndGo { touchdown_index } => Some(touchdown_index),
            Self::GoAround => None,
        }
    }
}

/// Where the height reference (HAT = 0) comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ElevationSource {
    /// MSL of the first on-ground sample (measured).
    Touchdown,
    /// Runway/airport elevation from the database (go-around; may differ from the sim by 10–50 ft).
    Database,
    /// Ground under the aircraft at the lowest point (MSL − AGL): no runway, no database value.
    Terrain,
}

/// What `track_dist_m` = 0 refers to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackDistRef {
    Threshold,
    Touchdown,
    LowestPoint,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GlidepathSource {
    /// `ApproachConfig::glidepath_deg` (3°), no procedure data.
    Assumed,
    /// The sim's ILS (track v2): angle from `NAV RAW GLIDE SLOPE`, deviation from `NAV GLIDE
    /// SLOPE ERROR` (glideslope received over ≥ `ils_min_share`, plausible to the geometry).
    Ils,
}

/// Where the localizer dots of the criteria come from.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalizerSource {
    /// From position and runway coordinates (virtual antenna beyond the far end).
    #[default]
    Geometric,
    /// The sim's `NAV CDI` (track v2), localizer present over ≥ `ils_min_share`.
    Ils,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VappSource {
    /// `AircraftRef::vapp_kt`.
    User,
    /// Median IAS 500 → 100 ft of this approach: judges consistency, not the absolute value.
    Flown,
    /// `vapp_vs0_factor` × `DESIGN SPEED VS0` (assumption, only without a flown median).
    Design,
    /// No reference: speed criteria are not measurable.
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LandingFlapsSource {
    /// The pilot's landing flaps of the airframe (`AircraftRef::landing_flaps_index`).
    User,
    /// Last handle position (`AircraftRef::flap_positions` − 1).
    AircraftPositions,
    /// Flap index at the touchdown.
    Touchdown,
    /// Unknown: the gate only checks "flaps ≥ 1".
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproachReference {
    /// The ILS angle with `glidepath_source` = Ils, else the assumed 3°.
    pub glidepath_deg: f64,
    pub glidepath_source: GlidepathSource,
    #[serde(default)]
    pub localizer_source: LocalizerSource,
    pub tch_ft: f64,
    /// Reference speed (KIAS) the speed criteria use; None = not measurable.
    pub vapp_kt: Option<f64>,
    pub vapp_source: VappSource,
    /// Median IAS 500 → 100 ft (always shown, even when a user value is the reference).
    pub flown_vapp_kt: Option<f64>,
    pub vs0_kt: Option<f64>,
    /// Vapp within 1.1–1.6 × VS0; None without VS0 or Vapp.
    pub vapp_plausible: Option<bool>,
    pub landing_flaps_index: Option<i32>,
    pub landing_flaps_source: LandingFlapsSource,
}

/// First point from which the aircraft stayed on the extended centreline to the threshold.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EstablishedPoint {
    pub t_ms: u64,
    pub hat_ft: f64,
    /// Distance to the threshold along the runway axis (−x), nm.
    pub dist_nm: f64,
    pub track_dist_m: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MarkerKind {
    /// Top of descent before this approach.
    Tod,
    TenNm,
    Faf,
    Gate1000,
    Gate500,
    Gate50,
    Threshold,
    Touchdown,
    /// Lowest point of a go-around.
    GoAround,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MarkerSource {
    /// Phase engine event, sharpened in the track.
    Phase,
    Track,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub kind: MarkerKind,
    pub source: MarkerSource,
    pub t_ms: u64,
    pub hat_ft: f64,
    pub track_dist_m: f64,
    pub x_m: Option<f64>,
    pub ias_kt: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GateKind {
    TenNm,
    Faf,
    Ft1000,
    Ft500,
    /// Values only, no criteria.
    Ft50,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FafReason {
    /// `faf_dist_nm` before the threshold came first.
    Distance,
    /// `faf_hat_ft` came first.
    Height,
}

/// Values interpolated where the gate was passed (the last time, on the way down).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproachGateSample {
    pub t_ms: u64,
    pub hat_ft: f64,
    pub track_dist_m: f64,
    pub x_m: Option<f64>,
    pub y_m: Option<f64>,
    pub ias_kt: f64,
    pub tas_kt: f64,
    pub ground_speed_kt: f64,
    pub vs_fpm: f64,
    pub bank_deg: f64,
    pub pitch_deg: f64,
    /// Configuration once through the gate (the later sample).
    pub flaps_index: i32,
    pub gear_pct: f64,
    pub glidepath_dev_deg: Option<f64>,
    pub gs_dots: Option<f64>,
    pub loc_dots: Option<f64>,
    pub alt_dev_ft: Option<f64>,
    pub ias_dev_kt: Option<f64>,
    pub energy_dev_ft: Option<f64>,
    /// Track v2 (None: not recorded / N1 never above `n1_valid_min_pct`).
    #[serde(default)]
    pub n1_pct: Option<f64>,
    #[serde(default)]
    pub spoilers_pct: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproachGate {
    pub kind: GateKind,
    pub reached: bool,
    pub faf_reason: Option<FafReason>,
    pub sample: Option<ApproachGateSample>,
    pub criteria: Vec<Criterion>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    S1,
    S2,
}

/// A continuous S1 violation that lasted at least its minimum duration.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exceedance {
    pub kind: CriterionKind,
    /// S2 when the S2 limit was also exceeded for its duration within this run.
    pub level: Severity,
    pub start_t_ms: u64,
    pub end_t_ms: u64,
    pub duration_s: f64,
    pub start_hat_ft: f64,
    pub end_hat_ft: f64,
    /// Worst measured value (signed; unit as in `Criterion::measured`).
    pub peak: f64,
    /// The S1 limit it crossed.
    pub limit: f64,
    /// Counts below the hard gate (`ApproachConfig::hard_gate_ft`, 500 ft by default; EASA: one
    /// criterion there makes the approach unstable). Name kept for the stored/serialised form.
    pub below_500: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApproachBand {
    /// No S1 criterion 1000 → 50 ft.
    Stable,
    /// 1–2 criteria above the hard gate, none below.
    Deviations,
    /// ≥ 3 criteria above the hard gate, none below.
    Unstable,
    /// ≥ 1 criterion below the hard gate (`ApproachConfig::hard_gate_ft`; the name is the
    /// stored/serialised form from when the gate was always 500 ft).
    UnstableBelow500,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeOutside {
    pub kind: CriterionKind,
    /// Seconds in qualifying S1 runs (runs shorter than the duration do not count).
    pub seconds: f64,
}

/// Stability over the band window (1000 → 50 ft, glidepath to 200 ft).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StabilityStats {
    /// Highest HAT (≤ 1500 ft, rounded down to 50 ft) from which down to 50 ft no S1
    /// criterion was violated for its duration. None = never stable or not measurable.
    pub stable_from_ft: Option<f64>,
    pub window_samples: usize,
    pub gp_rms_ft: Option<f64>,
    pub gp_rms_dots: Option<f64>,
    pub gp_max_above_dots: Option<f64>,
    pub gp_max_below_dots: Option<f64>,
    pub lat_rms_m: Option<f64>,
    /// Largest |y| (sign kept: positive = right).
    pub lat_max_m: Option<f64>,
    pub loc_rms_dots: Option<f64>,
    /// IAS − reference: median, median absolute deviation, 95th percentile of |dev|, range.
    pub ias_median_dev_kt: Option<f64>,
    pub ias_mad_kt: Option<f64>,
    pub ias_p95_abs_dev_kt: Option<f64>,
    pub ias_min_dev_kt: Option<f64>,
    pub ias_max_dev_kt: Option<f64>,
    /// Share (0–1) of samples outside `stats_speed_below/above_kt`.
    pub ias_outside_share: Option<f64>,
    pub vs_sd_fpm: Option<f64>,
    /// Most negative V/S.
    pub vs_min_fpm: Option<f64>,
    /// Share (0–1) of samples with |V/S| > 1000 fpm.
    pub vs_over_1000_share: Option<f64>,
    pub bank_max_deg: Option<f64>,
    pub bank_rms_deg: Option<f64>,
    pub time_outside: Vec<TimeOutside>,
}

/// Lateral guidance over the band window (thresholds: `ApproachConfig::lat_band_*`,
/// VectaSim convention below the FSF ±1 dot gate).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LateralBand {
    /// RMS ≤ 0.3 dot and |max| ≤ 0.5 dot.
    OnCentreline,
    /// RMS ≤ 0.6 dot and |max| ≤ 1 dot.
    Slight,
    Marked,
}

/// Lateral guidance (extended centreline) as its own dimension next to the glidepath.
/// Offsets in metres / localizer dots, positive = right of the centreline. RMS values are
/// [`StabilityStats::lat_rms_m`] / [`StabilityStats::loc_rms_dots`]. All `None` without a
/// runway; with a runway derived from the own track (`measurable` false) the band is `None`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LateralStats {
    /// A runway from the database or set by the pilot: the centreline is known.
    pub measurable: bool,
    /// Largest |localizer deviation| 1000 → 50 ft, sign kept, dots.
    pub loc_max_dots: Option<f64>,
    /// Offset where the 500 ft gate was passed.
    pub lat_at_500_m: Option<f64>,
    pub loc_at_500_dots: Option<f64>,
    /// Offset over the threshold (landing without a threshold crossing: last airborne
    /// sample; go-around: None).
    pub lat_at_threshold_m: Option<f64>,
    /// Largest offset on the far side within `lat_intercept_window_s` after "established";
    /// None = clean intercept, no intercept seen, or not established.
    pub intercept_overshoot_m: Option<f64>,
    pub intercept_overshoot_dots: Option<f64>,
    /// Sign changes of the offset (beyond `lat_reversal_dots`) between 1000 and 100 ft.
    pub lateral_reversals: Option<u32>,
    pub lateral_band: Option<LateralBand>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TasSource {
    Recorded,
    /// From IAS and altitude (ISA, no compressibility).
    Derived,
}

/// Energy height difference to the reference (3° path at Vapp): + = too much energy.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnergyPoint {
    pub total_ft: f64,
    /// Height part (= altitude deviation).
    pub height_ft: f64,
    /// Speed part: (TAS² − Vapp_TAS²) / 2g.
    pub speed_ft: f64,
}

/// Energy 10 nm → 1000 ft against `energy_band_high_ft` / `energy_band_low_ft`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EnergyBand {
    Good,
    High,
    Low,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnergyStats {
    /// Recorded: the sim's TAS (and its TAS/IAS ratio for the reference); derived: ISA.
    pub tas_source: TasSource,
    pub at_ten_nm: Option<EnergyPoint>,
    pub at_faf: Option<EnergyPoint>,
    pub at_1000: Option<EnergyPoint>,
    /// Largest excess from 10 nm to the end of the approach.
    pub max_excess_ft: Option<f64>,
    pub max_excess_hat_ft: Option<f64>,
    /// Largest excess / deficit from 10 nm (or the assessment start) to 1000 ft, and the band.
    #[serde(default)]
    pub band_max_ft: Option<f64>,
    #[serde(default)]
    pub band_min_ft: Option<f64>,
    #[serde(default)]
    pub band: Option<EnergyBand>,
}

/// The sim's ILS against the geometry (track v2). Both are always computed; `*_used` says
/// which one the criteria took. Dots as everywhere (+ = above / right).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IlsStats {
    /// Share of the samples 1000 → 200 ft with a valid glideslope / 1000 → 50 ft with a localizer.
    pub gs_share: Option<f64>,
    pub loc_share: Option<f64>,
    /// Published glideslope angle (median of the valid samples), °.
    pub gs_angle_deg: Option<f64>,
    pub gs_used: bool,
    pub loc_used: bool,
    /// Received over enough samples, but implausible to the runway (other ILS tuned).
    pub gs_rejected: bool,
    pub loc_rejected: bool,
    /// Median |sim − geometric| over the window, dots.
    pub gs_diff_dots: Option<f64>,
    pub loc_diff_dots: Option<f64>,
    /// RMS of both sources over the window (glideslope 1000 → 200 ft, localizer 1000 → 50 ft).
    pub gs_rms_sim_dots: Option<f64>,
    pub gs_rms_geo_dots: Option<f64>,
    pub loc_rms_sim_dots: Option<f64>,
    pub loc_rms_geo_dots: Option<f64>,
    /// A difference above `ils_mismatch_dots`: check the runway coordinates.
    pub mismatch: bool,
}

/// The sim's wind at the aircraft in the final 1000 → 50 ft (track v2).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindStats {
    pub samples: usize,
    /// Direction (true, from) of the mean wind vector and the median speed.
    pub dir_true_deg: Option<f64>,
    pub speed_kt: Option<f64>,
    /// Medians relative to the runway (+ = headwind / from the right); None without runway.
    pub headwind_kt: Option<f64>,
    pub crosswind_kt: Option<f64>,
    /// Range of the wind speed (max − min) – gustiness.
    pub gust_spread_kt: Option<f64>,
    /// Wind at the top (≈ 1000 ft) and over the threshold (≈ 50 ft), and the vector change.
    pub top_dir_true_deg: Option<f64>,
    pub top_kt: Option<f64>,
    pub bottom_dir_true_deg: Option<f64>,
    pub bottom_kt: Option<f64>,
    pub shear_kt: Option<f64>,
    /// Headwind change top → bottom (+ = more headwind near the ground).
    pub headwind_change_kt: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GoAroundSource {
    Track,
    Phase,
    /// Track pattern confirmed by the phase engine.
    Both,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoAround {
    pub detected_by: GoAroundSource,
    /// Lowest point ("decision point").
    pub lowest_t_ms: u64,
    pub lowest_hat_ft: f64,
    pub lowest_msl_ft: f64,
    pub lowest_track_dist_m: f64,
    pub lowest_x_m: Option<f64>,
    /// First sample after the lowest point climbing faster than 500 fpm.
    pub climb_t_ms: Option<u64>,
    /// Phase-engine transition Approach/Final → Climb (fires after its 10 s dwell).
    pub phase_t_ms: Option<u64>,
    /// Height gained within `ga_window_s` of the lowest point.
    pub climb_ft: f64,
    /// Documentation only (within 30 s after the lowest point).
    pub max_pitch_deg: f64,
    pub min_ias_kt: f64,
}

/// Autopilot/autothrust (track v2 only; always None for v1 tracks). Informative only, never a criterion.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutomationStats {
    /// HAT of the first sample after the last one with the autopilot on (None: never on, or on to the end).
    pub autopilot_off_hat_ft: Option<f64>,
    pub autothrust_off_hat_ft: Option<f64>,
    pub autopilot_used: bool,
    pub autothrust_used: bool,
    /// Still engaged at the last airborne sample (autoland / go-around flown by the AP).
    pub autopilot_at_end: bool,
    pub autothrust_at_end: bool,
    /// APPR / G/S mode seen.
    pub approach_mode: bool,
    pub glideslope_mode: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigEventKind {
    /// Gear reached `gear_down_pct`.
    GearDown,
    /// Gear back below 5 %.
    GearUp,
    Flaps,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEvent {
    pub kind: ConfigEventKind,
    pub t_ms: u64,
    pub hat_ft: f64,
    pub track_dist_m: f64,
    pub ias_kt: f64,
    pub flaps_from: Option<i32>,
    pub flaps_to: Option<i32>,
}

/// One profile point (thinned: 1 Hz below 3000 ft HAT, else every 5 s).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproachProfilePoint {
    pub t_ms: u64,
    pub latitude: f64,
    pub longitude: f64,
    pub hat_ft: f64,
    pub altitude_msl_ft: f64,
    pub track_dist_m: f64,
    pub x_m: Option<f64>,
    pub y_m: Option<f64>,
    pub ias_kt: f64,
    pub tas_kt: f64,
    pub ground_speed_kt: f64,
    pub vs_fpm: f64,
    pub bank_deg: f64,
    pub pitch_deg: f64,
    pub flaps_index: i32,
    pub gear_pct: f64,
    pub on_ground: bool,
    /// On the extended centreline (after "established", or inside the final cone).
    pub on_final: bool,
    pub glidepath_deg: Option<f64>,
    pub glidepath_dev_deg: Option<f64>,
    pub gs_dots: Option<f64>,
    /// Geometric localizer: angle from the virtual antenna, ° (positive = right).
    pub loc_angle_deg: Option<f64>,
    pub loc_dots: Option<f64>,
    /// Height of the reference path here and the deviation from it (+ = high).
    pub ref_hat_ft: Option<f64>,
    pub alt_dev_ft: Option<f64>,
    pub ias_dev_kt: Option<f64>,
    pub energy_dev_ft: Option<f64>,
    /// From the wind at the aircraft (track v2): + = headwind / from the right.
    pub headwind_kt: Option<f64>,
    pub crosswind_kt: Option<f64>,
    /// Both sources of the deviations (`gs_dots` / `loc_dots` are the one the criteria use, see
    /// `ApproachReference::glidepath_source` / `localizer_source`). Sim: only while received.
    #[serde(default)]
    pub gs_dots_sim: Option<f64>,
    #[serde(default)]
    pub gs_dots_geo: Option<f64>,
    #[serde(default)]
    pub loc_dots_sim: Option<f64>,
    #[serde(default)]
    pub loc_dots_geo: Option<f64>,
    /// Track v2: N1 (None when never above `n1_valid_min_pct`), deployed spoilers, %.
    #[serde(default)]
    pub n1_pct: Option<f64>,
    #[serde(default)]
    pub spoilers_pct: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproachAnalysis {
    /// 0-based, in time order within the flight.
    pub index: usize,
    pub outcome: ApproachOutcome,
    pub runway: Option<RunwayMatch>,
    /// HAT = 0 at this MSL.
    pub elevation_ft: f64,
    pub elevation_source: ElevationSource,
    pub track_dist_ref: TrackDistRef,
    pub reference: ApproachReference,
    pub established: Option<EstablishedPoint>,
    pub markers: Vec<Marker>,
    /// 10 nm, FAF, 1000, 500, 50 ft – always all five, `reached` false when not passed.
    pub gates: Vec<ApproachGate>,
    /// Qualifying S1 runs in the band window, time order.
    pub exceedances: Vec<Exceedance>,
    /// None when the approach never got below 1000 ft (nothing to assess).
    pub band: Option<ApproachBand>,
    pub stability: StabilityStats,
    /// Lateral guidance (extended centreline).
    #[serde(default)]
    pub lateral: LateralStats,
    pub energy: Option<EnergyStats>,
    /// Sim ILS vs geometry (None: no ILS state recorded – v1 track or no runway).
    #[serde(default)]
    pub ils: Option<IlsStats>,
    /// Sim wind 1000 → 50 ft (None: not recorded).
    #[serde(default)]
    pub wind: Option<WindStats>,
    pub go_around: Option<GoAround>,
    pub automation: Option<AutomationStats>,
    pub config_events: Vec<ConfigEvent>,
    /// First profile point, start of the assessment (15 nm / 5000 ft) and the end (touchdown / lowest point).
    pub start_t_ms: u64,
    pub assessed_from_t_ms: u64,
    pub end_t_ms: u64,
    pub samples: Vec<ApproachProfilePoint>,
    pub config: ApproachConfig,
}

// ---- helpers --------------------------------------------------------------------------

/// TAS from IAS at a (pressure ≈ MSL) altitude, ISA troposphere, incompressible.
pub fn tas_from_ias(ias_kt: f64, altitude_ft: f64) -> f64 {
    let sigma = (1.0 - 6.875_6e-6 * altitude_ft.clamp(-2000.0, 36_000.0)).powf(4.255_9);
    ias_kt / sigma.max(0.05).sqrt()
}

/// TAS of the reference speed `v` (KIAS) where the aircraft flies at `ias_kt`: with a recorded
/// TAS the sim's TAS/IAS ratio (its air density), else ISA from the altitude.
fn ref_tas_kt(v: f64, tas_kt: Option<f64>, ias_kt: f64, altitude_ft: f64) -> f64 {
    match tas_kt {
        Some(t) if ias_kt > 30.0 && t > 0.0 => v * t / ias_kt,
        _ => tas_from_ias(v, altitude_ft),
    }
}

fn energy_ft(tas_kt: f64) -> f64 {
    (tas_kt * FT_S_PER_KT).powi(2) / (2.0 * G_FT_S2)
}

fn rms(v: &[f64]) -> Option<f64> {
    (!v.is_empty()).then(|| (v.iter().map(|x| x * x).sum::<f64>() / v.len() as f64).sqrt())
}

fn std_dev(v: &[f64]) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    let m = v.iter().sum::<f64>() / v.len() as f64;
    Some((v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / v.len() as f64).sqrt())
}

fn percentile(mut v: Vec<f64>, p: f64) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(f64::total_cmp);
    let k = ((v.len() - 1) as f64 * p).round() as usize;
    Some(v[k.min(v.len() - 1)])
}

fn opt_lerp(a: Option<f64>, b: Option<f64>, f: f64) -> Option<f64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(lerp(x, y, f)),
        (x, y) => x.or(y),
    }
}

/// Ground course between neighbour samples, ° true; the heading when (almost) stationary.
fn course_deg(track: &[ApproachSample], i: usize, lo: usize, hi: usize) -> f64 {
    let (a, b) = (&track[i.saturating_sub(1).max(lo)], &track[(i + 1).min(hi)]);
    let e = crate::landing::dlon_deg(a.longitude, b.longitude).to_radians() * EARTH_R_M * a.latitude.to_radians().cos();
    let n = (b.latitude - a.latitude).to_radians() * EARTH_R_M;
    if e.hypot(n) < 20.0 { track[i].heading_true_deg } else { e.atan2(n).to_degrees().rem_euclid(360.0) }
}

fn sample_dist(track: &[ApproachSample], i: usize, j: usize) -> f64 {
    distance_m(track[i].latitude, track[i].longitude, track[j].latitude, track[j].longitude)
}

/// Index of the first on-ground sample belonging to the touchdown at `ts`.
fn touchdown_sample(track: &[ApproachSample], ts: u64) -> Option<usize> {
    let from = ts.saturating_sub(1500);
    track
        .iter()
        .position(|s| s.t_ms >= from && s.t_ms <= ts + 5000 && s.on_ground)
        .or_else(|| track.iter().position(|s| s.t_ms >= ts))
}

fn runway_match(r: &RunwayEnd, f: &RunwayFrame, lat: f64, lon: f64, heading: f64, check_on_runway: bool) -> RunwayMatch {
    let (x, y) = f.project(lat, lon);
    let half_w = if r.width_m > 0.0 { r.width_m / 2.0 } else { 15.0 };
    RunwayMatch {
        airport: r.airport.clone(),
        ident: r.ident.clone(),
        opposite_ident: r.opposite_ident.clone(),
        heading_true_deg: f.heading_deg,
        length_m: f.length_m,
        width_m: (r.width_m > 0.0).then_some(r.width_m),
        surface: r.surface.clone(),
        threshold_lat: r.threshold_lat,
        threshold_lon: r.threshold_lon,
        end_lat: r.end_lat,
        end_lon: r.end_lon,
        heading_diff_deg: angle_diff_deg(heading, f.heading_deg),
        on_runway: check_on_runway && y.abs() <= half_w && (0.0..=f.length_m).contains(&x),
        geometry: RunwayGeometry::database(),
    }
}

// ---- attempts -------------------------------------------------------------------------

/// The end of one approach found in the track: a touchdown or the lowest point of a go-around.
#[derive(Clone, Debug, PartialEq)]
pub struct ApproachAttempt {
    pub outcome: ApproachOutcome,
    /// Track index of the touchdown sample / the lowest point.
    pub end_index: usize,
    pub t_ms: u64,
    pub latitude: f64,
    pub longitude: f64,
    pub heading_true_deg: f64,
    /// Go-around: track index where the climb was confirmed; the next approach starts after it.
    pub climb_index: Option<usize>,
    pub detected_by: Option<GoAroundSource>,
    pub phase_t_ms: Option<u64>,
}

fn is_go_around_mark(p: &PhaseMark) -> bool {
    matches!(p.from, FlightPhase::Approach | FlightPhase::Final) && p.to == FlightPhase::Climb
}

/// Touchdowns (with a track sample) and go-arounds, in time order. Go-arounds: an airborne
/// lowest point below `ga_max_agl_ft`, reached in a descent of ≥ `ga_min_descent_ft` and
/// followed by ≥ `ga_min_climb_ft` climb within `ga_window_s`, no ground contact – or an
/// Approach/Final → Climb phase event the track pattern did not see.
pub fn find_attempts(track: &[ApproachSample], phases: &[PhaseMark], touchdowns: &[TouchdownReport], cfg: &ApproachConfig) -> Vec<ApproachAttempt> {
    let mut out = Vec::new();
    if track.is_empty() {
        return out;
    }
    for (k, td) in touchdowns.iter().enumerate() {
        let Some(i) = touchdown_sample(track, td.timestamp_ms) else { continue };
        out.push(ApproachAttempt {
            outcome: if td.touch_and_go { ApproachOutcome::TouchAndGo { touchdown_index: k } } else { ApproachOutcome::Landed { touchdown_index: k } },
            end_index: i,
            t_ms: td.timestamp_ms,
            latitude: td.latitude,
            longitude: td.longitude,
            heading_true_deg: td.heading_true_deg,
            climb_index: None,
            detected_by: None,
            phase_t_ms: None,
        });
    }
    let near_touchdown = |t0: u64, t1: u64| touchdowns.iter().any(|td| td.timestamp_ms + 5000 >= t0 && td.timestamp_ms <= t1);
    let window_ms = (cfg.ga_window_s * 1000.0) as u64;
    let lookback_ms = (cfg.ga_lookback_s * 1000.0) as u64;

    // track pattern
    let mut gas: Vec<ApproachAttempt> = Vec::new();
    let mut skip_until = 0;
    for i in 0..track.len() {
        let s = &track[i];
        if i < skip_until || s.on_ground || s.altitude_agl_ft >= cfg.ga_max_agl_ft {
            continue;
        }
        let mut climb = None;
        for (j, q) in track.iter().enumerate().skip(i + 1) {
            if q.t_ms > s.t_ms + window_ms || q.on_ground || q.altitude_msl_ft < s.altitude_msl_ft {
                break;
            }
            if q.altitude_msl_ft >= s.altitude_msl_ft + cfg.ga_min_climb_ft {
                climb = Some(j);
                break;
            }
        }
        let Some(j) = climb else { continue };
        let descended = (0..i)
            .rev()
            // a descent into this point: nothing lower in between, no ground contact
            .take_while(|&k| s.t_ms.saturating_sub(track[k].t_ms) <= lookback_ms && !track[k].on_ground && track[k].altitude_msl_ft >= s.altitude_msl_ft)
            .any(|k| track[k].altitude_msl_ft >= s.altitude_msl_ft + cfg.ga_min_descent_ft);
        if !descended || near_touchdown(s.t_ms, track[j].t_ms) {
            continue;
        }
        gas.push(ApproachAttempt {
            outcome: ApproachOutcome::GoAround,
            end_index: i,
            t_ms: s.t_ms,
            latitude: s.latitude,
            longitude: s.longitude,
            heading_true_deg: s.heading_true_deg,
            climb_index: Some(j),
            detected_by: Some(GoAroundSource::Track),
            phase_t_ms: None,
        });
        skip_until = j;
    }

    // phase engine: confirms a track go-around, or adds one the pattern missed (short climb)
    for p in phases.iter().filter(|p| is_go_around_mark(p)) {
        if let Some(g) = gas.iter_mut().find(|g| g.t_ms <= p.t_ms + 5000 && g.t_ms + lookback_ms + window_ms >= p.t_ms) {
            g.detected_by = Some(GoAroundSource::Both);
            g.phase_t_ms = Some(p.t_ms);
            continue;
        }
        let from = p.t_ms.saturating_sub(90_000);
        let cand: Vec<usize> = (0..track.len()).filter(|&i| track[i].t_ms >= from && track[i].t_ms <= p.t_ms).collect();
        if cand.is_empty() || cand.iter().any(|&i| track[i].on_ground) || near_touchdown(from, p.t_ms) {
            continue;
        }
        let Some(&lo) = cand.iter().min_by(|&&a, &&b| track[a].altitude_msl_ft.total_cmp(&track[b].altitude_msl_ft)) else { continue };
        let lim = track[lo].t_ms + window_ms;
        let top = (lo..track.len()).take_while(|&k| track[k].t_ms <= lim && !track[k].on_ground).max_by(|&a, &b| track[a].altitude_msl_ft.total_cmp(&track[b].altitude_msl_ft));
        let Some(top) = top.filter(|&t| track[t].altitude_msl_ft - track[lo].altitude_msl_ft >= cfg.ga_phase_min_climb_ft) else { continue };
        let s = &track[lo];
        gas.push(ApproachAttempt {
            outcome: ApproachOutcome::GoAround,
            end_index: lo,
            t_ms: s.t_ms,
            latitude: s.latitude,
            longitude: s.longitude,
            heading_true_deg: s.heading_true_deg,
            climb_index: Some(top),
            detected_by: Some(GoAroundSource::Phase),
            phase_t_ms: Some(p.t_ms),
        });
    }
    out.extend(gas);
    out.sort_by_key(|a| a.t_ms);
    out
}

/// Runway of an approach without touchdown: over the last `match_path_m` before the end of
/// `segment` (airborne, below `match_max_agl_ft`), the end that minimises the median |y| of
/// the samples before its threshold whose course is within `match_heading_deg`. At least
/// half of those samples (≥ 3) must fit, the median |y| must be ≤ `match_lateral_m` and the
/// last sample within `match_max_dist_m` before the threshold.
pub fn match_runway_for_approach(segment: &[ApproachSample], ends: &[RunwayEnd], cfg: &ApproachConfig) -> Option<(usize, RunwayFrame)> {
    let n = segment.len();
    if n == 0 {
        return None;
    }
    let mut path = 0.0;
    let mut considered = Vec::new();
    for i in (0..n).rev() {
        if i + 1 < n {
            path += sample_dist(segment, i, i + 1);
        }
        if path > cfg.match_path_m {
            break;
        }
        let s = &segment[i];
        if !s.on_ground && s.altitude_agl_ft <= cfg.match_max_agl_ft {
            considered.push(i);
        }
    }
    if considered.len() < 3 {
        return None;
    }
    let last = &segment[n - 1];
    let mut best: Option<(f64, usize, RunwayFrame)> = None;
    for (k, r) in ends.iter().enumerate() {
        let f = RunwayFrame::new(r);
        if f.length_m < 1.0 {
            continue;
        }
        let (x_last, _) = f.project(last.latitude, last.longitude);
        if !(-cfg.match_max_dist_m..=f.length_m).contains(&x_last) {
            continue;
        }
        let ys: Vec<f64> = considered
            .iter()
            .filter_map(|&i| {
                let s = &segment[i];
                let (x, y) = f.project(s.latitude, s.longitude);
                (x < 0.0 && angle_diff_deg(course_deg(segment, i, 0, n - 1), f.heading_deg) <= cfg.match_heading_deg).then_some(y.abs())
            })
            .collect();
        if ys.len() < 3 || ys.len() * 2 < considered.len() {
            continue;
        }
        let Some(score) = median(ys).filter(|m| *m <= cfg.match_lateral_m) else { continue };
        if best.as_ref().is_none_or(|(s, _, _)| score < *s) {
            best = Some((score, k, f));
        }
    }
    best.map(|(_, k, f)| (k, f))
}

// ---- analysis -------------------------------------------------------------------------

struct Input<'a> {
    track: &'a [ApproachSample],
    phases: &'a [PhaseMark],
    runways: &'a [RunwayEnd],
    aircraft: &'a AircraftRef,
    cfg: &'a ApproachConfig,
}

/// Every approach of a flight, in time order. Needs the track; without one (or without
/// any touchdown or go-around in it) the result is empty.
pub fn analyze_flight(
    track: &[ApproachSample],
    phases: &[PhaseMark],
    touchdowns: &[TouchdownReport],
    runways: &[RunwayEnd],
    aircraft: &AircraftRef,
    cfg: &ApproachConfig,
) -> Vec<ApproachAnalysis> {
    let inp = Input { track, phases, runways, aircraft, cfg };
    let mut out = Vec::new();
    let mut release_t: Option<u64> = None;
    for a in find_attempts(track, phases, touchdowns, cfg) {
        let lower = match release_t {
            Some(t) => track.iter().position(|s| s.t_ms > t).unwrap_or(a.end_index).min(a.end_index),
            None => 0,
        };
        if let Some(r) = analyze_attempt(&inp, &a, lower, out.len()) {
            out.push(r);
        }
        release_t = Some(match a.climb_index {
            Some(j) => track[j].t_ms,
            None => a.t_ms + 5000,
        });
    }
    out
}

/// Top of descent between `lower` and `end`: the last Cruise/Climb → Descent event minus
/// its 30 s dwell, walked back to where the descent began; else the last point within 50 ft
/// of the highest point if the aircraft descended ≥ 1000 ft from there.
fn find_tod(track: &[ApproachSample], phases: &[PhaseMark], lower: usize, end: usize) -> Option<(usize, MarkerSource)> {
    let (t_lo, t_hi) = (track[lower].t_ms, track[end].t_ms);
    let mark = phases
        .iter()
        .rfind(|p| p.to == FlightPhase::Descent && matches!(p.from, FlightPhase::Cruise | FlightPhase::Climb) && p.t_ms > t_lo && p.t_ms < t_hi);
    if let Some(p) = mark {
        let t0 = p.t_ms.saturating_sub(30_000);
        let mut i = (lower..=end).find(|&i| track[i].t_ms >= t0)?;
        let cap = track[i].t_ms.saturating_sub(60_000);
        while i > lower && track[i - 1].vertical_speed_fpm < -300.0 && track[i - 1].t_ms >= cap {
            i -= 1;
        }
        return Some((i, MarkerSource::Phase));
    }
    let top = (lower..=end).max_by(|&a, &b| track[a].altitude_msl_ft.total_cmp(&track[b].altitude_msl_ft))?;
    let max = track[top].altitude_msl_ft;
    if max - track[end].altitude_msl_ft < 1000.0 {
        return None;
    }
    (top..=end).rev().find(|&i| track[i].altitude_msl_ft >= max - 50.0).map(|i| (i, MarkerSource::Track))
}

/// Per-sample values over the profile range (local index = track index − profile start).
struct Pts {
    pts: Vec<ApproachProfilePoint>,
    /// Last airborne local index of the approach (before the touchdown / the lowest point).
    air_end: usize,
}

impl Pts {
    fn dist_axis(&self, l: usize) -> f64 {
        let p = &self.pts[l];
        match p.x_m {
            Some(x) if p.on_final && x < 0.0 => -x,
            _ => p.track_dist_m,
        }
    }

    fn interp(&self, j: usize, f: f64) -> ApproachGateSample {
        let (a, b) = (&self.pts[j], &self.pts[(j + 1).min(self.pts.len() - 1)]);
        ApproachGateSample {
            t_ms: lerp(a.t_ms as f64, b.t_ms as f64, f).round() as u64,
            hat_ft: lerp(a.hat_ft, b.hat_ft, f),
            track_dist_m: lerp(a.track_dist_m, b.track_dist_m, f),
            x_m: opt_lerp(a.x_m, b.x_m, f),
            y_m: opt_lerp(a.y_m, b.y_m, f),
            ias_kt: lerp(a.ias_kt, b.ias_kt, f),
            tas_kt: lerp(a.tas_kt, b.tas_kt, f),
            ground_speed_kt: lerp(a.ground_speed_kt, b.ground_speed_kt, f),
            vs_fpm: lerp(a.vs_fpm, b.vs_fpm, f),
            bank_deg: lerp(a.bank_deg, b.bank_deg, f),
            pitch_deg: lerp(a.pitch_deg, b.pitch_deg, f),
            flaps_index: b.flaps_index,
            gear_pct: b.gear_pct,
            glidepath_dev_deg: opt_lerp(a.glidepath_dev_deg, b.glidepath_dev_deg, f),
            gs_dots: opt_lerp(a.gs_dots, b.gs_dots, f),
            loc_dots: opt_lerp(a.loc_dots, b.loc_dots, f),
            alt_dev_ft: opt_lerp(a.alt_dev_ft, b.alt_dev_ft, f),
            ias_dev_kt: opt_lerp(a.ias_dev_kt, b.ias_dev_kt, f),
            energy_dev_ft: opt_lerp(a.energy_dev_ft, b.energy_dev_ft, f),
            n1_pct: opt_lerp(a.n1_pct, b.n1_pct, f),
            spoilers_pct: opt_lerp(a.spoilers_pct, b.spoilers_pct, f),
        }
    }

    /// Last descent through `value` of `axis` in [from, air_end): (local index, fraction).
    fn crossing(&self, from: usize, value: f64, axis: impl Fn(&Self, usize) -> f64) -> Option<(usize, f64)> {
        let j = (from..self.air_end).rev().find(|&j| axis(self, j) >= value)?;
        let (a, b) = (axis(self, j), axis(self, j + 1));
        if b >= value {
            return None;
        }
        Some((j, if (a - b).abs() > 1e-9 { ((a - value) / (a - b)).clamp(0.0, 1.0) } else { 0.0 }))
    }
}

/// One continuous criterion: S1/S2 windows (min, max) and durations, evaluated between
/// `floor_ft` and `ceil_ft`.
#[derive(Clone, Copy)]
struct Spec {
    kind: CriterionKind,
    s1: (Option<f64>, Option<f64>),
    s2: Option<(Option<f64>, Option<f64>)>,
    dur1: f64,
    dur2: f64,
    floor_ft: f64,
    ceil_ft: f64,
}

fn outside(v: f64, (lo, hi): (Option<f64>, Option<f64>)) -> bool {
    lo.is_some_and(|l| v < l - 1e-9) || hi.is_some_and(|h| v > h + 1e-9)
}

fn specs(cfg: &ApproachConfig) -> Vec<Spec> {
    let m = cfg.momentary_s;
    let sym = |a: f64| (Some(-a), Some(a));
    let all = vec![
        Spec { kind: CriterionKind::Gear, s1: (Some(cfg.gear_down_pct), None), s2: None, dur1: m, dur2: m, floor_ft: 0.0, ceil_ft: cfg.config_gate_ft },
        Spec { kind: CriterionKind::FlapChange, s1: (None, Some(0.5)), s2: None, dur1: 0.0, dur2: 0.0, floor_ft: 0.0, ceil_ft: cfg.config_gate_ft },
        Spec {
            kind: CriterionKind::Speed,
            s1: (Some(-cfg.speed_s1_below_kt), Some(cfg.speed_s1_above_kt)),
            s2: Some((Some(-cfg.speed_s2_below_kt), Some(cfg.speed_s2_above_kt))),
            dur1: cfg.speed_duration_s.max(m),
            dur2: cfg.speed_duration_s.max(m),
            floor_ft: cfg.window_bottom_ft,
            ceil_ft: f64::INFINITY,
        },
        Spec {
            kind: CriterionKind::VerticalSpeed,
            s1: (Some(-cfg.vs_s1_fpm), None),
            s2: Some((Some(-cfg.vs_s2_fpm), None)),
            dur1: cfg.vs_s1_duration_s.max(m),
            dur2: cfg.vs_s2_duration_s.max(m),
            floor_ft: cfg.window_bottom_ft,
            ceil_ft: f64::INFINITY,
        },
        Spec {
            kind: CriterionKind::Glidepath,
            s1: sym(cfg.gs_s1_dots),
            s2: Some(sym(cfg.gs_s2_dots)),
            dur1: cfg.gs_duration_s.max(m),
            dur2: cfg.gs_duration_s.max(m),
            floor_ft: cfg.gs_floor_ft,
            ceil_ft: f64::INFINITY,
        },
        Spec {
            kind: CriterionKind::Localizer,
            s1: sym(cfg.loc_s1_dots),
            s2: Some(sym(cfg.loc_s2_dots)),
            dur1: cfg.loc_duration_s.max(m),
            dur2: cfg.loc_duration_s.max(m),
            floor_ft: cfg.window_bottom_ft,
            ceil_ft: f64::INFINITY,
        },
        Spec {
            kind: CriterionKind::Bank,
            s1: (None, Some(cfg.bank_s1_deg)),
            s2: Some((None, Some(cfg.bank_s2_deg))),
            dur1: cfg.bank_duration_s.max(m),
            dur2: cfg.bank_duration_s.max(m),
            floor_ft: cfg.window_bottom_ft,
            ceil_ft: f64::INFINITY,
        },
        // track v2 only (no values = never counted): thrust above idle, spoilers retracted
        Spec {
            kind: CriterionKind::Thrust,
            s1: (Some(cfg.thrust_min_n1_pct), None),
            s2: None,
            dur1: cfg.thrust_duration_s.max(m),
            dur2: cfg.thrust_duration_s.max(m),
            floor_ft: cfg.thrust_floor_ft.max(cfg.window_bottom_ft),
            ceil_ft: cfg.config_gate_ft,
        },
        Spec {
            kind: CriterionKind::Spoilers,
            s1: (None, Some(cfg.spoilers_max_pct)),
            s2: None,
            dur1: m,
            dur2: m,
            floor_ft: cfg.window_bottom_ft,
            ceil_ft: cfg.config_gate_ft,
        },
    ];
    // the profile may switch the thrust check off (turboprops)
    all.into_iter().filter(|s| cfg.thrust_check || s.kind != CriterionKind::Thrust).collect()
}

fn measure(kind: CriterionKind, pts: &[ApproachProfilePoint], l: usize) -> Option<f64> {
    let p = &pts[l];
    match kind {
        CriterionKind::Gear => Some(p.gear_pct),
        CriterionKind::FlapChange => Some(if l > 0 && pts[l - 1].flaps_index != p.flaps_index { 1.0 } else { 0.0 }),
        CriterionKind::Speed => p.ias_dev_kt,
        CriterionKind::VerticalSpeed => Some(p.vs_fpm),
        CriterionKind::Glidepath => p.gs_dots,
        CriterionKind::Localizer => p.loc_dots,
        CriterionKind::Bank => Some(p.bank_deg.abs()),
        CriterionKind::Thrust => p.n1_pct,
        CriterionKind::Spoilers => p.spoilers_pct,
        _ => None,
    }
}

/// Qualifying S1 runs of every criterion over local indices [lo, hi] below `top_ft`.
fn exceedances(pts: &[ApproachProfilePoint], lo: usize, hi: usize, top_ft: f64, cfg: &ApproachConfig) -> Vec<Exceedance> {
    let mut out = Vec::new();
    if lo > hi || hi >= pts.len() {
        return out;
    }
    for sp in specs(cfg) {
        let idx: Vec<usize> =
            (lo..=hi).filter(|&l| !pts[l].on_ground && pts[l].hat_ft <= top_ft && pts[l].hat_ft >= sp.floor_ft && pts[l].hat_ft <= sp.ceil_ft).collect();
        let vals: Vec<Option<f64>> = idx.iter().map(|&l| measure(sp.kind, pts, l)).collect();
        let dur = |a: usize, b: usize| (pts[idx[b]].t_ms.saturating_sub(pts[idx[a]].t_ms)) as f64 / 1000.0 + 1.0;
        let mut k = 0;
        while k < idx.len() {
            if !vals[k].is_some_and(|v| outside(v, sp.s1)) {
                k += 1;
                continue;
            }
            let start = k;
            while k + 1 < idx.len() && idx[k + 1] == idx[k] + 1 && vals[k + 1].is_some_and(|v| outside(v, sp.s1)) {
                k += 1;
            }
            let end = k;
            k += 1;
            let d = if sp.dur1 <= 0.0 { 0.0 } else { dur(start, end) };
            if d + 1e-9 < sp.dur1 {
                continue;
            }
            // S2 sub-run of sufficient length?
            let mut level = Severity::S1;
            if let Some(s2) = sp.s2 {
                let mut a = None;
                for (m, v) in vals.iter().enumerate().take(end + 1).skip(start) {
                    if v.is_some_and(|v| outside(v, s2)) {
                        let s = *a.get_or_insert(m);
                        if dur(s, m) + 1e-9 >= sp.dur2 {
                            level = Severity::S2;
                            break;
                        }
                    } else {
                        a = None;
                    }
                }
            }
            // worst value: furthest outside the S1 window
            let excess = |v: f64| sp.s1.0.map_or(0.0, |l| l - v).max(sp.s1.1.map_or(0.0, |h| v - h));
            let peak = (start..=end).filter_map(|m| vals[m]).max_by(|a, b| excess(*a).total_cmp(&excess(*b))).unwrap_or(0.0);
            let limit = match sp.s1 {
                (Some(l), Some(h)) => {
                    if peak < l {
                        l
                    } else {
                        h
                    }
                }
                (Some(l), None) => l,
                (None, Some(h)) => h,
                (None, None) => 0.0,
            };
            let below: usize = (start..=end).filter(|&m| pts[idx[m]].hat_ft < cfg.hard_gate_ft).count();
            let below_500 = if sp.dur1 <= 0.0 { below > 0 } else { below as f64 + 1e-9 >= sp.dur1 };
            let (ps, pe) = (&pts[idx[start]], &pts[idx[end]]);
            out.push(Exceedance {
                kind: sp.kind,
                level,
                start_t_ms: ps.t_ms,
                end_t_ms: pe.t_ms,
                duration_s: d,
                start_hat_ft: ps.hat_ft,
                end_hat_ft: pe.hat_ft,
                peak,
                limit,
                below_500,
            });
        }
    }
    out.sort_by_key(|e| e.start_t_ms);
    out
}

fn band_of(ex: &[Exceedance]) -> ApproachBand {
    if ex.iter().any(|e| e.below_500) {
        return ApproachBand::UnstableBelow500;
    }
    let mut distinct: Vec<CriterionKind> = Vec::new();
    for e in ex {
        if !distinct.contains(&e.kind) {
            distinct.push(e.kind);
        }
    }
    match distinct.len() {
        0 => ApproachBand::Stable,
        1 | 2 => ApproachBand::Deviations,
        _ => ApproachBand::Unstable,
    }
}

/// Lateral band from the RMS and the largest |deviation| (dots), see `ApproachConfig::lat_band_*`.
pub fn lateral_band_of(rms_dots: f64, max_abs_dots: f64, cfg: &ApproachConfig) -> LateralBand {
    if rms_dots <= cfg.lat_band_on_rms_dots && max_abs_dots <= cfg.lat_band_on_max_dots {
        LateralBand::OnCentreline
    } else if rms_dots <= cfg.lat_band_slight_rms_dots && max_abs_dots <= cfg.lat_band_slight_max_dots {
        LateralBand::Slight
    } else {
        LateralBand::Marked
    }
}

/// Applies the provenance of the matched runway's geometry (resolved by the caller). With
/// geometry derived from the own track the "centreline" is the pilot's own line: the lateral
/// band is not assessable (`measurable` false, band None; the raw offsets stay).
pub fn apply_runway_geometry(a: &mut ApproachAnalysis, g: &RunwayGeometry) {
    let Some(r) = a.runway.as_mut() else { return };
    r.apply_geometry(g);
    if g.source.is_derived() {
        a.lateral.measurable = false;
        a.lateral.lateral_band = None;
    }
}

struct LateralCtx<'a> {
    measurable: bool,
    band_lo: usize,
    bottom: Option<usize>,
    air_end: usize,
    landed: bool,
    established_l: Option<usize>,
    g500: Option<&'a ApproachGateSample>,
}

fn lateral_stats(pts: &[ApproachProfilePoint], c: LateralCtx<'_>, st: &StabilityStats, cfg: &ApproachConfig) -> LateralStats {
    if !c.measurable || pts.is_empty() {
        return LateralStats::default();
    }
    let mut out = LateralStats { measurable: true, ..Default::default() };
    if let Some(b) = c.bottom.filter(|&b| c.band_lo <= b) {
        let win: Vec<&ApproachProfilePoint> = pts[c.band_lo..=b].iter().filter(|q| !q.on_ground).collect();
        let dots: Vec<f64> = win.iter().filter_map(|q| q.loc_dots).collect();
        if dots.len() >= cfg.min_stat_samples {
            out.loc_max_dots = dots.iter().copied().max_by(|a, b| a.abs().total_cmp(&b.abs()));
        }
        // S-turns: side changes beyond the dead band, 1000 → 100 ft
        let rev: Vec<f64> = win.iter().filter(|q| q.hat_ft >= cfg.lat_reversal_floor_ft).filter_map(|q| q.loc_dots).collect();
        if rev.len() >= cfg.min_stat_samples {
            let (mut side, mut n) = (0.0f64, 0u32);
            for d in rev.into_iter().filter(|d| d.abs() > cfg.lat_reversal_dots) {
                if side != 0.0 && d.signum() != side {
                    n += 1;
                }
                side = d.signum();
            }
            out.lateral_reversals = Some(n);
        }
    }
    out.lateral_band = st.loc_rms_dots.zip(out.loc_max_dots).map(|(r, m)| lateral_band_of(r, m.abs(), cfg));
    out.lat_at_500_m = c.g500.and_then(|s| s.y_m);
    out.loc_at_500_dots = c.g500.and_then(|s| s.loc_dots);

    // over the threshold (last crossing while airborne), else the last airborne sample of a landing
    let air = &pts[..=c.air_end.min(pts.len() - 1)];
    let crossing = (0..air.len().saturating_sub(1)).rev().find_map(|l| match (air[l].x_m, air[l + 1].x_m, air[l].y_m, air[l + 1].y_m) {
        (Some(x0), Some(x1), Some(y0), Some(y1)) if x0 < 0.0 && x1 >= 0.0 => Some(lerp(y0, y1, -x0 / (x1 - x0))),
        _ => None,
    });
    out.lat_at_threshold_m = crossing.or_else(|| if c.landed { air.last().and_then(|q| q.y_m) } else { None });

    // intercept overshoot: far side within the first seconds after "established"
    if let Some(k) = c.established_l.filter(|&k| k < air.len()) {
        let tk = pts[k].t_ms;
        let look = (cfg.lat_intercept_lookback_s * 1000.0) as u64;
        let side = (0..=k)
            .rev()
            .take_while(|&l| pts[l].t_ms + look >= tk)
            .find_map(|l| pts[l].loc_dots.filter(|d| d.abs() > cfg.lat_reversal_dots).map(f64::signum));
        if let Some(side) = side {
            let lim = tk + (cfg.lat_intercept_window_s * 1000.0) as u64;
            let far = (k..air.len())
                .take_while(|&l| pts[l].t_ms <= lim)
                .filter_map(|l| pts[l].loc_dots.zip(pts[l].y_m))
                .filter(|(d, _)| d * side < 0.0)
                .max_by(|a, b| a.0.abs().total_cmp(&b.0.abs()));
            if let Some((d, y)) = far.filter(|(d, _)| d.abs() >= cfg.lat_overshoot_min_dots) {
                out.intercept_overshoot_m = Some(y);
                out.intercept_overshoot_dots = Some(d);
            }
        }
    }
    out
}

fn analyze_attempt(inp: &Input, a: &ApproachAttempt, lower: usize, index: usize) -> Option<ApproachAnalysis> {
    let (track, cfg) = (inp.track, inp.cfg);
    let end = a.end_index;
    if end >= track.len() || lower > end {
        return None;
    }
    let landed = a.outcome != ApproachOutcome::GoAround;

    // runway
    let matched = if landed {
        let lcfg = LandingConfig { match_lateral_m: cfg.match_lateral_m, match_heading_deg: cfg.match_heading_deg, ..Default::default() };
        match_runway(a.latitude, a.longitude, a.heading_true_deg, inp.runways, &lcfg)
    } else {
        match_runway_for_approach(&track[lower..=end], inp.runways, cfg)
    };
    let frame = matched.map(|(_, f)| f);
    let rwy_end = matched.map(|(i, _)| &inp.runways[i]);
    let runway = matched.map(|(i, f)| runway_match(&inp.runways[i], &f, a.latitude, a.longitude, a.heading_true_deg, landed));

    // height reference
    let (elev, elevation_source) = if landed {
        (track[end].altitude_msl_ft, ElevationSource::Touchdown)
    } else {
        match rwy_end.and_then(|r| r.elevation_ft) {
            Some(e) => (e, ElevationSource::Database),
            None => (track[end].altitude_msl_ft - track[end].altitude_agl_ft, ElevationSource::Terrain),
        }
    };

    // profile range: from the top of descent (never before the last ground contact) to the end + margin
    let airborne_from = (lower..end).rev().find(|&i| track[i].on_ground).map_or(lower, |i| i + 1).min(end);
    let tod = find_tod(track, inp.phases, airborne_from, end);
    // … or from where the assessment starts (15 nm / 5000 ft), if that is earlier
    let assess_from = {
        let (max_d, max_h) = (cfg.assess_from_nm * M_PER_NM, cfg.assess_from_ft);
        let mut d = 0.0;
        let mut first = end;
        for i in (airborne_from..end).rev() {
            d += sample_dist(track, i, i + 1);
            if d > max_d {
                break;
            }
            if track[i].altitude_msl_ft - elev <= max_h {
                first = i;
            }
        }
        first
    };
    let p0 = tod.map_or(assess_from, |(i, _)| i.max(airborne_from).min(assess_from));
    let pend = match a.climb_index {
        Some(j) => j.max(end),
        None => {
            let lim = track[end].t_ms + (cfg.profile_after_touchdown_s * 1000.0) as u64;
            (end..track.len()).take_while(|&i| track[i].t_ms <= lim).last().unwrap_or(end)
        }
    };
    let n = pend - p0 + 1;
    let end_l = end - p0;
    let air_end = if landed { end_l.saturating_sub(1) } else { end_l };

    // path distance to the end point, then to the threshold
    let mut path = vec![0.0; n];
    for i in (p0..end).rev() {
        path[i - p0] = path[i + 1 - p0] + sample_dist(track, i, i + 1);
    }
    for i in end + 1..=pend {
        path[i - p0] = path[i - 1 - p0] - sample_dist(track, i - 1, i);
    }
    let x_end = frame.map(|f| f.project(track[end].latitude, track[end].longitude).0);
    let track_dist: Vec<f64> = path.iter().map(|d| d - x_end.unwrap_or(0.0)).collect();
    let track_dist_ref = match (frame.is_some(), landed) {
        (true, _) => TrackDistRef::Threshold,
        (false, true) => TrackDistRef::Touchdown,
        (false, false) => TrackDistRef::LowestPoint,
    };

    let hat: Vec<f64> = (p0..=pend).map(|i| track[i].altitude_msl_ft - elev).collect();
    let xy: Vec<Option<(f64, f64)>> = (p0..=pend).map(|i| frame.map(|f| f.project(track[i].latitude, track[i].longitude))).collect();
    let course: Vec<f64> = (p0..=pend).map(|i| course_deg(track, i, p0, pend)).collect();

    // reference speed
    let vapp_samples: Vec<f64> = (0..=air_end)
        .filter(|&l| !track[p0 + l].on_ground && hat[l] <= cfg.vapp_from_ft && hat[l] >= cfg.vapp_to_ft)
        .map(|l| track[p0 + l].ias_kt)
        .collect();
    let flown_vapp = if vapp_samples.len() >= 3 { median(vapp_samples) } else { None };
    // cascade: the pilot's Vapp (airframe) → the flown median → VS0 × 1.3 (assumption).
    // SimBrief's OFP carries no approach speed, so there is no OFP step.
    let design_vapp = inp.aircraft.vs0_kt.filter(|v| *v > 0.0).map(|v| v * cfg.vapp_vs0_factor);
    let (vapp, vapp_source) = match (inp.aircraft.vapp_kt, flown_vapp, design_vapp) {
        (Some(v), _, _) => (Some(v), VappSource::User),
        (None, Some(v), _) => (Some(v), VappSource::Flown),
        (None, None, Some(v)) => (Some(v), VappSource::Design),
        (None, None, None) => (None, VappSource::Unavailable),
    };
    // the design value is VS0-based itself: the plausibility check says nothing about it
    let vapp_plausible =
        vapp.zip(inp.aircraft.vs0_kt).filter(|_| vapp_source != VappSource::Design).map(|(v, s)| v >= cfg.vapp_min_vs0 * s && v <= cfg.vapp_max_vs0 * s);
    let (landing_flaps_index, landing_flaps_source) = match (inp.aircraft.landing_flaps_index, inp.aircraft.flap_positions, landed) {
        (Some(lf), _, _) if lf >= 0 => (Some(lf), LandingFlapsSource::User),
        (_, Some(np), _) if np > 0 => (Some(np - 1), LandingFlapsSource::AircraftPositions),
        (_, _, true) => (Some(track[end].flaps_index), LandingFlapsSource::Touchdown),
        _ => (None, LandingFlapsSource::Unknown),
    };
    let mut reference = ApproachReference {
        glidepath_deg: cfg.glidepath_deg,
        glidepath_source: GlidepathSource::Assumed,
        localizer_source: LocalizerSource::Geometric,
        tch_ft: cfg.tch_ft,
        vapp_kt: vapp,
        vapp_source,
        flown_vapp_kt: flown_vapp,
        vs0_kt: inp.aircraft.vs0_kt,
        vapp_plausible,
        landing_flaps_index,
        landing_flaps_source,
    };

    // established on final: from the end backwards while on the centreline
    let established_l = frame.and_then(|f| {
        let mut k = None;
        for l in (0..=air_end).rev() {
            let (x, y) = xy[l]?;
            if x >= 0.0 {
                k = Some(l);
                continue;
            }
            if angle_diff_deg(course[l], f.heading_deg) <= cfg.established_track_deg && y.abs() <= cfg.established_min_m.max(cfg.established_ratio * x.abs()) {
                k = Some(l);
            } else {
                break;
            }
        }
        k.filter(|&l| xy[l].is_some_and(|(x, _)| x < 0.0))
    });
    let on_final: Vec<bool> = (0..n)
        .map(|l| match (frame, xy[l]) {
            (Some(f), Some((x, y))) => {
                established_l.is_some_and(|k| l >= k)
                    || (x < 0.0 && angle_diff_deg(course[l], f.heading_deg) <= cfg.match_heading_deg && y.abs() <= 300f64.max(0.1 * x.abs()))
            }
            _ => false,
        })
        .collect();

    // ---- ILS (track v2) against the geometry: both computed, the sim's used when received
    // over enough samples and plausible to the runway ----
    let in_appr = |l: usize| l <= air_end && !track[p0 + l].on_ground;
    const GS_OK: u8 = nav_flags::HAS_GLIDE_SLOPE | nav_flags::GLIDE_SLOPE_VALID;
    let gs_sim: Vec<Option<f64>> = (0..n)
        .map(|l| {
            let s = &track[p0 + l];
            s.gs_error_deg.filter(|_| in_appr(l) && s.nav_flags & GS_OK == GS_OK).map(|e| e / cfg.gs_dot_deg)
        })
        .collect();
    // NAV CDI: needle right (+) = aircraft left of the course
    let loc_sim: Vec<Option<f64>> = (0..n)
        .map(|l| {
            let s = &track[p0 + l];
            s.loc_cdi.filter(|_| in_appr(l) && s.nav_flags & nav_flags::HAS_LOCALIZER != 0).map(|c| -c / 127.0 * cfg.loc_full_scale_dots)
        })
        .collect();
    let nav_recorded = (p0..=pend).any(|i| track[i].nav_recorded);
    let gs_win: Vec<usize> = (0..=air_end).filter(|&l| in_appr(l) && hat[l] <= cfg.window_top_ft && hat[l] >= cfg.gs_floor_ft).collect();
    let loc_win: Vec<usize> = (0..=air_end).filter(|&l| in_appr(l) && hat[l] <= cfg.window_top_ft && hat[l] >= cfg.window_bottom_ft).collect();
    let share = |win: &[usize], v: &[Option<f64>]| {
        (nav_recorded && win.len() >= cfg.min_stat_samples).then(|| win.iter().filter(|&&l| v[l].is_some()).count() as f64 / win.len() as f64)
    };
    let (gs_share, loc_share) = (share(&gs_win, &gs_sim), share(&loc_win, &loc_sim));
    let ils_angle = median(gs_win.iter().filter(|&&l| gs_sim[l].is_some()).filter_map(|&l| track[p0 + l].gs_angle_deg).filter(|a| (1.5..=7.0).contains(a)).collect());
    let med_diff = |win: &[usize], a: &[Option<f64>], b: &[Option<f64>]| {
        let v: Vec<f64> = win.iter().filter_map(|&l| a[l].zip(b[l]).map(|(x, y)| (x - y).abs())).collect();
        if v.len() >= cfg.min_stat_samples { median(v) } else { None }
    };
    let win_rms = |win: &[usize], v: &[Option<f64>]| {
        let x: Vec<f64> = win.iter().filter_map(|&l| v[l]).collect();
        if x.len() >= cfg.min_stat_samples { rms(&x) } else { None }
    };
    // geometric glidepath angle seen from the aiming point of a path with `ref_deg`
    let geo_gp = |ref_deg: f64| -> Vec<Option<f64>> {
        let gpip_x = cfg.tch_ft * M_PER_FT / ref_deg.to_radians().tan();
        (0..n)
            .map(|l| match xy[l] {
                Some((x, _)) if frame.is_some() && in_appr(l) && on_final[l] && x <= 0.0 && gpip_x - x >= 0.25 * M_PER_NM => {
                    Some((hat[l] * M_PER_FT).atan2(gpip_x - x).to_degrees())
                }
                _ => None,
            })
            .collect()
    };
    let to_dots = |ang: &[Option<f64>], r: f64| -> Vec<Option<f64>> { ang.iter().map(|a| a.map(|a| (a - r) / cfg.gs_dot_deg)).collect() };
    let gs_cand = frame.is_some() && gs_share.is_some_and(|s| s >= cfg.ils_min_share) && ils_angle.is_some();
    let mut gp_ref = if gs_cand { ils_angle.unwrap_or(cfg.glidepath_deg) } else { cfg.glidepath_deg };
    let mut gp_ang = geo_gp(gp_ref);
    let mut gs_geo = to_dots(&gp_ang, gp_ref);
    let gs_used = gs_cand && med_diff(&gs_win, &gs_sim, &gs_geo).is_some_and(|d| d * cfg.gs_dot_deg <= cfg.ils_reject_gs_deg);
    if gs_cand && !gs_used {
        gp_ref = cfg.glidepath_deg;
        gp_ang = geo_gp(gp_ref);
        gs_geo = to_dots(&gp_ang, gp_ref);
    }
    let mut loc_ang: Vec<Option<f64>> = vec![None; n];
    let mut loc_geo: Vec<Option<f64>> = vec![None; n];
    if let Some(f) = frame {
        let ant = f.length_m + cfg.loc_antenna_beyond_end_m;
        let dot = cfg.loc_dot_m_at_threshold.atan2(ant).to_degrees();
        for l in 0..n {
            if let Some((x, y)) = xy[l]
                && in_appr(l)
                && on_final[l]
                && x < ant
            {
                let ang = y.atan2(ant - x).to_degrees();
                loc_ang[l] = Some(ang);
                loc_geo[l] = Some(ang / dot);
            }
        }
    }
    let loc_cand = frame.is_some() && loc_share.is_some_and(|s| s >= cfg.ils_min_share);
    let loc_diff = med_diff(&loc_win, &loc_sim, &loc_geo);
    let loc_used = loc_cand && loc_diff.is_some_and(|d| d <= cfg.ils_reject_loc_dots);
    let gs_diff = med_diff(&gs_win, &gs_sim, &gs_geo);
    let ils = (nav_recorded && frame.is_some()).then(|| IlsStats {
        gs_share,
        loc_share,
        gs_angle_deg: ils_angle,
        gs_used,
        loc_used,
        gs_rejected: gs_cand && !gs_used,
        loc_rejected: loc_cand && !loc_used,
        gs_diff_dots: gs_diff,
        loc_diff_dots: loc_diff,
        gs_rms_sim_dots: win_rms(&gs_win, &gs_sim),
        gs_rms_geo_dots: win_rms(&gs_win, &gs_geo),
        loc_rms_sim_dots: win_rms(&loc_win, &loc_sim),
        loc_rms_geo_dots: win_rms(&loc_win, &loc_geo),
        mismatch: gs_diff.is_some_and(|d| d > cfg.ils_mismatch_dots) || loc_diff.is_some_and(|d| d > cfg.ils_mismatch_dots),
    });
    if gs_used {
        reference.glidepath_deg = gp_ref;
        reference.glidepath_source = GlidepathSource::Ils;
    }
    if loc_used {
        reference.localizer_source = LocalizerSource::Ils;
    }
    let n1_valid = (p0..=pend).any(|i| track[i].n1_pct.is_some_and(|v| v > cfg.n1_valid_min_pct));

    // per-point values
    let tan_gp = gp_ref.to_radians().tan();
    let recorded_tas = (p0..=pend).any(|i| track[i].tas_kt.is_some());
    let mut pts: Vec<ApproachProfilePoint> = Vec::with_capacity(n);
    for l in 0..n {
        let s = &track[p0 + l];
        let h = hat[l];
        let in_approach = l <= air_end && !s.on_ground;
        let gp = gp_ang[l];
        // the criteria's source; the sim's values only on the final, like the geometry's
        let gs_dots = if gs_used { gs_sim[l].filter(|_| on_final[l]) } else { gs_geo[l] };
        let gp_dev = if gs_used { gs_dots.map(|d| d * cfg.gs_dot_deg) } else { gp.map(|a| a - gp_ref) };
        let loc_dots = if loc_used { loc_sim[l].filter(|_| on_final[l]) } else { loc_geo[l] };
        let loc_angle = loc_ang[l];
        let mut ref_hat = None;
        if let (Some(_), Some((x, _)), true) = (frame, xy[l], in_approach) {
            let d = if on_final[l] && x < 0.0 { -x } else { track_dist[l] };
            if d >= 0.0 {
                ref_hat = Some(cfg.tch_ft + d * tan_gp / M_PER_FT);
            }
        }
        let tas = s.tas_kt.unwrap_or_else(|| tas_from_ias(s.ias_kt, s.altitude_msl_ft));
        let alt_dev = ref_hat.map(|r| h - r);
        let ias_dev = vapp.filter(|_| in_approach).map(|v| s.ias_kt - v);
        let energy_dev = alt_dev.zip(vapp).map(|(dh, v)| dh + energy_ft(tas) - energy_ft(ref_tas_kt(v, s.tas_kt, s.ias_kt, s.altitude_msl_ft)));
        let wind = match (frame, s.wind_dir_true_deg, s.wind_kt) {
            (Some(f), Some(d), Some(w)) => {
                let r = (d - f.heading_deg).to_radians();
                Some((w * r.cos(), w * r.sin()))
            }
            _ => None,
        };
        pts.push(ApproachProfilePoint {
            t_ms: s.t_ms,
            latitude: s.latitude,
            longitude: s.longitude,
            hat_ft: h,
            altitude_msl_ft: s.altitude_msl_ft,
            track_dist_m: track_dist[l],
            x_m: xy[l].map(|v| v.0),
            y_m: xy[l].map(|v| v.1),
            ias_kt: s.ias_kt,
            tas_kt: tas,
            ground_speed_kt: s.ground_speed_kt,
            vs_fpm: s.vertical_speed_fpm,
            bank_deg: s.bank_deg,
            pitch_deg: s.pitch_deg,
            flaps_index: s.flaps_index,
            gear_pct: s.gear_pct,
            on_ground: s.on_ground,
            on_final: on_final[l],
            glidepath_deg: gp,
            glidepath_dev_deg: gp_dev,
            gs_dots,
            loc_angle_deg: loc_angle,
            loc_dots,
            ref_hat_ft: ref_hat,
            alt_dev_ft: alt_dev,
            ias_dev_kt: ias_dev,
            energy_dev_ft: energy_dev,
            headwind_kt: wind.map(|w| w.0),
            crosswind_kt: wind.map(|w| w.1),
            gs_dots_sim: gs_sim[l],
            gs_dots_geo: gs_geo[l],
            loc_dots_sim: loc_sim[l],
            loc_dots_geo: loc_geo[l],
            n1_pct: s.n1_pct.filter(|_| n1_valid),
            spoilers_pct: s.spoilers_pct,
        });
    }
    let p = Pts { pts, air_end };
    let pts = &p.pts;

    // assessment start: within 15 nm and below 5000 ft
    let assess_l = (0..=air_end).find(|&l| pts[l].track_dist_m <= cfg.assess_from_nm * M_PER_NM && pts[l].hat_ft <= cfg.assess_from_ft).unwrap_or(0);

    // gates
    let by_hat = |s: &Pts, l: usize| s.pts[l].hat_ft;
    let by_dist = |s: &Pts, l: usize| s.dist_axis(l);
    let ten = p.crossing(assess_l, 10.0 * M_PER_NM, by_dist).map(|(j, f)| p.interp(j, f));
    let faf_d = p.crossing(assess_l, cfg.faf_dist_nm * M_PER_NM, by_dist).map(|(j, f)| p.interp(j, f));
    let faf_h = p.crossing(assess_l, cfg.faf_hat_ft, by_hat).map(|(j, f)| p.interp(j, f));
    let (faf, faf_reason) = match (faf_d, faf_h) {
        (Some(d), Some(h)) if d.t_ms <= h.t_ms => (Some(d), Some(FafReason::Distance)),
        (Some(_), Some(h)) => (Some(h), Some(FafReason::Height)),
        (Some(d), None) => (Some(d), Some(FafReason::Distance)),
        (None, Some(h)) => (Some(h), Some(FafReason::Height)),
        (None, None) => (None, None),
    };
    let g1000 = p.crossing(assess_l, 1000.0, by_hat).map(|(j, f)| p.interp(j, f));
    let g500 = p.crossing(assess_l, 500.0, by_hat).map(|(j, f)| p.interp(j, f));
    let g50 = p.crossing(assess_l, 50.0, by_hat).map(|(j, f)| p.interp(j, f));
    let established_at = |t: u64| established_l.is_some_and(|k| pts[k].t_ms <= t);

    // landing flaps known (airframe, last handle position, touchdown): that stage; else only "≥ 1"
    let flaps_criterion = |s: &ApproachGateSample| match landing_flaps_index {
        Some(lf) => criterion(CriterionKind::LandingFlaps, Some(s.flaps_index as f64), Some(lf as f64), None, Some(lf as f64)),
        None => criterion(CriterionKind::Flaps, Some(s.flaps_index as f64), Some(1.0), None, None),
    };
    // thrust / spoilers only for approaches that recorded them (track v2); a gap = not measured
    let has_n1 = pts.iter().any(|q| q.n1_pct.is_some());
    let has_spoilers = pts.iter().any(|q| q.spoilers_pct.is_some());
    let mut gates = Vec::new();
    {
        let criteria = ten.as_ref().map_or_else(Vec::new, |s| {
            let est = established_at(s.t_ms);
            vec![
                criterion(
                    CriterionKind::AltitudeDeviation,
                    s.alt_dev_ft.filter(|_| est),
                    Some(-cfg.ten_nm_alt_tolerance_ft),
                    Some(cfg.ten_nm_alt_tolerance_ft),
                    Some(gp_ref),
                ),
                criterion(CriterionKind::SpeedLimit, Some(s.ias_kt), None, Some(cfg.ten_nm_max_ias_kt), None),
                criterion(CriterionKind::Energy, s.energy_dev_ft.filter(|_| est), None, Some(cfg.ten_nm_max_energy_ft), vapp),
            ]
        });
        gates.push(ApproachGate { kind: GateKind::TenNm, reached: ten.is_some(), faf_reason: None, criteria, sample: ten.clone() });
    }
    {
        let criteria = faf.as_ref().map_or_else(Vec::new, |s| {
            vec![
                criterion(CriterionKind::Gear, Some(s.gear_pct), Some(cfg.gear_down_pct), None, None),
                criterion(CriterionKind::Flaps, Some(s.flaps_index as f64), Some(1.0), None, None),
                criterion(CriterionKind::AltitudeDeviation, s.alt_dev_ft, Some(-cfg.faf_alt_tolerance_ft), Some(cfg.faf_alt_tolerance_ft), Some(gp_ref)),
                criterion(CriterionKind::Speed, s.ias_dev_kt, Some(-cfg.faf_speed_below_kt), Some(cfg.faf_speed_above_kt), vapp),
            ]
        });
        gates.push(ApproachGate { kind: GateKind::Faf, reached: faf.is_some(), faf_reason, criteria, sample: faf.clone() });
    }
    for (kind, gate_ft, g) in [(GateKind::Ft1000, 1000.0, &g1000), (GateKind::Ft500, 500.0, &g500)] {
        let criteria = g.as_ref().map_or_else(Vec::new, |s| {
            // gear and landing flaps only from the configuration gate down (500 ft for GA)
            let mut c = if gate_ft <= cfg.config_gate_ft + 1e-9 {
                vec![criterion(CriterionKind::Gear, Some(s.gear_pct), Some(cfg.gear_down_pct), None, None), flaps_criterion(s)]
            } else {
                Vec::new()
            };
            c.extend([
                criterion(CriterionKind::VerticalSpeed, Some(s.vs_fpm), Some(-cfg.gate_max_vs_fpm), Some(cfg.gate_max_vs_fpm), None),
                criterion(CriterionKind::Speed, s.ias_dev_kt, Some(-cfg.gate_speed_below_kt), Some(cfg.gate_speed_above_kt), vapp),
                criterion(CriterionKind::Glidepath, s.gs_dots, Some(-cfg.gate_dots), Some(cfg.gate_dots), Some(gp_ref)),
                criterion(CriterionKind::Localizer, s.loc_dots, Some(-cfg.gate_dots), Some(cfg.gate_dots), None),
                criterion(CriterionKind::Bank, Some(s.bank_deg.abs()), None, Some(cfg.gate_max_bank_deg), None),
            ]);
            if has_n1 && cfg.thrust_check {
                c.push(criterion(CriterionKind::Thrust, s.n1_pct, Some(cfg.thrust_min_n1_pct), None, None));
            }
            if has_spoilers {
                c.push(criterion(CriterionKind::Spoilers, s.spoilers_pct, None, Some(cfg.spoilers_max_pct), None));
            }
            c
        });
        gates.push(ApproachGate { kind, reached: g.is_some(), faf_reason: None, criteria, sample: g.clone() });
    }
    gates.push(ApproachGate { kind: GateKind::Ft50, reached: g50.is_some(), faf_reason: None, criteria: Vec::new(), sample: g50.clone() });

    // markers
    let mut markers = Vec::new();
    let mk = |kind, source, t_ms, hat_ft, track_dist_m, x_m, ias_kt| Marker { kind, source, t_ms, hat_ft, track_dist_m, x_m, ias_kt };
    if let Some((i, src)) = tod {
        let l = i.max(p0) - p0;
        markers.push(mk(MarkerKind::Tod, src, pts[l].t_ms, pts[l].hat_ft, pts[l].track_dist_m, pts[l].x_m, pts[l].ias_kt));
    }
    for (kind, g) in [(MarkerKind::TenNm, &ten), (MarkerKind::Faf, &faf), (MarkerKind::Gate1000, &g1000), (MarkerKind::Gate500, &g500), (MarkerKind::Gate50, &g50)] {
        if let Some(s) = g {
            markers.push(mk(kind, MarkerSource::Track, s.t_ms, s.hat_ft, s.track_dist_m, s.x_m, s.ias_kt));
        }
    }
    if frame.is_some() {
        for l in 0..air_end.min(n - 1) {
            if let (Some(x0), Some(x1)) = (pts[l].x_m, pts[l + 1].x_m)
                && x0 < 0.0
                && x1 >= 0.0
            {
                let f = -x0 / (x1 - x0);
                let g = p.interp(l, f);
                markers.push(mk(MarkerKind::Threshold, MarkerSource::Track, g.t_ms, g.hat_ft.max(0.0), g.track_dist_m, Some(0.0), g.ias_kt));
            }
        }
    }
    let e = &pts[end_l];
    markers.push(mk(
        if landed { MarkerKind::Touchdown } else { MarkerKind::GoAround },
        MarkerSource::Track,
        if landed { a.t_ms } else { e.t_ms },
        e.hat_ft,
        e.track_dist_m,
        e.x_m,
        e.ias_kt,
    ));
    markers.sort_by_key(|m| m.t_ms);

    // band window 1000 → 50 ft, stable-from window 1500 → 50 ft
    let eval_end = if landed {
        air_end
    } else {
        let t = pts[end_l].t_ms.saturating_sub((cfg.ga_exclude_s * 1000.0) as u64);
        (0..=air_end).rev().find(|&l| pts[l].t_ms <= t).unwrap_or(0)
    };
    let bottom = (0..=eval_end).rev().find(|&l| !pts[l].on_ground && pts[l].hat_ft >= cfg.window_bottom_ft);
    let from_below = |top: f64| (0..=air_end).rev().find(|&l| pts[l].hat_ft > top).map_or(0, |l| l + 1);
    let (band_lo, stable_lo) = (from_below(cfg.window_top_ft), from_below(cfg.stable_from_max_ft));
    let (exceed, band, window_samples) = match bottom {
        Some(b) if band_lo <= b => {
            let ex = exceedances(pts, band_lo, b, cfg.window_top_ft, cfg);
            let band = band_of(&ex);
            (ex, Some(band), b - band_lo + 1)
        }
        _ => (Vec::new(), None, 0),
    };
    let stable_from_ft = match bottom {
        Some(b) if stable_lo <= b => {
            let ex = exceedances(pts, stable_lo, b, cfg.stable_from_max_ft, cfg);
            match ex.iter().map(|e| e.end_t_ms).max() {
                // stable since before the window: the window top
                None if stable_lo > 0 => Some(cfg.stable_from_max_ft),
                None => Some(pts[0].hat_ft.min(cfg.stable_from_max_ft)),
                Some(t) => (stable_lo..=b).find(|&l| pts[l].t_ms > t).map(|l| pts[l].hat_ft.min(cfg.stable_from_max_ft)),
            }
            .map(|h| (h / cfg.stable_round_ft).floor() * cfg.stable_round_ft)
        }
        _ => None,
    };

    // stability statistics over the band window
    let mut st = StabilityStats { stable_from_ft, window_samples, ..Default::default() };
    if let Some(b) = bottom.filter(|&b| band_lo <= b) {
        let win: Vec<&ApproachProfilePoint> = pts[band_lo..=b].iter().filter(|q| !q.on_ground).collect();
        let enough = |v: Vec<f64>| (v.len() >= cfg.min_stat_samples).then_some(v);
        let gp_win: Vec<&&ApproachProfilePoint> = win.iter().filter(|q| q.hat_ft >= cfg.gs_floor_ft).collect();
        if let Some(v) = enough(gp_win.iter().filter_map(|q| q.alt_dev_ft.filter(|_| q.on_final)).collect()) {
            st.gp_rms_ft = rms(&v);
        }
        if let Some(v) = enough(gp_win.iter().filter_map(|q| q.gs_dots).collect()) {
            st.gp_rms_dots = rms(&v);
            st.gp_max_above_dots = v.iter().copied().fold(None, |m: Option<f64>, x| Some(m.map_or(x, |m| m.max(x)))).filter(|x| *x > 0.0);
            st.gp_max_below_dots = v.iter().copied().fold(None, |m: Option<f64>, x| Some(m.map_or(x, |m| m.min(x)))).filter(|x| *x < 0.0);
        }
        if let Some(v) = enough(win.iter().filter_map(|q| q.y_m.filter(|_| q.on_final)).collect()) {
            st.lat_rms_m = rms(&v);
            st.lat_max_m = v.iter().copied().max_by(|a, b| a.abs().total_cmp(&b.abs()));
        }
        if let Some(v) = enough(win.iter().filter_map(|q| q.loc_dots).collect()) {
            st.loc_rms_dots = rms(&v);
        }
        if let Some(v) = enough(win.iter().filter_map(|q| q.ias_dev_kt).collect()) {
            let med = median(v.clone());
            st.ias_median_dev_kt = med;
            st.ias_mad_kt = med.and_then(|m| median(v.iter().map(|x| (x - m).abs()).collect()));
            st.ias_p95_abs_dev_kt = percentile(v.iter().map(|x| x.abs()).collect(), 0.95);
            st.ias_min_dev_kt = v.iter().copied().reduce(f64::min);
            st.ias_max_dev_kt = v.iter().copied().reduce(f64::max);
            let out_n = v.iter().filter(|x| **x < -cfg.stats_speed_below_kt || **x > cfg.stats_speed_above_kt).count();
            st.ias_outside_share = Some(out_n as f64 / v.len() as f64);
        }
        if let Some(v) = enough(win.iter().map(|q| q.vs_fpm).collect()) {
            st.vs_sd_fpm = std_dev(&v);
            st.vs_min_fpm = v.iter().copied().reduce(f64::min);
            st.vs_over_1000_share = Some(v.iter().filter(|x| x.abs() > 1000.0).count() as f64 / v.len() as f64);
        }
        if let Some(v) = enough(win.iter().map(|q| q.bank_deg).collect()) {
            st.bank_max_deg = v.iter().map(|x| x.abs()).reduce(f64::max);
            st.bank_rms_deg = rms(&v);
        }
        for sp in specs(cfg) {
            let secs: f64 = exceed.iter().filter(|e| e.kind == sp.kind).map(|e| e.duration_s).sum();
            if secs > 0.0 {
                st.time_outside.push(TimeOutside { kind: sp.kind, seconds: secs });
            }
        }
    }

    // lateral guidance (extended centreline)
    let lateral = lateral_stats(pts, LateralCtx { measurable: frame.is_some(), band_lo, bottom, air_end, landed, established_l, g500: g500.as_ref() }, &st, cfg);

    // energy
    let energy = (frame.is_some() && vapp.is_some()).then(|| {
        let split = |s: &ApproachGateSample| {
            let (Some(h), Some(v)) = (s.alt_dev_ft, vapp) else { return None };
            let msl = elev + s.hat_ft;
            let sp = energy_ft(s.tas_kt) - energy_ft(ref_tas_kt(v, recorded_tas.then_some(s.tas_kt), s.ias_kt, msl));
            Some(EnergyPoint { total_ft: h + sp, height_ft: h, speed_ft: sp })
        };
        let from_l = ten.as_ref().and_then(|s| pts.iter().position(|q| q.t_ms >= s.t_ms)).unwrap_or(assess_l);
        let max = (from_l..=air_end).filter_map(|l| pts[l].energy_dev_ft.map(|e| (e, pts[l].hat_ft))).max_by(|a, b| a.0.total_cmp(&b.0));
        // band 10 nm → 1000 ft (to the end when the approach never got below 1000 ft), on the
        // final only: in a circuit the "path" before the final is no reference (like the 10 nm gate)
        let to_l = g1000.as_ref().and_then(|s| pts.iter().rposition(|q| q.t_ms <= s.t_ms)).unwrap_or(air_end).min(air_end);
        let seg: Vec<f64> = (from_l..=to_l).filter(|&l| pts[l].on_final).filter_map(|l| pts[l].energy_dev_ft).collect();
        let (band_max, band_min) = if seg.len() >= cfg.min_stat_samples {
            (seg.iter().copied().reduce(f64::max), seg.iter().copied().reduce(f64::min))
        } else {
            (None, None)
        };
        let band = band_max.zip(band_min).map(|(hi, lo)| {
            let (over, under) = (hi / cfg.energy_band_high_ft.max(1.0), -lo / cfg.energy_band_low_ft.max(1.0));
            match (over >= 1.0, under >= 1.0) {
                (false, false) => EnergyBand::Good,
                (true, false) => EnergyBand::High,
                (false, true) => EnergyBand::Low,
                // both: the one further beyond its threshold
                (true, true) => {
                    if over >= under {
                        EnergyBand::High
                    } else {
                        EnergyBand::Low
                    }
                }
            }
        });
        EnergyStats {
            tas_source: if recorded_tas { TasSource::Recorded } else { TasSource::Derived },
            at_ten_nm: ten.as_ref().and_then(split),
            at_faf: faf.as_ref().and_then(split),
            at_1000: g1000.as_ref().and_then(split),
            max_excess_ft: max.map(|m| m.0),
            max_excess_hat_ft: max.map(|m| m.1),
            band_max_ft: band_max,
            band_min_ft: band_min,
            band,
        }
    });

    // sim wind in the final, 1000 → 50 ft
    let wind = bottom.filter(|&b| band_lo <= b).and_then(|b| {
        let win: Vec<usize> = (band_lo..=b).filter(|&l| !pts[l].on_ground).collect();
        let w: Vec<(usize, f64, f64)> = win.iter().filter_map(|&l| track[p0 + l].wind_dir_true_deg.zip(track[p0 + l].wind_kt).map(|(d, k)| (l, d, k))).collect();
        if w.len() < cfg.min_stat_samples {
            return None;
        }
        // vector (towards north / east components of the "from" direction)
        let vec_of = |d: f64, k: f64| (k * d.to_radians().cos(), k * d.to_radians().sin());
        let mean_of = |xs: &[(usize, f64, f64)]| {
            let (n, e) = xs.iter().fold((0.0, 0.0), |(n, e), &(_, d, k)| {
                let v = vec_of(d, k);
                (n + v.0, e + v.1)
            });
            let c = xs.len().max(1) as f64;
            (n / c, e / c)
        };
        let dir_of = |(n, e): (f64, f64)| (n.hypot(e) > 0.05).then(|| e.atan2(n).to_degrees().rem_euclid(360.0));
        let k = 3.min(w.len());
        let (top, bot) = (mean_of(&w[..k]), mean_of(&w[w.len() - k..]));
        let heads: Vec<f64> = w.iter().filter_map(|&(l, _, _)| pts[l].headwind_kt).collect();
        let cross: Vec<f64> = w.iter().filter_map(|&(l, _, _)| pts[l].crosswind_kt).collect();
        let head_of = |xs: &[(usize, f64, f64)]| {
            let v: Vec<f64> = xs.iter().filter_map(|&(l, _, _)| pts[l].headwind_kt).collect();
            (!v.is_empty()).then(|| v.iter().sum::<f64>() / v.len() as f64)
        };
        let speeds: Vec<f64> = w.iter().map(|x| x.2).collect();
        Some(WindStats {
            samples: w.len(),
            dir_true_deg: dir_of(mean_of(&w)),
            speed_kt: median(speeds.clone()),
            headwind_kt: median(heads),
            crosswind_kt: median(cross),
            gust_spread_kt: speeds.iter().copied().reduce(f64::max).zip(speeds.iter().copied().reduce(f64::min)).map(|(a, b)| a - b),
            top_dir_true_deg: dir_of(top),
            top_kt: Some(top.0.hypot(top.1)),
            bottom_dir_true_deg: dir_of(bot),
            bottom_kt: Some(bot.0.hypot(bot.1)),
            shear_kt: Some((top.0 - bot.0).hypot(top.1 - bot.1)),
            headwind_change_kt: head_of(&w[w.len() - k..]).zip(head_of(&w[..k])).map(|(b, t)| b - t),
        })
    });

    // automation (informative): last engaged sample of the approach
    let automation = nav_recorded.then(|| {
        let range: Vec<usize> = (assess_l..=air_end).filter(|&l| !pts[l].on_ground).collect();
        let bit = |l: usize, b: u8| track[p0 + l].nav_flags & b != 0;
        let off_after = |b: u8| -> (bool, bool, Option<f64>) {
            let used = range.iter().any(|&l| bit(l, b));
            let at_end = range.last().is_some_and(|&l| bit(l, b));
            let off = if used && !at_end {
                range.iter().rposition(|&l| bit(l, b)).and_then(|k| range.get(k + 1)).map(|&l| pts[l].hat_ft)
            } else {
                None
            };
            (used, at_end, off)
        };
        let (ap_used, ap_end, ap_off) = off_after(nav_flags::AUTOPILOT_MASTER);
        let (at_used, at_end, at_off) = off_after(nav_flags::AUTOTHRUST);
        AutomationStats {
            autopilot_off_hat_ft: ap_off,
            autothrust_off_hat_ft: at_off,
            autopilot_used: ap_used,
            autothrust_used: at_used,
            autopilot_at_end: ap_end,
            autothrust_at_end: at_end,
            approach_mode: range.iter().any(|&l| bit(l, nav_flags::APPROACH_HOLD)),
            glideslope_mode: range.iter().any(|&l| bit(l, nav_flags::GLIDE_SLOPE_HOLD)),
        }
    });

    // go-around details
    let go_around = (!landed).then(|| {
        let lo = &track[end];
        let lim30 = lo.t_ms + 30_000;
        let lim_w = lo.t_ms + (cfg.ga_window_s * 1000.0) as u64;
        let after: Vec<&ApproachSample> = track[end..].iter().take_while(|s| s.t_ms <= lim_w && !s.on_ground).collect();
        GoAround {
            detected_by: a.detected_by.unwrap_or(GoAroundSource::Track),
            lowest_t_ms: lo.t_ms,
            lowest_hat_ft: lo.altitude_msl_ft - elev,
            lowest_msl_ft: lo.altitude_msl_ft,
            lowest_track_dist_m: pts[end_l].track_dist_m,
            lowest_x_m: pts[end_l].x_m,
            climb_t_ms: after.iter().find(|s| s.vertical_speed_fpm > 500.0).map(|s| s.t_ms),
            phase_t_ms: a.phase_t_ms,
            climb_ft: after.iter().map(|s| s.altitude_msl_ft - lo.altitude_msl_ft).fold(0.0, f64::max),
            max_pitch_deg: after.iter().filter(|s| s.t_ms <= lim30).map(|s| s.pitch_deg).fold(lo.pitch_deg, f64::max),
            min_ias_kt: after.iter().filter(|s| s.t_ms <= lim30).map(|s| s.ias_kt).fold(lo.ias_kt, f64::min),
        }
    });

    // configuration events
    let mut config_events = Vec::new();
    for l in 1..=air_end.min(n - 1) {
        let (q0, q1) = (&pts[l - 1], &pts[l]);
        let ev = |kind, flaps_from, flaps_to| ConfigEvent { kind, t_ms: q1.t_ms, hat_ft: q1.hat_ft, track_dist_m: q1.track_dist_m, ias_kt: q1.ias_kt, flaps_from, flaps_to };
        if q0.gear_pct < cfg.gear_down_pct && q1.gear_pct >= cfg.gear_down_pct {
            config_events.push(ev(ConfigEventKind::GearDown, None, None));
        }
        if q0.gear_pct > 5.0 && q1.gear_pct <= 5.0 {
            config_events.push(ev(ConfigEventKind::GearUp, None, None));
        }
        if q0.flaps_index != q1.flaps_index {
            config_events.push(ev(ConfigEventKind::Flaps, Some(q0.flaps_index), Some(q1.flaps_index)));
        }
    }

    let established = established_l.map(|l| EstablishedPoint {
        t_ms: pts[l].t_ms,
        hat_ft: pts[l].hat_ft,
        dist_nm: pts[l].x_m.map_or(0.0, |x| -x / M_PER_NM),
        track_dist_m: pts[l].track_dist_m,
    });

    // thinned profile
    let sparse_ms = (cfg.profile_sparse_s * 1000.0) as u64;
    let mut samples: Vec<ApproachProfilePoint> = Vec::new();
    let mut last_t: Option<u64> = None;
    for (l, q) in pts.iter().enumerate() {
        let keep = q.hat_ft < cfg.profile_dense_below_ft || l == 0 || l == n - 1 || l == end_l || last_t.is_none_or(|t| q.t_ms >= t + sparse_ms);
        if keep {
            last_t = Some(q.t_ms);
            samples.push(q.clone());
        }
    }

    Some(ApproachAnalysis {
        index,
        outcome: a.outcome,
        runway,
        elevation_ft: elev,
        elevation_source,
        track_dist_ref,
        reference,
        established,
        markers,
        gates,
        exceedances: exceed,
        band,
        stability: st,
        lateral,
        energy,
        ils,
        wind,
        go_around,
        automation,
        config_events,
        start_t_ms: pts[0].t_ms,
        assessed_from_t_ms: pts[assess_l].t_ms,
        end_t_ms: pts[end_l].t_ms,
        samples,
        config: cfg.clone(),
    })
}

/// Whether a criterion list has a failed check (unavailable ones never count).
pub fn any_failed(criteria: &[Criterion]) -> bool {
    criteria.iter().any(|c| c.status == CheckStatus::Fail)
}

/// The gate of a kind (all five are always present in `ApproachAnalysis::gates`).
pub fn gate(a: &ApproachAnalysis, kind: GateKind) -> Option<&ApproachGate> {
    a.gates.iter().find(|g| g.kind == kind)
}
