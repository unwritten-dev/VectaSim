//! Landing debrief: what happened between 1000 ft and the end of the rollout.
//!
//! Pure functions over the stored 1 Hz track, the touchdown reports of the
//! flight, the runways around the touchdown point and an optional surface wind.
//! Nothing here scores a landing; every value is a measured fact, and the only
//! judgement is a "band" tag per value (smooth/normal/firm/hard, pass/fail per
//! stabilised-approach criterion) so the UI can colour it.
//!
//! Geometry: each runway end is a local flat frame with the landing threshold
//! as origin, x along the runway towards the far end and y to the right of the
//! centreline. Equirectangular projection around the threshold is accurate to
//! well under a metre within the ~10 km an approach covers.
//!
//! Heights are "height above touchdown" (HAT): altitude MSL minus the MSL of the
//! first on-ground sample. That is the elevation the aircraft actually landed
//! at, so it is immune to terrain under the approach (AGL) and to errors in
//! the airport elevation of the database.
//!
//! Thresholds (defaults of [`LandingConfig`], sources: ICAO Annex 14, FSF ALAR, manufacturer landing-rate bands):
//! - Touchdown zone (TDZ) from the threshold to min(900 m, first third of the runway):
//!   ICAO Annex 14 Vol. I 5.2.6 / FAA AIM ("first 3000 ft or first third"). The aiming
//!   point is only a marker inside it ([`aiming_point_m`], Annex 14 Tab. 5-2: 150/250/
//!   300/400 m for runways < 800/< 1200/< 2400/≥ 2400 m).
//! - Gates at 1000/500 ft HAT (FSF ALAR BN 7.1): gear down, flaps set, |V/S| ≤ 1000 fpm,
//!   IAS −5/+20 kt to the reference speed, glidepath ±0.35° (one dot; Annex 10 GS
//!   sensitivity; ±0.7° is the full scale of two dots and only an S2 note), bank ≤ 15°.
//! - Reference speed, same cascade as `crate::approach`: the pilot's Vapp, else the
//!   median IAS 500 → 100 ft of this approach (judges consistency, not the absolute
//!   value), else 1.3 × VS0 (FAA AFH rule of thumb); 1.1–1.6 × VS0 is the plausibility
//!   window. Never the IAS at 500 ft itself (that compared the gate with itself).
//! - Bands: landing rate smooth < 150 / normal < 300 / firm < 600 / hard ≥ 600 fpm
//!   (600 fpm = 10 ft/s, CS/FAR 25.473); peak g < 1.25 / < 1.5 / < 2.0 / ≥ 2.0 – hard
//!   from 2.0 g, because 1.75 g was stricter than the OEM inspection thresholds
//!   (A320 2.6 g, B737-600 2.1 g) while the landing-rate band uses the certification limit.
//! - Runway width 0 in a [`RunwayEnd`] means unknown: [`RunwayMatch::width_m`] is None,
//!   and "on the runway" falls back to ±15 m.

use crate::TouchdownReport;
use crate::approach::AircraftRef;
use serde::{Deserialize, Serialize};

pub(crate) const EARTH_R_M: f64 = 6_371_008.8;
pub const M_PER_FT: f64 = 0.3048;
pub const M_PER_NM: f64 = 1852.0;

/// The subset of a track sample the analysis needs (1 Hz, as stored).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandingSample {
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
}

/// One landing direction of a runway (OurAirports gives both ends per runway).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunwayEnd {
    pub airport: String,
    /// Designator of this landing direction ("26").
    pub ident: String,
    pub opposite_ident: String,
    pub threshold_lat: f64,
    pub threshold_lon: f64,
    /// Threshold of the opposite end (the far end when landing on `ident`).
    pub end_lat: f64,
    pub end_lon: f64,
    /// Declared length; 0 = use the threshold-to-`end` distance.
    pub length_m: f64,
    /// 0 = unknown (the database has none).
    pub width_m: f64,
    pub surface: String,
    /// Threshold elevation, ft MSL, from the database (or the airport elevation when the
    /// database has none per runway). Only the approach analysis uses it, as the height
    /// reference of an approach without touchdown; None = unknown.
    #[serde(default)]
    pub elevation_ft: Option<f64>,
}

/// Surface wind (METAR, true direction).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindInput {
    /// None for variable wind.
    pub direction_deg: Option<f64>,
    pub speed_kt: f64,
    pub gust_kt: Option<f64>,
    /// "dddVddd" variability range (clockwise from → to).
    #[serde(default)]
    pub variable_from_deg: Option<f64>,
    #[serde(default)]
    pub variable_to_deg: Option<f64>,
}

/// Thresholds of the analysis (see the module doc for the sources).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandingConfig {
    /// Touchdown zone: from the threshold to this many metres past it …
    pub tdz_end_m: f64,
    /// … or the first third of a runway shorter than 3 × `tdz_end_m`.
    pub tdz_first_third: bool,
    pub glidepath_deg: f64,
    /// Threshold crossing height of the reference glidepath.
    pub tch_ft: f64,
    /// Gate tolerance: one dot.
    pub glidepath_tolerance_deg: f64,
    /// Full scale (two dots): beyond it the deviation is an S2 note.
    pub glidepath_full_scale_deg: f64,
    pub max_vs_fpm: f64,
    /// Speed window around the reference speed ([`SpeedReferenceSource`]).
    pub speed_below_kt: f64,
    pub speed_above_kt: f64,
    /// Flown reference speed: median IAS between these HATs (as `crate::approach`).
    pub vapp_from_ft: f64,
    pub vapp_to_ft: f64,
    /// Design reference speed = this × VS0, used only without a user or flown value.
    pub vs0_factor: f64,
    /// A reference outside these multiples of VS0 is flagged implausible.
    pub vapp_min_vs0: f64,
    pub vapp_max_vs0: f64,
    pub max_bank_deg: f64,
    /// Runway match: nearest runway within this lateral distance …
    pub match_lateral_m: f64,
    /// … whose direction differs from the aircraft heading by at most this.
    pub match_heading_deg: f64,
    /// The rollout ends below this ground speed.
    pub rollout_end_kt: f64,
    /// Approach segment starts at this HAT, or …
    pub approach_start_ft: f64,
    /// … if the aircraft was never that high, this far from the touchdown point.
    pub approach_fallback_m: f64,
    /// Flare: V/S reduced to this fraction of the approach V/S.
    pub flare_vs_fraction: f64,
}

impl Default for LandingConfig {
    fn default() -> Self {
        Self {
            tdz_end_m: 900.0,
            tdz_first_third: true,
            glidepath_deg: 3.0,
            tch_ft: 50.0,
            glidepath_tolerance_deg: 0.35,
            glidepath_full_scale_deg: 0.7,
            max_vs_fpm: 1000.0,
            speed_below_kt: 5.0,
            speed_above_kt: 20.0,
            vapp_from_ft: 500.0,
            vapp_to_ft: 100.0,
            vs0_factor: 1.3,
            vapp_min_vs0: 1.1,
            vapp_max_vs0: 1.6,
            max_bank_deg: 15.0,
            match_lateral_m: M_PER_NM,
            match_heading_deg: 30.0,
            rollout_end_kt: 30.0,
            approach_start_ft: 1000.0,
            approach_fallback_m: 3.0 * M_PER_NM,
            flare_vs_fraction: 0.7,
        }
    }
}

/// Colour class of a value; no score is derived from it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Band {
    Smooth,
    Normal,
    Firm,
    Hard,
}

/// V/S at contact: smooth < 150, normal < 300, firm < 600, hard ≥ 600 fpm.
pub fn vs_band(vs_fpm: f64) -> Band {
    match vs_fpm.abs() {
        v if v < 150.0 => Band::Smooth,
        v if v < 300.0 => Band::Normal,
        v if v < 600.0 => Band::Firm,
        _ => Band::Hard,
    }
}

/// Peak g: < 1.25 / < 1.5 / < 2.0 / >= 2.0 (module doc: why 2.0 and not 1.75).
pub fn g_band(g: f64) -> Band {
    match g {
        g if g < 1.25 => Band::Smooth,
        g if g < 1.5 => Band::Normal,
        g if g < 2.0 => Band::Firm,
        _ => Band::Hard,
    }
}

/// Aiming-point marking distance past the threshold by runway length (ICAO Annex 14
/// Vol. I Tab. 5-2): 150 m below 800 m, 250 m below 1200 m, 300 m below 2400 m, else 400 m.
pub fn aiming_point_m(length_m: f64) -> f64 {
    match length_m {
        l if l < 800.0 => 150.0,
        l if l < 1200.0 => 250.0,
        l if l < 2400.0 => 300.0,
        _ => 400.0,
    }
}

/// Point `dist_m` from (`lat`, `lon`) towards (`toward_lat`, `toward_lon`) on the line
/// between them: a displaced threshold from its runway end and the opposite end.
pub fn point_along(lat: f64, lon: f64, toward_lat: f64, toward_lon: f64, dist_m: f64) -> (f64, f64) {
    let f = RunwayFrame::new(&RunwayEnd { threshold_lat: lat, threshold_lon: lon, end_lat: toward_lat, end_lon: toward_lon, ..Default::default() });
    f.unproject(dist_m, 0.0)
}

// ---- geometry -------------------------------------------------------------------------

/// Local runway frame: origin at the threshold, x along the runway, y to the right.
#[derive(Clone, Copy, Debug)]
pub struct RunwayFrame {
    lat0: f64,
    lon0: f64,
    cos_lat0: f64,
    sin_h: f64,
    cos_h: f64,
    pub heading_deg: f64,
    pub length_m: f64,
}

impl RunwayFrame {
    pub fn new(r: &RunwayEnd) -> Self {
        let lat0 = r.threshold_lat;
        let cos_lat0 = lat0.to_radians().cos();
        let e = (r.end_lon - r.threshold_lon).to_radians() * EARTH_R_M * cos_lat0;
        let n = (r.end_lat - r.threshold_lat).to_radians() * EARTH_R_M;
        let h = e.atan2(n);
        let geo_len = e.hypot(n);
        Self {
            lat0,
            lon0: r.threshold_lon,
            cos_lat0,
            sin_h: h.sin(),
            cos_h: h.cos(),
            heading_deg: h.to_degrees().rem_euclid(360.0),
            length_m: if r.length_m > 0.0 { r.length_m } else { geo_len },
        }
    }

    /// (x along, y right of centreline) in metres.
    pub fn project(&self, lat: f64, lon: f64) -> (f64, f64) {
        let e = (lon - self.lon0).to_radians() * EARTH_R_M * self.cos_lat0;
        let n = (lat - self.lat0).to_radians() * EARTH_R_M;
        (e * self.sin_h + n * self.cos_h, e * self.cos_h - n * self.sin_h)
    }

    /// Inverse of [`project`](Self::project).
    pub fn unproject(&self, x: f64, y: f64) -> (f64, f64) {
        let e = x * self.sin_h + y * self.cos_h;
        let n = x * self.cos_h - y * self.sin_h;
        (self.lat0 + (n / EARTH_R_M).to_degrees(), self.lon0 + (e / (EARTH_R_M * self.cos_lat0)).to_degrees())
    }
}

pub fn angle_diff_deg(a: f64, b: f64) -> f64 {
    ((a - b + 540.0).rem_euclid(360.0) - 180.0).abs()
}

pub(crate) fn distance_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dlat = p2 - p1;
    let dlon = (lon2 - lon1).to_radians();
    let h = (dlat / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * EARTH_R_M * h.sqrt().min(1.0).asin()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunwayMatch {
    pub airport: String,
    pub ident: String,
    pub opposite_ident: String,
    pub heading_true_deg: f64,
    pub length_m: f64,
    /// None = unknown (no width in the database).
    pub width_m: Option<f64>,
    pub surface: String,
    pub threshold_lat: f64,
    pub threshold_lon: f64,
    pub end_lat: f64,
    pub end_lon: f64,
    /// |aircraft heading − runway direction| at touchdown.
    pub heading_diff_deg: f64,
    /// Touchdown point lies on the paved/declared rectangle of the runway.
    pub on_runway: bool,
    /// Where the geometry comes from (database, derived from the track, set by the user).
    #[serde(flatten, default)]
    pub geometry: RunwayGeometry,
}

impl RunwayMatch {
    pub fn apply_geometry(&mut self, g: &RunwayGeometry) {
        self.geometry = g.clone();
    }
}

/// Origin of a runway's geometry.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunwayGeometrySource {
    /// OurAirports threshold coordinates.
    #[default]
    Database,
    /// Axis and threshold estimated from the landing track ([`derive_runway_from_track`]);
    /// designator from the course.
    Derived,
    /// Axis/threshold derived from the track, designator and length from a database runway
    /// without coordinates whose direction fits.
    DatabaseDerived,
    /// Threshold and far end set by the pilot.
    User,
}

impl RunwayGeometrySource {
    /// Geometry estimated from the own track: the centreline offset is not measurable.
    pub fn is_derived(self) -> bool {
        matches!(self, Self::Derived | Self::DatabaseDerived)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Database => "database",
            Self::Derived => "derived",
            Self::DatabaseDerived => "databaseDerived",
            Self::User => "user",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "database" => Self::Database,
            "derived" => Self::Derived,
            "databaseDerived" => Self::DatabaseDerived,
            "user" => Self::User,
            _ => return None,
        })
    }
}

/// Provenance and uncertainty of a runway's geometry (flattened into [`RunwayMatch`]).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RunwayGeometry {
    pub source: RunwayGeometrySource,
    /// ± metres of the threshold along the axis (derived geometry); None = database/user.
    pub along_uncertainty_m: Option<f64>,
    /// ± metres of the axis across (derived geometry); None = database/user.
    pub cross_uncertainty_m: Option<f64>,
    /// No declared length: the length is a lower bound (threshold → end of the rollout).
    pub length_estimated: bool,
    /// Number of landings the derived geometry is averaged from.
    pub derived_from_landings: Option<u32>,
}

impl RunwayGeometry {
    pub fn database() -> Self {
        Self::default()
    }

    pub fn user() -> Self {
        Self { source: RunwayGeometrySource::User, ..Default::default() }
    }

    /// Derived geometry with the fixed uncertainty of [`derive_runway_from_track`].
    pub fn derived(source: RunwayGeometrySource, length_estimated: bool, landings: u32) -> Self {
        Self {
            source,
            along_uncertainty_m: Some(DERIVED_ALONG_UNCERTAINTY_M),
            cross_uncertainty_m: Some(DERIVED_CROSS_UNCERTAINTY_M),
            length_estimated,
            derived_from_landings: Some(landings),
        }
    }
}

/// Nearest runway end whose direction fits the touchdown heading. The tolerance is
/// deliberately wide (default 1 nm / ±30°) so a touchdown beside the runway, or
/// a database runway that is slightly off, still gets its runway – `on_runway`
/// tells whether the point actually was on it.
pub fn match_runway(lat: f64, lon: f64, heading_true_deg: f64, ends: &[RunwayEnd], cfg: &LandingConfig) -> Option<(usize, RunwayFrame)> {
    let mut best: Option<(f64, usize, RunwayFrame)> = None;
    for (i, r) in ends.iter().enumerate() {
        let f = RunwayFrame::new(r);
        if f.length_m < 1.0 || angle_diff_deg(heading_true_deg, f.heading_deg) > cfg.match_heading_deg {
            continue;
        }
        let (x, y) = f.project(lat, lon);
        let outside = if x < 0.0 { -x } else if x > f.length_m { x - f.length_m } else { 0.0 };
        if y.abs() > cfg.match_lateral_m || outside > cfg.match_lateral_m {
            continue;
        }
        let score = y.abs() + outside;
        if best.as_ref().is_none_or(|(s, _, _)| score < *s) {
            best = Some((score, i, f));
        }
    }
    best.map(|(_, i, f)| (i, f))
}

// ---- output ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DistanceRef {
    /// `dist_m` is measured to the runway threshold along the runway axis.
    Threshold,
    /// No runway: `dist_m` is the flown path distance to the touchdown point.
    Touchdown,
}

/// One track sample of the approach/rollout, with derived values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproachPoint {
    pub t_ms: u64,
    pub latitude: f64,
    pub longitude: f64,
    /// Height above the touchdown elevation.
    pub hat_ft: f64,
    pub ias_kt: f64,
    pub ground_speed_kt: f64,
    pub vs_fpm: f64,
    pub bank_deg: f64,
    pub pitch_deg: f64,
    pub on_ground: bool,
    pub flaps_index: i32,
    pub gear_pct: f64,
    /// Runway frame (only with a matched runway).
    pub x_m: Option<f64>,
    pub y_m: Option<f64>,
    /// Distance still to go to the reference (see `DistanceRef`); negative past it.
    pub dist_m: f64,
    /// Angle from the reference glidepath origin; only on final, ≥ 0.25 nm before it.
    pub glidepath_deg: Option<f64>,
    pub glidepath_dev_deg: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TouchdownPoint {
    pub distance_m: f64,
    pub distance_ft: f64,
    /// Signed: positive = right of the centreline (in landing direction).
    pub lateral_m: f64,
    /// The touchdown zone begins at the threshold (always 0; kept for the UI).
    pub tdz_start_m: f64,
    pub tdz_end_m: f64,
    /// Aiming-point marking (a marker inside the zone, not its start).
    pub aiming_point_m: f64,
    /// Between the threshold and the end of the zone, and on the runway laterally.
    pub in_tdz: bool,
    /// Runway left ahead of the touchdown point (meaningless with `RunwayMatch::length_estimated`).
    pub remaining_m: f64,
    /// False with a derived runway: its axis is the own rollout, so `lateral_m` is ≈ 0 by
    /// construction and says nothing about the real centreline.
    #[serde(default = "yes")]
    pub lateral_measurable: bool,
    /// ± metres of `distance_m` (derived threshold); None = from database/user coordinates.
    #[serde(default)]
    pub distance_uncertainty_m: Option<f64>,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThresholdCrossing {
    pub t_ms: u64,
    pub height_ft: f64,
    pub ias_kt: f64,
    /// Time from crossing the threshold to the first contact.
    pub airborne_s: f64,
}

/// Values interpolated at the moment the aircraft descended through a height.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateSample {
    pub t_ms: u64,
    pub hat_ft: f64,
    pub dist_m: f64,
    pub ias_kt: f64,
    pub vs_fpm: f64,
    pub bank_deg: f64,
    pub flaps_index: i32,
    pub gear_pct: f64,
    pub glidepath_dev_deg: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StartReason {
    Altitude,
    Distance,
    /// The track starts later than either (short track).
    TrackStart,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproachStats {
    pub start_reason: Option<StartReason>,
    pub start_hat_ft: Option<f64>,
    pub start_dist_m: Option<f64>,
    pub duration_s: Option<f64>,
    pub ias_min_kt: Option<f64>,
    pub ias_max_kt: Option<f64>,
    pub ias_at_500_kt: Option<f64>,
    pub ias_at_50_kt: Option<f64>,
    pub ias_at_touchdown_kt: Option<f64>,
    /// Most negative / least negative V/S below 1000 ft and below 500 ft HAT (airborne).
    pub vs_min_1000_fpm: Option<f64>,
    pub vs_max_1000_fpm: Option<f64>,
    pub vs_min_500_fpm: Option<f64>,
    pub vs_max_500_fpm: Option<f64>,
    pub bank_max_below_500_deg: Option<f64>,
    pub glidepath_dev_at_1000_deg: Option<f64>,
    pub glidepath_dev_at_500_deg: Option<f64>,
    /// Largest deviation above (positive) and below (negative) the reference below 1000 ft.
    pub glidepath_dev_max_above_deg: Option<f64>,
    pub glidepath_dev_max_below_deg: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flare {
    /// HAT of the last sample still at approach V/S, where the reduction began.
    pub start_hat_ft: f64,
    pub start_t_ms: u64,
    pub duration_s: f64,
    /// Median V/S between 500 and 200 ft (the rate the flare reduced from).
    pub approach_vs_fpm: f64,
    /// V/S of the last airborne sample.
    pub final_vs_fpm: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rollout {
    /// Ground path from first contact until ground speed fell below `rollout_end_kt`.
    pub distance_m: f64,
    pub duration_s: f64,
    pub end_lat: f64,
    pub end_lon: f64,
    /// Runway left at that point (with a matched runway).
    pub remaining_m: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindComponents {
    pub direction_deg: Option<f64>,
    pub speed_kt: f64,
    pub gust_kt: Option<f64>,
    /// Direction the components refer to (runway, else aircraft heading at touchdown).
    pub reference_heading_deg: f64,
    pub relative_to_runway: bool,
    /// Positive = headwind, negative = tailwind.
    pub headwind_kt: Option<f64>,
    /// Positive = from the right, negative = from the left.
    pub crosswind_kt: Option<f64>,
    pub gust_headwind_kt: Option<f64>,
    pub gust_crosswind_kt: Option<f64>,
    pub variable_from_deg: Option<f64>,
    pub variable_to_deg: Option<f64>,
    /// Worst crosswind (magnitude) over the variability range, or the whole speed for VRB;
    /// None without either.
    pub max_crosswind_kt: Option<f64>,
    pub max_gust_crosswind_kt: Option<f64>,
    /// Side of `max_crosswind_kt`: true = from the right; None = either side (VRB).
    pub max_crosswind_from_right: Option<bool>,
}

/// Where the reference speed of the speed criteria comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpeedReferenceSource {
    /// The pilot's Vapp (`AircraftRef::vapp_kt`).
    User,
    /// Median IAS 500 → 100 ft of this approach: judges consistency, not the absolute value.
    Flown,
    /// `vs0_factor` × VS0 (only when neither of the above exists).
    Design,
    /// None: the speed criteria are not measurable.
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CriterionKind {
    Gear,
    Flaps,
    VerticalSpeed,
    Speed,
    Glidepath,
    Bank,
    // The kinds below are only produced by the approach analysis (`crate::approach`).
    /// Lateral deviation from the extended centreline, localizer-proxy dots.
    Localizer,
    /// Height above/below the reference path, ft.
    AltitudeDeviation,
    /// IAS against a fixed upper limit (250 kt at the 10 nm gate), kt.
    SpeedLimit,
    /// Total-energy excess over the reference profile, ft.
    Energy,
    /// A flap-handle change below the configuration gate (event, no value).
    FlapChange,
    /// Flap handle index at a gate against the landing flaps (airframe setting, last handle
    /// position or the touchdown's), index.
    LandingFlaps,
    /// Engine N1 (track v2) against the approach minimum, % – "thrust above idle" (FSF BN 7.1).
    Thrust,
    /// Deployed spoiler surface (track v2) in the final approach, % – "speedbrakes retracted" (FSF BN 7.1).
    Spoilers,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckStatus {
    Pass,
    Fail,
    /// Not measurable (no runway for the glidepath, no reference speed).
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Criterion {
    pub kind: CriterionKind,
    pub status: CheckStatus,
    /// Gear: % down; flaps: index; V/S: fpm; speed: kt deviation from `reference`;
    /// glidepath: ° deviation; bank: |°|.
    pub measured: Option<f64>,
    pub limit_min: Option<f64>,
    pub limit_max: Option<f64>,
    pub reference: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateCheck {
    pub gate_ft: f64,
    /// False when the approach never was above the gate.
    pub reached: bool,
    pub sample: Option<GateSample>,
    pub criteria: Vec<Criterion>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroundPoint {
    pub t_ms: u64,
    pub latitude: f64,
    pub longitude: f64,
    pub x_m: Option<f64>,
    pub y_m: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandingAnalysis {
    pub touchdown_index: usize,
    pub touchdown: TouchdownReport,
    /// Band of the headline landing rate (touchdown.landing_rate_fpm).
    pub vs_band: Band,
    pub vs_measured_band: Band,
    pub vs_hardest_band: Band,
    pub g_band: Band,
    /// Reference speed of the gate speed criteria (KIAS); None = not measurable.
    pub reference_speed_kt: Option<f64>,
    pub reference_speed_source: SpeedReferenceSource,
    /// Median IAS 500 → 100 ft (shown even when a user value is the reference).
    pub flown_reference_kt: Option<f64>,
    pub vs0_kt: Option<f64>,
    /// Reference within `vapp_min_vs0`-`vapp_max_vs0` × VS0; None without VS0 or reference.
    pub reference_plausible: Option<bool>,
    pub runway: Option<RunwayMatch>,
    pub touchdown_point: Option<TouchdownPoint>,
    /// MSL of the first on-ground sample (HAT reference); None without a track.
    pub touchdown_elevation_ft: Option<f64>,
    pub threshold: Option<ThresholdCrossing>,
    pub approach: ApproachStats,
    pub flare: Option<Flare>,
    pub rollout: Option<Rollout>,
    pub wind: Option<WindComponents>,
    pub gates: Vec<GateCheck>,
    /// Later contacts of the bounce window as found in the 1 Hz track.
    pub bounce_points: Vec<GroundPoint>,
    pub distance_ref: DistanceRef,
    pub samples: Vec<ApproachPoint>,
    pub config: LandingConfig,
}

// ---- analysis -------------------------------------------------------------------------

pub(crate) fn lerp(a: f64, b: f64, f: f64) -> f64 {
    a + (b - a) * f
}

pub(crate) fn median(mut v: Vec<f64>) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(f64::total_cmp);
    let m = v.len() / 2;
    Some(if v.len().is_multiple_of(2) { (v[m - 1] + v[m]) / 2.0 } else { v[m] })
}

fn min_max(it: impl Iterator<Item = f64>) -> (Option<f64>, Option<f64>) {
    it.fold((None, None), |(lo, hi): (Option<f64>, Option<f64>), v| {
        (Some(lo.map_or(v, |l| l.min(v))), Some(hi.map_or(v, |h| h.max(v))))
    })
}

/// Index of the first on-ground sample belonging to this touchdown.
pub(crate) fn touchdown_sample(track: &[LandingSample], ts: u64) -> Option<usize> {
    let from = ts.saturating_sub(1500);
    track
        .iter()
        .position(|s| s.t_ms >= from && s.t_ms <= ts + 5000 && s.on_ground)
        .or_else(|| track.iter().position(|s| s.t_ms >= ts))
}

/// Values at the last time the aircraft descended through `gate_ft` before `td`.
fn gate_sample(points: &[ApproachPoint], td: usize, gate_ft: f64) -> Option<GateSample> {
    let j = (0..td).rev().find(|&j| points[j].hat_ft >= gate_ft)?;
    let (a, b) = (&points[j], &points[(j + 1).min(td)]);
    let f = if (a.hat_ft - b.hat_ft).abs() > 1e-9 { ((a.hat_ft - gate_ft) / (a.hat_ft - b.hat_ft)).clamp(0.0, 1.0) } else { 0.0 };
    let gp = match (a.glidepath_dev_deg, b.glidepath_dev_deg) {
        (Some(x), Some(y)) => Some(lerp(x, y, f)),
        (x, y) => x.or(y),
    };
    Some(GateSample {
        t_ms: lerp(a.t_ms as f64, b.t_ms as f64, f).round() as u64,
        hat_ft: gate_ft,
        dist_m: lerp(a.dist_m, b.dist_m, f),
        ias_kt: lerp(a.ias_kt, b.ias_kt, f),
        vs_fpm: lerp(a.vs_fpm, b.vs_fpm, f),
        bank_deg: lerp(a.bank_deg, b.bank_deg, f),
        // configuration: the state once through the gate (the later sample)
        flaps_index: b.flaps_index,
        gear_pct: b.gear_pct,
        glidepath_dev_deg: gp,
    })
}

pub(crate) fn criterion(kind: CriterionKind, measured: Option<f64>, min: Option<f64>, max: Option<f64>, reference: Option<f64>) -> Criterion {
    let status = match measured {
        None => CheckStatus::Unavailable,
        Some(v) if min.is_none_or(|m| v >= m - 1e-9) && max.is_none_or(|m| v <= m + 1e-9) => CheckStatus::Pass,
        Some(_) => CheckStatus::Fail,
    };
    Criterion { kind, status, measured, limit_min: min, limit_max: max, reference }
}

fn gate_check(gate_ft: f64, sample: Option<GateSample>, ref_ias: Option<f64>, cfg: &LandingConfig) -> GateCheck {
    let criteria = match &sample {
        None => Vec::new(),
        Some(s) => vec![
            criterion(CriterionKind::Gear, Some(s.gear_pct), Some(95.0), None, None),
            criterion(CriterionKind::Flaps, Some(s.flaps_index as f64), Some(1.0), None, None),
            criterion(CriterionKind::VerticalSpeed, Some(s.vs_fpm), Some(-cfg.max_vs_fpm), Some(cfg.max_vs_fpm), None),
            criterion(CriterionKind::Speed, ref_ias.map(|r| s.ias_kt - r), Some(-cfg.speed_below_kt), Some(cfg.speed_above_kt), ref_ias),
            criterion(
                CriterionKind::Glidepath,
                s.glidepath_dev_deg,
                Some(-cfg.glidepath_tolerance_deg),
                Some(cfg.glidepath_tolerance_deg),
                Some(cfg.glidepath_deg),
            ),
            criterion(CriterionKind::Bank, Some(s.bank_deg.abs()), None, Some(cfg.max_bank_deg), None),
        ],
    };
    GateCheck { gate_ft, reached: sample.is_some(), sample, criteria }
}

/// Largest |sin(direction - reference)| over the clockwise arc `from` → `to`, and whether
/// the crosswind there comes from the right.
fn worst_crosswind_factor(from: f64, to: f64, reference_heading_deg: f64) -> (f64, bool) {
    let span = (to - from).rem_euclid(360.0);
    let in_arc = |d: f64| (d - from).rem_euclid(360.0) <= span + 1e-9;
    let mut best = (0.0_f64, true);
    for d in [from, to, reference_heading_deg + 90.0, reference_heading_deg - 90.0] {
        if !in_arc(d) {
            continue;
        }
        let s = (d - reference_heading_deg).to_radians().sin();
        if s.abs() > best.0 + 1e-12 {
            best = (s.abs(), s > 0.0);
        }
    }
    best
}

pub fn wind_components(wind: &WindInput, reference_heading_deg: f64, relative_to_runway: bool) -> WindComponents {
    let comp = |speed: f64| {
        wind.direction_deg.map(|d| {
            let a = (d - reference_heading_deg).to_radians();
            (speed * a.cos(), speed * a.sin())
        })
    };
    let base = comp(wind.speed_kt);
    let gust = wind.gust_kt.and_then(comp);
    // worst case: VRB = the whole wind across, dddVddd = the worst direction of the range
    let (max_xw_factor, max_from_right) = match (wind.direction_deg, wind.variable_from_deg, wind.variable_to_deg) {
        (_, Some(from), Some(to)) => {
            let (f, r) = worst_crosswind_factor(from, to, reference_heading_deg);
            (Some(f), Some(r))
        }
        (None, _, _) => (Some(1.0), None),
        _ => (None, None),
    };
    WindComponents {
        direction_deg: wind.direction_deg,
        speed_kt: wind.speed_kt,
        gust_kt: wind.gust_kt,
        reference_heading_deg,
        relative_to_runway,
        headwind_kt: base.map(|c| c.0),
        crosswind_kt: base.map(|c| c.1),
        gust_headwind_kt: gust.map(|c| c.0),
        gust_crosswind_kt: gust.map(|c| c.1),
        variable_from_deg: wind.variable_from_deg,
        variable_to_deg: wind.variable_to_deg,
        max_crosswind_kt: max_xw_factor.map(|f| wind.speed_kt * f),
        max_gust_crosswind_kt: max_xw_factor.zip(wind.gust_kt).map(|(f, g)| g * f),
        max_crosswind_from_right: max_from_right,
    }
}

/// Reference speed cascade (module doc): user Vapp → flown median → VS0 × factor, plus
/// the VS0 plausibility check.
pub fn speed_reference(
    user_kt: Option<f64>,
    flown_kt: Option<f64>,
    vs0_kt: Option<f64>,
    cfg: &LandingConfig,
) -> (Option<f64>, SpeedReferenceSource, Option<bool>) {
    let vs0 = vs0_kt.filter(|s| *s > 0.0);
    let (v, src) = match (user_kt, flown_kt, vs0) {
        (Some(v), _, _) => (Some(v), SpeedReferenceSource::User),
        (None, Some(v), _) => (Some(v), SpeedReferenceSource::Flown),
        (None, None, Some(s)) => (Some(s * cfg.vs0_factor), SpeedReferenceSource::Design),
        _ => (None, SpeedReferenceSource::Unavailable),
    };
    let plausible = v.zip(vs0).map(|(v, s)| v >= cfg.vapp_min_vs0 * s - 1e-9 && v <= cfg.vapp_max_vs0 * s + 1e-9);
    (v, src, plausible)
}

/// Touchdown zone (start, end) past the threshold: 0 … min(`tdz_end_m`, length / 3).
fn tdz_bounds(length_m: f64, cfg: &LandingConfig) -> (f64, f64) {
    if cfg.tdz_first_third && length_m < 3.0 * cfg.tdz_end_m { (0.0, length_m / 3.0) } else { (0.0, cfg.tdz_end_m) }
}

/// Analyse touchdown `index` of a flight. Returns None only if there is no such touchdown;
/// a missing track or runway leaves the dependent fields empty. Nothing is known about the
/// aircraft (see [`analyze_with`]).
pub fn analyze(
    track: &[LandingSample],
    touchdowns: &[TouchdownReport],
    index: usize,
    runways: &[RunwayEnd],
    wind: Option<&WindInput>,
    cfg: &LandingConfig,
) -> Option<LandingAnalysis> {
    analyze_with(track, touchdowns, index, runways, wind, &AircraftRef::default(), cfg)
}

/// [`analyze`] with what is known about the aircraft (user Vapp, VS0) for the reference speed.
pub fn analyze_with(
    track: &[LandingSample],
    touchdowns: &[TouchdownReport],
    index: usize,
    runways: &[RunwayEnd],
    wind: Option<&WindInput>,
    aircraft: &AircraftRef,
    cfg: &LandingConfig,
) -> Option<LandingAnalysis> {
    let td = touchdowns.get(index)?.clone();
    let prev_ms = index.checked_sub(1).map(|i| touchdowns[i].timestamp_ms).unwrap_or(0);
    let next_ms = touchdowns.get(index + 1).map(|t| t.timestamp_ms).unwrap_or(u64::MAX);

    let matched = match_runway(td.latitude, td.longitude, td.heading_true_deg, runways, cfg);
    let frame = matched.map(|(_, f)| f);
    let (reference_speed_kt, reference_speed_source, reference_plausible) = speed_reference(aircraft.vapp_kt, None, aircraft.vs0_kt, cfg);

    let mut out = LandingAnalysis {
        touchdown_index: index,
        vs_band: vs_band(td.landing_rate_fpm),
        vs_measured_band: vs_band(td.vs_fpm_measured),
        vs_hardest_band: vs_band(td.vs_fpm_hardest),
        g_band: g_band(td.peak_g),
        reference_speed_kt,
        reference_speed_source,
        flown_reference_kt: None,
        vs0_kt: aircraft.vs0_kt,
        reference_plausible,
        runway: None,
        touchdown_point: None,
        touchdown_elevation_ft: None,
        threshold: None,
        approach: ApproachStats::default(),
        flare: None,
        rollout: None,
        wind: None,
        gates: Vec::new(),
        bounce_points: Vec::new(),
        distance_ref: if frame.is_some() { DistanceRef::Threshold } else { DistanceRef::Touchdown },
        samples: Vec::new(),
        config: cfg.clone(),
        touchdown: td.clone(),
    };

    if let Some((i, f)) = matched {
        let r = &runways[i];
        let (x, y) = f.project(td.latitude, td.longitude);
        let half_w = if r.width_m > 0.0 { r.width_m / 2.0 } else { 15.0 };
        out.runway = Some(RunwayMatch {
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
            heading_diff_deg: angle_diff_deg(td.heading_true_deg, f.heading_deg),
            on_runway: y.abs() <= half_w && (0.0..=f.length_m).contains(&x),
            geometry: RunwayGeometry::database(),
        });
        let (tdz_start_m, tdz_end_m) = tdz_bounds(f.length_m, cfg);
        out.touchdown_point = Some(TouchdownPoint {
            distance_m: x,
            distance_ft: x / M_PER_FT,
            lateral_m: y,
            tdz_start_m,
            tdz_end_m,
            aiming_point_m: aiming_point_m(f.length_m),
            in_tdz: x >= tdz_start_m && x <= tdz_end_m && y.abs() <= half_w,
            remaining_m: f.length_m - x,
            lateral_measurable: true,
            distance_uncertainty_m: None,
        });
    }

    if let Some(w) = wind {
        out.wind = Some(match &frame {
            Some(f) => wind_components(w, f.heading_deg, true),
            None => wind_components(w, td.heading_true_deg, false),
        });
    }

    let Some(td_idx) = touchdown_sample(track, td.timestamp_ms) else {
        out.gates = vec![gate_check(1000.0, None, None, cfg), gate_check(500.0, None, None, cfg)];
        return Some(out);
    };
    let elev = track[td_idx].altitude_msl_ft;
    out.touchdown_elevation_ft = Some(elev);
    let hat = |s: &LandingSample| s.altitude_msl_ft - elev;
    let lower = track.iter().position(|s| s.t_ms > prev_ms + 5000).unwrap_or(0).min(td_idx);

    // approach start: last time above the start height, else the fallback distance
    let mut start = None;
    let mut reason = StartReason::TrackStart;
    for i in (lower..td_idx).rev() {
        if hat(&track[i]) >= cfg.approach_start_ft {
            start = Some(i);
            reason = StartReason::Altitude;
            break;
        }
    }
    if start.is_none() {
        let mut path = 0.0;
        for i in (lower..td_idx).rev() {
            let (a, b) = (&track[i], &track[i + 1]);
            path += distance_m(a.latitude, a.longitude, b.latitude, b.longitude);
            if path >= cfg.approach_fallback_m {
                start = Some(i);
                reason = StartReason::Distance;
                break;
            }
        }
    }
    let start = start.unwrap_or(lower);

    // end: rollout below the end speed, liftoff (touch-and-go), next touchdown or 90 s
    let mut end = td_idx;
    let mut rollout_end = None;
    for (i, s) in track.iter().enumerate().skip(td_idx) {
        if s.t_ms >= next_ms || s.t_ms > td.timestamp_ms + 180_000 {
            break;
        }
        end = i;
        if !s.on_ground && hat(s) > 50.0 {
            break;
        }
        if s.on_ground && s.ground_speed_kt < cfg.rollout_end_kt {
            rollout_end = Some(i);
            break;
        }
    }

    // path distance to the touchdown point (fallback distance reference)
    let mut path_to_td = vec![0.0; end - start + 1];
    for i in (start..td_idx).rev() {
        let (a, b) = (&track[i], &track[i + 1]);
        path_to_td[i - start] = path_to_td[i + 1 - start] + distance_m(a.latitude, a.longitude, b.latitude, b.longitude);
    }
    for i in td_idx + 1..=end {
        let (a, b) = (&track[i - 1], &track[i]);
        path_to_td[i - start] = path_to_td[i - 1 - start] - distance_m(a.latitude, a.longitude, b.latitude, b.longitude);
    }

    let tan_gp = cfg.glidepath_deg.to_radians().tan();
    let gpip_x = cfg.tch_ft * M_PER_FT / tan_gp;
    out.samples = (start..=end)
        .map(|i| {
            let s = &track[i];
            let h = hat(s);
            let xy = frame.map(|f| f.project(s.latitude, s.longitude));
            let (gp, dev) = match xy {
                Some((x, _)) if i < td_idx && x <= 0.0 && gpip_x - x >= 0.25 * M_PER_NM => {
                    let a = (h * M_PER_FT).atan2(gpip_x - x).to_degrees();
                    (Some(a), Some(a - cfg.glidepath_deg))
                }
                _ => (None, None),
            };
            ApproachPoint {
                t_ms: s.t_ms,
                latitude: s.latitude,
                longitude: s.longitude,
                hat_ft: h,
                ias_kt: s.ias_kt,
                ground_speed_kt: s.ground_speed_kt,
                vs_fpm: s.vertical_speed_fpm,
                bank_deg: s.bank_deg,
                pitch_deg: s.pitch_deg,
                on_ground: s.on_ground,
                flaps_index: s.flaps_index,
                gear_pct: s.gear_pct,
                x_m: xy.map(|v| v.0),
                y_m: xy.map(|v| v.1),
                dist_m: xy.map(|v| -v.0).unwrap_or(path_to_td[i - start]),
                glidepath_deg: gp,
                glidepath_dev_deg: dev,
            }
        })
        .collect();
    let pts = &out.samples;
    let tdp = td_idx - start;
    let airborne: Vec<&ApproachPoint> = pts[..tdp].iter().filter(|p| !p.on_ground).collect();

    // approach statistics
    let a = &mut out.approach;
    a.start_reason = Some(reason);
    a.start_hat_ft = pts.first().map(|p| p.hat_ft);
    a.start_dist_m = pts.first().map(|p| p.dist_m);
    a.duration_s = pts.first().map(|p| (td.timestamp_ms.saturating_sub(p.t_ms)) as f64 / 1000.0);
    (a.ias_min_kt, a.ias_max_kt) = min_max(airborne.iter().map(|p| p.ias_kt));
    (a.vs_min_1000_fpm, a.vs_max_1000_fpm) = min_max(airborne.iter().filter(|p| p.hat_ft <= 1000.0).map(|p| p.vs_fpm));
    (a.vs_min_500_fpm, a.vs_max_500_fpm) = min_max(airborne.iter().filter(|p| p.hat_ft <= 500.0).map(|p| p.vs_fpm));
    a.bank_max_below_500_deg = min_max(airborne.iter().filter(|p| p.hat_ft <= 500.0).map(|p| p.bank_deg.abs())).1;
    let devs = airborne.iter().filter(|p| p.hat_ft <= 1000.0).filter_map(|p| p.glidepath_dev_deg);
    let (lo, hi) = min_max(devs);
    a.glidepath_dev_max_above_deg = hi.filter(|v| *v > 0.0);
    a.glidepath_dev_max_below_deg = lo.filter(|v| *v < 0.0);
    a.ias_at_touchdown_kt = Some(pts[tdp].ias_kt);

    let g1000 = gate_sample(pts, tdp, 1000.0);
    let g500 = gate_sample(pts, tdp, 500.0);
    a.ias_at_500_kt = g500.as_ref().map(|g| g.ias_kt);
    a.ias_at_50_kt = gate_sample(pts, tdp, 50.0).map(|g| g.ias_kt);
    a.glidepath_dev_at_1000_deg = g1000.as_ref().and_then(|g| g.glidepath_dev_deg);
    a.glidepath_dev_at_500_deg = g500.as_ref().and_then(|g| g.glidepath_dev_deg);
    // reference speed: never the IAS at the gate itself (that made the criterion a tautology)
    let flown: Vec<f64> = airborne.iter().filter(|p| p.hat_ft <= cfg.vapp_from_ft && p.hat_ft >= cfg.vapp_to_ft).map(|p| p.ias_kt).collect();
    let flown = if flown.len() >= 3 { median(flown) } else { None };
    let (ref_ias, ref_src, plausible) = speed_reference(aircraft.vapp_kt, flown, aircraft.vs0_kt, cfg);
    out.flown_reference_kt = flown;
    out.reference_speed_kt = ref_ias;
    out.reference_speed_source = ref_src;
    out.reference_plausible = plausible;
    out.gates = vec![gate_check(1000.0, g1000, ref_ias, cfg), gate_check(500.0, g500, ref_ias, cfg)];

    // threshold crossing
    if frame.is_some() {
        for k in 0..tdp {
            let (p, q) = (&pts[k], &pts[k + 1]);
            if let (Some(x0), Some(x1)) = (p.x_m, q.x_m)
                && x0 < 0.0
                && x1 >= 0.0
            {
                let f = -x0 / (x1 - x0);
                let t = lerp(p.t_ms as f64, q.t_ms as f64, f);
                out.threshold = Some(ThresholdCrossing {
                    t_ms: t.round() as u64,
                    height_ft: lerp(p.hat_ft, q.hat_ft, f).max(0.0),
                    ias_kt: lerp(p.ias_kt, q.ias_kt, f),
                    airborne_s: ((td.timestamp_ms as f64 - t) / 1000.0).max(0.0),
                });
            }
        }
    }

    // flare: contiguous run of clearly reduced V/S that ends at the touchdown
    let approach_vs = median(airborne.iter().filter(|p| (200.0..=500.0).contains(&p.hat_ft)).map(|p| p.vs_fpm).collect())
        .or_else(|| median(airborne.iter().filter(|p| (100.0..=1000.0).contains(&p.hat_ft)).map(|p| p.vs_fpm).collect()));
    if let Some(ref_vs) = approach_vs.filter(|v| *v < -200.0) {
        let limit = ref_vs.abs() * cfg.flare_vs_fraction;
        let mut first_reduced = None;
        for k in (0..tdp).rev() {
            let p = &pts[k];
            if p.on_ground || p.hat_ft > 200.0 || p.vs_fpm.abs() > limit {
                break;
            }
            first_reduced = Some(k);
        }
        if let Some(k) = first_reduced {
            let s = &pts[k.saturating_sub(1)];
            out.flare = Some(Flare {
                start_hat_ft: s.hat_ft,
                start_t_ms: s.t_ms,
                duration_s: td.timestamp_ms.saturating_sub(s.t_ms) as f64 / 1000.0,
                approach_vs_fpm: ref_vs,
                final_vs_fpm: pts[tdp - 1].vs_fpm,
            });
        }
    }

    // rollout
    if let Some(r) = rollout_end.filter(|_| !td.touch_and_go) {
        let e = &pts[r - start];
        let end_x = e.x_m;
        // distance along the flown ground path (also right when the rollout leaves the runway axis)
        let distance_m = distance_m(td.latitude, td.longitude, pts[tdp].latitude, pts[tdp].longitude)
            + pts[tdp..=r - start].windows(2).map(|w| distance_m(w[0].latitude, w[0].longitude, w[1].latitude, w[1].longitude)).sum::<f64>();
        out.rollout = Some(Rollout {
            distance_m: distance_m.max(0.0),
            duration_s: e.t_ms.saturating_sub(td.timestamp_ms) as f64 / 1000.0,
            end_lat: e.latitude,
            end_lon: e.longitude,
            // only meaningful when the rollout went down the runway (not back or off it)
            remaining_m: match (frame, end_x, out.touchdown_point.as_ref()) {
                (Some(f), Some(x), Some(tp)) if x >= tp.distance_m => Some(f.length_m - x),
                _ => None,
            },
        });
    }

    // bounces: further air→ground edges in the window, as far as 1 Hz resolves them
    if td.bounces > 0 {
        let window_end = td.timestamp_ms + 5000 * (td.bounces as u64 + 1);
        for k in tdp + 1..pts.len() {
            if out.bounce_points.len() as u32 >= td.bounces || pts[k].t_ms > window_end {
                break;
            }
            if pts[k].on_ground && !pts[k - 1].on_ground {
                let p = &pts[k];
                out.bounce_points.push(GroundPoint { t_ms: p.t_ms, latitude: p.latitude, longitude: p.longitude, x_m: p.x_m, y_m: p.y_m });
            }
        }
    }

    Some(out)
}

/// Mark the runway of an analysis with where its geometry came from. Derived geometry: the
/// centreline offset is not measurable (the axis is the own rollout), the touchdown distance
/// carries the threshold uncertainty, and with an estimated (lower-bound) length the zone is
/// the fixed `tdz_end_m`, the aiming point the default 300 m and the rollout has no
/// "remaining" distance.
pub fn apply_runway_geometry(a: &mut LandingAnalysis, g: &RunwayGeometry) {
    let Some(r) = a.runway.as_mut() else { return };
    r.apply_geometry(g);
    let half_w = r.width_m.map_or(15.0, |w| w / 2.0);
    if let Some(tp) = a.touchdown_point.as_mut() {
        tp.lateral_measurable = !g.source.is_derived();
        tp.distance_uncertainty_m = g.along_uncertainty_m;
        if g.length_estimated {
            tp.tdz_end_m = a.config.tdz_end_m;
            tp.aiming_point_m = DERIVE_DEFAULT_AIM_M;
            tp.in_tdz = tp.distance_m >= tp.tdz_start_m && tp.distance_m <= tp.tdz_end_m && tp.lateral_m.abs() <= half_w;
        }
    }
    if g.length_estimated
        && let Some(ro) = a.rollout.as_mut()
    {
        ro.remaining_m = None;
    }
}

// ---- runway derived from the track ------------------------------------------------------

/// ± metres of a derived threshold along the axis (aiming-point assumption, 1 Hz sampling).
pub const DERIVED_ALONG_UNCERTAINTY_M: f64 = 50.0;
/// ± metres of a derived axis across (the pilot's own line, not the painted centreline).
pub const DERIVED_CROSS_UNCERTAINTY_M: f64 = 5.0;
/// Shortest ground run (path) a runway is derived from.
pub const DERIVE_MIN_GROUND_RUN_M: f64 = 150.0;
/// Threshold this far before the touchdown point when the runway length is unknown
/// (aiming point of a 1200–2400 m runway, ICAO Annex 14 Tab. 5-2).
pub const DERIVE_DEFAULT_AIM_M: f64 = 300.0;
/// A database designator fits the derived course within this.
pub const DERIVE_IDENT_TOLERANCE_DEG: f64 = 15.0;
/// Ground-run points further than this from the fitted line end the run (turn-off).
const DERIVE_MAX_RESIDUAL_M: f64 = 7.5;
/// Final approach window: airborne samples 60 s → touchdown, at least 20 s of them.
const DERIVE_FINAL_WINDOW_MS: u64 = 60_000;
const DERIVE_FINAL_MIN_MS: u64 = 20_000;
/// The final course counts as stable within this circular standard deviation …
const DERIVE_FINAL_MAX_SD_DEG: f64 = 5.0;
/// … and is blended into the axis (weakly) when it is within this of the rollout course.
const DERIVE_FINAL_BLEND_DEG: f64 = 10.0;
const DERIVE_FINAL_WEIGHT: f64 = 0.1;

/// What the database knows about one runway of the landing airport (OurAirports row; the
/// coordinates themselves are not needed, only whether it has them).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunwayHint {
    pub le_ident: String,
    pub he_ident: String,
    /// True headings from the database, if any.
    pub le_heading_deg: Option<f64>,
    pub he_heading_deg: Option<f64>,
    pub length_m: Option<f64>,
    pub width_m: Option<f64>,
    pub surface: String,
    pub has_coordinates: bool,
}

/// The airport a runway is derived for.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirportHint {
    pub icao: String,
    pub runways: Vec<RunwayHint>,
}

/// A runway estimated from one landing ([`derive_runway_from_track`]).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedRunway {
    /// Geometry for the analysis: threshold, far end (declared length, else the lower bound
    /// threshold → rollout end), touchdown elevation as `elevation_ft`, width 0 = unknown
    /// unless the database runway has one.
    pub end: RunwayEnd,
    pub geometry: RunwayGeometry,
    /// Axis direction used (rollout, weakly blended with a stable final), true.
    pub course_true_deg: f64,
    /// Course of the fitted ground run alone.
    pub rollout_course_deg: f64,
    /// Mean ground track of the last 20–60 s airborne and its circular standard deviation.
    pub approach_course_deg: Option<f64>,
    pub approach_course_sd_deg: Option<f64>,
    /// Ground path used for the fit, m.
    pub ground_run_m: f64,
    /// The ground run reached `rollout_end_kt` (30 kt) on the ground: a finished rollout,
    /// not a live track still rolling or a touch-and-go.
    pub rollout_complete: bool,
    /// Threshold → touchdown point along the axis, m (the assumption it rests on).
    pub touchdown_distance_m: f64,
}

/// Leading number of a designator ("09L" → 9); None for "H1" and other non-runway idents.
pub fn ident_number(ident: &str) -> Option<u32> {
    let digits: String = ident.trim().chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok().filter(|n| (1..=36).contains(n))
}

/// Designator of a true course rounded to 10° ("09"; 0 → "36"). No L/C/R: not knowable
/// from one track. True, not magnetic: off by one where the variation exceeds ~5°.
pub fn designator_for(course_true_deg: f64) -> String {
    let n = (course_true_deg.rem_euclid(360.0) / 10.0).round() as u32 % 36;
    format!("{:02}", if n == 0 { 36 } else { n })
}

/// Reciprocal designator: "09L" → "27R", "36" → "18", "04C" → "22C". Unchanged without a number.
pub fn opposite_ident(ident: &str) -> String {
    let Some(n) = ident_number(ident) else { return ident.to_string() };
    let o = (n + 17) % 36 + 1;
    let suffix: String = ident.trim().chars().skip_while(|c| c.is_ascii_digit()).collect();
    let suffix = match suffix.as_str() {
        "L" => "R",
        "R" => "L",
        s => s,
    };
    format!("{o:02}{suffix}")
}

/// Point `dist_m` from (`lat`, `lon`) on true course `heading_deg` (local flat frame).
pub fn offset_point(lat: f64, lon: f64, heading_deg: f64, dist_m: f64) -> (f64, f64) {
    let h = heading_deg.to_radians();
    let (e, n) = (dist_m * h.sin(), dist_m * h.cos());
    (lat + (n / EARTH_R_M).to_degrees(), lon + (e / (EARTH_R_M * lat.to_radians().cos())).to_degrees())
}

/// Least-squares line through local (east, north) points: unit direction (oriented from
/// the first to the last point), centroid and the largest perpendicular residual.
fn fit_line(pts: &[(f64, f64)]) -> ((f64, f64), (f64, f64), f64) {
    let n = pts.len() as f64;
    let (ce, cn) = pts.iter().fold((0.0, 0.0), |(a, b), p| (a + p.0 / n, b + p.1 / n));
    let (mut see, mut snn, mut sen) = (0.0, 0.0, 0.0);
    for p in pts {
        let (e, nn) = (p.0 - ce, p.1 - cn);
        see += e * e;
        snn += nn * nn;
        sen += e * nn;
    }
    let th = 0.5 * (2.0 * sen).atan2(see - snn);
    let mut d = (th.cos(), th.sin());
    let (first, last) = (pts[0], pts[pts.len() - 1]);
    if (last.0 - first.0) * d.0 + (last.1 - first.1) * d.1 < 0.0 {
        d = (-d.0, -d.1);
    }
    let max_res = pts.iter().map(|p| ((p.0 - ce) * d.1 - (p.1 - cn) * d.0).abs()).fold(0.0, f64::max);
    (d, (ce, cn), max_res)
}

/// Estimate the runway of a touchdown from the track when no database geometry exists:
///
/// - Axis: least-squares line through the touchdown point and the ground run after it
///   (on the ground until the ground speed falls below 30 kt, bounces included; a turn-off
///   that leaves the line by more than 7.5 m is cut), at least 150 m of path. A stable final
///   (ground track of the last 20–60 s airborne, circular SD ≤ 5°, within 10° of the
///   rollout) is blended in with a small weight.
/// - Threshold: on the axis, the aiming point before the touchdown point (300 m without a
///   known length, else Annex 14 by length), moved closer when the rollout would otherwise
///   run past the declared end. ±50 m along / ±5 m across ([`RunwayGeometry::derived`]).
/// - Designator: from a database runway of the airport without coordinates whose direction
///   (true heading, else designator × 10) fits within ±15° (`DatabaseDerived`; length, width
///   and surface taken over; ambiguous parallels keep only the number), else the course
///   rounded to 10° (`Derived`).
///
/// None without an on-ground sample at the touchdown, with a ground run too short or too
/// curved, or when the airport has runways with coordinates but no coordinate-less one in
/// this direction (then the landing was beside a known runway, not on an unknown one).
pub fn derive_runway_from_track(samples: &[LandingSample], touchdown: &TouchdownReport, airport: &AirportHint) -> Option<DerivedRunway> {
    let td_idx = touchdown_sample(samples, touchdown.timestamp_ms)?;
    if !samples[td_idx].on_ground {
        return None;
    }
    let elev = samples[td_idx].altitude_msl_ft;
    let (lat0, lon0) = (touchdown.latitude, touchdown.longitude);
    let cos0 = lat0.to_radians().cos();
    let enu = |lat: f64, lon: f64| ((lon - lon0).to_radians() * EARTH_R_M * cos0, (lat - lat0).to_radians() * EARTH_R_M);

    // ground run
    let mut pts = vec![(0.0, 0.0)];
    let mut complete = false;
    for s in &samples[td_idx..] {
        if s.t_ms > touchdown.timestamp_ms + 180_000 || (!s.on_ground && s.altitude_msl_ft - elev > 50.0) {
            break;
        }
        pts.push(enu(s.latitude, s.longitude));
        if s.on_ground && s.ground_speed_kt < LandingConfig::default().rollout_end_kt {
            complete = true;
            break;
        }
    }
    let path = |p: &[(f64, f64)]| p.windows(2).map(|w| (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1)).sum::<f64>();
    let mut n = pts.len();
    let (dir, c) = loop {
        if n < 3 || path(&pts[..n]) < DERIVE_MIN_GROUND_RUN_M {
            return None;
        }
        let (d, c, res) = fit_line(&pts[..n]);
        if res <= DERIVE_MAX_RESIDUAL_M {
            break (d, c);
        }
        n -= 1;
    };
    let pts = &pts[..n];
    let ground_run_m = path(pts);
    let rollout_course = dir.0.atan2(dir.1).to_degrees().rem_euclid(360.0);

    // final approach course
    let t_td = samples[td_idx].t_ms;
    let fin: Vec<&LandingSample> =
        samples[..td_idx].iter().filter(|s| !s.on_ground && s.t_ms + DERIVE_FINAL_WINDOW_MS >= t_td).collect();
    let mut approach = None;
    if fin.len() >= 3 && fin[fin.len() - 1].t_ms.saturating_sub(fin[0].t_ms) + 1000 >= DERIVE_FINAL_MIN_MS {
        let (mut se, mut sn, mut len) = (0.0, 0.0, 0.0);
        for w in fin.windows(2) {
            let (a, b) = (enu(w[0].latitude, w[0].longitude), enu(w[1].latitude, w[1].longitude));
            let d = (b.0 - a.0).hypot(b.1 - a.1);
            if d > 5.0 {
                se += b.0 - a.0;
                sn += b.1 - a.1;
                len += d;
            }
        }
        if len > 0.0 {
            let r = (se.hypot(sn) / len).min(1.0);
            let sd = (-2.0 * r.max(1e-12).ln()).sqrt().to_degrees();
            approach = Some((se.atan2(sn).to_degrees().rem_euclid(360.0), sd, len));
        }
    }
    let mut course = rollout_course;
    if let Some((fc, sd, len)) = approach
        && sd <= DERIVE_FINAL_MAX_SD_DEG
        && angle_diff_deg(fc, rollout_course) <= DERIVE_FINAL_BLEND_DEG
    {
        let (wr, wf) = (ground_run_m, DERIVE_FINAL_WEIGHT * len);
        let (fr, ff) = (rollout_course.to_radians(), fc.to_radians());
        course = (wr * fr.sin() + wf * ff.sin()).atan2(wr * fr.cos() + wf * ff.cos()).to_degrees().rem_euclid(360.0);
    }
    let dir = (course.to_radians().sin(), course.to_radians().cos());

    // designator from the database
    let mut fits: Vec<(&RunwayHint, &str, &str)> = Vec::new();
    for r in airport.runways.iter().filter(|r| !r.has_coordinates) {
        for (ident, opp, hdg) in [(&r.le_ident, &r.he_ident, r.le_heading_deg), (&r.he_ident, &r.le_ident, r.he_heading_deg)] {
            let Some(h) = hdg.or_else(|| ident_number(ident).map(|n| n as f64 * 10.0)) else { continue };
            if angle_diff_deg(h, course) <= DERIVE_IDENT_TOLERANCE_DEG {
                fits.push((r, ident.as_str(), opp.as_str()));
            }
        }
    }
    if fits.is_empty() && airport.runways.iter().any(|r| r.has_coordinates) {
        return None;
    }
    let (ident, opposite, length, width, surface, source) = match fits.as_slice() {
        [] => {
            let id = designator_for(course);
            let opp = opposite_ident(&id);
            (id, opp, None, None, String::new(), RunwayGeometrySource::Derived)
        }
        [(r, id, opp)] => (id.to_string(), opp.to_string(), r.length_m, r.width_m, r.surface.clone(), RunwayGeometrySource::DatabaseDerived),
        many => {
            // parallels: the number is known, the side is not
            let nums: Vec<Option<u32>> = many.iter().map(|(_, id, _)| ident_number(id)).collect();
            let id = match nums[0] {
                Some(n) if nums.iter().all(|m| *m == Some(n)) => format!("{n:02}"),
                _ => designator_for(course),
            };
            let len = many[0].0.length_m.filter(|l| many.iter().all(|(r, _, _)| r.length_m == Some(*l)));
            let opp = opposite_ident(&id);
            (id, opp, len, None, String::new(), RunwayGeometrySource::Derived)
        }
    };

    // threshold and far end on the axis
    let along = |p: (f64, f64)| (p.0 - c.0) * dir.0 + (p.1 - c.1) * dir.1;
    let x_td = along((0.0, 0.0));
    let x_end = pts.iter().map(|p| along(*p)).fold(x_td, f64::max);
    let roll = x_end - x_td;
    let mut d = length.map_or(DERIVE_DEFAULT_AIM_M, aiming_point_m);
    if let Some(l) = length
        && d + roll > l
    {
        d = (l - roll).max(0.0);
    }
    let len = length.unwrap_or_else(|| ((d + roll) / 50.0).ceil() * 50.0).max(d + roll);
    let to_ll = |x: f64| {
        let (e, nn) = (c.0 + dir.0 * x, c.1 + dir.1 * x);
        (lat0 + (nn / EARTH_R_M).to_degrees(), lon0 + (e / (EARTH_R_M * cos0)).to_degrees())
    };
    let (thr_lat, thr_lon) = to_ll(x_td - d);
    let (end_lat, end_lon) = to_ll(x_td - d + len);

    Some(DerivedRunway {
        end: RunwayEnd {
            airport: airport.icao.clone(),
            ident,
            opposite_ident: opposite,
            threshold_lat: thr_lat,
            threshold_lon: thr_lon,
            end_lat,
            end_lon,
            length_m: 0.0,
            width_m: width.unwrap_or(0.0),
            surface,
            elevation_ft: Some(elev),
        },
        geometry: RunwayGeometry::derived(source, length.is_none(), 1),
        course_true_deg: course,
        rollout_course_deg: rollout_course,
        approach_course_deg: approach.map(|a| a.0),
        approach_course_sd_deg: approach.map(|a| a.1),
        ground_run_m,
        rollout_complete: complete,
        touchdown_distance_m: d,
    })
}

/// Weighted mean of a stored runway (`old`, weight `old_weight` = landings so far) and a new
/// estimate of the same landing direction: threshold position, axis direction (circular)
/// and elevation averaged; length the longer of both (a derived length is a lower bound).
/// Identity, surface and width stay those of `old` (width from `new` if `old` has none).
pub fn blend_runway(old: &RunwayEnd, old_weight: f64, new: &RunwayEnd) -> RunwayEnd {
    let w = old_weight.max(0.0);
    let t = w + 1.0;
    let (fo, fnew) = (RunwayFrame::new(old), RunwayFrame::new(new));
    let thr_lat = (old.threshold_lat * w + new.threshold_lat) / t;
    let thr_lon = (old.threshold_lon * w + new.threshold_lon) / t;
    let (ho, hn) = (fo.heading_deg.to_radians(), fnew.heading_deg.to_radians());
    let h = (w * ho.sin() + hn.sin()).atan2(w * ho.cos() + hn.cos()).to_degrees().rem_euclid(360.0);
    let len = fo.length_m.max(fnew.length_m);
    let (end_lat, end_lon) = offset_point(thr_lat, thr_lon, h, len);
    RunwayEnd {
        threshold_lat: thr_lat,
        threshold_lon: thr_lon,
        end_lat,
        end_lon,
        length_m: 0.0,
        width_m: if old.width_m > 0.0 { old.width_m } else { new.width_m },
        elevation_ft: match (old.elevation_ft, new.elevation_ft) {
            (Some(a), Some(b)) => Some((a * w + b) / t),
            (a, b) => a.or(b),
        },
        ..old.clone()
    }
}

// ---- tests ----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const ELEV: f64 = 400.0;

    fn runway() -> RunwayEnd {
        // threshold at 50°N 8°E, runway 09 (true 090), 3000 m long, 45 m wide
        let f = RunwayFrame::new(&RunwayEnd { threshold_lat: 50.0, threshold_lon: 8.0, end_lat: 50.0, end_lon: 8.03, ..Default::default() });
        let (end_lat, end_lon) = f.unproject(3000.0, 0.0);
        RunwayEnd {
            airport: "TEST".into(),
            ident: "09".into(),
            opposite_ident: "27".into(),
            threshold_lat: 50.0,
            threshold_lon: 8.0,
            end_lat,
            end_lon,
            length_m: 3000.0,
            width_m: 45.0,
            surface: "ASP".into(),
            elevation_ft: None,
        }
    }

    fn both_ends() -> Vec<RunwayEnd> {
        let a = runway();
        let b = RunwayEnd {
            ident: "27".into(),
            opposite_ident: "09".into(),
            threshold_lat: a.end_lat,
            threshold_lon: a.end_lon,
            end_lat: a.threshold_lat,
            end_lon: a.threshold_lon,
            ..a.clone()
        };
        vec![a, b]
    }

    /// Straight-in approach on runway 09: 140 kt on a `gp_deg` path from 6 nm,
    /// flare at `flare_ft` to −`flare_vs` fpm, touchdown, braking to a stop.
    /// `lateral` metres right of the centreline throughout.
    fn approach(gp_deg: f64, flare_ft: f64, flare_vs: f64, lateral: f64) -> (Vec<LandingSample>, TouchdownReport) {
        let f = RunwayFrame::new(&runway());
        let tan = gp_deg.to_radians().tan();
        let gpip = 50.0 * M_PER_FT / 3f64.to_radians().tan();
        let mut x = -6.0 * M_PER_NM;
        let mut gs_ms: f64 = 140.0 * 0.514_444;
        let mut h_ft: f64 = (gpip - x) * tan / M_PER_FT;
        let mut flaring = false;
        let mut on_ground = false;
        let mut out = Vec::new();
        let mut td = None;
        for t in 0..400u64 {
            let prev_h = h_ft;
            if !on_ground {
                let line = ((gpip - x) * tan / M_PER_FT).max(0.0);
                if !flaring && line <= flare_ft {
                    flaring = true;
                }
                h_ft = if flaring { (h_ft - flare_vs / 60.0).max(0.0) } else { line };
                if h_ft <= 0.0 {
                    on_ground = true;
                }
            } else {
                gs_ms = (gs_ms - 2.5).max(0.0);
            }
            let vs = if on_ground && prev_h <= 0.0 { 0.0 } else { (h_ft - prev_h) * 60.0 };
            let (lat, lon) = f.unproject(x, lateral);
            let s = LandingSample {
                t_ms: 1_000_000 + t * 1000,
                latitude: lat,
                longitude: lon,
                altitude_msl_ft: ELEV + h_ft,
                altitude_agl_ft: h_ft,
                ground_speed_kt: gs_ms / 0.514_444,
                ias_kt: gs_ms / 0.514_444,
                vertical_speed_fpm: vs,
                heading_true_deg: 90.0,
                pitch_deg: 2.0,
                bank_deg: 0.0,
                g_force: 1.0,
                on_ground,
                flaps_index: 3,
                gear_pct: 100.0,
            };
            if on_ground && td.is_none() {
                let last_air = out.last().map(|p: &LandingSample| p.vertical_speed_fpm).unwrap_or(vs);
                td = Some(TouchdownReport {
                    timestamp_ms: s.t_ms,
                    vs_fpm_measured: last_air,
                    vs_fpm_sim: -flare_vs,
                    vs_fpm_hardest: last_air,
                    peak_g: 1.12,
                    pitch_deg: 3.0,
                    bank_deg: 0.0,
                    ground_speed_kt: s.ground_speed_kt,
                    heading_true_deg: 90.0,
                    latitude: lat,
                    longitude: lon,
                    bounces: 0,
                    touch_and_go: false,
                    landing_rate_fpm: -flare_vs,
                    landing_rate_source: crate::LandingRateSource::Sim,
                });
            }
            out.push(s);
            x += gs_ms;
            if on_ground && gs_ms <= 0.0 {
                break;
            }
        }
        (out, td.expect("touched down"))
    }

    fn status(g: &GateCheck, k: CriterionKind) -> CheckStatus {
        g.criteria.iter().find(|c| c.kind == k).unwrap().status
    }

    #[test]
    fn frame_roundtrip_and_sides() {
        let f = RunwayFrame::new(&runway());
        assert!((f.heading_deg - 90.0).abs() < 0.01, "{}", f.heading_deg);
        let (lat, lon) = f.unproject(1234.0, -17.0);
        let (x, y) = f.project(lat, lon);
        assert!((x - 1234.0).abs() < 0.01 && (y + 17.0).abs() < 0.01);
        // landing east, south is to the right
        let (_, y) = f.project(49.999, 8.01);
        assert!(y > 0.0);
    }

    #[test]
    fn straight_in_approach() {
        let (track, td) = approach(3.0, 20.0, 250.0, 3.0);
        let a = analyze(&track, std::slice::from_ref(&td), 0, &both_ends(), None, &LandingConfig::default()).unwrap();

        let rwy = a.runway.as_ref().expect("runway matched");
        assert_eq!(rwy.ident, "09");
        assert!(rwy.on_runway);
        let tp = a.touchdown_point.as_ref().unwrap();
        let expected_x = RunwayFrame::new(&runway()).project(td.latitude, td.longitude).0;
        assert!((tp.distance_m - expected_x).abs() < 0.5);
        assert!(tp.distance_m > 450.0 && tp.distance_m < 650.0, "touchdown at {} m", tp.distance_m);
        assert!((tp.distance_ft - tp.distance_m / M_PER_FT).abs() < 1e-6);
        assert!((tp.lateral_m - 3.0).abs() < 0.2, "lateral {}", tp.lateral_m);
        assert!(tp.in_tdz);
        // the zone starts at the threshold; 400 m is the aiming point of a 3000 m runway
        assert_eq!((tp.tdz_start_m, tp.tdz_end_m, tp.aiming_point_m), (0.0, 900.0, 400.0));

        // approach from 1000 ft, on the 3° path
        assert_eq!(a.approach.start_reason, Some(StartReason::Altitude));
        assert_eq!(a.distance_ref, DistanceRef::Threshold);
        let dev = a.approach.glidepath_dev_at_1000_deg.unwrap();
        assert!(dev.abs() < 0.1, "glidepath deviation at 1000 ft {dev}");
        assert!(a.approach.glidepath_dev_at_500_deg.unwrap().abs() < 0.1);
        let vs = a.approach.vs_min_1000_fpm.unwrap();
        assert!((-800.0..-700.0).contains(&vs), "approach V/S {vs}");
        assert!((a.approach.ias_at_500_kt.unwrap() - 140.0).abs() < 0.5);
        // reference: median IAS 500 → 100 ft (nothing known about the aircraft)
        assert_eq!(a.reference_speed_source, SpeedReferenceSource::Flown);
        assert!((a.reference_speed_kt.unwrap() - 140.0).abs() < 0.5);
        assert_eq!(a.flown_reference_kt, a.reference_speed_kt);
        assert_eq!(a.reference_plausible, None);

        // flare from ~20 ft
        let fl = a.flare.as_ref().expect("flare detected");
        assert!(fl.start_hat_ft > 15.0 && fl.start_hat_ft < 40.0, "flare at {} ft", fl.start_hat_ft);
        assert!(fl.duration_s >= 4.0 && fl.duration_s <= 7.0, "flare {} s", fl.duration_s);
        assert!((fl.final_vs_fpm + 250.0).abs() < 1.0);

        let th = a.threshold.as_ref().expect("threshold crossing");
        assert!(th.height_ft > 35.0 && th.height_ft < 60.0, "TCH {}", th.height_ft);
        assert!(th.airborne_s > 3.0 && th.airborne_s < 10.0);

        // stabilised at both gates
        assert_eq!(a.gates.len(), 2);
        for g in &a.gates {
            assert!(g.reached);
            assert!(g.criteria.iter().all(|c| c.status == CheckStatus::Pass), "gate {} {:?}", g.gate_ft, g.criteria);
        }

        // rollout: 140 kt → 30 kt at 2.5 m/s² ≈ 23 s, ~1000 m
        let r = a.rollout.as_ref().unwrap();
        assert!(r.distance_m > 800.0 && r.distance_m < 1300.0, "rollout {}", r.distance_m);
        assert!(r.remaining_m.unwrap() > 0.0);
        assert_eq!(a.vs_band, Band::Normal);
        assert_eq!(a.g_band, Band::Smooth);
    }

    #[test]
    fn steep_approach_fails_vs_and_glidepath() {
        let (track, td) = approach(4.5, 20.0, 250.0, 0.0);
        let a = analyze(&track, &[td], 0, &both_ends(), None, &LandingConfig::default()).unwrap();
        for g in &a.gates {
            assert_eq!(status(g, CriterionKind::VerticalSpeed), CheckStatus::Fail, "gate {}", g.gate_ft);
            assert_eq!(status(g, CriterionKind::Glidepath), CheckStatus::Fail);
            assert_eq!(status(g, CriterionKind::Gear), CheckStatus::Pass);
            assert_eq!(status(g, CriterionKind::Bank), CheckStatus::Pass);
        }
        assert!(a.approach.glidepath_dev_max_above_deg.unwrap() > 1.0);
    }

    #[test]
    fn no_runway_still_analyses_the_approach() {
        let (track, td) = approach(3.0, 20.0, 250.0, 0.0);
        let a = analyze(&track, &[td], 0, &[], None, &LandingConfig::default()).unwrap();
        assert!(a.runway.is_none() && a.touchdown_point.is_none() && a.threshold.is_none());
        assert_eq!(a.distance_ref, DistanceRef::Touchdown);
        assert!(a.flare.is_some());
        for g in &a.gates {
            assert_eq!(status(g, CriterionKind::Glidepath), CheckStatus::Unavailable);
            assert_eq!(status(g, CriterionKind::VerticalSpeed), CheckStatus::Pass);
        }
        let r = a.rollout.unwrap();
        assert!(r.distance_m > 800.0 && r.remaining_m.is_none());
        // the distance axis is the path to the touchdown point
        let tdp = a.samples.iter().position(|p| p.on_ground).unwrap();
        assert!(a.samples[tdp].dist_m.abs() < 1e-6 && a.samples[0].dist_m > 5000.0);
    }

    #[test]
    fn crosswind_components() {
        let (track, td) = approach(3.0, 20.0, 250.0, 0.0);
        let wind = WindInput { direction_deg: Some(180.0), speed_kt: 20.0, gust_kt: Some(30.0), ..Default::default() };
        let a = analyze(&track, std::slice::from_ref(&td), 0, &both_ends(), Some(&wind), &LandingConfig::default()).unwrap();
        let w = a.wind.unwrap();
        assert!(w.relative_to_runway);
        assert!(w.headwind_kt.unwrap().abs() < 0.1);
        assert!((w.crosswind_kt.unwrap() - 20.0).abs() < 0.1, "from the right");
        assert!((w.gust_crosswind_kt.unwrap() - 30.0).abs() < 0.1);

        let w = wind_components(&WindInput { direction_deg: Some(60.0), speed_kt: 20.0, gust_kt: None, ..Default::default() }, 90.0, true);
        assert!((w.headwind_kt.unwrap() - 17.32).abs() < 0.01);
        assert!((w.crosswind_kt.unwrap() + 10.0).abs() < 0.01, "from the left");
        assert!(w.max_crosswind_kt.is_none(), "no variability: no worst case");
        let tail = wind_components(&WindInput { direction_deg: Some(270.0), speed_kt: 8.0, gust_kt: None, ..Default::default() }, 90.0, true);
        assert!((tail.headwind_kt.unwrap() + 8.0).abs() < 0.01);
        let vrb = wind_components(&WindInput { direction_deg: None, speed_kt: 3.0, gust_kt: Some(9.0), ..Default::default() }, 90.0, true);
        assert!(vrb.headwind_kt.is_none());
        // VRB: the whole wind can be across, from either side
        assert_eq!((vrb.max_crosswind_kt, vrb.max_gust_crosswind_kt, vrb.max_crosswind_from_right), (Some(3.0), Some(9.0), None));
    }

    #[test]
    fn variable_wind_range_gives_the_worst_crosswind() {
        // runway 090, wind 120/10 varying 100–200: worst direction 180 = 10 kt from the right
        let w = WindInput { direction_deg: Some(120.0), speed_kt: 10.0, gust_kt: Some(18.0), variable_from_deg: Some(100.0), variable_to_deg: Some(200.0) };
        let c = wind_components(&w, 90.0, true);
        assert!((c.crosswind_kt.unwrap() - 5.0).abs() < 0.01, "mean direction stays the base value");
        assert!((c.max_crosswind_kt.unwrap() - 10.0).abs() < 0.01);
        assert!((c.max_gust_crosswind_kt.unwrap() - 18.0).abs() < 0.01);
        assert_eq!(c.max_crosswind_from_right, Some(true));
        // range 350–030 on runway 090 contains 000, exactly across from the left
        let w = WindInput { direction_deg: Some(10.0), speed_kt: 10.0, gust_kt: None, variable_from_deg: Some(350.0), variable_to_deg: Some(30.0) };
        let c = wind_components(&w, 90.0, true);
        assert!((c.max_crosswind_kt.unwrap() - 10.0).abs() < 0.01, "{c:?}");
        assert_eq!(c.max_crosswind_from_right, Some(false));
    }

    #[test]
    fn half_dot_high_fails_the_glidepath_gate() {
        // 3.5° is +0.5° = 1.4 dots: inside the old ±0.7° (full scale), outside one dot
        let (track, td) = approach(3.5, 20.0, 250.0, 0.0);
        let a = analyze(&track, &[td], 0, &both_ends(), None, &LandingConfig::default()).unwrap();
        for g in &a.gates {
            assert_eq!(status(g, CriterionKind::Glidepath), CheckStatus::Fail, "gate {}", g.gate_ft);
            assert_eq!(status(g, CriterionKind::VerticalSpeed), CheckStatus::Pass);
            let dev = g.criteria.iter().find(|c| c.kind == CriterionKind::Glidepath).unwrap().measured.unwrap();
            assert!(dev > 0.35 && dev < 0.7, "dev {dev}");
        }
    }

    #[test]
    fn speed_reference_cascade() {
        let cfg = LandingConfig::default();
        assert_eq!(speed_reference(Some(130.0), Some(140.0), Some(100.0), &cfg), (Some(130.0), SpeedReferenceSource::User, Some(true)));
        assert_eq!(speed_reference(None, Some(140.0), None, &cfg), (Some(140.0), SpeedReferenceSource::Flown, None));
        let (v, src, ok) = speed_reference(None, None, Some(100.0), &cfg);
        assert_eq!((src, ok), (SpeedReferenceSource::Design, Some(true)));
        assert!((v.unwrap() - 130.0).abs() < 1e-9);
        assert_eq!(speed_reference(None, None, None, &cfg), (None, SpeedReferenceSource::Unavailable, None));
        // 170 kt flown on a VS0 of 100 kt: outside 1.1–1.6 × VS0
        assert_eq!(speed_reference(None, Some(170.0), Some(100.0), &cfg).2, Some(false));
    }

    #[test]
    fn constant_but_fast_approach_fails_against_the_pilots_vapp() {
        // 140 kt all the way: the flown reference sees no deviation, a Vapp of 115 kt does (+25 kt)
        let (track, td) = approach(3.0, 20.0, 250.0, 0.0);
        let cfg = LandingConfig::default();
        let a = analyze(&track, std::slice::from_ref(&td), 0, &both_ends(), None, &cfg).unwrap();
        assert!(a.gates.iter().all(|g| status(g, CriterionKind::Speed) == CheckStatus::Pass));
        let ac = AircraftRef { vapp_kt: Some(115.0), ..Default::default() };
        let a = analyze_with(&track, &[td], 0, &both_ends(), None, &ac, &cfg).unwrap();
        assert_eq!(a.reference_speed_source, SpeedReferenceSource::User);
        for g in &a.gates {
            let c = g.criteria.iter().find(|c| c.kind == CriterionKind::Speed).unwrap();
            assert_eq!(c.status, CheckStatus::Fail, "gate {}", g.gate_ft);
            assert!((c.measured.unwrap() - 25.0).abs() < 0.5 && c.reference == Some(115.0));
        }
    }

    #[test]
    fn touchdown_before_the_aiming_point_is_in_the_zone() {
        // 200 m past the threshold: in the zone (it starts at the threshold), before the 400 m mark
        let ends = both_ends();
        let f = RunwayFrame::new(&ends[0]);
        let (lat, lon) = f.unproject(200.0, 2.0);
        let td = TouchdownReport {
            timestamp_ms: 0,
            vs_fpm_measured: -150.0,
            vs_fpm_sim: 0.0,
            vs_fpm_hardest: -150.0,
            peak_g: 1.2,
            pitch_deg: 0.0,
            bank_deg: 0.0,
            ground_speed_kt: 120.0,
            heading_true_deg: 90.0,
            latitude: lat,
            longitude: lon,
            bounces: 0,
            touch_and_go: false,
            landing_rate_fpm: -150.0,
            landing_rate_source: crate::LandingRateSource::Measured,
        };
        let a = analyze(&[], std::slice::from_ref(&td), 0, &ends, None, &LandingConfig::default()).unwrap();
        let tp = a.touchdown_point.unwrap();
        assert!(tp.in_tdz && tp.distance_m < tp.aiming_point_m, "{tp:?}");
        assert_eq!(a.runway.unwrap().width_m, Some(45.0));
        // unknown width: None, the ±15 m fallback still places it on the runway
        let narrow: Vec<RunwayEnd> = ends.iter().map(|e| RunwayEnd { width_m: 0.0, ..e.clone() }).collect();
        let a = analyze(&[], &[td], 0, &narrow, None, &LandingConfig::default()).unwrap();
        assert_eq!(a.runway.as_ref().unwrap().width_m, None);
        assert!(a.runway.unwrap().on_runway);
    }

    #[test]
    fn aiming_point_and_displaced_threshold() {
        assert_eq!([700.0, 1000.0, 2000.0, 4000.0].map(aiming_point_m), [150.0, 250.0, 300.0, 400.0]);
        let r = runway();
        // a threshold displaced 162 m along the runway lies 162 m down the axis of the end
        let (lat, lon) = point_along(r.threshold_lat, r.threshold_lon, r.end_lat, r.end_lon, 162.0);
        let (x, y) = RunwayFrame::new(&r).project(lat, lon);
        assert!((x - 162.0).abs() < 0.01 && y.abs() < 0.01, "{x} {y}");
        assert!((distance_m(r.threshold_lat, r.threshold_lon, lat, lon) - 162.0).abs() < 0.1);
    }

    #[test]
    fn runway_match_is_tolerant_but_directional() {
        let cfg = LandingConfig::default();
        let ends = both_ends();
        let f = RunwayFrame::new(&ends[0]);
        // 400 m beside the runway, 25° off: still runway 09, but not on it
        let (lat, lon) = f.unproject(800.0, -400.0);
        let (i, _) = match_runway(lat, lon, 65.0, &ends, &cfg).unwrap();
        assert_eq!(ends[i].ident, "09");
        // landing west picks 27
        let (i, _) = match_runway(lat, lon, 268.0, &ends, &cfg).unwrap();
        assert_eq!(ends[i].ident, "27");
        // too far off in heading or position
        assert!(match_runway(lat, lon, 130.0, &ends, &cfg).is_none());
        let (lat, lon) = f.unproject(800.0, 2500.0);
        assert!(match_runway(lat, lon, 90.0, &ends, &cfg).is_none());

        let td = TouchdownReport {
            timestamp_ms: 0,
            vs_fpm_measured: -650.0,
            vs_fpm_sim: 0.0,
            vs_fpm_hardest: -650.0,
            peak_g: 1.8,
            pitch_deg: 0.0,
            bank_deg: 0.0,
            ground_speed_kt: 120.0,
            heading_true_deg: 65.0,
            latitude: f.unproject(800.0, -400.0).0,
            longitude: f.unproject(800.0, -400.0).1,
            bounces: 0,
            touch_and_go: false,
            landing_rate_fpm: -650.0,
            landing_rate_source: crate::LandingRateSource::Measured,
        };
        let a = analyze(&[], &[td], 0, &ends, None, &cfg).unwrap();
        let rwy = a.runway.unwrap();
        assert!(!rwy.on_runway);
        let tp = a.touchdown_point.unwrap();
        assert!(!tp.in_tdz && (tp.lateral_m + 400.0).abs() < 0.5);
        // 1.8 g is "firm" since the hard band starts at 2.0 g
        assert_eq!((a.vs_band, a.g_band), (Band::Hard, Band::Firm));
        assert!(a.samples.is_empty() && a.gates.iter().all(|g| !g.reached));
    }

    #[test]
    fn bands_and_tdz_bounds() {
        assert_eq!(vs_band(-149.0), Band::Smooth);
        assert_eq!(vs_band(-150.0), Band::Normal);
        assert_eq!(vs_band(-450.0), Band::Firm);
        assert_eq!(vs_band(-600.0), Band::Hard);
        assert_eq!(g_band(1.24), Band::Smooth);
        assert_eq!(g_band(1.49), Band::Normal);
        assert_eq!(g_band(1.75), Band::Firm);
        assert_eq!(g_band(1.99), Band::Firm);
        assert_eq!(g_band(2.0), Band::Hard);
        let cfg = LandingConfig::default();
        // zone from the threshold: 0 … min(900 m, first third)
        assert_eq!(tdz_bounds(3000.0, &cfg), (0.0, 900.0));
        let (s, e) = tdz_bounds(1400.0, &cfg);
        assert!((e - 466.67).abs() < 0.01 && s == 0.0);
    }

    #[test]
    fn missing_touchdown_is_none() {
        assert!(analyze(&[], &[], 0, &[], None, &LandingConfig::default()).is_none());
    }

    // ---- derived runway ----

    fn hint(le: &str, he: &str, length_m: Option<f64>, coords: bool) -> RunwayHint {
        RunwayHint {
            le_ident: le.into(),
            he_ident: he.into(),
            length_m,
            width_m: Some(18.0),
            surface: "GRS".into(),
            has_coordinates: coords,
            ..Default::default()
        }
    }

    fn airport(runways: Vec<RunwayHint>) -> AirportHint {
        AirportHint { icao: "TEST".into(), runways }
    }

    #[test]
    fn runway_derived_without_any_database_runway() {
        // 3 m right of the real centreline all the way: the derived axis follows the track
        let (track, td) = approach(3.0, 20.0, 250.0, 3.0);
        let d = derive_runway_from_track(&track, &td, &airport(vec![])).expect("derived");
        assert!(angle_diff_deg(d.course_true_deg, 90.0) < 3.0, "course {}", d.course_true_deg);
        assert!(angle_diff_deg(d.rollout_course_deg, 90.0) < 0.5);
        assert!(d.approach_course_sd_deg.unwrap() < 1.0 && angle_diff_deg(d.approach_course_deg.unwrap(), 90.0) < 0.5);
        assert_eq!((d.end.ident.as_str(), d.end.opposite_ident.as_str()), ("09", "27"));
        assert_eq!(d.geometry.source, RunwayGeometrySource::Derived);
        assert!(d.geometry.length_estimated && d.rollout_complete && d.ground_run_m > 800.0);
        assert_eq!((d.geometry.along_uncertainty_m, d.geometry.cross_uncertainty_m), (Some(50.0), Some(5.0)));
        assert_eq!(d.end.width_m, 0.0, "width unknown");
        assert!((d.end.elevation_ft.unwrap() - ELEV).abs() < 1.0);
        // threshold 300 m before the touchdown point, on the flown line
        let real = RunwayFrame::new(&runway());
        let td_x = real.project(td.latitude, td.longitude).0;
        let (x, y) = real.project(d.end.threshold_lat, d.end.threshold_lon);
        assert!((x - (td_x - 300.0)).abs() < 5.0 && (y - 3.0).abs() < 1.0, "threshold at {x} {y} (td {td_x})");
        // the far end is at least past the rollout
        let derived = RunwayFrame::new(&d.end);
        assert!(derived.length_m >= 300.0 + 800.0, "{}", derived.length_m);

        // analysed like a database runway, but honest about what it can say
        let mut a = analyze(&track, std::slice::from_ref(&td), 0, std::slice::from_ref(&d.end), None, &LandingConfig::default()).unwrap();
        apply_runway_geometry(&mut a, &d.geometry);
        let r = a.runway.as_ref().expect("derived runway matched");
        assert_eq!((r.ident.as_str(), r.geometry.source), ("09", RunwayGeometrySource::Derived));
        assert!(r.width_m.is_none() && r.geometry.length_estimated);
        let tp = a.touchdown_point.as_ref().unwrap();
        assert!(!tp.lateral_measurable, "centreline offset not measurable");
        assert!(tp.lateral_m.abs() < 1.0);
        assert!((tp.distance_m - 300.0).abs() < 5.0 && tp.distance_uncertainty_m == Some(50.0));
        assert_eq!((tp.tdz_end_m, tp.aiming_point_m), (900.0, 300.0));
        assert!(tp.in_tdz);
        assert!(a.rollout.as_ref().unwrap().remaining_m.is_none());
        assert!(a.threshold.is_some() && a.approach.glidepath_dev_at_1000_deg.is_some());
    }

    #[test]
    fn runway_derived_with_designator_and_length_from_the_database() {
        let (track, td) = approach(3.0, 20.0, 250.0, 0.0);
        let d = derive_runway_from_track(&track, &td, &airport(vec![hint("09", "27", Some(3000.0), false)])).unwrap();
        assert_eq!(d.geometry.source, RunwayGeometrySource::DatabaseDerived);
        assert_eq!((d.end.ident.as_str(), d.end.width_m, d.end.surface.as_str()), ("09", 18.0, "GRS"));
        assert!(!d.geometry.length_estimated);
        // 3000 m runway: aiming point 400 m
        assert!((d.touchdown_distance_m - 400.0).abs() < 1e-6);
        assert!((RunwayFrame::new(&d.end).length_m - 3000.0).abs() < 1.0);
        // the database lists the runway the other way round: its he end fits the course
        let d2 = derive_runway_from_track(&track, &td, &airport(vec![hint("27", "09", Some(3000.0), false)])).unwrap();
        assert_eq!((d2.end.ident.as_str(), d2.end.opposite_ident.as_str()), ("09", "27"));
        // a short strip: the threshold moves so the rollout stays on it
        let d3 = derive_runway_from_track(&track, &td, &airport(vec![hint("09", "27", Some(1100.0), false)])).unwrap();
        assert!(d3.touchdown_distance_m < 250.0, "{}", d3.touchdown_distance_m);
    }

    #[test]
    fn runway_not_derived_beside_a_known_runway_or_from_a_short_run() {
        let (track, td) = approach(3.0, 20.0, 250.0, 0.0);
        // only a crossing runway with coordinates: the landing was not on an unknown runway
        assert!(derive_runway_from_track(&track, &td, &airport(vec![hint("18", "36", Some(2000.0), true)])).is_none());
        // a coordinate-less runway in this direction next to it: derived
        let d = derive_runway_from_track(&track, &td, &airport(vec![hint("18", "36", Some(2000.0), true), hint("09", "27", None, false)])).unwrap();
        assert_eq!((d.end.ident.as_str(), d.geometry.source), ("09", RunwayGeometrySource::DatabaseDerived));
        assert!(d.geometry.length_estimated);
        // a database designator 30° off is not taken over
        let d = derive_runway_from_track(&track, &td, &airport(vec![hint("12", "30", Some(900.0), false)])).unwrap();
        assert_eq!((d.end.ident.as_str(), d.geometry.source), ("09", RunwayGeometrySource::Derived));
        // parallels: the number, not the side
        let d = derive_runway_from_track(&track, &td, &airport(vec![hint("09L", "27R", Some(3000.0), false), hint("09R", "27L", Some(3000.0), false)]))
            .unwrap();
        assert_eq!((d.end.ident.as_str(), d.end.opposite_ident.as_str(), d.geometry.source), ("09", "27", RunwayGeometrySource::Derived));
        assert!(!d.geometry.length_estimated);
        // ground run under 150 m
        let i = track.iter().position(|s| s.on_ground).unwrap();
        assert!(derive_runway_from_track(&track[..i + 2], &td, &airport(vec![])).is_none());
        // a still rolling (live) track: derived, but not a finished rollout
        let d = derive_runway_from_track(&track[..i + 6], &td, &airport(vec![])).unwrap();
        assert!(!d.rollout_complete);
        // no track at all
        assert!(derive_runway_from_track(&[], &td, &airport(vec![])).is_none());
    }

    #[test]
    fn designators_and_blending() {
        assert_eq!(designator_for(94.9), "09");
        assert_eq!(designator_for(3.0), "36");
        assert_eq!(designator_for(355.0), "36");
        assert_eq!(designator_for(176.0), "18");
        assert_eq!(opposite_ident("09L"), "27R");
        assert_eq!(opposite_ident("36"), "18");
        assert_eq!(opposite_ident("04C"), "22C");
        assert_eq!(opposite_ident("H1"), "H1");
        assert_eq!((ident_number("09L"), ident_number("H1"), ident_number("40")), (Some(9), None, None));

        let a = runway();
        let f = RunwayFrame::new(&a);
        // same direction, threshold 40 m further, 2000 m long
        let (t_lat, t_lon) = f.unproject(40.0, 0.0);
        let (e_lat, e_lon) = f.unproject(2040.0, 0.0);
        let b = RunwayEnd { threshold_lat: t_lat, threshold_lon: t_lon, end_lat: e_lat, end_lon: e_lon, length_m: 0.0, elevation_ft: Some(410.0), ..a.clone() };
        let a = RunwayEnd { elevation_ft: Some(400.0), length_m: 0.0, ..a };
        let m = blend_runway(&a, 3.0, &b);
        let (x, y) = f.project(m.threshold_lat, m.threshold_lon);
        assert!((x - 10.0).abs() < 0.1 && y.abs() < 0.1, "{x} {y}");
        let mf = RunwayFrame::new(&m);
        assert!((mf.heading_deg - 90.0).abs() < 0.01 && (mf.length_m - 3000.0).abs() < 1.0);
        assert!((m.elevation_ft.unwrap() - 402.5).abs() < 1e-9);
        assert_eq!(m.ident, "09");
    }
}
