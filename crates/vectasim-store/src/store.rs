//! SQLite access: schema, migrations and the read/write API the app uses.
//! The connection lives behind a mutex so the recorder thread and Tauri
//! commands can share one `Store` clone.

use crate::track::{TrackSample, decode_track};
use crate::{Result, StoreError};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use vectasim_core::{AircraftInfo, FlightPhase, FlightSummary, IntegrityFlags, LandingRateSource, TouchdownReport};

const SCHEMA_VERSION: i64 = 6;

const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS flights (
    id                      TEXT PRIMARY KEY,
    state                   TEXT NOT NULL,          -- active | completed | interrupted
    phase                   TEXT NOT NULL,
    created_ms              INTEGER NOT NULL,
    updated_ms              INTEGER NOT NULL,
    off_block_ms            INTEGER,
    takeoff_ms              INTEGER,
    landing_ms              INTEGER,
    on_block_ms             INTEGER,
    dep_lat                 REAL,
    dep_lon                 REAL,
    arr_lat                 REAL,
    arr_lon                 REAL,
    max_alt_msl_ft          REAL NOT NULL DEFAULT 0,
    distance_nm             REAL NOT NULL DEFAULT 0,
    fuel_start_kg           REAL,
    fuel_end_kg             REAL,
    aircraft_title          TEXT,
    atc_model               TEXT,
    atc_type                TEXT,
    atc_id                  TEXT,
    atc_airline             TEXT,
    atc_flight_number       TEXT,
    provider                TEXT,
    sim_name                TEXT,
    paused_ms               INTEGER NOT NULL DEFAULT 0,
    pause_count             INTEGER NOT NULL DEFAULT 0,
    slew_detected           INTEGER NOT NULL DEFAULT 0,
    time_accel_detected     INTEGER NOT NULL DEFAULT 0,
    max_sim_rate            REAL NOT NULL DEFAULT 1,
    crashed                 INTEGER NOT NULL DEFAULT 0,
    fuel_increased_airborne INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS flights_off_block ON flights(off_block_ms DESC);

CREATE TABLE IF NOT EXISTS touchdowns (
    id               INTEGER PRIMARY KEY,
    flight_id        TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
    timestamp_ms     INTEGER NOT NULL,
    vs_fpm_measured  REAL NOT NULL,
    vs_fpm_sim       REAL NOT NULL,
    vs_fpm_hardest   REAL NOT NULL,
    peak_g           REAL NOT NULL,
    pitch_deg        REAL NOT NULL,
    bank_deg         REAL NOT NULL,
    ground_speed_kt  REAL NOT NULL,
    heading_true_deg REAL NOT NULL,
    latitude         REAL NOT NULL,
    longitude        REAL NOT NULL,
    bounces          INTEGER NOT NULL,
    touch_and_go     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS touchdowns_flight ON touchdowns(flight_id);

CREATE TABLE IF NOT EXISTS phase_events (
    id           INTEGER PRIMARY KEY,
    flight_id    TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
    from_phase   TEXT NOT NULL,
    to_phase     TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS phase_events_flight ON phase_events(flight_id);

CREATE TABLE IF NOT EXISTS tracks (
    flight_id    TEXT PRIMARY KEY REFERENCES flights(id) ON DELETE CASCADE,
    sample_count INTEGER NOT NULL,
    encoding     TEXT NOT NULL,                      -- 'vstk1'
    data         BLOB NOT NULL,
    preview      BLOB NOT NULL,
    updated_ms   INTEGER NOT NULL
);
"#;

/// v2: departure/arrival ICAO resolved from the airport index.
const MIGRATION_V2: &str = r#"
ALTER TABLE flights ADD COLUMN dep_icao TEXT;
ALTER TABLE flights ADD COLUMN arr_icao TEXT;
"#;

/// v3: key/value settings and the dispatch plan (OFP) attached to a flight.
const MIGRATION_V3: &str = r#"
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
ALTER TABLE flights ADD COLUMN callsign TEXT;
ALTER TABLE flights ADD COLUMN planned_dep TEXT;
ALTER TABLE flights ADD COLUMN planned_arr TEXT;
ALTER TABLE flights ADD COLUMN planned_block_s INTEGER;
ALTER TABLE flights ADD COLUMN planned_fuel_ramp_kg REAL;
ALTER TABLE flights ADD COLUMN planned_fuel_landing_kg REAL;
ALTER TABLE flights ADD COLUMN ofp_json TEXT;
"#;

/// v4: headline landing rate per touchdown (worst contact, sim value preferred – see
/// vectasim_core::touchdown). Older rows stay NULL and are derived on read by
/// `LANDING_RATE_SQL` from the columns they have.
const MIGRATION_V4: &str = r#"
ALTER TABLE touchdowns ADD COLUMN landing_rate_fpm REAL;
ALTER TABLE touchdowns ADD COLUMN landing_rate_source TEXT;
"#;

/// v5: the METAR (raw text) at off-block and at the landing, with when it was captured,
/// so the debrief shows the weather of the landing instead of the weather now.
const MIGRATION_V5: &str = r#"
ALTER TABLE flights ADD COLUMN dep_metar TEXT;
ALTER TABLE flights ADD COLUMN dep_metar_ms INTEGER;
ALTER TABLE flights ADD COLUMN arr_metar TEXT;
ALTER TABLE flights ADD COLUMN arr_metar_ms INTEGER;
"#;

/// Which end of a flight a stored METAR describes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MetarSlot {
    /// Captured at off-block.
    Departure,
    /// Captured at the landing.
    Arrival,
}

/// Headline landing rate of a touchdown row, also for rows written before v4: the sim
/// value when it has one (|v| ≥ 1 fpm), else the measured V/S, rounded.
pub(crate) const LANDING_RATE_SQL: &str =
    "COALESCE(landing_rate_fpm, ROUND(CASE WHEN ABS(vs_fpm_sim) >= 1 THEN vs_fpm_sim ELSE vs_fpm_measured END))";
const LANDING_SOURCE_SQL: &str =
    "COALESCE(landing_rate_source, CASE WHEN ABS(vs_fpm_sim) >= 1 THEN 'sim' ELSE 'measured' END)";

/// What the store keeps of a dispatch plan, independent of where it came from
/// (SimBrief today). `ofp_json` is the full document for the detail view.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedFlight {
    pub callsign: String,
    pub dep_icao: String,
    pub arr_icao: String,
    pub block_s: u64,
    pub fuel_ramp_kg: f64,
    pub fuel_landing_kg: f64,
    pub ofp_json: String,
    /// Airframe facts from the plan; the registration books the flight onto its airframe.
    #[serde(default)]
    pub registration: String,
    #[serde(default)]
    pub aircraft_icao: String,
    #[serde(default)]
    pub aircraft_name: String,
    #[serde(default)]
    pub airline_icao: String,
}

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

/// One row of the logbook list.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightRow {
    pub id: String,
    pub state: String,
    pub phase: FlightPhase,
    pub created_ms: u64,
    pub updated_ms: u64,
    pub off_block_ms: Option<u64>,
    pub takeoff_ms: Option<u64>,
    pub landing_ms: Option<u64>,
    pub on_block_ms: Option<u64>,
    pub dep_lat: Option<f64>,
    pub dep_lon: Option<f64>,
    pub arr_lat: Option<f64>,
    pub arr_lon: Option<f64>,
    pub max_alt_msl_ft: f64,
    pub distance_nm: f64,
    pub fuel_start_kg: Option<f64>,
    pub fuel_end_kg: Option<f64>,
    pub aircraft: AircraftInfo,
    pub provider: Option<String>,
    pub sim_name: Option<String>,
    pub dep_icao: Option<String>,
    pub arr_icao: Option<String>,
    pub callsign: Option<String>,
    pub planned_dep: Option<String>,
    pub planned_arr: Option<String>,
    pub planned_block_s: Option<u64>,
    pub planned_fuel_ramp_kg: Option<f64>,
    pub planned_fuel_landing_kg: Option<f64>,
    pub has_ofp: bool,
    pub integrity: IntegrityFlags,
    /// Landing rate of the flight: headline rate of the last full-stop touchdown (touch-and-goes excluded).
    pub landing_vs_fpm: Option<f64>,
    pub landing_count: u32,
    /// Raw METAR of the departure/landing airport (or its nearest reporting neighbour),
    /// captured at off-block / at the landing; `*_ms` is when it was captured.
    pub dep_metar: Option<String>,
    pub dep_metar_ms: Option<u64>,
    pub arr_metar: Option<String>,
    pub arr_metar_ms: Option<u64>,
    /// Registration of the airframe this flight is booked onto.
    pub airframe_reg: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseEventRow {
    pub from: FlightPhase,
    pub to: FlightPhase,
    pub timestamp_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightDetail {
    pub flight: FlightRow,
    pub touchdowns: Vec<TouchdownReport>,
    pub phases: Vec<PhaseEventRow>,
    pub has_track: bool,
    /// Full dispatch document (SimBrief JSON as stored), if one was attached.
    pub ofp_json: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub flights: u64,
    pub completed: u64,
    pub block_time_ms: u64,
    pub flight_time_ms: u64,
    pub distance_nm: f64,
    pub landings: u64,
    pub avg_landing_vs_fpm: Option<f64>,
}

/// Static per-flight context the recorder knows but the summary does not.
#[derive(Clone, Debug, Default)]
pub struct FlightContext {
    pub provider: String,
    pub sim_name: Option<String>,
    pub aircraft: Option<AircraftInfo>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Self::migrate(&conn)?;
        // A flight left 'active' means the app died mid-flight; keep it, but say so.
        let now = vectasim_core::now_ms() as i64;
        conn.execute(
            "UPDATE flights SET state = 'interrupted', updated_ms = ?1 WHERE state = 'active'",
            params![now],
        )?;
        Ok(Self { conn: Arc::new(Mutex::new(conn)) })
    }

    /// Apply schema steps newer than what the file has. Each step bumps
    /// `schema_version`, so a crash between steps resumes cleanly.
    fn migrate(conn: &Connection) -> Result<()> {
        conn.execute_batch(SCHEMA_V1)?;
        let mut version: i64 =
            conn.query_row("SELECT COALESCE(MAX(version), 0) FROM schema_version", [], |r| r.get(0))?;
        if version == 0 {
            conn.execute("INSERT INTO schema_version(version) VALUES (1)", [])?;
            version = 1;
        }
        if version < 2 {
            conn.execute_batch(MIGRATION_V2)?;
            conn.execute("UPDATE schema_version SET version = 2", [])?;
            version = 2;
        }
        if version < 3 {
            conn.execute_batch(MIGRATION_V3)?;
            conn.execute("UPDATE schema_version SET version = 3", [])?;
            version = 3;
        }
        if version < 4 {
            conn.execute_batch(MIGRATION_V4)?;
            conn.execute("UPDATE schema_version SET version = 4", [])?;
            version = 4;
        }
        if version < 5 {
            conn.execute_batch(MIGRATION_V5)?;
            conn.execute("UPDATE schema_version SET version = 5", [])?;
            version = 5;
        }
        if version < 6 {
            conn.execute_batch(crate::airframe::MIGRATION_V6)?;
            let booked = crate::airframe::backfill(conn)?;
            log::info!("airframes: {booked} existing flights booked by registration");
            conn.execute("UPDATE schema_version SET version = 6", [])?;
            version = 6;
        }
        debug_assert_eq!(version, SCHEMA_VERSION);
        log::info!("logbook schema version {version}");
        Ok(())
    }

    pub fn schema_version(&self) -> Result<i64> {
        Ok(self.conn().query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))?)
    }

    pub(crate) fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ---- writes used by the recorder -------------------------------------------------

    pub(crate) fn insert_flight(
        &self,
        id: &str,
        s: &FlightSummary,
        ctx: &FlightContext,
        dep_icao: Option<&str>,
        now_ms: u64,
    ) -> Result<()> {
        let ac = ctx.aircraft.clone().unwrap_or_default();
        self.conn().execute(
            "INSERT INTO flights (id, state, phase, created_ms, updated_ms, off_block_ms, dep_lat, dep_lon,
                max_alt_msl_ft, distance_nm, fuel_start_kg, aircraft_title, atc_model, atc_type, atc_id,
                atc_airline, atc_flight_number, provider, sim_name, dep_icao)
             VALUES (?1, 'active', ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![
                id,
                phase_str(s.phase),
                now_ms as i64,
                s.off_block_ms.map(|v| v as i64),
                s.departure.map(|p| p.latitude),
                s.departure.map(|p| p.longitude),
                s.max_altitude_msl_ft,
                s.distance_nm,
                s.fuel_start_kg,
                ac.title,
                ac.atc_model,
                ac.atc_type,
                ac.atc_id,
                ac.atc_airline,
                ac.atc_flight_number,
                ctx.provider,
                ctx.sim_name,
                dep_icao,
            ],
        )?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
            .optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn all_settings(&self) -> Result<Vec<(String, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Attach (or replace) the dispatch plan of a flight.
    pub fn attach_plan(&self, flight_id: &str, plan: &PlannedFlight) -> Result<bool> {
        let n = self.conn().execute(
            "UPDATE flights SET callsign = ?2, planned_dep = ?3, planned_arr = ?4, planned_block_s = ?5,
                planned_fuel_ramp_kg = ?6, planned_fuel_landing_kg = ?7, ofp_json = ?8 WHERE id = ?1",
            params![
                flight_id,
                plan.callsign,
                plan.dep_icao,
                plan.arr_icao,
                plan.block_s as i64,
                plan.fuel_ramp_kg,
                plan.fuel_landing_kg,
                plan.ofp_json,
            ],
        )?;
        if n > 0
            && let Some(reg) = crate::airframe::normalize_registration(&plan.registration)
        {
            let hint = crate::airframe::AirframeHint {
                icao_type: plan.aircraft_icao.to_uppercase(),
                title: plan.aircraft_name.clone(),
                airline: plan.airline_icao.to_uppercase(),
            };
            self.book_flight_airframe(flight_id, &reg, &hint, vectasim_core::now_ms())?;
        }
        Ok(n > 0)
    }

    /// The flight currently being recorded, if any.
    pub fn active_flight_id(&self) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row("SELECT id FROM flights WHERE state = 'active' ORDER BY created_ms DESC LIMIT 1", [], |r| r.get(0))
            .optional()?)
    }

    /// Store the METAR captured for one end of a flight (replaces an earlier one).
    pub fn set_flight_metar(&self, flight_id: &str, slot: MetarSlot, raw: &str, captured_ms: u64) -> Result<bool> {
        let sql = match slot {
            MetarSlot::Departure => "UPDATE flights SET dep_metar = ?2, dep_metar_ms = ?3 WHERE id = ?1",
            MetarSlot::Arrival => "UPDATE flights SET arr_metar = ?2, arr_metar_ms = ?3 WHERE id = ?1",
        };
        Ok(self.conn().execute(sql, params![flight_id, raw, captured_ms as i64])? > 0)
    }

    pub(crate) fn set_arrival_icao(&self, id: &str, arr_icao: Option<&str>) -> Result<()> {
        self.conn().execute("UPDATE flights SET arr_icao = ?2 WHERE id = ?1", params![id, arr_icao])?;
        Ok(())
    }

    pub(crate) fn update_flight(&self, id: &str, s: &FlightSummary, state: &str, now_ms: u64) -> Result<()> {
        let i = &s.integrity;
        self.conn().execute(
            "UPDATE flights SET state = ?2, phase = ?3, updated_ms = ?4, off_block_ms = ?5, takeoff_ms = ?6,
                landing_ms = ?7, on_block_ms = ?8, dep_lat = ?9, dep_lon = ?10, arr_lat = ?11, arr_lon = ?12,
                max_alt_msl_ft = ?13, distance_nm = ?14, fuel_start_kg = ?15, fuel_end_kg = ?16,
                paused_ms = ?17, pause_count = ?18, slew_detected = ?19, time_accel_detected = ?20,
                max_sim_rate = ?21, crashed = ?22, fuel_increased_airborne = ?23
             WHERE id = ?1",
            params![
                id,
                state,
                phase_str(s.phase),
                now_ms as i64,
                s.off_block_ms.map(|v| v as i64),
                s.takeoff_ms.map(|v| v as i64),
                s.landing_ms.map(|v| v as i64),
                s.on_block_ms.map(|v| v as i64),
                s.departure.map(|p| p.latitude),
                s.departure.map(|p| p.longitude),
                s.arrival.map(|p| p.latitude),
                s.arrival.map(|p| p.longitude),
                s.max_altitude_msl_ft,
                s.distance_nm,
                s.fuel_start_kg,
                s.fuel_end_kg,
                i.paused_ms as i64,
                i.pause_count,
                i.slew_detected,
                i.time_acceleration_detected,
                i.max_sim_rate,
                i.crashed,
                i.fuel_increased_airborne,
            ],
        )?;
        Ok(())
    }

    pub(crate) fn update_flight_aircraft(&self, id: &str, ac: &AircraftInfo) -> Result<()> {
        self.conn().execute(
            "UPDATE flights SET aircraft_title = ?2, atc_model = ?3, atc_type = ?4, atc_id = ?5, atc_airline = ?6,
                atc_flight_number = ?7 WHERE id = ?1",
            params![id, ac.title, ac.atc_model, ac.atc_type, ac.atc_id, ac.atc_airline, ac.atc_flight_number],
        )?;
        Ok(())
    }

    pub(crate) fn insert_touchdown(&self, flight_id: &str, r: &TouchdownReport) -> Result<()> {
        self.conn().execute(
            "INSERT INTO touchdowns (flight_id, timestamp_ms, vs_fpm_measured, vs_fpm_sim, vs_fpm_hardest, peak_g,
                pitch_deg, bank_deg, ground_speed_kt, heading_true_deg, latitude, longitude, bounces, touch_and_go,
                landing_rate_fpm, landing_rate_source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                flight_id,
                r.timestamp_ms as i64,
                r.vs_fpm_measured,
                r.vs_fpm_sim,
                r.vs_fpm_hardest,
                r.peak_g,
                r.pitch_deg,
                r.bank_deg,
                r.ground_speed_kt,
                r.heading_true_deg,
                r.latitude,
                r.longitude,
                r.bounces,
                r.touch_and_go,
                r.landing_rate_fpm,
                r.landing_rate_source.as_str(),
            ],
        )?;
        Ok(())
    }

    pub(crate) fn insert_phase_event(&self, flight_id: &str, from: FlightPhase, to: FlightPhase, ts: u64) -> Result<()> {
        self.conn().execute(
            "INSERT INTO phase_events (flight_id, from_phase, to_phase, timestamp_ms) VALUES (?1, ?2, ?3, ?4)",
            params![flight_id, phase_str(from), phase_str(to), ts as i64],
        )?;
        Ok(())
    }

    pub(crate) fn upsert_track(&self, flight_id: &str, count: usize, data: &[u8], preview: &[u8], now_ms: u64) -> Result<()> {
        self.conn().execute(
            "INSERT INTO tracks (flight_id, sample_count, encoding, data, preview, updated_ms)
             VALUES (?1, ?2, 'vstk1', ?3, ?4, ?5)
             ON CONFLICT(flight_id) DO UPDATE SET sample_count = excluded.sample_count, data = excluded.data,
                preview = excluded.preview, updated_ms = excluded.updated_ms",
            params![flight_id, count as i64, data, preview, now_ms as i64],
        )?;
        Ok(())
    }

    // ---- reads -----------------------------------------------------------------------

    pub fn list_flights(&self, limit: u32, offset: u32) -> Result<Vec<FlightRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {FLIGHT_COLS} FROM flights f ORDER BY COALESCE(off_block_ms, created_ms) DESC LIMIT ?1 OFFSET ?2"
        ))?;
        let rows = stmt.query_map(params![limit, offset], row_to_flight)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub(crate) fn list_flights_where(&self, cond: &str, arg: &str, limit: u32) -> Result<Vec<FlightRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {FLIGHT_COLS} FROM flights f WHERE {cond} ORDER BY COALESCE(off_block_ms, created_ms) DESC LIMIT ?2"
        ))?;
        let rows = stmt.query_map(params![arg, limit], row_to_flight)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn get_flight(&self, id: &str) -> Result<Option<FlightDetail>> {
        let conn = self.conn();
        let flight = conn
            .query_row(&format!("SELECT {FLIGHT_COLS} FROM flights f WHERE id = ?1"), params![id], row_to_flight)
            .optional()?;
        let Some(flight) = flight else { return Ok(None) };

        let mut stmt = conn.prepare(&format!(
            "SELECT timestamp_ms, vs_fpm_measured, vs_fpm_sim, vs_fpm_hardest, peak_g, pitch_deg, bank_deg,
                    ground_speed_kt, heading_true_deg, latitude, longitude, bounces, touch_and_go,
                    {LANDING_RATE_SQL}, {LANDING_SOURCE_SQL}
             FROM touchdowns WHERE flight_id = ?1 ORDER BY timestamp_ms"
        ))?;
        let touchdowns = stmt
            .query_map(params![id], |r| {
                Ok(TouchdownReport {
                    timestamp_ms: r.get::<_, i64>(0)? as u64,
                    vs_fpm_measured: r.get(1)?,
                    vs_fpm_sim: r.get(2)?,
                    vs_fpm_hardest: r.get(3)?,
                    peak_g: r.get(4)?,
                    pitch_deg: r.get(5)?,
                    bank_deg: r.get(6)?,
                    ground_speed_kt: r.get(7)?,
                    heading_true_deg: r.get(8)?,
                    latitude: r.get(9)?,
                    longitude: r.get(10)?,
                    bounces: r.get(11)?,
                    touch_and_go: r.get(12)?,
                    landing_rate_fpm: r.get(13)?,
                    landing_rate_source: LandingRateSource::parse(&r.get::<_, String>(14)?),
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        let mut stmt = conn.prepare(
            "SELECT from_phase, to_phase, timestamp_ms FROM phase_events WHERE flight_id = ?1 ORDER BY timestamp_ms, id",
        )?;
        let phases = stmt
            .query_map(params![id], |r| {
                Ok(PhaseEventRow {
                    from: phase_from_str(&r.get::<_, String>(0)?),
                    to: phase_from_str(&r.get::<_, String>(1)?),
                    timestamp_ms: r.get::<_, i64>(2)? as u64,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        let has_track: bool =
            conn.query_row("SELECT COUNT(*) FROM tracks WHERE flight_id = ?1", params![id], |r| r.get::<_, i64>(0))? > 0;
        let ofp_json: Option<String> =
            conn.query_row("SELECT ofp_json FROM flights WHERE id = ?1", params![id], |r| r.get(0))?;
        Ok(Some(FlightDetail { flight, touchdowns, phases, has_track, ofp_json }))
    }

    pub fn get_track(&self, id: &str) -> Result<Option<Vec<TrackSample>>> {
        self.track_blob(id, "data")
    }

    pub fn get_track_preview(&self, id: &str) -> Result<Option<Vec<TrackSample>>> {
        self.track_blob(id, "preview")
    }

    fn track_blob(&self, id: &str, column: &str) -> Result<Option<Vec<TrackSample>>> {
        let blob: Option<Vec<u8>> = self
            .conn()
            .query_row(&format!("SELECT {column} FROM tracks WHERE flight_id = ?1"), params![id], |r| r.get(0))
            .optional()?;
        blob.map(|b| decode_track(&b).map_err(StoreError::from)).transpose()
    }

    pub fn delete_flight(&self, id: &str) -> Result<bool> {
        Ok(self.conn().execute("DELETE FROM flights WHERE id = ?1", params![id])? > 0)
    }

    pub fn totals(&self) -> Result<Totals> {
        let conn = self.conn();
        let (flights, completed, block, flight, distance): (i64, i64, i64, i64, f64) = conn.query_row(
            "SELECT COUNT(*),
                    SUM(state = 'completed'),
                    COALESCE(SUM(CASE WHEN on_block_ms IS NOT NULL AND off_block_ms IS NOT NULL THEN on_block_ms - off_block_ms END), 0),
                    COALESCE(SUM(CASE WHEN landing_ms IS NOT NULL AND takeoff_ms IS NOT NULL THEN landing_ms - takeoff_ms END), 0),
                    COALESCE(SUM(distance_nm), 0)
             FROM flights",
            [],
            |r| Ok((r.get(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0), r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
        let (landings, avg): (i64, Option<f64>) = conn.query_row(
            &format!("SELECT COUNT(*), AVG({LANDING_RATE_SQL}) FROM touchdowns WHERE touch_and_go = 0"),
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(Totals {
            flights: flights as u64,
            completed: completed as u64,
            block_time_ms: block.max(0) as u64,
            flight_time_ms: flight.max(0) as u64,
            distance_nm: distance,
            landings: landings as u64,
            avg_landing_vs_fpm: avg,
        })
    }
}

const FLIGHT_COLS: &str = "f.id, f.state, f.phase, f.created_ms, f.updated_ms, f.off_block_ms, f.takeoff_ms, f.landing_ms,
    f.on_block_ms, f.dep_lat, f.dep_lon, f.arr_lat, f.arr_lon, f.max_alt_msl_ft, f.distance_nm, f.fuel_start_kg,
    f.fuel_end_kg, f.aircraft_title, f.atc_model, f.atc_type, f.atc_id, f.atc_airline, f.atc_flight_number,
    f.provider, f.sim_name, f.paused_ms, f.pause_count, f.slew_detected, f.time_accel_detected, f.max_sim_rate,
    f.crashed, f.fuel_increased_airborne, f.dep_icao, f.arr_icao,
    f.callsign, f.planned_dep, f.planned_arr, f.planned_block_s, f.planned_fuel_ramp_kg, f.planned_fuel_landing_kg,
    (f.ofp_json IS NOT NULL),
    (SELECT COALESCE(t.landing_rate_fpm, ROUND(CASE WHEN ABS(t.vs_fpm_sim) >= 1 THEN t.vs_fpm_sim ELSE t.vs_fpm_measured END))
       FROM touchdowns t WHERE t.flight_id = f.id AND t.touch_and_go = 0 ORDER BY t.timestamp_ms DESC LIMIT 1),
    (SELECT COUNT(*) FROM touchdowns t WHERE t.flight_id = f.id),
    f.dep_metar, f.dep_metar_ms, f.arr_metar, f.arr_metar_ms, f.airframe_reg";

fn row_to_flight(r: &Row<'_>) -> rusqlite::Result<FlightRow> {
    let opt_u64 = |i: usize| -> rusqlite::Result<Option<u64>> { Ok(r.get::<_, Option<i64>>(i)?.map(|v| v as u64)) };
    Ok(FlightRow {
        id: r.get(0)?,
        state: r.get(1)?,
        phase: phase_from_str(&r.get::<_, String>(2)?),
        created_ms: r.get::<_, i64>(3)? as u64,
        updated_ms: r.get::<_, i64>(4)? as u64,
        off_block_ms: opt_u64(5)?,
        takeoff_ms: opt_u64(6)?,
        landing_ms: opt_u64(7)?,
        on_block_ms: opt_u64(8)?,
        dep_lat: r.get(9)?,
        dep_lon: r.get(10)?,
        arr_lat: r.get(11)?,
        arr_lon: r.get(12)?,
        max_alt_msl_ft: r.get(13)?,
        distance_nm: r.get(14)?,
        fuel_start_kg: r.get(15)?,
        fuel_end_kg: r.get(16)?,
        aircraft: AircraftInfo {
            title: r.get::<_, Option<String>>(17)?.unwrap_or_default(),
            atc_model: r.get::<_, Option<String>>(18)?.unwrap_or_default(),
            atc_type: r.get::<_, Option<String>>(19)?.unwrap_or_default(),
            atc_id: r.get::<_, Option<String>>(20)?.unwrap_or_default(),
            atc_airline: r.get::<_, Option<String>>(21)?.unwrap_or_default(),
            atc_flight_number: r.get::<_, Option<String>>(22)?.unwrap_or_default(),
        },
        provider: r.get(23)?,
        sim_name: r.get(24)?,
        integrity: IntegrityFlags {
            paused_ms: r.get::<_, i64>(25)? as u64,
            pause_count: r.get(26)?,
            slew_detected: r.get(27)?,
            time_acceleration_detected: r.get(28)?,
            max_sim_rate: r.get(29)?,
            crashed: r.get(30)?,
            fuel_increased_airborne: r.get(31)?,
        },
        dep_icao: r.get(32)?,
        arr_icao: r.get(33)?,
        callsign: r.get(34)?,
        planned_dep: r.get(35)?,
        planned_arr: r.get(36)?,
        planned_block_s: opt_u64(37)?,
        planned_fuel_ramp_kg: r.get(38)?,
        planned_fuel_landing_kg: r.get(39)?,
        has_ofp: r.get(40)?,
        landing_vs_fpm: r.get(41)?,
        landing_count: r.get::<_, i64>(42)? as u32,
        dep_metar: r.get(43)?,
        dep_metar_ms: opt_u64(44)?,
        arr_metar: r.get(45)?,
        arr_metar_ms: opt_u64(46)?,
        airframe_reg: r.get(47)?,
    })
}

/// Phases are stored as their serde names so SQL stays readable.
pub(crate) fn phase_str(p: FlightPhase) -> String {
    serde_json::to_value(p).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_else(|| format!("{p:?}"))
}

pub(crate) fn phase_from_str(s: &str) -> FlightPhase {
    serde_json::from_value(serde_json::Value::String(s.to_owned())).unwrap_or_default()
}
