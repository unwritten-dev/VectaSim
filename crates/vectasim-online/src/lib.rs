//! Online-network traffic and weather for the live map.
//!
//! * [`VatsimFeed`] polls the public VATSIM v3 data file. VATSIM regenerates it
//!   every 15 s, so polling faster only burns their bandwidth and ours; the
//!   feed enforces that floor even across stop/start and backs off on errors.
//!   One poller serves every map view through the cached [`VatsimSnapshot`].
//! * [`MetarClient`] fetches METARs from aviationweather.gov (NOAA, JSON) with a
//!   per-ICAO cache and falls back to VATSIM's METAR text endpoint, which
//!   carries the same reports but without structure.
//! * [`metar::decode`] is a deliberately small METAR decoder: just what the
//!   flight bar and map badges show (wind, visibility, QNH, temperature,
//!   ceiling → flight category). We decode the raw text ourselves rather than
//!   trusting the NOAA JSON fields so both sources produce identical results.

pub mod metar;
pub mod vatsim;

pub use metar::{FlightCategory, Metar, MetarClient, Wind};
pub use vatsim::{
    Controller, Facility, FeedStatus, NearbyPilot, Pilot, Prefile, VatsimFeed, VatsimSnapshot, haversine_nm, parse_vatsim_json,
};

pub(crate) const USER_AGENT: &str = concat!("VectaSim/", env!("CARGO_PKG_VERSION"), " (+https://github.com/unwritten-dev/VectaSim)");

#[derive(Debug, thiserror::Error)]
pub enum OnlineError {
    #[error("HTTP {status} from {url}")]
    Http { status: u16, url: String },
    #[error("network: {0}")]
    Network(#[from] reqwest::Error),
    #[error("could not parse response: {0}")]
    Parse(String),
    #[error("rate limit reached, try again shortly")]
    RateLimited,
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
