//! Local-first persistence for VectaSim.
//!
//! One SQLite file (WAL mode) holds flights, touchdowns, phase events and the
//! flown track. The track is stored as a zstd-compressed, delta-encoded
//! columnar blob (see `track`), plus a sparse preview for fast map thumbnails.
//! `FlightRecorder` turns the live `FlightSession` stream into rows and flushes
//! the track once a minute so a crash loses at most a minute of path.

pub mod airframe;
pub mod export;
pub mod recorder;
pub mod store;
pub mod track;

pub use airframe::{Airframe, AirframeEdit, AirframePhoto, AirframeRow, icao_from_atc_model, normalize_registration, resolve_registration};
pub use export::ExportFormat;
pub use recorder::{FlightRecorder, LiveTrack, PlannedSlot, RecorderContext};
pub use store::{FlightDetail, FlightRow, MetarSlot, PhaseEventRow, PlannedFlight, Store, Totals};
pub use track::{TrackSample, decode_track, encode_track};

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
    #[error("{0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

pub(crate) fn now_ms_i64() -> i64 {
    vectasim_core::now_ms() as i64
}
