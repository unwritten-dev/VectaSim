//! Local-first persistence for VectaSim.
//!
//! One SQLite file (WAL mode) holds flights, touchdowns, phase events and the
//! flown track. The track is stored as a zstd-compressed, delta-encoded
//! columnar blob (see `track`), plus a sparse preview for fast map thumbnails.
//! `FlightRecorder` turns the live `FlightSession` stream into rows and flushes
//! the track every 15 s so a crash loses at most 15 s of path; `merge` resumes or joins
//! a flight a crash cut in two.

/// `ltr!(lang, "Flug {id} …", "Flight {id} …", args…)` – `format!` in the given language
/// (import warnings and other texts that reach the user; the store has no global language).
macro_rules! ltr {
    ($lang:expr, $de:literal, $en:literal $(, $a:expr)* $(,)?) => {
        match $lang {
            vectasim_core::Lang::De => format!($de $(, $a)*),
            vectasim_core::Lang::En => format!($en $(, $a)*),
        }
    };
}

pub mod airframe;
pub mod backup;
pub mod bundle;
pub mod csvimport;
pub mod error;
pub mod export;
pub mod merge;
pub mod metrics;
pub mod recorder;
pub mod store;
pub mod track;

pub use backup::{BackupEntry, BackupKind, RestoreCheck};
pub use bundle::{BundleManifest, ExportOptions, ExportReport, ImportMode, ImportOptions, ImportReport, is_planespotters_link};
pub use airframe::{
    Airframe, AirframeEdit, AirframePhoto, AirframeRow, VAPP_MAX_KT, VAPP_MIN_KT, icao_from_atc_model, normalize_registration, resolve_registration,
};
pub use csvimport::{ColumnMapping, CsvField, CsvImportOptions, CsvImportReport, CsvPreset, CsvPreview, CsvProfile, ParsedFlight};
pub use error::{BackupStep, Field, Invalid};
pub use export::ExportFormat;
pub use merge::{MergeCandidate, MergeReport, ResumeCandidate};
pub use metrics::{FLIGHT_METRICS_VERSION, FlightMetricsRow, RecentMetrics};
pub use recorder::{FlightRecorder, LiveTrack, PlannedSlot, RecorderContext};
pub use store::{
    g_load_from_track,
    APPROACH_FACTS_VERSION, ApproachFactDetail, ApproachFactRow, DeletedFlight, FlightCounts, FlightDetail, FlightRow, FlightUserEdit, MetarSlot, PhaseEventRow, PlannedFlight,
    NOTES_MAX_CHARS, RecentApproaches, RunwayRefinement, SCHEMA_VERSION, Store, StoreNotice, TAG_MAX_CHARS, TAGS_MAX, TRASH_RETENTION_DAYS, TagCount, Totals, UserRunway, UserRunwayEdit, UserRunwaySource, normalize_tags,
};
pub use track::{RecordedApproachData, TrackEncoder, TrackSample, decode_track, encode_track, recorded_approach_data};

/// Names the airport a position belongs to. Implemented by the app over the
/// embedded OurAirports index; kept as a trait so the store does not depend on it.
pub trait AirportResolver: Send + Sync {
    fn nearest_ident(&self, latitude: f64, longitude: f64, max_nm: f64) -> Option<String>;
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("track codec: {0}")]
    Track(#[from] track::TrackError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    /// A refusal the user can meet, with a stable code and German `Display` ([`error`]).
    #[error("{0}")]
    Invalid(Invalid),
    /// The file was written by a newer VectaSim (downgrade); it is left untouched.
    #[error("database schema v{found} is newer than this version supports (v{supported})")]
    NewerSchema { found: i64, supported: i64 },
    /// One migration step failed and was rolled back; the file keeps schema v`from`.
    #[error("migration v{from} -> v{to} failed (rolled back): {message}")]
    Migration { from: i64, to: i64, message: String, backup: Option<std::path::PathBuf> },
    /// A safety copy could not be written (nothing was changed).
    #[error("backup failed: {} ({}): {}", .step.label(vectasim_core::Lang::De), .dir.display(), .detail)]
    Backup { step: BackupStep, dir: std::path::PathBuf, detail: String },
}

impl StoreError {
    /// The safety copy written before the failed operation, if any.
    pub fn backup_path(&self) -> Option<&std::path::Path> {
        match self {
            StoreError::Migration { backup, .. } => backup.as_deref(),
            _ => None,
        }
    }
}

impl From<Invalid> for StoreError {
    fn from(i: Invalid) -> Self {
        StoreError::Invalid(i)
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

pub(crate) fn now_ms_i64() -> i64 {
    vectasim_core::now_ms() as i64
}

#[cfg(test)]
mod tests {
    /// The bundled SQLite must carry the fix for CVE-2025-6965 (3.50.2+).
    #[test]
    fn bundled_sqlite_is_new_enough() {
        println!("bundled SQLite {}", rusqlite::version());
        assert!(rusqlite::version_number() >= 3_050_002, "SQLite {} < 3.50.2", rusqlite::version());
    }
}
