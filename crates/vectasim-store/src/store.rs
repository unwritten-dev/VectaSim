//! SQLite access: schema, migrations and the read/write API the app uses.
//! The connection lives behind a mutex so the recorder thread and Tauri
//! commands can share one `Store` clone.

use crate::track::{TrackSample, decode_track};
use crate::{Result, StoreError};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use vectasim_core::approach::{self, ApproachAnalysis, ApproachBand, ElevationSource, FafReason, GateKind, GoAroundSource, LateralBand, MarkerKind, Severity};
use vectasim_core::landing::{CriterionKind, RunwayEnd, RunwayFrame, RunwayGeometrySource, angle_diff_deg, blend_runway, opposite_ident};
use vectasim_core::{AircraftInfo, FlightPhase, FlightSummary, IntegrityFlags, LandingRateSource, TouchdownReport};

/// Newest schema this build writes. A file with a higher version is refused
/// ([`StoreError::NewerSchema`]) instead of being opened by an older app.
pub const SCHEMA_VERSION: i64 = 14;

/// Days a deleted flight stays in the Papierkorb before `purge_deleted` removes it.
pub const TRASH_RETENTION_DAYS: u32 = 30;

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

/// v7: cache of the per-landing analysis facts the dispersion view needs (runway match,
/// touchdown point). Filled lazily by the app; goes with its flight.
const MIGRATION_V7: &str = r#"
CREATE TABLE IF NOT EXISTS landing_facts (
    flight_id            TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
    touchdown_index      INTEGER NOT NULL,
    version              INTEGER NOT NULL,
    computed_ms          INTEGER NOT NULL,
    matched              INTEGER NOT NULL,
    airport_icao         TEXT,
    runway_ident         TEXT,
    touchdown_distance_m REAL,
    centerline_offset_m  REAL,
    in_touchdown_zone    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (flight_id, touchdown_index)
);
"#;

/// v8: cache of the approach assessment (`vectasim_core::approach`), one row per approach
/// of a flight (go-arounds included). Flat columns for the strip, the logbook filters and
/// the gate scatter; everything else in `detail_json`. A flight without any assessable
/// approach keeps one marker row (`approach_index` -1, outcome 'none') so it is not
/// recomputed on every read. Filled lazily / at flight end; goes with its flight.
const MIGRATION_V8: &str = r#"
CREATE TABLE IF NOT EXISTS approach_facts (
    flight_id         TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
    approach_index    INTEGER NOT NULL,
    version           INTEGER NOT NULL,
    computed_ms       INTEGER NOT NULL,
    outcome           TEXT NOT NULL,             -- landed | touch_and_go | go_around (| none: marker row)
    touchdown_index   INTEGER,                   -- joins landing_facts
    airport_icao      TEXT, runway_ident TEXT,
    ended_ms          INTEGER NOT NULL,
    established_nm    REAL, established_hat_ft REAL,
    stable_from_ft    REAL,                      -- NULL = never stable / not measurable
    vapp_kt REAL, vapp_source TEXT, gp_deg REAL, gp_source TEXT,
    g10_alt_dev_ft REAL, g10_ias_kt REAL, g10_energy_dev_ft REAL,
    gfaf_alt_dev_ft REAL, gfaf_ias_dev_kt REAL,
    g1000_alt_dev_ft REAL, g1000_ias_dev_kt REAL, g1000_lat_dev_m REAL, g1000_vs_fpm REAL, g1000_pass INTEGER,
    g500_alt_dev_ft REAL,  g500_ias_dev_kt REAL,  g500_lat_dev_m REAL,  g500_vs_fpm REAL,  g500_pass INTEGER,
    gp_rms_ft REAL, lat_rms_m REAL, ias_mad_kt REAL, vs_sd_fpm REAL,
    ga_lowest_hat_ft  REAL,
    detail_json       TEXT,
    PRIMARY KEY (flight_id, approach_index)
);
CREATE INDEX IF NOT EXISTS approach_facts_ended ON approach_facts(ended_ms DESC);
"#;

/// The position jumped during the flight (teleport / reload), see `IntegrityFlags`.
const MIGRATION_V9: &str = r#"
ALTER TABLE flights ADD COLUMN teleport_detected INTEGER NOT NULL DEFAULT 0;
"#;

/// v10: soft delete (Papierkorb). `deleted_ms` set = in the trash; every logbook read skips it.
const MIGRATION_V10: &str = r#"
ALTER TABLE flights ADD COLUMN deleted_ms INTEGER;
"#;

/// v12: runways the logbook knows besides OurAirports (`user_runways`): derived from the
/// own landings at fields without threshold coordinates (refined with every further
/// landing, `user_runway_landings` remembers which ones counted) or set by the pilot.
/// Not tied to a flight. Plus the geometry source of a cached landing fact.
const MIGRATION_V12: &str = r#"
CREATE TABLE IF NOT EXISTS user_runways (
    airport_icao     TEXT NOT NULL,
    ident            TEXT NOT NULL,
    lat_thr          REAL NOT NULL,
    lon_thr          REAL NOT NULL,
    lat_end          REAL NOT NULL,
    lon_end          REAL NOT NULL,
    width_m          REAL,
    elevation_ft     REAL,
    source           TEXT NOT NULL,              -- derived | user
    length_estimated INTEGER NOT NULL DEFAULT 0, -- 1: the far end is only a lower bound
    created_ms       INTEGER NOT NULL,
    updated_ms       INTEGER NOT NULL,
    uses             INTEGER NOT NULL DEFAULT 0, -- landings averaged into a derived runway
    PRIMARY KEY (airport_icao, ident)
);
CREATE INDEX IF NOT EXISTS user_runways_thr ON user_runways(lat_thr, lon_thr);
CREATE TABLE IF NOT EXISTS user_runway_landings (
    airport_icao    TEXT NOT NULL,
    ident           TEXT NOT NULL,
    flight_id       TEXT NOT NULL,
    touchdown_index INTEGER NOT NULL,
    added_ms        INTEGER NOT NULL,
    PRIMARY KEY (airport_icao, ident, flight_id, touchdown_index)
);
"#;

/// v13: time without recording inside a flight that was resumed or merged after a crash
/// (`IntegrityFlags::gap_ms`).
const MIGRATION_V13: &str = r#"
ALTER TABLE flights ADD COLUMN gap_ms INTEGER NOT NULL DEFAULT 0;
"#;

/// v14: what the pilot adds to a flight (Notizen & Tags): free-text notes, tags (JSON array),
/// a personal rating 1-5 and corrections that overlay the recorded values in the UI (the
/// recorded ones stay untouched). Each column only when missing, like v9-v13.
const MIGRATION_V14_COLUMNS: &[(&str, &str)] = &[
    ("notes", "TEXT"),
    ("tags", "TEXT"),
    ("user_callsign", "TEXT"),
    ("user_dep_icao", "TEXT"),
    ("user_arr_icao", "TEXT"),
    ("user_aircraft_title", "TEXT"),
    ("user_registration", "TEXT"),
    ("rating", "INTEGER"),
];

/// Version of the cached approach facts; bump whenever the rules in
/// `vectasim_core::approach` (or the row mapping below) change, so old rows are recomputed.
/// 2: displaced thresholds move the runway geometry (glidepath origin, distances).
/// 3: runways derived from the track / remembered in `user_runways` (fields without coordinates).
/// 4: lateral guidance (localizer RMS and lateral band in the detail).
pub const APPROACH_FACTS_VERSION: u32 = 4;

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
    /// File behind the connection (`None` for in-memory stores).
    path: Option<PathBuf>,
}

/// A flight in the Papierkorb with the time it was deleted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedFlight {
    pub flight: FlightRow,
    pub deleted_ms: u64,
}

/// [`Store::flight_counts`]: logbook size and when it last changed.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightCounts {
    /// Flights in the logbook (Papierkorb not counted).
    pub flights: u64,
    /// Flights in the Papierkorb.
    pub deleted: u64,
    pub last_updated_ms: Option<u64>,
    pub last_deleted_ms: Option<u64>,
}

/// One schema step: brings a file from `to - 1` to `to`.
struct MigrationStep {
    to: i64,
    apply: fn(&Connection) -> Result<()>,
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1"),
        params![column],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

const MIGRATIONS: &[MigrationStep] = &[
    MigrationStep { to: 1, apply: |c| Ok(c.execute_batch(SCHEMA_V1)?) },
    MigrationStep { to: 2, apply: |c| Ok(c.execute_batch(MIGRATION_V2)?) },
    MigrationStep { to: 3, apply: |c| Ok(c.execute_batch(MIGRATION_V3)?) },
    MigrationStep { to: 4, apply: |c| Ok(c.execute_batch(MIGRATION_V4)?) },
    MigrationStep { to: 5, apply: |c| Ok(c.execute_batch(MIGRATION_V5)?) },
    MigrationStep {
        to: 6,
        apply: |c| {
            c.execute_batch(crate::airframe::MIGRATION_V6)?;
            let booked = crate::airframe::backfill(c)?;
            log::info!("airframes: {booked} existing flights booked by registration");
            Ok(())
        },
    },
    MigrationStep { to: 7, apply: |c| Ok(c.execute_batch(MIGRATION_V7)?) },
    MigrationStep { to: 8, apply: |c| Ok(c.execute_batch(MIGRATION_V8)?) },
    MigrationStep {
        to: 9,
        // idempotent: a file rolled back to an older version number may already have the column
        apply: |c| {
            if !has_column(c, "flights", "teleport_detected")? {
                c.execute_batch(MIGRATION_V9)?;
            }
            Ok(())
        },
    },
    MigrationStep {
        to: 10,
        apply: |c| {
            if !has_column(c, "flights", "deleted_ms")? {
                c.execute_batch(MIGRATION_V10)?;
            }
            c.execute_batch("CREATE INDEX IF NOT EXISTS flights_deleted ON flights(deleted_ms)")?;
            Ok(())
        },
    },
    MigrationStep {
        to: 11,
        // idempotent like v9/v10
        apply: |c| {
            if !has_column(c, "airframes", "vapp_kt")? {
                c.execute_batch(crate::airframe::MIGRATION_V11)?;
            }
            Ok(())
        },
    },
    MigrationStep {
        to: 12,
        // idempotent like v9-v11 (tables IF NOT EXISTS, column only when missing)
        apply: |c| {
            c.execute_batch(MIGRATION_V12)?;
            if !has_column(c, "landing_facts", "runway_source")? {
                c.execute_batch("ALTER TABLE landing_facts ADD COLUMN runway_source TEXT")?;
            }
            Ok(())
        },
    },
    MigrationStep {
        to: 13,
        // idempotent like v9-v12
        apply: |c| {
            if !has_column(c, "flights", "gap_ms")? {
                c.execute_batch(MIGRATION_V13)?;
            }
            Ok(())
        },
    },
    MigrationStep {
        to: 14,
        // idempotent like v9-v13
        apply: |c| {
            for (col, ty) in MIGRATION_V14_COLUMNS {
                if !has_column(c, "flights", col)? {
                    c.execute_batch(&format!("ALTER TABLE flights ADD COLUMN {col} {ty}"))?;
                }
            }
            Ok(())
        },
    },
];

/// Schema version of an open file; 0 = empty (no `schema_version` table yet).
pub(crate) fn file_schema_version(conn: &Connection) -> Result<i64> {
    let has_table: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version')",
        [],
        |r| r.get(0),
    )?;
    if !has_table {
        return Ok(0);
    }
    Ok(conn.query_row("SELECT COALESCE(MAX(version), 0) FROM schema_version", [], |r| r.get(0))?)
}

/// `backup_dir` setting of a file (read before migrating; `settings` exists from v3 on).
fn configured_backup_dir(conn: &Connection) -> Option<PathBuf> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", params![crate::backup::SETTING_BACKUP_DIR], |r| r.get::<_, String>(0))
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
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
    /// The pilot's own notes (plain text, line breaks kept; at most [`NOTES_MAX_CHARS`]).
    #[serde(default)]
    pub notes: Option<String>,
    /// The pilot's tags, normalised (see [`normalize_tags`]).
    #[serde(default)]
    pub tags: Vec<String>,
    /// Corrections of the recorded values (`None` = not corrected). The UI shows these
    /// instead of the recorded ones; the recorded ones stay as they are.
    #[serde(default)]
    pub user_callsign: Option<String>,
    #[serde(default)]
    pub user_dep_icao: Option<String>,
    #[serde(default)]
    pub user_arr_icao: Option<String>,
    #[serde(default)]
    pub user_aircraft_title: Option<String>,
    #[serde(default)]
    pub user_registration: Option<String>,
    /// Personal rating of the flight 1-5 (not of the landing).
    #[serde(default)]
    pub rating: Option<u8>,
}

/// Longest note [`Store::update_flight_user`] accepts (characters).
pub const NOTES_MAX_CHARS: usize = 2000;
/// At most this many tags per flight ...
pub const TAGS_MAX: usize = 20;
/// ... of at most this many characters each.
pub const TAG_MAX_CHARS: usize = 30;

/// What the pilot changes on a flight ([`Store::update_flight_user`]). Every field:
/// `None` = unchanged; for text `Some("")` clears it, for `tags` `Some([])`, for `rating` `Some(0)`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightUserEdit {
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub callsign: Option<String>,
    #[serde(default)]
    pub dep_icao: Option<String>,
    #[serde(default)]
    pub arr_icao: Option<String>,
    #[serde(default)]
    pub aircraft_title: Option<String>,
    /// A corrected registration also re-books the flight onto that airframe; clearing it
    /// books the flight back onto the recorded registration.
    #[serde(default)]
    pub registration: Option<String>,
    #[serde(default)]
    pub rating: Option<u8>,
}

/// One tag of the logbook with the number of flights carrying it ([`Store::list_tags`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    pub count: u32,
}

/// Tags as stored: trimmed, inner whitespace collapsed, commas removed (they separate tags
/// in the input), cut to [`TAG_MAX_CHARS`], empty ones and case-insensitive duplicates
/// dropped (the first spelling wins), at most [`TAGS_MAX`].
pub fn normalize_tags<S: AsRef<str>>(tags: &[S]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let clean = t.as_ref().replace(',', " ").split_whitespace().collect::<Vec<_>>().join(" ");
        let clean: String = clean.chars().take(TAG_MAX_CHARS).collect::<String>().trim_end().to_string();
        if clean.is_empty() || out.iter().any(|o| o.to_lowercase() == clean.to_lowercase()) {
            continue;
        }
        out.push(clean);
        if out.len() == TAGS_MAX {
            break;
        }
    }
    out
}

fn tags_from_json(json: Option<String>) -> Vec<String> {
    json.and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok()).unwrap_or_default()
}

/// A corrected airport: 4 letters/digits, upper-case.
fn user_icao(raw: &str, what: &str) -> Result<String> {
    let v = raw.trim().to_ascii_uppercase();
    if v.len() != 4 || !v.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(StoreError::Invalid(format!("{what}: ICAO-Code muss aus 4 Buchstaben/Ziffern bestehen")));
    }
    Ok(v)
}

/// A corrected free-text value: trimmed, at most `max` characters.
fn user_text(raw: &str, max: usize, what: &str) -> Result<String> {
    let v = raw.trim().to_string();
    if v.chars().count() > max {
        return Err(StoreError::Invalid(format!("{what}: höchstens {max} Zeichen")));
    }
    Ok(v)
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

/// Cached analysis facts of one touchdown (table `landing_facts`). `version` is the
/// caller's analysis version: a row of another version is stale and recomputed.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandingFactCache {
    pub version: u32,
    /// False: no runway matched - the other fields are empty, the landing is skipped.
    pub matched: bool,
    pub airport_icao: Option<String>,
    pub runway_ident: Option<String>,
    /// Along the runway from the threshold, metres (negative = before it).
    pub touchdown_distance_m: Option<f64>,
    /// Signed metres from the centreline: positive = right, negative = left (landing direction).
    pub centerline_offset_m: Option<f64>,
    pub in_touchdown_zone: bool,
    /// `RunwayGeometrySource::as_str` of the matched runway (None: rows before v12 = database).
    #[serde(default)]
    pub runway_source: Option<String>,
}

/// Who a remembered runway comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UserRunwaySource {
    /// Derived from the own landings (automatically, refined with each further landing).
    Derived,
    /// Set or corrected by the pilot; never changed automatically.
    User,
}

impl UserRunwaySource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Derived => "derived",
            Self::User => "user",
        }
    }

    fn parse(s: &str) -> Self {
        if s == "user" { Self::User } else { Self::Derived }
    }
}

/// A runway of table `user_runways`: one landing direction `ident` with its threshold and
/// the far end along the axis (for `user` rows the far end is the opposite threshold).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRunway {
    pub airport_icao: String,
    pub ident: String,
    pub lat_thr: f64,
    pub lon_thr: f64,
    pub lat_end: f64,
    pub lon_end: f64,
    pub width_m: Option<f64>,
    pub elevation_ft: Option<f64>,
    pub source: UserRunwaySource,
    /// The far end is only a lower bound (derived without a declared length).
    pub length_estimated: bool,
    pub created_ms: u64,
    pub updated_ms: u64,
    /// Landings averaged into a derived runway (0 for one the pilot entered).
    pub uses: u32,
}

impl UserRunway {
    /// The stored landing direction as the analyses take it (length from the coordinates).
    pub fn runway_end(&self) -> RunwayEnd {
        RunwayEnd {
            airport: self.airport_icao.clone(),
            ident: self.ident.clone(),
            opposite_ident: opposite_ident(&self.ident),
            threshold_lat: self.lat_thr,
            threshold_lon: self.lon_thr,
            end_lat: self.lat_end,
            end_lon: self.lon_end,
            length_m: 0.0,
            width_m: self.width_m.unwrap_or(0.0),
            surface: String::new(),
            elevation_ft: self.elevation_ft,
        }
    }

    /// The opposite landing direction - only for a runway the pilot set (both ends are
    /// thresholds); a derived far end is no threshold.
    pub fn reverse_end(&self) -> Option<RunwayEnd> {
        (self.source == UserRunwaySource::User).then(|| {
            let e = self.runway_end();
            RunwayEnd {
                ident: e.opposite_ident.clone(),
                opposite_ident: e.ident.clone(),
                threshold_lat: e.end_lat,
                threshold_lon: e.end_lon,
                end_lat: e.threshold_lat,
                end_lon: e.threshold_lon,
                ..e
            }
        })
    }
}

/// A runway the pilot saves (`save_user_runway`): threshold and far end of landing
/// direction `ident`. `previous_ident` renames an existing row (corrected designator).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRunwayEdit {
    pub airport_icao: String,
    pub ident: String,
    pub lat_thr: f64,
    pub lon_thr: f64,
    pub lat_end: f64,
    pub lon_end: f64,
    #[serde(default)]
    pub width_m: Option<f64>,
    #[serde(default)]
    pub elevation_ft: Option<f64>,
    #[serde(default)]
    pub length_estimated: bool,
    #[serde(default)]
    pub previous_ident: Option<String>,
}

/// What [`Store::refine_derived_runway`] did with one landing's estimate.
#[derive(Clone, Debug, PartialEq)]
pub enum RunwayRefinement {
    /// First landing on it: stored as a new derived runway (uses 1).
    Inserted(UserRunway),
    /// Averaged into the stored derived runway (uses + 1).
    Refined(UserRunway),
    /// This landing was averaged in before (the analysis ran again): unchanged.
    AlreadyCounted(UserRunway),
    /// The stored runway was set by the pilot, or the estimate does not fit it: unchanged.
    Kept(UserRunway),
}

impl RunwayRefinement {
    pub fn runway(&self) -> &UserRunway {
        match self {
            Self::Inserted(r) | Self::Refined(r) | Self::AlreadyCounted(r) | Self::Kept(r) => r,
        }
    }
}

/// An estimate fits a stored derived runway within this heading ...
const REFINE_MAX_HEADING_DEG: f64 = 15.0;
/// ... and with its threshold this close to the stored axis (across) and threshold (along).
const REFINE_MAX_CROSS_M: f64 = 60.0;
const REFINE_MAX_ALONG_M: f64 = 600.0;

const USER_RUNWAY_COLS: &str =
    "airport_icao, ident, lat_thr, lon_thr, lat_end, lon_end, width_m, elevation_ft, source, length_estimated, created_ms, updated_ms, uses";

fn row_to_user_runway(r: &Row<'_>) -> rusqlite::Result<UserRunway> {
    Ok(UserRunway {
        airport_icao: r.get(0)?,
        ident: r.get(1)?,
        lat_thr: r.get(2)?,
        lon_thr: r.get(3)?,
        lat_end: r.get(4)?,
        lon_end: r.get(5)?,
        width_m: r.get(6)?,
        elevation_ft: r.get(7)?,
        source: UserRunwaySource::parse(&r.get::<_, String>(8)?),
        length_estimated: r.get(9)?,
        created_ms: r.get::<_, i64>(10)?.max(0) as u64,
        updated_ms: r.get::<_, i64>(11)?.max(0) as u64,
        uses: r.get::<_, i64>(12)?.max(0) as u32,
    })
}

fn get_user_runway(conn: &Connection, icao: &str, ident: &str) -> Result<Option<UserRunway>> {
    Ok(conn
        .query_row(
            &format!("SELECT {USER_RUNWAY_COLS} FROM user_runways WHERE airport_icao = ?1 AND ident = ?2"),
            params![icao, ident],
            row_to_user_runway,
        )
        .optional()?)
}

/// Upper-case, trimmed key part ("eddf " -> "EDDF", "09l" -> "09L").
fn runway_key(s: &str) -> String {
    s.trim().to_ascii_uppercase()
}

fn valid_key(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Plausible values: coordinates finite and on the globe, ends 100 m - 8 km apart, width
/// 1-200 m, elevation -1500 - 30000 ft.
fn validate_user_runway(e: &UserRunwayEdit) -> Result<()> {
    let bad = |m: &str| Err(StoreError::Invalid(m.to_string()));
    if !valid_key(&runway_key(&e.airport_icao), 8) {
        return bad("Flugplatz-Kennung ungültig");
    }
    if !valid_key(&runway_key(&e.ident), 4) {
        return bad("Pistenbezeichnung ungültig");
    }
    let lat_ok = |v: f64| v.is_finite() && (-90.0..=90.0).contains(&v);
    let lon_ok = |v: f64| v.is_finite() && (-180.0..=180.0).contains(&v);
    if !(lat_ok(e.lat_thr) && lat_ok(e.lat_end) && lon_ok(e.lon_thr) && lon_ok(e.lon_end)) {
        return bad("Koordinaten ungültig");
    }
    let len = RunwayFrame::new(&RunwayEnd { threshold_lat: e.lat_thr, threshold_lon: e.lon_thr, end_lat: e.lat_end, end_lon: e.lon_end, ..Default::default() })
        .length_m;
    if !(100.0..=8000.0).contains(&len) {
        return bad("Schwelle und Bahnende müssen 100 m bis 8 km auseinanderliegen");
    }
    if e.width_m.is_some_and(|w| !w.is_finite() || !(1.0..=200.0).contains(&w)) {
        return bad("Pistenbreite ungültig (1–200 m)");
    }
    if e.elevation_ft.is_some_and(|v| !v.is_finite() || !(-1500.0..=30000.0).contains(&v)) {
        return bad("Höhe ungültig");
    }
    Ok(())
}

/// A full-stop touchdown of a completed flight, newest first from [`Store::recent_landings`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentLanding {
    pub flight: FlightRow,
    /// Index within the flight's touchdowns ordered by time (as `get_flight` returns them).
    pub touchdown_index: u32,
    pub touchdown: TouchdownReport,
    pub cached: Option<LandingFactCache>,
}

/// Cached facts of one approach (table `approach_facts`). Units: ft (heights, deviations;
/// positive = above the reference path), kt (speeds; deviations IAS − Vapp), m (lateral;
/// positive = right of the centreline), fpm (V/S, negative = descending), nm
/// (`established_nm`). `None` = not measurable / gate not reached.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproachFactRow {
    pub approach_index: u32,
    pub version: u32,
    /// Set by the store when written.
    pub computed_ms: u64,
    /// landed | touch_and_go | go_around
    pub outcome: String,
    pub touchdown_index: Option<u32>,
    pub airport_icao: Option<String>,
    pub runway_ident: Option<String>,
    /// Touchdown / lowest point of the go-around, epoch ms.
    pub ended_ms: u64,
    pub established_nm: Option<f64>,
    pub established_hat_ft: Option<f64>,
    pub stable_from_ft: Option<f64>,
    pub vapp_kt: Option<f64>,
    /// user | flown | unavailable
    pub vapp_source: Option<String>,
    pub gp_deg: Option<f64>,
    /// assumed
    pub gp_source: Option<String>,
    pub g10_alt_dev_ft: Option<f64>,
    /// Absolute IAS at 10 nm.
    pub g10_ias_kt: Option<f64>,
    pub g10_energy_dev_ft: Option<f64>,
    pub gfaf_alt_dev_ft: Option<f64>,
    pub gfaf_ias_dev_kt: Option<f64>,
    pub g1000_alt_dev_ft: Option<f64>,
    pub g1000_ias_dev_kt: Option<f64>,
    pub g1000_lat_dev_m: Option<f64>,
    pub g1000_vs_fpm: Option<f64>,
    /// No criterion failed at the gate (unmeasurable ones do not count); None = not reached.
    pub g1000_pass: Option<bool>,
    pub g500_alt_dev_ft: Option<f64>,
    pub g500_ias_dev_kt: Option<f64>,
    pub g500_lat_dev_m: Option<f64>,
    pub g500_vs_fpm: Option<f64>,
    pub g500_pass: Option<bool>,
    pub gp_rms_ft: Option<f64>,
    pub lat_rms_m: Option<f64>,
    pub ias_mad_kt: Option<f64>,
    pub vs_sd_fpm: Option<f64>,
    pub ga_lowest_hat_ft: Option<f64>,
    /// JSON of [`ApproachFactDetail`].
    pub detail_json: Option<String>,
}

/// The rest of an approach's facts, stored as `approach_facts.detail_json`. Additive only:
/// new fields need `#[serde(default)]` so older rows still parse.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproachFactDetail {
    /// None: the approach never got below 1000 ft.
    pub band: Option<ApproachBand>,
    pub elevation_source: ElevationSource,
    /// Distinct criteria with an exceedance 1000 → 50 ft.
    pub exceeded: Vec<CriterionKind>,
    pub exceedances_below_500: u32,
    pub s2_count: u32,
    pub vapp_plausible: Option<bool>,
    pub faf_reason: Option<FafReason>,
    /// Height over the threshold, ft (landings with a runway).
    pub threshold_height_ft: Option<f64>,
    pub go_around_detected_by: Option<GoAroundSource>,
    /// Where the matched runway's geometry comes from (None: rows before v3 / no runway).
    #[serde(default)]
    pub runway_source: Option<RunwayGeometrySource>,
    /// Localizer RMS 1000 → 50 ft, dots; only with a known centreline (None: derived runway / before v4).
    #[serde(default)]
    pub loc_rms_dots: Option<f64>,
    #[serde(default)]
    pub lateral_band: Option<LateralBand>,
}

impl ApproachFactRow {
    /// Flat facts of one analysed approach (`version` = [`APPROACH_FACTS_VERSION`]).
    pub fn from_analysis(a: &ApproachAnalysis) -> Self {
        let name = |v: serde_json::Value| v.as_str().map(str::to_owned);
        let sample = |k: GateKind| approach::gate(a, k).and_then(|g| g.sample.as_ref());
        let pass = |k: GateKind| approach::gate(a, k).filter(|g| g.reached).map(|g| !approach::any_failed(&g.criteria));
        let mut exceeded = Vec::new();
        for e in &a.exceedances {
            if !exceeded.contains(&e.kind) {
                exceeded.push(e.kind);
            }
        }
        let detail = ApproachFactDetail {
            band: a.band,
            elevation_source: a.elevation_source,
            exceeded,
            exceedances_below_500: a.exceedances.iter().filter(|e| e.below_500).count() as u32,
            s2_count: a.exceedances.iter().filter(|e| e.level == Severity::S2).count() as u32,
            vapp_plausible: a.reference.vapp_plausible,
            faf_reason: approach::gate(a, GateKind::Faf).and_then(|g| g.faf_reason),
            threshold_height_ft: a.markers.iter().find(|m| m.kind == MarkerKind::Threshold).map(|m| m.hat_ft),
            go_around_detected_by: a.go_around.as_ref().map(|g| g.detected_by),
            runway_source: a.runway.as_ref().map(|r| r.geometry.source),
            loc_rms_dots: a.stability.loc_rms_dots.filter(|_| a.lateral.measurable),
            lateral_band: a.lateral.lateral_band,
        };
        Self {
            approach_index: a.index as u32,
            version: APPROACH_FACTS_VERSION,
            computed_ms: 0,
            outcome: a.outcome.as_str().to_string(),
            touchdown_index: a.outcome.touchdown_index().map(|i| i as u32),
            airport_icao: a.runway.as_ref().map(|r| r.airport.clone()),
            runway_ident: a.runway.as_ref().map(|r| r.ident.clone()),
            ended_ms: a.end_t_ms,
            established_nm: a.established.as_ref().map(|e| e.dist_nm),
            established_hat_ft: a.established.as_ref().map(|e| e.hat_ft),
            stable_from_ft: a.stability.stable_from_ft,
            vapp_kt: a.reference.vapp_kt,
            vapp_source: serde_json::to_value(a.reference.vapp_source).ok().and_then(name),
            gp_deg: Some(a.reference.glidepath_deg),
            gp_source: serde_json::to_value(a.reference.glidepath_source).ok().and_then(name),
            g10_alt_dev_ft: sample(GateKind::TenNm).and_then(|s| s.alt_dev_ft),
            g10_ias_kt: sample(GateKind::TenNm).map(|s| s.ias_kt),
            g10_energy_dev_ft: sample(GateKind::TenNm).and_then(|s| s.energy_dev_ft),
            gfaf_alt_dev_ft: sample(GateKind::Faf).and_then(|s| s.alt_dev_ft),
            gfaf_ias_dev_kt: sample(GateKind::Faf).and_then(|s| s.ias_dev_kt),
            g1000_alt_dev_ft: sample(GateKind::Ft1000).and_then(|s| s.alt_dev_ft),
            g1000_ias_dev_kt: sample(GateKind::Ft1000).and_then(|s| s.ias_dev_kt),
            g1000_lat_dev_m: sample(GateKind::Ft1000).and_then(|s| s.y_m),
            g1000_vs_fpm: sample(GateKind::Ft1000).map(|s| s.vs_fpm),
            g1000_pass: pass(GateKind::Ft1000),
            g500_alt_dev_ft: sample(GateKind::Ft500).and_then(|s| s.alt_dev_ft),
            g500_ias_dev_kt: sample(GateKind::Ft500).and_then(|s| s.ias_dev_kt),
            g500_lat_dev_m: sample(GateKind::Ft500).and_then(|s| s.y_m),
            g500_vs_fpm: sample(GateKind::Ft500).map(|s| s.vs_fpm),
            g500_pass: pass(GateKind::Ft500),
            gp_rms_ft: a.stability.gp_rms_ft,
            lat_rms_m: a.stability.lat_rms_m,
            ias_mad_kt: a.stability.ias_mad_kt,
            vs_sd_fpm: a.stability.vs_sd_fpm,
            ga_lowest_hat_ft: a.go_around.as_ref().map(|g| g.lowest_hat_ft),
            detail_json: serde_json::to_string(&detail).ok(),
        }
    }

    pub fn detail(&self) -> Option<ApproachFactDetail> {
        self.detail_json.as_deref().and_then(|j| serde_json::from_str(j).ok())
    }
}

/// A completed flight with its cached approach facts, newest first from
/// [`Store::recent_approach_facts`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentApproaches {
    pub flight: FlightRow,
    pub has_track: bool,
    /// Lowest version of the flight's rows (marker row included); None = never computed.
    /// Anything other than [`APPROACH_FACTS_VERSION`] is stale.
    pub cached_version: Option<u32>,
    /// Approaches in order (marker row excluded).
    pub facts: Vec<ApproachFactRow>,
}

const APPROACH_COLS: &str = "approach_index, version, computed_ms, outcome, touchdown_index, airport_icao, runway_ident, ended_ms,
    established_nm, established_hat_ft, stable_from_ft, vapp_kt, vapp_source, gp_deg, gp_source,
    g10_alt_dev_ft, g10_ias_kt, g10_energy_dev_ft, gfaf_alt_dev_ft, gfaf_ias_dev_kt,
    g1000_alt_dev_ft, g1000_ias_dev_kt, g1000_lat_dev_m, g1000_vs_fpm, g1000_pass,
    g500_alt_dev_ft, g500_ias_dev_kt, g500_lat_dev_m, g500_vs_fpm, g500_pass,
    gp_rms_ft, lat_rms_m, ias_mad_kt, vs_sd_fpm, ga_lowest_hat_ft, detail_json";

fn row_to_approach_fact(r: &Row<'_>) -> rusqlite::Result<ApproachFactRow> {
    Ok(ApproachFactRow {
        approach_index: r.get::<_, i64>(0)?.max(0) as u32,
        version: r.get::<_, i64>(1)? as u32,
        computed_ms: r.get::<_, i64>(2)? as u64,
        outcome: r.get(3)?,
        touchdown_index: r.get::<_, Option<i64>>(4)?.map(|v| v as u32),
        airport_icao: r.get(5)?,
        runway_ident: r.get(6)?,
        ended_ms: r.get::<_, i64>(7)? as u64,
        established_nm: r.get(8)?,
        established_hat_ft: r.get(9)?,
        stable_from_ft: r.get(10)?,
        vapp_kt: r.get(11)?,
        vapp_source: r.get(12)?,
        gp_deg: r.get(13)?,
        gp_source: r.get(14)?,
        g10_alt_dev_ft: r.get(15)?,
        g10_ias_kt: r.get(16)?,
        g10_energy_dev_ft: r.get(17)?,
        gfaf_alt_dev_ft: r.get(18)?,
        gfaf_ias_dev_kt: r.get(19)?,
        g1000_alt_dev_ft: r.get(20)?,
        g1000_ias_dev_kt: r.get(21)?,
        g1000_lat_dev_m: r.get(22)?,
        g1000_vs_fpm: r.get(23)?,
        g1000_pass: r.get(24)?,
        g500_alt_dev_ft: r.get(25)?,
        g500_ias_dev_kt: r.get(26)?,
        g500_lat_dev_m: r.get(27)?,
        g500_vs_fpm: r.get(28)?,
        g500_pass: r.get(29)?,
        gp_rms_ft: r.get(30)?,
        lat_rms_m: r.get(31)?,
        ias_mad_kt: r.get(32)?,
        vs_sd_fpm: r.get(33)?,
        ga_lowest_hat_ft: r.get(34)?,
        detail_json: r.get(35)?,
    })
}

fn approach_facts_of(conn: &Connection, flight_id: &str) -> Result<Vec<ApproachFactRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {APPROACH_COLS} FROM approach_facts WHERE flight_id = ?1 AND approach_index >= 0 ORDER BY approach_index"
    ))?;
    let rows = stmt.query_map(params![flight_id], row_to_approach_fact)?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// Static per-flight context the recorder knows but the summary does not.
#[derive(Clone, Debug, Default)]
pub struct FlightContext {
    pub provider: String,
    pub sim_name: Option<String>,
    pub aircraft: Option<AircraftInfo>,
}

impl Store {
    /// Open (and migrate) the logbook; pre-migration copies go to `<db folder>/backups`
    /// unless the file has its own `backup_dir` setting.
    pub fn open(path: &Path) -> Result<Self> {
        let fallback = path.parent().map(|d| d.join("backups")).unwrap_or_else(|| PathBuf::from("backups"));
        Self::open_with_backup_dir(path, &fallback)
    }

    /// Like [`Store::open`], with the folder for pre-migration copies when the file has no
    /// `backup_dir` setting. A restore staged by [`Store::restore_from`] is applied first.
    pub fn open_with_backup_dir(path: &Path, default_backup_dir: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        if crate::backup::apply_pending_restore(path)? {
            log::warn!("logbook replaced by a restored backup: {}", path.display());
        }
        let conn = Connection::open(path)?;
        Self::init(conn, Some(path.to_path_buf()), Some(default_backup_dir))
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?, None, None)
    }

    fn init(conn: Connection, path: Option<PathBuf>, default_backup_dir: Option<&Path>) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let backup_dir = default_backup_dir.map(|d| configured_backup_dir(&conn).unwrap_or_else(|| d.to_path_buf()));
        Self::migrate(&conn, backup_dir.as_deref())?;
        // A flight left 'active' means the app died mid-flight; keep it, but say so.
        let now = vectasim_core::now_ms() as i64;
        conn.execute(
            "UPDATE flights SET state = 'interrupted', updated_ms = ?1 WHERE state = 'active'",
            params![now],
        )?;
        Ok(Self { conn: Arc::new(Mutex::new(conn)), path })
    }

    /// Apply the schema steps newer than what the file has. Before the first step on an
    /// existing file a full copy goes to `backup_dir` (`vectasim-pre-v<old>-<stamp>.db`) –
    /// no copy, no migration. Each step runs in its own `BEGIN IMMEDIATE … COMMIT` together
    /// with its `schema_version` bump, so a failure (or crash) leaves the file at the last
    /// complete version, never half-applied. A file from a newer app is refused untouched.
    fn migrate(conn: &Connection, backup_dir: Option<&Path>) -> Result<()> {
        let found = file_schema_version(conn)?;
        if found > SCHEMA_VERSION {
            return Err(StoreError::NewerSchema { found, supported: SCHEMA_VERSION });
        }
        if found >= 1 {
            // tables of v1 that a very old or hand-made file may lack (all IF NOT EXISTS)
            conn.execute_batch(&format!("BEGIN IMMEDIATE; {SCHEMA_V1} COMMIT;")).inspect_err(|_| {
                let _ = conn.execute_batch("ROLLBACK");
            })?;
        }
        if found == SCHEMA_VERSION {
            log::info!("logbook schema version {found}");
            return Ok(());
        }
        let backup = match (found, backup_dir) {
            (1.., Some(dir)) => {
                let kind = crate::backup::BackupKind::PreMigration(found);
                let target = crate::backup::create_backup_from(conn, dir, kind, vectasim_core::now_ms())?;
                log::info!("logbook copy before migrating from v{found}: {}", target.display());
                Some(target)
            }
            _ => None,
        };
        for step in MIGRATIONS.iter().filter(|m| m.to > found) {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let applied = (step.apply)(conn)
                .and_then(|()| {
                    if step.to == 1 {
                        conn.execute("INSERT INTO schema_version(version) VALUES (1)", [])?;
                    } else {
                        conn.execute("UPDATE schema_version SET version = ?1", params![step.to])?;
                    }
                    Ok(())
                })
                .and_then(|()| Ok(conn.execute_batch("COMMIT")?));
            if let Err(e) = applied {
                let _ = conn.execute_batch("ROLLBACK");
                log::error!("logbook migration to v{} failed and was rolled back: {e}", step.to);
                return Err(StoreError::Migration { from: step.to - 1, to: step.to, message: e.to_string(), backup });
            }
            log::info!("logbook migrated to schema v{}", step.to);
        }
        Ok(())
    }

    /// The database file (`None` for an in-memory store).
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Close the database file before the app restarts (restore): the connection is swapped
    /// for an empty in-memory one, so the file is checkpointed and released while the process
    /// winds down. Writes after this go nowhere.
    pub fn close_for_restart(&self) -> Result<()> {
        let replacement = Connection::open_in_memory()?;
        let old = std::mem::replace(&mut *self.conn(), replacement);
        old.close().map_err(|(_, e)| StoreError::from(e))
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
                max_sim_rate = ?21, crashed = ?22, fuel_increased_airborne = ?23, teleport_detected = ?24,
                gap_ms = ?25
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
                i.teleport_detected,
                i.gap_ms as i64,
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

    /// Correct a stored touchdown once its outcome is known (a long-roll touch-and-go is
    /// reported, and inserted, before it lifts off again).
    pub(crate) fn set_touchdown_touch_and_go(&self, flight_id: &str, touchdown_ms: u64, v: bool) -> Result<()> {
        self.conn().execute(
            "UPDATE touchdowns SET touch_and_go = ?3 WHERE flight_id = ?1 AND timestamp_ms = ?2",
            params![flight_id, touchdown_ms as i64, v],
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
            "SELECT {FLIGHT_COLS} FROM flights f WHERE f.deleted_ms IS NULL
             ORDER BY COALESCE(off_block_ms, created_ms) DESC LIMIT ?1 OFFSET ?2"
        ))?;
        let rows = stmt.query_map(params![limit, offset], row_to_flight)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub(crate) fn list_flights_where(&self, cond: &str, arg: &str, limit: u32) -> Result<Vec<FlightRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {FLIGHT_COLS} FROM flights f WHERE f.deleted_ms IS NULL AND ({cond})
             ORDER BY COALESCE(off_block_ms, created_ms) DESC LIMIT ?2"
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

    /// The pilot's notes, tags, rating and corrections of a flight (see [`FlightUserEdit`]).
    /// Everything is checked before anything is written: an invalid value fails the whole
    /// edit with [`StoreError::Invalid`]. A corrected registration re-books the flight onto
    /// that airframe ([`Store::set_flight_airframe`]); clearing a correction books it back
    /// onto the recorded registration. Returns the updated row, `None` for an unknown id.
    pub fn update_flight_user(&self, id: &str, edit: &FlightUserEdit, now_ms: u64) -> Result<Option<FlightRow>> {
        use rusqlite::types::Value as Sql;
        let text_or_null = |v: String| if v.is_empty() { Sql::Null } else { Sql::Text(v) };
        let mut sets: Vec<(&str, Sql)> = Vec::new();
        if let Some(n) = &edit.notes {
            let n = n.replace("\r\n", "\n").replace('\r', "\n");
            let n = n.trim_end().trim_start_matches('\n').to_string();
            if n.chars().count() > NOTES_MAX_CHARS {
                return Err(StoreError::Invalid(format!("Notiz zu lang (höchstens {NOTES_MAX_CHARS} Zeichen)")));
            }
            sets.push(("notes", text_or_null(n)));
        }
        if let Some(t) = &edit.tags {
            let t = normalize_tags(t);
            sets.push(("tags", if t.is_empty() { Sql::Null } else { Sql::Text(serde_json::to_string(&t)?) }));
        }
        if let Some(c) = &edit.callsign {
            sets.push(("user_callsign", text_or_null(user_text(c, 16, "Rufzeichen")?)));
        }
        for (col, raw, what) in [("user_dep_icao", &edit.dep_icao, "Abflug"), ("user_arr_icao", &edit.arr_icao, "Ankunft")] {
            if let Some(v) = raw {
                let v = if v.trim().is_empty() { String::new() } else { user_icao(v, what)? };
                sets.push((col, text_or_null(v)));
            }
        }
        if let Some(t) = &edit.aircraft_title {
            sets.push(("user_aircraft_title", text_or_null(user_text(t, 120, "Flugzeugname")?)));
        }
        let mut new_reg: Option<String> = None;
        if let Some(r) = &edit.registration {
            let reg = if r.trim().is_empty() {
                String::new()
            } else {
                crate::airframe::normalize_registration(r).ok_or_else(|| StoreError::Invalid(format!("ungültige Registrierung: {r}")))?
            };
            sets.push(("user_registration", text_or_null(reg.clone())));
            new_reg = Some(reg);
        }
        if let Some(r) = edit.rating {
            if r > 5 {
                return Err(StoreError::Invalid("Bewertung muss 1 bis 5 Sterne sein".into()));
            }
            sets.push(("rating", if r == 0 { Sql::Null } else { Sql::Integer(i64::from(r)) }));
        }

        let previous_reg: Option<Option<String>> = self
            .conn()
            .query_row("SELECT user_registration FROM flights WHERE id = ?1", params![id], |r| r.get(0))
            .optional()?;
        let Some(previous_reg) = previous_reg else { return Ok(None) };
        if !sets.is_empty() {
            let assignments = sets.iter().enumerate().map(|(i, (c, _))| format!("{c} = ?{}", i + 3)).collect::<Vec<_>>().join(", ");
            let mut values: Vec<Sql> = vec![Sql::Text(id.to_string()), Sql::Integer(now_ms as i64)];
            values.extend(sets.into_iter().map(|(_, v)| v));
            self.conn().execute(
                &format!("UPDATE flights SET {assignments}, updated_ms = MAX(updated_ms, ?2) WHERE id = ?1"),
                rusqlite::params_from_iter(values),
            )?;
        }
        match new_reg {
            Some(reg) if !reg.is_empty() => {
                self.set_flight_airframe(id, Some(&reg), now_ms)?;
            }
            // cleared a correction: back onto the recorded registration (or none)
            Some(_) if previous_reg.is_some() => {
                let original = self.original_flight_registration(id)?;
                self.set_flight_airframe(id, original.as_deref(), now_ms)?;
            }
            _ => {}
        }
        Ok(self.get_flight(id)?.map(|d| d.flight))
    }

    /// Every tag of the logbook (Papierkorb not counted) with its number of flights, most
    /// used first, then alphabetically. Spellings that differ only in case count as one
    /// (the most frequent spelling is shown).
    pub fn list_tags(&self) -> Result<Vec<TagCount>> {
        let rows: Vec<String> = {
            let conn = self.conn();
            let mut stmt = conn.prepare("SELECT tags FROM flights WHERE deleted_ms IS NULL AND tags IS NOT NULL AND tags <> ''")?;
            stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<std::result::Result<_, _>>()?
        };
        // lower-case key -> (count, spelling -> count)
        let mut by_key: std::collections::BTreeMap<String, (u32, std::collections::BTreeMap<String, u32>)> = Default::default();
        for json in rows {
            for tag in normalize_tags(&tags_from_json(Some(json))) {
                let e = by_key.entry(tag.to_lowercase()).or_default();
                e.0 += 1;
                *e.1.entry(tag).or_default() += 1;
            }
        }
        let mut out: Vec<TagCount> = by_key
            .into_values()
            .map(|(count, spellings)| {
                let tag = spellings.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0))).map(|(s, _)| s).unwrap_or_default();
                TagCount { tag, count }
            })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.tag.to_lowercase().cmp(&b.tag.to_lowercase())));
        Ok(out)
    }

    /// Move a flight to the Papierkorb (soft delete, see [`Store::delete_flight_at`]).
    pub fn delete_flight(&self, id: &str) -> Result<bool> {
        self.delete_flight_at(id, vectasim_core::now_ms())
    }

    /// Move a flight to the Papierkorb at `now_ms`. It disappears from every logbook read
    /// (list, totals, fleet, landing/approach facts) but keeps all its rows until restored
    /// or purged. False if unknown or already deleted.
    pub fn delete_flight_at(&self, id: &str, now_ms: u64) -> Result<bool> {
        Ok(self
            .conn()
            .execute("UPDATE flights SET deleted_ms = ?2 WHERE id = ?1 AND deleted_ms IS NULL", params![id, now_ms as i64])?
            > 0)
    }

    /// Take a flight out of the Papierkorb. False if it is not in it.
    pub fn restore_flight(&self, id: &str) -> Result<bool> {
        Ok(self.conn().execute("UPDATE flights SET deleted_ms = NULL WHERE id = ?1 AND deleted_ms IS NOT NULL", params![id])? > 0)
    }

    /// Remove a flight for good, with its touchdowns, phases, track and cached facts.
    pub fn delete_flight_permanently(&self, id: &str) -> Result<bool> {
        Ok(self.conn().execute("DELETE FROM flights WHERE id = ?1", params![id])? > 0)
    }

    /// Flights in the Papierkorb, most recently deleted first.
    pub fn list_deleted_flights(&self) -> Result<Vec<DeletedFlight>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {FLIGHT_COLS}, f.deleted_ms FROM flights f WHERE f.deleted_ms IS NOT NULL ORDER BY f.deleted_ms DESC, f.created_ms DESC"
        ))?;
        let rows = stmt.query_map([], |r| {
            Ok(DeletedFlight { flight: row_to_flight(r)?, deleted_ms: r.get::<_, i64>(FLIGHT_COL_COUNT)?.max(0) as u64 })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn deleted_count(&self) -> Result<u64> {
        Ok(self.conn().query_row("SELECT COUNT(*) FROM flights WHERE deleted_ms IS NOT NULL", [], |r| r.get::<_, i64>(0))? as u64)
    }

    /// Cheap summary of the logbook (one aggregate query): lets the UI see whether the full
    /// list changed before loading it again, and page through it.
    pub fn flight_counts(&self) -> Result<FlightCounts> {
        Ok(self.conn().query_row(
            "SELECT COUNT(*) FILTER (WHERE deleted_ms IS NULL), COUNT(*) FILTER (WHERE deleted_ms IS NOT NULL),
                    MAX(updated_ms), MAX(deleted_ms)
             FROM flights",
            [],
            |r| {
                Ok(FlightCounts {
                    flights: r.get::<_, i64>(0)?.max(0) as u64,
                    deleted: r.get::<_, i64>(1)?.max(0) as u64,
                    last_updated_ms: r.get::<_, Option<i64>>(2)?.map(|v| v.max(0) as u64),
                    last_deleted_ms: r.get::<_, Option<i64>>(3)?.map(|v| v.max(0) as u64),
                })
            },
        )?)
    }

    /// Remove flights that have been in the Papierkorb for at least `older_than_days`
    /// (0 = empty it). Returns how many went.
    pub fn purge_deleted(&self, older_than_days: u32, now_ms: u64) -> Result<usize> {
        let cutoff = now_ms as i64 - i64::from(older_than_days) * 86_400_000;
        Ok(self.conn().execute("DELETE FROM flights WHERE deleted_ms IS NOT NULL AND deleted_ms <= ?1", params![cutoff])?)
    }

    /// „Alle Daten löschen“: every flight (trash included) and every airframe, in one
    /// transaction. Settings stay. Returns the number of flights removed.
    pub fn delete_all_data(&self) -> Result<usize> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let n = tx.execute("DELETE FROM flights", [])?;
        tx.execute("DELETE FROM airframes", [])?;
        // runways learnt from those flights (and the pilot's own) go too
        tx.execute("DELETE FROM user_runways", [])?;
        tx.execute("DELETE FROM user_runway_landings", [])?;
        tx.commit()?;
        Ok(n)
    }

    /// Demo flights (mock provider) and replayed raw dumps (replay provider) are session-only:
    /// the app purges them at startup and when the demo/replay ends. Airframes that only demo flights created go with them; ones the user
    /// edited (name, notes) or that still carry real flights stay. Returns the flight count.
    pub fn delete_demo_flights(&self) -> Result<usize> {
        let conn = self.conn();
        let regs: Vec<String> = conn
            .prepare("SELECT DISTINCT airframe_reg FROM flights WHERE provider IN ('mock', 'replay') AND airframe_reg IS NOT NULL")?
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        let n = conn.execute("DELETE FROM flights WHERE provider IN ('mock', 'replay')", [])?;
        for reg in regs {
            conn.execute(
                "DELETE FROM airframes WHERE registration = ?1 AND custom_name IS NULL AND notes IS NULL AND vapp_kt IS NULL
                   AND NOT EXISTS (SELECT 1 FROM flights WHERE airframe_reg = ?1)",
                params![reg],
            )?;
        }
        Ok(n)
    }

    /// Full-stop touchdowns (no touch-and-go) of completed flights, newest first, with their
    /// cached facts if any. Demo (mock) flights only with `include_demo`.
    pub fn recent_landings(&self, limit: u32, include_demo: bool) -> Result<Vec<RecentLanding>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "WITH td AS (
                SELECT t.*, (SELECT COUNT(*) FROM touchdowns t2 WHERE t2.flight_id = t.flight_id
                    AND (t2.timestamp_ms < t.timestamp_ms OR (t2.timestamp_ms = t.timestamp_ms AND t2.id < t.id))) AS idx
                FROM touchdowns t)
             SELECT {FLIGHT_COLS},
                    td.timestamp_ms, td.vs_fpm_measured, td.vs_fpm_sim, td.vs_fpm_hardest, td.peak_g, td.pitch_deg,
                    td.bank_deg, td.ground_speed_kt, td.heading_true_deg, td.latitude, td.longitude, td.bounces,
                    td.touch_and_go,
                    COALESCE(td.landing_rate_fpm, ROUND(CASE WHEN ABS(td.vs_fpm_sim) >= 1 THEN td.vs_fpm_sim ELSE td.vs_fpm_measured END)),
                    COALESCE(td.landing_rate_source, CASE WHEN ABS(td.vs_fpm_sim) >= 1 THEN 'sim' ELSE 'measured' END),
                    td.idx, lf.version, lf.matched, lf.airport_icao, lf.runway_ident, lf.touchdown_distance_m,
                    lf.centerline_offset_m, lf.in_touchdown_zone, lf.runway_source
             FROM td
             JOIN flights f ON f.id = td.flight_id
             LEFT JOIN landing_facts lf ON lf.flight_id = td.flight_id AND lf.touchdown_index = td.idx
             WHERE f.state = 'completed' AND f.deleted_ms IS NULL AND td.touch_and_go = 0
               AND (?2 OR COALESCE(f.provider, '') <> 'mock')
             ORDER BY td.timestamp_ms DESC, td.id DESC
             LIMIT ?1"
        ))?;
        const T: usize = FLIGHT_COL_COUNT; // first column after FLIGHT_COLS
        let rows = stmt.query_map(params![limit, include_demo], |r| {
            let touchdown = TouchdownReport {
                timestamp_ms: r.get::<_, i64>(T)? as u64,
                vs_fpm_measured: r.get(T + 1)?,
                vs_fpm_sim: r.get(T + 2)?,
                vs_fpm_hardest: r.get(T + 3)?,
                peak_g: r.get(T + 4)?,
                pitch_deg: r.get(T + 5)?,
                bank_deg: r.get(T + 6)?,
                ground_speed_kt: r.get(T + 7)?,
                heading_true_deg: r.get(T + 8)?,
                latitude: r.get(T + 9)?,
                longitude: r.get(T + 10)?,
                bounces: r.get(T + 11)?,
                touch_and_go: r.get(T + 12)?,
                landing_rate_fpm: r.get(T + 13)?,
                landing_rate_source: LandingRateSource::parse(&r.get::<_, String>(T + 14)?),
            };
            let cached = match r.get::<_, Option<i64>>(T + 16)? {
                Some(version) => Some(LandingFactCache {
                    version: version as u32,
                    matched: r.get(T + 17)?,
                    airport_icao: r.get(T + 18)?,
                    runway_ident: r.get(T + 19)?,
                    touchdown_distance_m: r.get(T + 20)?,
                    centerline_offset_m: r.get(T + 21)?,
                    in_touchdown_zone: r.get(T + 22)?,
                    runway_source: r.get(T + 23)?,
                }),
                None => None,
            };
            Ok(RecentLanding { flight: row_to_flight(r)?, touchdown_index: r.get::<_, i64>(T + 15)? as u32, touchdown, cached })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Store (or replace) the cached facts of one touchdown. False if the flight does not exist.
    pub fn put_landing_fact(&self, flight_id: &str, touchdown_index: u32, fact: &LandingFactCache) -> Result<bool> {
        let n = self.conn().execute(
            "INSERT INTO landing_facts (flight_id, touchdown_index, version, computed_ms, matched, airport_icao,
                runway_ident, touchdown_distance_m, centerline_offset_m, in_touchdown_zone, runway_source)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 WHERE EXISTS (SELECT 1 FROM flights WHERE id = ?1)
             ON CONFLICT(flight_id, touchdown_index) DO UPDATE SET version = excluded.version,
                computed_ms = excluded.computed_ms, matched = excluded.matched, airport_icao = excluded.airport_icao,
                runway_ident = excluded.runway_ident, touchdown_distance_m = excluded.touchdown_distance_m,
                centerline_offset_m = excluded.centerline_offset_m, in_touchdown_zone = excluded.in_touchdown_zone,
                runway_source = excluded.runway_source",
            params![
                flight_id,
                touchdown_index,
                fact.version,
                vectasim_core::now_ms() as i64,
                fact.matched,
                fact.airport_icao,
                fact.runway_ident,
                fact.touchdown_distance_m,
                fact.centerline_offset_m,
                fact.in_touchdown_zone,
                fact.runway_source,
            ],
        )?;
        Ok(n > 0)
    }

    // ---- remembered runways (user_runways) -------------------------------------------

    /// Save a runway the pilot set or corrected (`source` user: never changed by later
    /// landings), or store one as `derived`. Insert or replace by (airport, ident); a
    /// `previous_ident` other than `ident` renames that row (its landing count goes along).
    pub fn upsert_user_runway(&self, edit: &UserRunwayEdit, source: UserRunwaySource) -> Result<UserRunway> {
        validate_user_runway(edit)?;
        let (icao, ident) = (runway_key(&edit.airport_icao), runway_key(&edit.ident));
        let now = crate::now_ms_i64();
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut uses = 0i64;
        let mut created = now;
        if let Some(prev) = edit.previous_ident.as_deref().map(runway_key).filter(|p| *p != ident) {
            if let Some(old) = get_user_runway(&tx, &icao, &prev)? {
                uses = old.uses as i64;
                created = old.created_ms as i64;
            }
            tx.execute("DELETE FROM user_runways WHERE airport_icao = ?1 AND ident = ?2", params![icao, prev])?;
            tx.execute(
                "UPDATE OR IGNORE user_runway_landings SET ident = ?3 WHERE airport_icao = ?1 AND ident = ?2",
                params![icao, prev, ident],
            )?;
            tx.execute("DELETE FROM user_runway_landings WHERE airport_icao = ?1 AND ident = ?2", params![icao, prev])?;
        }
        tx.execute(
            "INSERT INTO user_runways (airport_icao, ident, lat_thr, lon_thr, lat_end, lon_end, width_m, elevation_ft, source,
                length_estimated, created_ms, updated_ms, uses)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(airport_icao, ident) DO UPDATE SET lat_thr = excluded.lat_thr, lon_thr = excluded.lon_thr,
                lat_end = excluded.lat_end, lon_end = excluded.lon_end, width_m = excluded.width_m,
                elevation_ft = excluded.elevation_ft, source = excluded.source, length_estimated = excluded.length_estimated,
                updated_ms = excluded.updated_ms, uses = MAX(user_runways.uses, excluded.uses)",
            params![
                icao,
                ident,
                edit.lat_thr,
                edit.lon_thr,
                edit.lat_end,
                edit.lon_end,
                edit.width_m,
                edit.elevation_ft,
                source.as_str(),
                edit.length_estimated,
                created,
                now,
                uses
            ],
        )?;
        let row = get_user_runway(&tx, &icao, &ident)?.ok_or_else(|| StoreError::Invalid("Piste nicht gespeichert".into()))?;
        tx.commit()?;
        Ok(row)
    }

    /// Remembered runways of one airport, by designator.
    pub fn list_user_runways(&self, airport_icao: &str) -> Result<Vec<UserRunway>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!("SELECT {USER_RUNWAY_COLS} FROM user_runways WHERE airport_icao = ?1 ORDER BY ident"))?;
        let rows = stmt.query_map(params![runway_key(airport_icao)], row_to_user_runway)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Remembered runways whose threshold lies within ±`dlat`/±`dlon` degrees of a point.
    pub fn user_runways_near(&self, lat: f64, lon: f64, dlat: f64, dlon: f64) -> Result<Vec<UserRunway>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {USER_RUNWAY_COLS} FROM user_runways WHERE lat_thr BETWEEN ?1 AND ?2 AND lon_thr BETWEEN ?3 AND ?4
             ORDER BY airport_icao, ident"
        ))?;
        let rows = stmt.query_map(params![lat - dlat, lat + dlat, lon - dlon, lon + dlon], row_to_user_runway)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Forget a remembered runway (and which landings it was averaged from, so the next
    /// landing there derives it afresh). False if there was none.
    pub fn delete_user_runway(&self, airport_icao: &str, ident: &str) -> Result<bool> {
        let (icao, ident) = (runway_key(airport_icao), runway_key(ident));
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let n = tx.execute("DELETE FROM user_runways WHERE airport_icao = ?1 AND ident = ?2", params![icao, ident])?;
        tx.execute("DELETE FROM user_runway_landings WHERE airport_icao = ?1 AND ident = ?2", params![icao, ident])?;
        tx.commit()?;
        Ok(n > 0)
    }

    /// After the runways known at an airport changed: drop the cached landing facts that
    /// matched nothing or matched at `airport_icao`, and mark the approach facts of flights
    /// with such an approach stale, so both are recomputed lazily with the new geometry.
    pub fn invalidate_runway_facts(&self, airport_icao: Option<&str>) -> Result<()> {
        let icao = airport_icao.map(runway_key);
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM landing_facts WHERE matched = 0 OR (?1 IS NOT NULL AND airport_icao = ?1)", params![icao])?;
        tx.execute(
            "UPDATE approach_facts SET version = 0 WHERE flight_id IN (
                SELECT flight_id FROM approach_facts WHERE airport_icao IS NULL OR (?1 IS NOT NULL AND airport_icao = ?1))",
            params![icao],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Remember the runway one landing was derived on (`observed`: its airport, ident and
    /// geometry, see `vectasim_core::landing::derive_runway_from_track`). The first landing
    /// stores it as `derived`; every further landing (counted once per flight/touchdown)
    /// moves it to the weighted mean (`blend_runway`, weight = landings so far). A runway the
    /// pilot set, or an estimate that does not fit the stored one (heading > 15°, threshold
    /// > 60 m off the axis or > 600 m along it), is left alone.
    pub fn refine_derived_runway(&self, observed: &RunwayEnd, length_estimated: bool, flight_id: &str, touchdown_index: u32) -> Result<RunwayRefinement> {
        let (icao, ident) = (runway_key(&observed.airport), runway_key(&observed.ident));
        let now = crate::now_ms_i64();
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let existing = get_user_runway(&tx, &icao, &ident)?;
        let counted: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM user_runway_landings
                WHERE airport_icao = ?1 AND ident = ?2 AND flight_id = ?3 AND touchdown_index = ?4)",
            params![icao, ident, flight_id, touchdown_index],
            |r| r.get(0),
        )?;
        let record = |tx: &rusqlite::Transaction<'_>| -> Result<()> {
            tx.execute(
                "INSERT OR IGNORE INTO user_runway_landings (airport_icao, ident, flight_id, touchdown_index, added_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![icao, ident, flight_id, touchdown_index, now],
            )?;
            Ok(())
        };
        let write = |tx: &rusqlite::Transaction<'_>, e: &RunwayEnd, length_estimated: bool, uses: u32| -> Result<()> {
            tx.execute(
                "INSERT INTO user_runways (airport_icao, ident, lat_thr, lon_thr, lat_end, lon_end, width_m, elevation_ft, source,
                    length_estimated, created_ms, updated_ms, uses)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'derived', ?9, ?10, ?10, ?11)
                 ON CONFLICT(airport_icao, ident) DO UPDATE SET lat_thr = excluded.lat_thr, lon_thr = excluded.lon_thr,
                    lat_end = excluded.lat_end, lon_end = excluded.lon_end, width_m = excluded.width_m,
                    elevation_ft = excluded.elevation_ft, length_estimated = excluded.length_estimated,
                    updated_ms = excluded.updated_ms, uses = excluded.uses",
                params![
                    icao,
                    ident,
                    e.threshold_lat,
                    e.threshold_lon,
                    e.end_lat,
                    e.end_lon,
                    (e.width_m > 0.0).then_some(e.width_m),
                    e.elevation_ft,
                    length_estimated,
                    now,
                    uses
                ],
            )?;
            Ok(())
        };
        let outcome = match existing {
            Some(r) if counted => RunwayRefinement::AlreadyCounted(r),
            Some(r) if r.source == UserRunwaySource::User => RunwayRefinement::Kept(r),
            Some(r) => {
                let old = r.runway_end();
                let f = RunwayFrame::new(&old);
                let (x, y) = f.project(observed.threshold_lat, observed.threshold_lon);
                let fits = angle_diff_deg(f.heading_deg, RunwayFrame::new(observed).heading_deg) <= REFINE_MAX_HEADING_DEG
                    && y.abs() <= REFINE_MAX_CROSS_M
                    && x.abs() <= REFINE_MAX_ALONG_M;
                if fits {
                    let blended = blend_runway(&old, r.uses.max(1) as f64, observed);
                    write(&tx, &blended, r.length_estimated && length_estimated, r.uses.max(1) + 1)?;
                    record(&tx)?;
                    RunwayRefinement::Refined(get_user_runway(&tx, &icao, &ident)?.unwrap_or(r))
                } else {
                    RunwayRefinement::Kept(r)
                }
            }
            None => {
                validate_user_runway(&UserRunwayEdit {
                    airport_icao: icao.clone(),
                    ident: ident.clone(),
                    lat_thr: observed.threshold_lat,
                    lon_thr: observed.threshold_lon,
                    lat_end: observed.end_lat,
                    lon_end: observed.end_lon,
                    width_m: (observed.width_m > 0.0).then_some(observed.width_m),
                    elevation_ft: observed.elevation_ft,
                    ..Default::default()
                })?;
                write(&tx, observed, length_estimated, 1)?;
                record(&tx)?;
                let row = get_user_runway(&tx, &icao, &ident)?.ok_or_else(|| StoreError::Invalid("Piste nicht gespeichert".into()))?;
                RunwayRefinement::Inserted(row)
            }
        };
        tx.commit()?;
        Ok(outcome)
    }

    /// Replace all cached approach facts of a flight (one transaction). An empty `rows`
    /// stores the marker row "computed, nothing to assess" with `version`. False if the
    /// flight does not exist.
    pub fn put_approach_facts(&self, flight_id: &str, version: u32, rows: &[ApproachFactRow]) -> Result<bool> {
        use rusqlite::types::Value;
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let exists: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM flights WHERE id = ?1)", params![flight_id], |r| r.get(0))?;
        if !exists {
            return Ok(false);
        }
        tx.execute("DELETE FROM approach_facts WHERE flight_id = ?1", params![flight_id])?;
        let now = vectasim_core::now_ms() as i64;
        if rows.is_empty() {
            tx.execute(
                "INSERT INTO approach_facts (flight_id, approach_index, version, computed_ms, outcome, ended_ms)
                 VALUES (?1, -1, ?2, ?3, 'none', 0)",
                params![flight_id, version, now],
            )?;
        }
        {
            let placeholders = (2..=37).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
            let mut stmt = tx.prepare(&format!("INSERT INTO approach_facts (flight_id, {APPROACH_COLS}) VALUES (?1, {placeholders})"))?;
            for f in rows {
                let values: Vec<Value> = vec![
                    flight_id.to_string().into(),
                    (f.approach_index as i64).into(),
                    (f.version as i64).into(),
                    now.into(),
                    f.outcome.clone().into(),
                    f.touchdown_index.map(|v| v as i64).into(),
                    f.airport_icao.clone().into(),
                    f.runway_ident.clone().into(),
                    (f.ended_ms as i64).into(),
                    f.established_nm.into(),
                    f.established_hat_ft.into(),
                    f.stable_from_ft.into(),
                    f.vapp_kt.into(),
                    f.vapp_source.clone().into(),
                    f.gp_deg.into(),
                    f.gp_source.clone().into(),
                    f.g10_alt_dev_ft.into(),
                    f.g10_ias_kt.into(),
                    f.g10_energy_dev_ft.into(),
                    f.gfaf_alt_dev_ft.into(),
                    f.gfaf_ias_dev_kt.into(),
                    f.g1000_alt_dev_ft.into(),
                    f.g1000_ias_dev_kt.into(),
                    f.g1000_lat_dev_m.into(),
                    f.g1000_vs_fpm.into(),
                    f.g1000_pass.into(),
                    f.g500_alt_dev_ft.into(),
                    f.g500_ias_dev_kt.into(),
                    f.g500_lat_dev_m.into(),
                    f.g500_vs_fpm.into(),
                    f.g500_pass.into(),
                    f.gp_rms_ft.into(),
                    f.lat_rms_m.into(),
                    f.ias_mad_kt.into(),
                    f.vs_sd_fpm.into(),
                    f.ga_lowest_hat_ft.into(),
                    f.detail_json.clone().into(),
                ];
                stmt.execute(rusqlite::params_from_iter(values))?;
            }
        }
        tx.commit()?;
        Ok(true)
    }

    /// Cached approach facts of one flight, in order (empty when none or not computed yet).
    pub fn approach_facts_for_flight(&self, flight_id: &str) -> Result<Vec<ApproachFactRow>> {
        approach_facts_of(&self.conn(), flight_id)
    }

    /// Completed flights, newest first (by on-block/landing time), with their cached approach
    /// facts and the cache version. Demo (mock) flights only with `include_demo`.
    pub fn recent_approach_facts(&self, limit: u32, include_demo: bool) -> Result<Vec<RecentApproaches>> {
        let conn = self.conn();
        let rows = {
            let mut stmt = conn.prepare(&format!(
                "SELECT {FLIGHT_COLS},
                        EXISTS (SELECT 1 FROM tracks t WHERE t.flight_id = f.id),
                        (SELECT MIN(a.version) FROM approach_facts a WHERE a.flight_id = f.id)
                 FROM flights f
                 WHERE f.state = 'completed' AND f.deleted_ms IS NULL AND (?2 OR COALESCE(f.provider, '') <> 'mock')
                 ORDER BY COALESCE(f.on_block_ms, f.landing_ms, f.off_block_ms, f.created_ms) DESC, f.created_ms DESC
                 LIMIT ?1"
            ))?;
            const T: usize = FLIGHT_COL_COUNT; // first column after FLIGHT_COLS
            stmt.query_map(params![limit, include_demo], |r| {
                Ok((row_to_flight(r)?, r.get::<_, bool>(T)?, r.get::<_, Option<i64>>(T + 1)?.map(|v| v as u32)))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
        };
        rows.into_iter()
            .map(|(flight, has_track, cached_version)| {
                let facts = if cached_version.is_some() { approach_facts_of(&conn, &flight.id)? } else { Vec::new() };
                Ok(RecentApproaches { flight, has_track, cached_version, facts })
            })
            .collect()
    }


    pub fn totals(&self) -> Result<Totals> {
        let conn = self.conn();
        let (flights, completed, block, flight, distance): (i64, i64, i64, i64, f64) = conn.query_row(
            "SELECT COUNT(*),
                    SUM(state = 'completed'),
                    COALESCE(SUM(CASE WHEN on_block_ms IS NOT NULL AND off_block_ms IS NOT NULL THEN on_block_ms - off_block_ms END), 0),
                    COALESCE(SUM(CASE WHEN landing_ms IS NOT NULL AND takeoff_ms IS NOT NULL THEN landing_ms - takeoff_ms END), 0),
                    COALESCE(SUM(distance_nm), 0)
             FROM flights WHERE deleted_ms IS NULL",
            [],
            |r| Ok((r.get(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0), r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
        let (landings, avg): (i64, Option<f64>) = conn.query_row(
            &format!(
                "SELECT COUNT(*), AVG({LANDING_RATE_SQL}) FROM touchdowns
                 WHERE touch_and_go = 0 AND flight_id IN (SELECT id FROM flights WHERE deleted_ms IS NULL)"
            ),
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

/// Number of columns in [`FLIGHT_COLS`] (queries append their own after it).
pub(crate) const FLIGHT_COL_COUNT: usize = 58;

pub(crate) const FLIGHT_COLS: &str = "f.id, f.state, f.phase, f.created_ms, f.updated_ms, f.off_block_ms, f.takeoff_ms, f.landing_ms,
    f.on_block_ms, f.dep_lat, f.dep_lon, f.arr_lat, f.arr_lon, f.max_alt_msl_ft, f.distance_nm, f.fuel_start_kg,
    f.fuel_end_kg, f.aircraft_title, f.atc_model, f.atc_type, f.atc_id, f.atc_airline, f.atc_flight_number,
    f.provider, f.sim_name, f.paused_ms, f.pause_count, f.slew_detected, f.time_accel_detected, f.max_sim_rate,
    f.crashed, f.fuel_increased_airborne, f.dep_icao, f.arr_icao,
    f.callsign, f.planned_dep, f.planned_arr, f.planned_block_s, f.planned_fuel_ramp_kg, f.planned_fuel_landing_kg,
    (f.ofp_json IS NOT NULL),
    (SELECT COALESCE(t.landing_rate_fpm, ROUND(CASE WHEN ABS(t.vs_fpm_sim) >= 1 THEN t.vs_fpm_sim ELSE t.vs_fpm_measured END))
       FROM touchdowns t WHERE t.flight_id = f.id AND t.touch_and_go = 0 ORDER BY t.timestamp_ms DESC LIMIT 1),
    (SELECT COUNT(*) FROM touchdowns t WHERE t.flight_id = f.id),
    f.dep_metar, f.dep_metar_ms, f.arr_metar, f.arr_metar_ms, f.airframe_reg, f.teleport_detected, f.gap_ms,
    f.notes, f.tags, f.user_callsign, f.user_dep_icao, f.user_arr_icao, f.user_aircraft_title, f.user_registration, f.rating";

pub(crate) fn row_to_flight(r: &Row<'_>) -> rusqlite::Result<FlightRow> {
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
            teleport_detected: r.get(48)?,
            gap_ms: r.get::<_, i64>(49)?.max(0) as u64,
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
        notes: r.get(50)?,
        tags: tags_from_json(r.get(51)?),
        user_callsign: r.get(52)?,
        user_dep_icao: r.get(53)?,
        user_arr_icao: r.get(54)?,
        user_aircraft_title: r.get(55)?,
        user_registration: r.get(56)?,
        rating: r.get::<_, Option<i64>>(57)?.filter(|v| (1..=5).contains(v)).map(|v| v as u8),
    })
}

/// Phases are stored as their serde names so SQL stays readable.
pub(crate) fn phase_str(p: FlightPhase) -> String {
    serde_json::to_value(p).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_else(|| format!("{p:?}"))
}

pub(crate) fn phase_from_str(s: &str) -> FlightPhase {
    serde_json::from_value(serde_json::Value::String(s.to_owned())).unwrap_or_default()
}
