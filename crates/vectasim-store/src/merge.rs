//! After a crash: continue an interrupted flight (`resume_*`, used by the recorder when the
//! pilot accepts "resume flight?") or join it with the flight that followed it
//! (`merge_flights`, logbook → "merge").
//!
//! Criteria (see the constants):
//! - resume offer: the newest interrupted flight whose last track sample is at most 30 min
//!   old, within 5 nm and ±3 000 ft of the first sample after (re)connecting; never for demo
//!   or replay flights, never a flight that reached on-block;
//! - merge: first flight interrupted, second starts at most 60 min after the first one's
//!   last sample (1 min of overlap tolerated) and at most 5 nm from where it ended.
//!
//! A merge runs in one transaction: times, distance, fuel and integrity are combined (the
//! gap goes to `gap_ms`), the tracks are decoded, concatenated and encoded again (preview
//! too), touchdowns and phase events of the second flight are copied over, cached landing /
//! approach facts of both are dropped (recomputed lazily), and the second flight goes to the
//! Papierkorb with all its rows, so restoring it gives it back unchanged.

use crate::recorder::PREVIEW_EVERY;
use crate::store::{FLIGHT_COLS, FlightRow, row_to_flight};
use crate::track::{TrackSample, decode_track, encode_track, subsample};
use crate::{Invalid, Result, Store, StoreError};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use vectasim_core::flight::{GeoPoint, haversine_nm};
use vectasim_core::{FlightPhase, FlightState, FlightSummary};

/// Resume offer: last known position at most this old ...
pub const RESUME_MAX_AGE_MS: u64 = 30 * 60_000;
/// ... at most this far from the current one ...
pub const RESUME_MAX_DISTANCE_NM: f64 = 5.0;
/// ... and at most this much higher or lower.
pub const RESUME_MAX_ALT_DIFF_FT: f64 = 3_000.0;
/// Merge: the second flight starts at most this long after the first one ended ...
pub const MERGE_MAX_GAP_MS: u64 = 60 * 60_000;
/// ... (overlapping by up to this much counts as no gap) ...
pub const MERGE_OVERLAP_TOLERANCE_MS: u64 = 60_000;
/// ... and at most this far from where it ended.
pub const MERGE_MAX_JUMP_NM: f64 = 5.0;
/// Interrupted flights looked at for an offer / for candidates (newest first).
const SCAN_LIMIT: u32 = 50;

/// `flight:resumable`: an interrupted flight the current position continues.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeCandidate {
    pub flight_id: String,
    pub dep: Option<String>,
    /// Planned destination (OFP), if any.
    pub arr: Option<String>,
    pub callsign: Option<String>,
    pub off_block_ms: Option<u64>,
    /// Time of the last recorded sample.
    pub last_ms: u64,
    /// From the last recorded position to the current one.
    pub distance_nm: f64,
    pub alt_diff_ft: f64,
}

/// `list_merge_candidates`: an interrupted flight and the flight that seems to continue it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeCandidate {
    pub first: FlightRow,
    pub second: FlightRow,
    pub gap_ms: u64,
    pub distance_nm: f64,
}

/// What `merge_flights` did.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeReport {
    /// The merged flight (id of the first one).
    pub flight_id: String,
    /// The second flight, now in the Papierkorb.
    pub removed_id: String,
    pub gap_ms: u64,
    pub distance_nm: f64,
    pub sample_count: usize,
}

/// One end of a flight: time and position (track sample, else the row's columns).
#[derive(Clone, Copy, Debug)]
struct End {
    t_ms: u64,
    pos: Option<GeoPoint>,
}

fn point(lat: Option<f64>, lon: Option<f64>) -> Option<GeoPoint> {
    Some(GeoPoint { latitude: lat?, longitude: lon? })
}

fn sample_end(s: &TrackSample) -> End {
    End { t_ms: s.t_ms, pos: Some(GeoPoint { latitude: s.latitude, longitude: s.longitude }) }
}

/// Where and when a flight ends: its last track sample, else the latest time of the row.
fn end_of(f: &FlightRow, track: &[TrackSample]) -> Option<End> {
    if let Some(s) = track.last() {
        return Some(sample_end(s));
    }
    let t = [f.on_block_ms, f.landing_ms, f.takeoff_ms, f.off_block_ms].into_iter().flatten().max()?;
    Some(End { t_ms: t, pos: point(f.arr_lat, f.arr_lon).or(point(f.dep_lat, f.dep_lon)) })
}

/// Where and when a flight starts: its first track sample, else off-block / creation.
fn start_of(f: &FlightRow, track: &[TrackSample]) -> End {
    match track.first() {
        Some(s) => sample_end(s),
        None => End { t_ms: f.off_block_ms.unwrap_or(f.created_ms), pos: point(f.dep_lat, f.dep_lon) },
    }
}

/// Gap and position jump between the end of `first` and the start of `second`, or why the
/// two cannot be one flight.
fn check_pair(end: Option<End>, start: End) -> std::result::Result<(u64, f64), Invalid> {
    let end = end.ok_or(Invalid::MergeNoEnd)?;
    if start.t_ms + MERGE_OVERLAP_TOLERANCE_MS < end.t_ms {
        return Err(Invalid::MergeOverlap);
    }
    let gap = start.t_ms.saturating_sub(end.t_ms);
    if gap > MERGE_MAX_GAP_MS {
        return Err(Invalid::MergeGap { minutes: gap / 60_000, max_minutes: MERGE_MAX_GAP_MS / 60_000 });
    }
    let (Some(a), Some(b)) = (end.pos, start.pos) else { return Err(Invalid::MergePositionUnknown) };
    let d = haversine_nm(a, b);
    if !d.is_finite() || d > MERGE_MAX_JUMP_NM {
        return Err(Invalid::MergeJump { distance_nm: d, max_nm: MERGE_MAX_JUMP_NM });
    }
    Ok((gap, d))
}

fn invalid(i: Invalid) -> StoreError {
    StoreError::Invalid(i)
}

fn flight_row(conn: &Connection, id: &str) -> Result<Option<(FlightRow, bool)>> {
    Ok(conn
        .query_row(&format!("SELECT {FLIGHT_COLS}, f.deleted_ms IS NOT NULL FROM flights f WHERE f.id = ?1"), params![id], |r| {
            Ok((row_to_flight(r)?, r.get::<_, bool>(crate::store::FLIGHT_COL_COUNT)?))
        })
        .optional()?)
}

fn track_of(conn: &Connection, id: &str, column: &str) -> Result<Vec<TrackSample>> {
    let blob: Option<Vec<u8>> =
        conn.query_row(&format!("SELECT {column} FROM tracks WHERE flight_id = ?1"), params![id], |r| r.get(0)).optional()?;
    Ok(match blob {
        Some(b) => decode_track(&b)?,
        None => Vec::new(),
    })
}

/// Text columns where an empty string means "not set" as much as NULL does.
const COALESCED_COLS: &[&str] = &[
    "off_block_ms",
    "dep_lat",
    "dep_lon",
    "dep_icao",
    "callsign",
    "planned_dep",
    "planned_arr",
    "planned_block_s",
    "planned_fuel_ramp_kg",
    "planned_fuel_landing_kg",
    "ofp_json",
    "dep_metar",
    "dep_metar_ms",
    "airframe_reg",
    "aircraft_title",
    "atc_model",
    "atc_type",
    "atc_id",
    "atc_airline",
    "atc_flight_number",
    "sim_name",
    "provider",
    // what the pilot added to either part (v14)
    "notes",
    "tags",
    "user_callsign",
    "user_dep_icao",
    "user_arr_icao",
    "user_aircraft_title",
    "user_registration",
    "rating",
];

const TOUCHDOWN_COLS: &str = "timestamp_ms, vs_fpm_measured, vs_fpm_sim, vs_fpm_hardest, peak_g, pitch_deg, bank_deg,
    ground_speed_kt, heading_true_deg, latitude, longitude, bounces, touch_and_go, landing_rate_fpm, landing_rate_source";

impl Store {
    /// A stored flight as the `FlightSession` keeps it (for resuming it).
    pub fn flight_summary(&self, id: &str) -> Result<Option<FlightSummary>> {
        let Some(d) = self.get_flight(id)? else { return Ok(None) };
        let f = d.flight;
        let state = match f.state.as_str() {
            "active" => FlightState::Active,
            "completed" => FlightState::Completed,
            "interrupted" => FlightState::Interrupted,
            "discarded" => FlightState::Discarded,
            _ => FlightState::Idle,
        };
        // the last full stop's rate, unless it is unrated (slewed / fast-forwarded down): like
        // `FlightSession`, never a 0 fpm that would show and count as the flight's rate
        let landing_rate_fpm = d
            .touchdowns
            .iter()
            .rev()
            .find(|t| !t.touch_and_go)
            .filter(|t| t.landing_rate_source.is_rated())
            .map(|t| t.landing_rate_fpm);
        Ok(Some(FlightSummary {
            state,
            phase: f.phase,
            off_block_ms: f.off_block_ms,
            takeoff_ms: f.takeoff_ms,
            landing_ms: f.landing_ms,
            on_block_ms: f.on_block_ms,
            departure: point(f.dep_lat, f.dep_lon),
            arrival: point(f.arr_lat, f.arr_lon),
            max_altitude_msl_ft: f.max_alt_msl_ft,
            distance_nm: f.distance_nm,
            fuel_start_kg: f.fuel_start_kg,
            fuel_end_kg: f.fuel_end_kg,
            touchdowns: d.touchdowns,
            landing_rate_fpm,
            integrity: f.integrity,
            g_load: f.g_load.unwrap_or_default(),
        }))
    }

    /// The interrupted flight the current position continues, if any (see the module doc for
    /// the criteria). `now_ms` is the time of the current sample.
    pub fn resume_candidate(&self, lat: f64, lon: f64, alt_msl_ft: f64, now_ms: u64) -> Result<Option<ResumeCandidate>> {
        let conn = self.conn();
        let rows: Vec<FlightRow> = conn
            .prepare(&format!(
                "SELECT {FLIGHT_COLS} FROM flights f
                 WHERE f.state = 'interrupted' AND f.deleted_ms IS NULL AND f.on_block_ms IS NULL
                   AND COALESCE(f.provider, '') NOT IN ('mock', 'replay')
                 ORDER BY COALESCE(f.off_block_ms, f.created_ms) DESC LIMIT ?1"
            ))?
            .query_map(params![SCAN_LIMIT], row_to_flight)?
            .collect::<std::result::Result<_, _>>()?;
        let here = GeoPoint { latitude: lat, longitude: lon };
        for f in rows {
            if f.phase == FlightPhase::Shutdown {
                continue;
            }
            // the preview always ends with the last sample
            let Some(last) = track_of(&conn, &f.id, "preview")?.pop() else { continue };
            if last.t_ms > now_ms + MERGE_OVERLAP_TOLERANCE_MS || now_ms.saturating_sub(last.t_ms) > RESUME_MAX_AGE_MS {
                continue;
            }
            let distance_nm = haversine_nm(GeoPoint { latitude: last.latitude, longitude: last.longitude }, here);
            let alt_diff_ft = alt_msl_ft - last.altitude_msl_ft;
            if distance_nm <= RESUME_MAX_DISTANCE_NM && alt_diff_ft.abs() <= RESUME_MAX_ALT_DIFF_FT {
                return Ok(Some(ResumeCandidate {
                    flight_id: f.id,
                    dep: f.dep_icao,
                    arr: f.planned_arr.filter(|s| !s.is_empty()),
                    callsign: f.callsign.filter(|s| !s.is_empty()),
                    off_block_ms: f.off_block_ms,
                    last_ms: last.t_ms,
                    distance_nm,
                    alt_diff_ft,
                }));
            }
        }
        Ok(None)
    }

    /// Make an interrupted flight the active one again (the recorder resumes it). Errors
    /// when it is unknown, in the Papierkorb or not interrupted.
    pub(crate) fn reopen_flight(&self, id: &str, now_ms: u64) -> Result<()> {
        let n = self.conn().execute(
            "UPDATE flights SET state = 'active', on_block_ms = NULL, updated_ms = ?2
             WHERE id = ?1 AND state = 'interrupted' AND deleted_ms IS NULL",
            params![id, now_ms as i64],
        )?;
        if n == 0 {
            return Err(invalid(Invalid::ResumeNotInterrupted));
        }
        Ok(())
    }

    /// Interrupted flights directly followed by a flight that continues them (gap ≤ 60 min,
    /// position jump ≤ 5 nm), newest first.
    pub fn list_merge_candidates(&self) -> Result<Vec<MergeCandidate>> {
        let conn = self.conn();
        let firsts: Vec<FlightRow> = conn
            .prepare(&format!(
                "SELECT {FLIGHT_COLS} FROM flights f WHERE f.state = 'interrupted' AND f.deleted_ms IS NULL
                 ORDER BY COALESCE(f.off_block_ms, f.created_ms) DESC LIMIT ?1"
            ))?
            .query_map(params![SCAN_LIMIT], row_to_flight)?
            .collect::<std::result::Result<_, _>>()?;
        let mut next_stmt = conn.prepare(&format!(
            "SELECT {FLIGHT_COLS} FROM flights f
             WHERE f.deleted_ms IS NULL AND f.id <> ?1
               AND (COALESCE(f.off_block_ms, f.created_ms) > ?2 OR (COALESCE(f.off_block_ms, f.created_ms) = ?2 AND f.created_ms > ?3))
             ORDER BY COALESCE(f.off_block_ms, f.created_ms), f.created_ms LIMIT 1"
        ))?;
        let mut out = Vec::new();
        for first in firsts {
            let start = first.off_block_ms.unwrap_or(first.created_ms) as i64;
            let Some(second) = next_stmt.query_row(params![first.id, start, first.created_ms as i64], row_to_flight).optional()? else {
                continue;
            };
            let end = end_of(&first, &track_of(&conn, &first.id, "preview")?);
            let begin = start_of(&second, &track_of(&conn, &second.id, "preview")?);
            if let Ok((gap_ms, distance_nm)) = check_pair(end, begin) {
                out.push(MergeCandidate { first, second, gap_ms, distance_nm });
            }
        }
        Ok(out)
    }

    /// Join `second_id` onto `first_id` (see the module doc).
    pub fn merge_flights(&self, first_id: &str, second_id: &str) -> Result<MergeReport> {
        self.merge_flights_at(first_id, second_id, vectasim_core::now_ms())
    }

    pub fn merge_flights_at(&self, first_id: &str, second_id: &str, now_ms: u64) -> Result<MergeReport> {
        if first_id == second_id {
            return Err(invalid(Invalid::MergeSelf));
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let (a, a_deleted) = flight_row(&tx, first_id)?.ok_or_else(|| invalid(Invalid::FlightNotFound))?;
        let (b, b_deleted) = flight_row(&tx, second_id)?.ok_or_else(|| invalid(Invalid::FlightNotFound))?;
        if a_deleted || b_deleted {
            return Err(invalid(Invalid::MergeTrashed));
        }
        if a.state != "interrupted" {
            return Err(invalid(Invalid::ResumeNotInterrupted));
        }
        let track_a = track_of(&tx, first_id, "data")?;
        let track_b = track_of(&tx, second_id, "data")?;
        let (gap_ms, distance_nm) = check_pair(end_of(&a, &track_a), start_of(&b, &track_b)).map_err(invalid)?;

        let mut integrity = a.integrity.merged(&b.integrity);
        integrity.gap_ms += gap_ms;
        let arr_from_b = b.landing_ms.is_some() || b.arr_lat.is_some();
        let (arr_lat, arr_lon, arr_icao) =
            if arr_from_b { (b.arr_lat, b.arr_lon, b.arr_icao.clone()) } else { (a.arr_lat, a.arr_lon, a.arr_icao.clone()) };
        // the arrival METAR goes with the landing
        let (arr_metar, arr_metar_ms) = if b.landing_ms.is_some() && b.arr_metar.is_some() {
            (b.arr_metar.clone(), b.arr_metar_ms)
        } else {
            (a.arr_metar.clone().or(b.arr_metar.clone()), a.arr_metar_ms.or(b.arr_metar_ms))
        };
        tx.execute(
            "UPDATE flights SET state = ?2, phase = ?3, updated_ms = ?4, takeoff_ms = ?5, landing_ms = ?6, on_block_ms = ?7,
                arr_lat = ?8, arr_lon = ?9, arr_icao = ?10, max_alt_msl_ft = ?11, distance_nm = ?12, fuel_start_kg = ?13,
                fuel_end_kg = ?14, paused_ms = ?15, pause_count = ?16, slew_detected = ?17, time_accel_detected = ?18,
                max_sim_rate = ?19, crashed = ?20, fuel_increased_airborne = ?21, teleport_detected = ?22, gap_ms = ?23,
                arr_metar = ?24, arr_metar_ms = ?25
             WHERE id = ?1",
            params![
                first_id,
                b.state,
                crate::store::phase_str(b.phase),
                now_ms as i64,
                a.takeoff_ms.or(b.takeoff_ms).map(|v| v as i64),
                b.landing_ms.or(a.landing_ms).map(|v| v as i64),
                b.on_block_ms.map(|v| v as i64),
                arr_lat,
                arr_lon,
                arr_icao,
                a.max_alt_msl_ft.max(b.max_alt_msl_ft),
                a.distance_nm + b.distance_nm,
                a.fuel_start_kg.or(b.fuel_start_kg),
                b.fuel_end_kg.or(a.fuel_end_kg),
                integrity.paused_ms as i64,
                integrity.pause_count,
                integrity.slew_detected,
                integrity.time_acceleration_detected,
                integrity.max_sim_rate,
                integrity.crashed,
                integrity.fuel_increased_airborne,
                integrity.teleport_detected,
                integrity.gap_ms as i64,
                arr_metar,
                arr_metar_ms.map(|v| v as i64),
            ],
        )?;
        // g-load: both measured → merged; otherwise derived again from the merged track on the next read
        match (&a.g_load, &b.g_load) {
            (Some(ga), Some(gb)) => crate::store::write_g_load(&tx, first_id, Some(&ga.merged(gb)))?,
            _ => crate::store::clear_g_load(&tx, first_id)?,
        }
        // plan, METAR at off-block, airframe, aircraft: the first flight's, missing ones from the second
        let sets = COALESCED_COLS
            .iter()
            .map(|c| format!("{c} = CASE WHEN {c} IS NULL OR {c} = '' THEN (SELECT s.{c} FROM flights s WHERE s.id = ?2) ELSE {c} END"))
            .collect::<Vec<_>>()
            .join(", ");
        tx.execute(&format!("UPDATE flights SET {sets} WHERE id = ?1"), params![first_id, second_id])?;

        // touchdowns and phase events: copies, so the second flight stays complete in the Papierkorb
        let n_first: i64 = tx.query_row("SELECT COUNT(*) FROM touchdowns WHERE flight_id = ?1", params![first_id], |r| r.get(0))?;
        tx.execute(
            &format!("INSERT INTO touchdowns (flight_id, {TOUCHDOWN_COLS}) SELECT ?1, {TOUCHDOWN_COLS} FROM touchdowns WHERE flight_id = ?2 ORDER BY timestamp_ms, id"),
            params![first_id, second_id],
        )?;
        tx.execute(
            "INSERT INTO phase_events (flight_id, from_phase, to_phase, timestamp_ms)
             SELECT ?1, from_phase, to_phase, timestamp_ms FROM phase_events WHERE flight_id = ?2 ORDER BY timestamp_ms, id",
            params![first_id, second_id],
        )?;
        // landings already averaged into a derived runway stay counted (indices shift by the first flight's touchdowns)
        tx.execute(
            "INSERT OR IGNORE INTO user_runway_landings (airport_icao, ident, flight_id, touchdown_index, added_ms)
             SELECT airport_icao, ident, ?1, touchdown_index + ?3, added_ms FROM user_runway_landings WHERE flight_id = ?2",
            params![first_id, second_id, n_first],
        )?;
        tx.execute("DELETE FROM landing_facts WHERE flight_id IN (?1, ?2)", params![first_id, second_id])?;
        self.results_changed();
        tx.execute("DELETE FROM approach_facts WHERE flight_id IN (?1, ?2)", params![first_id, second_id])?;
        tx.execute("DELETE FROM flight_metrics WHERE flight_id IN (?1, ?2)", params![first_id, second_id])?;

        let mut samples = track_a;
        samples.extend(track_b);
        samples.sort_by_key(|s| s.t_ms);
        if !samples.is_empty() {
            let data = encode_track(&samples);
            let preview = encode_track(&subsample(&samples, PREVIEW_EVERY));
            tx.execute(
                "INSERT INTO tracks (flight_id, sample_count, encoding, data, preview, updated_ms)
                 VALUES (?1, ?2, 'vstk1', ?3, ?4, ?5)
                 ON CONFLICT(flight_id) DO UPDATE SET sample_count = excluded.sample_count, data = excluded.data,
                    preview = excluded.preview, updated_ms = excluded.updated_ms",
                params![first_id, samples.len() as i64, data, preview, now_ms as i64],
            )?;
        }
        tx.execute("UPDATE flights SET deleted_ms = ?2 WHERE id = ?1", params![second_id, now_ms as i64])?;
        tx.commit()?;
        log::info!("flight {second_id} merged into {first_id} (gap {} s, {distance_nm:.2} nm)", gap_ms / 1000);
        Ok(MergeReport {
            flight_id: first_id.to_string(),
            removed_id: second_id.to_string(),
            gap_ms,
            distance_nm,
            sample_count: samples.len(),
        })
    }
}
