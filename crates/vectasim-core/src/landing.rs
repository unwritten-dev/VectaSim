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

use crate::TouchdownReport;
use serde::{Deserialize, Serialize};

const EARTH_R_M: f64 = 6_371_008.8;
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
    /// Declared length; 0 = use the threshold-to-threshold distance.
    pub length_m: f64,
    pub width_m: f64,
    pub surface: String,
}

/// Surface wind (METAR, true direction).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindInput {
    /// None for variable wind.
    pub direction_deg: Option<f64>,
    pub speed_kt: f64,
    pub gust_kt: Option<f64>,
}

/// Thresholds of the analysis. Defaults follow common airline SOPs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandingConfig {
    /// Touchdown zone, metres past the threshold.
    pub tdz_start_m: f64,
    pub tdz_end_m: f64,
    /// Shrink the zone to the first third of a runway shorter than 3 × `tdz_end_m`.
    pub tdz_first_third: bool,
    pub glidepath_deg: f64,
    /// Threshold crossing height of the reference glidepath.
    pub tch_ft: f64,
    pub glidepath_tolerance_deg: f64,
    pub max_vs_fpm: f64,
    /// Speed window around the reference speed (IAS at 500 ft, a stand-in for Vref).
    pub speed_below_kt: f64,
    pub speed_above_kt: f64,
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
            tdz_start_m: 300.0,
            tdz_end_m: 900.0,
            tdz_first_third: true,
            glidepath_deg: 3.0,
            tch_ft: 50.0,
            glidepath_tolerance_deg: 0.7,
            max_vs_fpm: 1000.0,
            speed_below_kt: 5.0,
            speed_above_kt: 20.0,
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

/// Peak G: < 1.25 / < 1.5 / < 1.75 / ≥ 1.75.
pub fn g_band(g: f64) -> Band {
    match g {
        g if g < 1.25 => Band::Smooth,
        g if g < 1.5 => Band::Normal,
        g if g < 1.75 => Band::Firm,
        _ => Band::Hard,
    }
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

fn distance_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
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
    pub width_m: f64,
    pub surface: String,
    pub threshold_lat: f64,
    pub threshold_lon: f64,
    pub end_lat: f64,
    pub end_lon: f64,
    /// |aircraft heading − runway direction| at touchdown.
    pub heading_diff_deg: f64,
    /// Touchdown point lies on the paved/declared rectangle of the runway.
    pub on_runway: bool,
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
    pub tdz_start_m: f64,
    pub tdz_end_m: f64,
    pub in_tdz: bool,
    /// Runway left ahead of the touchdown point.
    pub remaining_m: f64,
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

fn lerp(a: f64, b: f64, f: f64) -> f64 {
    a + (b - a) * f
}

fn median(mut v: Vec<f64>) -> Option<f64> {
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
fn touchdown_sample(track: &[LandingSample], ts: u64) -> Option<usize> {
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

fn criterion(kind: CriterionKind, measured: Option<f64>, min: Option<f64>, max: Option<f64>, reference: Option<f64>) -> Criterion {
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

pub fn wind_components(wind: &WindInput, reference_heading_deg: f64, relative_to_runway: bool) -> WindComponents {
    let comp = |speed: f64| {
        wind.direction_deg.map(|d| {
            let a = (d - reference_heading_deg).to_radians();
            (speed * a.cos(), speed * a.sin())
        })
    };
    let base = comp(wind.speed_kt);
    let gust = wind.gust_kt.and_then(comp);
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
    }
}

fn tdz_bounds(length_m: f64, cfg: &LandingConfig) -> (f64, f64) {
    if cfg.tdz_first_third && length_m < 3.0 * cfg.tdz_end_m {
        let end = length_m / 3.0;
        (cfg.tdz_start_m.min(end / 3.0), end)
    } else {
        (cfg.tdz_start_m, cfg.tdz_end_m)
    }
}

/// Analyse touchdown `index` of a flight. Returns None only if there is no such touchdown;
/// a missing track or runway leaves the dependent fields empty.
pub fn analyze(
    track: &[LandingSample],
    touchdowns: &[TouchdownReport],
    index: usize,
    runways: &[RunwayEnd],
    wind: Option<&WindInput>,
    cfg: &LandingConfig,
) -> Option<LandingAnalysis> {
    let td = touchdowns.get(index)?.clone();
    let prev_ms = index.checked_sub(1).map(|i| touchdowns[i].timestamp_ms).unwrap_or(0);
    let next_ms = touchdowns.get(index + 1).map(|t| t.timestamp_ms).unwrap_or(u64::MAX);

    let matched = match_runway(td.latitude, td.longitude, td.heading_true_deg, runways, cfg);
    let frame = matched.map(|(_, f)| f);

    let mut out = LandingAnalysis {
        touchdown_index: index,
        vs_band: vs_band(td.landing_rate_fpm),
        vs_measured_band: vs_band(td.vs_fpm_measured),
        vs_hardest_band: vs_band(td.vs_fpm_hardest),
        g_band: g_band(td.peak_g),
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
            width_m: r.width_m,
            surface: r.surface.clone(),
            threshold_lat: r.threshold_lat,
            threshold_lon: r.threshold_lon,
            end_lat: r.end_lat,
            end_lon: r.end_lon,
            heading_diff_deg: angle_diff_deg(td.heading_true_deg, f.heading_deg),
            on_runway: y.abs() <= half_w && (0.0..=f.length_m).contains(&x),
        });
        let (tdz_start_m, tdz_end_m) = tdz_bounds(f.length_m, cfg);
        out.touchdown_point = Some(TouchdownPoint {
            distance_m: x,
            distance_ft: x / M_PER_FT,
            lateral_m: y,
            tdz_start_m,
            tdz_end_m,
            in_tdz: x >= tdz_start_m && x <= tdz_end_m && y.abs() <= half_w,
            remaining_m: f.length_m - x,
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
    let ref_ias = a.ias_at_500_kt;
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
        assert_eq!((tp.tdz_start_m, tp.tdz_end_m), (300.0, 900.0));

        // approach from 1000 ft, on the 3° path
        assert_eq!(a.approach.start_reason, Some(StartReason::Altitude));
        assert_eq!(a.distance_ref, DistanceRef::Threshold);
        let dev = a.approach.glidepath_dev_at_1000_deg.unwrap();
        assert!(dev.abs() < 0.1, "glidepath deviation at 1000 ft {dev}");
        assert!(a.approach.glidepath_dev_at_500_deg.unwrap().abs() < 0.1);
        let vs = a.approach.vs_min_1000_fpm.unwrap();
        assert!((-800.0..-700.0).contains(&vs), "approach V/S {vs}");
        assert!((a.approach.ias_at_500_kt.unwrap() - 140.0).abs() < 0.5);

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
        let wind = WindInput { direction_deg: Some(180.0), speed_kt: 20.0, gust_kt: Some(30.0) };
        let a = analyze(&track, std::slice::from_ref(&td), 0, &both_ends(), Some(&wind), &LandingConfig::default()).unwrap();
        let w = a.wind.unwrap();
        assert!(w.relative_to_runway);
        assert!(w.headwind_kt.unwrap().abs() < 0.1);
        assert!((w.crosswind_kt.unwrap() - 20.0).abs() < 0.1, "from the right");
        assert!((w.gust_crosswind_kt.unwrap() - 30.0).abs() < 0.1);

        let w = wind_components(&WindInput { direction_deg: Some(60.0), speed_kt: 20.0, gust_kt: None }, 90.0, true);
        assert!((w.headwind_kt.unwrap() - 17.32).abs() < 0.01);
        assert!((w.crosswind_kt.unwrap() + 10.0).abs() < 0.01, "from the left");
        let tail = wind_components(&WindInput { direction_deg: Some(270.0), speed_kt: 8.0, gust_kt: None }, 90.0, true);
        assert!((tail.headwind_kt.unwrap() + 8.0).abs() < 0.01);
        let vrb = wind_components(&WindInput { direction_deg: None, speed_kt: 3.0, gust_kt: None }, 90.0, true);
        assert!(vrb.headwind_kt.is_none());
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
        assert_eq!((a.vs_band, a.g_band), (Band::Hard, Band::Hard));
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
        assert_eq!(g_band(1.7), Band::Firm);
        assert_eq!(g_band(1.75), Band::Hard);
        let cfg = LandingConfig::default();
        assert_eq!(tdz_bounds(3000.0, &cfg), (300.0, 900.0));
        let (s, e) = tdz_bounds(1400.0, &cfg);
        assert!((e - 466.67).abs() < 0.01 && (s - 155.56).abs() < 0.01);
    }

    #[test]
    fn missing_touchdown_is_none() {
        assert!(analyze(&[], &[], 0, &[], None, &LandingConfig::default()).is_none());
    }
}
