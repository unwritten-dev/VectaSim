//! Per-flight metrics that the debrief and the trends compare across flights: the take-off
//! rotation (mean / peak pitch rate, duration), where the gear went down and the landing flaps
//! were set on the final approach, and the stable-approach result of the landing approach
//! (exceedances, 1000 / 500 ft gate verdicts).
//!
//! The derivation is the backend twin of the frontend's track markers
//! (`app/src/trackEvents.ts`, `flightMetrics`): the thresholds come from the same file
//! (`app/src/trackEvents.constants.json`, embedded here), and both sides run the shared test
//! vectors (`app/src/fixtures/track-metrics-vectors.json`). Rules:
//!
//! - rotation: the first lift-off after a take-off roll (≥ `rollMinS` on the ground, then
//!   airborne ≥ `airborneMinS`, ground speed before it > `rotMinGsKt`); rotation start is the
//!   earliest sample of the uninterrupted pitch-up run ending at the lift-off (each 1 s step
//!   above `rotContDegS`, the first above `rotStartDegS`, on the ground above `rotMinGsKt`).
//!   None when that lift-off had no pitch-up run.
//! - landing = the last full-stop touchdown (else the last touchdown); its final air segment
//!   starts at the last lift-off at least `airborneMinS` before it (else the track start).
//! - gear down: the last debounced gear-down change (≥ `gearThresholdPct`, held `configHoldS`)
//!   in that segment: AGL there and the great-circle distance to the threshold of the landing
//!   approach's runway.
//! - landing flaps: the last debounced flap change in that segment that ends extended.
//! - stable approach: the approach that ended in the landing touchdown (else the last landed
//!   one): its number of exceedances (None when it never got below 1000 ft) and the gate
//!   verdicts (failed → false, measured → true, nothing measurable / not reached → None).
//!
//! Stored per flight in `flight_metrics` (schema v18), one row per flight, versioned like
//! `approach_facts`: a row of another [`FLIGHT_METRICS_VERSION`] is stale. A flight without
//! anything measurable still gets its row (all `None`), so it is not computed again.

use crate::store::{FLIGHT_COL_COUNT, FLIGHT_COLS, row_to_flight};
use crate::{FlightRow, Result, Store, TrackSample};
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use vectasim_core::TouchdownReport;
use vectasim_core::approach::{ApproachAnalysis, ApproachGate, ApproachOutcome, GateKind};
use vectasim_core::landing::CheckStatus;

/// Version of the stored metrics; bump when a rule above (or the approach analysis they read)
/// changes, so old rows are recomputed.
pub const FLIGHT_METRICS_VERSION: u32 = 1;

/// The thresholds shared with the frontend (`app/src/trackEvents.constants.json`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackEventConstants {
    pub gear_threshold_pct: f64,
    pub config_hold_s: f64,
    pub rot_start_deg_s: f64,
    pub rot_cont_deg_s: f64,
    pub rot_min_gs_kt: f64,
    pub roll_min_s: f64,
    pub airborne_min_s: f64,
    pub rotation_slow_deg_s: f64,
    pub rotation_fast_deg_s: f64,
}

const CONSTANTS_JSON: &str = include_str!("../../../app/src/trackEvents.constants.json");

/// Parsed once; the test `shared_constants_parse` keeps the file valid.
pub static CONSTANTS: LazyLock<TrackEventConstants> =
    LazyLock::new(|| serde_json::from_str(CONSTANTS_JSON).expect("app/src/trackEvents.constants.json is valid"));

/// Take-off rotation: mean pitch rate rotation start → lift-off, steepest 1 s step, duration.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rotation {
    pub start_t_ms: u64,
    pub rate_deg_s: f64,
    pub peak_deg_s: f64,
    pub duration_s: f64,
}

/// What the metrics need of a touchdown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TouchdownRef {
    pub timestamp_ms: u64,
    pub touch_and_go: bool,
}

impl From<&TouchdownReport> for TouchdownRef {
    fn from(t: &TouchdownReport) -> Self {
        Self { timestamp_ms: t.timestamp_ms, touch_and_go: t.touch_and_go }
    }
}

/// What the metrics need of one assessed approach ([`ApproachSummary::from`] an analysis).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ApproachSummary {
    pub outcome: Option<ApproachOutcome>,
    pub airport: Option<String>,
    pub ident: Option<String>,
    pub threshold: Option<(f64, f64)>,
    /// Exceedances; None when the approach never got below 1000 ft (no band).
    pub exceedances: Option<u32>,
    pub stable_1000: Option<bool>,
    pub stable_500: Option<bool>,
}

impl From<&ApproachAnalysis> for ApproachSummary {
    fn from(a: &ApproachAnalysis) -> Self {
        let verdict = |k: GateKind| a.gates.iter().find(|g| g.kind == k).and_then(gate_verdict);
        Self {
            outcome: Some(a.outcome),
            airport: a.runway.as_ref().map(|r| r.airport.clone()),
            ident: a.runway.as_ref().map(|r| r.ident.clone()),
            threshold: a.runway.as_ref().map(|r| (r.threshold_lat, r.threshold_lon)),
            exceedances: a.band.map(|_| a.exceedances.len() as u32),
            stable_1000: verdict(GateKind::Ft1000),
            stable_500: verdict(GateKind::Ft500),
        }
    }
}

/// Verdict of a stable-approach gate: false = a criterion failed, true = measured and none
/// failed, None = not reached or nothing measurable (`gateVerdict` in the frontend).
pub fn gate_verdict(g: &ApproachGate) -> Option<bool> {
    if !g.reached {
        return None;
    }
    if g.criteria.iter().any(|c| c.status == CheckStatus::Fail) {
        return Some(false);
    }
    g.criteria.iter().any(|c| c.status != CheckStatus::Unavailable).then_some(true)
}

/// Stored metrics of one flight (table `flight_metrics`). `None` = not determinable.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightMetricsRow {
    pub version: u32,
    /// Set by the store when written.
    pub computed_ms: u64,
    /// Runway of the landing approach.
    pub airport_icao: Option<String>,
    pub runway_ident: Option<String>,
    pub rotation_rate_deg_s: Option<f64>,
    pub rotation_peak_deg_s: Option<f64>,
    pub rotation_duration_s: Option<f64>,
    pub gear_down_agl_ft: Option<f64>,
    pub gear_down_dist_nm: Option<f64>,
    pub landing_flaps_agl_ft: Option<f64>,
    pub exceedances: Option<u32>,
    pub stable_1000: Option<bool>,
    pub stable_500: Option<bool>,
}

fn pitch_rate(s: &[TrackSample], k: usize) -> f64 {
    let dt = ((s[k + 1].t_ms as f64 - s[k].t_ms as f64) / 1000.0).max(0.001);
    (s[k + 1].pitch_deg - s[k].pitch_deg) / dt
}

/// Rotation of the take-off roll that ends at lift-off index `lo` (first airborne sample);
/// None = no pitch-up run (`rotationAt` in the frontend).
pub fn rotation_at(s: &[TrackSample], lo: usize) -> Option<Rotation> {
    let c = &*CONSTANTS;
    let ok = |k: usize| s[k].on_ground && s[k].ground_speed_kt > c.rot_min_gs_kt;
    let mut r = lo;
    while r >= 1 && ok(r - 1) && pitch_rate(s, r - 1) > c.rot_cont_deg_s {
        r -= 1;
    }
    // the run starts where the nose clearly comes up
    while r < lo && pitch_rate(s, r) <= c.rot_start_deg_s {
        r += 1;
    }
    if r >= lo {
        return None;
    }
    let peak = (r..lo).map(|k| pitch_rate(s, k)).fold(0.0, f64::max);
    let duration_s = (s[lo].t_ms as f64 - s[r].t_ms as f64) / 1000.0;
    Some(Rotation { start_t_ms: s[r].t_ms, rate_deg_s: (s[lo].pitch_deg - s[r].pitch_deg) / duration_s, peak_deg_s: peak, duration_s })
}

/// Lift-offs after a take-off roll (index of the first airborne sample, rotation or None) –
/// `rotationEvents` in the frontend.
pub fn rotations(s: &[TrackSample]) -> Vec<(usize, Option<Rotation>)> {
    let c = &*CONSTANTS;
    let mut out = Vec::new();
    let mut ground_since: Option<u64> = None;
    for i in 0..s.len() {
        if s[i].on_ground {
            ground_since.get_or_insert(s[i].t_ms);
            continue;
        }
        let Some(since) = ground_since.take() else { continue };
        if (s[i].t_ms as f64 - since as f64) / 1000.0 < c.roll_min_s {
            continue; // a bounce
        }
        let mut j = i;
        while j + 1 < s.len() && !s[j + 1].on_ground {
            j += 1;
        }
        if (s[j].t_ms as f64 - s[i].t_ms as f64) / 1000.0 < c.airborne_min_s || s[i - 1].ground_speed_kt <= c.rot_min_gs_kt {
            continue;
        }
        out.push((i, rotation_at(s, i)));
    }
    out
}

/// Changes of a discrete state with a hold-time debounce, as (first sample index, from, to):
/// a new value counts once it held ≥ `hold_s` (or to the end of the track) – `debouncedChanges`
/// in the frontend.
fn debounced_changes<V: PartialEq + Copy>(s: &[TrackSample], value: impl Fn(&TrackSample) -> V, hold_s: f64) -> Vec<(usize, V, V)> {
    let mut out = Vec::new();
    let Some(first) = s.first() else { return out };
    let mut cur = value(first);
    let mut i = 1;
    while i < s.len() {
        let v = value(&s[i]);
        if v == cur {
            i += 1;
            continue;
        }
        let mut j = i;
        while j + 1 < s.len() && value(&s[j + 1]) == v {
            j += 1;
        }
        let held = (s[j].t_ms as f64 - s[i].t_ms as f64) / 1000.0 + 1.0;
        if held >= hold_s || j == s.len() - 1 {
            out.push((i, cur, v));
            cur = v;
        }
        i = j + 1;
    }
    out
}

/// The flight's landing: the last full stop, else the last touchdown.
pub fn landing_touchdown_index(touchdowns: &[TouchdownRef]) -> Option<usize> {
    touchdowns.iter().rposition(|t| !t.touch_and_go).or(touchdowns.len().checked_sub(1))
}

/// Start (epoch ms) of the air segment that ends in the touchdown at `td_ms`; None when the
/// track starts airborne.
fn final_segment_start(s: &[TrackSample], td_ms: u64) -> Option<u64> {
    let latest = td_ms as f64 - CONSTANTS.airborne_min_s * 1000.0;
    (1..s.len()).rev().find(|&i| s[i].t_ms as f64 <= latest && !s[i].on_ground && s[i - 1].on_ground).map(|i| s[i].t_ms)
}

fn agl(s: &TrackSample) -> f64 {
    if s.on_ground { 0.0 } else { s.altitude_agl_ft }
}

/// Great-circle distance, NM (as `haversineNm` in the frontend).
fn haversine_nm(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let r = std::f64::consts::PI / 180.0;
    let dp = (lat2 - lat1) * r;
    let dl = (lon2 - lon1) * r;
    let a = (dp / 2.0).sin().powi(2) + (lat1 * r).cos() * (lat2 * r).cos() * (dl / 2.0).sin().powi(2);
    2.0 * 3440.065 * a.sqrt().asin()
}

/// The metrics of one flight from its 1 Hz track, touchdowns and assessed approaches (pure).
pub fn derive(samples: &[TrackSample], touchdowns: &[TouchdownRef], approaches: &[ApproachSummary]) -> FlightMetricsRow {
    let c = &*CONSTANTS;
    let rot = rotations(samples).first().and_then(|(_, r)| *r);
    let k = landing_touchdown_index(touchdowns);
    let a = k.and_then(|k| {
        approaches
            .iter()
            .find(|a| a.outcome.and_then(ApproachOutcome::touchdown_index) == Some(k))
            .or_else(|| approaches.iter().rev().find(|a| matches!(a.outcome, Some(ApproachOutcome::Landed { .. }))))
    });
    let (mut gear, mut flaps) = (None, None);
    if let Some(k) = k {
        let td = touchdowns[k].timestamp_ms;
        let from = final_segment_start(samples, td);
        let in_seg = |i: usize| from.is_none_or(|f| samples[i].t_ms >= f) && samples[i].t_ms <= td;
        gear = debounced_changes(samples, |s| s.gear_pct >= c.gear_threshold_pct, c.config_hold_s)
            .into_iter()
            .filter(|&(i, _, to)| to && in_seg(i))
            .map(|(i, _, _)| i)
            .next_back();
        flaps = debounced_changes(samples, |s| s.flaps_index, c.config_hold_s)
            .into_iter()
            .filter(|&(i, _, to)| to > 0 && in_seg(i))
            .map(|(i, _, _)| i)
            .next_back();
    }
    let threshold = a.and_then(|a| a.threshold);
    FlightMetricsRow {
        version: FLIGHT_METRICS_VERSION,
        computed_ms: 0,
        airport_icao: a.and_then(|a| a.airport.clone()),
        runway_ident: a.and_then(|a| a.ident.clone()),
        rotation_rate_deg_s: rot.map(|r| r.rate_deg_s),
        rotation_peak_deg_s: rot.map(|r| r.peak_deg_s),
        rotation_duration_s: rot.map(|r| r.duration_s),
        gear_down_agl_ft: gear.map(|i| agl(&samples[i])),
        gear_down_dist_nm: gear.zip(threshold).map(|(i, (lat, lon))| haversine_nm(samples[i].latitude, samples[i].longitude, lat, lon)),
        landing_flaps_agl_ft: flaps.map(|i| agl(&samples[i])),
        exceedances: a.and_then(|a| a.exceedances),
        stable_1000: a.and_then(|a| a.stable_1000),
        stable_500: a.and_then(|a| a.stable_500),
    }
}

/// [`derive`] over a stored flight's analysis.
pub fn derive_from_analysis(samples: &[TrackSample], touchdowns: &[TouchdownReport], approaches: &[ApproachAnalysis]) -> FlightMetricsRow {
    let tds: Vec<TouchdownRef> = touchdowns.iter().map(TouchdownRef::from).collect();
    let aps: Vec<ApproachSummary> = approaches.iter().map(ApproachSummary::from).collect();
    derive(samples, &tds, &aps)
}

// ---- store -------------------------------------------------------------------------------

/// v18: the per-flight metrics (one row per flight, goes with it).
pub(crate) const MIGRATION_V18: &str = r#"
CREATE TABLE IF NOT EXISTS flight_metrics (
    flight_id            TEXT PRIMARY KEY REFERENCES flights(id) ON DELETE CASCADE,
    version              INTEGER NOT NULL,
    computed_ms          INTEGER NOT NULL,
    airport_icao         TEXT,
    runway_ident         TEXT,
    rotation_rate_deg_s  REAL,
    rotation_peak_deg_s  REAL,
    rotation_duration_s  REAL,
    gear_down_agl_ft     REAL,
    gear_down_dist_nm    REAL,
    landing_flaps_agl_ft REAL,
    exceedances          INTEGER,
    stable_1000          INTEGER,
    stable_500           INTEGER
);
"#;

const METRIC_COLS: &str = "m.version, m.computed_ms, m.airport_icao, m.runway_ident, m.rotation_rate_deg_s, m.rotation_peak_deg_s,
    m.rotation_duration_s, m.gear_down_agl_ft, m.gear_down_dist_nm, m.landing_flaps_agl_ft, m.exceedances, m.stable_1000, m.stable_500";

/// Row from [`METRIC_COLS`] starting at column `o`; None when the flight has no row (LEFT JOIN).
fn row_to_metrics(r: &Row<'_>, o: usize) -> rusqlite::Result<Option<FlightMetricsRow>> {
    let Some(version) = r.get::<_, Option<i64>>(o)? else { return Ok(None) };
    Ok(Some(FlightMetricsRow {
        version: version as u32,
        computed_ms: r.get::<_, i64>(o + 1)? as u64,
        airport_icao: r.get(o + 2)?,
        runway_ident: r.get(o + 3)?,
        rotation_rate_deg_s: r.get(o + 4)?,
        rotation_peak_deg_s: r.get(o + 5)?,
        rotation_duration_s: r.get(o + 6)?,
        gear_down_agl_ft: r.get(o + 7)?,
        gear_down_dist_nm: r.get(o + 8)?,
        landing_flaps_agl_ft: r.get(o + 9)?,
        exceedances: r.get::<_, Option<i64>>(o + 10)?.map(|v| v.max(0) as u32),
        stable_1000: r.get(o + 11)?,
        stable_500: r.get(o + 12)?,
    }))
}

/// A completed flight with its stored metrics (None = not computed yet), newest first from
/// [`Store::recent_flight_metrics`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentMetrics {
    pub flight: FlightRow,
    pub has_track: bool,
    pub metrics: Option<FlightMetricsRow>,
}

impl RecentMetrics {
    /// Missing or of another version: compute (again).
    pub fn is_stale(&self) -> bool {
        self.metrics.as_ref().is_none_or(|m| m.version != FLIGHT_METRICS_VERSION)
    }
}

impl Store {
    /// Store the metrics of a flight (replaces its row). False if the flight does not exist.
    pub fn put_flight_metrics(&self, flight_id: &str, m: &FlightMetricsRow) -> Result<bool> {
        let conn = self.conn();
        let exists: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM flights WHERE id = ?1)", params![flight_id], |r| r.get(0))?;
        if !exists {
            return Ok(false);
        }
        conn.execute(
            "INSERT OR REPLACE INTO flight_metrics (flight_id, version, computed_ms, airport_icao, runway_ident, rotation_rate_deg_s,
                 rotation_peak_deg_s, rotation_duration_s, gear_down_agl_ft, gear_down_dist_nm, landing_flaps_agl_ft, exceedances,
                 stable_1000, stable_500)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                flight_id,
                m.version,
                vectasim_core::now_ms() as i64,
                m.airport_icao,
                m.runway_ident,
                m.rotation_rate_deg_s,
                m.rotation_peak_deg_s,
                m.rotation_duration_s,
                m.gear_down_agl_ft,
                m.gear_down_dist_nm,
                m.landing_flaps_agl_ft,
                m.exceedances,
                m.stable_1000,
                m.stable_500
            ],
        )?;
        Ok(true)
    }

    /// The stored metrics of one flight (None: not computed yet).
    pub fn flight_metrics(&self, flight_id: &str) -> Result<Option<FlightMetricsRow>> {
        let conn = self.conn();
        let row = conn
            .query_row(&format!("SELECT {METRIC_COLS} FROM flight_metrics m WHERE m.flight_id = ?1"), params![flight_id], |r| {
                row_to_metrics(r, 0)
            })
            .optional()?;
        Ok(row.flatten())
    }

    /// Completed flights, newest first (as [`Store::recent_approach_facts`]), with their stored
    /// metrics. Demo (mock) flights only with `include_demo`.
    pub fn recent_flight_metrics(&self, limit: u32, include_demo: bool) -> Result<Vec<RecentMetrics>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {FLIGHT_COLS}, EXISTS (SELECT 1 FROM tracks t WHERE t.flight_id = f.id), {METRIC_COLS}
             FROM flights f LEFT JOIN flight_metrics m ON m.flight_id = f.id
             WHERE f.state = 'completed' AND f.deleted_ms IS NULL AND (?2 OR COALESCE(f.provider, '') <> 'mock')
             ORDER BY COALESCE(f.on_block_ms, f.landing_ms, f.off_block_ms, f.created_ms) DESC, f.created_ms DESC
             LIMIT ?1"
        ))?;
        const T: usize = FLIGHT_COL_COUNT;
        let rows = stmt.query_map(params![limit, include_demo], |r| {
            Ok(RecentMetrics { flight: row_to_flight(r)?, has_track: r.get(T)?, metrics: row_to_metrics(r, T + 1)? })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const VECTORS: &str = include_str!("../../../app/src/fixtures/track-metrics-vectors.json");

    #[test]
    fn shared_constants_parse() {
        let c = &*CONSTANTS;
        assert_eq!((c.rotation_slow_deg_s, c.rotation_fast_deg_s), (1.5, 4.0));
        assert_eq!((c.gear_threshold_pct, c.config_hold_s, c.roll_min_s, c.airborne_min_s), (50.0, 2.0, 10.0, 10.0));
    }

    fn sample(r: &Value) -> TrackSample {
        let n = |i: usize| r[i].as_f64().unwrap();
        TrackSample {
            t_ms: r[0].as_u64().unwrap(),
            on_ground: n(1) == 1.0,
            ground_speed_kt: n(2),
            ias_kt: n(2),
            pitch_deg: n(3),
            altitude_agl_ft: n(4),
            gear_pct: n(5),
            flaps_index: n(6) as i32,
            latitude: n(7),
            longitude: n(8),
            altitude_msl_ft: 400.0,
            g_force: 1.0,
            ..Default::default()
        }
    }

    fn approach(a: &Value) -> ApproachSummary {
        let gates: Vec<ApproachGate> = serde_json::from_value(a["gates"].clone()).unwrap();
        let verdict = |k: GateKind| gates.iter().find(|g| g.kind == k).and_then(gate_verdict);
        let rw = &a["runway"];
        ApproachSummary {
            outcome: Some(serde_json::from_value(a["outcome"].clone()).unwrap()),
            airport: rw["airport"].as_str().map(str::to_owned),
            ident: rw["ident"].as_str().map(str::to_owned),
            threshold: rw["thresholdLat"].as_f64().zip(rw["thresholdLon"].as_f64()),
            exceedances: (!a["band"].is_null()).then(|| a["exceedances"].as_u64().unwrap() as u32),
            stable_1000: verdict(GateKind::Ft1000),
            stable_500: verdict(GateKind::Ft500),
        }
    }

    /// The same cases as `trackEvents.test.ts` ("flight metrics (shared vectors with the backend)").
    #[test]
    fn shared_vectors_match_the_frontend() {
        let v: Value = serde_json::from_str(VECTORS).unwrap();
        let cases = v["cases"].as_array().unwrap();
        assert!(cases.len() >= 6);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let samples: Vec<TrackSample> = c["samples"].as_array().unwrap().iter().map(sample).collect();
            let tds: Vec<TouchdownRef> = serde_json::from_value(c["touchdowns"].clone()).unwrap();
            let aps: Vec<ApproachSummary> = c["approaches"].as_array().unwrap().iter().map(approach).collect();
            let got = serde_json::to_value(derive(&samples, &tds, &aps)).unwrap();
            for (k, want) in c["expected"].as_object().unwrap() {
                let have = &got[k.as_str()];
                match want.as_f64() {
                    Some(w) => assert!(have.as_f64().is_some_and(|h| (h - w).abs() < 1e-4), "{name}: {k} = {have}, want {w}"),
                    None => assert_eq!(have, want, "{name}: {k}"),
                }
            }
        }
    }

    #[test]
    fn landing_is_the_last_full_stop() {
        let t = |tng| TouchdownRef { timestamp_ms: 0, touch_and_go: tng };
        assert_eq!(landing_touchdown_index(&[]), None);
        assert_eq!(landing_touchdown_index(&[t(false), t(true)]), Some(0));
        assert_eq!(landing_touchdown_index(&[t(true), t(true)]), Some(1));
    }

    #[test]
    fn nothing_measurable_is_all_none() {
        let m = derive(&[], &[], &[]);
        assert_eq!(m, FlightMetricsRow { version: FLIGHT_METRICS_VERSION, ..Default::default() });
    }
}
